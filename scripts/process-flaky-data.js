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

// Load job logs for failed jobs
const jobLogs = {};
const logsDir = 'pr-job-logs';
if (fs.existsSync(logsDir)) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
  console.log(`Found ${logFiles.length} PR job log files`);
  
  logFiles.forEach(file => {
    const jobId = file.replace('.log', '');
    try {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      jobLogs[jobId] = content;
      
      const notOkCount = (content.match(/not ok \d+/gi) || []).length;
      if (notOkCount > 0) {
        console.log(`  Log ${jobId}: ${content.length} bytes, ${notOkCount} "not ok" lines`);
      }
    } catch (e) {
      console.warn(`Could not read log for job ${jobId}: ${e.message}`);
    }
  });
} else {
  console.log('No pr-job-logs directory found');
}

/**
 * Parse job logs to extract test failure details from TAP output
 */
function parseTestFailures(jobId) {
  const log = jobLogs[jobId];
  if (!log) return null;
  
  const failures = [];
  const lines = log.split('\n');
  
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;
  let currentFile = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Try to detect filename from output
    const fileMatch = line.match(/Running\s+(\S+\.bats)/i) || line.match(/(\S+\.bats)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
    }
    
    // Parse TAP output - handle various formats
    const notOkMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?not ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
    if (notOkMatch) {
      failedTests++;
      totalTests++;
      const testNumber = notOkMatch[1];
      let testName = notOkMatch[2].trim();
      const comment = notOkMatch[3] || '';
      
      testName = testName.replace(/\s+in \d+ms$/, '');
      
      if (comment.toLowerCase().includes('skip') || comment.toLowerCase().includes('todo')) {
        skippedTests++;
        failedTests--;
      } else {
        failures.push({
          number: parseInt(testNumber),
          name: testName,
          comment: comment,
          file: currentFile
        });
      }
      continue;
    }
    
    const okMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
    if (okMatch) {
      passedTests++;
      totalTests++;
      continue;
    }
    
    const batsFileMatch = line.match(/^\s*(\S+\.bats)\s*$/);
    if (batsFileMatch) {
      currentFile = batsFileMatch[1];
    }
  }
  
  if (failures.length === 0 && totalTests === 0) {
    return null;
  }
  
  return {
    failures: failures,
    stats: {
      total: totalTests,
      passed: passedTests,
      failed: failedTests,
      skipped: skippedTests
    }
  };
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

