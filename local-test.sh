#!/bin/bash
# Local testing script for CI Dashboard
# Usage: ./local-test.sh [fetch|serve|both]
#
# Requirements:
# - Docker
# - GH_TOKEN environment variable (GitHub token with repo access)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check for GH_TOKEN, try to get from gh CLI if not set
if [ -z "$GH_TOKEN" ]; then
    echo "🔑 GH_TOKEN not set, trying to get from gh CLI..."
    if command -v gh &> /dev/null; then
        GH_TOKEN=$(gh auth token 2>/dev/null || true)
        if [ -n "$GH_TOKEN" ]; then
            echo "   ✅ Got token from gh CLI"
            export GH_TOKEN
        fi
    fi
fi

if [ -z "$GH_TOKEN" ]; then
    echo "❌ Error: GH_TOKEN environment variable is required"
    echo "   Either:"
    echo "   - Export your GitHub token: export GH_TOKEN=ghp_..."
    echo "   - Or login with gh CLI: gh auth login"
    exit 1
fi

# Build the container
build_container() {
    echo "🔨 Building container..."
    docker build -f Dockerfile.local -t ci-dashboard-local .
}

# Fetch nightly data
fetch_nightly_data() {
    echo "📥 Fetching nightly CI data..."
    
    docker run --rm \
        -e GH_TOKEN="$GH_TOKEN" \
        -v "$SCRIPT_DIR:/app" \
        ci-dashboard-local \
        bash -c '
            set -e
            cd /app
            
            echo "Fetching nightly workflow runs (last 10 days)..."
            gh api \
                -H "Accept: application/vnd.github+json" \
                --paginate \
                "repos/kata-containers/kata-containers/actions/workflows/ci-nightly.yaml/runs?created=>$(date -d "10 days ago" +%Y-%m-%d)" \
                --jq ".workflow_runs" | jq -s "add // []" > nightly-runs.json
            
            echo "Found $(jq "length" nightly-runs.json) nightly runs"
            
            # Fetch jobs for each run
            echo "[]" > all-jobs.json
            
            for run_id in $(jq -r ".[].id" nightly-runs.json | head -15); do
                echo "Fetching jobs for run $run_id..."
                
                # Fetch ALL jobs (no filter - we want everything for the dashboard)
                gh api \
                    -H "Accept: application/vnd.github+json" \
                    --paginate \
                    "repos/kata-containers/kata-containers/actions/runs/$run_id/jobs?per_page=100" \
                    --jq ".jobs[]" | \
                    jq -s --arg run_id "$run_id" "[.[] | . + {workflow_run_id: \$run_id}]" > run-jobs.json
                
                echo "  Found $(jq "length" run-jobs.json) jobs"
                
                jq -s "add" all-jobs.json run-jobs.json > temp-jobs.json
                mv temp-jobs.json all-jobs.json
            done
            
            # Create final format
            echo "{\"jobs\":" > raw-runs.json
            cat all-jobs.json >> raw-runs.json
            echo "}" >> raw-runs.json
            
            echo "Total jobs: $(jq ".jobs | length" raw-runs.json)"
            
            # Fetch logs for ALL failed jobs
            echo "Fetching logs for failed jobs..."
            mkdir -p job-logs
            
            failed_count=$(jq -r ".jobs[] | select(.conclusion == \"failure\") | .id" raw-runs.json | wc -l)
            echo "Found $failed_count failed jobs to fetch logs for"
            
            for job_id in $(jq -r ".jobs[] | select(.conclusion == \"failure\") | .id" raw-runs.json); do
                echo "Fetching log for job $job_id..."
                curl -sL \
                    -H "Authorization: token $GH_TOKEN" \
                    -H "Accept: application/vnd.github+json" \
                    "https://api.github.com/repos/kata-containers/kata-containers/actions/jobs/$job_id/logs" \
                    -o "job-logs/$job_id.log"
                
                size=$(wc -c < "job-logs/$job_id.log")
                not_ok=$(grep -c "not ok" "job-logs/$job_id.log" 2>/dev/null || echo 0)
                echo "  Log: $size bytes, $not_ok \"not ok\" lines"
            done
            
            echo ""
            echo "✅ Nightly data fetched!"
            echo "   Runs: $(jq "length" nightly-runs.json)"
            echo "   Jobs: $(jq ".jobs | length" raw-runs.json)"
            echo "   Logs: $(ls job-logs/*.log 2>/dev/null | wc -l)"
        '
}

# Fetch flaky test data from PRs
fetch_flaky_data() {
    echo "📥 Fetching flaky test data from PRs..."
    
    docker run --rm \
        -e GH_TOKEN="$GH_TOKEN" \
        -v "$SCRIPT_DIR:/app" \
        ci-dashboard-local \
        bash -c '
            set -e
            cd /app
            
            # For local testing, use 7 days; for production use 14 days
            SINCE_DATE=$(date -d "7 days ago" +%Y-%m-%d)
            echo "Fetching PR runs since $SINCE_DATE (local testing mode - 7 days)..."
            
            # Fetch PR runs from "Kata Containers CI" workflow (ID 52911914 = ci-on-push.yaml)
            # triggered by pull_request_target. Filter out skipped runs as they have no test results
            gh api \
                -H "Accept: application/vnd.github+json" \
                --paginate \
                "repos/kata-containers/kata-containers/actions/workflows/52911914/runs?event=pull_request_target&created=>$SINCE_DATE&per_page=100" \
                --jq "[.workflow_runs[] | select(.conclusion != \"skipped\")]" | jq -s "add // []" > pr-runs.json
            
            echo "Found $(jq "length" pr-runs.json) PR CI runs (non-skipped)"
            
            # Show some sample runs
            echo "Sample runs:"
            jq -r ".[0:3] | .[] | \"  Run \(.id): \(.event) - \(.display_title | .[0:60])\"" pr-runs.json
            
            # Fetch jobs for PR runs
            echo "[]" > all-pr-jobs.json
            
            # Build a cache of branch -> PR info mappings as JSON file (including merge status)
            echo "Building PR cache from recent PRs..."
            gh api "repos/kata-containers/kata-containers/pulls?state=all&per_page=100" \
                --jq "[.[] | {branch: .head.ref, number: .number, title: .title, merged: (.merged_at != null), state: .state, merged_at: .merged_at}]" > pr-cache.json
            echo "  Cached $(jq length pr-cache.json) PR mappings"
            echo "  Merged PRs: $(jq "[.[] | select(.merged == true)] | length" pr-cache.json)"
            
            # For local testing, process only 20 runs; for production use 100
            for run_id in $(jq -r "sort_by(.created_at) | reverse | .[0:20] | .[].id" pr-runs.json); do
                run_info=$(jq -r --arg id "$run_id" ".[] | select(.id == (\$id | tonumber))" pr-runs.json)
                pr_number=$(echo "$run_info" | jq -r ".pull_requests[0].number // null")
                head_sha=$(echo "$run_info" | jq -r ".head_sha // \"unknown\"")
                display_title=$(echo "$run_info" | jq -r ".display_title // \"unknown\"")
                run_attempt=$(echo "$run_info" | jq -r ".run_attempt // 1")
                created_at=$(echo "$run_info" | jq -r ".created_at")
                
                # For pull_request_target, head_branch is "main", so we need to find PR by title match
                pr_title="$display_title"
                pr_info=$(jq -r --arg title "$display_title" "[.[] | select(.title == \$title)] | .[0] // empty" pr-cache.json)
                if [ "$pr_number" = "null" ] || [ -z "$pr_number" ]; then
                    pr_number=$(echo "$pr_info" | jq -r ".number // empty" 2>/dev/null)
                fi
                pr_merged=$(echo "$pr_info" | jq -r ".merged // false" 2>/dev/null)
                pr_state=$(echo "$pr_info" | jq -r ".state // empty" 2>/dev/null)
                
                # Skip if we still dont have a PR number
                if [ -z "$pr_number" ]; then
                    echo "Skipping run $run_id (title: ${display_title:0:40}...) - no PR found"
                    continue
                fi
                
                # Truncate title for display
                display_title=$(echo "$pr_title" | cut -c1-50)
                [ ${#pr_title} -gt 50 ] && display_title="${display_title}..."
                
                echo "Fetching jobs for run $run_id (PR #$pr_number: $display_title, attempt $run_attempt)..."
                
                # Fetch ALL k8s test jobs from:
                # - run-k8s-tests-on-aks.yaml (run-k8s-tests with matrix)
                # - run-k8s-tests-on-arm64.yaml (run-k8s-tests-on-arm64)
                # - run-k8s-tests-on-nvidia-gpu.yaml (run-nvidia-gpu-tests, run-nvidia-gpu-snp-tests)
                # - run-k8s-tests-on-zvsi.yaml (run-k8s-tests with matrix)
                # - run-k8s-tests-on-tdx.yaml, run-k8s-tests-on-sev.yaml, etc.
                gh api \
                    -H "Accept: application/vnd.github+json" \
                    --paginate \
                    "repos/kata-containers/kata-containers/actions/runs/$run_id/jobs?per_page=100" \
                    --jq ".jobs[] | select(.name | test(\"run-k8s-tests|run-nvidia-gpu|run-kata-coco\"; \"i\"))" | \
                    jq -s --arg run_id "$run_id" --arg pr "$pr_number" --arg title "$pr_title" --arg sha "$head_sha" --arg attempt "$run_attempt" --arg created "$created_at" --arg merged "$pr_merged" --arg state "$pr_state" \
                    "[.[] | . + {workflow_run_id: \$run_id, pr_number: \$pr, pr_title: \$title, head_sha: \$sha, run_attempt: (\$attempt | tonumber), run_created_at: \$created, pr_merged: (\$merged == \"true\"), pr_state: \$state}]" > run-jobs.json
                
                job_count=$(jq "length" run-jobs.json)
                if [ "$job_count" -gt 0 ]; then
                    echo "  Found $job_count test jobs"
                    jq -s "add" all-pr-jobs.json run-jobs.json > temp-jobs.json
                    mv temp-jobs.json all-pr-jobs.json
                fi
            done
            
            # Create final format
            echo "{\"jobs\":" > raw-pr-runs.json
            cat all-pr-jobs.json >> raw-pr-runs.json
            echo "}" >> raw-pr-runs.json
            
            echo "Total PR jobs: $(jq ".jobs | length" raw-pr-runs.json)"
            
            # Fetch logs for failed PR jobs
            echo "Fetching logs for failed PR jobs..."
            mkdir -p pr-job-logs
            
            for job_id in $(jq -r ".jobs[] | select(.conclusion == \"failure\") | .id" raw-pr-runs.json | head -30); do
                echo "Fetching log for job $job_id..."
                curl -sL \
                    -H "Authorization: token $GH_TOKEN" \
                    -H "Accept: application/vnd.github+json" \
                    "https://api.github.com/repos/kata-containers/kata-containers/actions/jobs/$job_id/logs" \
                    -o "pr-job-logs/$job_id.log"
                
                size=$(wc -c < "pr-job-logs/$job_id.log")
                not_ok=$(grep -c "not ok" "pr-job-logs/$job_id.log" 2>/dev/null || echo 0)
                echo "  Log: $size bytes, $not_ok \"not ok\" lines"
            done
            
            echo ""
            echo "✅ PR flaky data fetched!"
            echo "   PR Runs: $(jq "length" pr-runs.json)"
            echo "   PR Jobs: $(jq ".jobs | length" raw-pr-runs.json)"
            echo "   PR Logs: $(ls pr-job-logs/*.log 2>/dev/null | wc -l)"
        '
}

# Process data
process_data() {
    echo "⚙️ Processing data..."
    
    docker run --rm \
        -v "$SCRIPT_DIR:/app" \
        ci-dashboard-local \
        bash -c '
            cd /app
            
            # Install dependencies if needed
            if [ ! -d node_modules ]; then
                echo "Installing npm dependencies..."
                npm install
            fi
            
            echo "Processing nightly data..."
            node scripts/process-data.js
            
            if [ -f raw-pr-runs.json ]; then
                echo ""
                echo "Processing flaky data..."
                node scripts/process-flaky-data.js
            fi
            
            echo ""
            echo "✅ Data processing complete!"
        '
}

# Serve locally
serve() {
    echo "🌐 Starting local server at http://localhost:8080"
    echo "   Press Ctrl+C to stop"
    echo ""
    
    docker run --rm \
        -v "$SCRIPT_DIR:/app" \
        -p 8080:8080 \
        ci-dashboard-local \
        npx http-server /app -p 8080 -c-1
}

# Main
case "${1:-both}" in
    fetch)
        build_container
        fetch_nightly_data
        fetch_flaky_data
        process_data
        ;;
    serve)
        build_container
        serve
        ;;
    both)
        build_container
        fetch_nightly_data
        fetch_flaky_data
        process_data
        serve
        ;;
    *)
        echo "Usage: $0 [fetch|serve|both]"
        echo ""
        echo "  fetch  - Fetch and process data only"
        echo "  serve  - Start local server only (requires data.json)"
        echo "  both   - Fetch data and start server (default)"
        exit 1
        ;;
esac

