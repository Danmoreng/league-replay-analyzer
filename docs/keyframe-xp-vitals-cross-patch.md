# Cross-Patch Keyframe XP and Vital-State Research

## Productive XP/level result

`rofl-replay-participant-stat-snapshots/v4` now exposes replay-native XP and
derived level for every exact build in the saved 57-replay corpus. Runtime
input is the loaded `.rofl`, its replay-embedded validated final participant
levels, and the canonical external profile. Saved Riot fixtures remain offline
validation labels and are never runtime inputs.

The XP lanes are:

| Patch group | XP offsets | Runtime projection |
| --- | --- | --- |
| 15.22 | `[1174,1173,1172,1171]` | decoded `Float32LE` |
| 15.23 | `[83,85,87,89]` | decoded `Float32LE` |
| 15.24 | `[83,85,87,89]` | invariant `floor(Float32LE)` over bounded cipher domains |
| 16.1 | `[83,85,87,89]` | decoded `Float32LE` |
| 16.5 | `[1326,1325,1324,1323]` | invariant `floor(Float32LE)` over bounded cipher domains |
| 16.6 | `[1334,1333,1332,1331]` | decoded `Float32LE` |
| 16.7 | `[43,44,45,46]` | decoded `Float32LE` |
| 16.9 | `[43,44,45,46]` | decoded `Float32LE` |
| 16.14 | `[83,85,87,89]` | decoded `Float32LE` |

The partial-cipher 15.24 and 16.5 profiles emit XP only when every injective
assignment in the frozen per-symbol domains produces the same floored integer.
A missing domain, divergent projection, invalid float, or excessive bounded
search fails the complete snapshot stream closed. No runtime inference or API
fallback exists.

Across 16,760 participant/keyframe snapshots:

- 16,746 floored XP values exactly match the same Timeline frame
- 14 are monotonic replay values between the current and next Timeline frame,
  matching the frozen same-keyframe ordering rule
- derived level matches 16,759 same-frame labels, with one corresponding
  forward-ordering boundary
- zero unaccepted XP/level mismatches, unknown emitted projections, or
  monotonic regressions

Level uses the cumulative XP thresholds already validated for 16.14. Whether
levels 19 and 20 are possible is selected only from replay-embedded validated
final participant metadata; this preserves the pre-2026 level-18 cap without a
runtime patch guess or Riot API input.

Reproduce the research and productive gate on Linux:

```bash
node scripts/research_keyframe_xp_cross_patch.mjs \
  --output tmp/keyframe-xp-cross-patch.json

node scripts/validate_replay_participant_cs_snapshots_corpus.mjs \
  build-linux/packages/rofl-core/rofl_core_cli \
  packages/rofl-core/profiles/replay-decoder-profiles.v1.json
```

`scripts/promote_keyframe_xp_cross_patch.mjs` deterministically applies only a
fully passing report to the canonical profile.

## Health and resource result

The first bounded vital-state gate tested the exact-build 16.14 champion
snapshot packet (`0x02EB`, length 1,479) after its complete byte substitution.
It scanned all contiguous/stride-2 through stride-8 `Float32LE` candidates for:

- current health
- maximum health
- current generic resource (`power` in the offline Timeline oracle)
- maximum generic resource

The candidate layout was selected on seven Discovery replays (2,170
participant snapshots) and evaluated on three held-out replays (1,030
snapshots). No field passed promotion. The best direct health candidate was
only 10/2,170 exact on Discovery and 0/1,030 on Holdout; the best candidates
for max health and current/maximum resource were likewise far outside the
frozen accuracy, correlation, and normalized-error thresholds.

Reproduce the negative gate:

```bash
node scripts/research_keyframe_vitals_16_14.mjs \
  --output tmp/keyframe-vitals-16.14.json
```

This rejects a simple direct vital-stat stripe in the productive champion
snapshot payload. It does not prove the replay lacks vitals. The next research
step is structural decoding of the separate component/bundle families already
known to correlate with `power`, `powerMax`, and `healthMax`, followed by
replay-native participant/entity assignment and cross-replay validation.

Until that passes, health and resource remain unavailable in the runtime ABI
and product UI. Resource must remain generic rather than being labelled mana,
because champions can use mana, energy, fury, or no resource.
