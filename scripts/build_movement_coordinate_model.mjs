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
  const lengthBand = Math.floor((pattern.familyLength ?? 0) / 1024);
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

  const model = {
    generatedAtUtc: new Date().toISOString(),
    signatureCount: Object.keys(signatures).length,
    familySignatureCount: Object.keys(familySignatures).length,
    familyMappingCount: Object.keys(familyMappings).length,
    familyBandCount: Object.keys(familyBands).length,
    signatures,
    familySignatures,
    familyMappings,
    familyBands,
  };

  writeJson(outputPath, model);
  console.log(`Wrote movement coordinate model to ${outputPath}`);
}

main();
