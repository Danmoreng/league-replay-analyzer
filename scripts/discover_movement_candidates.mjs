import fs from "fs";
import path from "path";

import {
  buildPositionSeries,
  clamp,
  fitAffine1D,
  interpolate,
  median,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  standardDeviation,
  summonersRiftBounds,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const allowedDecodeLabels = new Set(["u8", "u16", "u32", "i16", "i32", "f32"]);

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    fixtureDir: null,
    outputDir: null,
    minOverlap: 6,
    topMatches: 256,
    maxPairsPerSlot: 120,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-dir" && index + 1 < argv.length) {
      args.outputDir = argv[++index];
    } else if (arg === "--min-overlap" && index + 1 < argv.length) {
      args.minOverlap = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-matches" && index + 1 < argv.length) {
      args.topMatches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-pairs-per-slot" && index + 1 < argv.length) {
      args.maxPairsPerSlot = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/discover_movement_candidates.mjs --artifact-dir <path> [--fixture-dir <path>] [--output-dir <path>]");
}

function buildFieldCandidate(familySummary, slotSummary, field) {
  if (!allowedDecodeLabels.has(field.decodeLabel)) {
    return null;
  }

  const samples = (field.samples ?? [])
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.decoded));
  if (samples.length < 6) {
    return null;
  }

  return {
    familyKey: familySummary.familyKey,
    familyLength: familySummary.length,
    familyFirstByte: familySummary.firstByte,
    slotIndex: slotSummary.slotIndex,
    rowArchetype: familySummary.slotArchetypeBySlot.get(slotSummary.slotIndex) ?? "unknown",
    offset: field.offset,
    width: field.width,
    decodeLabel: field.decodeLabel,
    uniqueValues: field.uniqueValues,
    changedTransitions: field.changedTransitions,
    activeSamples: field.activeSamples,
    samples,
  };
}

function alignPairSamples(leftField, rightField) {
  const rightByTimestamp = new Map(rightField.samples.map((sample) => [sample.timestamp, sample.decoded]));
  const points = [];
  for (const sample of leftField.samples) {
    const rightValue = rightByTimestamp.get(sample.timestamp);
    if (!Number.isFinite(rightValue)) {
      continue;
    }
    points.push({
      timestamp: sample.timestamp,
      leftValue: sample.decoded,
      rightValue,
    });
  }
  return points;
}

function buildPairCandidates(familySummary, slotSummary, fields, maxPairsPerSlot, minOverlap) {
  const pairCandidates = [];
  for (let leftIndex = 0; leftIndex < fields.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < fields.length; rightIndex += 1) {
      if (pairCandidates.length >= maxPairsPerSlot) {
        return pairCandidates;
      }

      const leftField = fields[leftIndex];
      const rightField = fields[rightIndex];
      if (leftField.offset === rightField.offset) {
        continue;
      }
      const points = alignPairSamples(leftField, rightField);
      if (points.length < minOverlap) {
        continue;
      }

      pairCandidates.push({
        familyKey: familySummary.familyKey,
        familyLength: familySummary.length,
        familyFirstByte: familySummary.firstByte,
        slotIndex: slotSummary.slotIndex,
        rowArchetype: familySummary.slotArchetypeBySlot.get(slotSummary.slotIndex) ?? "unknown",
        left: {
          offset: leftField.offset,
          width: leftField.width,
          decodeLabel: leftField.decodeLabel,
        },
        right: {
          offset: rightField.offset,
          width: rightField.width,
          decodeLabel: rightField.decodeLabel,
        },
        points,
        sourceScore: (leftField.changedTransitions ?? 0) + (rightField.changedTransitions ?? 0),
      });
    }
  }

  return pairCandidates;
}

function buildMovementTargets(series) {
  return {
    x: series.map((point) => ({ timestamp: point.timestamp, value: point.x })),
    y: series.map((point) => ({ timestamp: point.timestamp, value: point.y })),
  };
}

function computeStepDistances(points) {
  const distances = [];
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    distances.push(Math.sqrt((dx * dx) + (dy * dy)));
  }
  return distances;
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

function computeSpeedRatio(points) {
  if (points.length < 2) {
    return 0;
  }

  let validSteps = 0;
  let plausibleSteps = 0;
  for (let index = 1; index < points.length; index += 1) {
    const spanMillis = points[index].timestamp - points[index - 1].timestamp;
    if (spanMillis <= 0) {
      continue;
    }
    validSteps += 1;
    const distance = Math.sqrt(
      ((points[index].x - points[index - 1].x) ** 2) +
      ((points[index].y - points[index - 1].y) ** 2),
    );
    const speed = distance / (spanMillis / 1000);
    if (speed <= 1200) {
      plausibleSteps += 1;
    }
  }

  if (validSteps === 0) {
    return 0;
  }
  return plausibleSteps / validSteps;
}

function evaluateMapping(pairCandidate, targetSeries, mapping) {
  const rawXValues = [];
  const rawYValues = [];
  const targetXValues = [];
  const targetYValues = [];

  for (const point of pairCandidate.points) {
    const targetX = interpolate(targetSeries.x, point.timestamp);
    const targetY = interpolate(targetSeries.y, point.timestamp);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      continue;
    }

    const rawX = mapping === "normal" ? point.leftValue : point.rightValue;
    const rawY = mapping === "normal" ? point.rightValue : point.leftValue;
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) {
      continue;
    }

    rawXValues.push(rawX);
    rawYValues.push(rawY);
    targetXValues.push(targetX);
    targetYValues.push(targetY);
  }

  if (rawXValues.length < 6) {
    return null;
  }

  const fitX = fitAffine1D(rawXValues, targetXValues);
  const fitY = fitAffine1D(rawYValues, targetYValues);
  if (!Number.isFinite(fitX.rmse) || !Number.isFinite(fitY.rmse)) {
    return null;
  }

  const predictedPoints = rawXValues.map((rawX, index) => ({
    timestamp: pairCandidate.points[index].timestamp,
    x: (fitX.slope * rawX) + fitX.intercept,
    y: (fitY.slope * rawYValues[index]) + fitY.intercept,
  }));
  const targetPoints = targetXValues.map((x, index) => ({
    timestamp: pairCandidate.points[index].timestamp,
    x,
    y: targetYValues[index],
  }));

  const xCorrelation = pearsonCorrelation(
    predictedPoints.map((point) => point.x),
    targetPoints.map((point) => point.x),
  );
  const yCorrelation = pearsonCorrelation(
    predictedPoints.map((point) => point.y),
    targetPoints.map((point) => point.y),
  );
  const predictedSteps = computeStepDistances(predictedPoints);
  const targetSteps = computeStepDistances(targetPoints);
  const pathCorrelation = pearsonCorrelation(predictedSteps, targetSteps);

  let squaredDistance = 0;
  for (let index = 0; index < predictedPoints.length; index += 1) {
    const dx = predictedPoints[index].x - targetPoints[index].x;
    const dy = predictedPoints[index].y - targetPoints[index].y;
    squaredDistance += (dx * dx) + (dy * dy);
  }
  const distanceRmse = Math.sqrt(squaredDistance / predictedPoints.length);
  const normalizedDistanceRmse = distanceRmse / summonersRiftBounds.maxX;
  const boundsRatio = computeBoundsRatio(predictedPoints);
  const speedRatio = computeSpeedRatio(predictedPoints);
  const pathVariance = standardDeviation(predictedSteps);
  const varianceFactor = clamp(pathVariance / 1500, 0.2, 1);
  const correlationFactor = clamp((xCorrelation + yCorrelation) / 2, 0, 1);
  const pathFactor = clamp(Number.isFinite(pathCorrelation) ? pathCorrelation : 0, 0, 1);
  const distanceFactor = 1 / (1 + (normalizedDistanceRmse * 6));
  const overlapFactor = Math.min(1, predictedPoints.length / 12);

  let validatorScore = 1;
  if (correlationFactor < 0.45) {
    validatorScore *= clamp(correlationFactor / 0.45, 0, 1);
  }
  if (normalizedDistanceRmse > 0.2) {
    validatorScore *= clamp(0.2 / normalizedDistanceRmse, 0, 1);
  }
  if (boundsRatio < 0.85) {
    validatorScore *= clamp(boundsRatio / 0.85, 0, 1);
  }
  if (speedRatio < 0.75) {
    validatorScore *= clamp(speedRatio / 0.75, 0, 1);
  }

  const effectiveScore =
    overlapFactor *
    varianceFactor *
    ((0.4 * correlationFactor) + (0.2 * pathFactor) + (0.2 * distanceFactor) + (0.1 * boundsRatio) + (0.1 * speedRatio)) *
    validatorScore;

  return {
    overlap: predictedPoints.length,
    mapping,
    xCorrelation,
    yCorrelation,
    pathCorrelation,
    distanceRmse,
    normalizedDistanceRmse,
    boundsRatio,
    speedRatio,
    validatorScore,
    effectiveScore,
    transformX: {
      slope: fitX.slope,
      intercept: fitX.intercept,
      rmse: fitX.rmse,
    },
    transformY: {
      slope: fitY.slope,
      intercept: fitY.intercept,
      rmse: fitY.rmse,
    },
    passesValidation:
      predictedPoints.length >= 6 &&
      correlationFactor >= 0.45 &&
      normalizedDistanceRmse <= 0.2 &&
      boundsRatio >= 0.85 &&
      speedRatio >= 0.75,
  };
}

function comparePairToParticipant(pairCandidate, participant, targetSeries) {
  const normal = evaluateMapping(pairCandidate, targetSeries, "normal");
  const swapped = evaluateMapping(pairCandidate, targetSeries, "swapped");
  const best = [normal, swapped]
    .filter(Boolean)
    .sort((left, right) => right.effectiveScore - left.effectiveScore)[0];
  if (!best) {
    return null;
  }

  return {
    familyKey: pairCandidate.familyKey,
    familyLength: pairCandidate.familyLength,
    familyFirstByte: pairCandidate.familyFirstByte,
    slotIndex: pairCandidate.slotIndex,
    rowArchetype: pairCandidate.rowArchetype,
    leftOffset: pairCandidate.left.offset,
    leftDecodeLabel: pairCandidate.left.decodeLabel,
    rightOffset: pairCandidate.right.offset,
    rightDecodeLabel: pairCandidate.right.decodeLabel,
    participantId: participant.participantId,
    champion: participant.champion,
    teamId: participant.teamId,
    teamPosition: participant.teamPosition,
    overlap: best.overlap,
    mapping: best.mapping,
    xCorrelation: best.xCorrelation,
    yCorrelation: best.yCorrelation,
    pathCorrelation: best.pathCorrelation,
    distanceRmse: best.distanceRmse,
    normalizedDistanceRmse: best.normalizedDistanceRmse,
    boundsRatio: best.boundsRatio,
    speedRatio: best.speedRatio,
    validatorScore: best.validatorScore,
    effectiveScore: best.effectiveScore,
    transformX: best.transformX,
    transformY: best.transformY,
    passesValidation: best.passesValidation,
  };
}

function loadFamilySummaries(artifactDir, runManifest) {
  return runManifest.families.map((family) => {
    const familyDir = path.join(artifactDir, "families", family.familyKey);
    const cleanedPath = path.join(familyDir, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      return null;
    }

    const slotArchetypeBySlot = new Map();
    for (const slot of family.dynamicSlots ?? []) {
      slotArchetypeBySlot.set(slot, "dynamic_state_like");
    }
    for (const slot of family.mixedSlots ?? []) {
      slotArchetypeBySlot.set(slot, "mixed");
    }
    for (const slot of family.handleSlots ?? []) {
      slotArchetypeBySlot.set(slot, "static_handle_like");
    }

    return {
      ...family,
      cleaned: readJson(cleanedPath),
      slotArchetypeBySlot,
    };
  }).filter(Boolean);
}

function summarizeRawPair(rawPairKey, matches) {
  const bestByParticipant = new Map();
  for (const match of matches) {
    const current = bestByParticipant.get(match.participantId);
    if (!current || match.effectiveScore > current.effectiveScore) {
      bestByParticipant.set(match.participantId, match);
    }
  }

  const supportMatches = [...bestByParticipant.values()].sort((left, right) => right.effectiveScore - left.effectiveScore);
  if (!supportMatches.length) {
    return null;
  }

  const exemplar = supportMatches[0];
  const averageAxisCorrelation = supportMatches.reduce((sum, match) => sum + ((match.xCorrelation + match.yCorrelation) / 2), 0) / supportMatches.length;
  const averagePathCorrelation = supportMatches.reduce((sum, match) => sum + match.pathCorrelation, 0) / supportMatches.length;
  const averageNormalizedDistanceRmse = supportMatches.reduce((sum, match) => sum + match.normalizedDistanceRmse, 0) / supportMatches.length;
  const averageValidatorScore = supportMatches.reduce((sum, match) => sum + match.validatorScore, 0) / supportMatches.length;
  const averageEffectiveScore = supportMatches.reduce((sum, match) => sum + match.effectiveScore, 0) / supportMatches.length;
  const passCount = supportMatches.filter((match) => match.passesValidation).length;
  const aggregateScore =
    averageEffectiveScore *
    (0.5 + Math.min(1, supportMatches.length / 4)) *
    (0.5 + (passCount / supportMatches.length));

  return {
    rawPairKey,
    familyKey: exemplar.familyKey,
    familyLength: exemplar.familyLength,
    familyFirstByte: exemplar.familyFirstByte,
    slotIndex: exemplar.slotIndex,
    rowArchetype: exemplar.rowArchetype,
    leftOffset: exemplar.leftOffset,
    leftDecodeLabel: exemplar.leftDecodeLabel,
    rightOffset: exemplar.rightOffset,
    rightDecodeLabel: exemplar.rightDecodeLabel,
    mapping: exemplar.mapping,
    participantIds: supportMatches.map((match) => match.participantId),
    champions: supportMatches.map((match) => match.champion),
    passCount,
    averageAxisCorrelation,
    averagePathCorrelation,
    averageNormalizedDistanceRmse,
    averageValidatorScore,
    averageEffectiveScore,
    aggregateScore,
    transformX: {
      slopeMedian: median(supportMatches.map((match) => match.transformX.slope).filter(Number.isFinite)),
      interceptMedian: median(supportMatches.map((match) => match.transformX.intercept).filter(Number.isFinite)),
      sampleCount: supportMatches.filter((match) => Number.isFinite(match.transformX.slope) && Number.isFinite(match.transformX.intercept)).length,
    },
    transformY: {
      slopeMedian: median(supportMatches.map((match) => match.transformY.slope).filter(Number.isFinite)),
      interceptMedian: median(supportMatches.map((match) => match.transformY.intercept).filter(Number.isFinite)),
      sampleCount: supportMatches.filter((match) => Number.isFinite(match.transformY.slope) && Number.isFinite(match.transformY.intercept)).length,
    },
    supportMatches: supportMatches.slice(0, 8),
  };
}

function buildPatternSummary(patternKey, candidates) {
  const bestByParticipant = new Map();
  for (const match of candidates.flatMap((candidate) => candidate.supportMatches)) {
    const current = bestByParticipant.get(match.participantId);
    if (!current || match.effectiveScore > current.effectiveScore) {
      bestByParticipant.set(match.participantId, match);
    }
  }

  const supportMatches = [...bestByParticipant.values()].sort((left, right) => right.effectiveScore - left.effectiveScore);
  const slotIndices = candidates.map((candidate) => candidate.slotIndex);
  const participantIds = [...new Set(supportMatches.map((match) => match.participantId))];
  const averageAxisCorrelation = supportMatches.reduce((sum, match) => sum + ((match.xCorrelation + match.yCorrelation) / 2), 0) / Math.max(supportMatches.length, 1);
  const averagePathCorrelation = supportMatches.reduce((sum, match) => sum + match.pathCorrelation, 0) / Math.max(supportMatches.length, 1);
  const averageNormalizedDistanceRmse = supportMatches.reduce((sum, match) => sum + match.normalizedDistanceRmse, 0) / Math.max(supportMatches.length, 1);
  const averageValidatorScore = supportMatches.reduce((sum, match) => sum + match.validatorScore, 0) / Math.max(supportMatches.length, 1);
  const averageEffectiveScore = supportMatches.reduce((sum, match) => sum + match.effectiveScore, 0) / Math.max(supportMatches.length, 1);
  const confidence =
    averageEffectiveScore *
    (0.5 + Math.min(1, candidates.length / 3)) *
    (0.5 + Math.min(1, participantIds.length / 4)) *
    (0.5 + averageValidatorScore);

  const exemplar = candidates[0];
  return {
    patternKey,
    familyKey: exemplar.familyKey,
    family: `${exemplar.familyLength} / 0x${exemplar.familyFirstByte.toString(16).toUpperCase().padStart(2, "0")}`,
    familyLength: exemplar.familyLength,
    familyFirstByte: exemplar.familyFirstByte,
    rowArchetype: exemplar.rowArchetype,
    rowBand: [Math.min(...slotIndices), Math.max(...slotIndices)],
    xField: {
      offset: exemplar.leftOffset,
      decode: exemplar.leftDecodeLabel,
    },
    yField: {
      offset: exemplar.rightOffset,
      decode: exemplar.rightDecodeLabel,
    },
    mapping: exemplar.mapping,
    transformX: {
      slopeMedian: median(supportMatches.map((match) => match.transformX.slope).filter(Number.isFinite)),
      interceptMedian: median(supportMatches.map((match) => match.transformX.intercept).filter(Number.isFinite)),
      sampleCount: supportMatches.filter((match) => Number.isFinite(match.transformX.slope) && Number.isFinite(match.transformX.intercept)).length,
    },
    transformY: {
      slopeMedian: median(supportMatches.map((match) => match.transformY.slope).filter(Number.isFinite)),
      interceptMedian: median(supportMatches.map((match) => match.transformY.intercept).filter(Number.isFinite)),
      sampleCount: supportMatches.filter((match) => Number.isFinite(match.transformY.slope) && Number.isFinite(match.transformY.intercept)).length,
    },
    confidence,
    support: {
      replays: 1,
      participants: participantIds.length,
      rows: new Set(slotIndices).size,
      avgAxisCorrelation: averageAxisCorrelation,
      avgPathCorrelation: averagePathCorrelation,
      avgNormalizedDistanceRmse: averageNormalizedDistanceRmse,
      avgValidatorScore: averageValidatorScore,
      avgEffectiveScore: averageEffectiveScore,
    },
    rawPairCandidates: candidates.map((candidate) => ({
      slotIndex: candidate.slotIndex,
      rawPairKey: candidate.rawPairKey,
      participantIds: candidate.participantIds,
      champions: candidate.champions,
      aggregateScore: candidate.aggregateScore,
      averageAxisCorrelation: candidate.averageAxisCorrelation,
      averagePathCorrelation: candidate.averagePathCorrelation,
      averageNormalizedDistanceRmse: candidate.averageNormalizedDistanceRmse,
      transformX: candidate.transformX,
      transformY: candidate.transformY,
    })),
    participantHits: supportMatches.slice(0, 32).map((match) => ({
      participantId: match.participantId,
      champion: match.champion,
      teamId: match.teamId,
      teamPosition: match.teamPosition,
      slotIndex: match.slotIndex,
      xCorrelation: match.xCorrelation,
      yCorrelation: match.yCorrelation,
      pathCorrelation: match.pathCorrelation,
      normalizedDistanceRmse: match.normalizedDistanceRmse,
      effectiveScore: match.effectiveScore,
    })),
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const outputDir = args.outputDir ? resolveAbsolute(repoRoot, args.outputDir) : artifactDir;
  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  if (!fs.existsSync(runManifestPath)) {
    throw new Error(`Run manifest not found at ${runManifestPath}`);
  }

  const runManifest = readJson(runManifestPath);
  const replayId = runManifest.replayId;
  const inferredFixtureDir = path.join(repoRoot, "replays", "api", replayId.replace(/-/g, "_"));
  const fixtureDir = args.fixtureDir ? resolveAbsolute(repoRoot, args.fixtureDir) : inferredFixtureDir;
  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    throw new Error(`Riot fixture bundle not found under ${fixtureDir}`);
  }

  const matchJson = readJson(matchPath);
  const timelineJson = readJson(timelinePath);
  const { participants, positionSeriesByParticipant } = buildPositionSeries(matchJson, timelineJson);
  const familySummaries = loadFamilySummaries(artifactDir, runManifest);

  const allMatches = [];
  for (const familySummary of familySummaries) {
    for (const slotSummary of familySummary.cleaned.slots ?? []) {
      const fieldCandidates = (slotSummary.fields ?? [])
        .map((field) => buildFieldCandidate(familySummary, slotSummary, field))
        .filter(Boolean);
      if (fieldCandidates.length < 2) {
        continue;
      }

      const pairCandidates = buildPairCandidates(
        familySummary,
        slotSummary,
        fieldCandidates,
        args.maxPairsPerSlot,
        args.minOverlap,
      );

      for (const pairCandidate of pairCandidates) {
        for (const participant of participants) {
          const targetSeries = positionSeriesByParticipant.get(participant.participantId) ?? [];
          if (targetSeries.length < args.minOverlap) {
            continue;
          }
          const match = comparePairToParticipant(pairCandidate, participant, buildMovementTargets(targetSeries));
          if (match) {
            allMatches.push(match);
          }
        }
      }
    }
  }

  allMatches.sort((left, right) =>
    right.effectiveScore - left.effectiveScore ||
    left.normalizedDistanceRmse - right.normalizedDistanceRmse ||
    right.xCorrelation - left.xCorrelation,
  );

  const rawPairGroups = new Map();
  for (const match of allMatches) {
    const rawPairKey = [
      match.familyKey,
      match.slotIndex,
      match.leftOffset,
      match.leftDecodeLabel,
      match.rightOffset,
      match.rightDecodeLabel,
      match.mapping,
    ].join("|");
    const list = rawPairGroups.get(rawPairKey) ?? [];
    list.push(match);
    rawPairGroups.set(rawPairKey, list);
  }

  const rawPairCandidates = [];
  for (const [rawPairKey, matches] of rawPairGroups.entries()) {
    const summary = summarizeRawPair(rawPairKey, matches);
    if (summary) {
      rawPairCandidates.push(summary);
    }
  }
  rawPairCandidates.sort((left, right) => right.aggregateScore - left.aggregateScore);

  const patternGroups = new Map();
  for (const candidate of rawPairCandidates) {
    const patternKey = [
      candidate.familyKey,
      candidate.leftOffset,
      candidate.leftDecodeLabel,
      candidate.rightOffset,
      candidate.rightDecodeLabel,
      candidate.mapping,
    ].join("|");
    const list = patternGroups.get(patternKey) ?? [];
    list.push(candidate);
    patternGroups.set(patternKey, list);
  }

  const rankedPatterns = [...patternGroups.entries()]
    .map(([patternKey, candidates]) => buildPatternSummary(patternKey, candidates))
    .sort((left, right) =>
      right.confidence - left.confidence ||
      left.support.avgNormalizedDistanceRmse - right.support.avgNormalizedDistanceRmse,
    );

  const promotedPatterns = rankedPatterns.filter((pattern) =>
    pattern.support.rows >= 2 &&
    pattern.support.participants >= 4 &&
    pattern.support.avgAxisCorrelation >= 0.45 &&
    pattern.support.avgNormalizedDistanceRmse <= 0.2 &&
    pattern.support.avgValidatorScore >= 0.55,
  );

  const candidateMatchesReport = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    fixtureDir,
    summary: {
      totalMatches: allMatches.length,
      rawPairCount: rawPairCandidates.length,
      patternCount: rankedPatterns.length,
      promotedPatternCount: promotedPatterns.length,
    },
    rawPairCandidates,
    topMatches: allMatches.slice(0, args.topMatches),
  };

  const provisionalSchema = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    source: {
      artifactDir,
      fixtureDir,
      familyCount: familySummaries.length,
    },
    thresholds: {
      minRows: 2,
      minParticipants: 4,
      minAverageAxisCorrelation: 0.45,
      maxAverageNormalizedDistanceRmse: 0.2,
      minAverageValidatorScore: 0.55,
    },
    promotedPatterns,
    rankedPatterns: rankedPatterns.slice(0, 128),
  };

  writeJson(path.join(outputDir, "movement-candidate-matches.json"), candidateMatchesReport);
  writeJson(path.join(outputDir, "movement-provisional-schema.json"), provisionalSchema);

  console.log(`Wrote movement candidate matches to ${path.join(outputDir, "movement-candidate-matches.json")}`);
  console.log(`Wrote movement provisional schema to ${path.join(outputDir, "movement-provisional-schema.json")}`);
  console.log(`Promoted ${promotedPatterns.length} movement patterns from ${rankedPatterns.length} ranked patterns.`);
}

main();
