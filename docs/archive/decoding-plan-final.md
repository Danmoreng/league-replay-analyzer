> Note: this is a historical investigation document. For the current decoder state, start with `docs/decoder-status.md` and `docs/reverse-engineering-index.md`.

# Chunk Subrecord Decoding Plan

## Purpose

This document is the combined working plan for decoding the large decompressed subrecords inside footer-style replay chunk payloads.

It merges:

- the useful exploration strategy from the existing subrecord plan
- the current verified repo findings from `docs/replay-format-notes.md`
- the practical constraints of the current `rofl-core` inspector implementation

The goal is to move from "large opaque binary blobs" to "repeatable, validated record decoders" without hard-coding guesses too early.

## Immediate Recommendation

Focus next on the repeated `53,970`-byte family first.

Do not begin with the `61,917` family unless a new inspect run shows it is equally frequent and easier to isolate.

Reasoning:

- `53,970` already appears repeatedly across adjacent chunks in the checked-in notes
- repeated size plus repeated leading byte make it the best target for comparative analysis
- building the tooling around one stable family will make `61,917`, `64,836`, `47,277`, and `23,526` much cheaper to analyze afterward

## Current Evidence Baseline

These points should be treated as verified facts from the repo as it exists now:

- newer local samples can be parsed through the `rofl2-like-footer` metadata path
- footer-style records can be indexed using the observed `17`-byte header before each zstd frame
- startup, keyframe, and chunk payloads can be decompressed
- later chunk payloads show strong candidate `u16` little-endian framing patterns
- chunk `4` contains large candidate regions including `53,970`, `64,836`, `47,277`, and `23,526`
- chunks `5` and `6` contain many large candidate subrecords clustered around `53,970`
- chunk `6` appears to require a framing start offset of `1`, which may indicate a leading discriminator or wrapper byte

These points are still hypotheses and should not be promoted to "facts" yet:

- that the current `u16` framing candidate is the real packet boundary rule
- that `0xD2` is an opcode rather than simply the first byte of a larger header
- that the `53,970` family is a fixed snapshot packet rather than a nested bundle
- that the same layout is stable across multiple replay versions

## Core Principles

1. Separate verified facts from hypotheses.
2. Extend the current inspector before introducing large new abstractions.
3. Parse with explicit cursor-based readers, not packed struct overlays.
4. Require cross-record evidence before naming fields.
5. Validate every candidate field against replay semantics, not just byte patterns.

## Additional External Guidance

A few durable points from external format research are worth carrying forward into this plan:

- Treat the ROFL2 metadata footer rule as a stable container fact: the final 4 bytes encode the metadata JSON size, while the game version still needs a separate early-file scan.
- If decompressed chunk payloads ever reveal nested zstd framing, test `skippable frame` and `seek-table` hypotheses before inventing a custom wrapper format. Zstd seekable layout is the closest generic analogue to the `footer-style` observations in this repo.
- Prefer machine-readable inspection outputs and deterministic fixture summaries over console-only inspection. Hash-addressed family dumps and JSON summaries are more valuable than one-off terminal transcripts.
- Keep quantitative framing gates explicit: coverage, leftover bytes, failure rate, and boundary consistency should decide whether a framing rule is good enough to build decoders on top of.

These are process constraints, not proof about League payload semantics, so they should guide tooling and validation rather than be treated as decoded format facts.

## What We Need To Learn

For the first large family, we need to determine:

1. whether the current framing hypothesis is real
2. where the subrecord actually begins and ends
3. whether the first bytes are a family marker, header, opcode, or wrapper
4. whether the body is flat, repeated-stride, or nested
5. which fields are sequence or time related
6. which fields may represent entity ids, counts, flags, or coordinates
7. which parts are stable enough to normalize into the shared replay model

## Phase 0: Harden the Inspection Layer

Before decoding structs, improve the extraction and comparison tooling in `rofl-core`.

### Objectives

- make subrecord extraction repeatable
- make family comparison machine-readable
- avoid manual hex inspection as the only workflow

### Implementation targets

Prefer building on the existing helpers in `packages/rofl-core/src/replay_analyzer.cpp` instead of replacing them immediately.

Useful additions:

- extraction of all candidate framed subrecords from a selected chunk
- grouping by `(length, first_byte)`
- grouping by `(length, prefix4)`
- summary counts per chunk and across a replay
- JSON output for family extraction and comparisons
- side-by-side prefix compare output for the first `N` bytes
- byte-stability maps for a chosen family
- visual console stability maps for the first `256` or `512` bytes of a family

### Proposed CLI additions

These are the most useful next commands to add:

- `rofl_core_cli --inspect-subrecords <path>`
- `rofl_core_cli --dump-subrecord-family <path> --length 53970 --first-byte 0xD2`
- `rofl_core_cli --compare-subrecord-family <path> --length 53970 --first-byte 0xD2 --prefix-bytes 256`
- `rofl_core_cli --subrecord-summary-json <path>`
- `rofl_core_cli --guess-stride --length 53970 --header-size 16`

### Stability map output

The family compare command should include a compact visual stability map.

Suggested legend:

- `.` = byte is identical across all compared records
- `+` = byte changes, but only across a small set of values
- `X` = byte is highly variable across the compared records

This should be treated as a fast header/body locator, not as proof of field meaning.

### Why this comes first

The current inspector already has the core pieces:

- best framing candidate search
- framed subrecord extraction
- per-segment inspection output

What is missing is stable family-level output that can drive decoding decisions instead of ad hoc eyeballing.

## Phase 1: Prove or Reject the Framing Hypothesis

The current plan must not assume that the `u16` framing is already proven.

### Checks to perform

- run the extraction logic across more chunks than `4` through `6`
- compare framing candidates at offsets `0` and `1`
- measure coverage, leftover bytes, and break conditions
- verify whether the same family boundaries recur across neighboring chunks
- verify whether the framing length includes or excludes the leading family byte
- test whether a one-byte wrapper before the framed series explains chunk `6`

### Success criteria

We should treat the framing as operationally valid only if:

- the same rule extracts coherent families across several adjacent chunks
- leftover bytes become explainable and small
- repeated families appear at consistent boundaries
- the extracted record counts are stable enough to compare across time

Suggested minimum gates for moving from framing to decoder work:

- coverage ratio is high enough that the unexplained remainder is genuinely small
- leftover bytes cluster into one or two repeatable wrapper/footer patterns rather than random fragmentation
- parser failures stay rare and reproducible
- neighboring chunks reproduce the same family boundaries with only small wrapper variance

### Failure criteria

If framing consistency collapses outside the small current window, struct work pauses and the next step becomes finding a higher-level chunk wrapper.

## Phase 2: Build a Corpus for the `53,970` Family

Once extraction is stable enough, collect every matching `53,970` family record from the replay.

### For each sample, record

- chunk id
- subrecord ordinal within the chunk
- framing start offset
- subrecord offset inside the decompressed chunk
- absolute replay payload offset if useful
- total length
- first `16` bytes in hex
- first `16` bytes interpreted as `u8`, `u16`, and `u32` views

### Initial goals

- confirm how many `53,970` records actually exist
- confirm whether `0xD2` is always the first payload byte for this family
- identify whether there are sub-families within the same size

## Phase 3: Comparative Binary Analysis

This is the most important analysis stage before field naming.

### Analyses to run across the whole family

- byte-by-byte stability map
- longest constant prefix
- longest constant suffix
- entropy profile by window
- offsets with small monotonic deltas
- offsets whose values repeat from record to record
- zero-heavy regions
- likely padding regions

### Candidate field scans

At each offset, inspect plausible interpretations as:

- `u8`
- `u16`
- `u32`
- `u64`
- `i32`
- `float32`

Only keep interpretations that show coherent behavior across multiple records.

League-specific heuristics to apply:

- candidate position-like `float32` values should cluster roughly within `[-5000.0, 20000.0]`
- fields that frequently decode to `NaN`, `inf`, or extreme magnitudes should be rejected as coordinate candidates
- candidate time-like `u32` values should increase monotonically and stay broadly consistent with replay progression

### Signs we are looking for

Likely header-like fields:

- sequence counter
- tick index
- timestamp
- object count
- section length
- checksum or hash-like value
- flags or bitfields

Likely body-like fields:

- repeated fixed-size entries
- nested sections
- coordinate arrays
- network ids
- sparse flag planes

### Time correlation guidance

If a candidate `u32` looks like a tick or timestamp:

- compare its deltas across neighboring records
- compare family-to-family or chunk-to-chunk progression against replay ordering
- use `gameLengthMillis` and chunk counts only as a rough sanity bound, not as an exact clock model

Chunk cadence may not be uniform, so this check is supportive evidence, not a primary proof.

## Phase 4: Internal Layout Heuristics

After identifying stable and changing regions, test how the body is organized.

### Tests

- subtract candidate header sizes such as `4`, `8`, `12`, `16`, `24`, `32`
- factor the remaining body length
- test common entry strides such as `8`, `12`, `16`, `20`, `24`, `32`, `48`, `64`, `96`, `128`
- compare aligned columns under each stride assumption
- search for nested length prefixes inside the body
- search for count fields in the header that match a plausible stride

### Decision rules

Do not accept a stride as real unless:

- it explains most of the body length
- aligned columns behave like stable fields across multiple records
- the same interpretation works on more than one record

### Stride helper utility

Add a small CLI helper that can:

- subtract a proposed header size from a record length
- list integer divisors of the remaining body size
- highlight divisors that fall into plausible struct-size ranges

This is only a prioritization tool. A mathematically convenient divisor is not evidence unless it also matches cross-record field behavior.

## Phase 5: External Cross-Reference

External research is useful, but only after we have local evidence.

### Order of operations

1. extract and compare the family locally
2. identify candidate offsets and field roles
3. then compare those findings against external references

### Good uses of external references

- checking whether a leading byte commonly maps to a known packet family
- checking whether Riot spectator or game packet research describes similar snapshot layouts
- checking whether a guessed entity-update layout resembles known packet families from the same patch era
- checking whether the outer bytes resemble ENet-style wrapper fields, channel markers, or transport framing

### Bad use of external references

- forcing a structure onto the bytes before local evidence supports it
- treating the first byte as a confirmed opcode too early
- importing runtime dependencies or copied parser logic

### ENet awareness

Keep an explicit transport-wrapper hypothesis in mind during this phase.

In particular:

- `0xD2`, `0x5D`, and similar leading bytes may belong to a transport or wrapper layer
- those bytes should not be treated as confirmed game opcodes until we establish the true outer header boundary
- if the first few bytes are stable while later offsets vary more semantically, that may indicate wrapper fields before the actual gameplay payload

## Phase 6: Experimental Decoder Implementation

Once a stable outer layout is identified, implement an experimental parser in `rofl-core`.

### Implementation style

- use explicit bounds-checked reads
- keep field offsets obvious in code
- return structured parse results plus warnings
- preserve unknown regions rather than discarding them
- avoid `reinterpret_cast`, packed structs, or direct memory overlay

### Suggested types

These names are placeholders, not commitments:

- `ExperimentalSubrecordHeader`
- `ExperimentalD2Record`
- `ExperimentalD2Entry`

### Good output shape

Each parsed field should carry:

- offset
- width
- value
- interpretation
- confidence level

This makes it possible to keep "maybe" fields visible without pretending they are final.

## Phase 7: Semantic Validation

A decoded field matters only if it correlates with actual replay behavior.

### Validation checks

- timestamps should advance with chunk order
- counts should stay within believable game-scale ranges
- ids should recur in ways consistent with persistent objects
- coordinate candidates should cluster within playable map bounds
- floats should avoid implausible `NaN` or extreme values
- neighboring records should show smooth movement if they describe tracked entities

For coordinate candidates, prefer fields that:

- repeatedly land in the rough League world range of `[-5000.0, 20000.0]`
- move smoothly across adjacent records
- appear in pairs or triples consistent with 2D or 3D positions

### Strong validation signals

- a field scales with replay time from metadata
- repeated ids can be tracked across neighboring records
- candidate coordinates look like real map motion
- a candidate count aligns with a repeated inner stride

## Phase 8: Expand to Other Families

After the first family is partially decoded, reuse the same tooling on the next large families.

Suggested priority:

1. `64,836`
2. `47,277`
3. `23,526`
4. `61,917` if a new inspection run confirms it as a real recurring family in local samples

The exact order can change if fresh inspection output shows a cleaner target.

## Implementation Roadmap in the Repo

### Likely files to touch

- `packages/rofl-core/src/replay_analyzer.cpp`
- `packages/rofl-core/include/rofl/core/replay_analyzer.hpp`
- `packages/rofl-core/src/cli_main.cpp`
- `packages/rofl-core/tests/smoke_test.cpp`
- `docs/replay-format-notes.md`

### Minimal first milestone

1. add family-level extraction output
2. add JSON summary for extracted families
3. add compare output for one chosen family
4. document verified family counts and offsets in `docs/replay-format-notes.md`

### Second milestone

1. identify the stable outer header for the `53,970` family
2. implement an experimental decoder for that outer header
3. print decoded candidate fields through the CLI
4. add plausibility checks and regression coverage

## Testing Strategy

### Unit and fixture coverage

Add tests for:

- framed subrecord extraction from synthetic buffers
- family grouping behavior
- compare output shape
- out-of-bounds protection in experimental decoders
- parse failures on malformed records

### Real replay validation

Prefer validating new decode work first through the native CLI against:

- `replays/EUW1-7779216102.rofl`
- any future local samples added for cross-version checks

Browser and Wasm validation should come after the native decoding path is stable.

## Documentation Rules

Update `docs/replay-format-notes.md` only with verified findings.

Keep the following items clearly labeled as hypotheses until validated:

- framing rules
- packet family names
- field meanings
- opcode interpretations
- stride assumptions

If an important project-level parsing decision becomes stable, record it near the code and in the docs rather than relying on session history.

## Anti-Patterns To Avoid

- defining packed structs too early
- treating the first byte as a confirmed opcode without cross-record evidence
- assuming one replay version layout applies everywhere
- letting external reference material override contradictory local evidence
- mixing verified facts and guesses in the same notes section
- pushing decode logic into the web app before it is stable in `rofl-core`

## Immediate Next Actions

1. Extend the native CLI to emit family-level subrecord summaries and JSON output.
2. Extract every `53,970` family record from the current replay.
3. Generate a byte-stability map and monotonic-offset scan for that family.
4. Identify the smallest stable outer header candidate.
5. Implement one experimental outer-header decoder only after those steps succeed.

## Definition of Done for This Stage

This stage is complete when we can say, for one large subrecord family:

- where each record begins and ends
- which outer fields are real
- which of those fields are likely time, sequence, count, flags, or ids
- whether the body appears repeated-stride, nested, or mixed
- how confident we are in each claimed field
- what family should be decoded next with the same tooling

## Current Progress & Findings

### Phase 0 Completion
- Implemented extraction tooling: `rofl_core_cli` can now extract family subrecords, dump them, and compare them directly using `--compare-subrecord-family`.
- Generated stability maps for the `53,970` family (starting with `0xD2`) over 581 instances.

### Initial Discovery: The `0xD2` 53,970-byte Family
1. **Not an Opcode:** The `0xD2` byte is strictly repeating. The comparison output showed `3537031890` (`0xD2D2D2D2`) extending deeply into the file across multiple fields in every record instance.
2. **Sparse Padding:** The 53,970 byte block appears to be a large, fixed-size dense memory array padded/initialized with `0xD2` rather than `0x00`. Actual game entity or state data is sparsely scattered into this buffer at specific offsets.
3. **Divisibility:** Assuming a 2-byte header, the remaining `53,968` bytes divide perfectly by `16` (yielding `3,373` elements). This suggests a fixed array of 3,373 elements, possibly representing spatial grid cells, pathing nodes, or basic entity slots.
4. **Next Steps Adjusted:** The immediate next step is to use the comparison tooling to find the "stride length" by calculating offset distances between non-`0xD2` bytes within the array.
