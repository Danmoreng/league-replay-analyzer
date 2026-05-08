#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    versionGroup: "16.9",
    outputPath: null,
    requirePerfectMatch: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--allow-validation-mismatch") {
      args.requirePerfectMatch = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/validate_rofl_api_parity_corpus.mjs [--version-group 16.9]");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  return separatorIndex < 0 ? replayId : `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
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

function discoverReplayIds(artifactRoot, apiRoot, versionGroup) {
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((replayId) => {
      const summaryPath = path.join(artifactRoot, replayId, "summary.json");
      const fixtureDir = path.join(apiRoot, normalizeFixtureReplayId(replayId));
      if (!fs.existsSync(summaryPath) || !fs.existsSync(path.join(fixtureDir, "match.json"))) {
        return false;
      }
      const summary = readJson(summaryPath);
      return String(summary.gameVersion ?? "").startsWith(versionGroup);
    })
    .sort();
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const apiRoot = resolveAbsolute(root, args.apiRoot);
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `rofl-api-parity-corpus-validation-${args.versionGroup}.json`),
  );
  const replayIds = discoverReplayIds(artifactRoot, apiRoot, args.versionGroup);
  const exportScript = path.join("scripts", "export_rofl_api_metrics.mjs");
  const validateScript = path.join("scripts", "validate_rofl_api_metrics_against_riot.mjs");

  const rows = [];
  for (const replayId of replayIds) {
    runNode(exportScript, [
      "--replay-id",
      replayId,
      "--artifact-root",
      artifactRoot,
    ]);
    runNode(validateScript, [
      "--replay-id",
      replayId,
      "--artifact-root",
      artifactRoot,
      "--api-root",
      apiRoot,
    ]);
    const validationPath = path.join(artifactRoot, replayId, "rofl-api-metrics-riot-validation.json");
    const validation = readJson(validationPath);
    rows.push({
      replayId,
      validationPath,
      participant: {
        pass: validation.totals?.passCount ?? null,
        total: validation.totals?.comparisonCount ?? null,
        fail: validation.totals?.failCount ?? null,
      },
      team: {
        pass: validation.totals?.teamPassCount ?? null,
        total: validation.totals?.teamComparisonCount ?? null,
        fail: validation.totals?.teamFailCount ?? null,
      },
      finalTimeline: {
        pass: validation.totals?.finalTimelinePassCount ?? null,
        total: validation.totals?.finalTimelineComparisonCount ?? null,
        fail: validation.totals?.finalTimelineFailCount ?? null,
      },
      metadata: {
        pass: validation.totals?.metadataPassCount ?? null,
        total: validation.totals?.metadataComparisonCount ?? null,
        fail: validation.totals?.metadataFailCount ?? null,
      },
      identifiers: {
        pass: validation.totals?.identifierPassCount ?? null,
        total: validation.totals?.identifierComparisonCount ?? null,
        fail: validation.totals?.identifierFailCount ?? null,
      },
      failureSummary: {
        participantFields: countBy((validation.failures ?? []).map((failure) => failure.field)),
        teamFields: countBy((validation.teamFailures ?? []).map((failure) => failure.field)),
        finalTimelineFields: countBy((validation.finalTimelineFailures ?? []).map((failure) => failure.field)),
        metadataFields: countBy((validation.metadataFailures ?? []).map((failure) => failure.field)),
      },
    });
  }

  const totals = rows.reduce((acc, row) => {
    for (const section of ["participant", "team", "finalTimeline", "metadata", "identifiers"]) {
      acc[section].pass += row[section].pass ?? 0;
      acc[section].total += row[section].total ?? 0;
      acc[section].fail += row[section].fail ?? 0;
    }
    return acc;
  }, {
    participant: { pass: 0, total: 0, fail: 0 },
    team: { pass: 0, total: 0, fail: 0 },
    finalTimeline: { pass: 0, total: 0, fail: 0 },
    metadata: { pass: 0, total: 0, fail: 0 },
    identifiers: { pass: 0, total: 0, fail: 0 },
  });
  const output = {
    corpusValidationSchema: "rofl-api-parity-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-validation-only",
    runtimeInput: false,
    versionGroup: args.versionGroup,
    replayCount: rows.length,
    artifactRoot,
    apiRoot,
    totals,
    failureSummary: {
      participantFields: mergeCounts(rows.map((row) => row.failureSummary.participantFields)),
      teamFields: mergeCounts(rows.map((row) => row.failureSummary.teamFields)),
      finalTimelineFields: mergeCounts(rows.map((row) => row.failureSummary.finalTimelineFields)),
      metadataFields: mergeCounts(rows.map((row) => row.failureSummary.metadataFields)),
    },
    rows,
  };
  writeJson(outputPath, output);
  console.log(`Wrote ROFL API parity corpus validation to ${outputPath}`);
  console.log(`corpus replays: ${rows.length}`);
  console.log(`participant parity: ${totals.participant.pass}/${totals.participant.total}`);
  console.log(`team parity: ${totals.team.pass}/${totals.team.total}`);
  console.log(`final timeline parity: ${totals.finalTimeline.pass}/${totals.finalTimeline.total}`);
  console.log(`metadata parity: ${totals.metadata.pass}/${totals.metadata.total}`);
  if (args.requirePerfectMatch && (
    totals.participant.fail !== 0 ||
    totals.team.fail !== 0 ||
    totals.finalTimeline.fail !== 0 ||
    totals.metadata.fail !== 0
  )) {
    throw new Error(`ROFL/API corpus validation had required failures: ${JSON.stringify(totals)}`);
  }
}

function countBy(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value ?? "<missing>");
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function mergeCounts(countsList) {
  const merged = {};
  for (const counts of countsList) {
    for (const [key, value] of Object.entries(counts ?? {})) {
      merged[key] = (merged[key] ?? 0) + value;
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([left], [right]) => left.localeCompare(right)));
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
