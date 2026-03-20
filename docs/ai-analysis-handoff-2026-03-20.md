# ROFL AI Analysis Handoff - March 20, 2026

## Purpose

This document packages the current state of the replay reverse-engineering work into one handoff that can be fed to another AI model for deeper analysis.

The goal is to let another model continue from the current evidence without needing conversation history.

Primary replay under investigation:
- `replays/EUW1-7779216102.rofl`

Primary Riot fixture bundle:
- `replays/api/EUW1_7779216102/match.json`
- `replays/api/EUW1_7779216102/timeline.json`
- `replays/api/EUW1_7779216102/manifest.json`

Current date of this handoff:
- March 20, 2026

## High-Level State

The project is no longer at the "can we open the replay" stage.

What is implemented and working now:
- local `.rofl` parsing in C++
- Wasm export of the parser for the Vue UI
- replay metadata extraction
- footer-style zstd record indexing for newer replay formats
- recurring-family scan across decompressed chunk subrecords
- movement-candidate analysis for sparse families
- automatic movement correlation against Riot timeline positions and event anchors
- automatic scalar-lane extraction for top families
- automatic scalar correlation against Riot participant-frame stats in the Riot timeline
- a Decoder Inspector UI for visual and ranked investigation

What is still not solved:
- reliable champion movement extraction from the replay payload
- semantic slot assignment for persistent player/entity tables
- confident decoding of ability use, damage packets, or full event streams
- a version-robust normalized entity/state decoder

The most important shift from the last session is this:
- movement-first heuristics are still weak on `EUW1-7779216102.rofl`
- scalar-state matching is now producing stronger evidence than movement matching
- the most promising next path is identifying player-state tables first, then using that identity/time backbone to revisit movement

## Product / Repo Context

Repo root:
- `C:\Development\league-replay-analyzer`

Architecture:
- frontend: Vue 3 + TypeScript under `apps/web`
- parser core: C++ under `packages/rofl-core`
- Wasm bridge: `packages/rofl-wasm`
- sample replays: `replays`

Important current files:
- `packages/rofl-core/include/rofl/core/replay_analyzer.hpp`
- `packages/rofl-core/src/replay_analyzer.cpp`
- `packages/rofl-core/src/cli_main.cpp`
- `packages/rofl-wasm/src/rofl_wasm.cpp`
- `packages/rofl-wasm/CMakeLists.txt`
- `apps/web/src/components/ReplayInspector.vue`
- `apps/web/src/replayInvestigation.ts`
- `apps/web/src/replayCorrelation.ts`
- `apps/web/src/replayScalarCorrelation.ts`
- `apps/web/src/wasmReplayParser.ts`
- `apps/web/src/App.vue`
- `docs/replay-format-notes.md`
- `docs/session-rofl-movement-investigation-handoff.md`

## Replay Container Findings

For newer files like `EUW1-7779216102.rofl`, the classic 288-byte ROFL header path does not validate cleanly.

The parser now relies on a verified footer-style path:
- metadata length is stored in the final 4 bytes
- metadata block is located immediately before that length field
- a footer-style chain of zstd records can be indexed before the metadata block

Verified local sample properties for `replays/EUW1-7779216102.rofl`:
- file size: `15,013,275`
- metadata source: `footer-size`
- metadata offset: `14,903,687`
- metadata size: `109,584`
- game version leaked near file start: `16.5.752.7101`
- replay `gameLengthMillis`: `1,895,012`
- metadata `lastGameChunkId`: `66`
- metadata `lastKeyFrameId`: `32`

Verified footer-style zstd record chain:
- `97` indexed records before metadata
- `1` startup record
- `32` keyframe records
- `64` chunk records
- startup ends at chunk `2`
- first regular gameplay chunk is effectively after startup, with current chunk-alignment work using the footer-indexed chunk ids

These findings are already documented in:
- `docs/replay-format-notes.md`

## Timing / Riot API Alignment Invariants

These are currently high-confidence across the local corpus and are useful for any AI continuing this work:

- replay `gameLengthMillis` is usually within a few hundred milliseconds of Match-V5 `gameDuration * 1000`
- replay metadata player summaries match Riot Match-V5 very closely for champion/team/KDA/damage/vision/win
- replay `goldEarned` is almost identical to Match-V5 but not always byte-for-byte exact
- official timeline `frameCount == replay keyframeCount + 1`
- keyframe records align strongly with timeline frame boundaries
- chunk records behave like approximately 30-second windows between minute snapshots

This means another AI should assume:
- Riot timeline participant frames are valid ground truth anchors for player-state time series
- replay keyframes are a better first target for scalar/player-state reasoning than blind chunk minimap matching
- chunk-local event windows are still useful for nearby validation, but not enough by themselves

## Decoder Inspector / UI State

The web UI now has a Decoder Inspector page.

It does all of the following:
- scans recurring replay families
- analyzes top movement candidates for selected families
- runs automatic movement correlation against Riot timeline movement and event anchors
- runs automatic scalar correlation against Riot participant-frame stats
- displays ranked families, movement matches, and scalar matches

Relevant UI files:
- `apps/web/src/components/ReplayInspector.vue`
- `apps/web/src/replayCorrelation.ts`
- `apps/web/src/replayScalarCorrelation.ts`
- `apps/web/src/wasmReplayParser.ts`

This means another AI does not need to invent an analysis UX from scratch. It can extend the current ranking/assignment pipeline instead.

## Current Native / Wasm Commands

Current useful native commands:
- `rofl_core_cli.exe --summary <replay>`
- `rofl_core_cli.exe --inspect <replay>`
- `rofl_core_cli.exe --summarize-subrecord-families <replay>`
- `rofl_core_cli.exe --compare-position-classes <replay> ...`
- `rofl_core_cli.exe --compare-raw-positions-with-api <replay> <api-positions.json> ...`
- `rofl_core_cli.exe --match-event-window <replay> ...`
- `rofl_core_cli.exe --scan-families-json <replay> ...`
- `rofl_core_cli.exe --analyze-scalar-family-json <replay> ...`

Current Wasm exports now include:
- replay parse
- family scan
- sparse movement-family analysis
- scalar-family analysis

## Family Scan Results For EUW1-7779216102

Latest top recurring families from the replay-wide family scan:

1. `53970 / 0xD2`
- records: `581`
- chunks: `62`
- chunk span: `5-66`
- recommended stride: `16`
- recommended header: `2`
- element count candidate: `3373`

2. `53974 / 0xD2`
- records: `19`
- chunks: `15`
- chunk span: `6-60`
- recommended stride: `16`
- recommended header: `6`
- element count candidate: `3373`

3. `61917 / 0x00`
- records: `13`
- chunks: `12`
- chunk span: `6-64`
- recommended stride: `16`
- recommended header: `13`
- element count candidate: `3869`

4. `28928 / 0x4B`
- records: `11`
- chunks: `10`
- chunk span: `9-66`
- recommended stride: `16`
- recommended header: `0`
- element count candidate: `1808`

5. `39064 / 0x98`
- records: `10`
- chunks: `10`
- chunk span: `29-60`
- recommended stride: `16`
- recommended header: `8`
- element count candidate: `2441`

6. `19313 / 0xF1`
- records: `9`
- chunks: `9`
- chunk span: `10-66`
- recommended stride: `16`
- recommended header: `1`
- element count candidate: `1207`

7. `28928 / 0xDD`
- records: `6`
- chunks: `6`
- chunk span: `8-64`
- recommended stride: `16`
- recommended header: `0`
- element count candidate: `1808`

8. `56689 / 0xF1`
- records: `6`
- chunks: `5`
- chunk span: `11-64`
- recommended stride: `16`
- recommended header: `1`
- element count candidate: `3543`

## Movement Findings

The current movement path is still not convincing.

What has already been tried:
- family-level sparse movement ranking inside the dominant `53970 / 0xD2` family
- event-window proximity scans against Riot kill/objective positions
- raw-record comparison to Riot positions rather than chunk-collapsed medians
- affine remapping attempts between replay candidate tracks and Riot map coordinates
- automatic correlation in the UI against Riot timeline positions plus event anchors

Current conclusion on movement for `EUW1-7779216102.rofl`:
- the current float-pair model is still weak
- the best movement candidates are not strong enough to treat as decoded champion tracks
- the dominant `53970 / 0xD2` family still looks like broad world/entity state, but not yet like clean champion x/y extraction under the current decoder

Important negative conclusion:
- movement-only analysis is not the fastest path forward on this replay

## Scalar Analysis Pipeline

A new scalar analysis path was added.

What it does:
- extracts raw per-slot/per-lane scalar candidates from top replay families
- emits sample series for each lane
- tries multiple decodes automatically:
  - `u32`
  - `i32`
  - `f32`
  - `u16lo`
  - `u16hi`
  - `i16lo`
  - `i16hi`
- correlates these candidate series against Riot timeline participant-frame stats:
  - `level`
  - `currentGold`
  - `totalGold`
  - `xp`
  - `minionsKilled`
  - `jungleMinionsKilled`
  - `championStats.health`
  - `championStats.healthMax`
  - `championStats.power`
  - `championStats.powerMax`
  - `championStats.movementSpeed`
  - and some damage counters in the frontend implementation

This was implemented in:
- `packages/rofl-core/src/replay_analyzer.cpp`
- `packages/rofl-wasm/src/rofl_wasm.cpp`
- `apps/web/src/replayScalarCorrelation.ts`
- `apps/web/src/components/ReplayInspector.vue`

## Latest Scalar Results For EUW1-7779216102

These are the strongest current results from the actual replay run against local Riot fixtures.

### Best Result Per Metric

Move Speed:
- family: `53974 / 0xD2`
- slot/lane/decode: `slot 7 lane 3 u32`
- champion matched: `Ambessa`
- score: `0.454`
- correlation: `0.736`
- normalized RMSE: `0.677`
- overlap: `19`

Jungle CS:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 17 lane 1 u32`
- champion matched: `Katarina`
- score: `0.430`
- correlation: `0.643`
- normalized RMSE: `0.353`
- overlap: `13`

Health:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 7 lane 1 u32`
- champion matched: `DrMundo`
- score: `0.408`
- correlation: `0.839`
- normalized RMSE: `0.544`
- overlap: `13`

Current Gold:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 16 lane 3 i16lo`
- champion matched: `Soraka`
- score: `0.391`
- correlation: `0.783`
- normalized RMSE: `0.622`
- overlap: `13`

Power:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 7 lane 1 u32`
- champion matched: `Malzahar`
- score: `0.369`
- correlation: `0.739`
- normalized RMSE: `0.674`
- overlap: `13`

CS:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Ambessa`
- score: `0.350`
- correlation: `0.788`
- normalized RMSE: `0.615`
- overlap: `13`

Max Health:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Swain`
- score: `0.335`
- correlation: `0.772`
- normalized RMSE: `0.636`
- overlap: `13`

XP:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Swain`
- score: `0.335`
- correlation: `0.762`
- normalized RMSE: `0.648`
- overlap: `13`

Total Gold:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Swain`
- score: `0.327`
- correlation: `0.763`
- normalized RMSE: `0.646`
- overlap: `13`

Level:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Swain`
- score: `0.320`
- correlation: `0.755`
- normalized RMSE: `0.656`
- overlap: `13`

Max Power:
- family: `61917 / 0x00`
- slot/lane/decode: `slot 8 lane 3 i16lo`
- champion matched: `Ornn`
- score: `0.308`
- correlation: `0.756`
- normalized RMSE: `0.654`
- overlap: `13`

### Best Families By Scalar Evidence

#### 1. `61917 / 0x00`
This is currently the strongest all-around scalar family.

Top hits inside it:
- `Katarina jungle CS` at `slot 17 lane 1`
- `DrMundo health` at `slot 7 lane 1`
- `Soraka current gold` at `slot 16 lane 3`
- several plausible `currentGold`, `health`, `power`, `move speed`, `xp`, and `level` style candidates

Interpretation:
- this family is the strongest current candidate for a compact player-state or entity-state table
- it should now be treated as the primary semantic decoding target

#### 2. `39064 / 0x98`
This family produced some of the cleanest individual scalar correlations, despite fewer records.

Examples:
- `Brand current gold`, `slot 26 lane 0 i16lo`, corr `0.963`, nRMSE `0.271`
- `Malzahar power`, `slot 28 lane 1 u16lo`, corr `0.938`, nRMSE `0.346`
- `Ahri health`, `slot 21 lane 0 u16lo`, corr `0.917`, nRMSE `0.400`

Interpretation:
- this family may contain chunk-local or more specialized state with cleaner individual stat lanes
- it is probably worth inspecting after `61917 / 0x00`

#### 3. `28928 / 0x4B`
This family has a strong current-gold-like candidate.

Example:
- `Ahri current gold`, `slot 13 lane 2 u16lo`, corr `0.908`, nRMSE `0.418`

Interpretation:
- likely another promising scalar/state family
- not obviously the main player table, but clearly not random noise either

#### 4. `19313 / 0xF1`
This family has a strong short-window `jungle CS` style candidate.

Example:
- `Katarina jungle CS`, `slot 5 lane 1 u16lo`, corr `0.922`, nRMSE `0.182`

Interpretation:
- highly interesting but based on fewer samples
- may represent a smaller per-window or compressed state packet rather than the main persistent player table

### Important Negative Scalar Finding

The huge dominant family `53970 / 0xD2` is still not where the strongest semantic signals are showing up.

That matters because it means:
- the large sparse family may still carry world/entity state
- but it is not currently the most productive place to recover player stats or champion movement
- analysis should pivot from `53970 / 0xD2` obsession toward the smaller families that are already correlating against known Riot participant stats

## Current Best Interpretation

The replay almost certainly contains more than positions.

The current evidence is most consistent with this model:
- one or more recurring families carry compact player/entity state tables
- some of those tables contain stat-like lanes that correlate with Riot participant-frame values
- movement may either live in a different family or require a different numeric/structural interpretation inside the same state tables
- the best next progress comes from table/slot identity assignment, not from more blind minimap fitting

In particular:
- `61917 / 0x00` looks like the best current candidate for a participant-state table
- `39064 / 0x98` and `28928 / 0x4B` also look semantically meaningful
- movement extraction should probably be revisited only after slot-to-player identity is stronger

## What Another AI Should Investigate Next

### Primary Task
Build participant-table assignment for the promising scalar families.

This means:
- infer which slots likely represent persistent player rows
- infer whether the family contains 10 participant rows, 5v5 grouped rows, or a larger mixed table
- use multi-metric assignment across `gold/xp/cs/level/health/power` rather than one metric at a time
- favor stable slot-to-player matching over per-lane isolated ranking

### Secondary Task
Search for explicit table structure inside `61917 / 0x00`.

Useful questions:
- do adjacent slots form a contiguous player block?
- do masks/first-byte values partition the table into player rows vs non-player rows?
- are some lanes clearly scalar state and others ids/flags/enums?
- is there a repeated row order across chunks that can be aligned to Riot participant order?

### Tertiary Task
Revisit movement after slot identity is stronger.

Useful questions:
- once a slot is believed to belong to a player row, do nearby lanes in the same row decode into position using a different numeric transform?
- are coordinates packed as `i16x2`, fixed-point, delta-coded integers, or mixed world/local offsets?
- are position-like values only valid in some masks or row states?

### Also Worth Testing
- whether keyframes are a better source than chunk subrecords for player stats
- whether some stat lanes are monotone counters while others are snapshots
- whether some families are keyframe snapshots and others are half-minute deltas
- whether row identity can be stabilized by combining multiple metrics and event windows

## Concrete File Inputs To Give Another AI

If another AI can read local files, these are the most important ones to provide:

Replay and fixtures:
- `replays/EUW1-7779216102.rofl`
- `replays/api/EUW1_7779216102/match.json`
- `replays/api/EUW1_7779216102/timeline.json`

Current code:
- `packages/rofl-core/src/replay_analyzer.cpp`
- `packages/rofl-core/include/rofl/core/replay_analyzer.hpp`
- `packages/rofl-core/src/cli_main.cpp`
- `packages/rofl-wasm/src/rofl_wasm.cpp`
- `apps/web/src/components/ReplayInspector.vue`
- `apps/web/src/replayInvestigation.ts`
- `apps/web/src/replayCorrelation.ts`
- `apps/web/src/replayScalarCorrelation.ts`
- `apps/web/src/wasmReplayParser.ts`

Current notes:
- `docs/replay-format-notes.md`
- `docs/session-rofl-movement-investigation-handoff.md`
- this file

Optional scratch artifacts that may still help a deeper model inspect chunk structure:
- `chunk_24_subrecords.txt`
- `chunk_65_subrecords.txt`
- `chunk_6_subrecords.txt`
- `scripts/temp-compare-chunks.mjs`

These scratch files are not canonical, but they may still be useful for forensic comparison.

## Reproduction Commands

Builds that currently pass:

```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" -File .\scripts\build-native.ps1 -Configuration Debug -Target rofl_core_cli
& "C:\Program Files\PowerShell\7\pwsh.exe" -File .\scripts\build-wasm.ps1 -Configuration Release
npm run typecheck --workspace @lra/web
& "C:\Users\User\.vite-plus\0.1.11\bin\vp.exe" build
```

Replay family scan for the primary replay:

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --scan-families-json .\replays\EUW1-7779216102.rofl --min-length 4096 --min-records 4 --top-families 8
```

Scalar lane dump for one family:

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --analyze-scalar-family-json .\replays\EUW1-7779216102.rofl --length 61917 --first-byte 0x00 --header-size 13 --stride 16 --top-slots 18
```

Movement-family analysis for comparison:

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --profile-position-slots .\replays\EUW1-7779216102.rofl --length 53970 --first-byte 0xD2 --header-size 2 --stride 16 --top-slots 40 --move-epsilon 25 --smooth-threshold 800
```

## Suggested Prompt For Another AI

Use something like this:

```text
You are continuing reverse-engineering work on a local-first League of Legends replay analyzer.

Read these files first:
- docs/ai-analysis-handoff-2026-03-20.md
- docs/replay-format-notes.md
- packages/rofl-core/src/replay_analyzer.cpp
- apps/web/src/replayScalarCorrelation.ts
- replays/api/EUW1_7779216102/match.json
- replays/api/EUW1_7779216102/timeline.json

Key context:
- Movement decoding for EUW1-7779216102.rofl is still weak under the current float-pair model.
- Scalar lane matching is now producing stronger evidence than movement.
- The strongest current family for player-state semantics is 61917 / 0x00.
- 39064 / 0x98 and 28928 / 0x4B also look promising.
- The dominant 53970 / 0xD2 family still looks like broad world/entity state but not yet clean champion movement.

Your task:
1. infer whether 61917 / 0x00 contains a participant table
2. identify likely player rows and stable slot-to-player assignment
3. determine which lanes best map to gold/xp/cs/level/health/power
4. only after that, investigate whether nearby lanes in the same rows decode to positions under a different numeric transform

Prefer a data-driven approach using the local Riot fixture bundle as ground truth.
Avoid assuming the current movement decoder is correct.
```

## Bottom Line

The main new result is that we can now automatically find stat-like replay lanes, and those lanes are more convincing than the current movement candidates.

If another AI is going to make real progress quickly, it should stop treating movement extraction as the only gateway and should instead:
- lock down player-state tables first
- use multi-metric participant assignment
- then return to movement with stronger row identity and timing priors
