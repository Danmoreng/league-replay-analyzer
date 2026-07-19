# Linux Setup

The native parser, tests, web app, and Emscripten/Wasm bridge can be built on
Linux. The Linux scripts are separate from the Windows PowerShell scripts so
both environments can use the same source tree after their branches merge.

## Required tools

- CMake 3.26 or newer
- a C++20 compiler such as GCC or Clang
- Ninja (recommended) or Make
- Vite+ (`vp`), which manages the Node.js/npm versions pinned by the project
- Git

On a current Ubuntu release, the system packages cover the native toolchain:

```bash
sudo apt update
sudo apt install build-essential cmake git ninja-build openssh-client
```

Install the Vite+ CLI using its official Linux installer, then open a new shell:

```bash
curl -fsSL https://vite.plus | bash
```

Install the repository's JavaScript dependencies from the repository root.
Using `vp` matters here because the project has Vite+/Vitest npm aliases and a
pinned package-manager version:

```bash
vp install --frozen-lockfile
```

## Native parser

Build the CLI and run its smoke test:

```bash
./scripts/build-native.sh --configuration Debug --run-smoke-test
```

Build and run the complete native C++ test suite:

```bash
./scripts/test-native.sh --configuration Debug
```

The default Linux build directory is `build-linux`. The equivalent npm wrappers
are `npm run build:native:linux` and `npm run test:native:linux`.

Run the CLI against a local replay:

```bash
./build-linux/packages/rofl-core/rofl_core_cli \
  --summary ./replays/EUW1-7779216102.rofl
```

Both scripts accept `--clean`, `--build-dir`, `--configuration`, and
`--generator`. Run either script with `--help` for all options.

## Web app

The Vite+ project is scoped to `apps/web`. Use the root wrappers:

```bash
npm run check:web
npm run test:web
npm run typecheck:web
npm run build:web
```

Start the development server with:

```bash
npm run dev:web
```

## Emscripten and Wasm

Emscripten is optional for native work but required to regenerate the browser
module. A repo-local SDK under `tools/emsdk` remains ignored by Git:

```bash
git clone https://github.com/emscripten-core/emsdk.git tools/emsdk
./tools/emsdk/emsdk install 6.0.3
./tools/emsdk/emsdk activate 6.0.3
./scripts/build-wasm.sh --configuration Release
```

`build-wasm.sh` loads `tools/emsdk/emsdk_env.sh` automatically when it exists.
It publishes `rofl_wasm.js` and `rofl_wasm.wasm` into
`apps/web/src/generated/wasm` by default. Use `--no-publish` for a build-only
check or `--emsdk-root` for an SDK installed elsewhere.

The equivalent npm wrapper is:

```bash
npm run build:wasm:linux
```

The Linux Wasm path is verified with emsdk 6.0.3 and CMake 4.2.3. Emscripten
warns that this CMake release does not support Emscripten shared libraries;
this project forces static libraries, and the `rofl_wasm` build and web
contract tests pass under that combination.

## Copy local replay files from Windows

Replay files are local fixtures and `replays/` is ignored by Git. Do not commit
or push private replay corpora as part of Linux setup.

For a network transfer, first ensure Ubuntu is running an SSH server (for
example, `sudo apt install openssh-server`). Then stage the files on Ubuntu.
From Windows PowerShell, with the Ubuntu host reachable:

```powershell
$Source = 'C:\Development\league-replay-analyzer\replays'
$Destination = 'sebastian@ubuntu-host:league-replays-transfer/'
ssh sebastian@ubuntu-host 'mkdir -p league-replays-transfer'
Get-ChildItem -LiteralPath $Source -Filter '*.rofl' -File | ForEach-Object {
    scp -p $_.FullName $Destination
}
```

Then import them from the staging directory on Ubuntu:

```bash
./scripts/import-replays.sh --source "$HOME/league-replays-transfer" --dry-run
./scripts/import-replays.sh --source "$HOME/league-replays-transfer"
```

The importer copies only `.rofl` files, skips identical files, and refuses to
overwrite a different same-named replay unless `--overwrite` is explicit.

If the Windows filesystem or an external drive is mounted directly, skip the
network staging step and pass that mounted replay directory to `--source`.
For example, under WSL-style mounts:

```bash
./scripts/import-replays.sh \
  --source /mnt/c/Development/league-replay-analyzer/replays \
  --dry-run
```

For an independent transfer check, compare `Get-FileHash -Algorithm SHA256` on
Windows with `sha256sum replays/*.rofl` on Ubuntu.
