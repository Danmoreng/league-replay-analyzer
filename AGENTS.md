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
- Linux equivalents are `scripts/build-native.sh`, `scripts/test-native.sh`,
  and `scripts/build-wasm.sh`; `scripts/import-replays.sh` safely imports a
  locally staged replay corpus without silent overwrites.
- `replays/` contains local replay samples for manual testing.
- the parser extracts embedded replay metadata and per-player final `statsJson`
- the shared C++ core implements exact packet-block framing with timestamps, channels, packet types, signed compact block parameters, payload boundaries, and source provenance
- native CLI tools validate framing, catalog packet types, dump bounded payload samples, and emit normalized replay-only champion-kill, elite-objective, ward-lifecycle, item-purchase-subset, and item-sale-operation events
- the kill decoder is version-profiled for patches 15.22 through 16.9 and validates 2,796/2,796 corpus kills plus final K/D/A for all 470 participants
- the elite-objective decoder is version-profiled for the same patch groups and validates 425/425 events with zero extras, missing events, or unknown emitted classes
- the current web app loads a `.rofl` locally, calls the real Wasm decoder, and renders replay-derived participant summaries, kills, elite objectives, ward lifecycle events, strict purchase-linked resulting-item updates, strict direct add-only item purchases, exact item-sale operations, and exact-build profile-backed keyframe XP/level/total-gold/lane-CS snapshots
- the default web landing page is a timeline-first product replay view: the full-width scrubber prioritizes kills, objectives, purchase-linked resulting-item updates, direct add-only item purchases, and a separate orange item-sale-operation stream; Ward lifecycle is compressed into a density lane, team K/D/A, recognized item updates, and available XP/level/total-gold/lane-CS snapshots follow the scrub time. Sale markers never mutate or imply an inventory; XP and total gold are displayed with truncation from replay-native Float32 state, level is derived from patch-pinned XP thresholds plus the replay-embedded final level cap, and lane CS is emitted only after integral/monotonic validation. The separate summary level, neutral CS, Ward, and earned-gold fields remain explicitly labelled final. The product view does not show seven-slot final inventories as if they were dynamic, fake health/resource bars, a minimap, or ward-position research controls. Static Data Dragon names/icons are a fail-soft presentation layer with an exact replay-build-to-Data-Dragon-version pin (`16.14.794.5912` to `16.14.1`), never a runtime `latest` lookup, and never create replay state. Summary, fixture views, decoder tools, and position hypotheses remain Research & Debug concerns
- objective killer/team, elemental dragon subtype, event positions, and kill damage/gold details remain unresolved
- the ward lifecycle is promoted through C++, native CLI, Wasm, TypeScript, and Vue as `rofl-replay-wards/v1`: 6,168/6,168 placements are exact, while 1,882/1,883 conservative removals have zero extras and exact fields for emitted events; subtype, position, vision radius, and removal reason remain unavailable
- ward-position research isolates exactly one patch-versioned high-entropy spawn family plus one fixed 63-byte companion family for 6,168/6,168 placements and placement-to-removal differential pairs for 1,882/1,882 linked removals; patch 16.9 uses `0x00D6` plus `0x01AD`, but zero strict coordinate candidates pass, so productive ward position remains unavailable
- the separate `rofl-ward-position-candidates-research/v1` C++/Wasm surface keeps `researchOnly: true`, `promotionGate: false`, `positionAvailable: false`, and `clientBinaryInput: false`; the sole surviving `P16-FLOAT32-BE-API-FIT-COARSE` hypothesis is calculated from the loaded `.rofl` with a symbol lookup fitted offline from 95 saved kill-position anchors, but it is no longer mounted on the product landing page
- the patch-16.9 coarse ward-position model resolves only 48/2,625 placements across 19/20 replays because a marker requires all six mapped bytes: the per-lane lookup sizes are 3, 72, 65 for X offsets `p[8..10]` and 3, 70, 71 for Y offsets `p[12..14]`; any missing symbol makes the coordinate unavailable rather than guessed
- primary/companion lanes form a conflict-free 256-symbol permutation across 2,625 placements, and 701/745 linked removals have an exact full primary+companion spawn fingerprint match, but these equality constraints do not reveal the numeric coordinate assigned to an unknown symbol
- embedded final `statsJson` level, XP, lane CS, neutral CS, seven item slots, and ward-placement/kill aggregates validate exactly through the productive native summary for 6,110/6,110 fields across all 470 corpus participants; `validatedFinalPlayerStatsAvailable` restricts display to the eight validated patch groups with a complete valid field set, and the values are final state rather than timelines
- the Wasm suite includes a real in-memory zstd ROFL contract test for the ward ABI and unsupported-version error boundary; Wasm C++ exception handling must remain enabled for those JSON error boundaries
- patch-16.9 inventory research decodes add/update item IDs and a sale-operation class; for exact build `16.14.794.5912`, two complementary productive external-profile-only purchase streams are available. `rofl-replay-purchase-linked-item-updates/v1` emits 193/193 strict resulting-item updates (D7 130, H3 63). `rofl-replay-direct-item-purchases/v1` emits 1,278/1,278 isolated direct add-only purchases (D7 844, H3 434), including 1,043/1,043 buildable components (D7 710, H3 333). Both have zero extras/wrong IDs and at most 1 ms timing delta; their event sets are disjoint, yielding 1,471/1,973 exact offline purchase labels (74.6%). The direct stream accepts only a champion-owned `0x0369` length-14/15 add isolated from all relevant `0x0369`/`0x03F9`/`0x0146`/`0x0081` operation families within +/-1 ms, with its structural 13-bit ID in the canonical profile's exact pinned Data Dragon 16.14.1 catalog (212 real IDs, 71 buildable component IDs with a non-empty `into` relation; SHA-256 `0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75`). It rejects the non-purchasable static grants with item IDs `2010` and `2422`. Separately, `rofl-replay-item-sales/v1` is an exact external-profile-only sale-operation stream: 116/116 events (D7 77, H3 39), zero extras/misses, maximum 1 ms. It proves only replay-native participant, timestamp, sale operation, and removal-block provenance; sold item, slot, instance, count/charges, price, gold gain, undo, and inventory state are explicitly unavailable. No item stream provides full inventory reconstruction. Two unseen item-ID input symbols still fail closed, and an all-segment scan of 3,266 `0x0369` blocks finds neither symbol. Direct Recipe-/Removal-Ordinal hypotheses are intentionally not promoted: they cover only 113/193 exactly, while the Arity gate reaches 139 but has 26 false positives
- a maintained patch-16.14 static-recipe research gate accepts only an explicitly saved, SHA-256-pinned Data Dragon 16.14.1 item catalog and never performs network/latest lookup; intersecting transitive recipes with historical replay-decoded add IDs yields 194 exact singleton candidates out of 292 evaluated real-item removals (98 remain ambiguous), but historical IDs are not current inventory/instances and no runtime API or full reconstruction follows
- keyframe outer framing and champion ownership are exact. For exact build `16.14.794.5912`, every champion/keyframe has an exact 366-record `0x01EB` directory connected to one 1,479-byte `0x02EB` block by the exact bridge `0x0233 · (0x0306 0x0306)^k · 0x0452 · 0x007D?`, `k=0..4`; the `0x01EB` tokens remain a non-semantic physical directory. Separately, a D7-frozen profile-pinned 256-byte cipher→plain permutation (SHA-256 `c9be1f4971505dcc7c4366329366794108c1b031060039a2bcfd2d60134ed4be`) produces replay-native interleaved Float32LE keyframe snapshots: total gold `[115,117,119,121]` and integral lane CS `[123,125,127,129]`. On 2,170 D7 and 1,030 H3 snapshots both are finite, nonnegative, and participant-monotonic; Lane CS is integral everywhere. Timeline agrees after `trunc(totalGold)` on 2,166/2,170 D7 and 1,029/1,030 H3 snapshots and exactly on lane CS for 2,169/2,170 D7 and 1,029/1,030 H3; five retained shared-boundary deviations are never repaired at runtime. This profile-backed surface is implemented through C++, Native, Wasm, and the product UI and fails closed outside the exact external profile. XP `[83,85,87,89]` and neutral CS `[131,133,135,137]` are strong but unpromoted Float32 research candidates; current gold, level, health/resources, full inventory, movement, and the remaining inner state grammar remain unresolved
- there is no valid replay-native movement or position decoder; the provisional `0x00DC` raw-coordinate interpretation was disproven and removed from the runtime, and `0x01AB` has no promoted coordinate/waypoint grammar. A maintained exact-build patch-16.14 gate proves 6,314/6,314 consecutive `0x0328`→`0x0170` companion pairs plus 1,494 unpaired `0x0328` blocks, and 759 pair `blockParam` values exactly equal replay-decoded ward entity IDs after placement (all 29 links with known conservative removal precede it), but this bounded generic entity-handle relation exposes no operation, owner/champion, payload, waypoint, or coordinate grammar
- building and turret-plate signatures are correlations with false positives, not runtime decoders
- external profile revision `2026-07-23`, SHA-256 `47f20aae95740df4fb3b66417cabd146abe85c23b432c5fa1bd17d868995f9b0`, fingerprint `fnv1a64:7eb24280c8b9ce1d`, for build `16.14.794.5912` validates 684/684 kills, 99/99 objectives, 1,477/1,477 ward placements, 484/484 ward removals, 1,300/1,300 final player-stat values, 193/193 purchase-linked resulting-item updates, 1,278/1,278 direct add-only item purchases, 116/116 item-sale operations, and 3,200/3,200 keyframe levels plus 3,198/3,200 floored XP values (the two differences are frozen ordering boundaries) across the ten saved replay/API fixtures; ward position has zero valid candidates and remains unavailable

Important browser caveat:

- the product landing page intentionally shows no minimap until replay-native Champion positions pass promotion; minimaps elsewhere are fixture/research UI, not live movement output from the loaded `.rofl`
- experimental ward candidates remain available only through the research schema/tooling; they are not productive decoded ward positions, are not mounted on the product landing page, and visual plausibility cannot promote them
- the former fixed `api-positions.json` fallback is disabled; it is no longer loaded or relabelled for unrelated replays
- precomputed `public/replay-movement-fixtures` are research artifacts and must not be described as Wasm-decoded movement

Near-term engineering focus should be:

1. promote or reject the XP and neutral-CS Float32 stripes with a frozen integer-projection and snapshot-ordering rule; do not widen the profile, Wasm schema, or UI without a full replay-only gate
2. decode current gold, then level and health/resource state from the same exact-build keyframe grammar; never use Timeline values at runtime
3. preserve fail-closed handling for the two absent patch-16.14 item-ID symbols while decoding stateful inventory slot/instance/removal grammar and a complete reducer
4. use the exact ward-linked generic handle subset to decode `0x0328`/`0x0170` operation and payload grammar, expand replay-native entity identity, and only then decode movement/waypoints
5. expand or structurally decode the patch-16.9 ward symbol-to-Float32 mapping, then continue ward subtype/vision semantics and promote buildings/plates, damage, spells, combat effects, and world entities

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

Patch-pinned static game metadata may support a decoder grammar when it carries
no match state. For example, an exact Data Dragon item catalog may provide
versioned recipe edges only if its bytes are locally supplied, fingerprinted,
and selected with the exact replay profile. Never fetch `latest` at runtime or
use static metadata to fabricate a replay field that the loaded `.rofl` did not
semantically identify.

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

## Host and Shell Assumptions

### Windows

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

### Linux

- OS: Ubuntu Linux
- shell: Bash
- repo path on the current Linux research host:
  `/home/sebastian/league-replay-analyzer`
- use `scripts/build-native.sh` and `scripts/test-native.sh` with Ninja for the
  native build and tests
- use `scripts/build-wasm.sh` for the Emscripten build; it automatically loads
  a repo-local `tools/emsdk/emsdk_env.sh` when present
- use `scripts/run_decoder_artifacts.sh` and `scripts/run_decoder_corpus.sh`
  for decoder research; the latter is the complete Linux-native corpus gate
- use `scripts/run_autoresearch.sh` and `scripts/stop_autoresearch.sh` for the
  autonomous decoder loop
- never invoke PowerShell or a `.ps1` script on Linux; Linux workflows must use
  the maintained Bash/Node entry points
- emsdk 6.0.3 is the currently verified Linux Wasm toolchain version
- install JavaScript dependencies with `vp install --frozen-lockfile`; Vite+
  manages the Node.js and npm versions pinned by the project
- run Vite+ commands from `apps/web` or use the root `npm run *:web` wrappers
- local replay files remain ignored under `replays/`; use
  `scripts/import-replays.sh` when importing a staged Windows corpus

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

For Linux shell build scripts, keep the equivalent properties:

- Bash strict mode with `set -Eeuo pipefail`
- explicit configuration, build directory, generator, target, and clean options
- early prerequisite checks and guarded build-directory cleanup
- direct `cmake -S/-B` configuration followed by `cmake --build`
- concise status output and optional smoke validation

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
- `scripts` for PowerShell and Linux shell automation
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
- require a complete 57-replay corpus rerun in ScoreOnly mode before keeping changes; ScoreOnly is the default gate, not a partial corpus
- use [scripts/summarize_decoder_corpus.mjs](/C:/Development/league-replay-analyzer/scripts/summarize_decoder_corpus.mjs) as the machine-readable scorecard
- on Windows, use `scripts/run_autoresearch.ps1` and
  `scripts/stop_autoresearch.ps1`; on Linux, use the native
  `scripts/run_autoresearch.sh` and `scripts/stop_autoresearch.sh` equivalents
- generate full debug artifacts only for an explicit research question; durable evidence is the ledger row, compact summary, and kept commit, so retain at most the current baseline/active ScoreOnly root and manually delete completed reproducible score roots after their score is recorded; retain debug roots only while they remain useful evidence
- full-debug corpus roots are large (roughly 4.1 GiB versus the verified 408 MiB ScoreOnly reference); use a fast local SSD, check free space, and do not promise automatic deletion
- do not commit replay movement fixtures or scratch artifacts during the loop

If you make an important project-level decision, leave a short written record near the code instead of relying on conversation history alone.
