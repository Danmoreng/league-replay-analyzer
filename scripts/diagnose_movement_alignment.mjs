#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildPositionSeries,
  clamp,
  fitAffine1D,
  interpolate,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  summonersRiftBounds,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const mapSpan = 15000;

const geometryVariants = [
  {
    key: "identity",
    apply: (x, y) => ({ x, y }),
  },
  {
    key: "swap",
    apply: (x, y) => ({ x: y, y: x }),
  },
  {
    key: "mirrorX",
    apply: (x, y) => ({ x: mapSpan - x, y }),
  },
  {
    key: "mirrorY",
    apply: (x, y) => ({ x, y: mapSpan - y }),
  },
  {
    key: "mirrorXY",
    apply: (x, y) => ({ x: mapSpan - x, y: mapSpan - y }),
  },
  {
    key: "swapMirrorX",
    apply: (x, y) => ({ x: mapSpan - y, y: x }),
  },
  {
    key: "swapMirrorY",
    apply: (x, y) => ({ x: y, y: mapSpan - x }),
  },
  {
    key: "swapMirrorXY",
    apply: (x, y) => ({ x: mapSpan - y, y: mapSpan - x }),
  },
];

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    movementPath: null,
    fixtureDir: null,
    outputPath: null,
    maxTimeShiftMs: 120000,
    timeStepMs: 1000,
    minOverlap: 6,
    topMatches: 5,
    entityKeyFilter: "",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--movement-path" && index + 1 < argv.length) {
      args.movementPath = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--max-time-shift-ms" && index + 1 < argv.length) {
      args.maxTimeShiftMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--time-step-ms" && index + 1 < argv.length) {
      args.timeStepMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-overlap" && index + 1 < argv.length) {
      args.minOverlap = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-matches" && index + 1 < argv.length) {
      args.topMatches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--entity-key" && index + 1 < argv.length) {
      args.entityKeyFilter = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactDir && !args.movementPath) {
    throw new Error("Pass --artifact-dir <path> or --movement-path <path>.");
  }
  if (!Number.isFinite(args.maxTimeShiftMs) || args.maxTimeShiftMs < 0) {
    throw new Error("--max-time-shift-ms must be a non-negative integer.");
  }
  if (!Number.isFinite(args.timeStepMs) || args.timeStepMs <= 0) {
    throw new Error("--time-step-ms must be a positive integer.");
  }
  if (!Number.isFinite(args.minOverlap) || args.minOverlap < 3) {
    throw new Error("--min-overlap must be at least 3.");
  }
  if (!Number.isFinite(args.topMatches) || args.topMatches < 1) {
    throw new Error("--top-matches must be at least 1.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/diagnose_movement_alignment.mjs --artifact-dir <path> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --movement-path <path>      Override extracted-movement.json path.");
  console.log("  --fixture-dir <path>        Override replay API fixture dir.");
  console.log("  --output-path <path>        Output JSON path (default: <artifact>/movement-alignment-diagnosis.json).");
  console.log("  --max-time-shift-ms <int>   Search window for timestamp alignment (default: 120000).");
  console.log("  --time-step-ms <int>        Time shift step in milliseconds (default: 1000).");
  console.log("  --min-overlap <int>         Minimum aligned samples (default: 6).");
  console.log("  --top-matches <int>         Top matches to keep per entity (default: 5).");
  console.log("  --entity-key <key>          Analyze only one entity key.");
}

function normalizeEntitySamples(entity) {
  const source = Array.isArray(entity.rawSamples) && entity.rawSamples.length > 0
    ? "rawSamples"
    : "trajectory";
  const points = source === "rawSamples"
    ? entity.rawSamples.map((sample) => ({
      timestamp: sample.timestamp,
      x: sample.rawX,
      y: sample.rawY,
    }))
    : (entity.trajectory ?? []).map((sample) => ({
      timestamp: sample.timestamp,
      x: sample.x,
      y: sample.y,
    }));

  const normalizedPoints = points
    .filter((point) =>
      Number.isFinite(point.timestamp)
      && Number.isFinite(point.x)
      && Number.isFinite(point.y))
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((point) => ({
      timestamp: point.timestamp,
      x: point.x,
      y: point.y,
    }));

  return {
    sourceMode: source,
    points: normalizedPoints,
  };
}

function toValueSeries(points, key) {
  return points.map((point) => ({
    timestamp: point.timestamp,
    value: point[key],
  }));
}

function stepDistances(points) {
  const distances = [];
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    distances.push(Math.sqrt((dx * dx) + (dy * dy)));
  }
  return distances;
}

function evaluateAlignment(sourcePoints, targetPoints, variant, shiftMs, minOverlap) {
  const targetX = toValueSeries(targetPoints, "x");
  const targetY = toValueSeries(targetPoints, "y");

  const aligned = [];
  for (const sourcePoint of sourcePoints) {
    const shiftedTimestamp = sourcePoint.timestamp + shiftMs;
    const targetValueX = interpolate(targetX, shiftedTimestamp);
    const targetValueY = interpolate(targetY, shiftedTimestamp);
    if (!Number.isFinite(targetValueX) || !Number.isFinite(targetValueY)) {
      continue;
    }

    const transformed = variant.apply(sourcePoint.x, sourcePoint.y);
    if (!Number.isFinite(transformed.x) || !Number.isFinite(transformed.y)) {
      continue;
    }

    aligned.push({
      timestamp: sourcePoint.timestamp,
      sourceX: transformed.x,
      sourceY: transformed.y,
      targetX: targetValueX,
      targetY: targetValueY,
    });
  }

  if (aligned.length < minOverlap) {
    return null;
  }

  const fitX = fitAffine1D(
    aligned.map((item) => item.sourceX),
    aligned.map((item) => item.targetX),
  );
  const fitY = fitAffine1D(
    aligned.map((item) => item.sourceY),
    aligned.map((item) => item.targetY),
  );

  const predicted = aligned.map((item) => ({
    timestamp: item.timestamp,
    x: (fitX.slope * item.sourceX) + fitX.intercept,
    y: (fitY.slope * item.sourceY) + fitY.intercept,
  }));
  const targets = aligned.map((item) => ({
    timestamp: item.timestamp,
    x: item.targetX,
    y: item.targetY,
  }));

  const predictedXs = predicted.map((item) => item.x);
  const predictedYs = predicted.map((item) => item.y);
  const targetXs = targets.map((item) => item.x);
  const targetYs = targets.map((item) => item.y);

  let squaredDistanceError = 0;
  for (let index = 0; index < predicted.length; index += 1) {
    const dx = predicted[index].x - targets[index].x;
    const dy = predicted[index].y - targets[index].y;
    squaredDistanceError += (dx * dx) + (dy * dy);
  }

  const distanceRmse = Math.sqrt(squaredDistanceError / predicted.length);
  const normalizedDistanceRmse = distanceRmse / summonersRiftBounds.diagonal;
  const xCorrelation = pearsonCorrelation(predictedXs, targetXs);
  const yCorrelation = pearsonCorrelation(predictedYs, targetYs);
  const averageAxisCorrelation = (xCorrelation + yCorrelation) / 2;
  const pathCorrelation = pearsonCorrelation(
    stepDistances(predicted),
    stepDistances(targets),
  );

  const axisScore = clamp((averageAxisCorrelation + 1) / 2, 0, 1);
  const pathScore = clamp((pathCorrelation + 1) / 2, 0, 1);
  const rmseScore = 1 - clamp(normalizedDistanceRmse / 0.2, 0, 1);
  const overlapScore = clamp(aligned.length / sourcePoints.length, 0, 1);
  const score = (axisScore * 0.4) + (pathScore * 0.2) + (rmseScore * 0.3) + (overlapScore * 0.1);

  return {
    score,
    shiftMs,
    variant: variant.key,
    overlap: aligned.length,
    xCorrelation,
    yCorrelation,
    averageAxisCorrelation,
    pathCorrelation,
    distanceRmse,
    normalizedDistanceRmse,
    affineX: {
      slope: fitX.slope,
      intercept: fitX.intercept,
      rmse: fitX.rmse,
      valid: fitX.valid,
    },
    affineY: {
      slope: fitY.slope,
      intercept: fitY.intercept,
      rmse: fitY.rmse,
      valid: fitY.valid,
    },
  };
}

function buildTimeShifts(maxTimeShiftMs, timeStepMs) {
  const shifts = [];
  for (let shift = -maxTimeShiftMs; shift <= maxTimeShiftMs; shift += timeStepMs) {
    shifts.push(shift);
  }
  if (!shifts.includes(0)) {
    shifts.push(0);
  }
  return [...new Set(shifts)].sort((left, right) => left - right);
}

function classifyBestMatch(match) {
  if (!match) {
    return "none";
  }
  if (
    match.overlap >= 6
    && match.averageAxisCorrelation >= 0.8
    && match.pathCorrelation >= 0.35
    && match.normalizedDistanceRmse <= 0.08
  ) {
    return "strong";
  }
  if (
    match.overlap >= 6
    && match.averageAxisCorrelation >= 0.65
    && match.pathCorrelation >= 0.2
    && match.normalizedDistanceRmse <= 0.14
  ) {
    return "moderate";
  }
  return "weak";
}

function summarizeByFamily(entityResults) {
  const byFamily = new Map();
  for (const entity of entityResults) {
    const family = byFamily.get(entity.familyKey) ?? {
      familyKey: entity.familyKey,
      totalEntities: 0,
      strong: 0,
      moderate: 0,
      weak: 0,
      averageBestScore: 0,
      averageBestNRMSE: 0,
      averageBestAxisCorrelation: 0,
      averageBestPathCorrelation: 0,
    };

    family.totalEntities += 1;
    family.averageBestScore += entity.bestMatch?.score ?? 0;
    family.averageBestNRMSE += entity.bestMatch?.normalizedDistanceRmse ?? 0;
    family.averageBestAxisCorrelation += entity.bestMatch?.averageAxisCorrelation ?? 0;
    family.averageBestPathCorrelation += entity.bestMatch?.pathCorrelation ?? 0;

    const classKey = classifyBestMatch(entity.bestMatch);
    if (classKey === "strong") {
      family.strong += 1;
    } else if (classKey === "moderate") {
      family.moderate += 1;
    } else {
      family.weak += 1;
    }

    byFamily.set(entity.familyKey, family);
  }

  return [...byFamily.values()]
    .map((family) => ({
      ...family,
      averageBestScore: family.averageBestScore / Math.max(1, family.totalEntities),
      averageBestNRMSE: family.averageBestNRMSE / Math.max(1, family.totalEntities),
      averageBestAxisCorrelation: family.averageBestAxisCorrelation / Math.max(1, family.totalEntities),
      averageBestPathCorrelation: family.averageBestPathCorrelation / Math.max(1, family.totalEntities),
    }))
    .sort((left, right) =>
      right.strong - left.strong
      || right.moderate - left.moderate
      || right.averageBestScore - left.averageBestScore
      || left.averageBestNRMSE - right.averageBestNRMSE);
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const artifactDir = args.artifactDir
    ? resolveAbsolute(repoRoot, args.artifactDir)
    : path.dirname(resolveAbsolute(repoRoot, args.movementPath));
  const movementPath = args.movementPath
    ? resolveAbsolute(repoRoot, args.movementPath)
    : path.join(artifactDir, "extracted-movement.json");

  if (!fs.existsSync(movementPath)) {
    throw new Error(`Movement extraction file not found at ${movementPath}`);
  }

  const extractedMovement = readJson(movementPath);
  const replayId = extractedMovement.replayId;
  if (!replayId) {
    throw new Error(`Replay id missing in ${movementPath}`);
  }

  const fixtureDir = args.fixtureDir
    ? resolveAbsolute(repoRoot, args.fixtureDir)
    : path.join(repoRoot, "replays", "api", replayId.replace(/-/g, "_"));
  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    throw new Error(`Fixture bundle not found under ${fixtureDir}`);
  }

  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "movement-alignment-diagnosis.json");

  const matchJson = readJson(matchPath);
  const timelineJson = readJson(timelinePath);
  const { participants, positionSeriesByParticipant } = buildPositionSeries(matchJson, timelineJson);
  const timeShifts = buildTimeShifts(args.maxTimeShiftMs, args.timeStepMs);

  const entities = (extractedMovement.entities ?? [])
    .filter((entity) => !args.entityKeyFilter || entity.entityKey === args.entityKeyFilter);
  const entityResults = [];

  for (const entity of entities) {
    const normalizedSource = normalizeEntitySamples(entity);
    const sourcePoints = normalizedSource.points;
    if (sourcePoints.length < args.minOverlap) {
      entityResults.push({
        entityKey: entity.entityKey,
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        sourceMode: normalizedSource.sourceMode,
        sampleCount: sourcePoints.length,
        skipped: true,
        reason: `not enough source points (${sourcePoints.length})`,
        bestMatch: null,
        topMatches: [],
      });
      continue;
    }

    const matches = [];
    for (const participant of participants) {
      const targetSeries = positionSeriesByParticipant.get(participant.participantId) ?? [];
      if (targetSeries.length < args.minOverlap) {
        continue;
      }

      for (const variant of geometryVariants) {
        for (const shiftMs of timeShifts) {
          const evaluation = evaluateAlignment(
            sourcePoints,
            targetSeries,
            variant,
            shiftMs,
            args.minOverlap,
          );
          if (!evaluation) {
            continue;
          }
          matches.push({
            ...evaluation,
            participantId: participant.participantId,
            champion: participant.champion,
            teamId: participant.teamId,
            teamPosition: participant.teamPosition,
          });
        }
      }
    }

    matches.sort((left, right) =>
      right.score - left.score
      || left.normalizedDistanceRmse - right.normalizedDistanceRmse
      || right.averageAxisCorrelation - left.averageAxisCorrelation
      || right.pathCorrelation - left.pathCorrelation
      || right.overlap - left.overlap);

    entityResults.push({
      entityKey: entity.entityKey,
      familyKey: entity.familyKey,
      slotIndex: entity.slotIndex,
      sourceMode: normalizedSource.sourceMode,
      sampleCount: sourcePoints.length,
      skipped: false,
      bestMatch: matches[0] ?? null,
      quality: classifyBestMatch(matches[0] ?? null),
      topMatches: matches.slice(0, args.topMatches),
    });
  }

  const analyzed = entityResults.filter((entity) => !entity.skipped);
  const strongCount = analyzed.filter((entity) => entity.quality === "strong").length;
  const moderateCount = analyzed.filter((entity) => entity.quality === "moderate").length;
  const weakCount = analyzed.filter((entity) => entity.quality === "weak").length;

  const diagnosis = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    movementPath,
    fixtureDir,
    settings: {
      maxTimeShiftMs: args.maxTimeShiftMs,
      timeStepMs: args.timeStepMs,
      minOverlap: args.minOverlap,
      topMatches: args.topMatches,
      entityKeyFilter: args.entityKeyFilter || null,
      geometryVariants: geometryVariants.map((variant) => variant.key),
    },
    summary: {
      entityCount: entities.length,
      analyzedEntityCount: analyzed.length,
      skippedEntityCount: entityResults.length - analyzed.length,
      strongCount,
      moderateCount,
      weakCount,
      averageBestScore: analyzed.reduce((sum, entity) => sum + (entity.bestMatch?.score ?? 0), 0) / Math.max(1, analyzed.length),
      averageBestNRMSE: analyzed.reduce((sum, entity) => sum + (entity.bestMatch?.normalizedDistanceRmse ?? 0), 0) / Math.max(1, analyzed.length),
      averageBestAxisCorrelation: analyzed.reduce((sum, entity) => sum + (entity.bestMatch?.averageAxisCorrelation ?? 0), 0) / Math.max(1, analyzed.length),
      averageBestPathCorrelation: analyzed.reduce((sum, entity) => sum + (entity.bestMatch?.pathCorrelation ?? 0), 0) / Math.max(1, analyzed.length),
    },
    familySummary: summarizeByFamily(analyzed),
    entities: entityResults,
  };

  writeJson(outputPath, diagnosis);
  console.log(`Wrote movement alignment diagnosis to ${outputPath}`);
  console.log(`Analyzed ${diagnosis.summary.analyzedEntityCount}/${diagnosis.summary.entityCount} entities.`);
  console.log(
    `Best-match quality: strong=${diagnosis.summary.strongCount}, moderate=${diagnosis.summary.moderateCount}, weak=${diagnosis.summary.weakCount}`,
  );
}

main();
