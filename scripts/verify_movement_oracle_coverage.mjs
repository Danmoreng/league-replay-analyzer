#!/usr/bin/env node

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    inputPath: "artifacts-keyframes/movement-oracle-coverage-summary-16.9.json",
    versionGroup: "16.9",
    expectedReplayCount: 20,
    expectedPassing: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--expected-passing" && index + 1 < argv.length) args.expectedPassing = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_movement_oracle_coverage.mjs [--input-path <path>] [--version-group 16.9] [--expected-replay-count 20] [--expected-passing <count>]");
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
  assert(summary.schema === "movement-oracle-coverage-summary/v1", "Unexpected movement oracle summary schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected movement oracle version group", summary.versionGroup);
  assert(summary.runtimeInput === false && summary.runtimeApiData === false, "Movement oracle summary must be marked non-runtime", {
    runtimeInput: summary.runtimeInput,
    runtimeApiData: summary.runtimeApiData,
  });
  assert(summary.replayCount === args.expectedReplayCount && summary.presentReplayCount === args.expectedReplayCount, "Unexpected movement oracle replay count", {
    replayCount: summary.replayCount,
    presentReplayCount: summary.presentReplayCount,
  });
  assert(summary.totals?.expectedParticipantCount === args.expectedReplayCount * 10, "Movement oracle expected participant count mismatch", summary.totals);
  assert(summary.totals?.passingOracleParticipantCount > 0, "Movement oracle should find at least some validation-passing candidates", summary.totals);
  if (args.expectedPassing != null) {
    assert(summary.totals?.passingOracleParticipantCount === args.expectedPassing, "Unexpected movement oracle passing participant count", {
      expected: args.expectedPassing,
      actual: summary.totals?.passingOracleParticipantCount,
    });
  }
  assert(summary.totals?.passingOracleParticipantCount < summary.totals?.expectedParticipantCount, "Movement oracle unexpectedly covers every participant; promotion gate needs review", summary.totals);
  assert(summary.totals?.failingOracleParticipantCount === summary.totals.expectedParticipantCount - summary.totals.passingOracleParticipantCount, "Movement oracle failing participant count mismatch", summary.totals);
  assert(summary.totals?.completeOracleReplayCount < summary.presentReplayCount, "Movement oracle unexpectedly has complete coverage for every replay; promotion gate needs review", summary.totals);
  assert((summary.totals?.oracleFailureReasons?.["rmse_above_0.18"] ?? 0) > 0, "Movement oracle should expose high-RMSE failures", summary.totals?.oracleFailureReasons);
  assert((summary.totals?.oracleFailureReasons?.["axis_below_0.55"] ?? 0) > 0, "Movement oracle should expose low-axis-correlation failures", summary.totals?.oracleFailureReasons);
  assert(Object.keys(summary.totals?.topFailingOracleFamilies ?? {}).length > 0, "Movement oracle should expose failing candidate families", summary.totals?.topFailingOracleFamilies);
  assert((summary.replays ?? []).every((replay) => replay.runtimeInput === false && replay.runtimeApiData === false), "Every replay oracle row must be marked non-runtime", summary.replays);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).length === 10), "Every oracle replay must account for 10 participants", summary.replays);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).every((participant) =>
    participant.hasPassingOracleCandidate === true || (participant.oracleFailureReasons ?? []).length > 0
  )), "Every non-passing oracle participant must include failure reasons", summary.replays);

  console.log(`Verified movement oracle coverage summary: ${inputPath}`);
  console.log(`oracle passing participants=${summary.totals.passingOracleParticipantCount}/${summary.totals.expectedParticipantCount}, complete=${summary.totals.completeOracleReplayCount}`);
}

main();
