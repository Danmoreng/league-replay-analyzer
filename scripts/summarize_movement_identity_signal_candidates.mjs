#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    keyframeArtifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    gapPath: null,
    outputPath: null,
    movementFile: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--keyframe-artifact-root" && index + 1 < argv.length) {
      args.keyframeArtifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--gap-path" && index + 1 < argv.length) {
      args.gapPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--movement-file" && index + 1 < argv.length) {
      args.movementFile = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_movement_identity_signal_candidates.mjs [--version-group 16.9]");
}

function parseEntityKey(entityKey) {
  if (!entityKey) {
    return null;
  }
  const [familyKey, slotIndexText, xOffsetText, yOffsetText, mapping] = entityKey.split("|");
  return {
    familyKey,
    slotIndex: Number(slotIndexText),
    xOffset: Number(xOffsetText),
    yOffset: Number(yOffsetText),
    mapping,
    offsetPair: `${xOffsetText}|${yOffsetText}`,
    familySlot: `${familyKey}|${slotIndexText}`,
    familyOffsetPair: `${familyKey}|${xOffsetText}|${yOffsetText}`,
    familySlotMapping: `${familyKey}|${slotIndexText}|${mapping}`,
  };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }
    return String(left[0]).localeCompare(String(right[0]));
  }));
}

function bucketSlot(slotIndex) {
  if (!Number.isFinite(slotIndex)) {
    return "unknown";
  }
  return `${Math.floor(slotIndex / 5) * 5}-${Math.floor(slotIndex / 5) * 5 + 4}`;
}

function entityOrdinalMaps(movement) {
  const entities = [...(movement.entities ?? [])].sort((left, right) =>
    String(left.familyKey).localeCompare(String(right.familyKey))
    || (left.slotIndex ?? 0) - (right.slotIndex ?? 0)
    || String(left.entityKey).localeCompare(String(right.entityKey)),
  );
  const globalOrdinalByKey = new Map();
  const familyOrdinalByKey = new Map();
  const familyCounts = new Map();
  entities.forEach((entity, index) => {
    globalOrdinalByKey.set(entity.entityKey, index);
    const familyCount = familyCounts.get(entity.familyKey) ?? 0;
    familyOrdinalByKey.set(entity.entityKey, familyCount);
    familyCounts.set(entity.familyKey, familyCount + 1);
  });
  return { globalOrdinalByKey, familyOrdinalByKey, familyCounts };
}

function roleLabel(participant) {
  return `${participant.team}|${participant.teamPosition}`;
}

function summarizeFeature(rows, name, valueForRow) {
  const valueTotals = new Map();
  const valueLabels = new Map();
  const labelTotals = new Map();

  for (const row of rows) {
    const value = valueForRow(row);
    const label = roleLabel(row);
    increment(valueTotals, value);
    increment(labelTotals, label);
    const labels = valueLabels.get(value) ?? new Map();
    increment(labels, label);
    valueLabels.set(value, labels);
  }

  let pureCount = 0;
  let ambiguousValueCount = 0;
  const topValues = [];
  for (const [value, total] of valueTotals.entries()) {
    const labels = valueLabels.get(value) ?? new Map();
    const sortedLabels = [...labels.entries()].sort((left, right) => right[1] - left[1]);
    const top = sortedLabels[0] ?? [null, 0];
    pureCount += top[1];
    if (labels.size > 1) {
      ambiguousValueCount += 1;
    }
    topValues.push({
      value,
      count: total,
      topLabel: top[0],
      topLabelCount: top[1],
      purity: total > 0 ? top[1] / total : 0,
      labelCounts: Object.fromEntries(sortedLabels),
    });
  }

  topValues.sort((left, right) =>
    right.count - left.count
    || right.purity - left.purity
    || String(left.value).localeCompare(String(right.value)),
  );

  return {
    name,
    rowCount: rows.length,
    distinctValueCount: valueTotals.size,
    ambiguousValueCount,
    weightedPurity: rows.length > 0 ? pureCount / rows.length : 0,
    labelCoverage: sortedObject(labelTotals),
    topValues: topValues.slice(0, 20),
  };
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const keyframeArtifactRoot = resolveAbsolute(root, args.keyframeArtifactRoot);
  const gapPath = args.gapPath
    ? resolveAbsolute(root, args.gapPath)
    : path.join(keyframeArtifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}.json`);
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(keyframeArtifactRoot, `movement-identity-signal-candidates-${args.versionGroup}.json`);

  const gap = readJson(gapPath);
  const rows = [];
  const missingMovementFiles = [];

  for (const replay of gap.replays ?? []) {
    const movementFile = args.movementFile ?? replay.movementFile ?? gap.movementFile ?? "extracted-movement-max50-supplemented.json";
    const movementPath = path.join(artifactRoot, replay.replayId, movementFile);
    if (!fs.existsSync(movementPath)) {
      missingMovementFiles.push(movementPath);
      continue;
    }
    const movement = readJson(movementPath);
    const ordinals = entityOrdinalMaps(movement);
    for (const participant of replay.participants ?? []) {
      if (!participant.oraclePassesValidation || !participant.oracleEntityKey) {
        continue;
      }
      const entity = parseEntityKey(participant.oracleEntityKey);
      if (!entity) {
        continue;
      }
      rows.push({
        replayId: replay.replayId,
        ...participant,
        ...entity,
        slotBucket: bucketSlot(entity.slotIndex),
        globalOrdinal: ordinals.globalOrdinalByKey.get(participant.oracleEntityKey) ?? null,
        familyOrdinal: ordinals.familyOrdinalByKey.get(participant.oracleEntityKey) ?? null,
        familySize: ordinals.familyCounts.get(entity.familyKey) ?? null,
      });
    }
  }

  const features = [
    summarizeFeature(rows, "familyKey", (row) => row.familyKey),
    summarizeFeature(rows, "slotIndex", (row) => String(row.slotIndex)),
    summarizeFeature(rows, "slotBucket", (row) => row.slotBucket),
    summarizeFeature(rows, "offsetPair", (row) => row.offsetPair),
    summarizeFeature(rows, "mapping", (row) => row.mapping),
    summarizeFeature(rows, "familySlot", (row) => row.familySlot),
    summarizeFeature(rows, "familyOffsetPair", (row) => row.familyOffsetPair),
    summarizeFeature(rows, "familySlotMapping", (row) => row.familySlotMapping),
    summarizeFeature(rows, "globalOrdinalMod10", (row) => Number.isFinite(row.globalOrdinal) ? String(row.globalOrdinal % 10) : "unknown"),
    summarizeFeature(rows, "familyOrdinalMod10", (row) => Number.isFinite(row.familyOrdinal) ? String(row.familyOrdinal % 10) : "unknown"),
  ];

  features.sort((left, right) =>
    right.weightedPurity - left.weightedPurity
    || left.ambiguousValueCount - right.ambiguousValueCount
    || left.distinctValueCount - right.distinctValueCount,
  );

  const promotable = features.filter((feature) =>
    feature.rowCount >= 100 &&
    feature.weightedPurity >= 0.95 &&
    feature.ambiguousValueCount === 0,
  );

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-identity-signal-candidates/v1",
    versionGroup: args.versionGroup,
    mode: "offline-oracle-diagnostic",
    status: promotable.length > 0 ? "review_promotable_signal" : "no_promotable_existing_entity_key_signal",
    runtimeInput: false,
    runtimeApiData: false,
    note: "Uses offline oracle labels to evaluate existing replay-derived entity-key features; do not use labels at runtime.",
    gapPath,
    movementFile: args.movementFile ?? gap.movementFile ?? "extracted-movement-max50-supplemented.json",
    rowCount: rows.length,
    missingMovementFiles,
    promotionGate: {
      minRows: 100,
      minWeightedPurity: 0.95,
      requireNoAmbiguousValues: true,
      promotableFeatureCount: promotable.length,
    },
    features,
  };

  writeJson(outputPath, output);
  console.log(`Wrote movement identity signal candidate summary to ${outputPath}`);
  console.log(`oracle-labelled rows=${rows.length}, promotable features=${promotable.length}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
