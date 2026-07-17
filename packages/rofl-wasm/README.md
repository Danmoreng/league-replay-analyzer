# rofl-wasm

Browser-facing WebAssembly bridge for the shared replay parser core.

The exported replay-only APIs currently cover:

- replay metadata and final participant summaries
- champion-kill events
- elite-objective events
- ward placements and conservative ward kills
- packet-family research analyzers

Run `scripts/build-wasm.ps1` from the repository root to build the module and
publish `rofl_wasm.js` and `rofl_wasm.wasm` into the web app.

The web contract suite builds a small zstd ROFL in memory and crosses the real
generated ward ABI, including the unsupported-version JSON error boundary.
C++ exception handling is therefore enabled for the core and Wasm wrapper.
