# Replay inventory packet research

## Status

Patch 16.9 has a reproducible, exact decoder for the item ID carried by the
14/15-byte inventory add/update packet family. This is a real replay-native
field, but it is not yet a complete inventory transaction decoder.

For exact build `16.14.794.5912`, the shared C++ core, Wasm boundary, and Vue
client productively expose three external-profile-only schemas:
`rofl-replay-purchase-linked-item-updates/v1` for strict transform/resulting
updates, and `rofl-replay-direct-item-purchases/v1` for strict isolated direct
adds, plus `rofl-replay-item-sales/v1` for exact sale operations without an
item identity. All consume only the loaded `.rofl` and canonical local profile
bytes; saved Riot fixtures remain offline discovery/validation oracles and are
never runtime inputs or fallbacks.

Runtime promotion remains blocked for complete inventory reconstruction because
the 6/7-byte removal family still has no decoded slot or item-instance
reference. Consequently, a removal cannot yet be mapped to the item that left
a champion's inventory without using an offline Riot label.

The canonical profile revision is `2026-07-21`, SHA-256
`f690f77926c09d28998c52e5a56044c4575a23a268f49328c071be02d2359cce`, with
fingerprint `fnv1a64:10b2b8d2727009a0`.

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

## Patch-16.14 productive sale-operation subset

The ten saved patch-16.14 replay/fixture pairs establish a version-specific,
productive but deliberately operation-only result:
`rofl-replay-item-sales/v1`. It emits a replay-native participant, timestamp,
sale-operation classification, and exact removal-block provenance. It does not
decode the sold item identity, slot, instance, count/charges, price, gold gain,
undo, or a complete inventory state.

Reproduce it with the native CLI already built:

```powershell
node .\scripts\validate_replay_item_sales_corpus.mjs
```

The productive validator invokes the native extractor only with the saved
`.rofl` and canonical external profile, then opens saved Match-V5/Timeline
fixtures as offline validation oracles. It validates 77/77 D7 plus 39/39 H3
events, 116/116 combined, with zero extras, zero misses, and at most one
millisecond timing delta. The older
`artifacts/inventory-packet-research-16.14.json` remains research-only evidence
and is not a runtime input.

| Candidate family                     | Channel | Packet type | Content lengths | Owner formula             | Corpus count |
| ------------------------------------ | ------: | ----------: | --------------: | ------------------------- | -----------: |
| inventory add/update                 |       1 |    `0x0369` |           14/15 | `blockParam - 0x400000AD` |        2,519 |
| inventory removal                    |       1 |    `0x03F9` |             6/7 | `blockParam - 0x400000AD` |        2,074 |
| unresolved removal-context companion |       1 |    `0x0146` |           2/3/4 | `blockParam - 0x400000AD` |        4,214 |

The external profile freezes the productive sale predicate: exactly zero
profiled `0x0369` adds of length 14/15 and exactly one `0x03F9` removal of
length 6/7 for the champion owner at the exact replay timestamp; the removal
must have `payload[0] & 0x0f` in `{2, 5}`, `payload[2] & 0x03 != 3`, and
`payload[2]` in `{0x30, 0x6e, 0x7a, 0xea, 0xee, 0xf9}`. Unknown variants fail
closed. The classification proves a sale operation, not what was sold. The
Vue product view renders it only as a separate orange timeline stream and
never mutates an inventory.

The 16.9 add/update item-ID formula is a negative control on this new family:
it matches `0/1,971` unique one-purchase/one-add labels (all 1,971 mismatch).
It must therefore not be ported or parameterized as a 16.14 item-ID decoder.

The separate fail-closed bit-grammar harness now establishes all 13 positions
of the 16.14 item-ID lane across those same 1,971 labels. Seven formulas were
found during the earlier full-corpus exploration:

| Item-ID bit | Replay-native formula (little-endian payload-bit numbering) |
| ----------: | ----------------------------------------------------------- |
|           0 | `payloadBit(71)`                                            |
|           1 | `payloadBit(66) XOR payloadBit(71) XOR 1`                   |
|           5 | `payloadBit(70) XOR 1`                                      |
|           6 | `payloadBit(69) XOR payloadBit(70) XOR 1`                   |
|           7 | `payloadBit(78) XOR payloadBit(79)`                         |
|          10 | `payloadBit(73) XOR payloadBit(76) XOR 1`                   |
|          12 | `payloadBit(78) XOR 1`                                      |

The remaining six formulas were then selected only on seven fixed Discovery
replays. With `qN = payloadBit(N)`, they are:

| Item-ID bit | Formula                                                                                           |
| ----------: | ------------------------------------------------------------------------------------------------- |
|           2 | `q65 XOR (q66 AND q71)`                                                                           |
|           3 | `1 XOR q65 XOR q68 XOR (q66 AND q71) XOR (q65 AND q66 AND q71)`                                   |
|           4 | `1 XOR q67 XOR q68 XOR (q65 AND q68) XOR (q66 AND q68 AND q71) XOR (q65 AND q66 AND q68 AND q71)` |
|           8 | `1 XOR q74 XOR q79 XOR (q72 AND q79)`                                                             |
|           9 | `q73 XOR (q73 AND q79) XOR (q72 AND q73 AND q79)`                                                 |
|          11 | `1 XOR q75 XOR q76 XOR (q73 AND q76)`                                                             |

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
result for the _complete relevant profiled owner/time-group population_,
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

### Patch-16.14 strict direct add-only purchase subset

The complementary direct-purchase gate avoids interpreting every add/update as
a buy. It starts from one champion-owned channel-1 `0x0369` add of exact length
14 or 15 in an owner/time group, then requires that the same owner has no
relevant `0x0369`, `0x03F9`, `0x0146`, or `0x0081` operation within +/-1 ms.
Thus it deliberately excludes transformations, removals, contextual changes,
and Undo-adjacent operation groups rather than guessing their semantics.

The replay-derived structural 13-bit item ID is then filtered by static item
metadata embedded in the canonical external profile. The metadata is exactly
the saved official Riot Data Dragon `16.14.1` `en_US` catalog, 583,139 bytes,
706 catalog entries, SHA-256
`0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75`. Its
frozen semantic-free selection contains 212 purchasable Summoner's-Rift real
item IDs at or below 8191 and 71 buildable component IDs whose Data Dragon
`into` relation is non-empty. The strict loader compares both complete arrays
against the frozen catalog, so matching metadata and list sizes alone cannot
widen the gate. It classifies only the already
decoded replay item ID and supplies no match-state fallback. 2,010/2,422
static-grant/non-real candidates are rejected instead of emitted.

This is promoted through C++, the Native CLI, the Wasm ABI, TypeScript, and the
Vue product view as `rofl-replay-direct-item-purchases/v1` for exact build
`16.14.794.5912`. It must have the canonical external profile; missing,
invalid, built-in, ambiguous, or other-build selection is unavailable. The
runtime event includes timestamp, replay-native participant/network ID,
structural item ID, a component flag, and exact add-block provenance. It makes
no claim about slot, item instance, count/charges, price, gold, removal, undo,
or current inventory state.

Reproduce its corpus gate with:

```powershell
node .\scripts\validate_replay_direct_item_purchases_corpus.mjs
```

Across the fixed seven-replay D7 and three-replay H3 split, it emits 844/844
D7 plus 434/434 H3 exact purchases, 1,278/1,278 combined, with zero extras,
zero wrong IDs, and a maximum one-millisecond timestamp delta. It includes
710/710 D7 plus 333/333 H3 buildable-component purchases, 1,043/1,043 combined. Its emitted
events are disjoint from the 193 strict purchase-linked resulting-item updates;
together, the two productive streams exactly recover 1,471/1,973 saved
Timeline purchase labels (74.6%). Timeline is only the offline corpus oracle,
not a runtime input.

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

| Fixture property    | Required value                                                     |
| ------------------- | ------------------------------------------------------------------ |
| Data Dragon version | `16.14.1`                                                          |
| Catalog entries     | 706                                                                |
| Byte length         | 583,139                                                            |
| SHA-256             | `0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75` |

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

| Split          | Real uniquely labelled removals | Recipe truth in candidate set | Mean candidates before / after | Exact singleton after | Still ambiguous |
| -------------- | ------------------------------: | ----------------------------: | -----------------------------: | --------------------: | --------------: |
| Discovery (D7) |                             209 |                       209/209 |                   10.27 / 1.50 |               138/209 |              71 |
| Holdout (H3)   |                              83 |                         83/83 |                   11.61 / 1.60 |                 56/83 |              27 |
| Combined       |                             292 |                       292/292 |                              — |               194/292 |              98 |

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

### Sale, Undo, and current-gold adjustment follow-up

Two exact-build research harnesses now connect the replay-native spent-like
keyframe lane, offline shop operations, and the six-record `0x0081` history
component without promoting a product field:

```bash
node scripts/research_inventory_gold_adjustments_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --item-data /path/to/Data-Dragon-16.14.1-item.json

node scripts/research_inventory_sale_identity_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --item-data /path/to/Data-Dragon-16.14.1-item.json

node scripts/research_inventory_removal_slots_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli
```

The gold and sale-identity scripts require the same byte-length- and
SHA-256-pinned `16.14.1` catalog described above; the removal-slot harness does
not. They perform no network lookup. Saved Timeline values and item events are
offline labels only.

The `[107,109,111,113]` spent-like lane follows a static-recipe purchase ledger
plus `ITEM_UNDO.goldGain` on 2,004/2,100 D7 and 941/1,000 frozen H3 keyframe
transitions. Undo intervals alone agree on 32/33 D7 and 17/17 H3 transitions;
the sole difference is a one-minute interval containing several other item
operations. This supports net cumulative spending semantics: undoing a purchase
reduces the lane by its refund, while undoing a sale increases the lane by the
reacquisition cost. All 16 sale-Undo intervals agree with that signed adjustment;
purchase-Undo intervals agree in 35/36 cases. It does not make Timeline
`goldGain` a runtime input.

Sale proceeds remain separate from that lane. Adding cumulative pinned sale
proceeds to `trunc(totalGold) - trunc(spentLike)` improves exact offline
current-gold snapshots from 1,321/3,200 to 1,459/3,200. It does not close the
gate; systematic residuals remain, and the replay sale stream still lacks the
sold item needed to choose a static price. Current spendable gold therefore
remains unavailable.

An exhaustive decoded-keyframe correction scan covers every contiguous and
stride-2 8/16/32-bit integer and Float32 candidate in the 1,479-byte `0x02EB`
payload. Its best result is a decoded zero constant, matching 1,086/2,170 D7
and 374/1,030 H3 residual rows without improving the ledger calculation. No
numeric replay-native correction field is found.

### Removal-slot candidate

The exact-build `0x03F9` family has a complete seven-value structural candidate:

| Payload | Replay bits | Candidate slot | Combined packets |
| ------- | ----------- | -------------: | ---------------: |
| 6 bytes | `bit7=0, bit8=0` | 0 | 180 |
| 6 bytes | `bit7=1, bit8=1` | 1 | 208 |
| 6 bytes | `bit7=1, bit8=0` | 2 | 278 |
| 7 bytes | `bit16=1, bit17=0` | 3 | 321 |
| 7 bytes | `bit16=0, bit17=1` | 4 | 491 |
| 7 bytes | `bit16=0, bit17=0` | 5 | 284 |
| 7 bytes | `bit16=1, bit17=1` | 6 | 312 |

The unused six-byte symbol `bit7=0, bit8=1` never occurs. All 2,074 packets
decode structurally: 1,293 D7 and 781 H3, with every candidate slot represented
in both partitions. Of 535 owner/timestamp groups containing multiple
removals, 506 use distinct candidate slots and 29 repeat one under unresolved
stack/count/update behavior.

The semantic anchor is exact but partial. Saved Timeline is an offline oracle
for 72 strict two-event trinket replacements; every corresponding replay
removal decodes candidate slot 6 (50/50 D7 and 22/22 H3). The 116 exact sale
operations cover candidate slots 0 through 5. Their operation nibble is `5` in
112 rows and `2` in four probable partial-stack sales, but count semantics are
not promoted.

The preceding six-record `0x0081` component supplies a noisy cross-check rather
than current state. For 111 sales with one unique historical sold-item record,
`candidateSlot == 5 - recordOrdinal` in 108 cases. The remaining three are
retained because manual rearrangement or another state transition can occur
after the keyframe. Slots 0-5 therefore still lack a zero-error semantic oracle,
and the candidate is deliberately absent from C++, Wasm, and product schemas.

The identity follow-up also rejects several tempting shortcuts. The preceding
six-record `0x0081` history component contains the offline sold item for
74/77 D7 and 38/39 H3 sales. Among the 111 rows where that item occurs exactly
once, every 7-byte removal corresponds to history ordinal 0-2 and every 6-byte
removal to ordinal 3-5. This is a reproducible candidate-set constraint, not a
slot decoder: the component was already falsified as current inventory, four
sales lack their truth item, and each half normally contains three different
items and prices.

Frozen D7-to-H3 searches for raw removal-to-item, removal-to-price, and
removal-to-history-ordinal lookup fields fail with held-out wrong labels.
Direct add/removal XOR and history-record/removal XOR searches also fail; the
best direct record linkage selects zero rows. Consequently sold identity,
physical inventory slot, item instance, sale gold gain, and full inventory
state remain unpromoted.

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
| ------- | ----------: | --------------- | ------------------------: | -----: | -----: |
| `16.9`  |    `0x0165` | chunk / 1       |                    78/147 |      0 | 53.06% |
| `16.14` |    `0x0081` | chunk / 1       |                     31/62 |      0 | 50.00% |

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

### Keyframe `0x0081` current-inventory falsification (patch 16.14)

The maintained harness
[`research_keyframe_inventory_slots_16_14.mjs`](../scripts/research_keyframe_inventory_slots_16_14.mjs)
tests the tempting interpretation that the champion-owned keyframe `0x0081`
component is a six-slot current inventory. Saved Match and Timeline files are
offline validation oracles only; all candidate structure and values come from
the loaded replay.

There is real, exact structure here. Every one of the 3,200 champion/keyframe
payloads contains six trailing records selected without labels by the marker
`(0xC0|0xC3) · ?? · ?? · 0xE6`. The exact patch-16.14 item-ID Boolean grammar
reused from `0x0369` decodes plausible item symbols at stable record-relative
offsets. On final participant tracks with no later labelled item operation,
404/438 expected occupied-item labels occur somewhere in the payload and
392/438 occur in the hypothesized corresponding record.

That evidence does **not** describe current inventory. After aligning each
keyframe component with the preceding keyframe time and reducing saved
Timeline item operations only as an offline oracle, only 1,732/3,200 candidate
multisets are exact. More importantly, 1,049/3,200 snapshots contain a decoded
item that the oracle inventory has already removed. The failure reproduces in
the frozen split: 675/2,170 D7 and 374/1,030 H3 snapshots have false-extra
items. Components and sold/destroyed items can persist, which is consistent
with the prior shop/Undo component evidence rather than physical champion
slots.

The current-inventory and slot-ordinal hypotheses are therefore rejected.
Record boundaries and reused item symbols remain useful structural evidence,
but they do not authorize a C++/Wasm/product inventory field.

A narrower add/record-change gate remains useful for further grammar search.
It selects intervals containing exactly one Timeline purchase label, one
replay-native `0x0369` add with the same decoded item, and one changed `0x0081`
historical record. This yields 126 D7 and 55 H3 rows across all six main record
ordinals. No contiguous one-to-eight-bit add-payload lookup is conflict-free on
Discovery, so the record ordinal cannot yet place the added item in a runtime
slot reducer.

The follow-up companion scan widens the packet search without widening the
semantic claim. For every one of those 181 anchors it uses the native bounded
packet-window command to inspect all exact-framed, same-owner channel-1 chunk
packets within `+/-1 ms` of the `0x0369` add. It evaluates both variable-length
packet-type families and exact packet-type/content-length families. Of 43
family representations, only `type:873` (`0x0369`) is present in every one of
the 126 Discovery windows; no separate companion has complete support. First
and last occurrences plus every contiguous one-to-eight-bit field produce zero
conflict-free six-record-ordinal lookup on Discovery, so Holdout has no selected
candidate to promote.

```bash
node scripts/research_inventory_add_slot_companions_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --keyframe-research tmp/keyframe-inventory-slots-research-16.14.json \
  --output tmp/inventory-add-slot-companions-research-16.14.json
```

The same keyframe harness now freezes 21 no-item-event, same-multiset record
reorderings (12 D7, 9 H3). These are useful negative swap anchors, not physical
swap labels. A replay-only window scan finds five intervals with none of the
profiled add, removal, removal-context, or chunk Undo-component families and
zero packet type/length/four-byte-prefix signatures occurring exactly once in
all 21 windows. Fourteen windows contain 21 `0x0146` packets, but six repeated
payloads each span different inferred record movements. In particular,
`c550cb` occurs with both record `5 -> 4` and `4 -> 5`. That contradiction
rejects interpreting the payload as a direct source/destination slot symbol
under this record model.

```bash
node scripts/research_inventory_rearrangement_windows_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --keyframe-research tmp/keyframe-inventory-slots-research-16.14.json \
  --output tmp/inventory-rearrangement-windows-research-16.14.json
```

Both scans use `--dump-packet-window-json`, which filters timestamp, channel,
and optional owner during the native framing pass rather than materializing an
all-type replay dump. This keeps exact operation-window research bounded while
retaining segment and packet provenance.

### Replay-only backward reducer from final inventory

[`research_inventory_backward_reducer_16_14.mjs`](../scripts/research_inventory_backward_reducer_16_14.mjs)
tests a stateful alternative to direct slot-field searches. Its match-state
anchor is the seven final item slots in each saved ROFL's embedded `statsJson`,
read through the productive validated summary. It then walks the four profiled
item families backward with exact participant, timestamp, source order, and
packet provenance:

- a decoded `0x0369` add is undone only by removing its item from a compatible
  concrete or symbolic slot;
- a low-nibble-`5` `0x03F9` removal is undone only by restoring a unique
  provenance-keyed symbol into its candidate slot when that slot is empty;
- productive `rofl-replay-item-sales/v1` provenance marks which symbols are
  sale candidates;
- `0x0146`, chunk `0x0081`, non-`5` removal operations, duplicate candidate
  slots, unknown add symbols, state contradictions, and excessive branching
  stop the participant track instead of being guessed.

The symbolic reducer has an always-run synthetic identity/linkage self-test.
Its corpus gate covers 4,645 D7 and 2,273 H3 relevant owner/time groups. The
final-state suffix reaches only 24 D7 and two H3 groups. Fifty D7 and 23 H3
tracks stop at `0x0146`/Undo-component groups; another 20 D7 and seven H3 stop
at an unresolved removal operation. Four of 77 D7 sales are encountered, zero
of 39 H3 sales are encountered, and no sale symbol can be linked back to an
earlier decoded add. Offline Timeline validation therefore records
`0 exact / 0 wrong / 116 unavailable` sold-item identities.

```bash
node scripts/research_inventory_backward_reducer_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --decoder-profiles packages/rofl-core/profiles/replay-decoder-profiles.v1.json \
  --output tmp/inventory-backward-reducer-research-16.14.json
```

This rejects final-state anchoring as a shortcut around unresolved operation
semantics. It does not reject a future reducer after `0x0146`, non-sale
`0x03F9`, add placement, swaps, counts, and instances are decoded. No sold item,
sale price, current-gold correction, or dynamic inventory state is promoted.

### Timeline-oracle backward slot diagnostic

[`research_inventory_timeline_oracle_backward_slots_16_14.mjs`](../scripts/research_inventory_timeline_oracle_backward_slots_16_14.mjs)
tests whether the saved Timeline supplies the identities missing from the
replay-only reducer. It remains deliberately offline: the final seven slots,
champion identity, `0x03F9` candidate slots, and sale provenance come from the
ROFL; Timeline item events drive only this diagnostic.

The strict seven-slot solver enumerates same-timestamp event order, duplicate
items, empty-slot placement, and identity-to-removal-slot assignments. It
reverses 268/2,135 D7 and 98/1,095 frozen H3 groups. This includes 169 groups
whose destroyed/sold identities are constrained by distinct replay candidate
slots and 29 sale groups, but all 100 participant tracks hit a state
contradiction before the beginning.

An independent per-item balance makes the cause measurable without slot
branching. Starting at the replay-final multiset and reversing all 4,977 saved
Timeline item labels produces:

- 13 negative units across 13 participant tracks, proving that some recorded
  creations lack a corresponding removal/final item under the naive grammar;
- 858 positive units, with 36 tracks exceeding the seven-slot capacity and no
  participant reaching an exact zero balance;
- 198 positive units on the two Viego tracks alone, including impossible
  131- and 67-unit beginnings. Their broad cross-build item sets are strong
  evidence that possession copies/destruction share the Timeline item-event
  vocabulary;
- 660 positive units outside Viego, so possession is not the only gap. System
  IDs `2001`/`2002`, `120x` perk/quest items, consumables, trinkets, and
  `386x` support-item transformations dominate the residual.

A separate 64-state bounded diagnostic may skip a label instead of forcing it
into a slot. Its best observed histories still skip 1,022 mutations (775
destroyed, 228 purchased, 14 sold, five undo), and only five of 100 end with an
empty beginning. This is an upper-bound diagnostic rather than a global
minimum, but the exact balance contradictions already prove that Timeline is
neither complete nor slot-pure.

```bash
node scripts/research_inventory_timeline_oracle_backward_slots_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --decoder-profiles packages/rofl-core/profiles/replay-decoder-profiles.v1.json \
  --output tmp/inventory-timeline-oracle-backward-slots-16.14.json
```

The useful next split is therefore semantic, not another unconstrained reverse
trace: isolate Viego possession copies, non-inventory system/perk records,
consumable use, trinket replacement, and support-item transformations, then
map each class back to replay packets. Timeline remains an oracle for those
classes and never a runtime reducer input.

```bash
node scripts/research_keyframe_inventory_slots_16_14.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --output tmp/keyframe-inventory-slots-research-16.14.json
```

The repeated `BE C7 1F 76` / `BE C9 1F 76` markers are likewise not a record
grammar. Splitting on them is byte-lossless for all 5,798 surveyed patch-16.9
payloads, but no bounded byte, `u16`, LEB128, or mask field encodes each body's
length, ordinal, or remaining count exactly. Prefix/suffix clusters conflict
in Holdout, and Undo chunks have only sparse, ordinal-unstable full-body
matches to nearby keyframes. Marker occurrence must remain structural scratch
evidence rather than runtime framing or instance identity.

## Patch-16.9 profile

| Semantic candidate       | Channel | Packet type | Content lengths | Champion ID base |
| ------------------------ | ------: | ----------: | --------------: | ---------------: |
| inventory add/update     |       1 |    `0x0132` |           14/15 |     `0x400000AD` |
| inventory removal/update |       1 |    `0x0415` |             6/7 |     `0x400000AD` |

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

| Result                               | Count |
| ------------------------------------ | ----: |
| uniquely labelled add/update packets | 3,716 |
| distinct labelled API item IDs       |   171 |
| direct item-ID matches               | 3,714 |
| explained automatic transforms       |     2 |
| unexplained mismatches               |     0 |

The two non-identical labels are semantically correct resulting inventory
items rather than decoder errors:

| Replay            | Participant | API purchase | Same-time API destroy |   Replay-decoded result |
| ----------------- | ----------: | -----------: | --------------------: | ----------------------: |
| `EUW1-7838031220` |           6 |         3119 |                  3119 |     3121 (Fimbulwinter) |
| `EUW1-7838099746` |           8 |         3003 |                  3003 | 3040 (Seraph's Embrace) |

This establishes that `0x0132` represents resulting inventory add/update
state. It must not be renamed to `ITEM_PURCHASED`: automatic transforms and
stack/state updates use the same family.

## Transaction-shape audit

The 20-replay corpus contains:

| Evidence                                | Count |
| --------------------------------------- | ----: |
| Riot item events used as offline labels | 8,874 |
| `ITEM_PURCHASED`                        | 4,488 |
| `ITEM_DESTROYED`                        | 4,050 |
| `ITEM_SOLD`                             |   189 |
| `ITEM_UNDO`                             |   147 |
| replay add/update packets               | 4,454 |
| replay removal packets                  | 3,550 |

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

| Cross-check                                                   | Samples |      Best result |
| ------------------------------------------------------------- | ------: | ---------------: |
| same-item replacement removal field                           |     151 |  72/151 (47.68%) |
| offline-labelled add/removal lifecycle link, slot-sized field |     882 | 675/882 (76.53%) |
| candidate-state removal slot field                            |     733 | 420/733 (57.30%) |

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
