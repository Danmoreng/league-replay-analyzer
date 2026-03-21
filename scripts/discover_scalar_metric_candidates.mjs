import fs from "fs";
import path from "path";

import {
  average,
  buildMetricSeries,
  clamp,
  fitAffine1D,
  interpolate,
  median,
  metricDefinitionByKey,
  metricDefinitions,
  parseVersionGroup,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  standardDeviation,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    corpusManifest: null,
    outputPath: null,
    versionGroup: null,
    metric: null,
    maxTopMatches: 256,
    maxReplayCandidates: 128,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--corpus-manifest" && index + 1 < argv.length) {
      args.corpusManifest = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--metric" && index + 1 < argv.length) {
      args.metric = argv[++index];
    } else if (arg === "--max-top-matches" && index + 1 < argv.length) {
      args.maxTopMatches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-replay-candidates" && index + 1 < argv.length) {
      args.maxReplayCandidates = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.versionGroup) {
    throw new Error("Missing required --version-group <value> argument.");
  }
  if (!args.metric) {
    throw new Error("Missing required --metric <key> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/discover_scalar_metric_candidates.mjs --version-group <value> --metric <key> [--artifact-root <path>] [--corpus-manifest <path>] [--output-path <path>]");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  if (separatorIndex < 0) {
    return replayId;
  }
  return `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function buildConfusionMetricKeys(metricKey) {
  const defaultKeys = ["level", "currentGold", "totalGold", "xp", "minionsKilled", "jungleMinionsKilled"];
  switch (metricKey) {
    case "health":
      return [...defaultKeys, "healthMax", "power", "movementSpeed"];
    case "healthMax":
      return [...defaultKeys, "health", "powerMax", "movementSpeed"];
    case "power":
      return [...defaultKeys, "powerMax", "health", "movementSpeed"];
    case "powerMax":
      return [...defaultKeys, "power", "healthMax", "movementSpeed"];
    case "movementSpeed":
      return [...defaultKeys, "health", "power"];
    default:
      return defaultKeys.filter((key) => key !== metricKey);
  }
}

function buildFamilyBandKey(versionGroup, candidate) {
  const lengthBand = Math.floor((candidate.familyLength ?? 0) / 4096) * 4;
  const firstByte = Number.isFinite(candidate.familyFirstByte)
    ? candidate.familyFirstByte.toString(16).toUpperCase().padStart(2, "0")
    : "??";
  return `${versionGroup}|0x${firstByte}|${lengthBand}k|${candidate.rowArchetype}|${candidate.offset}|${candidate.decodeLabel}`;
}

function getSlotArchetype(family, slotIndex) {
  if ((family.dynamicSlots ?? []).includes(slotIndex)) {
    return "dynamic_state_like";
  }
  if ((family.mixedSlots ?? []).includes(slotIndex)) {
    return "mixed";
  }
  if ((family.handleSlots ?? []).includes(slotIndex)) {
    return "static_handle_like";
  }
  return "unknown";
}

function buildFieldCandidate(family, slot, field) {
  const points = (field.samples ?? [])
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.decoded))
    .map((sample) => ({
      timestamp: sample.timestamp,
      value: sample.decoded,
    }));

  if (points.length < 6) {
    return null;
  }

  return {
    familyKey: family.familyKey,
    familyLength: family.length,
    familyFirstByte: family.firstByte,
    headerSize: family.headerSize,
    stride: family.stride,
    slotIndex: slot.slotIndex,
    rowArchetype: getSlotArchetype(family, slot.slotIndex),
    offset: field.offset,
    width: field.width,
    decodeLabel: field.decodeLabel,
    activeSamples: field.activeSamples ?? points.length,
    uniqueValues: field.uniqueValues ?? 0,
    changedTransitions: field.changedTransitions ?? 0,
    increasingTransitions: field.increasingTransitions ?? 0,
    decreasingTransitions: field.decreasingTransitions ?? 0,
    stableTransitions: field.stableTransitions ?? 0,
    monotonicRatio: field.monotonicRatio ?? 0,
    directionHint: field.directionHint ?? "unknown",
    sourceScore: field.score ?? 0,
    points,
  };
}

function compareCandidateToMetric(candidate, participant, metric, targetPoints) {
  if (candidate.points.length < metric.minOverlap || targetPoints.length < metric.minOverlap) {
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

  if (rawValues.length < metric.minOverlap) {
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

  const overlap = rawValues.length;
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

  const nonMonotonicMetrics = new Set(["health", "power", "movementSpeed"]);
  const boundedMaxMetrics = new Set(["healthMax", "powerMax"]);
  if (nonMonotonicMetrics.has(metric.key)) {
    if ((candidate.monotonicRatio ?? 0) > 0.95) {
      validatorScore *= 0.45;
    } else if ((candidate.monotonicRatio ?? 0) > 0.85) {
      validatorScore *= 0.7;
    }
    if ((candidate.changedTransitions ?? 0) < 4) {
      validatorScore *= 0.7;
    }
    if (deltaCorrelation < 0.12) {
      validatorScore *= 0.75;
    }
  }
  if (boundedMaxMetrics.has(metric.key)) {
    if (fit.slope < 0) {
      validatorScore *= 0.35;
    }
    if ((candidate.uniqueValues ?? 0) < 3) {
      validatorScore *= 0.6;
    }
  }
  if (metric.key === "movementSpeed" && deltaCorrelation < 0.08) {
    validatorScore *= 0.7;
  }

  const effectiveScore = baseScore * validatorScore;
  const passesValidation =
    overlap >= metric.minOverlap &&
    correlation >= metric.minCorrelation &&
    normalizedRmse <= metric.maxNormalizedRmse &&
    validatorScore >= 0.45 &&
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
    teamPosition: participant.teamPosition,
    overlap,
    correlation,
    deltaCorrelation,
    normalizedRmse,
    slope: fit.slope,
    intercept: fit.intercept,
    affineRmse: fit.rmse,
    baseScore,
    validatorScore,
    effectiveScore,
    passesValidation,
    uniqueValues: candidate.uniqueValues,
    changedTransitions: candidate.changedTransitions,
    monotonicRatio: candidate.monotonicRatio,
    sourceScore: candidate.sourceScore,
  };
}

function summarizeReplayCandidate(candidateKey, matches, targetMetricKey) {
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
  const confusionScores = supportMatches.map((match) => match.bestConfusionScore ?? 0);
  const specificityValues = supportMatches.map((match) => match.specificityScore ?? 0);
  const confidence =
    average(supportMatches.map((match) => match.effectiveScore)) *
    (0.55 + Math.min(1, supportMatches.length / 4)) *
    (0.6 + average(specificityValues));

  return {
    candidateKey,
    metric: targetMetricKey,
    familyKey: exemplar.familyKey,
    familyLength: exemplar.familyLength,
    familyFirstByte: exemplar.familyFirstByte,
    rowArchetype: exemplar.rowArchetype,
    offset: exemplar.offset,
    width: exemplar.width,
    decodeLabel: exemplar.decodeLabel,
    slotIndex: exemplar.slotIndex,
    supportParticipants: supportMatches.length,
    passCount: supportMatches.filter((match) => match.passesValidation).length,
    avgCorrelation: average(supportMatches.map((match) => match.correlation)),
    avgDeltaCorrelation: average(supportMatches.map((match) => Number.isFinite(match.deltaCorrelation) ? match.deltaCorrelation : 0)),
    avgNormalizedRmse: average(supportMatches.map((match) => match.normalizedRmse)),
    avgValidatorScore: average(supportMatches.map((match) => match.validatorScore)),
    avgEffectiveScore: average(supportMatches.map((match) => match.effectiveScore)),
    avgSpecificityScore: average(specificityValues),
    avgConfusionScore: average(confusionScores),
    confidence,
    transform: {
      slopeMedian: median(supportMatches.map((match) => match.slope).filter(Number.isFinite)),
      interceptMedian: median(supportMatches.map((match) => match.intercept).filter(Number.isFinite)),
      sampleCount: supportMatches.filter((match) => Number.isFinite(match.slope) && Number.isFinite(match.intercept)).length,
    },
    dominantConfusionMetric: supportMatches
      .map((match) => match.bestConfusionMetric)
      .filter(Boolean)
      .sort((left, right) =>
        supportMatches.filter((match) => match.bestConfusionMetric === right).length -
        supportMatches.filter((match) => match.bestConfusionMetric === left).length ||
        left.localeCompare(right),
      )[0] ?? null,
    champions: supportMatches.map((match) => match.champion),
    participantHits: supportMatches,
  };
}

function summarizeCrossReplayGroup(groupKey, entries) {
  const replayIds = [...new Set(entries.map((entry) => entry.replayId))];
  const familyKeys = [...new Set(entries.map((entry) => entry.familyKey))];
  const slotIndices = entries.map((entry) => entry.slotIndex);

  return {
    groupKey,
    metric: entries[0]?.metric ?? null,
    replaySupport: replayIds.length,
    replayIds,
    familySupport: familyKeys.length,
    familyKeys,
    offset: entries[0]?.offset ?? null,
    decodeLabel: entries[0]?.decodeLabel ?? null,
    rowArchetype: entries[0]?.rowArchetype ?? "unknown",
    slotBand: [Math.min(...slotIndices), Math.max(...slotIndices)],
    medianSlotIndex: median(slotIndices),
    medianParticipants: median(entries.map((entry) => entry.supportParticipants)),
    medianCorrelation: median(entries.map((entry) => entry.avgCorrelation)),
    medianDeltaCorrelation: median(entries.map((entry) => entry.avgDeltaCorrelation)),
    medianNormalizedRmse: median(entries.map((entry) => entry.avgNormalizedRmse)),
    medianValidatorScore: median(entries.map((entry) => entry.avgValidatorScore)),
    medianEffectiveScore: median(entries.map((entry) => entry.avgEffectiveScore)),
    medianSpecificityScore: median(entries.map((entry) => entry.avgSpecificityScore)),
    medianConfusionScore: median(entries.map((entry) => entry.avgConfusionScore)),
    confidence: average(entries.map((entry) => entry.confidence)) *
      (0.55 + Math.min(1, replayIds.length / 3)) *
      (0.6 + median(entries.map((entry) => entry.avgSpecificityScore))),
    transform: {
      slopeMedian: median(entries.map((entry) => entry.transform?.slopeMedian).filter(Number.isFinite)),
      interceptMedian: median(entries.map((entry) => entry.transform?.interceptMedian).filter(Number.isFinite)),
      sampleCount: entries.reduce((sum, entry) => sum + (entry.transform?.sampleCount ?? 0), 0),
    },
    examples: entries.slice(0, 12).map((entry) => ({
      replayId: entry.replayId,
      familyKey: entry.familyKey,
      slotIndex: entry.slotIndex,
      supportParticipants: entry.supportParticipants,
      avgCorrelation: entry.avgCorrelation,
      avgNormalizedRmse: entry.avgNormalizedRmse,
      avgSpecificityScore: entry.avgSpecificityScore,
      dominantConfusionMetric: entry.dominantConfusionMetric,
    })),
  };
}

function loadManifest(repoRoot, artifactRoot, corpusManifestPath) {
  if (corpusManifestPath && fs.existsSync(corpusManifestPath)) {
    return readJson(corpusManifestPath);
  }

  return {
    processed: fs.readdirSync(artifactRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        replayId: entry.name,
        artifactDir: path.join(artifactRoot, entry.name),
      })),
  };
}

function buildOutputPath(artifactRoot, versionGroup, metricKey, explicitOutputPath) {
  if (explicitOutputPath) {
    return explicitOutputPath;
  }
  return path.join(artifactRoot, "scalar-metric-discovery", versionGroup, `${metricKey}.json`);
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const corpusManifestPath = args.corpusManifest
    ? resolveAbsolute(repoRoot, args.corpusManifest)
    : path.join(artifactRoot, "corpus-manifest.json");
  const outputPath = buildOutputPath(
    artifactRoot,
    args.versionGroup,
    args.metric,
    args.outputPath ? resolveAbsolute(repoRoot, args.outputPath) : null,
  );

  const targetMetric = metricDefinitionByKey.get(args.metric);
  if (!targetMetric) {
    throw new Error(`Unknown metric key: ${args.metric}`);
  }

  const confusionMetricKeys = buildConfusionMetricKeys(args.metric)
    .filter((key, index, array) => array.indexOf(key) === index)
    .filter((key) => metricDefinitionByKey.has(key));
  const requestedMetricKeys = [args.metric, ...confusionMetricKeys];
  const manifest = loadManifest(repoRoot, artifactRoot, corpusManifestPath);

  const topMatches = [];
  const replaySummaries = [];
  const exactGroups = new Map();
  const familyBandGroups = new Map();

  for (const replay of manifest.processed ?? []) {
    const artifactDir = replay.artifactDir
      ? resolveAbsolute(repoRoot, replay.artifactDir)
      : path.join(artifactRoot, replay.replayId);
    const runManifestPath = path.join(artifactDir, "run-manifest.json");
    const summaryPath = path.join(artifactDir, "summary.json");
    if (!fs.existsSync(runManifestPath) || !fs.existsSync(summaryPath)) {
      continue;
    }

    const summary = readJson(summaryPath);
    const versionGroup = parseVersionGroup(summary.gameVersion);
    if (versionGroup !== args.versionGroup) {
      continue;
    }

    const fixtureDir = path.join(repoRoot, "replays", "api", normalizeFixtureReplayId(replay.replayId));
    const matchPath = path.join(fixtureDir, "match.json");
    const timelinePath = path.join(fixtureDir, "timeline.json");
    if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
      continue;
    }

    const runManifest = readJson(runManifestPath);
    const matchJson = readJson(matchPath);
    const timelineJson = readJson(timelinePath);
    const { participants, metricSeriesByParticipant } = buildMetricSeries(matchJson, timelineJson, requestedMetricKeys);

    const replayMatches = [];
    for (const family of runManifest.families ?? []) {
      const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
      if (!fs.existsSync(cleanedPath)) {
        continue;
      }

      const cleaned = readJson(cleanedPath);
      for (const slot of cleaned.slots ?? []) {
        for (const field of slot.fields ?? []) {
          const candidate = buildFieldCandidate(family, slot, field);
          if (!candidate) {
            continue;
          }

          for (const participant of participants) {
            const participantSeries = metricSeriesByParticipant.get(participant.participantId);
            const targetPoints = participantSeries?.get(args.metric) ?? [];
            if (targetPoints.length < targetMetric.minOverlap) {
              continue;
            }

            const targetMatch = compareCandidateToMetric(candidate, participant, targetMetric, targetPoints);
            if (!targetMatch) {
              continue;
            }

            let bestConfusionMetric = null;
            let bestConfusionScore = 0;
            for (const confusionMetricKey of confusionMetricKeys) {
              const confusionMetric = metricDefinitionByKey.get(confusionMetricKey);
              const confusionPoints = participantSeries?.get(confusionMetricKey) ?? [];
              if (!confusionMetric || confusionPoints.length < confusionMetric.minOverlap) {
                continue;
              }
              const confusionMatch = compareCandidateToMetric(candidate, participant, confusionMetric, confusionPoints);
              if (!confusionMatch) {
                continue;
              }
              if (confusionMatch.effectiveScore > bestConfusionScore) {
                bestConfusionScore = confusionMatch.effectiveScore;
                bestConfusionMetric = confusionMetricKey;
              }
            }

            const specificityScore = clamp(
              targetMatch.effectiveScore / Math.max(targetMatch.effectiveScore + (bestConfusionScore * 0.9), 1e-6),
              0,
              1,
            );
            targetMatch.bestConfusionMetric = bestConfusionMetric;
            targetMatch.bestConfusionScore = bestConfusionScore;
            targetMatch.specificityScore = specificityScore;
            targetMatch.discoveryScore = targetMatch.effectiveScore * (0.6 + specificityScore);
            replayMatches.push(targetMatch);
          }
        }
      }
    }

    replayMatches.sort((left, right) =>
      right.discoveryScore - left.discoveryScore ||
      right.effectiveScore - left.effectiveScore ||
      left.normalizedRmse - right.normalizedRmse,
    );
    topMatches.push(...replayMatches.slice(0, args.maxTopMatches));

    const replayCandidateGroups = new Map();
    for (const match of replayMatches) {
      const key = `${match.familyKey}|${match.slotIndex}|${match.offset}|${match.decodeLabel}`;
      const list = replayCandidateGroups.get(key) ?? [];
      list.push(match);
      replayCandidateGroups.set(key, list);
    }

    const rankedReplayCandidates = [...replayCandidateGroups.entries()]
      .map(([candidateKey, matches]) => summarizeReplayCandidate(candidateKey, matches, args.metric))
      .filter(Boolean)
      .sort((left, right) =>
        right.confidence - left.confidence ||
        right.avgSpecificityScore - left.avgSpecificityScore ||
        right.avgCorrelation - left.avgCorrelation,
      )
      .slice(0, args.maxReplayCandidates)
      .map((entry) => ({
        ...entry,
        replayId: replay.replayId,
        versionGroup,
      }));

    for (const entry of rankedReplayCandidates) {
      const exactKey = `${versionGroup}|${entry.familyKey}|${entry.offset}|${entry.decodeLabel}`;
      const exactList = exactGroups.get(exactKey) ?? [];
      exactList.push(entry);
      exactGroups.set(exactKey, exactList);

      const familyBandKey = buildFamilyBandKey(versionGroup, entry);
      const familyBandList = familyBandGroups.get(familyBandKey) ?? [];
      familyBandList.push(entry);
      familyBandGroups.set(familyBandKey, familyBandList);
    }

    replaySummaries.push({
      replayId: replay.replayId,
      gameVersion: summary.gameVersion,
      candidateCount: rankedReplayCandidates.length,
      topCandidates: rankedReplayCandidates.slice(0, 12),
    });
  }

  const exactSupport = [...exactGroups.entries()]
    .map(([groupKey, entries]) => summarizeCrossReplayGroup(groupKey, entries))
    .sort((left, right) =>
      right.replaySupport - left.replaySupport ||
      right.confidence - left.confidence ||
      right.medianSpecificityScore - left.medianSpecificityScore,
    );

  const familyBandSupport = [...familyBandGroups.entries()]
    .map(([groupKey, entries]) => summarizeCrossReplayGroup(groupKey, entries))
    .sort((left, right) =>
      right.replaySupport - left.replaySupport ||
      right.confidence - left.confidence ||
      right.medianSpecificityScore - left.medianSpecificityScore,
    );

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    versionGroup: args.versionGroup,
    metric: {
      key: targetMetric.key,
      label: targetMetric.label,
      monotonic: targetMetric.monotonic,
      minCorrelation: targetMetric.minCorrelation,
      maxNormalizedRmse: targetMetric.maxNormalizedRmse,
      minOverlap: targetMetric.minOverlap,
    },
    confusionMetrics: confusionMetricKeys,
    replayCount: replaySummaries.length,
    replayIds: replaySummaries.map((summary) => summary.replayId),
    replaySummaries,
    topMatches: topMatches
      .sort((left, right) =>
        right.discoveryScore - left.discoveryScore ||
        right.effectiveScore - left.effectiveScore ||
        left.normalizedRmse - right.normalizedRmse,
      )
      .slice(0, args.maxTopMatches),
    exactSupport,
    familyBandSupport,
    watchlistCandidates: exactSupport
      .filter((entry) =>
        entry.replaySupport >= 2 &&
        entry.medianParticipants >= 3 &&
        entry.medianCorrelation >= Math.max(targetMetric.minCorrelation, 0.45) &&
        entry.medianNormalizedRmse <= Math.min(targetMetric.maxNormalizedRmse, 0.9) &&
        entry.medianSpecificityScore >= 0.5,
      )
      .slice(0, 24),
    recommendedCandidates: exactSupport
      .filter((entry) =>
        entry.replaySupport >= 2 &&
        entry.medianParticipants >= 4 &&
        entry.medianCorrelation >= Math.max(targetMetric.minCorrelation, 0.55) &&
        entry.medianNormalizedRmse <= Math.min(targetMetric.maxNormalizedRmse, 0.75) &&
        entry.medianSpecificityScore >= 0.58 &&
        entry.medianConfusionScore <= 0.18 &&
        entry.medianEffectiveScore >= 0.18,
      )
      .slice(0, 24),
  };

  writeJson(outputPath, output);
  console.log(`Wrote scalar metric discovery report to ${outputPath}`);
  console.log(`Scanned ${replaySummaries.length} ${args.versionGroup} replays for ${args.metric}.`);
  console.log(`Found ${exactSupport.length} exact candidate groups and ${familyBandSupport.length} family-band groups.`);
}

main();
