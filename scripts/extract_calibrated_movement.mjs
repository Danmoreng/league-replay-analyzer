#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  clamp,
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  summonersRiftBounds,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const mapSpan = 15000;
const qualityRank = {
  none: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
};

const geometryVariants = {
  identity: (x, y) => ({ x, y }),
  swap: (x, y) => ({ x: y, y: x }),
  mirrorX: (x, y) => ({ x: mapSpan - x, y }),
  mirrorY: (x, y) => ({ x, y: mapSpan - y }),
  mirrorXY: (x, y) => ({ x: mapSpan - x, y: mapSpan - y }),
  swapMirrorX: (x, y) => ({ x: mapSpan - y, y: x }),
  swapMirrorY: (x, y) => ({ x: y, y: mapSpan - x }),
  swapMirrorXY: (x, y) => ({ x: mapSpan - y, y: mapSpan - x }),
};

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    artifactsDir: "artifacts",
    versionGroup: "16.7",
    modelPath: null,
    summaryFileName: "summary.json",
    diagnosisFileName: "movement-alignment-diagnosis.json",
    movementFileName: "extracted-movement.json",
    outputFileName: "calibrated-movement.json",
    reportFileName: "calibrated-movement-report.json",
    topHypotheses: 3,
    allowUnmodelledFamily: false,
    includeWeak: false,
    retainUnaccepted: false,
    preserveOriginalTrajectory: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--artifacts-dir" && index + 1 < argv.length) {
      args.artifactsDir = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--model-path" && index + 1 < argv.length) {
      args.modelPath = argv[++index];
    } else if (arg === "--summary-file-name" && index + 1 < argv.length) {
      args.summaryFileName = argv[++index];
    } else if (arg === "--diagnosis-file-name" && index + 1 < argv.length) {
      args.diagnosisFileName = argv[++index];
    } else if (arg === "--movement-file-name" && index + 1 < argv.length) {
      args.movementFileName = argv[++index];
    } else if (arg === "--output-file-name" && index + 1 < argv.length) {
      args.outputFileName = argv[++index];
    } else if (arg === "--report-file-name" && index + 1 < argv.length) {
      args.reportFileName = argv[++index];
    } else if (arg === "--top-hypotheses" && index + 1 < argv.length) {
      args.topHypotheses = Number.parseInt(argv[++index], 10);
    } else if (arg === "--allow-unmodelled-family") {
      args.allowUnmodelledFamily = true;
    } else if (arg === "--include-weak") {
      args.includeWeak = true;
    } else if (arg === "--retain-unaccepted") {
      args.retainUnaccepted = true;
    } else if (arg === "--preserve-original-trajectory") {
      args.preserveOriginalTrajectory = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.topHypotheses) || args.topHypotheses < 1) {
    throw new Error("--top-hypotheses must be at least 1.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/extract_calibrated_movement.mjs [options]");
  console.log("");
  console.log("Modes:");
  console.log("  --artifact-dir <path>        Process exactly one artifact directory.");
  console.log("  --artifacts-dir <path>       Process all matching artifacts (default: artifacts).");
  console.log("");
  console.log("Options:");
  console.log("  --version-group <major.minor> Version group for batch mode (default: 16.7).");
  console.log("  --model-path <path>          Model JSON path (default: <artifacts>/movement-<version>-model.json).");
  console.log("  --summary-file-name <name>   Summary file name (default: summary.json).");
  console.log("  --diagnosis-file-name <name> Diagnosis file name (default: movement-alignment-diagnosis.json).");
  console.log("  --movement-file-name <name>  Source movement file name (default: extracted-movement.json).");
  console.log("  --output-file-name <name>    Output movement file name (default: calibrated-movement.json).");
  console.log("  --report-file-name <name>    Output report file name (default: calibrated-movement-report.json).");
  console.log("  --top-hypotheses <int>       Number of hypotheses to preserve (default: 3).");
  console.log("  --allow-unmodelled-family    Allow families absent in model using strict gates.");
  console.log("  --include-weak               Allow weak-quality entities.");
  console.log("  --retain-unaccepted          Keep original entities when calibration is rejected.");
  console.log("  --preserve-original-trajectory Keep original entity trajectory for accepted entities.");
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

  return {
    sourceMode: source,
    points: points
      .filter((point) =>
        Number.isFinite(point.timestamp)
        && Number.isFinite(point.x)
        && Number.isFinite(point.y))
      .sort((left, right) => left.timestamp - right.timestamp),
  };
}

function classifyMatch(match) {
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

function meetsQualityGate(quality, minQuality, includeWeak) {
  if (includeWeak) {
    return true;
  }
  return (qualityRank[quality] ?? 0) >= (qualityRank[minQuality] ?? qualityRank.strong);
}

function buildTrajectoryFromMatch(sourcePoints, match) {
  const applyVariant = geometryVariants[match.variant] ?? geometryVariants.identity;
  const slopeX = match.affineX?.slope ?? 1;
  const interceptX = match.affineX?.intercept ?? 0;
  const slopeY = match.affineY?.slope ?? 1;
  const interceptY = match.affineY?.intercept ?? 0;
  const shiftMs = match.shiftMs ?? 0;

  const transformed = sourcePoints.map((point) => {
    const variantPoint = applyVariant(point.x, point.y);
    return {
      timestamp: point.timestamp + shiftMs,
      x: (slopeX * variantPoint.x) + interceptX,
      y: (slopeY * variantPoint.y) + interceptY,
    };
  }).filter((point) =>
    Number.isFinite(point.timestamp)
    && Number.isFinite(point.x)
    && Number.isFinite(point.y));

  transformed.sort((left, right) => left.timestamp - right.timestamp);

  const deduped = [];
  for (const point of transformed) {
    if (deduped.length > 0 && deduped[deduped.length - 1].timestamp === point.timestamp) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }
  return deduped;
}

function computeBoundsRatio(points) {
  if (!points.length) {
    return 0;
  }
  let inBounds = 0;
  for (const point of points) {
    if (
      point.x >= summonersRiftBounds.minX
      && point.x <= summonersRiftBounds.maxX
      && point.y >= summonersRiftBounds.minY
      && point.y <= summonersRiftBounds.maxY
    ) {
      inBounds += 1;
    }
  }
  return inBounds / points.length;
}

function computeTrajectoryStats(trajectory) {
  if (!trajectory.length) {
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

  let minX = trajectory[0].x;
  let maxX = trajectory[0].x;
  let minY = trajectory[0].y;
  let maxY = trajectory[0].y;
  let pathLength = 0;
  const uniquePoints = new Set();

  for (let index = 0; index < trajectory.length; index += 1) {
    const point = trajectory[index];
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    uniquePoints.add(`${Math.round(point.x)}|${Math.round(point.y)}`);

    if (index === 0) {
      continue;
    }

    const previous = trajectory[index - 1];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    pathLength += Math.sqrt((dx * dx) + (dy * dy));
  }

  const first = trajectory[0];
  const last = trajectory[trajectory.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const displacement = Math.sqrt((dx * dx) + (dy * dy));
  const uniquePointRatio = uniquePoints.size / trajectory.length;
  const xRange = maxX - minX;
  const yRange = maxY - minY;
  const movementQuality = clamp(
    (Math.min(1, (xRange + yRange) / 6000) * 0.45)
      + (Math.min(1, pathLength / 9000) * 0.35)
      + (uniquePointRatio * 0.2),
    0,
    1,
  );

  return {
    pointCount: trajectory.length,
    uniquePointRatio,
    displacement,
    pathLength,
    xRange,
    yRange,
    movementQuality,
  };
}

function computeRangeRatio(trajectoryStats) {
  if (!trajectoryStats || trajectoryStats.pointCount <= 0) {
    return 0;
  }
  return clamp(((trajectoryStats.xRange / mapSpan) + (trajectoryStats.yRange / mapSpan)) / 2, 0, 1);
}

function dedupeMatches(matches) {
  const byKey = new Map();
  for (const match of matches) {
    const key = [
      match.participantId ?? "",
      match.variant ?? "",
      match.shiftMs ?? "",
      match.affineX?.slope ?? "",
      match.affineX?.intercept ?? "",
      match.affineY?.slope ?? "",
      match.affineY?.intercept ?? "",
    ].join("|");
    if (!byKey.has(key)) {
      byKey.set(key, match);
    }
  }
  return [...byKey.values()];
}

function dedupeRejectedEntities(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.entityKey ?? ""}|${entry.reason ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        entityKey: entry.entityKey,
        familyKey: entry.familyKey ?? null,
        quality: entry.quality ?? null,
        reason: entry.reason ?? "rejected",
      });
    }
  }
  return [...byKey.values()];
}

function parseFamilyPolicy(model) {
  const byFamily = new Map();
  for (const family of model.families ?? []) {
    byFamily.set(family.familyKey, family.policy ?? {});
  }
  return byFamily;
}

function passesPolicyGates(match, policy, includeWeak) {
  const quality = classifyMatch(match);
  const minQuality = policy.minQuality ?? "strong";
  if (!meetsQualityGate(quality, minQuality, includeWeak)) {
    return false;
  }
  if (Number.isFinite(policy.minOverlap) && (match.overlap ?? 0) < policy.minOverlap) {
    return false;
  }
  if (Number.isFinite(policy.minScore) && (match.score ?? 0) < policy.minScore) {
    return false;
  }
  if (Number.isFinite(policy.minAxisCorrelation) && (match.averageAxisCorrelation ?? 0) < policy.minAxisCorrelation) {
    return false;
  }
  if (Number.isFinite(policy.minPathCorrelation) && (match.pathCorrelation ?? 0) < policy.minPathCorrelation) {
    return false;
  }
  if (Number.isFinite(policy.maxNormalizedDistanceRmse)
    && (match.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY) > policy.maxNormalizedDistanceRmse) {
    return false;
  }
  return true;
}

function toSupportHypothesis(match, sourcePoints) {
  const quality = classifyMatch(match);
  const trajectory = buildTrajectoryFromMatch(sourcePoints, match);
  const trajectoryStats = computeTrajectoryStats(trajectory);
  const boundsRatio = computeBoundsRatio(trajectory);
  return {
    participantId: match.participantId ?? null,
    champion: match.champion ?? null,
    teamId: match.teamId ?? null,
    teamPosition: match.teamPosition ?? null,
    overlap: match.overlap ?? 0,
    mapping: match.variant ?? "identity",
    xCorrelation: match.xCorrelation ?? 0,
    yCorrelation: match.yCorrelation ?? 0,
    minAxisCorrelation: Math.min(match.xCorrelation ?? 0, match.yCorrelation ?? 0),
    pathCorrelation: match.pathCorrelation ?? 0,
    distanceRmse: match.distanceRmse ?? Number.POSITIVE_INFINITY,
    normalizedDistanceRmse: match.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY,
    boundsRatio,
    speedRatio: 1,
    rangeRatio: computeRangeRatio(trajectoryStats),
    validatorScore: clamp(match.score ?? 0, 0, 1),
    effectiveScore: clamp(match.score ?? 0, 0, 1),
    passesValidation: quality !== "weak",
    shiftMs: match.shiftMs ?? 0,
    transformX: {
      slope: match.affineX?.slope ?? 1,
      intercept: match.affineX?.intercept ?? 0,
      rmse: match.affineX?.rmse ?? Number.POSITIVE_INFINITY,
      valid: Boolean(match.affineX?.valid),
    },
    transformY: {
      slope: match.affineY?.slope ?? 1,
      intercept: match.affineY?.intercept ?? 0,
      rmse: match.affineY?.rmse ?? Number.POSITIVE_INFINITY,
      valid: Boolean(match.affineY?.valid),
    },
    trajectoryStats,
    trajectory,
    quality,
  };
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildSourceMetrics(hypotheses) {
  const usable = hypotheses.length ? hypotheses : [];
  return {
    avgAxisCorrelation: average(usable.map((hypothesis) => ((hypothesis.xCorrelation + hypothesis.yCorrelation) / 2))),
    avgMinAxisCorrelation: average(usable.map((hypothesis) => hypothesis.minAxisCorrelation ?? 0)),
    avgPathCorrelation: average(usable.map((hypothesis) => hypothesis.pathCorrelation ?? 0)),
    avgNormalizedDistanceRmse: average(usable.map((hypothesis) => hypothesis.normalizedDistanceRmse ?? 1)),
    avgRangeRatio: average(usable.map((hypothesis) => hypothesis.rangeRatio ?? 0)),
    avgValidatorScore: average(usable.map((hypothesis) => hypothesis.validatorScore ?? 0)),
    avgEffectiveScore: average(usable.map((hypothesis) => hypothesis.effectiveScore ?? 0)),
  };
}

function enumerateArtifacts(repoRoot, args) {
  if (args.artifactDir) {
    return [resolveAbsolute(repoRoot, args.artifactDir)];
  }

  const artifactsDir = resolveAbsolute(repoRoot, args.artifactsDir);
  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`Artifacts directory not found at ${artifactsDir}`);
  }

  const artifactDirs = [];
  const entries = fs.readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const artifactName of entries) {
    const artifactDir = path.join(artifactsDir, artifactName);
    const summaryPath = path.join(artifactDir, args.summaryFileName);
    if (!fs.existsSync(summaryPath)) {
      continue;
    }
    const summary = readJson(summaryPath);
    if (parseVersionGroup(summary.gameVersion) !== args.versionGroup) {
      continue;
    }
    artifactDirs.push(artifactDir);
  }

  return artifactDirs;
}

function processArtifact(artifactDir, modelPath, familyPolicyByKey, args) {
  const movementPath = path.join(artifactDir, args.movementFileName);
  const diagnosisPath = path.join(artifactDir, args.diagnosisFileName);
  const outputPath = path.join(artifactDir, args.outputFileName);
  const reportPath = path.join(artifactDir, args.reportFileName);

  if (!fs.existsSync(movementPath)) {
    return { artifactDir, replayId: path.basename(artifactDir), status: "skipped", reason: `Missing ${args.movementFileName}` };
  }
  if (!fs.existsSync(diagnosisPath)) {
    return { artifactDir, replayId: path.basename(artifactDir), status: "skipped", reason: `Missing ${args.diagnosisFileName}` };
  }

  const extractedMovement = readJson(movementPath);
  const diagnosis = readJson(diagnosisPath);
  const replayId = diagnosis.replayId ?? extractedMovement.replayId ?? path.basename(artifactDir);

  const sourceByEntityKey = new Map((extractedMovement.entities ?? []).map((entity) => [entity.entityKey, entity]));
  const diagnosisByEntityKey = new Map((diagnosis.entities ?? []).map((entity) => [entity.entityKey, entity]));
  const acceptedEntities = [];
  const acceptedByEntityKey = new Map();
  const rejectedEntities = [];

  for (const diagnosisEntity of diagnosis.entities ?? []) {
    const sourceEntity = sourceByEntityKey.get(diagnosisEntity.entityKey);
    if (!sourceEntity) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        reason: "entity missing in extracted movement",
      });
      continue;
    }

    if (diagnosisEntity.skipped || !diagnosisEntity.bestMatch) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        reason: diagnosisEntity.reason ?? "skipped or missing best match",
      });
      continue;
    }

    const defaultPolicy = {
      include: false,
      tier: "unmodelled",
      minQuality: "strong",
      minOverlap: 6,
      minScore: 0.8,
      minAxisCorrelation: 0.75,
      minPathCorrelation: 0.35,
      maxNormalizedDistanceRmse: 0.1,
      reason: "family is not in movement model",
    };
    const familyPolicy = familyPolicyByKey.get(diagnosisEntity.familyKey) ?? defaultPolicy;
    if (!familyPolicy.include && !args.allowUnmodelledFamily) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        quality: diagnosisEntity.quality ?? classifyMatch(diagnosisEntity.bestMatch),
        reason: `family rejected by model (${familyPolicy.tier ?? "rejected"})`,
      });
      continue;
    }

    const normalizedSource = normalizeEntitySamples(sourceEntity);
    if (normalizedSource.points.length < 4) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        reason: `insufficient source points (${normalizedSource.points.length})`,
      });
      continue;
    }

    const candidateMatches = dedupeMatches([
      diagnosisEntity.bestMatch,
      ...(diagnosisEntity.topMatches ?? []),
    ]);
    const selected = candidateMatches.find((match) =>
      passesPolicyGates(match, familyPolicy, args.includeWeak));

    if (!selected) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        quality: diagnosisEntity.quality ?? classifyMatch(diagnosisEntity.bestMatch),
        reason: "no hypothesis passed policy gates",
      });
      continue;
    }

    const selectedQuality = classifyMatch(selected);
    const selectedTrajectory = buildTrajectoryFromMatch(normalizedSource.points, selected);
    const selectedTrajectoryStats = computeTrajectoryStats(selectedTrajectory);
    if (selectedTrajectory.length < 4 || (selectedTrajectoryStats.xRange + selectedTrajectoryStats.yRange) < 250) {
      rejectedEntities.push({
        entityKey: diagnosisEntity.entityKey,
        familyKey: diagnosisEntity.familyKey ?? null,
        quality: selectedQuality,
        reason: "calibrated trajectory collapsed or too short",
      });
      continue;
    }

    const hypothesisMatches = candidateMatches
      .filter((match) => passesPolicyGates(match, familyPolicy, args.includeWeak))
      .slice(0, args.topHypotheses);
    const supportHypotheses = hypothesisMatches.map((match) => toSupportHypothesis(match, normalizedSource.points));
    if (!supportHypotheses.length) {
      supportHypotheses.push(toSupportHypothesis(selected, normalizedSource.points));
    }

    const boundsRatio = computeBoundsRatio(selectedTrajectory);
    const sourceMetrics = buildSourceMetrics(supportHypotheses);
    const originalTrajectory = (sourceEntity.trajectory ?? [])
      .filter((point) =>
        Number.isFinite(point.timestamp)
        && Number.isFinite(point.x)
        && Number.isFinite(point.y))
      .sort((left, right) => left.timestamp - right.timestamp);
    const trajectory = args.preserveOriginalTrajectory ? originalTrajectory : selectedTrajectory;
    const trajectoryStats = args.preserveOriginalTrajectory
      ? (sourceEntity.trajectoryStats ?? computeTrajectoryStats(originalTrajectory))
      : selectedTrajectoryStats;
    const entitySourceMetrics = args.preserveOriginalTrajectory
      ? (sourceEntity.sourceMetrics ?? sourceMetrics)
      : sourceMetrics;
    const entityBoundsRatio = args.preserveOriginalTrajectory
      ? (Number.isFinite(sourceEntity.boundsRatio) ? sourceEntity.boundsRatio : computeBoundsRatio(originalTrajectory))
      : boundsRatio;

    acceptedEntities.push({
      entityKey: sourceEntity.entityKey,
      familyKey: sourceEntity.familyKey,
      patternKey: sourceEntity.patternKey ?? null,
      patternConfidence: sourceEntity.patternConfidence ?? null,
      slotIndex: sourceEntity.slotIndex,
      mapping: selected.variant ?? "identity",
      sourceMode: normalizedSource.sourceMode,
      rawPointCount: normalizedSource.points.length,
      filteredPointCount: trajectory.length,
      rawBoundsRatio: computeBoundsRatio(normalizedSource.points),
      boundsRatio: entityBoundsRatio,
      trajectoryStats,
      trajectory,
      sourceMetrics: entitySourceMetrics,
      supportHypotheses,
      calibration: {
        familyTier: familyPolicy.tier ?? null,
        policyReason: familyPolicy.reason ?? null,
        quality: selectedQuality,
        score: selected.score ?? 0,
        trajectoryMode: args.preserveOriginalTrajectory ? "original" : "calibrated",
        shiftMs: selected.shiftMs ?? 0,
        variant: selected.variant ?? "identity",
        matchedParticipantId: selected.participantId ?? null,
        matchedChampion: selected.champion ?? null,
        matchedTeamId: selected.teamId ?? null,
        matchedTeamPosition: selected.teamPosition ?? null,
      },
    });
    acceptedByEntityKey.set(sourceEntity.entityKey, true);
  }

  const fallbackEntities = [];
  for (const sourceEntity of extractedMovement.entities ?? []) {
    if (acceptedByEntityKey.has(sourceEntity.entityKey)) {
      continue;
    }
    if (!diagnosisByEntityKey.has(sourceEntity.entityKey)) {
      rejectedEntities.push({
        entityKey: sourceEntity.entityKey,
        familyKey: sourceEntity.familyKey ?? null,
        reason: "entity missing in diagnosis output",
      });
    }

    if (!args.retainUnaccepted) {
      continue;
    }

    const normalizedSource = normalizeEntitySamples(sourceEntity);
    const fallbackTrajectory = (sourceEntity.trajectory ?? [])
      .filter((point) =>
        Number.isFinite(point.timestamp)
        && Number.isFinite(point.x)
        && Number.isFinite(point.y))
      .sort((left, right) => left.timestamp - right.timestamp);
    const trajectoryStats = sourceEntity.trajectoryStats ?? computeTrajectoryStats(fallbackTrajectory);
    const boundsRatio = Number.isFinite(sourceEntity.boundsRatio)
      ? sourceEntity.boundsRatio
      : computeBoundsRatio(fallbackTrajectory);

    fallbackEntities.push({
      ...sourceEntity,
      sourceMode: sourceEntity.sourceMode ?? normalizedSource.sourceMode,
      rawPointCount: sourceEntity.rawPointCount ?? normalizedSource.points.length,
      filteredPointCount: sourceEntity.filteredPointCount ?? fallbackTrajectory.length,
      boundsRatio,
      trajectoryStats,
      trajectory: fallbackTrajectory,
      calibration: {
        familyTier: null,
        policyReason: "Retained original trajectory as fallback",
        quality: "fallback",
        score: null,
        shiftMs: 0,
        variant: "identity",
        matchedParticipantId: null,
        matchedChampion: null,
        matchedTeamId: null,
        matchedTeamPosition: null,
      },
    });
  }

  const outputEntities = [...acceptedEntities, ...fallbackEntities];
  const dedupedRejectedEntities = dedupeRejectedEntities(rejectedEntities);

  const calibratedMovement = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    sourceMovementPath: movementPath,
    diagnosisPath,
    modelPath,
    modelVersionGroup: args.versionGroup,
    settings: {
      topHypotheses: args.topHypotheses,
      allowUnmodelledFamily: args.allowUnmodelledFamily,
      includeWeak: args.includeWeak,
      retainUnaccepted: args.retainUnaccepted,
      preserveOriginalTrajectory: args.preserveOriginalTrajectory,
      diagnosisFileName: args.diagnosisFileName,
      movementFileName: args.movementFileName,
    },
    summary: {
      sourceEntityCount: extractedMovement.entities?.length ?? 0,
      diagnosedEntityCount: diagnosis.entities?.length ?? 0,
      acceptedEntityCount: acceptedEntities.length,
      fallbackEntityCount: fallbackEntities.length,
      outputEntityCount: outputEntities.length,
      rejectedEntityCount: dedupedRejectedEntities.length,
      familyAcceptedCount: new Set(outputEntities.map((entity) => entity.familyKey)).size,
    },
    entities: outputEntities,
  };

  const report = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    sourceMovementPath: movementPath,
    diagnosisPath,
    modelPath,
    summary: calibratedMovement.summary,
    acceptedEntities: acceptedEntities.map((entity) => ({
      entityKey: entity.entityKey,
      familyKey: entity.familyKey,
      slotIndex: entity.slotIndex,
      quality: entity.calibration.quality,
      score: entity.calibration.score,
      matchedParticipantId: entity.calibration.matchedParticipantId,
      matchedChampion: entity.calibration.matchedChampion,
      matchedTeamId: entity.calibration.matchedTeamId,
      matchedTeamPosition: entity.calibration.matchedTeamPosition,
      trajectoryPointCount: entity.trajectory.length,
      boundsRatio: entity.boundsRatio,
      familyTier: entity.calibration.familyTier,
    })),
    fallbackEntities: fallbackEntities.map((entity) => ({
      entityKey: entity.entityKey,
      familyKey: entity.familyKey,
      slotIndex: entity.slotIndex,
    })),
    rejectedEntities: dedupedRejectedEntities,
  };

  writeJson(outputPath, calibratedMovement);
  writeJson(reportPath, report);

  return {
    artifactDir,
    replayId,
    status: "ok",
    acceptedEntityCount: acceptedEntities.length,
    rejectedEntityCount: rejectedEntities.length,
    outputPath,
    reportPath,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const artifactsDir = resolveAbsolute(repoRoot, args.artifactsDir);
  const modelPath = args.modelPath
    ? resolveAbsolute(repoRoot, args.modelPath)
    : path.join(artifactsDir, `movement-${args.versionGroup}-model.json`);

  if (!fs.existsSync(modelPath)) {
    throw new Error(`Movement model not found at ${modelPath}`);
  }

  const model = readJson(modelPath);
  const familyPolicyByKey = parseFamilyPolicy(model);
  const artifactDirs = enumerateArtifacts(repoRoot, args);
  if (!artifactDirs.length) {
    throw new Error("No artifacts matched the requested mode.");
  }

  const results = artifactDirs.map((artifactDir) =>
    processArtifact(artifactDir, modelPath, familyPolicyByKey, args));
  const completed = results.filter((result) => result.status === "ok");
  const skipped = results.filter((result) => result.status !== "ok");
  const acceptedTotal = completed.reduce((sum, result) => sum + (result.acceptedEntityCount ?? 0), 0);
  const rejectedTotal = completed.reduce((sum, result) => sum + (result.rejectedEntityCount ?? 0), 0);

  for (const result of completed) {
    console.log(`Calibrated ${result.replayId}: accepted=${result.acceptedEntityCount}, rejected=${result.rejectedEntityCount}`);
  }
  for (const result of skipped) {
    console.log(`Skipped ${result.replayId}: ${result.reason}`);
  }

  console.log(`Processed artifacts: ${completed.length}/${artifactDirs.length}`);
  console.log(`Total accepted entities: ${acceptedTotal}`);
  console.log(`Total rejected entities: ${rejectedTotal}`);
}

main();
