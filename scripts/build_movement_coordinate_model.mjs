import fs from "fs";
import path from "path";

import {
  median,
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: null,
    corpusManifest: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--corpus-manifest" && index + 1 < argv.length) {
      args.corpusManifest = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactRoot && !args.corpusManifest) {
    throw new Error("Missing required --artifact-root <path> or --corpus-manifest <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/build_movement_coordinate_model.mjs [--artifact-root <path>] [--corpus-manifest <path>] [--output-path <path>]");
}

function medianAbsoluteDeviation(values, center) {
  if (!values.length) {
    return 0;
  }
  return median(values.map((value) => Math.abs(value - center)));
}

function includeAssignment(validation) {
  if (!validation) {
    return null;
  }
  if (validation.passes) {
    return "passing";
  }
  if (
    Number.isFinite(validation.averageAxisCorrelation) &&
    Number.isFinite(validation.normalizedDistanceRmse) &&
    Number.isFinite(validation.pathCorrelation) &&
    validation.averageAxisCorrelation >= 0.6 &&
    validation.normalizedDistanceRmse <= 0.22 &&
    validation.pathCorrelation >= 0.4
  ) {
    return "near_passing";
  }
  return null;
}

function buildSignatureKey(pattern) {
  return `${pattern.mapping}|${pattern.xField.decode}|${pattern.yField.decode}`;
}

function buildFamilySignatureKey(versionGroup, pattern) {
  return `${versionGroup}|${pattern.familyKey}|${buildSignatureKey(pattern)}`;
}

function buildFamilyMappingKey(versionGroup, pattern) {
  return `${versionGroup}|${pattern.familyKey}|${pattern.mapping}`;
}

function buildFamilyBandKey(versionGroup, pattern) {
  const lengthBand = Math.floor((pattern.familyLength ?? 0) / 4096) * 4;
  const firstByte = Number.isFinite(pattern.familyFirstByte)
    ? pattern.familyFirstByte.toString(16).toUpperCase().padStart(2, "0")
    : "??";
  return `${versionGroup}|0x${firstByte}|${lengthBand}k|${pattern.mapping}`;
}

function includeSchemaPattern(pattern) {
  const support = pattern?.support ?? {};
  if ((support.rows ?? 0) < 2 || (support.participants ?? 0) < 4) {
    return false;
  }
  if (!Number.isFinite(support.avgAxisCorrelation) || support.avgAxisCorrelation < 0.5) {
    return false;
  }
  if (!Number.isFinite(support.avgNormalizedDistanceRmse) || support.avgNormalizedDistanceRmse > 0.24) {
    return false;
  }
  if (!Number.isFinite(support.avgValidatorScore) || support.avgValidatorScore < 0.7) {
    return false;
  }
  return true;
}

function includeRankedPattern(pattern, index) {
  if (index >= 24) {
    return false;
  }
  const support = pattern?.support ?? {};
  if ((support.rows ?? 0) < 1 || (support.participants ?? 0) < 5) {
    return false;
  }
  if (!Number.isFinite(support.avgAxisCorrelation) || support.avgAxisCorrelation < 0.5) {
    return false;
  }
  if (!Number.isFinite(support.avgNormalizedDistanceRmse) || support.avgNormalizedDistanceRmse > 0.26) {
    return false;
  }
  if (!Number.isFinite(support.avgValidatorScore) || support.avgValidatorScore < 0.65) {
    return false;
  }
  return true;
}

function scoreEntryAgainstPrior(entry, prior) {
  const xScore = scoreAxisAgainstPrior(entry.transformX, prior.transformX);
  const yScore = scoreAxisAgainstPrior(entry.transformY, prior.transformY);
  return Math.sqrt(xScore * yScore);
}

function scoreAxisAgainstPrior(axis, priorAxis) {
  if (!axis || !priorAxis) {
    return 0;
  }

  const slopeScale = Math.max(Math.abs(priorAxis.slopeMedian) * 0.5, (priorAxis.slopeMad ?? 0) * 4, 1e-9);
  const interceptScale = Math.max(Math.abs(priorAxis.interceptMedian) * 0.1, (priorAxis.interceptMad ?? 0) * 4, 400);
  const slopeDelta = Math.abs((axis.slopeMedian ?? 0) - priorAxis.slopeMedian);
  const interceptDelta = Math.abs((axis.interceptMedian ?? 0) - priorAxis.interceptMedian);
  const slopeScore = 1 / (1 + (slopeDelta / slopeScale));
  const interceptScore = 1 / (1 + (interceptDelta / interceptScale));
  return Math.max(0, Math.min(1, Math.sqrt(slopeScore * interceptScore)));
}

function summarizeBucket(entries) {
  const xSlopes = entries.map((entry) => entry.transformX.slopeMedian).filter(Number.isFinite);
  const xIntercepts = entries.map((entry) => entry.transformX.interceptMedian).filter(Number.isFinite);
  const ySlopes = entries.map((entry) => entry.transformY.slopeMedian).filter(Number.isFinite);
  const yIntercepts = entries.map((entry) => entry.transformY.interceptMedian).filter(Number.isFinite);
  const replayCount = new Set(entries.map((entry) => entry.replayId)).size;
  const familyCount = new Set(entries.map((entry) => entry.familyKey)).size;

  const xSlopeMedian = median(xSlopes);
  const xInterceptMedian = median(xIntercepts);
  const ySlopeMedian = median(ySlopes);
  const yInterceptMedian = median(yIntercepts);

  return {
    support: entries.length,
    replayCount,
    familyCount,
    passingCount: entries.filter((entry) => entry.label === "passing").length,
    nearPassingCount: entries.filter((entry) => entry.label === "near_passing").length,
    schemaCandidateCount: entries.filter((entry) => entry.label === "schema_candidate").length,
    transformX: {
      slopeMedian: xSlopeMedian,
      slopeMad: medianAbsoluteDeviation(xSlopes, xSlopeMedian),
      interceptMedian: xInterceptMedian,
      interceptMad: medianAbsoluteDeviation(xIntercepts, xInterceptMedian),
    },
    transformY: {
      slopeMedian: ySlopeMedian,
      slopeMad: medianAbsoluteDeviation(ySlopes, ySlopeMedian),
      interceptMedian: yInterceptMedian,
      interceptMad: medianAbsoluteDeviation(yIntercepts, yInterceptMedian),
    },
    examples: entries.slice(0, 12).map((entry) => ({
      replayId: entry.replayId,
      versionGroup: entry.versionGroup,
        familyKey: entry.familyKey,
        patternKey: entry.patternKey,
        champion: entry.champion,
        label: entry.label,
        source: entry.source,
        averageAxisCorrelation: entry.averageAxisCorrelation,
        normalizedDistanceRmse: entry.normalizedDistanceRmse,
        pathCorrelation: entry.pathCorrelation,
    })),
  };
}

function clusterFamilyBandEntries(entries) {
  const sortedEntries = entries
    .slice()
    .sort((left, right) =>
      entryPriority(right) - entryPriority(left)
      || right.averageAxisCorrelation - left.averageAxisCorrelation
      || left.normalizedDistanceRmse - right.normalizedDistanceRmse,
    );

  const clusters = [];
  for (const entry of sortedEntries) {
    let bestCluster = null;
    let bestScore = 0;
    for (const cluster of clusters) {
      const similarity = scoreEntryAgainstPrior(entry, cluster);
      if (similarity > bestScore) {
        bestScore = similarity;
        bestCluster = cluster;
      }
    }

    const minimumScore = entry.source === "ranked_candidate" ? 0.72 : 0.58;
    if (bestCluster && bestScore >= minimumScore) {
      bestCluster.entries.push(entry);
      continue;
    }

    clusters.push({
      entries: [entry],
      transformX: {
        slopeMedian: entry.transformX.slopeMedian,
        slopeMad: 0,
        interceptMedian: entry.transformX.interceptMedian,
        interceptMad: 0,
      },
      transformY: {
        slopeMedian: entry.transformY.slopeMedian,
        slopeMad: 0,
        interceptMedian: entry.transformY.interceptMedian,
        interceptMad: 0,
      },
    });

    if (bestCluster) {
      continue;
    }
  }

  return clusters
    .map((cluster, index) => summarizeCluster(cluster.entries, index))
    .sort((left, right) =>
      right.replayCount - left.replayCount
      || right.support - left.support
      || right.passingCount - left.passingCount
      || right.nearPassingCount - left.nearPassingCount,
    );
}

function summarizeCluster(entries, index) {
  const summary = summarizeBucket(entries);
  const signatureCounts = new Map();
  for (const entry of entries) {
    const current = signatureCounts.get(entry.signatureKey) ?? 0;
    signatureCounts.set(entry.signatureKey, current + 1);
  }

  return {
    clusterId: `c${index + 1}`,
    ...summary,
    signatureCount: signatureCounts.size,
    rankedCandidateCount: entries.filter((entry) => entry.label === "ranked_candidate").length,
    dominantSignatures: [...signatureCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 6)
      .map(([signatureKey, support]) => ({ signatureKey, support })),
  };
}

function entryPriority(entry) {
  if (entry.label === "passing") {
    return 4;
  }
  if (entry.label === "near_passing") {
    return 3;
  }
  if (entry.label === "schema_candidate") {
    return 2;
  }
  return 1;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const corpusManifestPath = args.corpusManifest
    ? resolveAbsolute(repoRoot, args.corpusManifest)
    : null;
  const artifactRoot = args.artifactRoot
    ? resolveAbsolute(repoRoot, args.artifactRoot)
    : path.dirname(corpusManifestPath);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "movement-coordinate-model.json");

  const manifest = corpusManifestPath
    ? readJson(corpusManifestPath)
    : {
      processed: fs.readdirSync(artifactRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          replayId: entry.name,
          artifactDir: path.join(artifactRoot, entry.name),
        })),
    };

  const buckets = new Map();
  const familySignatureBuckets = new Map();
  const familyMappingBuckets = new Map();
  const familyBandBuckets = new Map();
  const familyBandClusterInputBuckets = new Map();
  for (const replay of manifest.processed ?? []) {
    const artifactDir = replay.artifactDir ? resolveAbsolute(repoRoot, replay.artifactDir) : path.join(artifactRoot, replay.replayId);
    const summaryPath = path.join(artifactDir, "summary.json");
    const participantMovementPath = path.join(artifactDir, "participant-movement.json");
    const assignedValidationPath = path.join(artifactDir, "assigned-movement-validation-report.json");
    const movementSchemaPath = path.join(artifactDir, "movement-provisional-schema.json");
    if (!fs.existsSync(summaryPath) || !fs.existsSync(participantMovementPath) || !fs.existsSync(assignedValidationPath) || !fs.existsSync(movementSchemaPath)) {
      continue;
    }

    const summary = readJson(summaryPath);
    const participantMovement = readJson(participantMovementPath);
    const assignedValidation = readJson(assignedValidationPath);
    const movementSchema = readJson(movementSchemaPath);
    const patternByKey = new Map(
      [...(movementSchema.promotedPatterns ?? []), ...(movementSchema.rankedPatterns ?? [])]
        .map((pattern) => [pattern.patternKey, pattern]),
    );
    const assignmentByEntityKey = new Map(
      (participantMovement.assignments ?? []).map((assignment) => [assignment.entityKey, assignment]),
    );
    const versionGroup = parseVersionGroup(summary.gameVersion);

    for (const validatedAssignment of assignedValidation.assignments ?? []) {
      if (validatedAssignment.status !== "matched") {
        continue;
      }
      const label = includeAssignment(validatedAssignment.validation);
      if (!label) {
        continue;
      }

      const assignment = assignmentByEntityKey.get(validatedAssignment.entityKey);
      const pattern = assignment?.patternKey ? patternByKey.get(assignment.patternKey) : null;
      if (!assignment || !pattern) {
        continue;
      }

      const signatureKey = buildSignatureKey(pattern);
      const entry = {
        replayId: replay.replayId,
        versionGroup,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        signatureKey,
        champion: assignment.champion,
        label,
        source: "assigned_validation",
        averageAxisCorrelation: validatedAssignment.validation.averageAxisCorrelation,
        normalizedDistanceRmse: validatedAssignment.validation.normalizedDistanceRmse,
        pathCorrelation: validatedAssignment.validation.pathCorrelation,
        transformX: pattern.transformX,
        transformY: pattern.transformY,
      };
      const list = buckets.get(signatureKey) ?? [];
      list.push(entry);
      buckets.set(signatureKey, list);

      const familySignatureKey = buildFamilySignatureKey(versionGroup, pattern);
      const familySignatureList = familySignatureBuckets.get(familySignatureKey) ?? [];
      familySignatureList.push(entry);
      familySignatureBuckets.set(familySignatureKey, familySignatureList);

      const familyMappingKey = buildFamilyMappingKey(versionGroup, pattern);
      const familyMappingList = familyMappingBuckets.get(familyMappingKey) ?? [];
      familyMappingList.push(entry);
      familyMappingBuckets.set(familyMappingKey, familyMappingList);

      const familyBandKey = buildFamilyBandKey(versionGroup, pattern);
      const familyBandList = familyBandBuckets.get(familyBandKey) ?? [];
      familyBandList.push(entry);
      familyBandBuckets.set(familyBandKey, familyBandList);
      const familyBandClusterInputList = familyBandClusterInputBuckets.get(familyBandKey) ?? [];
      familyBandClusterInputList.push(entry);
      familyBandClusterInputBuckets.set(familyBandKey, familyBandClusterInputList);
    }

    for (const pattern of movementSchema.promotedPatterns ?? []) {
      if (!includeSchemaPattern(pattern)) {
        continue;
      }

      const entry = {
        replayId: replay.replayId,
        versionGroup,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        signatureKey: buildSignatureKey(pattern),
        champion: null,
        label: "schema_candidate",
        source: "movement_schema",
        averageAxisCorrelation: pattern.support.avgAxisCorrelation,
        normalizedDistanceRmse: pattern.support.avgNormalizedDistanceRmse,
        pathCorrelation: pattern.support.avgPathCorrelation,
        transformX: pattern.transformX,
        transformY: pattern.transformY,
      };

      const signatureKey = buildSignatureKey(pattern);
      const list = buckets.get(signatureKey) ?? [];
      list.push(entry);
      buckets.set(signatureKey, list);

      const familySignatureKey = buildFamilySignatureKey(versionGroup, pattern);
      const familySignatureList = familySignatureBuckets.get(familySignatureKey) ?? [];
      familySignatureList.push(entry);
      familySignatureBuckets.set(familySignatureKey, familySignatureList);

      const familyMappingKey = buildFamilyMappingKey(versionGroup, pattern);
      const familyMappingList = familyMappingBuckets.get(familyMappingKey) ?? [];
      familyMappingList.push(entry);
      familyMappingBuckets.set(familyMappingKey, familyMappingList);

      const familyBandKey = buildFamilyBandKey(versionGroup, pattern);
      const familyBandList = familyBandBuckets.get(familyBandKey) ?? [];
      familyBandList.push(entry);
      familyBandBuckets.set(familyBandKey, familyBandList);
      const familyBandClusterInputList = familyBandClusterInputBuckets.get(familyBandKey) ?? [];
      familyBandClusterInputList.push(entry);
      familyBandClusterInputBuckets.set(familyBandKey, familyBandClusterInputList);
    }

    for (const [index, pattern] of (movementSchema.rankedPatterns ?? []).entries()) {
      if (!includeRankedPattern(pattern, index)) {
        continue;
      }

      const familyBandKey = buildFamilyBandKey(versionGroup, pattern);
      const entry = {
        replayId: replay.replayId,
        versionGroup,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        signatureKey: buildSignatureKey(pattern),
        champion: null,
        label: "ranked_candidate",
        source: "movement_schema",
        averageAxisCorrelation: pattern.support.avgAxisCorrelation,
        normalizedDistanceRmse: pattern.support.avgNormalizedDistanceRmse,
        pathCorrelation: pattern.support.avgPathCorrelation,
        transformX: pattern.transformX,
        transformY: pattern.transformY,
      };
      const familyBandClusterInputList = familyBandClusterInputBuckets.get(familyBandKey) ?? [];
      familyBandClusterInputList.push(entry);
      familyBandClusterInputBuckets.set(familyBandKey, familyBandClusterInputList);
    }
  }

  const signatures = Object.fromEntries(
    [...buckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, summarizeBucket(entries)]),
  );
  const familySignatures = Object.fromEntries(
    [...familySignatureBuckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, summarizeBucket(entries)]),
  );
  const familyMappings = Object.fromEntries(
    [...familyMappingBuckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, summarizeBucket(entries)]),
  );
  const familyBands = Object.fromEntries(
    [...familyBandBuckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, summarizeBucket(entries)]),
  );
  const familyBandClusters = Object.fromEntries(
    [...familyBandClusterInputBuckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, clusterFamilyBandEntries(entries)]),
  );

  const model = {
    generatedAtUtc: new Date().toISOString(),
    signatureCount: Object.keys(signatures).length,
    familySignatureCount: Object.keys(familySignatures).length,
    familyMappingCount: Object.keys(familyMappings).length,
    familyBandCount: Object.keys(familyBands).length,
    familyBandClusterCount: Object.keys(familyBandClusters).length,
    signatures,
    familySignatures,
    familyMappings,
    familyBands,
    familyBandClusters,
  };

  writeJson(outputPath, model);
  console.log(`Wrote movement coordinate model to ${outputPath}`);
}

main();
