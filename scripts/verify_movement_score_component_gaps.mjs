#!/usr/bin/env node

import path from "path";

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    inputPath: null,
    expectedWrongAssignmentCount: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--expected-wrong-assignment-count" && index + 1 < argv.length) {
      args.expectedWrongAssignmentCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/verify_movement_score_component_gaps.mjs [--version-group 16.9] [--input-path <path>] [--expected-wrong-assignment-count <count>]");
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = args.inputPath
    ? resolveAbsolute(root, args.inputPath)
    : path.join(artifactRoot, `movement-score-component-gaps-${args.versionGroup}.json`);
  const summary = readJson(inputPath);

  assertCondition(summary.schema === "movement-score-component-gaps/v1", "schema mismatch");
  assertCondition(summary.versionGroup === args.versionGroup, "version group mismatch");
  assertCondition(summary.mode === "offline-oracle-diagnostic", "mode mismatch");
  assertCondition(summary.runtimeInput === false, "summary must not be runtime input");
  assertCondition(summary.runtimeApiData === false, "summary must not be runtime API data");
  if (args.expectedWrongAssignmentCount != null) {
    assertCondition(summary.statusCounts?.passing_oracle_available_wrong_entity_assigned === args.expectedWrongAssignmentCount, "wrong assignment count mismatch");
  } else {
    assertCondition((summary.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? 0) > 0, "expected wrong assignment count");
  }
  assertCondition((summary.oracleVisibilityCounts?.oracle_visible ?? 0) > 0, "expected at least some visible oracle alternatives");
  assertCondition((summary.oracleVisibilityCounts?.oracle_not_visible_in_recorded_alternatives ?? 0) > 0, "expected some oracle alternatives outside recorded alternatives");
  assertCondition(summary.scoreDeltas?.oracleMinusAssignedScore?.count === summary.oracleVisibilityCounts.oracle_visible, "score delta count mismatch");
  assertCondition((summary.componentDeltas?.roleScore?.count ?? 0) <= summary.oracleVisibilityCounts.oracle_visible, "role component delta count cannot exceed visible oracle count");
  assertCondition((summary.examples ?? []).length > 0, "missing diagnostic examples");

  console.log(`Verified movement score component gap summary: ${inputPath}`);
  console.log(`wrong=${summary.statusCounts.passing_oracle_available_wrong_entity_assigned}, visible=${summary.oracleVisibilityCounts.oracle_visible}, hidden=${summary.oracleVisibilityCounts.oracle_not_visible_in_recorded_alternatives}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
