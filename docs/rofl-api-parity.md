# ROFL API Parity Status

Updated: 2026-05-08

## Goal

The long-term target is Riot match/timeline API parity from `.rofl` files without using Riot API data for runtime extraction.

The runtime extractor should eventually:

- read only the `.rofl` file and repo-local decoder schemas
- emit a Riot-like match payload
- emit a Riot-like timeline payload with `frames[].participantFrames`
- include all 10 participants
- provide explicit coverage for decoded and missing data
- reserve Riot API fixtures for offline validation only

## Current 16.9 Artifact

Current focused artifact:

- `artifacts-keyframes/EUW1-7840220945/rofl-api-metrics.json`
- replay: `replays/EUW1-7840220945.rofl`
- patch: `16.9.772.1032`

Generate it with:

```powershell
npm run export:rofl-api-metrics -- --replay-id EUW1-7840220945
```

Verify it with:

```powershell
npm run verify:rofl-api-metrics -- --replay-id EUW1-7840220945
```

Offline validation against the local Riot fixture:

```powershell
npm run validate:rofl-api-metrics:riot -- --replay-id EUW1-7840220945
```

Offline API shape-gap audit against the local Riot fixture:

```powershell
npm run audit:rofl-api-shape-gap -- --replay-id EUW1-7840220945
```

Offline challenge-field gap candidate audit:

```powershell
npm run audit:rofl-challenge-gaps -- --replay-id EUW1-7840220945
```

Offline timeline reconstruction model audit:

```powershell
npm run audit:timeline-reconstruction -- --replay-id EUW1-7840220945
```

Write the prompt-to-artifact goal audit:

```powershell
npm run audit:rofl-api-parity -- --replay-id EUW1-7840220945
```

Run the full export, runtime verification, and offline validation checkpoint:

```powershell
npm run verify:rofl-api-parity -- --replay-id EUW1-7840220945
```

Run the offline patch-corpus stability audit:

```powershell
npm run validate:rofl-api-parity-corpus -- --version-group 16.9 --allow-validation-mismatch
```

The full checkpoint regenerates `keyframe-rofl-stat-slot-assignments-16.9.json` and the offline supervised comparison before export, so identity blocker evidence cannot go stale.
The regenerated identity assignment artifact has schema `rofl-keyframe-stat-slot-assignments/v1`, which the checkpoint verifies before export.
The regenerated offline identity comparison artifact has schema `rofl-keyframe-stat-supervised-comparison/v1`, which the checkpoint verifies before export.
The full checkpoint also regenerates `keyframe-rofl-stat-support-threshold-sweep-16.9.json` before the goal audit.
The support-threshold sweep artifact has schema `rofl-keyframe-stat-support-threshold-sweep/v1`, which the checkpoint verifies.
The checkpoint also requires the default sweep row (`minSupportScore=0.35`) to have 0 assignments and requires every swept threshold to have 0 canonical candidates.
The sweep also includes an unsafe single-metric negative control; on the current 16.9 corpus it produces tempting assignments but offline comparison marks them mostly as conflicts, which is why one-metric identity links are not runtime-exported.

The full checkpoint also runs a negative completion gate: `audit:rofl-api-parity -- --require-complete` must fail until full API parity is actually achieved.

Current offline validation result:

- participant final match-stat comparisons: `1530 / 1530`
- team final match-stat comparisons: `18 / 18`
- final timeline scalar/damage-stat comparisons: `170 / 170`
- metadata comparisons: `7 / 7`
- identifier comparisons: `0 / 22` non-blocking, because ROFL `statsJson` participant identifiers are replay-local/anonymized or legacy IDs and do not currently equal Riot API PUUIDs or encrypted summoner IDs
- validation output: `artifacts-keyframes/EUW1-7840220945/rofl-api-metrics-riot-validation.json`
- validation schema: `rofl-api-metrics-riot-validation/v1`
- shape-gap output: `artifacts-keyframes/EUW1-7840220945/rofl-api-shape-gap-report.json`
- shape-gap schema: `rofl-api-shape-gap-report/v1`
- shape-gap result: `205 / 469` Riot API leaf paths matched, `264` missing
- challenge-gap output: `artifacts-keyframes/EUW1-7840220945/rofl-challenge-gap-candidates.json`
- challenge-gap schema: `rofl-challenge-gap-candidates/v1`
- challenge-gap result: `2` exact normalized candidates, `29` fuzzy candidates, `95` missing across `126` Riot challenge keys
- exact challenge value parity: `1` promoted validated exact candidate (`turretTakedowns`) and `1` exact-name candidate rejected by value mismatch (`killingSprees`)
- challenge corpus support: `20` patch `16.9` fixture-backed replays scanned; fuzzy `snowballsHit <- Missions_SnowballsHit` is kept rejected as all-zero-only evidence, while `turretTakedowns <- TURRET_TAKEDOWNS` has non-zero corpus support
- timeline reconstruction audit output: `artifacts-keyframes/EUW1-7840220945/timeline-reconstruction-model.json`
- timeline reconstruction audit schema: `rofl-timeline-reconstruction-model/v1`
- timeline reconstruction audit result on the focused replay: API frame count equals replay keyframes plus one, keyframe chunk IDs follow `2 * keyframeId + 1`, and chunk record IDs follow `recordId + 1`
- corpus validation output: `artifacts-keyframes/rofl-api-parity-corpus-validation-16.9.json`
- corpus validation schema: `rofl-api-parity-corpus-validation/v1`
- corpus validation result across `20` patch `16.9` fixture-backed replays: participant final match stats `30598 / 30600`, team final stats `335 / 360`, final timeline scalar/damage stats `3400 / 3400`, metadata `140 / 140`
- corpus validation timeline reconstruction block: `20 / 20` replays have API frames equal replay keyframes plus one, `20 / 20` pass the keyframe chunk formula, `20 / 20` pass the chunk record formula, `572 / 572` API intervals map to chunks, and the model is `keyframe-baseline-plus-chunk-deltas`
- corpus validation known unstable fields: participant `perks.styles`, `totalHeal`; team objective kill counts for champion, tower, dragon, baron, horde, and inhibitor
- `fieldCoverage.matchTeams.corpusValidation` marks team objective kill aggregates as `partially_stable`: they are ROFL-derived and validate on the focused replay, but corpus validation shows objective undercounts on some 16.9 replays
- timeline reconstruction corpus audit: `artifacts-keyframes/timeline-reconstruction-model-16.9.json` confirms `20 / 20` patch `16.9` fixture-backed replays have API frames equal replay keyframes plus one, keyframe chunk formula holds, and chunk record formula holds
- timeline reconstruction corpus audit also records `summary.topEventfulIntervals`, ranked by objectives, champion kills, item events, and total events; each target includes chunk IDs, record IDs, payload offsets, compressed lengths, uncompressed lengths, and codec, so use those chunk windows as the first reverse-engineering targets for chunk-delta event/state decoding
- goal audit output: `artifacts-keyframes/EUW1-7840220945/rofl-api-parity-goal-audit.json`
- goal audit schema: `rofl-api-parity-goal-audit/v1`
- mode: `offline-validation-only`

Current verified output:

- artifact schema: `rofl-api-parity-checkpoint/v1`
- extraction mode: `rofl-only-final-stats`
- 10 roster participants from ROFL summary metadata
- Riot-like `match.metadata`
- Riot-like `match.info.participants`
- Riot-like `match.info.teams` with final team aggregates
- Riot-like `timeline.metadata`
- Riot-like `timeline.info.frames`
- Riot-like `timeline.info.participants`
- ROFL filename-derived `match.info.gameId` and `timeline.info.gameId`
- ROFL filename-derived `match.metadata.matchId` and `timeline.metadata.matchId`
- ROFL filename-derived `match.info.platformId`
- ROFL statsJson-derived `match.metadata.participants` and `timeline.metadata.participants`
- explicit non-blocking identifier comparison showing those ROFL participant identifiers do not match Riot API PUUIDs or encrypted summoner IDs
- 114 API-like final stats fields per participant from embedded `statsJson`
- 152 per-participant final match-stat fields are covered by strict offline Riot validation, including direct pings, casts, damage, objective, jungle split, lane/role code transforms, nexus/building loss, placement, surrender, item, summoner spell, full perk style, stat perk, mission score, player behavior, challenge, and final combat stat mappings
- team objective kill counts now include champion, tower, inhibitor, dragon, baron, Atakhan, Horde/Voidgrubs, and Rift Herald where present in ROFL final `statsJson`
- 1 runtime timeline frame
- 1 final ROFL-only `statsJson` timeline frame with all 10 participants
- `totals.timelineParticipantCount: 10` based on emitted `frames[].participantFrames`
- 0 research keyframe metric series in the default runtime artifact
- 50 ROFL-only final timeline metric series
- 50 runtime timeline metric points
- explicit per-participant/per-metric coverage
- per-participant `metricStatusCounts` summarizing each coverage row
- `coverageStatusLegend` for `decoded`, `noisy`, `unstable_identity`, `duplicate_rejected`, and `not_found`
- decoded final-stat coverage can carry `nonFinalKeyframeCandidate` annotations when a non-final keyframe candidate for that same participant/metric was rejected as noisy or duplicate evidence
- `fieldCoverage` that states which API-shaped sections are ROFL-only decoded, validation-only, or still missing
- `fieldCoverage.matchParticipantChallenges` marks Riot `participants[].challenges.*` parity as partial, with only `challenges.turretTakedowns` decoded from ROFL `statsJson`
- `roflDerivedFieldMap` that maps decoded API-shaped match/timeline fields to ROFL sources and marks shape-only/missing fields explicitly
- `fieldCoverage.matchMetadataGaps` for Riot match metadata fields not present in the current ROFL summary, with inspected ROFL sources and decoded metadata keys recorded
- `fieldCoverage.matchParticipantGaps` for remaining participant fields that are not accepted as ROFL/API parity, including rejected/gap evidence for static champion IDs, event-derived first kill/tower flags, and missing account/profile fields
- `fieldCoverage.matchTeamGaps` for Riot team fields not present in the current ROFL summary, including bans and `objectives.*.first` event-order flags
- `fieldCoverage.matchTeamGaps.unstableDecodedFields` lists decoded team objective kill fields that still need event-level or alternate ROFL evidence before they can be treated as patch-wide stable parity
- `identityLinkage` that summarizes final roster linkage, Riot API identifier parity status, and non-final scalar identity blockers
- `identityLinkage.roflMetadataParticipantIdentifiers` marks ROFL `statsJson` participant identifiers as internal/shape-only, not verified Riot API PUUIDs or encrypted summoner IDs
- `parityChecklist` that maps the current goal requirements to artifact evidence and explicit gaps
- `parityChecklist` includes concrete evidence paths for the conservative replay-only identity gate and records the true Riot API PUUID gap
- `rofl-api-parity-goal-audit.json` maps the user objective to concrete artifact evidence and keeps completion status `not_complete` while full parity gaps remain
- `rofl-api-shape-gap-report.json` is an offline-only comparison against Riot match/timeline fixture shape; it quantifies missing API leaf paths without being a runtime extraction input
- `rofl-api-shape-gap-report.json` categorizes missing paths into actionable buckets such as match metadata, participant challenges, participant event flags, account/profile fields, static ID mapping, team bans, first-objective flags, timeline events, and timeline participant-frame gaps
- `rofl-challenge-gap-candidates.json` is an offline-only analysis of missing Riot `challenges.*` fields against ROFL `statsJson` keys; exact-name candidates are value-checked before promotion and fuzzy matches record patch-corpus/all-zero evidence
- the checkpoint runner verifies the generated goal audit schema marker and `not_complete` status
- the checkpoint runner verifies the generated ROFL API artifact schema marker and extraction mode before the deeper runtime verifier
- the checkpoint runner rebuilds replay-only scalar identity evidence before exporting the ROFL API-shaped artifact
- the checkpoint runner verifies the replay-only scalar identity assignment schema marker and version group
- the replay-only scalar identity assignment artifact includes `totals.rejectionSummary`, with primary blockers and per-metric reasons for why no non-final participant assignments are accepted
- the checkpoint runner verifies the offline identity comparison schema marker and version group
- the checkpoint runner regenerates the replay-only identity support-threshold sweep before the goal audit
- the checkpoint runner verifies the support-threshold sweep schema marker and version group
- the checkpoint runner verifies the support-threshold sweep has no canonical candidates and keeps the default threshold at 0 assignments
- the checkpoint runner verifies the unsafe single-metric identity negative control still produces offline conflicts instead of accepted runtime identity
- the goal audit reads `rofl-api-metrics-riot-validation.json` and records offline-only participant/team/metadata/identifier parity counts
- the goal audit verifies the Riot validation report schema marker
- `rejectedCandidateArtifacts.nonFinalScalarIdentity` that records why non-final keyframe scalar identity is not accepted
- non-final scalar identity diagnostics include the conservative replay-only metric set, acceptance thresholds, aggregate scoring diagnostics, rejection-reason counts, and the strongest replay candidates
- scalar identity diagnostics also break evidence down by metric: observed slot values, roster comparisons, positive scores, and accepted edge support
- replay-only scalar identity scoring deduplicates repeated offsets of the same metric before accepting support, so duplicate currentGold/CS candidates cannot masquerade as independent evidence
- replay-only scalar identity scoring requires each accepted support metric to pass a minimum per-metric quality score before it can form an edge
- replay-only scalar identity scoring rejects duplicated final-stat anchors from accepted support by default, and diagnostics still report those anchors so low-information evidence is visible rather than promoted as participant identity
- strongest rejected scalar identity assignments include support metrics, winner-gap data, runner-up details, and rejection reasons when any rejected assignments survive initial gates
- `rejectedCandidateArtifacts.positions` that records existing movement evidence and why it is not emitted as runtime API data
- `rejectedCandidateArtifacts.itemEvents` that records supervised item-event candidates and why they are not emitted as runtime API data
- `rejectedCandidateArtifacts.inventoryTimeline` that records why item/inventory state over time is not emitted
- `rejectedCandidateArtifacts.championStatsFinal` that records why final `participantFrames[].championStats` is only shape-compatible: current `statsJson` candidates are all-zero or unrelated counter collisions, not accepted API parity
- `rejectedCandidateArtifacts.damageTimeline` that records whether any extracted-stat damage candidates exist
- separate `matchCoverage` for ROFL-only final match data
- aggregate coverage summary in `totals.coverageSummary`
- verifier rejects Riot API fixture paths anywhere in the runtime artifact
- `source.inputClasses` classifies replay files, replay-derived summaries, decoder diagnostics, and Riot fixtures by runtime/validation role
- the goal audit independently scans the runtime artifact for `replays/api` path references
- `timeline.info.frames[*].events` is present as an array
- each emitted `participantFrames[id]` includes matching `participantId`
- each emitted `participantFrames[id]` includes API-shaped `championStats` and `damageStats` containers; final-frame cumulative `damageStats` are decoded from ROFL `statsJson`

Coverage statuses currently used:

- `decoded`
- `noisy`
- `unstable_identity`
- `duplicate_rejected`
- `not_found`

The verifier requires all five statuses to be defined in `coverageStatusLegend`, even when a specific default replay only produces a subset of those statuses.

The artifact also includes machine-readable `parityGaps` so consumers and tests do not confuse this checkpoint with complete API parity.

The verifier checks:

- the artifact points at an existing `.rofl` under `replays/`
- the artifact has `extractionMode: rofl-only-final-stats`
- the artifact points at an existing replay summary artifact outside `replays/api`
- the default runtime artifact has `source.decoderArtifactSupervised: false`
- the default runtime artifact has `source.researchInputPath: null`
- the default runtime artifact has zero research keyframe series or dropped research rows
- all 10 participants are present
- every participant has substantial ROFL `statsJson` data
- Riot-like `match.info.participants` is present
- Riot-like `timeline.info.frames` is present
- Riot-like `timeline.info.participants` is present
- `match.info.gameId` and `timeline.info.gameId` match the replay id
- `match.metadata.matchId` and `timeline.metadata.matchId` match the replay id
- `match.info.platformId` matches the replay id prefix
- match and timeline metadata participant identifier lists contain all 10 participants and match each other inside the ROFL-derived artifact
- timeline frames include `events`
- participant frame objects include matching `participantId`
- participant frame objects include `championStats` and decoded final-frame `damageStats`
- the final `statsJson` frame has all six decoded metrics for all 10 participants and matches per-metric coverage provenance
- decoded series have provenance
- coverage status counts match `totals.coverageSummary`
- each participant coverage row has `metricStatusCounts` matching its per-metric statuses
- `matchCoverage` marks all 10 participants decoded with substantial `statsJson` data
- the runtime artifact does not reference `replays/api`
- `source.inputClasses.riotApiFixtures` is `offline-validation-only` and not required for runtime
- `source.inputClasses.decoderSchemasAndDiagnostics` is not allowed for implicit runtime promotion
- remaining parity gaps are explicitly reported
- `fieldCoverage` proves the runtime input policy and separates ROFL-only fields from validation-only Riot fixtures and missing timeline fields
- Riot API PUUID comparison is reported as a non-blocking identifier gap, not as decoded metadata parity
- `fieldCoverage.matchMetadataGaps` lists non-stats match metadata that is still unavailable and records the inspected ROFL sources (`summary.json`, `metadataJson`, and embedded `statsJson`)
- `fieldCoverage.matchParticipantGaps` lists unpromoted participant fields and explains why candidate ROFL values are not exposed as API parity data
- `fieldCoverage.matchTeamGaps` separates decoded final objective kill counts from missing bans and first-objective event-order fields
- `parityChecklist` does not claim full API parity and lists known missing timeline/event/position/inventory/damage work
- `parityChecklist` requires true Riot API PUUID parity to remain a known full-parity gap
- `identityLinkage.riotApiIdentifierParity.status` remains `not_found` until true Riot PUUID parity is decoded from ROFL-only data
- API-shaped `metadata.participants` is populated from ROFL metadata identifiers for shape compatibility, with identifier semantics documented under `identityLinkage`
- the goal audit records which objective checks are satisfied, partial, or not satisfied
- the goal audit verifies the Riot comparison report is `offline-validation-only` and targets an unsupervised runtime artifact
- the goal audit verifies the Riot shape-gap report is also `offline-validation-only`, targets the unsupervised runtime artifact, and records remaining missing Riot API paths
- the full checkpoint verifies the audit's `--require-complete` mode still fails while full-parity gaps remain
- the goal audit checks API-shaped timeline frame structure, including `events` arrays, `championStats` containers, and decoded final-frame `damageStats` on participant frames
- the goal audit checks API-shaped match structure, including `match.metadata`, `match.info.participants`, `match.info.teams`, and decoded final-stat coverage
- the verifier checks `roflDerivedFieldMap` sources for core match/timeline fields, final participant frame metrics, shape-only containers, and missing timeline events
- the goal audit checks every participant coverage row has per-metric statuses, with 5 decoded final metrics, explicit `not_found` non-final metrics, and rejected non-final keyframe annotations where identity diagnostics found weak or duplicated evidence
- the goal audit checks rejected candidate evidence exists for positions, item events, inventory timeline, and damage timeline
- the goal audit records the 16.9 replay-only scalar identity corpus scorecard from `keyframe-rofl-stat-slot-assignments-16.9.json`
- non-final scalar identity evidence is either absent or explicitly rejected with assignment/comparison counts
- non-final scalar identity evidence includes the accepted metric set, thresholds, and diagnostic totals so decoder iterations can measure why candidates failed
- non-final scalar identity diagnostic totals include per-metric counts, so weak identity evidence can be traced to missing metric coverage versus weak participant separation
- replay-only scalar identity diagnostics include per-metric counts for support rejected by the `minSupportScore` quality gate
- replay-only scalar identity diagnostics include per-metric weak-support and accepted-support rates
- replay-only scalar identity diagnostics include top weak support examples by metric, with predicted value, final target, target duplicate count, slot, and candidate participant
- replay-only scalar identity diagnostics include duplicate final-target examples by metric, which explains common ambiguity such as multiple players ending on the same lane CS or zero jungle CS value
- `identityLinkage.nonFinalScalarIdentity.nextDecoderTargets` summarizes which metric families to investigate next for replay-only identity
- non-final scalar identity verification keeps duplicate metric evidence out of accepted support, requires per-support metric quality, and requires any surviving candidate to pass winner-gap separation before runtime export
- non-final scalar identity verification requires rejected assignment summaries to stay explicitly rejected and explain their support/rejection details
- position candidate evidence is either absent or explicitly rejected for runtime promotion with a concrete blocker
- item-event candidate evidence is either absent or explicitly rejected as supervised/offline-only
- inventory timeline evidence is either absent or explicitly rejected as non-runtime
- damage timeline candidate evidence is either absent or explicitly rejected as research-only

The Riot comparison script is intentionally separate from runtime export. It reads `replays/api` only to validate already-generated ROFL output.
It also refuses to validate artifacts that are not the default `rofl-only-final-stats` mode or that declare supervised/runtime Riot API inputs.

## What Is ROFL-Only Today

The following fields are extracted from the ROFL file only:

- roster participant count
- champion names
- team IDs
- team positions
- Riot ID game name/tagline when present in replay metadata
- game version
- game duration
- final `level`
- final `totalGold`
- final `xp`
- final `minionsKilled`
- final `jungleMinionsKilled`
- final API-shaped `frames[].participantFrames` values for all 10 participants for:
  - `level`
  - `currentGold` is not emitted as API parity: the available ROFL `GOLD_EARNED - GOLD_SPENT` candidate does not match Riot final timeline `participantFrames.currentGold`
  - `totalGold`
  - `xp`
  - `minionsKilled`
  - `jungleMinionsKilled`
- final KDA
- final item slots
- summoner spell IDs
- perk IDs/styles/stat shards
- final damage dealt/taken fields
- final healing/shielding/mitigation fields
- final vision score, wards placed, and wards killed
- final objective/turret/inhibitor stats
- final multikill stats
- final team win/objective/stat aggregates in `match.info.teams`

These final metrics come from the embedded replay `statsJson`, not Riot REST API files.

## What Is Not Yet ROFL-Only

The default runtime timeline only emits the final ROFL-only `statsJson` frame and does not load the supervised keyframe research artifact. Research keyframe metric values can be generated with `--include-research-keyframes`, but they still depend on the existing research artifacts for:

- participant identity assignment
- affine calibration of some fields
- quality summaries originally discovered with Riot API timeline parity

The exporter marks this in `source.decoderArtifactSupervised` and each decoded series has provenance:

- `values: rofl-keyframe-field`
- `participantIdentity: current-keyframe-assignment-artifact`
- `calibration: replay-local-affine-fit` or `stored-supervised-parity-fit`

This means the current default artifact is a useful ROFL-only API-shaped parity checkpoint for match/final timeline data, not complete timeline API parity.

## Missing For Full Parity

High-priority missing pieces:

- non-stats match metadata such as queue ID, map ID, game mode/type/name, and exact creation/start/end timestamps
- true Riot API PUUID/encrypted summoner ID identity parity; current ROFL `statsJson` participant identifiers are replay-local/anonymized or legacy IDs and only internally consistent
- replay-only participant identity for all 10 players
- replay-only calibration/schema for timeline scalar fields
- reliable timeline `level`, `xp`, `totalGold`, and CS metrics without noisy affine artifacts
- champion position extraction in Riot `position.x/y` form for patch `16.9`
- timeline events such as champion kills, item purchases, objectives, wards, and level-up events
- item/inventory state over time
- damage stat timelines
- a stable verification gate that separates runtime ROFL-only extraction from offline Riot API validation

Important direction: do not treat isolated keyframe rows as complete Riot API timeline frames. Current corpus notes show official Riot timeline frame count aligns with replay `keyframeCount + 1`, but the replay chunks between keyframes likely contain the state-update/event deltas needed to reconstruct the game state. Full timeline parity should therefore be pursued as state reconstruction:

1. use replay keyframes as periodic baseline snapshots
2. decode chunk/subrecord updates between keyframes as state deltas and events
3. apply those deltas onto the latest baseline state
4. sample the reconstructed state into Riot-shaped `timeline.info.frames`
5. validate against Riot API fixtures only offline

For `EUW1-7840220945`, the movement pipeline has a `participant-movement.json` diagnostic, but it is not emitted into `timeline.info.frames` because it assigns 9 of 10 participants, only 7 of 9 assignments pass offline Riot validation, and the current assignment path uses identity priors. The API-shaped artifact records this under `rejectedCandidateArtifacts.positions`.

The same replay now has an offline `item-event-candidates.json` diagnostic with 689 candidates and 93 strong candidates, but it is not emitted into `timeline.info.frames[*].events` because the report is discovered against Riot API timeline item events and is not yet a ROFL-only event decoder. The API-shaped artifact records this under `rejectedCandidateArtifacts.itemEvents`.

Inventory timeline parity is tracked separately under `rejectedCandidateArtifacts.inventoryTimeline`: final item slots are ROFL-only in `match.info.participants`, but item state over time is not reconstructed because there is no accepted ROFL-only item-event or slot-state timeline decoder yet.

Final `championStats` parity is tracked under `rejectedCandidateArtifacts.championStatsFinal`. The artifact keeps the API-shaped `championStats` container, but does not emit values because the current `statsJson` scan only finds all-zero collisions or unrelated counters, not decoded champion stat semantics.

For damage timelines, the same artifact records `rejectedCandidateArtifacts.damageTimeline`. On `EUW1-7840220945`, no damage timeline candidate metrics are present in `extracted-stats.json`, so damage remains `not_found` for runtime parity.

## Next Decoder Work

The next concrete step is to move timeline parity toward replay state reconstruction instead of direct keyframe-to-API-frame extraction:

1. Keep keyframes as baseline snapshots, not standalone API frames.
2. Decode chunk subrecord families that occur between keyframes and classify them as state deltas, events, entity updates, or noise.
3. Rebuild per-participant state by applying chunk deltas to the latest keyframe baseline.
4. Use `statsJson` final rows, roster order, team/champion metadata, and cross-metric consistency as identity constraints on reconstructed state.
5. Emit non-final `participantFrames` only when identity, calibration, and state-update evidence are replay-only and pass quality gates.
6. Keep Riot API timeline comparisons in a separate validation report, not in the runtime artifact.

The replay-only identity work remains a prerequisite for exposing participant-labelled state: use all 10 `statsJson` rows as final-state anchors, match candidate rows to participants by final values for monotonic metrics such as level, XP, total gold, lane CS, and jungle CS, and combine evidence across metrics before accepting a participant identity.

Current `16.9` replay-only scalar identity evidence is not strong enough to emit non-final timeline metrics: `keyframe-rofl-stat-slot-assignments-16.9.json` uses the conservative metric set and has 0 assignments across 20 replays and 0 canonical candidates after duplicate same-metric support is collapsed and weak per-metric support is filtered. The API-shaped artifact records this under `rejectedCandidateArtifacts.nonFinalScalarIdentity`, including the metric set, thresholds, aggregate diagnostics, per-metric evidence counts, rejection-reason counts, strongest replay-level candidates, and strongest rejected assignment details needed to decide the next decoder iteration.

A probe with `--metric-set all` considered volatile ROFL final anchors such as health, power, and movement speed. It increased slot metric observations from 52 to 228 but, after duplicate same-metric support is collapsed and weak per-metric support is filtered, still produced no accepted assignments and 0 canonical candidates, so the default path remains conservative.

Sensitivity probes for `--min-support-score` show why the default remains `0.35`: thresholds `0.30` and `0.25` still produce 0 assignments, while `0.20` admits one diagnostic assignment that matches the offline supervised comparison but fails winner-gap separation (`winnerGap=0.0008828456005518515`). That candidate is therefore useful as a research clue, not runtime API data.
Regenerate that scorecard with:

```powershell
npm run sweep:keyframe-rofl-support -- --version-group 16.9
```

The goal audit records the sweep rows from `keyframe-rofl-stat-support-threshold-sweep-16.9.json`.
