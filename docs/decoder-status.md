# Replay Decoder Status

Updated: 2026-07-24
Baseline commit: `fe39e13`

This is the canonical handoff for the current decoder state. Read it before
continuing reverse engineering. Detailed evidence and reproduction commands
live in the linked research notes.

## Product Goal

The target is a local-first, replay-only reconstruction pipeline:

```text
.rofl bytes
  -> container and packet framing
  -> patch-profiled semantic decoders
  -> normalized match model
  -> C++ native tools and browser Wasm
  -> Vue timeline, 2D map, inventories, stats, and analytical overlays
```

At runtime, the loaded replay must be the only match-data source. Riot Match-V5
and Timeline fixtures may be used offline to discover and validate semantics,
but they must never be required by the decoder or silently fill missing replay
fields in the product.

Decoder research has the same hard local safety boundary. It may inspect saved
`.rofl` files and their patch-versioned packet bytes with this repository's own
parser and may compare results with saved Riot fixtures offline. It must never
execute, inspect, instrument, patch, or emulate installed League/Riot client or
game binaries, running League/Riot processes, Vanguard, or Vanguard-managed
data. Disabling or bypassing Vanguard is not part of this project.

## External decoder profiles

The productive version/build grammar is supplied through the strict external
`rofl-replay-decoder-profiles/v1` asset at
[`packages/rofl-core/profiles/replay-decoder-profiles.v1.json`](../packages/rofl-core/profiles/replay-decoder-profiles.v1.json).
Native and Wasm use the same C++ loader/interpreter. The CLI accepts optional
`--decoder-profiles`; the product web path passes canonical JSON bytes through
the per-call Wasm ABI. Built-in profiles are only a backwards-compatibility
fallback for callers without an external asset.

Selection is exact by replay version/build. The loader has a 256 KiB limit,
strict validation, fail-closed behavior, and selected-profile provenance
fingerprinting. An opcode-only patch update needs a profile/frontend-asset
update, not a Wasm rebuild. A new semantic grammar still requires C++ code and
replay-only validation; profiles do not infer semantics autonomously. See
[`decoder-profiles.md`](decoder-profiles.md).

The intended result is an analytics-grade reconstruction, not a replacement
for Riot's 3D game engine. The model should eventually include champion and
entity movement, combat and objective events, wards and vision, inventories,
gold, level, XP, CS, health, resources, damage, and other state that can be
proven from replay bytes.

## Productive Replay-Only Runtime

The following paths are implemented in the shared C++ core, exposed through
Wasm, and consumed by the Vue application unless noted otherwise.

| Area                                   | Replay-derived output                                                                                                                                                                                                                                                      | Validation / boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Container                              | Metadata offsets, payload/header boundaries, match ID when present, chunk/keyframe counts, segment table, Zstd/footer records, and exact packet-block framing with timestamps, channels, packet types, block parameters, payload boundaries, and provenance                | Container and packet framing are productive. `payloadDecodingAvailable` means payload packets are readable, not that every semantic stream is decoded.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Participant summary                    | Champion, Riot ID name/tag, team, `teamPosition`/role (TOP, JUNGLE, and so on; not map coordinates), win, and final K/D/A, level, XP, lane CS, neutral CS, seven item slots, ward aggregates, gold earned, damage to champions, and vision score from embedded `statsJson` | Final match state only; these are not timelines. The productive native summary validates level, XP, both CS fields, all item slots, and both ward aggregates exactly for 6,110/6,110 values across all 470 corpus participants. `validatedFinalPlayerStatsAvailable` requires one of the eight validated patch groups and a complete valid field set; otherwise the product shows unavailable. `participantId = statsJson index + 1` is validated for the same participants. Gold remains replay-native cumulative earned gold and is not part of that exact 6,110-field claim.                  |
| Champion kills                         | Timestamp, victim, killer or execution, ordered assists, network IDs, and source provenance in `rofl-replay-kills/v1`                                                                                                                                                      | Historical corpus: 2,796/2,796 kills over 47 replays, maximum 1 ms delta. External profile build `16.14.794.5912`: 684/684. Victim, killer, ordered assists, final K/D/A, and participant identity all validate exactly. Kill position, damage source, and gold/bounty are unresolved.                                                                                                                                                                                                                                                                                                           |
| Elite objectives                       | Timestamp, broad monster class, discriminator, and source provenance in `rofl-replay-objectives/v1`                                                                                                                                                                        | Historical corpus: 425/425. External profile build `16.14.794.5912`: 99/99. Supports Dragon, Baron, Rift Herald, Horde/Void Grubs, and Atakhan where present. Killer/team, elemental dragon subtype, and position are unresolved.                                                                                                                                                                                                                                                                                                                                                                |
| Ward lifecycle                         | Standard-ward placement timestamp, ward entity ID, owner participant, conservative ward-kill timestamp, linked ward entity ID, killer participant, and source provenance in `rofl-replay-wards/v1`                                                                         | Historical corpus: 6,168/6,168 placements; 1,882/1,883 removals with zero extras. External profile build `16.14.794.5912`: 1,477/1,477 placements and 484/484 removals. Ward subtype, position, vision radius, and removal reason are unavailable.                                                                                                                                                                                                                                                                                                                                               |
| Purchase-linked resulting-item updates | Timestamp, participant, resulting item ID, matched strict bundle template, and packet provenance in `rofl-replay-purchase-linked-item-updates/v1`                                                                                                                          | External-profile-only, exact build `16.14.794.5912`: 193/193 offline-validated updates (D7 130, H3 63), zero extras/wrong IDs, maximum 1 ms delta. Strict subset only: 2,326/2,519 profiled add/update packets remain unavailable; no slot, instance, removal/component identity, count, complete inventory, price/gold, or undo state.                                                                                                                                                                                                                                                          |
| Direct add-only item purchases         | Timestamp, replay-native participant, structural 13-bit item ID, buildable-component flag, and add-block provenance in `rofl-replay-direct-item-purchases/v1`                                                                                                              | External-profile-only, exact build `16.14.794.5912`: 1,278/1,278 exact purchases (D7 844, H3 434), zero extras/wrong IDs, maximum 1 ms delta. This includes 1,043/1,043 buildable components (D7 710, H3 333). It accepts only an isolated champion-owned channel-1 `0x0369`, length 14/15 add, with no relevant `0x0369`/`0x03F9`/`0x0146`/`0x0081` family operation for that owner within +/-1 ms and a decoded ID in the profile-pinned static real-item catalog. It does not expose a general purchase classifier, slot, instance, quantity, price, gold, removal, undo, or inventory state. |
| Item sale operations                   | Timestamp, replay-native participant, exact sale-operation classification, and removal-block provenance in `rofl-replay-item-sales/v1`                                                                                                                                     | External-profile-only, exact build `16.14.794.5912`: 116/116 offline-validated sale operations (D7 77, H3 39), zero extras/misses, maximum 1 ms delta. The event proves only the operation and its source block; sold item ID, slot, instance, count/charges, price, gold gain, undo, and inventory state are explicitly unavailable.                                                                                                                                                                                                                                                            |
| Keyframe participant stat snapshots    | Timestamp, replay-native participant, Float32 XP, XP-derived level, Float32 total gold, integer lane CS, and projected integer neutral/jungle CS in `rofl-replay-participant-stat-snapshots/v3`                                                                            | External-profile-only, exact build `16.14.794.5912`: champion-owned keyframe `0x02EB`, 1,479-byte payloads, a profile-pinned 256-byte cipher-to-plain permutation, and fixed interleaved Float32LE stripes. D7/H3: all 2,170/1,030 snapshots are finite and monotonic; level agrees with all 3,200 saved Timeline frames, floored XP agrees for 3,198/3,200 with only two frozen ordering boundaries, lane CS remains integral, and the D7-frozen neutral-CS projection agrees 3,200/3,200. Timeline data is never a runtime input or fallback. |

The historical built-in coverage includes patch groups `15.22`, `15.23`,
`15.24`, `16.1`, `16.5`, `16.6`, `16.7`, and `16.9`. The externally supplied
profile additionally validates exact build `16.14.794.5912`: 684/684 kills,
99/99 objectives, 1,477/1,477 ward placements, 484/484 ward removals, and
1,300/1,300 final player-stat values. The same exact external profile also
enables the strict 193/193 purchase-linked resulting-item-update subset, the
strict 1,278/1,278 direct-add-only purchase subset, and the exact 116/116
item-sale-operation stream. It also enables the profile-backed keyframe XP,
level, total-gold, lane-CS, and neutral-CS snapshot surface; none of these exact-build
surfaces is available through built-in fallback profiles. The profile revision
is `2026-07-24`, its SHA-256 is
`ca5696864d60d9a7667cfbe3221be1303d3f248de10983b05389fc8275eeaf7a`, and its
provenance fingerprint is `fnv1a64:5d6e6dfe099ce86f`.

The browser decoding layer exposes the real Wasm participant summary, kill
timeline, objective timeline, ward lifecycle, both exact-build item-purchase
subsets, the exact-build item-sale-operation stream, and exact-build
replay-native keyframe XP/level/total-gold/lane-CS/neutral-CS snapshots for the locally
loaded replay. Not every decoded research stream is mounted in the product
view.

The default browser landing page is a focused timeline product view. Its
full-width scrubber and event list contain only replay-native champion kills
and elite objectives. Ward lifecycle, purchase subsets, and sale operations
remain available to research/debug tooling but are deliberately absent from the
product timeline. Compact champion cards show the champion portrait, player,
role, scrub-time K/D/A, and—where the exact-build external profile is
present—derived level, lane CS, and neutral/jungle CS. Cumulative total gold is not shown as
spendable current gold. Partial purchase and operation streams are not shown as
inventory slots or current inventory. Final inventories, fake health/resource
bars, the minimap, explanatory decoder copy, and ward-position research
controls are not shown on the product landing page. Current spendable gold and
complete timeline inventory remain unavailable pending replay-native decoders.

Item IDs are resolved only for presentation through official static Data Dragon
data. The productive replay build `16.14.794.5912` is explicitly pinned to Data
Dragon `16.14.1`; the browser never discovers a moving `latest` revision. The
presentation layer supplies localized names and icon URLs, fails softly back to
the numeric ID, and has no Match-V5 or Timeline input. It cannot turn the strict
item-update subset into slots, removals, transactions, or current inventory
state. Summary, fixture views, decoder tools, and position hypotheses remain
Research & Debug concerns.

The 16.14 external profile does not alter that boundary: its ward-position
research has zero valid coordinate candidates, so ward position remains
unavailable.

### Rich final-state export

A separate native/offline API-parity exporter can emit roughly 114 API-shaped
final participant fields for patch `16.9`, including final items, level, XP,
CS, jungle CS, spells, perks, damage/healing/shielding, vision, and objective
aggregates. All 20/20 current `16.9` replay exports pass the export verifier.

This path is valuable final-state evidence, but it is not the primary typed
Wasm contract and it is not a timeline. Some team/objective aggregates remain
partially stable, so fields must be promoted selectively rather than treating
the entire API-shaped object as universally exact. See
[`rofl-api-parity.md`](rofl-api-parity.md).

## Browser Truth Boundary

The product landing page intentionally has no minimap until replay-native
Champion positions pass promotion. Minimap surfaces elsewhere are not
productive replay decoder output.

- The "Riot API" side uses local Riot fixtures when present.
- The former fixed `api-positions.json` fallback generated from replay
  `EUW1_7779216102` is disabled. It is no longer loaded or relabelled when a
  replay-specific Riot research fixture is unavailable.
- The "Replay Decoder" side loads precomputed files from
  `public/replay-movement-fixtures`; it does not derive positions from the
  uploaded replay through Wasm. Only 17 of 76 stored assignments pass their own
  validation.
- The prior raw `0x00DC` coordinate/path-target overlay was removed after it
  was disproven against Riot positions and plausible issued destinations.

Until a movement profile passes the replay-only promotion gate, the product
viewer remains timeline-only rather than drawing fixture or guessed positions.

Ward candidates remain available through the separate
`rofl-ward-position-candidates-research/v1` schema with
`researchOnly: true`, `promotionGate: false`, `positionAvailable: false`, and
`source.clientBinaryInput: false`, but they are not mounted on the product
landing page. Research consumers reject a replay/patch mismatch, discard
coordinates outside 0-15,000 instead of clamping them, and must not draw a
vision radius. A plausible-looking marker cannot promote a hypothesis.

The packet inspector is also a research surface. It can expose replay-native
packet families through Wasm, but heuristic candidates are not normalized game
state and must not be presented as decoded facts.

## Validated Research That Is Not Runtime Yet

### Ward spawn packets and position

A 47-replay scan over all 6,168 exact ward placements and 1,882 exact
placement-to-removal links isolates a versioned two-packet spawn sequence. Every
placement has exactly one high-entropy packet family plus exactly one fixed
63-byte companion family. In patch 16.9 these are `0x00D6` and `0x01AD`;
equivalent packet IDs are profiled for every supported group from 15.22 through
16.9. The same two families recur on new entity IDs around all 1,882 linked
removals, with shared variable byte regions between placement and probable
WardCorpse spawns.

This isolates the next packet grammar but does not decode a coordinate
transform. Simple raw/scaled integer and float pair scans produced zero strict
X/Y candidates. Riot Timeline ward events do not contain ward coordinates, so
participant-frame positions are only a weak falsification oracle, not a ward
position label. Productive ward position therefore remains unavailable. See
[`ward-position-spawn-packet-research.md`](ward-position-spawn-packet-research.md).

For patch 16.9, the eight earlier raw-coordinate hypotheses were visually
falsified and are no longer offered. The remaining research model is not
mounted on the product landing page; it interprets primary lanes `p[8..10]`
and `p[12..14]` as the first three
bytes of big-endian Float32 values and forces the unresolved low byte to zero.
Its symbol lookup was fitted offline from 95 saved exact-time kill anchors.

The coarse model produces 48/2,625 in-bounds ward candidates across 19/20 patch
16.9 replays; the stricter full-integer-LSB variant produces 45, while a
holdout-pure model requiring evidence from at least two independent replays
produces zero. Runtime candidate bytes still come only from the loaded `.rofl`.
The research schema/output therefore remains API-offline-fit, research-only, and not
promoted.

Coverage is low because every X/Y candidate requires six successful symbol
lookups. The tables contain 3, 72, and 65 mapped input symbols for primary X
offsets `p[8..10]`, and 3, 70, and 71 for primary Y offsets `p[12..14]`.
The leading lanes cover the observed Float32 range with only three symbols, but
the four variable mantissa lanes remain sparse relative to 256 possible byte
values. A single unknown symbol suppresses the entire marker; values are never
interpolated, clamped, or copied from an API fixture. The six simultaneous gates
therefore reduce 2,625 exact placements to 48 coordinate candidates.

Riot Timeline ward events supply no ward-coordinate labels. The current lookup
can only be learned from 95 independently matched kill-position anchors.
Placement/removal equality can validate or propagate an already known mapping,
but cannot assign a numeric coordinate to a symbol that is unknown on both
sides. The next session should therefore seek additional replay-native spatial
anchors or recover the symbol codec itself, concentrating on `p[9]`, `p[10]`,
`p[13]`, and `p[14]`, then require replay holdout and full-corpus validation.

Independent replay-only evidence strongly identifies the underlying spawn-state
field: primary lanes `p[8..11]` and `p[12..15]` map bijectively to companion
lanes with purity 1.0 over all 2,625 placements, and 701/745 linked removals have
an exact full primary+companion fingerprint match to their placement. This
supports field identity, not coordinate correctness. Visual plausibility cannot
satisfy the promotion gate.

### Inventory transactions

Patch `16.9`, 20-replay research currently proves:

- exact champion owner and timestamp for 4,454 add/update packets;
- a decoded resulting item ID for 3,716 uniquely labelable add/updates: 3,714
  direct matches plus two correctly explained automatic transformations;
- an exact sale-operation class for 189/189 labelled sales with zero extras.

Patch `16.14`, ten-replay research now separately proves exact champion owner
and timestamp for 2,519 add/update plus 2,074 removal-family packets, and an
exact sale-operation class for 116/116 labelled sales with zero extras or
misses. The older 16.9 item-ID formula matches 0/1,971 uniquely labelled
16.14 add/update packets, so it is explicitly rejected at the version boundary.
The patch-16.14 research harness now combines 13 compact Boolean bit formulas
into the complete item ID for every one of the 1,971 unambiguous labels. The six
new formulas were selected on seven fixed Discovery replays (`1,320/1,320`) and
then reproduce all `651/651` complete IDs in three fixed Holdouts, including
`19/19` unseen-item-ID label samples. Seven older formulas predate that split,
so the Holdouts independently validate selection of the six new bits, not all 13. Two input symbols for bits 9 and 11 are absent from all ten replays and are
explicitly fail-closed as unavailable. Another 236 saved Timeline purchases
have no matching profiled packet group and remain outside this validation.
Across all 2,519 profiled add/update packets, zero stored packets use either
unknown symbol and every packet produces a structural 13-bit value. Exact
owner/timestamp purchase-ID multisets semantically link 1,973 packets; the
remaining 546 are explicitly transaction-unresolved and must not be emitted as
purchases, slots, instances, transforms, or undo operations.

The productive decoder deliberately narrows that evidence to ten frozen
replay-native owner/time bundle templates and exposes only 193/193 exact
purchase-linked resulting-item updates through the external-profile-only
`rofl-replay-purchase-linked-item-updates/v1` surface (D7 130, H3 63). It has
zero extras and wrong IDs and a maximum one-millisecond offline validation
delta. Every other profiled add/update packet—2,326/2,519 in the ten fixtures—
is unavailable. A direct recipe/removal-ordinal alternative covers only
113/193 exact events; an Arity gate yields 139 candidates but 26 false
positives. Neither failed offline-oracle rule is a runtime input, profile
grammar, or basis for widening the productive stream.

A second, disjoint productive external-profile-only surface now captures the
direct component purchases that the bundle predicate intentionally omits:
`rofl-replay-direct-item-purchases/v1`. It accepts exactly one champion-owned
channel-1 `0x0369` add of length 14 or 15 at an owner/time group, then rejects
it when any relevant `0x0369`, `0x03F9`, `0x0146`, or `0x0081` operation occurs
for the same owner within +/-1 ms. The add's fail-closed structural 13-bit ID
must belong to the canonical profile's static, exact-pinned Data Dragon 16.14.1
`en_US` catalog: SHA-256
`0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75`, 212
real item IDs at or below 8191, and 71 buildable component IDs with a non-empty
Data Dragon `into` relation. The profile loader validates both complete ID
arrays against the frozen catalog. The catalog classifies
only the already replay-decoded ID; it supplies no match state. 2,010/2,422
decoded static-grant/non-real candidates are rejected instead of widened into
purchase events.

The direct stream validates 844/844 D7 and 434/434 H3 events, 1,278/1,278
combined, with zero extras, zero wrong IDs, and at most one millisecond timing
delta. It includes 710/710 D7 plus 333/333 H3 buildable-component purchases,
1,043/1,043 combined. Its events are disjoint from the 193 transform/bundle events, so the
two productive streams recover 1,471/1,973 exact saved-Timeline purchase
labels (74.6%) without using Timeline at runtime. Slots, item instances,
quantities/charges, removed item identity, removals, prices, gold, undo state,
and full inventory reconstruction remain unavailable.

The same exact-build profile now promotes the deliberately narrower
operation-only `rofl-replay-item-sales/v1` stream. Its frozen replay-native
predicate emits only a champion-owned sale operation with its exact
`0x03F9` removal-block provenance; it does not identify the thing removed. The
fixed corpus validates 77/77 D7 plus 39/39 H3 operations, 116/116 combined,
with zero extras, zero misses, and at most one millisecond timestamp delta.
The event is therefore useful as an orange timeline marker, but not as an
inventory mutation: sold item ID, slot, item instance, count/charges, price,
gold gain, undo, and inventory state are explicitly unavailable. The classifier
is external-profile-only and fails closed for missing, invalid, built-in,
ambiguous, or other-build profile selection.

An exhaustive all-segment scan now confirms that the two fail-closed symbols
cannot be learned from the current fixtures: all 3,266 `0x0369` blocks in the
ten replays were framed and inspected, and bit-9 input code `0` plus bit-11
input code `4` each occur zero times. No keyframe or startup copy supplies
them. The decoder must therefore keep those codes unavailable until a new
saved replay contains independent coverage.

The same fixed ten-fixture, 7/3 Discovery/Holdout research gate isolates a
second, still unresolved removal-context family: champion-owned channel-1
`0x0146` packets of length 2/3/4. There are 4,214 packets. A strictly
Timeline-only timing shape—one `ITEM_DESTROYED`, no `ITEM_SOLD`, and neither a
profiled 14/15-byte `0x0369` nor a profiled 6/7-byte `0x03F9` packet at the
same owner within one millisecond—has 432 groups and 434 `0x0146` packets,
with zero missing or ambiguous associations (267/269 Discovery and 165/165
Holdout). Another 25 exact double-Destroy groups contain one each of profiled
`0x0369`, profiled `0x03F9`, and `0x0146`. The 459 count is a unique complete
framing-provenance union (`replayId`, segment type/ID/payload offset, and
source offset) across both shapes with zero duplicate physical-packet
assignments; 3,755 lie outside both. `blockIndex` is only chunk-local: two
diagnostic block-index collisions are distinct physical packets in different
chunks, not timing ambiguity. The often useful intermediate count of 3,780 is
only the number outside the single-Destroy shape; it includes the 25
double-Destroy companions. This is
not an `0x0146` semantic decoder: its item, slot, instance, payload grammar,
and operation class remain unavailable, and it emits no C++/Wasm/UI output.

Pinned Data Dragon classification also shows that the timing-associated labels
are semantically mixed, not a clean system-item class: the single-Destroy shape
contains ordinary Health Potions, Control Wards, Biscuits, and elixirs as well
as system items, while every double-Destroy group combines a Control Ward with
a support-quest item. Full-payload, prefix, and bounded Boolean classifiers all
collide with the other 3,755 packets, so `0x0146` cannot yet be normalized as
use, consume, removal, or charge state.

Owner-local stateful context does not resolve it either. Most profiled `0x0146`
packets are standalone relative to same-time profiled add/removal operations;
neighbour families vary widely, identical payloads collide across several item
labels or no label, and a zero-extra D7 payload rule covers only 187/290 nearby
labels before producing two H3 extras. No item, charge, slot, instance, or
operation class survives the frozen split.

A maintained, research-only patch-16.14 static-recipe constraint now uses an
explicit locally saved and SHA-256-pinned Data Dragon `16.14.1` item catalog.
It intersects each result item's transitive `from` closure with distinct
historically observed same-owner `0x0369` item IDs. Those historical IDs are
not current inventory, surviving instances, slots, or counts. On the fixed D7
set the recipe constraint reduces the mean candidate set from 10.27 to 1.50
and yields 138 exact singletons out of 209 evaluated real-item removals; the
frozen H3 result is 11.61 to 1.60 and 56/83. All 292 labelled truths remain in
the constrained sets, 194 are singleton and 98 remain ambiguous. The harness
does not attempt complete inventory reconstruction and emits no runtime data.

A stronger direct-recipe shortcut is explicitly rejected: inferring every
direct `from` component for a one-add/matching-removal group finds all 291
labelled groups but also emits 60 extra groups (82.9% precision). Bounded
packet-order, recipe, prefix/bit, and local-neighbour discriminators do not
remove those extras without losing truths. Likewise, 194 recipe-singleton
removals provide no direct 6/7-byte `0x03F9` item-ID slice or compact Boolean
codec. A stateful operation/inventory grammar is still required.

A conservative online multiset reducer confirms that this missing grammar is
not merely an implementation detail. Starting empty and stopping each owner at
the first unresolved profiled operation accepts 15/15 exact Discovery prefix
events, all pure starting-item adds and zero recipes. Under the frozen rule,
Holdout accepts eight exact local adds but misses one additional Timeline event
inside a continuous prefix. No owner reaches the end of the profiled stream,
so no final inventory comparison is valid. This scratch reducer is therefore
neither a partial runtime decoder nor a complete-state path.

Even conservative unique-source lifecycles do not expose an item-instance link
directly: 15 D7 and 9 H3 add-to-removal pairs are available after offline state
disambiguation, but an exhaustive one-to-eight-bit contiguous slice/XOR search
between their `0x0369` and `0x03F9` payloads has zero exact D7 candidate.

The removal family now has a stronger bounded slot candidate. All 2,074
champion-owned `0x03F9` length-6/7 packets in the fixed exact-build corpus map
to a seven-value structural domain with zero unavailable symbols: length 6
maps `(bit7,bit8)` values `00/11/10` to candidate slots `0/1/2`, while length 7
maps `(bit16,bit17)` values `10/01/00/11` to `3/4/5/6`. The fixed split has
1,293 D7 and 781 H3 packets; every slot value occurs in both. All 72 strict
trinket-replacement labels independently select candidate slot 6 (50 D7 and 22
H3, zero wrong), and 506/535 simultaneous multi-removal groups use distinct
candidate slots. This is not yet a product field: only slot 6 has a zero-error
semantic oracle, sold-item identity and instances remain unavailable, and 29
multi-removal groups repeat a candidate slot under unresolved count/update
semantics.

The historical `0x0081` records provide a second, still non-promotable check.
Mapping their six record ordinals to slots `5..0` agrees with the removal-slot
candidate in 108/111 sales having one unique historical sold-item record. The
three disagreements can be explained only after inventory rearrangement/state
semantics are decoded, so they are retained instead of excluded. Separately,
181 isolated purchase intervals link one `0x0369` add to one changed historical
record across all six main candidate slots (126 D7, 55 H3). No contiguous
one-to-eight-bit add-payload lookup is conflict-free even on D7, so add
placement remains unresolved.

A bounded all-family companion scan now closes the simplest remaining version
of that hypothesis. For each of the 181 anchors it inspects every exact-framed,
same-owner channel-1 chunk packet within one millisecond of the labelled add.
Across 43 packet-type and packet-type/content-length family representations,
only the variable-length `0x0369` add family itself occurs in all 126 D7
windows. Testing first/last occurrences and every contiguous one-to-eight-bit
field yields zero conflict-free D7 record-ordinal lookup; consequently there is
no candidate to evaluate or promote on H3. There is no separate universal
same-time add-slot companion under this bound.

The historical-record ordering itself is also a poor swap oracle. Twenty-one
same-multiset `0x0081` reorder intervals have no offline Timeline item event
(12 D7, 9 H3). Five contain none of the profiled `0x0369`, `0x03F9`, `0x0146`,
or chunk `0x0081` operation families, and no packet type/length/four-byte-prefix
signature occurs exactly once in every window. The other intervals include 21
`0x0146` packets across 14 windows, but six repeated payloads each accompany
different inferred record movements; `c550cb` alone includes both record
`5 -> 4` and `4 -> 5`. These are historical component reorderings, not proven
physical inventory swaps or slot labels.

A replay-only backward reducer now tests whether the embedded final seven-slot
inventory can close missing identity links without a direct add-slot field. It
includes decoded `0x0369` lengths 14/15/16/17 plus length-11 trinket changes.
Productive sales retain their structural fixed-slot candidate and a
provenance-keyed identity. Other low-nibble-5/13 removals and `0x0146` records
branch over the bounded alternatives “no unit-count change” or “one anonymous
main-slot unit removed”; anonymous non-sale units are canonicalized so only
sale identities retain provenance. Nine exact sale-Undo anchors additionally
restore a replay-native item identity: a productive fresh sale candidate must
occur exactly once in the later same-owner `0x0081` record set. Unlinked
`0x0081`, other removal nibbles, contradictions, and more than 4,096 states
still fail closed.

This expanded model reverses 4,280/6,945 relevant owner/time groups and reaches
the beginning for 36/70 D7 plus 14/30 frozen-H3 participants. It encounters
48/77 D7 and 24/39 H3 sales. Five sale symbols bind uniquely to an earlier
decoded add—three D7 and two H3—and all five match the offline Timeline oracle,
with zero wrong identities. The result is a material traceability checkpoint,
not a runtime decoder: 20 tracks exceed the branch cap, 50 complete tracks
still retain hundreds or thousands of possible slot histories, `0x0081` Undo
coverage remains partial, and only five sale identities are unique. It therefore
recovers neither complete inventory nor a complete sale/current-gold ledger and
does not authorize C++/Wasm/UI inventory.

An offline Timeline-oracle backward solver now tests the stronger hypothesis
that the saved API item identities can fill those replay-only gaps. The final
seven-slot anchor still comes from each ROFL, and candidate slots still come
from exact-framed `0x03F9`; Timeline labels are research input only. The strict
solver reverses 366/3,230 owner/timestamp groups across 100 participants,
including 169 groups constrained by replay candidate slots and 29 containing a
sale, but no participant reaches the beginning.

The failure is not only missing replay linkage: Riot Timeline item events are
not a complete physical-inventory log. An exact identity-balance projection of
all 4,977 Timeline labels from the replay-final inventory leaves 13 negative
units and 858 positive units; zero of 100 participant balances close, and 36
tracks imply more than seven positive starting units. The two largest tracks
are both Viego (131 and 67 positive units, 198 combined) and contain many item
identities outside their final build, strong offline evidence that possession
cloning/destruction is mixed into the same API event vocabulary. Non-Viego
tracks still leave 660 positive units, dominated by system/perk item IDs,
consumables, trinkets, and support-item transformations. A bounded diagnostic
can reach the beginning only by skipping 1,022 event mutations, and only five
best-observed histories end empty. Timeline therefore helps label packet
semantics, but tracing it backward verbatim cannot produce product inventory.

Owner-local ordinal/count lookups likewise leave zero exact H3 hypothesis;
non-contiguous XOR rules are massively non-unique, and most nearby keyframe
inventory anchors contain multiple item operations. Neither state order nor
keyframe proximity supplies an individual slot/instance link.

Nor do pinned static prices reveal a gold field: 710 strict D7 purchase-cost
labels and 77 sale-gain labels have zero exact direct integer, varint, bitfield,
successive-packet-delta, or nearest-owner-keyframe `i32` candidate. H3 remains
unopened because Discovery has no codec. Purchase/sale gold deltas and current
gold are therefore still unavailable.

A full decoded-keyframe residual scan does not repair current gold. Signed and
unsigned 8/16/32-bit integers plus Float32 values at every contiguous or
stride-2 offset in the 1,479-byte decoded `0x02EB` payload produce no correction
field for the post-ledger residual. The best candidate is a constant decoded
zero and merely reproduces 1,460/3,200 already-exact residual rows. Current
spendable gold remains unavailable rather than approximated.

An expanded exact-framing pass over all 9,908,848 D7 chunk blocks likewise
finds no co-timestamp companion: 5,606 non-operation blocks across 1,284
type/channel/length/prefix families are tested as direct scalars, varints,
bitfields, direction-aware amounts, and stateful deltas; the best direct hit is
15/787. With no D7 candidate, H3 remains closed.

An add/update packet is not necessarily a purchase. Automatic transforms and
unlabelled state updates exist. The sold/removed item, slot, item instance,
count/charges, component consumption, upgrades, undos, and swaps remain
unresolved. The full-inventory promotion gate is 0/20 because all 3,550 removal
packets lack a decoded item target. The strict 16.14 purchase-linked and direct
add-only subsets plus the operation-only sale stream are the productive
inventory-adjacent C++/Wasm surfaces; no general inventory API or
reconstruction exists yet. See
[`replay-inventory-packet-research.md`](replay-inventory-packet-research.md).

There is also exact replay-native evidence for a variable inventory-component
family associated with only part of the undo stream: patch 16.9 `0x0165`
matches 78/147 labelled undos with zero extras, while patch 16.14 `0x0081`
matches 31/62 with zero extras. Both retain exact champion ownership and 1.0
leave-one-replay-out precision, and both packet types also occur as owner-bound
keyframe components. This proves a component/change anchor, not item identity,
slot, operation ordering, or complete undo coverage; it remains research-only.
For patch 16.14, a follow-up D7 scan of all 9,908,848 chunk blocks evaluates
3,481,871 packet-type/length/prefix classifiers against the 17 Undo labels not
covered by `0x0081`; none covers all targets before extra rejection. This rules
out a second single-family constant-prefix classifier through 16 prefix bytes,
not a stateful multi-packet grammar. H3 remains unopened because Discovery has
no exact candidate.

Within the 31 exact `0x0081` anchors, there is no same-owner/time/chunk
`0x0369`, `0x03F9`, or `0x0146` companion. Nearest-operation and 60-second
lookback links recover at most 6/23 D7 and 2/8 H3 offline `beforeId` labels, and
no payload byte maps exactly to Undo `beforeId`, `afterId`, or `goldGain`.
Applying the established 13-bit item grammar changes the result for sale Undo.
All 11 nonzero `afterId` labels occur in the six trailing records at the normal
item offset and persist into the following keyframe. Linking productive fresh
sale candidates to an item occurring exactly once in the Undo record set yields
6/6 exact D7 discovery and 3/3 exact frozen-H3 restored identities, with zero
wrong candidates across all 31 anchors. The remaining 22 partial-family anchors,
including purchase Undo identity, still fail closed and prevent complete state.
Nearest same-owner keyframe components provide no full equality, chunk
subsequence, shared four-byte prefix, common aligned XOR edit, or stable
ordinal either.

The repeated `BE C7 1F 76` / `BE C9 1F 76` marker partition is byte-lossless
over all 5,798 patch-16.9 `0x0165` payloads, but it is not a proven record
splitter. No bounded byte, `u16`, LEB128, or mask field encodes body length,
ordinal, or remaining-record count exactly; prefix/suffix clusters conflict in
Holdout, and Undo-to-near-keyframe full-body matches are sparse and
ordinal-unstable. Marker occurrence alone must not become framing or instance
identity.

An expanded full-payload and offline-oracle scan falsified the strongest simple
slot candidate: it matches 155/196 deterministic initial adds but only 108/239
terminal final-item labels. Across 882 offline-linked add/removal lifecycles,
the best slot-sized relationship reaches 675/882 and the best instance-sized
relationship 505/882; a separately labelled removal-slot scan reaches 420/733.
These correlations are useful search constraints but are not runtime fields.
The next inventory lead is a stateful operation and slot/instance grammar that
can reject automatic transforms and resolve removals against an actually
maintained inventory. The separate swap/use families and conservative prefix
reducers remain parallel leads; marker partitioning and static recipe lookup
alone are insufficient.

### Keyframe champion state

The outer structure is exact on two independent patch-16.9 replays:

- packet families `0x0442`, `0x0165`, and `0x01F0` yield exactly one
  champion-owned block per participant per keyframe;
- 1,830 selected blocks have exact framing, timestamp alignment, and ownership,
  with no missing, duplicate, or non-champion owners;
- payloads change and therefore carry state.

For exact build 16.14, each champion/keyframe has a maintained structural
directory of exactly 366 `0x01EB` records alongside one champion-owned
1,479-byte `0x02EB` block. The `0x01EB` suffixes `payload[3..]` provide 366
unique, stable directory tokens in all 2,170 D7 and 1,030 H3 owner-segments.
An exact bridge connects them as
`0x0233 · (0x0306 0x0306)^k · 0x0452 · 0x007D? · 0x02EB`, `k=0..4`.
Within the wider group, all 63,905 D7 and 32,567 H3 `0x0306` records use a
two- or three-byte base plus zero to two four-byte extensions; four contiguous
`0x027C` records follow `0x02EB`, and exactly four contiguous `0x011A` records
occur between that block and the unique `0x0151` end. Complete bridge
type/length layouts are not frozen; H3 contains four D7-unseen combinations
within the frozen per-packet domains. This fixes replay-native record and
partial typed-stream boundaries only: neither a directory index/token nor a
typed record has proven cell or value meaning. Direct, descriptor-guided, and
raw typed-stream Gold/CS relations remain negative.

#### Productive exact-build keyframe XP, level, gold, and lane-CS snapshots

The 16.14 `0x02EB` owner/keyframe slab now has a separate, promoted decoder
boundary. It is deliberately independent of the non-semantic `0x01EB`
directory: only channel-1, champion-owned `0x02EB` packets of exactly 1,479
bytes are accepted. The external exact-build profile contains the frozen
bijective `cipherToPlain` permutation (SHA-256 over its 256 raw bytes:
`c9be1f4971505dcc7c4366329366794108c1b031060039a2bcfd2d60134ed4be`), where
the prior D7 majority anchor maps raw `p[119]` to Float32LE total-gold byte 2
and `0x0E` decodes to `0`. Runtime never learns, extends, or refits this table.

After that substitution, three profile-pinned interleaved Float32LE stripes are
decoded directly from the loaded replay:

| Field      | Payload offsets        | UI projection                                                                                    | D7 / H3 validation                                                                                                                                           |
| ---------- | ---------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| XP         | `[83, 85, 87, 89]`     | `trunc(Float32)`                                                                                 | 2,170/2,170 and 1,030/1,030 finite, nonnegative, and participant-monotonic; saved Timeline agrees for 2,169/2,170 D7 and 1,029/1,030 H3 snapshots.           |
| Level      | derived from XP        | patch-16.14 cumulative thresholds, capped at 18 or 20 from replay-embedded validated final level | 3,200/3,200 exact against saved Timeline; no direct replay level scalar survived bounded Float32/U8/U16 searches.                                            |
| Total gold | `[115, 117, 119, 121]` | `trunc(Float32)`                                                                                 | 2,170/2,170 and 1,030/1,030 finite, nonnegative, and participant-monotonic; saved Timeline agrees for 2,166/2,170 D7 and 1,029/1,030 H3 snapshots.           |
| Lane CS    | `[123, 125, 127, 129]` | exact integral Float32                                                                           | 2,170/2,170 and 1,030/1,030 finite, nonnegative, participant-monotonic, and integral; saved Timeline agrees for 2,169/2,170 D7 and 1,029/1,030 H3 snapshots. |

The five retained Timeline deviations are explicit snapshot-boundary evidence,
not gaps filled at runtime. D7 has four: `EUW1-7920292147` participant 4
segments 33 and 41 (gold only), `EUW1-7920341366` participant 8 segment 14
(gold and lane), and `EUW1-7920364492` participant 7 segment 6 (gold only).
H3 has one: `EUW1-7921482297` participant 8 segment 24 (gold and lane). In
each, the replay-native values remain finite and monotonic; the preceding and
following keyframe state shows a shared ordering boundary. The first snapshots
match the saved Timeline for all 70 D7 and 30 H3 participant tracks; last
snapshots match 69/70 D7 and 30/30 H3 gold tracks and 70/70 D7 plus 30/30 H3
lane tracks. These counts are offline validation only.

XP differs only at the D7 segment-14 and H3 segment-24 ordering boundaries
already listed above; the other three frozen differences concern gold only.
The cumulative level thresholds are
`0, 280, 660, 1140, 1720, 2400, 3180, 4060, 5040, 6120, 7300, 8580, 9960,
11440, 13020, 14700, 16480, 18360, 20340, 22420`. The decoder requires a
complete, profile-validated replay-embedded final-stat record and uses only its
final level to choose the participant's 18-or-20 cap. Saved Riot fixtures do
not participate in this derivation.

The normalized surface is `rofl-replay-participant-stat-snapshots/v3`. It is
implemented in C++, exposed through the external-profile-only Wasm ABI, and
consumed by the product roster at the current scrub time. Missing, invalid,
non-bijective, built-in, ambiguous, or non-exact-build profiles fail closed;
the UI shows stat snapshots unavailable rather than final values or API data.

Reproduce the compact ten-replay D7/H3 gate after building the native CLI:

```bash
node scripts/validate_replay_participant_stat_snapshots_corpus.mjs \
  --cli build-linux/packages/rofl-core/rofl_core_cli \
  --output tmp/participant-stat-snapshots-corpus-validation.json
```

The report is compact and retains only counts, hashes, diagnostics, and the five
frozen ordering differences; it does not serialize the 3,200 snapshots again.

Neutral CS `[131,133,135,137]` uses the same frozen cipher. The replay-native
Float32 value is finite, nonnegative, and monotonic across every snapshot but
contains real fractional neutral-CS weights. Discovery defines the exact
`floor(value + epsilon)` interval as `[3.814697265625e-6,
3.0517578125e-5)` and freezes `epsilon = 1e-5`; that rule reproduces all
2,170 D7 and all 1,030 previously unopened H3 `jungleMinionsKilled` labels.
The field is profile-backed, emitted as integer `neutralMinionsKilled`, exposed
through Native/Wasm/TypeScript, and shown by the product roster at scrub time.
Current spendable gold, health, max health, mana/resource, damage, alive state,
and full inventory remain unresolved.

Two July 2026 maintained gates narrow those gaps without adding product fields:

- `[107,109,111,113]` in the exact-build `0x02EB` payload is a cumulative
  spent-gold-like Float32LE lane: 3,200/3,200 values are finite, nonnegative,
  and integral, and all 100 participant tracks begin at zero. It is not
  spendable gold. `trunc(totalGold - spentLike)` matches only 967/2,170 D7 and
  354/1,030 H3 current-gold labels. A frozen static-recipe/Undo ledger matches
  the lane delta on 2,945/3,100 transitions, including 49/50 Undo-containing
  intervals (16/16 sale-Undo and 35/36 purchase-Undo intervals). Cumulative
  sale proceeds improve the current-gold comparison to 1,459/3,200 snapshots
  but do not close the residual; sold-item identity is also unavailable, so no
  spendable-gold field is promoted. A corrected cross-replay multiplicity gate
  additionally freezes all eight exact one-per-champion/keyframe families
  (`0x0081`, `0x0151`, `0x0196`, `0x0233`, `0x02EB`, `0x038D`, `0x0452`, and
  `0x047A`) across the same 3,200 snapshots. Outside the separately exhaustive
  `0x02EB` audit, no raw or profile-permuted UInt/Float32 scalar with stride
  `1..8` reproduces current gold in D7 and H3.
- every exact-build champion/keyframe `0x0081` payload has six replay-only
  trailing records and reuses the established item-ID symbol grammar, but the
  records are not directly usable as current inventory. A Timeline-derived
  offline reducer sees false-extra decoded items in 675/2,170 D7 and 374/1,030
  H3 snapshots. A new bounded alignment audit tests record state against
  Timeline event reductions at keyframe offsets `-2..+2`; the existing `-1`
  alignment is uniquely strongest in both D7 and H3, so a missing one-minute
  shift does not close the gap. Timeline incompleteness is nevertheless
  material: 957/1,336 false-extra item occurrences have no prior labelled
  identity action, while 378 have a latest labelled removal. Thus missing
  Timeline operations explain many apparent extras, but known historical
  identities still reject a direct current-slot interpretation. The stronger
  whole-record gate finds 49 D7 and 28 H3 byte-identical, same-ordinal item
  records with opposite strict activity labels; even the full record bytes
  therefore cannot determine current activity without component-level or
  temporal state. Per-ordinal searches over normalized component-prefix and all
  six sibling-record start/end contexts additionally find zero conflict-free
  D7 contiguous one-to-eight-bit lookups and zero one/two-bit affine rules for
  every ordinal, before H3 is consulted. There is no simple surrounding
  activity mask under this grammar. The preceding
  component contains the sold item for 112/116 sales. Combining the structural
  removal slot with reverse record ordinal `5-slot`, then failing closed when
  the preceding same-owner component is older than 30 seconds, identifies the
  sold item in 36/36 D7 discovery sales and 13/13 frozen-H3 holdout sales with
  zero wrong identities; D7 exercises all six main slots. Older candidates are
  deliberately unavailable, so this is a conservative research subset rather
  than a complete sale decoder. Without the freshness gate, the new
  removal-slot candidate agrees with the reverse record ordinal in 108/111
  unique-truth sales. All 72 strict trinket replacements select
  candidate slot 6, but only that slot has a zero-error semantic oracle. The
  181 isolated add/record-change anchors cover all six main candidate slots,
  while no bounded contiguous add-payload lookup is conflict-free on D7. An
  all-family +/-1 ms scan finds only the add family present in every D7 window
  and no companion-field lookup. Twenty-one no-item-event same-multiset record
  reorderings also fail as swap labels: five lack every profiled operation
  family and repeated `0x0146` payloads accompany contradictory record moves.
  An expanded backward reducer anchored at the replay-embedded final seven
  slots reverses 4,270/6,945 relevant groups and reaches the beginning for
  49/100 tracks. It encounters 71/116 sales and uniquely links five sale
  identities with `5 exact / 0 wrong` offline validation, but leaves hundreds
  or thousands of candidate histories per completed track. Of 36 final-slot mismatches on
  tracks with no later Timeline item event, 34 do have later replay-native
  operations from the known four-family population. The other two do not, so
  Timeline omissions alone still do not establish state. A separately bounded
  forward reducer also includes length-11 trinket changes and rare length-16/17
  add records. Its deterministic replay-only candidate reconstructs `9/70` D7
  and `5/30` H3 exact final slot tracks; a symbolic placement solver reaches
  23/70 and 13/30 final anchors. A separate best score that assumes initial
  trinket 3340 reaches 10/70 and 6/30 but is explicitly non-promotable because
  that seed is not replay-native. This remains historical
  shop/Undo and removal-slot candidate evidence, not a complete physical
  inventory decoder. The fresh sale subset is also research-only pending a
  profile-backed C++ implementation and full-corpus promotion.

Both artifacts remain research-only and fail closed. The product continues to
omit current gold and dynamic inventory slots instead of relabelling total gold,
final Match items, purchases, or Undo history as current state.

One narrow inventory-component change anchor survives predeclared holdouts:

- patch 16.9 fixed family `0x0442`, 1,451-byte payload, byte 259 changes on
  382/382 purchase-or-undo windows and 0/488 negative windows;

The former patch-16.14 `0x02EB` byte-111 “inventory anchor” is reclassified:
byte 111 is one byte of the spent-gold-like Float32LE lane above. Its exact
361/361 purchase-or-undo change correlation is economy evidence, not an
inventory-component boundary.

The remaining 16.9 anchor's value and XOR mask are non-monotonic and do not
decode item ID, slot, count, operation ordering, or inventory state. It is a
research boundary only, not a normalized runtime field.

Patch 16.14 now has replay/Timeline **change correlations** within the
champion-owned 1,479-byte `0x02EB` family, not decoded field boundaries. The
`totalGold` artifact explicitly sets `fieldBoundaryAvailable:false`,
`nonUnique:true`, and `postHoc:true`. Post-hoc pair `109,119` changes on all
3,024 saved `totalGold` changes and none of 76 unchanged transitions
(Discovery 2,043/0/0/57; frozen Holdout 981/0/0/19, TP/FP/FN/TN). A bounded
`96..128` Discovery-only search (maximum three bytes) finds three equally
minimal exact pairs: `109,119`, `115,119`, and `117,119`; all remain exact in
H3. The former exact `115,117,119` correlation is a non-minimal superset.
Every nine-replay leave-one-replay-out search again finds those same three
pairs, which are exact on its held replay. This preserves a stability
diagnostic but is neither independent holdout evidence nor proof of a semantic
or component boundary.

The lane-CS correlation is uniquely minimal in its separately fixed `120..140`
search window: only `125,127,129` is exact in Discovery and H3. It changes on
all 2,155 saved `minionsKilled` changes and none of 945 unchanged transitions
(Discovery 1,458/0/0/642; Holdout 697/0/0/303). The previous `127..129`
range missed three otherwise identical p125-only updates; byte 125 changes in
24 positive / 0 negative Discovery transitions and 32 / 0 Holdout transitions,
including exactly one and two p125-only forms respectively. The asserted
p125-only witnesses are `EUW1-7920292147` participant 3, segments 38→39, lane
CS 280→281, plus `EUW1-7921482297` participants 3 and 8, segments 46→47, lane
CS 360→361 and 268→269; all have p125 `0x0e→0xe8`. Byte 128 is inert across
all 3,100 transitions and is diagnostic only, not part of the correlation or
a packing test. This is not historical unseen-holdout evidence because p125
was found in a full-corpus mismatch audit; the LORO result is stability
diagnostic only.

Neither older change correlation decodes a delta, event, or component boundary.
The earlier direct packed lane/gold forms remain negative because they operated
on encrypted raw bytes, not the later frozen byte permutation and interleaved
Float32 grammar. They must not be used to infer last hits, purchases, a gold
delta, or component identity. Jungle-CS raw offsets `134..137` remain an
imperfect negative control with ten false positives; the separate decoded
neutral-CS Float32 research stripe is not yet promoted.

The negative boundary is now broader: an exact change-byte correlation is not
a numeric gold decoder, and no numeric current/earned-gold field has passed a
replay-native grammar gate. Searches of champion-owned `0x0217` and generic
NPC-lifecycle families likewise have not produced an exact minion/monster
credit, CS delta, or last-hit event decoder. Those packet families must remain
unavailable rather than serve as a timeline approximation.

Schema `rofl-keyframe-economy-anchors-research/v4` adds structural-only gates
without promoting fields. D7 has 229 ever-non-default offsets and H3 has 221,
with no H3-only offset. A D7-only selector freezes two maximal non-constant
exact mirrors—`154..162` to `1289..1297` and `1066..1073` to
`1074..1081`—which reproduce byte-for-byte in H3. Uniform alternating
`[value,0x0E]` / `[0x0E,value]` cells and a one-bit adjacent mask-header model
are both falsified. These are serialization diagnostics, not records or field
boundaries.

A separately bounded stride-two scalar audit checks 1,126 integer, Float32,
Float64, raw-delta, constant-XOR, and constant-add candidates over starts
`90..160` and logical widths `2..8`. None is D7-exact; adding `p121`, `p131`,
or `p141` to the apparent gold/lane/jungle lanes yields zero direct matches and
no viable changing-delta decoder in D7 or frozen H3. Bounded discrete packet
searches likewise find no exact champion-owner lane-CS or jungle-CS event-count
family. The best lane-CS burst candidate covers just 149/1,482 positive D7
intervals and adds 361 unchanged-interval events; the only zero-extra prefix
candidate covers zero positive deltas. The next keyframe step is therefore a
stateful replication/record grammar, not a wider static scalar packing.

Position, health, resources, current gold, damage, KDA, and alive state are not
decoded. Exact-build XP, derived level, total gold, lane CS, and neutral/jungle
CS are productive keyframe state fields. Older supervised keyframe assignments
remain research artifacts, not replay-only runtime fields. The blocker for the
remaining state is the inner replication/component serialization grammar. See
[`keyframe-champion-state-discovery.md`](keyframe-champion-state-discovery.md).

### Movement

There is no valid replay-native position, path target, or waypoint decoder.

A maintained exact-build direct-scalar gate now also rules out the simplest
keyframe-state interpretation. Across 2,170 D7 and 1,030 H3 champion snapshots,
the substantial exact one-per-champion/keyframe families `0x0081`, `0x02EB`,
and `0x047A` were searched for raw and profile-permuted signed Int16 and
Float32 LE/BE lanes with strides 1 through 8. D7 selected candidates before H3
was opened. Neither axis survives: the best affine RMSE remains about 3,763 X
and 3,622 Y map units, while the strongest D7 first-difference correlations are
only `-0.0138` X and `0.0548` Y and remain weak or reverse sign in H3. Champion
position is therefore not another direct scalar alongside the promoted
`0x02EB` stats; research must decode the movement/component message grammar.

The frequent champion-handle-associated `0x01AB` family has also failed the
coordinate/waypoint promotion gate: neither its raw payload nor bounded
companion interpretations produce replay-native position semantics. It remains
research input only, not an emitted movement stream.

An exact-build patch-16.14 maintained gate proves one bounded entity relation.
All 6,314 channel-1 chunk type `0x0170` (368) blocks are consecutive after a
type `0x0328` (808) block in the same chunk with the same timestamp,
`blockParam`, and payload length; 1,494 type-808 blocks are unpaired. Within
that set, 759 pair `blockParam` values exactly equal replay-decoded ward entity
IDs and occur strictly after placement. All 29 links with an available
conservative removal occur before it, and every ward-linked pair has a 17-byte
payload. This establishes a generic entity-handle relation for that subset,
not the operation or payload grammar. No paired handle is a champion network
ID or appears as a raw LE/BE `u32` in its payload; owner/champion identity,
entity class outside the ward subset, coordinates, paths, and waypoints remain
unavailable.

A separate exact-build `16.14.794.5912` research-only global handle audit
extends beyond that pair cohort. It uses existing replay-only decoded
`WARD_PLACED` IDs as an offline label oracle and scans every exact-framed chunk
block with nonzero `blockParam`; no Timeline, Match-V5, client binary, process,
or runtime product input is used. D7 fully loads before H3: 7,343,781 D7
blocks / 108,063 handle instances / 998 labelled wards, then 3,269,376 H3
blocks / 45,283 handle instances / 479 wards. The single channel-1
`0x03E8`, length-3 family covers all wards but has 218 D7 and 86 H3 extras.
Within the eight family/length tokens frozen from the preceding pair-cohort
research (not an exhaustive search over every packet family), the smallest D7
zero-extra structural subset is a first occurrence of `0x03E8/3` followed by
`0x0023/9`; frozen H3 reproduces 479/479 with zero extras. This is not a Ward
spawn/removal, owner, payload, position, vision, or movement decoder, and stays
research-only with no C++/Wasm/UI output.

The provisional expressions based on little-endian `u16` values at payload
offsets 0 and 8 were disproven. Exact framing, in-bounds values, and exact owner
only establish provenance; they do not establish coordinate semantics. A strict
patch-16.9 audit of the older candidate pipeline produced only 60/200 passing
participant tracks, 0/20 complete replays, and no promotable replay-native
identity feature.

The strongest next lead is to decode the actual movement message grammar:
entity identity, speed, path/count and teleport flags, compressed waypoint
flags, signed absolute coordinates, and signed delta coordinates. Do not add
pathfinding or interpolate between targets until those semantics are proven.
See [`replay-movement-packet-research.md`](replay-movement-packet-research.md).

### Buildings and turret plates

Patch-specific candidates cover all 640 labelled building-kill timestamps and
all 2,441 turret-plate timestamps, but also occur outside those events. They are
timestamp correlations, not safe decoders. Event classification, building
identity, lane/tier, killer/team, position, and state remain unresolved.

## Missing for Full Match Reconstruction

The largest missing streams are:

1. champion positions, waypoints, teleports, recalls, and participant-stable
   movement tracks;
2. dynamic champion state: health, max health, resource, gold, XP, level, CS,
   movement speed, alive/dead state, respawn, and buffs;
3. complete inventory state and transaction semantics at every timeline point;
4. damage, healing, shielding, spell-cast, crowd-control, and combat-source
   events;
5. ward position, type, lifetime, reveal/disable state, and derived vision;
6. buildings, turret plates, inhibitors, lane/tier identity, and ownership;
7. objective killer/team, elemental subtype, participants, and location;
8. non-champion world entities such as minions, monsters, structures,
   projectiles, traps, and pets where analytically useful.

Perfect engine-level reconstruction may not be possible for every patch or
every transient state. The normalized model and UI must therefore report field
availability and degrade gracefully instead of fabricating missing values.

## Promotion Rules

A field may enter C++/Wasm and the product UI only when all of these hold:

1. Runtime extraction uses only the loaded `.rofl` bytes and replay version.
2. Packet framing, source provenance, bounds, and version profile are exact.
3. The semantic interpretation passes a corpus-level offline validation gate,
   including false-positive rejection.
4. Participant or entity identity is replay-native and stable.
5. Unknown variants are rejected or surfaced as unavailable, never guessed.
6. The C++ schema has native tests, the Wasm boundary has contract coverage,
   and the Vue UI labels limitations honestly.

Exact packet timing or champion ownership alone proves where bytes came from;
it does not prove what those bytes mean.

## Recommended Next Work

1. Promote or reject the XP and neutral-CS Float32 research stripes with a
   frozen integer-projection and snapshot-ordering rule. Keep the D7 cipher
   fixed, use replay-only fields at runtime, and require Native/Wasm/UI tests
   before widening the productive snapshot schema.
2. Decode current gold and then the remaining participant state (level,
   health, max health, mana/resource) from the same exact-build keyframe
   grammar without reusing Timeline values at runtime.
3. Preserve fail-closed handling for the two absent patch-16.14 item-ID symbols
   while decoding the stateful operation/slot/instance/removal grammar and a
   complete inventory reducer.
4. Use the exact ward-linked generic handle subset to decode the
   `0x0328`/`0x0170` operation and payload grammar, expand replay-native entity
   identity, then decode the real movement/waypoint protocol. Validate raw
   waypoints before considering interpolation, pathfinding, or movement-speed
   reconstruction.
5. Decode the isolated versioned ward spawn/companion grammar into X/Y, then
   validate the transform against an independent spatial oracle before exposing
   position. Continue subtype, vision radius, removal reason, and the one
   intentionally omitted ambiguous removal form without weakening the zero-extra
   lifecycle boundary.
6. Promote buildings/plates and then pursue damage, spells, combat effects, and
   other world entities.

These workstreams can be researched in parallel, but each promotion should be
small, versioned, and independently validated.

## Reproduction Baseline

Build and test the productive core and browser paths:

```powershell
.\scripts\test-native.ps1 -UseNinja
.\scripts\build-wasm.ps1 -Configuration Release
npm run typecheck:web
npm run test:web
npm run build:web
```

Run the exact event corpus gates after building `rofl_core_cli`:

```powershell
node .\scripts\validate_replay_kills_corpus.mjs
node .\scripts\validate_replay_objectives_corpus.mjs
node .\scripts\validate_packet_ward_lifecycle.mjs
node .\scripts\validate_replay_wards_corpus.mjs
node .\scripts\validate_replay_final_player_stats_corpus.mjs
node .\scripts\validate_replay_purchase_linked_item_updates_corpus.mjs
node .\scripts\validate_replay_direct_item_purchases_corpus.mjs
node .\scripts\validate_replay_item_sales_corpus.mjs
```

Inventory and keyframe research have their own reproduction commands in their
focused documents. Research artifacts and Riot fixtures are validation inputs,
not product runtime dependencies.

## Focused References

- [`packet-block-semantic-findings.md`](packet-block-semantic-findings.md)
- [`replay-objective-decoder-validation.md`](replay-objective-decoder-validation.md)
- [`packet-ward-semantic-findings.md`](packet-ward-semantic-findings.md)
- [`replay-inventory-packet-research.md`](replay-inventory-packet-research.md)
- [`keyframe-champion-state-discovery.md`](keyframe-champion-state-discovery.md)
- [`replay-movement-packet-research.md`](replay-movement-packet-research.md)
- [`rofl-api-parity.md`](rofl-api-parity.md)
- [`replay-format-notes.md`](replay-format-notes.md)
