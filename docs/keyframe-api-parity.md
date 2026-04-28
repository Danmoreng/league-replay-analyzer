# Keyframe/API Parity Implementation Path

Updated: 2026-04-27

This document records the current implementation path for using `.rofl` keyframes as the supervised bridge toward API-equivalent replay state.

## Goal

Use keyframe records as minute-boundary state snapshots and compare their decoded candidate fields directly against Riot timeline `participantFrames`.

The immediate goal is not replay-only movement rendering. The immediate goal is to prove stable keyframe parity for participant state, then use that participant/slot identity to make movement extraction less ambiguous.

## Current Data Model

The container layer already supports record-kind-specific artifact generation:

- `chunk`: default half-minute delta stream used by existing artifact/corpus work
- `keyframe`: minute-boundary state stream
- `startup`: bootstrap stream
- `all`: mixed scan mode for broad inspection

Native cleaned/scalar samples now include explicit record identity:

- `segmentId`
- `segmentType`
- `chunkId`
- `recordIndex`
- `apiFrameIndex`
- `timestamp`

For keyframes, `apiFrameIndex = segmentId - 1`. This matches the existing corpus finding that replay keyframe `1` corresponds to API timeline frame `0`.

## Artifact Generation

Generate keyframe artifacts into a separate root so chunk artifacts are not overwritten:

```powershell
.\scripts\run_decoder_artifacts.ps1 `
  -ReplayPath .\replays\EUW1-7813463706.rofl `
  -ArtifactRoot .\artifacts-keyframes `
  -RecordType keyframe `
  -TopFamilies 12 `
  -TopEntitySlots 32 `
  -TopScalarSlots 24 `
  -DynamicSlotCount 12 `
  -MixedSlotCount 4 `
  -TopWindows 24 `
  -TopFields 24 `
  -SkipScalar `
  -Force
```

The important output files are:

- `artifacts-keyframes/<replay-id>/run-manifest.json`
- `artifacts-keyframes/<replay-id>/family-scan.json`
- `artifacts-keyframes/<replay-id>/families/<family-key>/cleaned.json`
- `artifacts-keyframes/<replay-id>/families/<family-key>/schema.json`

## Parity Discovery

Run the supervised parity harness:

```powershell
npm run discover:keyframe-parity -- --artifact-root .\artifacts-keyframes --replay-id EUW1-7813463706
```

The script writes:

- `artifacts-keyframes/<replay-id>/keyframe-api-parity.json`

The script compares cleaned keyframe fields against Riot API `participantFrames` by exact `apiFrameIndex`. It does not interpolate timestamps for keyframes.

Default metrics:

- `level`
- `xp`
- `totalGold`
- `currentGold`
- `minionsKilled`
- `jungleMinionsKilled`
- `health`
- `healthMax`
- `power`
- `powerMax`
- `movementSpeed`

Default strict gate:

- overlap at least `6` API frames
- correlation at least `0.70`
- normalized RMSE at most `0.65`
- monotonic metrics must not require a negative affine slope

These thresholds are discovery gates, not final promotion rules.

## Current Smoke Result

Using `EUW1-7813463706` with focused build artifacts under `build/keyframe-parity-artifacts`:

- `72` keyframe field candidates
- `7920` field/participant/metric comparisons
- `28` strict passing matches
- output: `build/keyframe-parity-artifacts/EUW1-7813463706/keyframe-api-parity.json`

This proves the end-to-end path works:

1. native keyframe artifact generation
2. keyframe sample identity emission
3. exact API-frame comparison
4. participant/slot evidence grouping

## First Corpus Result

On 2026-04-28, `scripts/run_keyframe_parity_corpus.ps1` was run across the local replay/API corpus with:

- `27` replay/API fixture pairs
- `-TopFamilies 8`
- `-TopEntitySlots 24`
- `-DynamicSlotCount 10`
- `-MixedSlotCount 3`
- `-TopWindows 16`
- `-TopFields 16`

Parity discovery produced:

- `5,300` keyframe field candidates
- `528,000` field/participant/metric comparisons
- `10,674` strict passing field/metric matches
- `1,093` participant-slot evidence groups

The conflict-aware schema builder then produced:

- `28` promoted metric candidates
- `1` promoted participant-slot candidate before identity weighting

Promoted metric evidence is currently concentrated in:

- `16.6 | 58339-0xE3-h3`
- `16.7 | 7710-0x1E-h14`

The strongest metric class is `movementSpeed`, followed by smaller `currentGold`, `health`, and `jungleMinionsKilled` evidence. This means the keyframe path has real frame-aligned signal, but participant-slot identity is still the bottleneck: most apparent participant-slot groups become ambiguous once same-replay participant conflicts are considered.

Practical interpretation:

- metric-level parity is viable enough to keep developing
- participant-slot promotion must remain conflict-aware
- single-field matches should not be treated as decoded schema
- the next useful schema work is reducing same-slot/multi-participant ambiguity, not loosening thresholds

## Weighted Slot Diagnostics

On 2026-04-28, the schema builder was updated to separate two concepts that were previously conflated:

- participant state slots: a family/slot contains API-like participant state, even if the participant assignment is still contested
- participant identity slots: a family/slot has enough unambiguous, weighted evidence to assign a participant in at least two replays

The participant evidence score now weights metrics by identity value:

- high value: `health`, `power`, `currentGold`, `movementSpeed`
- medium value: `minionsKilled`, `jungleMinionsKilled`
- lower value: `totalGold`, `xp`, `level`, `healthMax`, `powerMax`

This keeps generic monotonic stats from dominating identity promotion while still letting them support a broader state-slot finding.

With the existing `artifacts-keyframes` corpus, the regenerated schema produced:

- `28` promoted metric candidates
- `16` promoted participant state slots
- `8` promoted participant identity slots
- `83` conflicted participant slots

Version/family concentration:

- `16.6 | 58339-0xE3-h3`: `13` promoted participant state slots
- `16.7 | 7710-0x1E-h14`: `3` promoted participant state slots

Metric promotions remain concentrated in the same families:

- `16.6 | 58339-0xE3-h3`: `25` metric candidates, mostly `movementSpeed`
- `16.7 | 7710-0x1E-h14`: `3` metric candidates, `health` and `currentGold`

The diagnostic script writes the conflict report:

```powershell
npm run diagnose:keyframe-slot-conflicts -- --artifact-root .\artifacts-keyframes
```

Output:

- `artifacts-keyframes/keyframe-slot-conflicts.json`

Current interpretation:

- the keyframe stream has reliable state-like rows for the main `16.6` and `16.7` families
- identity assignment is improved but not solved
- `15` of the `16` state-promoted slots still have at least one ambiguous replay
- movement extraction should use state-slot promotion as a search prior, but should not yet trust slot identity without a replay-local assignment pass

## Interpretation Rules

Treat a single passing field as weak evidence. A usable participant row needs multiple independent metrics agreeing on the same:

- replay id
- version group
- family
- slot index
- participant id

The first promotion target should be multi-metric participant/slot evidence, not isolated `field -> metric` matches.

The final API frame is expected to be unpaired in pure keyframe mode because API `frameCount = keyframeCount + 1`. That final frame likely requires final chunk/delta handling later.

## Next Implementation Step

The keyframe corpus runner now automates the artifact, parity, and schema steps:

```powershell
.\scripts\run_keyframe_parity_corpus.ps1 -ArtifactRoot .\artifacts-keyframes -Force
```

It writes:

- `artifacts-keyframes/keyframe-corpus-manifest.json`
- `artifacts-keyframes/keyframe-api-parity.json`
- `artifacts-keyframes/keyframe-parity-schema.json`

The schema promotion stage reads `keyframe-api-parity.json` across the corpus and promotes only participant/slot groups with:

- at least two strong metrics in one replay
- stable family/slot behavior across replays in the same version group
- no stronger conflicting participant assignment for the same slot

After that, movement extraction should use promoted participant/slot identity as a prior and search only plausible rows for position-like fields.

The promotion script can also be run directly:

```powershell
npm run build:keyframe-parity-schema -- --artifact-root .\artifacts-keyframes
```
