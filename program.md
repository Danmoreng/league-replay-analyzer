# Decoder Autoresearch Program

This file is the autonomous overnight research contract for the replay decoder.

The goal is not generic coding output. The goal is to improve validated replay decoding across the local corpus, keep only real wins, and continue without waiting for the human.

## Read first

Before doing anything else, read these files:

1. `AGENTS.md`
2. `docs/decoder-status.md`
3. `docs/decoder-development-loop.md`
4. `docs/autonomous-decoder-research.md`
5. `scripts/summarize_decoder_corpus.mjs`

## Setup

Work with the user once to set up a run:

1. agree on a run tag such as `2026-03-21-decoder`
2. create a fresh branch `autoresearch/<tag>`
3. create `tmp/autoresearch/<tag>/`
4. initialize `tmp/autoresearch/<tag>/results.tsv` with the documented header
5. establish the baseline:
   - choose one fresh score root such as `tmp/autoresearch/<tag>/scores/baseline-<timestamp>`
   - run the complete decoder corpus with `-ScoreOnly -ArtifactRoot <fresh-root> -RequireEmptyArtifactRoot`
   - run `node .\scripts\summarize_decoder_corpus.mjs --artifact-root <fresh-root> --json`
   - log the baseline row as `keep`

After setup, do not stop to ask whether you should continue. Continue until interrupted.

The recommended supervisor is:

- `pwsh -File .\scripts\run_autoresearch.ps1 -Tag <tag>`

To stop the loop cleanly:

- `pwsh -File .\scripts\stop_autoresearch.ps1 -Tag <tag>`

Stopping nuance:

- the stop script prevents new iterations by writing a `STOP` file
- it does not forcibly kill a `codex exec` child that is already running

## Allowed work

Primary scope:

- `scripts/*.mjs`
- `scripts/lib/*.mjs`
- decoder docs that need to reflect new stable findings

Secondary scope:

- small helper tooling that makes the decoder loop more measurable or reliable

Do not drift into unrelated frontend work, Wasm work, or broad refactors unless the experiment clearly requires it.

## Hard constraints

- Do not modify replay fixtures as part of the experiment loop.
- Do not commit generated replay movement fixtures.
- Do not commit scratch scripts unless they are promoted into real maintained tooling.
- Do not keep changes that rely on averaging or median-based movement transforms for final extraction.
- Do not keep a change without a complete 57-replay corpus rerun in ScoreOnly mode.

## Experiment loop

Loop forever:

1. inspect the current branch, latest kept score, and recent findings
2. choose one decoder hypothesis
3. edit the relevant decoder files
4. run fast checks:
   - `node --check` on edited files
   - targeted replay extraction or validation when useful
5. commit the experiment
6. choose a new per-iteration score root under
   `tmp/autoresearch/<tag>/scores/iteration-<n>-<timestamp>` and run the complete corpus:
   - `& 'C:\Program Files\PowerShell\7\pwsh.exe' -File .\scripts\run_decoder_corpus.ps1 -Configuration Debug -ScoreOnly -ArtifactRoot <fresh-root> -RequireEmptyArtifactRoot -Force -CleanReplayArtifacts`
7. summarize the run:
   - `node .\scripts\summarize_decoder_corpus.mjs --artifact-root <fresh-root> --json`
8. append a row to `tmp/autoresearch/<tag>/results.tsv`
9. compare against the previous kept result
10. keep or revert:
   - keep if the score improved
   - revert if it regressed
   - revert if it stayed flat and the code got more complex without a clear correctness gain
11. move to the next hypothesis immediately

The scorecard is strict and manifest-based by default. It requires both scalar
and assigned-movement reports for every manifested replay and rejects stale
unmanifested score-report directories. `--allow-legacy-directory-scan` is a
diagnostic compatibility escape hatch, never a valid autonomous scorecard.

## Artifact discipline and retention

`-ScoreOnly` is the default keep/revert gate. It still processes the complete
57-replay corpus and produces the manifest, schema, validation reports, and
scorecard needed for the decision, but suppresses bulky per-replay research
artifacts. The verified reference run is 427,731,245 bytes (about 408 MiB /
0.398 GiB), compared with roughly 4.1 GiB for the older full-debug run.

Use full debug output only when a concrete research question needs raw family,
slab, schema, extraction, or movement artifacts; it is not the automatic
follow-up to every experiment. The durable evidence is the ledger row, compact
summary, and kept commit—not every 408 MiB ScoreOnly root. Retain at most the
current baseline root and any root needed by an active investigation. Once its
score is recorded, a completed ScoreOnly root is reproducible and may be
deleted manually. Keep debug roots only while they remain useful evidence for
an active investigation or a documented finding. Do not promise automatic
deletion: manage temporary retention deliberately. Run full debug work on a
fast local SSD and check free space first.

## Scorecard

Compare runs in this order:

1. `scalarPasses`
2. `movementPasses`
3. `promotedPatterns`
4. `promotedBundlePatterns`

This project should still bias toward state decoding first. Scalar validation wins over movement shape improvements.

## Current priority order

Current stable reference score:

- `scalarPasses = 62`
- `movementPasses = 294`
- `promotedPatterns = 1421`
- `promotedBundlePatterns = 0`

This is the fresh 57-replay scorecard at commit `57b79b3`, including the ten
exact-build patch-16.14 fixtures. The bundle count is zero by the current strict
manifest-based summarizer and must not be compared to the superseded 18-replay
March baseline as if the corpus and promotion boundary were unchanged.

Current priority order:

1. promote or reject the exact-build 16.14 XP and neutral-CS Float32 research
   stripes using the already frozen 256-byte `0x02EB` cipher table and a
   replay-only integer-projection/snapshot-ordering gate; total gold and lane
   CS are already profile-backed decoded fields, while XP/neutral CS are not
2. decode current gold, then level and health/resource state from the same
   participant-owned keyframe grammar without runtime Timeline input
3. derive replay-native inventory slot/instance/removal linkage and a complete
   reducer from the proven patch-16.14 and patch-16.9 transaction families
4. use the exact ward-linked `0x0328`/`0x0170` handle subset to recover its
   operation/payload grammar, expand explicit entity identity, and only then
   interpret movement coordinates or promote UI output

## Crash policy

If a run crashes:

- inspect the log
- fix obvious mistakes once or twice if the idea is still sound
- otherwise mark the run as `crash`, revert, and move on

## Keep the loop honest

Do not confuse busier artifacts with progress.

Progress means one of:

- more validated scalar passes
- more validated movement assignments without scalar regression
- a clearly documented correctness fix that preserves the scorecard

Everything else is noise until proven otherwise.
