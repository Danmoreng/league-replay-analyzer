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

## Replay-Local Slot Assignment

The next bridge script solves replay-local slot-to-participant assignment from the promoted state slots:

```powershell
npm run assign:keyframe-participant-slots -- --artifact-root .\artifacts-keyframes
```

Output:

- `artifacts-keyframes/keyframe-slot-assignments.json`

The assignment pass uses the promoted state slots from `keyframe-parity-schema.json`, then scores replay-local participant evidence with the same metric identity weights used by schema promotion. It solves a one-to-one assignment per replay and family, and marks assignments as `stable` only when the selected participant is the top local candidate with enough score gap over the runner-up.

Current corpus result:

- `20 / 27` replays analyzed
- `44` slot-to-participant assignments
- `23` stable assignments
- `16.6`: `37` assignments, `20` stable
- `16.7`: `7` assignments, `3` stable

The seven skipped replays are older or unsupported version groups that do not yet have promoted keyframe state slots.

This is still API-supervised tooling, not replay-only decoding. Its purpose is to produce a cleaner per-replay assignment target that movement extraction can use as a prior while we search for replay-native identity fields.

## Identity Order Findings

The current identity-order analysis is:

```powershell
npm run analyze:keyframe-identity-order -- --artifact-root .\artifacts-keyframes
```

Output:

- `artifacts-keyframes/keyframe-identity-order-analysis.json`

Current result from stable assignments:

- `23` stable assignment rows
- API `participantId` equals `.rofl` metadata roster order for `23 / 23` rows
- keyframe slot index does not sort like participant id, roster order, or lane-role order; aggregate ordered-pair rate is about `0.55`

Interpretation:

- the `.rofl` metadata roster is enough to name API participant ids: `participantId = rosterIndex + 1`
- the keyframe state slot index is not itself the participant order
- we still need either a replay-local stat/value assignment pass or a native keyframe/startup identity field to map state slots to roster rows

## Replay-Only Final-Stats Experiment

The first replay-only experiment tries to assign keyframe state slots to `.rofl` metadata roster rows using only promoted/ranked keyframe metric fields and final `statsJson` values:

```powershell
npm run assign:keyframe-rofl-stats -- --artifact-root .\artifacts-keyframes
```

Output:

- `artifacts-keyframes/keyframe-rofl-stat-slot-assignments.json`

Current result:

- `20 / 27` replays analyzed
- `0` assignments
- `0` usable edges

This negative result is useful. The promoted metric evidence is currently dominated by `movementSpeed`, `health`, `power`, and `currentGold`, while the `.rofl` final stats block mostly exposes final monotonic totals such as `level`, `xp`, total gold, and CS. The fields that align with final-only metrics are not yet stable enough in the schema artifacts to support replay-only slot assignment.

Next implication:

- do not expect final `statsJson` alone to identify keyframe rows yet
- the better path is to search startup/keyframe records for roster-order identifiers, champion ids, summoner ids, team ids, or stable per-player handles, then use the confirmed `participantId = rosterIndex + 1` rule to label decoded rows

## Startup Identifier Search

Startup inspection showed the startup segment is not u16-framed like normal chunk/keyframe subrecords. It is u32-framed:

- small leading startup record
- large startup record around `13k` bytes, first byte `0x8A` in the current 16.6 sample

The native family scanner now supports both u16 and u32 length-prefixed subrecords, which makes startup families visible to the artifact tooling.

The raw startup-token scanner is:

```powershell
npm run scan:startup-roster-tokens -- --artifact-root .\artifacts-keyframes --replay-root .\replays --api-root .\replays\api
```

Output:

- `artifacts-keyframes/startup-roster-token-scan.json`

Current result:

- `27` replay startup payloads scanned
- no plain ASCII champion names, Riot names, or PUUIDs found
- no repeated exact `summonerIdLow32` candidates found
- many low-cardinality numeric coincidences exist for `participantId`, `teamId`, and one-byte champion ids, but they are not row-specific enough to promote

Interpretation:

- startup payload access is now working
- obvious plain roster identifiers are not directly present in startup payload bytes
- next startup work should search for encoded/indirect handles rather than direct ids, especially repeated 32-bit tokens that correlate with roster order after grouping, not exact known ids

## End-of-Day Checkpoint: 2026-04-28

Committed progress today established three useful facts:

- keyframes contain minute-boundary participant-state-like rows, but keyframe slot index is not participant order
- `.rofl` metadata roster order maps to Riot API participant ids as `participantId = rosterIndex + 1` for all currently stable keyframe assignments
- startup payloads are accessible now, but obvious direct identifiers are not stored plainly in the decoded startup bytes

Current tooling:

- `npm run build:keyframe-parity-schema -- --artifact-root .\artifacts-keyframes`
- `npm run diagnose:keyframe-slot-conflicts -- --artifact-root .\artifacts-keyframes`
- `npm run assign:keyframe-participant-slots -- --artifact-root .\artifacts-keyframes`
- `npm run analyze:keyframe-identity-order -- --artifact-root .\artifacts-keyframes`
- `npm run assign:keyframe-rofl-stats -- --artifact-root .\artifacts-keyframes`
- `npm run scan:keyframe-identifiers -- --artifact-root .\artifacts-keyframes --api-root .\replays\api`
- `npm run scan:startup-roster-tokens -- --artifact-root .\artifacts-keyframes --replay-root .\replays --api-root .\replays\api`

Current corpus scorecard:

- promoted keyframe metric candidates: `28`
- promoted participant state slots: `16`
- promoted participant identity slots: `8`
- replay-local slot assignments: `44`
- stable replay-local slot assignments: `23`
- stable assignments where API participant id equals `.rofl` roster order: `23 / 23`
- direct replay-only final-stat assignments: `0`
- direct startup roster-token candidates suitable for promotion: `0`

Recommended next session:

1. Build an encoded-handle scanner over startup and keyframe payloads instead of exact known-id matching.
2. Search for 10-row/token groups whose cardinality and ordering match `.rofl` roster rows, even if token values do not equal champion/team/summoner ids.
3. Try linking those startup token groups to keyframe participant-state slots through repeated 32-bit tokens, bit slices, or row-neighbor structure.
4. Only after a candidate handle link exists, feed it into movement assignment as a replay-native identity prior.

## Corpus Checkpoint: 2026-05-06

After adding the current-patch replay/API fixtures, `scripts/run_keyframe_parity_corpus.ps1` was rerun across the local corpus:

- replay/API fixture pairs: `47`
- version groups: `15.22`, `15.23`, `15.24`, `16.1`, `16.5`, `16.6`, `16.7`, `16.9`
- promoted metric candidates: `84`
- promoted participant state slots: `69`
- promoted participant identity slots: `31`
- conflicted participant slots: `180`
- replay-local assignments: `197`
- stable replay-local assignments: `99`
- stable assignments where API `participantId` equals metadata roster order: `99 / 99`
- direct replay-only final-stat assignments: `0`

The new `16.9` corpus materially improves current-patch evidence. The strongest current-patch state signal is concentrated in:

- `16.9 | 24672-0x60-h0`

Promoted `16.9` metrics currently include:

- `movementSpeed`
- `currentGold`
- `health`
- `minionsKilled`

Additional replay-local assignment evidence also finds broader metric support for `power`, `level`, `xp`, `totalGold`, `healthMax`, `powerMax`, and jungle CS, but these remain API-supervised field/slot assignments rather than replay-native labels.

The keyframe state export prototype is:

```powershell
npm run export:keyframe-state
```

Output:

- `artifacts-keyframes/keyframe-state-prototype.json`

Stable-assignment export result on the 47-replay corpus:

- exported replays: `34 / 47`
- participant series: `99`
- metric series: `565`
- keyframe points: `4,522`

With unstable assignments included:

```powershell
npm run export:keyframe-state -- --include-unstable --output-path artifacts-keyframes\keyframe-state-prototype-all-assignments.json
```

Result:

- exported replays: `35 / 47`
- participant series: `197`
- metric series: `1,094`
- keyframe points: `8,574`

Interpretation:

- We can now export structured, participant-labeled keyframe state for stable assignments.
- This export is still supervised by API parity artifacts and local affine fits; it is not yet a final replay-only decoder.
- The next engineering step is moving the stable subset from this prototype into the native C++ core as a normalized `KeyframeStateTimeline` surface, while keeping the assignment confidence explicit.
- The remaining blocker for replay-only participant labeling is a native identity/handle link between startup/keyframe rows and metadata roster rows.

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
- `artifacts-keyframes/keyframe-slot-conflicts.json`
- `artifacts-keyframes/keyframe-slot-assignments.json`
- `artifacts-keyframes/keyframe-identity-order-analysis.json`
- `artifacts-keyframes/keyframe-rofl-stat-slot-assignments.json`

The schema promotion stage reads `keyframe-api-parity.json` across the corpus and promotes only participant/slot groups with:

- at least two strong metrics in one replay
- stable family/slot behavior across replays in the same version group
- no stronger conflicting participant assignment for the same slot

After that, movement extraction should use promoted participant/slot identity as a prior and search only plausible rows for position-like fields.

The promotion script can also be run directly:

```powershell
npm run build:keyframe-parity-schema -- --artifact-root .\artifacts-keyframes
```
