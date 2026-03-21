import fs from "fs";
import path from "path";

import {
  average,
  clamp,
  metricDefinitions,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: null,
    familyKey: null,
    metrics: metricDefinitions.map((metric) => metric.key),
    slotRadius: 4,
    maxCandidatesPerMetric: 8,
    maxBundles: 12,
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
    } else if (arg === "--metrics" && index + 1 < argv.length) {
      args.metrics = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--slot-radius" && index + 1 < argv.length) {
      args.slotRadius = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-candidates-per-metric" && index + 1 < argv.length) {
      args.maxCandidatesPerMetric = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-bundles" && index + 1 < argv.length) {
      args.maxBundles = Number.parseInt(argv[++index], 10);
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.versionGroup) {
    throw new Error("Missing required --version-group <value> argument.");
  }
  if (!args.familyKey) {
    throw new Error("Missing required --family-key <value> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/build_scalar_family_bundle_candidates.mjs --version-group <value> --family-key <family> [--artifact-root <path>] [--metrics <a,b,c>] [--slot-radius <n>] [--max-candidates-per-metric <n>] [--max-bundles <n>] [--output-path <path>]");
}

function buildOutputPath(artifactRoot, versionGroup, familyKey, explicitOutputPath) {
  if (explicitOutputPath) {
    return explicitOutputPath;
  }

  const safeFamilyKey = familyKey.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `family-bundles-${safeFamilyKey}.json`,
  );
}

function loadMetricReport(artifactRoot, versionGroup, metricKey) {
  const reportPath = path.join(artifactRoot, "scalar-metric-discovery", versionGroup, `${metricKey}.json`);
  if (!fs.existsSync(reportPath)) {
    return null;
  }
  return readJson(reportPath);
}

function baseCandidateScore(entry) {
  const replaySupportFactor = Math.min(entry.replaySupport ?? 0, 5) / 5;
  const participantFactor = Math.min(entry.medianParticipants ?? 0, 10) / 10;
  const slotCompactness = clamp(entry.slotCompactness ?? 0, 0, 1);
  const correlationFactor = clamp(entry.medianCorrelation ?? 0, 0, 1);
  const absoluteDeltaFactor = clamp(entry.medianAbsoluteDeltaCorrelation ?? 0, 0, 1);
  const specificityFactor = clamp(entry.medianSpecificityScore ?? 0, 0, 1);
  const confusionPenalty = 1 - clamp(entry.medianConfusionScore ?? 0, 0, 1);
  return (
    (0.22 * replaySupportFactor) +
    (0.16 * participantFactor) +
    (0.16 * slotCompactness) +
    (0.18 * correlationFactor) +
    (0.1 * absoluteDeltaFactor) +
    (0.12 * specificityFactor) +
    (0.06 * confusionPenalty)
  );
}

function metricSpecificScore(entry, metricKey) {
  let score = baseCandidateScore(entry);

  if (metricKey === "health") {
    score += 0.08 * clamp(entry.medianLowTailAgreement ?? 0, 0, 1);
  }
  if (metricKey === "movementSpeed") {
    score += 0.08 * clamp(entry.medianSpeedBoostAgreement ?? 0, 0, 1);
  }
  if (metricKey === "healthMax" || metricKey === "powerMax") {
    const stabilityBonus = clamp(1 - Math.abs(entry.medianAbsoluteDeltaCorrelation ?? 0), 0, 1);
    score += 0.06 * stabilityBonus;
  }

  return score;
}

function chooseTopCandidatesByMetric(reportsByMetric, familyKey, maxCandidatesPerMetric) {
  const result = new Map();

  for (const [metricKey, report] of reportsByMetric.entries()) {
    const candidates = (report.exactSupport ?? [])
      .filter((entry) => entry.familyKeys?.includes(familyKey))
      .map((entry) => ({
        ...entry,
        metric: metricKey,
        bundleCandidateScore: metricSpecificScore(entry, metricKey),
      }))
      .sort((left, right) =>
        right.bundleCandidateScore - left.bundleCandidateScore ||
        right.replaySupport - left.replaySupport ||
        right.slotCompactness - left.slotCompactness ||
        right.medianCorrelation - left.medianCorrelation
      )
      .slice(0, maxCandidatesPerMetric);

    result.set(metricKey, candidates);
  }

  return result;
}

function computeReplayOverlap(entries) {
  if (entries.length < 2) {
    return 1;
  }

  const scores = [];
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = new Set(entries[leftIndex].replayIds ?? []);
      const right = new Set(entries[rightIndex].replayIds ?? []);
      const intersection = [...left].filter((replayId) => right.has(replayId)).length;
      const union = new Set([...left, ...right]).size;
      scores.push(union > 0 ? (intersection / union) : 0);
    }
  }
  return average(scores);
}

function computeOffsetConflictStats(entries) {
  const offsetCounts = new Map();
  for (const entry of entries) {
    const key = String(entry.offset);
    offsetCounts.set(key, (offsetCounts.get(key) ?? 0) + 1);
  }

  let duplicateCount = 0;
  for (const count of offsetCounts.values()) {
    if (count > 1) {
      duplicateCount += count - 1;
    }
  }

  const uniqueOffsets = offsetCounts.size;
  const uniquenessRatio = uniqueOffsets / Math.max(entries.length, 1);
  return {
    uniqueOffsets,
    duplicateOffsetCount: duplicateCount,
    uniquenessRatio,
  };
}

function buildBundle(anchor, topByMetric, slotRadius) {
  const selectedByMetric = new Map([[anchor.metric, anchor]]);

  for (const [metricKey, candidates] of topByMetric.entries()) {
    if (metricKey === anchor.metric) {
      continue;
    }

    const sibling = candidates
      .map((candidate) => ({
        ...candidate,
        distanceToAnchor: Math.abs((candidate.medianSlotIndex ?? 0) - (anchor.medianSlotIndex ?? 0)),
        duplicateGroupPenalty: [...selectedByMetric.values()].some((entry) => entry.groupKey === candidate.groupKey) ? 1 : 0,
        duplicateOffsetPenalty: [...selectedByMetric.values()].some((entry) => entry.offset === candidate.offset) ? 1 : 0,
      }))
      .filter((candidate) => candidate.distanceToAnchor <= slotRadius)
      .sort((left, right) =>
        left.duplicateOffsetPenalty - right.duplicateOffsetPenalty ||
        left.duplicateGroupPenalty - right.duplicateGroupPenalty ||
        left.distanceToAnchor - right.distanceToAnchor ||
        right.bundleCandidateScore - left.bundleCandidateScore ||
        right.replaySupport - left.replaySupport
      )[0];

    if (sibling) {
      selectedByMetric.set(metricKey, sibling);
    }
  }

  const entries = [...selectedByMetric.values()].sort((left, right) =>
    (left.medianSlotIndex ?? 0) - (right.medianSlotIndex ?? 0) ||
    left.metric.localeCompare(right.metric)
  );
  const slotIndices = entries.map((entry) => entry.medianSlotIndex ?? 0);
  const slotMin = Math.min(...slotIndices);
  const slotMax = Math.max(...slotIndices);
  const slotSpan = slotMax - slotMin;
  const slotCompactness = 1 / (1 + (slotSpan / Math.max(slotRadius * 2, 1)));
  const replayOverlap = computeReplayOverlap(entries);
  const offsetConflictStats = computeOffsetConflictStats(entries);
  const metricCount = entries.length;
  const strongMetricCount = entries.filter((entry) => (entry.replaySupport ?? 0) >= 3).length;
  const weakMetricCount = entries.filter((entry) => (entry.replaySupport ?? 0) <= 1).length;
  const avgCandidateScore = average(entries.map((entry) => entry.bundleCandidateScore));
  const avgReplaySupport = average(entries.map((entry) => entry.replaySupport ?? 0));

  const bundleScore =
    (0.32 * (metricCount / Math.max(topByMetric.size, 1))) +
    (0.22 * avgCandidateScore) +
    (0.16 * slotCompactness) +
    (0.16 * replayOverlap) +
    (0.08 * (Math.min(avgReplaySupport, 5) / 5)) +
    (0.08 * (strongMetricCount / Math.max(metricCount, 1))) -
    (0.04 * (weakMetricCount / Math.max(metricCount, 1))) +
    (0.06 * offsetConflictStats.uniquenessRatio) -
    (0.06 * (offsetConflictStats.duplicateOffsetCount / Math.max(metricCount - 1, 1)));

  return {
    anchorMetric: anchor.metric,
    anchorGroupKey: anchor.groupKey,
    anchorMedianSlotIndex: anchor.medianSlotIndex,
    metricCount,
    slotBand: [slotMin, slotMax],
    slotSpan,
    slotCompactness,
    replayOverlap,
    strongMetricCount,
    weakMetricCount,
    uniqueOffsets: offsetConflictStats.uniqueOffsets,
    duplicateOffsetCount: offsetConflictStats.duplicateOffsetCount,
    uniquenessRatio: offsetConflictStats.uniquenessRatio,
    avgCandidateScore,
    avgReplaySupport,
    bundleScore,
    metrics: entries.map((entry) => ({
      metric: entry.metric,
      groupKey: entry.groupKey,
      replaySupport: entry.replaySupport,
      medianParticipants: entry.medianParticipants,
      medianSlotIndex: entry.medianSlotIndex,
      slotCompactness: entry.slotCompactness,
      medianCorrelation: entry.medianCorrelation,
      medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
      medianLowTailAgreement: entry.medianLowTailAgreement ?? null,
      medianSpeedBoostAgreement: entry.medianSpeedBoostAgreement ?? null,
      medianSpecificityScore: entry.medianSpecificityScore,
      medianConfusionScore: entry.medianConfusionScore,
      bundleCandidateScore: entry.bundleCandidateScore,
      replayIds: entry.replayIds ?? [],
    })),
  };
}

function dedupeBundles(bundles) {
  const seen = new Set();
  return bundles.filter((bundle) => {
    const signature = bundle.metrics
      .map((metric) => `${metric.metric}:${metric.groupKey}`)
      .sort()
      .join("|");
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const outputPath = buildOutputPath(
    artifactRoot,
    args.versionGroup,
    args.familyKey,
    args.outputPath ? resolveAbsolute(repoRoot, args.outputPath) : null,
  );

  const reportsByMetric = new Map();
  for (const metricKey of args.metrics) {
    const report = loadMetricReport(artifactRoot, args.versionGroup, metricKey);
    if (report) {
      reportsByMetric.set(metricKey, report);
    }
  }

  const topByMetric = chooseTopCandidatesByMetric(reportsByMetric, args.familyKey, args.maxCandidatesPerMetric);
  const anchors = [...topByMetric.values()].flat();
  const bundles = dedupeBundles(
    anchors
      .map((anchor) => buildBundle(anchor, topByMetric, args.slotRadius))
      .sort((left, right) =>
        right.bundleScore - left.bundleScore ||
        right.metricCount - left.metricCount ||
        right.replayOverlap - left.replayOverlap ||
        left.slotSpan - right.slotSpan
      ),
  ).slice(0, args.maxBundles);

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    versionGroup: args.versionGroup,
    familyKey: args.familyKey,
    metrics: [...reportsByMetric.keys()],
    slotRadius: args.slotRadius,
    bundles,
    topCandidatesByMetric: Object.fromEntries(
      [...topByMetric.entries()].map(([metricKey, candidates]) => [
        metricKey,
        candidates.map((entry) => ({
          groupKey: entry.groupKey,
          replaySupport: entry.replaySupport,
          medianParticipants: entry.medianParticipants,
          medianSlotIndex: entry.medianSlotIndex,
          slotCompactness: entry.slotCompactness,
          medianCorrelation: entry.medianCorrelation,
          medianAbsoluteDeltaCorrelation: entry.medianAbsoluteDeltaCorrelation,
          medianSpecificityScore: entry.medianSpecificityScore,
          medianConfusionScore: entry.medianConfusionScore,
          bundleCandidateScore: entry.bundleCandidateScore,
        })),
      ]),
    ),
  };

  writeJson(outputPath, output);
  console.log(`Wrote scalar family bundle candidates to ${outputPath}`);
}

main();
