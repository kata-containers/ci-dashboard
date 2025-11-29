#!/usr/bin/env node
/**
 * Process GitHub Actions jobs into dashboard format
 * 
 * Reads: raw-runs.json (contains jobs), config.yaml, job-logs/*.log, data.json (cache)
 * Outputs: data.json
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

console.log('Starting data processing...');

// Load config
let config;
try {
  config = yaml.load(fs.readFileSync('config.yaml', 'utf8'));
  console.log('Config loaded successfully');
} catch (e) {
  console.error('Failed to load config.yaml:', e.message);
  process.exit(1);
}

// Load existing data.json as cache (if exists)
let cachedData = null;
try {
  if (fs.existsSync('data.json')) {
    cachedData = JSON.parse(fs.readFileSync('data.json', 'utf8'));
    console.log(`Loaded cached data from ${cachedData.lastRefresh || 'unknown time'}`);
    
    // Also load cached failed tests index if exists
    if (cachedData.failedTestsIndex) {
      console.log(`  Cache has ${Object.keys(cachedData.failedTestsIndex).length} tracked failed tests`);
    }
  }
} catch (e) {
  console.warn('No cached data available:', e.message);
}

// Load raw jobs data
let rawData;
try {
  rawData = JSON.parse(fs.readFileSync('raw-runs.json', 'utf8'));
  console.log(`Loaded ${rawData.jobs?.length || 0} jobs`);
} catch (e) {
  console.error('Failed to load raw-runs.json:', e.message);
  process.exit(1);
}

const allJobs = rawData.jobs || [];

// Load job logs for failed jobs
const jobLogs = {};
const logsDir = 'job-logs';
if (fs.existsSync(logsDir)) {
  const logFiles = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
  console.log(`Found ${logFiles.length} job log files`);
  
  logFiles.forEach(file => {
    const jobId = file.replace('.log', '');
    try {
      const content = fs.readFileSync(path.join(logsDir, file), 'utf8');
      jobLogs[jobId] = content;
      
      // Debug: show log size and check for "not ok" lines
      const notOkCount = (content.match(/not ok \d+/gi) || []).length;
      console.log(`  Log ${jobId}: ${content.length} bytes, ${notOkCount} "not ok" lines found`);
      
      // Show sample "not ok" lines if found
      if (notOkCount > 0) {
        const lines = content.split('\n');
        const notOkLines = lines.filter(l => /not ok \d+/i.test(l)).slice(0, 3);
        notOkLines.forEach(l => console.log(`    ${l.substring(0, 100)}`));
      }
    } catch (e) {
      console.warn(`Could not read log for job ${jobId}: ${e.message}`);
    }
  });
} else {
  console.log('No job-logs directory found');
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
  
  // Keep track of which test file we are in (for context)
  let currentFile = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Try to detect filename from output (often appears before results)
    // Example: "Running k8s-policy-deployment.bats" or similar
    const fileMatch = line.match(/Running\s+(\S+\.bats)/i) || line.match(/(\S+\.bats)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
    }
    
    // Parse TAP output - handle both formats:
    // Standard TAP: "not ok 1 - Test name # comment"
    // Bats format:  "not ok 1 Test name in 12345ms"
    // GitHub Actions logs: "2025-11-27T00:53:00.5185123Z not ok 1 Test name in 12345ms"
    // We use a flexible regex that looks for "not ok" followed by a number
    // Case insensitive match for "not ok", handle leading timestamp/whitespace
    const notOkMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?not ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
    if (notOkMatch) {
      failedTests++;
      totalTests++;
      const testNumber = notOkMatch[1];
      let testName = notOkMatch[2].trim();
      const comment = notOkMatch[3] || '';
      
      // Remove timing suffix if present (bats adds "in Xms")
      testName = testName.replace(/\s+in \d+ms$/, '');
      
      // Check if it's a skip/todo
      if (comment.toLowerCase().includes('skip') || comment.toLowerCase().includes('todo')) {
        skippedTests++;
        failedTests--;
      } else {
        failures.push({
          number: parseInt(testNumber),
          name: testName,
          comment: comment,
          file: currentFile // Attach file context if found
        });
      }
      continue;
    }
    
    // "ok 1 - Test name" or "ok 1 Test name in Xms"
    // GitHub Actions logs: "2025-11-27T00:53:00.5185123Z ok 1 Test name in Xms"
    const okMatch = line.match(/(?:^\d{4}-\d{2}-\d{2}T[\d:\.]+Z\s+)?ok (\d+)\s+(?:-\s+)?(.+?)(?:\s+in \d+ms)?(?:\s*#\s*(.*))?$/i);
    if (okMatch) {
      passedTests++;
      totalTests++;
      continue;
    }
    
    // Also capture bats test file names as standalone lines if they look like file headers
    // Example: "k8s-policy-deployment.bats"
    const batsFileMatch = line.match(/^\s*(\S+\.bats)\s*$/);
    if (batsFileMatch) {
      currentFile = batsFileMatch[1];
    }
  }
  
  // Debug output
  if (failures.length > 0) {
    console.log(`Job ${jobId}: Found ${failures.length} failures (Total parsed: ${totalTests})`);
    failures.forEach(f => console.log(`  - [${f.file || 'unknown'}] ${f.name}`));
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

// Get the job names we care about from config
const configuredJobs = [];
(config.sections || []).forEach(section => {
  (section.jobs || []).forEach(job => {
    const jobName = typeof job === 'string' ? job : job.name;
    const jobDesc = typeof job === 'object' ? job.description : jobName;
    configuredJobs.push({ name: jobName, description: jobDesc, section: section.id });
  });
});

/**
 * Global index of failed tests across all jobs
 * Structure: { "testName": { occurrences: [{date, jobName, jobId, runId}], totalCount: N } }
 */
const failedTestsIndex = cachedData?.failedTestsIndex || {};

/**
 * Merge new failure data into the global index
 */
function indexFailedTest(testName, date, jobName, jobId, runId) {
  if (!failedTestsIndex[testName]) {
    failedTestsIndex[testName] = {
      occurrences: [],
      totalCount: 0
    };
  }
  
  // Check if this occurrence already exists (by jobId)
  const existingIdx = failedTestsIndex[testName].occurrences.findIndex(
    o => o.jobId === jobId
  );
  
  if (existingIdx === -1) {
    failedTestsIndex[testName].occurrences.push({
      date: date,
      jobName: jobName,
      jobId: jobId,
      runId: runId
    });
    failedTestsIndex[testName].totalCount++;
  }
  
  // Keep only last 30 days of data
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  
  failedTestsIndex[testName].occurrences = failedTestsIndex[testName].occurrences
    .filter(o => new Date(o.date) >= cutoffDate)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  
  failedTestsIndex[testName].totalCount = failedTestsIndex[testName].occurrences.length;
}

/**
 * Get cached weather history for a test if it exists
 */
function getCachedWeatherHistory(sectionId, testId) {
  if (!cachedData) return null;
  const section = cachedData.sections?.find(s => s.id === sectionId);
  if (!section) return null;
  const test = section.tests?.find(t => t.id === testId);
  return test?.weatherHistory || null;
}

// Get fatal step patterns
const fatalStepPatterns = (config.fatal_steps || []).map(s => {
  return typeof s === 'string' ? new RegExp(s) : new RegExp(s.pattern);
});
if (fatalStepPatterns.length === 0) {
  // Default if not configured
  fatalStepPatterns.push(/^Run tests/);
}
console.log('Fatal step patterns:', fatalStepPatterns.map(r => r.toString()));

// Process sections based on config
const sections = (config.sections || []).map(sectionConfig => {
  const sectionJobs = sectionConfig.jobs || [];
  
  const tests = sectionJobs.map(jobConfig => {
    const jobName = typeof jobConfig === 'string' ? jobConfig : jobConfig.name;
    const jobDescription = typeof jobConfig === 'object' ? jobConfig.description : jobName;
    const jobMaintainers = typeof jobConfig === 'object' ? (jobConfig.maintainers || []) : [];
    // Use description as display name, fall back to job name
    const displayName = jobDescription || jobName;
    // Use job name for ID (stable), not description (can change)
    const testId = jobName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    
    // Find jobs matching this name (exact match)
    const matchingJobs = allJobs.filter(job => {
      const name = job.name || '';
      // Exact match for full job name
      return name === jobName;
    }).sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
    
    
    console.log(`Job "${displayName}": found ${matchingJobs.length} matching jobs`);
    
    // Helper to determine status based on fatal steps
    const determineStatus = (job) => {
      if (!job) return 'not_run';
      
      if (job.status === 'in_progress' || job.status === 'queued') {
        return 'not_run'; // Treat running/queued as not run yet
      }
      
      if (job.conclusion === 'success') {
        return 'passed';
      }
      
      if (job.conclusion === 'failure') {
        // Check if failure is in a fatal step
        const failedStep = job.steps?.find(s => s.conclusion === 'failure');
        const failedStepName = failedStep?.name || 'Unknown step';
        
        // If steps are not available (e.g. not fetched), assume it's a test failure to be safe?
        // Or if we can't verify it's a fatal step, treat as fatal? 
        // Better to check patterns.
        
        if (failedStep) {
          const isFatal = fatalStepPatterns.some(p => p.test(failedStepName));
          if (!isFatal) {
            console.log(`  [Non-fatal failure] Job ${job.id} failed at "${failedStepName}" -> marked as not_run`);
            return 'not_run_setup_failed'; // Internal status, maps to 'not_run'
          }
        }
        return 'failed';
      }
      
      if (job.conclusion === 'cancelled' || job.conclusion === 'skipped') {
        return 'not_run';
      }
      
      return 'not_run';
    };

    // Get latest job
    const latestJob = matchingJobs[0];
    let rawStatus = determineStatus(latestJob);
    let status = rawStatus === 'not_run_setup_failed' ? 'not_run' : rawStatus;
    let setupRetry = rawStatus === 'not_run_setup_failed'; // Mark if it was a setup failure
    
    // Get cached weather for this test
    const cachedWeather = getCachedWeatherHistory(sectionConfig.id, testId);
    
    // Determine anchor date for 10-day window
    // If today's run hasn't happened/finished yet, start from yesterday
    let anchorDate = new Date();
    const todayStr = anchorDate.toDateString();
    const hasRunToday = matchingJobs.some(j => {
      const d = new Date(j.started_at || j.created_at);
      return d.toDateString() === todayStr && (j.conclusion === 'success' || j.conclusion === 'failure');
    });
    
    if (!hasRunToday) {
      anchorDate.setDate(anchorDate.getDate() - 1);
    }
    
    // Build weather history (last 10 days from anchor)
    const weatherHistory = [];
    for (let i = 0; i < 10; i++) {
      const date = new Date(anchorDate);
      date.setDate(date.getDate() - (9 - i));
      date.setHours(0, 0, 0, 0);
      
      // Find job for this day - only use jobs that have the "Run tests" step
      const dayJobs = matchingJobs.filter(job => {
        const jobDate = new Date(job.started_at || job.created_at);
        return jobDate.toDateString() === date.toDateString();
      });
      
      // Pick the first job that has a "Run tests" step, otherwise null (not run)
      const dayJob = dayJobs.find(job => {
        return job.steps?.some(s => fatalStepPatterns.some(p => p.test(s.name)));
      }) || null;
      
      let dayStatus = 'none';
      let dayFailures = null;
      let dayStepName = null;
      
      if (dayJob) {
        const dayRawStatus = determineStatus(dayJob);
        
        if (dayRawStatus === 'passed') {
          dayStatus = 'passed';
        } else if (dayRawStatus === 'failed') {
          dayStatus = 'failed';
          dayStepName = getFailedStep(dayJob);
          
          // Try to get failure details
          dayFailures = parseTestFailures(dayJob.id.toString());
          
          // Debug: log if parsing failed
          if (!dayFailures) {
            const hasLog = !!jobLogs[dayJob.id.toString()];
            console.log(`  Day ${date.toISOString().split('T')[0]}: No parsed failures. Has log: ${hasLog}, Job ID: ${dayJob.id}`);
          }
          
          // If no fresh log, try to get from cache
          if (!dayFailures && cachedWeather) {
            const cachedDay = cachedWeather.find(c => 
              new Date(c.date).toDateString() === date.toDateString()
            );
            if (cachedDay?.failureDetails) {
              dayFailures = cachedDay.failureDetails;
              console.log(`  Using cached failure details for ${date.toISOString().split('T')[0]}`);
            }
          }
          
          // Extract unique bats files from failures (clean up GitHub Actions group markers)
          const batsFiles = [];
          const batsFilesSet = new Set();
          if (dayFailures?.failures) {
            dayFailures.failures.forEach(f => {
              if (f.file) {
                // Remove GitHub Actions group markers and normalize
                const cleanFile = f.file.replace(/^##\[group\]/, '').trim();
                if (cleanFile && !batsFilesSet.has(cleanFile)) {
                  batsFilesSet.add(cleanFile);
                  batsFiles.push(cleanFile);
                }
              }
              indexFailedTest(
                f.name,
                date.toISOString(),
                displayName,
                dayJob.id.toString(),
                dayJob.workflow_run_id || dayJob.run_id?.toString()
              );
            });
          }
          
          // Store bats files in failureDetails for easy access
          if (dayFailures && batsFiles.length > 0) {
            dayFailures.batsFiles = batsFiles;
          }
        } else if (dayRawStatus === 'not_run_setup_failed') {
           // It failed, but not in a fatal step. Treat as not run/setup failed.
           // Maybe we want a visual distinction? For now, 'none' or 'not_run'
           dayStatus = 'not_run'; // Or 'setup_failed' if we add UI support
        }
      } else if (cachedWeather) {
        // No fresh data for this day, use cache if available
        const cachedDay = cachedWeather.find(c => 
          new Date(c.date).toDateString() === date.toDateString()
        );
        if (cachedDay) {
          dayStatus = cachedDay.status;
          dayFailures = cachedDay.failureDetails;
          dayStepName = cachedDay.failureStep;
        }
      }
      
      // Build failure step display: show bats files if available, otherwise step name
      let failureStepDisplay = null;
      if (dayStatus === 'failed') {
        if (dayFailures?.batsFiles && dayFailures.batsFiles.length > 0) {
          failureStepDisplay = dayFailures.batsFiles.join(', ');
        } else {
          failureStepDisplay = dayStepName || 'Run tests';
        }
      }
      
      weatherHistory.push({
        date: date.toISOString(),
        status: dayStatus,
        runId: dayJob?.workflow_run_id || dayJob?.run_id?.toString() || null,
        jobId: dayJob?.id?.toString() || null,
        duration: dayJob ? formatDuration(dayJob.started_at, dayJob.completed_at) : null,
        failureStep: failureStepDisplay,
        failureDetails: dayFailures
      });
    }
    
    // Count failures in last 10 days
    const failureCount = weatherHistory.filter(w => w.status === 'failed').length;
    
    // Get all unique failed tests from weather history
    const failedTestsInWeather = [];
    weatherHistory.forEach(day => {
      if (day.failureDetails?.failures) {
        // Get unique test names for this day (deduplicate within the day)
        const uniqueTestsForDay = new Map();
        day.failureDetails.failures.forEach(f => {
          if (!uniqueTestsForDay.has(f.name)) {
            uniqueTestsForDay.set(f.name, f);
          }
        });
        
        // Process each unique test for this day
        uniqueTestsForDay.forEach((f, testName) => {
          const existing = failedTestsInWeather.find(e => e.name === testName);
          const dateStr = day.date.split('T')[0];
          
          if (existing) {
            // Only increment count if this is a new day
            if (!existing.dates.includes(dateStr)) {
              existing.count++;
              existing.dates.push(dateStr);
            }
            // Collect bats files (clean up GitHub Actions group markers)
            if (f.file && !existing.files) {
              existing.files = new Set();
            }
            if (f.file) {
              const cleanFile = f.file.replace(/^##\[group\]/, '').trim();
              if (cleanFile) {
                existing.files.add(cleanFile);
              }
            }
          } else {
            const files = new Set();
            if (f.file) {
              const cleanFile = f.file.replace(/^##\[group\]/, '').trim();
              if (cleanFile) {
                files.add(cleanFile);
              }
            }
            failedTestsInWeather.push({
              name: testName,
              count: 1,
              dates: [dateStr],
              files: files
            });
          }
        });
      }
    });
    
    // Convert Sets to arrays for JSON serialization
    failedTestsInWeather.forEach(ft => {
      if (ft.files) {
        ft.files = Array.from(ft.files);
      }
      // Sort dates
      ft.dates = [...new Set(ft.dates)].sort().reverse();
    });
    
    // Sort by count descending
    failedTestsInWeather.sort((a, b) => b.count - a.count);
    
    // Find last failure and success
    const lastFailureJob = matchingJobs.find(j => j.conclusion === 'failure');
    const lastSuccessJob = matchingJobs.find(j => j.conclusion === 'success');
    
    // Get failure details for the latest failed job
    let errorDetails = null;
    if (status === 'failed' && latestJob?.id) {
      const testFailures = parseTestFailures(latestJob.id.toString());
      
      if (testFailures && testFailures.failures.length > 0) {
        // Extract unique bats files from failures
        const batsFiles = [];
        testFailures.failures.forEach(f => {
          if (f.file && !batsFiles.includes(f.file)) {
            batsFiles.push(f.file);
          }
        });
        
        errorDetails = {
          step: batsFiles.length > 0 ? batsFiles.join(', ') : getFailedStep(latestJob),
          batsFiles: batsFiles,
          testResults: testFailures.stats,
          failures: testFailures.failures.slice(0, 20), // Limit to first 20 failures
          output: testFailures.failures.map(f => `not ok ${f.number} - ${f.name}${f.comment ? ' # ' + f.comment : ''}`).join('\n')
        };
      } else {
        errorDetails = {
          step: getFailedStep(latestJob),
          output: 'View full log on GitHub for details'
        };
      }
    }
    
    return {
      id: testId,
      name: displayName,
      fullName: jobName,
      status: status,
      duration: latestJob ? formatDuration(latestJob.started_at, latestJob.completed_at) : 'N/A',
      lastFailure: lastFailureJob ? formatRelativeTime(lastFailureJob.started_at) : 'Never',
      lastSuccess: lastSuccessJob ? formatRelativeTime(lastSuccessJob.started_at) : 'Never',
      weatherHistory: weatherHistory,
      failureCount: failureCount,
      failedTestsInWeather: failedTestsInWeather, // NEW: specific "not ok" tests and their frequency
      retried: latestJob?.run_attempt > 1 ? latestJob.run_attempt - 1 : 0,
      setupRetry: false,
      runId: latestJob?.workflow_run_id || latestJob?.run_id?.toString() || null,
      jobId: latestJob?.id?.toString() || null,
      error: errorDetails,
      maintainers: jobMaintainers
    };
  });
  
  return {
    id: sectionConfig.id,
    name: sectionConfig.name,
    description: sectionConfig.description,
    tests: tests
  };
});

/**
 * For each failed test in the index, find which other jobs also have this failure
 */
function enrichFailedTestsIndex() {
  Object.keys(failedTestsIndex).forEach(testName => {
    const entry = failedTestsIndex[testName];
    
    // Group by job name
    const jobBreakdown = {};
    entry.occurrences.forEach(occ => {
      if (!jobBreakdown[occ.jobName]) {
        jobBreakdown[occ.jobName] = {
          count: 0,
          dates: [],
          jobIds: []
        };
      }
      jobBreakdown[occ.jobName].count++;
      jobBreakdown[occ.jobName].dates.push(occ.date);
      jobBreakdown[occ.jobName].jobIds.push(occ.jobId);
    });
    
    entry.affectedJobs = Object.keys(jobBreakdown).map(jobName => ({
      jobName: jobName,
      count: jobBreakdown[jobName].count,
      latestDate: jobBreakdown[jobName].dates[0],
      jobIds: jobBreakdown[jobName].jobIds
    })).sort((a, b) => b.count - a.count);
    
    // Count unique jobs affected
    entry.uniqueJobsAffected = entry.affectedJobs.length;
  });
}

enrichFailedTestsIndex();

// Build output data
const outputData = {
  lastRefresh: new Date().toISOString(),
  sections: sections,
  failedTestsIndex: failedTestsIndex // NEW: global index of all failed tests
};

// Write data.json
fs.writeFileSync('data.json', JSON.stringify(outputData, null, 2));
console.log(`Written data.json with ${sections.length} sections`);
console.log(`Tracking ${Object.keys(failedTestsIndex).length} unique failed tests`);

// Log summary
sections.forEach(section => {
  const passed = section.tests.filter(t => t.status === 'passed').length;
  const failed = section.tests.filter(t => t.status === 'failed').length;
  const notRun = section.tests.filter(t => t.status === 'not_run').length;
  const running = section.tests.filter(t => t.status === 'running').length;
  console.log(`Section "${section.name}": ${passed} passed, ${failed} failed, ${running} running, ${notRun} not run`);
  
  // Log failure details if any
  section.tests.filter(t => t.failedTestsInWeather?.length > 0).forEach(t => {
    console.log(`  ${t.name}: ${t.failureCount} failures in 10 days`);
    t.failedTestsInWeather.slice(0, 3).forEach(f => {
      console.log(`    - "${f.name}" failed ${f.count}x`);
    });
  });
});

console.log('Data processing complete!');

// Helper functions
function getFailedStep(job) {
  if (!job || !job.steps) return 'Unknown step';
  const failedStep = job.steps.find(s => s.conclusion === 'failure');
  return failedStep?.name || 'Run tests';
}

function formatDuration(startTime, endTime) {
  if (!startTime || !endTime) return 'N/A';
  const start = new Date(startTime);
  const end = new Date(endTime);
  const diffMs = end - start;
  if (isNaN(diffMs) || diffMs < 0) return 'N/A';
  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'N/A';
  const now = new Date();
  const diffMs = now - date;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours === 0) {
      return 'Just now';
    }
    return `${diffHours}h ago`;
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
}

