# Windows Setup

## Required Tools

- Node.js
- npm
- CMake
- Visual Studio 2022 with MSVC C++ tools

## Recommended Tools

- Git
- Ninja
- Emscripten SDK for the WebAssembly build

## Node Version

Use the latest active LTS release, not an odd-numbered Current release.

This machine currently has Node `v25.2.1`, which is not an LTS line. That is good enough for experiments, but it is not the stable default I would use for a new repo.

## Emscripten

Emscripten is not required to start the native parser core. It is required once we want to compile the C++ core to WebAssembly for in-browser parsing.

Official install flow on Windows is through `emsdk`.

Typical install commands:

```powershell
git clone https://github.com/emscripten-core/emsdk.git
Set-Location .\emsdk
.\emsdk install latest
.\emsdk activate latest
.\emsdk_env.ps1
```

After that, verify with:

```powershell
emcc -v
```

## Recommended Next Steps On This Machine

1. Install a current Node LTS release.
2. Keep Visual Studio 2022 C++ tools installed.
3. Install Ninja if you want faster CMake iteration.
4. Install Emscripten only when we are ready to build `packages/rofl-wasm`.
5. Run PowerShell project scripts outside the sandbox when they matter, because this environment has been unreliable for sandboxed `.ps1` execution.

## Vite+

Vite+ is installed on this machine at C:\Users\User\.vite-plus\0.1.11\bin\vp.exe.
If p is not visible inside the sandbox, run it outside the sandbox or call that absolute path directly.
