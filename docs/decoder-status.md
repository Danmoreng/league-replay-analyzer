# Replay Decoder Status

Updated: 2026-07-18
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

| Area | Replay-derived output | Validation / boundary |
| --- | --- | --- |
| Container | Metadata offsets, payload/header boundaries, match ID when present, chunk/keyframe counts, segment table, Zstd/footer records, and exact packet-block framing with timestamps, channels, packet types, block parameters, payload boundaries, and provenance | Container and packet framing are productive. `payloadDecodingAvailable` means payload packets are readable, not that every semantic stream is decoded. |
| Participant summary | Champion, Riot ID name/tag, team, `teamPosition`/role (TOP, JUNGLE, and so on; not map coordinates), win, and final K/D/A, level, XP, lane CS, neutral CS, seven item slots, ward aggregates, gold earned, damage to champions, and vision score from embedded `statsJson` | Final match state only; these are not timelines. The productive native summary validates level, XP, both CS fields, all item slots, and both ward aggregates exactly for 6,110/6,110 values across all 470 corpus participants. `validatedFinalPlayerStatsAvailable` requires one of the eight validated patch groups and a complete valid field set; otherwise the product shows unavailable. `participantId = statsJson index + 1` is validated for the same participants. Gold remains replay-native cumulative earned gold and is not part of that exact 6,110-field claim. |
| Champion kills | Timestamp, victim, killer or execution, ordered assists, network IDs, and source provenance in `rofl-replay-kills/v1` | Historical corpus: 2,796/2,796 kills over 47 replays, maximum 1 ms delta. External profile build `16.14.794.5912`: 684/684. Victim, killer, ordered assists, final K/D/A, and participant identity all validate exactly. Kill position, damage source, and gold/bounty are unresolved. |
| Elite objectives | Timestamp, broad monster class, discriminator, and source provenance in `rofl-replay-objectives/v1` | Historical corpus: 425/425. External profile build `16.14.794.5912`: 99/99. Supports Dragon, Baron, Rift Herald, Horde/Void Grubs, and Atakhan where present. Killer/team, elemental dragon subtype, and position are unresolved. |
| Ward lifecycle | Standard-ward placement timestamp, ward entity ID, owner participant, conservative ward-kill timestamp, linked ward entity ID, killer participant, and source provenance in `rofl-replay-wards/v1` | Historical corpus: 6,168/6,168 placements; 1,882/1,883 removals with zero extras. External profile build `16.14.794.5912`: 1,477/1,477 placements and 484/484 removals. Ward subtype, position, vision radius, and removal reason are unavailable. |

The historical built-in coverage includes patch groups `15.22`, `15.23`,
`15.24`, `16.1`, `16.5`, `16.6`, `16.7`, and `16.9`. The externally supplied
profile additionally validates exact build `16.14.794.5912`: 684/684 kills,
99/99 objectives, 1,477/1,477 ward placements, 484/484 ward removals, and
1,300/1,300 final player-stat values.

The browser currently renders the real Wasm participant summary, kill timeline,
objective timeline, and ward lifecycle for the locally loaded replay.

The default browser landing page is now a dedicated product replay view. It
combines replay-native kills, elite objectives, ward placements, and conservative
ward kills on one scrubber. Team rosters show exact final level, XP, lane and
neutral CS, seven item slots, and ward aggregates alongside the existing final
summary fields. It reserves explicit unavailable states for movement, inventory
history, health, resources, ward positions, and other dynamic streams that have
not passed promotion. The previous summary, data browser, and decoder inspector
remain available as Research & Debug views.

The product view additionally has a visually isolated ward-position research
layer. For patch 16.9 it computes the experimental
`P16-FLOAT32-BE-API-FIT-COARSE` markers live from spawn-packet bytes in the
loaded replay. The byte-symbol lookup was fitted offline from saved Riot
Timeline kill anchors and is always labelled API-offline-fit / not promoted.
No API file is read at runtime. This layer is not the productive ward position
field and does not change `rofl-replay-wards/v1`, where `position` and
`visionRadius` remain unavailable.

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

The current minimap is not a productive replay decoder output.

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
viewer says that movement is unavailable for the loaded replay.

Ward markers shown by the optional research layer are a narrower exception to
the empty-map presentation, not to the truth boundary. They are emitted through
the separate `rofl-ward-position-candidates-research/v1` schema with
`researchOnly: true`, `promotionGate: false`, `positionAvailable: false`, and
`source.clientBinaryInput: false`. The UI rejects a replay/patch mismatch,
discards coordinates outside 0-15,000 instead of clamping them, and does not
draw a vision radius. A plausible-looking marker cannot promote a hypothesis.

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
falsified and are no longer offered in the product UI. The replacement research
model interprets primary lanes `p[8..10]` and `p[12..14]` as the first three
bytes of big-endian Float32 values and forces the unresolved low byte to zero.
Its symbol lookup was fitted offline from 95 saved exact-time kill anchors.

The coarse model produces 48/2,625 in-bounds ward candidates across 19/20 patch
16.9 replays; the stricter full-integer-LSB variant produces 45, while a
holdout-pure model requiring evidence from at least two independent replays
produces zero. Runtime candidate bytes still come only from the loaded `.rofl`.
The active UI warning therefore says API-offline-fit, research-only, and not
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
so the Holdouts independently validate selection of the six new bits, not all
13. Two input symbols for bits 9 and 11 are absent from all ten replays and are
explicitly fail-closed as unavailable. Another 236 saved Timeline purchases
have no matching profiled packet group and remain outside this validation.
Across all 2,519 profiled add/update packets, zero stored packets use either
unknown symbol and every packet produces a structural 13-bit value. Exact
owner/timestamp purchase-ID multisets semantically link 1,973 packets; the
remaining 546 are explicitly transaction-unresolved and must not be emitted as
purchases, slots, instances, transforms, or undo operations.

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

An add/update packet is not necessarily a purchase. Automatic transforms and
unlabelled state updates exist. The sold/removed item, slot, item instance,
count/charges, component consumption, upgrades, undos, and swaps remain
unresolved. The full-inventory promotion gate is 0/20 because all 3,550 removal
packets lack a decoded item target. No C++/Wasm inventory API exists yet. See
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

An expanded full-payload and offline-oracle scan falsified the strongest simple
slot candidate: it matches 155/196 deterministic initial adds but only 108/239
terminal final-item labels. Across 882 offline-linked add/removal lifecycles,
the best slot-sized relationship reaches 675/882 and the best instance-sized
relationship 505/882; a separately labelled removal-slot scan reaches 420/733.
These correlations are useful search constraints but are not runtime fields.
The next inventory lead is a lossless record splitter for the repeated
`0x0165` component tags (`BE C7 1F 76` and `BE C9 1F 76`), followed by a
same-owner keyframe/chunk structural comparison. The separate swap family and
the patch-specific add/update symbol codec remain parallel leads.

### Keyframe champion state

The outer structure is exact on two independent patch-16.9 replays:

- packet families `0x0442`, `0x0165`, and `0x01F0` yield exactly one
  champion-owned block per participant per keyframe;
- 1,830 selected blocks have exact framing, timestamp alignment, and ownership,
  with no missing, duplicate, or non-champion owners;
- payloads change and therefore carry state.

Narrow inventory-component change anchors now survive predeclared holdouts:

- patch 16.9 fixed family `0x0442`, 1,451-byte payload, byte 259 changes on
  382/382 purchase-or-undo windows and 0/488 negative windows;
- patch 16.14 fixed family `0x02EB`, 1,479-byte payload, byte 111 changes on
  361/361 purchase-or-undo windows and 0/449 negative windows.

The values and XOR masks are non-monotonic and do not decode item ID, slot,
count, operation ordering, or inventory state. These anchors are therefore
research boundaries only, not normalized runtime fields.

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

Neither correlation decodes a value, delta, event, or field boundary. A direct
packed lane or gold value matches 0/3,100 non-initial keyframe values; the
`109,119` gold delta matches only 58 Discovery and 19 Holdout transitions, and
the lane delta only the corresponding 945 unchanged transitions. Thus no
current or earned gold, numeric lane CS, delta, or last-hit event is decoded.
Jungle-CS offsets 134..137 remain an imperfect negative control with ten false
positives.

A separately bounded stride-two scalar audit checks 1,126 integer, Float32,
Float64, raw-delta, constant-XOR, and constant-add candidates over starts
`90..160` and logical widths `2..8`. None is D7-exact; adding `p121`, `p131`,
or `p141` to the apparent gold/lane/jungle lanes yields zero direct matches and
no viable changing-delta decoder in D7 or frozen H3. Bounded discrete packet
searches likewise find no exact champion-owner lane-CS or jungle-CS event-count
family. The next keyframe step is therefore a stateful replication/record
grammar, not a wider static scalar packing.

Position, health, resources, numeric gold, XP, level, numeric CS, damage, KDA,
and alive state are not decoded. Older supervised keyframe assignments are
research artifacts, not replay-only runtime fields. The blocker is the inner
replication/component serialization grammar. See
[`keyframe-champion-state-discovery.md`](keyframe-champion-state-discovery.md).

### Movement

There is no valid replay-native position, path target, or waypoint decoder.

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

1. Obtain independent coverage for the two fail-closed patch-16.14 item-ID
   symbols, then complete slot/instance/removal decoding and reconstruct
   inventory state; expose item events and a scrubber-synchronized inventory
   panel only after the Native/Wasm promotion gate.
2. Decode the inner keyframe replication/component grammar using the exact but
   non-semantic `totalGold` and lane-CS change correlations only as search
   constraints. Use final `statsJson` values plus controlled transitions as
   replay-only constraints for numeric gold, XP, level, CS, health, and
   resources.
3. Decode the real movement/waypoint protocol and entity identity. Validate raw
   waypoints before considering interpolation, pathfinding, or movement-speed
   reconstruction.
4. Decode the isolated versioned ward spawn/companion grammar into X/Y, then
   validate the transform against an independent spatial oracle before exposing
   position. Continue subtype, vision radius, removal reason, and the one
   intentionally omitted ambiguous removal form without weakening the zero-extra
   lifecycle boundary.
5. Promote buildings/plates and then pursue damage, spells, combat effects, and
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
