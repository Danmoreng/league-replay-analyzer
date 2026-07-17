# Reverse Engineering Docs Index

Updated: 2026-07-17

This file consolidates the replay reverse-engineering documentation into a smaller set of active references.

## Read These First

1. `docs/decoder-status.md`
   Canonical productive/research status, browser truth boundary, promotion
   rules, missing streams, and next steps.
2. `docs/replay-format-notes.md`
   Container-level findings, stable format notes, and version-sensitive observations.
3. `docs/packet-block-semantic-findings.md`
   Exact champion-kill and elite-objective packet semantics plus unresolved
   building/item correlations.
4. `docs/architecture.md`
   Current C++/Wasm/Vue boundaries and the target normalized pipeline.
5. `docs/riot-api-fixtures.md`
   How Riot fixtures are used strictly as offline supervision.

## Active Working References

- `docs/decoder-development-loop.md`
- `docs/decoder-status.md`
- `docs/packet-block-semantic-findings.md`
- `docs/replay-objective-decoder-validation.md`
- `docs/packet-ward-semantic-findings.md`
- `docs/replay-inventory-packet-research.md`
- `docs/keyframe-champion-state-discovery.md`
- `docs/replay-movement-packet-research.md`
- `docs/rofl-api-parity.md`
- `docs/keyframe-api-parity.md`
- `docs/replay-format-notes.md`
- `docs/riot-api-fixtures.md`
- `docs/test-fixtures.md`
- `docs/architecture.md`

## Historical / Session Docs

These are still useful for provenance, but they should not be treated as the latest status on their own. Archived session and handoff notes now live under `docs/archive/`.

- `docs/archive/ai-analysis-handoff-2026-03-20.md`
- `docs/bitfield-packing-hypothesis.md`
- `docs/signature-clustering-findings.md`
- `docs/archive/session-rofl-movement-handoff.md`
- `docs/archive/session-rofl-movement-investigation-handoff.md`
- `docs/archive/reverse-engineering-findings.md`
- `docs/archive/decoding-plan-final.md`
- `docs/archive/layout-hypothesis.md`

## Consolidation Policy

- Put the latest decoder status in `docs/decoder-status.md`.
- Keep exact corpus evidence and reproduction commands in focused decoder notes.
- Keep `docs/replay-format-notes.md` focused on relatively stable format/container notes.
- Keep one-off hypotheses, AI handoffs, and session logs as historical references instead of rewriting the project state into many places.
- When a historical doc is still valuable but superseded, add a short note pointing back to `docs/decoder-status.md`.
