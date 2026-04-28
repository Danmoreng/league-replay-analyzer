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
    minParticipantIdentityWeight: 2.4,
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
    } else if (arg === "--min-participant-identity-weight" && index + 1 < argv.length) {
      args.minParticipantIdentityWeight = Number.parseFloat(argv[++index]);
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

const METRIC_IDENTITY_WEIGHTS = new Map([
  ["health", 1.4],
  ["power", 1.4],
  ["currentGold", 1.35],
  ["movementSpeed", 1.25],
  ["minionsKilled", 1.0],
  ["jungleMinionsKilled", 1.0],
  ["totalGold", 0.75],
  ["xp", 0.75],
  ["level", 0.6],
  ["healthMax", 0.55],
  ["powerMax", 0.55],
]);

function metricIdentityWeight(metric) {
  return METRIC_IDENTITY_WEIGHTS.get(metric) ?? 0.5;
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

function enrichParticipantSlotEvidence(entry) {
  const metrics = [...new Set(entry.metrics ?? [])];
  const identityWeight = metrics.reduce((sum, metric) => sum + metricIdentityWeight(metric), 0);
  const identityMetricCount = metrics.filter((metric) => metricIdentityWeight(metric) >= 1).length;
  const genericMetricCount = metrics.length - identityMetricCount;
  const weightedSupportScore = (entry.support ?? []).reduce((sum, support) => {
    const score = typeof support.score === "number" && Number.isFinite(support.score) ? support.score : 0;
    return sum + metricIdentityWeight(support.metric) * score;
  }, 0);
  return {
    ...entry,
    identityWeight,
    identityMetricCount,
    genericMetricCount,
    weightedSupportScore,
  };
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
    const ranked = replayEntries.map(enrichParticipantSlotEvidence).sort((left, right) =>
      right.identityWeight - left.identityWeight ||
      right.weightedSupportScore - left.weightedSupportScore ||
      right.metricCount - left.metricCount ||
      right.bestScore - left.bestScore ||
      right.avgCorrelation - left.avgCorrelation ||
      left.avgNormalizedRmse - right.avgNormalizedRmse ||
      left.participantId - right.participantId,
    );
    const winner = ranked[0];
    const runnerUp = ranked.find((entry) => entry.participantId !== winner.participantId) ?? null;
    const metricCountGap = runnerUp ? winner.metricCount - runnerUp.metricCount : Number.POSITIVE_INFINITY;
    const identityWeightGap = runnerUp ? winner.identityWeight - runnerUp.identityWeight : Number.POSITIVE_INFINITY;
    const weightedSupportScoreGap = runnerUp ? winner.weightedSupportScore - runnerUp.weightedSupportScore : Number.POSITIVE_INFINITY;
    const scoreGap = runnerUp ? winner.bestScore - runnerUp.bestScore : Number.POSITIVE_INFINITY;
    const unambiguous = !runnerUp ||
      identityWeightGap >= 1.4 ||
      (identityWeightGap >= 0.8 && metricCountGap >= 1) ||
      (metricCountGap >= 2 && scoreGap >= 0.08) ||
      scoreGap >= 0.16;
    winners.push({
      ...winner,
      replayParticipantConflictCount: new Set(replayEntries.map((entry) => entry.participantId)).size,
      runnerUpMetricCount: runnerUp?.metricCount ?? null,
      runnerUpIdentityWeight: runnerUp?.identityWeight ?? null,
      runnerUpWeightedSupportScore: runnerUp?.weightedSupportScore ?? null,
      runnerUpScore: runnerUp?.bestScore ?? null,
      metricCountGap,
      identityWeightGap,
      weightedSupportScoreGap,
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
  const identityWeights = finiteValues(unambiguousWinners.map((entry) => entry.identityWeight));
  const identityMetricCounts = finiteValues(unambiguousWinners.map((entry) => entry.identityMetricCount));
  const genericMetricCounts = finiteValues(unambiguousWinners.map((entry) => entry.genericMetricCount));
  const weightedSupportScores = finiteValues(unambiguousWinners.map((entry) => entry.weightedSupportScore));
  const correlations = finiteValues(unambiguousWinners.map((entry) => entry.avgCorrelation));
  const normalizedRmses = finiteValues(unambiguousWinners.map((entry) => entry.avgNormalizedRmse));
  const scores = finiteValues(unambiguousWinners.map((entry) => entry.bestScore));
  const metricSet = new Set();
  const stateMetricSet = new Set();
  for (const entry of winners) {
    for (const metric of entry.metrics ?? []) {
      stateMetricSet.add(metric);
    }
  }
  for (const entry of unambiguousWinners) {
    for (const metric of entry.metrics ?? []) {
      metricSet.add(metric);
    }
  }

  const strongEntries = unambiguousWinners.filter((entry) => (entry.metricCount ?? 0) >= thresholds.minParticipantMetricCount);
  const identityStrongEntries = strongEntries.filter((entry) => (entry.identityWeight ?? 0) >= thresholds.minParticipantIdentityWeight);
  const stateStrongEntries = winners.filter((entry) => (entry.metricCount ?? 0) >= thresholds.minParticipantMetricCount);
  const stateMetricCounts = finiteValues(winners.map((entry) => entry.metricCount));
  const stateIdentityWeights = finiteValues(winners.map((entry) => entry.identityWeight));
  const stateIdentityMetricCounts = finiteValues(winners.map((entry) => entry.identityMetricCount));
  const stateGenericMetricCounts = finiteValues(winners.map((entry) => entry.genericMetricCount));
  const stateWeightedSupportScores = finiteValues(winners.map((entry) => entry.weightedSupportScore));
  const allCorrelations = finiteValues(winners.map((entry) => entry.avgCorrelation));
  const allNormalizedRmses = finiteValues(winners.map((entry) => entry.avgNormalizedRmse));
  const statePromoted =
    supportReplays.length >= thresholds.minSupportReplays &&
    uniqueSorted(stateStrongEntries.map((entry) => entry.replayId)).length >= thresholds.minSupportReplays &&
    average(allCorrelations) >= thresholds.minAvgCorrelation &&
    average(allNormalizedRmses) <= thresholds.maxAvgNormalizedRmse;
  const identityPromoted =
    unambiguousSupportReplays.length >= thresholds.minSupportReplays &&
    uniqueSorted(identityStrongEntries.map((entry) => entry.replayId)).length >= thresholds.minSupportReplays &&
    average(correlations) >= thresholds.minAvgCorrelation &&
    average(normalizedRmses) <= thresholds.maxAvgNormalizedRmse;

  return {
    key,
    versionGroup,
    familyKey,
    slotIndex: Number.parseInt(slotIndexText, 10),
    promoted: identityPromoted,
    statePromoted,
    identityPromoted,
    supportReplayCount: supportReplays.length,
    unambiguousSupportReplayCount: unambiguousSupportReplays.length,
    strongReplayCount: uniqueSorted(strongEntries.map((entry) => entry.replayId)).length,
    stateStrongReplayCount: uniqueSorted(stateStrongEntries.map((entry) => entry.replayId)).length,
    identityStrongReplayCount: uniqueSorted(identityStrongEntries.map((entry) => entry.replayId)).length,
    ambiguousReplayCount: uniqueSorted(ambiguousReplays).length,
    supportReplays,
    unambiguousSupportReplays,
    ambiguousReplays,
    metrics: [...metricSet].sort(),
    stateMetrics: [...stateMetricSet].sort(),
    stateAvgMetricCount: average(stateMetricCounts),
    stateMedianMetricCount: median(stateMetricCounts),
    stateAvgIdentityWeight: average(stateIdentityWeights),
    stateMedianIdentityWeight: median(stateIdentityWeights),
    stateAvgIdentityMetricCount: average(stateIdentityMetricCounts),
    stateAvgGenericMetricCount: average(stateGenericMetricCounts),
    stateAvgWeightedSupportScore: average(stateWeightedSupportScores),
    stateAvgCorrelation: average(allCorrelations),
    stateAvgNormalizedRmse: average(allNormalizedRmses),
    avgMetricCount: average(metricCounts),
    medianMetricCount: median(metricCounts),
    avgIdentityWeight: average(identityWeights),
    medianIdentityWeight: median(identityWeights),
    avgIdentityMetricCount: average(identityMetricCounts),
    avgGenericMetricCount: average(genericMetricCounts),
    avgWeightedSupportScore: average(weightedSupportScores),
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
        identityWeight: entry.identityWeight,
        identityMetricCount: entry.identityMetricCount,
        genericMetricCount: entry.genericMetricCount,
        weightedSupportScore: entry.weightedSupportScore,
        metrics: entry.metrics,
        avgCorrelation: entry.avgCorrelation,
        avgNormalizedRmse: entry.avgNormalizedRmse,
        bestScore: entry.bestScore,
        replayParticipantConflictCount: entry.replayParticipantConflictCount,
        runnerUpMetricCount: entry.runnerUpMetricCount,
        runnerUpIdentityWeight: entry.runnerUpIdentityWeight,
        runnerUpWeightedSupportScore: entry.runnerUpWeightedSupportScore,
        runnerUpScore: entry.runnerUpScore,
        metricCountGap: Number.isFinite(entry.metricCountGap) ? entry.metricCountGap : null,
        identityWeightGap: Number.isFinite(entry.identityWeightGap) ? entry.identityWeightGap : null,
        weightedSupportScoreGap: Number.isFinite(entry.weightedSupportScoreGap) ? entry.weightedSupportScoreGap : null,
        scoreGap: Number.isFinite(entry.scoreGap) ? entry.scoreGap : null,
        unambiguous: entry.unambiguous,
      })),
  };
}

function buildSlotConflictReport(participantSlotCandidates) {
  const conflicted = participantSlotCandidates
    .filter((candidate) => candidate.ambiguousReplayCount > 0)
    .map((candidate) => ({
      key: candidate.key,
      versionGroup: candidate.versionGroup,
      familyKey: candidate.familyKey,
      slotIndex: candidate.slotIndex,
      statePromoted: candidate.statePromoted,
      identityPromoted: candidate.identityPromoted,
      supportReplayCount: candidate.supportReplayCount,
      unambiguousSupportReplayCount: candidate.unambiguousSupportReplayCount,
      ambiguousReplayCount: candidate.ambiguousReplayCount,
      stateAvgIdentityWeight: candidate.stateAvgIdentityWeight,
      stateAvgMetricCount: candidate.stateAvgMetricCount,
      stateAvgCorrelation: candidate.stateAvgCorrelation,
      stateAvgNormalizedRmse: candidate.stateAvgNormalizedRmse,
      identityAvgIdentityWeight: candidate.avgIdentityWeight,
      identityAvgMetricCount: candidate.avgMetricCount,
      identityAvgCorrelation: candidate.avgCorrelation,
      identityAvgNormalizedRmse: candidate.avgNormalizedRmse,
      ambiguousReplays: candidate.ambiguousReplays.slice(0, 16),
      examples: candidate.examples.filter((example) => !example.unambiguous).slice(0, 6),
    }))
    .sort((left, right) =>
      right.ambiguousReplayCount - left.ambiguousReplayCount ||
      right.supportReplayCount - left.supportReplayCount ||
      right.stateAvgIdentityWeight - left.stateAvgIdentityWeight ||
      left.key.localeCompare(right.key),
    );

  return {
    conflictedSlotCount: conflicted.length,
    topConflicts: conflicted.slice(0, 128),
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
      Number(right.statePromoted) - Number(left.statePromoted) ||
      right.identityStrongReplayCount - left.identityStrongReplayCount ||
      right.strongReplayCount - left.strongReplayCount ||
      right.stateStrongReplayCount - left.stateStrongReplayCount ||
      right.unambiguousSupportReplayCount - left.unambiguousSupportReplayCount ||
      right.supportReplayCount - left.supportReplayCount ||
      right.avgIdentityWeight - left.avgIdentityWeight ||
      right.stateAvgIdentityWeight - left.stateAvgIdentityWeight ||
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
    rankedParticipantIdentityCandidates: participantSlotCandidates.filter((entry) => !entry.promoted).slice(0, 256),
    promotedParticipantStateSlotCandidates: participantSlotCandidates.filter((entry) => entry.statePromoted),
    rankedParticipantStateSlotCandidates: participantSlotCandidates.filter((entry) => !entry.statePromoted).slice(0, 256),
    rankedParticipantSlotCandidates: participantSlotCandidates.filter((entry) => !entry.promoted).slice(0, 256),
    slotConflictReport: buildSlotConflictReport(participantSlotCandidates),
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
    minParticipantIdentityWeight: args.minParticipantIdentityWeight,
  };
  const schema = buildSchema(report, thresholds);
  writeJson(outputPath, schema);

  console.log(`Wrote keyframe parity schema to ${outputPath}`);
  console.log(`promoted metrics: ${schema.promotedMetricCandidates.length}`);
  console.log(`promoted participant identity slots: ${schema.promotedParticipantSlotCandidates.length}`);
  console.log(`promoted participant state slots: ${schema.promotedParticipantStateSlotCandidates.length}`);
  console.log(`conflicted participant slots: ${schema.slotConflictReport.conflictedSlotCount}`);
}

main();
