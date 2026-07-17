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
