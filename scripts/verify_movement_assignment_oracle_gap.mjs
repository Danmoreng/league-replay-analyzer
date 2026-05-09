#!/usr/bin/env node

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    inputPath: "artifacts-keyframes/movement-assignment-oracle-gap-16.9.json",
    versionGroup: "16.9",
    expectedReplayCount: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_movement_assignment_oracle_gap.mjs [--input-path artifacts-keyframes/movement-assignment-oracle-gap-16.9.json] [--version-group 16.9] [--expected-replay-count 20]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = resolveAbsolute(process.cwd(), args.inputPath);
  const summary = readJson(inputPath);
  assert(summary.schema === "movement-assignment-oracle-gap-summary/v1", "Unexpected assignment/oracle gap schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected version group", summary.versionGroup);
  assert(summary.runtimeInput === false && summary.runtimeApiData === false, "Assignment/oracle gap must be marked offline-only", summary);
  assert(summary.replayCount === args.expectedReplayCount && summary.presentReplayCount === args.expectedReplayCount, "Unexpected replay count", summary);
  assert(summary.totals?.expectedParticipantCount === args.expectedReplayCount * 10, "Unexpected participant count", summary.totals);
  assert((summary.totals?.passingOracleCount ?? 0) > (summary.totals?.passingAssignedCount ?? 0), "Oracle should expose assignment headroom", summary.totals);
  assert((summary.totals?.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? 0) > 0, "Gap summary should expose wrong-entity assignments", summary.totals);
  assert((summary.totals?.statusCounts?.passing_oracle_unassigned ?? 0) > 0, "Gap summary should expose unassigned passing oracle candidates", summary.totals);
  const wrongEntityCount = summary.totals?.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? 0;
  const wrongShapeCounts = summary.totals?.wrongEntityBreakdown?.shapeCounts ?? {};
  const wrongShapeTotal = Object.values(wrongShapeCounts).reduce((sum, value) => sum + value, 0);
  assert(wrongShapeTotal === wrongEntityCount, "Wrong-entity shape counts must sum to wrong-entity count", {
    wrongEntityCount,
    wrongShapeCounts,
  });
  assert((wrongShapeCounts.different_family ?? 0) > (wrongShapeCounts.same_family_slot_group ?? 0), "Wrong-entity breakdown should expose cross-family identity confusion", summary.totals?.wrongEntityBreakdown);
  assert(Object.keys(summary.totals?.wrongEntityBreakdown?.topAssignedToOracleFamilyPairs ?? {}).length > 0, "Wrong-entity breakdown must include assigned/oracle family pairs", summary.totals?.wrongEntityBreakdown);
  assert(Object.keys(summary.totals?.wrongEntityBreakdown?.oracleReplayOnlyRankBuckets ?? {}).length > 0, "Wrong-entity breakdown must include oracle replay-only rank buckets", summary.totals?.wrongEntityBreakdown);
  assert(Object.keys(summary.totals?.wrongEntityBreakdown?.unassignedOracleReplayOnlyRankBuckets ?? {}).length > 0, "Wrong-entity breakdown must include unassigned oracle replay-only rank buckets", summary.totals?.wrongEntityBreakdown);
  assert(Object.keys(summary.totals?.wrongEntityBreakdown?.oracleReplayOnlyScoreGapBuckets ?? {}).length > 0, "Wrong-entity breakdown must include oracle replay-only score gap buckets", summary.totals?.wrongEntityBreakdown);
  assert(Object.keys(summary.totals?.wrongEntityBreakdown?.scalarProximityBuckets ?? {}).length > 0, "Wrong-entity breakdown must include scalar proximity buckets", summary.totals?.wrongEntityBreakdown);
  assert(Number.isFinite(summary.totals?.wrongEntityBreakdown?.assignedPassScoreComponents?.teamScore?.average) &&
    Number.isFinite(summary.totals?.wrongEntityBreakdown?.wrongEntityScoreComponents?.teamScore?.average),
    "Wrong-entity breakdown must include assigned-pass and wrong-entity score component summaries", summary.totals?.wrongEntityBreakdown);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).length === 10), "Every replay must account for 10 participants", summary.replays);
  console.log(`Verified movement assignment/oracle gap summary: ${inputPath}`);
  console.log(`assigned=${summary.totals.assignedCount}, assignedPassing=${summary.totals.passingAssignedCount}, oraclePassing=${summary.totals.passingOracleCount}`);
}

main();
