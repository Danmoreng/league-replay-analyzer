# Architecture Notes

## Intended Shape

This repo is structured for a local-first web application with a shared replay core:

- `packages/rofl-core` owns replay parsing, normalization, and native tooling
- `packages/rofl-wasm` will expose the parser core to the browser
- `apps/web` owns timeline UI, rendering, and local storage

## Near-Term Priorities

1. Define replay container parsing and version detection.
2. Normalize extracted data before it reaches the UI.
3. Build parser tests around replay fixtures from different patch eras.
4. Keep the Wasm boundary narrow and data-oriented.

## Data Flow

The intended long-term flow is:

1. user drops a `.rofl` file in the browser
2. a worker loads the Wasm parser
3. the parser returns normalized match data
4. Vue state drives the 2D renderer and side panels

Until the Wasm bridge exists, native C++ targets should be the primary place to validate parser behavior.
