#!/usr/bin/env node

import path from "path";

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    inputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
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
  console.log("Usage: node ./scripts/verify_movement_identity_signal_candidates.mjs [--version-group 16.9]");
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
    : path.join(artifactRoot, `movement-identity-signal-candidates-${args.versionGroup}.json`);
  const summary = readJson(inputPath);

  assertCondition(summary.schema === "movement-identity-signal-candidates/v1", "schema mismatch");
  assertCondition(summary.versionGroup === args.versionGroup, "version group mismatch");
  assertCondition(summary.mode === "offline-oracle-diagnostic", "mode mismatch");
  assertCondition(summary.runtimeInput === false, "summary must not be runtime input");
  assertCondition(summary.runtimeApiData === false, "summary must not be runtime API data");
  assertCondition(summary.rowCount === 119, `expected 119 oracle-labelled rows, found ${summary.rowCount}`);
  assertCondition((summary.missingMovementFiles ?? []).length === 0, "movement files are missing");
  assertCondition((summary.features ?? []).length >= 8, "expected multiple feature summaries");
  assertCondition(summary.promotionGate?.minWeightedPurity === 0.95, "promotion gate purity mismatch");
  assertCondition(summary.promotionGate?.promotableFeatureCount === 0, "existing entity-key features should not be marked promotable");
  assertCondition(summary.status === "no_promotable_existing_entity_key_signal", "unexpected status");

  const byName = new Map((summary.features ?? []).map((feature) => [feature.name, feature]));
  for (const name of ["familyKey", "slotIndex", "familySlot", "globalOrdinalMod10", "familyOrdinalMod10"]) {
    assertCondition(byName.has(name), `missing feature ${name}`);
    assertCondition(byName.get(name).rowCount === summary.rowCount, `feature ${name} row count mismatch`);
  }
  assertCondition((byName.get("familySlot")?.weightedPurity ?? 0) < 0.95, "familySlot unexpectedly meets promotion purity");

  console.log(`Verified movement identity signal candidate summary: ${inputPath}`);
  console.log(`rows=${summary.rowCount}, promotable=${summary.promotionGate.promotableFeatureCount}, top=${summary.features[0].name}:${summary.features[0].weightedPurity.toFixed(3)}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
