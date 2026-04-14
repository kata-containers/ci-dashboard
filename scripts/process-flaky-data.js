#!/usr/bin/env node
/**
 * Process PR workflow runs to extract flaky test data
 * 
 * Reads: raw-pr-runs.json (contains PR jobs), pr-job-logs/*.log, config.yaml
 * Outputs: flaky-data.json
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

console.log('Starting flaky test data processing...');

// Load config
let config;
try {
  config = yaml.load(fs.readFileSync('config.yaml', 'utf8'));
  console.log('Config loaded successfully');
} catch (e) {
  console.error('Failed to load config.yaml:', e.message);
  process.exit(1);
}

// Load raw PR jobs data
let rawData;
try {
  rawData = JSON.parse(fs.readFileSync('raw-pr-runs.json', 'utf8'));
  console.log(`Loaded ${rawData.jobs?.length || 0} PR jobs`);
} catch (e) {
  console.error('Failed to load raw-pr-runs.json:', e.message);
  // Create empty output if no data
  const emptyOutput = {
    lastRefresh: new Date().toISOString(),
    periodDays: 14,
    totalFailures: 0,
    totalPRs: 0,
    flakyTests: [],
    summary: {
      totalFlakyTests: 0,
      mostAffectedJob: null,
      trend: []
    }
  };
  fs.writeFileSync('flaky-data.json', JSON.stringify(emptyOutput, null, 2));
  console.log('Created empty flaky-data.json (no PR data available)');
  process.exit(0);
}

const allJobs = rawData.jobs || [];
rawData = null; // free the parsed JSON tree; allJobs holds what we need

// Pre-parsed test results cache (stores only parsed failures, NOT raw log content).
// Avoids OOM: PR log files can total several GB; keeping them all as strings crashes Node.
const parsedJobResults = {};

const MAX_SYNC_LOG_SIZE = 10 * 1024 * 1024; // 10MB - above this, use chunked reading to avoid GC pressure
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB read chunks

function processLogLine(line, state) {
  const fileMatch = line.match(/Running\s+(\S+\.bats)/i) || line.match(/(\S+\.bats)/);
  if (fileMatch) {
    state.currentFile = fileMatch[1];
  }

  const notOkMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?not ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
  if (notOkMatch) {
    state.failedTests++;
    state.totalTests++;
    const testNumber = notOkMatch[1];
    let testName = notOkMatch[2].trim().replace(/\s+in \d+ms$/, '');
    const comment = notOkMatch[3] || '';
    if (comment.toLowerCase().includes('skip') || comment.toLowerCase().includes('todo')) {
      state.skippedTests++;
      state.failedTests--;
    } else {
      state.failures.push({ number: parseInt(testNumber), name: testName, comment, file: state.currentFile });
    }
    return;
  }

  const okMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
  if (okMatch) {
    state.passedTests++;
    state.totalTests++;
    return;
  }

  const batsFileMatch = line.match(/^\s*(\S+\.bats)\s*$/);
  if (batsFileMatch) {
    state.currentFile = batsFileMatch[1];
  }
}

function newParseState() {
  return { failures: [], totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0, currentFile: null };
}

function stateToResult(state) {
  if (state.failures.length === 0 && state.totalTests === 0) return null;
  return {
    failures: state.failures,
    stats: { total: state.totalTests, passed: state.passedTests, failed: state.failedTests, skipped: state.skippedTests }
  };
}

/**
 * Buffer newline scan — avoids ConsString + giant String#split OOM (see process-data.js).
 */
function parseLogFileChunked(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(CHUNK_SIZE);
  let leftover = Buffer.alloc(0);
  const state = newParseState();
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE)) > 0) {
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      const combined = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;

      let lineStart = 0;
      for (let i = 0; i < combined.length; i++) {
        if (combined[i] === 0x0a) {
          let line = combined.toString('utf8', lineStart, i);
          if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
          processLogLine(line, state);
          lineStart = i + 1;
        }
      }

      leftover =
        lineStart < combined.length
          ? Buffer.from(combined.subarray(lineStart))
          : Buffer.alloc(0);
    }
    if (leftover.length > 0) {
      let tail = leftover.toString('utf8');
      if (tail.charCodeAt(tail.length - 1) === 13) tail = tail.slice(0, -1);
      if (tail.trim()) processLogLine(tail, state);
    }
  } finally {
    fs.closeSync(fd);
  }
  return stateToResult(state);
}

function parseLogFile(filePath) {
  let fileSize;
  try {
    fileSize = fs.statSync(filePath).size;
  } catch (e) {
    return null;
  }
  if (fileSize < 100) return null;

  if (fileSize > MAX_SYNC_LOG_SIZE) {
    return parseLogFileChunked(filePath);
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const state = newParseState();
    for (const line of content.split('\n')) {
      processLogLine(line, state);
    }
    return stateToResult(state);
  } catch (e) {
    if (e.message.includes('Cannot create a string')) {
      return parseLogFileChunked(filePath);
    }
    return null;
  }
}

// Load and parse PR job logs
const logsDir = 'pr-job-logs';
if (fs.existsSync(logsDir)) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
  console.log(`Found ${logFiles.length} PR job log files`);

  logFiles.forEach(file => {
    const jobId = file.replace('.log', '');
    const filePath = path.join(logsDir, file);
    try {
      const fileSize = fs.statSync(filePath).size;
      const result = parseLogFile(filePath);
      if (result) {
        parsedJobResults[jobId] = result;
        const notOkCount = result.failures.length;
        console.log(`  Log ${jobId}: ${fileSize} bytes, ${notOkCount} "not ok" lines`);
      }
    } catch (e) {
      console.warn(`  Could not process log for job ${jobId}: ${e.message}`);
    }
  });
} else {
  console.log('No pr-job-logs directory found');
}

/**
 * Look up pre-parsed test failure details for a job.
 */
function parseTestFailures(jobId) {
  return parsedJobResults[jobId] || null;
}

// Get job display name - for PR failures, use the raw job name (more technical)
// This includes ALL jobs from the k8s test workflows, not just configured ones
function getJobDisplayName(jobName) {
  // For PR failures tab, we show the raw job name which is more useful for technical folks
  // Examples: "run-k8s-tests (ubuntu, qemu, small)", "run-nvidia-gpu-snp-tests-on-amd64"
  return jobName;
}

// Process all jobs to detect flakiness
console.log('\nProcessing PR jobs for flakiness detection...');

// Structure to collect test failure data
// { testName: { file, occurrences: [...], affectedJobs: {...} } }
const failedTestsMap = {};

// Track unique PRs and their merge status
const uniquePRs = new Set();
const prMergeStatus = {}; // { prNumber: { merged: bool, state: string } }

// Track failures by day for trend
const failuresByDay = {};

// Group jobs by PR and job name to detect flakiness
// Key: `${prNumber}-${jobName}` -> { failed: [attempts], passed: [attempts] }
const prJobResults = {};

// First pass: collect all job results grouped by PR and job name
allJobs.forEach(job => {
  const prNumber = job.pr_number || 'unknown';
  const jobName = job.name;
  const runAttempt = job.run_attempt || 1;
  const conclusion = job.conclusion;
  
  // Track PR merge status
  if (prNumber !== 'unknown' && !prMergeStatus[prNumber]) {
    prMergeStatus[prNumber] = {
      merged: job.pr_merged || false,
      state: job.pr_state || 'unknown'
    };
  }
  
  const key = `${prNumber}-${jobName}`;
  if (!prJobResults[key]) {
    prJobResults[key] = { 
      prNumber, 
      jobName, 
      failed: [], 
      passed: [],
      prMerged: job.pr_merged || false
    };
  }
  
  if (conclusion === 'failure') {
    prJobResults[key].failed.push({ ...job, runAttempt });
  } else if (conclusion === 'success') {
    prJobResults[key].passed.push({ ...job, runAttempt });
  }
});

// Identify flaky cases: failed in one attempt, passed in another (same PR, same job)
const flakyPRJobs = new Set();
Object.entries(prJobResults).forEach(([key, results]) => {
  if (results.failed.length > 0 && results.passed.length > 0) {
    // This is a flaky case - failed then passed (or vice versa)
    flakyPRJobs.add(key);
    console.log(`  Flaky detected: PR #${results.prNumber} - ${results.jobName} (${results.failed.length} failed, ${results.passed.length} passed)`);
  }
});

console.log(`\nFound ${flakyPRJobs.size} flaky PR-job combinations`);

// Process failed jobs
const failedJobs = allJobs.filter(j => j.conclusion === 'failure');
console.log(`Found ${failedJobs.length} failed jobs to analyze`);

failedJobs.forEach(job => {
  const jobId = String(job.id);
  const jobName = job.name;
  const prNumber = job.pr_number || 'unknown';
  const prTitle = job.pr_title || '';
  const runId = job.workflow_run_id;
  const runAttempt = job.run_attempt || 1;
  const createdAt = job.run_created_at || job.started_at;
  const dateStr = createdAt ? createdAt.split('T')[0] : 'unknown';
  const prMerged = job.pr_merged || false;
  
  uniquePRs.add(prNumber);
  
  // Track for trend
  if (!failuresByDay[dateStr]) {
    failuresByDay[dateStr] = 0;
  }
  
  // Check if this is a confirmed flaky case
  const prJobKey = `${prNumber}-${jobName}`;
  const isFlaky = flakyPRJobs.has(prJobKey);
  
  // Parse log for test failures
  const testResults = parseTestFailures(jobId);
  
  if (testResults && testResults.failures.length > 0) {
    console.log(`  Job ${jobId} (PR #${prNumber}, attempt ${runAttempt}${isFlaky ? ' [FLAKY]' : ''}${prMerged ? ' [MERGED]' : ''}): ${testResults.failures.length} test failures`);
    
    testResults.failures.forEach(failure => {
      const testKey = failure.name;
      
      if (!failedTestsMap[testKey]) {
        failedTestsMap[testKey] = {
          name: failure.name,
          file: failure.file,
          occurrences: [],
          affectedJobs: {},
          uniquePRs: new Set(),
          uniqueDates: new Set(),
          flakyCount: 0,
          mergedCount: 0
        };
      }
      
      // Add occurrence with flaky and merged flags
      failedTestsMap[testKey].occurrences.push({
        date: dateStr,
        prNumber: prNumber,
        prTitle: prTitle,
        jobName: jobName,
        jobDisplayName: getJobDisplayName(jobName),
        jobId: jobId,
        runId: runId,
        runAttempt: runAttempt,
        isFlaky: isFlaky,
        prMerged: prMerged
      });
      
      // Track flaky and merged counts
      if (isFlaky) {
        failedTestsMap[testKey].flakyCount++;
      }
      if (prMerged) {
        failedTestsMap[testKey].mergedCount++;
      }
      
      // Track affected jobs
      if (!failedTestsMap[testKey].affectedJobs[jobName]) {
        failedTestsMap[testKey].affectedJobs[jobName] = {
          name: jobName,
          displayName: getJobDisplayName(jobName),
          count: 0,
          flakyCount: 0,
          mergedCount: 0
        };
      }
      failedTestsMap[testKey].affectedJobs[jobName].count++;
      if (isFlaky) {
        failedTestsMap[testKey].affectedJobs[jobName].flakyCount++;
      }
      if (prMerged) {
        failedTestsMap[testKey].affectedJobs[jobName].mergedCount++;
      }
      
      // Track unique PRs and dates
      failedTestsMap[testKey].uniquePRs.add(prNumber);
      failedTestsMap[testKey].uniqueDates.add(dateStr);
      
      // Update file if we found one
      if (failure.file && !failedTestsMap[testKey].file) {
        failedTestsMap[testKey].file = failure.file;
      }
      
      // Increment day counter
      failuresByDay[dateStr]++;
    });
  }
});

// Convert to array and sort by frequency
const failedTests = Object.values(failedTestsMap).map(test => ({
  name: test.name,
  file: test.file,
  totalFailures: test.occurrences.length,
  flakyCount: test.flakyCount,
  mergedCount: test.mergedCount,
  isConfirmedFlaky: test.flakyCount > 0,
  mergedDespiteFailure: test.mergedCount > 0,
  uniquePRs: test.uniquePRs.size,
  uniqueDates: Array.from(test.uniqueDates).sort().reverse(),
  affectedJobs: Object.values(test.affectedJobs).sort((a, b) => b.count - a.count),
  recentOccurrences: test.occurrences
    .sort((a, b) => {
      // Sort by date desc, then by PR, then by attempt
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      if (a.prNumber !== b.prNumber) return String(b.prNumber).localeCompare(String(a.prNumber));
      return b.runAttempt - a.runAttempt;
    })
    // Keep ALL occurrences (no slice)
})).sort((a, b) => b.totalFailures - a.totalFailures);

// Build trend data (last 14 days)
const trend = [];
const today = new Date();
for (let i = 13; i >= 0; i--) {
  const date = new Date(today);
  date.setDate(date.getDate() - i);
  const dateStr = date.toISOString().split('T')[0];
  trend.push({
    date: dateStr,
    failures: failuresByDay[dateStr] || 0
  });
}

// Find most affected job
let mostAffectedJob = null;
const jobFailureCounts = {};
failedTests.forEach(test => {
  test.affectedJobs.forEach(job => {
    if (!jobFailureCounts[job.name]) {
      jobFailureCounts[job.name] = { 
        name: job.name, 
        displayName: job.displayName, 
        count: 0,
        flakyCount: 0,
        mergedCount: 0
      };
    }
    jobFailureCounts[job.name].count += job.count;
    jobFailureCounts[job.name].flakyCount += job.flakyCount || 0;
    jobFailureCounts[job.name].mergedCount += job.mergedCount || 0;
  });
});
const sortedJobs = Object.values(jobFailureCounts).sort((a, b) => b.count - a.count);
if (sortedJobs.length > 0) {
  mostAffectedJob = sortedJobs[0];
}

// Count confirmed flaky and merged-despite-failure
const confirmedFlakyCount = failedTests.filter(t => t.isConfirmedFlaky).length;
const mergedDespiteFailureCount = failedTests.filter(t => t.mergedDespiteFailure).length;

// Build output
const outputData = {
  lastRefresh: new Date().toISOString(),
  periodDays: 14,
  totalFailures: failedTests.reduce((sum, t) => sum + t.totalFailures, 0),
  totalPRs: uniquePRs.size,
  confirmedFlakyCount: confirmedFlakyCount,
  mergedDespiteFailureCount: mergedDespiteFailureCount,
  failedTests: failedTests,  // Renamed from flakyTests
  summary: {
    totalFailedTests: failedTests.length,
    confirmedFlaky: confirmedFlakyCount,
    mergedDespiteFailure: mergedDespiteFailureCount,
    mostAffectedJob: mostAffectedJob,
    trend: trend,
    jobBreakdown: sortedJobs.slice(0, 10) // Top 10 jobs
  }
};

// Write output
fs.writeFileSync('flaky-data.json', JSON.stringify(outputData, null, 2));

console.log('\n=== PR Test Failures Summary ===');
console.log(`Total failed tests found: ${failedTests.length}`);
console.log(`  - Confirmed flaky (failed then passed): ${confirmedFlakyCount}`);
console.log(`  - Merged despite failure: ${mergedDespiteFailureCount}`);
console.log(`Total test failures: ${outputData.totalFailures}`);
console.log(`PRs analyzed: ${uniquePRs.size}`);
console.log(`Most affected job: ${mostAffectedJob?.displayName || 'N/A'} (${mostAffectedJob?.count || 0} failures)`);

if (failedTests.length > 0) {
  console.log('\nTop 5 most failing tests:');
  failedTests.slice(0, 5).forEach((test, i) => {
    const badges = [];
    if (test.isConfirmedFlaky) badges.push('🔄 FLAKY');
    if (test.mergedDespiteFailure) badges.push('✓ MERGED');
    console.log(`  ${i + 1}. "${test.name}" - ${test.totalFailures}x failures across ${test.uniquePRs} PRs ${badges.join(' ')}`);
    if (test.file) console.log(`     📁 ${test.file}`);
  });
}

console.log('\nPR failures data processing complete!');

