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

The purchase-linked resulting-item-update surface is available only through
this exact-build external profile. It consumes the loaded replay and selected
local profile bytes only, and fails closed for a missing, invalid, non-external,
or non-`16.14.794.5912` profile. It is a strict subset rather than a complete
purchase or inventory timeline: 2,326/2,519 profiled add/update packets remain
unavailable, as do slot, item instance, removal, component identity, full
inventory, gold/price, and undo state.

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
