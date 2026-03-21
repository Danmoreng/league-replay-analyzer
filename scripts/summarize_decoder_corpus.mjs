#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    artifactRoot: path.resolve("artifacts"),
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--artifact-root") {
      args.artifactRoot = path.resolve(argv[index + 1]);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
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

function buildSummary(artifactRoot) {
  const corpusSchemaPath = path.join(artifactRoot, "corpus-schema.json");
  const corpusSchema = readJson(corpusSchemaPath);
  const replayIds = fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

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
    replayCount: corpusSchema.source?.replayCount ?? replayIds.length,
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
  const summary = buildSummary(args.artifactRoot);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  printHuman(summary);
}

main();
