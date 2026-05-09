# League Replay Analyzer

Local-first replay analysis for League of Legends `.rofl` files.

## Current Direction

The project is built around a shared C++ replay/analytics core with two working targets:

- native executable/test harness for parser development
- WebAssembly module for browser-side parsing

The frontend is a Vue 3 + TypeScript app in `apps/web`, and that folder owns the Vite+ config and validation workflow.

## Repo Layout

- `apps/web` - Vue frontend and current replay dashboard
- `packages/rofl-core` - native C++ parser core and replay metadata extraction
- `packages/rofl-wasm` - browser Wasm bridge target for the C++ parser
- `scripts` - Windows/PowerShell automation
- `docs` - project notes, setup instructions, and captured direction
- `replays` - local replay samples for testing

## Quick Start

Install dependencies from the repo root:

```powershell
npm install
```

Run the web app from the repo root:

```powershell
npm run dev:web
```

Or work directly inside the web app:

```powershell
Set-Location .\apps\web
vp dev
```

Build the web app from the repo root:

```powershell
npm run build:web
```

Run the frontend validation loop:

```powershell
npm run check:web
npm run test:web
npm run typecheck:web
```

Build the native parser:

```powershell
pwsh -File .\scripts\build-native.ps1 -UseNinja -RunSmokeTest
```

Run the native tests:

```powershell
pwsh -File .\scripts\test-native.ps1 -UseNinja
```

Print a replay summary from the native parser:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --summary .\replays\EUW1-7779216102.rofl
```

Build and publish Wasm into the frontend source tree:

```powershell
pwsh -File .\scripts\build-wasm.ps1 -Configuration Release
```

## Current MVP

The browser vertical slice is still working end-to-end, but the decoder work has moved well beyond the original metadata-only MVP.

The parser and research tooling currently cover:

- embedded replay metadata and per-player `statsJson`
- replay-derived final participant/team metric export shaped toward Riot match API parity
- keyframe/chunk reconstruction diagnostics
- replay-only movement candidate extraction and assignment diagnostics
- offline validation reports against local Riot fixtures and saved replay corpus artifacts

The web app can load a local `.rofl` file, parse it through the real C++ Wasm module, and inspect replay-derived outputs. The decoder research loop is currently driven mostly by native/scripted corpus artifacts in `artifacts-keyframes` and `artifacts`.

## Next Focus

The active decoder direction is API/timeline parity from `.rofl` files without using Riot API data at runtime. Current focused gaps are:

- stable replay-only participant identity for timeline rows and movement entities
- alias-aware movement entity grouping for `participantFrames.position`
- fuller timeline/event reconstruction from chunk/keyframe records
- preserving and calibrating validation-passing movement candidates through extraction

The latest movement checkpoint is intentionally not promoted to runtime `participantFrames.position`: strict replay-only current max128 assignment reaches high coverage only diagnostically, and the movement promotion audit remains `not_complete`. See `docs/rofl-api-parity.md` for current numbers and blockers.

## Decoder Checkpoints

The main replay/API parity checkpoint is:

```powershell
npm run verify:rofl-api-parity -- --replay-id EUW1-7840220945 --version-group 16.9 --allow-validation-mismatch --skip-incomplete-gate
```

Focused movement diagnostics:

```powershell
npm run summarize:movement-diagnostics -- --version-group 16.9 --output-path artifacts-keyframes/movement-diagnostics-summary-16.9.json
npm run verify:movement-diagnostics -- --version-group 16.9
npm run audit:movement-position-goal -- --version-group 16.9
```

The movement audit is a negative gate. `npm run audit:movement-position-goal -- --require-complete` should fail until replay-only position output has stable 10-player participant mapping across the 16.9 corpus.

## Setup Notes

- Read [docs/setup/windows.md](docs/setup/windows.md) for this machine's current setup.
- Read [docs/chat.md](docs/chat.md) for the original product and architecture discussion.
- Read [docs/rofl-api-parity.md](docs/rofl-api-parity.md) for the current decoder state, verifier commands, movement blockers, and parity artifact policy.
- Read [AGENTS.md](AGENTS.md) for repo-specific working instructions.
- Read [program.md](program.md) and [docs/autonomous-decoder-research.md](docs/autonomous-decoder-research.md) if you want to run autonomous overnight decoder research.
- Start the repo-local supervisor with `pwsh -File .\scripts\run_autoresearch.ps1 -Tag <tag>`.
- Stop it with `pwsh -File .\scripts\stop_autoresearch.ps1 -Tag <tag>`. This prevents new iterations, but it does not forcibly kill a `codex exec` child that is already running.
