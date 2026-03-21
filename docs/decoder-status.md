# Replay Decoder Status

Updated: 2026-03-21

This is the canonical status document for the current replay reverse-engineering work. Use this file first when continuing decoder work.

## Current Position

The project has moved past container parsing and manual chunk inspection. The current decoder can now:

- recover recurring replay subrecord families
- analyze sparse movement-style candidates
- analyze scalar lanes against Riot participant-frame stats
- classify large 16-byte-stride slabs into schema-heavy vs non-schema rows
- mask recurring signature-like 32-bit motifs out of non-schema rows
- export cleaned field samples for correlation
- run the same family/schema/cleaned-field analysis in the web UI through Wasm

The practical conclusion is unchanged but now better supported:

- champion movement is still not reliably decoded
- player/state decoding is currently stronger than movement decoding
- the fastest path is still state-first, then movement later

## Current Replay-Only Extraction Status

The decoder now has a working offline corpus pipeline:

- per-replay artifact generation
- replay-local provisional schema inference
- version-group alias clustering across replays
- replay-only stat extraction
- offline validation against Riot timeline fixtures

The latest full corpus run on `2026-03-21` covered 7 local replay fixtures and produced:

- `133` promoted exact corpus-backed patterns from `886` ranked exact patterns
- `40` version-group alias clusters in `artifacts/corpus-schema.json`
- validated replay-only `level`, `xp`, `totalGold`, and `minionsKilled` timelines across multiple replays

Current best validated replay-only result:

- `EUW1-7779216102`: `level` for 3 participants, `totalGold` for 2, `xp` for 1, `minionsKilled` for 1

Other replays now also yield real replay-derived stat timelines, but coverage is still uneven by patch/version group.

## Current Movement Discovery Status

Movement is no longer purely speculative. The decoder now has a dedicated movement-discovery path:

- `scripts/discover_movement_candidates.mjs`
- `scripts/extract_replay_movement.mjs`
- `scripts/validate_movement_candidates.mjs`

The current movement pipeline:

- scans cleaned replay fields as candidate `x/y` pairs per slot
- fits affine transforms against Riot participant `position.x/y`
- scores pairs by axis correlation, path correlation, map-bounds ratio, and distance error
- promotes replay-local movement patterns only when the same pair recurs across multiple rows
- emits anonymous replay-derived trajectories into `artifacts/<replay-id>/extracted-movement.json`
- learns a decode-signature movement coordinate prior in `artifacts/movement-coordinate-model.json`
- learns corpus-backed movement identity priors into `artifacts/movement-identity-priors.json`
- assigns extracted trajectories to participants replay-only into `artifacts/<replay-id>/participant-movement.json`
- validates those participant-labelled tracks in `artifacts/<replay-id>/assigned-movement-validation-report.json`

Current corpus-level result from the same 7 local replays:

- `EUW1-7596620123`: `2` promoted movement patterns, `4` extracted trajectories
- `EUW1-7617298409`: `3` promoted movement patterns, `5` extracted trajectories
- `EUW1-7678536418`: `8` promoted movement patterns, `11` extracted trajectories
- other replays currently show participant-level movement matches but not enough repeated-row support for promotion

The strongest current pattern is version-sensitive and appears to live in the main `0x00` state family for several patch groups:

- `15.22`: `61894 / 0x00`
- `15.23`: `61737 / 0x00`
- `16.1`: `61733 / 0x00`

Replay-only movement identity is now partially working, but still patch-fragile:

- `EUW1-7596231295`: `2 / 2` participant-labelled movement assignments passed validation
- `EUW1-7617298409`: `1 / 3` participant-labelled movement assignments passed validation
- `EUW1-7596620123`: one near-pass (`Khazix`, normalized RMSE about `0.205`) but no passing assignments under the current threshold
- `EUW1-7678536418` and newer replays still produce trajectories, but participant-labelled validation is currently poor

Current best replay-only movement examples:

- `EUW1-7596231295`: `FiddleSticks` jungle and `Jinx` bottom from family `17068 / 0xF1`
- `EUW1-7617298409`: `Corki` bottom from family `61737 / 0x00`

The new coordinate-model audit is now in place, but it is still early:

- current model support is only `4` decode signatures
- it is being used as a soft scoring prior during movement discovery
- current support is enough to preserve good `15.22` and `15.23` fits, but not yet enough to cleanly fix weak `16.1` candidates

That is meaningful progress, but it is still not a final movement schema. The main remaining problems are:

- newer `16.1` candidates still mix good trajectory shapes with weak participant identity
- some extracted tracks are still only partially champion-like even after outlier filtering
- version-group movement priors are helping, but they are not yet strong enough to stabilize all role assignments

## What Is Actually Supported

### Stable findings

- `.rofl` container parsing, footer indexing, and zstd-backed chunk recovery are working.
- Replay metadata and embedded `statsJson` are working.
- Riot timeline fixtures are good supervision for scalar state and event windows.
- The analysis UI now uses the loaded replay buffer directly through Wasm. It no longer requires pasted CLI JSON for schema or cleaned-field inspection.

### Strong but still decoder-level findings

- `61917 / 0x00` is not a compact 10-row participant table. It partitions as `3869 x 16B` with mixed row behavior.
- `39064 / 0x98` partitions as `2441 x 16B`.
- `28928 / 0x4B` partitions as `1808 x 16B`.
- `19313 / 0xF1` partitions as `1207 x 16B`.
- Early rows in several families are descriptor/schema-heavy rather than scalar/player-state rows.
- Repeating 32-bit motifs like `0x4B710002`, `0x000200F1`, `0x00F1DD71`, `0xF14B7100`, and `0x0200F14B` are not behaving like plain row pointers or plain scalar fields.
- These motifs should currently be treated as signature-like/archetype-like packed fields, not as decoded semantics.

### What is still not proven

- a fully stable participant-to-row mapping that survives across all important families, metrics, and replays
- a fully decoded scalar field map for health/gold/xp/cs/level across every supported patch group
- replay-only champion movement extraction with stable participant identity across patch groups
- a proven ECS handle layout or row-pointer format

## Current Working Model

The best current model for the important recurring families is:

1. large mixed slabs with `16B` row stride
2. early descriptor/schema-heavy rows in some slabs
3. later rows containing a mix of signature-like packed tokens and real state bytes
4. scalar semantics more likely to live in the remaining gaps after masking signature-dominated `u32` windows

This is more defensible than either earlier extreme:

- not a flat participant table
- not a pure pointer/handle table either

## Family Summary For `EUW1-7779216102.rofl`

| Family | Working interpretation | Notes |
| --- | --- | --- |
| `61917 / 0x00` | mixed state slab | `3869 x 16B`; early rows schema-heavy; later rows mixed; still important |
| `39064 / 0x98` | relatively clean state slab candidate | `2441 x 16B`; less schema-heavy; still one of the better scalar targets |
| `28928 / 0x4B` | mixed slab with descriptor rows | `1808 x 16B`; recurring packed motifs |
| `19313 / 0xF1` | mixed slab with descriptor rows | `1207 x 16B`; recurring packed motifs |
| `53970 / 0xD2` | broad world/entity family | still not convincing as direct champion movement |

## Schema And Signature Findings

The native schema classifier and cleaner support these points:

- `61917 / 0x00`: leading rows are schema-heavy; later low rows remain relevant for decoding
- `28928 / 0x4B`: same pattern, with leading descriptor-heavy rows
- `19313 / 0xF1`: same pattern, with leading descriptor-heavy rows
- `39064 / 0x98`: cleaner under the stricter schema classifier than the other main slabs

The signature clustering and cleaned-row pipeline support this rule of thumb:

- do not probe every 4-byte window as a stat candidate
- first mask signature-dominated windows
- then probe surviving subfields and correlate those against Riot state

## Current Tooling

### Native CLI

Important commands now available in `rofl_core_cli`:

- `--scan-replay-families-json`
- `--analyze-sparse-family-json`
- `--analyze-scalar-family-json`
- `--analyze-entity-slab-json`
- `--analyze-bitfield-schema-json`
- `--analyze-clean-row-offsets-json`

### Web / Wasm

The web inspector can now run these backend paths directly through Wasm:

- family scan
- sparse family analysis
- scalar family analysis
- entity slab analysis
- bitfield schema analysis
- cleaned row-offset analysis

The deep-analysis section in the UI now uses the selected family and suggested rows automatically. No pasted JSON is required for the normal workflow.

## Recommended Workflow

For a new replay or continued work on the current replay:

1. scan families
2. analyze one family normally
3. run auto correlate for movement/scalar/participant hints
4. open backend deep analysis for the selected family
5. run schema scan
6. run cleaned field scan
7. correlate surviving cleaned fields against Riot stats
8. only return to movement once row identity and scalar timing are stronger

## Next Decoder Work

The most useful next backend steps are:

- improve cleaned-field ranking on surviving subfields, not just full aligned windows
- stabilize participant assignment across several metrics simultaneously
- improve movement candidate filtering on `16.1` families, especially `61733 / 0x00`
- strengthen movement identity priors and assignment thresholds so weak families stay unmatched instead of mislabelled
- keep using scalar/state extraction as the identity backbone for movement

The next session should begin with more replay intake:

- collect more `.rofl` files
- collect matching Riot `match.json` and `timeline.json` fixtures for each replay when possible
- rerun the full corpus pipeline before changing thresholds again

The highest-value next implementation after intake is to upgrade the movement coordinate model from sparse decode-signature priors to stronger family-aware priors per version group.

## Related Docs

Use these together with this status file:

- `docs/reverse-engineering-index.md`
- `docs/replay-format-notes.md`
- `docs/riot-api-fixtures.md`

Historical handoffs and hypothesis notes are still useful, but they are no longer the canonical status source.
