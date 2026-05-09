import fs from "fs";
import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: null,
    familyKey: null,
    bundlePath: null,
    minReplaySupport: 3,
    minMetricCount: 4,
    minBundleScore: 0.78,
    minReplayOverlap: 0.55,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--family-key" && index + 1 < argv.length) {
      args.familyKey = argv[++index];
    } else if (arg === "--bundle-path" && index + 1 < argv.length) {
      args.bundlePath = argv[++index];
    } else if (arg === "--min-replay-support" && index + 1 < argv.length) {
      args.minReplaySupport = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-metric-count" && index + 1 < argv.length) {
      args.minMetricCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-bundle-score" && index + 1 < argv.length) {
      args.minBundleScore = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-replay-overlap" && index + 1 < argv.length) {
      args.minReplayOverlap = Number.parseFloat(argv[++index]);
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.bundlePath && (!args.versionGroup || !args.familyKey)) {
    throw new Error("Provide either --bundle-path <path> or both --version-group <value> and --family-key <value>.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/recommend_scalar_family_bundle_metrics.mjs [--artifact-root <path>] (--bundle-path <path> | --version-group <value> --family-key <family>) [--min-replay-support <n>] [--min-metric-count <n>] [--min-bundle-score <n>] [--min-replay-overlap <n>] [--output-path <path>]");
}

function buildBundlePath(artifactRoot, versionGroup, familyKey, explicitBundlePath) {
  if (explicitBundlePath) {
    return explicitBundlePath;
  }
  return path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `family-bundles-${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
  );
}

function buildOutputPath(artifactRoot, versionGroup, familyKey, explicitOutputPath) {
  if (explicitOutputPath) {
    return explicitOutputPath;
  }
  return path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `family-bundle-recommendations-${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
  );
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const bundlePath = resolveAbsolute(
    repoRoot,
    buildBundlePath(artifactRoot, args.versionGroup, args.familyKey, args.bundlePath),
  );
  if (!fs.existsSync(bundlePath)) {
    throw new Error(`Bundle file not found: ${bundlePath}`);
  }

  const bundleReport = readJson(bundlePath);
  const versionGroup = args.versionGroup ?? bundleReport.versionGroup;
  const familyKey = args.familyKey ?? bundleReport.familyKey;
  const outputPath = resolveAbsolute(
    repoRoot,
    buildOutputPath(artifactRoot, versionGroup, familyKey, args.outputPath),
  );

  const viableBundles = (bundleReport.bundles ?? [])
    .filter((bundle) =>
      bundle.metricCount >= args.minMetricCount &&
      bundle.bundleScore >= args.minBundleScore &&
      bundle.replayOverlap >= args.minReplayOverlap
    )
    .map((bundle) => ({
      ...bundle,
      recommendedMetrics: (bundle.metrics ?? []).filter((metric) => (metric.replaySupport ?? 0) >= args.minReplaySupport),
    }))
    .filter((bundle) => bundle.recommendedMetrics.length >= args.minMetricCount - 1)
    .sort((left, right) =>
      right.bundleScore - left.bundleScore ||
      right.replayOverlap - left.replayOverlap ||
      right.strongMetricCount - left.strongMetricCount
    );

  const primaryBundle = viableBundles[0] ?? null;
  const output = {
    generatedAtUtc: new Date().toISOString(),
    source: bundlePath,
    versionGroup,
    familyKey,
    thresholds: {
      minReplaySupport: args.minReplaySupport,
      minMetricCount: args.minMetricCount,
      minBundleScore: args.minBundleScore,
      minReplayOverlap: args.minReplayOverlap,
    },
    viableBundleCount: viableBundles.length,
    primaryBundle: primaryBundle ? {
      anchorMetric: primaryBundle.anchorMetric,
      anchorGroupKey: primaryBundle.anchorGroupKey,
      metricCount: primaryBundle.metricCount,
      strongMetricCount: primaryBundle.strongMetricCount,
      weakMetricCount: primaryBundle.weakMetricCount,
      slotBand: primaryBundle.slotBand,
      slotCompactness: primaryBundle.slotCompactness,
      replayOverlap: primaryBundle.replayOverlap,
      uniqueOffsets: primaryBundle.uniqueOffsets,
      bundleScore: primaryBundle.bundleScore,
      recommendedMetrics: primaryBundle.recommendedMetrics,
    } : null,
    viableBundles: viableBundles.map((bundle) => ({
      anchorMetric: bundle.anchorMetric,
      anchorGroupKey: bundle.anchorGroupKey,
      metricCount: bundle.metricCount,
      strongMetricCount: bundle.strongMetricCount,
      weakMetricCount: bundle.weakMetricCount,
      slotBand: bundle.slotBand,
      slotCompactness: bundle.slotCompactness,
      replayOverlap: bundle.replayOverlap,
      uniqueOffsets: bundle.uniqueOffsets,
      bundleScore: bundle.bundleScore,
      recommendedMetricKeys: bundle.recommendedMetrics.map((metric) => metric.metric),
    })),
  };

  writeJson(outputPath, output);
  console.log(`Wrote scalar family bundle recommendations to ${outputPath}`);
}

main();
