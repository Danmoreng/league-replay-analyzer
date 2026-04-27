import fs from "fs";
import path from "path";

import {
  average,
  clamp,
  fitAffine1D,
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

const defaultMetrics = [
  "level",
  "xp",
  "totalGold",
  "currentGold",
  "minionsKilled",
  "jungleMinionsKilled",
  "health",
  "healthMax",
  "power",
  "powerMax",
  "movementSpeed",
];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    outputPath: null,
    metrics: defaultMetrics,
    minOverlap: 6,
    minCorrelation: 0.7,
    maxNormalizedRmse: 0.65,
    topMatches: 100,
    topEvidence: 50,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--metrics" && index + 1 < argv.length) {
      args.metrics = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--min-overlap" && index + 1 < argv.length) {
      args.minOverlap = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-correlation" && index + 1 < argv.length) {
      args.minCorrelation = Number.parseFloat(argv[++index]);
    } else if (arg === "--max-normalized-rmse" && index + 1 < argv.length) {
      args.maxNormalizedRmse = Number.parseFloat(argv[++index]);
    } else if (arg === "--top-matches" && index + 1 < argv.length) {
      args.topMatches = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-evidence" && index + 1 < argv.length) {
      args.topEvidence = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minOverlap) || args.minOverlap < 2) {
    throw new Error("--min-overlap must be at least 2.");
  }
  if (!Number.isFinite(args.minCorrelation) || args.minCorrelation < -1 || args.minCorrelation > 1) {
    throw new Error("--min-correlation must be between -1 and 1.");
  }
  if (!Number.isFinite(args.maxNormalizedRmse) || args.maxNormalizedRmse <= 0) {
    throw new Error("--max-normalized-rmse must be positive.");
  }

  for (const metricKey of args.metrics) {
    if (!metricDefinitionByKey.has(metricKey)) {
      throw new Error(`Unknown metric '${metricKey}'. Known metrics: ${metricDefinitions.map((metric) => metric.key).join(", ")}`);
    }
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/discover_keyframe_api_parity.mjs [--artifact-root <path>] [--api-root <path>] [--replay-id <id>] [--metrics level,xp,totalGold] [--min-correlation <n>] [--max-normalized-rmse <n>] [--output-path <path>]");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  if (separatorIndex < 0) {
    return replayId;
  }
  return `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function listReplayArtifactDirs(artifactRoot, replayId) {
  if (replayId) {
    const artifactDir = path.join(artifactRoot, replayId);
    return fs.existsSync(path.join(artifactDir, "run-manifest.json"))
      ? [{ replayId, artifactDir }]
      : [];
  }

  if (!fs.existsSync(artifactRoot)) {
    return [];
  }

  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      replayId: entry.name,
      artifactDir: path.join(artifactRoot, entry.name),
    }))
    .filter((entry) => fs.existsSync(path.join(entry.artifactDir, "run-manifest.json")))
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sampleApiFrameIndex(sample) {
  const explicitIndex = finiteNumber(sample.apiFrameIndex);
  if (explicitIndex != null && explicitIndex >= 0) {
    return explicitIndex;
  }

  const segmentId = finiteNumber(sample.segmentId);
  if (sample.segmentType === "keyframe" && segmentId != null && segmentId > 0) {
    return segmentId - 1;
  }

  return null;
}

function slotArchetype(family, slotIndex) {
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

function buildFieldCandidate(family, slot, field, minOverlap) {
  const byFrame = new Map();
  for (const sample of field.samples ?? []) {
    const frameIndex = sampleApiFrameIndex(sample);
    const decoded = finiteNumber(sample.decoded);
    if (frameIndex == null || decoded == null) {
      continue;
    }
    const list = byFrame.get(frameIndex) ?? [];
    list.push(decoded);
    byFrame.set(frameIndex, list);
  }

  const points = [...byFrame.entries()]
    .map(([apiFrameIndex, values]) => ({
      apiFrameIndex,
      timestamp: apiFrameIndex * 60000,
      value: median(values),
      sampleCount: values.length,
    }))
    .filter((point) => Number.isFinite(point.value))
    .sort((left, right) => left.apiFrameIndex - right.apiFrameIndex);

  if (points.length < minOverlap) {
    return null;
  }

  return {
    familyKey: family.familyKey,
    familyLength: family.length,
    familyFirstByte: family.firstByte,
    headerSize: family.headerSize,
    stride: family.stride,
    slotIndex: slot.slotIndex,
    rowArchetype: slotArchetype(family, slot.slotIndex),
    offset: field.offset,
    width: field.width,
    decodeLabel: field.decodeLabel,
    activeSamples: field.activeSamples ?? points.length,
    uniqueValues: field.uniqueValues ?? 0,
    sourceScore: field.score ?? 0,
    frameCoverage: points.length,
    rawSampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
    points,
  };
}

function readTargetValue(frames, apiFrameIndex, participantId, metric) {
  const frame = frames[apiFrameIndex];
  if (!frame) {
    return null;
  }

  const participantFrame = frame.participantFrames?.[String(participantId)];
  if (!participantFrame) {
    return null;
  }

  const value = metric.readFrame(participantFrame);
  return Number.isFinite(value) ? value : null;
}

function monotonicAgreement(predictedValues, targetValues) {
  if (predictedValues.length < 2 || predictedValues.length !== targetValues.length) {
    return 0;
  }

  let agreements = 0;
  let comparisons = 0;
  for (let index = 1; index < predictedValues.length; index += 1) {
    const predictedDelta = predictedValues[index] - predictedValues[index - 1];
    const targetDelta = targetValues[index] - targetValues[index - 1];
    const targetStable = Math.abs(targetDelta) <= 1e-6;
    const predictedStable = Math.abs(predictedDelta) <= 1e-6;
    if ((targetStable && predictedStable) || (targetDelta >= 0 && predictedDelta >= 0) || (targetDelta <= 0 && predictedDelta <= 0)) {
      agreements += 1;
    }
    comparisons += 1;
  }

  return comparisons > 0 ? agreements / comparisons : 0;
}

function compareCandidateToParticipantMetric(candidate, participant, metric, frames, options) {
  const rawValues = [];
  const targetValues = [];
  const apiFrameIndices = [];
  for (const point of candidate.points) {
    const target = readTargetValue(frames, point.apiFrameIndex, participant.participantId, metric);
    if (target == null) {
      continue;
    }
    rawValues.push(point.value);
    targetValues.push(target);
    apiFrameIndices.push(point.apiFrameIndex);
  }

  const requiredOverlap = Math.max(options.minOverlap, metric.minOverlap ?? options.minOverlap);
  if (rawValues.length < requiredOverlap) {
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
  const monotonicScore = metric.monotonic ? monotonicAgreement(predictedValues, targetValues) : 0.75;
  const overlapFactor = Math.min(1, rawValues.length / 16);
  const coverageFactor = Math.min(1, rawValues.length / Math.max(frames.length - 1, 1));
  const correlationFactor = clamp(Number.isFinite(correlation) ? correlation : 0, 0, 1);
  const deltaFactor = clamp(Number.isFinite(deltaCorrelation) ? deltaCorrelation : 0, 0, 1);
  const rmseFactor = 1 / (1 + normalizedRmse);
  const sourceFactor = 1 / (1 + Math.exp(-Math.min(candidate.sourceScore, 12) / 4));
  const slopeFactor = metric.monotonic && fit.slope < 0 ? 0.2 : 1;
  const score = slopeFactor * (
    (0.34 * correlationFactor) +
    (0.18 * deltaFactor) +
    (0.2 * rmseFactor) +
    (0.14 * monotonicScore) +
    (0.08 * overlapFactor) +
    (0.06 * coverageFactor)
  ) * (0.7 + (0.3 * sourceFactor));

  const minCorrelation = Math.max(metric.minCorrelation, options.minCorrelation);
  const maxNormalizedRmse = Math.min(metric.maxNormalizedRmse, options.maxNormalizedRmse);
  const pass =
    correlation >= minCorrelation &&
    normalizedRmse <= maxNormalizedRmse &&
    (!metric.monotonic || fit.slope >= 0) &&
    rawValues.length >= requiredOverlap;

  return {
    familyKey: candidate.familyKey,
    familyLength: candidate.familyLength,
    familyFirstByte: candidate.familyFirstByte,
    headerSize: candidate.headerSize,
    stride: candidate.stride,
    slotIndex: candidate.slotIndex,
    rowArchetype: candidate.rowArchetype,
    offset: candidate.offset,
    width: candidate.width,
    decodeLabel: candidate.decodeLabel,
    participantId: participant.participantId,
    champion: participant.champion,
    teamId: participant.teamId,
    teamPosition: participant.teamPosition,
    metric: metric.key,
    overlap: rawValues.length,
    firstApiFrameIndex: apiFrameIndices[0],
    lastApiFrameIndex: apiFrameIndices[apiFrameIndices.length - 1],
    correlation,
    deltaCorrelation,
    normalizedRmse,
    monotonicAgreement: monotonicScore,
    slope: fit.slope,
    intercept: fit.intercept,
    rmse: fit.rmse,
    score,
    minCorrelation,
    maxNormalizedRmse,
    pass,
  };
}

function buildParticipantEvidence(matches, topEvidence) {
  const grouped = new Map();
  for (const match of matches.filter((entry) => entry.pass)) {
    const key = `${match.participantId}|${match.familyKey}|${match.slotIndex}`;
    const group = grouped.get(key) ?? {
      participantId: match.participantId,
      champion: match.champion,
      teamId: match.teamId,
      teamPosition: match.teamPosition,
      familyKey: match.familyKey,
      slotIndex: match.slotIndex,
      rowArchetype: match.rowArchetype,
      metrics: new Map(),
      matches: [],
    };
    const previousMetric = group.metrics.get(match.metric);
    if (!previousMetric || match.score > previousMetric.score) {
      group.metrics.set(match.metric, match);
    }
    group.matches.push(match);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => {
      const bestByMetric = [...group.metrics.values()].sort((left, right) => right.score - left.score);
      return {
        participantId: group.participantId,
        champion: group.champion,
        teamId: group.teamId,
        teamPosition: group.teamPosition,
        familyKey: group.familyKey,
        slotIndex: group.slotIndex,
        rowArchetype: group.rowArchetype,
        metricCount: bestByMetric.length,
        metrics: bestByMetric.map((match) => match.metric),
        avgCorrelation: average(bestByMetric.map((match) => match.correlation).filter(Number.isFinite)),
        avgNormalizedRmse: average(bestByMetric.map((match) => match.normalizedRmse).filter(Number.isFinite)),
        bestScore: Math.max(...bestByMetric.map((match) => match.score)),
        support: bestByMetric.map((match) => ({
          metric: match.metric,
          offset: match.offset,
          decodeLabel: match.decodeLabel,
          overlap: match.overlap,
          correlation: match.correlation,
          normalizedRmse: match.normalizedRmse,
          score: match.score,
        })),
      };
    })
    .sort((left, right) =>
      right.metricCount - left.metricCount ||
      right.bestScore - left.bestScore ||
      right.avgCorrelation - left.avgCorrelation ||
      left.avgNormalizedRmse - right.avgNormalizedRmse ||
      left.participantId - right.participantId,
    )
    .slice(0, topEvidence);
}

function loadParticipants(matchJson) {
  return (matchJson.info?.participants ?? []).map((participant) => ({
    participantId: participant.participantId,
    champion: participant.championName,
    teamId: participant.teamId,
    teamPosition: participant.teamPosition || participant.individualPosition || "",
  }));
}

function analyzeReplay({ replayId, artifactDir, apiRoot, metrics, minOverlap, minCorrelation, maxNormalizedRmse, topMatches, topEvidence }) {
  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const summaryPath = path.join(artifactDir, "summary.json");
  const fixtureDir = path.join(apiRoot, normalizeFixtureReplayId(replayId));
  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");

  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    return {
      replayId,
      artifactDir,
      skipped: true,
      reason: "missing-api-fixture",
    };
  }

  const runManifest = readJson(runManifestPath);
  const summary = fs.existsSync(summaryPath) ? readJson(summaryPath) : null;
  const matchJson = readJson(matchPath);
  const timelineJson = readJson(timelinePath);
  const frames = timelineJson.info?.frames ?? [];
  const participants = loadParticipants(matchJson);

  const metricDefs = metrics.map((metricKey) => metricDefinitionByKey.get(metricKey)).filter(Boolean);
  const candidates = [];
  for (const family of runManifest.families ?? []) {
    const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }

    const cleaned = readJson(cleanedPath);
    if (cleaned.segmentType !== "keyframe") {
      continue;
    }

    for (const slot of cleaned.slots ?? []) {
      for (const field of slot.fields ?? []) {
        const candidate = buildFieldCandidate(family, slot, field, minOverlap);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }

  const matches = [];
  for (const candidate of candidates) {
    for (const participant of participants) {
      for (const metric of metricDefs) {
        const match = compareCandidateToParticipantMetric(candidate, participant, metric, frames, {
          minOverlap,
          minCorrelation,
          maxNormalizedRmse,
        });
        if (match) {
          matches.push(match);
        }
      }
    }
  }

  matches.sort((left, right) =>
    Number(right.pass) - Number(left.pass) ||
    right.score - left.score ||
    right.correlation - left.correlation ||
    left.normalizedRmse - right.normalizedRmse ||
    left.participantId - right.participantId,
  );

  const passingMatches = matches.filter((match) => match.pass);
  const participantSlotEvidence = buildParticipantEvidence(matches, topEvidence);

  return {
    replayId,
    artifactDir,
    recordType: runManifest.parameters?.recordType ?? null,
    gameVersion: summary?.gameVersion ?? runManifest.summary?.gameVersion ?? null,
    versionGroup: parseVersionGroup(summary?.gameVersion ?? runManifest.summary?.gameVersion ?? ""),
    replayKeyframeCount: summary?.container?.keyframeCount ?? null,
    apiFrameCount: frames.length,
    comparedApiFrameCount: Math.max(frames.length - 1, 0),
    finalApiFrameIsUnpaired: summary?.container?.keyframeCount != null
      ? frames.length === summary.container.keyframeCount + 1
      : null,
    candidateCount: candidates.length,
    matchCount: matches.length,
    passingMatchCount: passingMatches.length,
    participantSlotEvidenceCount: participantSlotEvidence.length,
    topMatches: matches.slice(0, topMatches),
    participantSlotEvidence,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const apiRoot = resolveAbsolute(repoRoot, args.apiRoot);
  const replayDirs = listReplayArtifactDirs(artifactRoot, args.replayId);

  const replays = replayDirs.map((entry) => analyzeReplay({
    ...entry,
    apiRoot,
    metrics: args.metrics,
    minOverlap: args.minOverlap,
    minCorrelation: args.minCorrelation,
    maxNormalizedRmse: args.maxNormalizedRmse,
    topMatches: args.topMatches,
    topEvidence: args.topEvidence,
  }));

  const analyzed = replays.filter((replay) => !replay.skipped);
  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    apiRoot,
    metrics: args.metrics,
    minOverlap: args.minOverlap,
    minCorrelation: args.minCorrelation,
    maxNormalizedRmse: args.maxNormalizedRmse,
    replayCount: analyzed.length,
    skippedReplayCount: replays.length - analyzed.length,
    totals: {
      candidateCount: analyzed.reduce((sum, replay) => sum + replay.candidateCount, 0),
      matchCount: analyzed.reduce((sum, replay) => sum + replay.matchCount, 0),
      passingMatchCount: analyzed.reduce((sum, replay) => sum + replay.passingMatchCount, 0),
      participantSlotEvidenceCount: analyzed.reduce((sum, replay) => sum + replay.participantSlotEvidenceCount, 0),
    },
    replays,
  };

  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : args.replayId && analyzed.length === 1
      ? path.join(analyzed[0].artifactDir, "keyframe-api-parity.json")
      : path.join(artifactRoot, "keyframe-api-parity.json");

  writeJson(outputPath, output);
  console.log(`Wrote keyframe/API parity report to ${outputPath}`);
  console.log(`Analyzed ${output.replayCount} replay(s): ${output.totals.passingMatchCount}/${output.totals.matchCount} passing field/metric matches, ${output.totals.participantSlotEvidenceCount} participant-slot evidence groups.`);
}

main();
