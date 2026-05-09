#!/usr/bin/env node

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    inputPath: "artifacts-keyframes/movement-hidden-oracle-sources-16.9.json",
    versionGroup: "16.9",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_movement_hidden_oracle_sources.mjs [--input-path artifacts-keyframes/movement-hidden-oracle-sources-16.9.json] [--version-group 16.9]");
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
  assert(summary.schema === "movement-hidden-oracle-sources/v1", "Unexpected hidden-oracle schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected version group", summary.versionGroup);
  assert(summary.runtimeInput === false && summary.runtimeApiData === false, "Hidden-oracle summary must be offline-only", summary);
  assert((summary.totals?.hiddenCount ?? 0) > 0, "Hidden-oracle summary should expose hidden validation-passing oracle candidates", summary.totals);
  assert(Object.keys(summary.totals?.hiddenReasonCounts ?? {}).length > 0, "Hidden-oracle summary must include reason counts", summary.totals);
  assert((summary.examples ?? []).length > 0, "Hidden-oracle summary must include examples");
  console.log(`Verified movement hidden-oracle source summary: ${inputPath}`);
  console.log(`hidden=${summary.totals.hiddenCount}`);
}

main();
