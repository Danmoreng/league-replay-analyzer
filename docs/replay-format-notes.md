> Note: use `docs/decoder-status.md` for the latest decoder state. This file is for more stable format and container notes.

# Replay Format Notes

## Verified So Far

The current parser supports two metadata-discovery paths:

1. `classic-rofl`
   - Matches the documented 288-byte header layout used by older `.rofl` files.
   - Header fields used by `rofl-core`:
     - `262`: header length (`u16`, expected `288`)
     - `268`: metadata offset (`u32`)
     - `272`: metadata length (`u32`)
     - `276`: payload header offset (`u32`)
     - `280`: payload header length (`u32`)
     - `284`: payload/segment-table offset (`u32`)
   - If those fields validate, the parser reads the classic payload header and segment table.

2. `rofl2-like-footer`
   - Used when the classic 288-byte header layout does not validate.
   - The parser reads the last 4 bytes as a little-endian metadata length and then reads that many bytes immediately before the footer.
   - This path is verified against the local replay fixture `replays/EUW1-7779216102.rofl`.

## Verified Local Sample

For `replays/EUW1-7779216102.rofl`:

- file size: `15,013,275`
- metadata source: `footer-size`
- metadata offset: `14,903,687`
- metadata size: `109,584`
- footer bytes: `10 AC 01 00` (`109,584` little-endian)
- game version leak near file start: `16.5.752.7101`

That means:

- `metadata_offset = file_size - 4 - metadata_size`
- `14,903,687 = 15,013,275 - 4 - 109,584`

This is a concrete, validated relationship, not a hypothesis.

## Native Probe Findings

Running the native CLI probe against `replays/EUW1-7779216102.rofl` currently reports:

- classic header valid: `no`
- classic payload header valid: `no`
- footer metadata valid: `yes`
- parser summary available: `yes`
- timeline hints from metadata: `gameLengthMillis = 1,895,012`, `lastGameChunkId = 66`, `lastKeyFrameId = 32`
- payload capabilities: `segmentTable = yes`, `payloadDecoding = yes`

The raw classic header words at the legacy offsets are effectively garbage for this sample:

- `headerLength = 55094`
- `fileLength = 986342294`
- `metadataOffset = 2350193029`
- `metadataLength = 2421270161`
- `payloadHeaderOffset = 3605654821`
- `payloadHeaderLength = 3076487740`
- `payloadOffset = 3068108477`

That is useful negative evidence: the newer sample is not just a classic header with one or two changed fields.

The first generic 17-byte segment-table scan also returned `0` candidates in the live sample. That does not prove the newer replay has no index; it does prove that a naive search for the classic segment-table shape is not enough.

Implication for the next parser step:

- keep the footer-style record indexing path; it is now validated
- inspect decompressed startup, keyframe, and chunk payloads for packet/frame structure
- avoid assuming the classic `payload_offset -> 17-byte table -> segment bytes` layout exists in this replay era
- if nested zstd frames appear inside decompressed chunk payloads, explicitly test skippable-frame and seek-table interpretations before assuming a custom wrapper

## Footer-Style Zstd Record Layout

The local sample now exposes a stable pre-metadata record chain that `rofl-core` can index and decompress without decrypting payloads.

Observed record shape:

- 17-byte header immediately before each zstd frame
- byte `0`: record id
- bytes `1..3`: zero padding
- byte `4`: related chunk id
- bytes `5..7`: zero padding
- byte `8`: record kind
  - `1 = chunk`
  - `2 = keyframe`
  - `3 = startup`
- bytes `9..12`: uncompressed length (`u32`, little-endian)
- bytes `13..16`: compressed length (`u32`, little-endian)
- bytes `17..`: payload beginning with zstd frame magic `28 B5 2F FD`

Verified on `replays/EUW1-7779216102.rofl`:

- `97` indexed records before the metadata block
- `1` startup record
- `32` keyframe records
- `64` chunk records
- startup ends at chunk `2`
- first regular game chunk is `3`
- highest chunk record id is `66`
- highest keyframe record id is `32`

This matches the replay metadata closely enough to treat the record chain as real container structure, not accidental magic-byte hits.

Decompressed payload verification on the local sample:

- startup record `1` decompresses to `12,919` bytes
- keyframe record `1` decompresses to `122,737` bytes
- chunk record `3` decompresses to `259,623` bytes
- all three were verified through `rofl_core_cli --probe` on `2026-03-15`
- the decompressed bytes are still opaque binary payloads, not yet decoded gameplay events

What this gives us now:

- absolute header offsets for each footer-style record
- absolute payload offsets for each zstd frame
- compressed and uncompressed lengths for each record
- startup / chunk / keyframe classification
- keyframe-to-chunk association through the related chunk id field
- raw decompressed byte streams for native inspection

What it does not give us yet:

- packet schema / opcode meaning
- timestamped movement extraction
- event timelines or full state reconstruction

## Classic Segment Table Layout

When the classic header path validates, the parser reads segment headers as 17-byte entries:

- `0..3`: segment id (`u32`)
- `4`: segment type (`u8`) where `1 = chunk`, `2 = keyframe`
- `5..8`: encrypted segment length (`u32`)
- `9..12`: associated chunk id (`u32`, keyframes only)
- `13..16`: data offset relative to the end of the segment header table (`u32`)

`rofl-core` currently exposes those fields in normalized form but does not decode classic segment payloads yet.

## Riot API Correlation Findings

On March 15, 2026, we compared the local replay corpus directly against official Match-V5 and timeline fixtures.

High-confidence matches across the current seven-replay corpus:

- replay `gameLengthMillis` stays within `14` to `502` ms of Match-V5 `gameDuration * 1000`
- replay metadata player summaries match Match-V5 exactly for champion, team, team position, Riot ID, K/D/A, total damage to champions, vision score, and win/loss across all `70` participants checked
- replay `goldEarned` is almost the same as Match-V5 but not perfectly identical: `40 / 70` exact, `29 / 70` at `-1`, and `1 / 70` at `-2` when computed as `replay - API`
- official timeline `frameCount` equals replay `keyframeCount + 1` on all seven replays
- every checked keyframe record satisfies `keyframe.chunkId = 2 * keyframe.id + 1`
- every checked chunk record satisfies `chunk.chunkId = chunk.id + 1`, which means metadata `lastGameChunkId` matches the highest chunk record `id`, not the highest normalized `chunkId` exposed by the parser; across the current corpus, the highest normalized `chunkId` is always `lastGameChunkId + 1`

This strongly suggests a time model for newer footer-style files:

- keyframes align to the official timeline frame boundaries, with replay keyframe `1` corresponding to timeline frame `0`
- chunk records behave like approximately `30` second delta windows between those minute snapshots
- the final replay chunk parity matches the final official timeline interval length: replays with a tail shorter than `30` seconds end on an odd `lastGameChunkId`, while longer tails keep the second half-minute chunk

Practical implication for decoding:

- when the API shows a dragon, baron, herald, tower, or kill cluster at time `T`, inspect the replay chunk whose half-minute window covers `T` before scanning neighboring chunks
- use replay metadata `statsJson` as a stable bridge for player ordering and identity, but do not assume `goldEarned` is a perfect byte-for-byte copy of Match-V5
- raw chunk size is only a weak semantic signal overall, although compressed chunk size has a moderate corpus-level correlation with champion kills (`r ~= 0.37`)

This does not decode payloads yet, but it gives us a reliable time-alignment layer for subrecord-family work.

## Current Boundary

What is implemented now:

- metadata extraction
- player stats extraction from `statsJson`
- classic header parsing when it validates
- classic payload header parsing when it validates
- classic segment table parsing when it validates
- footer-size metadata recovery for newer files like the local sample
- footer-style zstd record indexing
- raw zstd decompression of indexed footer-style records

What is not implemented yet:

- packet decoding
- semantic event extraction
- movement/event timeline extraction

## Initial Decompressed Payload Heuristics

Using `rofl_core_cli --inspect` on `replays/EUW1-7779216102.rofl`:

General observations:

- startup record `1` is `12,919` bytes and is unusually printable for binary data (`45.0%`), but it does not show a convincing simple `u16`-length framing
- keyframe record `1` is `122,737` bytes with a high zero-byte ratio (`23.5%`), which suggests dense binary state data rather than text-like payloads
- startup and keyframe payloads do not currently look like the same layout as later chunk payloads
- a naive `u32` framing candidate appears in the startup record, but it is almost certainly a false positive because it degenerates into one tiny record plus one file-sized record

Chunk observations:

- chunk record `3` is `259,623` bytes and does not show a useful simple `u16` or `u32` framing pattern
- chunk record `4` is `341,891` bytes and the heuristic scanner found a strong `u16` little-endian length-prefixed candidate from offset `0` covering `336,397 / 341,891` bytes across `9` records
- chunk record `5` is `1,377,638` bytes and shows an even stronger `u16` little-endian candidate from offset `0` covering `1,364,148 / 1,377,638` bytes across `33` records
- chunk record `6` is `1,484,890` bytes and shows the same pattern, but starting at offset `1`, covering `1,443,920 / 1,484,890` bytes across `33` records

Subrecord observations from those chunk candidates:

- chunks `5` and `6` contain many large candidate subrecords clustered around `53,970` bytes
- chunk `4` also contains multiple large candidate subrecords, including `53,970`, `64,836`, `47,277`, and `23,526` byte regions
- the repeated `53,970`-byte size across multiple adjacent chunks is unlikely to be random noise and suggests a real internal chunk payload structure
- chunk `6` requiring a start offset of `1` may indicate a one-byte flag or discriminator before the concatenated subrecords begin
- the subrecord payloads are still opaque binary blobs; repeated size alone does not yet identify them as packets, frames, or entity streams

Current interpretation:

- later chunk payloads likely contain concatenated subrecords with a length-prefixed binary framing layer
- startup and keyframe records likely use a different higher-level layout, or they contain state/bootstrap blobs that are not packetized in the same way
- the next useful decoder step is to parse these candidate chunk subrecords consistently and compare their leading bytes across several neighboring chunks to find repeated headers, counters, timestamps, or entity identifiers

These are still heuristics, not a verified packet schema, but they are strong enough to justify building the next inspection layer around chunk-subrecord extraction.

Methodological note:

- future chunk inspection tooling should prefer deterministic JSON summaries, family hashes, and corpus-level comparisons over console-only dumps
- regression fixtures for extracted subrecord families will be more valuable than synthetic-only tests once a family-level decoder starts to stabilize

## Confidence Levels

High confidence:

- footer-size metadata recovery on the local sample
- classic 288-byte header field meanings from reference implementations
- classic segment table structure
- footer-style zstd record indexing on the local sample
- raw zstd decompression of indexed footer-style records on the local sample

Lower confidence / still needs verification:

- whether all post-14.11 files use the same footer convention
- whether all newer files use this same 17-byte zstd record header layout
- the meaning of the decompressed payload bytes across patches
- where packet opcode and field mappings diverge by version


## Event-Family Correlation Update

On March 15, 2026, we reran chunk-family correlation against the local Riot API fixtures using the corrected chunk window mapping:

- first regular gameplay chunk id is `4` in `replays/EUW1-7779216102.rofl`
- event timestamps map to replay chunks as `chunkId = firstRegularChunkId + floor(timestamp / 30000)`
- the native CLI path may be `build/packages/rofl-core/rofl_core_cli.exe` under Ninja or `build/packages/rofl-core/Debug/rofl_core_cli.exe` under multi-config builds

Using the corrected `payload-pattern-hunter` flow on the local sample:

- `CHAMPION_KILL` events occur in `27` different chunks, but there is no single subrecord family that appears in every kill-bearing chunk while being absent from the quiet baseline chunk
- `ELITE_MONSTER_KILL` and `BUILDING_KILL` show the same result: no universal event-only family across all eventful chunks
- the only family that appears in every checked kill/objective/building chunk and also in the quiet baseline is the sparse family `firstByte = 0xD2`, `length = 53,970`
- in the kill scan, that `0xD2/53,970` family appears `301` times across `27` eventful chunks and also appears `12` times in quiet chunk `6`

Implication:

- the dominant `53,970` family is not a simple one-record-per-event packet
- it behaves like recurring world-state or entity-slab data that is present in quiet and eventful windows alike
- chunk semantics are likely mixed: each chunk contains several subrecord families, and visible gameplay events probably emerge either from smaller chunk-local families or from state transitions inside the recurrent sparse slabs

This is the strongest current answer to what later chunk payloads represent:

- not a flat event log with one stable kill/objective opcode family
- more likely a bundle of heterogeneous state/update records, where the sparse fixed-size families carry broad world/entity state and other families carry additional specialized delta data

## Working Interpretation And Next Step

As of March 15, 2026, the current evidence is more consistent with stored spectator-style state and delta data than with a compact stream of raw player inputs:

- the dominant sparse family recurs in quiet and eventful windows alike
- its body looks like a fixed-capacity slot table with mixed float-like and non-float-like lanes
- chunk timing aligns cleanly with replay timeline windows and keyframe boundaries
- no single universal kill/objective family has appeared across all eventful chunks

That does not prove player inputs are absent, but inputs do not currently look like the primary payload layer we have identified.

The decoding focus should therefore be:

1. rank sparse slots by coordinate-like smooth motion across adjacent records
2. group those slots into coarse classes by lane pair, dominant first byte, and lane mask
3. compare the best candidates against champion counts, ward timing, and objective windows
4. use keyframes as minute-boundary anchors to separate baseline state from half-minute deltas

This direction is now backed by the native slot profiler command:

- `rofl_core_cli --profile-position-slots <path> --length 53970 --first-byte 0xD2 --header-size 2 --stride 16`
- `rofl_core_cli --compare-position-classes <path> --length 53970 --first-byte 0xD2 --header-size 2 --stride 16`

That command is intended to surface candidate position/state slots before we try to assign specific semantic identities such as champion, ward, missile, or minion.



## Cross-Patch Sparse Family Comparison

On March 16, 2026, we ran the native position-class comparer across representative local replays from five replay versions:

- `15.22.724.5161` via `replays/EUW1-7596231295.rofl`
- `15.23.728.3286` via `replays/EUW1-7617298409.rofl`
- `15.24.733.6673` via `replays/EUW1-7648140653.rofl`
- `16.1.737.4870` via `replays/EUW1-7678536418.rofl`
- `16.5.752.7101` via `replays/EUW1-7779216102.rofl`

The first important negative result is that the previously useful `16.5` sparse family is not portable:

- `length = 53,970`, `firstByte = 0xD2`, `headerSize = 2` produced strong results on `16.5`
- the same family produced `0` matching records on the checked `15.22`, `15.23`, `15.24`, and `16.1` samples

That means the sparse world/entity slab hypothesis survives, but the exact subrecord family carrying that slab is version-sensitive.

### Large Recurring Families Found Per Version

Using real chunk-subrecord dumps rather than the lower-level heuristic `--inspect` framing output, the large recurring families that actually exist in each sample were:

- `15.22`: `firstByte = 0x41`, `length = 16,705`
- `15.23`: `firstByte = 0xA8`, `length = 43,176`
- `15.24`: `firstByte = 0xFE`, `length = 65,278`
- `16.1`: `firstByte = 0xC2`, `length = 49,858`
- `16.5`: `firstByte = 0xD2`, `length = 53,970`

Not all large families are equally useful:

- some are analyzable sparse tables with smooth multi-slot motion
- some are mostly repeated-fill slabs that the comparer can scan but that do not yield useful candidate classes

### Results By Patch

`15.22` on `0x41 / 16,705`:

- the strongest classes were only `5`, `5`, and `4` slots
- all top classes remained `mixed state candidate`
- this does not look like a clean persistent 10-entity class

`15.23` on `0xA8 / 43,176`:

- the comparer produced useful output
- strongest classes were `13`, `13`, and `6` slots
- these behaved like a real sparse table, but less cleanly than later versions

`15.24` on `0xFE / 65,278`:

- this was the strongest pre-`16.x` result
- best classes were `11`, `12`, `8`, `15`, and `16` slots
- this is consistent with a persistent state slab that can produce champion-like class sizes

`16.1` on `0xC2 / 49,858`:

- the family was analyzable, but the output was noisier
- nearest class was `11` slots, with broader mixed-state classes around it
- motion looked more mobile and less cleanly separated than `16.5`

`16.5` on `0xD2 / 53,970`:

- still the cleanest sample so far
- strongest classes remained `9`, `11`, and `7` slots
- this is still the best evidence that one sparse family is carrying broad entity/world state rather than event-only packets

### Interpretation

Cross-patch comparison strengthens two conclusions:

- the replay payload is still better explained as version-specific spectator/state-delta transport than as a stable event packet stream
- the broad sparse-slot-table idea appears to survive across patches, but the concrete family signature changes by version

So the current problem is no longer just `decode 0xD2 / 53,970`. The real problem is:

1. find the candidate sparse families for a given replay version
2. rank them by smooth-motion and persistence
3. run slot-class comparison only on the best families
4. then try to separate champion-like classes from wards, minions, missiles, and broader mixed world state

### Updated Workflow

The manual cross-patch pass showed that one hard-coded `length / firstByte / headerSize` triple is not enough for corpus work.

The next tooling step should therefore be an automated family-discovery pipeline:

1. dump chunk subrecords for representative chunks in the replay
2. identify large recurring families that appear across many chunks
3. reject obvious filler-only slabs
4. rank surviving families by coordinate-like smooth motion and slot persistence
5. run `--compare-position-classes` only on the top candidates

This is now the recommended path for batch-scanning the local replay corpus. The earlier `0xD2 / 53,970` workflow should be treated as a successful version-specific case study, not as a universal replay-era invariant.
