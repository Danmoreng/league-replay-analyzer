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
- Vite+ commands may be easier to run outside the sandbox
- Emscripten is installed locally under `tools/emsdk`
- `scripts/build-wasm.ps1` can import `tools/emsdk/emsdk_env.ps1` automatically when needed

## Common Commands

Install JavaScript dependencies:

```powershell
vp install
```

Run the web app:

```powershell
vp run dev --filter @lra/web
```

Run the Vite+ validation loop:

```powershell
vp check --fix
vp test
```

Build the native parser:

```powershell
pwsh -File .\scripts\build-native.ps1 -Configuration Debug
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
- If `vp` is not visible inside the sandbox, call `C:\Users\User\.vite-plus\0.1.11\bin\vp.exe` explicitly or run it outside the sandbox.
- The current Wasm build publishes generated files into `apps/web/src/generated/wasm` so the frontend can import them directly.
