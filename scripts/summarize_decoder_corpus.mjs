#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    artifactRoot: path.resolve("artifacts"),
    json: false,
    strictManifest: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--artifact-root") {
      if (!argv[index + 1]) {
        throw new Error("--artifact-root requires a path");
      }
      args.artifactRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--allow-legacy-directory-scan") {
      args.strictManifest = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function requireFile(filePath, description) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
}

function getStrictManifestReplayIds(artifactRoot, corpusSchema) {
  const manifestPath = path.join(artifactRoot, "corpus-manifest.json");
  requireFile(manifestPath, "corpus manifest");
  const manifest = readJson(manifestPath);
  if (!samePath(manifest.artifactRoot, artifactRoot)) {
    throw new Error(`Corpus manifest artifact root does not match scorecard root: ${manifest.artifactRoot}`);
  }
  if (!Array.isArray(manifest.processed) || manifest.processed.length === 0) {
    throw new Error(`Corpus manifest must contain a non-empty processed replay list: ${manifestPath}`);
  }

  const schemaSource = corpusSchema.source;
  if (schemaSource == null || typeof schemaSource !== "object") {
    throw new Error("Corpus schema is missing source provenance.");
  }
  if (!samePath(schemaSource.artifactRoot, artifactRoot)) {
    throw new Error(`Corpus schema artifact root does not match scorecard root: ${schemaSource.artifactRoot}`);
  }
  if (!samePath(schemaSource.corpusManifestPath, manifestPath)) {
    throw new Error(`Corpus schema manifest path does not match scorecard manifest: ${schemaSource.corpusManifestPath}`);
  }
  if (schemaSource.replayCount !== manifest.processed.length) {
    throw new Error(`Corpus schema replay count (${schemaSource.replayCount}) does not match manifest (${manifest.processed.length}).`);
  }

  const replayIds = [];
  const seenReplayIds = new Set();
  for (const entry of manifest.processed) {
    const replayId = entry?.replayId;
    if (typeof replayId !== "string" || replayId.length === 0 || path.basename(replayId) !== replayId) {
      throw new Error("Corpus manifest contains an invalid replayId.");
    }
    const replayKey = process.platform === "win32" ? replayId.toLowerCase() : replayId;
    if (seenReplayIds.has(replayKey)) {
      throw new Error(`Corpus manifest contains duplicate replayId: ${replayId}`);
    }
    seenReplayIds.add(replayKey);

    const expectedArtifactDir = path.join(artifactRoot, replayId);
    if (typeof entry.artifactDir !== "string" || !samePath(entry.artifactDir, expectedArtifactDir)) {
      throw new Error(`Corpus manifest replay '${replayId}' must use artifactDir ${expectedArtifactDir}.`);
    }
    const expectedScalarPath = path.join(expectedArtifactDir, "validation-report.json");
    const expectedMovementPath = path.join(expectedArtifactDir, "assigned-movement-validation-report.json");
    if (typeof entry.validationReportPath !== "string" || !samePath(entry.validationReportPath, expectedScalarPath)) {
      throw new Error(`Corpus manifest replay '${replayId}' has an invalid scalar validation path.`);
    }
    if (typeof entry.assignedMovementValidationPath !== "string" || !samePath(entry.assignedMovementValidationPath, expectedMovementPath)) {
      throw new Error(`Corpus manifest replay '${replayId}' has an invalid assigned-movement validation path.`);
    }
    requireFile(expectedArtifactDir, `manifested replay artifact directory for ${replayId}`);
    if (!fs.statSync(expectedArtifactDir).isDirectory()) {
      throw new Error(`Manifested replay artifact path is not a directory: ${expectedArtifactDir}`);
    }
    replayIds.push(replayId);
  }

  for (const entry of fs.readdirSync(artifactRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryKey = process.platform === "win32" ? entry.name.toLowerCase() : entry.name;
    if (seenReplayIds.has(entryKey)) {
      continue;
    }
    const staleScalarPath = path.join(artifactRoot, entry.name, "validation-report.json");
    const staleMovementPath = path.join(artifactRoot, entry.name, "assigned-movement-validation-report.json");
    if (fs.existsSync(staleScalarPath) || fs.existsSync(staleMovementPath)) {
      throw new Error(`Unmanifested score report directory detected: ${path.join(artifactRoot, entry.name)}`);
    }
  }

  return replayIds.sort();
}

function summarizeScalarValidation(report) {
  const totals = new Map();
  let totalPasses = 0;
  let totalChecks = 0;

  for (const participant of Object.values(report.participants ?? {})) {
    for (const [metricName, metric] of Object.entries(participant.metrics ?? {})) {
      const current = totals.get(metricName) ?? { passes: 0, total: 0 };
      current.total += 1;
      totalChecks += 1;
      if (metric.passes) {
        current.passes += 1;
        totalPasses += 1;
      }
      totals.set(metricName, current);
    }
  }

  return {
    totalPasses,
    totalChecks,
    perMetric: Object.fromEntries(
      [...totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([metricName, value]) => [metricName, value]),
    ),
  };
}

function summarizeMovementValidation(report) {
  const summary = report.summary ?? {};
  return {
    passingAssignments: summary.passingAssignmentCount ?? 0,
    totalAssignments: summary.assignmentCount ?? 0,
  };
}

export function buildSummary(artifactRoot, { strictManifest = true } = {}) {
  const corpusSchemaPath = path.join(artifactRoot, "corpus-schema.json");
  requireFile(corpusSchemaPath, "corpus schema");
  const corpusSchema = readJson(corpusSchemaPath);
  const replayIds = strictManifest
    ? getStrictManifestReplayIds(artifactRoot, corpusSchema)
    : fs.readdirSync(artifactRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  if (strictManifest) {
    if (!Array.isArray(corpusSchema.versionGroups) || corpusSchema.versionGroups.some((group) => !Number.isInteger(group?.replayCount) || group.replayCount < 0)) {
      throw new Error("Corpus schema has invalid version-group replay counts.");
    }
    const versionGroupReplayCount = corpusSchema.versionGroups.reduce((sum, group) => sum + group.replayCount, 0);
    if (versionGroupReplayCount !== replayIds.length) {
      throw new Error(`Corpus schema version-group replay count (${versionGroupReplayCount}) does not match manifest (${replayIds.length}).`);
    }
  }

  const scalarTotals = {
    totalPasses: 0,
    totalChecks: 0,
    perMetric: new Map(),
  };
  const movementTotals = {
    passingAssignments: 0,
    totalAssignments: 0,
    replayCount: 0,
    perReplay: [],
  };

  for (const replayId of replayIds) {
    const validationPath = path.join(artifactRoot, replayId, "validation-report.json");
    if (strictManifest) {
      requireFile(validationPath, `scalar validation report for ${replayId}`);
    }
    if (fs.existsSync(validationPath)) {
      const scalarSummary = summarizeScalarValidation(readJson(validationPath));
      scalarTotals.totalPasses += scalarSummary.totalPasses;
      scalarTotals.totalChecks += scalarSummary.totalChecks;
      for (const [metricName, value] of Object.entries(scalarSummary.perMetric)) {
        const current = scalarTotals.perMetric.get(metricName) ?? { passes: 0, total: 0 };
        current.passes += value.passes;
        current.total += value.total;
        scalarTotals.perMetric.set(metricName, current);
      }
    }

    const assignedMovementValidationPath = path.join(artifactRoot, replayId, "assigned-movement-validation-report.json");
    if (strictManifest) {
      requireFile(assignedMovementValidationPath, `assigned movement validation report for ${replayId}`);
    }
    if (fs.existsSync(assignedMovementValidationPath)) {
      const movementSummary = summarizeMovementValidation(readJson(assignedMovementValidationPath));
      movementTotals.passingAssignments += movementSummary.passingAssignments;
      movementTotals.totalAssignments += movementSummary.totalAssignments;
      movementTotals.replayCount += 1;
      movementTotals.perReplay.push({
        replayId,
        passingAssignments: movementSummary.passingAssignments,
        totalAssignments: movementSummary.totalAssignments,
      });
    }
  }

  movementTotals.perReplay.sort((left, right) => {
    const leftRate = left.totalAssignments ? left.passingAssignments / left.totalAssignments : 0;
    const rightRate = right.totalAssignments ? right.passingAssignments / right.totalAssignments : 0;
    return rightRate - leftRate || right.passingAssignments - left.passingAssignments || left.replayId.localeCompare(right.replayId);
  });

  return {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    replayCount: strictManifest ? replayIds.length : (corpusSchema.source?.replayCount ?? replayIds.length),
    versionGroups: (corpusSchema.versionGroups ?? []).map((group) => ({
      versionGroup: group.versionGroup,
      replayCount: group.replayCount,
    })),
    schema: {
      promotedPatterns: (corpusSchema.promotedPatterns ?? []).length,
      rankedPatterns: (corpusSchema.rankedPatterns ?? []).length,
      bundlePromotedPatterns: (corpusSchema.bundlePromotedPatterns ?? []).length,
      bundleRankedPatterns: (corpusSchema.bundleRankedPatterns ?? []).length,
      bundlePromotedPatternKeys: (corpusSchema.bundlePromotedPatterns ?? []).map((pattern) => pattern.patternKey),
    },
    scalar: {
      totalPasses: scalarTotals.totalPasses,
      totalChecks: scalarTotals.totalChecks,
      perMetric: Object.fromEntries(
        [...scalarTotals.perMetric.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([metricName, value]) => [metricName, value]),
      ),
    },
    movement: {
      passingAssignments: movementTotals.passingAssignments,
      totalAssignments: movementTotals.totalAssignments,
      replayCount: movementTotals.replayCount,
      topReplays: movementTotals.perReplay.slice(0, 8),
    },
    scorecard: {
      scalarPasses: scalarTotals.totalPasses,
      movementPasses: movementTotals.passingAssignments,
      promotedPatterns: (corpusSchema.promotedPatterns ?? []).length,
      promotedBundlePatterns: (corpusSchema.bundlePromotedPatterns ?? []).length,
    },
  };
}

function printHuman(summary) {
  console.log(`replays: ${summary.replayCount}`);
  console.log(
    `version_groups: ${summary.versionGroups.map((group) => `${group.versionGroup}:${group.replayCount}`).join(", ")}`,
  );
  console.log(
    `schema: promoted=${summary.schema.promotedPatterns} ranked=${summary.schema.rankedPatterns} bundle_promoted=${summary.schema.bundlePromotedPatterns} bundle_ranked=${summary.schema.bundleRankedPatterns}`,
  );
  console.log(`scalar: ${summary.scalar.totalPasses}/${summary.scalar.totalChecks}`);
  for (const [metricName, value] of Object.entries(summary.scalar.perMetric)) {
    console.log(`  ${metricName}: ${value.passes}/${value.total}`);
  }
  console.log(`movement: ${summary.movement.passingAssignments}/${summary.movement.totalAssignments}`);
  for (const replay of summary.movement.topReplays) {
    console.log(`  ${replay.replayId}: ${replay.passingAssignments}/${replay.totalAssignments}`);
  }
  console.log(
    `scorecard: scalar=${summary.scorecard.scalarPasses} movement=${summary.scorecard.movementPasses} promoted=${summary.scorecard.promotedPatterns} bundle=${summary.scorecard.promotedBundlePatterns}`,
  );
}

function main() {
  const args = parseArgs(process.argv);
  const summary = buildSummary(args.artifactRoot, { strictManifest: args.strictManifest });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  printHuman(summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
