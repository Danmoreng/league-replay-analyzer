# Decoder Development Loop

Updated: 2026-03-21

This document defines the preferred non-UI development loop for replay decoder work until we have a more confident data schema.

Use this as the working plan for future decoder sessions.

## Goal

Build an automatic replay-decoding loop that can:

- discover likely state-bearing families and rows
- rank likely field patterns automatically
- promote only the strongest recurring patterns into a provisional schema
- extract normalized participant stat timelines automatically
- validate those extracted timelines against Riot timeline ground truth

The UI should remain a consumer and spot-check tool. Discovery and schema inference should happen outside the UI first.

## Why Outside The UI

The current UI is useful for inspection, but it is the wrong place to drive the main reverse-engineering loop because:

- the decoder still needs batch-style repeated experiments
- we need replay-to-replay comparisons, not one screen at a time
- we need machine-readable artifacts that can be diffed and re-scored
- we need deterministic promotion rules before we expose anything as “decoded” in the UI

So the primary loop should run through native CLI plus small scripts under `scripts/`.

## Current Inputs

We already have the important building blocks:

### Native CLI analyzers

Available now in `rofl_core_cli`:

- `--scan-replay-families-json`
- `--analyze-sparse-family-json`
- `--analyze-scalar-family-json`
- `--analyze-entity-slab-json`
- `--analyze-bitfield-schema-json`
- `--analyze-clean-row-offsets-json`

### Existing supervision

- Riot `match.json`
- Riot `timeline.json`
- replay metadata and embedded `statsJson`

### Current strongest target replay

- `EUW1-7779216102.rofl`

### Current strongest family target

- `61917 / 0x00`

### Current strongest row band

- low dynamic rows around `15`, `17`, `20`

## Working Model

The current best model is:

1. several large recurring `16B` stride slabs exist
2. some early rows are schema/descriptor-heavy
3. later rows mix real state bytes with signature-like packed motifs
4. cleaned-field analysis must mask recurring signature windows first
5. state extraction is more promising than movement extraction right now

That model should be treated as the baseline until disproved.

## Target Output

The immediate target is not full replay decoding. The immediate target is a machine-readable provisional schema with confidence.

A provisional field record should look like this conceptually:

```json
{
  "replayVersion": "15.6.x-or-family-signature-group",
  "family": "61917 / 0x00",
  "rowArchetype": "dynamic_state_like",
  "rowBand": [15, 20],
  "offset": 10,
  "decode": "u8_2",
  "metric": "level",
  "confidence": 0.82,
  "support": {
    "replays": 1,
    "participants": 8,
    "rows": 2,
    "avgCorrelation": 0.68,
    "avgNormalizedRmse": 0.31
  }
}
```

Once we have enough records like that, automatic extraction can emit normalized participant timelines.

## Recommended Development Loop

### Phase 1: Replay-level artifact generation

For each replay under investigation:

1. run family scan
2. select top recurring families automatically
3. run entity-slab analysis for those families
4. run schema analysis on early rows
5. derive cleaned candidate rows from dynamic and mixed slots
6. run cleaned row-offset analysis
7. save all outputs as JSON artifacts

Store them under a replay-specific artifact directory, for example:

- `artifacts/<replay-id>/family-scan.json`
- `artifacts/<replay-id>/families/<family-key>/entity-slab.json`
- `artifacts/<replay-id>/families/<family-key>/schema.json`
- `artifacts/<replay-id>/families/<family-key>/cleaned.json`

These artifact files do not exist yet by default. They are the intended next step for automation.

### Phase 2: Candidate normalization

Load the artifacts and normalize the cleaned fields into canonical candidates.

Important rule:

- deduplicate aliases coming from the same raw window

Examples of aliases that should collapse into one raw-window candidate:

- `u32 @ +7`
- `u16hi @ +7`
- `u8_3 @ +7`

The system should keep only the most plausible semantic decode for that raw window.

### Phase 3: Validator scoring

Apply metric-specific validators before promoting anything.

Examples:

- `level`
  - integer-like
  - bounded small range
  - stepwise, not noisy continuous drift
- `jungleMinionsKilled`
  - integer-like
  - monotonic
  - sparse increments
- `xp`
  - monotonic
  - broader range than `level`
- `health`
  - non-monotonic
  - bounded
  - reacts around death and fight windows
- `currentGold`
  - can rise and fall
- `totalGold`
  - mostly monotonic

This stage should heavily penalize one generic progression word matching many unrelated monotonic metrics.

### Phase 4: Participant assignment

Use only stronger cleaned-field matches to assign rows to participants.

A row should not be treated as participant-like unless it matches the same participant across multiple metrics with consistent support.

Good signals:

- same row repeatedly matches the same participant
- support spans several metrics
- support survives candidate deduplication
- row archetype is dynamic or mixed, not schema-heavy

### Phase 5: Provisional schema promotion

Promote a candidate field pattern only when it clears thresholds such as:

- support across multiple participants
- support across multiple rows in the same family band
- average correlation above threshold
- normalized RMSE below threshold
- metric-specific validator passed
- not outcompeted by a sibling decode of the same raw window

The output of this phase is the provisional schema registry.

### Phase 6: Automatic extraction

Given a provisional schema registry:

1. locate matching family rows in the replay
2. decode promoted fields only
3. assign them to participants using the current row assignment model
4. emit normalized time series

Conceptual output:

- `participantId`
- `timestamp`
- `level`
- `xp`
- `currentGold`
- `health`
- `cs`
- `jungleCs`

### Phase 7: Validation

Compare extracted time series against Riot timeline data and produce an extraction report.

The validation report should say:

- which fields extracted successfully
- which fields failed confidence thresholds
- which participant assignments were stable or unstable
- whether the replay version looks compatible with the current provisional schema

## Daily Workflow For Coding Sessions

This is the practical loop to use in day-to-day work.

### Session start

1. read `docs/decoder-status.md`
2. read this file
3. choose one discovery replay
4. choose one validation replay if and only if at least 2-4 fields already look believable

### During the session

1. improve automation, not manual inspection
2. generate artifacts for the replay
3. inspect ranked outputs only when the automation surfaces something surprising
4. update thresholds and validators when false positives dominate
5. keep notes in code or docs only when a rule becomes durable

### Session end

1. save generated artifact examples if they are useful
2. update `docs/decoder-status.md` with any changed decoder conclusions
3. keep the UI secondary unless it exposed a genuinely new insight

## Proposed Implementation Order

This is the recommended build order for the next few work items.

### 1. Batch artifact runner

Add a script under `scripts/` that:

- runs family scan
- picks top families
- runs entity/schema/cleaned analysis for each family
- writes JSON artifacts to disk

Suggested future file:

- `scripts/run_decoder_artifacts.ps1`

### 2. Artifact summarizer

Add a script or TypeScript module that:

- loads the generated artifacts
- deduplicates raw-window aliases
- runs validator scoring
- builds likely field maps
- writes a provisional schema JSON

Suggested future files:

- `scripts/build_provisional_schema.mjs`
- or a native/TS equivalent under `apps/web/src` if we want to share logic later

### 3. Extraction runner

Add a runner that:

- consumes provisional schema JSON
- decodes replay fields automatically
- writes normalized participant timelines

Suggested future outputs:

- `artifacts/<replay-id>/provisional-schema.json`
- `artifacts/<replay-id>/extracted-stats.json`
- `artifacts/<replay-id>/validation-report.json`

### 4. Only then improve the UI

Once the CLI/script loop is producing believable schemas and extracted fields, the UI should consume those results and visualize them.

## Stopping Rules

Do not promote a field just because it is the top-ranked match in one replay.

A field is not ready unless it is:

- deduplicated
- validator-clean
- participant-consistent
- not obviously explained by a generic progression word

Do not return to movement as the main focus until:

- participant rows are more stable
- at least a few scalar fields look real
- extraction output is usable enough to serve as an identity/time backbone

## What We Should Build Next

The next concrete task should be:

1. build a non-UI artifact runner
2. build provisional schema generation from those artifacts
3. extract participant stat timelines automatically

That is the shortest path from investigation tooling to an actual decoder.
