# Session Wrap-up: 2026-04-08

This document records all decoder-related engineering work completed in this session, including movement-calibration experiments, static-metric diagnostics, and item-event discovery tooling.

## Scope

Work completed in this session:

- Movement alignment diagnostics and calibration pipeline for patch `16.7`
- API static-state extraction for side-panel style metrics and item events
- Replay-vs-API static-metric diagnostics for `currentGold`, `health`, and `power`
- Replay field-change to API item-event candidate discovery
- Script wiring in `package.json`

## Files Added

- `scripts/build_movement_16_7_model.mjs`
- `scripts/diagnose_movement_alignment.mjs`
- `scripts/extract_calibrated_movement.mjs`
- `scripts/extract_api_static_state.mjs`
- `scripts/diagnose_static_metric_alignment.mjs`
- `scripts/discover_item_event_candidates.mjs`

## Files Modified

- `package.json`
- `scripts/assign_replay_movement.mjs`

## package.json Script Additions

Added npm script aliases:

- `build:movement-16.7-model`
- `diagnose:movement-alignment`
- `extract:calibrated-movement`
- `extract:api-static-state`
- `diagnose:static-metrics`
- `discover:item-events`

## Movement Calibration Work

### New tooling

- `scripts/diagnose_movement_alignment.mjs`
  - Brute-force alignment between replay movement candidates and Riot API position series
  - Searches time shift and geometric variants
  - Fits affine transforms per axis and scores candidates
  - Writes per-replay diagnosis: `movement-alignment-diagnosis.json`

- `scripts/build_movement_16_7_model.mjs`
  - Aggregates all `16.7` diagnosis files
  - Produces family policies (`trusted`, `strict`, `rejected`, `insufficient`)
  - Writes `artifacts/movement-16.7-model.json`

- `scripts/extract_calibrated_movement.mjs`
  - Applies diagnosis best matches and model gates to build `calibrated-movement.json`
  - Supports hybrid and preserve-original modes:
    - `--retain-unaccepted`
    - `--preserve-original-trajectory`

### Model output (16.7 corpus)

`artifacts/movement-16.7-model.json`:

- `8` families evaluated
- `5` families included
- `3` families rejected/insufficient

Included families:

- `61743-0x00-h15` (`trusted`, allow `moderate+strong`)
- `15668-0xF1-h4` (`trusted`, allow `moderate+strong`)
- `11822-0x2E-h14` (`trusted`, allow `moderate+strong`)
- `13312-0x3D-h0` (`strict`, strong-only)
- `12084-0xF1-h4` (`strict`, strong-only)

### Assignment/validation comparisons on 16.7

Baseline (`extracted-movement.json`):

- `47/60` passing
- pass rate `0.7833`

Calibrated strict:

- `17/24` passing
- pass rate `0.7083`

Calibrated hybrid replace:

- `37/55` passing
- pass rate `0.6727`

Calibrated hybrid preserve-original:

- `39/59` passing
- pass rate `0.6610`

Result: movement calibration harness is implemented and functional, but these integration modes did not beat current baseline assignment pass-rate.

## API Static-State Extraction Work

### New tooling

- `scripts/extract_api_static_state.mjs`
  - Reads `match.json` and `timeline.json`
  - Emits per-participant static timeline:
    - `level`, `currentGold`, `totalGold`, `xp`
    - `minionsKilled`, `jungleMinionsKilled`
    - `health`, `healthMax`, `power`, `powerMax`
    - `movementSpeed`, `position`
  - Extracts item events:
    - `ITEM_PURCHASED`, `ITEM_SOLD`, `ITEM_DESTROYED`, `ITEM_UNDO`
  - Reconstructs inventory timeline and final inventory
  - Writes `replays/api/<MATCH_ID>/api-static-state.json`

### 16.7 extraction run

- Replays processed: `9`
- Total item events: `3769`
- Average item events per replay: `418.78`

## Static Metric Diagnostic (Replay-vs-API)

### New tooling

- `scripts/diagnose_static_metric_alignment.mjs`
  - Reads `candidate-matches.json`
  - Focus metrics: `currentGold`, `health`, `power`
  - Builds:
    - field-metric leaders
    - family-metric rollups
    - per-family recommendation status
  - Writes `static-metric-alignment-diagnosis.json`

### 16.7 aggregate summary

- Replays processed: `9`
- Avg family rollup count: `4.56`
- Avg field leaders per replay: `86.33`
- Total prioritize families across corpus: `1`
- Avg top effective score: `0.4139`

Interpretation: replay scalar alignment for the targeted static metrics is still mostly exploratory and not yet stable across the full latest-patch cohort.

## Item Event Candidate Discovery

### New tooling

- `scripts/discover_item_event_candidates.mjs`
  - Scans cleaned replay fields for timestamped value changes
  - Aligns change timestamps to API `ITEM_*` timelines using time-shift search
  - Scores candidates using:
    - global item-event alignment
    - participant-specific alignment
    - event-type alignment
    - recall/coverage/shift penalties
  - Outputs:
    - family summaries
    - ranked top candidates
  - Writes `item-event-candidates.json`

### Scoring refinement applied in-session

Initial scoring overfit sparse candidates with large shifts. The script was tightened to:

- increase recall weight
- apply coverage weighting
- penalize large absolute time shifts
- raise strong-candidate acceptance thresholds

### 16.7 aggregate summary

- Replays processed: `9`
- Avg candidates per replay: `707.78`
- Total strong candidates: `845`
- Avg strong candidates per replay: `93.89`
- Total prioritize families: `11`
- Avg best candidate score: `0.1501`
- Avg best participant recall: `0.1117`
- Avg best global recall: `0.0265`

Interpretation: this is now a useful ranked-discovery tool for likely item-event-bearing replay fields, but not yet a solved item-event decoder.

## Notes on Generated Outputs

During the session, per-replay outputs were generated under `artifacts/<replay-id>/` and `replays/api/<match>/`. These are runtime artifacts used for analysis and are not intended to be canonical source files.

## Recommended Next Work

1. Use `static-metric-alignment-diagnosis.json` to prioritize family/slot windows for targeted `health/power/currentGold` decoder promotion in `extract_replay_stats`.
2. Promote highest-confidence `item-event-candidates` windows into a dedicated replay-side item-event decoder pass.
3. Build a replay-vs-API item-event validator report (precision/recall by event type and participant) before integrating into UI-facing outputs.
