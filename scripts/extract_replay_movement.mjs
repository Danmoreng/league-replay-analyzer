import fs from "fs";
import path from "path";

import {
  resolveAbsolute,
  readJson,
  summonersRiftBounds,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    outputPath: null,
    schemaPath: null,
    maxPatterns: 4,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--max-patterns" && index + 1 < argv.length) {
      args.maxPatterns = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactDir) {
    throw new Error("Missing required --artifact-dir <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/extract_replay_movement.mjs --artifact-dir <path> [--schema-path <path>] [--output-path <path>]");
}

function buildFieldIndex(cleanedJson) {
  const fieldIndex = new Map();
  for (const slot of cleanedJson?.slots ?? []) {
    for (const field of slot.fields ?? []) {
      fieldIndex.set(`${slot.slotIndex}|${field.offset}|${field.decodeLabel}`, field);
    }
  }
  return fieldIndex;
}

function alignFieldSamples(xField, yField, mapping, transformX, transformY) {
  const yByTimestamp = new Map((yField.samples ?? []).map((sample) => [sample.timestamp, sample.decoded]));
  const points = [];
  for (const sample of xField.samples ?? []) {
    const pairedValue = yByTimestamp.get(sample.timestamp);
    if (!Number.isFinite(sample.decoded) || !Number.isFinite(pairedValue) || !Number.isFinite(sample.timestamp)) {
      continue;
    }

    const rawX = mapping === "normal" ? sample.decoded : pairedValue;
    const rawY = mapping === "normal" ? pairedValue : sample.decoded;
    const x = ((transformX?.slopeMedian ?? 1) * rawX) + (transformX?.interceptMedian ?? 0);
    const y = ((transformY?.slopeMedian ?? 1) * rawY) + (transformY?.interceptMedian ?? 0);
    points.push({
      timestamp: sample.timestamp,
      x,
      y,
    });
  }
  return points;
}

function computeBoundsRatio(points) {
  if (!points.length) {
    return 0;
  }

  let inBounds = 0;
  for (const point of points) {
    if (
      point.x >= summonersRiftBounds.minX &&
      point.x <= summonersRiftBounds.maxX &&
      point.y >= summonersRiftBounds.minY &&
      point.y <= summonersRiftBounds.maxY
    ) {
      inBounds += 1;
    }
  }

  return inBounds / points.length;
}

function pointInBounds(point) {
  return (
    point.x >= summonersRiftBounds.minX &&
    point.x <= summonersRiftBounds.maxX &&
    point.y >= summonersRiftBounds.minY &&
    point.y <= summonersRiftBounds.maxY
  );
}

function filterTrajectoryPoints(points) {
  return points.filter((point) => pointInBounds(point));
}

function computeTrajectoryStats(points) {
  if (!points.length) {
    return {
      pointCount: 0,
      uniquePointRatio: 0,
      displacement: 0,
      pathLength: 0,
      xRange: 0,
      yRange: 0,
      movementQuality: 0,
    };
  }

  let minX = points[0].x;
  let maxX = points[0].x;
  let minY = points[0].y;
  let maxY = points[0].y;
  let pathLength = 0;
  const uniquePoints = new Set();
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    uniquePoints.add(`${Math.round(point.x)}|${Math.round(point.y)}`);

    if (index === 0) {
      continue;
    }

    const previous = points[index - 1];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    pathLength += Math.sqrt((dx * dx) + (dy * dy));
  }

  const first = points[0];
  const last = points[points.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const displacement = Math.sqrt((dx * dx) + (dy * dy));
  const xRange = maxX - minX;
  const yRange = maxY - minY;
  const uniquePointRatio = uniquePoints.size / points.length;
  const movementQuality = Math.min(1, ((xRange + yRange) / 6000)) * 0.45
    + Math.min(1, (pathLength / 9000)) * 0.35
    + uniquePointRatio * 0.2;

  return {
    pointCount: points.length,
    uniquePointRatio,
    displacement,
    pathLength,
    xRange,
    yRange,
    movementQuality,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const schemaPath = args.schemaPath
    ? resolveAbsolute(repoRoot, args.schemaPath)
    : path.join(artifactDir, "movement-provisional-schema.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "extracted-movement.json");

  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  if (!fs.existsSync(runManifestPath)) {
    throw new Error(`Run manifest not found at ${runManifestPath}`);
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Movement provisional schema not found at ${schemaPath}`);
  }

  const runManifest = readJson(runManifestPath);
  const schema = readJson(schemaPath);
  const promotedPatterns = schema.promotedPatterns ?? [];
  const rankedFallback = (schema.rankedPatterns ?? [])
    .filter((pattern) =>
      (pattern.support?.avgValidatorScore ?? 0) >= 0.85 &&
      (pattern.support?.avgNormalizedDistanceRmse ?? Number.POSITIVE_INFINITY) <= 0.2,
    );
  const patterns = (promotedPatterns.length ? promotedPatterns : rankedFallback)
    .slice(0, args.maxPatterns);

  const familyFieldIndexes = new Map();
  for (const family of runManifest.families ?? []) {
    const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    familyFieldIndexes.set(family.familyKey, buildFieldIndex(readJson(cleanedPath)));
  }

  const extractedPatterns = [];
  const entities = [];
  for (const pattern of patterns) {
    const fieldIndex = familyFieldIndexes.get(pattern.familyKey);
    if (!fieldIndex) {
      continue;
    }

    const rawCandidates = (pattern.rawPairCandidates ?? []).slice(0, 8);
    const entityKeys = [];
    for (const candidate of rawCandidates) {
      const xField = fieldIndex.get(`${candidate.slotIndex}|${pattern.xField.offset}|${pattern.xField.decode}`);
      const yField = fieldIndex.get(`${candidate.slotIndex}|${pattern.yField.offset}|${pattern.yField.decode}`);
      if (!xField || !yField) {
        continue;
      }

      const points = alignFieldSamples(
        xField,
        yField,
        pattern.mapping,
        pattern.transformX,
        pattern.transformY,
      );
      if (points.length < 4) {
        continue;
      }

      const rawBoundsRatio = computeBoundsRatio(points);
      if (rawBoundsRatio < 0.85) {
        continue;
      }
      const filteredPoints = filterTrajectoryPoints(points);
      if (filteredPoints.length < 4) {
        continue;
      }
      const boundsRatio = computeBoundsRatio(filteredPoints);

      const entityKey = `${pattern.familyKey}|${candidate.slotIndex}|${pattern.xField.offset}|${pattern.yField.offset}|${pattern.mapping}`;
      entityKeys.push(entityKey);
      const trajectoryStats = computeTrajectoryStats(filteredPoints);
      entities.push({
        entityKey,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        patternConfidence: pattern.confidence,
        sourceMetrics: {
          avgAxisCorrelation: pattern.support?.avgAxisCorrelation ?? 0,
          avgPathCorrelation: pattern.support?.avgPathCorrelation ?? 0,
          avgNormalizedDistanceRmse: pattern.support?.avgNormalizedDistanceRmse ?? Number.POSITIVE_INFINITY,
          avgValidatorScore: pattern.support?.avgValidatorScore ?? 0,
        },
        slotIndex: candidate.slotIndex,
        rawPointCount: points.length,
        filteredPointCount: filteredPoints.length,
        rawBoundsRatio,
        boundsRatio,
        trajectoryStats,
        trajectory: filteredPoints,
      });
    }

    extractedPatterns.push({
      patternKey: pattern.patternKey,
      familyKey: pattern.familyKey,
      confidence: pattern.confidence,
      rowBand: pattern.rowBand,
      xField: pattern.xField,
      yField: pattern.yField,
      mapping: pattern.mapping,
      entityKeys,
    });
  }

  const extractedMovement = {
    replayId: runManifest.replayId,
    generatedAtUtc: new Date().toISOString(),
    schemaPath,
    patterns: extractedPatterns,
    entities,
  };

  writeJson(outputPath, extractedMovement);
  console.log(`Wrote extracted movement to ${outputPath}`);
  console.log(`Extracted ${entities.length} candidate trajectories from ${extractedPatterns.length} movement patterns.`);
}

main();
