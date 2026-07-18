# Exact keyframe champion-state discovery (patch 16.9)

## Result

The replay packet framing and champion ownership are exact, but none of the raw scalar or bit-packed candidates in the three tested packet families is ready to become a runtime state decoder.

Across two independent patch `16.9` replays, the scan found no direct exact validation match and no correlation candidate that survived a stricter first-difference gate. Several fields in `0x0442` correlate strongly with monotonic match progression, but they do not track the minute-to-minute changes of the proposed semantic label. They are progression proxies, not decoded level, gold, CS, health, damage, or KDA fields.

This is still useful progress: it replaces heuristic keyframe carving with exact packet families, exact participant ownership, and a reproducible negative result that identifies the next reverse-engineering boundary.

## Reproduction

The reusable scanner is [discover_keyframe_champion_state.mjs](../scripts/discover_keyframe_champion_state.mjs). It reads full payloads only through the native CLI's exact packet-block dump and does not read any legacy LE-length-prefix subrecords or keyframe slab artifacts.

```powershell
node .\scripts\discover_keyframe_champion_state.mjs `
  --replay .\replays\EUW1-7840220945.rofl `
  --timeline .\replays\api\EUW1_7840220945\timeline.json `
  --replay .\replays\EUW1-7840267452.rofl `
  --timeline .\replays\api\EUW1_7840267452\timeline.json `
  --output .\artifacts-keyframes\keyframe-champion-state-discovery-16.9.json `
  --top 12 `
  --screen-top 48 `
  --probe-frames 5
```

The Riot timeline files are validation labels only. Runtime ownership comes from the replay-native, kill-derived patch `16.9` champion network-ID base and each exact packet's `blockParam`.

## Exact packet-family evidence

| Packet family | Replay 7840220945 | Replay 7840267452 | Content length | Exact conclusion |
| --- | ---: | ---: | --- | --- |
| `0x0442` | 290 blocks / 29 keyframes | 320 blocks / 32 keyframes | always 1451 bytes | exactly one block for each of 10 champions in every keyframe |
| `0x0165` | 290 / 29 | 320 / 32 | 79–272 / 79–278 bytes | exactly one block for each champion; variable-length serialization |
| `0x01F0` | 290 / 29 | 320 / 32 | 73–90 / 73–87 bytes | exactly one block for each champion; participant-specific fixed lengths within a replay |

All six packet dumps pass exact framing. All `1,830` selected blocks have full, untruncated payloads. Timeline alignment is at most `1 ms` in both games. There are no missing owners, duplicate champion owners, or non-champion blocks in these families.

Every participant payload changes at every consecutive keyframe. The amount of change differs substantially by family:

| Packet family | Replay 7840220945 changed bytes per transition | Replay 7840267452 changed bytes per transition |
| --- | ---: | ---: |
| `0x0442` | average 58.9, range 4–97 | average 63.2, range 6–106 |
| `0x0165` | average 78.3, range 11–260 | average 79.1, range 12–264 |
| `0x01F0` | average 8.3, range 1–16 | average 7.5, range 1–18 |

This confirms that the blocks carry changing keyframe state. It does not establish what serialization grammar or semantic component each packet represents.

## Scan and validation method

For every exact champion-owned block, the scanner aligns the same participant to the nearest offline timeline frame. It then evaluates:

- byte-aligned unsigned, signed, floating-point, and `0x60`-XOR probes;
- little- and big-bit-order unsigned fields with widths from 1 through 24 bits, selected by target range;
- start-relative and end-relative fields for variable-length packets;
- non-overlapping adjacent X/Y pairs;
- common direct transforms, including powers-of-two scales, coordinate biases, and inverted bit-range encodings;
- global Pearson correlation;
- pooled within-participant correlation;
- per-replay correlation;
- within-participant first-difference correlation;
- correlation with keyframe time to expose monotonic progression confounds;
- affine error, direct-transform RMSE, and maximum direct error.

Targets include X/Y, health/max health, power/max power, current/total gold, level, XP, lane/jungle/total CS, damage totals, replay-native cumulative kills/deaths/assists, dead/recently-killed state, and an offline frame-level respawn transition label.

The promotion rule is deliberately strict. A semantic field must either match every aligned label through a direct transform in both replays, or retain strong correlation after taking consecutive within-participant differences. A high raw correlation with elapsed match time is not sufficient.

## Semantic findings

No candidate survives that promotion rule.

The strongest-looking `0x0442` candidates demonstrate why first differences matter:

| Proposed label | Candidate | Global r | Within-participant r | First-difference r | Within-participant time r | Direct RMSE | Assessment |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| max health | `start+364b`, little `u11` | -0.814 | -0.829 | 0.006 | -0.849 | 603.6 | progression proxy |
| total gold | `start+3875b`, little `u20` | -0.760 | -0.768 | -0.021 | -0.757 | 2996.1 | progression proxy |
| level | `start+369b`, little `u6` | -0.875 | -0.871 | -0.037 | -0.850 | 2.7 | progression proxy |
| lane CS | `start+529b`, big `u10` | -0.904 | -0.842 | -0.153 | -0.690 | 40.5 | progression proxy |
| jungle CS | `start+623b`, little `u6` | 0.934 | 0.879 | 0.235 | 0.415 | 22.4 | progression proxy |
| cumulative kills | `start+760b`, little `u5` | 0.819 | 0.789 | 0.341 | 0.640 | 2.4 | closest change signal, still neither direct nor sufficiently stable |

The requested high-value state remains unresolved:

- **Position:** no useful X or Y field in any family. The best adjacent-pair affine distance RMSE is about `5,390–5,510` map units, with weak per-axis within-participant correlation.
- **Current health:** the strongest `0x0442` probe has only about `|r| = 0.42` and first-difference correlation near zero.
- **Current gold:** the strongest `0x0442` probe has global `r = 0.326`, within-participant `r = 0.239`, and first-difference `r` near zero.
- **Alive / respawn:** no binary field is stable across both replays. The best dead-state signal is only about `r = 0.24`; the respawn-transition signal is weaker.
- **Damage:** high correlations use the same monotonic `0x0442` neighborhood as XP/gold/CS and fail the first-difference test.
- **`0x0165`:** weaker progression correlations, dynamic lengths, and no surviving semantic field.
- **`0x01F0`:** only a few bytes change between keyframes and no tested semantic field survives replay separation or first differences.

## What this means for implementation

Do not expose any of these candidates as health, gold, level, CS, damage, KDA, alive state, or position. The exact outer packet framing is solved; the remaining blocker is the inner component/replication serialization.

The next useful step is to reverse-engineer that inner grammar, beginning with `0x0442`:

1. Diff consecutive payloads for the same participant and map the 4–106 changing bytes back to field masks, value streams, and fixed/default `0x60` regions.
2. Compare simultaneous champion blocks to separate keyframe time/header fields from participant state.
3. Identify whether changed values are bit masks plus a separately encoded value list, rather than fixed-offset scalars.
4. Use controlled transitions—death, level-up, purchase, and large position changes—to test decoded grammar elements, not raw offsets.
5. Only after the inner grammar is understood, rerun this two-replay validator and require direct or first-difference-stable agreement before adding C++/Wasm schema fields.

The exact family coverage makes that work tractable: participant identity and keyframe timing no longer need to be inferred while decoding the payload interior.

## Narrow inventory-component research anchors (patches 16.9 and 16.14)

`0x0442` now has one reproducible **research-only** anchor for the inventory
component boundary. This is not an inventory decoder and must not be surfaced in
the runtime UI, C++, or Wasm schema.

The harness [research_keyframe_inventory_anchor.mjs](../scripts/research_keyframe_inventory_anchor.mjs)
uses explicit fixed profiles. The `16.9` profile uses three saved replay/timeline pairs: two fixed discovery replays
(`EUW1-7840220945`, `EUW1-7840267452`) and the predeclared holdout
`EUW1-7840327293`. It requires exact `0x0442` framing, the replay-native
champion owner from `blockParam`, full 1,451-byte payloads, and exactly ten
champion snapshots per keyframe.

For each champion it compares consecutive snapshots and assigns saved timeline
item events for that same participant to the half-open interval
`(previousSnapshotTimestamp, currentSnapshotTimestamp]`. In the two discovery
replays, byte offset `259` changed on all `264/264` windows containing
`ITEM_PURCHASED` or `ITEM_UNDO`, and on none of the `326` negative windows. The
predeclared holdout independently reproduced the same gate: `118/118` positive
windows changed and `0/162` negatives changed. Across all three replays that is
`382/382` positives and `0/488` negatives.

The immediate `256..263` lane sharpens the boundary: purchase/undo windows have
only change masks `0x08` (byte 259) or `0x88` (bytes 259 and 263), while every
negative window has `0x00`. Pure purchase windows (no undo, sale, or destroy)
also pass exactly (`130/130`). In contrast, all 80 sale/destroy windows without
a purchase or undo leave byte 259 unchanged. `ITEM_SOLD` must not be interpreted
separately yet because the observed sale windows also overlap purchase/undo
activity.

The byte value is deliberately **not promoted**. This harness establishes only
the fixed change-presence invariant and does not contain an item-ID, slot, item
operation, count, or complete-inventory decoder.

Reproduce it with:

```powershell
node .\scripts\research_keyframe_inventory_anchor.mjs `
  --profile 16.9 `
  --output .\tmp\keyframe-inventory-anchor-16.9.json
```

The separately profiled `16.14` anchor uses exact `0x02EB` keyframe blocks with
1,479-byte payloads and byte offset `111`. Its two fixed discovery replays are
`EUW1-7919517389` and `EUW1-7919624327`; `EUW1-7921996430` was fixed as the
holdout before the offset was selected. It applies the same exact owner and
half-open timing gate. The discovery result is `229/229` positive purchase/undo
windows with zero false positives across 291 negatives; the holdout independently
is `132/132` with zero false positives across 158 negatives. The XOR masks vary
(for example `0x76`, `0x35`, and `0x44`), so this is a change-presence anchor,
not a raw value or bit-field decoder.

```powershell
node .\scripts\research_keyframe_inventory_anchor.mjs `
  --profile 16.14 `
  --output .\tmp\keyframe-inventory-anchor-16.14.json
```

There is no automatic candidate-offset selection and no custom-case override:
the fixed discovery/holdout split is part of each profile's evidence boundary.
Both profiles remain research-only until a deterministic replay-native inventory
grammar and semantic validation establish item identities and transitions.

## Patch-16.14 economy change anchors

The maintained harness
[research_keyframe_economy_anchors_16_14.mjs](../scripts/research_keyframe_economy_anchors_16_14.mjs)
adds bounded replay/Timeline **change-correlation** research inside
champion-owned `0x02EB` keyframes. It
uses the ten fixed patch-16.14 replay/timeline pairs, exact 1,479-byte payloads,
exact replay-native champion ownership, exactly ten owners per keyframe, and a
predeclared seven-replay discovery / three-replay holdout split.

The `totalGold` result is explicitly post-hoc and non-unique, not a semantic or
component boundary: its artifact records `fieldBoundaryAvailable: false`,
`nonUnique: true`, and `postHoc: true`. Changing either byte at offsets `109`
or `119` identifies every saved Timeline `totalGold` change and no unchanged
transition:

| Split | Changed / true change | Changed / no change | Unchanged / true change | Unchanged / no change |
|---|---:|---:|---:|---:|
| discovery | 2,043 | 0 | 0 | 57 |
| holdout | 981 | 0 | 0 | 19 |

That is an exact `3,024`-positive / `76`-negative correlation, not a gold-value
decoder or field boundary. The post-hoc pair has Discovery `2,043/0/0/57` and
frozen-Holdout `981/0/0/19` TP/FP/FN/TN. To measure non-uniqueness without
selecting from H3, a bounded `96..128` Discovery-only search allows unions of
at most three bytes. Its minimum exact unions are `109,119`, `115,119`, and
`117,119`; all three reproduce the same exact Holdout matrix after the
Discovery result is frozen. The former `115,117,119` correlation is exact but
is a non-minimal superset. The all-corpus leave-one-replay-out stability
diagnostic finds the same three minimal pairs on every nine-replay training
fold and each is exact on its held replay. These checks are not independent
holdout evidence. A direct big-endian packing of `109,119` matches `0/3,100`
values; its delta matches only 58 Discovery and 19 Holdout transitions, so it
is not a numeric state or delta decoder. Other value grammars remain open.

The nearby lane-CS change envelope is also exact, but it remains strictly
non-numeric. Any changed byte at offsets `125`, `127`, or `129` marks
every saved Timeline `minionsKilled` change and no unchanged transition:

| Split | Changed / true change | Changed / no change | Unchanged / true change | Unchanged / no change |
|---|---:|---:|---:|---:|
| discovery | 1,458 | 0 | 0 | 642 |
| holdout | 697 | 0 | 0 | 303 |

The original `127..129` range missed one discovery and two holdout changes.
All three are the same adjacent-component form: byte `125` alone changes
(`0x0e -> 0xe8`) while `127` and `129` remain unchanged. The asserted
witnesses are Discovery `EUW1-7920292147`, participant 3, segments 38→39,
lane CS 280→281; and Holdout `EUW1-7921482297`, participants 3 and 8,
segments 46→47, lane CS 360→361 and 268→269. Byte `125` changes on 24
positive / 0 negative discovery transitions and 32 / 0 holdout transitions;
the p125-only form is exactly 1 / 2. Byte 128 changes in none of the 3,100
transitions and is retained only as a local-layout diagnostic, not in the
change envelope or numeric packing test.

A bounded `120..140` selector run on the seven Discovery replays chooses the
minimal ordered set `127`, `129`, then `125` and reproduces the same exact
confusion matrix on the three fixed Holdout replays. This is a reproducible
Discovery→Holdout check, **not** historical unseen-holdout evidence: p125 was
identified by a full-corpus mismatch audit before this gate was added. The
separate all-corpus leave-one-replay-out selector chooses the same three bytes
on every nine-replay fold and remains exact on each held replay; that is
cross-validation, not additional holdout-isolated evidence.

The lane-CS result is a change correlation only. A bounded `120..140`
Discovery-only minimum-union search finds exactly one minimum union:
`125,127,129`; it reproduces the same exact matrix in H3. The direct packing
and packed delta still reproduce `0/3,100` lane-CS values and only the 945
unchanged transitions respectively, so neither is a lane-CS state, delta, or
last-hit decoder. Jungle offsets `134..137` remain a negative control with ten
false positives (8 discovery, 2 holdout). No numeric CS field is normalized.

```powershell
node .\scripts\research_keyframe_economy_anchors_16_14.mjs
```

The artifact remains `researchOnly: true`, `promotionGate: false`, and
`runtimeInput: false` (`rofl-keyframe-economy-anchors-research/v3`). No gold
or CS state reaches C++, Wasm, or the browser.

### Bounded scalar and discrete-event falsifications

A follow-up scalar audit fixes the candidate family before evaluation: every
start offset `90..160`, stride-two logical width `2..8`, unsigned integer and
Float32/Float64 interpretation in both byte orders, raw delta, and one
Discovery-calibrated whole-value XOR or additive mask. Across 1,126 candidates,
none is exact on D7. H3 is read only for the frozen D7 rankings and weakens them
further. In particular, adding the next logical byte does not complete a
plaintext scalar:

- `totalGold` bytes `115,117,119,121`: `0/2,170` direct D7 matches and
  `0/2,043` changing-delta matches; H3 is `0/1,030` and `0/981`;
- lane-CS bytes `125,127,129,131`: `0/2,170` direct and `0/1,458`
  changing-delta D7 matches; H3 is `0/1,030` and `0/697`;
- jungle-CS bytes `135,137,139,141`: `0/2,170` direct D7 matches and only
  `1/367` changing-delta matches; H3 is `0/1,030` and `0/183`.

The full bounded stride search's best changing-delta counts are only `3/2,043`
for total gold, `11/1,458` for lane CS, `3/367` for jungle CS, `42/964` for
level, `1/1,931` for XP, and `2/2,100` for current gold. Their frozen H3 counts
are `0/981`, `5/697`, `0/183`, `20/430`, `0/939`, and `0/998`. The logical
lanes are therefore not static plaintext scalars under this family; the next
hypothesis must operate at the stateful record/replication level.

Separate packet-count audits also reject simple champion-owner event streams.
For lane CS, 42,387 type/length/prefix signatures from 71 portable, bounded
chunk families produce no exact D7 count stream; the frozen top 20 also fail
H3, including zero-CS and compound-increment checks. An expanded pass over all
channels, 257..2,048-byte payloads, and families without a champion in the
catalog top set finds 91 portable groups, but only one has any champion blocks
and it has only 20, below the frozen minimum support of 50. For jungle CS,
3,134 tokens and 2,853 fixed count/multiplicity equations from 65
champion-owner-safe families produce no exact D7 candidate. The best frozen
comparison (`type 210`, length 22, `count * 4`) matches only `192/367` positive
D7 intervals and adds 491 no-change false positives; H3 is likewise non-viable.

An initial non-champion-owner audit covers 5,760 distinct `blockParam` values
across 14 structurally selected short packet families. Repeated packet shapes
exist, but owner values recur across replays and their first/last observations
are neither explicit create/delete operations nor uniquely attributable to a
champion or camp. This does not rule out monster-owned state; it establishes
that a real operation/record grammar with parent or owner references must come
before using these values as entity identities.
