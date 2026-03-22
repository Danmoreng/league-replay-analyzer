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
   - run the full decoder corpus
   - run `node .\scripts\summarize_decoder_corpus.mjs --json`
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
- Do not keep a change without a full corpus rerun.

## Experiment loop

Loop forever:

1. inspect the current branch, latest kept score, and recent findings
2. choose one decoder hypothesis
3. edit the relevant decoder files
4. run fast checks:
   - `node --check` on edited files
   - targeted replay extraction or validation when useful
5. commit the experiment
6. run the full corpus:
   - `& 'C:\Program Files\PowerShell\7\pwsh.exe' -File .\scripts\run_decoder_corpus.ps1 -Configuration Debug`
7. summarize the run:
   - `node .\scripts\summarize_decoder_corpus.mjs --json`
8. append a row to `tmp/autoresearch/<tag>/results.tsv`
9. compare against the previous kept result
10. keep or revert:
   - keep if the score improved
   - revert if it regressed
   - revert if it stayed flat and the code got more complex without a clear correctness gain
11. move to the next hypothesis immediately

## Scorecard

Compare runs in this order:

1. `scalarPasses`
2. `movementPasses`
3. `promotedPatterns`
4. `promotedBundlePatterns`

This project should still bias toward state decoding first. Scalar validation wins over movement shape improvements.

## Current priority order

Current stable reference score:

- `scalarPasses = 40`
- `movementPasses = 64`
- `promotedPatterns = 349`
- `promotedBundlePatterns = 3`

Known caveat:

- one overnight run reached `40 / 68 / 349 / 3`, but that movement-side result has not yet been reproduced deterministically from a clean rerun

Current priority order:

1. split ambiguous exact `16.6 | 61894-0x00-h6` patterns before participant assignment and extraction tie-breaking
2. stabilize `16.6 | 6912-0xC6-h0 | power` around `s14`
3. improve latest-patch movement rejection without regressing validated scalar extraction

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
