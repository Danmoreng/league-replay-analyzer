# Replay Decoder Status

Updated: 2026-07-17
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
| Champion kills | Timestamp, victim, killer or execution, ordered assists, network IDs, and source provenance in `rofl-replay-kills/v1` | 2,796/2,796 kills over 47 replays, maximum 1 ms delta; victim, killer, ordered assists, final K/D/A, and participant identity all validate exactly. Kill position, damage source, and gold/bounty are unresolved. |
| Elite objectives | Timestamp, broad monster class, discriminator, and source provenance in `rofl-replay-objectives/v1` | 425/425 events over 47 replays with zero extras, missing events, or unknown emitted classes. Supports Dragon, Baron, Rift Herald, Horde/Void Grubs, and Atakhan where present. Killer/team, elemental dragon subtype, and position are unresolved. |
| Ward lifecycle | Standard-ward placement timestamp, ward entity ID, owner participant, conservative ward-kill timestamp, linked ward entity ID, killer participant, and source provenance in `rofl-replay-wards/v1` | 6,168/6,168 placements with zero extras or missing events. 1,882/1,883 removals with zero extras; one ambiguous patch-16.9 packet form is deliberately omitted. Ward subtype, position, vision radius, and removal reason are unavailable. |

The exact kill, objective, ward, and promoted final-summary profiles currently cover patch groups `15.22`,
`15.23`, `15.24`, `16.1`, `16.5`, `16.6`, `16.7`, and `16.9`.

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

The packet inspector is also a research surface. It can expose replay-native
packet families through Wasm, but heuristic candidates are not normalized game
state and must not be presented as decoded facts.

## Validated Research That Is Not Runtime Yet

### Inventory transactions

Patch `16.9`, 20-replay research currently proves:

- exact champion owner and timestamp for 4,454 add/update packets;
- a decoded resulting item ID for 3,716 uniquely labelable add/updates: 3,714
  direct matches plus two correctly explained automatic transformations;
- an exact sale-operation class for 189/189 labelled sales with zero extras.

An add/update packet is not necessarily a purchase. Automatic transforms and
unlabelled state updates exist. The sold/removed item, slot, item instance,
count/charges, component consumption, upgrades, undos, and swaps remain
unresolved. The full-inventory promotion gate is 0/20 because all 3,550 removal
packets lack a decoded item target. No C++/Wasm inventory API exists yet. See
[`replay-inventory-packet-research.md`](replay-inventory-packet-research.md).

An expanded full-payload and offline-oracle scan falsified the strongest simple
slot candidate: it matches 155/196 deterministic initial adds but only 108/239
terminal final-item labels. Across 882 offline-linked add/removal lifecycles,
the best slot-sized relationship reaches 675/882 and the best instance-sized
relationship 505/882; a separately labelled removal-slot scan reaches 420/733.
These correlations are useful search constraints but are not runtime fields.
The next inventory lead is the separate swap packet family plus a patch-16.9
field deserializer/symbol table.

### Keyframe champion state

The outer structure is exact on two independent patch-16.9 replays:

- packet families `0x0442`, `0x0165`, and `0x01F0` yield exactly one
  champion-owned block per participant per keyframe;
- 1,830 selected blocks have exact framing, timestamp alignment, and ownership,
  with no missing, duplicate, or non-champion owners;
- payloads change and therefore carry state.

No tested field survives the direct-value or first-difference semantic gate.
Position, health, resources, gold, XP, level, CS, damage, KDA, and alive state
are not decoded. Older supervised keyframe assignments are research artifacts,
not replay-only runtime fields. The blocker is the inner replication/component
serialization grammar. See
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

1. Decode the real movement/waypoint protocol and entity identity. Validate raw
   waypoints before considering interpolation, pathfinding, or movement-speed
   reconstruction.
2. Complete inventory slot/instance/removal decoding and reconstruct inventory
   state; then expose item events and a scrubber-synchronized inventory panel.
3. Decode the inner keyframe replication/component grammar and use final
   `statsJson` values plus controlled transitions as replay-only constraints for
   health, gold, level, XP, CS, and resources.
4. Decode ward subtype, position, vision radius, removal reason, and the one
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
