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
- tooling: Vite+ / Vite
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

At the moment this repo is early-stage but already scaffolded. `docs/chat.md` contains the product and architecture discussion that defines the current direction. `scripts/reference/example_build.ps1` is a reference for how PowerShell-based CMake build scripts should be written for this user’s Windows setup.

When starting a future session:

1. read this file
2. read `docs/chat.md` if product/architecture context is needed
3. inspect the actual repo state before assuming the planned structure already exists

## Windows and Shell Assumptions

- OS: Windows
- shell: PowerShell 7
- repo path: `C:\Development\league-replay-analyzer`
- the user has seen PowerShell scripts fail inside the sandbox on this machine

Because of that, follow these rules:

- If a task requires executing a PowerShell build/setup/test script (`.ps1`), prefer running it outside the sandbox with escalated permissions.
- If a script is important and fails inside the sandbox, rerun it outside the sandbox instead of trying to work around the environment.
- Use PowerShell-native commands and paths in examples and automation unless there is a strong reason not to.`r`n- Vite+ is installed for this user, but the sandbox PATH may not expose `vp`; prefer running Vite+ outside the sandbox, and if needed call `C:\Users\User\.vite-plus\0.1.11\bin\vp.exe` explicitly.
- Assume Visual Studio C++ tools and CMake are the primary native toolchain on this machine.
- Prefer build scripts that bootstrap the MSVC environment through `vswhere.exe` + `vcvars64.bat` when needed.
- Support Ninja as an option, but keep Visual Studio generator support available unless the user removes that requirement.

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

If the repo is scaffolded from scratch, prefer a layout close to:

- `apps/web` for the Vue frontend
- `packages/rofl-core` for the C++ parser and analytics core
- `packages/rofl-wasm` or equivalent wrapper/build glue for Wasm exposure
- `scripts` for PowerShell automation
- `docs` for format notes, reverse-engineering notes, and architecture decisions
- `fixtures` or `testdata` for replay samples if the user can legally store them here

This is a preference, not a hard rule. Follow the actual repo if it already diverges intentionally.

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

- Prefer first-party docs and the repo’s own notes for decisions.
- If external research is needed, use community replay parsers as references for file format behavior, but do not copy them in as dependencies unless the user explicitly changes the rule.
- Keep third-party runtime dependencies lean, especially in the parser layer.
- Favor maintainable, testable code over clever reverse-engineering shortcuts.

## Documentation Maintenance

When architecture, workflow, or tooling assumptions materially change:

- update `AGENTS.md`
- add or update focused docs in `docs/`
- keep future sessions from relying on stale assumptions in `docs/chat.md`

If you make an important project-level decision, leave a short written record near the code instead of relying on conversation history alone.
