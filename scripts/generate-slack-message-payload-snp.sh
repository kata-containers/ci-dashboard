#!/usr/bin/env bash
set -o pipefail
set -o errexit

# Value source files
KATA_SUMMARY_VALUES_FILE="${KATA_SUMMARY_VALUES_FILE:-kata_snp_summary_values.json}"
TRUSTEE_SUMMARY_VALUES_FILE="${TRUSTEE_SUMMARY_VALUES_FILE:-trustee_snp_summary_values.json}"

# Default Kata Values
kata_snp_total=${kata_snp_total:-0}
kata_snp_pass_rate=${kata_snp_pass_rate:-0}
kata_snp_failed_count=${kata_snp_failed_count:-0}
kata_snp_flaky_count=${kata_snp_flaky_count:-0}
kata_snp_passed=${kata_snp_passed:-0}
kata_snp_failed_count=${kata_snp_failed_count:-0}
kata_snp_not_run=${kata_snp_not_run:-0}

# Default trustee Values
trustee_snp_total=${trustee_snp_total:-0}
trustee_snp_pass_rate=${trustee_snp_pass_rate:-0}
trustee_snp_failed_count=${trustee_failed_count:-0}
trustee_snp_flaky_count=${trustee_snp_flaky_count:-0}
trustee_snp_passed=${trustee_snp_passed:-0}
trustee_snp_failed_count=${trustee_snp_failed_count:-0}
trustee_snp_not_run=${trustee_snp_not_run:-0}

load_kata_values_from_json() {
	read -r kata_snp_pass_rate\
		kata_snp_passed\
		kata_snp_failed_count\
		kata_snp_not_run\
		kata_snp_flaky_count\
		kata_snp_total\
		kata_snp_failing_arch\
		kata_snp_flaky_arch\
	< <(jq -r '[.pass_rate, .passed, .failed_count, .not_run, .flaky_count, .total, .arch_summary, .flaky_arch_summary] | join(" ")' "$1")
}

load_trustee_values_from_json(){
	read -r trustee_snp_pass_rate\
		trustee_snp_passed\
		trustee_snp_failed_count\
		trustee_snp_not_run\
		trustee_snp_flaky_count\
		trustee_snp_total\
		trustee_snp_failing_arch\
		trustee_snp_flaky_arch\
	< <(jq -r '[.pass_rate, .passed, .failed_count, .not_run, .flaky_count, .total, .arch_summary, .flaky_arch_summary] | join(" ")' "$1")
}

describe_status(){
    local pass_rate=${1:-0}
	local status_emoji
	local status_text
    if [ "$pass_rate" -ge 95 ]; then
        status_emoji="☀️"
        status_text="Excellent"
    elif [ "$pass_rate" -ge 85 ]; then
        status_emoji="🌤️"
        status_text="Good"
    elif [ "$pass_rate" -ge 70 ]; then
        status_emoji="⛅"
        status_text="Fair"
    elif [ "$pass_rate" -ge 50 ]; then
        status_emoji="🌧️"
        status_text="Needs Attention"
    else
        status_emoji="⛈️"
        status_text="Critical"
    fi
    echo "$status_emoji $status_text"
}

describe_failed(){
    # Build summary lines with arch breakdown
    local failed_count=$1
    local failing_arch=${2:-''}
    local failed
    if [ "$failed_count" -eq 0 ]; then
        failed="🔴 *0 SNP jobs failed* 🎉"
    else
        if [ -n "$failing_arch" ]; then
            failed="🔴 *${failed_count} SNP jobs failed* [${failing_arch}]"
        else
            failed="🔴 *${failed_count} SNP jobs failed*"
        fi
    fi
    echo "$failed"
}

describe_flaky(){
    # Build summary lines with arch breakdown
    local flaky_count=$1
    local flaky_arch=${2:-''}
    local flaky
    if [ "$flaky_count" -eq 0 ]; then
        flaky="⚡ *0 SNP jobs are flaky*"
    else
        if [ -n "$flaky_arch" ]; then
            flaky="⚡ *${flaky_count} SNP jobs are flaky* [${flaky_arch}]"
        else
            flaky="⚡ *${flaky_count} SNP jobs are flaky*"
        fi
    fi
    echo "$flaky"
}

generate_slack_message_payload(){
jq '.' <<EOF
{
	"blocks": [
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": "${status_emoji} AMD SEV-SNP Nightly CI Results ($status_text)",
				"emoji": true
			}
		},
		{
			"type": "context",
			"elements": [
				{
					"type": "mrkdwn",
					"text": "$(date -u '+%A, %B %d, %Y')"
				}
			]
		},
		{
			"type": "divider"
		},
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": "Kata/CoCo SEV-SNP Nightly CI Results ($kata_status_text)",
				"emoji": true
			}
		},
		{
			"type": "section",
			"fields": [
				{
					"type": "mrkdwn",
					"text": "*Pass Rate*\n${kata_status_emoji} ${kata_snp_pass_rate}%"
				},
				{
					"type": "mrkdwn",
					"text": "*Status*\n${kata_status_text}"
				},
				{
					"type": "mrkdwn",
					"text": "*SNP Jobs*\n${kata_snp_total} total"
				},
				{
					"type": "mrkdwn",
					"text": "*Results*\n🟢 ${kata_snp_passed} | 🔴 ${kata_snp_failed_count} | 🟡 ${kata_snp_not_run}"
				}
			]
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": "${kata_failed_line}\n${kata_flaky_line}\n\n📊 <https://kata-containers.github.io/ci-dashboard/|View details on CI Dashboard>"
			}
		},
		{
			"type": "divider"
		},
		{
			"type": "header",
			"text": {
				"type": "plain_text",
				"text": "Trustee SEV-SNP Nightly CI Results ($trustee_status_text)",
				"emoji": true
			}
		},
		{
			"type": "section",
			"fields": [
				{
					"type": "mrkdwn",
					"text": "*Pass Rate*\n${trustee_status_emoji} ${trustee_snp_pass_rate}%"
				},
				{
					"type": "mrkdwn",
					"text": "*Status*\n${trustee_status_text}"
				},
				{
					"type": "mrkdwn",
					"text": "*SNP Jobs*\n${trustee_snp_total} total"
				},
				{
					"type": "mrkdwn",
					"text": "*Results*\n🟢 ${trustee_snp_passed} | 🔴 ${trustee_snp_failed_count} | 🟡 ${trustee_snp_not_run}"
				}
			]
		},
		{
			"type": "section",
			"text": {
				"type": "mrkdwn",
				"text": "${trustee_failed_line}\n${trustee_flaky_line}\n\n📊 <https://kata-containers.github.io/ci-dashboard/|View details on CI Dashboard>"
			}
		}
	]
}
EOF
}

main() {
	if [ $# -eq 2 ]; then
		KATA_SUMMARY_VALUES_FILE="$1"
		TRUSTEE_SUMMARY_VALUES_FILE="$2"
	elif [ $# -ne 0 ]; then
		echo "Usage: $0 [KATA_SUMMARY_VALUES_FILE TRUSTEE_SUMMARY_VALUES_FILE]" >&2
		echo "Either provide both arguments or set the KATA_SUMMARY_VALUES_FILE & TRUSTEE_SUMMARY_VALUES_FILE environment variables manually." >&2
		exit 1
	fi

	load_kata_values_from_json "$KATA_SUMMARY_VALUES_FILE"
	load_trustee_values_from_json "$TRUSTEE_SUMMARY_VALUES_FILE"

	# Check the status of each job type
	read -r kata_status_emoji kata_status_text < <(describe_status "$kata_snp_pass_rate");
	read -r trustee_status_emoji trustee_status_text < <(describe_status "$trustee_snp_pass_rate");

	# Set the overall status to the lower of the two job types
	snp_pass_rate=$(( kata_snp_pass_rate < trustee_snp_pass_rate ? kata_snp_pass_rate : trustee_snp_pass_rate ))
	read -r status_emoji status_text < <(describe_status "$snp_pass_rate")


	# Get arch breakdowns from summary with defaults
	kata_failed_line=$(describe_failed "$kata_snp_failed_count" "$kata_snp_failing_arch")
	trustee_failed_line=$(describe_failed "$trustee_snp_failed_count" "$trustee_snp_failing_arch")

	kata_flaky_line=$(describe_flaky "$kata_snp_flaky_count" "$kata_snp_flaky_arch")
	trustee_flaky_line=$(describe_flaky "$trustee_snp_flaky_count" "$trustee_snp_flaky_arch")

	generate_slack_message_payload
}

# shellcheck disable=SC2068
main $@

