# Reverse Engineering Docs Index

Updated: 2026-03-21

This file consolidates the replay reverse-engineering documentation into a smaller set of active references.

## Read These First

1. `docs/decoder-status.md`
   Current decoder status, current working model, current tooling, and next steps.
2. `docs/replay-format-notes.md`
   Container-level findings, stable format notes, and version-sensitive observations.
3. `docs/riot-api-fixtures.md`
   How Riot fixtures are used as supervision and where the local test data comes from.
4. `docs/architecture.md`
   High-level project structure.

## Active Working References

- `docs/decoder-development-loop.md`
- `docs/decoder-status.md`
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
- Keep `docs/replay-format-notes.md` focused on relatively stable format/container notes.
- Keep one-off hypotheses, AI handoffs, and session logs as historical references instead of rewriting the project state into many places.
- When a historical doc is still valuable but superseded, add a short note pointing back to `docs/decoder-status.md`.
