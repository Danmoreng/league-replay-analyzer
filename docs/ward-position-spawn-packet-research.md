# Ward Position / Spawn Packet Research

Updated: 2026-07-17

## Status

This research isolates a replay-native, patch-versioned ward spawn packet sequence,
but it does **not** decode ward coordinates yet. No position field is eligible for
runtime promotion.

The productive ward lifecycle remains the identity and timing source. This note
uses its validated `wardEntityNetworkId` values to inspect packet neighborhoods
and uses Riot Timeline participant positions only as an offline falsification
oracle. Riot data is not a runtime input.

All work is restricted to saved `.rofl` packet bytes, this repository's own
parser/tools, and saved Riot fixtures used offline. Installed League/Riot client
or game binaries, running processes, Vanguard, and Vanguard-managed data must
not be executed, inspected, instrumented, patched, or emulated. No decoder step
depends on disabling or bypassing Vanguard.

## Corpus result

The scan covers 47 replays, all supported version groups from 15.22 through 16.9,
6,168 exact placements, and 1,882 exact placement-to-removal links.

For every placement, the same-timestamp neighborhood contains exactly one
high-entropy, ward-owned packet from a patch-specific family and exactly one
ward-owned 63-byte companion packet. Both occur before the already validated
three-byte placement marker, normally within the preceding eight packet blocks.

| Version | Replays | Placements | High-entropy family | Length | 63-byte companion |
| --- | ---: | ---: | --- | --- | --- |
| 15.22 | 2 | 344 | `0x00DC` | 64-73 | `0x00BC` |
| 15.23 | 1 | 216 | `0x0393` | 64-73 | `0x0060` |
| 15.24 | 1 | 95 | `0x0342` | 63-73 | `0x0218` |
| 16.1 | 2 | 329 | `0x02CC` | 63-73 | `0x0428` |
| 16.5 | 1 | 125 | `0x0427` | 64-73 | `0x01EE` |
| 16.6 | 11 | 1,449 | `0x03D1` | 63-73 | `0x034B` |
| 16.7 | 9 | 985 | `0x0449` | 63-73 | `0x0219` |
| 16.9 | 20 | 2,625 | `0x00D6` | 62-73 | `0x01AD` |

The coverage is 6,168/6,168 for each of the two packet roles, with one packet per
placement. The high-entropy family averages about 5.67-5.77 bits per byte. The
fixed companion averages about 2.86-2.89 bits per byte.

The 16.9 sequence is therefore not just the visible `0x01AD`/63-byte pattern.
The stronger obfuscated-spawn lead is `0x00D6`, followed by the fixed `0x01AD`
companion and then the marker. The equivalent packet IDs change every patch.

## Placement-to-removal differential

Each of the 1,882 productive `WARD_KILL` events is already linked to its original
placement by ward entity identity. Around every removal, the same patch-specific
two-packet family appears on new/other entity IDs, normally twice. This is
consistent with a ward-corpse or related spawned-entity sequence.

The high-entropy family produces one usable placement-to-best-removal comparison
for every linked removal:

| Version | Removals compared | High-entropy packet | Strong shared byte offsets |
| --- | ---: | --- | --- |
| 15.22 | 110 | `0x00DC` | 8, 12, 15-21, 23-25, 27-30 |
| 15.23 | 98 | `0x0393` | 9, 13, 15-18 |
| 15.24 | 32 | `0x0342` | none at the conservative 80% gate |
| 16.1 | 139 | `0x02CC` | none at the conservative 80% gate |
| 16.5 | 34 | `0x0427` | none at the conservative 80% gate |
| 16.6 | 437 | `0x03D1` | 7, 10, 18 |
| 16.7 | 287 | `0x0449` | 12 |
| 16.9 | 745 | `0x00D6` | 9-11, 13-15 |

The fixed 63-byte companion also yields one comparison for every linked removal.
Its strongest shared variable-byte regions are patch-specific: 16.9 uses offsets
34, 36, 38, 42, 44, and 46; several other groups use the same six-offset shape at
different locations. In 16.9, the two removal-spawn siblings share offsets 9-26
of the high-entropy packet byte-for-byte across 739 conservative two-candidate
pairs, while the values vary substantially between wards.

This is strong evidence that the packets carry shared spawn state, plausibly
including position. It is not yet a coordinate transform. Raw `f32`, `u16`,
scaled `u16`, and signed-`i16` pair scans across 22,771 placement-neighborhood
occurrences produced zero candidates passing the conservative corpus gate. Only
15 raw ward-ID payload occurrences were found; entity identity is primarily in
the framed `blockParam`, not in the payload.

## Patch-16.9 live visual model: API-OFFLINE-FIT / NOT PROMOTED

The eight earlier raw-coordinate interpretations were visually falsified and
are no longer exposed by the product UI. The current live layer uses one bounded
research model, `P16-FLOAT32-BE-API-FIT-COARSE`:

- X uses primary bytes `p[8..10]` as mapped Float32-BE bytes 0..2.
- Y uses primary bytes `p[12..14]` as mapped Float32-BE bytes 0..2.
- Float byte 3 is forced to zero and is explicitly not decoded.
- The symbol lookup was fitted offline from 95 saved Riot Timeline kill anchors.
- At runtime, coordinates are calculated only from the loaded `.rofl` spawn
  packets; no Riot API fixture, client binary, installed game data, or Vanguard
  input is read.

The model emits 48/2,625 bounded candidates across 19 patch-16.9 replays. A
full-integer-LSB variant emits 45; the conservative holdout-pure model emits
zero. These coverage numbers and the offline fit make the model unsuitable for
promotion. It exists only for user-led visual falsification.

### Why only a small fraction of wards has a marker

All 2,625 patch-16.9 ward placements have exact lifecycle identity and timing;
only the coordinate layer is sparse. One position requires all six primary
symbols to be known at the same time:

| Axis | Primary offset | Mapped input symbols | Possible byte values |
| --- | ---: | ---: | ---: |
| X | `p[8]` | 3 | 256 |
| X | `p[9]` | 72 | 256 |
| X | `p[10]` | 65 | 256 |
| Y | `p[12]` | 3 | 256 |
| Y | `p[13]` | 70 | 256 |
| Y | `p[14]` | 71 | 256 |

The three-symbol leading lanes cover the observed Float32 exponent/range
classes. The four variable mantissa lanes are much less complete. If any one of
the six replay symbols lacks a target byte, the UI emits no coordinate. It does
not guess, interpolate, clamp, or use a replay-specific API fallback. These
simultaneous requirements explain the observed 48/2,625 corpus coverage; a
loaded replay can have a different percentage depending on its symbol mix.

The sparse mappings come from only 95 reliable kill-position anchors. Riot
Timeline ward events contain no ward coordinates, so they cannot directly label
the missing symbols. The 701/745 exact placement/removal fingerprint matches
prove that both events carry the same spawn-state field, but equality alone does
not reveal the numeric value of an unknown byte. A removal can validate an
already decoded position; it cannot manufacture a new coordinate label.
The replay-only lifecycle invariant is stronger but still does not prove X/Y:
primary `p[8..15]` maps bijectively to the alternating companion lanes over all
2,625 placements, and 701/745 linked removals have exactly two sibling spawns
whose complete primary+companion fingerprint equals the placement. The other 44
have no exact match. The UI shows exact placement times, conservatively linked
removal times, this corpus invariant, and never draws a vision radius.

## Safety and evidence boundary

Only local corpus evidence from saved replay packets may establish a decoder in
this project. Client-binary execution or analysis, process inspection,
instrumentation, RVA matching, machine-code emulation, Vanguard interaction, and
Vanguard-managed data are intentionally outside scope. Community descriptions
may provide historical format context, but no client-code technique, binary
artifact, or runtime dependency may enter the workflow.

## Next decoder step

1. Expand the symbol-to-Float32 tables for sparse lanes `p[9]`, `p[10]`,
   `p[13]`, and `p[14]` using additional independently labelled replay-native
   spatial anchors; do not interpolate missing symbols.
2. Investigate the underlying field codec rather than treating the table as six
   unrelated substitutions. Use the complete conflict-free primary-to-companion
   256-symbol permutation as a structural constraint.
3. Use the 701 exact placement/removal fingerprint matches as consistency and
   propagation checks when one side is independently decoded; do not treat
   equality as a coordinate label.
4. Rerun replay-level holdout and the complete patch corpus after every mapping
   change. Reject any model that relies on the replay it is evaluated against.
5. Promote `position` only after in-bounds, identity, timing, independent
   holdout, false-positive, and cross-patch gates pass. Visual inspection can
   reject hypotheses but cannot satisfy this gate.

## Reproduction

Build the native decoder first, then run:

```powershell
node .\scripts\research_ward_entity_positions.mjs `
  --neighborhood-radius 48 `
  --minimum-candidate-support 20 `
  --output artifacts\ward-entity-position-research.json
```

The output schema is `rofl-ward-entity-position-research/v1`. The report includes
per-replay totals, patch-specific packet families, entropy and ID checks,
placement/removal differentials, simple coordinate-candidate falsification, and
an explicit `promotionGate: false`.

The separate offline ranking pass is:

```powershell
node .\scripts\research_ward_position_hypotheses.mjs `
  --output artifacts\ward-position-hypotheses-16.9.json
```

Its saved report is discovery evidence only. The C++/Wasm/UI research contract
is `rofl-ward-position-candidates-research/v1`; it carries replay identity,
patch identity, exact `xSource`/`ySource` formulas, and the hard non-promotion
and no-client-binary flags described above.
