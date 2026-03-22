# Replay Decoder Status

Updated: 2026-03-22

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
- a two-pass corpus convergence loop so `corpus-schema.json` is rebuilt again after fresh extraction and validation results exist
- the scalar corpus loop now reaches a real fixed point again after the bundle transform-sample amplification bug was removed

The latest recovered corpus state on `2026-03-22` still covers 18 local replay fixtures and currently produces:

- `349` promoted exact corpus-backed patterns in the final `artifacts/corpus-schema.json`
- `128` remaining ranked exact patterns in that same final schema
- `3` promoted bundle-backed patterns and `9` remaining ranked bundle-backed patterns
- a larger latest-patch cohort with `11` local `16.6` replays
- validated replay-only `xp`, `totalGold`, `level`, `power`, `powerMax`, `healthMax`, `minionsKilled`, `jungleMinionsKilled`, and `movementSpeed` timelines across at least some replays
- a current scorecard of `40` scalar passes, `64` labelled movement passes, `349` promoted exact patterns, and `3` promoted bundle-backed patterns
- one higher overnight movement result of `40 / 68 / 349 / 3` that has not yet been reproduced deterministically from a clean rerun, so `40 / 64 / 349 / 3` is the current stable branch reference point

Current validated replay-only scalar coverage:

- `xp`: `11 / 13` participant passes
- `totalGold`: `13 / 16`
- `level`: `2 / 2`
- `power`: `6 / 9`
- `powerMax`: `1 / 1`
- `healthMax`: `1 / 2`
- `movementSpeed`: `4 / 9`
- `minionsKilled`: `1 / 1`
- `jungleMinionsKilled`: `1 / 1`
- `health`: `0 / 1`

Current strongest stable latest-patch bundle-backed scalar is now:

- `16.6 | 6912 / 0xC6 / h0 | powerMax | s14`

`16.6 | 61894 / 0x00 / h6` is still an important latest-patch exploratory slab because it carries replay-local evidence for:

- `power`
- `healthMax`
- `movementSpeed`

Important caveat:

- the final schema now promotes three bundle-backed patterns:
  - `bundle-family|16.6|61894-0x00-h6|power|s17`
  - `bundle-family|16.6|61894-0x00-h6|power|s19`
  - `bundle-family|16.6|6912-0xC6-h0|powerMax|s14`
- `6912 / 0xC6 / h0 | power` still has useful replay-local validation, but it is not yet stably promoted as its own final bundle-backed pattern
- `61894 / 0x00 / h6 | movementSpeed` is still replay-only and not schema-promoted
- bundle-family promotion now only consumes the exact extracted pattern that produced a replay metric; weak sibling bundle candidates no longer inherit validation from a stronger chosen sibling
- extraction no longer feeds weak `bundleRankedPatterns` back into selection; only bundle-promoted corpus families and replay-local bundle recommendations affect replay-only scalar extraction
- bundle-backed transform sample counts are now bounded to replay-local evidence instead of recursively re-importing corpus-level counts
- slot-cluster-aware bundle resolution for `16.6 | 61894 / 0x00 / h6` is now implemented and uses `artifacts/scalar-family-layout/16.6/61894-0x00-h6.json` as the canonical layout prior
- replay extraction now deduplicates bundle-backed selections by family, metric, and slot cluster, so a promoted cluster like `6912 / 0xC6 / h0 | powerMax | s14` does not materialize duplicate decodes in one replay
- the recovered autoresearch win improved latest-patch `61894` `power` promotion and current replay-only `movementSpeed` validation, but the movement-side gain is not fully deterministic yet
- the remaining scalar blocker is no longer family-wide slot flattening; it is ambiguous multi-slot exact evidence in a few replays plus insufficiently stable `6912` `power` promotion around `s14`

Latest replay intake that changed the corpus most:

- `EUN1-3927636043` is the strongest new scalar anchor replay:
  - passing replay-only `totalGold` on `Sion`
  - passing replay-only `minionsKilled` on `Riven`
  - passing replay-only `totalGold`, `powerMax`, and `power` on `Morgana`
- `EUN1-3927615048` adds replay-only `totalGold` and `power` on `Janna`
- `EUN1-3927662924` adds replay-only `totalGold` and `power` on `Lux`
- `EUN1-3927581495` adds a small but clean `xp` hit on `Vladimir`
- `EUN1-3927556233` currently acts mostly as negative latest-patch evidence: no validated scalar timelines survived the final rerun

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
- carries exact replay-local transform hypotheses and raw aligned samples through discovery and extraction instead of collapsing tracks to family medians
- emits anonymous replay-derived trajectories into `artifacts/<replay-id>/extracted-movement.json`
- learns movement coordinate priors in `artifacts/movement-coordinate-model.json` at several levels:
  - decode signature
  - version-group family signature
  - version-group family mapping
  - version-group family band
- learns corpus-backed movement identity priors into `artifacts/movement-identity-priors.json`
- assigns extracted trajectories to participants replay-only into `artifacts/<replay-id>/participant-movement.json`
- rebuilds participant-labelled trajectories from the exact matched hypothesis for that replay/entity instead of using a pattern-wide median transform
- validates those participant-labelled tracks in `artifacts/<replay-id>/assigned-movement-validation-report.json`

Current corpus-level result from the same 18 local replays:

- the current stable branch score is `64 / 109` passing replay-only labelled assignments
- one overnight autoresearch run reached `68 / 111`, but that movement result has not yet been reproduced deterministically from a clean rerun
- strongest current rerun examples include:
  - `EUW1-7648140653`: `7 / 8` passing assignments
  - `EUN1-3927615048`: `6 / 8`
  - `EUN1-3927110403`: `6 / 9`
  - `EUW1-7779216102`: `5 / 6`
- promotion is still sparse; most useful movement output is currently coming from replay-local ranked fallback plus identity assignment rather than broad corpus-promoted movement schemas

The strongest current pattern is version-sensitive and appears to live in the main `0x00` state family for several patch groups:

- `15.22`: `61894 / 0x00`
- `15.23`: `61737 / 0x00`
- `16.1`: `61733 / 0x00`

Replay-only movement identity is now materially better than the earlier median-based path, but it is still patch-fragile and not yet fully deterministic across repeated full reruns. Treat the current `64` passing assignments as the stable branch reference, not the unreproduced overnight `68`.

Current best replay-only movement examples:

- `EUN1-3927615048`: the best new latest-patch movement replay in this intake; enough assigned tracks now pass to keep it useful as movement evidence
- `EUN1-3927636043`: also a useful latest-patch movement replay, and it is more valuable overall because it carries strong scalar validation too
- `EUW1-7648140653`: `16.1` assignment quality is now good enough to keep most rendered tracks under the current validation gate
- `EUN1-3927135846`: still produces useful latest-patch movement evidence, but this replay remains a good example of why weak assignments should stay filtered
- `EUN1-3927556233`: useful mainly as a negative control because it still fails all labelled movement validation in the current pipeline

The coordinate-model audit is now materially more useful:

- the model now includes family-aware and family-band priors in addition to plain decode signatures
- the latest full run reduced noisy candidate counts on `15.23`, `16.1`, and `16.6` movement families
- movement fallback extraction now prefers family diversity before taking multiple windows from the same family
- that diversity rule is important on `16.6`, where strong single-row families like `51483 / 0xF1`, `58082 / 0xE2`, and `61897 / 0x00` would otherwise be crowded out by repeated aliases from one family

That is meaningful progress, but it is still not a final movement schema. The main remaining problems are:

- newer `16.6` replays still need stronger participant assignment so the good family-diverse candidates stop collapsing onto the wrong roles
- `16.1` candidates still mix good trajectory shapes with weak participant identity inside `61733 / 0x00`
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

### Offline decoder scripts

Important current scripts:

- `scripts/run_decoder_artifacts.ps1`
- `scripts/build_provisional_schema.mjs`
- `scripts/build_corpus_schema.mjs`
- `scripts/extract_replay_stats.mjs`
- `scripts/validate_extracted_stats.mjs`
- `scripts/analyze_scalar_family_layout.mjs`
- `scripts/run_decoder_corpus.ps1`

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

- continue pushing `16.6 | 6912 / 0xC6 / h0` state decoding, especially separating the stronger `power | s14` evidence from weaker nearby variants so it can survive final bundle promotion the way `powerMax | s14` now does
- split ambiguous multi-slot exact `16.6 | 61894 / 0x00 / h6 | movementSpeed` patterns before participant assignment so one replay-local winner cannot straddle both the correct late slot and a bad neighboring slot
- keep `movementSpeed` and `power` cluster-specific so bad `18/19` variants cannot drag down the stronger `12/13`, `s14`, or `16/17/18` regions again
- keep using scalar/state extraction as the identity backbone for movement
- continue improving `16.1` movement family filtering and identity assignment, especially around `61733 / 0x00`

The next session should begin with more replay intake:

- collect more `.rofl` files
- collect matching Riot `match.json` and `timeline.json` fixtures for each replay when possible
- rerun the full corpus pipeline before changing thresholds again

The highest-value next implementation is now to split ambiguous multi-slot exact `16.6 | 61894 / 0x00 / h6` patterns before assignment and extraction tie-breaking, then return to stabilizing `16.6 | 6912 / 0xC6 / h0 | power` around the same `s14` cluster that already supports `powerMax`.

## Related Docs

Use these together with this status file:

- `docs/reverse-engineering-index.md`
- `docs/replay-format-notes.md`
- `docs/riot-api-fixtures.md`

Historical handoffs and hypothesis notes are still useful, but they are no longer the canonical status source.
