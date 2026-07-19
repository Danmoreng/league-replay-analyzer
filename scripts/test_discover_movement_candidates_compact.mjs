#!/usr/bin/env node

import assert from "node:assert/strict";

import { buildMovementOutputDocuments } from "./discover_movement_candidates.mjs";

const rankedPatterns = Array.from({ length: 40 }, (_, index) => ({
  patternKey: `pattern-${index}`,
  familyKey: "fixture-family",
}));
const allMatches = Array.from({ length: 5 }, (_, index) => ({
  participantId: index + 1,
  effectiveScore: 1 - (index / 10),
}));
const rawPairCandidates = Array.from({ length: 48 }, (_, index) => ({
  rawPairKey: `raw-${index}`,
  supportMatches: [{ participantId: 1 }],
}));

const compact = buildMovementOutputDocuments({
  replayId: "fixture-replay",
  artifactDir: "/fixture/artifact",
  fixtureDir: "/fixture/api",
  familyCount: 1,
  coordinateModelPath: null,
  allMatches,
  rawPairCandidates,
  rankedPatterns,
  promotedPatterns: [],
  topMatches: 3,
  compactScoreOnly: true,
});

assert.equal(compact.candidateMatchesReport.schema, "rofl-movement-candidate-matches-compact/v1");
assert.equal(compact.candidateMatchesReport.outputMode, "compact-score-only");
assert.equal(compact.candidateMatchesReport.rawPairCandidatesAvailable, false);
assert.equal(Object.hasOwn(compact.candidateMatchesReport, "rawPairCandidates"), false);
assert.equal(compact.candidateMatchesReport.topMatches.length, 3);
assert.equal(compact.provisionalSchema.source.outputMode, "compact-score-only");
assert.equal(compact.provisionalSchema.rankedPatterns.length, 40);

const standard = buildMovementOutputDocuments({
  replayId: "fixture-replay",
  artifactDir: "/fixture/artifact",
  fixtureDir: "/fixture/api",
  familyCount: 1,
  coordinateModelPath: null,
  allMatches,
  rawPairCandidates,
  rankedPatterns,
  promotedPatterns: [],
  topMatches: 3,
  compactScoreOnly: false,
});

assert.equal(Object.hasOwn(standard.candidateMatchesReport, "schema"), false);
assert.deepEqual(standard.candidateMatchesReport.rawPairCandidates, rawPairCandidates);
assert.equal(standard.provisionalSchema.rankedPatterns.length, 40);

console.log("compact movement candidate output boundary tests passed");
