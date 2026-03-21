import fs from "fs";
import path from "path";

import {
  buildFieldIndex,
  buildSummaryRoster,
  fieldSamplesToSeries,
  lastFiniteValue,
  median,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    schemaPath: "artifacts/corpus-schema.json",
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
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

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/extract_replay_stats.mjs --artifact-dir <path> [--schema-path <path>] [--output-path <path>]");
}

function scoreMetricValue(metricKey, expected, actual) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return 0;
  }

  const diff = Math.abs(actual - expected);
  switch (metricKey) {
    case "level":
      return Math.max(0, 1 - (diff / 2));
    case "totalGold":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 900)));
    case "xp":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 800)));
    case "minionsKilled":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.3, 25)));
    case "jungleMinionsKilled":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.4, 12)));
    case "healthMax":
    case "powerMax":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.3, 120)));
    case "health":
    case "power":
    case "currentGold":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.5, 150)));
    default:
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 100)));
  }
}

function isMetricAssignable(metricKey, roster) {
  return roster.some((entry) => Number.isFinite(entry.finalMetrics?.[metricKey]));
}

function derivePatternTransform(pattern, candidateMatches) {
  const matches = (candidateMatches?.topMatches ?? []).filter((match) =>
    match.familyKey === pattern.familyKey &&
    match.offset === pattern.offset &&
    match.decodeLabel === pattern.decode &&
    match.metricKey === pattern.metric,
  );

  const slopes = matches.map((match) => match.slope).filter(Number.isFinite);
  const intercepts = matches.map((match) => match.intercept).filter(Number.isFinite);
  return {
    slopeMedian: slopes.length > 0 ? median(slopes) : 1,
    interceptMedian: intercepts.length > 0 ? median(intercepts) : 0,
    sampleCount: slopes.length,
  };
}

function normalizePattern(pattern, candidateMatches, source) {
  const recommendedSlots = pattern.recommendedSlots
    ? pattern.recommendedSlots
    : (pattern.rawWindowCandidates ?? []).map((candidate) => ({ slotIndex: candidate.slotIndex, replayCount: 1 }));
  const rowBand = pattern.recommendedRowBand ?? pattern.rowBand ?? [0, 0];
  return {
    patternKey: pattern.patternKey,
    familyKey: pattern.familyKey,
    metric: pattern.metric,
    metricLabel: pattern.metricLabel,
    confidence: pattern.confidence,
    recommendedRowBand: rowBand,
    recommendedSlots,
    offset: pattern.offset,
    decode: pattern.decode,
    transform: pattern.transform?.sampleCount > 0 ? pattern.transform : derivePatternTransform(pattern, candidateMatches),
    source,
  };
}

function evaluateSeriesPlausibility(metricKey, series) {
  if (!series.length) {
    return 0;
  }

  const values = series.map((point) => point.value).filter(Number.isFinite);
  if (!values.length) {
    return 0;
  }

  let minExpected = -Infinity;
  let maxExpected = Infinity;
  let monotonic = false;
  switch (metricKey) {
    case "level":
      minExpected = 1;
      maxExpected = 18;
      monotonic = true;
      break;
    case "totalGold":
      minExpected = 0;
      maxExpected = 30000;
      monotonic = true;
      break;
    case "xp":
      minExpected = 0;
      maxExpected = 40000;
      monotonic = true;
      break;
    case "minionsKilled":
      minExpected = 0;
      maxExpected = 500;
      monotonic = true;
      break;
    case "jungleMinionsKilled":
      minExpected = 0;
      maxExpected = 350;
      monotonic = true;
      break;
    default:
      return 0.5;
  }

  const inRangeCount = values.filter((value) => value >= minExpected && value <= maxExpected).length;
  const inRangeRatio = inRangeCount / values.length;

  let monotonicRatio = 1;
  if (monotonic && values.length > 1) {
    let okay = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] >= (values[index - 1] - 1e-6)) {
        okay += 1;
      }
    }
    monotonicRatio = okay / (values.length - 1);
  }

  return (0.7 * inRangeRatio) + (0.3 * monotonicRatio);
}

function pickBestTransform(pattern, field, roster) {
  const transformCandidates = [];
  const preferred = pattern.transform ?? { slopeMedian: 1, interceptMedian: 0, sampleCount: 0 };
  transformCandidates.push({
    slopeMedian: preferred.slopeMedian ?? 1,
    interceptMedian: preferred.interceptMedian ?? 0,
    sampleCount: preferred.sampleCount ?? 0,
    label: "learned",
  });
  transformCandidates.push({
    slopeMedian: 1,
    interceptMedian: 0,
    sampleCount: 0,
    label: "identity",
  });

  let best = null;
  for (const transform of transformCandidates) {
    const series = fieldSamplesToSeries(field, {
      slope: transform.slopeMedian,
      intercept: transform.interceptMedian,
    });
    if (series.length === 0) {
      continue;
    }

    const finalValue = lastFiniteValue(series);
    if (!Number.isFinite(finalValue)) {
      continue;
    }

    let bestRosterScore = 0;
    for (const rosterEntry of roster) {
      const expected = rosterEntry.finalMetrics?.[pattern.metric];
      if (!Number.isFinite(expected)) {
        continue;
      }
      bestRosterScore = Math.max(bestRosterScore, scoreMetricValue(pattern.metric, expected, finalValue));
    }

    const plausibilityScore = evaluateSeriesPlausibility(pattern.metric, series);

    let heuristicBonus = 0;
    if (pattern.metric === "level" && finalValue >= 1 && finalValue <= 18) {
      heuristicBonus += 0.1;
    }
    if ((pattern.metric === "minionsKilled" || pattern.metric === "jungleMinionsKilled") && finalValue >= 0 && finalValue <= 400) {
      heuristicBonus += 0.05;
    }

    const score = (0.7 * bestRosterScore) + (0.3 * plausibilityScore) + heuristicBonus;
    if (!best || score > best.score) {
      best = {
        transform,
        series,
        finalValue,
        plausibilityScore,
        score,
      };
    }
  }

  return best;
}

function chooseSchemaPatterns(corpusSchema, provisionalSchema, candidateMatches, runManifest, roster) {
  const familyKeys = new Set((runManifest.families ?? []).map((family) => family.familyKey));
  const promoted = (corpusSchema.promotedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "corpus-promoted"));
  if (promoted.length > 0) {
    return promoted;
  }

  const localPromoted = (provisionalSchema.promotedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "replay-promoted"));
  if (localPromoted.length > 0) {
    return localPromoted;
  }

  const localRanked = (provisionalSchema.rankedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 16)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "replay-ranked"));
  if (localRanked.length > 0) {
    return localRanked;
  }

  const rankedCorpus = (corpusSchema.rankedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .filter((pattern) => (pattern.support?.replays ?? 0) >= 2)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 12)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "corpus-ranked"));
  if (rankedCorpus.length > 0) {
    return rankedCorpus;
  }

  return [];
}

function buildCandidateRows(pattern, familyFieldIndex, roster) {
  const rowBandSlots = [];
  for (let slotIndex = pattern.recommendedRowBand[0]; slotIndex <= pattern.recommendedRowBand[1]; slotIndex += 1) {
    rowBandSlots.push(slotIndex);
  }

  const candidateSlots = [
    ...(pattern.recommendedSlots ?? []).map((slot) => slot.slotIndex),
    ...rowBandSlots,
  ].filter((value, index, array) => array.indexOf(value) === index);

  const candidates = [];
  for (const slotIndex of candidateSlots) {
    const fieldEntry = familyFieldIndex.get(`${slotIndex}|${pattern.offset}|${pattern.decode}`);
    if (!fieldEntry) {
      continue;
    }

    const transformed = pickBestTransform(pattern, fieldEntry.field, roster);
    if (!transformed) {
      continue;
    }
    if (transformed.plausibilityScore < 0.55) {
      continue;
    }

    candidates.push({
      familyKey: pattern.familyKey,
      slotIndex,
      metric: pattern.metric,
      metricLabel: pattern.metricLabel,
      patternConfidence: pattern.confidence,
      transformLabel: transformed.transform.label,
      plausibilityScore: transformed.plausibilityScore,
      series: transformed.series,
      finalValue: transformed.finalValue,
    });
  }

  return candidates;
}

function assignPatternCandidates(pattern, candidates, roster) {
  const edges = [];
  for (const candidate of candidates) {
    for (const rosterEntry of roster) {
      const expected = rosterEntry.finalMetrics[pattern.metric];
      if (!Number.isFinite(expected) || !Number.isFinite(candidate.finalValue)) {
        continue;
      }

      const score = scoreMetricValue(pattern.metric, expected, candidate.finalValue);
      if (score <= 0.2) {
        continue;
      }

      edges.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        rosterIndex: rosterEntry.rosterIndex,
        metric: pattern.metric,
        score,
      });
    }
  }

  edges.sort((left, right) => right.score - left.score);
  const assignedSlots = new Set();
  const assignedRoster = new Set();
  const assignments = [];
  for (const edge of edges) {
    const slotKey = `${edge.familyKey}|${edge.slotIndex}`;
    if (assignedSlots.has(slotKey) || assignedRoster.has(edge.rosterIndex)) {
      continue;
    }
    assignments.push(edge);
    assignedSlots.add(slotKey);
    assignedRoster.add(edge.rosterIndex);
  }

  return assignments;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const schemaPath = resolveAbsolute(repoRoot, args.schemaPath);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "extracted-stats.json");

  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const summaryPath = path.join(artifactDir, "summary.json");
  const provisionalSchemaPath = path.join(artifactDir, "provisional-schema.json");
  const candidateMatchesPath = path.join(artifactDir, "candidate-matches.json");
  if (!fs.existsSync(runManifestPath)) {
    throw new Error(`Run manifest not found at ${runManifestPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Replay summary not found at ${summaryPath}. Re-run artifact generation with the updated runner.`);
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Corpus schema not found at ${schemaPath}`);
  }

  const runManifest = readJson(runManifestPath);
  const summaryJson = readJson(summaryPath);
  const corpusSchema = readJson(schemaPath);
  const provisionalSchema = fs.existsSync(provisionalSchemaPath) ? readJson(provisionalSchemaPath) : { promotedPatterns: [], rankedPatterns: [] };
  const candidateMatches = fs.existsSync(candidateMatchesPath) ? readJson(candidateMatchesPath) : { topMatches: [] };
  const roster = buildSummaryRoster(summaryJson);
  const selectedPatterns = chooseSchemaPatterns(corpusSchema, provisionalSchema, candidateMatches, runManifest, roster);

  const familyFieldIndex = new Map();
  for (const family of runManifest.families ?? []) {
    const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    familyFieldIndex.set(family.familyKey, buildFieldIndex(readJson(cleanedPath)));
  }

  const slotAssignmentEvidence = new Map();
  const directAssignments = new Map();
  const candidateRows = [];

  for (const pattern of selectedPatterns) {
    const fieldIndex = familyFieldIndex.get(pattern.familyKey);
    if (!fieldIndex) {
      continue;
    }

    const patternCandidates = buildCandidateRows(pattern, fieldIndex, roster);
    candidateRows.push(...patternCandidates.map((candidate) => ({ ...candidate, pattern })));

    const metricAssignments = assignPatternCandidates(pattern, patternCandidates, roster);
    for (const assignment of metricAssignments) {
      const key = `${assignment.familyKey}|${assignment.slotIndex}|${assignment.rosterIndex}`;
      slotAssignmentEvidence.set(key, (slotAssignmentEvidence.get(key) ?? 0) + (assignment.score * pattern.confidence));
      directAssignments.set(`${assignment.familyKey}|${assignment.slotIndex}|${assignment.metric}`, assignment.rosterIndex);
    }
  }

  const finalSlotAssignments = new Map();
  const groupedEvidence = new Map();
  for (const [evidenceKey, score] of slotAssignmentEvidence.entries()) {
    const [familyKey, slotIndexText, rosterIndexText] = evidenceKey.split("|");
    const slotKey = `${familyKey}|${slotIndexText}`;
    const list = groupedEvidence.get(slotKey) ?? [];
    list.push({ rosterIndex: Number.parseInt(rosterIndexText, 10), score });
    groupedEvidence.set(slotKey, list);
  }
  for (const [slotKey, entries] of groupedEvidence.entries()) {
    const best = [...entries].sort((left, right) => right.score - left.score)[0];
    if (best && best.score >= 0.2) {
      finalSlotAssignments.set(slotKey, best.rosterIndex);
    }
  }

  const participantOutputs = roster.map((entry) => ({
    rosterIndex: entry.rosterIndex,
    champion: entry.champion,
    team: entry.team,
    teamPosition: entry.teamPosition,
    riotIdGameName: entry.riotIdGameName,
    riotIdTagLine: entry.riotIdTagLine,
    metrics: {},
  }));

  const unresolvedCandidates = [];
  for (const candidate of candidateRows) {
    const slotKey = `${candidate.familyKey}|${candidate.slotIndex}`;
    const directKey = `${candidate.familyKey}|${candidate.slotIndex}|${candidate.metric}`;
    const rosterIndex =
      directAssignments.get(directKey) ??
      finalSlotAssignments.get(slotKey) ??
      null;

    if (rosterIndex == null) {
      unresolvedCandidates.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        metric: candidate.metric,
        finalValue: candidate.finalValue,
        patternConfidence: candidate.pattern.confidence,
      });
      continue;
    }

    const participantOutput = participantOutputs.find((entry) => entry.rosterIndex === rosterIndex);
    if (!participantOutput) {
      continue;
    }

    const existing = participantOutput.metrics[candidate.metric];
    const record = {
      familyKey: candidate.familyKey,
      slotIndex: candidate.slotIndex,
      confidence: candidate.pattern.confidence,
      transformLabel: candidate.transformLabel,
      plausibilityScore: candidate.plausibilityScore,
      finalValue: candidate.finalValue,
      timeline: candidate.series.map((point) => ({
        timestamp: point.timestamp,
        value: point.value,
      })),
    };

    if (!existing || record.confidence > existing.confidence) {
      participantOutput.metrics[candidate.metric] = record;
    }
  }

  const extractedStats = {
    replayId: runManifest.replayId,
    generatedAtUtc: new Date().toISOString(),
    schemaPath,
    gameVersion: runManifest.summary?.gameVersion ?? summaryJson.gameVersion ?? "unknown",
    roster: roster.map((entry) => ({
      rosterIndex: entry.rosterIndex,
      champion: entry.champion,
      team: entry.team,
      teamPosition: entry.teamPosition,
      riotIdGameName: entry.riotIdGameName,
      riotIdTagLine: entry.riotIdTagLine,
      finalMetrics: entry.finalMetrics,
    })),
    selectedPatterns: selectedPatterns.map((pattern) => ({
      patternKey: pattern.patternKey,
      familyKey: pattern.familyKey,
      metric: pattern.metric,
      source: pattern.source,
      confidence: pattern.confidence,
      recommendedRowBand: pattern.recommendedRowBand,
      recommendedSlots: pattern.recommendedSlots,
      transform: pattern.transform,
    })),
    participants: participantOutputs,
    unresolvedCandidates,
  };

  writeJson(outputPath, extractedStats);
  console.log(`Wrote extracted replay stats to ${outputPath}`);
  console.log(`Assigned ${participantOutputs.reduce((sum, participant) => sum + Object.keys(participant.metrics).length, 0)} metric timelines.`);
}

main();
