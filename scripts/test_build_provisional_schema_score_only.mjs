import assert from "node:assert/strict";

import {
  parseArgs,
  projectCandidateMatchesForScoreOnly,
} from "./build_provisional_schema.mjs";

const fullReport = {
  replayId: "EUW1-7921482297",
  generatedAtUtc: "2026-07-19T00:00:00.000Z",
  artifactDir: "C:/scratch/artifact",
  fixtureDir: "C:/scratch/fixture",
  summary: {
    totalMatches: 12,
    rawWindowCount: 2,
    patternCount: 1,
    promotedPatternCount: 0,
  },
  rawWindowCandidates: [
    {
      rawWindowKey: "large-debug-window",
      supportMatches: [{ participantId: 1, effectiveScore: 0.9 }],
    },
  ],
  topMatches: [{ participantId: 1, metricKey: "totalGold", effectiveScore: 0.9 }],
};

const compactReport = projectCandidateMatchesForScoreOnly(fullReport);

assert.deepEqual(fullReport.rawWindowCandidates, [
  {
    rawWindowKey: "large-debug-window",
    supportMatches: [{ participantId: 1, effectiveScore: 0.9 }],
  },
]);
assert.equal("rawWindowCandidates" in compactReport, false);
assert.equal(compactReport.outputMode, "score-only");
assert.deepEqual(compactReport.topMatches, fullReport.topMatches);
assert.deepEqual(compactReport.summary, fullReport.summary);

const compactArgs = parseArgs([
  "node",
  "scripts/build_provisional_schema.mjs",
  "--artifact-dir",
  "tmp/example",
  "--score-only",
]);
assert.equal(compactArgs.scoreOnly, true);

const standardArgs = parseArgs([
  "node",
  "scripts/build_provisional_schema.mjs",
  "--artifact-dir",
  "tmp/example",
]);
assert.equal(standardArgs.scoreOnly, false);

console.log("build_provisional_schema score-only projection test passed");
