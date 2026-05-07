import fs from "fs";
import path from "path";

import {
  buildFieldIndex,
  buildSummaryRoster,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";
import { metricIdentityWeight } from "./lib/keyframe-slot-scoring.mjs";

const preferredMetrics = new Set([
  "level",
  "xp",
  "totalGold",
  "currentGold",
  "minionsKilled",
  "jungleMinionsKilled",
  "healthMax",
  "powerMax",
]);

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    schemaPath: null,
    outputPath: null,
    versionGroup: null,
    minMetricCount: 2,
    minScore: 1.1,
    minDistinctMetricCount: 2,
    minWinnerGap: 0.35,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--min-metric-count" && index + 1 < argv.length) {
      args.minMetricCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-score" && index + 1 < argv.length) {
      args.minScore = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-distinct-metric-count" && index + 1 < argv.length) {
      args.minDistinctMetricCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-winner-gap" && index + 1 < argv.length) {
      args.minWinnerGap = Number.parseFloat(argv[++index]);
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
  console.log("Usage: node ./scripts/assign_keyframe_slots_from_rofl_stats.mjs [--artifact-root <path>] [--schema-path <path>] [--version-group <group>] [--output-path <path>] [--min-distinct-metric-count <n>] [--min-winner-gap <score>]");
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value != null))].sort((left, right) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  });
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function lastFiniteSample(field) {
  for (let index = (field?.samples?.length ?? 0) - 1; index >= 0; index -= 1) {
    const sample = field.samples[index];
    if (finite(sample.decoded)) {
      return sample;
    }
  }
  return null;
}

function transformedValue(rawValue, candidate) {
  const slope = finite(candidate.medianSlope) ? candidate.medianSlope : (finite(candidate.avgSlope) ? candidate.avgSlope : 1);
  const intercept = finite(candidate.medianIntercept) ? candidate.medianIntercept : (finite(candidate.avgIntercept) ? candidate.avgIntercept : 0);
  return (slope * rawValue) + intercept;
}

function metricFitScore(predicted, target, metric) {
  if (!finite(predicted) || !finite(target)) {
    return 0;
  }
  const scale = Math.max(Math.abs(target), 20);
  const relativeError = Math.abs(predicted - target) / scale;
  const base = 1 / (1 + (relativeError * 4));
  const monotonicPenalty = predicted > target * 1.08 && preferredMetrics.has(metric) ? 0.65 : 1;
  return base * metricIdentityWeight(metric) * monotonicPenalty;
}

function schemaByVersion(schema) {
  const metricsBySlot = new Map();
  const metricCandidates = [
    ...(schema.promotedMetricCandidates ?? []),
    ...(schema.rankedMetricCandidates ?? []),
  ];
  for (const candidate of metricCandidates) {
    if (!preferredMetrics.has(candidate.metric)) {
      continue;
    }
    const key = `${candidate.versionGroup}|${candidate.familyKey}|${candidate.slotIndex}`;
    const list = metricsBySlot.get(key) ?? [];
    list.push(candidate);
    metricsBySlot.set(key, list);
  }

  const byVersion = new Map();
  for (const candidate of schema.promotedParticipantStateSlotCandidates ?? []) {
    const list = byVersion.get(candidate.versionGroup) ?? [];
    list.push({
      ...candidate,
      metricCandidates: metricsBySlot.get(`${candidate.versionGroup}|${candidate.familyKey}|${candidate.slotIndex}`) ?? [],
    });
    byVersion.set(candidate.versionGroup, list);
  }
  return byVersion;
}

function readFamilyIndexes(artifactDir, candidates) {
  const indexes = new Map();
  for (const familyKey of uniqueSorted(candidates.map((candidate) => candidate.familyKey))) {
    const cleanedPath = path.join(artifactDir, "families", familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    indexes.set(familyKey, buildFieldIndex(readJson(cleanedPath)));
  }
  return indexes;
}

function buildSlotMetricValues(familyIndexes, candidate) {
  const fieldIndex = familyIndexes.get(candidate.familyKey);
  if (!fieldIndex) {
    return [];
  }
  const values = [];
  for (const metricCandidate of candidate.metricCandidates ?? []) {
    const indexedField = fieldIndex.get(`${candidate.slotIndex}|${metricCandidate.offset}|${metricCandidate.decodeLabel}`);
    const sample = lastFiniteSample(indexedField?.field);
    if (!sample) {
      continue;
    }
    values.push({
      metric: metricCandidate.metric,
      rawValue: sample.decoded,
      value: transformedValue(sample.decoded, metricCandidate),
      timestamp: sample.timestamp,
      offset: metricCandidate.offset,
      decodeLabel: metricCandidate.decodeLabel,
    });
  }
  return values;
}

function buildEdges(roster, candidates, familyIndexes, thresholds) {
  const edges = [];
  const diagnostics = {
    candidateSlotCount: candidates.length,
    slotWithMetricValueCount: 0,
    slotMetricValueCount: 0,
    comparedMetricCount: 0,
    positiveMetricScoreCount: 0,
    supportBelowMetricCount: 0,
    scoreBelowThresholdCount: 0,
    maxCandidateScore: null,
    maxCandidateMetricCount: 0,
  };
  for (const candidate of candidates) {
    const slotMetricValues = buildSlotMetricValues(familyIndexes, candidate);
    if (!slotMetricValues.length) {
      continue;
    }
    diagnostics.slotWithMetricValueCount += 1;
    diagnostics.slotMetricValueCount += slotMetricValues.length;
    for (const rosterEntry of roster) {
      const support = [];
      let score = 0;
      for (const metricValue of slotMetricValues) {
        const target = rosterEntry.finalMetrics?.[metricValue.metric];
        if (!finite(target)) {
          continue;
        }
        diagnostics.comparedMetricCount += 1;
        const metricScore = metricFitScore(metricValue.value, target, metricValue.metric);
        if (metricScore <= 0) {
          continue;
        }
        diagnostics.positiveMetricScoreCount += 1;
        support.push({
          metric: metricValue.metric,
          predicted: metricValue.value,
          target,
          score: metricScore,
          offset: metricValue.offset,
          decodeLabel: metricValue.decodeLabel,
        });
        score += metricScore;
      }
      if (support.length > 0 && (diagnostics.maxCandidateScore == null || score > diagnostics.maxCandidateScore)) {
        diagnostics.maxCandidateScore = score;
        diagnostics.maxCandidateMetricCount = support.length;
      }
      if (support.length < thresholds.minMetricCount || score < thresholds.minScore) {
        if (support.length > 0 && support.length < thresholds.minMetricCount) {
          diagnostics.supportBelowMetricCount += 1;
        } else if (support.length >= thresholds.minMetricCount && score < thresholds.minScore) {
          diagnostics.scoreBelowThresholdCount += 1;
        }
        continue;
      }
      edges.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        rosterIndex: rosterEntry.rosterIndex,
        champion: rosterEntry.champion,
        team: rosterEntry.team,
        teamPosition: rosterEntry.teamPosition,
        score,
        metricCount: support.length,
        support,
      });
    }
  }
  return { edges, diagnostics };
}

function solveAssignments(slots, rosterIndexes, edgesBySlot) {
  const rosterOffset = new Map(rosterIndexes.map((rosterIndex, index) => [rosterIndex, index]));
  const memo = new Map();

  function search(slotOffset, usedMask) {
    const key = `${slotOffset}|${usedMask}`;
    if (memo.has(key)) {
      return memo.get(key);
    }
    if (slotOffset >= slots.length) {
      return { score: 0, assignments: [] };
    }

    const slot = slots[slotOffset];
    let best = search(slotOffset + 1, usedMask);
    for (const edge of edgesBySlot.get(slot.key) ?? []) {
      const offset = rosterOffset.get(edge.rosterIndex);
      if (offset == null) {
        continue;
      }
      const bit = 1 << offset;
      if ((usedMask & bit) !== 0) {
        continue;
      }
      const suffix = search(slotOffset + 1, usedMask | bit);
      const candidate = {
        score: edge.score + suffix.score,
        assignments: [{ slot, edge }, ...suffix.assignments],
      };
      if (candidate.score > best.score || (candidate.score === best.score && candidate.assignments.length > best.assignments.length)) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  return search(0, 0);
}

function classifyAssignment(edge, runnerUp, thresholds) {
  const distinctMetricCount = new Set((edge.support ?? []).map((support) => support.metric)).size;
  const winnerGap = runnerUp ? edge.score - runnerUp.score : null;
  const rank = runnerUp && runnerUp.score > edge.score ? 2 : 1;
  const reasons = [];

  if (edge.metricCount < thresholds.minMetricCount) {
    reasons.push("below-min-metric-count");
  }
  if (distinctMetricCount < thresholds.minDistinctMetricCount) {
    reasons.push("below-min-distinct-metric-count");
  }
  if (edge.score < thresholds.minScore) {
    reasons.push("below-min-score");
  }
  if (runnerUp && winnerGap < thresholds.minWinnerGap) {
    reasons.push("below-min-winner-gap");
  }

  return {
    confidence: reasons.length === 0 ? "canonical-candidate" : "diagnostic-only",
    canonicalCandidate: reasons.length === 0,
    rank,
    distinctMetricCount,
    winnerGap,
    rejectionReasons: reasons,
  };
}

function assignFamily(familyKey, candidates, edges, thresholds) {
  const familyCandidates = candidates.filter((candidate) => candidate.familyKey === familyKey);
  const familyEdges = edges.filter((edge) => edge.familyKey === familyKey);
  const slots = familyCandidates.map((candidate) => ({
    key: `${candidate.familyKey}|${candidate.slotIndex}`,
    schemaKey: candidate.key,
    familyKey: candidate.familyKey,
    slotIndex: candidate.slotIndex,
  }));
  const edgesBySlot = new Map();
  for (const edge of familyEdges) {
    const key = `${edge.familyKey}|${edge.slotIndex}`;
    const list = edgesBySlot.get(key) ?? [];
    list.push(edge);
    edgesBySlot.set(key, list);
  }
  for (const [key, list] of edgesBySlot) {
    list.sort((left, right) => right.score - left.score || right.metricCount - left.metricCount);
    edgesBySlot.set(key, list);
  }

  const solution = solveAssignments(slots, uniqueSorted(familyEdges.map((edge) => edge.rosterIndex)), edgesBySlot);
  let canonicalCandidateCount = 0;
  let diagnosticOnlyCount = 0;
  const assignments = solution.assignments
    .sort((left, right) => left.slot.slotIndex - right.slot.slotIndex)
    .map(({ slot, edge }) => {
      const ranked = edgesBySlot.get(slot.key) ?? [];
      const runnerUp = ranked.find((candidate) => candidate.rosterIndex !== edge.rosterIndex) ?? null;
      const classification = classifyAssignment(edge, runnerUp, thresholds);
      if (classification.canonicalCandidate) {
        canonicalCandidateCount += 1;
      } else {
        diagnosticOnlyCount += 1;
      }
      return {
        schemaKey: slot.schemaKey,
        familyKey,
        slotIndex: slot.slotIndex,
        rosterIndex: edge.rosterIndex,
        expectedParticipantId: edge.rosterIndex + 1,
        champion: edge.champion,
        team: edge.team,
        teamPosition: edge.teamPosition,
        score: edge.score,
        metricCount: edge.metricCount,
        distinctMetricCount: classification.distinctMetricCount,
        confidence: classification.confidence,
        canonicalCandidate: classification.canonicalCandidate,
        rank: classification.rank,
        rejectionReasons: classification.rejectionReasons,
        support: edge.support,
        winnerGap: classification.winnerGap,
        runnerUp: runnerUp
          ? {
              rosterIndex: runnerUp.rosterIndex,
              champion: runnerUp.champion,
              teamPosition: runnerUp.teamPosition,
              score: runnerUp.score,
              metricCount: runnerUp.metricCount,
            }
          : null,
      };
    });
  return {
    familyKey,
    candidateSlotCount: familyCandidates.length,
    edgeCount: familyEdges.length,
    assignmentCount: solution.assignments.length,
    canonicalCandidateCount,
    diagnosticOnlyCount,
    assignments,
  };
}

function assignReplay(artifactRoot, replayId, versionGroup, candidates, thresholds) {
  const artifactDir = path.join(artifactRoot, replayId);
  const summaryPath = path.join(artifactDir, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    return { replayId, versionGroup, skipped: true, reason: "missing-summary" };
  }
  const roster = buildSummaryRoster(readJson(summaryPath));
  const familyIndexes = readFamilyIndexes(artifactDir, candidates);
  const { edges, diagnostics } = buildEdges(roster, candidates, familyIndexes, thresholds);
  const familyKeys = uniqueSorted(candidates.map((candidate) => candidate.familyKey));
  const families = familyKeys.map((familyKey) => assignFamily(familyKey, candidates, edges, thresholds));
  const assignments = families.flatMap((family) => family.assignments ?? []);
  return {
    replayId,
    versionGroup,
    candidateSlotCount: candidates.length,
    edgeCount: edges.length,
    assignmentCount: assignments.length,
    canonicalCandidateCount: assignments.filter((assignment) => assignment.canonicalCandidate).length,
    diagnosticOnlyCount: assignments.filter((assignment) => !assignment.canonicalCandidate).length,
    diagnostics,
    families,
  };
}

function sumDiagnostics(rows) {
  const totals = {
    candidateSlotCount: 0,
    slotWithMetricValueCount: 0,
    slotMetricValueCount: 0,
    comparedMetricCount: 0,
    positiveMetricScoreCount: 0,
    supportBelowMetricCount: 0,
    scoreBelowThresholdCount: 0,
    maxCandidateScore: null,
    maxCandidateMetricCount: 0,
  };
  for (const row of rows) {
    const diagnostics = row.diagnostics ?? {};
    for (const key of [
      "candidateSlotCount",
      "slotWithMetricValueCount",
      "slotMetricValueCount",
      "comparedMetricCount",
      "positiveMetricScoreCount",
      "supportBelowMetricCount",
      "scoreBelowThresholdCount",
    ]) {
      totals[key] += diagnostics[key] ?? 0;
    }
    if (Number.isFinite(diagnostics.maxCandidateScore) && (totals.maxCandidateScore == null || diagnostics.maxCandidateScore > totals.maxCandidateScore)) {
      totals.maxCandidateScore = diagnostics.maxCandidateScore;
      totals.maxCandidateMetricCount = diagnostics.maxCandidateMetricCount ?? 0;
    }
  }
  return totals;
}

function sumAssignmentConfidence(rows) {
  const totals = {
    assignmentCount: 0,
    canonicalCandidateCount: 0,
    diagnosticOnlyCount: 0,
    belowDistinctMetricCount: 0,
    belowWinnerGapCount: 0,
  };
  for (const row of rows) {
    totals.assignmentCount += row.assignmentCount ?? 0;
    totals.canonicalCandidateCount += row.canonicalCandidateCount ?? 0;
    totals.diagnosticOnlyCount += row.diagnosticOnlyCount ?? 0;
    for (const family of row.families ?? []) {
      for (const assignment of family.assignments ?? []) {
        if ((assignment.rejectionReasons ?? []).includes("below-min-distinct-metric-count")) {
          totals.belowDistinctMetricCount += 1;
        }
        if ((assignment.rejectionReasons ?? []).includes("below-min-winner-gap")) {
          totals.belowWinnerGapCount += 1;
        }
      }
    }
  }
  return totals;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const schemaPath = args.schemaPath
    ? resolveAbsolute(repoRoot, args.schemaPath)
    : path.join(artifactRoot, "keyframe-parity-schema.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-rofl-stat-slot-assignments.json");

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Keyframe parity schema not found at ${schemaPath}.`);
  }

  const schema = readJson(schemaPath);
  const candidatesByVersion = schemaByVersion(schema);
  const replaySummaries = (schema.replaySummaries ?? [])
    .filter((replay) => !args.versionGroup || replay.versionGroup === args.versionGroup);
  const thresholds = {
    minMetricCount: args.minMetricCount,
    minScore: args.minScore,
    minDistinctMetricCount: args.minDistinctMetricCount,
    minWinnerGap: args.minWinnerGap,
  };
  const replays = replaySummaries.map((replay) => {
    const candidates = candidatesByVersion.get(replay.versionGroup) ?? [];
    if (!candidates.length) {
      return {
        replayId: replay.replayId,
        versionGroup: replay.versionGroup,
        skipped: true,
        reason: "no-promoted-state-slots-for-version",
      };
    }
    return assignReplay(artifactRoot, replay.replayId, replay.versionGroup, candidates, thresholds);
  });
  const analyzed = replays.filter((replay) => !replay.skipped);
  const output = {
    generatedAtUtc: new Date().toISOString(),
    sourceSchemaGeneratedAtUtc: schema.generatedAtUtc ?? null,
    versionGroup: args.versionGroup,
    thresholds,
    replayCount: replays.length,
    analyzedReplayCount: analyzed.length,
    skippedReplayCount: replays.length - analyzed.length,
    totals: {
      assignmentCount: analyzed.reduce((sum, replay) => sum + replay.assignmentCount, 0),
      edgeCount: analyzed.reduce((sum, replay) => sum + replay.edgeCount, 0),
      confidence: sumAssignmentConfidence(analyzed),
      diagnostics: sumDiagnostics(analyzed),
    },
    replays,
  };
  writeJson(outputPath, output);

  console.log(`Wrote replay-only keyframe stat assignments to ${outputPath}`);
  console.log(`analyzed replays: ${output.analyzedReplayCount}/${output.replayCount}`);
  console.log(`assignments: ${output.totals.assignmentCount}`);
  console.log(`edges: ${output.totals.edgeCount}`);
}

main();
