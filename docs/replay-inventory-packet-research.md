# Replay inventory packet research

## Status

Patch 16.9 has a reproducible, exact decoder for the item ID carried by the
14/15-byte inventory add/update packet family. This is a real replay-native
field, but it is not yet a complete inventory transaction decoder.

For exact build `16.14.794.5912`, the shared C++ core, Wasm boundary, and Vue
client productively expose the narrow, external-profile-only schema
`rofl-replay-purchase-linked-item-updates/v1`. It emits only strict
purchase-linked resulting-item updates from the loaded `.rofl`; saved Riot
fixtures remain offline discovery/validation oracles and are never runtime
inputs or fallbacks.

Runtime promotion remains blocked for complete inventory reconstruction because
the 6/7-byte removal family still has no decoded slot or item-instance
reference. Consequently, a removal cannot yet be mapped to the item that left
a champion's inventory without using an offline Riot label.

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

The separate replay-only underidentification gate strengthens that boundary
without Timeline, Match, or Data Dragon input. It scans every exact-build
`16.14.794.5912` `0x0369` block and proves that the physical `all` scan is the
exact `chunk + keyframe + startup` union. D7 contains 2,091 packets, of which
2,040 are long enough to carry the input bits; the two missing-code counts are
both zero, while all seven non-target codes occur. Only after those D7 counts
and two alternative decoders are frozen does H3 open. H3 contains 1,175
packets (1,152 input-capable) and again has zero target-code occurrences.

Across all 3,266 packets (3,192 input-capable), each maintained Boolean formula
has an equally compatible alternate: XOR bit 9 with
`(1 XOR q72) AND (1 XOR q73) AND (1 XOR q79)`, or XOR bit 11 with
`(1 XOR q73) AND (1 XOR q75) AND q76`. Each term is one only on its missing
code, so the alternate agrees on every stored packet but changes that missing
output from zero to one. The corpus therefore cannot numerically choose between
item-ID differences of `2^9` and `2^11`; fail-closed behavior is required until
a new replay supplies an independently anchored occurrence. Reproduce the
deterministic research-only result with:

```powershell
node .\scripts\research_inventory_item_id_missing_symbols_16_14.mjs
```

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
state are still missing. This bit-grammar research artifact itself adds no
general C++/Wasm inventory field; the separately promoted strict
purchase-linked resulting-item-update subset below does not change those
unavailable fields.

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

The pinned 16.14.1 catalog makes the timing association more specific but not
more classifiable. Single-Destroy groups mix ordinary Health Potions, Control
Wards, Biscuits, and elixirs with system items; every double-Destroy group
mixes a Control Ward with a support-quest item. Full-payload symbols collide
across labels and with 25 hard negatives in H3, while bounded prefix/bit/ANF
rules match many of the other 3,755 packets. The family therefore cannot be
emitted as use, consume, removal, count, or charge state.

Stateful neighbourhoods do not supply the missing discriminator. Of 4,214
profiled contexts, 2,820/2,847 D7 and 1,354/1,367 H3 packets occur without a
same-time profiled add/removal triplet, and immediate owner-local predecessor
and successor families vary widely. Only 290 D7 and 178 H3 packets have nearby
offline item labels. The strongest zero-extra D7 payload rule covers 187/290,
then produces two extras while covering only 104/178 H3 labels. Identical
payloads also collide across several consumable IDs and unlabelled contexts.
Neither sequence context nor payload therefore identifies an item, charge,
slot, instance, or removal operation exactly.

### Patch-16.14 same-time operation-bundle checkpoint

A separate maintained, replay-only checkpoint records a narrow structural
result for the *complete relevant profiled owner/time-group population*,
without interpreting any individual packet payload. Reproduce it with:

```powershell
node .\scripts\research_inventory_operation_sequences_16_14.mjs
```

It reads every exact-framed chunk/channel-1 packet in the four profiled
families—`0x0369` lengths 14/15, `0x03F9` lengths 6/7, `0x0146` lengths 2/3/4,
and chunk `0x0081`—and groups them only by exact replay-native champion owner
and exact replay timestamp. A template consists solely of the ordered
family/length sequence, sorted by exact physical source order inside that one
group. It never uses packet payload bytes, preceding/succeeding operation
groups, Match data, static data, network data, or a client binary as a
template feature.

The fixed 7/3 D7/H3 split is deliberately sequenced: D7 fully frames and gates
its population before H3 is opened. D7 contains 1,575 add, 1,293 removal,
2,847 removal-context, and 23 Undo-component blocks in 4,645 owner/time
groups. It freezes 27 signatures that each recur at least twice, have exactly
one saved-Timeline item-event **bundle** label, and have no unlabelled D7
occurrence. The frozen template content fingerprint is
`fd1586bc5eb6a2d4151243773e16d37e38f1c3cac94c7dde93becd1c1f735344`.

Against all 4,645 D7 groups, those templates cover 289/289 matching groups
with zero false-positive groups; against all 2,273 H3 groups they cover
136/136 with zero false-positive groups. The H3 population independently has
944 add, 781 removal, 1,367 removal-context, and 8 Undo-component blocks.
Nineteen of the 27 frozen signatures occur in H3, accounting for all 136 H3
matches with zero extras; the other eight have zero H3 support and remain
unavailable. A per-template D7 leave-one-replay-out check reselects and
correctly labels 279 heldout matching groups with zero extras. The remaining
10 heldout matching groups lack the two-occurrence training support required
to select their signature and are emitted zero times: this is an explicit
fail-closed unseen-template outcome, not a missed inference.

Unknown signatures are intentionally unavailable: 4,356 D7 and 2,137 H3
groups are not assigned any event bundle. The 425 exact combined matches are
offline validation evidence only. A bundle label such as
`ITEM_DESTROYED+ITEM_PURCHASED` is not a statement that a particular packet is
the destroyed or purchased item, and the result provides neither item ID,
slot, item instance, count/charges, undo before/after state, gold delta, nor
an inventory reducer. It is therefore `researchOnly`, has
`promotionGate:false`, and adds no C++/Wasm/UI API.

### Patch-16.14 strict purchase-linked resulting-item subset

A second maintained checkpoint combines only ten of the frozen same-time
bundle signatures with the separately proven, fail-closed `0x0369` item-ID
grammar:

```powershell
node .\scripts\research_inventory_purchase_subset_16_14.mjs
```

The runtime-shaped predicate uses only the complete profiled chunk/channel-1
owner/time group, exact family/length source order, champion ownership, and the
structural item ID from its one `0x0369` length-14 packet. The ten signatures
are selected on D7 and frozen before H3 is opened; their content fingerprint is
`edadb744df01c08cd9898428ebf6a7faca4de7d285e6e78cb832180e7227e27b`.
An unknown signature or either formally underidentified item-ID input symbol
makes the whole candidate unavailable.

The frozen subset identifies 130/1,575 D7 add/update packets and 63/944 H3
packets. All 193 selected packets are exact purchase-linked resulting-item
updates with zero false-positive groups and zero wrong item IDs. Seven H3
packets carry six item IDs never seen in D7 (`2520`, `3053`, `3087`, `3181`,
`3803`, and `6657`) and remain exact. Ten leave-one-replay-out folds likewise
produce zero false positives, including nine selected packets whose item ID is
unseen in that fold's training replays.

This exact frozen result is now promoted as the strict, external-profile-only
productive schema `rofl-replay-purchase-linked-item-updates/v1` for exact build
`16.14.794.5912`. The shared C++ core, its Wasm wrapper, and the local Vue
client consume only loaded `.rofl` bytes plus the canonical local external
profile. The runtime event contains the replay-native participant, timestamp,
resulting item ID, matched template, and packet provenance; it does not read
Match-V5, Timeline, Data Dragon, a network service, or client/game data.

Reproduce the productive corpus gate with:

```powershell
node .\scripts\validate_replay_purchase_linked_item_updates_corpus.mjs
```

Across the fixed ten saved replay/API fixture pairs, it emits and
offline-validates 193/193 events (D7 130, H3 63), with zero extras, zero wrong
resulting item IDs, and a maximum one-millisecond timestamp delta. The
external-profile boundary is mandatory and exact-build only: a missing,
invalid, non-external, ambiguous, or non-`16.14.794.5912` profile is
unavailable rather than falling back to a built-in decoder.

This remains deliberately a small exact subset: 2,326/2,519 profiled
add/update packets remain unavailable, and the result is not a complete
purchase stream. It does not identify consumed or removed components, slot,
item instance, count/charges, price, gold state, undo, or current inventory.

### Negative promotion controls for direct recipe/removal rules

Two compact alternatives do not meet the zero-false-positive promotion gate.
The direct Recipe-/Removal-Ordinal grammar covers only 113 of the 193 exact
purchase-linked resulting-item updates. The Arity gate reaches 139 candidates
but produces 26 false positives. These are offline-oracle evaluation results,
not runtime inputs, and neither rule is included in the profile or decoder.
They must not be used to widen the 193-event stream, classify the remaining
2,326 add/update packets, or infer removed components, slots, instances,
inventory, price/gold, or undo state.

### Patch-16.14 static recipe constraint

A separate maintained harness validates one bounded component-consumption
constraint using Riot Data Dragon only as patch-pinned static item-schema
metadata:

```powershell
node .\scripts\research_inventory_recipe_constraints_16_14.mjs `
  --item-data C:\path\to\Data-Dragon-16.14.1-item.json
```

`--item-data` is required. The harness performs no network request and has no
`latest` lookup. It accepts only the complete official `16.14.1` item catalog
from
`https://ddragon.leagueoflegends.com/cdn/16.14.1/data/en_US/item.json`:

| Fixture property | Required value |
|---|---|
| Data Dragon version | `16.14.1` |
| Catalog entries | 706 |
| Byte length | 583,139 |
| SHA-256 | `0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75` |

The 583 KiB catalog fixture is deliberately not tracked in this repository.
The file supplies item validity and `from`/`into` recipe edges only. Match state
still comes from each saved replay; saved Timeline events remain offline labels
loaded after packet extraction. The catalog is not a runtime dependency or a
fallback for missing replay fields, and this research adds no C++, Wasm, or UI
surface.

Historical D7 research designed the classifier and recipe rule. The maintained
harness reproduces that frozen result; it does not recreate the original
selection process. It does enforce that the D7 expected-count gate passes
before it opens any H3 file. The classifier defines a real inventory item as a
catalog entry with Summoner's Rift map flag `maps[11] == true`,
`gold.purchasable == true`, and positive total gold. This separates actual
inventory/component labels from system events such as lane quests (`1200`,
`1201`, `1222`), Recall (`2001`, `2002`), the zero-gold Stealth Ward trinket
(`3340`), and Eye of the Herald (`3513`). Discovery has 1,118 real-item Destroy
labels versus 380 non-purchasable, zero-gold, or map-invalid labels. The
unchanged-rule Holdout classification has 724 versus 193.
Both class maps are closed-world gates: their keys and counts must match
exactly, so a new `catalog-missing` or other residual class fails the maintained
run rather than disappearing behind the documented partition.

The replay-only transaction shape is deliberately narrow:

```text
same owner within 1 ms:
  exactly one profiled 0x0369 add/update
  exactly one profiled 0x03F9 removal
  zero profiled 0x0146 removal-context packets
  resulting item has a non-empty Data Dragon `from` recipe
```

The candidate removed item must be an earlier historically observed same-owner
structural `0x0369` item ID in the result item's transitive `from` closure.
Historical order means an earlier packet timestamp, or the same timestamp in
the same segment with a lower `sourceOffset` than the `0x03F9` removal. This is
only a deduplicated set of previously observed add/update item IDs. It is not a
current inventory, item instance, continuity proof, or ownership-at-removal
claim. A static sibling alias is admitted only when both sorted `from` and
sorted `into` lists are identical; this covers the catalog's `2420`/`2421`
Armguard state boundary without a per-replay lookup. Any `0x0146`,
multi-operation, missing-recipe, or transform shape fails closed.

In each maintained run, the historically D7-designed rule and expected-count
gate pass before the harness opens the three H3 replays:

| Split | Real uniquely labelled removals | Recipe truth in candidate set | Mean candidates before / after | Exact singleton after | Still ambiguous |
|---|---:|---:|---:|---:|---:|
| Discovery (D7) | 209 | 209/209 | 10.27 / 1.50 | 138/209 | 71 |
| Holdout (H3) | 83 | 83/83 | 11.61 / 1.60 | 56/83 | 27 |
| Combined | 292 | 292/292 | — | 194/292 | 98 |

All 292 truths also occur among the historically observed replay-native
structural add/update item IDs under that physical-order rule. There are zero
wrong singleton targets and zero missing truths in the constrained sets. This
is exact evidence for a bounded recipe relation, not a full removal decoder:
98 targets remain ambiguous, sales are outside this rule, and `0x0146`, slot,
instance, undo, and transform semantics remain unavailable.

The harness does not attempt complete inventory reconstruction and therefore
does not report a synthetic participant success fraction. Its explicit boundary
is `completeInventoryReconstructionAttempted: false` and
`completeInventoryAvailable: false`.

The catalog does not by itself turn this constraint into a semantic decoder.
A replay-plus-static-metadata shortcut that infers every direct `from`
component for one-add/matching-removal groups reaches all 291 labelled groups
but also produces 60 extras (82.9% precision, 100% recall). Bounded packet
order/length, recipe/gold, prefix/bit, neighbour, and decision-tree filters do
not remove all extras without dropping real groups. Recipe-singleton labels
also yield no direct `0x03F9` item-ID slice or compact Boolean codec. A
stateful inventory/operation discriminator remains necessary.

A stricter online multiset prefix experiment starts every owner empty, consumes
events in exact replay source order, and stops permanently at the first
unresolved profiled operation. It accepts only proven pure adds or a direct
recipe whose complete component multiset is already present. Discovery reaches
15 accepted events, all pure starting-item adds, with 15/15 exact Timeline
labels and no extras. The frozen Holdout rule accepts eight locally exact adds
but one participant has an additional Timeline purchase inside the claimed
continuous prefix. No direct recipe is reached and no owner reaches the end of
the profiled stream, so final inventory validation is unavailable. This
falsifies promotion of the current prefix reducer; it does not falsify a future
stateful grammar that can classify the intervening operations.

A separate conservative slot/instance linkage audit pairs a removal with an
earlier add only when saved Timeline state leaves exactly one live source item.
This yields 15 D7 and 9 H3 pairs. An exhaustive one-to-eight-bit contiguous
slice/XOR search between the paired `0x0369` and `0x03F9` payloads has zero
exact D7 candidates; the best non-constant relation reaches only 13/15 before
it can be frozen. Consequently there is still no replay-native slot, instance,
or removal identity link, and H3 supplies evaluation evidence only rather than
a selected codec.

Stateful ordinals do not repair that link. Fifty D7 lookup hypotheses based on
owner-local purchase/removal ordinal and live-item count yield zero exact H3
mapping. Non-contiguous one-removal-bit versus one-to-three-add-bit XOR rules
leave 637 mutually non-unique H3 candidates, while nearby `0x02EB` inventory
anchors contain multiple item operations in 747 D7 and 352 H3 windows. These
collisions prevent interpreting any such relation as a slot or instance field.

Static item prices also fail to expose an operation gold scalar. A strict D7
set contains 710 non-recipe `0x0369` purchase labels with an exact decoded item
ID and 77 proven `0x03F9` sales, giving 787 pinned expected cost/gain values.
Direct signed/unsigned integers, ULEB/ZigZag varints, one-to-sixteen-bit
fields, successive same-owner packet deltas, and nearest owner `0x02EB` `i32`
deltas all have zero exact candidate (best raw hit 3/787; best keyframe hit
4/785). H3 remains unopened for this failed search. No purchase/sale gold
delta or current-gold field is decoded.

The same result holds outside the operation payloads. An exact D7 framing pass
over 9,908,848 chunk blocks retains 5,606 non-`0x0369`/`0x03F9` blocks within
one millisecond of those 787 labels, partitioned into 1,284
type/channel/length/prefix families. Direct integers, ULEB/ZigZag, every
little-endian one-to-sixteen-bit window, direction-aware amounts, and
same-owner family deltas produce no exact candidate; the best direct accident
matches only 15/787 labels. Since no D7 candidate reaches the false-positive
gate, H3 is intentionally unopened. There is no hidden co-timestamp gold
companion under this bound.

If this static grammar is ever promoted, its catalog bytes must be shipped and
fingerprinted beside the exact replay decoder profile. Selecting an unpinned
Data Dragon version, fetching `latest`, or consulting Match/Timeline at runtime
would violate the replay-only boundary.

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

A bounded raw-predicate audit rejects the simplest explanation for the missing
patch-16.14 Undo half. It scans all `9,908,848` D7 chunk blocks, including
`971,445` channel-1 blocks with exact champion ownership, and evaluates
`3,481,871` classifiers of the form packet type + content length + exact payload
prefix through 16 bytes against the 17 D7 Undo labels not covered by `0x0081`.
No classifier covers all targets before extra rejection; `0x0081` remains the
zero-extra negative control at 23/40 D7 labels and covers 0/17 missing labels.
With no exact Discovery candidate, H3 is deliberately unopened. This
falsifies a second single-family constant-prefix classifier within that bound;
it does not falsify a multi-packet, stateful record grammar or decode item,
slot, instance, before/after identity, or operation ordering.

For the 31 already exact `0x0081` anchors themselves (23 D7, 8 H3), the same
owner/time/chunk context contains no profiled `0x0369`, `0x03F9`, or `0x0146`
operation. The nearest preceding profiled operation agrees with the offline
Undo `beforeId` only 5/23 and 1/8 times; even a 60-second lookback reaches just
6/23 and 2/8. No payload byte maps exactly to `beforeId`, `afterId`, or
`goldGain`. Thus the exact partial Undo timing anchor still cannot drive a
state reducer or before/after inventory transition.

Comparing those chunks with the nearest same-owner `0x0081` keyframe component
also fails: D7 has 23 preceding and 7 following pairs, H3 has 8 and 2, but no
full payload equality, complete chunk-as-keyframe subsequence, shared four-byte
prefix, or common aligned XOR edit. Even same-segment pairs do not copy a
record, and owner-local ordinals are not stable. The shared packet type is
component-family evidence only, not a before/after serialization link.

The repeated `BE C7 1F 76` / `BE C9 1F 76` markers are likewise not a record
grammar. Splitting on them is byte-lossless for all 5,798 surveyed patch-16.9
payloads, but no bounded byte, `u16`, LEB128, or mask field encodes each body's
length, ordinal, or remaining count exactly. Prefix/suffix clusters conflict
in Holdout, and Undo chunks have only sparse, ordinal-unstable full-body
matches to nearby keyframes. Marker occurrence must remain structural scratch
evidence rather than runtime framing or instance identity.

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
derive the field/symbol grammar for `0x0132` and `0x0415` exclusively from the
saved replay corpus. Older decoded packet schemas suggest that buy, remove,
swap, and use may be separate messages with explicit slot fields, but that is
only a structural search clue, never a decoder dependency or proof for 16.9.

Client/game binaries, client-side packet traces, running League/Riot processes,
and Vanguard-managed data are outside this research boundary and must not be
used to obtain a deserializer or symbol table. Productive evidence must come
from saved `.rofl` packet bytes, this repository's parser/tools, replay-native
final `statsJson`, and saved Riot API fixtures used only as offline validation
oracles. Once slot identity and swaps are replay-natively available, the reducer
can maintain seven slots per participant and validate each reconstructed final
inventory against its replay's embedded final state.

Structural reference only:

- [Older decoded replay packet schema](https://huggingface.co/datasets/maknee/league-of-legends-decoded-replay-packets/blob/main/packets.py)
- [Dataset scope and covered patches](https://huggingface.co/datasets/maknee/league-of-legends-decoded-replay-packets/blob/main/README.md)

After patch 16.9 reaches the full-state gate, repeat the derivation behind a
versioned profile for 16.7 before exposing inventory events through C++/Wasm.
