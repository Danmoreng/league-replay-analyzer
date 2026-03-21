import fs from "fs";
import path from "path";

const metricDefinitions = [
  { key: "level", label: "Level", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 0.9, minOverlap: 6, read: (frame) => frame.level ?? null },
  { key: "currentGold", label: "Current Gold", monotonic: false, minCorrelation: 0.4, maxNormalizedRmse: 1.1, minOverlap: 6, read: (frame) => frame.currentGold ?? null },
  { key: "totalGold", label: "Total Gold", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 1.0, minOverlap: 6, read: (frame) => frame.totalGold ?? null },
  { key: "xp", label: "XP", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 1.0, minOverlap: 6, read: (frame) => frame.xp ?? null },
  { key: "minionsKilled", label: "CS", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 1.0, minOverlap: 6, read: (frame) => frame.minionsKilled ?? null },
  { key: "jungleMinionsKilled", label: "Jungle CS", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 1.0, minOverlap: 6, read: (frame) => frame.jungleMinionsKilled ?? null },
  { key: "health", label: "Health", monotonic: false, minCorrelation: 0.4, maxNormalizedRmse: 1.1, minOverlap: 6, read: (frame) => frame.championStats?.health ?? null },
  { key: "healthMax", label: "Max Health", monotonic: true, minCorrelation: 0.45, maxNormalizedRmse: 1.0, minOverlap: 6, read: (frame) => frame.championStats?.healthMax ?? null },
  { key: "power", label: "Power", monotonic: false, minCorrelation: 0.35, maxNormalizedRmse: 1.15, minOverlap: 6, read: (frame) => frame.championStats?.power ?? null },
  { key: "powerMax", label: "Max Power", monotonic: true, minCorrelation: 0.4, maxNormalizedRmse: 1.05, minOverlap: 6, read: (frame) => frame.championStats?.powerMax ?? null },
  { key: "movementSpeed", label: "Move Speed", monotonic: false, minCorrelation: 0.35, maxNormalizedRmse: 1.2, minOverlap: 6, read: (frame) => frame.championStats?.movementSpeed ?? null },
];

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    fixtureDir: null,
    outputDir: null,
    minPatternRows: 2,
    minPatternParticipants: 2,
    topMatches: 256,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-dir" && index + 1 < argv.length) {
      args.outputDir = argv[++index];
    } else if (arg === "--min-pattern-rows" && index + 1 < argv.length) {
      args.minPatternRows = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-pattern-participants" && index + 1 < argv.length) {
      args.minPatternParticipants = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-matches" && index + 1 < argv.length) {
      args.topMatches = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/build_provisional_schema.mjs --artifact-dir <path> [--fixture-dir <path>] [--output-dir <path>]");
}

function resolveAbsolute(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath);
}

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => {
    const delta = value - mean;
    return sum + (delta * delta);
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function pearsonCorrelation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 3) {
    return 0;
  }

  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < length; index += 1) {
    sumLeft += left[index];
    sumRight += right[index];
  }
  const meanLeft = sumLeft / length;
  const meanRight = sumRight / length;

  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < length; index += 1) {
    const leftDelta = left[index] - meanLeft;
    const rightDelta = right[index] - meanRight;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  if (leftVariance <= 1e-9 || rightVariance <= 1e-9) {
    return 0;
  }

  return numerator / Math.sqrt(leftVariance * rightVariance);
}

function fitAffine1D(rawValues, targetValues) {
  const length = Math.min(rawValues.length, targetValues.length);
  if (length < 3) {
    return { valid: false, slope: 0, intercept: 0, rmse: Number.POSITIVE_INFINITY };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let index = 0; index < length; index += 1) {
    const x = rawValues[index];
    const y = targetValues[index];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denominator = (length * sumXX) - (sumX * sumX);
  if (Math.abs(denominator) < 1e-9) {
    const intercept = sumY / length;
    let squaredError = 0;
    for (let index = 0; index < length; index += 1) {
      const error = intercept - targetValues[index];
      squaredError += error * error;
    }
    return {
      valid: false,
      slope: 0,
      intercept,
      rmse: Math.sqrt(squaredError / length),
    };
  }

  const slope = ((length * sumXY) - (sumX * sumY)) / denominator;
  const intercept = (sumY - (slope * sumX)) / length;
  let squaredError = 0;
  for (let index = 0; index < length; index += 1) {
    const predicted = (slope * rawValues[index]) + intercept;
    const error = predicted - targetValues[index];
    squaredError += error * error;
  }

  return {
    valid: true,
    slope,
    intercept,
    rmse: Math.sqrt(squaredError / length),
  };
}

function interpolate(points, timestamp) {
  if (points.length === 0) {
    return null;
  }
  if (timestamp <= points[0].timestamp) {
    return points[0].value;
  }
  if (timestamp >= points[points.length - 1].timestamp) {
    return points[points.length - 1].value;
  }

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (timestamp > right.timestamp) {
      continue;
    }
    const span = right.timestamp - left.timestamp;
    if (span <= 0) {
      return right.value;
    }
    const t = (timestamp - left.timestamp) / span;
    return left.value + ((right.value - left.value) * t);
  }

  return points[points.length - 1]?.value ?? null;
}

function buildMetricSeries(matchJson, timelineJson) {
  const participants = matchJson.info.participants.map((participant) => ({
    participantId: participant.participantId,
    champion: participant.championName,
    teamId: participant.teamId,
  }));

  const metricSeriesByParticipant = new Map();
  for (const participant of participants) {
    metricSeriesByParticipant.set(participant.participantId, new Map());
  }

  for (const frame of timelineJson.info.frames) {
    const participantFrames = frame.participantFrames ?? {};
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      const participantId = Number.parseInt(rawParticipantId, 10);
      const targetMap = metricSeriesByParticipant.get(participantId);
      if (!targetMap) {
        continue;
      }
      for (const metric of metricDefinitions) {
        const value = metric.read(participantFrame);
        if (value == null || !Number.isFinite(value)) {
          continue;
        }
        const list = targetMap.get(metric.key) ?? [];
        list.push({ timestamp: frame.timestamp, value });
        targetMap.set(metric.key, list);
      }
    }
  }

  return { participants, metricSeriesByParticipant };
}

function buildFieldCandidate(familySummary, slotSummary, field) {
  const points = [];
  for (const sample of field.samples ?? []) {
    if (!Number.isFinite(sample.decoded)) {
      continue;
    }
    points.push({ timestamp: sample.timestamp, value: sample.decoded });
  }

  if (points.length < 6) {
    return null;
  }

  return {
    familyKey: familySummary.familyKey,
    familyLength: familySummary.length,
    familyFirstByte: familySummary.firstByte,
    headerSize: familySummary.headerSize,
    stride: familySummary.stride,
    slotIndex: slotSummary.slotIndex,
    rowArchetype: familySummary.slotArchetypeBySlot.get(slotSummary.slotIndex) ?? "unknown",
    offset: field.offset,
    width: field.width,
    decodeLabel: field.decodeLabel,
    activeSamples: field.activeSamples,
    uniqueValues: field.uniqueValues,
    changedTransitions: field.changedTransitions,
    sourceScore: field.score,
    points,
  };
}

function compareCandidateToMetric(candidate, participant, metric, targetPoints) {
  if (candidate.points.length < metric.minOverlap || targetPoints.length < 3) {
    return null;
  }

  const rawValues = [];
  const targetValues = [];
  for (const point of candidate.points) {
    const target = interpolate(targetPoints, point.timestamp);
    if (target == null || !Number.isFinite(target)) {
      continue;
    }
    rawValues.push(point.value);
    targetValues.push(target);
  }

  const overlap = rawValues.length;
  if (overlap < metric.minOverlap) {
    return null;
  }

  const fit = fitAffine1D(rawValues, targetValues);
  if (!Number.isFinite(fit.rmse)) {
    return null;
  }

  const predictedValues = rawValues.map((value) => (fit.slope * value) + fit.intercept);
  const predictedDiffs = [];
  const targetDiffs = [];
  for (let index = 1; index < predictedValues.length; index += 1) {
    predictedDiffs.push(predictedValues[index] - predictedValues[index - 1]);
    targetDiffs.push(targetValues[index] - targetValues[index - 1]);
  }

  const correlation = pearsonCorrelation(predictedValues, targetValues);
  const deltaCorrelation = pearsonCorrelation(predictedDiffs, targetDiffs);
  const targetStdDev = standardDeviation(targetValues);
  const normalizedRmse = fit.rmse / Math.max(targetStdDev, 1);

  let monotonicAgreement = 1;
  if (metric.monotonic && targetDiffs.length > 0) {
    let agreements = 0;
    for (let index = 0; index < targetDiffs.length; index += 1) {
      const targetDelta = targetDiffs[index];
      const predictedDelta = predictedDiffs[index];
      const sameDirection = (targetDelta >= -1e-6 && predictedDelta >= -1e-6) || (targetDelta <= 1e-6 && predictedDelta <= 1e-6);
      if (sameDirection) {
        agreements += 1;
      }
    }
    monotonicAgreement = agreements / targetDiffs.length;
  }

  const overlapFactor = Math.min(1, overlap / 16);
  const uniqueFactor = Math.min(1, candidate.uniqueValues / 12);
  const rmseFactor = 1 / (1 + normalizedRmse);
  const correlationFactor = clamp(correlation, 0, 1);
  const deltaFactor = clamp(Number.isFinite(deltaCorrelation) ? deltaCorrelation : 0, 0, 1);
  const monotonicFactor = metric.monotonic ? monotonicAgreement : 0.75;
  const slopeFactor = metric.monotonic && fit.slope < 0 ? 0.2 : 1;
  const baseScore = overlapFactor * uniqueFactor * rmseFactor * ((0.5 * correlationFactor) + (0.2 * deltaFactor) + (0.3 * monotonicFactor)) * slopeFactor;

  let validatorScore = 1;
  if (correlation < metric.minCorrelation) {
    validatorScore *= clamp(correlation / Math.max(metric.minCorrelation, 1e-6), 0, 1);
  }
  if (normalizedRmse > metric.maxNormalizedRmse) {
    validatorScore *= clamp(metric.maxNormalizedRmse / Math.max(normalizedRmse, 1e-6), 0, 1);
  }
  if (metric.monotonic && fit.slope < 0) {
    validatorScore *= 0.2;
  }
  if (metric.key === "level" && candidate.uniqueValues > 32) {
    validatorScore *= 0.7;
  }
  if ((metric.key === "minionsKilled" || metric.key === "jungleMinionsKilled") && deltaCorrelation < 0.1) {
    validatorScore *= 0.7;
  }

  const effectiveScore = baseScore * validatorScore;
  const passesValidation =
    overlap >= metric.minOverlap &&
    correlation >= metric.minCorrelation &&
    normalizedRmse <= metric.maxNormalizedRmse &&
    (!metric.monotonic || fit.slope >= 0);

  return {
    familyKey: candidate.familyKey,
    familyLength: candidate.familyLength,
    familyFirstByte: candidate.familyFirstByte,
    slotIndex: candidate.slotIndex,
    rowArchetype: candidate.rowArchetype,
    offset: candidate.offset,
    width: candidate.width,
    decodeLabel: candidate.decodeLabel,
    participantId: participant.participantId,
    champion: participant.champion,
    teamId: participant.teamId,
    metricKey: metric.key,
    metricLabel: metric.label,
    overlap,
    uniqueValues: candidate.uniqueValues,
    changedTransitions: candidate.changedTransitions,
    correlation,
    deltaCorrelation,
    affineRmse: fit.rmse,
    normalizedRmse,
    slope: fit.slope,
    intercept: fit.intercept,
    baseScore,
    validatorScore,
    effectiveScore,
    passesValidation,
  };
}

function loadFamilySummaries(artifactDir, runManifest) {
  return runManifest.families.map((family) => {
    const familyDir = path.join(artifactDir, "families", family.familyKey);
    const cleanedPath = path.join(familyDir, "cleaned.json");
    const entitySlabPath = path.join(familyDir, "entity-slab.json");
    const cleaned = fs.existsSync(cleanedPath) ? readJson(cleanedPath) : null;
    const entitySlab = fs.existsSync(entitySlabPath) ? readJson(entitySlabPath) : null;

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
      familyDir,
      cleaned,
      entitySlab,
      slotArchetypeBySlot,
    };
  });
}

function summarizeRawWindow(windowKey, matches) {
  const matchesByMetricDecode = new Map();
  for (const match of matches) {
    const key = `${match.metricKey}|${match.decodeLabel}`;
    const list = matchesByMetricDecode.get(key) ?? [];
    list.push(match);
    matchesByMetricDecode.set(key, list);
  }

  let bestAggregate = null;
  for (const [metricDecodeKey, metricMatches] of matchesByMetricDecode.entries()) {
    const bestByParticipant = new Map();
    for (const match of metricMatches) {
      const current = bestByParticipant.get(match.participantId);
      if (!current || match.effectiveScore > current.effectiveScore) {
        bestByParticipant.set(match.participantId, match);
      }
    }

    const supportMatches = Array.from(bestByParticipant.values()).sort((left, right) => right.effectiveScore - left.effectiveScore);
    if (supportMatches.length === 0) {
      continue;
    }

    const averageCorrelation = supportMatches.reduce((sum, match) => sum + match.correlation, 0) / supportMatches.length;
    const averageNormalizedRmse = supportMatches.reduce((sum, match) => sum + match.normalizedRmse, 0) / supportMatches.length;
    const averageValidatorScore = supportMatches.reduce((sum, match) => sum + match.validatorScore, 0) / supportMatches.length;
    const averageEffectiveScore = supportMatches.reduce((sum, match) => sum + match.effectiveScore, 0) / supportMatches.length;
    const passCount = supportMatches.filter((match) => match.passesValidation).length;
    const participantSupportFactor = Math.min(1, supportMatches.length / 4);
    const aggregateScore = averageEffectiveScore * (0.5 + participantSupportFactor) * (0.5 + (passCount / supportMatches.length));

    const [metricKey, decodeLabel] = metricDecodeKey.split("|");
    const exemplar = supportMatches[0];
    const aggregate = {
      rawWindowKey: windowKey,
      familyKey: exemplar.familyKey,
      slotIndex: exemplar.slotIndex,
      rowArchetype: exemplar.rowArchetype,
      offset: exemplar.offset,
      width: exemplar.width,
      decodeLabel,
      metricKey,
      metricLabel: exemplar.metricLabel,
      participantIds: supportMatches.map((match) => match.participantId),
      champions: supportMatches.map((match) => match.champion),
      supportMatches,
      passCount,
      averageCorrelation,
      averageNormalizedRmse,
      averageValidatorScore,
      averageEffectiveScore,
      aggregateScore,
    };

    if (!bestAggregate || aggregate.aggregateScore > bestAggregate.aggregateScore) {
      bestAggregate = aggregate;
    }
  }

  return bestAggregate;
}

function buildPatternSummary(patternKey, candidates) {
  const bestMatchByParticipant = new Map();
  for (const match of candidates.flatMap((candidate) => candidate.supportMatches)) {
    const current = bestMatchByParticipant.get(match.participantId);
    if (!current || match.effectiveScore > current.effectiveScore) {
      bestMatchByParticipant.set(match.participantId, match);
    }
  }

  const supportMatches = Array.from(bestMatchByParticipant.values()).sort((left, right) => right.effectiveScore - left.effectiveScore);
  const slotIndices = candidates.map((candidate) => candidate.slotIndex);
  const participantIds = new Set(supportMatches.map((match) => match.participantId));
  const averageCorrelation = supportMatches.reduce((sum, match) => sum + match.correlation, 0) / Math.max(supportMatches.length, 1);
  const averageNormalizedRmse = supportMatches.reduce((sum, match) => sum + match.normalizedRmse, 0) / Math.max(supportMatches.length, 1);
  const averageValidatorScore = supportMatches.reduce((sum, match) => sum + match.validatorScore, 0) / Math.max(supportMatches.length, 1);
  const averageEffectiveScore = supportMatches.reduce((sum, match) => sum + match.effectiveScore, 0) / Math.max(supportMatches.length, 1);
  const dominantArchetype = [...new Set(candidates.map((candidate) => candidate.rowArchetype))].sort((left, right) => {
    const leftCount = candidates.filter((candidate) => candidate.rowArchetype === left).length;
    const rightCount = candidates.filter((candidate) => candidate.rowArchetype === right).length;
    return rightCount - leftCount;
  })[0] ?? "unknown";

  const confidence =
    averageEffectiveScore *
    (0.5 + Math.min(1, candidates.length / 3)) *
    (0.5 + Math.min(1, participantIds.size / 4)) *
    (0.5 + averageValidatorScore);

  const exemplar = candidates[0];
  const familyLabel = `${exemplar.familyLength} / 0x${exemplar.familyFirstByte.toString(16).toUpperCase().padStart(2, "0")}`;

  return {
    patternKey,
    familyKey: exemplar.familyKey,
    family: familyLabel,
    familyLength: exemplar.familyLength,
    familyFirstByte: exemplar.familyFirstByte,
    rowArchetype: dominantArchetype,
    rowBand: [Math.min(...slotIndices), Math.max(...slotIndices)],
    offset: exemplar.offset,
    width: exemplar.width,
    decode: exemplar.decode,
    metric: exemplar.metric,
    metricLabel: exemplar.metricLabel,
    confidence,
    support: {
      replays: 1,
      participants: participantIds.size,
      rows: new Set(slotIndices).size,
      avgCorrelation: averageCorrelation,
      avgNormalizedRmse: averageNormalizedRmse,
      avgValidatorScore: averageValidatorScore,
      avgEffectiveScore: averageEffectiveScore,
    },
    rawWindowCandidates: candidates.map((candidate) => ({
      slotIndex: candidate.slotIndex,
      rawWindowKey: candidate.rawWindowKey,
      participantIds: candidate.participantIds,
      champions: candidate.champions,
      aggregateScore: candidate.aggregateScore,
      averageCorrelation: candidate.averageCorrelation,
      averageNormalizedRmse: candidate.averageNormalizedRmse,
    })),
    participantHits: supportMatches
      .sort((left, right) => right.effectiveScore - left.effectiveScore)
      .slice(0, 32)
      .map((match) => ({
        participantId: match.participantId,
        champion: match.champion,
        teamId: match.teamId,
        slotIndex: match.slotIndex,
        correlation: match.correlation,
        normalizedRmse: match.normalizedRmse,
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
  const { participants, metricSeriesByParticipant } = buildMetricSeries(matchJson, timelineJson);
  const participantById = new Map(participants.map((participant) => [participant.participantId, participant]));

  const familySummaries = loadFamilySummaries(artifactDir, runManifest);

  const allMatches = [];
  for (const familySummary of familySummaries) {
    if (!familySummary.cleaned?.slots) {
      continue;
    }

    for (const slotSummary of familySummary.cleaned.slots) {
      for (const field of slotSummary.fields ?? []) {
        const candidate = buildFieldCandidate(familySummary, slotSummary, field);
        if (!candidate) {
          continue;
        }

        for (const participant of participants) {
          const metricSeries = metricSeriesByParticipant.get(participant.participantId);
          if (!metricSeries) {
            continue;
          }

          for (const metric of metricDefinitions) {
            const targetPoints = metricSeries.get(metric.key) ?? [];
            const match = compareCandidateToMetric(candidate, participant, metric, targetPoints);
            if (match) {
              allMatches.push(match);
            }
          }
        }
      }
    }
  }

  allMatches.sort((left, right) => right.effectiveScore - left.effectiveScore || left.normalizedRmse - right.normalizedRmse || right.correlation - left.correlation);

  const rawWindowGroups = new Map();
  for (const match of allMatches) {
    const key = `${match.familyKey}|${match.slotIndex}|${match.offset}`;
    const list = rawWindowGroups.get(key) ?? [];
    list.push(match);
    rawWindowGroups.set(key, list);
  }

  const rawWindowCandidates = [];
  for (const [rawWindowKey, matches] of rawWindowGroups.entries()) {
    const bestAggregate = summarizeRawWindow(rawWindowKey, matches);
    if (!bestAggregate) {
      continue;
    }
    const participantDetails = bestAggregate.participantIds.map((participantId) => participantById.get(participantId)).filter(Boolean);
    rawWindowCandidates.push({
      familyKey: bestAggregate.familyKey,
      slotIndex: bestAggregate.slotIndex,
      rowArchetype: bestAggregate.rowArchetype,
      offset: bestAggregate.offset,
      width: bestAggregate.width,
      decode: bestAggregate.decodeLabel,
      metric: bestAggregate.metricKey,
      metricLabel: bestAggregate.metricLabel,
      rawWindowKey: bestAggregate.rawWindowKey,
      familyLength: bestAggregate.supportMatches[0]?.familyLength,
      familyFirstByte: bestAggregate.supportMatches[0]?.familyFirstByte,
      participantIds: bestAggregate.participantIds,
      champions: participantDetails.map((participant) => participant.champion),
      passCount: bestAggregate.passCount,
      averageCorrelation: bestAggregate.averageCorrelation,
      averageNormalizedRmse: bestAggregate.averageNormalizedRmse,
      averageValidatorScore: bestAggregate.averageValidatorScore,
      averageEffectiveScore: bestAggregate.averageEffectiveScore,
      aggregateScore: bestAggregate.aggregateScore,
      supportMatches: bestAggregate.supportMatches
        .slice(0, 8)
        .map((match) => ({
          participantId: match.participantId,
          champion: match.champion,
          correlation: match.correlation,
          normalizedRmse: match.normalizedRmse,
          validatorScore: match.validatorScore,
          effectiveScore: match.effectiveScore,
          passesValidation: match.passesValidation,
        })),
    });
  }

  rawWindowCandidates.sort((left, right) => right.aggregateScore - left.aggregateScore);

  const patternGroups = new Map();
  for (const candidate of rawWindowCandidates) {
    const patternKey = `${candidate.familyKey}|${candidate.offset}|${candidate.decode}|${candidate.metric}`;
    const list = patternGroups.get(patternKey) ?? [];
    list.push(candidate);
    patternGroups.set(patternKey, list);
  }

  const rankedPatterns = [];
  for (const [patternKey, candidates] of patternGroups.entries()) {
    rankedPatterns.push(buildPatternSummary(patternKey, candidates));
  }

  rankedPatterns.sort((left, right) => right.confidence - left.confidence || left.support.avgNormalizedRmse - right.support.avgNormalizedRmse);

  const promotedPatterns = rankedPatterns.filter((pattern) =>
    pattern.support.rows >= args.minPatternRows &&
    pattern.support.participants >= args.minPatternParticipants &&
    pattern.support.avgCorrelation >= 0.5 &&
    pattern.support.avgNormalizedRmse <= 1.0 &&
    pattern.support.avgValidatorScore >= 0.6,
  );

  const candidateMatchesReport = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    fixtureDir,
    summary: {
      totalMatches: allMatches.length,
      rawWindowCount: rawWindowCandidates.length,
      patternCount: rankedPatterns.length,
      promotedPatternCount: promotedPatterns.length,
    },
    rawWindowCandidates,
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
      minPatternRows: args.minPatternRows,
      minPatternParticipants: args.minPatternParticipants,
      minAverageCorrelation: 0.5,
      maxAverageNormalizedRmse: 1.0,
      minAverageValidatorScore: 0.6,
    },
    promotedPatterns,
    rankedPatterns: rankedPatterns.slice(0, 128),
  };

  writeJson(path.join(outputDir, "candidate-matches.json"), candidateMatchesReport);
  writeJson(path.join(outputDir, "provisional-schema.json"), provisionalSchema);

  console.log(`Wrote candidate matches to ${path.join(outputDir, "candidate-matches.json")}`);
  console.log(`Wrote provisional schema to ${path.join(outputDir, "provisional-schema.json")}`);
  console.log(`Promoted ${promotedPatterns.length} patterns from ${rankedPatterns.length} ranked patterns.`);
}

main();
