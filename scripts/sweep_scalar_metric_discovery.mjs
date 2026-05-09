import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import {
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const DEFAULT_METRICS = ["health", "power", "healthMax", "powerMax", "movementSpeed"];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    metrics: DEFAULT_METRICS,
    minReplayCount: 2,
    outputPath: null,
    versionGroups: [],
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--metrics" && index + 1 < argv.length) {
      args.metrics = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--min-replay-count" && index + 1 < argv.length) {
      args.minReplayCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroups.push(argv[++index]);
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
  console.log("Usage: node ./scripts/sweep_scalar_metric_discovery.mjs [--artifact-root <path>] [--metrics health,power,...] [--min-replay-count <n>] [--version-group <value>] [--output-path <path>]");
}

function discoverVersionGroups(artifactRoot) {
  const counts = new Map();
  for (const entry of fs.readdirSync(artifactRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const summaryPath = path.join(artifactRoot, entry.name, "summary.json");
    if (!fs.existsSync(summaryPath)) {
      continue;
    }
    const summary = readJson(summaryPath);
    const versionGroup = parseVersionGroup(summary.gameVersion);
    if (!versionGroup) {
      continue;
    }
    counts.set(versionGroup, (counts.get(versionGroup) ?? 0) + 1);
  }
  return counts;
}

function runScanner(repoRoot, artifactRoot, versionGroup, metric) {
  const scriptPath = path.join(repoRoot, "scripts", "discover_scalar_metric_candidates.mjs");
  execFileSync(
    process.execPath,
    [scriptPath, "--artifact-root", artifactRoot, "--version-group", versionGroup, "--metric", metric],
    { cwd: repoRoot, stdio: "inherit" },
  );

  const reportPath = path.join(artifactRoot, "scalar-metric-discovery", versionGroup, `${metric}.json`);
  return readJson(reportPath);
}

function summarizeReport(report) {
  const nearMissScore = (entry) => (
    (Math.min(entry.replaySupport ?? 0, 4) / 4 * 0.28) +
    (Math.min(entry.medianParticipants ?? 0, 10) / 10 * 0.2) +
    (Math.max(0, Math.min(entry.slotCompactness ?? 0, 1)) * 0.14) +
    (Math.max(0, Math.min(entry.medianCorrelation ?? 0, 1)) * 0.18) +
    (Math.max(0, Math.min(entry.medianAbsoluteDeltaCorrelation ?? 0, 1)) * 0.14) +
    (Math.max(0, Math.min(entry.medianSpecificityScore ?? 0, 1)) * 0.14) +
    ((1 - Math.max(0, Math.min(entry.medianConfusionScore ?? 0, 1))) * 0.06)
  );
  const topWatchlist = (report.watchlistCandidates ?? []).slice(0, 3).map((entry) => ({
    groupKey: entry.groupKey,
    replaySupport: entry.replaySupport,
    medianParticipants: entry.medianParticipants,
    slotCompactness: entry.slotCompactness ?? null,
    medianCorrelation: entry.medianCorrelation,
    medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
    medianLowTailAgreement: entry.medianLowTailAgreement ?? null,
    medianSpecificityScore: entry.medianSpecificityScore,
    medianConfusionScore: entry.medianConfusionScore,
  }));

  const topRecommended = (report.recommendedCandidates ?? []).slice(0, 3).map((entry) => ({
    groupKey: entry.groupKey,
    replaySupport: entry.replaySupport,
    medianParticipants: entry.medianParticipants,
    slotCompactness: entry.slotCompactness ?? null,
    medianCorrelation: entry.medianCorrelation,
    medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
    medianLowTailAgreement: entry.medianLowTailAgreement ?? null,
    medianSpecificityScore: entry.medianSpecificityScore,
    medianConfusionScore: entry.medianConfusionScore,
  }));

  const topNearMisses = (report.exactSupport ?? [])
    .map((entry) => ({
      groupKey: entry.groupKey,
      replaySupport: entry.replaySupport,
      medianParticipants: entry.medianParticipants,
      slotCompactness: entry.slotCompactness ?? null,
      medianCorrelation: entry.medianCorrelation,
      medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
      medianLowTailAgreement: entry.medianLowTailAgreement ?? null,
      medianSpeedBoostAgreement: entry.medianSpeedBoostAgreement ?? null,
      medianSpecificityScore: entry.medianSpecificityScore,
      medianConfusionScore: entry.medianConfusionScore,
      nearMissScore: nearMissScore(entry),
    }))
    .sort((left, right) =>
      right.nearMissScore - left.nearMissScore ||
      right.replaySupport - left.replaySupport ||
      right.medianParticipants - left.medianParticipants ||
      right.medianCorrelation - left.medianCorrelation
    )
    .slice(0, 5);

  const topFamilyBandNearMisses = (report.familyBandSupport ?? [])
    .map((entry) => ({
      groupKey: entry.groupKey,
      replaySupport: entry.replaySupport,
      medianParticipants: entry.medianParticipants,
      slotCompactness: entry.slotCompactness ?? null,
      medianCorrelation: entry.medianCorrelation,
      medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
      medianLowTailAgreement: entry.medianLowTailAgreement ?? null,
      medianSpeedBoostAgreement: entry.medianSpeedBoostAgreement ?? null,
      medianSpecificityScore: entry.medianSpecificityScore,
      medianConfusionScore: entry.medianConfusionScore,
      nearMissScore: nearMissScore(entry),
    }))
    .sort((left, right) =>
      right.nearMissScore - left.nearMissScore ||
      right.replaySupport - left.replaySupport ||
      right.medianParticipants - left.medianParticipants ||
      right.medianCorrelation - left.medianCorrelation
    )
    .slice(0, 5);

  return {
    replayCount: report.replayCount ?? 0,
    exactGroupCount: report.exactSupport?.length ?? 0,
    familyBandCount: report.familyBandSupport?.length ?? 0,
    watchlistCount: report.watchlistCandidates?.length ?? 0,
    recommendedCount: report.recommendedCandidates?.length ?? 0,
    topWatchlist,
    topRecommended,
    topNearMisses,
    topFamilyBandNearMisses,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const detectedVersionCounts = discoverVersionGroups(artifactRoot);
  const versionGroups = args.versionGroups.length
    ? args.versionGroups
    : [...detectedVersionCounts.entries()]
      .filter(([, replayCount]) => replayCount >= args.minReplayCount)
      .map(([versionGroup]) => versionGroup)
      .sort();

  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "scalar-metric-discovery", "sweep-summary.json");

  const results = [];
  for (const versionGroup of versionGroups) {
    const replayCount = detectedVersionCounts.get(versionGroup) ?? 0;
    for (const metric of args.metrics) {
      const report = runScanner(repoRoot, artifactRoot, versionGroup, metric);
      results.push({
        versionGroup,
        replayCount,
        metric,
        ...summarizeReport(report),
      });
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    metrics: args.metrics,
    minReplayCount: args.minReplayCount,
    versionGroups,
    versionReplayCounts: Object.fromEntries([...detectedVersionCounts.entries()].sort()),
    results,
  };

  writeJson(outputPath, output);
  console.log(`Wrote scalar metric sweep summary to ${outputPath}`);
}

main();
