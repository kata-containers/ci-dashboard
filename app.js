/**
 * Kata CI Dashboard - Application Logic
 */

// ============================================
// State
// ============================================

let state = {
  data: null,
  flakyData: null,
  loading: true,
  error: null,
  filter: 'all',
  viewMode: 'all', // 'all', 'tee', 'nvidia', 'ibm' - which section to show
  showRequiredOnly: false, // filter to show only required jobs
  searchQuery: '',
  expandedSections: new Set(),
  expandedGroups: new Set(),
  expandedFlakyTests: new Set(),
  activeTab: 'nightly',
  flakyJobFilter: 'all',
  // CoCo-specific state
  activeProject: 'kata', // 'kata' or 'coco'
  activeCocoTab: 'coco-charts', // 'coco-charts', 'coco-caa', etc.
  cocoFilter: 'all',
  cocoSearchQuery: '',
  caaFilter: 'all',
  caaSearchQuery: ''
};

// ============================================
// Data Loading
// ============================================

async function loadData() {
  state.loading = true;
  state.error = null;
  renderLoading();
  
  try {
    // Load nightly data
    const response = await fetch('data.json?t=' + Date.now());
    if (!response.ok) {
      throw new Error('Data not available yet');
    }
    state.data = await response.json();
    
    // Auto-expand sections with failures
  state.data.sections.forEach(section => {
      const hasFailures = section.tests.some(t => t.status === 'failed');
      if (hasFailures) {
        state.expandedSections.add(section.id);
        state.expandedGroups.add(`${section.id}-failed`);
      }
    });
    
    // Load flaky data (don't fail if not available)
    try {
      const flakyResponse = await fetch('flaky-data.json?t=' + Date.now());
      if (flakyResponse.ok) {
        state.flakyData = await flakyResponse.json();
        updateFlakyBadge();
      }
    } catch (e) {
      console.log('Flaky data not available yet');
    }
    
    state.loading = false;
    render();
  } catch (error) {
    state.loading = false;
    state.error = error.message;
    renderError();
  }
}

/**
 * Update the flaky tests badge count in the tab
 */
function updateFlakyBadge() {
  const badge = document.getElementById('flaky-count-badge');
  if (badge && state.flakyData) {
    const count = state.flakyData.flakyTests?.length || 0;
    if (count > 0) {
      badge.textContent = count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
  }
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
  
  // Get tests from the appropriate source based on view mode
  let testsToCount = [];
  
  if (state.viewMode === 'tee') {
    const section = state.data.sections?.find(s => s.id === 'tee');
    testsToCount = section?.tests || [];
  } else if (state.viewMode === 'nvidia') {
    const section = state.data.sections?.find(s => s.id === 'nvidia-gpu');
    testsToCount = section?.tests || [];
  } else if (state.viewMode === 'ibm') {
    const section = state.data.sections?.find(s => s.id === 'ibm');
    testsToCount = section?.tests || [];
  } else if (state.viewMode === 'coco-charts') {
    testsToCount = state.data.cocoChartsSection?.tests || [];
  } else {
    // For 'all' and 'required' views, use allJobsSection
    testsToCount = state.data.allJobsSection?.tests || state.data.sections?.flatMap(s => s.tests) || [];
  }
  
  // Apply required filter if enabled (not applicable for coco-charts)
  if (state.showRequiredOnly && state.viewMode !== 'coco-charts') {
    testsToCount = testsToCount.filter(t => matchesCategory(t, 'required'));
  }
  
  // Apply status and search filters
  const filteredTests = filterTests(testsToCount);
  
  // Count failure DAYS across filtered tests (sum of days each test failed)
  const failureDays = filteredTests.reduce((sum, t) => {
    return sum + (t.weatherHistory || []).filter(w => w.status === 'failed').length;
  }, 0);
  
  return {
    total: filteredTests.length,
    failed: filteredTests.filter(t => t.status === 'failed').length,
    passed: filteredTests.filter(t => t.status === 'passed').length,
    notRun: filteredTests.filter(t => t.status === 'not_run').length,
    failureDays: failureDays
  };
}

/**
 * Check if a job matches a category filter
 */
function matchesCategory(test, category) {
  if (category === 'all') return true;
  
  const jobName = test.jobName || test.fullName || test.name || '';
  
  // For 'tee', 'nvidia', and 'ibm', use the configured sections (exact match)
  if (category === 'tee' || category === 'nvidia' || category === 'ibm') {
    // Check if this job is in the configured section
    const sectionId = category === 'tee' ? 'tee' : (category === 'nvidia' ? 'nvidia-gpu' : 'ibm');
    const section = state.data?.sections?.find(s => s.id === sectionId);
    if (section) {
      return section.tests.some(t => t.fullName === jobName || t.jobName === jobName);
    }
    return false;
  }
  
  // Check required jobs
  if (category === 'required') {
    if (test.isRequired) return true;
    const requiredJobs = state.data?.requiredJobs || [];
    return requiredJobs.some(req => jobName === req || jobName.includes(req) || req.includes(jobName));
  }
  
  return false;
}

function filterTests(tests) {
  let filtered = tests;
  
  // Filter by required (applies to all view modes)
  if (state.showRequiredOnly) {
    filtered = filtered.filter(t => matchesCategory(t, 'required'));
  }
  
  // Filter by status
  if (state.filter !== 'all') {
    filtered = filtered.filter(t => t.status === state.filter);
  }
  
  // Filter by search query
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

/**
 * Resolve maintainer handles to display names with GitHub links
 * @param {string[]} handles - Array of maintainer handles (e.g., ["@fidencio"])
 * @returns {string} - HTML string with maintainer links
 */
function renderMaintainers(handles) {
  if (!handles || handles.length === 0) return '';
  
  const directory = state.data?.maintainersDirectory || {};
  
  const maintainerLinks = handles.map(handle => {
    const maintainer = directory[handle];
    if (!maintainer) {
      // Fallback: just show the handle as a GitHub link
      const username = handle.replace(/^@/, '');
      return `<a href="https://github.com/${username}" target="_blank" class="maintainer-link">${handle}</a>`;
    }
    
    const github = maintainer.github || handle.replace(/^@/, '');
    const name = maintainer.name || handle;
    
    return `<a href="https://github.com/${github}" target="_blank" class="maintainer-link" title="${name}">${handle}</a>`;
  });
  
  return maintainerLinks.join(', ');
}

/**
 * Get maintainer names (without links) for compact display
 */
function getMaintainerNames(handles) {
  if (!handles || handles.length === 0) return '';
  
  const directory = state.data?.maintainersDirectory || {};
  
  return handles.map(handle => {
    const maintainer = directory[handle];
    return maintainer?.name || handle;
  }).join(', ');
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
  updateJobCount();
  renderRenameWarnings();
  
  // Update last refresh time
  if (state.data.lastRefresh) {
    document.getElementById('last-refresh-time').textContent = 
      formatRelativeTime(state.data.lastRefresh);
  }
}

/**
 * Render warning banner for detected job renames
 */
function renderRenameWarnings() {
  const container = document.getElementById('rename-warnings');
  if (!container) return;
  
  // Get renames detected within last 3 days
  const threeDaysAgo = new Date();
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  
  const recentRenames = (state.data.detectedRenames || []).filter(rename => {
    const detectedDate = new Date(rename.detectedDate);
    return detectedDate > threeDaysAgo;
  });
  
  if (recentRenames.length === 0) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  
  const renamesList = recentRenames.map(rename => {
    const detectedDate = new Date(rename.detectedDate);
    const formattedDate = detectedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return `
      <div class="rename-item">
        <span class="rename-old">"${escapeHtml(rename.oldName)}"</span>
        <span class="rename-arrow">→</span>
        <span class="rename-new">"${escapeHtml(rename.newName)}"</span>
        <span class="rename-date">(detected ${formattedDate})</span>
      </div>
    `;
  }).join('');
  
  const configPatch = recentRenames.map(rename => 
    `  - old: "${rename.oldName}"\n    new: "${rename.newName}"`
  ).join('\n');
  
  container.innerHTML = `
    <div class="rename-warning-banner">
      <div class="rename-warning-header">
        <span class="rename-warning-icon">⚠️</span>
        <span class="rename-warning-title">Potential Job Renames Detected</span>
      </div>
      <p class="rename-warning-description">
        The following jobs appear to have been renamed. History has been merged automatically.
      </p>
      <div class="rename-list">
        ${renamesList}
      </div>
      <div class="rename-action">
        <p>If this is incorrect (these are separate tests), open a PR to add this to <code>ci-dashboard/config.yaml</code>:</p>
        <pre class="rename-config-patch">not_a_rename:
${configPatch}</pre>
      </div>
    </div>
  `;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderSections() {
  const container = document.getElementById('sections-container');
  container.innerHTML = '';
  
  if (!state.data) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No data available</h3>
        <p>Waiting for data to load...</p>
      </div>
    `;
    return;
  }
  
  // Determine which data source to use based on view mode
  let sectionsToRender = [];
  
  if (state.viewMode === 'tee') {
    // Use the configured TEE section (with descriptive names)
    const teeSection = state.data.sections?.find(s => s.id === 'tee');
    if (teeSection) {
      const filteredTests = filterTests(teeSection.tests || []);
      if (filteredTests.length > 0) {
        sectionsToRender.push({ ...teeSection, tests: filteredTests });
      }
    }
  } else if (state.viewMode === 'nvidia') {
    // Use the configured NVIDIA section (with descriptive names)
    const nvidiaSection = state.data.sections?.find(s => s.id === 'nvidia-gpu');
    if (nvidiaSection) {
      const filteredTests = filterTests(nvidiaSection.tests || []);
      if (filteredTests.length > 0) {
        sectionsToRender.push({ ...nvidiaSection, tests: filteredTests });
      }
    }
  } else if (state.viewMode === 'ibm') {
    // Use the configured IBM section (s390x tests)
    const ibmSection = state.data.sections?.find(s => s.id === 'ibm');
    if (ibmSection) {
      const filteredTests = filterTests(ibmSection.tests || []);
      if (filteredTests.length > 0) {
        sectionsToRender.push({ ...ibmSection, tests: filteredTests });
      }
    }
  } else if (state.viewMode === 'coco-charts') {
    // Use the CoCo Charts section (external repo)
    const cocoSection = state.data.cocoChartsSection;
    if (cocoSection) {
      const filteredTests = filterTests(cocoSection.tests || []);
      if (filteredTests.length > 0) {
        sectionsToRender.push({ ...cocoSection, tests: filteredTests });
      }
    }
  } else if (state.data.allJobsSection) {
    // For 'all' and 'required' views, use allJobsSection (flat list with simplified names)
    // The required filter is applied in filterTests() via showRequiredOnly flag
    const allJobs = state.data.allJobsSection;
    const filteredTests = filterTests(allJobs.tests || []);
    
    if (filteredTests.length > 0) {
      sectionsToRender.push({
        ...allJobs,
        tests: filteredTests
      });
    }
  } else if (state.data.sections && state.data.sections.length > 0) {
    // Fallback to configured sections
  state.data.sections.forEach(section => {
      const filteredTests = filterTests(section.tests || []);
      if (filteredTests.length > 0) {
        sectionsToRender.push({ ...section, tests: filteredTests });
      }
    });
  }
  
  if (sectionsToRender.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No jobs found</h3>
        <p>No jobs match the current filter criteria.</p>
      </div>
    `;
    return;
  }
  
  sectionsToRender.forEach(section => {
    const tests = section.tests || [];
    if (tests.length === 0) return;
    
    const stats = getSectionStats(tests);
    const isExpanded = state.expandedSections.has(section.id) || state.viewMode !== 'all' || state.showRequiredOnly || state.searchQuery;
    
    const sectionEl = document.createElement('div');
    sectionEl.className = `section ${isExpanded ? 'expanded' : ''}`;
    // Build status badges for section
    const statusBadges = [];
    if (stats.failed > 0) {
      statusBadges.push(`<span class="section-status has-failed">(${stats.failed} failed)</span>`);
    }
    if (stats.notRun > 0) {
      statusBadges.push(`<span class="section-status has-not-run">(${stats.notRun} not run)</span>`);
    }
    if (statusBadges.length === 0 && stats.passed === stats.total) {
      statusBadges.push(`<span class="section-status all-green">All Green</span>`);
    }
    
    // Build section title
    let sectionTitle = section.name;
    if (state.showRequiredOnly && section.id === 'all-jobs') {
      sectionTitle = 'Required Jobs';
    }
    
    sectionEl.innerHTML = `
      <div class="section-header" data-section="${section.id}">
        <span class="section-toggle">▶</span>
        <span class="section-name">${sectionTitle}</span>
        <div class="section-meta">
          <span class="section-count">${tests.length} jobs</span>
          <span class="section-weather">
            <span class="section-weather-icon">${stats.weatherEmoji}</span>
            ${stats.weatherPercent}%
          </span>
          ${statusBadges.join('')}
        </div>
      </div>
      <div class="section-content">
        ${renderTestGroups(section, tests)}
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
              <span>Maintainers</span>
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
  
  const maintainersHtml = test.maintainers && test.maintainers.length > 0
    ? renderMaintainers(test.maintainers)
    : '<span class="no-maintainer">—</span>';
  
  return `
    <div class="test-row ${test.status}">
      <div class="test-name-col">
        <div class="test-name">
          <span class="test-status-dot ${test.status}"></span>
          <span class="test-name-text" ${test.error ? `data-test-id="${test.id}" data-section-id="${sectionId}" style="cursor:pointer"` : ''}>${test.name}</span>
          ${test.isRequired ? '<span class="required-badge">required</span>' : ''}
          ${failureInfo.length > 0 ? `
            <span class="test-failure-badge" data-test-id="${test.id}" data-section-id="${sectionId}">
              ⚠️ ${failureInfo.join(' · ')}
          </span>
        ` : ''}
        </div>
      </div>
      <div class="test-maintainers-col">
        ${maintainersHtml}
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
  
  // Get tests based on current view mode for filter counts
  let viewTests = [];
  if (state.viewMode === 'tee') {
    const section = state.data?.sections?.find(s => s.id === 'tee');
    viewTests = section?.tests || [];
  } else if (state.viewMode === 'nvidia') {
    const section = state.data?.sections?.find(s => s.id === 'nvidia-gpu');
    viewTests = section?.tests || [];
  } else if (state.viewMode === 'ibm') {
    const section = state.data?.sections?.find(s => s.id === 'ibm');
    viewTests = section?.tests || [];
  } else if (state.viewMode === 'coco-charts') {
    viewTests = state.data?.cocoChartsSection?.tests || [];
  } else {
    // For 'all' and 'required' views, use allJobsSection
    viewTests = state.data?.allJobsSection?.tests || state.data?.sections?.flatMap(s => s.tests) || [];
  }
  
  // Apply required filter if enabled (not applicable for coco-charts)
  if (state.showRequiredOnly && state.viewMode !== 'coco-charts') {
    viewTests = viewTests.filter(t => matchesCategory(t, 'required'));
  }
  
  document.getElementById('filter-failed-count').textContent = viewTests.filter(t => t.status === 'failed').length;
  document.getElementById('filter-not-run-count').textContent = viewTests.filter(t => t.status === 'not_run').length;
  document.getElementById('filter-passed-count').textContent = viewTests.filter(t => t.status === 'passed').length;
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
  // Scroll to the clicked section after re-render
  setTimeout(() => {
    const sectionEl = document.querySelector(`.section-header[data-section="${sectionId}"]`);
    if (sectionEl) {
      sectionEl.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }, 0);
}

function toggleGroup(groupId) {
  if (state.expandedGroups.has(groupId)) {
    state.expandedGroups.delete(groupId);
  } else {
    state.expandedGroups.add(groupId);
  }
  
  // Re-render the appropriate section based on active project and tab
  if (state.activeProject === 'coco') {
    if (state.activeCocoTab === 'coco-charts') {
      renderCocoSections();
    } else if (state.activeCocoTab === 'coco-caa') {
      renderCAASections();
    }
  } else {
    renderSections();
  }
  
  // Scroll to the clicked group after re-render
  setTimeout(() => {
    const groupEl = document.querySelector(`.test-group-header[data-group="${groupId}"]`);
    if (groupEl) {
      groupEl.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    }
  }, 0);
}

function setFilter(filter) {
  state.filter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderSections();
  updateJobCount();
}

function setViewMode(mode) {
  state.viewMode = mode;
  
  // Update quick filter buttons (TEE/NVIDIA)
  document.querySelectorAll('.quick-filter-btn').forEach(btn => {
    const btnMode = btn.dataset.category;
    btn.classList.toggle('active', btnMode === mode);
  });
  
  // When switching to TEE/NVIDIA, the All button should still show the current required state
  updateAllRequiredButtons();
  
  updateStats();
  renderSections();
  updateJobCount();
}

function toggleRequiredFilter() {
  state.showRequiredOnly = !state.showRequiredOnly;
  updateAllRequiredButtons();
  
  updateStats();
  renderSections();
  updateJobCount();
}

function updateAllRequiredButtons() {
  // Update toggle buttons (All/Required)
  document.querySelectorAll('.category-btn').forEach(btn => {
    const btnCategory = btn.dataset.category;
    if (btnCategory === 'all') {
      btn.classList.toggle('active', !state.showRequiredOnly);
    } else if (btnCategory === 'required') {
      btn.classList.toggle('active', state.showRequiredOnly);
    }
  });
}

function updateJobCount() {
  if (!state.data) return;
  
  // Get total count (all jobs)
  const allTests = state.data.allJobsSection?.tests || state.data.sections?.flatMap(s => s.tests) || [];
  
  // Get visible count based on current view mode
  let visibleTests = [];
  if (state.viewMode === 'tee') {
    const section = state.data.sections?.find(s => s.id === 'tee');
    visibleTests = filterTests(section?.tests || []);
  } else if (state.viewMode === 'nvidia') {
    const section = state.data.sections?.find(s => s.id === 'nvidia-gpu');
    visibleTests = filterTests(section?.tests || []);
  } else if (state.viewMode === 'ibm') {
    const section = state.data.sections?.find(s => s.id === 'ibm');
    visibleTests = filterTests(section?.tests || []);
  } else if (state.viewMode === 'coco-charts') {
    visibleTests = filterTests(state.data.cocoChartsSection?.tests || []);
  } else {
    // For 'all' and 'required' views, use allJobsSection
    visibleTests = filterTests(allTests);
  }
  
  const visibleEl = document.getElementById('visible-jobs');
  const totalEl = document.getElementById('total-jobs');
  
  if (visibleEl) visibleEl.textContent = visibleTests.length;
  if (totalEl) totalEl.textContent = allTests.length;
}

function showWeatherModal(sectionId, testId) {
  // Look in regular sections, allJobsSection, cocoChartsSection, and cocoCAASection
  let section = state.data.sections.find(s => s.id === sectionId);
  if (!section && sectionId === 'all-jobs' && state.data.allJobsSection) {
    section = state.data.allJobsSection;
  }
  if (!section && sectionId === 'coco-charts' && state.data.cocoChartsSection) {
    section = state.data.cocoChartsSection;
  }
  if (!section && sectionId === 'coco-caa' && state.data.cocoCAASection) {
    section = state.data.cocoCAASection;
  }
  const test = section?.tests.find(t => t.id === testId);
  
  // Determine the GitHub repo for links
  const sourceRepo = test?.sourceRepo || 'kata-containers/kata-containers';
  
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
  
  // Build maintainers section
  const maintainersSection = test.maintainers && test.maintainers.length > 0
    ? `<div class="weather-maintainers">
         <span class="maintainers-label">Maintainers:</span>
         ${renderMaintainers(test.maintainers)}
       </div>`
    : '';
  
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
          <a href="https://github.com/${sourceRepo}/actions/runs/${day.runId}${day.jobId ? '/job/' + day.jobId : ''}" 
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
        ${maintainersSection}
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
  // Look in regular sections, allJobsSection, cocoChartsSection, and cocoCAASection
  let section = state.data.sections.find(s => s.id === sectionId);
  if (!section && sectionId === 'all-jobs' && state.data.allJobsSection) {
    section = state.data.allJobsSection;
  }
  if (!section && sectionId === 'coco-charts' && state.data.cocoChartsSection) {
    section = state.data.cocoChartsSection;
  }
  if (!section && sectionId === 'coco-caa' && state.data.cocoCAASection) {
    section = state.data.cocoCAASection;
  }
  const test = section?.tests.find(t => t.id === testId);
  
  if (!test || !test.error) {
    showToast('No error details available', 'error');
    return;
  }
  
  // Determine the GitHub repo for links
  const sourceRepo = test?.sourceRepo || 'kata-containers/kata-containers';
  
  const modal = document.getElementById('error-modal');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const githubLink = document.getElementById('github-log-link');
  
  title.textContent = `${test.name} — Error Details`;
  githubLink.href = `https://github.com/${sourceRepo}/actions/runs/${test.runId}${test.jobId ? '/job/' + test.jobId : ''}`;
  
  // Build maintainers section for error modal
  const errorMaintainersHtml = test.maintainers && test.maintainers.length > 0
    ? `<div class="error-maintainers">
         <span class="maintainers-label">Maintainers:</span>
         ${renderMaintainers(test.maintainers)}
       </div>`
    : '';
  
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
        ${errorMaintainersHtml}
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
// Tab Switching
// ============================================

function switchTab(tabName) {
  state.activeTab = tabName;
  
  // Update tab buttons (only within Kata content)
  document.querySelectorAll('#kata-content .tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Update tab content (only within Kata content)
  document.querySelectorAll('#kata-content .tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `${tabName}-content`);
  });
  
  // Render appropriate content
  if (tabName === 'nightly') {
    renderSections();
    updateStats();
    updateJobCount();
  } else if (tabName === 'prfailures') {
    renderPRFailures();
  }
}

// ============================================
// Flaky Tests Rendering
// ============================================

/**
 * Simplify long job names for display
 * e.g., "kata-containers-ci-on-push / run-kata-coco-tests / run-k8s-tests-on-tee (sev-snp, qemu-snp)"
 * becomes "run-k8s-tests-on-tee (sev-snp, qemu-snp)"
 */
function simplifyJobName(fullName) {
  if (!fullName) return 'Unknown';
  
  // Split by " / " and take the last meaningful part
  const parts = fullName.split(' / ');
  
  // Get the last part (usually the most specific)
  let name = parts[parts.length - 1];
  
  // If there are 3+ parts, the last one is usually the job with params
  // e.g., "run-k8s-tests (ubuntu, qemu, small)"
  if (parts.length >= 2) {
    name = parts[parts.length - 1];
  }
  
  return name;
  }
  
function renderPRFailures() {
  const byTestList = document.getElementById('flaky-by-test-list');
  const byJobList = document.getElementById('flaky-by-job-list');
  
  if (!state.flakyData) {
    byTestList.innerHTML = '<p class="empty-message">No data available. Analysis runs daily at 05:00 UTC.</p>';
    byJobList.innerHTML = '<p class="empty-message">No data available.</p>';
    return;
  }
  
  // Get all tests and filter to only flaky ones
  const allTests = state.flakyData.failedTests || state.flakyData.flakyTests || [];
  const flakyTests = allTests.filter(t => t.isConfirmedFlaky || t.flakyCount > 0);
  
  // Sort by flaky count
  flakyTests.sort((a, b) => (b.flakyCount || 0) - (a.flakyCount || 0));
  
  // Build job stats
  const jobStats = {};
  flakyTests.forEach(test => {
    // Get flaky occurrences for this test
    const flakyOccs = (test.recentOccurrences || []).filter(o => o.isFlaky);
    
    test.affectedJobs.forEach(job => {
      if (job.flakyCount > 0) {
        if (!jobStats[job.name]) {
          jobStats[job.name] = { 
            name: job.name, 
            displayName: job.displayName,
            flakyTests: [],
            occurrences: []
          };
        }
        // Get occurrences for this specific job
        const jobOccs = flakyOccs.filter(o => o.jobName === job.name);
        jobStats[job.name].flakyTests.push({ 
          name: test.name, 
          count: job.flakyCount, 
          file: test.file,
          occurrences: jobOccs
        });
        jobStats[job.name].occurrences.push(...jobOccs);
        }
    });
  });
  
  const sortedJobs = Object.values(jobStats)
    .map(j => ({ ...j, flakyTestCount: j.flakyTests.length }))
    .sort((a, b) => b.flakyTestCount - a.flakyTestCount);
  
  // Update stats
  document.getElementById('prfailures-flaky').textContent = flakyTests.length;
  document.getElementById('prfailures-total').textContent = allTests.reduce((sum, t) => sum + t.totalFailures, 0);
  document.getElementById('prfailures-prs').textContent = state.flakyData.totalPRs || 0;
  
  // Render "By Test" view
  if (flakyTests.length === 0) {
    byTestList.innerHTML = '<p class="empty-message">No flaky tests detected! 🎉</p>';
    } else {
    byTestList.innerHTML = flakyTests.map((test, i) => {
      const isExpanded = state.expandedFlakyTests.has(test.name);
      const flakyOccs = (test.recentOccurrences || []).filter(o => o.isFlaky);
      const flakyJobs = test.affectedJobs.filter(j => j.flakyCount > 0);
      
      return `
        <div class="flaky-item ${isExpanded ? 'expanded' : ''}" data-test-name="${test.name}">
          <div class="flaky-item-header">
            <span class="flaky-rank">#${i + 1}</span>
            <div class="flaky-item-info">
              <div class="flaky-item-name">${test.name}</div>
              <div class="flaky-item-file">${test.file || 'unknown file'}</div>
            </div>
            <span class="flaky-item-badge">${test.flakyCount}x flaky</span>
            <span class="flaky-item-toggle">${isExpanded ? '▼' : '▶'}</span>
          </div>
          ${isExpanded ? `
            <div class="flaky-item-details">
              <div class="flaky-detail-section">
                <h4>Affected Jobs (${flakyJobs.length})</h4>
                <div class="flaky-jobs-chips">
                  ${flakyJobs.map(j => `<span class="job-chip-small">${simplifyJobName(j.displayName)} (${j.flakyCount}x)</span>`).join('')}
                </div>
              </div>
              <div class="flaky-detail-section">
                <h4>Failed Runs (${flakyOccs.length}) — click to debug</h4>
                <div class="flaky-runs-list">
                  ${flakyOccs.map(occ => {
                    const date = new Date(occ.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                    return `
                      <a href="https://github.com/kata-containers/kata-containers/actions/runs/${occ.runId}/job/${occ.jobId}" 
                         target="_blank" class="flaky-run-link">
                        <span class="run-date">${date}</span>
                        <span class="run-pr">PR #${occ.prNumber}</span>
                        <span class="run-job">${simplifyJobName(occ.jobDisplayName)}</span>
                        <span class="run-arrow">→</span>
                      </a>
                    `;
                  }).join('')}
                </div>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }
  
  // Render "By Job" view
  if (sortedJobs.length === 0) {
    byJobList.innerHTML = '<p class="empty-message">No job data available</p>';
  } else {
    byJobList.innerHTML = sortedJobs.map((job, i) => {
      const isExpanded = state.expandedFlakyJobs?.has(job.name);
      
      return `
        <div class="flaky-job-item ${isExpanded ? 'expanded' : ''}" data-job-name="${job.name}">
          <div class="flaky-job-header">
            <span class="flaky-rank">#${i + 1}</span>
            <div class="flaky-job-info">
              <div class="flaky-job-name">${simplifyJobName(job.displayName)}</div>
            </div>
            <span class="flaky-job-badge">${job.flakyTestCount} flaky test${job.flakyTestCount > 1 ? 's' : ''}</span>
            <span class="flaky-job-toggle">${isExpanded ? '▼' : '▶'}</span>
          </div>
          ${isExpanded ? `
            <div class="flaky-job-details">
              ${job.flakyTests.map(test => `
                <div class="job-flaky-test">
                  <div class="job-flaky-test-header">
                    <span class="job-flaky-test-name">${test.name}</span>
                    <span class="job-flaky-test-count">${test.count}x</span>
                  </div>
                  <div class="job-flaky-test-file">${test.file || 'unknown file'}</div>
                  <div class="job-flaky-test-runs">
                    ${test.occurrences.slice(0, 3).map(occ => {
                      const date = new Date(occ.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                      return `
                        <a href="https://github.com/kata-containers/kata-containers/actions/runs/${occ.runId}/job/${occ.jobId}" 
                           target="_blank" class="mini-run-link">
                          ${date} · PR #${occ.prNumber} →
                        </a>
                      `;
                    }).join('')}
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }
  
  // Add sub-tab switching
  document.querySelectorAll('.sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const subtab = tab.dataset.subtab;
      document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.sub-tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`${subtab}-content`).classList.add('active');
    });
  });
  
  // Add click handlers for expanding tests
  document.querySelectorAll('.flaky-item').forEach(item => {
    item.querySelector('.flaky-item-header').addEventListener('click', () => {
      const testName = item.dataset.testName;
      if (state.expandedFlakyTests.has(testName)) {
        state.expandedFlakyTests.delete(testName);
      } else {
        state.expandedFlakyTests.add(testName);
      }
      renderPRFailures();
      // Scroll to the clicked item after re-render
      setTimeout(() => {
        const newItem = document.querySelector(`.flaky-item[data-test-name="${CSS.escape(testName)}"]`);
        if (newItem) {
          newItem.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        }
      }, 0);
    });
  });
  
  // Add click handlers for expanding jobs
  if (!state.expandedFlakyJobs) state.expandedFlakyJobs = new Set();
  document.querySelectorAll('.flaky-job-item').forEach(item => {
    item.querySelector('.flaky-job-header').addEventListener('click', () => {
      const jobName = item.dataset.jobName;
      if (state.expandedFlakyJobs.has(jobName)) {
        state.expandedFlakyJobs.delete(jobName);
      } else {
        state.expandedFlakyJobs.add(jobName);
      }
      renderPRFailures();
      // Scroll to the clicked item after re-render
      setTimeout(() => {
        const newItem = document.querySelector(`.flaky-job-item[data-job-name="${CSS.escape(jobName)}"]`);
        if (newItem) {
          newItem.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }
      }, 0);
    });
  });
  
  // Add search handler (single search for both views)
  const searchFlaky = document.getElementById('search-flaky');
  
  if (searchFlaky) {
    searchFlaky.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      
      // Filter tests in "By Test" view
      document.querySelectorAll('.flaky-item').forEach(item => {
        const testName = item.dataset.testName.toLowerCase();
        const file = item.querySelector('.flaky-item-file')?.textContent.toLowerCase() || '';
        const matches = testName.includes(query) || file.includes(query);
        item.style.display = matches ? '' : 'none';
      });
      
      // Filter jobs in "By Job" view
      document.querySelectorAll('.flaky-job-item').forEach(item => {
        const jobName = item.querySelector('.flaky-job-name')?.textContent.toLowerCase() || '';
        const matches = jobName.includes(query);
        item.style.display = matches ? '' : 'none';
      });
    });
  }
}

function renderFlakyTestRow(test) {
  const isExpanded = state.expandedFlakyTests.has(test.name);
  const flakyOccurrences = (test.recentOccurrences || []).filter(o => o.isFlaky);
  
  // Get unique PRs where this was flaky
  const flakyPRs = [...new Set(flakyOccurrences.map(o => o.prNumber))];
  
  // Get jobs where this test is flaky
  const flakyJobs = test.affectedJobs.filter(j => j.flakyCount > 0);
  
  return `
    <div class="flaky-row ${isExpanded ? 'expanded' : ''}" data-test-name="${test.name}">
      <div class="flaky-row-header">
        <div class="test-info">
          <span class="test-name">${test.name}</span>
          ${test.file ? `<span class="test-file">${test.file}</span>` : ''}
        </div>
        <div class="flaky-stats">
          <span class="flaky-count">${test.flakyCount || 0}x flaky</span>
          <span class="pr-count">${flakyPRs.length} PR${flakyPRs.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      ${isExpanded ? `
        <div class="flaky-row-details">
          <div class="detail-section">
            <h4>Affected Jobs (${flakyJobs.length})</h4>
            <div class="job-chips">
              ${flakyJobs.map(j => `
                <span class="job-chip" title="${j.displayName}">${simplifyJobName(j.displayName)} <em>(${j.flakyCount}x)</em></span>
              `).join('')}
            </div>
          </div>
          <div class="detail-section">
            <h4>Recent Flaky Occurrences</h4>
            <div class="occurrences-list">
              ${flakyOccurrences.slice(0, 5).map(occ => {
                const date = new Date(occ.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return `
                  <div class="occurrence">
                    <span class="occ-date">${date}</span>
                    <a href="https://github.com/kata-containers/kata-containers/pull/${occ.prNumber}" target="_blank" class="occ-pr">PR #${occ.prNumber}</a>
                    <span class="occ-job" title="${occ.jobDisplayName}">${simplifyJobName(occ.jobDisplayName)}</span>
                    <a href="https://github.com/kata-containers/kata-containers/actions/runs/${occ.runId}/job/${occ.jobId}" target="_blank" class="occ-link">View</a>
                  </div>
                `;
              }).join('')}
            </div>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

/**
 * Navigate to a specific job in the Nightly tab
 */
function navigateToJob(jobName) {
  // Switch to nightly tab
  switchTab('nightly');
  
  // Find the test with this job name and expand its section
  if (state.data?.sections) {
    for (const section of state.data.sections) {
      const test = section.tests.find(t => t.jobName === jobName || t.name === jobName);
      if (test) {
        // Expand the section
        state.expandedSections.add(section.id);
        
        // Expand the appropriate group based on test status
        const groupId = `${section.id}-${test.status === 'passed' ? 'passed' : test.status === 'failed' ? 'failed' : 'not-run'}`;
        state.expandedGroups.add(groupId);
        
        // Re-render and scroll to the test
        renderSections();
        
        // Scroll to the test row after a short delay
        setTimeout(() => {
          const testRow = document.querySelector(`.test-row .test-name-text[data-test-id="${test.id}"]`);
          if (testRow) {
            testRow.closest('.test-row').scrollIntoView({ behavior: 'smooth', block: 'center' });
            testRow.closest('.test-row').classList.add('highlight');
            setTimeout(() => testRow.closest('.test-row').classList.remove('highlight'), 2000);
          }
        }, 100);
        
        return;
      }
    }
  }
  
  // If not found in nightly, just show a toast
  showToast(`Job "${jobName}" not found in nightly runs`, 'error');
}

function renderFailedTestCard(test) {
  const isExpanded = state.expandedFlakyTests.has(test.name);
  const isFlaky = test.isConfirmedFlaky || test.flakyCount > 0;
  const isMerged = test.mergedDespiteFailure || test.mergedCount > 0;
  
  // Format ALL affected jobs (clickable to navigate)
  const affectedJobsHtml = test.affectedJobs.map(job => {
    const jobFlaky = job.flakyCount > 0;
    const jobMerged = job.mergedCount > 0;
    return `
      <span class="flaky-job-chip clickable ${jobFlaky ? 'is-flaky' : ''} ${jobMerged ? 'is-merged' : ''}" 
            data-job-name="${job.name}" 
            title="Click to view in Nightly tab${jobFlaky ? ' (confirmed flaky)' : ''}${jobMerged ? ' (merged despite failure)' : ''}">
        ${job.displayName} <span class="job-count">(${job.count}x)</span>
        ${jobFlaky ? '<span class="chip-badge flaky">🔄</span>' : ''}
        ${jobMerged ? '<span class="chip-badge merged">✓</span>' : ''}
      </span>
    `;
  }).join('');
  
  // Format ALL occurrences with flaky/merged badges
  const allOccurrences = test.recentOccurrences || [];
  const occurrencesHtml = allOccurrences.map(occ => {
    const date = new Date(occ.date);
    const formatted = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isRerun = occ.runAttempt > 1;
    const prTitle = occ.prTitle ? `: ${occ.prTitle.substring(0, 40)}${occ.prTitle.length > 40 ? '...' : ''}` : '';
    const occFlaky = occ.isFlaky;
    const occMerged = occ.prMerged;
    
    return `
      <div class="flaky-occurrence ${occFlaky ? 'is-flaky' : ''} ${occMerged ? 'is-merged' : ''}">
        <span class="occurrence-date">${formatted}</span>
        <span class="occurrence-pr">
          <a href="https://github.com/kata-containers/kata-containers/pull/${occ.prNumber}" target="_blank" class="pr-link">
            PR #${occ.prNumber}${prTitle}
          </a>
          ${isRerun ? `<span class="rerun-badge">(re-run #${occ.runAttempt})</span>` : ''}
          ${occFlaky ? `<span class="occurrence-badge flaky" title="Confirmed flaky: failed then passed on re-run">🔄 Flaky</span>` : ''}
          ${occMerged ? `<span class="occurrence-badge merged" title="PR was merged despite this failure">✓ Merged</span>` : ''}
        </span>
        <span class="occurrence-job">${occ.jobDisplayName}</span>
        <a href="https://github.com/kata-containers/kata-containers/actions/runs/${occ.runId}/job/${occ.jobId}" 
           target="_blank" 
           class="occurrence-link">
          View Run
        </a>
      </div>
    `;
  }).join('');
  
  // Format ALL dates
  const allDatesHtml = test.uniqueDates.map(d => {
    const date = new Date(d);
    return `<span class="date-chip">${date.toLocaleDateString('en-US', {month: 'short', day: 'numeric'})}</span>`;
  }).join('');
  
  // Build header badges
  const headerBadges = [];
  if (isFlaky) {
    headerBadges.push(`<span class="test-badge flaky" title="Confirmed flaky: failed then passed on re-run">🔄 Flaky (${test.flakyCount || 0})</span>`);
  }
  if (isMerged) {
    headerBadges.push(`<span class="test-badge merged" title="PR merged despite this failure">✓ Merged (${test.mergedCount || 0})</span>`);
  }
  
  return `
    <div class="flaky-test-card ${isExpanded ? 'expanded' : ''} ${isFlaky ? 'is-flaky' : ''} ${isMerged ? 'is-merged' : ''}" data-test-name="${test.name}">
      <div class="flaky-test-header">
        <div class="flaky-test-toggle">▶</div>
        <div class="flaky-test-info">
          <div class="flaky-test-name">
            <span class="flaky-marker">✗</span>
            ${test.name}
            ${headerBadges.join('')}
          </div>
          ${test.file ? `<div class="flaky-test-file">📁 ${test.file}</div>` : ''}
        </div>
        <div class="flaky-test-stats">
          <span class="flaky-count">${test.totalFailures}x</span>
          <span class="flaky-prs">${test.uniquePRs} PR${test.uniquePRs > 1 ? 's' : ''}</span>
        </div>
        <a href="https://github.com/kata-containers/kata-containers/actions/runs/${test.recentOccurrences[0]?.runId}/job/${test.recentOccurrences[0]?.jobId}" 
           target="_blank" 
           class="btn btn-small"
           onclick="event.stopPropagation()">
          Latest
        </a>
      </div>
      <div class="flaky-test-body">
        <div class="flaky-section">
          <h5>Affected Jobs (${test.affectedJobs.length})</h5>
          <div class="flaky-jobs-list">
            ${affectedJobsHtml}
          </div>
        </div>
        <div class="flaky-section">
          <h5>All Failures (${allOccurrences.length})</h5>
          <div class="flaky-occurrences">
            ${occurrencesHtml}
          </div>
        </div>
        <div class="flaky-section">
          <h5>Failed on Days (${test.uniqueDates.length})</h5>
          <div class="flaky-dates">
            ${allDatesHtml}
          </div>
        </div>
      </div>
    </div>
  `;
}

function toggleFlakyTest(testName) {
  if (state.expandedFlakyTests.has(testName)) {
    state.expandedFlakyTests.delete(testName);
  } else {
    state.expandedFlakyTests.add(testName);
  }
  renderFlakyTests();
}

// ============================================
// Initialization
// ============================================

function init() {
  // Set current date
  document.getElementById('current-date').textContent = formatDate();
  const cocoDateEl = document.getElementById('coco-current-date');
  if (cocoDateEl) cocoDateEl.textContent = formatDate();
  
  // Load data
  loadData();
  
  // Event listeners
  document.getElementById('modal-close').addEventListener('click', () => closeModal('error-modal'));
  document.getElementById('weather-close').addEventListener('click', () => closeModal('weather-modal'));
  
  document.getElementById('copy-error').addEventListener('click', copyError);
  
  // Project switching (Kata vs CoCo)
  document.querySelectorAll('.project-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const project = btn.dataset.project;
      switchProject(project);
    });
  });
  
  // Tab switching (within Kata project)
  document.querySelectorAll('#kata-content .tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  
  // CoCo tab switching
  document.querySelectorAll('#coco-content .tab:not(:disabled)').forEach(tab => {
    tab.addEventListener('click', () => switchCocoTab(tab.dataset.tab));
  });
  
  // Filter buttons (status) - Kata
  document.querySelectorAll('.filter-btn:not(.coco-filter)').forEach(btn => {
    btn.addEventListener('click', () => setFilter(btn.dataset.filter));
  });
  
  // Filter buttons (status) - CoCo
  document.querySelectorAll('.filter-btn.coco-filter').forEach(btn => {
    btn.addEventListener('click', () => setCocoFilter(btn.dataset.filter));
  });
  
  // Category filter buttons (All/Required toggle)
  // Category toggle buttons (All/Required) - these toggle the required filter
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      if (category === 'required') {
        state.showRequiredOnly = true;
      } else {
        state.showRequiredOnly = false;
      }
      updateAllRequiredButtons();
      updateStats();
      renderSections();
      updateJobCount();
    });
  });
  
  // Quick filter buttons (TEE/NVIDIA) - these change the view mode
  document.querySelectorAll('.quick-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.category;
      // Toggle: if already active, go back to 'all'
      if (state.viewMode === mode) {
        setViewMode('all');
      } else {
        setViewMode(mode);
      }
    });
  });
  
  // Search - Kata
  document.getElementById('search-tests').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    renderSections();
    updateJobCount();
  });
  
  // Search - CoCo Charts
  const cocoSearchEl = document.getElementById('search-coco-tests');
  if (cocoSearchEl) {
    cocoSearchEl.addEventListener('input', (e) => {
      state.cocoSearchQuery = e.target.value;
      renderCocoSections();
      updateCocoJobCount();
    });
  }
  
  // Filter buttons - CAA
  document.querySelectorAll('.filter-btn.caa-filter').forEach(btn => {
    btn.addEventListener('click', () => setCAAFilter(btn.dataset.filter));
  });
  
  // Search - CAA
  const caaSearchEl = document.getElementById('search-caa-tests');
  if (caaSearchEl) {
    caaSearchEl.addEventListener('input', (e) => {
      state.caaSearchQuery = e.target.value;
      renderCAASections();
      updateCAAJobCount();
    });
  }
  
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

// ============================================
// Project Switching (Kata vs CoCo)
// ============================================

function switchProject(project) {
  state.activeProject = project;
  
  // Update project buttons
  document.querySelectorAll('.project-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.project === project);
  });
  
  // Show/hide project content
  document.querySelectorAll('.project-content').forEach(content => {
    content.classList.toggle('active', content.id === `${project}-content`);
  });
  
  if (project === 'kata') {
    // Ensure a tab is active (default to nightly)
    if (!state.activeTab) state.activeTab = 'nightly';
    switchTab(state.activeTab);
  } else if (project === 'coco') {
    // Ensure a CoCo tab is active (default to coco-charts)
    if (!state.activeCocoTab) state.activeCocoTab = 'coco-charts';
    switchCocoTab(state.activeCocoTab);
  }
}

function switchCocoTab(tabName) {
  state.activeCocoTab = tabName;
  
  // Update tab buttons
  document.querySelectorAll('#coco-content .tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Show/hide tab content
  document.querySelectorAll('#coco-content .tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `${tabName}-content`);
  });
  
  // Render appropriate content
  if (tabName === 'coco-charts') {
    renderCocoSections();
    updateCocoStats();
    updateCocoJobCount();
  } else if (tabName === 'coco-caa') {
    renderCAASections();
    updateCAAStats();
    updateCAAJobCount();
  }
}

function setCocoFilter(filter) {
  state.cocoFilter = filter;
  document.querySelectorAll('.filter-btn.coco-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderCocoSections();
  updateCocoJobCount();
}

function setCAAFilter(filter) {
  state.caaFilter = filter;
  document.querySelectorAll('.filter-btn.caa-filter').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  renderCAASections();
  updateCAAJobCount();
}

function renderCocoSections() {
  const container = document.getElementById('coco-sections-container');
  if (!container) return;
  
  const cocoSection = state.data?.cocoChartsSection;
  if (!cocoSection) {
    container.innerHTML = '<p class="empty-message">No CoCo Charts data available</p>';
    return;
  }
  
  // Filter tests
  let tests = cocoSection.tests || [];
  
  // Apply search filter
  if (state.cocoSearchQuery) {
    const query = state.cocoSearchQuery.toLowerCase();
    tests = tests.filter(t => 
      t.name.toLowerCase().includes(query) ||
      t.jobName?.toLowerCase().includes(query)
    );
  }
  
  // Apply status filter
  if (state.cocoFilter && state.cocoFilter !== 'all') {
    tests = tests.filter(t => t.status === state.cocoFilter);
  }
  
  if (tests.length === 0) {
    container.innerHTML = '<p class="empty-message">No tests match your filters</p>';
    return;
  }
  
  // Group by status
  const failed = tests.filter(t => t.status === 'failed');
  const passed = tests.filter(t => t.status === 'passed');
  const notRun = tests.filter(t => t.status === 'not_run' || t.status === 'none');
  
  // Calculate weather stats (same as Kata)
  const weatherPercent = tests.length > 0 
    ? Math.round((passed.length / tests.length) * 100) 
    : 0;
  const weatherEmoji = weatherPercent >= 90 ? '☀️' : weatherPercent >= 70 ? '⛅' : weatherPercent >= 50 ? '🌥️' : '🌧️';
  
  // Status badges (exactly like Kata: failed → not run → all green)
  const statusBadges = [];
  if (failed.length > 0) {
    statusBadges.push(`<span class="section-status has-failed">(${failed.length} failed)</span>`);
  }
  if (notRun.length > 0) {
    statusBadges.push(`<span class="section-status has-not-run">(${notRun.length} not run)</span>`);
  }
  if (statusBadges.length === 0 && passed.length === tests.length) {
    statusBadges.push(`<span class="section-status all-green">All Green</span>`);
  }
  
  // Helper to render a test group (exactly like Kata's renderTestGroup)
  const renderCocoTestGroup = (groupTests, label, statusClass, groupId, isExpanded) => {
    if (groupTests.length === 0) return '';
    return `
      <div class="test-group ${isExpanded ? 'expanded' : ''}" data-group-id="${groupId}">
        <div class="test-group-header" data-group="${groupId}">
          <div class="test-group-title">
            <span class="test-group-toggle">▶</span>
            <span class="dot dot-${statusClass}"></span>
            ${label} (${groupTests.length})
          </div>
        </div>
        <div class="test-group-content">
          <div class="test-table-header">
            <span>Test Name</span>
            <span>Maintainers</span>
            <span>Run</span>
            <span>Last Failure</span>
            <span>Last Success</span>
            <span class="weather-header">Weather <span class="weather-range">(oldest ← 10 days → newest)</span></span>
            <span>Retried</span>
          </div>
          ${groupTests.map(t => renderCocoTestRow(t, cocoSection.id, cocoSection.sourceRepo)).join('')}
        </div>
      </div>
    `;
  };
  
  // Check if section is expanded (default to true on first render)
  // Use a separate flag to track if we've initialized this section
  if (!state.cocoChartsInitialized) {
    state.expandedSections.add('coco-charts');
    // Auto-expand failed group if there are failures (same as Kata)
    if (failed.length > 0) {
      state.expandedGroups.add('coco-charts-failed');
    }
    state.cocoChartsInitialized = true;
  }
  const isSectionExpanded = state.expandedSections.has('coco-charts');
  
  container.innerHTML = `
    <div class="section ${isSectionExpanded ? 'expanded' : ''}" data-section-id="coco-charts">
      <div class="section-header" data-section="coco-charts">
        <span class="section-toggle">▶</span>
        <span class="section-name">All Jobs</span>
        <div class="section-meta">
          <span class="section-count">${tests.length} jobs</span>
          <span class="section-weather">
            <span class="section-weather-icon">${weatherEmoji}</span>
            ${weatherPercent}%
          </span>
          ${statusBadges.join('')}
        </div>
      </div>
      <div class="section-content" style="${isSectionExpanded ? '' : 'display: none;'}">
        ${renderCocoTestGroup(failed, 'FAILED', 'failed', 'coco-charts-failed', state.expandedGroups.has('coco-charts-failed') || state.cocoFilter === 'failed')}
        ${renderCocoTestGroup(notRun, 'NOT RUN', 'not-run', 'coco-charts-not-run', state.expandedGroups.has('coco-charts-not-run') || state.cocoFilter === 'not_run')}
        ${renderCocoTestGroup(passed, 'PASSED', 'passed', 'coco-charts-passed', state.expandedGroups.has('coco-charts-passed') || state.cocoFilter === 'passed')}
      </div>
    </div>
  `;
  
  // Add click handler for section header (expand/collapse)
  const sectionHeader = container.querySelector('.section-header[data-section="coco-charts"]');
  if (sectionHeader) {
    sectionHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionId = 'coco-charts';
      const section = sectionHeader.closest('.section');
      const content = section.querySelector('.section-content');
      const isExpanded = section.classList.contains('expanded');
      
      // Toggle state
      if (isExpanded) {
        state.expandedSections.delete(sectionId);
      } else {
        state.expandedSections.add(sectionId);
      }
      
      section.classList.toggle('expanded', !isExpanded);
      content.style.display = isExpanded ? 'none' : '';
    });
  }
  
  // Add click handlers for group headers (use toggleGroup like Kata)
  container.querySelectorAll('.test-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      if (e.target.closest('.section-header')) return; // Don't trigger on section header
      const groupId = header.dataset.group;
      toggleGroup(groupId);
    });
  });
  
  // Add click handlers for weather columns
  container.querySelectorAll('.test-weather-col[data-test-id]').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      const testId = col.dataset.testId;
      showWeatherModal('coco-charts', testId);
    });
  });
}

function renderCocoTestRow(test, sectionId, sourceRepo) {
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
  
  const repo = sourceRepo || 'confidential-containers/charts';
  
  // Match Kata's layout exactly
  return `
    <div class="test-row ${test.status}">
      <div class="test-name-col">
        <div class="test-name">
          <span class="test-status-dot ${test.status}"></span>
          <span class="test-name-text">${escapeHtml(test.name)}</span>
          ${test.isRequired ? '<span class="required-badge">required</span>' : ''}
        </div>
      </div>
      <div class="test-maintainers-col">
        <span class="no-maintainer">—</span>
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
      </div>
    </div>
  `;
}

function updateCocoStats() {
  const cocoSection = state.data?.cocoChartsSection;
  if (!cocoSection) return;
  
  const tests = cocoSection.tests || [];
  const total = tests.length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const notRun = tests.filter(t => t.status === 'not_run' || t.status === 'none').length;
  const passed = tests.filter(t => t.status === 'passed').length;
  
  const totalEl = document.getElementById('coco-total-tests');
  const failedEl = document.getElementById('coco-failed-tests');
  const notRunEl = document.getElementById('coco-not-run-tests');
  const passedEl = document.getElementById('coco-passed-tests');
  
  if (totalEl) totalEl.textContent = total;
  if (failedEl) failedEl.textContent = failed;
  if (notRunEl) notRunEl.textContent = notRun;
  if (passedEl) passedEl.textContent = passed;
  
  // Update filter button counts
  const filterFailedEl = document.getElementById('coco-filter-failed-count');
  const filterNotRunEl = document.getElementById('coco-filter-not-run-count');
  const filterPassedEl = document.getElementById('coco-filter-passed-count');
  
  if (filterFailedEl) filterFailedEl.textContent = failed;
  if (filterNotRunEl) filterNotRunEl.textContent = notRun;
  if (filterPassedEl) filterPassedEl.textContent = passed;
}

function updateCocoJobCount() {
  const cocoSection = state.data?.cocoChartsSection;
  if (!cocoSection) return;
  
  let tests = cocoSection.tests || [];
  const total = tests.length;
  
  // Apply filters
  if (state.cocoSearchQuery) {
    const query = state.cocoSearchQuery.toLowerCase();
    tests = tests.filter(t => 
      t.name.toLowerCase().includes(query) ||
      t.jobName?.toLowerCase().includes(query)
    );
  }
  
  if (state.cocoFilter && state.cocoFilter !== 'all') {
    tests = tests.filter(t => t.status === state.cocoFilter);
  }
  
  const visibleEl = document.getElementById('coco-visible-jobs');
  const totalEl = document.getElementById('coco-total-jobs');
  
  if (visibleEl) visibleEl.textContent = tests.length;
  if (totalEl) totalEl.textContent = total;
}

// ============================================
// Cloud API Adaptor (CAA) Functions
// ============================================

function renderCAASections() {
  const container = document.getElementById('caa-sections-container');
  if (!container) return;
  
  const caaSection = state.data?.cocoCAASection;
  if (!caaSection) {
    container.innerHTML = '<p class="empty-message">No Cloud API Adaptor data available</p>';
    return;
  }
  
  // Filter tests
  let tests = caaSection.tests || [];
  
  // Apply search filter
  if (state.caaSearchQuery) {
    const query = state.caaSearchQuery.toLowerCase();
    tests = tests.filter(t => 
      t.name.toLowerCase().includes(query) ||
      t.jobName?.toLowerCase().includes(query)
    );
  }
  
  // Apply status filter
  if (state.caaFilter && state.caaFilter !== 'all') {
    tests = tests.filter(t => t.status === state.caaFilter);
  }
  
  if (tests.length === 0) {
    container.innerHTML = '<p class="empty-message">No tests match your filters</p>';
    return;
  }
  
  // Group by status
  const failed = tests.filter(t => t.status === 'failed');
  const passed = tests.filter(t => t.status === 'passed');
  const notRun = tests.filter(t => t.status === 'not_run' || t.status === 'none');
  
  // Calculate weather stats (same as Kata)
  const weatherPercent = tests.length > 0 
    ? Math.round((passed.length / tests.length) * 100) 
    : 0;
  const weatherEmoji = weatherPercent >= 90 ? '☀️' : weatherPercent >= 70 ? '⛅' : weatherPercent >= 50 ? '🌥️' : '🌧️';
  
  // Status badges (exactly like Kata: failed → not run → all green)
  const statusBadges = [];
  if (failed.length > 0) {
    statusBadges.push(`<span class="section-status has-failed">(${failed.length} failed)</span>`);
  }
  if (notRun.length > 0) {
    statusBadges.push(`<span class="section-status has-not-run">(${notRun.length} not run)</span>`);
  }
  if (statusBadges.length === 0 && passed.length === tests.length) {
    statusBadges.push(`<span class="section-status all-green">All Green</span>`);
  }
  
  // Helper to render a test group (exactly like Kata's renderTestGroup)
  const renderCAATestGroup = (groupTests, label, statusClass, groupId, isExpanded) => {
    if (groupTests.length === 0) return '';
    return `
      <div class="test-group ${isExpanded ? 'expanded' : ''}" data-group-id="${groupId}">
        <div class="test-group-header" data-group="${groupId}">
          <div class="test-group-title">
            <span class="test-group-toggle">▶</span>
            <span class="dot dot-${statusClass}"></span>
            ${label} (${groupTests.length})
          </div>
        </div>
        <div class="test-group-content">
          <div class="test-table-header">
            <span>Test Name</span>
            <span>Maintainers</span>
            <span>Run</span>
            <span>Last Failure</span>
            <span>Last Success</span>
            <span class="weather-header">Weather <span class="weather-range">(oldest ← 10 days → newest)</span></span>
            <span>Retried</span>
          </div>
          ${groupTests.map(t => renderCocoTestRow(t, caaSection.id, caaSection.sourceRepo)).join('')}
        </div>
      </div>
    `;
  };
  
  // Check if section is expanded (default to true on first render)
  if (!state.cocoCAAInitialized) {
    state.expandedSections.add('coco-caa');
    // Auto-expand failed group if there are failures (same as Kata)
    if (failed.length > 0) {
      state.expandedGroups.add('coco-caa-failed');
    }
    state.cocoCAAInitialized = true;
  }
  const isSectionExpanded = state.expandedSections.has('coco-caa');
  
  container.innerHTML = `
    <div class="section ${isSectionExpanded ? 'expanded' : ''}" data-section-id="coco-caa">
      <div class="section-header" data-section="coco-caa">
        <span class="section-toggle">▶</span>
        <span class="section-name">All Jobs</span>
        <div class="section-meta">
          <span class="section-count">${tests.length} jobs</span>
          <span class="section-weather">
            <span class="section-weather-icon">${weatherEmoji}</span>
            ${weatherPercent}%
          </span>
          ${statusBadges.join('')}
        </div>
      </div>
      <div class="section-content" style="${isSectionExpanded ? '' : 'display: none;'}">
        ${renderCAATestGroup(failed, 'FAILED', 'failed', 'coco-caa-failed', state.expandedGroups.has('coco-caa-failed') || state.caaFilter === 'failed')}
        ${renderCAATestGroup(notRun, 'NOT RUN', 'not-run', 'coco-caa-not-run', state.expandedGroups.has('coco-caa-not-run') || state.caaFilter === 'not_run')}
        ${renderCAATestGroup(passed, 'PASSED', 'passed', 'coco-caa-passed', state.expandedGroups.has('coco-caa-passed') || state.caaFilter === 'passed')}
      </div>
    </div>
  `;
  
  // Add click handler for section header (expand/collapse)
  const sectionHeader = container.querySelector('.section-header[data-section="coco-caa"]');
  if (sectionHeader) {
    sectionHeader.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionId = 'coco-caa';
      const section = sectionHeader.closest('.section');
      const content = section.querySelector('.section-content');
      const isExpanded = section.classList.contains('expanded');
      
      // Toggle state
      if (isExpanded) {
        state.expandedSections.delete(sectionId);
      } else {
        state.expandedSections.add(sectionId);
      }
      
      section.classList.toggle('expanded', !isExpanded);
      content.style.display = isExpanded ? 'none' : '';
    });
  }
  
  // Add click handlers for group headers (use toggleGroup like Kata)
  container.querySelectorAll('.test-group-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return;
      if (e.target.closest('.section-header')) return; // Don't trigger on section header
      const groupId = header.dataset.group;
      toggleGroup(groupId);
    });
  });
  
  // Add click handlers for weather columns
  container.querySelectorAll('.test-weather-col[data-test-id]').forEach(col => {
    col.addEventListener('click', (e) => {
      e.stopPropagation();
      const testId = col.dataset.testId;
      showWeatherModal('coco-caa', testId);
    });
  });
}

function updateCAAStats() {
  const caaSection = state.data?.cocoCAASection;
  if (!caaSection) return;
  
  const tests = caaSection.tests || [];
  const total = tests.length;
  const failed = tests.filter(t => t.status === 'failed').length;
  const notRun = tests.filter(t => t.status === 'not_run' || t.status === 'none').length;
  const passed = tests.filter(t => t.status === 'passed').length;
  
  const totalEl = document.getElementById('caa-total-tests');
  const failedEl = document.getElementById('caa-failed-tests');
  const notRunEl = document.getElementById('caa-not-run-tests');
  const passedEl = document.getElementById('caa-passed-tests');
  
  if (totalEl) totalEl.textContent = total;
  if (failedEl) failedEl.textContent = failed;
  if (notRunEl) notRunEl.textContent = notRun;
  if (passedEl) passedEl.textContent = passed;
  
  // Update filter button counts
  const filterFailedEl = document.getElementById('caa-filter-failed-count');
  const filterNotRunEl = document.getElementById('caa-filter-not-run-count');
  const filterPassedEl = document.getElementById('caa-filter-passed-count');
  
  if (filterFailedEl) filterFailedEl.textContent = failed;
  if (filterNotRunEl) filterNotRunEl.textContent = notRun;
  if (filterPassedEl) filterPassedEl.textContent = passed;
}

function updateCAAJobCount() {
  const caaSection = state.data?.cocoCAASection;
  if (!caaSection) return;
  
  let tests = caaSection.tests || [];
  const total = tests.length;
  
  // Apply filters
  if (state.caaSearchQuery) {
    const query = state.caaSearchQuery.toLowerCase();
    tests = tests.filter(t => 
      t.name.toLowerCase().includes(query) ||
      t.jobName?.toLowerCase().includes(query)
    );
  }
  
  if (state.caaFilter && state.caaFilter !== 'all') {
    tests = tests.filter(t => t.status === state.caaFilter);
  }
  
  const visibleEl = document.getElementById('caa-visible-jobs');
  const totalEl = document.getElementById('caa-total-jobs');
  
  if (visibleEl) visibleEl.textContent = tests.length;
  if (totalEl) totalEl.textContent = total;
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
