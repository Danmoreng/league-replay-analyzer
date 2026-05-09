#!/usr/bin/env node

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    inputPath: "artifacts-keyframes/movement-candidate-to-extracted-oracle-comparison-16.9.json",
    versionGroup: "16.9",
    expectedReplayCount: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_movement_candidate_to_extracted_oracle.mjs [--input-path <path>] [--version-group 16.9] [--expected-replay-count 20]");
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
  assert(summary.schema === "movement-candidate-to-extracted-oracle-comparison/v1", "Unexpected candidate/extracted comparison schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected version group", summary.versionGroup);
  assert(summary.runtimeInput === false && summary.runtimeApiData === false, "Comparison must be marked non-runtime", summary);
  assert(summary.replayCount === args.expectedReplayCount && summary.presentReplayCount === args.expectedReplayCount, "Unexpected replay count", summary);
  assert(summary.totals?.expectedParticipantCount === args.expectedReplayCount * 10, "Unexpected participant count", summary.totals);
  assert((summary.totals?.lostCandidatePassCount ?? 0) > 0, "Comparison should expose candidate-match passes lost before extraction", summary.totals);
  assert(Object.keys(summary.totals?.lostCandidatePassByFamily ?? {}).length > 0, "Comparison should expose lost pass families", summary.totals);
  assert(Object.keys(summary.totals?.lostCandidatePassByReason ?? {}).length > 0, "Comparison should expose lost pass reasons", summary.totals);
  assert((summary.totals?.lostCandidatePassByReason?.discovered_raw_pair_omitted_from_truncated_schema ?? 0) > 0, "Comparison should distinguish discovered raw pairs omitted from truncated schema", summary.totals);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).length === 10), "Every replay must account for 10 participants", summary.replays);
  assert((summary.replays ?? []).every((replay) => (replay.participants ?? []).every((participant) =>
    participant.status !== "lost_candidate_pass" || typeof participant.lostReason === "string"
  )), "Every lost candidate pass must include a reason", summary.replays);
  console.log(`Verified movement candidate/extracted oracle comparison: ${inputPath}`);
  console.log(`lost candidate-match passes=${summary.totals.lostCandidatePassCount}`);
}

main();
