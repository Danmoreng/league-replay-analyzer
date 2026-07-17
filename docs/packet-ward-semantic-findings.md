# Packet ward and vision lifecycle findings

## Scope and provenance

This report covers 47 saved `.rofl` files across patch groups 15.22, 15.23,
15.24, 16.1, 16.5, 16.6, 16.7, and 16.9. Candidate extraction reads only the
replay packet stream. Saved Riot timeline data is joined afterward as an
offline validation oracle; it is not a runtime dependency and is never copied
into decoder output.

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
| Position and vision radius | not decoded by this profile | not resolved | future work |

The one deliberately unsupported `WARD_KILL` is in patch 16.9. Its linked
packet has content length 27. The same type and length occurs 1,124 additional
times for tracked ward IDs without a `WARD_KILL` label, so promoting length 27
would create a large false-positive class. The payload reason field must be
decoded before that variant is enabled.

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

This sequence is suitable for a versioned C++ decoder module and normalized
Wasm output. The validator should remain a corpus gate: any profile change
must rerun all fixtures and retain zero extras for promoted exact signals.
