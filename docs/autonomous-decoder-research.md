# Autonomous Decoder Research

This project can use the same core idea as `autoresearch`, but the unit of progress is not a 5-minute training run. Here the unit of progress is a decoder hypothesis that survives a full corpus rerun.

## Core idea

The agent should operate on a dedicated research branch and repeat a strict keep-or-revert loop:

1. make one decoder hypothesis concrete in code
2. run targeted checks to catch obvious breakage fast
3. rerun the full decoder corpus
4. summarize the resulting corpus metrics
5. keep the commit only if the corpus actually improved
6. otherwise revert and try the next idea

The important adaptation is that this repo needs a machine-readable scorecard after each corpus run. Use [summarize_decoder_corpus.mjs](/C:/Development/league-replay-analyzer/scripts/summarize_decoder_corpus.mjs) for that.

## Scope

This workflow is for decoder research, not general product work.

In scope:

- `scripts/*.mjs`
- `scripts/lib/*.mjs`
- focused decoder docs when findings materially change

Usually out of scope for the overnight loop:

- `apps/web` feature work
- Wasm bindings
- C++ parser architecture changes
- replay fixture publishing
- cleanup of unrelated prototype files

Frontend or Wasm edits are acceptable only when they are directly required to inspect decoder outputs, not as the primary goal of the run.

## Run setup

Use a dedicated branch per autonomous session:

- branch name: `autoresearch/<tag>`
- example tag: `2026-03-21-decoder`

Keep all run logs under:

- `tmp/autoresearch/<tag>/`

Recommended files in that directory:

- `results.tsv`
- one `run-<timestamp>.log` per corpus rerun
- one `summary-<timestamp>.json` per corpus summary

Do not commit anything under `tmp/autoresearch/`.

## Recommended supervisor

Do not rely on one long interactive Codex session staying open overnight.

Use the repo-local supervisor instead:

```powershell
pwsh -File .\scripts\run_autoresearch.ps1 -Tag 2026-03-21-decoder -EnsureResearchBranch
```

That script does not try to keep one Codex process alive forever. It repeatedly launches bounded `codex exec` iterations, lets each one finish, and starts the next. That is the reliable heartbeat.

To stop the run cleanly:

```powershell
pwsh -File .\scripts\stop_autoresearch.ps1 -Tag 2026-03-21-decoder
```

Useful options:

- `-MaxIterations 12` to cap the run
- `-IterationTimeoutMinutes 180` to kill a stuck iteration
- `-SleepSeconds 10` to pause briefly between iterations
- `-Model <name>` to pin a model
- `-DangerouslyBypassApprovalsAndSandbox` only in an isolated throwaway clone or VM

Important runtime note:

- `stop_autoresearch.ps1` creates a `STOP` file for the supervisor loop, but it does not forcibly kill a `codex exec` child that is already running
- if the supervisor process dies unexpectedly, the current child iteration may still finish on its own, but no later iterations should start without the supervisor

## Ground rules

- Do not commit generated replay movement fixtures.
- Do not commit scratch or temporary scripts unless they become real maintained tooling.
- Do not use averaged or median-derived transforms for final replay movement extraction.
- Prefer exact replay-local evidence for movement and slot-cluster resolution.
- Do not keep a change based only on intuition, one replay, or a prettier artifact. Keep it only if the corpus score improved or a correctness fix is clearly documented.

## Experiment unit

One experiment should represent one coherent decoding idea, for example:

- split an ambiguous `movementSpeed` pattern by slot cluster before assignment
- tighten bundle-backed promotion around one family and one metric
- change candidate ranking so exact replay-local evidence wins over weak bundle fallbacks
- improve one validator so bad latest-patch candidates are rejected earlier

Avoid mixing several unrelated decoder ideas into one experiment. If a run improves, the winning reason should be explainable.

## Required checks

Before a full corpus rerun:

1. run syntax checks on edited `.mjs` files with `node --check`
2. run targeted replay extraction or validation commands for the specific family or replay you touched when practical

Before keeping any change:

1. rerun the full corpus:
   `& 'C:\Program Files\PowerShell\7\pwsh.exe' -File .\scripts\run_decoder_corpus.ps1 -Configuration Debug`
2. summarize the results:
   `node .\scripts\summarize_decoder_corpus.mjs --json`

If the full corpus did not run, the experiment is not complete and should not be kept as an overnight winner.

## Scorecard

The default scorecard is lexicographic and intentionally conservative:

1. `scalarPasses`
2. `movementPasses`
3. `promotedPatterns`
4. `promotedBundlePatterns`

These values come from [summarize_decoder_corpus.mjs](/C:/Development/league-replay-analyzer/scripts/summarize_decoder_corpus.mjs).

Interpretation:

- scalar validation wins first because state decoding is still the stronger backbone
- movement assignment wins second because it benefits from better scalar identity
- promoted schema counts are useful, but only after validation counts

## Keep or revert

Keep a commit if:

- `scalarPasses` increased, and there is no obvious severe correctness regression
- or `scalarPasses` stayed equal and `movementPasses` increased
- or the scorecard stayed flat but the change is a clear correctness fix or simplification with no measurable regression

Revert a commit if:

- `scalarPasses` decreased
- or the run crashed and the fix is not obvious
- or the corpus score stayed flat and the code got more complex without a clear correctness gain

When in doubt, revert. The loop should bias toward preserving only clear wins.

## Safety

Git commits reduce the risk of losing tracked code changes, but they are not complete protection.

Autonomous runs can still:

- damage or delete untracked files
- modify files outside the repo if you run with broad access
- leave the worktree in a bad local state

So the recommended setup is:

1. run in a disposable repo copy
2. use a dedicated research branch
3. prefer `--full-auto` over dangerous full access
4. use dangerous full access only if the surrounding environment is already isolated

## Suggested TSV format

Use a tab-separated file at `tmp/autoresearch/<tag>/results.tsv` with this header:

```text
commit	scalar_passes	movement_passes	promoted_patterns	promoted_bundle_patterns	status	description
```

Status should be one of:

- `keep`
- `discard`
- `crash`

## Good overnight targets

Current high-value targets:

1. split ambiguous replay-local exact `16.6 | 61894-0x00-h6` patterns before participant assignment and extraction tie-breaking
2. stabilize `16.6 | 6912-0xC6-h0 | power` around `s14`
3. strengthen rejection of weak latest-patch movement candidates without hurting validated scalar extraction

Current stable reference score after the recovered 2026-03-22 branch win:

- `scalarPasses = 40`
- `movementPasses = 64`
- `promotedPatterns = 349`
- `promotedBundlePatterns = 3`

Known caveat:

- one overnight run reached `40 / 68 / 349 / 3`, but that movement-side result has not yet been reproduced deterministically from a clean rerun

Current poor overnight targets:

- wide frontend refactors
- large C++ parser rewrites
- changes that require new dependencies
- cosmetic artifact reshaping without validation impact

## Files to read first

Before starting an autonomous run, the agent should read:

1. [program.md](/C:/Development/league-replay-analyzer/program.md)
2. [AGENTS.md](/C:/Development/league-replay-analyzer/AGENTS.md)
3. [decoder-status.md](/C:/Development/league-replay-analyzer/docs/decoder-status.md)
4. [decoder-development-loop.md](/C:/Development/league-replay-analyzer/docs/decoder-development-loop.md)
5. [autonomous-decoder-research.md](/C:/Development/league-replay-analyzer/docs/autonomous-decoder-research.md)
