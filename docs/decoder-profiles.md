# Decoder Profiles

## Purpose

The productive decoder uses the strict external schema
`rofl-replay-decoder-profiles/v1`. Its canonical profile asset is
[`packages/rofl-core/profiles/replay-decoder-profiles.v1.json`](../packages/rofl-core/profiles/replay-decoder-profiles.v1.json).

Profiles carry version/build-specific packet opcodes, lengths, discriminators,
and other already-proven grammar parameters. They do not discover semantics and
must not turn packet correlations, plausible values, or offline API labels into
runtime facts.

## Runtime architecture

One C++ profile loader and interpreter is shared by the native CLI and Wasm
builds. The CLI may receive an optional `--decoder-profiles` path. The browser
passes the canonical JSON bytes through the per-call Wasm ABI; the productive
web path therefore uses the external asset rather than relying on a compiled-in
table.

Built-in profiles remain a backwards-compatibility fallback for callers that do
not supply an external profile. They are not the productive web configuration.

```text
canonical profile JSON asset
  -> strict C++ loader / interpreter
  -> Native CLI or per-call Wasm ABI
  -> normalized replay-only events with profile provenance
```

The loader selects an exact replay version/build profile. It enforces the
schema's strict validation and 256 KiB input limit, fails closed for missing,
invalid, ambiguous, or unsupported profiles, and records a provenance
fingerprint for the selected external profile. A supplied invalid external
profile must never silently fall back to another profile.

## Change boundary

An opcode-only patch update can be shipped by updating the profile asset and
the frontend asset that supplies it; it does not require a Wasm rebuild. A
semantically new packet grammar, field interpretation, or event state machine
still requires a C++ implementation change, replay-only corpus evidence, and
the usual native/Wasm/UI promotion gates. Profiles are declarative parameters,
not autonomous semantic inference.

## Current 16.14 validation

For exact build `16.14.794.5912`, the external profile validates against the
ten saved replay/API fixture pairs as follows:

| Surface | Replay-only result | Offline validation |
| --- | --- | --- |
| Champion kills | normalized events | 684 / 684 |
| Elite objectives | normalized events | 99 / 99 |
| Ward placements | normalized events | 1,477 / 1,477 |
| Ward removals | normalized events | 484 / 484 |
| Final player stats | validated final scalar/item fields | 1,300 / 1,300 |
| Purchase-linked resulting-item updates | strict `rofl-replay-purchase-linked-item-updates/v1` subset | 193 / 193 (D7 130, H3 63), zero extras or wrong IDs, maximum 1 ms delta |
| Direct add-only item purchases | strict `rofl-replay-direct-item-purchases/v1` subset | 1,278 / 1,278 (D7 844, H3 434), including 1,043 / 1,043 buildable components (D7 710, H3 333), zero extras or wrong IDs, maximum 1 ms delta |
| Item sale operations | operation-only `rofl-replay-item-sales/v1` stream | 116 / 116 (D7 77, H3 39), zero extras or misses, maximum 1 ms delta |
| Keyframe participant stat snapshots | `rofl-replay-participant-stat-snapshots/v2` | exact build only: 2,170 D7 and 1,030 H3 champion-owned XP/level/total-gold/lane-CS snapshots, all finite/nonnegative/monotonic; level validates 3,200/3,200 and floored XP 3,198/3,200 with only frozen ordering-boundary differences |

The purchase-linked resulting-item-update surface is available only through
this exact-build external profile. It consumes the loaded replay and selected
local profile bytes only, and fails closed for a missing, invalid, non-external,
or non-`16.14.794.5912` profile. It is a strict subset rather than a complete
purchase or inventory timeline: 2,326/2,519 profiled add/update packets remain
unavailable, as do slot, item instance, removal, component identity, full
inventory, gold/price, and undo state.

The direct-add-only purchase surface is likewise exact-build external-profile
only. Its `inventoryDirectPurchaseSubset` grammar requires one champion-owned
channel-1 `0x0369` add with content length 14 or 15 at its exact owner/time
group, then rejects the candidate if a `0x0369`, `0x03F9`, `0x0146`, or
`0x0081` operation occurs for that owner within +/-1 ms. The structural
13-bit replay-decoded ID must be contained in the same profile's pinned static
Data Dragon `16.14.1` `en_US` catalog: SHA-256
`0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75`, 212
real item IDs (at most 8191), and 71 buildable component IDs with a non-empty
Data Dragon `into` relation. The profile loader compares both complete ID
arrays against the frozen exact-build catalog rather than trusting their counts
or metadata alone. That catalog classifies
only an ID already decoded from replay bytes; it contributes no match state.
2,010/2,422 static-grant/non-real candidates are rejected. The direct stream
is disjoint from the 193 purchase-linked transform subset; together the two
recover 1,471/1,973 exact offline purchase labels (74.6%). It still has no
slot, instance, count/charges, removed-item identity, removal, full inventory,
price/gold, or undo state.

The `inventorySaleSubset` grammar is a separate exact-build external-profile
operation classifier. A normalized sale event is limited to replay-native
participant, timestamp, sale-operation classification, and exact removal-block
provenance. It carries no sold item identity, slot, item instance,
count/charges, price, gold gain, undo, or inventory state. Those fields must
remain unavailable in every event and diagnostic. The browser may render the
operation as a separate orange timeline marker, but may not apply it to an
inventory model. Missing, invalid, built-in, ambiguous, or non-`16.14.794.5912`
profiles fail closed.

`keyframeParticipantStats` is another separate exact-build external-profile
capability. It pins only a fully specified replay grammar: keyframe/channel-1
`0x02EB`, content length 1,479, the champion network-ID base, a required
bijective 256-entry `cipherToPlain` permutation, and three fixed interleaved
Float32LE byte-offset arrays. The canonical cipher table SHA-256 is
`c9be1f4971505dcc7c4366329366794108c1b031060039a2bcfd2d60134ed4be`; the
loader rejects a duplicate/missing permutation value or any non-exact-build
use. The profile decodes XP from `[83,85,87,89]`, total gold from
`[115,117,119,121]`, and lane CS from `[123,125,127,129]`. Level is derived
with the patch-pinned XP thresholds and the replay-embedded validated final
level's 18-or-20 cap. Runtime does not consult, learn from, or repair values
with Timeline data. The normalized output is external-profile-only in Native
and Wasm and fails closed if values are non-finite, negative, lane CS is not
integral, ownership is invalid, a participant track decreases, a
timestamp/participant pair is duplicated, or a keyframe does not contain the
complete participant set 1 through 10. Neutral CS, current spendable gold,
health, and resources are deliberately absent from this capability pending separate
semantic/promotion gates.

The canonical profile asset currently carries revision `2026-07-23`, SHA-256
`47f20aae95740df4fb3b66417cabd146abe85c23b432c5fa1bd17d868995f9b0`, and
fingerprint `fnv1a64:7eb24280c8b9ce1d`. All exact-build surfaces fail
closed for a missing, invalid, non-external, ambiguous, or non-`16.14.794.5912`
profile.

Ward position remains unavailable: the corresponding 16.14 research produced
zero valid coordinate candidates. The profile neither supplies nor infers a
ward coordinate.

## Safety and oracle boundary

The runtime profile and decoder consume only the loaded `.rofl` and the
selected local profile bytes. Saved Riot fixtures are offline discovery and
validation oracles only; they are never a browser/runtime input or fallback.
The project safety boundary remains unchanged: do not execute, inspect,
instrument, patch, emulate, or otherwise access League/Riot binaries,
processes, Vanguard, or Vanguard-managed data.
