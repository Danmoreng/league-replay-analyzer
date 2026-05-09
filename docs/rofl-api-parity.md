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

Summarize subrecord families for the ranked reconstruction chunk targets:

```powershell
npm run summarize:reconstruction-chunks -- --top-intervals 3
```

Verify the saved reconstruction chunk target summary without rerunning native extraction:

```powershell
npm run verify:reconstruction-chunks
```

Compare the ranked eventful reconstruction chunks against quiet chunk windows to prioritize decoder families:

```powershell
npm run compare:reconstruction-chunks -- --top-eventful-intervals 3 --quiet-intervals 3
```

Verify the saved eventful-vs-quiet chunk-family comparison:

```powershell
npm run verify:reconstruction-chunk-comparison
```

Export full payload samples for the top enriched decoder families:

```powershell
npm run export:reconstruction-family-samples -- --top-families 6 --max-records-per-replay 4
```

Verify the saved decoder family payload samples:

```powershell
npm run verify:reconstruction-family-samples
```

Analyze byte-pattern summaries for the saved decoder family payload samples:

```powershell
npm run analyze:reconstruction-family-samples
```

Verify the saved decoder family sample analysis:

```powershell
npm run verify:reconstruction-family-sample-analysis
```

Rank decoder targets from the verified sample analysis:

```powershell
npm run rank:reconstruction-decoder-targets
```

Verify the saved decoder target ranking:

```powershell
npm run verify:reconstruction-decoder-targets
```

Build and verify the focused dossier for the current top decoder target:

```powershell
npm run build:reconstruction-target-dossier -- --family-key 241-0x02
npm run verify:reconstruction-target-dossier -- --family-key 241-0x02
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
The full checkpoint also regenerates the reconstruction chunk summary, chunk-family comparison, family samples, sample analysis, target ranking, 241 target dossiers, target neighborhoods, table analyses, row identity gates, and family/event correlation before exporting the API-shaped runtime artifact, then verifies all of them. The chunk and event-correlation steps shell out to the native `rofl_core_cli.exe` to dump chunk subrecords, so on this Windows machine it should be run outside the sandbox if a sandboxed invocation fails with `EPERM`.
The full checkpoint also regenerates `artifacts/EUW1-7840220945/participant-movement.json` and `artifacts/EUW1-7840220945/assigned-movement-validation-report.json` before export, then asserts the focused movement blocker is still present: 9/10 participant assignments, Malphite TOP unmatched, top rejected entity candidates for the unmatched participant, two unassigned entity tracks with rejected participant candidates, and 7/9 offline movement-quality passes.
The full checkpoint also regenerates the no-priors movement diagnostic before export:

```powershell
npm run assign:movement -- --artifact-dir artifacts/EUW1-7840220945 --priors-path artifacts/EUW1-7840220945/no-priors.json --output-path artifacts/EUW1-7840220945/participant-movement-no-priors.json
npm run validate:assigned-movement -- --participant-movement-path artifacts/EUW1-7840220945/participant-movement-no-priors.json --output-path artifacts/EUW1-7840220945/assigned-movement-no-priors-validation-report.json
```

The checkpoint asserts that this replay-only no-priors diagnostic disables identity priors, assigns 8/10 participants, leaves Vayne TOP and Malphite TOP unmatched with rejected entity candidates, and has 7/8 offline movement-quality passes.

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
- shape-gap result: `399 / 469` Riot API leaf paths matched, `70` missing
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
- reconstruction chunk target summary: `artifacts-keyframes/reconstruction-chunk-target-summary-16.9.json` records subrecord-family counts for the top eventful chunk windows using `rofl_core_cli --dump-chunk-subrecords`; `aggregateTopFamilies` ranks recurring families across target chunks, and this remains a decoder-target artifact, not runtime extraction
- reconstruction chunk family comparison: `artifacts-keyframes/reconstruction-chunk-family-comparison-16.9.json` compares eventful chunk windows against quiet windows and ranks enriched subrecord families; this is offline decoder guidance for chunk-delta reconstruction, not runtime extraction
- current event-enriched decoder queue from that comparison starts with `241-0x02`, `241-0x04`, `512-0x00`, `2-0xC7`, `49607-0xF1`, and `61724-0x00`; initial native profiles show dense/high-variance payloads and repeated token patterns, so none of these should be exposed as runtime API metrics until a chunk-delta state or event schema is decoded and validated
- reconstruction family samples: `artifacts-keyframes/reconstruction-family-samples-16.9.json` stores full chunk payload hex samples for those enriched families across the eventful replay windows; this is an offline reverse-engineering artifact and must not be treated as decoded API parity
- reconstruction family sample analysis: `artifacts-keyframes/reconstruction-family-sample-analysis-16.9.json` summarizes common prefixes, byte frequencies, aligned 16/32-bit token frequencies, and recurring 4/6/8-byte sequences for the sampled enriched families; this is decoder guidance only, not extracted API data
- recurring sequence clues from the current sample analysis include `C7 19 F1 00 02 00 C7 C1` / `00 C7 19 F1 00 02 00 C7` in `241-0x02`, `00 04 01 36 A3 4C C9 F1` in `241-0x04`, and long `65 65 65 65 ...` runs in the large families; these are candidate grammar tokens to investigate, not decoded events or state fields
- sequence offset evidence currently points at `241-0x02` as a better structured-token target than the large `0x65`-dominated families: its top 8-byte token appears repeatedly at recurring offsets, while the large-family `65 65 65 65 65 65 65 65` token slides across many distinct offsets and is likely filler or bulk payload structure
- reconstruction decoder target ranking: `artifacts-keyframes/reconstruction-decoder-target-ranking-16.9.json` ranks sampled families for offline decoder work only; current top targets are `241-0x02` and `241-0x04`, while `49607-0xF1` is marked `bulk-or-filler-heavy`
- reconstruction target dossier: `artifacts-keyframes/reconstruction-target-dossier-241-0x02-16.9.json` bundles ranking, sequence/offset evidence, and sampled chunk locations for the current top target; it is marked `decoder_target_only_not_runtime_api_data`
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
- `fieldCoverage.matchParticipantChallenges` marks Riot `participants[].challenges.*` parity as partial, with only `challenges.turretTakedowns` decoded from ROFL `statsJson`; unresolved 16.9 challenge leaves are emitted API-shaped as `null` and listed in `apiShapedNotFoundFields`
- `roflDerivedFieldMap` that maps decoded API-shaped match/timeline fields to ROFL sources and marks shape-only/missing fields explicitly
- `fieldCoverage.matchMetadataGaps` for Riot match metadata fields not present in the current ROFL summary, with inspected ROFL sources and decoded metadata keys recorded; those fields are emitted API-shaped as `null` and listed in `apiShapedNotFoundFields`, not counted as decoded ROFL data
- `fieldCoverage.matchParticipantGaps` for remaining participant fields that are not accepted as ROFL/API parity, including rejected/gap evidence for static champion IDs, event-derived first kill/tower flags, and missing account/profile fields
- `fieldCoverage.matchTeamGaps` for Riot team fields not present in the current ROFL summary, including bans and `objectives.*.first` event-order flags; those fields are emitted API-shaped as `null` and listed in `apiShapedNotFoundFields`, not counted as decoded ROFL data
- `fieldCoverage.matchTeamGaps.unstableDecodedFields` lists decoded team objective kill fields that still need event-level or alternate ROFL evidence before they can be treated as patch-wide stable parity
- `identityLinkage` that summarizes final roster linkage, Riot API identifier parity status, and non-final scalar identity blockers
- `identityLinkage.evidenceMatrix` maps the replay-only identity evidence classes from the goal to concrete artifact refs: ROFL metadata/statsJson roster, roster order, team/champion metadata, cross-metric final stats consistency, startup roster/order tokens, keyframe row identity gates, and handle graph row links
- `identityLinkage.nonFinalScalarIdentity.runtimePromotionGate` records the current promotion decision: final roster identity passes, but non-final scalar identity, startup-token-to-keyframe linkage, row identity coherence, handle graph linkage, and no-priors position identity remain blocked
- `identityLinkage.roflMetadataParticipantIdentifiers` marks ROFL `statsJson` participant identifiers as internal/shape-only, not verified Riot API PUUIDs or encrypted summoner IDs
- `parityChecklist` that maps the current goal requirements to artifact evidence and explicit gaps
- `parityChecklist` includes concrete evidence paths for the conservative replay-only identity gate and records the true Riot API PUUID gap
- `rofl-api-parity-goal-audit.json` maps the user objective to concrete artifact evidence and keeps completion status `not_complete` while full parity gaps remain
- `rofl-api-shape-gap-report.json` is an offline-only comparison against Riot match/timeline fixture shape; it quantifies missing API leaf paths without being a runtime extraction input
- `rofl-api-shape-gap-report.json` now has only the timeline-events bucket left as missing shape; match metadata, participant challenges, first-objective flags, participant event/profile/static-ID fields, team bans, and unresolved timeline participant-frame scalar/position/championStats leaves remain semantically `not_found`/`not_promoted`/`shape_only` but are present as `null` leaves for API shape
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
- `rejectedCandidateArtifacts.reconstructionRowIdentity` that records why the 241-family row identity gates are not accepted
- non-final scalar identity diagnostics include the conservative replay-only metric set, acceptance thresholds, aggregate scoring diagnostics, rejection-reason counts, and the strongest replay candidates
- `rejectedCandidateArtifacts.nonFinalScalarIdentity.startupRosterTokenScan` summarizes `artifacts-keyframes/startup-roster-token-scan.json` as diagnostic-only evidence: for patch 16.9 it scans 20 replays and finds full-corpus replay-only roster/order token hits, but those startup tokens are still not linked to non-final keyframe state rows
- `rejectedCandidateArtifacts.nonFinalScalarIdentity.startupKeyframeRowLink` summarizes `artifacts-keyframes/startup-keyframe-row-link-diagnostic-16.9.json` as `not_promoted`: startup roster/order tokens are present, strict keyframe identifier-token scan has no roster/order token candidates, the direct startup-token to stable keyframe row link is still `not_found`, the row identity gates are blocked, and handle graph evidence remains weak
- `artifactManifest.decoderDiagnostics` includes `replay-only-startup-roster-token-diagnostic` and marks it `runtimeInput:false` / `runtimeApiData:false`
- `artifactManifest.decoderDiagnostics` includes `offline-startup-keyframe-row-link-diagnostic` and marks it `runtimeInput:false` / `runtimeApiData:false`
- `rejectedCandidateArtifacts.nonFinalScalarIdentity.handleGraphRowLinkCandidates` summarizes `artifacts-keyframes/keyframe-handle-graph-candidate-scores.json` as `not_promoted`: current patch 16.9 has 260 row-link candidates, all `weak`, with top score 0.333, so no handle graph link is accepted as participant identity
- `artifactManifest.decoderDiagnostics` includes `offline-handle-graph-row-link-diagnostic` and marks it `runtimeInput:false` / `runtimeApiData:false`
- scalar identity diagnostics also break evidence down by metric: observed slot values, roster comparisons, positive scores, and accepted edge support
- replay-only scalar identity scoring deduplicates repeated offsets of the same metric before accepting support, so duplicate currentGold/CS candidates cannot masquerade as independent evidence
- replay-only scalar identity scoring requires each accepted support metric to pass a minimum per-metric quality score before it can form an edge
- replay-only scalar identity scoring rejects duplicated final-stat anchors from accepted support by default, and diagnostics still report those anchors so low-information evidence is visible rather than promoted as participant identity
- strongest rejected scalar identity assignments include support metrics, winner-gap data, runner-up details, and rejection reasons when any rejected assignments survive initial gates
- `rejectedCandidateArtifacts.positions` that records existing movement evidence and why it is not emitted as runtime API data
- `rejectedCandidateArtifacts.positions.promotionBlockers` and `qualityGateSummary` make the movement rejection machine-readable: current blockers are 9/10 assignment coverage, 1 unmatched participant, identity-prior dependency, and 7/9 offline quality passes
- the movement rejection also preserves near-miss evidence: the unmatched Malphite participant has top rejected entity candidates, and the two unassigned entity tracks have top rejected participant candidates, so the 9/10 blocker is inspectable without promoting x/y data
- `rejectedCandidateArtifacts.positions.perParticipantCoverage` and `fieldCoverage.positions.perParticipantCoverage` summarize all 10 participants with explicit `unstable_identity`, `noisy`, or `not_found` movement status; this keeps candidate x/y evidence visible without promoting it into `participantFrames.position`
- `roflDerivedFieldMap.timeline["info.frames[].participantFrames[].position"]` mirrors the same per-participant movement coverage and status counts while keeping `position` `not_promoted`
- `rejectedCandidateArtifacts.itemEvents` that records supervised item-event candidates and why they are not emitted as runtime API data
- `rejectedCandidateArtifacts.itemEvents.eventFamilyCorrelation` summarizes `artifacts-keyframes/reconstruction-family-event-correlation-16.9.json` as `not_promoted`: selected event-enriched families such as `241-0x02`, `241-0x04`, `512-0x00`, and `2-0xC7` are tracked, but the diagnostic uses offline Riot event categories and does not decode ROFL event payload semantics
- `artifactManifest.decoderDiagnostics` includes `offline-event-family-correlation-diagnostic` and marks it `runtimeInput:false` / `runtimeApiData:false`
- `rejectedCandidateArtifacts.inventoryTimeline` that records why item/inventory state over time is not emitted
- `rejectedCandidateArtifacts.championStatsFinal` that records why final `participantFrames[].championStats` is only shape-compatible: current `statsJson` candidates are all-zero or unrelated counter collisions, not accepted API parity
- `rejectedCandidateArtifacts.damageTimeline` that records whether any extracted-stat damage candidates exist
- separate `matchCoverage` for ROFL-only final match data
- `fieldCoverage.timelineNonFinalParticipantIdentity` that records the rejected 241-family chunk-row identity gates
- `roflDerivedFieldMap.timeline["info.frames[].participantFrames[].nonFinalParticipantIdentity"]` that maps the same rejected identity path to `chunk-row-identity-gates`
- aggregate coverage summary in `totals.coverageSummary`
- `remainingParityGaps` provides a compact machine-readable gap table for non-final participant identity, positions, timeline events, inventory timeline, and damage timeline; every entry states the API surface, runtime emission policy, non-runtime status, blocker summary, evidence refs, and next decoder step. The non-final participant identity gap points back to `identityLinkage.evidenceMatrix` and `identityLinkage.nonFinalScalarIdentity.runtimePromotionGate`, with the blocked runtime-promotion and no-priors position identity blockers preserved.
- `roflOnlyExtractionProof` provides a compact proof table for runtime inputs, ROFL-only decoded surfaces, per-participant decoded scalar/damage metric counts, offline-validation-only reports, not-promoted runtime candidates, and linked remaining gap keys
- `roflOnlyExtractionProof.apiShapeProof` records the current shape boundary directly in the runtime artifact: match shape is API-shaped with `0` missing leaf paths, timeline shape remains partial with `70` missing `events[]` leaf paths and `empty-events-arrays` runtime emission
- `artifactManifest` lists the generated runtime artifact, required ROFL replay input, replay-derived summary, offline validation reports, and the full checkpoint command with explicit runtime-input roles
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
- `fieldCoverage.matchMetadataGaps` lists non-stats match metadata that is still unavailable, records the inspected ROFL sources (`summary.json`, `metadataJson`, and embedded `statsJson`), and verifies the API-shaped null leaves
- `fieldCoverage.matchParticipantGaps` lists unpromoted participant fields and explains why candidate ROFL values are not exposed as API parity data
- `fieldCoverage.matchTeamGaps` separates decoded final objective kill counts from missing bans and first-objective event-order fields, with `objectives.*.first` and `bans[]` API-shaped as null and mapped in `roflDerivedFieldMap.match`
- `fieldCoverage.timelineNonFinalParticipantFrames.apiShapedNotFoundFields` verifies unresolved timeline frame leaves such as `currentGold`, `goldPerSecond`, `position.x/y`, `timeEnemySpentControlled`, and `championStats.*` are API-shaped as `null` without being counted as decoded metric points
- `fieldCoverage.timelineEvents.apiShapedNotFoundFields` enumerates the remaining `70` Riot timeline event leaf paths as `not_found`; runtime frames keep `events: []` until actual ROFL event decoding exists, rather than emitting fake null event objects
- `roflDerivedFieldMap.timeline["info.frames[].events"]` mirrors the same `70` event leaf gaps and the `empty-events-arrays` runtime policy, so field-map consumers do not need to infer event gaps from the offline shape report
- `fieldCoverage.timelineEvents.rejectedItemEventEvidence`, `roflDerivedFieldMap.timeline["info.frames[].events"].rejectedItemEventEvidence`, and `rejectedCandidateArtifacts.inventoryTimeline.relatedCandidateArtifact` mirror the supervised item-event diagnostic counts, while keeping them offline-only and out of runtime `events`/inventory state
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

For `EUW1-7840220945`, the movement pipeline has a `participant-movement.json` diagnostic, but it is not emitted into `timeline.info.frames` because it assigns 9 of 10 participants, only 7 of 9 assignments pass offline Riot validation, and the current assignment path uses identity priors. The unmatched participant is Malphite TOP on team 200; its best rejected entity candidates are already assigned to other participants, while the remaining unassigned entity tracks also keep their top rejected participant candidates. The API-shaped artifact records this under `rejectedCandidateArtifacts.positions`, including explicit `promotionBlockers`, `qualityGateSummary`, near-miss candidate summaries, and per-participant movement coverage so consumers can distinguish unstable assigned candidates, noisy failed-validation candidates, and the unmatched participant.

The same position blocker now has a no-priors diagnostic: `participant-movement-no-priors.json` reruns the assignment with `movement-identity-priors.json` disabled, and `assigned-movement-no-priors-validation-report.json` validates that offline-only diagnostic. On `EUW1-7840220945`, this drops movement assignment from 9/10 to 8/10 participants while 7/8 assigned tracks pass offline validation. The API-shaped artifact records that under `rejectedCandidateArtifacts.positions.noPriorsDiagnostic`, mirrors it through `fieldCoverage.positions.noPriorsDiagnostic` and `roflDerivedFieldMap.timeline["info.frames[].participantFrames[].position"].noPriorsDiagnostic`, and keeps `runtimeApiData=false`; it is evidence that real x/y tracks exist, but replay-only participant identity is still too weak to emit `participantFrames.position`.

The same replay now has an offline `item-event-candidates.json` diagnostic with 689 candidates and 93 strong candidates, but it is not emitted into `timeline.info.frames[*].events` because the report is discovered against Riot API timeline item events and is not yet a ROFL-only event decoder. The API-shaped artifact records this under `rejectedCandidateArtifacts.itemEvents`.

Inventory timeline parity is tracked separately under `rejectedCandidateArtifacts.inventoryTimeline`: final item slots are ROFL-only in `match.info.participants`, but item state over time is not reconstructed because there is no accepted ROFL-only item-event or slot-state timeline decoder yet.

Final `championStats` parity is tracked under `rejectedCandidateArtifacts.championStatsFinal`. The artifact keeps the API-shaped `championStats` leaves as `null`, but does not emit values because the current `statsJson` scan only finds all-zero collisions or unrelated counters, not decoded champion stat semantics.

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

The API-shaped artifact also records the 241-family row identity gate under `rejectedCandidateArtifacts.reconstructionRowIdentity`. That summary keeps the candidate evidence visible to runtime consumers without promoting it: both `241-0x02` and `241-0x04` have `promotionStatus=not_promoted`, `runtimeApiData=false`, `participantIdentity=false`, `minCoherence=0.75`, `strongestRows` with per-row blocker reasons, and row status counts that sum to 10 rejected or unstable rows.

The same non-promoted identity path is mirrored in `fieldCoverage.timelineNonFinalParticipantIdentity`, `roflDerivedFieldMap.timeline["info.frames[].participantFrames[].nonFinalParticipantIdentity"]`, and `remainingParityGaps.nonFinalParticipantIdentity`, so consumers can see that the chunk-row evidence was considered but remains `not_promoted` with `participantIdentity=not-established`. The remaining-gap row also links the broader `identityLinkage.evidenceMatrix`, blocked `identityLinkage.nonFinalScalarIdentity.runtimePromotionGate`, and `rejectedCandidateArtifacts.nonFinalScalarIdentity.startupKeyframeRowLink`.

A probe with `--metric-set all` considered volatile ROFL final anchors such as health, power, and movement speed. It increased slot metric observations from 52 to 228 but, after duplicate same-metric support is collapsed and weak per-metric support is filtered, still produced no accepted assignments and 0 canonical candidates, so the default path remains conservative.

Sensitivity probes for `--min-support-score` show why the default remains `0.35`: thresholds `0.30` and `0.25` still produce 0 assignments, while `0.20` admits one diagnostic assignment that matches the offline supervised comparison but fails winner-gap separation (`winnerGap=0.0008828456005518515`). That candidate is therefore useful as a research clue, not runtime API data.
Regenerate that scorecard with:

```powershell
npm run sweep:keyframe-rofl-support -- --version-group 16.9
```

The goal audit records the sweep rows from `keyframe-rofl-stat-support-threshold-sweep-16.9.json`.

The current chunk-delta target is the fixed-length `241` family pair. The next hypothesis under test is deliberately structural, not semantic: determine whether `241-0x02` and `241-0x04` are `1` table-kind byte plus `10 * 24` bytes of fixed rows. The offline artifacts are:

- `artifacts-keyframes/reconstruction-target-dossier-241-0x02-16.9.json`
- `artifacts-keyframes/reconstruction-target-dossier-241-0x04-16.9.json`
- `artifacts-keyframes/reconstruction-target-neighborhood-241-0x02-16.9.json`
- `artifacts-keyframes/reconstruction-target-neighborhood-241-0x04-16.9.json`
- `artifacts-keyframes/reconstruction-target-table-analysis-241-0x02-16.9.json`
- `artifacts-keyframes/reconstruction-target-table-analysis-241-0x04-16.9.json`
- `artifacts-keyframes/reconstruction-row-identity-241-0x02-16.9.json`
- `artifacts-keyframes/reconstruction-row-identity-241-0x04-16.9.json`
- `artifacts-keyframes/reconstruction-family-event-correlation-16.9.json`

Regenerate and verify them with:

```powershell
npm run build:reconstruction-target-dossier -- --family-key 241-0x02
npm run verify:reconstruction-target-dossier -- --family-key 241-0x02
npm run build:reconstruction-target-neighborhood -- --family-key 241-0x02
npm run verify:reconstruction-target-neighborhood -- --family-key 241-0x02
npm run build:reconstruction-target-dossier -- --family-key 241-0x04
npm run verify:reconstruction-target-dossier -- --family-key 241-0x04
npm run build:reconstruction-target-neighborhood -- --family-key 241-0x04
npm run verify:reconstruction-target-neighborhood -- --family-key 241-0x04
npm run analyze:reconstruction-target-table -- --family-key 241-0x02 --row-count 10 --row-size 24
npm run verify:reconstruction-target-table-analysis -- --family-key 241-0x02
npm run infer:reconstruction-row-identity -- --family-key 241-0x02 --version-group 16.9
npm run verify:reconstruction-row-identity -- --family-key 241-0x02 --version-group 16.9
npm run analyze:reconstruction-target-table -- --family-key 241-0x04 --row-count 10 --row-size 24
npm run verify:reconstruction-target-table-analysis -- --family-key 241-0x04
npm run infer:reconstruction-row-identity -- --family-key 241-0x04 --version-group 16.9
npm run verify:reconstruction-row-identity -- --family-key 241-0x04 --version-group 16.9
npm run scan:reconstruction-row-grids -- --version-group 16.9
npm run verify:reconstruction-row-grids -- --version-group 16.9
npm run analyze:reconstruction-row-grid-fields -- --version-group 16.9
npm run verify:reconstruction-row-grid-fields -- --version-group 16.9
npm run correlate:reconstruction-families-events -- --version-group 16.9
npm run verify:reconstruction-family-event-correlation -- --version-group 16.9
```

Early result: both families split cleanly into the proposed `1 + 10 * 24` shape, but the row-coherence scores are weak on the current sample set (`241-0x02` same-row win rate `0.3333`, `241-0x04` same-row win rate `0.1`). The table artifacts therefore set `promotionAssessment.status=not_promoted` and `runtimeApiData=false`. That means the shape is worth keeping as a decoder target, but it is not yet evidence for participant identity or runtime `participantFrames` values.

For the open replay-only identity gap, these `241` table artifacts are now tracked as a tested but rejected promotion path. The current evidence says the records are structurally plausible `10`-row tables, but the row tracks are not coherent enough to map rows to participants. They are not promotable for participant identity yet. Until row continuity, field semantics, and participant identity all pass replay-only gates, these artifacts must stay out of runtime `timeline.info.frames[].participantFrames`.

The companion row identity gate artifacts make that rejection explicit per row. `reconstruction-row-identity-241-0x02-16.9.json` and `reconstruction-row-identity-241-0x04-16.9.json` set `promotionAssessment.status=not_promoted`, `runtimeApiData=false`, and `participantIdentity=false`; every row keeps `participantId=null`. The gate currently uses the same-row win rate threshold `0.75` plus a duplicate-row rejection threshold `0.5`, so both families fail promotion until the decoder can prove stable row continuity and a ROFL-only row-to-participant mapping. In the current artifacts, `241-0x02` marks 4 rows as `duplicate_rejected` because the same row bytes are duplicated inside too many records, while the remaining rows stay `unstable_identity`. `241-0x04` rows remain `unstable_identity`.

The generic row-grid scan in `artifacts-keyframes/reconstruction-row-grid-candidates-16.9.json` broadens that test beyond the fixed `1 + 10 * 24` hypothesis. It scans sampled reconstruction families for 5-row and 10-row grids with multiple header sizes, scores exact same-row continuity, nearest-row index stability, and duplicate-row rates, and keeps every candidate `runtimeApiData=false` and `participantIdentity=false`. Current best evidence is still `not_promoted`: the top candidate is a `241-0x04` 5-row grid with strong nearest-index stability but no exact same-row continuity, so it is useful decoder direction rather than accepted participant identity.

`artifacts-keyframes/reconstruction-row-grid-field-analysis-16.9.json` then profiles byte columns inside the top row-grid candidates. It records row-discriminator and record-constant byte-column signals, but still sets `fieldPromotionAssessment.status=not_promoted`, `runtimeApiData=false`, and `participantIdentity=false`: the current byte columns are unlabeled ROFL evidence and are not mapped to roster order, team, champion, or `participantId`. The runtime artifact mirrors that result under `rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridFieldAnalysis`.

The first event-correlation artifact samples 40 normalized 16.9 intervals. It keeps Riot timeline events as offline validation labels only and normalizes family counts by total subrecords in each selected interval. It also sets `promotionAssessment.status=not_promoted` and `runtimeApiData=false`, and records that Spearman uses average ranks for tied values. Current tied-rank Spearman results for `241-0x02` are modest (`total` Pearson `0.2767`, Spearman `0.3647`; `championKills` Pearson `0.3545`, Spearman `0.4355`), and `241-0x04` remains mixed (`total` Pearson `0.4175`, Spearman `0.2608`; `itemEvents` Pearson `0.5567`, Spearman `0.1955`). This is useful target-ranking context, not runtime event decoding.
