# Windows Setup

## Required Tools

- Node.js
- npm
- CMake
- Visual Studio 2022 with MSVC C++ tools
- Vite+ installed at `C:\Users\User\.vite-plus\0.1.11\bin\vp.exe`

## Recommended Tools

- Git
- Ninja
- Emscripten SDK for the WebAssembly build

## Machine Status

This machine is already set up well enough to build the current project state.

Known working assumptions:

- the repo is using the user's current Node installation
- the Vite+ project is scoped to `apps/web`, not the repo root
- Vite+ commands may be easier to run outside the sandbox
- Emscripten is installed locally under `tools/emsdk`
- `scripts/build-wasm.ps1` can import `tools/emsdk/emsdk_env.ps1` automatically when needed

## Common Commands

Install JavaScript dependencies from the repo root through Vite+ so the pinned
npm version and Vite+/Vitest aliases are respected:

```powershell
vp install --frozen-lockfile
```

Run the web app from the repo root:

```powershell
npm run dev:web
```

Or work directly in the frontend folder:

```powershell
Set-Location .\apps\web
vp dev
```

Run the frontend validation loop from the repo root:

```powershell
npm run check:web
npm run test:web
npm run typecheck:web
```

Build the native parser:

```powershell
pwsh -File .\scripts\build-native.ps1 -UseNinja -Configuration Debug
```

Run the native tests:

```powershell
pwsh -File .\scripts\test-native.ps1 -UseNinja -Configuration Debug
```

Build the Wasm module and publish it into the frontend source tree:

```powershell
pwsh -File .\scripts\build-wasm.ps1 -Configuration Release
```

## Emscripten

Emscripten is required for the browser Wasm target and is already installed locally in this repo.

If the environment needs to be loaded manually in a fresh shell, use:

```powershell
Set-Location .\tools\emsdk
.\emsdk_env.ps1
emcc -v
```

## Notes

- Prefer running important `.ps1` scripts outside the sandbox on this machine.
- Run Vite+ commands from `apps/web` or via the root `npm run *:web` wrappers instead of treating the repo root as the Vite+ project.
- If `vp` is not visible inside the sandbox, call `C:\Users\User\.vite-plus\0.1.11\bin\vp.exe` explicitly or run it outside the sandbox.
- The current Wasm build publishes generated files into `apps/web/src/generated/wasm` so the frontend can import them directly.
