> Note: this is a historical investigation document. For the current decoder state, start with `docs/decoder-status.md` and `docs/reverse-engineering-index.md`.

# ROFL Movement Investigation Handoff - March 16, 2026

## Session Goal
Continue the ROFL champion-movement reverse engineering work after the earlier sparse-table export experiments failed to line up with Riot API movement.

This session focused on three questions:
- Are we missing the right subrecord family entirely?
- Does event-local matching work better than whole-path matching?
- Does comparing all raw sparse-family records, instead of chunk medians, reveal a hidden movement track?

## Replay / Fixture Used
- Replay: `replays/EUW1-7779216102.rofl`
- Riot timeline fixture: `apps/web/public/riot-api-fixtures/EUW1_7779216102/timeline.json`
- Simplified API positions: `apps/web/public/api-positions.json`
- Patch family under investigation: replay version `16.5.752.7101`

## Code Added This Session
Changes are currently local and uncommitted in:
- `packages/rofl-core/include/rofl/core/replay_analyzer.hpp`
- `packages/rofl-core/src/cli_main.cpp`
- `packages/rofl-core/src/replay_analyzer.cpp`

New native CLI commands added:
- `--summarize-subrecord-families`
- `--match-event-window`
- `--compare-raw-positions-with-api`

All three commands compiled successfully in Debug via `scripts/build-native.ps1`.

## What We Tried

### 1. Ranked recurring subrecord families across the replay
Added `--summarize-subrecord-families` to scan all zstd chunk payloads, group framed subrecords by `(length, first byte)`, and rank families by recurrence across chunks.

Result:
- Dominant family: `len=53970`, `first=0xD2`, `records=567` in the earlier run, later `581` after broader extraction checks
- Appears across `62` chunks
- Clean 16-byte partition candidate: `h2=3373`
- Still the strongest world-state candidate by far

Secondary family:
- `len=53974`, `first=0xD2`
- Only `23` records across `16` chunks in the earlier scan
- Clean 16-byte sibling candidate: `h6=3373`

Negative findings:
- No nearby family emerged as an obviously better champion-movement source than `53970 / 0xD2`
- Another recurring family around `39064 / 0x98` produced no useful position-like candidates

Interpretation:
- The main issue is probably decoding or semantic interpretation, not failure to locate the main world-state family.

### 2. Re-tested chunk-collapsed ROFL/API path matching
The earlier `--compare-positions-with-api` flow compared one collapsed point per chunk against API movement.

Best earlier result on the main family was still poor:
- Example best match: `slot 1107`, pair `+0/+4`, `participant 2`
- `RMSE 8125.48`
- `mean distance 7404.47`
- `overlap 38/38`

Interpretation:
- This is far too poor to be real champion path recovery.

### 3. Focused on small replay windows around known Riot events
Added `--match-event-window` to score raw coordinate-like samples in a narrow chunk window around one known Riot event.

This was done to avoid the chunk-collapse problem and to test whether event anchoring can identify moving entities.

Example event anchors from the Riot timeline:
- `167816 ms`, `CHAMPION_KILL`, `(12645, 1897)`
- `202778 ms`, `CHAMPION_KILL`, `(3429, 13064)`
- `202945 ms`, `CHAMPION_KILL`, `(9925, 7647)`
- `210507 ms`, `CHAMPION_KILL`, `(9540, 7888)`
- `230423 ms`, `CHAMPION_KILL`, `(1995, 12464)`
- `597508 ms`, `ELITE_MONSTER_KILL`, `(4766, 10157)`

Key event-window findings on `53970 / 0xD2 / h2 / stride16`:
- First kill `(12645, 1897)`:
  - best candidate `slot 341`, pair `+0/+12`
  - best distance `786.09`
  - only one hit inside `1000`
- Top-lane kill `(3429, 13064)`:
  - best candidate `slot 513`, pair `+0/+12`
  - best distance `374.89`
- Another top-lane kill `(1995, 12464)`:
  - best candidate `slot 513`, pair `+0/+12`
  - best distance `1181.41`
- Objective test `(4766, 10157)`:
  - best distance stayed around `2051.82`
  - no convincing repeated hits

Most important event-local observation:
- `slot 513 / +0/+12` repeated for two top-side kill windows
- its best coordinate was effectively the same both times: about `(3072.01, 12949.56)`

Interpretation:
- This looks like a static or semi-static regional map anchor, not a champion path.
- Event-local scanning is useful, but it currently surfaces map-space anchors more than moving entities.

### 4. Compared all raw sparse-family records against the API, not chunk medians
Added `--compare-raw-positions-with-api`.

This command:
- extracts every raw coordinate-like sparse sample for each candidate slot/pair
- assigns pseudo-timestamps within each chunk using per-record order
- compares against interpolated Riot API movement
- also fits affine transforms to test the coordinate-warp hypothesis:
  - `x' = a*x + b`
  - `y' = c*y + d`

This was specifically added because the median-per-chunk approach might have been hiding a real signal.

#### Main-family run with top 80 internal candidates
Command shape:
```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --compare-raw-positions-with-api .\replays\EUW1-7779216102.rofl .\apps\web\public\api-positions.json --length 53970 --first-byte 0xD2 --header-size 2 --stride 16 --top-slots 80 --move-epsilon 25 --smooth-threshold 800 --chunk-time-ms 30000 --chunk-base-id 5 --max-time-offsets 5
```

Result summary:
- `581` records of size `53970`
- `14004` candidate slot/pair profiles
- `80` candidate tracks compared
- `8800` candidate/API comparisons

Best match from that run:
- `slot 251`, pair `+0/+12`, `participant 8`, `offset +30000 ms`
- direct match: `identityRmse 12350.95`
- affine fit: `affineRmse 2097.75`
- fitted transform:
  - `x = 0.06 * raw + 8795.22`
  - `y = -0.14 * raw + 8534.65`

Interpretation:
- Direct matching is still extremely bad.
- The affine drop looks large, but the fitted slopes are already suspiciously close to a degenerate constant-position fit.

#### Widened raw scan to top 2000 candidates
This was done to test whether the internal ranking was simply missing a weaker but real movement slot.

Best result in that run:
- `slot 1785`, pair `+8/+12`, `participant 8`, `offset +30000 ms`
- `identityRmse 12308.03`
- `affineRmse 1935.20`
- fitted transform:
  - `x = -0.05 * raw + 8768.37`
  - `y = 1.12 * raw + 8437.29`

Interpretation:
- Still not plausible champion movement.
- Slopes/intercepts are unstable across candidates and do not converge on a consistent map transform.

#### Full-family raw scan over all 14,004 candidates
This was the decisive pass.

Result summary:
- `14004` candidate tracks with raw coordinates
- `1,540,440` candidate/API comparisons

Best full-family match:
- `slot 998`, pair `+0/+4`, `participant 8`, `offset +30000 ms`
- `identityRmse 12260.76`
- `affineRmse 1768.20`
- fitted transform:
  - `x = -0.36 * raw + 8748.39`
  - `y = -0.29 * raw + 8500.62`

Representative top-fit transforms from the same run:
- `x = 0.14 * raw + 8678.09`, `y = 0.11 * raw + 8271.67`
- `x = 0.25 * raw + 8933.05`, `y = -5.79 * raw + 8598.20`
- `x = -7.77 * raw + 7329.84`, `y = -0.85 * raw + 7134.30`
- `x = 18.46 * raw + 8729.87` on one axis for another top candidate
- several top candidates had `moving` ratios near `0.00`

Interpretation:
- Using all individual raw records did **not** reveal a hidden good path.
- The median-per-chunk collapse was **not** the main reason the earlier approach failed.
- The affine-warp improvement is mostly degenerate fitting of weakly moving or static anchors onto a participant's average position.
- If ROFL coordinates were simply API coordinates in another scale or offset, the best transforms should have looked consistent across candidates. They did not.

### 5. Re-tested the sibling family with raw comparison
Run on `53974 / 0xD2 / header 6 / stride 16`:
- only `19` raw records survived the current extraction path
- no candidate tracks survived raw coordinate extraction

Interpretation:
- The sibling family is not currently a promising movement source.

## What We Found
- The dominant sparse-family candidate is still `53970 / 0xD2 / header 2 / stride 16 / 3373 slots`.
- Event-local matching can find map-space anchors near real API events.
- Some slots appear to correspond to meaningful static or regional positions on the map.
- Raw-record comparison did not rescue the movement hypothesis for the current float-lane decode.
- A simple affine warp does not explain the mismatch.

## What We Did Not Find
- No convincing champion movement track recovered from the current float-lane interpretation.
- No alternate recurring family that clearly outperforms `53970 / 0xD2`.
- No stable transform showing that ROFL positions are merely scaled or shifted API coordinates.
- No event-window candidate with repeated dense hits that looks like a true moving participant.

## Current Best Interpretation
The replay likely still contains map-space state related to world positions, but the current decoding model is incomplete.

The present extraction probably mixes several kinds of state inside the same sparse family, such as:
- static anchors
- object or region references
- non-position scalar state
- possible position data in a different numeric representation than raw `float,float`

The most likely failure mode now is semantic decoding, not family discovery.

## Recommended Next Steps
Most promising next investigations:
1. Test alternate numeric interpretations per lane instead of assuming `f32` pairs only.
   - signed `i32`
   - unsigned `u32`
   - fixed-point transforms
   - split `i16x2` or `u16x2`
   - mixed lane semantics such as `position + state/id`
2. Use event windows with motion filters.
   - keep only slots that land near the event location and also move plausibly before and after the event
   - reject candidates that are too stationary across repeated events
3. Compare adjacent records structurally.
   - inspect slot deltas across consecutive records inside the same chunk
   - look for lanes whose changes correlate with expected motion continuity
4. Investigate first-byte / mask semantics more deeply.
   - current raw comparisons show many top candidates with masks like `1111`
   - the first byte may still encode entity/component state and validity, not just noise
5. Consider whether chunk timing itself is still wrong.
   - current raw comparer uses pseudo-times based on record order inside a chunk
   - if subrecords encode a more explicit internal time or sequence number, that would improve comparison quality

## Suggested Commit Scope
A checkpoint commit is reasonable.

Recommended to commit:
- the three C++ files containing the new native investigation tooling
- this handoff document

Recommended not to commit:
- `chunk_24_subrecords.txt`
- `chunk_65_subrecords.txt`
- `chunk_6_subrecords.txt`
- `scripts/temp-compare-chunks.mjs`

Rationale:
- The new CLI tools are useful and compile successfully.
- Even though the results are negative, they rule out several plausible hypotheses and save time next session.
- The scratch files are one-off artifacts, not durable tooling.

## Verification Performed
Built successfully:
```powershell
& "C:\Program Files\PowerShell\7\pwsh.exe" -File .\scripts\build-native.ps1 -Configuration Debug -Target rofl_core_cli
```

Core successful runs:
```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --summarize-subrecord-families .\replays\EUW1-7779216102.rofl --min-length 256 --min-records 4 --top-families 20
```

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --match-event-window .\replays\EUW1-7779216102.rofl --length 53970 --first-byte 0xD2 --header-size 2 --stride 16 --event-x 3429 --event-y 13064 --timestamp-ms 202778 --chunk-time-ms 30000 --chunk-base-id 5 --chunk-radius 1 --top-slots 20
```

```powershell
.\build\packages\rofl-core\Debug\rofl_core_cli.exe --compare-raw-positions-with-api .\replays\EUW1-7779216102.rofl .\apps\web\public\api-positions.json --length 53970 --first-byte 0xD2 --header-size 2 --stride 16 --top-slots 20000 --move-epsilon 25 --smooth-threshold 800 --chunk-time-ms 30000 --chunk-base-id 5 --max-time-offsets 5
```

## Bottom Line
The raw-record scan was worth doing and answered the main open question from this session:
- comparing all individual sparse-family records does **not** uncover a clean champion path under the current float-pair model
- the affine warp hypothesis does **not** currently look like the explanation
- tomorrow's work should shift from more brute-force float matching toward better decoding of lane semantics and record structure
