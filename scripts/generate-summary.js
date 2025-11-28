#!/usr/bin/env node
/**
 * Generate daily summary from dashboard data
 * 
 * Reads: data.json, config.yaml
 * Outputs: summary.json (to stdout)
 */

const fs = require('fs');

// Load data
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));

// Calculate overall stats
const allTests = data.sections.flatMap(s => s.tests);
const totalTests = allTests.length;
const failedCount = allTests.filter(t => t.status === 'failed').length;
const runningCount = allTests.filter(t => t.status === 'running').length;
const passedCount = allTests.filter(t => t.status === 'passed').length;
const overallPassRate = Math.round((passedCount / totalTests) * 100);

// Calculate per-section stats
const sections = data.sections.map(section => {
  const tests = section.tests;
  const failed = tests.filter(t => t.status === 'failed').length;
  const passed = tests.filter(t => t.status === 'passed').length;
  const passRate = Math.round((passed / tests.length) * 100);
  
  let weatherEmoji = '☀️';
  if (passRate < 95) weatherEmoji = '🌤️';
  if (passRate < 85) weatherEmoji = '⛅';
  if (passRate < 70) weatherEmoji = '🌧️';
  if (passRate < 50) weatherEmoji = '⛈️';
  
  return {
    name: section.name,
    total: tests.length,
    failed,
    passed,
    pass_rate: passRate,
    weather_emoji: weatherEmoji
  };
});

// Get failing tests with details
const failingTests = allTests
  .filter(t => t.status === 'failed')
  .map(t => {
    // Calculate days failing (count consecutive failed days from today)
    const weather = t.weatherHistory || [];
    let daysFailing = 0;
    for (let i = weather.length - 1; i >= 0; i--) {
      if (weather[i].status === 'failed') {
        daysFailing++;
      } else {
        break;
      }
    }
    
    return {
      name: t.name,
      error_step: t.error?.step || 'Unknown',
      days_failing: daysFailing,
      run_id: t.runId
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
        transitions
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

