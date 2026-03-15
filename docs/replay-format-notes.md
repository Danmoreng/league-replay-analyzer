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


