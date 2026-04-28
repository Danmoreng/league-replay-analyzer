import fs from "fs";
import path from "path";

import {
  average,
  median,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    parityReportPath: null,
    outputPath: null,
    minSupportReplays: 2,
    minAvgCorrelation: 0.78,
    maxAvgNormalizedRmse: 0.58,
    minAvgScore: 0.62,
    minParticipantMetricCount: 2,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--parity-report" && index + 1 < argv.length) {
      args.parityReportPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--min-support-replays" && index + 1 < argv.length) {
      args.minSupportReplays = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-avg-correlation" && index + 1 < argv.length) {
      args.minAvgCorrelation = Number.parseFloat(argv[++index]);
    } else if (arg === "--max-avg-normalized-rmse" && index + 1 < argv.length) {
      args.maxAvgNormalizedRmse = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-avg-score" && index + 1 < argv.length) {
      args.minAvgScore = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-participant-metric-count" && index + 1 < argv.length) {
      args.minParticipantMetricCount = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/build_keyframe_parity_schema.mjs [--artifact-root <path>] [--parity-report <path>] [--output-path <path>]");
}

function finiteValues(values) {
  return values.filter((value) => typeof value === "number" && Number.isFinite(value));
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value != null))].sort((left, right) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  });
}

function groupByReplay(entries) {
  const byReplay = new Map();
  for (const entry of entries) {
    const list = byReplay.get(entry.replayId) ?? [];
    list.push(entry);
    byReplay.set(entry.replayId, list);
  }
  return byReplay;
}

function bestMetricMatchPerReplay(matches) {
  const winners = [];
  const ambiguousReplays = [];
  for (const [replayId, entries] of groupByReplay(matches)) {
    const ranked = [...entries].sort((left, right) =>
      right.score - left.score ||
      right.correlation - left.correlation ||
      left.normalizedRmse - right.normalizedRmse ||
      left.participantId - right.participantId,
    );
    const winner = ranked[0];
    const runnerUp = ranked.find((entry) => entry.participantId !== winner.participantId) ?? null;
    const scoreGap = runnerUp ? winner.score - runnerUp.score : Number.POSITIVE_INFINITY;
    const unambiguous = !runnerUp || scoreGap >= 0.08;
    winners.push({
      ...winner,
      replayParticipantConflictCount: new Set(entries.map((entry) => entry.participantId)).size,
      runnerUpScore: runnerUp?.score ?? null,
      scoreGap,
      unambiguous,
    });
    if (!unambiguous) {
      ambiguousReplays.push(replayId);
    }
  }
  return { winners, ambiguousReplays };
}

function bestParticipantSlotEvidencePerReplay(entries) {
  const winners = [];
  const ambiguousReplays = [];
  for (const [replayId, replayEntries] of groupByReplay(entries)) {
    const ranked = [...replayEntries].sort((left, right) =>
      right.metricCount - left.metricCount ||
      right.bestScore - left.bestScore ||
      right.avgCorrelation - left.avgCorrelation ||
      left.avgNormalizedRmse - right.avgNormalizedRmse ||
      left.participantId - right.participantId,
    );
    const winner = ranked[0];
    const runnerUp = ranked.find((entry) => entry.participantId !== winner.participantId) ?? null;
    const metricCountGap = runnerUp ? winner.metricCount - runnerUp.metricCount : Number.POSITIVE_INFINITY;
    const scoreGap = runnerUp ? winner.bestScore - runnerUp.bestScore : Number.POSITIVE_INFINITY;
    const unambiguous = !runnerUp || metricCountGap >= 2 || (metricCountGap >= 1 && scoreGap >= 0.08) || scoreGap >= 0.16;
    winners.push({
      ...winner,
      replayParticipantConflictCount: new Set(replayEntries.map((entry) => entry.participantId)).size,
      runnerUpMetricCount: runnerUp?.metricCount ?? null,
      runnerUpScore: runnerUp?.bestScore ?? null,
      metricCountGap,
      scoreGap,
      unambiguous,
    });
    if (!unambiguous) {
      ambiguousReplays.push(replayId);
    }
  }
  return { winners, ambiguousReplays };
}

function summarizeMetricGroup(key, matches, thresholds) {
  const [versionGroup, familyKey, slotIndexText, metric, offsetText, decodeLabel] = key.split("|");
  const { winners, ambiguousReplays } = bestMetricMatchPerReplay(matches);
  const unambiguousWinners = winners.filter((match) => match.unambiguous);
  const supportReplays = uniqueSorted(winners.map((match) => match.replayId));
  const unambiguousSupportReplays = uniqueSorted(unambiguousWinners.map((match) => match.replayId));
  const participantIds = uniqueSorted(winners.map((match) => match.participantId));
  const champions = uniqueSorted(winners.map((match) => match.champion));
  const teamPositions = uniqueSorted(winners.map((match) => match.teamPosition));
  const correlations = finiteValues(unambiguousWinners.map((match) => match.correlation));
  const normalizedRmses = finiteValues(unambiguousWinners.map((match) => match.normalizedRmse));
  const scores = finiteValues(unambiguousWinners.map((match) => match.score));
  const overlaps = finiteValues(unambiguousWinners.map((match) => match.overlap));
  const slopes = finiteValues(unambiguousWinners.map((match) => match.slope));

  const avgCorrelation = average(correlations);
  const avgNormalizedRmse = average(normalizedRmses);
  const avgScore = average(scores);
  const supportReplayCount = supportReplays.length;
  const unambiguousSupportReplayCount = unambiguousSupportReplays.length;
  const promoted =
    unambiguousSupportReplayCount >= thresholds.minSupportReplays &&
    avgCorrelation >= thresholds.minAvgCorrelation &&
    avgNormalizedRmse <= thresholds.maxAvgNormalizedRmse &&
    avgScore >= thresholds.minAvgScore;

  return {
    key,
    versionGroup,
    familyKey,
    slotIndex: Number.parseInt(slotIndexText, 10),
    metric,
    offset: Number.parseInt(offsetText, 10),
    decodeLabel,
    promoted,
    supportReplayCount,
    unambiguousSupportReplayCount,
    supportReplays,
    unambiguousSupportReplays,
    ambiguousReplays,
    participantIds,
    champions,
    teamPositions,
    sampleCount: matches.length,
    avgOverlap: average(overlaps),
    medianOverlap: median(overlaps),
    avgCorrelation,
    medianCorrelation: median(correlations),
    avgNormalizedRmse,
    medianNormalizedRmse: median(normalizedRmses),
    avgScore,
    medianScore: median(scores),
    medianSlope: median(slopes),
    examples: winners
      .sort((left, right) =>
        right.score - left.score ||
        right.correlation - left.correlation ||
        left.normalizedRmse - right.normalizedRmse,
      )
      .slice(0, 8)
      .map((match) => ({
        replayId: match.replayId,
        participantId: match.participantId,
        champion: match.champion,
        teamPosition: match.teamPosition,
        overlap: match.overlap,
        correlation: match.correlation,
        normalizedRmse: match.normalizedRmse,
        score: match.score,
        replayParticipantConflictCount: match.replayParticipantConflictCount,
        scoreGap: Number.isFinite(match.scoreGap) ? match.scoreGap : null,
        unambiguous: match.unambiguous,
        firstApiFrameIndex: match.firstApiFrameIndex,
        lastApiFrameIndex: match.lastApiFrameIndex,
      })),
  };
}

function summarizeParticipantSlotGroup(key, entries, thresholds) {
  const [versionGroup, familyKey, slotIndexText] = key.split("|");
  const { winners, ambiguousReplays } = bestParticipantSlotEvidencePerReplay(entries);
  const unambiguousWinners = winners.filter((entry) => entry.unambiguous);
  const supportReplays = uniqueSorted(winners.map((entry) => entry.replayId));
  const unambiguousSupportReplays = uniqueSorted(unambiguousWinners.map((entry) => entry.replayId));
  const metricCounts = finiteValues(unambiguousWinners.map((entry) => entry.metricCount));
  const correlations = finiteValues(unambiguousWinners.map((entry) => entry.avgCorrelation));
  const normalizedRmses = finiteValues(unambiguousWinners.map((entry) => entry.avgNormalizedRmse));
  const scores = finiteValues(unambiguousWinners.map((entry) => entry.bestScore));
  const metricSet = new Set();
  for (const entry of unambiguousWinners) {
    for (const metric of entry.metrics ?? []) {
      metricSet.add(metric);
    }
  }

  const strongEntries = unambiguousWinners.filter((entry) => (entry.metricCount ?? 0) >= thresholds.minParticipantMetricCount);
  const promoted =
    unambiguousSupportReplays.length >= thresholds.minSupportReplays &&
    strongEntries.length >= thresholds.minSupportReplays &&
    average(correlations) >= thresholds.minAvgCorrelation &&
    average(normalizedRmses) <= thresholds.maxAvgNormalizedRmse;

  return {
    key,
    versionGroup,
    familyKey,
    slotIndex: Number.parseInt(slotIndexText, 10),
    promoted,
    supportReplayCount: supportReplays.length,
    unambiguousSupportReplayCount: unambiguousSupportReplays.length,
    strongReplayCount: uniqueSorted(strongEntries.map((entry) => entry.replayId)).length,
    supportReplays,
    unambiguousSupportReplays,
    ambiguousReplays,
    metrics: [...metricSet].sort(),
    avgMetricCount: average(metricCounts),
    medianMetricCount: median(metricCounts),
    avgCorrelation: average(correlations),
    avgNormalizedRmse: average(normalizedRmses),
    bestScore: Math.max(0, ...scores),
    examples: winners
      .sort((left, right) =>
        Number(right.unambiguous) - Number(left.unambiguous) ||
        right.metricCount - left.metricCount ||
        right.bestScore - left.bestScore ||
        right.avgCorrelation - left.avgCorrelation ||
        left.avgNormalizedRmse - right.avgNormalizedRmse,
      )
      .slice(0, 8)
      .map((entry) => ({
        replayId: entry.replayId,
        participantId: entry.participantId,
        champion: entry.champion,
        teamPosition: entry.teamPosition,
        metricCount: entry.metricCount,
        metrics: entry.metrics,
        avgCorrelation: entry.avgCorrelation,
        avgNormalizedRmse: entry.avgNormalizedRmse,
        bestScore: entry.bestScore,
        replayParticipantConflictCount: entry.replayParticipantConflictCount,
        runnerUpMetricCount: entry.runnerUpMetricCount,
        runnerUpScore: entry.runnerUpScore,
        metricCountGap: Number.isFinite(entry.metricCountGap) ? entry.metricCountGap : null,
        scoreGap: Number.isFinite(entry.scoreGap) ? entry.scoreGap : null,
        unambiguous: entry.unambiguous,
      })),
  };
}

function buildSchema(report, thresholds) {
  const metricGroups = new Map();
  const participantSlotGroups = new Map();
  const replaySummaries = [];

  for (const replay of report.replays ?? []) {
    if (replay.skipped) {
      continue;
    }

    replaySummaries.push({
      replayId: replay.replayId,
      versionGroup: replay.versionGroup,
      gameVersion: replay.gameVersion,
      candidateCount: replay.candidateCount,
      matchCount: replay.matchCount,
      passingMatchCount: replay.passingMatchCount,
      participantSlotEvidenceCount: replay.participantSlotEvidenceCount,
      replayKeyframeCount: replay.replayKeyframeCount,
      apiFrameCount: replay.apiFrameCount,
      finalApiFrameIsUnpaired: replay.finalApiFrameIsUnpaired,
    });

    for (const match of replay.topMatches ?? []) {
      if (!match.pass) {
        continue;
      }
      const key = [
        replay.versionGroup,
        match.familyKey,
        match.slotIndex,
        match.metric,
        match.offset,
        match.decodeLabel,
      ].join("|");
      const list = metricGroups.get(key) ?? [];
      list.push({ ...match, replayId: replay.replayId, versionGroup: replay.versionGroup });
      metricGroups.set(key, list);
    }

    for (const evidence of replay.participantSlotEvidence ?? []) {
      const key = [
        replay.versionGroup,
        evidence.familyKey,
        evidence.slotIndex,
      ].join("|");
      const list = participantSlotGroups.get(key) ?? [];
      list.push({ ...evidence, replayId: replay.replayId, versionGroup: replay.versionGroup });
      participantSlotGroups.set(key, list);
    }
  }

  const metricCandidates = [...metricGroups.entries()]
    .map(([key, matches]) => summarizeMetricGroup(key, matches, thresholds))
    .sort((left, right) =>
      Number(right.promoted) - Number(left.promoted) ||
      right.unambiguousSupportReplayCount - left.unambiguousSupportReplayCount ||
      right.supportReplayCount - left.supportReplayCount ||
      right.avgScore - left.avgScore ||
      right.avgCorrelation - left.avgCorrelation ||
      left.avgNormalizedRmse - right.avgNormalizedRmse ||
      left.key.localeCompare(right.key),
    );

  const participantSlotCandidates = [...participantSlotGroups.entries()]
    .map(([key, entries]) => summarizeParticipantSlotGroup(key, entries, thresholds))
    .sort((left, right) =>
      Number(right.promoted) - Number(left.promoted) ||
      right.strongReplayCount - left.strongReplayCount ||
      right.unambiguousSupportReplayCount - left.unambiguousSupportReplayCount ||
      right.supportReplayCount - left.supportReplayCount ||
      right.bestScore - left.bestScore ||
      right.avgCorrelation - left.avgCorrelation ||
      left.avgNormalizedRmse - right.avgNormalizedRmse ||
      left.key.localeCompare(right.key),
    );

  return {
    generatedAtUtc: new Date().toISOString(),
    sourceReportGeneratedAtUtc: report.generatedAtUtc ?? null,
    artifactRoot: report.artifactRoot ?? null,
    thresholds,
    replayCount: replaySummaries.length,
    replaySummaries,
    promotedMetricCandidates: metricCandidates.filter((entry) => entry.promoted),
    rankedMetricCandidates: metricCandidates.filter((entry) => !entry.promoted).slice(0, 256),
    promotedParticipantSlotCandidates: participantSlotCandidates.filter((entry) => entry.promoted),
    rankedParticipantSlotCandidates: participantSlotCandidates.filter((entry) => !entry.promoted).slice(0, 256),
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const parityReportPath = args.parityReportPath
    ? resolveAbsolute(repoRoot, args.parityReportPath)
    : path.join(artifactRoot, "keyframe-api-parity.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-parity-schema.json");

  if (!fs.existsSync(parityReportPath)) {
    throw new Error(`Parity report not found at ${parityReportPath}. Run discover_keyframe_api_parity.mjs first.`);
  }

  const report = readJson(parityReportPath);
  const thresholds = {
    minSupportReplays: args.minSupportReplays,
    minAvgCorrelation: args.minAvgCorrelation,
    maxAvgNormalizedRmse: args.maxAvgNormalizedRmse,
    minAvgScore: args.minAvgScore,
    minParticipantMetricCount: args.minParticipantMetricCount,
  };
  const schema = buildSchema(report, thresholds);
  writeJson(outputPath, schema);

  console.log(`Wrote keyframe parity schema to ${outputPath}`);
  console.log(`promoted metrics: ${schema.promotedMetricCandidates.length}`);
  console.log(`promoted participant slots: ${schema.promotedParticipantSlotCandidates.length}`);
}

main();
