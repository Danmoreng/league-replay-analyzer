#!/usr/bin/env node

// Tests the fully decoded 16.14 champion/keyframe payload for direct replay-
// native health and resource Float32LE lanes. This is a bounded negative or
// promotion gate; saved Timeline championStats are offline labels only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE_PATH = "packages/rofl-core/profiles/replay-decoder-profiles.v1.json";
const MANIFEST_PATH = "scripts/manifests/replay-participant-stat-snapshots-16.14.expected.json";

function parseArgs(argv) {
  const args = {
    cliPath: "build-linux/packages/rofl-core/rofl_core_cli",
    replayDir: "replays",
    apiRoot: "replays/api",
    profilePath: PROFILE_PATH,
    manifestPath: MANIFEST_PATH,
    outputPath: "tmp/keyframe-vitals-16.14.json",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--decoder-profiles" && argv[index + 1]) args.profilePath = argv[++index];
    else if (arg === "--manifest" && argv[index + 1]) args.manifestPath = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/research_keyframe_vitals_16_14.mjs [--cli <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function runJson(cliPath, cliArgs) {
  const result = spawnSync(cliPath, cliArgs, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `CLI exited with ${result.status}.`);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

function loadRows(args, grammar, fixtures) {
  const rows = [];
  for (const fixture of fixtures) {
    const replayId = fixture.replayId;
    const replayPath = path.join(args.replayDir, `${replayId}.rofl`);
    const timelinePath = path.join(args.apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    const dump = runJson(args.cliPath, [
      "--dump-packet-type-json", replayPath,
      "--packet-type", String(grammar.packetType),
      "--segment-type", "keyframe", "--max-blocks", "0",
    ]);
    for (let index = 0; index < dump.blocks.length; index += 1) {
      const block = dump.blocks[index];
      const participantId = block.blockParam - grammar.championNetworkIdBase;
      const stats = timeline.info.frames[Math.floor(index / 10)]
        ?.participantFrames?.[participantId]?.championStats;
      if (!stats || block.contentHexTruncated) throw new Error(`Vitals alignment failed for ${replayId}.`);
      rows.push({
        partition: fixture.partition,
        payload: Buffer.from(block.contentHex, "hex"),
        health: stats.health,
        healthMax: stats.healthMax,
        resource: stats.power,
        resourceMax: stats.powerMax,
      });
    }
  }
  return rows;
}

function candidateStats(rows, candidate, field, cipher) {
  let valid = 0;
  let exact = 0;
  let sumSquaredError = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  const targets = [];
  for (const row of rows) {
    const bytes = Buffer.from(candidate.offsets.map((offset) => cipher[row.payload[offset]]));
    const value = bytes.readFloatLE(0);
    const expected = row[field];
    if (!Number.isFinite(value) || value < -1 || value > 100_000 || !Number.isFinite(expected)) continue;
    const projected = candidate.projection === "round" ? Math.round(value) : Math.floor(value + 1e-5);
    const error = projected - expected;
    valid += 1;
    if (projected === expected) exact += 1;
    sumSquaredError += error * error;
    sumX += projected;
    sumY += expected;
    sumXX += projected * projected;
    sumYY += expected * expected;
    sumXY += projected * expected;
    targets.push(expected);
  }
  const denominator = Math.sqrt((valid * sumXX - sumX * sumX) * (valid * sumYY - sumY * sumY));
  const meanTarget = targets.reduce((sum, value) => sum + value, 0) / targets.length;
  const targetVariance = targets.reduce((sum, value) => sum + (value - meanTarget) ** 2, 0) / targets.length;
  const rmse = valid ? Math.sqrt(sumSquaredError / valid) : null;
  return {
    snapshotCount: rows.length,
    validCount: valid,
    exactCount: exact,
    exactRate: valid ? exact / valid : 0,
    correlation: denominator > 0 ? (valid * sumXY - sumX * sumY) / denominator : 0,
    rmse,
    normalizedRmse: targetVariance > 0 && rmse !== null ? rmse / Math.sqrt(targetVariance) : null,
  };
}

function scanMetric(discovery, holdout, field, grammar) {
  const candidates = [];
  for (const projection of ["floor", "round"]) {
    for (let stride = -8; stride <= 8; stride += 1) {
      if (stride === 0) continue;
      for (let start = 0; start < grammar.contentLength; start += 1) {
        const offsets = [0, 1, 2, 3].map((index) => start + index * stride);
        if (offsets.some((offset) => offset < 0 || offset >= grammar.contentLength)) continue;
        const candidate = { start, stride, offsets, projection };
        const stats = candidateStats(discovery, candidate, field, grammar.cipherToPlain);
        if (stats.validCount < discovery.length * 0.98) continue;
        candidates.push({ ...candidate, ...stats });
      }
    }
  }
  candidates.sort((left, right) =>
    left.normalizedRmse - right.normalizedRmse ||
    right.correlation - left.correlation ||
    right.exactRate - left.exactRate,
  );
  const topCandidates = candidates.slice(0, 12).map((candidate) => ({
    ...candidate,
    holdout: candidateStats(holdout, candidate, field, grammar.cipherToPlain),
  }));
  const promoted = topCandidates.filter((candidate) =>
    candidate.exactRate >= 0.98 && candidate.correlation >= 0.98 &&
    candidate.normalizedRmse <= 0.1 && candidate.holdout.exactRate >= 0.98 &&
    candidate.holdout.correlation >= 0.98 && candidate.holdout.normalizedRmse <= 0.1,
  );
  return {
    searchedCandidateCount: candidates.length,
    promotionCandidateCount: promoted.length,
    promotionCandidate: promoted.length === 1 ? promoted[0] : null,
    topCandidates,
  };
}

function main() {
  const args = parseArgs(process.argv);
  for (const key of Object.keys(args)) args[key] = path.resolve(args[key]);
  const registry = JSON.parse(fs.readFileSync(args.profilePath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, "utf8"));
  const grammar = registry.profiles.find((entry) => entry.versionGroup === "16.14")
    ?.keyframeParticipantStats;
  if (!grammar || grammar.cipherToPlain.some((plain) => plain === null)) {
    throw new Error("16.14 requires a complete productive keyframe cipher.");
  }
  const rows = loadRows(args, grammar, manifest.fixtures);
  const discovery = rows.filter((row) => row.partition === "D7");
  const holdout = rows.filter((row) => row.partition === "H3");
  const metrics = Object.fromEntries(
    ["health", "healthMax", "resource", "resourceMax"].map((field) => [
      field, scanMetric(discovery, holdout, field, grammar),
    ]),
  );
  const report = {
    schema: "rofl-keyframe-vitals-16.14-research/v1",
    generatedAtUtc: new Date().toISOString(),
    source: {
      replayInput: "Saved ROFL champion-owned keyframe packet bytes.",
      offlineOracle: "Saved Riot Timeline championStats health/healthMax/power/powerMax.",
      runtimeRiotInput: false,
    },
    grammar: {
      exactBuild: "16.14.794.5912", packetType: grammar.packetType,
      contentLength: grammar.contentLength, encoding: "cipher-decoded Float32LE",
      strides: [[-8, -1], [1, 8]],
    },
    partitions: { Discovery: discovery.length, Holdout: holdout.length },
    promotionGate: "Unique candidate with >=98% exact, >=0.98 correlation, and <=0.1 normalized RMSE on both partitions.",
    metrics,
    anyPromotionCandidate: Object.values(metrics).some((metric) => metric.promotionCandidate !== null),
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(Object.fromEntries(Object.entries(metrics).map(([field, metric]) => [field, {
    promotionCandidateCount: metric.promotionCandidateCount,
    best: metric.topCandidates[0] ?? null,
  }])), null, 2));
}

main();
