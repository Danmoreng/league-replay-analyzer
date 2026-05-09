#!/usr/bin/env node

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    inputPath: "artifacts-keyframes/movement-candidate-failure-sources-16.9.json",
    versionGroup: "16.9",
    expectedReplayCount: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_movement_candidate_failure_sources.mjs [--input-path <path>] [--version-group 16.9] [--expected-replay-count 20]");
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
  assert(summary.schema === "movement-candidate-failure-sources/v1", "Unexpected movement candidate failure schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected movement candidate failure version group", summary.versionGroup);
  assert(summary.runtimeInput === false && summary.runtimeApiData === false, "Movement candidate failure summary must be non-runtime", {
    runtimeInput: summary.runtimeInput,
    runtimeApiData: summary.runtimeApiData,
  });
  assert(summary.replayCount === args.expectedReplayCount && summary.presentReplayCount === args.expectedReplayCount, "Unexpected replay count", {
    replayCount: summary.replayCount,
    presentReplayCount: summary.presentReplayCount,
  });
  assert(summary.totals?.expectedParticipantCount === args.expectedReplayCount * 10, "Unexpected expected participant count", summary.totals);
  assert(summary.totals?.passingParticipantCount > 0 && summary.totals?.passingParticipantCount < summary.totals?.expectedParticipantCount, "Candidate-match pass count should be partial", summary.totals);
  assert((summary.totals?.failureByModelSource?.none ?? 0) > 0, "Failure sources should expose unsupported coordinate model candidates", summary.totals?.failureByModelSource);
  assert(Object.keys(summary.totals?.topFailureFamilies ?? {}).length > 0, "Failure sources should expose top failing families", summary.totals?.topFailureFamilies);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).length === 10), "Every replay must account for 10 participants", summary.replays);
  console.log(`Verified movement candidate failure sources: ${inputPath}`);
  console.log(`candidate-match passing participants=${summary.totals.passingParticipantCount}/${summary.totals.expectedParticipantCount}`);
}

main();
