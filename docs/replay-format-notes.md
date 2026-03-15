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

- search for a different payload directory/index structure in the footer-style file
- inspect the regions around early compression-signature hits as possible payload/container boundaries
- avoid assuming the classic `payload_offset -> 17-byte table -> segment bytes` layout exists in this replay era

## Classic Segment Table Layout

When the classic header path validates, the parser reads segment headers as 17-byte entries:

- `0..3`: segment id (`u32`)
- `4`: segment type (`u8`) where `1 = chunk`, `2 = keyframe`
- `5..8`: encrypted segment length (`u32`)
- `9..12`: associated chunk id (`u32`, keyframes only)
- `13..16`: data offset relative to the end of the segment header table (`u32`)

`rofl-core` currently exposes those fields in normalized form but does not decode segment payloads yet.

## Current Boundary

What is implemented now:

- metadata extraction
- player stats extraction from `statsJson`
- classic header parsing when it validates
- classic payload header parsing when it validates
- classic segment table parsing when it validates
- footer-size metadata recovery for newer files like the local sample

What is not implemented yet:

- payload decryption
- payload decompression
- packet decoding
- movement/event timeline extraction

## Confidence Levels

High confidence:

- footer-size metadata recovery on the local sample
- classic 288-byte header field meanings from reference implementations
- classic segment table structure

Lower confidence / still needs verification:

- whether all post-14.11 files use the same footer convention
- where newer files store payload-header-equivalent information, if at all
- whether payload compression is uniformly gzip/zlib after decryption across replay eras

