#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    thresholds: [0.35, 0.3, 0.25, 0.2],
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--thresholds" && index + 1 < argv.length) {
      args.thresholds = argv[++index].split(",").map((value) => Number.parseFloat(value));
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (args.thresholds.some((value) => !Number.isFinite(value))) {
    throw new Error("All --thresholds values must be finite numbers.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/sweep_rofl_identity_support_thresholds.mjs [--version-group 16.9] [--thresholds 0.35,0.3,0.25,0.2]");
}

function thresholdLabel(value) {
  return String(value).replace(".", "p");
}

function scenarioLabel(scenario) {
  return scenario.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function runNode(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `keyframe-rofl-stat-support-threshold-sweep-${args.versionGroup}.json`),
  );
  const assignScript = path.join("scripts", "assign_keyframe_slots_from_rofl_stats.mjs");
  const compareScript = path.join("scripts", "compare_rofl_stat_assignments_to_supervised.mjs");

  const rows = [];
  for (const threshold of args.thresholds) {
    const label = thresholdLabel(threshold);
    const assignmentPath = path.join(artifactRoot, `keyframe-rofl-stat-slot-assignments-${args.versionGroup}-minsupport-${label}.json`);
    const comparisonPath = path.join(artifactRoot, `keyframe-rofl-stat-supervised-comparison-${args.versionGroup}-minsupport-${label}.json`);
    runNode(assignScript, [
      "--version-group",
      args.versionGroup,
      "--artifact-root",
      artifactRoot,
      "--min-support-score",
      String(threshold),
      "--output-path",
      assignmentPath,
    ]);
    runNode(compareScript, [
      "--version-group",
      args.versionGroup,
      "--artifact-root",
      artifactRoot,
      "--rofl-stats-path",
      assignmentPath,
      "--output-path",
      comparisonPath,
    ]);
    const assignment = readJson(assignmentPath);
    const comparison = readJson(comparisonPath);
    rows.push({
      minSupportScore: threshold,
      assignmentPath,
      comparisonPath,
      assignmentCount: assignment.totals?.assignmentCount ?? null,
      edgeCount: assignment.totals?.edgeCount ?? null,
      canonicalCandidateCount: assignment.totals?.confidence?.canonicalCandidateCount ?? null,
      diagnosticOnlyCount: assignment.totals?.confidence?.diagnosticOnlyCount ?? null,
      belowWinnerGapCount: assignment.totals?.confidence?.belowWinnerGapCount ?? null,
      comparisonCounts: comparison.totals?.byComparison ?? {},
      canonicalMatchCount: comparison.totals?.canonicalMatchCount ?? null,
      diagnosticMatchCount: comparison.totals?.diagnosticMatchCount ?? null,
      diagnosticConflictCount: comparison.totals?.diagnosticConflictCount ?? null,
    });
  }

  const relaxedNegativeControls = [
    {
      name: "unsafe-single-metric",
      reason: "Shows why one-metric keyframe row assignments are not accepted as runtime participant identity.",
      args: [
        "--min-metric-count",
        "1",
        "--min-distinct-metric-count",
        "1",
        "--min-support-score",
        "0.2",
        "--min-winner-gap",
        "0",
      ],
    },
  ];
  const negativeControlRows = [];
  for (const scenario of relaxedNegativeControls) {
    const label = scenarioLabel(scenario);
    const assignmentPath = path.join(artifactRoot, `keyframe-rofl-stat-slot-assignments-${args.versionGroup}-${label}.json`);
    const comparisonPath = path.join(artifactRoot, `keyframe-rofl-stat-supervised-comparison-${args.versionGroup}-${label}.json`);
    runNode(assignScript, [
      "--version-group",
      args.versionGroup,
      "--artifact-root",
      artifactRoot,
      ...scenario.args,
      "--output-path",
      assignmentPath,
    ]);
    runNode(compareScript, [
      "--version-group",
      args.versionGroup,
      "--artifact-root",
      artifactRoot,
      "--rofl-stats-path",
      assignmentPath,
      "--output-path",
      comparisonPath,
    ]);
    const assignment = readJson(assignmentPath);
    const comparison = readJson(comparisonPath);
    negativeControlRows.push({
      name: scenario.name,
      reason: scenario.reason,
      assignmentPath,
      comparisonPath,
      assignmentCount: assignment.totals?.assignmentCount ?? null,
      edgeCount: assignment.totals?.edgeCount ?? null,
      maxCandidateMetricCount: assignment.totals?.diagnostics?.maxCandidateMetricCount ?? null,
      comparisonCounts: comparison.totals?.byComparison ?? {},
      canonicalMatchCount: comparison.totals?.canonicalMatchCount ?? null,
      diagnosticMatchCount: comparison.totals?.diagnosticMatchCount ?? null,
      diagnosticConflictCount: comparison.totals?.diagnosticConflictCount ?? null,
    });
  }

  const output = {
    sweepSchema: "rofl-keyframe-stat-support-threshold-sweep/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    thresholds: args.thresholds,
    rows,
    negativeControlRows,
  };
  writeJson(outputPath, output);
  console.log(`Wrote ROFL identity support threshold sweep to ${outputPath}`);
  console.log(`thresholds: ${args.thresholds.join(", ")}`);
  console.log(`assignments: ${rows.map((row) => `${row.minSupportScore}=${row.assignmentCount}`).join(", ")}`);
  console.log(`negative controls: ${negativeControlRows.map((row) => `${row.name}=${row.assignmentCount} (${JSON.stringify(row.comparisonCounts)})`).join(", ")}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
