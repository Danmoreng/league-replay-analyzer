# Cross-Patch Keyframe CS Decoder

## Product boundary

`rofl-replay-participant-stat-snapshots/v4` exposes scrub-time lane and
neutral/jungle CS for every exact replay build represented by the saved
57-replay corpus. Runtime input is the loaded `.rofl` plus the canonical local
external decoder profile. Saved Riot Timeline fixtures are offline validation
labels only.

All historical profiles now emit separately validated replay-native XP and
derived level. Historical `totalGold` remains `null`; exact build
`16.14.794.5912` retains its cumulative-total-gold field. Current spendable
gold remains unavailable. See `keyframe-xp-vitals-cross-patch.md` for the XP
promotion gate and the bounded health/resource negative result.

## Supported exact builds and layouts

| Patch group | Exact builds | Packet / length | Lane-CS offsets | Jungle-CS offsets |
| --- | --- | --- | --- | --- |
| 15.22 | `15.22.724.5161` | `0x0005` / 1,215 | `[1154,1153,1152,1151]` | `[1150,1149,1148,1147]` |
| 15.23 | `15.23.728.3286` | `0x0035` / 1,291 | `[123,125,127,129]` | `[131,133,135,137]` |
| 15.24 | `15.24.733.6673` | `0x0022` / 1,291 | `[123,125,127,129]` | `[131,133,135,137]` |
| 16.1 | `16.1.737.4870` | `0x0094` / 1,295 | `[123,125,127,129]` | `[131,133,135,137]` |
| 16.5 | `16.5.752.7101` | `0x0435` / 1,367 | `[1306,1305,1304,1303]` | `[1302,1301,1300,1299]` |
| 16.6 | `16.6.755.2788`, `16.6.756.0931` | `0x00DE` / 1,375 | `[1314,1313,1312,1311]` | `[1310,1309,1308,1307]` |
| 16.7 | `16.7.758.4427`, `16.7.760.9485` | `0x0445` / 1,379 | `[63,64,65,66]` | `[67,68,69,70]` |
| 16.9 | `16.9.771.8383`, `16.9.772.1032`, `16.9.772.8292` | `0x0442` / 1,451 | `[63,64,65,66]` | `[67,68,69,70]` |
| 16.14 | `16.14.794.5912` | `0x02EB` / 1,479 | `[123,125,127,129]` | `[131,133,135,137]` |

The raw cipher-to-plain permutation is patch-specific. It does not transfer
between these groups. Six families have a complete 256-symbol table. The XP
promotion further constrains the partial families: 15.24 has 240 known mappings
plus nine bounded domains, 16.5 has 249 known mappings plus six bounded domains,
and the single unresolved 16.1 mapping does not occur in any promoted stat
field. The runtime enumerates domains and emits an integer only when every
injective assignment produces the same projection. A missing domain, divergent
result, invalid value, or excessive search fails the complete snapshot stream
closed.

Jungle CS uses `floor(Float32 + 1e-5)` except for 16.9, whose frozen projection
is `floor(Float32 + 2e-5)`. Lane CS must project to an exact nonnegative integer.

## Corpus gate

The productive Native decoder was compared to every aligned Timeline frame in
all 57 saved replays:

- 16,760 / 16,760 jungle-CS snapshots exact
- 16,751 / 16,760 lane-CS snapshots exact
- the remaining nine lane-CS snapshots are monotonic replay values between the
  current and next API frame, matching the frozen same-keyframe ordering rule
- XP is 16,746 exact plus 14 accepted ordering boundaries; level is 16,759
  exact plus one accepted ordering boundary
- zero unaccepted stat mismatches, unknown emitted values, or monotonic
  regressions

Reproduce the research selection and productive corpus gate on Linux:

```bash
node scripts/research_keyframe_cs_cross_patch.mjs \
  --output tmp/keyframe-cs-cross-patch.json

node scripts/validate_replay_participant_cs_snapshots_corpus.mjs \
  build-linux/packages/rofl-core/rofl_core_cli \
  packages/rofl-core/profiles/replay-decoder-profiles.v1.json
```

`scripts/promote_keyframe_cs_cross_patch.mjs` deterministically materializes a
fully passing research report into the canonical profile asset. It refuses any
patch group whose promotion gate is false.
