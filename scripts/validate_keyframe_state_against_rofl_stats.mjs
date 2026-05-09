import path from "path";

import {
  metricDefinitionByKey,
  readJson,
  resolveAbsolute,
  safeNumber,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const defaultMetricKeys = [
  "level",
  "xp",
  "totalGold",
  "minionsKilled",
  "jungleMinionsKilled",
  "healthMax",
  "powerMax",
];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    exportPath: null,
    outputPath: null,
    maxRelativeError: 0.35,
    finalWindowMillis: 120000,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--export-path" && index + 1 < argv.length) {
      args.exportPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--max-relative-error" && index + 1 < argv.length) {
      args.maxRelativeError = Number.parseFloat(argv[++index]);
    } else if (arg === "--final-window-millis" && index + 1 < argv.length) {
      args.finalWindowMillis = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/validate_keyframe_state_against_rofl_stats.mjs [--version-group 16.9] [--artifact-root <path>] [--export-path <path>] [--output-path <path>] [--max-relative-error <fraction>] [--final-window-millis <ms>]");
}

function relativeError(predicted, target) {
  const scale = Math.max(Math.abs(target), 20);
  return Math.abs(predicted - target) / scale;
}

function lastFiniteSeriesPoint(points) {
  for (let index = (points?.length ?? 0) - 1; index >= 0; index -= 1) {
    const point = points[index];
    if (Number.isFinite(point?.value)) {
      return point;
    }
  }
  return null;
}

function parseSummaryStatsJson(summaryJson) {
  const metadata = typeof summaryJson?.metadataJson === "string"
    ? JSON.parse(summaryJson.metadataJson)
    : (summaryJson?.metadataJson ?? {});
  return typeof metadata?.statsJson === "string"
    ? JSON.parse(metadata.statsJson)
    : (metadata?.statsJson ?? []);
}

function readMetricFromStatMap(statMap, metricKey) {
  const metric = metricDefinitionByKey.get(metricKey);
  if (!metric) {
    return null;
  }
  if (metricKey === "minionsKilled") {
    return safeNumber(statMap.MINIONS_KILLED) ?? safeNumber(statMap.CREEP_SCORE);
  }
  if (metricKey === "jungleMinionsKilled") {
    const direct = safeNumber(statMap.NEUTRAL_MINIONS_KILLED);
    if (direct != null) {
      return direct;
    }
    const own = safeNumber(statMap.NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE) ?? 0;
    const enemy = safeNumber(statMap.NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE) ?? 0;
    return own + enemy;
  }
  for (const key of metric.summaryStatKeys ?? []) {
    const value = safeNumber(statMap[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function buildStatsRoster(summaryJson) {
  const statsJson = parseSummaryStatsJson(summaryJson);
  return statsJson.map((statMap, index) => {
    const finalMetrics = {};
    for (const metricKey of defaultMetricKeys) {
      finalMetrics[metricKey] = readMetricFromStatMap(statMap, metricKey);
    }
    return {
      rosterIndex: index,
      champion: statMap.SKIN ?? null,
      finalMetrics,
    };
  });
}

function compareParticipant(replayId, participant, rosterEntry, metricKeys, maxRelativeError, gameLengthMillis, finalWindowMillis) {
  const comparisons = [];
  for (const metricKey of metricKeys) {
    const target = rosterEntry?.finalMetrics?.[metricKey];
    const metric = participant.metrics?.[metricKey];
    const lastPoint = lastFiniteSeriesPoint(participant.series?.[metricKey]);
    if (!Number.isFinite(target) || !metric) {
      continue;
    }
    const maxAbsError = Number.isFinite(metric.maxAbsError) ? metric.maxAbsError : null;
    const observedError = lastPoint ? lastPoint.value - target : null;
    const observedRelativeError = lastPoint ? relativeError(lastPoint.value, target) : null;
    const remainingMillis = lastPoint && Number.isFinite(gameLengthMillis) && Number.isFinite(lastPoint.timestamp)
      ? gameLengthMillis - lastPoint.timestamp
      : null;
    const inFinalWindow = remainingMillis != null && remainingMillis >= 0 && remainingMillis <= finalWindowMillis;
    const fitRelativeError = maxAbsError == null ? null : relativeError(target + maxAbsError, target);
    const relError = observedRelativeError ?? fitRelativeError;
    comparisons.push({
      replayId,
      participantId: participant.participant?.participantId ?? null,
      champion: participant.participant?.champion ?? null,
      metric: metricKey,
      target,
      validationMode: lastPoint ? "last-exported-point" : "fit-max-error",
      lastTimestamp: lastPoint?.timestamp ?? null,
      lastApiFrameIndex: lastPoint?.apiFrameIndex ?? null,
      gameLengthMillis: Number.isFinite(gameLengthMillis) ? gameLengthMillis : null,
      remainingMillis,
      inFinalWindow,
      lastValue: lastPoint?.value ?? null,
      observedError,
      observedRelativeError,
      pointCount: metric.pointCount ?? null,
      comparedPoints: metric.comparedPoints ?? null,
      correlation: metric.correlation ?? null,
      normalizedRmse: metric.normalizedRmse ?? null,
      meanAbsError: metric.meanAbsError ?? null,
      maxAbsError,
      fitRelativeError,
      relativeError: relError,
      pass: relError != null && relError <= maxRelativeError,
      stable: participant.stable ?? false,
      familyKey: participant.familyKey,
      slotIndex: participant.slotIndex,
      sourceFamilyKey: participant.sourceFamilyKey ?? participant.familyKey,
      sourceSlotIndex: participant.sourceSlotIndex ?? participant.slotIndex,
    });
  }
  return comparisons;
}

function summarizeComparisons(comparisons) {
  const byMetric = {};
  for (const comparison of comparisons) {
    const row = byMetric[comparison.metric] ?? {
      comparisonCount: 0,
      passCount: 0,
      failCount: 0,
      maxRelativeError: 0,
    };
    row.comparisonCount += 1;
    if (comparison.pass) {
      row.passCount += 1;
    } else {
      row.failCount += 1;
    }
    if (Number.isFinite(comparison.relativeError)) {
      row.maxRelativeError = Math.max(row.maxRelativeError, comparison.relativeError);
    }
    byMetric[comparison.metric] = row;
  }
  return byMetric;
}

function summarizeFinalWindow(comparisons) {
  const inWindow = comparisons.filter((comparison) => comparison.inFinalWindow);
  const outsideWindow = comparisons.filter((comparison) => !comparison.inFinalWindow);
  return {
    finalWindowComparisonCount: inWindow.length,
    finalWindowPassCount: inWindow.filter((comparison) => comparison.pass).length,
    finalWindowFailCount: inWindow.filter((comparison) => !comparison.pass).length,
    outsideFinalWindowComparisonCount: outsideWindow.length,
    outsideFinalWindowPassCount: outsideWindow.filter((comparison) => comparison.pass).length,
    outsideFinalWindowFailCount: outsideWindow.filter((comparison) => !comparison.pass).length,
  };
}

function countBy(rows, readKey) {
  const counts = {};
  for (const row of rows) {
    const key = readKey(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const exportPath = resolveAbsolute(
    root,
    args.exportPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}.json`),
  );
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `keyframe-state-rofl-stat-validation-${args.versionGroup}.json`),
  );
  const exportJson = readJson(exportPath);
  const metricKeys = defaultMetricKeys.filter((metricKey) => metricDefinitionByKey.has(metricKey));
  const comparisons = [];

  for (const replay of exportJson.replays ?? []) {
    const summaryPath = path.join(artifactRoot, replay.replayId, "summary.json");
    const summaryJson = readJson(summaryPath);
    const roster = buildStatsRoster(summaryJson);
    const gameLengthMillis = Number.isFinite(summaryJson.gameLengthMillis) ? summaryJson.gameLengthMillis : null;
    for (const participant of replay.participants ?? []) {
      const participantId = participant.participant?.participantId;
      if (!Number.isInteger(participantId) || participantId < 1) {
        continue;
      }
      const rosterEntry = roster[participantId - 1] ?? null;
      comparisons.push(...compareParticipant(replay.replayId, participant, rosterEntry, metricKeys, args.maxRelativeError, gameLengthMillis, args.finalWindowMillis));
    }
  }

  const failures = comparisons.filter((comparison) => !comparison.pass);
  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    sourceExportPath: exportPath,
    thresholds: {
      maxRelativeError: args.maxRelativeError,
      finalWindowMillis: args.finalWindowMillis,
    },
    totals: {
      comparisonCount: comparisons.length,
      passCount: comparisons.filter((comparison) => comparison.pass).length,
      failCount: comparisons.filter((comparison) => !comparison.pass).length,
      stableComparisonCount: comparisons.filter((comparison) => comparison.stable).length,
      stablePassCount: comparisons.filter((comparison) => comparison.stable && comparison.pass).length,
      stableFailCount: comparisons.filter((comparison) => comparison.stable && !comparison.pass).length,
      ...summarizeFinalWindow(comparisons),
    },
    byMetric: summarizeComparisons(comparisons),
    failureSummary: {
      byReplay: countBy(failures, (failure) => failure.replayId),
      byMetric: countBy(failures, (failure) => failure.metric),
      bySourceFamily: countBy(failures, (failure) => failure.sourceFamilyKey),
    },
    validationModes: countBy(comparisons, (comparison) => comparison.validationMode),
    failures,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ROFL stats validation to ${outputPath}`);
  console.log(`comparisons: ${output.totals.comparisonCount}, pass: ${output.totals.passCount}, fail: ${output.totals.failCount}`);
}

main();
