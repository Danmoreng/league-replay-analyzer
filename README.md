# League Replay Analyzer

Local-first replay analysis for League of Legends `.rofl` files.

## Current Direction

The project is built around a shared C++ replay/analytics core with two working targets:

- native executable/test harness for parser development
- WebAssembly module for browser-side parsing

The frontend is a Vue 3 + TypeScript app in `apps/web`, and that folder owns the Vite+ config and validation workflow.

## Repo Layout

- `apps/web` - Vue frontend and current replay dashboard
- `packages/rofl-core` - native C++ container, packet-block, and normalized event parser
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

The browser vertical slice now reads real replay packet data end-to-end.

The shared C++ core and research tooling currently cover:

- embedded replay metadata and per-player `statsJson`
- exact packet-block framing for startup, keyframe, and chunk segments
- packet timestamps, channels, packet types, signed compact entity parameters, payload boundaries, and source provenance
- normalized replay-only champion-kill events with victim, killer, ordered assists, participant identity, and final K/D/A validation
- native packet catalogs and bounded packet-type payload dumps for decoder research
- replay-derived final participant/team metric export shaped toward Riot match API parity
- keyframe/chunk reconstruction diagnostics
- replay-only movement candidate extraction and assignment diagnostics
- offline validation reports against local Riot fixtures and saved replay corpus artifacts

The exact packet grammar validates all 4,093 decompressed segments in the local
47-replay corpus: 79,232,747 packet blocks and 3,132,599,313 bytes with zero
framing errors across patch groups 15.22 through 16.9.

Champion kills are productionized through the shared C++/Wasm path. The corpus
contains 2,796 decoded events, all matching the offline timeline labels within
1 ms; replay metadata final K/D/A also matches all 470 participants. The Vue
app renders those replay-only events as a clickable kill timeline after a local
`.rofl` upload.

Useful commands:

```powershell
.\build\packages\rofl-core\rofl_core_cli.exe --validate-packet-framing .\replays\example.rofl
.\build\packages\rofl-core\rofl_core_cli.exe --summarize-packet-types-json .\replays\example.rofl
.\build\packages\rofl-core\rofl_core_cli.exe --extract-replay-kills-json .\replays\example.rofl
npm run extract:replay-kills -- .\replays\example.rofl
npm run validate:replay-kills-corpus
```

## Next Focus

The active decoder direction is API/timeline parity from `.rofl` files without using Riot API data at runtime. Current focused gaps are:

- porting the exact elite-monster objective profiles into normalized C++/Wasm events
- decoding bit-packed inventory deltas into safe item purchase/sale/undo events
- extracting gold, damage, health, mana, CS, and level timeseries from packet payloads
- stable replay-only participant identity for movement entities
- alias-aware movement entity grouping for `participantFrames.position`
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
