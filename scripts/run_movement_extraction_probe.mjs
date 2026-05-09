#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    replayListPath: null,
    maxPatterns: 50,
    maxRawCandidatesPerPattern: 14,
    maxCandidateMatchSupplementPatterns: 0,
    outputFile: "extracted-movement-max50.json",
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-list-path" && index + 1 < argv.length) args.replayListPath = argv[++index];
    else if (arg === "--max-patterns" && index + 1 < argv.length) args.maxPatterns = Number.parseInt(argv[++index], 10);
    else if (arg === "--max-raw-candidates-per-pattern" && index + 1 < argv.length) args.maxRawCandidatesPerPattern = Number.parseInt(argv[++index], 10);
    else if (arg === "--max-candidate-match-supplement-patterns" && index + 1 < argv.length) args.maxCandidateMatchSupplementPatterns = Number.parseInt(argv[++index], 10);
    else if (arg === "--output-file" && index + 1 < argv.length) args.outputFile = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/run_movement_extraction_probe.mjs [--artifact-root artifacts] [--version-group 16.9] [--max-patterns 50] [--max-raw-candidates-per-pattern 14] [--max-candidate-match-supplement-patterns 0] [--output-file extracted-movement-max50.json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function replayListPathForVersion(versionGroup) {
  return path.join("artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
}

function discoverReplayIds(args) {
  const replayListPath = resolveAbsolute(process.cwd(), args.replayListPath ?? replayListPathForVersion(args.versionGroup));
  if (fs.existsSync(replayListPath)) {
    const replayList = readJson(replayListPath);
    return (replayList.replays ?? [])
      .filter((replay) => !replay.skipped)
      .map((replay) => replay.replayId)
      .filter(Boolean)
      .sort();
  }
  const artifactRoot = resolveAbsolute(process.cwd(), args.artifactRoot);
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replayIds = discoverReplayIds(args);
  const rows = [];
  for (const replayId of replayIds) {
    const artifactDir = path.join(artifactRoot, replayId);
    if (!fs.existsSync(path.join(artifactDir, "movement-provisional-schema.json"))) {
      rows.push({ replayId, status: "skipped", reason: "missing movement-provisional-schema.json" });
      continue;
    }
    runNode(path.join("scripts", "extract_replay_movement.mjs"), [
      "--artifact-dir",
      artifactDir,
      "--max-patterns",
      String(args.maxPatterns),
      "--max-raw-candidates-per-pattern",
      String(args.maxRawCandidatesPerPattern),
      "--max-candidate-match-supplement-patterns",
      String(args.maxCandidateMatchSupplementPatterns),
      "--output-path",
      path.join(artifactDir, args.outputFile),
    ]);
    rows.push({ replayId, status: "processed" });
  }
  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-extraction-probe-run/v1",
    versionGroup: args.versionGroup,
    artifactRoot,
    maxPatterns: args.maxPatterns,
    maxRawCandidatesPerPattern: args.maxRawCandidatesPerPattern,
    maxCandidateMatchSupplementPatterns: args.maxCandidateMatchSupplementPatterns,
    outputFile: args.outputFile,
    replayCount: rows.length,
    processedReplayCount: rows.filter((row) => row.status === "processed").length,
    skippedReplayCount: rows.filter((row) => row.status === "skipped").length,
    rows,
  };
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-extraction-probe-${args.versionGroup}-max${args.maxPatterns}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement extraction probe report to ${outputPath}`);
  console.log(`processed=${output.processedReplayCount} skipped=${output.skippedReplayCount}`);
}

main();
