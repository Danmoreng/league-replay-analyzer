import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    inputPath: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_scalar_family_hotspots.mjs [--artifact-root <path>] [--input-path <path>] [--output-path <path>]");
}

function extractFamilyKey(groupKey) {
  const parts = String(groupKey).split("|");
  return parts.length >= 4 ? parts[1] : null;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const inputPath = args.inputPath
    ? resolveAbsolute(repoRoot, args.inputPath)
    : path.join(artifactRoot, "scalar-metric-discovery", "sweep-summary.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "scalar-metric-discovery", "family-hotspots.json");

  const sweep = readJson(inputPath);
  const hotspots = new Map();

  for (const result of sweep.results ?? []) {
    for (const candidate of result.topNearMisses ?? []) {
      const familyKey = extractFamilyKey(candidate.groupKey);
      if (!familyKey) {
        continue;
      }

      const hotspotKey = `${result.versionGroup}|${familyKey}`;
      const current = hotspots.get(hotspotKey) ?? {
        hotspotKey,
        versionGroup: result.versionGroup,
        familyKey,
        metrics: new Map(),
        examples: [],
      };

      current.metrics.set(result.metric, {
        metric: result.metric,
        replayCount: result.replayCount,
        nearMissScore: candidate.nearMissScore,
        replaySupport: candidate.replaySupport,
        medianParticipants: candidate.medianParticipants,
        slotCompactness: candidate.slotCompactness ?? null,
        medianCorrelation: candidate.medianCorrelation,
        medianAbsoluteDeltaCorrelation: candidate.medianAbsoluteDeltaCorrelation,
        medianSpecificityScore: candidate.medianSpecificityScore,
        medianConfusionScore: candidate.medianConfusionScore,
        groupKey: candidate.groupKey,
      });
      current.examples.push({
        metric: result.metric,
        groupKey: candidate.groupKey,
        nearMissScore: candidate.nearMissScore,
      });
      hotspots.set(hotspotKey, current);
    }
  }

  const rankedHotspots = [...hotspots.values()]
    .map((entry) => {
      const metrics = [...entry.metrics.values()].sort((left, right) => right.nearMissScore - left.nearMissScore);
      return {
        hotspotKey: entry.hotspotKey,
        versionGroup: entry.versionGroup,
        familyKey: entry.familyKey,
        metricCount: metrics.length,
        avgNearMissScore: metrics.reduce((sum, metric) => sum + metric.nearMissScore, 0) / Math.max(metrics.length, 1),
        bestNearMissScore: metrics[0]?.nearMissScore ?? 0,
        maxReplaySupport: Math.max(...metrics.map((metric) => metric.replaySupport)),
        metrics,
      };
    })
    .sort((left, right) =>
      right.metricCount - left.metricCount ||
      right.avgNearMissScore - left.avgNearMissScore ||
      right.bestNearMissScore - left.bestNearMissScore ||
      right.maxReplaySupport - left.maxReplaySupport
    );

  writeJson(outputPath, {
    generatedAtUtc: new Date().toISOString(),
    source: inputPath,
    hotspots: rankedHotspots,
  });

  console.log(`Wrote scalar family hotspots to ${outputPath}`);
}

main();
