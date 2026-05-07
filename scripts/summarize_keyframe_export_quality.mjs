import path from "path";

import {
  average,
  median,
  metricDefinitionByKey,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    inputPath: null,
    outputPath: null,
    maxNormalizedRmse: 0.65,
    topCount: 32,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--max-normalized-rmse" && index + 1 < argv.length) {
      args.maxNormalizedRmse = Number.parseFloat(argv[++index]);
    } else if (arg === "--top-count" && index + 1 < argv.length) {
      args.topCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.maxNormalizedRmse) || args.maxNormalizedRmse <= 0) {
    throw new Error("--max-normalized-rmse must be a positive number.");
  }
  if (!Number.isInteger(args.topCount) || args.topCount < 1) {
    throw new Error("--top-count must be a positive integer.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/summarize_keyframe_export_quality.mjs [--version-group 16.9] [--input-path <path>] [--output-path <path>] [--max-normalized-rmse 0.65]");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function quantile(values, q) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const offset = (sorted.length - 1) * q;
  const lower = Math.floor(offset);
  const upper = Math.ceil(offset);
  if (lower === upper) {
    return sorted[lower];
  }
  const t = offset - lower;
  return sorted[lower] + ((sorted[upper] - sorted[lower]) * t);
}

function collectSeries(exportJson, maxNormalizedRmse) {
  const rows = [];
  const violations = [];

  for (const replay of exportJson.replays ?? []) {
    for (const participant of replay.participants ?? []) {
      for (const [metricKey, metric] of Object.entries(participant.metrics ?? {})) {
        const definition = metricDefinitionByKey.get(metricKey);
        const requiredPoints = definition?.minOverlap ?? 6;
        const normalizedRmseLimit = Math.min(definition?.maxNormalizedRmse ?? maxNormalizedRmse, maxNormalizedRmse);
        const row = {
          replayId: replay.replayId,
          participantId: participant.participant?.participantId,
          champion: participant.participant?.champion,
          metric: metricKey,
          stable: Boolean(participant.stable),
          replayLocalAssignment: Boolean(participant.replayLocalAssignment),
          familyKey: participant.familyKey,
          slotIndex: participant.slotIndex,
          sourceFamilyKey: participant.sourceFamilyKey,
          sourceSlotIndex: participant.sourceSlotIndex,
          fitSource: metric.fitSource,
          pointCount: finite(metric.pointCount),
          comparedPoints: finite(metric.comparedPoints),
          correlation: finite(metric.correlation),
          normalizedRmse: finite(metric.normalizedRmse),
          meanAbsError: finite(metric.meanAbsError),
          maxAbsError: finite(metric.maxAbsError),
          score: finite(metric.score),
          requiredPoints,
          normalizedRmseLimit,
        };
        rows.push(row);

        if (row.comparedPoints == null || row.comparedPoints < requiredPoints) {
          violations.push({
            ...row,
            reason: "insufficient-compared-points",
          });
        }
        if (row.normalizedRmse == null || row.normalizedRmse > normalizedRmseLimit) {
          violations.push({
            ...row,
            reason: "normalized-rmse-above-limit",
          });
        }
      }
    }
  }

  return { rows, violations };
}

function summarizeByMetric(rows) {
  const byMetric = new Map();
  for (const row of rows) {
    const list = byMetric.get(row.metric) ?? [];
    list.push(row);
    byMetric.set(row.metric, list);
  }

  return [...byMetric.entries()]
    .map(([metric, entries]) => {
      const normalizedRmses = entries.map((entry) => entry.normalizedRmse).filter((value) => value != null);
      const meanAbsErrors = entries.map((entry) => entry.meanAbsError).filter((value) => value != null);
      const comparedPoints = entries.map((entry) => entry.comparedPoints).filter((value) => value != null);
      return {
        metric,
        seriesCount: entries.length,
        replayLocalSeriesCount: entries.filter((entry) => entry.replayLocalAssignment).length,
        localFitSeriesCount: entries.filter((entry) => entry.fitSource === "local-fit").length,
        storedTopMatchSeriesCount: entries.filter((entry) => entry.fitSource === "stored-top-match").length,
        normalizedRmse: {
          average: normalizedRmses.length ? average(normalizedRmses) : null,
          median: normalizedRmses.length ? median(normalizedRmses) : null,
          p90: quantile(normalizedRmses, 0.9),
          max: normalizedRmses.length ? Math.max(...normalizedRmses) : null,
        },
        meanAbsError: {
          average: meanAbsErrors.length ? average(meanAbsErrors) : null,
          median: meanAbsErrors.length ? median(meanAbsErrors) : null,
          p90: quantile(meanAbsErrors, 0.9),
          max: meanAbsErrors.length ? Math.max(...meanAbsErrors) : null,
        },
        comparedPoints: {
          min: comparedPoints.length ? Math.min(...comparedPoints) : null,
          median: comparedPoints.length ? median(comparedPoints) : null,
          max: comparedPoints.length ? Math.max(...comparedPoints) : null,
        },
      };
    })
    .sort((left, right) =>
      (right.normalizedRmse.max ?? -1) - (left.normalizedRmse.max ?? -1) ||
      left.metric.localeCompare(right.metric)
    );
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = resolveAbsolute(
    root,
    args.inputPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}.json`),
  );
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `keyframe-state-quality-${args.versionGroup}.json`),
  );

  const exportJson = readJson(inputPath);
  const { rows, violations } = collectSeries(exportJson, args.maxNormalizedRmse);
  const worstByNormalizedRmse = [...rows]
    .sort((left, right) =>
      (right.normalizedRmse ?? -1) - (left.normalizedRmse ?? -1) ||
      (right.meanAbsError ?? -1) - (left.meanAbsError ?? -1)
    )
    .slice(0, args.topCount);
  const worstByMeanAbsError = [...rows]
    .sort((left, right) =>
      (right.meanAbsError ?? -1) - (left.meanAbsError ?? -1) ||
      (right.normalizedRmse ?? -1) - (left.normalizedRmse ?? -1)
    )
    .slice(0, args.topCount);

  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    inputPath,
    filters: exportJson.filters ?? null,
    thresholds: {
      maxNormalizedRmse: args.maxNormalizedRmse,
      perMetricMinOverlap: true,
    },
    totals: {
      replayCount: exportJson.totals?.replayCount ?? (exportJson.replays ?? []).length,
      exportedReplayCount: exportJson.totals?.exportedReplayCount ?? (exportJson.replays ?? []).length,
      participantSeriesCount: exportJson.totals?.participantSeriesCount ?? 0,
      metricSeriesCount: rows.length,
      replayLocalMetricSeriesCount: rows.filter((row) => row.replayLocalAssignment).length,
      localFitSeriesCount: rows.filter((row) => row.fitSource === "local-fit").length,
      storedTopMatchSeriesCount: rows.filter((row) => row.fitSource === "stored-top-match").length,
      violationCount: violations.length,
    },
    byMetric: summarizeByMetric(rows),
    worstByNormalizedRmse,
    worstByMeanAbsError,
    violations,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ${outputPath}`);
  console.log(`Quality summary: ${rows.length} metric series, ${violations.length} violation(s).`);
}

main();
