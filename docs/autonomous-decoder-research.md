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
- one fresh `scores/iteration-<n>-<timestamp>/` ScoreOnly corpus root per iteration

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

1. choose a fresh per-iteration score root and rerun the complete corpus in
   ScoreOnly mode:
   `& 'C:\Program Files\PowerShell\7\pwsh.exe' -File .\scripts\run_decoder_corpus.ps1 -Configuration Debug -ScoreOnly -ArtifactRoot <fresh-root> -RequireEmptyArtifactRoot -Force -CleanReplayArtifacts`
2. summarize the results:
   `node .\scripts\summarize_decoder_corpus.mjs --artifact-root <fresh-root> --json`

ScoreOnly still processes the complete 57-replay corpus; it is not a partial
corpus shortcut. If that full score run did not complete, the experiment is not
complete and should not be kept as an overnight winner.

The summarizer is strict and manifest-based by default. It fails if a
manifested scalar or assigned-movement report is missing, if schema/manifest
provenance points at another root, or if an unmanifested directory contains a
score report. `--allow-legacy-directory-scan` exists only for old diagnostic
artifacts and must not be used to decide keep/revert.

## Artifact discipline and retention

The standard autonomous gate is `-ScoreOnly`. Its verified 57-replay output is
427,731,245 bytes (about 408 MiB / 0.398 GiB), while the previous full-debug
workflow used roughly 4.1 GiB per corpus root. ScoreOnly retains the strict
manifest/schema/validation evidence needed by the scorecard but avoids bulky
per-replay discovery artifacts.

Run a full-debug corpus only for an explicit research question that needs raw
family, slab, schema, extraction, or movement outputs. It is not required for
ordinary keep/revert decisions. The durable evidence is the ledger row, compact
summary, and kept commit—not every ScoreOnly root. Retain at most the current
baseline root and any root needed by an active investigation. After a completed
ScoreOnly run has a recorded score, its root is reproducible and may be deleted
manually. Retain debug roots only while they are active research evidence or
support a documented finding. There is no automatic deletion promise. Use a
fast local SSD for debug work and check available disk space before starting it.

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

1. use the exact patch-16.14 366-record `0x01EB` directory to decode the
   variable bridge/typed-value stream grammar through `0x02EB`/`0x0151`;
   directory/bridge remain non-semantic and Gold/CS correlations are constraints
2. derive replay-native inventory slot/instance/removal linkage and a complete
   reducer from the proven versioned transaction families
3. use the exact ward-linked `0x0328`/`0x0170` handle subset to recover its
   operation/payload grammar, expand explicit entity identity, and only then
   interpret coordinate-like payload values

Current stable reference score from the fresh 57-replay run at commit
`57b79b3`:

- `scalarPasses = 62`
- `movementPasses = 294`
- `promotedPatterns = 1421`
- `promotedBundlePatterns = 0`

This reference includes ten exact-build patch-16.14 fixtures. It supersedes the
old 18-replay March score for keep/revert decisions; the two corpus shapes and
their promotion counts are not directly interchangeable.

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
