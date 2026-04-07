#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactsDir: "artifacts",
    outputPath: null,
    versionGroup: "16.7",
    summaryFileName: "summary.json",
    diagnosisFileName: "movement-alignment-diagnosis.json",
    minFamilySamples: 6,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifacts-dir" && index + 1 < argv.length) {
      args.artifactsDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--summary-file-name" && index + 1 < argv.length) {
      args.summaryFileName = argv[++index];
    } else if (arg === "--diagnosis-file-name" && index + 1 < argv.length) {
      args.diagnosisFileName = argv[++index];
    } else if (arg === "--min-family-samples" && index + 1 < argv.length) {
      args.minFamilySamples = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minFamilySamples) || args.minFamilySamples < 1) {
    throw new Error("--min-family-samples must be at least 1.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/build_movement_16_7_model.mjs [options]");
  console.log("");
  console.log("Options:");
  console.log("  --artifacts-dir <path>       Artifacts root (default: artifacts).");
  console.log("  --output-path <path>         Model output path (default: <artifacts>/movement-<version>-model.json).");
  console.log("  --version-group <major.minor> Version group to aggregate (default: 16.7).");
  console.log("  --summary-file-name <name>   Summary file name (default: summary.json).");
  console.log("  --diagnosis-file-name <name> Diagnosis file name (default: movement-alignment-diagnosis.json).");
  console.log("  --min-family-samples <int>   Minimum family samples before allowing (default: 6).");
}

function createFamilyAccumulator(familyKey) {
  return {
    familyKey,
    totalEntities: 0,
    strongCount: 0,
    moderateCount: 0,
    weakCount: 0,
    scoreSum: 0,
    axisSum: 0,
    pathSum: 0,
    nrmseSum: 0,
    overlapSum: 0,
    variantHistogram: {},
  };
}

function safeNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function classifyPolicy(stats, minFamilySamples) {
  const defaults = {
    minOverlap: 6,
    minScore: 0.8,
    minAxisCorrelation: 0.75,
    minPathCorrelation: 0.35,
    maxNormalizedDistanceRmse: 0.1,
  };

  if (stats.totalEntities < minFamilySamples) {
    return {
      include: false,
      tier: "insufficient",
      minQuality: "strong",
      ...defaults,
      reason: `Insufficient support: ${stats.totalEntities}/${minFamilySamples} samples`,
    };
  }

  if (stats.weakRate > 0.45 || stats.averageAxisCorrelation < 0.62) {
    return {
      include: false,
      tier: "rejected",
      minQuality: "strong",
      ...defaults,
      reason: "Weak-rate or axis correlation is too unstable",
    };
  }

  const trustedByStrongRate = stats.strongRate >= 0.35;
  const trustedByCleanModerate =
    stats.weakRate <= 0.15
    && stats.averageAxisCorrelation >= 0.74
    && stats.averagePathCorrelation >= 0.7
    && stats.averageNormalizedDistanceRmse <= 0.11;

  if (trustedByStrongRate || trustedByCleanModerate) {
    return {
      include: true,
      tier: "trusted",
      minQuality: "moderate",
      minOverlap: 6,
      minScore: 0.73,
      minAxisCorrelation: 0.66,
      minPathCorrelation: 0.15,
      maxNormalizedDistanceRmse: 0.13,
      reason: trustedByStrongRate
        ? "Strong-rate reliability"
        : "Low weak-rate + stable moderate-quality family",
    };
  }

  return {
    include: true,
    tier: "strict",
    minQuality: "strong",
    ...defaults,
    reason: "Only strong-quality entities are reliable for this family",
  };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const artifactsDir = resolveAbsolute(repoRoot, args.artifactsDir);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactsDir, `movement-${args.versionGroup}-model.json`);

  if (!fs.existsSync(artifactsDir)) {
    throw new Error(`Artifacts directory not found at ${artifactsDir}`);
  }

  const familyStatsByKey = new Map();
  const replayInputs = [];
  const artifactEntries = fs.readdirSync(artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  for (const artifactName of artifactEntries) {
    const artifactDir = path.join(artifactsDir, artifactName);
    const summaryPath = path.join(artifactDir, args.summaryFileName);
    const diagnosisPath = path.join(artifactDir, args.diagnosisFileName);
    if (!fs.existsSync(summaryPath) || !fs.existsSync(diagnosisPath)) {
      continue;
    }

    const summary = readJson(summaryPath);
    const versionGroup = parseVersionGroup(summary.gameVersion);
    if (versionGroup !== args.versionGroup) {
      continue;
    }

    const diagnosis = readJson(diagnosisPath);
    replayInputs.push({
      replayId: diagnosis.replayId ?? artifactName,
      artifactDir,
      gameVersion: summary.gameVersion ?? null,
      diagnosisPath,
      analyzedEntityCount: diagnosis.summary?.analyzedEntityCount ?? 0,
    });

    for (const entity of diagnosis.entities ?? []) {
      if (entity?.skipped || !entity?.bestMatch || !entity?.familyKey) {
        continue;
      }

      const family = familyStatsByKey.get(entity.familyKey) ?? createFamilyAccumulator(entity.familyKey);
      family.totalEntities += 1;

      if (entity.quality === "strong") {
        family.strongCount += 1;
      } else if (entity.quality === "moderate") {
        family.moderateCount += 1;
      } else {
        family.weakCount += 1;
      }

      family.scoreSum += safeNumber(entity.bestMatch.score);
      family.axisSum += safeNumber(entity.bestMatch.averageAxisCorrelation);
      family.pathSum += safeNumber(entity.bestMatch.pathCorrelation);
      family.nrmseSum += safeNumber(entity.bestMatch.normalizedDistanceRmse);
      family.overlapSum += safeNumber(entity.bestMatch.overlap);

      const variantKey = `${entity.bestMatch.variant ?? "unknown"}`;
      family.variantHistogram[variantKey] = (family.variantHistogram[variantKey] ?? 0) + 1;
      familyStatsByKey.set(entity.familyKey, family);
    }
  }

  const families = [...familyStatsByKey.values()]
    .map((family) => {
      const total = Math.max(1, family.totalEntities);
      const strongRate = family.strongCount / total;
      const moderateRate = family.moderateCount / total;
      const weakRate = family.weakCount / total;
      const averageScore = family.scoreSum / total;
      const averageAxisCorrelation = family.axisSum / total;
      const averagePathCorrelation = family.pathSum / total;
      const averageNormalizedDistanceRmse = family.nrmseSum / total;
      const averageOverlap = family.overlapSum / total;
      const dominantVariant = Object.entries(family.variantHistogram)
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;

      const stats = {
        totalEntities: family.totalEntities,
        strongRate,
        moderateRate,
        weakRate,
        averageScore,
        averageAxisCorrelation,
        averagePathCorrelation,
        averageNormalizedDistanceRmse,
      };
      const policy = classifyPolicy(stats, args.minFamilySamples);

      return {
        familyKey: family.familyKey,
        totalEntities: family.totalEntities,
        strongCount: family.strongCount,
        moderateCount: family.moderateCount,
        weakCount: family.weakCount,
        strongRate,
        moderateRate,
        weakRate,
        averageScore,
        averageAxisCorrelation,
        averagePathCorrelation,
        averageNormalizedDistanceRmse,
        averageOverlap,
        dominantVariant,
        variantHistogram: family.variantHistogram,
        policy,
      };
    })
    .sort((left, right) =>
      Number(right.policy.include) - Number(left.policy.include)
      || left.policy.tier.localeCompare(right.policy.tier)
      || right.totalEntities - left.totalEntities
      || right.strongRate - left.strongRate
      || left.weakRate - right.weakRate);

  const included = families.filter((family) => family.policy.include);
  const model = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    artifactsDir,
    replayCount: replayInputs.length,
    replays: replayInputs,
    settings: {
      minFamilySamples: args.minFamilySamples,
      summaryFileName: args.summaryFileName,
      diagnosisFileName: args.diagnosisFileName,
      policyNotes: [
        "trusted: low weak-rate / high reliability, allow moderate+strong entities",
        "strict: mixed family, allow only strong entities",
        "rejected/insufficient: exclude from calibrated extraction",
      ],
    },
    summary: {
      familyCount: families.length,
      includedFamilyCount: included.length,
      rejectedFamilyCount: families.length - included.length,
      totalIncludedEntities: included.reduce((sum, family) => sum + family.totalEntities, 0),
      totalIncludedStrong: included.reduce((sum, family) => sum + family.strongCount, 0),
      totalIncludedModerate: included.reduce((sum, family) => sum + family.moderateCount, 0),
      totalIncludedWeak: included.reduce((sum, family) => sum + family.weakCount, 0),
    },
    families,
  };

  writeJson(outputPath, model);
  console.log(`Wrote movement model to ${outputPath}`);
  console.log(`Replays considered: ${model.replayCount}`);
  console.log(`Families included: ${model.summary.includedFamilyCount}/${model.summary.familyCount}`);
}

main();
