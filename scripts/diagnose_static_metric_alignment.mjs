#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const defaultMetrics = ["currentGold", "health", "power"];

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    candidatePath: null,
    outputPath: null,
    metrics: defaultMetrics,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--candidate-path" && index + 1 < argv.length) {
      args.candidatePath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--metrics" && index + 1 < argv.length) {
      args.metrics = argv[++index]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactDir) {
    throw new Error("Missing required --artifact-dir <path> argument.");
  }
  if (!args.metrics.length) {
    throw new Error("At least one metric must be supplied via --metrics.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/diagnose_static_metric_alignment.mjs --artifact-dir <path> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --candidate-path <path>  Candidate matches JSON (default: <artifact>/candidate-matches.json).");
  console.log("  --output-path <path>     Output path (default: <artifact>/static-metric-alignment-diagnosis.json).");
  console.log("  --metrics <a,b,c>        Metrics to analyze (default: currentGold,health,power).");
}

function classifyWindowCandidate(candidate) {
  const passCount = candidate.passCount ?? 0;
  const avgEffective = candidate.averageEffectiveScore ?? 0;
  if (passCount >= 6 && avgEffective >= 0.28) {
    return "strong";
  }
  if (passCount >= 4 && avgEffective >= 0.2) {
    return "moderate";
  }
  return "weak";
}

function classifyTopMatch(match) {
  const effective = match.effectiveScore ?? 0;
  const correlation = match.correlation ?? 0;
  const normalizedRmse = match.normalizedRmse ?? Number.POSITIVE_INFINITY;
  if (effective >= 0.28 && correlation >= 0.55 && normalizedRmse <= 1.1) {
    return "strong";
  }
  if (effective >= 0.18 && correlation >= 0.4 && normalizedRmse <= 1.5) {
    return "moderate";
  }
  return "weak";
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const candidatePath = args.candidatePath
    ? resolveAbsolute(repoRoot, args.candidatePath)
    : path.join(artifactDir, "candidate-matches.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "static-metric-alignment-diagnosis.json");
  const summaryPath = path.join(artifactDir, "summary.json");

  if (!fs.existsSync(candidatePath)) {
    throw new Error(`candidate-matches.json not found at ${candidatePath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary.json not found at ${summaryPath}`);
  }

  const summary = readJson(summaryPath);
  const candidateMatches = readJson(candidatePath);
  const metricSet = new Set(args.metrics);

  const rawWindowCandidates = (candidateMatches.rawWindowCandidates ?? [])
    .filter((candidate) => metricSet.has(candidate.metric));
  const topMatches = (candidateMatches.topMatches ?? [])
    .filter((match) => metricSet.has(match.metricKey));

  const topMatchesByFieldMetric = new Map();
  for (const match of topMatches) {
    const key = [
      match.familyKey,
      match.slotIndex,
      match.offset,
      match.decodeLabel,
      match.metricKey,
    ].join("|");
    const list = topMatchesByFieldMetric.get(key) ?? [];
    list.push(match);
    topMatchesByFieldMetric.set(key, list);
  }

  const fieldMetricLeaders = [];
  for (const [fieldKey, matches] of topMatchesByFieldMetric.entries()) {
    const sorted = [...matches].sort((left, right) =>
      (right.effectiveScore ?? 0) - (left.effectiveScore ?? 0)
      || (right.correlation ?? 0) - (left.correlation ?? 0)
      || (left.normalizedRmse ?? Number.POSITIVE_INFINITY) - (right.normalizedRmse ?? Number.POSITIVE_INFINITY));
    const best = sorted[0];
    fieldMetricLeaders.push({
      fieldKey,
      familyKey: best.familyKey,
      slotIndex: best.slotIndex,
      offset: best.offset,
      decodeLabel: best.decodeLabel,
      metric: best.metricKey,
      quality: classifyTopMatch(best),
      bestMatch: best,
      topMatches: sorted.slice(0, 5),
    });
  }

  fieldMetricLeaders.sort((left, right) =>
    (right.bestMatch.effectiveScore ?? 0) - (left.bestMatch.effectiveScore ?? 0)
    || (right.bestMatch.correlation ?? 0) - (left.bestMatch.correlation ?? 0)
    || (left.bestMatch.normalizedRmse ?? Number.POSITIVE_INFINITY) - (right.bestMatch.normalizedRmse ?? Number.POSITIVE_INFINITY));

  const familyMetricSummaryMap = new Map();
  for (const candidate of rawWindowCandidates) {
    const quality = classifyWindowCandidate(candidate);
    const key = `${candidate.familyKey}|${candidate.metric}`;
    const metricSummary = familyMetricSummaryMap.get(key) ?? {
      familyKey: candidate.familyKey,
      metric: candidate.metric,
      candidateCount: 0,
      strongCount: 0,
      moderateCount: 0,
      weakCount: 0,
      passCountSum: 0,
      aggregateScoreSum: 0,
      averageEffectiveScoreSum: 0,
      averageCorrelationSum: 0,
      averageNormalizedRmseSum: 0,
      bestCandidate: null,
    };

    metricSummary.candidateCount += 1;
    metricSummary.passCountSum += candidate.passCount ?? 0;
    metricSummary.aggregateScoreSum += candidate.aggregateScore ?? 0;
    metricSummary.averageEffectiveScoreSum += candidate.averageEffectiveScore ?? 0;
    metricSummary.averageCorrelationSum += candidate.averageCorrelation ?? 0;
    metricSummary.averageNormalizedRmseSum += candidate.averageNormalizedRmse ?? 0;
    if (quality === "strong") {
      metricSummary.strongCount += 1;
    } else if (quality === "moderate") {
      metricSummary.moderateCount += 1;
    } else {
      metricSummary.weakCount += 1;
    }

    if (
      !metricSummary.bestCandidate ||
      (candidate.aggregateScore ?? 0) > (metricSummary.bestCandidate.aggregateScore ?? 0)
    ) {
      metricSummary.bestCandidate = {
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        offset: candidate.offset,
        width: candidate.width,
        decode: candidate.decode,
        passCount: candidate.passCount ?? 0,
        aggregateScore: candidate.aggregateScore ?? 0,
        averageEffectiveScore: candidate.averageEffectiveScore ?? 0,
        averageCorrelation: candidate.averageCorrelation ?? 0,
        averageNormalizedRmse: candidate.averageNormalizedRmse ?? 0,
      };
    }

    familyMetricSummaryMap.set(key, metricSummary);
  }

  const familyMetricSummaries = [...familyMetricSummaryMap.values()]
    .map((summaryRow) => ({
      familyKey: summaryRow.familyKey,
      metric: summaryRow.metric,
      candidateCount: summaryRow.candidateCount,
      strongCount: summaryRow.strongCount,
      moderateCount: summaryRow.moderateCount,
      weakCount: summaryRow.weakCount,
      averagePassCount: summaryRow.passCountSum / Math.max(1, summaryRow.candidateCount),
      averageAggregateScore: summaryRow.aggregateScoreSum / Math.max(1, summaryRow.candidateCount),
      averageEffectiveScore: summaryRow.averageEffectiveScoreSum / Math.max(1, summaryRow.candidateCount),
      averageCorrelation: summaryRow.averageCorrelationSum / Math.max(1, summaryRow.candidateCount),
      averageNormalizedRmse: summaryRow.averageNormalizedRmseSum / Math.max(1, summaryRow.candidateCount),
      bestCandidate: summaryRow.bestCandidate,
      status: summaryRow.strongCount > 0
        ? "strong"
        : (summaryRow.moderateCount > 0 ? "moderate" : "weak"),
    }))
    .sort((left, right) =>
      (right.strongCount - left.strongCount)
      || (right.moderateCount - left.moderateCount)
      || (right.averageAggregateScore - left.averageAggregateScore)
      || (left.averageNormalizedRmse - right.averageNormalizedRmse));

  const familyRollupMap = new Map();
  for (const row of familyMetricSummaries) {
    const bucket = familyRollupMap.get(row.familyKey) ?? {
      familyKey: row.familyKey,
      metricsCovered: [],
      strongMetricCount: 0,
      moderateMetricCount: 0,
      weakMetricCount: 0,
      avgAggregateScores: [],
      avgCorrelations: [],
      avgNrmse: [],
    };
    bucket.metricsCovered.push(row.metric);
    if (row.status === "strong") {
      bucket.strongMetricCount += 1;
    } else if (row.status === "moderate") {
      bucket.moderateMetricCount += 1;
    } else {
      bucket.weakMetricCount += 1;
    }
    bucket.avgAggregateScores.push(row.averageAggregateScore);
    bucket.avgCorrelations.push(row.averageCorrelation);
    bucket.avgNrmse.push(row.averageNormalizedRmse);
    familyRollupMap.set(row.familyKey, bucket);
  }

  const familyRollup = [...familyRollupMap.values()]
    .map((row) => ({
      familyKey: row.familyKey,
      metricsCovered: row.metricsCovered.sort((left, right) => left.localeCompare(right)),
      strongMetricCount: row.strongMetricCount,
      moderateMetricCount: row.moderateMetricCount,
      weakMetricCount: row.weakMetricCount,
      averageAggregateScore: average(row.avgAggregateScores),
      averageCorrelation: average(row.avgCorrelations),
      averageNormalizedRmse: average(row.avgNrmse),
      recommendation: row.strongMetricCount >= 1
        ? "prioritize"
        : (row.moderateMetricCount >= 1 ? "investigate" : "deprioritize"),
    }))
    .sort((left, right) =>
      right.strongMetricCount - left.strongMetricCount
      || right.moderateMetricCount - left.moderateMetricCount
      || right.averageAggregateScore - left.averageAggregateScore
      || left.averageNormalizedRmse - right.averageNormalizedRmse);

  const output = {
    replayId: candidateMatches.replayId ?? path.basename(artifactDir),
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    candidatePath,
    gameVersion: summary.gameVersion ?? null,
    versionGroup: parseVersionGroup(summary.gameVersion ?? "unknown"),
    settings: {
      metrics: args.metrics,
      focus: "Replay-vs-API scalar alignment diagnostics for static state metrics.",
    },
    summary: {
      rawWindowCandidateCount: rawWindowCandidates.length,
      fieldMetricLeaderCount: fieldMetricLeaders.length,
      familyMetricSummaryCount: familyMetricSummaries.length,
      familyRollupCount: familyRollup.length,
      topEffectiveScores: fieldMetricLeaders.slice(0, 10).map((entry) => ({
        familyKey: entry.familyKey,
        slotIndex: entry.slotIndex,
        offset: entry.offset,
        metric: entry.metric,
        effectiveScore: entry.bestMatch.effectiveScore ?? 0,
        correlation: entry.bestMatch.correlation ?? 0,
        normalizedRmse: entry.bestMatch.normalizedRmse ?? Number.POSITIVE_INFINITY,
      })),
    },
    familyRollup,
    familyMetricSummaries,
    fieldMetricLeaders: fieldMetricLeaders.slice(0, 200),
  };

  writeJson(outputPath, output);
  console.log(`Wrote static metric alignment diagnosis to ${outputPath}`);
  console.log(`Families analyzed: ${output.summary.familyRollupCount}, leaders: ${output.summary.fieldMetricLeaderCount}`);
}

main();
