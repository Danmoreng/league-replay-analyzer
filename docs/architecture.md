# Architecture Notes

Updated: 2026-07-17

## Current Shape

This repo is structured for a local-first web application with a shared replay core:

- `packages/rofl-core` owns container parsing, exact packet framing,
  patch-profiled semantic decoders, JSON normalization, tests, and native tooling
- `packages/rofl-wasm` exposes replay summary, kill, objective, ward, and research
  packet-analysis entry points to the browser
- `apps/web` owns local file loading, Vue state, timelines, rendering, and the
  Wasm integration
- `scripts` owns corpus extraction, offline Riot-fixture validation, and focused
  reverse-engineering probes

The productive browser path already parses the selected `.rofl` locally through
Wasm and renders participant final summaries, champion kills, elite-monster
objectives, and the validated ward lifecycle. Final level, XP, CS, items, and
ward aggregates come from embedded replay metadata; they are not timeseries.
The product renders those newly promoted fields only when the core emits
`validatedFinalPlayerStatsAvailable` for a complete field set in a validated
patch group.
The minimap remains fixture-based research UI and is not a decoded movement
stream.

## Target Data Flow

```text
local .rofl File/ArrayBuffer
  -> C++ container parser
  -> exact chunk/keyframe and packet-block stream
  -> patch/build profile
  -> semantic event/state/entity decoders
  -> normalized ReplayModel with availability and provenance
  -> Wasm worker boundary
  -> Vue playback clock
  -> 2D map, event timeline, side panels, and analytical overlays
```

Native C++ and browser Wasm must use the same semantic decoder implementation.
The native CLI remains the fastest corpus/debug surface; Wasm is the product
deployment target. A dedicated worker is the intended boundary once parsing or
normalization becomes large enough to affect the UI thread.

## Normalized Model Direction

Do not expose raw patch-specific packet types directly to product components.
Versioned decoders should populate stable domains such as:

- match and participant metadata
- timestamped frames and participant state samples
- champion, objective, building, inventory, ward, combat, and spell events
- entity lifecycles and movement/waypoint samples
- inventory snapshots and stat timeseries
- field availability, confidence, decoder version, and packet provenance

Unknown data must remain absent or explicitly unavailable. It must never be
filled from an unrelated replay, a Riot fixture, or a heuristic candidate.

## Validation Boundary

- Product/runtime inputs: loaded `.rofl` bytes and replay version only.
- Offline oracle: saved Riot Match-V5/Timeline fixtures used by corpus tests.
- Research artifacts: allowed for discovery and diagnostics, never silently
  consumed to manufacture product match state.
- Promotion: requires exact framing, replay-native identity, semantic corpus
  agreement, false-positive rejection, native tests, Wasm coverage, and clear UI
  limitations.

Patch profiles belong in the parser core. The UI should depend on normalized
schemas and capability flags, not packet opcodes or byte offsets.

## Near-Term Priorities

1. Decode replay-native movement messages and entity identity.
2. Complete inventory state reconstruction.
3. Decode keyframe component state for dynamic champion timeseries.
4. Decode ward subtype, position, vision radius, and removal reason.
5. Add structures, damage, spells, and additional world entities.

## Product Constraints

- Local-first and post-game only.
- No live memory reading, injection, live overlay, or gameplay automation.
- No mandatory backend for the core replay workflow.
- Graceful degradation across patches and partially decoded streams.
- Community parsers may inform research but are not runtime dependencies.

See [`decoder-status.md`](decoder-status.md) for the exact current support matrix
and corpus results.
