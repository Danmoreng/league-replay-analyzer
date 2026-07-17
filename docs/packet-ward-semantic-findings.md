# Packet ward and vision lifecycle findings

## Runtime promotion status

The validated lifecycle is now productive as `rofl-replay-wards/v1` in the
shared C++ core, native CLI, Wasm boundary, typed TypeScript contract, and Vue
product timeline. Runtime extraction receives only the loaded `.rofl`. The
schema deliberately leaves ward subtype, position, vision radius, and removal
reason as `null`/unavailable and labels removal coverage as conservative partial.

## Scope and provenance

This report covers 47 saved `.rofl` files across patch groups 15.22, 15.23,
15.24, 16.1, 16.5, 16.6, 16.7, and 16.9. Candidate extraction reads only the
replay packet stream. Saved Riot timeline data is joined afterward as an
offline validation oracle; it is not a runtime dependency and is never copied
into decoder output.

This workflow never executes, inspects, instruments, patches, or emulates an
installed League/Riot client or game binary, a running League/Riot process,
Vanguard, or Vanguard-managed data. Decoder evidence is limited to saved
`.rofl` packet bytes processed by this repository's own parser. No test requires
disabling or bypassing Vanguard.

The validated scope is the four standard Riot timeline ward classes:
`BLUE_TRINKET`, `CONTROL_WARD`, `SIGHT_WARD`, and `YELLOW_TRINKET`.
`UNDEFINED` entries, traps, and Teemo mushrooms remain outside this profile.

## Results

| Signal | Replay-native result | Offline-label validation | Status |
| --- | --- | --- | --- |
| Standard ward placement | owner packet followed by first matching entity marker | 6,168 / 6,168, zero extras | exact on corpus |
| Placement owner | champion network ID on the paired owner packet | 6,168 / 6,168 | exact on corpus |
| Conservative ward kill/removal | tracked ward entity ID plus profiled removal length | 1,882 / 1,883, zero extras | high-confidence partial |
| Killer of decoded removal | last short owner block before the linked removal | 1,882 / 1,882 | exact for emitted removals |
| Ward subtype | not present in the validated marker sequence | not resolved | correlation only |
| Position and vision radius | patch-versioned spawn families isolated, but no coordinate transform decoded | zero strict X/Y candidates | validated research only |

Position research now isolates exactly one high-entropy spawn packet plus one
fixed 63-byte companion packet for each of the 6,168 placements. Patch 16.9
uses `0x00D6` plus `0x01AD`; the packet IDs change by patch. The same families
recur around all 1,882 linked removals and share variable byte regions with
probable WardCorpse entities. This is strong packet-grammar evidence, but no
raw or scaled X/Y interpretation passes the corpus gate, so position remains
unavailable. See
[`ward-position-spawn-packet-research.md`](ward-position-spawn-packet-research.md).

For visual falsification, the separate
`rofl-ward-position-candidates-research/v1` contract exposes eight patch-16.9
interpretations: `CONTROL-U16-7-11`, `P16-BE-FY`, `P16-BE-SWAP-FX`, `P16-LE`,
`C16A-LE`, `C16B-BE`, `C24-LE-SWAP-FY`, and `C24-BE-FX`. Every result is marked
`researchOnly: true`, `promotionGate: false`, `positionAvailable: false`, and
`source.clientBinaryInput: false`. The productive lifecycle schema remains
unchanged with `position: null`.

The research UI binds candidates to the exact loaded replay, patch group, ward
entity, owner, and placement timestamp. It rejects out-of-bounds values rather
than clamping them, never draws a vision radius, and labels the layer
`EXPERIMENTAL / NOT DECODED`. Visual plausibility may falsify an interpretation;
it cannot promote one. Exact formulas and their low-uniqueness warnings are in
[`ward-position-spawn-packet-research.md`](ward-position-spawn-packet-research.md).

The one deliberately unsupported `WARD_KILL` is in patch 16.9. Its linked
packet has content length 27. The same type and length occurs 1,124 additional
times for tracked ward IDs without a `WARD_KILL` label, so promoting length 27
would create a large false-positive class. The payload reason field must be
decoded before that variant is enabled.

The independent native promotion gate is reproduced with:

```powershell
.\scripts\build-native.ps1 -UseNinja
node .\scripts\validate_replay_wards_corpus.mjs
```

It requires all 47 replays, exact patch-group totals, zero placement extras or
missing events, zero kill extras, and exactly the one deliberate 16.9 omission.

## Patch profiles

All packets below are channel 1. Placement markers have content length 3.
Placement-owner blocks accept lengths 2, 3, or 4. Killer-owner blocks accept
lengths 6 or 7.

| Patch | Placement marker | `payload[2]` | Placement owner | Removal | Kill lengths | Killer owner |
| --- | --- | --- | --- | --- | --- | --- |
| 15.22 | `0x0308` | `0x09` | `0x0420` | `0x0017` | 21, 28, 29 | `0x044E` |
| 15.23 | `0x0368` | `0xD5` | `0x01BF` | `0x020A` | 28, 29 | `0x028B` |
| 15.24 | `0x02CE` | `0xE1` | `0x0227` | `0x009C` | 28, 29 | `0x0220` |
| 16.1 | `0x037F` | `0x01`, `0x92` | `0x0335` | `0x0059` | 28, 29 | `0x021A` |
| 16.5 | `0x03F8` | `0x50` | `0x024F` | `0x023F` | 28, 29 | `0x01FE` |
| 16.6 | `0x0311` | `0x14` | `0x011D` | `0x0271` | 21, 28, 29 | `0x03FD` |
| 16.7 | `0x0162` | `0x80`, `0xF4`, `0xF7` | `0x033B` | `0x039C` | 28, 29 | `0x0301` |
| 16.9 | `0x0041` | `0xB0` | `0x04AC` | `0x02E6` | 28, 29 | `0x02F6` |

Owner `blockParam` values map through the patch's champion network-ID base:
`participantId = blockParam - championNetworkIdBase`. Placement `blockParam`
is instead the created ward entity network ID.

## Runtime state machine

1. Select a profile from the replay game version and parse packet blocks with
   signed compact `blockParam` deltas.
2. Remember valid placement-owner blocks for the current packet timestamp.
3. Accept only the first profiled 3-byte placement marker after that owner
   block. Emit a ward creation with timestamp, ward entity ID, and owner
   participant ID.
4. Track the entity ID. A removal packet is a `WARD_KILL` only when its type
   and content length are in the conservative patch profile.
5. Attribute a decoded removal to the last profiled 6/7-byte champion owner
   block before it in the same chunk and packet timestamp.
6. Preserve raw provenance and confidence. Do not infer subtype, position, or
   a kill reason for unprofiled removal lengths.

The experimental candidate schema is not a seventh productive state-machine
step and must not feed normalized ward position or vision state.

This sequence is suitable for a versioned C++ decoder module and normalized
Wasm output. The validator should remain a corpus gate: any profile change
must rerun all fixtures and retain zero extras for promoted exact signals.
