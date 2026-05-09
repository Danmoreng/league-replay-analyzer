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
    candidateMatchesPath: null,
    maxPatterns: 10,
    maxRawCandidatesPerPattern: 14,
    maxCandidateMatchSupplementPatterns: 0,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--candidate-matches-path" && index + 1 < argv.length) {
      args.candidateMatchesPath = argv[++index];
    } else if (arg === "--max-patterns" && index + 1 < argv.length) {
      args.maxPatterns = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-raw-candidates-per-pattern" && index + 1 < argv.length) {
      args.maxRawCandidatesPerPattern = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-candidate-match-supplement-patterns" && index + 1 < argv.length) {
      args.maxCandidateMatchSupplementPatterns = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/extract_replay_movement.mjs --artifact-dir <path> [--schema-path <path>] [--candidate-matches-path <path>] [--output-path <path>] [--max-patterns <n>] [--max-raw-candidates-per-pattern <n>] [--max-candidate-match-supplement-patterns <n>]");
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

function alignRawFieldSamples(xField, yField, mapping) {
  const yByTimestamp = new Map((yField.samples ?? []).map((sample) => [sample.timestamp, sample.decoded]));
  const samples = [];
  for (const sample of xField.samples ?? []) {
    const pairedValue = yByTimestamp.get(sample.timestamp);
    if (!Number.isFinite(sample.decoded) || !Number.isFinite(pairedValue) || !Number.isFinite(sample.timestamp)) {
      continue;
    }

    const rawX = mapping === "normal" ? sample.decoded : pairedValue;
    const rawY = mapping === "normal" ? pairedValue : sample.decoded;
    samples.push({
      timestamp: sample.timestamp,
      rawX,
      rawY,
    });
  }
  return samples;
}

function applyTransformsToSamples(rawSamples, transformX, transformY) {
  return rawSamples.map((sample) => ({
    timestamp: sample.timestamp,
    x: ((transformX?.slope ?? 1) * sample.rawX) + (transformX?.intercept ?? 0),
    y: ((transformY?.slope ?? 1) * sample.rawY) + (transformY?.intercept ?? 0),
  }));
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

function scoreFallbackPattern(pattern) {
  const support = pattern.support ?? {};
  const validatorScore = Math.min(1, Math.max(0, support.avgValidatorScore ?? 0));
  const axisScore = Math.min(1, Math.max(0, support.avgAxisCorrelation ?? 0));
  const minAxisScore = Math.min(1, Math.max(0, support.avgMinAxisCorrelation ?? 0));
  const pathScore = Math.min(1, Math.max(0, support.avgPathCorrelation ?? 0));
  const rmseScore = 1 - Math.min(1, Math.max(0, support.avgNormalizedDistanceRmse ?? 1));
  const rangeScore = Math.min(1, Math.max(0, support.avgRangeRatio ?? 0));
  const effectiveScore = Math.min(1, Math.max(0, (support.avgEffectiveScore ?? 0) / 0.5));
  const replaySupport = Math.min(1, Math.max(0, (pattern.coordinateModelReplaySupport ?? 0) / 3));
  const bestRawPairScore = Math.min(
    1,
    Math.max(
      0,
      ((pattern.rawPairCandidates ?? []).reduce((best, candidate) =>
        Math.max(best, candidate.aggregateScore ?? 0), 0
      )) / 0.45,
    ),
  );

  return (
    (validatorScore * 0.22) +
    (axisScore * 0.14) +
    (minAxisScore * 0.16) +
    (pathScore * 0.14) +
    (rmseScore * 0.15) +
    (rangeScore * 0.08) +
    (effectiveScore * 0.1) +
    (replaySupport * 0.05) +
    (bestRawPairScore * 0.1)
  );
}

function selectFallbackPatterns(rankedPatterns, maxPatterns) {
  const ranked = (rankedPatterns ?? [])
    .filter((pattern) => {
      const support = pattern.support ?? {};
      const bestRawPairScore = (pattern.rawPairCandidates ?? []).reduce((best, candidate) =>
        Math.max(best, candidate.aggregateScore ?? 0), 0);
      const strongLocalCandidate =
        bestRawPairScore >= 0.3 &&
        (support.avgValidatorScore ?? 0) >= 0.62 &&
        (support.avgAxisCorrelation ?? 0) >= 0.35 &&
        (support.avgMinAxisCorrelation ?? 0) >= 0.15 &&
        (support.avgPathCorrelation ?? 0) >= 0.18 &&
        (support.avgNormalizedDistanceRmse ?? Number.POSITIVE_INFINITY) <= 0.29 &&
        (support.avgRangeRatio ?? 0) >= 0.3;
      return (
        (
          (support.avgValidatorScore ?? 0) >= 0.78 &&
          (support.avgAxisCorrelation ?? 0) >= 0.52 &&
          (support.avgMinAxisCorrelation ?? 0) >= 0.22 &&
          (support.avgPathCorrelation ?? 0) >= 0.35 &&
          (support.avgNormalizedDistanceRmse ?? Number.POSITIVE_INFINITY) <= 0.22 &&
          (support.avgRangeRatio ?? 0) >= 0.38 &&
          (support.avgEffectiveScore ?? 0) >= 0.34
        ) ||
        (
          (support.avgValidatorScore ?? 0) >= 0.64 &&
          (support.avgAxisCorrelation ?? 0) >= 0.38 &&
          (support.avgMinAxisCorrelation ?? 0) >= 0.16 &&
          (support.avgPathCorrelation ?? 0) >= 0.2 &&
          (support.avgNormalizedDistanceRmse ?? Number.POSITIVE_INFINITY) <= 0.28 &&
          (support.avgRangeRatio ?? 0) >= 0.32 &&
          (support.avgEffectiveScore ?? 0) >= 0.28
        ) ||
        strongLocalCandidate
      );
    })
    .map((pattern) => ({
      pattern,
      fallbackScore: scoreFallbackPattern(pattern),
    }))
    .sort((left, right) =>
      right.fallbackScore - left.fallbackScore
      || (right.pattern.support?.avgEffectiveScore ?? 0) - (left.pattern.support?.avgEffectiveScore ?? 0)
      || (right.pattern.coordinateModelReplaySupport ?? 0) - (left.pattern.coordinateModelReplaySupport ?? 0)
      || left.pattern.patternKey.localeCompare(right.pattern.patternKey),
    );

  const selected = [];
  const selectedKeys = new Set();
  const byFamily = new Map();
  for (const entry of ranked) {
    const list = byFamily.get(entry.pattern.familyKey) ?? [];
    list.push(entry);
    byFamily.set(entry.pattern.familyKey, list);
  }

  // Prefer family diversity before taking alternate windows from the same family.
  const familyEntries = [...byFamily.entries()]
    .map(([familyKey, entries]) => ({
      familyKey,
      entries,
      bestScore: entries[0]?.fallbackScore ?? 0,
    }))
    .sort((left, right) =>
      right.bestScore - left.bestScore
      || left.familyKey.localeCompare(right.familyKey),
    );

  for (const family of familyEntries) {
    const first = family.entries[0];
    if (!first || selectedKeys.has(first.pattern.patternKey)) {
      continue;
    }
    selected.push(first.pattern);
    selectedKeys.add(first.pattern.patternKey);
    if (selected.length >= maxPatterns) {
      return selected;
    }
  }

  for (const family of familyEntries) {
    for (const entry of family.entries.slice(1)) {
      if (selectedKeys.has(entry.pattern.patternKey)) {
        continue;
      }
      selected.push(entry.pattern);
      selectedKeys.add(entry.pattern.patternKey);
      if (selected.length >= maxPatterns) {
        return selected;
      }
    }
  }

  return selected;
}

function selectExtractionPatterns(promotedPatterns, rankedPatterns, maxPatterns, candidateMatchSupplementPatterns = []) {
  const selected = [];
  const selectedKeys = new Set();
  for (const pattern of promotedPatterns ?? []) {
    if (!pattern?.patternKey || selectedKeys.has(pattern.patternKey)) {
      continue;
    }
    selected.push(pattern);
    selectedKeys.add(pattern.patternKey);
    if (selected.length >= maxPatterns) {
      return selected;
    }
  }

  for (const pattern of selectFallbackPatterns(rankedPatterns ?? [], maxPatterns)) {
    if (!pattern?.patternKey || selectedKeys.has(pattern.patternKey)) {
      continue;
    }
    selected.push(pattern);
    selectedKeys.add(pattern.patternKey);
    if (selected.length >= maxPatterns) {
      return selected;
    }
  }

  for (const pattern of candidateMatchSupplementPatterns ?? []) {
    if (!pattern?.patternKey || selectedKeys.has(pattern.patternKey)) {
      continue;
    }
    selected.push(pattern);
    selectedKeys.add(pattern.patternKey);
    if (selected.length >= maxPatterns) {
      return selected;
    }
  }

  return selected;
}

function buildCandidateMatchSupplementPatterns(candidateMatches, maxPatterns) {
  if (!Number.isFinite(maxPatterns) || maxPatterns <= 0) {
    return [];
  }

  const rawPairs = [...(candidateMatches?.rawPairCandidates ?? [])]
    .filter((candidate) =>
      candidate.familyKey != null &&
      Number.isFinite(candidate.slotIndex) &&
      Number.isFinite(candidate.leftOffset) &&
      candidate.leftDecodeLabel != null &&
      Number.isFinite(candidate.rightOffset) &&
      candidate.rightDecodeLabel != null &&
      candidate.mapping != null &&
      (candidate.supportMatches ?? []).length > 0 &&
      (candidate.passCount ?? 0) > 0
    )
    .sort((left, right) =>
      (right.passCount ?? 0) - (left.passCount ?? 0)
      || (right.aggregateScore ?? 0) - (left.aggregateScore ?? 0)
      || (left.rawPairKey ?? "").localeCompare(right.rawPairKey ?? ""),
    );

  const byPattern = new Map();
  for (const candidate of rawPairs) {
    const patternKey = [
      candidate.familyKey,
      candidate.leftOffset,
      candidate.leftDecodeLabel,
      candidate.rightOffset,
      candidate.rightDecodeLabel,
      candidate.mapping,
    ].join("|");
    const list = byPattern.get(patternKey) ?? [];
    list.push(candidate);
    byPattern.set(patternKey, list);
  }

  return [...byPattern.entries()]
    .map(([patternKey, candidates]) => {
      const exemplar = candidates[0];
      const supportMatches = candidates.flatMap((candidate) => candidate.supportMatches ?? []);
      const participantIds = new Set(supportMatches.map((match) => match.participantId).filter(Boolean));
      const slotIndices = candidates.map((candidate) => candidate.slotIndex);
      const average = (key) => {
        const values = supportMatches.map((match) => match[key]).filter(Number.isFinite);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      };
      const avgAxisCorrelation = supportMatches.length
        ? supportMatches.reduce((sum, match) => sum + (((match.xCorrelation ?? 0) + (match.yCorrelation ?? 0)) / 2), 0) / supportMatches.length
        : 0;
      const passCount = supportMatches.filter((match) => match.passesValidation === true).length;
      const confidence = (
        (Math.min(1, passCount / 4) * 0.35) +
        (Math.min(1, (candidates[0]?.aggregateScore ?? 0) / 0.65) * 0.35) +
        (Math.min(1, participantIds.size / 5) * 0.15) +
        (Math.min(1, candidates.length / 4) * 0.15)
      );
      return {
        patternKey,
        familyKey: exemplar.familyKey,
        family: `${exemplar.familyLength} / 0x${Number(exemplar.familyFirstByte ?? 0).toString(16).toUpperCase().padStart(2, "0")}`,
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
        confidence,
        support: {
          replays: 1,
          participants: participantIds.size,
          rows: new Set(slotIndices).size,
          avgAxisCorrelation,
          avgMinAxisCorrelation: average("minAxisCorrelation"),
          avgPathCorrelation: average("pathCorrelation"),
          avgNormalizedDistanceRmse: average("normalizedDistanceRmse"),
          avgRangeRatio: average("rangeRatio"),
          avgValidatorScore: average("validatorScore"),
          avgEffectiveScore: average("effectiveScore"),
        },
        source: "candidate-match-supplement-diagnostic",
        rawPairCandidates: candidates.map((candidate) => ({
          slotIndex: candidate.slotIndex,
          rawPairKey: candidate.rawPairKey,
          participantIds: candidate.participantIds,
          champions: candidate.champions,
          aggregateScore: candidate.aggregateScore,
          averageAxisCorrelation: candidate.averageAxisCorrelation,
          averageMinAxisCorrelation: candidate.averageMinAxisCorrelation,
          averagePathCorrelation: candidate.averagePathCorrelation,
          averageNormalizedDistanceRmse: candidate.averageNormalizedDistanceRmse,
          averageRangeRatio: candidate.averageRangeRatio,
          transformX: candidate.transformX,
          transformY: candidate.transformY,
          supportMatches: candidate.supportMatches ?? [],
        })),
      };
    })
    .sort((left, right) =>
      right.confidence - left.confidence
      || (right.support?.avgEffectiveScore ?? 0) - (left.support?.avgEffectiveScore ?? 0)
      || left.patternKey.localeCompare(right.patternKey),
    )
    .slice(0, maxPatterns);
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

function normalizeSupportMatch(supportMatch) {
  return {
    participantId: supportMatch.participantId,
    champion: supportMatch.champion,
    teamId: supportMatch.teamId,
    teamPosition: supportMatch.teamPosition,
    overlap: supportMatch.overlap,
    mapping: supportMatch.mapping,
    xCorrelation: supportMatch.xCorrelation,
    yCorrelation: supportMatch.yCorrelation,
    minAxisCorrelation: supportMatch.minAxisCorrelation,
    pathCorrelation: supportMatch.pathCorrelation,
    distanceRmse: supportMatch.distanceRmse,
    normalizedDistanceRmse: supportMatch.normalizedDistanceRmse,
    boundsRatio: supportMatch.boundsRatio,
    speedRatio: supportMatch.speedRatio,
    rangeRatio: supportMatch.rangeRatio,
    validatorScore: supportMatch.validatorScore,
    effectiveScore: supportMatch.effectiveScore,
    passesValidation: supportMatch.passesValidation,
    transformX: supportMatch.transformX,
    transformY: supportMatch.transformY,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const schemaPath = args.schemaPath
    ? resolveAbsolute(repoRoot, args.schemaPath)
    : path.join(artifactDir, "movement-provisional-schema.json");
  const candidateMatchesPath = args.candidateMatchesPath
    ? resolveAbsolute(repoRoot, args.candidateMatchesPath)
    : path.join(artifactDir, "movement-candidate-matches.json");
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
  const candidateMatches = args.maxCandidateMatchSupplementPatterns > 0 && fs.existsSync(candidateMatchesPath)
    ? readJson(candidateMatchesPath)
    : null;
  const candidateMatchSupplementPatterns = buildCandidateMatchSupplementPatterns(candidateMatches, args.maxCandidateMatchSupplementPatterns);
  const patterns = selectExtractionPatterns(promotedPatterns, schema.rankedPatterns ?? [], args.maxPatterns, candidateMatchSupplementPatterns);

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

    const rawCandidates = (pattern.rawPairCandidates ?? []).slice(0, args.maxRawCandidatesPerPattern);
    const entityKeys = [];
    for (const candidate of rawCandidates) {
      const xField = fieldIndex.get(`${candidate.slotIndex}|${pattern.xField.offset}|${pattern.xField.decode}`);
      const yField = fieldIndex.get(`${candidate.slotIndex}|${pattern.yField.offset}|${pattern.yField.decode}`);
      if (!xField || !yField) {
        continue;
      }

      const rawSamples = alignRawFieldSamples(
        xField,
        yField,
        pattern.mapping,
      );
      if (rawSamples.length < 4) {
        continue;
      }

      const supportHypotheses = [];
      for (const supportMatch of candidate.supportMatches ?? []) {
        if (
          !Number.isFinite(supportMatch?.transformX?.slope) ||
          !Number.isFinite(supportMatch?.transformX?.intercept) ||
          !Number.isFinite(supportMatch?.transformY?.slope) ||
          !Number.isFinite(supportMatch?.transformY?.intercept)
        ) {
          continue;
        }
        const transformedPoints = applyTransformsToSamples(rawSamples, supportMatch.transformX, supportMatch.transformY);
        const rawBoundsRatio = computeBoundsRatio(transformedPoints);
        const filteredPoints = filterTrajectoryPoints(transformedPoints);
        if (filteredPoints.length < 4) {
          continue;
        }
        const boundsRatio = computeBoundsRatio(filteredPoints);
        const trajectoryStats = computeTrajectoryStats(filteredPoints);
        supportHypotheses.push({
          ...normalizeSupportMatch(supportMatch),
          rawBoundsRatio,
          boundsRatio,
          trajectoryStats,
          trajectory: filteredPoints,
        });
      }

      supportHypotheses.sort((left, right) =>
        (Number(right.passesValidation) - Number(left.passesValidation))
        || right.effectiveScore - left.effectiveScore
        || right.validatorScore - left.validatorScore
        || left.normalizedDistanceRmse - right.normalizedDistanceRmse,
      );

      const exemplarHypothesis = supportHypotheses[0] ?? null;
      if (!exemplarHypothesis) {
        continue;
      }

      const entityKey = `${pattern.familyKey}|${candidate.slotIndex}|${pattern.xField.offset}|${pattern.yField.offset}|${pattern.mapping}`;
      entityKeys.push(entityKey);
      entities.push({
        entityKey,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        patternConfidence: pattern.confidence,
        sourceMetrics: {
          avgAxisCorrelation: ((exemplarHypothesis.xCorrelation ?? 0) + (exemplarHypothesis.yCorrelation ?? 0)) / 2,
          avgMinAxisCorrelation: exemplarHypothesis.minAxisCorrelation ?? 0,
          avgPathCorrelation: exemplarHypothesis.pathCorrelation ?? 0,
          avgNormalizedDistanceRmse: exemplarHypothesis.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY,
          avgRangeRatio: exemplarHypothesis.rangeRatio ?? 0,
          avgValidatorScore: exemplarHypothesis.validatorScore ?? 0,
          avgEffectiveScore: exemplarHypothesis.effectiveScore ?? 0,
        },
        patternSupport: pattern.support ?? null,
        slotIndex: candidate.slotIndex,
        rawPointCount: rawSamples.length,
        filteredPointCount: exemplarHypothesis.trajectory.length,
        rawBoundsRatio: exemplarHypothesis.rawBoundsRatio,
        boundsRatio: exemplarHypothesis.boundsRatio,
        trajectoryStats: exemplarHypothesis.trajectoryStats,
        trajectory: exemplarHypothesis.trajectory,
        rawSamples,
        mapping: pattern.mapping,
        supportHypotheses,
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
      source: pattern.source ?? null,
      entityKeys,
    });
  }

  const extractedMovement = {
    replayId: runManifest.replayId,
    generatedAtUtc: new Date().toISOString(),
    schemaPath,
    candidateMatchesPath: candidateMatches ? candidateMatchesPath : null,
    candidateMatchSupplementPatternCount: candidateMatchSupplementPatterns.length,
    extractionMode: candidateMatches ? "diagnostic_candidate_match_supplement" : "schema_only",
    patterns: extractedPatterns,
    entities,
  };

  writeJson(outputPath, extractedMovement);
  console.log(`Wrote extracted movement to ${outputPath}`);
  console.log(`Extracted ${entities.length} candidate trajectories from ${extractedPatterns.length} movement patterns.`);
}

main();
