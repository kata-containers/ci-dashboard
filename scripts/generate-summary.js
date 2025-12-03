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
  weather_emoji: overallPassRate >= 95 ? '☀️' : overallPassRate >= 85 ? '🌤️' : overallPassRate >= 70 ? '⛅' : overallPassRate >= 50 ? '🌧️' : '⛈️'
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
    return {
      name: t.name,
      error_step: t.error?.step || 'Unknown',
      days_failing: calculateDaysFailing(t.weatherHistory),
      run_id: t.runId,
      maintainers: t.maintainers || [],
      slack_mentions: resolveMaintainersToSlack(t.maintainers || [])
    };
  })
  .sort((a, b) => b.days_failing - a.days_failing);

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
      return {
        name: t.name,
        flaky_rate: flakyRate,
        transitions,
        maintainers: t.maintainers || [],
        slack_mentions: resolveMaintainersToSlack(t.maintainers || [])
      };
    }
    return null;
  })
  .filter(Boolean)
  .sort((a, b) => b.flaky_rate - a.flaky_rate);

// Calculate trend (compare with yesterday)
// This would require historical data; for now, use a placeholder
const trend = overallPassRate >= 90 ? 'Stable' : 
              overallPassRate >= 80 ? 'Slightly down' : 'Needs attention';
const trendEmoji = overallPassRate >= 90 ? '→' : 
                   overallPassRate >= 80 ? '↘️' : '📉';

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
  trend,
  trend_emoji: trendEmoji,
  sections,
  failing_tests: failingTests,
  flaky_tests: flakyTests
};

console.log(JSON.stringify(summary, null, 2));

