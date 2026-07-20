# Reverse Engineering Docs Index

Updated: 2026-07-23

This file consolidates the replay reverse-engineering documentation into a smaller set of active references.

## Hard Safety Boundary

Reverse engineering in this repository means analysis of saved `.rofl` files
and patch-versioned packet bytes with the repository's own parser. Saved Riot
fixtures may be used only as offline oracles. Do not execute, inspect,
instrument, patch, or emulate installed League/Riot client or game binaries,
running League/Riot processes, Vanguard, or Vanguard-managed data. Do not
disable or bypass Vanguard. Client-binary RVA or machine-code-emulation paths
are outside scope even when described by historical community work.

## Read These First

1. `docs/decoder-status.md`
   Canonical productive/research status, browser truth boundary, promotion
   rules, missing streams, and next steps.
2. `docs/decoder-profiles.md`
   External profile schema, Native/Wasm interpretation boundary, exact build
   selection, provenance, fail-closed rules, and patch-update limits.
3. `docs/replay-format-notes.md`
   Container-level findings, stable format notes, and version-sensitive observations.
4. `docs/packet-block-semantic-findings.md`
   Exact champion-kill and elite-objective packet semantics plus unresolved
   building/item correlations.
5. `docs/architecture.md`
   Current C++/Wasm/Vue boundaries and the target normalized pipeline.
6. `docs/riot-api-fixtures.md`
   How Riot fixtures are used strictly as offline supervision.

## Active Working References

- `docs/decoder-development-loop.md`
- `docs/decoder-status.md`
- `docs/decoder-profiles.md`
- `docs/packet-block-semantic-findings.md`
- `docs/replay-objective-decoder-validation.md`
- `docs/packet-ward-semantic-findings.md`
- `docs/ward-position-spawn-packet-research.md` (eight replay-only patch-16.9
  visual hypotheses, all explicitly `NOT DECODED`)
- `docs/replay-inventory-packet-research.md` (including the productive,
  exact-build external-profile-only purchase-linked resulting-item and direct
  add-only purchase subsets, the operation-only item-sale stream, their pinned
  static-item-catalog boundary, and their explicit inventory/research
  limitations)
- `scripts/research_inventory_removal_slots_16_14.mjs` (the complete
  seven-value `0x03F9` structural slot candidate, exact slot-6 trinket oracle,
  and explicit non-promotion boundary)
- `docs/keyframe-champion-state-discovery.md` (including the exact-build
  patch-16.14 replay-byte-only `0x01EB` physical record directory: 366
  contiguous records per owner/keyframe, stable cross-index-unique
  `payload[3..end]` directory fingerprint, exact bridge through `0x02EB`,
  partial `0x0306`/`0x027C`/`0x011A` typed-stream skeleton, and explicit
  non-semantic boundary)
- `docs/decoder-status.md` also records the promoted exact-build `0x02EB`
  participant-snapshot grammar: the profile-pinned 256-byte permutation and
  interleaved XP/total-gold/lane-CS Float32LE stripes plus the replay-only
  XP-threshold/final-level-cap derivation. Neutral CS remains research-only.
- `scripts/validate_replay_participant_stat_snapshots_corpus.mjs` and
  `scripts/manifests/replay-participant-stat-snapshots-16.14.expected.json`
  reproduce its compact D7/H3 promotion gate.
- `scripts/research_keyframe_current_gold_16_14.mjs` reproduces the exact-build
  spent-gold-like lane and the negative current-gold correction searches.
- `scripts/research_keyframe_inventory_slots_16_14.mjs` reproduces the exact
  six-record keyframe `0x0081` structure, freezes the `-2..+2` Timeline-state
  alignment audit, separates prior-labelled removals from item identities
  absent in Timeline, and checks later replay operations before rejecting a
  direct current-slot interpretation on D7 and frozen H3. It also freezes
  8,137 D7 plus 4,014 H3 strict active/inactive record labels and rejects every
  one/two-bit affine or contiguous one-to-eight-bit record-local activity rule.
- `scripts/research_inventory_forward_slot_reducer_16_14.mjs` tests the bounded
  cross-product of add-length sets, four removal-nibble sets, duplicate
  handling, trinket protection, and four deterministic add-slot placement
  rules against replay-embedded final slots. Length-11 trinkets and rare
  length-16/17 adds improve the replay-only candidate to 9/70 D7 and 5/30 H3
  exact final slot tracks. A provisional static initial-trinket seed reaches
  10/70 and 6/30 but is explicitly non-promotable. Symbolic placement reaches
  23/70 and 13/30 final anchors while retaining non-unique histories.
- `scripts/research_inventory_add_slot_companions_16_14.mjs` exhausts the
  same-owner `+/-1 ms` packet-family/direct-bit-field search around 181 strict
  add/historical-record anchors; only `0x0369` has complete D7 support and it
  yields no conflict-free record-ordinal lookup.
- `scripts/research_inventory_rearrangement_windows_16_14.mjs` freezes 21
  same-multiset historical-record reorderings and rejects their use as direct
  swap labels through missing operation families and contradictory repeated
  `0x0146` payloads.
- `scripts/research_inventory_backward_reducer_16_14.mjs` starts from embedded
  replay-final seven-slot inventories and reverses expanded symbolic
  add/removal/context histories plus the exact sale-Undo restored-item subset.
  It reaches the beginning for 50/100 tracks, encounters 72/116 sales, and
  uniquely resolves five sale identities with `5 exact / 0 wrong` offline
  validation, but retains thousands of ambiguous slot histories.
- `scripts/research_inventory_undo_component_families.mjs` applies the proven
  item grammar to the 31 exact patch-16.14 Undo anchors and freezes a replay-only
  fresh-sale linkage at 6/6 D7 plus 3/3 H3 restored identities, zero wrong.
- `scripts/research_inventory_timeline_oracle_backward_slots_16_14.mjs` uses
  saved Timeline identities only as an offline diagnostic around replay-final
  slots and `0x03F9` candidate slots. Its exact balance gate proves Timeline
  item events are not a complete slot-pure log, with likely Viego possession
  copies and unmatched system/transformation/consumable events.
- `scripts/research_inventory_gold_adjustments_16_14.mjs` freezes the
  static-recipe/Undo spend-ledger comparison and the incomplete cumulative-sale
  correction for current gold.
- `scripts/research_inventory_sale_identity_16_14.mjs` freezes the six-record
  sale-history candidate constraint, the negative raw removal/record linkage
  searches, and a replay-only 30-second freshness rule that identifies 36/36
  D7 discovery plus 13/13 frozen-H3 sold items with zero wrong identities.
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
- Do not turn historical client-binary, RVA, process, Vanguard, or emulation
  techniques into active reproduction steps; preserve only replay-format context
  that can be tested from saved packet data.
