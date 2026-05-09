import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    beforePath: null,
    afterPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before" && index + 1 < argv.length) {
      args.beforePath = argv[++index];
    } else if (arg === "--after" && index + 1 < argv.length) {
      args.afterPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.beforePath || !args.afterPath) {
    throw new Error("Missing required --before <path> and --after <path> arguments.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/inspect_runtime_schema_drift.mjs --before <schema.json> --after <schema.json>");
}

function normalizePattern(pattern) {
  return {
    patternKey: pattern.patternKey,
    familyKey: pattern.familyKey,
    metric: pattern.metric,
    decode: pattern.decode,
    offset: pattern.offset,
    slotClusterKey: pattern.slotClusterKey ?? null,
    recommendedRowBand: pattern.recommendedRowBand ?? null,
    recommendedSlots: pattern.recommendedSlots ?? null,
    confidence: pattern.confidence ?? null,
    transform: pattern.transform ?? null,
    bundleSupport: pattern.bundleSupport ?? null,
    support: pattern.support
      ? {
        replays: pattern.support.replays ?? null,
        promotedReplays: pattern.support.promotedReplays ?? null,
        medianParticipants: pattern.support.medianParticipants ?? null,
        medianCorrelation: pattern.support.medianCorrelation ?? null,
        medianNormalizedRmse: pattern.support.medianNormalizedRmse ?? null,
        medianValidatorScore: pattern.support.medianValidatorScore ?? null,
      }
      : null,
  };
}

function normalizeRuntimeSchema(schema) {
  return {
    source: schema.source ?? null,
    thresholds: schema.thresholds ?? null,
    versionGroups: schema.versionGroups ?? null,
    promotedPatterns: (schema.promotedPatterns ?? [])
      .map(normalizePattern)
      .sort((left, right) => left.patternKey.localeCompare(right.patternKey)),
    bundlePromotedPatterns: (schema.bundlePromotedPatterns ?? [])
      .map(normalizePattern)
      .sort((left, right) => left.patternKey.localeCompare(right.patternKey)),
  };
}

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const beforePath = resolveAbsolute(repoRoot, args.beforePath);
  const afterPath = resolveAbsolute(repoRoot, args.afterPath);

  if (!fs.existsSync(beforePath)) {
    throw new Error(`Schema not found: ${beforePath}`);
  }
  if (!fs.existsSync(afterPath)) {
    throw new Error(`Schema not found: ${afterPath}`);
  }

  const before = normalizeRuntimeSchema(readJson(beforePath));
  const after = normalizeRuntimeSchema(readJson(afterPath));

  const beforeText = stringify(before);
  const afterText = stringify(after);
  if (beforeText === afterText) {
    console.log("No runtime schema drift detected.");
    return;
  }

  const beforePromoted = new Map(before.promotedPatterns.map((pattern) => [pattern.patternKey, pattern]));
  const afterPromoted = new Map(after.promotedPatterns.map((pattern) => [pattern.patternKey, pattern]));
  const beforeBundle = new Map(before.bundlePromotedPatterns.map((pattern) => [pattern.patternKey, pattern]));
  const afterBundle = new Map(after.bundlePromotedPatterns.map((pattern) => [pattern.patternKey, pattern]));

  const summarizeDiff = (label, leftMap, rightMap) => {
    const added = [];
    const removed = [];
    const changed = [];
    const keys = new Set([...leftMap.keys(), ...rightMap.keys()]);
    for (const key of [...keys].sort()) {
      const left = leftMap.get(key) ?? null;
      const right = rightMap.get(key) ?? null;
      if (!left && right) {
        added.push(key);
      } else if (left && !right) {
        removed.push(key);
      } else if (stringify(left) !== stringify(right)) {
        changed.push(key);
      }
    }

    console.log(`${label}: added=${added.length} removed=${removed.length} changed=${changed.length}`);
    for (const key of added) {
      console.log(`+ ${key}`);
    }
    for (const key of removed) {
      console.log(`- ${key}`);
    }
    for (const key of changed) {
      console.log(`~ ${key}`);
      console.log("before:");
      console.log(stringify(leftMap.get(key)));
      console.log("after:");
      console.log(stringify(rightMap.get(key)));
    }
  };

  summarizeDiff("promotedPatterns", beforePromoted, afterPromoted);
  summarizeDiff("bundlePromotedPatterns", beforeBundle, afterBundle);
}

main();
