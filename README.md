# Kata Containers CI Dashboard

A real-time dashboard for monitoring Kata Containers nightly CI test status.

🔗 **Live Dashboard**: https://kata-containers.github.io/ci-dashboard/

## Features

- **Nightly Test Monitoring**: View all nightly test results at a glance
- **10-Day Weather History**: Track test stability over time (oldest → newest)
- **Test Sections**: Organized by category (GPU, TEE, etc.)
- **Failure Details**: View failed test names from TAP output ("not ok" lines)
- **Direct Job Links**: Click through to specific GitHub Actions jobs
- **Auto-Refresh**: Data updates every 3 hours

## Current Sections

| Section | Tests | Description |
|---------|-------|-------------|
| **NVIDIA GPU** | 2 | GPU passthrough tests (A100, H100+SNP) |
| **TEE** | 8 | Confidential Computing tests (SEV-SNP, TDX, zVSI, CoCo variants) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  kata-containers/ci-dashboard (this repo)                               │
│  ├── .github/workflows/update-data.yml  ← Fetches data every 3 hours   │
│  ├── config.yaml                        ← Test sections configuration   │
│  ├── index.html, style.css, app.js      ← Dashboard UI                  │
│  ├── scripts/process-data.js            ← Data processing               │
│  └── data.json                          ← Generated data (auto-updated) │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              │ GitHub Pages
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                                                                         │
│  https://kata-containers.github.io/ci-dashboard/                        │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Configuration

The dashboard is configured via `config.yaml` in this repository.

### Config Structure

```yaml
settings:
  weather_days: 10           # Days of history to show
  refresh_interval: 180      # Auto-refresh in minutes
  source_repo: "kata-containers/kata-containers"

sections:
  - id: nvidia-gpu
    name: "NVIDIA GPU"
    description: "GPU passthrough tests"
    maintainers:
      - "@username"
    jobs:
      - name: "kata-containers-ci-on-push / run-k8s-tests-on-nvidia-gpu / run-nvidia-gpu-tests-on-amd64"
        description: "NVIDIA GPU tests on A100"

fatal_steps:
  - pattern: "Run tests.*"   # Only this step counts as a real test failure
```

### Adding a New Test Section

1. Edit `config.yaml`
2. Add a new section with:
   - `id`: Unique identifier
   - `name`: Display name
   - `description`: Section description
   - `maintainers`: List of GitHub handles
   - `jobs`: List of job configurations with exact GitHub Actions job names

## Development

### Local Preview

```bash
# Start local server
python3 -m http.server 8080

# Open browser
open http://localhost:8080
```

### Manual Data Refresh

1. Go to **Actions** tab
2. Select **Update CI Dashboard Data**
3. Click **Run workflow**

## How It Works

1. **GitHub Actions workflow** runs every 3 hours
2. Fetches nightly workflow runs from `kata-containers/kata-containers`
3. For each run, fetches individual job results
4. Filters jobs matching configured patterns (GPU, TEE, etc.)
5. For failed jobs, fetches logs and parses TAP output for "not ok" lines
6. Generates `data.json` with test status, weather history, and failure details
7. Commits and pushes `data.json` to trigger GitHub Pages rebuild

## Contributing

1. **Add new tests**: Edit `config.yaml` and add job configurations
2. **UI changes**: Modify `index.html`, `style.css`, or `app.js`
3. **Data processing**: Modify `scripts/process-data.js`

## License

Apache 2.0 - See [LICENSE](LICENSE)
