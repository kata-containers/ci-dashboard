#!/usr/bin/env node
/**
 * Generate daily summary from dashboard data
 * 
 * Reads: data.json, config.yaml
 * Outputs: summary.json (to stdout)
 */

const fs = require('fs');
const yaml = require('js-yaml');

// Load data
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));

// Load config for maintainers directory
const config = yaml.load(fs.readFileSync('config.yaml', 'utf8'));
const maintainersDirectory = config.maintainers_directory || {};

/**
 * Resolve maintainer handles to Slack mentions
 * @param {string[]} handles - Array of maintainer handles (e.g., ["@fidencio"])
 * @returns {string} - Slack mentions string (e.g., "<@UU8N67ZN1>")
 */
function resolveMaintainersToSlack(handles) {
  if (!handles || handles.length === 0) return '';
  
  const mentions = handles.map(handle => {
    const maintainer = maintainersDirectory[handle];
    if (!maintainer) return handle; // Return raw handle if not found
    
    // Get Slack ID from kata-containers workspace (primary)
    const slackId = maintainer.slack?.['kata-containers'] || 
                    maintainer.slack?.['cloud-native'] ||
                    null;
    
    if (slackId) {
      return `<@${slackId}>`;
    }
    return maintainer.name || handle;
  });
  
  return mentions.join(' ');
}

// Use allJobsSection for the nightly "All Jobs" view
// This matches what the dashboard shows
const allJobsSection = data.allJobsSection || { tests: [] };
const allTests = allJobsSection.tests || [];
const totalTests = allTests.length;
const failedCount = allTests.filter(t => t.status === 'failed').length;
const notRunCount = allTests.filter(t => t.status === 'not_run' || t.status === 'none').length;
const runningCount = allTests.filter(t => t.status === 'running').length;
const passedCount = allTests.filter(t => t.status === 'passed').length;
const overallPassRate = totalTests > 0 ? Math.round((passedCount / totalTests) * 100) : 0;

// Create a single "All Jobs" section summary
const sections = [{
  name: "All Jobs",
  total: totalTests,
  failed: failedCount,
  passed: passedCount,
  not_run: notRunCount,
  pass_rate: overallPassRate,
  weather_emoji: overallPassRate >= 95 ? '☀️' : overallPassRate >= 85 ? '🌤️' : overallPassRate >= 70 ? '⛅' : overallPassRate >= 50 ? '🌧️' : '⛈️',
  tests: allTests  // Include full test list for filtering (e.g., SNP-specific workflows)
}];

/**
 * Calculate consecutive days failing from the end of weather history
 */
function calculateDaysFailing(weatherHistory) {
  const weather = weatherHistory || [];
  let daysFailing = 0;
  for (let i = weather.length - 1; i >= 0; i--) {
    if (weather[i].status === 'failed') {
      daysFailing++;
    } else {
      break;
    }
  }
  return daysFailing;
}

// Get failing tests with details
const failingTests = allTests
  .filter(t => t.status === 'failed')
  .map(t => {
    // Get the most recent failure from weather history for step info
    const recentFailure = (t.weatherHistory || [])
      .filter(w => w.status === 'failed')
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    
    // Get error step from: error field, weather history, or 'Unknown'
    const errorStep = t.error?.step || recentFailure?.failureStep || 'Unknown';
    
    // Get specific test failures if available (from bats/Go test output)
    const failureDetails = recentFailure?.failureDetails;
    const specificFailures = failureDetails?.failures?.map(f => f.name) || [];
    
    // Extract architecture from test name (e.g., [s390x], [ppc64le], [amd64], [arm64])
    const archMatch = t.name.match(/\[(s390x|ppc64le|amd64|arm64)\]/);
    const arch = archMatch ? archMatch[1] : 'amd64'; // Default to amd64 if not specified
    
    return {
      name: t.name,
      error_step: errorStep,
      specific_failures: specificFailures,
      days_failing: calculateDaysFailing(t.weatherHistory),
      run_id: t.runId,
      job_id: t.jobId,
      arch: arch,
      maintainers: t.maintainers || [],
      slack_mentions: resolveMaintainersToSlack(t.maintainers || [])
    };
  })
  .sort((a, b) => b.days_failing - a.days_failing);

// Calculate architecture breakdown for failing tests
const failingByArch = {};
failingTests.forEach(t => {
  failingByArch[t.arch] = (failingByArch[t.arch] || 0) + 1;
});
const archSummary = Object.entries(failingByArch)
  .sort((a, b) => b[1] - a[1])
  .map(([arch, count]) => `[${count}x ${arch}]`)
  .join(' ');

// Detect flaky tests (alternating pass/fail pattern)
const flakyTests = allTests
  .map(t => {
    const weather = t.weatherHistory || [];
    if (weather.length < 5) return null;
    
    // Count transitions between pass/fail
    let transitions = 0;
    for (let i = 1; i < weather.length; i++) {
      if (weather[i].status !== weather[i-1].status) {
        transitions++;
      }
    }
    
    const flakyRate = Math.round((transitions / (weather.length - 1)) * 100);
    
    // Consider flaky if more than 30% transitions
    if (flakyRate > 30) {
      // Extract architecture from test name
      const archMatch = t.name.match(/\[(s390x|ppc64le|amd64|arm64)\]/);
      const arch = archMatch ? archMatch[1] : 'amd64';
      
      return {
        name: t.name,
        flaky_rate: flakyRate,
        transitions,
        arch,
        maintainers: t.maintainers || [],
        slack_mentions: resolveMaintainersToSlack(t.maintainers || [])
      };
    }
    return null;
  })
  .filter(Boolean)
  .sort((a, b) => b.flaky_rate - a.flaky_rate);

// Group flaky tests by architecture
const flakyByArch = {};
flakyTests.forEach(t => {
  flakyByArch[t.arch] = (flakyByArch[t.arch] || 0) + 1;
});

// Create flaky arch summary string like "[2x s390x] [1x ppc64le]"
const flakyArchSummary = Object.entries(flakyByArch)
  .sort((a, b) => b[1] - a[1]) // Sort by count descending
  .map(([arch, count]) => `[${count}x ${arch}]`)
  .join(' ');

// Calculate historical stats from weather history
// Collect all dates from weather histories
const allDates = new Set();
allTests.forEach(t => {
  (t.weatherHistory || []).forEach(w => {
    if (w.date) allDates.add(w.date);
  });
});
const sortedDates = Array.from(allDates).sort().reverse();
const todayDate = sortedDates[0];

// Calculate failures for each of the last 10 days
const last10Days = sortedDates.slice(0, 10);
const failuresByDay = {};

last10Days.forEach(date => {
  let failedOnDate = 0;
  allTests.forEach(t => {
    const weather = t.weatherHistory || [];
    const entry = weather.find(w => w.date === date);
    if (entry && entry.status === 'failed') {
      failedOnDate++;
    }
  });
  failuresByDay[date] = failedOnDate;
});

// Calculate 10-day average for failures (excluding today for comparison)
const historicalDays = last10Days.slice(1); // Exclude today
const historicalFailures = historicalDays.map(d => failuresByDay[d] || 0);
const tenDayAvgFailed = historicalFailures.length > 0 
  ? historicalFailures.reduce((a, b) => a + b, 0) / historicalFailures.length 
  : 0;
const tenDayAvgFailedRounded = Math.round(tenDayAvgFailed * 10) / 10; // One decimal place

// Calculate trend vs 10-day average
const failedDelta = failedCount - tenDayAvgFailedRounded;
const trend = failedDelta < -0.5 ? 'Improving' : 
              failedDelta > 0.5 ? 'Regressing' : 'Stable';
const trendEmoji = failedDelta < -0.5 ? '↓' : 
                   failedDelta > 0.5 ? '↑' : '→';

// Calculate 10-day average for flaky jobs
// For flaky, we need to calculate how many jobs were flaky on each historical day
// Since flaky detection requires weather history, we estimate based on transitions
const flakyByDay = {};
historicalDays.forEach(date => {
  let flakyOnDate = 0;
  allTests.forEach(t => {
    const weather = t.weatherHistory || [];
    // Find index of this date in weather
    const dateIndex = weather.findIndex(w => w.date === date);
    if (dateIndex >= 4) { // Need at least 5 days of history up to this date
      const recentWeather = weather.slice(0, dateIndex + 1).slice(-5);
      let transitions = 0;
      for (let i = 1; i < recentWeather.length; i++) {
        if (recentWeather[i].status !== recentWeather[i-1].status) {
          transitions++;
        }
      }
      const flakyRate = Math.round((transitions / (recentWeather.length - 1)) * 100);
      if (flakyRate > 30) flakyOnDate++;
    }
  });
  flakyByDay[date] = flakyOnDate;
});

const historicalFlaky = historicalDays.map(d => flakyByDay[d] || 0);
const tenDayAvgFlaky = historicalFlaky.length > 0 
  ? historicalFlaky.reduce((a, b) => a + b, 0) / historicalFlaky.length 
  : 0;
const tenDayAvgFlakyRounded = Math.round(tenDayAvgFlaky * 10) / 10;
const flakyDelta = flakyTests.length - tenDayAvgFlakyRounded;

// Output summary
const summary = {
  date: new Date().toISOString(),
  overall_pass_rate: overallPassRate,
  total_tests: totalTests,
  failed_count: failedCount,
  not_run_count: notRunCount,
  running_count: runningCount,
  passed_count: passedCount,
  flaky_count: flakyTests.length,
  ten_day_avg_failed: tenDayAvgFailedRounded,
  ten_day_avg_flaky: tenDayAvgFlakyRounded,
  flaky_delta: flakyDelta,
  failed_delta: failedDelta,
  trend,
  trend_emoji: trendEmoji,
  sections,
  failing_tests: failingTests,
  failing_by_arch: failingByArch,
  failing_arch_summary: archSummary,
  flaky_tests: flakyTests,
  flaky_by_arch: flakyByArch,
  flaky_arch_summary: flakyArchSummary
};

console.log(JSON.stringify(summary, null, 2));

