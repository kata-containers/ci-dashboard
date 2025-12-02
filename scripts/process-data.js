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
    const jobMaintainers = typeof job === 'object' ? (job.maintainers || []) : [];
    configuredJobs.push({ name: jobName, description: jobDesc, section: section.id, maintainers: jobMaintainers });
  });
});

// Load required tests from gatekeeper (authoritative source)
// Source: https://raw.githubusercontent.com/kata-containers/kata-containers/refs/heads/main/tools/testing/gatekeeper/required-tests.yaml
let requiredTests = [];
let requiredRegexps = [];
try {
  if (fs.existsSync('required-tests.yaml')) {
    const requiredTestsConfig = yaml.load(fs.readFileSync('required-tests.yaml', 'utf8'));
    
    // Get always-required tests
    requiredTests = requiredTestsConfig.required_tests || [];
    
    // Get required regexps
    requiredRegexps = requiredTestsConfig.required_regexps || [];
    
    // Get tests from the 'test' mapping (most comprehensive list)
    const testMapping = requiredTestsConfig.mapping?.test || {};
    if (testMapping.names) {
      requiredTests = requiredTests.concat(testMapping.names);
    }
    if (testMapping.regexps) {
      // Split by | to get individual patterns
      const patterns = testMapping.regexps.split('|').filter(p => p.trim());
      requiredRegexps = requiredRegexps.concat(patterns);
    }
    
    // Get tests from 'static' mapping
    const staticMapping = requiredTestsConfig.mapping?.static || {};
    if (staticMapping.names) {
      requiredTests = requiredTests.concat(staticMapping.names);
    }
    if (staticMapping.regexps) {
      const patterns = staticMapping.regexps.split('|').filter(p => p.trim());
      requiredRegexps = requiredRegexps.concat(patterns);
    }
    
    // Get tests from 'build' mapping
    const buildMapping = requiredTestsConfig.mapping?.build || {};
    if (buildMapping.names) {
      requiredTests = requiredTests.concat(buildMapping.names);
    }
    if (buildMapping.regexps) {
      const patterns = buildMapping.regexps.split('|').filter(p => p.trim());
      requiredRegexps = requiredRegexps.concat(patterns);
    }
    
    console.log(`Loaded ${requiredTests.length} required tests and ${requiredRegexps.length} required regexps from gatekeeper`);
  } else {
    console.warn('required-tests.yaml not found, falling back to config.yaml required_jobs');
    requiredTests = config.required_jobs || [];
  }
} catch (e) {
  console.warn('Failed to load required-tests.yaml:', e.message);
  requiredTests = config.required_jobs || [];
}

// Get category patterns from config
const categoryPatterns = config.job_categories || {};

/**
 * Determine which categories a job belongs to
 */
function getJobCategories(jobName) {
  const categories = [];
  const nameLower = jobName.toLowerCase();
  
  // Check each category
  Object.keys(categoryPatterns).forEach(category => {
    const patterns = categoryPatterns[category].patterns || [];
    if (patterns.some(p => nameLower.includes(p.toLowerCase()))) {
      categories.push(category);
    }
  });
  
  // Check if it's a required job
  // Required tests from gatekeeper are full paths like:
  // "Kata Containers CI / kata-containers-ci-on-push / run-k8s-tests-on-aks / run-k8s-tests (ubuntu, clh, normal)"
  // The job name from GitHub is just the final part like "run-k8s-tests (ubuntu, clh, normal)"
  // So we check if any required test path ends with this job name
  const isRequired = requiredTests.some(req => {
    const reqLower = req.toLowerCase();
    // Check if the required test ends with this job name (after " / ")
    return reqLower.endsWith(nameLower) || reqLower.endsWith(' / ' + nameLower);
  });
  
  // Also check required regexps
  const matchesRegexp = requiredRegexps.some(pattern => {
    try {
      const regex = new RegExp(pattern, 'i');
      return regex.test(jobName);
    } catch (e) {
      return false;
    }
  });
  
  if (isRequired || matchesRegexp) {
    categories.push('required');
  }
  
  return categories;
}

/**
 * Get all unique job names from raw data
 */
function getAllUniqueJobNames() {
  const jobNames = new Set();
  allJobs.forEach(job => {
    if (job.name) {
      jobNames.add(job.name);
    }
  });
  return Array.from(jobNames).sort();
}

console.log(`Found ${getAllUniqueJobNames().length} unique job names in raw data`);

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
    // Get categories including required status
    const categories = getJobCategories(jobName);
    const isRequired = categories.includes('required');
    
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
      jobName: jobName,
      fullName: jobName,
      status: status,
      categories: categories,
      isRequired: isRequired,
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

// Build "All Jobs" section from all unique job names
const allJobNames = getAllUniqueJobNames();
console.log(`Building 'All Jobs' section with ${allJobNames.length} jobs...`);

// Build a lookup map of configured jobs from sections (they have rich weather data with failure details)
const configuredJobsFromSections = new Map();
sections.forEach(section => {
  section.tests.forEach(test => {
    if (test.jobName || test.fullName) {
      configuredJobsFromSections.set(test.jobName || test.fullName, test);
    }
  });
});
console.log(`  Found ${configuredJobsFromSections.size} configured jobs with rich data`);

const allJobsSection = {
  id: 'all-jobs',
  name: 'All Jobs',
  description: 'All nightly CI jobs',
  tests: allJobNames.map(jobName => {
    // Check if this job is configured (has custom description/maintainers)
    const configuredJob = configuredJobs.find(cj => cj.name === jobName);
    // For All Jobs view, always use simplified job name (not description)
    // The description is only used in the TEE/NVIDIA section views
    const displayName = simplifyJobName(jobName);
    const maintainers = configuredJob?.maintainers || [];
    const testId = jobName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const categories = getJobCategories(jobName);
    
    // If this job was already processed in a section, reuse its rich data
    const existingTest = configuredJobsFromSections.get(jobName);
    if (existingTest) {
      return {
        ...existingTest,
        id: testId,
        name: displayName, // Use simplified name for All Jobs view
        jobName: jobName,
        fullName: jobName,
        categories: categories,
        isRequired: categories.includes('required')
      };
    }
    
    // Find jobs matching this name
    const matchingJobs = allJobs.filter(job => job.name === jobName)
      .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
    
    // With filter=all, we get jobs from ALL attempts for each workflow run.
    // Group by workflow_run_id to find the first attempt for each run.
    const jobsByRun = {};
    for (const job of matchingJobs) {
      const runId = job.workflow_run_id;
      if (!jobsByRun[runId]) {
        jobsByRun[runId] = [];
      }
      jobsByRun[runId].push(job);
    }
    
    // For each run, find the first attempt (run_attempt=1) - that's the real result
    // A job that fails on attempt 1 but passes on retry is FLAKY
    const getFirstAttemptJob = (runId) => {
      const jobs = jobsByRun[runId] || [];
      // Sort by run_attempt ascending to get first attempt
      const sorted = [...jobs].sort((a, b) => (a.run_attempt || 1) - (b.run_attempt || 1));
      return sorted[0] || null;
    };
    
    const getLatestAttemptJob = (runId) => {
      const jobs = jobsByRun[runId] || [];
      // Sort by run_attempt descending to get latest attempt  
      const sorted = [...jobs].sort((a, b) => (b.run_attempt || 1) - (a.run_attempt || 1));
      return sorted[0] || null;
    };
    
    // Get the most recent run's first attempt for current status
    const mostRecentRunId = matchingJobs[0]?.workflow_run_id;
    const firstAttemptJob = mostRecentRunId ? getFirstAttemptJob(mostRecentRunId) : null;
    const latestAttemptJob = mostRecentRunId ? getLatestAttemptJob(mostRecentRunId) : null;
    
    // Use first attempt for status determination (shows real failures)
    const latestJob = firstAttemptJob;
    
    // Check if there were retries that passed (flaky test indicator)
    const hadRetries = latestAttemptJob && latestAttemptJob.run_attempt > 1;
    const retriedAndPassed = hadRetries && 
      firstAttemptJob?.conclusion === 'failure' && 
      latestAttemptJob?.conclusion === 'success';
    
    let status = 'not_run';
    
    if (latestJob) {
      if (latestJob.conclusion === 'success') {
        status = 'passed';
      } else if (latestJob.conclusion === 'failure') {
        // Check if failure is in a fatal step
        const failedStep = latestJob.steps?.find(s => s.conclusion === 'failure');
        if (failedStep) {
          const isFatal = fatalStepPatterns.some(p => p.test(failedStep.name));
          status = isFatal ? 'failed' : 'not_run';
        } else {
          status = 'failed';
        }
      } else if (latestJob.status === 'in_progress' || latestJob.status === 'queued') {
        status = 'running';
      }
    }
    
    // Build weather history (last 10 days)
    const weatherHistory = [];
    const anchorDate = new Date();
    for (let i = 0; i < 10; i++) {
      const date = new Date(anchorDate);
      date.setDate(date.getDate() - (9 - i));
      date.setHours(0, 0, 0, 0);
      
      const dayJobs = matchingJobs.filter(job => {
        const jobDate = new Date(job.started_at || job.created_at);
        return jobDate.toDateString() === date.toDateString();
      });
      
      // Group day's jobs by workflow_run_id
      const dayJobsByRun = {};
      for (const job of dayJobs) {
        const runId = job.workflow_run_id;
        if (!dayJobsByRun[runId]) {
          dayJobsByRun[runId] = [];
        }
        dayJobsByRun[runId].push(job);
      }
      
      // Get the most recent run for this day
      const mostRecentDayJob = dayJobs[0];
      const dayRunId = mostRecentDayJob?.workflow_run_id;
      
      // For this day's run, get the FIRST attempt (shows real result)
      let dayJob = null;
      let dayRetried = false;
      
      if (dayRunId && dayJobsByRun[dayRunId]) {
        const runJobs = dayJobsByRun[dayRunId];
        // Sort by run_attempt to get first and last
        const sorted = [...runJobs].sort((a, b) => (a.run_attempt || 1) - (b.run_attempt || 1));
        dayJob = sorted[0]; // First attempt
        const lastAttempt = sorted[sorted.length - 1];
        // Job was retried if there are multiple attempts
        dayRetried = sorted.length > 1 || (lastAttempt?.run_attempt || 1) > 1;
      }
      
      let dayStatus = 'none';
      let failureStep = null;
      let failureDetails = null;
      
      if (dayJob) {
        if (dayJob.conclusion === 'success') {
          dayStatus = 'passed';
        } else if (dayJob.conclusion === 'failure') {
          dayStatus = 'failed';
          // Get the failed step name
          const failedStep = dayJob.steps?.find(s => s.conclusion === 'failure');
          if (failedStep) {
            failureStep = failedStep.name;
          }
          // Try to get failure details from parsed logs if available
          const logFile = `job-logs/${dayJob.id}.log`;
          if (fs.existsSync(logFile)) {
            const logContent = fs.readFileSync(logFile, 'utf-8');
            const parsed = parseTestFailures(logContent);
            if (parsed && parsed.failures && parsed.failures.length > 0) {
              failureDetails = parsed;
              failureStep = parsed.batsFiles?.join(', ') || failureStep;
            }
          }
        }
      }
      
      weatherHistory.push({
        date: date.toISOString(),
        status: dayStatus,
        retried: dayRetried, // True if there were multiple attempts for this job
        runId: dayJob?.workflow_run_id || dayJob?.run_id?.toString() || null,
        jobId: dayJob?.id?.toString() || null, // Links to FIRST attempt (the real result)
        duration: dayJob ? formatDuration(dayJob.started_at, dayJob.completed_at) : null,
        failureStep: failureStep,
        failureDetails: failureDetails
      });
    }
    
    // Find last failure and success (from first attempts only)
    const lastFailureJob = matchingJobs.find(j => j.conclusion === 'failure' && (j.run_attempt || 1) === 1);
    const lastSuccessJob = matchingJobs.find(j => j.conclusion === 'success' && (j.run_attempt || 1) === 1);
    
    return {
      id: testId,
      name: displayName,
      jobName: jobName, // Full job name for filtering
      fullName: jobName,
      status: status,
      categories: categories,
      isRequired: categories.includes('required'),
      duration: latestJob ? formatDuration(latestJob.started_at, latestJob.completed_at) : 'N/A',
      lastFailure: lastFailureJob ? formatRelativeTime(lastFailureJob.started_at) : 'Never',
      lastSuccess: lastSuccessJob ? formatRelativeTime(lastSuccessJob.started_at) : 'Never',
      weatherHistory: weatherHistory,
      failureCount: weatherHistory.filter(w => w.status === 'failed').length,
      retried: hadRetries, // True if there were workflow retries
      retriedAndPassed: retriedAndPassed, // True if first attempt failed but retry passed (FLAKY!)
      runId: latestJob?.workflow_run_id || latestJob?.run_id?.toString() || null,
      jobId: latestJob?.id?.toString() || null, // Links to first attempt
      maintainers: maintainers
    };
  })
};

console.log(`All Jobs section: ${allJobsSection.tests.length} jobs`);
console.log(`  Flaky (failed then passed on retry): ${allJobsSection.tests.filter(t => t.retriedAndPassed).length}`);
console.log(`  Required: ${allJobsSection.tests.filter(t => t.isRequired).length}`);
console.log(`  TEE: ${allJobsSection.tests.filter(t => t.categories.includes('tee')).length}`);
console.log(`  NVIDIA: ${allJobsSection.tests.filter(t => t.categories.includes('nvidia')).length}`);

// ============================================
// Rename Detection
// ============================================

/**
 * Calculate similarity between two strings (Levenshtein-based)
 */
function stringSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;
  
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1;
  
  // Simple character-based similarity
  let matches = 0;
  const longerChars = longer.toLowerCase().split('');
  const shorterChars = shorter.toLowerCase().split('');
  
  shorterChars.forEach((char, i) => {
    if (longerChars[i] === char) matches++;
  });
  
  return matches / longer.length;
}

/**
 * Get common prefix length between two strings
 */
function commonPrefixLength(str1, str2) {
  let i = 0;
  while (i < str1.length && i < str2.length && str1[i] === str2[i]) {
    i++;
  }
  return i;
}

/**
 * Detect potential job renames by analyzing job appearance patterns
 */
function detectRenames(allJobsSection, cachedData) {
  const detectedRenames = [];
  const notARename = config.not_a_rename || [];
  
  // Get current job names and their first appearance
  const currentJobs = new Map();
  allJobsSection.tests.forEach(test => {
    const jobName = test.jobName || test.fullName;
    // Find first day this job appeared in weather history
    const firstAppearance = test.weatherHistory?.find(w => w.status !== 'none');
    if (firstAppearance) {
      currentJobs.set(jobName, {
        name: jobName,
        firstSeen: new Date(firstAppearance.date),
        weatherHistory: test.weatherHistory
      });
    }
  });
  
  // Get cached job names (jobs that existed before)
  const cachedJobs = new Map();
  if (cachedData?.allJobsSection?.tests) {
    cachedData.allJobsSection.tests.forEach(test => {
      const jobName = test.jobName || test.fullName;
      cachedJobs.set(jobName, {
        name: jobName,
        weatherHistory: test.weatherHistory
      });
    });
  }
  
  // Also check sections
  if (cachedData?.sections) {
    cachedData.sections.forEach(section => {
      section.tests?.forEach(test => {
        const jobName = test.jobName || test.fullName;
        if (!cachedJobs.has(jobName)) {
          cachedJobs.set(jobName, {
            name: jobName,
            weatherHistory: test.weatherHistory
          });
        }
      });
    });
  }
  
  // Find jobs that disappeared (in cache but not in current with recent activity)
  const disappearedJobs = [];
  cachedJobs.forEach((cachedJob, jobName) => {
    if (!currentJobs.has(jobName)) {
      // Check if it had recent activity (within last 5 days in weather)
      const hadRecentActivity = cachedJob.weatherHistory?.slice(-5).some(w => w.status !== 'none');
      if (hadRecentActivity) {
        disappearedJobs.push(cachedJob);
      }
    }
  });
  
  // For each new job, check if it might be a rename of a disappeared job
  currentJobs.forEach((currentJob, jobName) => {
    // Skip if this job existed in cache
    if (cachedJobs.has(jobName)) return;
    
    // Check against disappeared jobs
    disappearedJobs.forEach(oldJob => {
      // Check if this pair is in not_a_rename list
      const isExcluded = notARename.some(entry => 
        entry.old === oldJob.name && entry.new === jobName
      );
      if (isExcluded) return;
      
      // Calculate similarity
      const similarity = stringSimilarity(oldJob.name, jobName);
      const prefixLen = commonPrefixLength(oldJob.name, jobName);
      const minLen = Math.min(oldJob.name.length, jobName.length);
      const prefixRatio = prefixLen / minLen;
      
      // Consider it a potential rename if:
      // - High overall similarity (>70%) OR
      // - Long common prefix (>60% of shorter string)
      if (similarity > 0.7 || prefixRatio > 0.6) {
        detectedRenames.push({
          oldName: oldJob.name,
          newName: jobName,
          similarity: Math.round(similarity * 100),
          detectedDate: new Date().toISOString(),
          oldWeatherHistory: oldJob.weatherHistory
        });
        console.log(`  Potential rename detected: "${oldJob.name}" → "${jobName}" (${Math.round(similarity * 100)}% similar)`);
      }
    });
  });
  
  // Also carry forward previously detected renames (within 3 days)
  if (cachedData?.detectedRenames) {
    const threeDaysAgo = new Date();
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    
    cachedData.detectedRenames.forEach(rename => {
      const detectedDate = new Date(rename.detectedDate);
      // Keep if still within 3 days and not already in current list
      if (detectedDate > threeDaysAgo) {
        const alreadyDetected = detectedRenames.some(r => 
          r.oldName === rename.oldName && r.newName === rename.newName
        );
        if (!alreadyDetected) {
          detectedRenames.push(rename);
        }
      }
    });
  }
  
  return detectedRenames;
}

/**
 * Merge weather history from old job into new job (for auto-aliasing)
 */
function mergeWeatherHistory(newHistory, oldHistory) {
  if (!oldHistory || !newHistory) return newHistory;
  
  const merged = [...newHistory];
  
  // For each day in old history, if new history has 'none', use old
  oldHistory.forEach(oldDay => {
    const oldDate = new Date(oldDay.date).toDateString();
    const newDayIndex = merged.findIndex(d => new Date(d.date).toDateString() === oldDate);
    
    if (newDayIndex !== -1 && merged[newDayIndex].status === 'none' && oldDay.status !== 'none') {
      merged[newDayIndex] = { ...oldDay };
    }
  });
  
  return merged;
}

// Detect renames
console.log('Detecting potential job renames...');
const detectedRenames = detectRenames(allJobsSection, cachedData);

if (detectedRenames.length > 0) {
  console.log(`Found ${detectedRenames.length} potential rename(s)`);
  
  // Apply auto-aliasing: merge old weather history into new jobs
  detectedRenames.forEach(rename => {
    // Find the new job in allJobsSection
    const newJob = allJobsSection.tests.find(t => 
      (t.jobName || t.fullName) === rename.newName
    );
    
    if (newJob && rename.oldWeatherHistory) {
      newJob.weatherHistory = mergeWeatherHistory(newJob.weatherHistory, rename.oldWeatherHistory);
      newJob.aliasedFrom = rename.oldName;
      console.log(`  Auto-aliased: "${rename.oldName}" → "${rename.newName}"`);
    }
    
    // Also update in sections if present
    sections.forEach(section => {
      const sectionJob = section.tests?.find(t => 
        (t.jobName || t.fullName) === rename.newName
      );
      if (sectionJob && rename.oldWeatherHistory) {
        sectionJob.weatherHistory = mergeWeatherHistory(sectionJob.weatherHistory, rename.oldWeatherHistory);
        sectionJob.aliasedFrom = rename.oldName;
      }
    });
  });
} else {
  console.log('No potential renames detected');
}

/**
 * Simplify long job names for display
 */
function simplifyJobName(fullName) {
  if (!fullName) return 'Unknown';
  
  // Split by " / " and take the last meaningful part
  const parts = fullName.split(' / ');
  
  // Get the last part (usually the most specific)
  let name = parts[parts.length - 1];
  
  // If there are 3+ parts, the last one is usually the job with params
  if (parts.length >= 2) {
    name = parts[parts.length - 1];
  }
  
  return name;
}

// ============================================
// Process CoCo Charts E2E Tests (external repo)
// ============================================

let cocoChartsSection = null;
try {
  if (fs.existsSync('coco-charts-jobs.json')) {
    const cocoChartsJobs = JSON.parse(fs.readFileSync('coco-charts-jobs.json', 'utf8'));
    console.log(`Processing ${cocoChartsJobs.length} CoCo Charts E2E jobs...`);
    
    // Get unique job names from CoCo Charts, filtering out non-E2E jobs
    const nonE2EJobs = ['Check What Changed', 'E2E Test Summary', 'Create Issue on E2E Failure'];
    const cocoJobNames = [...new Set(cocoChartsJobs.map(j => j.name))]
      .filter(name => !nonE2EJobs.includes(name))
      .sort();
    console.log(`  Found ${cocoJobNames.length} unique CoCo Charts E2E job names (filtered out ${nonE2EJobs.length} non-test jobs)`);
    
    cocoChartsSection = {
      id: 'coco-charts',
      name: 'CoCo',
      description: 'Confidential Containers E2E Tests (Nightly)',
      subProject: 'Charts',  // For future: Trustee, Guest Components
      sourceRepo: 'confidential-containers/charts',
      tests: cocoJobNames.map(jobName => {
        const testId = jobName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        
        // Find jobs matching this name
        const matchingJobs = cocoChartsJobs.filter(job => job.name === jobName)
          .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
        
        const latestJob = matchingJobs[0];
        let status = 'not_run';
        
        if (latestJob) {
          if (latestJob.conclusion === 'success') {
            status = 'passed';
          } else if (latestJob.conclusion === 'failure') {
            status = 'failed';
          } else if (latestJob.status === 'in_progress' || latestJob.status === 'queued') {
            status = 'running';
          }
        }
        
        // Build weather history (last 10 days)
        const weatherHistory = [];
        const anchorDate = new Date();
        for (let i = 0; i < 10; i++) {
          const date = new Date(anchorDate);
          date.setDate(date.getDate() - (9 - i));
          date.setHours(0, 0, 0, 0);
          
          const dayJobs = matchingJobs.filter(job => {
            const jobDate = new Date(job.started_at || job.created_at);
            return jobDate.toDateString() === date.toDateString();
          });
          
          const dayJob = dayJobs[0] || null;
          let dayStatus = 'none';
          let failureStep = null;
          
          if (dayJob) {
            if (dayJob.conclusion === 'success') {
              dayStatus = 'passed';
            } else if (dayJob.conclusion === 'failure') {
              dayStatus = 'failed';
              const failedStep = dayJob.steps?.find(s => s.conclusion === 'failure');
              failureStep = failedStep?.name || 'Unknown step';
            }
          }
          
          weatherHistory.push({
            date: date.toISOString(),
            status: dayStatus,
            runId: dayJob?.workflow_run_id || dayJob?.run_id?.toString() || null,
            jobId: dayJob?.id?.toString() || null,
            duration: dayJob ? formatDuration(dayJob.started_at, dayJob.completed_at) : null,
            failureStep: failureStep
          });
        }
        
        // Simplify job name for display
        // CoCo Charts job names are like: "E2E (ci / k3s / nydus / qemu-coco-dev)"
        let displayName = jobName;
        const match = jobName.match(/E2E \((.+)\)/);
        if (match) {
          displayName = match[1];
        }
        
        // Find last failure and success
        const lastFailureJob = matchingJobs.find(j => j.conclusion === 'failure');
        const lastSuccessJob = matchingJobs.find(j => j.conclusion === 'success');
        
        return {
          id: testId,
          name: displayName,
          jobName: jobName,
          fullName: jobName,
          status: status,
          duration: latestJob ? formatDuration(latestJob.started_at, latestJob.completed_at) : 'N/A',
          lastFailure: lastFailureJob ? formatRelativeTime(lastFailureJob.started_at) : 'Never',
          lastSuccess: lastSuccessJob ? formatRelativeTime(lastSuccessJob.started_at) : 'Never',
          weatherHistory: weatherHistory,
          failureCount: weatherHistory.filter(w => w.status === 'failed').length,
          retried: latestJob?.run_attempt > 1 ? latestJob.run_attempt - 1 : 0,
          runId: latestJob?.workflow_run_id || latestJob?.run_id?.toString() || null,
          jobId: latestJob?.id?.toString() || null,
          sourceRepo: 'confidential-containers/charts',
          maintainers: []
        };
      })
    };
    
    console.log(`CoCo Charts section: ${cocoChartsSection.tests.length} jobs`);
    const passed = cocoChartsSection.tests.filter(t => t.status === 'passed').length;
    const failed = cocoChartsSection.tests.filter(t => t.status === 'failed').length;
    console.log(`  ${passed} passed, ${failed} failed`);
  } else {
    console.log('No coco-charts-jobs.json found, skipping CoCo Charts section');
  }
} catch (e) {
  console.warn('Failed to process CoCo Charts data:', e.message);
}

// ============================================
// Process CoCo Cloud API Adaptor E2E Tests
// ============================================

let cocoCAASection = null;
try {
  if (fs.existsSync('coco-caa-jobs.json')) {
    const caaJobs = JSON.parse(fs.readFileSync('coco-caa-jobs.json', 'utf8'));
    console.log(`Processing ${caaJobs.length} Cloud API Adaptor E2E jobs...`);
    
    // Get unique job names, filtering out non-E2E jobs and undefined names
    const nonE2EJobs = ['build images'];
    const caaJobNames = [...new Set(caaJobs.map(j => j.name).filter(name => name))]
      .filter(name => !nonE2EJobs.some(n => name.toLowerCase().includes(n.toLowerCase())))
      .sort();
    console.log(`  Found ${caaJobNames.length} unique CAA E2E job names`);
    
    cocoCAASection = {
      id: 'coco-caa',
      name: 'Cloud API Adaptor',
      description: 'Cloud API Adaptor Daily E2E Tests',
      subProject: 'CAA',
      sourceRepo: 'confidential-containers/cloud-api-adaptor',
      tests: caaJobNames.map(jobName => {
        const testId = jobName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        
        // Find jobs matching this name
        const matchingJobs = caaJobs.filter(job => job.name === jobName)
          .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
        
        const latestJob = matchingJobs[0];
        let status = 'not_run';
        
        if (latestJob) {
          if (latestJob.conclusion === 'success') {
            status = 'passed';
          } else if (latestJob.conclusion === 'failure') {
            status = 'failed';
          } else if (latestJob.status === 'in_progress' || latestJob.status === 'queued') {
            status = 'running';
          }
        }
        
        // Build weather history (last 10 days)
        const weatherHistory = [];
        const anchorDate = new Date();
        for (let i = 0; i < 10; i++) {
          const date = new Date(anchorDate);
          date.setDate(date.getDate() - (9 - i));
          date.setHours(0, 0, 0, 0);
          
          const dayJobs = matchingJobs.filter(job => {
            const jobDate = new Date(job.started_at || job.created_at);
            return jobDate.toDateString() === date.toDateString();
          });
          
          const dayJob = dayJobs[0] || null;
          let dayStatus = 'none';
          let failureStep = null;
          
          if (dayJob) {
            if (dayJob.conclusion === 'success') {
              dayStatus = 'passed';
            } else if (dayJob.conclusion === 'failure') {
              dayStatus = 'failed';
              const failedStep = dayJob.steps?.find(s => s.conclusion === 'failure');
              failureStep = failedStep?.name || 'Unknown step';
            }
          }
          
          weatherHistory.push({
            date: date.toISOString(),
            status: dayStatus,
            runId: dayJob?.workflow_run_id || dayJob?.run_id?.toString() || null,
            jobId: dayJob?.id?.toString() || null,
            duration: dayJob ? formatDuration(dayJob.started_at, dayJob.completed_at) : null,
            failureStep: failureStep
          });
        }
        
        // Simplify job name for display
        let displayName = jobName;
        
        // Find last failure and success
        const lastFailureJob = matchingJobs.find(j => j.conclusion === 'failure');
        const lastSuccessJob = matchingJobs.find(j => j.conclusion === 'success');
        
        return {
          id: testId,
          name: displayName,
          jobName: jobName,
          fullName: jobName,
          status: status,
          duration: latestJob ? formatDuration(latestJob.started_at, latestJob.completed_at) : 'N/A',
          lastFailure: lastFailureJob ? formatRelativeTime(lastFailureJob.started_at) : 'Never',
          lastSuccess: lastSuccessJob ? formatRelativeTime(lastSuccessJob.started_at) : 'Never',
          weatherHistory: weatherHistory,
          failureCount: weatherHistory.filter(w => w.status === 'failed').length,
          retried: latestJob?.run_attempt > 1 ? latestJob.run_attempt - 1 : 0,
          runId: latestJob?.workflow_run_id || latestJob?.run_id?.toString() || null,
          jobId: latestJob?.id?.toString() || null,
          sourceRepo: 'confidential-containers/cloud-api-adaptor',
          maintainers: []
        };
      })
    };
    
    console.log(`Cloud API Adaptor section: ${cocoCAASection.tests.length} jobs`);
    const caaPassed = cocoCAASection.tests.filter(t => t.status === 'passed').length;
    const caaFailed = cocoCAASection.tests.filter(t => t.status === 'failed').length;
    console.log(`  ${caaPassed} passed, ${caaFailed} failed`);
  } else {
    console.log('No coco-caa-jobs.json found, skipping Cloud API Adaptor section');
  }
} catch (e) {
  console.warn('Failed to process Cloud API Adaptor data:', e.message);
}

// Build output data
const outputData = {
  lastRefresh: new Date().toISOString(),
  sections: sections,
  allJobsSection: allJobsSection, // NEW: all jobs for the "All" view
  cocoChartsSection: cocoChartsSection, // CoCo Charts E2E tests
  cocoCAASection: cocoCAASection, // CoCo Cloud API Adaptor E2E tests
  requiredTests: requiredTests,
  jobCategories: categoryPatterns,
  failedTestsIndex: failedTestsIndex,
  maintainersDirectory: config.maintainers_directory || {},
  detectedRenames: detectedRenames // Potential job renames (show warning for 3 days)
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

