# Packet-Block Semantic Findings

This note records replay-only semantic findings made after replacing the old
length-prefix heuristic with the actual packet-block framing.

## Validation boundary

- Packet boundaries, timestamps, channels, packet types, block parameters, and
  payload bytes come from `.rofl` files only.
- Riot Match-V5/timeline fixtures are used only as offline labels to validate
  candidate semantics.
- Packet type numbers are version-sensitive and must be selected through a
  patch/build profile.

## Champion kill decoder

Across all 47 local replays (patch groups 15.22 through 16.9), every
`CHAMPION_KILL` is represented by the same two-part structure on channel 1:

1. A sequence of owner-attributed packets at one timestamp.
2. A fixed-five-byte death marker at that timestamp whose `blockParam` is the
   victim champion's network ID.

The owner sequence is exactly:

```text
[victim, ...ordered assists, killer]
```

An execution with Riot `killerId = 0` contains only `[victim]`.

The death marker closes the sequence, including when two kills have the same
millisecond timestamp. Packet source order must therefore be preserved.

The packet type alone is not sufficient. One patch-16.6 replay contains three
additional `0x001A` packets with no same-time owner sequence. They are not kill
events and must be ignored. Across the corpus there are 2,799 candidate marker
packets, 2,796 valid owner-sequence-plus-marker events, and three ignored orphan
markers.

Validated patch profiles:

| Patch group | Owner-sequence type | Death-marker type | Champion ID base | Validated kills |
|---|---:|---:|---:|---:|
| 15.22 | `0x0015` | `0x01D4` | `0x40000099` | 166 |
| 15.23 | `0x0105` | `0x0343` | `0x400004CC` | 69 |
| 15.24 | `0x01D8` | `0x020E` | `0x40000147` | 67 |
| 16.1 | `0x02D6` | `0x0093` | `0x400000AD` | 119 |
| 16.5 | `0x021A` | `0x03EF` | `0x400000AD` | 56 |
| 16.6 | `0x02EC` | `0x001A` | `0x400000AD` | 660 |
| 16.7 | `0x0052` | `0x0452` | `0x400000AD` | 445 |
| 16.9 | `0x0073` | `0x02CB` | `0x400000AD` | 1,214 |

Total validation result: 2,796 of 2,796 Riot timeline kill events matched
within 1 ms, including victim, killer, and ordered assist IDs. Independently,
the decoded event aggregates match the replay's own final `statsJson` K/D/A for
all 470 participants.

The current corpus also validates that `statsJson[index]` maps to
`participantId = index + 1`: champion, team, and Riot ID identity match the
offline fixtures for all 470 participants. This is replay-format evidence, not
a reason to read Riot data at runtime.

For each validated replay, champion network IDs are contiguous and map as:

```text
championNetworkId = championIdBase + participantId
```

The pre-16.1 bases have limited replay support and should not be hardcoded as a
general patch guarantee. Runtime decoding should derive champion ownership from
startup/keyframe entity creation and use the bases above as validation fixtures.

## Signed compact block parameters

The compact one-byte `blockParam` delta is a signed 8-bit delta.

Interpreting it as unsigned creates false owner IDs offset by `0x100`,
`0x200`, and so on when the stream moves backward between contiguous champion
IDs. Kill sequences provide an exact regression oracle because their owners
must reconstruct to the ten champion IDs.

## Runtime decoder shape

For a selected patch profile:

```text
pendingOwners = []

for block in source order:
  if block matches ownerSequenceType:
    append block.blockParam to pendingOwners

  if block matches deathMarkerType:
    keep only pending owners within 1 ms of the marker timestamp
    if no matching owners:
      ignore this non-kill use of the packet type
      clear pendingOwners
      continue
    require pendingOwners[0] == block.blockParam

    victim = pendingOwners[0]
    if pendingOwners.length == 1:
      killer = none
      assists = []
    else:
      assists = pendingOwners[1:-1]
      killer = pendingOwners[-1]

    emit champion-kill event
    pendingOwners = []
```

Pending owner packets are retained from the previous candidate marker until the
next candidate marker; only the same-time subset is used. Clearing on every
sequence timestamp change loses valid events when unrelated uses of the owner
packet type are interleaved. The implementation must retain segment/source
offsets for diagnostics.

## Elite monster objective decoder

The 47-replay corpus contains 425 `ELITE_MONSTER_KILL` events. One channel-1
profile per patch reproduces all 425 within 1 ms, with the matching replay
packet count equal to the timeline event count and no extra matching packets:

| Patch | Type | Lengths | Events |
|---|---:|---:|---:|
| 15.22 | `0x02DE` | 126 | 22 |
| 15.23 | `0x026E` | 126/127 | 14 |
| 15.24 | `0x00FF` | 126/127 | 8 |
| 16.1 | `0x03C3` | 126/127 | 19 |
| 16.5 | `0x0328` | 126/127 | 9 |
| 16.6 | `0x00F2` | 126/127 | 103 |
| 16.7 | `0x03AE` | 126/127 | 74 |
| 16.9 | `0x01EB` | 132/133 | 176 |

The monster-class discriminator is also exact for the available corpus:

- 15.22 `payload[124]`: Dragon 149, Atakhan 103, Baron 241, Herald 82, Horde 126.
- 15.23 `payload[1]`: Dragon 108, Atakhan 134, Baron 114, Herald 47, Horde 42.
- 15.24 `payload[122]`: Atakhan 62, Dragon 43, Herald 247, Horde 198; no Baron fixture.
- 16.1 `payload[122]`: Dragon 111, Baron 178, Herald 204, Horde 170.
- 16.5: length 127 is Horde; for length 126, `payload[3]` is Dragon 184, Baron 30, Herald 222.
- 16.6 `payload[122]`: Dragon 255, Baron 12, Herald 199, Horde 31.
- 16.7 `payload[1]`: Dragon 71, Baron 42, Herald 8, Horde 170.
- 16.9 `payload[2]`: Dragon 69, Baron 172, Herald 118, Horde 123.

Elemental dragon subtype and killer ownership remain unresolved. Runtime
selection needs only replay version, type, length, and payload; Riot data was
used only for offline validation.

## Building and turret-plate candidates

Candidate signatures cover all 640 `BUILDING_KILL` and 2,441
`TURRET_PLATE_DESTROYED` timestamps, but they also occur outside labelled
events, so they remain correlations rather than safe decoders.

Building type/length profiles are: 15.22 `0x036C`/107, 15.23 `0x0213`/107,
15.24 `0x023A`/107, 16.1 `0x019F`/107, 16.5 `0x0140`/107, 16.6
`0x0471`/107, 16.7 `0x01E7`/112, and 16.9 `0x03C4`/112. Patch 16.9 turret
plates have paired `0x0033` and `0x01C1` length-17 packets at all 1,133
timestamps, plus a related length-17 `0x03C4`; payload or conjunction rules
are still needed to reject false positives.

## Item transaction correlations

Across 10,494 purchases, 9,834 destroys, 428 sales, and 359 undos, the
purchase-correlated 14/15-byte type and removal/sale-correlated 6/7-byte type
are:

| Patch | Purchase-correlated | Removal/sale-correlated |
|---|---:|---:|
| 15.22 | `0x0173` | `0x02D1` |
| 15.23 | `0x043C` | `0x01BE` |
| 15.24 | `0x01E7` | `0x0252` |
| 16.1 | `0x03D8` | `0x047F` |
| 16.5 | `0x0090` | `0x00F3` |
| 16.6 | `0x037F` | `0x02F9` |
| 16.7 | `0x00F8` | `0x013E` |
| 16.9 | `0x0132` | `0x0415` |

Removal lengths 6 and 7 cover all 428 sale timestamps with the correct
champion `blockParam` owner, but these types also occur elsewhere. Item IDs
and before/after IDs never appear as plain u16/u32 little- or big-endian values
in these payloads. Treat them as bit-packed replicated inventory deltas and do
not expose item IDs until that schema is decoded.
