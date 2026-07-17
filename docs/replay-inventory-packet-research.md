# Replay inventory packet research

## Status

Patch 16.9 has a reproducible, exact decoder for the item ID carried by the
14/15-byte inventory add/update packet family. This is a real replay-native
field, but it is not yet a complete inventory transaction decoder.

Runtime promotion is intentionally blocked because the 6/7-byte removal
family still has no decoded slot or item-instance reference. Consequently, a
removal cannot yet be mapped to the item that left a champion's inventory
without using an offline Riot label.

No C++ runtime inventory API was added from this research.

## Reproducing the result

Build the native CLI, then run:

```powershell
node .\scripts\research_inventory_packets_16_9.mjs
```

The script writes
`artifacts/inventory-packet-research-16.9.json`. It invokes the native packet
dump with a `.rofl` path only. Match-V5 and timeline fixtures are read after
packet extraction and are used exclusively as offline labels.

The checked corpus consists of 20 patch-16.9 replays.

## Patch-16.9 profile

| Semantic candidate | Channel | Packet type | Content lengths | Champion ID base |
|---|---:|---:|---:|---:|
| inventory add/update | 1 | `0x0132` | 14/15 | `0x400000AD` |
| inventory removal/update | 1 | `0x0415` | 6/7 | `0x400000AD` |

`participantId = blockParam - 0x400000AD` is exact for the champion-owned
samples used below. Packet type, owner, and timestamp alone are not sufficient
to emit normalized purchase or sale events.

## Decoded add/update item ID

For a 14/15-byte `0x0132` payload, with little-endian bit numbering:

```text
lowSymbol      = readBits(payload, 34, 6)
highSymbol     = readBits(payload, 42, 6)
high           = (51 - highSymbol) & 63
encodedHighBit = readBits(payload, 40, 1)
mask           = 1 - readBits(payload, 32, 1)
specialHigh    = high == 52 || high == 62 ? 1 : 0
highBit        = encodedHighBit ^ mask ^ specialHigh
encodedLow7    = (highBit << 6) | lowSymbol
low7           = (115 - encodedLow7) & 127
itemId         = (high << 7) | low7
```

Validation uses only samples where one champion has exactly one add/update
packet and one Riot `ITEM_PURCHASED` label within 1 ms.

| Result | Count |
|---|---:|
| uniquely labelled add/update packets | 3,716 |
| distinct labelled API item IDs | 171 |
| direct item-ID matches | 3,714 |
| explained automatic transforms | 2 |
| unexplained mismatches | 0 |

The two non-identical labels are semantically correct resulting inventory
items rather than decoder errors:

| Replay | Participant | API purchase | Same-time API destroy | Replay-decoded result |
|---|---:|---:|---:|---:|
| `EUW1-7838031220` | 6 | 3119 | 3119 | 3121 (Fimbulwinter) |
| `EUW1-7838099746` | 8 | 3003 | 3003 | 3040 (Seraph's Embrace) |

This establishes that `0x0132` represents resulting inventory add/update
state. It must not be renamed to `ITEM_PURCHASED`: automatic transforms and
stack/state updates use the same family.

## Transaction-shape audit

The 20-replay corpus contains:

| Evidence | Count |
|---|---:|
| Riot item events used as offline labels | 8,874 |
| `ITEM_PURCHASED` | 4,488 |
| `ITEM_DESTROYED` | 4,050 |
| `ITEM_SOLD` | 189 |
| `ITEM_UNDO` | 147 |
| replay add/update packets | 4,454 |
| replay removal packets | 3,550 |

All 189 sale labels have exactly one correct-owner removal packet within 1 ms.
Shape alone is not a safe sale decoder: 266 destroy-only groups have the same
one-removal/no-add shape. The removal payload provides the missing 16.9
subvariant discriminator. The following replay-only rule emits 189/189 sale
operations, with zero extras and zero missing labels:

```text
same champion and timestamp:
  add/update packet count == 0
  removal packet count == 1
  removal payload[2] in { 0x68, 0x69, 0xBA, 0xBE, 0xC2, 0xC6, 0xDF }
```

The 266 destroy-only packets instead use `payload[2]` values `0x5E`, `0x5F`,
or `0xDE` in this corpus. The operation class is therefore exact for the
available patch-16.9 samples. The sold item ID remains unresolved because the
removal's slot/instance field is not decoded.

Additional negative evidence:

- 174 add/update groups have no Riot item-event label. These include replay
  state changes such as automatic item evolution.
- The two candidate packet families cover none of the 147 `ITEM_UNDO` labels.
- No removal packet occurs in a group with no offline item-event label, but a
  runtime decoder still cannot distinguish sale, component consumption, item
  use, and other removal causes from shape alone.

## Slot and item-instance linkage attempt

There are 151 especially strong same-item replacement pairs in which item 2055
is destroyed and re-added for the same champion at the same timestamp. Every
pair contains one add/update and one removal packet.

Two bits at add offset 48 exactly equal two bits at removal offset 16 for all
151 pairs. The four observed values and the support-item context make this a
better count/charge-state candidate than a slot identifier, so it is not
promoted as slot data.

An exhaustive contiguous-slice scan of the candidate add prefix (bits 0-33)
against the candidate removal prefix (bits 0-15), for widths 2 through 10,
found no stable bidirectional mapping at an 80% threshold. The best result was
only 82/151 (54.30%). This rules out the simple direct-slice, XOR, or lookup
link assumed by the first probes; it does not prove that the payload lacks a
slot. League packet fields use patch-specific field transforms, so the slot may
require decoding the complete serialized field.

## Full inventory-state gate

Full inventory reconstruction was attempted on all 20 replays and passes
`0/20` because all 3,550 removal packets still have an unresolved item target.
The gate requires all of the following before adding C++ runtime output:

1. decode add/update item ID, slot, count/charges, and any required instance
   reference from replay bytes;
2. decode removal slot/instance and resolve every removal against the current
   replay-only inventory state;
3. retain the exact patch-16.9 sale discriminator and classify the remaining
   destroy/use/upgrade transitions without Riot runtime input;
4. discover the undo and item-swap packet families;
5. reproduce every supported replay's final inventory from its own final
   `statsJson` state, with zero unresolved removals and zero extra normalized
   transactions;
6. preserve automatic transformations as explicit state changes rather than
   mislabelling them as purchases.

## Next decoder step

The highest-value next step is the patch-16.9 field decoder for the slot/count
portion of `0x0132` and `0x0415`. A decoded client-side packet trace or the
patch-matched packet deserializer would provide a much stronger route than
fitting more opcode/timestamp correlations. Once slot identity is available,
the reducer can maintain seven slots per participant and use replay-native
final `statsJson` items as an independent, ROFL-only validation oracle.

After patch 16.9 reaches the full-state gate, repeat the derivation behind a
versioned profile for 16.7 before exposing inventory events through C++/Wasm.
