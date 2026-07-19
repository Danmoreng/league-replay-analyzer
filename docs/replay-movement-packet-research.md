# Replay movement packet research

## Current status

No replay-native champion position, click target, or decoded waypoint stream is
ready for runtime use. A provisional patch-16.9 experiment interpreted two
masked fields from short champion-owned packet payloads as map coordinates.
Those values were in bounds and had exact participant ownership, but that was
not enough to establish their meaning.

Side-by-side comparison with saved Riot timeline positions disproved the
interpretation: the points neither follow champion movement nor form plausible
issued destinations. The C++/Wasm decoder and browser overlay based on those
fields were therefore removed before commit.

## Rejected interpretation

The rejected experiment used the following raw fields:

```text
xCandidate = littleEndianU16(payload + 0) & 0x3fff
yCandidate = littleEndianU16(payload + 8) & 0x3fff
```

These expressions describe only stable, in-range packet values. They must not
be called positions, path targets, endpoints, or waypoints. Exact packet
framing and exact champion ownership validate provenance, not semantics.

## Patch-16.14 entity-handle checkpoint

The maintained replay-only harness
`scripts/research_movement_entity_handles_16_14.mjs` keeps one narrower
structural result. It reads only the ten saved exact-build `16.14.794.5912`
`.rofl` files and uses the existing replay-only ward decoder solely as an
entity-ID oracle. The
oracle is bound to the checked-in external profile provenance fingerprint
`fnv1a64:6d28e6357df7d878`; profile drift fails closed. It does not read
Timeline, Match-V5, client binaries, or runtime inputs.

The fixed seven-replay D7 split is completely loaded, selected, and asserted
before the three-replay H3 split is opened. In D7, all 3,668 channel-1 chunk
`0x0170` blocks immediately follow a `0x0328` block with the same segment,
timestamp, `blockParam`, and payload length; 984 `0x0328` blocks are unpaired.
H3 independently reproduces 2,646/2,646 companion blocks with 510 unpaired
`0x0328` blocks.

A strict subset gives a replay-native generic entity-handle relation: 534 D7
and 225 H3 pair `blockParam` values exactly equal a decoded `WARD_PLACED`
`wardEntityNetworkId`. Each matching pair occurs after that replay-only ward
placement (D7 60,002--127,173 ms; H3 60,081--127,243 ms); all matched pairs
with an available conservative `WARD_KILL` occur before it (22/22 D7, 7/7 H3).
All known ward-linked pairs have 17-byte payloads. This is exact ID equality
and ordering evidence for the matched ward subset, not an explanation of the
operation or payload.

The harness also rejects two tempting overclaims for this profile: no paired
`blockParam` is a champion network ID, and no pair contains a raw little- or
big-endian 32-bit copy of its own `blockParam` in either payload. It therefore
does **not** establish owner/champion identity, broader entity classification,
entity creation, a handle codec, a lifecycle operation, coordinates, speed,
teleports, path counts, or waypoints. It produces a deterministic
`rofl-movement-entity-handles-research/v1` report with `researchOnly:true`,
`promotionGate:false`, and `runtimeInput:false`; no C++/Wasm/UI decoder follows.

Reproduce it after building `rofl_core_cli`:

```powershell
node .\scripts\research_movement_entity_handles_16_14.mjs `
  --output .\tmp\movement-entity-handles-16.14.json
```

## Stronger structural lead

The next decoder should start from the actual movement message grammar instead
of fitting raw offsets. Format references indicate that a decoded movement
message contains at least:

- path/count and teleport flags;
- an entity network ID;
- movement speed;
- compressed waypoint flags;
- signed 16-bit absolute coordinates and signed 8-bit waypoint deltas.

The coordinate transform used by that grammar is expected to be based on
signed fixed-point values, approximately:

```text
worldX = encodedX * 2 + 7358
worldY = encodedY * 2 + 7412
```

This is a research lead, not a promoted decoder profile. The payload first has
to be decrypted/decoded with the patch-specific packet protocol and then parsed
as a waypoint stream.

## Promotion gate

A movement decoder may reach C++/Wasm and the Vue minimap only after it passes
all of these checks:

1. Parse a complete message grammar rather than selecting correlated offsets.
2. Preserve replay-native entity identity and timestamp provenance.
3. Reconstruct valid waypoint sequences and reject malformed lengths/flags.
4. Compare against offline Riot positions across multiple replays and patches.
5. Report quantitative spatial error, temporal alignment, coverage, and false
   positives; being inside Summoner's Rift bounds is not sufficient.
6. Render decoded waypoints separately from interpolated current positions.

Until then, `scripts/discover_packet_movement.mjs` remains a research tool. Its
Riot timeline input is an offline validation oracle and must never become a
runtime dependency.
