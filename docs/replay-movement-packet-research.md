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
