# Local Testing

Test the CI dashboard locally before pushing changes.

## Prerequisites

- Docker
- GitHub CLI (`gh`) authenticated

## Usage

```bash
# Fetch data and start server
./local-test.sh fetch
./local-test.sh serve

# Or just serve existing data
./local-test.sh serve
```

Then open http://localhost:8080

## What it does

1. Fetches nightly CI runs (last 10 days)
2. Fetches PR CI runs (last 7 days for local testing)
3. Downloads logs for failed jobs
4. Processes data into `data.json` and `flaky-data.json`
5. Starts a local HTTP server

