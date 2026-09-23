#!/usr/bin/env bash
### Parses test summary data out of the summary.json file

set -o pipefail
set -o errexit

# COUNTERS & TALLIES
###########################################
TOTAL=0
PASSED=0
FAILED_COUNT=0
NOT_RUN=0
FLAKY_COUNT=0
PASS_RATE=0
ARCH=""
FLAKY_ARCH=""
SKIP_NOTIFICATION=true


# JOB IDENTIFICATION
###########################################
DESIRED_JOBS="${DESIRED_JOBS:-snp}"
DESIRED_JOBS="${DESIRED_JOBS,,}"

JOB_TYPE="${JOB_TYPE:-kata}"
JOB_TYPE="${JOB_TYPE,,}"

default_job_prefix="${JOB_TYPE}_${DESIRED_JOBS}"
JOB_PREFIX="${JOB_PREFIX:-$default_job_prefix}"
JOB_PREFIX="${JOB_PREFIX,,}"

declare -A job_patterns
declare -A error_messages


# JOB PATTERN MATRIX
###########################################
# Filter matching (sev-snp, qemu-snp, qemu-snp-runtime-rs, Helm Trustee e2e (SNP))
job_patterns["snp"]='sev-snp|qemu-snp|\(snp\)'


# JOB ERROR MESSAGE MATRIX
###########################################
error_messages["snp"]="$(
cat << EOF
⚠️ WARNING: No SNP jobs found in summary
This could mean:"
  - Job names changed (sev-snp/qemu-snp/qemu-snp-runtime-rs → something else)
  - SNP tests didn't run in this nightly build"
  - Filter pattern needs updating"
Note: qemu-snp-experimental is intentionally excluded
Skipping notification to avoid sending misleading 0% message
EOF
)"


# I/O SOURCES
###########################################
GITHUB_OUTPUT="${GITHUB_OUTPUT:-/dev/stdout}"
JSON_OUTFILE="${JSON_OUTFILE:-${JOB_PREFIX}_summary_values.json}"

# SUMMARY OUTPUT
###########################################
output_values_json(){
    jq -n \
        --argjson total "$TOTAL"\
        --argjson passed "$PASSED"\
        --argjson failed_count "$FAILED_COUNT"\
        --argjson not_run "$NOT_RUN"\
        --argjson flaky_count "$FLAKY_COUNT"\
        --argjson pass_rate "$PASS_RATE"\
        --arg arch_summary "$ARCH"\
        --arg flaky_arch_summary "$FLAKY_ARCH"\
        --argjson skip_notification "$SKIP_NOTIFICATION"\
        '$ARGS.named'
}


output_values(){
cat << EOF
total=${TOTAL}
passed=${PASSED}
failed_count=${FAILED_COUNT}
not_run=${NOT_RUN}
flaky_count=${FLAKY_COUNT}
pass_rate=${PASS_RATE}
arch_summary=${ARCH}
flaky_arch_summary=${FLAKY_ARCH}
skip_notification=${SKIP_NOTIFICATION}
EOF
}
DEFAULT_VALUES=$(output_values)
DEFAULT_VALUES_JSON=$(output_values_json)


output_summary(){
cat << EOF
=== ${DESIRED_JOBS} Summary ===
Total ${DESIRED_JOBS} jobs: $TOTAL
Passed: $PASSED
Failed: $FAILED_COUNT
Not run: $NOT_RUN
Flaky: $FLAKY_COUNT
Pass rate: $PASS_RATE%
EOF
}

# INPUT VALIDATION
###########################################
# get_summary_data_file validates & makes a temp copy of the specifed json file.
# If successful, the path to the temp json file is emitted.
get_summary_data_file(){
    local input_source="${1:-}"

    if [ -n "$input_source" ]; then
        if [ ! -f "$input_source" ]; then
            echo "❌ ERROR: $input_source not found" >&2
            exit 1
        fi
        SUMMARY_JSON=$(cat "$input_source")
    else
        SUMMARY_JSON=$(cat)
        if [ -z "$SUMMARY_JSON" ]; then
            echo "❌ ERROR: No input provided (pass a file argument or pipe JSON to stdin)" >&2
            exit 1
        fi
    fi

    if ! echo "$SUMMARY_JSON" | jq empty 2>/dev/null; then
        echo "❌ ERROR: Input is not valid JSON" >&2
        echo "$SUMMARY_JSON" >&2
        exit 1
    fi

    local summary_data_file
    summary_data_file=$(mktemp)
    echo "$SUMMARY_JSON" > "$summary_data_file"
    echo "$summary_data_file"
}

# SUMMARY CALCULUS
##########################################
# tabulate_values sets the global tally variables 
# using the provided regex pattern to match jobs by name 
# in the provided summary_data_file. The tally vairables
# track how many jobs passed, failed, didn't run, were flaky, etc.
tabulate_values() {
    local job_pattern="$1"
    local summary_data_file="$2"
    
    # Filter for the desired jobs only
    # Exclude experimental jobs by filtering it out after initial match
    
    FAILED=$(jq --arg job_pattern "${job_pattern}" -L ./scripts/jq 'include "get_tests"; [. | failing_tests | matching($job_pattern) | stable]' "$summary_data_file")
    FLAKY=$(jq --arg job_pattern "${job_pattern}" -L ./scripts/jq 'include "get_tests"; [. | flaky_tests | matching($job_pattern) | stable]' "$summary_data_file")

    # Get architecture breakdown for SNP jobs if available
    ARCH=$(echo "$FAILED" | jq -r 'group_by(.arch) | map("\(length)x \(.[0].arch)") | join(" ")' 2>/dev/null || echo "")
    FLAKY_ARCH=$(echo "$FLAKY" | jq -r 'group_by(.arch) | map("\(length)x \(.[0].arch)") | join(" ")' 2>/dev/null || echo "")

    # Calculate SNP-specific stats from all sections
    FAILED_COUNT=$(echo "$FAILED" | jq 'length')
    FLAKY_COUNT=$(echo "$FLAKY" | jq 'length')
    TOTAL=$(  jq --arg job_pattern  "${job_pattern}" -L ./scripts/jq 'include "get_tests"; [. | all_tests | matching($job_pattern) | stable           ] | length' "$summary_data_file")
    PASSED=$( jq --arg job_pattern  "${job_pattern}" -L ./scripts/jq 'include "get_tests"; [. | all_tests | matching($job_pattern) | stable  | passing] | length' "$summary_data_file")
    NOT_RUN=$(jq --arg job_pattern  "${job_pattern}" -L ./scripts/jq 'include "get_tests"; [. | all_tests | matching($job_pattern) | stable  | skipped] | length' "$summary_data_file")

    if [ "$TOTAL" -ne 0 ]; then
        PASS_RATE=$(echo "scale=0; ($PASSED * 100) / $TOTAL" | bc)
    fi
}


parse_args(){
    if [[ $# -eq 0 ]]; then
        echo "usage: $0 [-o|--out SUMMARY_VALUES_JSON_FILE] SUMMARY_JSON_FILE" >&2
        exit 1
    fi
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -o|--out)
                JSON_OUTFILE="$2"
                shift 2
                ;;
            *)
                POSITIONAL_ARGS+=("$1")
                shift
                ;;
        esac
    done
}

# MAIN ENTRYPOINT
##########################################
main () {
    POSITIONAL_ARGS=()
    parse_args "$@"
    set -- "${POSITIONAL_ARGS[@]}"
    
    # Validate & create a temp clone of the input summary file
    trap '{ rm -f "$summary_data_file"; } &> /dev/null' EXIT
    summary_data_file=$(get_summary_data_file "${1:-}")

    # Evaluate the temp summary file & set the global tally variables accordingly for the desired set of jobs
    echo "Filtering for ${DESIRED_JOBS} jobs..."
    job_pattern="${job_patterns[$DESIRED_JOBS]}"
    tabulate_values "$job_pattern" "$summary_data_file"

    # Validate desired jobs exist
    if [ "$TOTAL" -eq 0 ]; then
        echo "${error_messages[$DESIRED_JOBS]}"
        # Set outputs to avoid empty values in subsequent steps
        echo "$DEFAULT_VALUES" >> "$GITHUB_OUTPUT"
        echo "$DEFAULT_VALUES_JSON" >> "$JSON_OUTFILE"
        exit 0
    else
        SKIP_NOTIFICATION=false
    fi

    # Write tabulated values to the next stage
    output_values >> "$GITHUB_OUTPUT"
    output_values_json > "$JSON_OUTFILE"

    # Output a summary of the tabulated values for the action logs
    output_summary
}

main "$@"

