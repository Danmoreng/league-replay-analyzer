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
- `scripts/build-native.ps1` builds the native target.
- `scripts/build-wasm.ps1` builds the Wasm target and publishes generated artifacts into `apps/web/src/generated/wasm`.
- `replays/` contains local replay samples for manual testing.
- the parser extracts embedded replay metadata and per-player final `statsJson`
- the shared C++ core implements exact packet-block framing with timestamps, channels, packet types, signed compact block parameters, payload boundaries, and source provenance
- native CLI tools validate framing, catalog packet types, dump bounded payload samples, and emit normalized replay-only champion-kill and elite-objective events
- the kill decoder is version-profiled for patches 15.22 through 16.9 and validates 2,796/2,796 corpus kills plus final K/D/A for all 470 participants
- the elite-objective decoder is version-profiled for the same patch groups and validates 425/425 events with zero extras, missing events, or unknown emitted classes
- the current web app loads a `.rofl` locally, calls the real Wasm decoder, and renders replay-derived participant summaries, kills, and elite objectives with diagnostics
- objective killer/team, elemental dragon subtype, event positions, and kill damage/gold details remain unresolved
- ward lifecycle research is close to runtime promotion: 6,168/6,168 placements are exact, while 1,882/1,883 conservative removals are high-confidence partial coverage with zero extras and exact fields for emitted events; subtype and position are not decoded and there is no C++/Wasm ward API yet
- patch-16.9 inventory research decodes add/update item IDs and a sale-operation class, but slot/instance/removal linkage, undo, and full inventory state are unresolved; no inventory runtime API exists
- keyframe outer framing and champion ownership are exact, but the inner replication/component grammar and all proposed dynamic state fields remain unresolved
- there is no valid replay-native movement or position decoder; the provisional `0x00DC` raw-coordinate interpretation was disproven and removed from the runtime
- building and turret-plate signatures are correlations with false positives, not runtime decoders

Important browser caveat:

- the minimap is currently fixture/research UI, not live output from the loaded `.rofl`
- its fixed `api-positions.json` fallback comes from one hard-coded replay and can display false movement for any other loaded replay; removing or isolating this fallback is the first product cleanup
- precomputed `public/replay-movement-fixtures` are research artifacts and must not be described as Wasm-decoded movement

Near-term engineering focus should be:

1. remove or explicitly isolate the misleading fixed minimap fallback
2. promote the validated ward lifecycle through C++, Wasm, and Vue
3. decode the real movement/waypoint message grammar and replay-native entity identity
4. finish inventory slot/instance/removal decoding and reconstruct full inventory state
5. decode keyframe replication/component state for health, resources, gold, XP, level, CS, and related timeseries
6. promote buildings/plates and pursue damage, spell, combat-effect, and world-entity streams

When starting a future session:

1. read this file
2. read `docs/decoder-status.md` for the canonical implementation and research status
3. use `docs/reverse-engineering-index.md` to find focused evidence and reproduction commands
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
