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

For current-patch-only inspection:

```powershell
npm run export:keyframe-state -- --version-group 16.9
npm run export:keyframe-state -- --version-group 16.9 --include-unstable --output-path artifacts-keyframes\keyframe-state-prototype-16.9-all-assignments.json
```

Outputs:

- `artifacts-keyframes/keyframe-state-prototype-16.9.json`
- `artifacts-keyframes/keyframe-state-prototype-16.9-all-assignments.json`

Coverage audit:

```powershell
npm run summarize:keyframe-export-coverage -- --version-group 16.9
npm run summarize:latest-keyframe-state -- --version-group 16.9
npm run summarize:keyframe-export-quality -- --version-group 16.9
npm run summarize:keyframe-export-quality -- --version-group 16.9 --input-path artifacts-keyframes\keyframe-state-prototype-16.9-all-assignments.json --output-path artifacts-keyframes\keyframe-state-quality-16.9-all-assignments.json
npm run scan:keyframe-state-band -- --version-group 16.9
npm run scan:keyframe-state-band -- --version-group 16.9 --replay-id EUW1-7843548046 --min-active-samples 3 --output-path artifacts-keyframes\keyframe-state-band-scan-16.9-EUW1-7843548046-min3.json
npm run analyze:keyframe-identity-order -- --version-group 16.9 --output-path artifacts-keyframes\keyframe-identity-order-analysis-16.9-stable.json
npm run analyze:keyframe-identity-order -- --version-group 16.9 --all-assignments --output-path artifacts-keyframes\keyframe-identity-order-analysis-16.9-all.json
npm run assign:keyframe-rofl-stats -- --version-group 16.9 --output-path artifacts-keyframes\keyframe-rofl-stat-slot-assignments-16.9.json
npm run compare:keyframe-rofl-stats -- --version-group 16.9
npm run validate:keyframe-rofl-stats -- --version-group 16.9
npm run summarize:keyframe-blockers -- --version-group 16.9
npm run verify:keyframe-state -- --version-group 16.9
```

Outputs:

- `artifacts-keyframes/keyframe-export-coverage-16.9.json`
- `artifacts-keyframes/latest-keyframe-state-summary-16.9.json`
- `artifacts-keyframes/keyframe-state-quality-16.9.json`
- `artifacts-keyframes/keyframe-state-quality-16.9-all-assignments.json`
- `artifacts-keyframes/keyframe-state-band-scan-16.9.json`
- `artifacts-keyframes/keyframe-state-band-scan-16.9-EUW1-7843548046-min3.json`
- `artifacts-keyframes/keyframe-identity-order-analysis-16.9-stable.json`
- `artifacts-keyframes/keyframe-identity-order-analysis-16.9-all.json`
- `artifacts-keyframes/keyframe-rofl-stat-slot-assignments-16.9.json`
- `artifacts-keyframes/keyframe-rofl-stat-supervised-comparison-16.9.json`
- `artifacts-keyframes/keyframe-state-rofl-stat-validation-16.9.json`
- `artifacts-keyframes/keyframe-blockers-16.9.json`

The verifier checks that the current-patch stable/all-assignment exports, coverage audit,
latest summary, metric-series counts, fit-quality summaries, state-band scan, blocker
summary, and `h0` to `h16` structural correction agree.

Current `16.9` coverage result:

- stable export: `71 / 71` stable assigned rows exported across `18 / 20` replays
- all-assignment export: `161 / 161` assigned rows exported across `18 / 20` replays
- quality summaries: `0` fit-gate violations in both stable and all-assignment exports
- corrected h16 assignments: `90`
- replay-local exported rows: `35` stable, `84` all-assignment
- candidate state slots: `687`
- identity edges: `887`, with `814` surviving the assignment gate
- replay-local fallback state slots are included when a slot has strong participant evidence but is not yet corpus-promoted
- remaining blocker split: `2` replays have candidate state slots but no identity edges
- no assignment at all: `EUW1-7837700332`, `EUW1-7843548046`
- blocker report baseline: `0` blocked replays have canonical parity candidates, `1` has artifact-bundle cleaned fields, `1` has canonical targeted state-band raw/cleaned fields, `1` has diagnostic-only low-sample targeted state-band fields, and `1` has a five-point diagnostic-only short-series path
- replay-only slot-order check: participant IDs match replay summary roster order for supervised rows (`71 / 71` stable, `161 / 161` all-assignment), but slot order is not predictive (`0.514` stable and `0.507` all-assignment aggregate slot/participant order rate)
- replay-only final `statsJson` check: `20 / 20` current-patch replays analyzed after fixing the cleaned-field lookup. Diagnostics now show `600` candidate slots, `40` slots with readable metric values, `52` slot metric values, `230` compared metric values, `8` final-stat edges, and `2` assignments. Both assignments are `diagnostic-only`: `0` are canonical candidates, `1` is rejected for duplicate-metric support, and `1` is rejected for a near-zero winner gap. Supervised comparison reports `1` stable-row match, `0` stable-row conflicts, and `1` unstable-row conflict, so final stats alone remain diagnostic and are not a safe canonical slot identity source.
- offline final-`statsJson` validation for already-assigned stable rows: `148` comparable metric series, `129` passing the `0.35` relative-error gate, and `19` failures when comparing the last exported keyframe value to the final metadata value. Timing matters: within the final two-minute window, `63 / 64` comparisons pass; outside that window, monotonic totals (`xp`, gold, CS, jungle CS, level) can drift before the final stats block. This is a conservative end-state sanity check, not a replay-only timeline validation.

Remaining no-assignment details:

- `EUW1-7837700332`: `24672-0x60-h0` has cleaned fields, and targeted state-band scan over slots `84-96` finds `288` raw and `288` cleaned fields, but the strongest fields cover only `5` distinct API frame indices (`2`, `11`, `12`, `15`, `27`), below the metric-level `minOverlap = 6` gate
- `EUW1-7843548046`: `24672-0x60-h0` is detected as a family with only `3` active records; the canonical native row-offset analyzer requires at least `4` active samples before emitting a field, so all `12` targeted state-band slots (`84-96`) are suppressed and parity discovery has no usable field series to score. A diagnostic-only scan with `--min-active-samples 3` exposes `288` raw and `288` cleaned fields, but those fields are not promoted into the canonical export.

Short-series diagnostic for `EUW1-7837700332`:

```powershell
node .\scripts\discover_keyframe_api_parity.mjs --replay-id EUW1-7837700332 --min-overlap 5 --metric-min-overlap-cap 5 --output-path tmp\keyframe-parity-EUW1-7837700332-short5.json
node .\scripts\assign_keyframe_participant_slots.mjs --parity-report tmp\keyframe-parity-EUW1-7837700332-short5.json --output-path tmp\keyframe-slot-assignments-EUW1-7837700332-short5.json
node .\scripts\export_keyframe_state_prototype.mjs --replay-id EUW1-7837700332 --assignments-path tmp\keyframe-slot-assignments-EUW1-7837700332-short5.json --parity-report tmp\keyframe-parity-EUW1-7837700332-short5.json --output-path tmp\keyframe-state-EUW1-7837700332-short5.json
```

Result:

- parity discovery: `3547` passing matches, `50` participant-slot evidence groups
- assignment: `8` assigned rows, `2` stable rows
- stable export: `2` participant series, `22` metric series, `110` points
- interpretation: useful diagnostic evidence, but not canonical yet because 5-point fits can produce large absolute errors on high-range metrics like `xp` and `totalGold`

Low-sample diagnostic for `EUW1-7843548046`:

```powershell
npm run scan:keyframe-state-band -- --version-group 16.9 --replay-id EUW1-7843548046 --min-active-samples 3 --output-path artifacts-keyframes\keyframe-state-band-scan-16.9-EUW1-7843548046-min3.json
.\build\packages\rofl-core\rofl_core_cli.exe --analyze-clean-row-offsets-json .\replays\EUW1-7843548046.rofl --length 24672 --first-byte 0x60 --header-size 0 --stride 16 --slots 84,85,86,87,88,89,90,91,93,94,95,96 --top-fields 24 --min-active-samples 3 --record-type keyframe > tmp\keyframe-cleaned-EUW1-7843548046-min3.json
node .\scripts\discover_keyframe_api_parity.mjs --replay-id EUW1-7843548046 --min-overlap 3 --metric-min-overlap-cap 3 --cleaned-override tmp\keyframe-cleaned-EUW1-7843548046-min3.json --cleaned-override-replay-id EUW1-7843548046 --cleaned-override-family-key 24672-0x60-h0 --output-path tmp\keyframe-parity-EUW1-7843548046-min3.json
node .\scripts\assign_keyframe_participant_slots.mjs --parity-report tmp\keyframe-parity-EUW1-7843548046-min3.json --output-path tmp\keyframe-slot-assignments-EUW1-7843548046-min3.json
node .\scripts\export_keyframe_state_prototype.mjs --replay-id EUW1-7843548046 --assignments-path tmp\keyframe-slot-assignments-EUW1-7843548046-min3.json --parity-report tmp\keyframe-parity-EUW1-7843548046-min3.json --cleaned-override tmp\keyframe-cleaned-EUW1-7843548046-min3.json --cleaned-override-replay-id EUW1-7843548046 --cleaned-override-family-key 24672-0x60-h0 --include-unstable --output-path tmp\keyframe-state-EUW1-7843548046-min3-all.json
npm run summarize:keyframe-export-quality -- --version-group 16.9 --input-path tmp\keyframe-state-EUW1-7843548046-min3-all.json --output-path tmp\keyframe-state-quality-EUW1-7843548046-min3-all.json
```

Result:

- diagnostic parity: `288` candidates, `12889` passing matches, `50` evidence groups
- assignment: `9` assigned rows, `0` stable rows
- assignment ambiguity: only `2 / 9` assigned rows are rank-1, `7 / 9` have non-positive winner gaps, max winner gap is `0.0975`, and median winner gap is `-0.8345` versus the canonical stable threshold of `0.35`
- all-assignment diagnostic export: `9` participant series, `92` metric series, `276` points
- quality summary: `92 / 92` metric series violate canonical quality gates, primarily because the diagnostic has only three points
- interpretation: state-band values are extractable from the replay, but this is not a canonical export path

Stable-assignment export result on the 47-replay corpus after replay-local fallback assignment:

- exported replays: `38 / 47`
- participant series: `147`
- metric series: `887`
- keyframe points: `6,826`

With unstable assignments included:

```powershell
npm run export:keyframe-state -- --include-unstable --output-path artifacts-keyframes\keyframe-state-prototype-all-assignments.json
```

All-assignment export result after replay-local fallback assignment:

- exported replays: `38 / 47`
- participant series: `322`
- metric series: `1,971`
- keyframe points: `14,625`

Interpretation:

- We can now export structured, participant-labeled keyframe state for stable assignments.
- This export is still supervised by API parity artifacts and local affine fits; it is not yet a final replay-only decoder.
- The next engineering step is moving the stable subset from this prototype into the native C++ core as a normalized `KeyframeStateTimeline` surface, while keeping the assignment confidence explicit.
- The remaining blocker for replay-only participant labeling is a native identity/handle link between startup/keyframe rows and metadata roster rows.

Startup roster token scan note:

- `artifacts-keyframes/startup-roster-token-scan.json` does find current-patch `16.9` roster-order-like numeric tokens in all `20` replays, especially at tiny offsets such as `1` and `2`
- those offsets are too generic to treat as participant-owner handles; they currently prove startup records contain roster-order signals, not that a startup token links to corrected h16 keyframe state rows
- replay-only identity still needs a cross-record link from startup/metadata identity to keyframe state rows, not just a roster-order token hit

## Handle-Graph Checkpoint: 2026-05-06

Follow-up handle-graph work confirmed a structural correction for the main `16.9` state family:

- previous exploration key: `16.9 | 24672-0x60-h0`
- corrected structural hypothesis: `16.9 | 24672-0x60-h16`
- evidence: the first 16 bytes are `0x60` padding/header bytes in all 20 current-patch replays
- `u16le@0 == 24672` in `20 / 20` current-patch replays
- effective row count is therefore `1541`, not `1542`

The existing promoted h0 slot numbers still point at the same byte offsets if converted by:

```text
h16SlotIndex = h0SlotIndex - 1
```

The native C++ candidate export now reports the corrected `24672-0x60-h16` family and shifted row indices. Existing JS artifacts generated with `h0` should be treated as discovery artifacts until regenerated with the corrected header hypothesis.

`scripts/export_keyframe_state_prototype.mjs` now applies that correction at export time for `16.9` state rows. It still reads the existing `24672-0x60-h0` discovery artifacts, but exported participant series use:

- `familyKey: "24672-0x60-h16"`
- `slotIndex: sourceSlotIndex - 1`
- `sourceFamilyKey` and `sourceSlotIndex` for artifact traceability
- `structuralCorrection: "h0-discovery-to-h16-structural-family"`

Current verification on the local artifact set:

- stable export: `18 / 20` `16.9` replays, `71` participant series, `446` metric series
- all-assignment export: `18 / 20` `16.9` replays, `161` participant series, `1072` metric series

The native handle-graph scanner is:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --scan-keyframe-handle-graph-json .\replays\EUW1-7842589492.rofl --top-families 32 --max-records 0
```

The corpus wrapper is:

```powershell
npm run scan:keyframe-handle-graph-corpus -- --version-group 16.9 --top-families 32 --max-records 0
```

Output:

- `artifacts-keyframes/keyframe-handle-graph-corpus.json`

Initial corpus result:

- scanned replays: `20`
- `24672-0x60-h16` present in all `20`
- `u16le@0 == length` in all `20`
- broad u16 row-reference-looking patterns exist across all lanes, but are currently too noisy to treat as owner handles

Focused h16 scan added:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --scan-keyframe-handle-graph-json .\replays\EUW1-7842589492.rofl --top-families 32 --max-records 0 --focus-family 24672-0x60-h16 --focus-slots 79,82,83,84,85,86,87,88,90,91,93,94,95,96,97,99,100,479,488,491,494 --focus-neighbor-radius 2
```

The corpus wrapper now uses the same focus defaults for `16.9`.

Focused corpus result:

- scanned replays: `20`
- focus family: `24672-0x60-h16`
- focus source rows: `21`
- expanded source rows with radius `2`: `42`
- strongest recurring signals are still u16-width values from h16 state rows
- repeated values such as `0xF1`, `0x700`, `0x400`, and `0x300` appear across offsets and target families
- these values are stable enough to investigate as replay-native tokens, but not strong enough to assign participant owners directly

Supervised assignment comparison:

- the focused corpus report maps existing `24672-0x60-h0` supervised assignments to `24672-0x60-h16` by subtracting one row
- mapped supervised h16 assignments currently cover `12` of the `20` patch `16.9` replays
- recurring focused patterns do intersect assigned source rows, but the same offsets also touch many neighboring/unassigned rows
- this argues against treating a single u16 lane as the participant owner link
- owner inference should require per-row agreement across multiple metrics and stable replay-local assignment evidence

Candidate scoring:

```powershell
npm run score:keyframe-handle-graph -- --artifact-root artifacts-keyframes --top-candidates 50
```

Output:

- `artifacts-keyframes/keyframe-handle-graph-candidate-scores.json`

Refreshed score result after replay-local fallback assignment:

- scored patterns: `260`
- strong candidates: `0`
- investigate candidates: `0`
- weak candidates: `260`
- top score: `0.3330`
- supervised h16 assignment summary in the focused handle graph currently maps `13` replays and `45` source slots

Interpretation:

- narrow 4-byte candidates can be source/target-specific, but currently have only one assigned replay hit
- high-coverage u16 candidates hit many assigned rows, but also many neighboring rows and target rows
- this is useful negative evidence: the current focused handle graph does not yet expose a direct participant-owner pointer
- next useful scoring input is per-record value stability for each assigned row, not just aggregate row/target coverage

Next implication:

- filter handle-graph work around known promoted state slots and neighbor rows instead of ranking every row in every family
- search for replay-native owner links near corrected h16 state rows
- do not promote generic u16 row-index-looking lanes without stronger owner/identity evidence
- next decoder step should score focused row-reference candidates by entropy, temporal stability, and agreement with promoted API participant assignments, instead of sorting mainly by total count

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
