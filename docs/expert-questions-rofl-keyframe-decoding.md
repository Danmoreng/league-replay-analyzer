# Expert Questions: ROFL Keyframe State Decoding

Date: 2026-05-06

## Project Context

We are building a local-first League of Legends `.rofl` replay analyzer. The goal is an offline/post-game analytical 2D replay viewer, not a 3D replay client and not a live-game integration.

Current architecture:

- parser core: C++
- native CLI for corpus/debug tooling
- WebAssembly wrapper for browser parsing
- frontend: Vue 3 + TypeScript

Policy constraints:

- no live memory reading
- no process injection
- no live overlays
- no automation or competitive advantage features
- parser is built from scratch in this repo
- community parsers may be used as references only, not runtime dependencies

## What We Have Working

The parser can currently:

- parse `.rofl` metadata and embedded `statsJson`
- parse container headers and segment tables
- decompress zstd payload segments
- classify segment types: `startup`, `keyframe`, `chunk`
- extract length-prefixed subrecords from those segments
- scan recurring sparse subrecord families
- generate artifact bundles for chunk/keyframe/startup streams

For keyframes specifically:

- keyframe records align to Riot API timeline minute frames
- observed mapping: keyframe `segmentId - 1 == Riot API frame index`
- final Riot API frame is usually unpaired in pure keyframe mode

## Current Corpus

Local corpus:

- 47 replay/API fixture pairs
- version groups include `15.22`, `15.23`, `15.24`, `16.1`, `16.5`, `16.6`, `16.7`, `16.9`
- latest added group: 20 replays from patch `16.9`

Keyframe parity run across the corpus found:

- promoted metric candidates: 84
- promoted participant state slots: 69
- promoted participant identity slots: 31
- conflicted participant slots: 180
- replay-local assignments: 197
- stable replay-local assignments: 99
- stable assignments where API `participantId == metadata roster order`: 99 / 99
- replay-only final-stat slot assignments: 0

Current-patch `16.9` signal is concentrated in:

- family: `24672-0x60-h0`
- length: `24672`
- first byte: `0x60`
- header size: `0`
- stride: `16`
- element count: `1542`

Promoted `16.9` metric candidates include:

- `movementSpeed`
- `currentGold`
- `health`
- `minionsKilled`

Broader replay-local evidence also finds support for:

- `power`
- `powerMax`
- `healthMax`
- `level`
- `xp`
- `totalGold`
- `jungleMinionsKilled`

## What We Can Export Today

We now have two export paths.

### JS Supervised Prototype

Script:

```powershell
npm run export:keyframe-state
```

Output:

- `artifacts-keyframes/keyframe-state-prototype.json`

This uses:

- `keyframe-slot-assignments.json`
- `keyframe-api-parity.json`
- cleaned keyframe artifacts
- local affine fits against Riot API timeline

Stable-assignment result:

- exported replays: 34 / 47
- participant series: 99
- metric series: 565
- keyframe points: 4,522

This is participant-labeled but API-supervised.

### C++ Core Candidate Export

CLI:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --export-keyframe-state-candidates-json .\replays\EUW1-7842589492.rofl
```

This exports:

- `schema: keyframe-state-timeline.v1`
- `schemaId: keyframe-state-schema.v1`
- `versionGroup`
- keyframe records with `segmentId`, `chunkId`, `apiFrameIndex`, `timestamp`
- promoted field candidates with:
  - `familyKey`
  - `slotIndex`
  - `metric`
  - `offset`
  - `decodeLabel`
  - confidence metadata
  - `rawValue`
  - `decodedValue`
  - `calibratedValue: null`

This is real ROFL keyframe extraction in C++, but participant identity is still:

```json
"participantIdentity": "unassigned"
```

## Current Working Assumptions

Please challenge these.

1. Keyframes are minute-boundary snapshots of some world/entity state.
2. For keyframes, `segmentId - 1` maps to Riot API timeline frame index.
3. In `.rofl` metadata `statsJson`, roster order maps to Riot API `participantId = rosterIndex + 1`.
4. Keyframe sparse row slot index is not participant order.
5. The `16.9 | 24672-0x60-h0` family contains participant-state-like rows.
6. A 16-byte stride is the right row interpretation for that family.
7. The promoted fields are real state signals, but many raw decodes need calibration or a different interpretation before they become actual HP/gold/mana values.
8. Startup likely contains some indirect roster/entity/handle mapping, but not plain champion names, PUUIDs, summoner IDs, or Riot IDs.
9. Final `statsJson` alone is not enough to assign keyframe rows to players.

## Questions For An Expert

### ROFL Container And Segment Semantics

1. Are the segment kinds `startup`, `keyframe`, and `chunk` conceptually correct for modern `.rofl` files, or are we overfitting names to observed structure?
2. Is keyframe `segmentId - 1 == API timeline frame index` a known/expected property, or could it be accidental for our corpus?
3. Are keyframes expected to be full state snapshots, partial snapshots, or compressed deltas from prior state?
4. Are chunks between keyframes expected to carry player state deltas, event deltas, or both?

### Sparse Family Layout

5. For the `16.9 | 24672-0x60-h0` family, does a 16-byte row stride and element count around 1542 sound plausible?
6. What could the 1542 rows represent?
   - entities?
   - component arrays?
   - object handles?
   - replicated network objects?
   - something else?
7. Should we expect player champions to occupy stable row slots across a match, or can rows be reused/reassigned?
8. Are the high slot numbers, e.g. `480`, `489..495`, likely entity rows, component rows, or table/index rows?

### Participant Identity

9. What is the most likely replay-native way to map state rows to the 10 players?
10. Should we look for:
    - champion IDs?
    - summoner spell IDs?
    - team IDs?
    - skin IDs?
    - network object IDs?
    - actor handles?
    - component-owner handles?
11. Is that mapping more likely in `startup`, in the first keyframe, or spread across chunk deltas?
12. Are player/champion objects likely linked by a handle graph rather than direct IDs?
13. If startup has no plain PUUID/summoner/champion strings, what binary encodings or indirections would you expect?

### Metrics And Field Interpretation

14. In promoted keyframe fields, many signals correlate strongly with Riot API stats but raw values are not directly meaningful. Should we expect:
    - fixed-point values?
    - quantized network values?
    - affine transforms?
    - bit-packed fields?
    - component-specific compression?
15. Are HP/mana/gold/CS likely stored as independent fields in the same row, or split across multiple components/rows?
16. Could `currentGold`, `totalGold`, and `xp` be event-derived rather than direct state fields?
17. Should `health` and `power` be read from champion stats components, buff components, or replicated entity components?
18. Are movement speed and position usually stored near each other, or in entirely separate structures?

### Position Extraction

19. We have decent movement candidate coverage in chunks, but not final keyframe position decoding. Should position be expected in:
    - chunk deltas only?
    - keyframes and chunks?
    - a separate family/component stream?
20. Are player positions likely float32 map coordinates, fixed-point integers, or compressed path/navmesh coordinates?
21. Is Riot API timeline position sampled/interpolated from replay state, or generated from server-side event snapshots independently?

### Validation Strategy

22. Is comparing decoded keyframes to Riot API timeline frames a valid supervised strategy?
23. What are the main false-positive traps in this approach?
24. How would you distinguish true decoded state from correlation artifacts in replay data?
25. What minimal replay-native evidence would you require before calling participant-labeled HP/gold/CS decoding solved?

### Versioning

26. Should we expect these family keys/slot layouts to change every patch, every major patch, or rarely?
27. Is it better to maintain per-patch schemas, or to reverse-engineer a more stable descriptor/table format first?
28. Are the first byte and length enough to identify a family, or should we include additional signatures?

## Specific Artifacts We Can Share

Potentially useful files:

- `docs/keyframe-api-parity.md`
- `artifacts-keyframes/keyframe-parity-schema.json`
- `artifacts-keyframes/keyframe-slot-assignments.json`
- `artifacts-keyframes/keyframe-identity-order-analysis.json`
- `artifacts-keyframes/keyframe-state-prototype.json`
- `artifacts-keyframes/startup-roster-token-scan.json`
- `artifacts-keyframes/keyframe-identifier-token-scan.json`

Relevant code:

- `packages/rofl-core/src/replay_analyzer.cpp`
- `scripts/discover_keyframe_api_parity.mjs`
- `scripts/build_keyframe_parity_schema.mjs`
- `scripts/assign_keyframe_participant_slots.mjs`
- `scripts/export_keyframe_state_prototype.mjs`

Useful CLI commands:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --export-keyframe-state-candidates-json .\replays\EUW1-7842589492.rofl
```

```powershell
npm run export:keyframe-state -- --replay-id EUW1-7842589492
```

```powershell
npm run scan:startup-roster-tokens -- --artifact-root .\artifacts-keyframes --replay-root .\replays --api-root .\replays\api
```

## What We Need Most

The most valuable expert input would be:

1. Whether our keyframe model is directionally correct.
2. How to find the replay-native identity link from rows/components to the 10 players.
3. Whether raw correlated fields should be decoded through fixed schemas, bitfields, fixed-point transforms, or handle/component traversal.
4. Whether we should keep extending supervised parity, or pause and reverse-engineer descriptors/handle tables first.
