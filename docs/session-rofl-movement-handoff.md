# ROFL Movement Extraction & Visualization Session

## Session Objective
The goal of this session was to identify, extract, and verify champion movement data from the newer ROFL2 (zstd-compressed) replay format by correlating it with the official Riot Match API timeline.

## Technical Findings

### 1. The "World State" Sparse Table
- **Replay Version**: 16.5.752.7101 (Sample: `EUW1-7779216102.rofl`)
- **Primary Subrecord Family**: 
    - **Length**: 53,970 bytes
    - **Signature Byte**: `0xD2` (Calculated as `length % 256`)
    - **Structure**: A sparse array of 3,373 slots.
    - **Stride**: 16 bytes per slot.
- **Data Layout**: Each 16-byte slot contains four 32-bit "lanes". Preliminary analysis suggests these lanes contain `f32` values representing entity states (X, Y coordinates, rotation, etc.).

### 2. Candidate Discovery
Using the `compare-position-classes` tool, we identified several slot "families" that exhibit champion-like movement:
- **Top Class**: `+0/+12|first=0x71` (9 slots, 98% smooth movement).
- **Secondary Class**: `+0/+8|first=0x00` (11 slots, persistent across match).
- **Coordinates**: Traced slots show `f32` values in the range of `0.0` to `15000.0`, which perfectly matches the Summoner's Rift coordinate system.

## Implementation Progress

### Native Core (`packages/rofl-core`)
- Added `export_positions_json` to `replay_analyzer.cpp`. This function iterates through a specific subrecord family, checks for "active" slots (non-padding), and exports the `f32` values of all 4 lanes into a JSON array.
- Updated `cli_main.cpp` to include the `--export-positions-json` command.

### Web Frontend (`apps/web`)
- **App.vue**: 
    - Integrated `loadMovementData()` to fetch sidecar JSON files.
    - Implemented side-by-side `Minimap.vue` components for visual verification.
    - Added debug logging and status indicators for data loading.
- **Public Assets**:
    - `rofl-positions.json`: Extracted candidates from the replay file.
    - `api-positions.json`: Ground truth extracted from Riot API `timeline.json`.

### Extraction Scripts (`scripts/`)
- `extract-api-positions.mjs`: Parses Riot API timeline data into a simplified position format for the UI.

## Current Status & Issues
- **Encoding Fix**: PowerShell's default output encoding caused `JSON.parse` errors (UTF-16/BOM). This was fixed by using Node.js to write the JSON files in standard UTF-8.
- **Lane Mapping**: While we can extract all four lanes, we have not yet definitively mapped which lane is `X` and which is `Y` for all classes. Some slots use Lane 0/2, others use Lane 4/8.
- **Semantic Linkage**: We have the 10 champions and 10+ movement slots, but they are not yet correlated (e.g., "Slot 1428 is Ahri").

## Handoff: Next Steps for Codex
1. **Dynamic Lane Mapping**: In `App.vue:loadMovementData`, refine the heuristic that selects which lanes to use for X/Y based on which values fall within map bounds (0-15000) and show variance.
2. **Correlation Engine**: Implement a script to calculate the "Path Distance" between every ROFL slot and every API participant. The pairs with the lowest Frechet distance or simple MSE are the semantic matches.
3. **Sparse Bitmasking**: The first byte of the 16-byte slot is often a bitmask (e.g., `0x71`). Investigate if this mask indicates which lanes are currently valid/active to avoid parsing garbage data.
4. **Wasm Exposure**: Move the `export_positions_json` logic into the `rofl-wasm` wrapper so the web UI can extract movement directly from a dropped `.rofl` file without needing the pre-generated sidecar JSONs.
