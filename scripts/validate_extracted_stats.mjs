import fs from "fs";
import path from "path";

import {
  buildMetricSeries,
  interpolate,
  metricDefinitionByKey,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  standardDeviation,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    extractedPath: null,
    fixtureDir: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extracted-path" && index + 1 < argv.length) {
      args.extractedPath = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.extractedPath) {
    throw new Error("Missing required --extracted-path <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/validate_extracted_stats.mjs --extracted-path <path> [--fixture-dir <path>] [--output-path <path>]");
}

function compareSeries(extractedSeries, targetSeries) {
  const extractedValues = [];
  const targetValues = [];

  for (const point of targetSeries) {
    const extractedValue = interpolate(extractedSeries, point.timestamp);
    if (!Number.isFinite(extractedValue) || !Number.isFinite(point.value)) {
      continue;
    }
    extractedValues.push(extractedValue);
    targetValues.push(point.value);
  }

  if (extractedValues.length < 3) {
    return {
      overlap: extractedValues.length,
      correlation: 0,
      rmse: Number.POSITIVE_INFINITY,
      normalizedRmse: Number.POSITIVE_INFINITY,
    };
  }

  let squaredError = 0;
  for (let index = 0; index < extractedValues.length; index += 1) {
    const error = extractedValues[index] - targetValues[index];
    squaredError += error * error;
  }

  const rmse = Math.sqrt(squaredError / extractedValues.length);
  const normalizedRmse = rmse / Math.max(standardDeviation(targetValues), 1);
  return {
    overlap: extractedValues.length,
    correlation: pearsonCorrelation(extractedValues, targetValues),
    rmse,
    normalizedRmse,
  };
}

function findApiParticipant(participant, apiParticipants) {
  let best = null;
  for (const apiParticipant of apiParticipants) {
    let score = 0;
    if (participant.champion && apiParticipant.champion && participant.champion === apiParticipant.champion) {
      score += 4;
    }
    if (participant.team != null && apiParticipant.teamId != null && Number(participant.team) === Number(apiParticipant.teamId)) {
      score += 2;
    }
    if (participant.teamPosition && apiParticipant.teamPosition && participant.teamPosition === apiParticipant.teamPosition) {
      score += 2;
    }

    if (!best || score > best.score) {
      best = { apiParticipant, score };
    }
  }
  return best;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const extractedPath = resolveAbsolute(repoRoot, args.extractedPath);
  const extracted = readJson(extractedPath);
  const replayId = extracted.replayId;
  const fixtureDir = args.fixtureDir
    ? resolveAbsolute(repoRoot, args.fixtureDir)
    : path.join(repoRoot, "replays", "api", replayId.replace(/-/g, "_"));
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(path.dirname(extractedPath), "validation-report.json");

  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    throw new Error(`Fixture bundle not found under ${fixtureDir}`);
  }

  const matchJson = readJson(matchPath);
  const timelineJson = readJson(timelinePath);
  const requestedMetricKeys = new Set();
  for (const participant of extracted.participants ?? []) {
    for (const metricKey of Object.keys(participant.metrics ?? {})) {
      requestedMetricKeys.add(metricKey);
    }
  }

  const { participants: apiParticipants, metricSeriesByParticipant } = buildMetricSeries(
    matchJson,
    timelineJson,
    [...requestedMetricKeys],
  );

  const validationParticipants = [];
  const metricSummaries = new Map();

  for (const participant of extracted.participants ?? []) {
    const apiMatch = findApiParticipant(participant, apiParticipants);
    if (!apiMatch?.apiParticipant || apiMatch.score < 6) {
      validationParticipants.push({
        rosterIndex: participant.rosterIndex,
        champion: participant.champion,
        matchedParticipantId: null,
        status: "unmatched",
      });
      continue;
    }

    const apiParticipant = apiMatch.apiParticipant;
    const apiMetricSeries = metricSeriesByParticipant.get(apiParticipant.participantId) ?? new Map();
    const metricResults = {};
    for (const [metricKey, extractedMetric] of Object.entries(participant.metrics ?? {})) {
      const targetSeries = apiMetricSeries.get(metricKey) ?? [];
      const comparison = compareSeries(extractedMetric.timeline, targetSeries);
      const metricDefinition = metricDefinitionByKey.get(metricKey);
      const passes =
        comparison.overlap >= Math.max(metricDefinition?.minOverlap ?? 6, 3) &&
        comparison.correlation >= ((metricDefinition?.minCorrelation ?? 0.45) - 0.05) &&
        comparison.normalizedRmse <= ((metricDefinition?.maxNormalizedRmse ?? 1.0) + 0.1);

      metricResults[metricKey] = {
        overlap: comparison.overlap,
        correlation: comparison.correlation,
        rmse: comparison.rmse,
        normalizedRmse: comparison.normalizedRmse,
        passes,
      };

      const summary = metricSummaries.get(metricKey) ?? [];
      summary.push(metricResults[metricKey]);
      metricSummaries.set(metricKey, summary);
    }

    validationParticipants.push({
      rosterIndex: participant.rosterIndex,
      champion: participant.champion,
      matchedParticipantId: apiParticipant.participantId,
      team: participant.team,
      teamPosition: participant.teamPosition,
      status: "matched",
      metrics: metricResults,
    });
  }

  const metricSummaryObject = {};
  for (const [metricKey, results] of metricSummaries.entries()) {
    metricSummaryObject[metricKey] = {
      participantCount: results.length,
      passCount: results.filter((result) => result.passes).length,
      averageCorrelation: results.reduce((sum, result) => sum + result.correlation, 0) / Math.max(results.length, 1),
      averageNormalizedRmse: results.reduce((sum, result) => sum + result.normalizedRmse, 0) / Math.max(results.length, 1),
    };
  }

  const validationReport = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    fixtureDir,
    extractedPath,
    extractedStatsFingerprint: extracted.schemaFingerprint ?? null,
    summary: {
      participantCount: validationParticipants.length,
      matchedParticipantCount: validationParticipants.filter((participant) => participant.status === "matched").length,
      metricCount: Object.keys(metricSummaryObject).length,
    },
    metrics: metricSummaryObject,
    participants: validationParticipants,
  };

  writeJson(outputPath, validationReport);
  console.log(`Wrote validation report to ${outputPath}`);
}

main();
