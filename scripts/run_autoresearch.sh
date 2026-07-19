#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

tag="$(date -u +%F)-decoder"
max_iterations=0
sleep_seconds=5
iteration_timeout_minutes=180
model=""
ensure_research_branch=false
dangerously_bypass=false

usage() {
  printf '%s\n' "Usage: scripts/run_autoresearch.sh [options]" "" \
    "Options:" \
    "  --tag <value>                         Run tag (default: YYYY-MM-DD-decoder)" \
    "  --max-iterations <n>                  Stop after n iterations; 0 is unlimited" \
    "  --sleep-seconds <n>                   Delay between iterations (default: 5)" \
    "  --iteration-timeout-minutes <n>       Per-iteration timeout (default: 180)" \
    "  --model <value>                       Optional Codex model override" \
    "  --ensure-research-branch              Create/switch to autoresearch/<tag>" \
    "  --dangerously-bypass-approvals-and-sandbox" \
    "                                        Pass the matching Codex execution mode" \
    "  -h, --help                            Show this help"
}

require_integer() {
  local option="$1"
  local value="$2"
  local minimum="$3"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < minimum )); then
    printf 'error: %s requires an integer >= %s\n' "$option" "$minimum" >&2
    exit 2
  fi
}

while (( $# > 0 )); do
  case "$1" in
    --tag|--max-iterations|--sleep-seconds|--iteration-timeout-minutes|--model)
      if (( $# < 2 )); then
        printf 'error: %s requires a value\n' "$1" >&2
        exit 2
      fi
      case "$1" in
        --tag) tag="$2" ;;
        --max-iterations) max_iterations="$2" ;;
        --sleep-seconds) sleep_seconds="$2" ;;
        --iteration-timeout-minutes) iteration_timeout_minutes="$2" ;;
        --model) model="$2" ;;
      esac
      shift 2
      ;;
    --ensure-research-branch)
      ensure_research_branch=true
      shift
      ;;
    --dangerously-bypass-approvals-and-sandbox)
      dangerously_bypass=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

if [[ ! "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  printf 'error: tag must contain only letters, digits, dots, underscores, and hyphens\n' >&2
  exit 2
fi
require_integer --max-iterations "$max_iterations" 0
require_integer --sleep-seconds "$sleep_seconds" 0
require_integer --iteration-timeout-minutes "$iteration_timeout_minutes" 1

for command in codex git node timeout; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'error: required command not found: %s\n' "$command" >&2
    exit 1
  fi
done

status() {
  printf '[autoresearch] %s\n' "$*"
}

run_dir="$repo_root/tmp/autoresearch/$tag"
stop_file="$run_dir/STOP"
results_file="$run_dir/results.tsv"
prompt_file="$run_dir/loop-prompt.txt"
branch_name="autoresearch/$tag"
mkdir -p -- "$run_dir"
if [[ ! -f "$results_file" ]]; then
  printf 'commit\tscalar_passes\tmovement_passes\tpromoted_patterns\tpromoted_bundle_patterns\tstatus\tdescription\n' >"$results_file"
fi

if [[ "$ensure_research_branch" == true ]]; then
  current_branch="$(git -C "$repo_root" branch --show-current)"
  if [[ "$current_branch" != "$branch_name" ]]; then
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch_name"; then
      status "Switching to existing branch $branch_name"
      git -C "$repo_root" switch "$branch_name"
    else
      status "Creating branch $branch_name"
      git -C "$repo_root" switch -c "$branch_name"
    fi
  fi
fi

iteration=0
while true; do
  if [[ -f "$stop_file" ]]; then
    status "Stop file detected. Exiting."
    break
  fi
  if (( max_iterations > 0 && iteration >= max_iterations )); then
    status "Reached max iterations: $max_iterations"
    break
  fi

  ((iteration += 1))
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  artifact_root_relative="tmp/autoresearch/$tag/scores/iteration-$iteration-$stamp"
  artifact_root="$repo_root/$artifact_root_relative"
  if [[ -e "$artifact_root" ]]; then
    printf 'error: autoresearch score root already exists: %s\n' "$artifact_root" >&2
    exit 1
  fi

  printf '%s\n' \
    "Read program.md and docs/autonomous-decoder-research.md." \
    "Continue the autonomous decoder research loop in this repository on Linux." \
    "" \
    "Use this run tag: $tag" \
    "Use this ledger file: tmp/autoresearch/$tag/results.tsv" \
    "Use this fresh ScoreOnly corpus root for this iteration only: $artifact_root_relative" \
    "" \
    "Do exactly one bounded iteration:" \
    "1. inspect the latest kept result and current repo state" \
    "2. choose one decoder hypothesis" \
    "3. implement the change" \
    "4. run fast checks on touched files" \
    "5. rerun the complete 57-replay decoder corpus in ScoreOnly mode exactly with:" \
    "   ./scripts/run_decoder_corpus.sh --configuration Debug --score-only --artifact-root '$artifact_root_relative' --require-empty-artifact-root --force --clean-replay-artifacts" \
    "6. summarize exactly that ScoreOnly root with:" \
    "   node ./scripts/summarize_decoder_corpus.mjs --artifact-root '$artifact_root_relative' --json" \
    "7. append exactly one row to tmp/autoresearch/$tag/results.tsv and include the score-root path in its description" \
    "8. keep or revert based on the scorecard in program.md" \
    "9. update docs only if the finding is actually stable and worth recording" \
    "10. stop after this single iteration" \
    "" \
    "Use only native Linux/Bash and Node commands. Do not invoke PowerShell or any .ps1 script." \
    "Do not use the shared artifacts root. Full debug artifacts are permitted only for an explicit research question, never as the default keep/revert gate. Do not ask the user to continue. Complete one full iteration and exit." \
    >"$prompt_file"

  stdout_path="$run_dir/codex-$stamp.stdout.log"
  stderr_path="$run_dir/codex-$stamp.stderr.log"
  message_path="$run_dir/codex-$stamp.last-message.txt"
  meta_path="$run_dir/codex-$stamp.meta.json"
  started_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  codex_args=(exec --json -C "$repo_root" -o "$message_path")
  if [[ "$dangerously_bypass" == true ]]; then
    codex_args+=(--dangerously-bypass-approvals-and-sandbox)
  else
    codex_args+=(--full-auto)
  fi
  if [[ -n "$model" ]]; then
    codex_args+=(-m "$model")
  fi
  codex_args+=(-)

  status "Starting iteration $iteration"
  if timeout --signal=TERM --kill-after=15s "${iteration_timeout_minutes}m" \
      codex "${codex_args[@]}" <"$prompt_file" >"$stdout_path" 2>"$stderr_path"; then
    exit_code=0
    completed=true
  else
    exit_code=$?
    completed=true
    if (( exit_code == 124 )); then
      completed=false
      printf 'Supervisor timeout after %s minutes.\n' "$iteration_timeout_minutes" >>"$stderr_path"
    fi
  fi
  status "Iteration $iteration exited with code $exit_code"
  finished_at_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  node - "$meta_path" "$iteration" "$tag" "$started_at_utc" "$finished_at_utc" "$exit_code" "$completed" \
      "$artifact_root" "$artifact_root_relative" "$stdout_path" "$stderr_path" "$message_path" <<'NODE'
const fs = require("node:fs");
const [output, iteration, tag, startedAtUtc, finishedAtUtc, exitCode, completed,
  artifactRoot, artifactRootRelative, stdoutPath, stderrPath, messagePath] = process.argv.slice(2);
fs.writeFileSync(output, `${JSON.stringify({
  iteration: Number(iteration), tag, startedAtUtc, finishedAtUtc,
  exitCode: Number(exitCode), completed: completed === "true",
  artifactRoot, artifactRootRelative, stdoutPath, stderrPath, messagePath,
}, null, 2)}\n`);
NODE

  if [[ -f "$stop_file" ]]; then
    status "Stop file detected after iteration $iteration. Exiting."
    break
  fi
  if (( sleep_seconds > 0 )); then
    sleep "$sleep_seconds"
  fi
done
