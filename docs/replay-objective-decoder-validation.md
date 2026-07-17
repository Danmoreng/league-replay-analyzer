# Replay objective decoder validation

The native parser has a replay-only decoder for `ELITE_MONSTER_KILL` events.
Runtime extraction receives only `.rofl` bytes. Saved Riot timeline fixtures are
used after extraction as offline labels; they are not decoder inputs.

## Reproduce the corpus check

```powershell
.\scripts\build-native.ps1 -UseNinja -Target rofl_core_cli
node .\scripts\validate_replay_objectives_corpus.mjs
```

The validator writes
`artifacts/replay-objectives-corpus-validation.json` and fails with a non-zero
exit code unless all of these conditions hold:

- 47 replay/API fixture pairs are checked.
- all 425 timeline `ELITE_MONSTER_KILL` events have a replay-derived match.
- timestamp delta is at most 1 ms.
- monster class matches after normalizing Riot `RIFTHERALD` to the runtime
  `RIFTHERALD` label.
- there are zero extra replay events, zero missing timeline events, and zero
  unknown monster classes.
- packet framing is exact for every selected chunk.

## Validated patch profiles

| Patch | Channel/type | Accepted lengths | Exact events |
|---|---:|---:|---:|
| 15.22 | 1 / `0x02DE` | 126 | 22 |
| 15.23 | 1 / `0x026E` | 126–127 | 14 |
| 15.24 | 1 / `0x00FF` | 126–127 | 8 |
| 16.1 | 1 / `0x03C3` | 126–127 | 19 |
| 16.5 | 1 / `0x0328` | 126–127 | 9 |
| 16.6 | 1 / `0x00F2` | 126–127 | 103 |
| 16.7 | 1 / `0x03AE` | 126–127 | 74 |
| 16.9 | 1 / `0x01EB` | 132–133 | 176 |

The packet type is reused by unrelated short messages. Type/channel matching
alone is therefore insufficient. The runtime decoder must reject blocks outside
the profile length bounds and must emit an event only when the patch-specific
monster classifier returns a known class. A pre-filter audit produced 983 type
candidates: 425 exact objective events and 558 short, unclassified non-events.
This is why the validator explicitly enforces zero extras and zero unknowns.

## Monster classifiers

- 15.22: `payload[124]` — Dragon 149, Atakhan 103, Baron 241, Herald 82,
  Horde 126.
- 15.23: `payload[1]` — Dragon 108, Atakhan 134, Baron 114, Herald 47,
  Horde 42.
- 15.24: `payload[122]` — Dragon 43, Atakhan 62, Herald 247, Horde 198.
- 16.1: `payload[122]` — Dragon 111, Baron 178, Herald 204, Horde 170.
- 16.5: length 127 means Horde; for length 126, `payload[3]` identifies
  Dragon 184, Baron 30, or Herald 222.
- 16.6: `payload[122]` — Dragon 255, Baron 12, Herald 199, Horde 31.
- 16.7: `payload[1]` — Dragon 71, Baron 42, Herald 8, Horde 170.
- 16.9: `payload[2]` — Dragon 69, Baron 172, Herald 118, Horde 123.

Every payload access is guarded by the accepted content-length range and a
discriminator-offset bounds check. Candidate, length-rejected, unknown-class,
and emitted-event counts are kept separate in diagnostics.

## Current semantic boundary

The decoder safely promotes objective timestamp and coarse monster class.
Elemental dragon subtype, killer participant, and killer team remain `null`.
Those fields must not be inferred from timeline fixtures or from timestamp-only
correlations. Future promotion requires replay-only payload evidence and a new
corpus validation gate.
