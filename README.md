# League Replay Analyzer

Local-first replay analysis for League of Legends `.rofl` files.

## Current Direction

The project is built around a shared C++ replay/analytics core with two intended targets:

- native executable/test harness for parser development
- WebAssembly module for browser-side parsing

The frontend is a Vue 3 + TypeScript app and the JavaScript toolchain is now managed through Vite+.

## Repo Layout

- `apps/web` - Vue frontend and replay metadata dashboard
- `packages/rofl-core` - native C++ parser core and replay metadata extraction
- `packages/rofl-wasm` - browser Wasm bridge target for the C++ parser
- `scripts` - Windows/PowerShell automation
- `docs` - project notes, setup instructions, and captured direction
- `replays` - local replay samples for testing

## Quick Start

Install dependencies with Vite+:

```powershell
vp install
```

Run the web app:

```powershell
vp run dev --filter @lra/web
```

Build the web app:

```powershell
vp run build --filter @lra/web
```

Run the Vite+ validation loop:

```powershell
vp check
vp test
```

Build the native parser:

```powershell
pwsh -File .\scripts\build-native.ps1 -RunSmokeTest
```

Print a replay summary from the native parser:

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --summary .\replays\EUW1-7779216102.rofl
```

Build Wasm once emsdk is installed:

```powershell
pwsh -File .\scripts\build-wasm.ps1
# if emsdk is cloned into .\tools\emsdk, the script will import it automatically
```

## Current MVP

The first parser pass extracts the embedded match metadata block already present inside the replay file. That currently gives us:

- game version
- game length
- last chunk/keyframe ids
- per-player stats from the embedded `statsJson` payload

This is enough to render an immediate browser dashboard while the lower-level chunk parser is still being built.

## Setup Notes

- Read [docs/setup/windows.md](/C:/Development/league-replay-analyzer/docs/setup/windows.md) before adding the Wasm build.
- Read [docs/chat.md](/C:/Development/league-replay-analyzer/docs/chat.md) for the original product and architecture discussion.
