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

function summarizeBucket(entries) {
  const xSlopes = entries.map((entry) => entry.transformX.slopeMedian).filter(Number.isFinite);
  const xIntercepts = entries.map((entry) => entry.transformX.interceptMedian).filter(Number.isFinite);
  const ySlopes = entries.map((entry) => entry.transformY.slopeMedian).filter(Number.isFinite);
  const yIntercepts = entries.map((entry) => entry.transformY.interceptMedian).filter(Number.isFinite);

  const xSlopeMedian = median(xSlopes);
  const xInterceptMedian = median(xIntercepts);
  const ySlopeMedian = median(ySlopes);
  const yInterceptMedian = median(yIntercepts);

  return {
    support: entries.length,
    passingCount: entries.filter((entry) => entry.label === "passing").length,
    nearPassingCount: entries.filter((entry) => entry.label === "near_passing").length,
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
      const list = buckets.get(signatureKey) ?? [];
      list.push({
        replayId: replay.replayId,
        versionGroup,
        familyKey: pattern.familyKey,
        patternKey: pattern.patternKey,
        champion: assignment.champion,
        label,
        averageAxisCorrelation: validatedAssignment.validation.averageAxisCorrelation,
        normalizedDistanceRmse: validatedAssignment.validation.normalizedDistanceRmse,
        pathCorrelation: validatedAssignment.validation.pathCorrelation,
        transformX: pattern.transformX,
        transformY: pattern.transformY,
      });
      buckets.set(signatureKey, list);
    }
  }

  const signatures = Object.fromEntries(
    [...buckets.entries()]
      .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
      .map(([key, entries]) => [key, summarizeBucket(entries)]),
  );

  const model = {
    generatedAtUtc: new Date().toISOString(),
    signatureCount: Object.keys(signatures).length,
    signatures,
  };

  writeJson(outputPath, model);
  console.log(`Wrote movement coordinate model to ${outputPath}`);
}

main();
