/**
 * Kata CI Dashboard - Application Logic
 */

// ============================================
// State
// ============================================

let state = {
  data: null,
  loading: true,
  error: null,
  filter: 'all',
  searchQuery: '',
  expandedSections: new Set(),
  expandedGroups: new Set()
};

// ============================================
// Data Loading
// ============================================

async function loadData() {
  state.loading = true;
  state.error = null;
  renderLoading();
  
  try {
    const response = await fetch('data.json?t=' + Date.now());
    if (!response.ok) {
      throw new Error('Data not available yet');
    }
    state.data = await response.json();
    state.loading = false;
    
    // Auto-expand sections with failures
  state.data.sections.forEach(section => {
      const hasFailures = section.tests.some(t => t.status === 'failed');
      if (hasFailures) {
        state.expandedSections.add(section.id);
        state.expandedGroups.add(`${section.id}-failed`);
      }
    });
    
    render();
  } catch (error) {
    state.loading = false;
    state.error = error.message;
    renderError();
  }
}

// ============================================
// Utility Functions
// ============================================

function getWeatherFromHistory(weatherHistory) {
  if (!weatherHistory) return [];
  return weatherHistory.map(h => h.status);
}

function getWeatherEmoji(weatherHistory) {
  if (!weatherHistory || weatherHistory.length === 0) return '❓';
  const weather = getWeatherFromHistory(weatherHistory);
  const passedCount = weather.filter(w => w === 'passed').length;
  const percentage = (passedCount / weather.length) * 100;
  
  if (percentage === 100) return '☀️';
  if (percentage >= 85) return '🌤️';
  if (percentage >= 70) return '⛅';
  if (percentage >= 50) return '🌧️';
  return '⛈️';
}

function getWeatherPercentage(weatherHistory) {
  if (!weatherHistory || weatherHistory.length === 0) return 0;
  const weather = getWeatherFromHistory(weatherHistory);
  const passedCount = weather.filter(w => w === 'passed').length;
  return Math.round((passedCount / weather.length) * 100);
}

function getSectionStats(tests) {
  const failed = tests.filter(t => t.status === 'failed').length;
  const passed = tests.filter(t => t.status === 'passed').length;
  const notRun = tests.filter(t => t.status === 'not_run' || t.status === 'running').length;
  
  // Count total failure days across all tests in section
  const totalFailureDays = tests.reduce((sum, t) => {
    const failDays = (t.weatherHistory || []).filter(w => w.status === 'failed').length;
    return sum + failDays;
  }, 0);
  
  // Calculate overall weather
  const allWeather = tests.flatMap(t => t.weatherHistory || []);
  const weatherPercent = getWeatherPercentage(allWeather);
  const weatherEmoji = getWeatherEmoji(allWeather);
  
  return { failed, passed, notRun, total: tests.length, totalFailureDays, weatherPercent, weatherEmoji };
}

function getTotalStats() {
  if (!state.data) return { total: 0, failed: 0, passed: 0, notRun: 0, failureDays: 0 };
  const allTests = state.data.sections.flatMap(s => s.tests);
  
  // Count failure DAYS across all tests (sum of days each test failed)
  const failureDays = allTests.reduce((sum, t) => {
    return sum + (t.weatherHistory || []).filter(w => w.status === 'failed').length;
  }, 0);
  
  return {
    total: allTests.length,
    failed: allTests.filter(t => t.status === 'failed').length, // Only current failures
    passed: allTests.filter(t => t.status === 'passed').length,
    notRun: allTests.filter(t => t.status === 'not_run').length,
    failureDays: failureDays
  };
}

function filterTests(tests) {
  let filtered = tests;
  
  if (state.filter !== 'all') {
    filtered = filtered.filter(t => t.status === state.filter);
  }
  
  if (state.searchQuery) {
    const query = state.searchQuery.toLowerCase();
    filtered = filtered.filter(t => t.name.toLowerCase().includes(query));
  }
  
  return filtered;
}

function formatDate() {
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  return new Date().toLocaleDateString('en-US', options);
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  
  return date.toLocaleDateString();
}

// ============================================
// Render Functions
// ============================================

function renderLoading() {
  const container = document.getElementById('sections-container');
  container.innerHTML = `
    <div class="loading-state">
      <div class="loading-spinner">⟳</div>
      <h3>Loading dashboard data...</h3>
      <p>Fetching latest CI results</p>
    </div>
  `;
}

function renderError() {
  const container = document.getElementById('sections-container');
  container.innerHTML = `
    <div class="error-state">
      <div class="error-icon">📊</div>
      <h3>No Data Available Yet</h3>
      <p>The dashboard is waiting for the first data refresh.</p>
      <p class="error-hint">
        Run the "Update CI Dashboard Data" workflow in 
        <a href="https://github.com/kata-containers/ci-dashboard/actions" target="_blank">GitHub Actions</a>
        to fetch initial data.
      </p>
      <button class="btn btn-primary" onclick="loadData()">
        ⟳ Try Again
      </button>
    </div>
  `;
  
  // Update stats to show zeros
  document.getElementById('total-tests').textContent = '0';
  document.getElementById('failed-tests').textContent = '0';
  document.getElementById('not-run-tests').textContent = '0';
  document.getElementById('passed-tests').textContent = '0';
}

function render() {
  if (state.loading) {
    renderLoading();
    return;
  }
  
  if (state.error || !state.data) {
    renderError();
    return;
  }
  
  updateStats();
  renderSections();
  
  // Update last refresh time
  if (state.data.lastRefresh) {
    document.getElementById('last-refresh-time').textContent = 
      formatRelativeTime(state.data.lastRefresh);
  }
}

function renderSections() {
  const container = document.getElementById('sections-container');
  container.innerHTML = '';
  
  if (!state.data || !state.data.sections || state.data.sections.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No sections configured</h3>
        <p>Add sections to config.yaml to start monitoring tests.</p>
      </div>
    `;
    return;
  }
  
  state.data.sections.forEach(section => {
    const filteredTests = filterTests(section.tests || []);
    if (filteredTests.length === 0 && state.filter !== 'all') return;
    
    const stats = getSectionStats(section.tests || []);
    const isExpanded = state.expandedSections.has(section.id);
    
    const sectionEl = document.createElement('div');
    sectionEl.className = `section ${isExpanded ? 'expanded' : ''}`;
    // Build status badges for section
    const statusBadges = [];
    if (stats.failed > 0) {
      statusBadges.push(`<span class="section-status has-failed">${stats.failed} failed</span>`);
    }
    if (stats.notRun > 0) {
      statusBadges.push(`<span class="section-status has-not-run">${stats.notRun} not run</span>`);
    }
    if (statusBadges.length === 0 && stats.passed === stats.total) {
      statusBadges.push(`<span class="section-status all-green">All Green</span>`);
    }
    
    sectionEl.innerHTML = `
      <div class="section-header" data-section="${section.id}">
        <span class="section-toggle">▶</span>
        <span class="section-name">${section.name}</span>
        <div class="section-meta">
          <span class="section-count">${stats.total} tests</span>
          <span class="section-weather">
            <span class="section-weather-icon">${stats.weatherEmoji}</span>
            ${stats.weatherPercent}%
          </span>
          ${statusBadges.join('')}
        </div>
      </div>
      <div class="section-content">
        ${renderTestGroups(section, filteredTests)}
      </div>
    `;
    
    container.appendChild(sectionEl);
  });
  
  // Add click handlers for section headers
  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const sectionId = header.dataset.section;
      toggleSection(sectionId);
    });
  });
  
  // Add click handlers for test group headers
  document.querySelectorAll('.test-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      const groupId = header.dataset.group;
      toggleGroup(groupId);
    });
  });
  
  // Add click handlers for test names (show error if available)
  document.querySelectorAll('.test-name-text[data-test-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const testId = el.dataset.testId;
      const sectionId = el.dataset.sectionId;
      showErrorModal(sectionId, testId);
    });
  });
  
  // Add click handlers for failure badges (show weather/analysis)
  document.querySelectorAll('.test-failure-badge').forEach(badge => {
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      const testId = badge.dataset.testId;
      const sectionId = badge.dataset.sectionId;
      showWeatherModal(sectionId, testId);
    });
  });
  
  // Add click handlers for weather columns
  document.querySelectorAll('.test-weather-col[data-test-id]').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      const testId = col.dataset.testId;
      const sectionId = col.dataset.sectionId;
      showWeatherModal(sectionId, testId);
    });
  });
}

function renderTestGroups(section, tests) {
  const failed = tests.filter(t => t.status === 'failed');
  const notRun = tests.filter(t => t.status === 'not_run');
  const passed = tests.filter(t => t.status === 'passed');
  
  let html = '';
  
  // Failed tests
  if (failed.length > 0) {
    const groupId = `${section.id}-failed`;
    const isExpanded = state.expandedGroups.has(groupId) || state.filter === 'failed';
    html += renderTestGroup(section, failed, groupId, 'FAILED', 'failed', isExpanded);
  }
  
  // Not run tests
  if (notRun.length > 0) {
    const groupId = `${section.id}-not-run`;
    const isExpanded = state.expandedGroups.has(groupId) || state.filter === 'not_run';
    html += renderTestGroup(section, notRun, groupId, 'NOT RUN', 'not-run', isExpanded);
  }
  
  // Passed tests
  if (passed.length > 0) {
    const groupId = `${section.id}-passed`;
    const isExpanded = state.expandedGroups.has(groupId) || state.filter === 'passed';
    html += renderTestGroup(section, passed, groupId, 'PASSED', 'passed', isExpanded);
  }
  
  return html;
}

function renderTestGroup(section, tests, groupId, label, statusClass, isExpanded) {
  return `
      <div class="test-group ${isExpanded ? 'expanded' : ''}" data-group-id="${groupId}">
        <div class="test-group-header" data-group="${groupId}">
          <div class="test-group-title">
            <span class="test-group-toggle">▶</span>
          <span class="dot dot-${statusClass}"></span>
          ${label} (${tests.length})
          </div>
        </div>
        <div class="test-group-content">
            <div class="test-table-header">
              <span>Test Name</span>
              <span>Run</span>
              <span>Last Failure</span>
              <span>Last Success</span>
          <span class="weather-header">Weather <span class="weather-range">(oldest ← 10 days → newest)</span></span>
              <span>Retried</span>
            </div>
        ${tests.map(t => renderTestRow(section.id, t)).join('')}
        </div>
      </div>
    `;
}

function renderTestRow(sectionId, test) {
  const weather = getWeatherFromHistory(test.weatherHistory);
  const weatherDots = weather.length > 0 
    ? weather.map(w => `<span class="weather-dot ${w}"></span>`).join('')
    : '<span class="weather-dot none"></span>'.repeat(10);
  
  const weatherEmoji = getWeatherEmoji(test.weatherHistory);
  const passedCount = weather.filter(w => w === 'passed').length;
  const failedCount = weather.filter(w => w === 'failed').length;
  
  const statusDisplay = {
    'passed': '● Passed',
    'failed': '○ Failed',
    'not_run': '⊘ Not Run',
    'running': '◌ Running'
  };
  
  // Check if there are failing tests to show
  const hasFailingTests = test.failedTestsInWeather && test.failedTestsInWeather.length > 0;
  const failingTestsPreview = hasFailingTests 
    ? test.failedTestsInWeather.slice(0, 2).map(f => f.name.substring(0, 40)).join(', ')
    : '';
  
  // Build inline failure info
  const failureInfo = [];
  if (test.error && test.error.failures?.length > 0) {
    failureInfo.push(`${test.error.failures.length} test${test.error.failures.length > 1 ? 's' : ''} failed`);
  }
  if (hasFailingTests) {
    const uniqueCount = test.failedTestsInWeather.length;
    const totalOccurrences = test.failedTestsInWeather.reduce((s, f) => s + f.count, 0);
    failureInfo.push(`${uniqueCount} unique failure${uniqueCount > 1 ? 's' : ''} in 10 days`);
  }
  
  return `
    <div class="test-row ${test.status}">
      <div class="test-name-col">
        <div class="test-name">
          <span class="test-status-dot ${test.status}"></span>
          <span class="test-name-text" ${test.error ? `data-test-id="${test.id}" data-section-id="${sectionId}" style="cursor:pointer"` : ''}>${test.name}</span>
          ${failureInfo.length > 0 ? `
            <span class="test-failure-badge" data-test-id="${test.id}" data-section-id="${sectionId}">
              ⚠️ ${failureInfo.join(' · ')}
          </span>
        ` : ''}
        </div>
      </div>
      <div class="test-run-col">
        <span class="test-run-status ${test.status}">${statusDisplay[test.status] || test.status}</span>
        <span class="test-run-duration">${test.duration || 'N/A'}</span>
      </div>
      <div class="test-time-col">
        ${test.lastFailure === 'Never' || !test.lastFailure ? '<span class="never">Never</span>' : test.lastFailure}
      </div>
      <div class="test-time-col">
        ${test.lastSuccess || 'N/A'}
      </div>
      <div class="test-weather-col" data-test-id="${test.id}" data-section-id="${sectionId}" title="Click for 10-day history">
        <div class="weather-dots">${weatherDots}</div>
        <div class="weather-summary">
          <span class="weather-icon">${weatherEmoji}</span>
          ${passedCount}/${weather.length || 10}
          ${failedCount > 0 ? `<span class="weather-failed-count">(${failedCount} ✗)</span>` : ''}
        </div>
      </div>
      <div class="test-retried-col">
        ${test.retried || 0}
        ${test.setupRetry ? '<span class="setup-retry">⚙️ (setup)</span>' : ''}
      </div>
    </div>
  `;
}

function updateStats() {
  const stats = getTotalStats();
  document.getElementById('total-tests').textContent = stats.total;
  document.getElementById('failed-tests').textContent = stats.failed;
  document.getElementById('not-run-tests').textContent = stats.notRun;
  document.getElementById('passed-tests').textContent = stats.passed;
  
  // Filter counts should show tests in that current status
  const allTests = state.data?.sections?.flatMap(s => s.tests) || [];
  document.getElementById('filter-failed-count').textContent = allTests.filter(t => t.status === 'failed').length;
  document.getElementById('filter-not-run-count').textContent = allTests.filter(t => t.status === 'not_run').length;
  document.getElementById('filter-passed-count').textContent = allTests.filter(t => t.status === 'passed').length;
}

// ============================================
// Event Handlers
// ============================================

function toggleSection(sectionId) {
  if (state.expandedSections.has(sectionId)) {
    state.expandedSections.delete(sectionId);
  } else {
    state.expandedSections.add(sectionId);
  }
  renderSections();
}

function toggleGroup(groupId) {
  if (state.expandedGroups.has(groupId)) {
    state.expandedGroups.delete(groupId);
  } else {
    state.expandedGroups.add(groupId);
  }
  renderSections();
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderSections();
}

function showWeatherModal(sectionId, testId) {
  const section = state.data.sections.find(s => s.id === sectionId);
  const test = section?.tests.find(t => t.id === testId);
  
  if (!test || !test.weatherHistory) {
    showToast('No weather history available', 'error');
    return;
  }
  
  const modal = document.getElementById('weather-modal');
  const title = document.getElementById('weather-modal-title');
  const body = document.getElementById('weather-modal-body');
  
  const weather = getWeatherFromHistory(test.weatherHistory);
  const weatherEmoji = getWeatherEmoji(test.weatherHistory);
  const passedCount = weather.filter(w => w === 'passed').length;
  const failedCount = weather.filter(w => w === 'failed').length;
  
  title.textContent = `${test.name} — 10 Day History`;
  
  const daysHtml = [...test.weatherHistory].reverse().map((day, index) => {
    const date = new Date(day.date);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isToday = index === 0;
    
    // Get failing tests for this day, deduplicate by name
    const rawDayFailures = day.failureDetails?.failures || [];
    const uniqueDayFailures = [];
    const seenNames = new Set();
    rawDayFailures.forEach(f => {
      if (!seenNames.has(f.name)) {
        seenNames.add(f.name);
        uniqueDayFailures.push(f);
      }
    });
    const failureCount = uniqueDayFailures.length;
    
    const messageText = day.status === 'passed' 
      ? `Completed in ${day.duration || 'N/A'}` 
      : day.status === 'failed' 
        ? null
        : 'No run recorded';
    
    return `
      <div class="weather-day-row ${day.status}">
        <div class="weather-day-date">
          ${formatted}
          <span class="day-name">${dayName}${isToday ? ' (Today)' : ''}</span>
        </div>
        <div class="weather-day-status ${day.status}">
          ${day.status === 'passed' ? '● Passed' : day.status === 'failed' ? '○ Failed' : '— No run'}
        </div>
        ${messageText ? `
          <div class="weather-day-message ${day.status === 'failed' ? 'failure-note' : ''}">
            ${messageText}
          </div>
        ` : ''}
        ${day.runId ? `
          <a href="https://github.com/kata-containers/kata-containers/actions/runs/${day.runId}${day.jobId ? '/job/' + day.jobId : ''}" 
             target="_blank" 
             class="weather-day-link">
            View Run
          </a>
        ` : ''}
      </div>
      ${day.status === 'failed' && failureCount > 0 ? `
        <div class="weather-day-failures">
          <div class="day-failures-header">Failed tests (${failureCount}):</div>
          <ul class="day-failures-list">
            ${uniqueDayFailures.slice(0, 5).map(f => `
              <li class="day-failure-item">
                <span class="failure-marker">✗</span>
                <span class="failure-name">${f.name}</span>
              </li>
            `).join('')}
            ${failureCount > 5 ? `<li class="day-failure-more">...and ${failureCount - 5} more</li>` : ''}
          </ul>
        </div>
      ` : ''}
    `;
  }).join('');
  
  // Build failing tests summary for this job
  // Use 60-day analysis if available, otherwise fall back to 10-day or build from weather
  let failingTestsForAnalysis = test.failedTestsAnalysis60d || test.failedTestsInWeather || [];
  
  if (failingTestsForAnalysis.length === 0 && failedCount > 0) {
    // Build from weather history days that have failureDetails
    const failureMap = {};
    test.weatherHistory.forEach(day => {
      if (day.status === 'failed' && day.failureDetails?.failures) {
        day.failureDetails.failures.forEach(f => {
          if (!failureMap[f.name]) {
            failureMap[f.name] = {
              name: f.name,
              count: 0,
              dates: [],
              files: new Set()
            };
          }
          failureMap[f.name].count++;
          // Deduplicate dates
          const dateStr = day.date.split('T')[0];
          if (!failureMap[f.name].dates.includes(dateStr)) {
            failureMap[f.name].dates.push(dateStr);
          }
          // Collect bats files (clean up GitHub Actions group markers)
          if (f.file) {
            const cleanFile = f.file.replace(/^##\[group\]/, '').trim();
            if (cleanFile) {
              failureMap[f.name].files.add(cleanFile);
            }
          }
        });
      }
    });
    failingTestsForAnalysis = Object.values(failureMap).map(ft => ({
      ...ft,
      files: Array.from(ft.files),
      dates: ft.dates.sort().reverse()
    })).sort((a, b) => b.count - a.count);
  }
  
  // If still empty but we have failures, try to get from failedTestsIndex (global index)
  if (failingTestsForAnalysis.length === 0 && failedCount > 0 && state.data?.failedTestsIndex) {
    const failureMap = {};
    Object.keys(state.data.failedTestsIndex).forEach(testName => {
      const entry = state.data.failedTestsIndex[testName];
      // Filter to this job only
      const jobOccurrences = entry.occurrences.filter(occ => occ.jobName === test.name);
      if (jobOccurrences.length > 0) {
        // Only include if within last 10 days
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 10);
        const recentOccurrences = jobOccurrences.filter(occ => new Date(occ.date) >= cutoffDate);
        if (recentOccurrences.length > 0) {
          const dates = [...new Set(recentOccurrences.map(o => o.date.split('T')[0]))].sort().reverse();
          failureMap[testName] = {
            name: testName,
            count: recentOccurrences.length,
            dates: dates
          };
        }
      }
    });
    failingTestsForAnalysis = Object.values(failureMap).sort((a, b) => b.count - a.count);
  }
  
  const analysisDays = test.failedTestsAnalysis60d ? 60 : 10;
  
  let failingTestsSummaryHtml = '';
  if (failingTestsForAnalysis.length > 0) {
    failingTestsSummaryHtml = `
      <div class="weather-failing-tests-summary">
        <h5>⚠️ Failing Tests Analysis (${analysisDays} days)</h5>
        <p class="summary-description">Tests that failed and their frequency:</p>
        <div class="failing-tests-list">
          ${failingTestsForAnalysis.map(ft => {
            // Find if this test fails in other jobs
            const otherJobs = getOtherJobsWithSameFailure(ft.name, test.name);
            
            // Deduplicate dates and format them
            const uniqueDates = [...new Set(ft.dates.map(d => {
              const dateStr = typeof d === 'string' ? d.split('T')[0] : d;
              return dateStr;
            }))].sort().reverse();
            const formattedDates = uniqueDates.map(d => {
              try {
                return new Date(d).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
              } catch {
                return d;
              }
            }).join(', ');
            
            // Get bats files (handle both array and Set)
            const batsFiles = ft.files ? (Array.isArray(ft.files) ? ft.files : Array.from(ft.files)) : [];
            const batsFileDisplay = batsFiles.length > 0 ? ` (${batsFiles.join(', ')})` : '';
            
            // Use unique days count, not total occurrences
            const dayCount = uniqueDates.length;
            
            return `
              <div class="failing-test-item">
                <div class="failing-test-header">
                  <span class="failing-test-name">${ft.name}${batsFileDisplay}</span>
                  <span class="failing-test-count">${dayCount}x in ${analysisDays} days</span>
              </div>
                <div class="failing-test-dates">
                  Failed on: ${formattedDates}
                </div>
                ${otherJobs.length > 0 ? `
                  <div class="failing-test-correlation">
                    <span class="correlation-label">Also failing in:</span>
                    <div class="correlation-jobs">
                      ${otherJobs.map(j => `
                        <span class="correlation-job">${j.jobName} (${j.count}x)</span>
            `).join('')}
          </div>
        </div>
                ` : `
                  <div class="failing-test-correlation">
                    <span class="correlation-label">Only happened with this test</span>
                  </div>
                `}
            </div>
            `;
          }).join('')}
          </div>
      </div>
    `;
  }
  
  body.innerHTML = `
    <div class="weather-detail-header">
      <span class="weather-detail-icon">${weatherEmoji}</span>
      <div class="weather-detail-stats">
        <h4>${passedCount}/${weather.length} days passed</h4>
        <p>${getWeatherPercentage(test.weatherHistory)}% success rate over the last 10 days</p>
      </div>
          </div>
          
    <div class="weather-days-list">
      ${daysHtml}
          </div>
          
    ${failingTestsSummaryHtml}
    
    ${failedCount > 0 && failingTestsForAnalysis.length === 0 ? `
      <div class="weather-failure-summary">
        <h5>⚠️ ${failedCount} failure${failedCount > 1 ? 's' : ''} in the last 10 days</h5>
        <p>Failed on these days:</p>
        <div class="failed-days-list">
          ${test.weatherHistory.filter(d => d.status === 'failed').map(day => {
            const date = new Date(day.date);
            const hasDetails = day.failureDetails?.failures?.length > 0;
            return `
              <div class="failed-day-item">
                <span class="failed-day-date">${date.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'})}</span>
                ${day.failureStep ? `<span class="failed-day-step">${day.failureStep}</span>` : '<span class="failed-day-step">(No details available)</span>'}
                ${day.runId ? `<a href="https://github.com/kata-containers/kata-containers/actions/runs/${day.runId}${day.jobId ? '/job/' + day.jobId : ''}" target="_blank" class="failed-day-link">View Run</a>` : ''}
                ${hasDetails ? `<span class="failed-day-note">(${day.failureDetails.failures.length} test${day.failureDetails.failures.length > 1 ? 's' : ''} failed - logs parsed)</span>` : ''}
              </div>
            `;
          }).join('')}
        </div>
        <p class="failure-note">Test details not available for this date. You can also click "View Run" to see the full logs on GitHub.</p>
            </div>
    ` : ''}
  `;
  
  modal.classList.add('active');
}

/**
 * Find other jobs that have the same failing test
 */
function getOtherJobsWithSameFailure(testName, currentJobName) {
  if (!state.data?.failedTestsIndex) return [];
  
  const entry = state.data.failedTestsIndex[testName];
  if (!entry || !entry.affectedJobs) return [];
  
  // Filter out the current job
  return entry.affectedJobs.filter(j => j.jobName !== currentJobName);
}

function showFailingTestsModal(sectionId, testId) {
  const section = state.data.sections.find(s => s.id === sectionId);
  const test = section?.tests.find(t => t.id === testId);
  
  // Use 60-day analysis if available, otherwise 10-day
  const failingTests = test?.failedTestsAnalysis60d || test?.failedTestsInWeather || [];
  const analysisDays = test?.failedTestsAnalysis60d ? 60 : 10;
  
  if (!test || failingTests.length === 0) {
    showToast('No failing test details available', 'error');
    return;
  }
  
  const modal = document.getElementById('weather-modal');
  const title = document.getElementById('weather-modal-title');
  const body = document.getElementById('weather-modal-body');
  
  title.textContent = `${test.name} — Failing Tests Analysis (${analysisDays} days)`;
  
  const testsHtml = failingTests.map(ft => {
    // Find if this test fails in other jobs
    const otherJobs = getOtherJobsWithSameFailure(ft.name, test.name);
    
    return `
      <div class="failing-test-card">
        <div class="failing-test-card-header">
          <div class="failing-test-info">
            <span class="failing-test-icon">✗</span>
            <span class="failing-test-name">${ft.name}</span>
            </div>
          <span class="failing-test-badge">${ft.count}x failed</span>
          </div>
          
        <div class="failing-test-card-body">
          <div class="failing-test-dates-section">
            <h6>Failed on these days:</h6>
            <div class="date-chips">
              ${ft.dates.map(d => {
                const date = new Date(d);
                return `<span class="date-chip">${date.toLocaleDateString('en-US', {weekday: 'short', month: 'short', day: 'numeric'})}</span>`;
              }).join('')}
        </div>
        </div>
          
          ${otherJobs.length > 0 ? `
            <div class="failing-test-cross-jobs">
              <h6>⚠️ This test also fails in other jobs:</h6>
              <div class="cross-job-list">
                ${otherJobs.map(j => `
                  <div class="cross-job-item">
                    <span class="cross-job-name">${j.jobName}</span>
                    <span class="cross-job-count">${j.count}x in 30 days</span>
          </div>
                `).join('')}
          </div>
        </div>
          ` : `
            <div class="failing-test-unique">
              <span class="unique-badge">✓ Unique to this job</span>
              <p>This test failure only occurs in this job.</p>
      </div>
          `}
    </div>
      </div>
    `;
  }).join('');
    
  body.innerHTML = `
    <div class="failing-tests-modal-header">
      <p>Analysis of specific test failures ("not ok" tests) from the last ${analysisDays} days:</p>
    </div>
    
    <div class="failing-tests-cards">
      ${testsHtml}
    </div>
  `;
  
  modal.classList.add('active');
}

function showErrorModal(sectionId, testId) {
  const section = state.data.sections.find(s => s.id === sectionId);
  const test = section?.tests.find(t => t.id === testId);
  
  if (!test || !test.error) {
    showToast('No error details available', 'error');
    return;
  }
  
  const modal = document.getElementById('error-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const githubLink = document.getElementById('github-log-link');
  
  title.textContent = `${test.name} — Error Details`;
  githubLink.href = `https://github.com/kata-containers/kata-containers/actions/runs/${test.runId}${test.jobId ? '/job/' + test.jobId : ''}`;
  
  // Check if we have detailed test results
  const hasTestResults = test.error.testResults && test.error.failures?.length > 0;
  
  let testResultsHtml = '';
  if (hasTestResults) {
    const stats = test.error.testResults;
    testResultsHtml = `
      <div class="test-results-summary">
        <h4>Test Results</h4>
        <div class="test-stats">
          <span class="stat-passed">✓ ${stats.passed} passed</span>
          <span class="stat-failed">✗ ${stats.failed} failed</span>
          ${stats.skipped > 0 ? `<span class="stat-skipped">○ ${stats.skipped} skipped</span>` : ''}
          <span class="stat-total">(${stats.total} total)</span>
        </div>
      </div>
      <div class="failed-tests-list">
        <h4>Failed Tests (${test.error.failures.length})</h4>
        <ul class="failures-list">
          ${test.error.failures.map(f => `
            <li class="failure-item">
              <span class="failure-marker">not ok ${f.number}</span>
              <span class="failure-name">${f.name}</span>
              ${f.comment ? `<span class="failure-comment"># ${f.comment}</span>` : ''}
            </li>
          `).join('')}
        </ul>
      </div>
    `;
  }
  
  body.innerHTML = `
    <div class="error-details">
      <div class="error-meta">
        <span>Duration: <strong>${test.duration || 'N/A'}</strong></span>
      </div>
      <div class="error-step">
        Failed Step: <strong>${test.error.step || 'Unknown'}</strong>
      </div>
      ${testResultsHtml}
      ${!hasTestResults ? `<pre class="error-output">${test.error.output || 'No error output available'}</pre>` : ''}
    </div>
  `;
  
  modal.dataset.runId = test.runId;
  modal.dataset.testName = test.name;
  
  modal.classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.querySelector('.toast-message').textContent = message;
  toast.className = `toast show ${type}`;
  
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

function copyError() {
  const errorOutput = document.querySelector('#modal-body .error-output');
  if (errorOutput) {
    navigator.clipboard.writeText(errorOutput.textContent);
    showToast('Error copied to clipboard', 'success');
  }
}

// ============================================
// Initialization
// ============================================

function init() {
  // Set current date
  document.getElementById('current-date').textContent = formatDate();
  
  // Load data
  loadData();
  
  // Event listeners
  document.getElementById('modal-close').addEventListener('click', () => closeModal('error-modal'));
  document.getElementById('weather-close').addEventListener('click', () => closeModal('weather-modal'));
  
  document.getElementById('copy-error').addEventListener('click', copyError);
  
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });
  
  // Search
  document.getElementById('search-tests').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderSections();
  });
  
  // Close modals on overlay click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.remove('active');
      }
    });
  });
  
  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
    }
  });
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
