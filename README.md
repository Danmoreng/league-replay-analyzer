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

The current vertical slice is working end-to-end in the browser.

The parser currently extracts the embedded match metadata block already present inside the replay file. That currently gives us:

- game version
- game length
- last chunk/keyframe ids
- per-player stats from the embedded `statsJson` payload

The web app can load a local `.rofl` file, parse it through the real C++ Wasm module, and render a basic match summary plus raw parsed JSON.

## Next Focus

The next parser layer is lower-level chunk parsing and timeline extraction so the UI can move beyond metadata cards into:

- timeline scrubbing
- player movement on a 2D map
- wards and objective events
- richer state snapshots over time

## Setup Notes

- Read [docs/setup/windows.md](/C:/Development/league-replay-analyzer/docs/setup/windows.md) for this machine's current setup.
- Read [docs/chat.md](/C:/Development/league-replay-analyzer/docs/chat.md) for the original product and architecture discussion.
- Read [AGENTS.md](/C:/Development/league-replay-analyzer/AGENTS.md) for repo-specific working instructions.
- Read [program.md](/C:/Development/league-replay-analyzer/program.md) and [docs/autonomous-decoder-research.md](/C:/Development/league-replay-analyzer/docs/autonomous-decoder-research.md) if you want to run autonomous overnight decoder research.
- Start the repo-local supervisor with `pwsh -File .\scripts\run_autoresearch.ps1 -Tag <tag>`.
- Stop it with `pwsh -File .\scripts\stop_autoresearch.ps1 -Tag <tag>`. This prevents new iterations, but it does not forcibly kill a `codex exec` child that is already running.
