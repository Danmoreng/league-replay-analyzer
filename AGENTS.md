# AGENTS.md

## Project Intent

This repository is for building a local-first League of Legends replay analyzer that reads `.rofl` replay files and renders a 2D analytical view of the match.

The intended product is not a standalone 3D replay client. The target is an analytics-focused web application that can show:

- player and entity movement on a 2D map
- wards and vision-related overlays
- timeline scrubbing and event inspection
- side-panel state such as gold, items, level, CS, health, mana, and similar stats when extractable
- future analytical views such as pathing heatmaps, objective setup windows, and inferred vision pockets

## Key Product Constraints

- Keep the tool post-game and replay-file based.
- Do not depend on live memory reading, process injection, or any other live-game integration.
- Apply a hard local safety boundary to all decoder research:
  - never execute, inspect, instrument, patch, emulate, or reverse engineer installed League of Legends client/game binaries or running League/Riot processes
  - never access Vanguard, Vanguard-managed processes, or Vanguard-managed game/client data for tests or discovery
  - do not ask the user to disable, bypass, or weaken Vanguard or any Riot security mechanism
  - decoder discovery may use only saved `.rofl` files and their patch-versioned packet bytes, this repository's own parser/tools, and saved Riot API fixtures as offline validation oracles
- Treat Riot policy conservatively:
  - replay analysis is acceptable only if it stays offline/post-game
  - do not add live overlays, automation, or unfair-advantage features
- Build the parser from scratch in this repo.
- Existing community parsers may be used only as format references and inspiration, not as runtime dependencies.
- Expect the replay format to be version-sensitive and to change across patches.

## Preferred Architecture

Unless the user explicitly changes direction, optimize for this architecture:

- frontend: Vue 3 + TypeScript
- tooling: Vite+
- parser core: C++
- deployment targets for parser core:
  - native build for tests, corpus inspection, and tooling
  - WebAssembly build for in-browser replay parsing
- app model: local-first browser app, with parsing done client-side when feasible

The default architectural assumption is:

1. one shared C++ replay/analytics core
2. one Wasm wrapper consumed by the web frontend
3. one native executable or test harness for parser validation

Do not start by building a mandatory backend unless the user asks for shared storage, batch processing, collaboration features, or some other server-side requirement.

## Current Repo Reality

This repo is already scaffolded and has a working replay-only vertical slice.
The canonical detailed handoff is `docs/decoder-status.md`.

Current state:

- `apps/web` is a Vue 3 + TypeScript frontend managed with Vite+.
- the Vite+ project/configuration is scoped to `apps/web`; the repo root is a workspace/build orchestration layer, not the frontend project root
- `packages/rofl-core` contains the shared C++ replay parser core.
- `packages/rofl-wasm` builds the C++ parser to WebAssembly.
- decoder profiles use strict external schema `rofl-replay-decoder-profiles/v1`
  from `packages/rofl-core/profiles/replay-decoder-profiles.v1.json`; one C++
  loader/interpreter serves Native and Wasm, the CLI may take
  `--decoder-profiles`, and the productive web path passes canonical JSON bytes
  through the per-call Wasm ABI
- external profiles select exact version/build, are limited to 256 KiB,
  strictly validated, fail closed, and emit a provenance fingerprint; built-ins
  are backwards-compatibility fallback only, not the productive web path
- opcode-only updates require only profile/frontend-asset updates; semantic new
  grammar still requires C++ work and replay-only validation—profiles never
  autonomously discover semantics
- `scripts/build-native.ps1` builds the native target.
- `scripts/build-wasm.ps1` builds the Wasm target and publishes generated artifacts into `apps/web/src/generated/wasm`.
- `replays/` contains local replay samples for manual testing.
- the parser extracts embedded replay metadata and per-player final `statsJson`
- the shared C++ core implements exact packet-block framing with timestamps, channels, packet types, signed compact block parameters, payload boundaries, and source provenance
- native CLI tools validate framing, catalog packet types, dump bounded payload samples, and emit normalized replay-only champion-kill, elite-objective, and ward-lifecycle events
- the kill decoder is version-profiled for patches 15.22 through 16.9 and validates 2,796/2,796 corpus kills plus final K/D/A for all 470 participants
- the elite-objective decoder is version-profiled for the same patch groups and validates 425/425 events with zero extras, missing events, or unknown emitted classes
- the current web app loads a `.rofl` locally, calls the real Wasm decoder, and renders replay-derived participant summaries, kills, elite objectives, and ward lifecycle events with diagnostics
- the default web landing page is a product-oriented replay viewer with one combined kill/objective/ward timeline and final-state team rosters showing level, XP, lane and neutral CS, seven item slots, ward aggregates, and gold; movement, inventory history, health, mana, and other unresolved dynamic streams remain explicitly unavailable, while the earlier summary and decoder tools remain under Research & Debug
- objective killer/team, elemental dragon subtype, event positions, and kill damage/gold details remain unresolved
- the ward lifecycle is promoted through C++, native CLI, Wasm, TypeScript, and Vue as `rofl-replay-wards/v1`: 6,168/6,168 placements are exact, while 1,882/1,883 conservative removals have zero extras and exact fields for emitted events; subtype, position, vision radius, and removal reason remain unavailable
- ward-position research isolates exactly one patch-versioned high-entropy spawn family plus one fixed 63-byte companion family for 6,168/6,168 placements and placement-to-removal differential pairs for 1,882/1,882 linked removals; patch 16.9 uses `0x00D6` plus `0x01AD`, but zero strict coordinate candidates pass, so productive ward position remains unavailable
- the separate `rofl-ward-position-candidates-research/v1` C++/Wasm/UI surface keeps `researchOnly: true`, `promotionGate: false`, `positionAvailable: false`, and `clientBinaryInput: false`; the eight visually falsified raw-coordinate variants are hidden, and the live UI now exposes only `P16-FLOAT32-BE-API-FIT-COARSE`, calculated from the loaded `.rofl` with a symbol lookup fitted offline from 95 saved kill-position anchors
- the patch-16.9 coarse ward-position model resolves only 48/2,625 placements across 19/20 replays because a marker requires all six mapped bytes: the per-lane lookup sizes are 3, 72, 65 for X offsets `p[8..10]` and 3, 70, 71 for Y offsets `p[12..14]`; any missing symbol makes the coordinate unavailable rather than guessed
- primary/companion lanes form a conflict-free 256-symbol permutation across 2,625 placements, and 701/745 linked removals have an exact full primary+companion spawn fingerprint match, but these equality constraints do not reveal the numeric coordinate assigned to an unknown symbol
- embedded final `statsJson` level, XP, lane CS, neutral CS, seven item slots, and ward-placement/kill aggregates validate exactly through the productive native summary for 6,110/6,110 fields across all 470 corpus participants; `validatedFinalPlayerStatsAvailable` restricts display to the eight validated patch groups with a complete valid field set, and the values are final state rather than timelines
- the Wasm suite includes a real in-memory zstd ROFL contract test for the ward ABI and unsupported-version error boundary; Wasm C++ exception handling must remain enabled for those JSON error boundaries
- patch-16.9 inventory research decodes add/update item IDs and a sale-operation class; patch 16.14 separately proves its add/update/removal families, 116/116 sale operations, and seven exact item-ID bit positions across 1,971 labels, but the remaining six bits, slot/instance/removal linkage, swaps, undo, and full inventory state remain unresolved, and no inventory runtime API exists
- keyframe outer framing and champion ownership are exact; patch 16.14 additionally has an exact three-byte totalGold change envelope across 3,024 changing and 76 unchanged transitions, but it exposes no numeric gold value, nearby CS envelopes are imperfect, and the inner replication/component value grammar remains unresolved
- there is no valid replay-native movement or position decoder; the provisional `0x00DC` raw-coordinate interpretation was disproven and removed from the runtime
- building and turret-plate signatures are correlations with false positives, not runtime decoders
- external profile build `16.14.794.5912` validates 684/684 kills, 99/99
  objectives, 1,477/1,477 ward placements, 484/484 ward removals, and
  1,300/1,300 final player-stat values across the ten new saved replay/API
  fixtures; ward position has zero valid candidates and remains unavailable

Important browser caveat:

- the minimap is currently fixture/research UI, not live output from the loaded `.rofl`
- experimental ward markers are generated live from the loaded `.rofl` by the single API-offline-fitted coarse Float32 symbol model; they are not productive decoded ward positions, and visual plausibility cannot promote them
- the former fixed `api-positions.json` fallback is disabled; it is no longer loaded or relabelled for unrelated replays
- precomputed `public/replay-movement-fixtures` are research artifacts and must not be described as Wasm-decoded movement

Near-term engineering focus should be:

1. finish the patch-16.14 item-ID grammar, slot/instance/removal decoding, and full inventory-state reconstruction
2. decode the patch-16.14 keyframe replication/component value grammar beginning at the exact totalGold change envelope and nearby CS lanes, then reconstruct numeric gold, CS, XP, level, health, and resources
3. decode the real movement/waypoint message grammar and replay-native entity identity
4. expand or structurally decode the patch-16.9 ward symbol-to-Float32 mapping, prioritizing the sparse `p[9]`, `p[10]`, `p[13]`, and `p[14]` lanes; use new replay-native spatial anchors plus the exact primary/companion permutation and placement/removal equality constraints, never interpolation or visual plausibility, then rerun holdout and full-corpus gates
5. continue ward subtype/vision semantics and promote buildings/plates, damage, spell, combat-effect, and world-entity streams

When starting a future session:

1. read this file
2. read `docs/decoder-status.md` for the canonical implementation and research status
3. read `docs/decoder-profiles.md` before changing profile loading, version/build
   selection, Wasm profile bytes, or profile provenance
4. use `docs/reverse-engineering-index.md` to find focused evidence and reproduction commands
4. treat `docs/chat.md` only as historical product context, not current decoder truth
5. inspect the actual repo state before assuming planned work is still unfinished
6. prefer continuing from the current Wasm-backed frontend rather than rebuilding scaffolding

## Replay-Only Reconstruction Contract

The long-term target is a complete analytics-grade match reconstruction from the
loaded `.rofl`: movement, events, wards/vision, inventories, gold, level, XP,
CS, health/resources, damage, objectives, structures, and other useful entity
state rendered on a synchronized 2D map and timeline.

Runtime match data must come only from the loaded replay. Riot Match-V5 and
Timeline files are allowed as offline discovery and validation oracles, never as
runtime inputs or silent fallback data. Every normalized field must carry a
versioned decoder boundary and degrade to unavailable when not proven.

This replay-only contract also governs research tooling. Installed League/Riot
client binaries, game processes, Vanguard, and Vanguard-managed data are outside
the project scope and must not be executed, inspected, instrumented, patched, or
emulated. Saved replay packet bytes are the sole decoder input and evidence.

Promotion requires all of the following:

- exact replay framing and source provenance
- a replay-only semantic decode with replay-native participant/entity identity
- corpus validation with explicit false-positive rejection
- native tests, Wasm contract coverage, and honest UI availability labels

Exact timing, in-bounds values, or champion ownership prove provenance but do
not by themselves prove semantic meaning. Do not expose heuristic coordinates,
state fields, or event classifications as decoded facts.

## Windows and Shell Assumptions

- OS: Windows
- shell: PowerShell 7
- repo path: `C:\Development\league-replay-analyzer`
- the user has seen PowerShell scripts fail inside the sandbox on this machine
- the user wants PowerShell scripts run outside the sandbox when they matter

Because of that, follow these rules:

- If a task requires executing a PowerShell build/setup/test script (`.ps1`), prefer running it outside the sandbox with escalated permissions.
- If a script is important and fails inside the sandbox, rerun it outside the sandbox instead of trying to work around the environment.
- Use PowerShell-native commands and paths in examples and automation unless there is a strong reason not to.
- Vite+ is installed for this user, but the sandbox PATH may not expose `vp`; prefer running Vite+ outside the sandbox, and if needed call `C:\Users\User\.vite-plus\0.1.11\bin\vp.exe` explicitly.
- when running Vite+ commands, prefer `apps/web` as the working directory or use the root `npm run *:web` wrappers rather than treating the repo root as the Vite+ project
- Emscripten is installed locally under `tools/emsdk`; `scripts/build-wasm.ps1` can import `tools/emsdk/emsdk_env.ps1` automatically.
- Assume Visual Studio C++ tools and CMake are the primary native toolchain on this machine.
- Ninja is available and is the practical default generator here.
- Prefer build scripts that bootstrap the MSVC environment through `vswhere.exe` + `vcvars64.bat` when needed.

## Build Script Expectations

Use `scripts/reference/example_build.ps1` as the style reference for future build scripts in this repo.

Expected characteristics:

- strict PowerShell scripting with:
  - `[CmdletBinding()]`
  - `Set-StrictMode -Version Latest`
  - `$ErrorActionPreference = "Stop"`
- explicit parameters for:
  - configuration
  - build directory
  - optional clean
  - generator selection such as Ninja vs Visual Studio
  - specific target selection
- robust MSVC environment import via `vswhere` if `VCINSTALLDIR` is missing
- generator mismatch detection and cleanup when needed
- direct `cmake -S/-B` configure step followed by `cmake --build`
- optional smoke-test or validation hooks where useful

When authoring scripts here:

- prefer predictable, composable scripts over one-off command snippets
- keep parameters explicit
- fail early on missing prerequisites
- print concise status messages

## Engineering Priorities

Bias implementation work toward these foundations first:

1. replay container parsing and version detection
2. normalized internal schema for frames, events, entities, inventories, vision objects, and stat timeseries
3. repeatable parser tests against saved replay fixtures
4. native CLI or test harness for debugging parser behavior
5. Wasm boundary for browser use
6. Vue-based replay explorer UI

Important: do not tightly couple UI code to raw replay format details. Keep patch/version handling isolated inside the parser core and normalize data before it reaches the frontend.

## Suggested Repo Shape

The current repo already follows this layout:

- `apps/web` for the Vue frontend
- `packages/rofl-core` for the C++ parser and analytics core
- `packages/rofl-wasm` for Wasm exposure
- `scripts` for PowerShell automation
- `docs` for format notes, reverse-engineering notes, and architecture decisions
- `replays` for local replay samples

Follow the actual repo structure unless the user explicitly wants to reorganize it.

## Reverse-Engineering Guidance

When working on `.rofl` parsing:

- expect patch/version differences
- isolate format-specific logic behind versioned parser modules where possible
- document findings as you go
- preserve sample-driven tests for each supported replay era
- design for graceful degradation when some replay data streams are unavailable

If a replay cannot provide every stat stream, the product should still be able to deliver partial value such as:

- movement visualization
- event timeline
- ward placement overlays
- objective markers

## Research and Dependency Guidance

- Prefer first-party docs and the repo's own notes for decisions.
- If external research is needed, use community replay parsers as references for file format behavior, but do not copy them in as dependencies unless the user explicitly changes the rule.
- Keep third-party runtime dependencies lean, especially in the parser layer.
- Favor maintainable, testable code over clever reverse-engineering shortcuts.

## Documentation Maintenance

When architecture, workflow, or tooling assumptions materially change:

- update `AGENTS.md`
- add or update focused docs in `docs/`
- keep future sessions from relying on stale assumptions in `docs/chat.md`

## Autonomous Decoder Loop

This repo now also has a root [program.md](/C:/Development/league-replay-analyzer/program.md) that defines an autonomous overnight decoder-research loop.

If the user wants autonomous decoder iteration, read that file and [docs/autonomous-decoder-research.md](/C:/Development/league-replay-analyzer/docs/autonomous-decoder-research.md) before starting. The loop is intentionally narrower than general repo work:

- prefer decoder scripts and decoder docs
- require a full corpus rerun before keeping changes
- use [scripts/summarize_decoder_corpus.mjs](/C:/Development/league-replay-analyzer/scripts/summarize_decoder_corpus.mjs) as the machine-readable scorecard
- use [scripts/run_autoresearch.ps1](/C:/Development/league-replay-analyzer/scripts/run_autoresearch.ps1) as the recommended supervisor and [scripts/stop_autoresearch.ps1](/C:/Development/league-replay-analyzer/scripts/stop_autoresearch.ps1) to stop it cleanly
- do not commit replay movement fixtures or scratch artifacts during the loop

If you make an important project-level decision, leave a short written record near the code instead of relying on conversation history alone.
