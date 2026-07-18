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
node .\scripts\research_inventory_slot_encoding_16_9.mjs
```

The scripts write `artifacts/inventory-packet-research-16.9.json` and
`artifacts/inventory-slot-encoding-research-16.9.json`. The first script
invokes the native packet dump with a `.rofl` path only. Match-V5 and timeline
fixtures are read after packet extraction and are used exclusively as offline
labels. The second script consumes that research artifact and does not alter
the runtime decoder.

The checked corpus consists of 20 patch-16.9 replays.

## Patch-16.14 sale-operation research only

The ten saved patch-16.14 replay/fixture pairs establish a second,
version-specific **research** result. It is deliberately not a runtime
inventory API and does not decode item identity, slot, instance, undo, or a
complete inventory state.

Reproduce it with the native CLI already built:

```powershell
node .\scripts\research_inventory_packets_16_14.mjs
```

The script writes the explicitly non-promoted
`artifacts/inventory-packet-research-16.14.json`. It obtains packet blocks only
from the saved `.rofl` files and uses saved Match-V5 timelines solely as
offline labels. Its `researchOnly: true`, `promotionGate: false`, and
`runtimeInput: false` fields are part of the artifact contract.

| Candidate family | Channel | Packet type | Content lengths | Owner formula | Corpus count |
|---|---:|---:|---:|---|---:|
| inventory add/update | 1 | `0x0369` | 14/15 | `blockParam - 0x400000AD` | 2,519 |
| inventory removal | 1 | `0x03F9` | 6/7 | `blockParam - 0x400000AD` | 2,074 |
| unresolved removal-context companion | 1 | `0x0146` | 2/3/4 | `blockParam - 0x400000AD` | 4,214 |

The 16.9 add/update item-ID formula is a negative control on this new family:
it matches `0/1,971` unique one-purchase/one-add labels (all 1,971 mismatch).
It must therefore not be ported or parameterized as a 16.14 item-ID decoder.

The separate fail-closed bit-grammar harness now establishes all 13 positions
of the 16.14 item-ID lane across those same 1,971 labels. Seven formulas were
found during the earlier full-corpus exploration:

| Item-ID bit | Replay-native formula (little-endian payload-bit numbering) |
|---:|---|
| 0 | `payloadBit(71)` |
| 1 | `payloadBit(66) XOR payloadBit(71) XOR 1` |
| 5 | `payloadBit(70) XOR 1` |
| 6 | `payloadBit(69) XOR payloadBit(70) XOR 1` |
| 7 | `payloadBit(78) XOR payloadBit(79)` |
| 10 | `payloadBit(73) XOR payloadBit(76) XOR 1` |
| 12 | `payloadBit(78) XOR 1` |

The remaining six formulas were then selected only on seven fixed Discovery
replays. With `qN = payloadBit(N)`, they are:

| Item-ID bit | Formula |
|---:|---|
| 2 | `q65 XOR (q66 AND q71)` |
| 3 | `1 XOR q65 XOR q68 XOR (q66 AND q71) XOR (q65 AND q66 AND q71)` |
| 4 | `1 XOR q67 XOR q68 XOR (q65 AND q68) XOR (q66 AND q68 AND q71) XOR (q65 AND q66 AND q68 AND q71)` |
| 8 | `1 XOR q74 XOR q79 XOR (q72 AND q79)` |
| 9 | `q73 XOR (q73 AND q79) XOR (q72 AND q73 AND q79)` |
| 11 | `1 XOR q75 XOR q76 XOR (q73 AND q76)` |

All 1,320 Discovery labels decode exactly. The three fixed Holdouts then decode
all `651/651` complete IDs, including `19/19` label samples whose item ID never
appears in Discovery. Because the earlier seven formulas predate this split,
the Holdouts are independently clean for the six new bits, not for selection
of the entire 13-bit grammar. Full-corpus per-bit checks remain `1,971/1,971`,
with 30/30 cross-replay unseen-item-ID label samples.

The Discovery truth tables are complete and conflict-free for every formula
except two explicitly absent input symbols. Those symbols never occur in
Discovery, Holdout, or the full corpus:
bit 9 input `[72,73,79]` code `0`, and bit 11 input `[73,75,76]` code `4`
(input-list order is least-significant-code-bit first). The harness returns
unavailable for either symbol instead of applying the Boolean extrapolation.
Thus it is a complete ID only on the explicitly observed/fail-closed symbol
domain, not an unrestricted future-packet decoder.

The evidence covers 1,971 unambiguous one-purchase/one-packet joins; 236 saved
Timeline purchases have no matching profiled packet group and remain outside
the validation. Every label is gated to `0..8191`.

The maintained gate also scans all 2,519 profiled `0x0369` packets. Every one
uses an observed symbol code and therefore yields a structural 13-bit value;
neither fail-closed input symbol occurs anywhere in the stored packet corpus.
Exact owner/timestamp item-ID multisets conservatively purchase-link 1,973
packets in 1,972 groups: the original 1,971 single-packet labels plus one
two-packet/two-purchase Holdout group. The split is 1,320 linked of 1,575
Discovery packets and 653 linked of 944 Holdout packets.

The other 546 packets are explicitly `transactionUnresolved`. Their structural
bit value is not proof of a purchase, resulting item, slot, instance, transform,
or undo, and the runtime must not emit them as semantic inventory events.

### Patch-16.14 16/17-byte `0x0369` negative control

The maintained item-ID harness also catalogs every champion-owned 16/17-byte
`0x0369` packet without adding those lengths to the profile. The existing
fail-closed 13-bit grammar structurally decodes all nine saved packets. The
seven Discovery replays have 6/6 exact owner/timestamp/purchase-ID links and
zero extras, but the three fixed Holdouts have only 2/3 links plus one
unlabelled extra. Thus eight packets would link purchases and one would remain
transaction-unresolved; the required zero-extra profile-extension gate fails.

The artifact records `profileExtensionGate: false` and keeps the maintained
profiled payload lengths at 14/15 bytes. The hypothetical 16/17-byte
extension is diagnostic only (2,528 packets; 1,981 linked; 547 unresolved),
never a runtime decoder change.

Reproduce the bounded result with:

```powershell
node .\scripts\research_inventory_item_id_bits_16_14.mjs
```

The output is explicitly `researchOnly: true`, `promotionGate: false`, and
`runtimeInput: false`. Slot, instance, removal linkage, undo, and full inventory
state are still missing, and no C++/Wasm inventory field exists yet.

For a single-removal/no-add transaction group at the same replay-native
participant and timestamp, the following operation-class predicate is exact
on the ten fixtures:

```text
(payload[0] & 0x0F) in { 0x02, 0x05 }
&& (payload[2] & 0x03) != 0x03
```

Together with the transaction shape, it resolves 116/116 offline-labelled
sales with zero extras and zero misses. It rejects the three known
destroy+purchase transform collisions and all 189 destroy-only one-removal
negatives.
Leave-one-replay-out is exact for each of the ten replays.

The result has a strict compatibility boundary: the currently proven
`payload[2]` values are `0x30, 0x6E, 0x7A, 0xEA, 0xEE, 0xF9`. This bounded
opcode-field enum is not a full-payload lookup table. The explicit
unseen-discriminator test withholds each value and records only the expected
fail-closed false negatives, never a false positive. A new byte value must
therefore be unavailable rather than guessed as a sale until another labelled
corpus proves it. This remains insufficient to identify the sold item, so it
cannot promote a full inventory reducer.

The maintained harness uses the multi-type native packet dump, so both packet
families and the unresolved companion family are extracted from one exact replay
parse. The underlying CLI command
is also available directly for bounded grammar research:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe `
  --dump-packet-types-json .\replays\EUW1-7919517389.rofl `
  --packet-type 0x0369 --packet-type 0x03F9 --packet-type 0x0146 `
  --segment-type chunk --max-blocks 0
```

`--max-blocks` applies independently to each requested type; zero emits every
matching block. The replay is decompressed and framed once, requested packet
types are de-duplicated and sorted, and each family retains exact source
provenance.

### Patch-16.14 unresolved `0x0146` removal-context companion

The same maintained research artifact contains a strictly non-promoted timing
gate for the champion-owned, 2/3/4-byte `0x0146` family. It is a Timeline-only
association result, not a packet classifier or a normalized removal event.

The predeclared single-Destroy label shape is, for the same champion within
one millisecond:

```text
exactly one ITEM_DESTROYED and zero ITEM_SOLD
zero profiled 0x0369 packets of length 14/15
zero profiled 0x03F9 packets of length 6/7
```

All 432 label groups have one exact `0x0146` timestamp group: 434 packets in
total because two groups contain duplicate companion packets. There are zero
missing associations and zero ambiguous companion timestamp groups. This also
reproduces on the fixed split: Discovery has 267 groups / 269 packets and the
three Holdouts have 165 / 165.

A second exact timing shape has two `ITEM_DESTROYED`, zero `ITEM_SOLD`, one
profiled `0x0369` packet, one profiled `0x03F9` packet, and one `0x0146`
packet. It occurs in 25 groups (15 Discovery, 10 Holdout). Therefore 459 of
the 4,214 packets are timing-associated across the two proven shapes:
434 single-Destroy-shape packets plus 25 double-Destroy companions. The gate
forms this as a unique framed-provenance packet union
`${replayId}:${segmentType}:${segmentId}:${segmentPayloadOffset}:${sourceOffset}`
and requires zero duplicate physical-packet assignments across shapes. The
remaining 3,755 occur outside both shapes and are explicitly unresolved.

`blockIndex` is local to a chunk and is not replay-global. Two values collide
across distinct chunks in the timing-associated corpus; the artifact records
their full framing provenance as diagnostic samples. They are two distinct
physical packets, not a timing-assignment ambiguity or a duplicate in the
provenance union.

The intermediate number `4,214 - 434 = 3,780` means only “outside the
single-Destroy shape”; it includes the 25 separately timing-associated
double-Destroy companions and must not be described as completely unrelated.

No `0x0146` packet is emitted, classified, or treated as an inventory removal
by C++, Wasm, or the UI. Its payload grammar, item ID, slot, instance, and
operation semantics are unavailable. The artifact records
`classifierAvailable: false`, zero runtime semantic claims, and zero runtime
false claims precisely because it creates no runtime output.

## Cross-patch inventory-component / undo anchors

Two variable-length, champion-owned component families have an exact but
partial relationship to `ITEM_UNDO`. They are replay-native change signals,
not complete undo or inventory decoders:

| Version | Packet type | Segment/channel | Exact matched Undo labels | Extras | Recall |
|---|---:|---|---:|---:|---:|
| `16.9` | `0x0165` | chunk / 1 | 78/147 | 0 | 53.06% |
| `16.14` | `0x0081` | chunk / 1 | 31/62 | 0 | 50.00% |

Both profiles use `participantId = blockParam - 0x400000AD` and a maximum
one-millisecond offline label tolerance. Leave-one-replay-out preserves 1.0
precision and the same partial recall. Reproduce the fixed, fail-closed profiles
with:

```powershell
node .\scripts\research_inventory_undo_component_families.mjs --profile 16.9
node .\scripts\research_inventory_undo_component_families.mjs --profile 16.14
```

The same packet types also occur as variable-length champion-owned keyframe
components. On 16.14, the all-segment survey has 3,200 keyframe `0x0081` blocks
and exactly the 31 undo-associated chunk blocks. For 16.9, `0x0165` has 5,720
keyframe blocks and 78 undo-associated chunk blocks over the 20-replay corpus.
This is strong component identity evidence, but it does not establish the
payload's semantic grammar. The maintained gate intentionally stops at family,
owner, timing, segment, length, and exact partial Undo association. Item
identity, slot, instance, ordering, and the unmatched undo half therefore remain
unavailable.

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
151 pairs. A full-payload scan found 28 exact contiguous candidates, but these
are overlapping wider views of the same four-value signal around add bits
42-48 and removal bits 10-16, not 28 independent fields. The four observed
values and support-item context make this a better count/charge-state candidate
than a slot or item-instance identifier, so it is not promoted.

An initial-add oracle supplied 196 deterministic slot labels before each
participant's first complex transaction. One tempting add symbol was:

```text
symbol = (readBit(payload, 0) << 3) | readBits(payload, 10, 3)
symbol-to-slot candidate = {1:0, 4:1, 6:2, 3:3, 5:4, 7:5, 2:6}
```

It follows the first-empty-slot allocation pattern early in a match, but only
matches 155/196 initial labels (79.08%) and 108/239 independently selected
terminal final-item labels (45.19%). It is therefore falsified as a general
slot decoder.

Three further cross-checks also failed the exact promotion gate:

| Cross-check | Samples | Best result |
|---|---:|---:|
| same-item replacement removal field | 151 | 72/151 (47.68%) |
| offline-labelled add/removal lifecycle link, slot-sized field | 882 | 675/882 (76.53%) |
| candidate-state removal slot field | 733 | 420/733 (57.30%) |

The lifecycle scan's strongest unrestricted relationship is 880/882, but it
has only three values and is another low-cardinality state/length correlation.
The strongest instance-sized relationship reaches only 505/882 (57.26%). No
exact, reusable slot or item-instance link is present in the tested raw
contiguous fields.

This rules out the simple direct-slice, XOR, lookup, and initial-allocation
interpretations tested here; it does not prove that the payload lacks a slot.
League packet fields use patch-specific transforms, so slot identity may
require decoding the complete serialized field or a separate swap operation.

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

The highest-value next step is to identify the patch-16.9 item-swap family and
obtain the patch-matched field deserializer or symbol table for `0x0132` and
`0x0415`. Older decoded packet schemas model buy, remove, swap, and use as
separate messages, with explicit slot fields on buy/remove and source/target
slots on swap. This is only a structural research clue from older patches, not
a decoder dependency or proof for 16.9.

A decoded patch-16.9 client-side packet trace or the patch-matched packet
deserializer would provide a much stronger route than fitting more payload
correlations. The locally installed client is patch 16.14, so it cannot safely
define the 16.9 profile. Once slot identity and swaps are available, the
reducer can maintain seven slots per participant and use replay-native final
`statsJson` items as an independent, ROFL-only validation oracle.

Structural reference only:

- [Older decoded replay packet schema](https://huggingface.co/datasets/maknee/league-of-legends-decoded-replay-packets/blob/main/packets.py)
- [Dataset scope and covered patches](https://huggingface.co/datasets/maknee/league-of-legends-decoded-replay-packets/blob/main/README.md)

After patch 16.9 reaches the full-state gate, repeat the derivation behind a
versioned profile for 16.7 before exposing inventory events through C++/Wasm.
