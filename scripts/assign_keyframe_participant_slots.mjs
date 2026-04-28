import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";
import { enrichParticipantSlotEvidence } from "./lib/keyframe-slot-scoring.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    parityReportPath: null,
    schemaPath: null,
    outputPath: null,
    minMetricCount: 1,
    minEdgeIdentityWeight: 2.4,
    minEdgeWeightedScore: 1.5,
    minWinnerGap: 0.35,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--parity-report" && index + 1 < argv.length) {
      args.parityReportPath = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--min-metric-count" && index + 1 < argv.length) {
      args.minMetricCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-edge-identity-weight" && index + 1 < argv.length) {
      args.minEdgeIdentityWeight = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-edge-weighted-score" && index + 1 < argv.length) {
      args.minEdgeWeightedScore = Number.parseFloat(argv[++index]);
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
  console.log("Usage: node ./scripts/assign_keyframe_participant_slots.mjs [--artifact-root <path>] [--parity-report <path>] [--schema-path <path>] [--output-path <path>]");
}

function uniqueSorted(values) {
  return [...new Set(values.filter((value) => value != null))].sort((left, right) => {
    if (typeof left === "number" && typeof right === "number") {
      return left - right;
    }
    return String(left).localeCompare(String(right));
  });
}

function stateCandidateIndex(schema) {
  const byVersion = new Map();
  for (const candidate of schema.promotedParticipantStateSlotCandidates ?? []) {
    const list = byVersion.get(candidate.versionGroup) ?? [];
    list.push(candidate);
    byVersion.set(candidate.versionGroup, list);
  }
  return byVersion;
}

function buildReplayEdges(replay, stateCandidates, thresholds) {
  const allowedKeys = new Set(stateCandidates.map((candidate) => `${candidate.familyKey}|${candidate.slotIndex}`));
  return (replay.participantSlotEvidence ?? [])
    .filter((entry) => allowedKeys.has(`${entry.familyKey}|${entry.slotIndex}`))
    .map(enrichParticipantSlotEvidence)
    .map((entry) => ({
      replayId: replay.replayId,
      versionGroup: replay.versionGroup,
      familyKey: entry.familyKey,
      slotIndex: entry.slotIndex,
      participantId: entry.participantId,
      champion: entry.champion,
      teamId: entry.teamId,
      teamPosition: entry.teamPosition,
      metricCount: entry.metricCount,
      metrics: entry.metrics,
      identityWeight: entry.identityWeight,
      identityMetricCount: entry.identityMetricCount,
      genericMetricCount: entry.genericMetricCount,
      weightedSupportScore: entry.weightedSupportScore,
      avgCorrelation: entry.avgCorrelation,
      avgNormalizedRmse: entry.avgNormalizedRmse,
      bestScore: entry.bestScore,
      passesEdgeGate:
        (entry.metricCount ?? 0) >= thresholds.minMetricCount &&
        (entry.identityWeight ?? 0) >= thresholds.minEdgeIdentityWeight &&
        (entry.weightedSupportScore ?? 0) >= thresholds.minEdgeWeightedScore,
    }));
}

function edgeScore(edge) {
  const fitScore = Math.max(0, (edge.avgCorrelation ?? 0) - ((edge.avgNormalizedRmse ?? 0) * 0.35));
  return edge.weightedSupportScore + (edge.identityWeight * 0.2) + fitScore;
}

function edgeRankBySlot(edges) {
  const bySlot = new Map();
  for (const edge of edges) {
    const key = `${edge.familyKey}|${edge.slotIndex}`;
    const list = bySlot.get(key) ?? [];
    list.push(edge);
    bySlot.set(key, list);
  }

  const ranked = new Map();
  for (const [slotKey, list] of bySlot) {
    const sorted = [...list].sort((left, right) =>
      edgeScore(right) - edgeScore(left) ||
      right.weightedSupportScore - left.weightedSupportScore ||
      right.identityWeight - left.identityWeight ||
      right.metricCount - left.metricCount ||
      left.participantId - right.participantId,
    );
    ranked.set(slotKey, sorted);
  }
  return ranked;
}

function solveOneToOne(slots, participants, edgesBySlotParticipant) {
  const participantOffset = new Map(participants.map((participantId, index) => [participantId, index]));
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
    const slotEdges = edgesBySlotParticipant.get(slot.key) ?? [];

    for (const edge of slotEdges) {
      const offset = participantOffset.get(edge.participantId);
      if (offset == null) {
        continue;
      }
      const bit = 1 << offset;
      if ((usedMask & bit) !== 0) {
        continue;
      }
      const suffix = search(slotOffset + 1, usedMask | bit);
      const candidate = {
        score: edgeScore(edge) + suffix.score,
        assignments: [{ slot, edge }, ...suffix.assignments],
      };
      if (
        candidate.score > best.score ||
        (candidate.score === best.score && candidate.assignments.length > best.assignments.length)
      ) {
        best = candidate;
      }
    }

    memo.set(key, best);
    return best;
  }

  return search(0, 0);
}

function assignFamily(replay, familyKey, stateCandidates, edges, thresholds) {
  const familyCandidates = stateCandidates
    .filter((candidate) => candidate.familyKey === familyKey)
    .sort((left, right) => left.slotIndex - right.slotIndex);
  const familyEdges = edges.filter((edge) => edge.familyKey === familyKey);
  const gatedEdges = familyEdges.filter((edge) => edge.passesEdgeGate);
  const rankedBySlot = edgeRankBySlot(familyEdges);
  const edgesBySlotParticipant = new Map();

  for (const edge of gatedEdges) {
    const slotKey = `${edge.familyKey}|${edge.slotIndex}`;
    const list = edgesBySlotParticipant.get(slotKey) ?? [];
    list.push(edge);
    edgesBySlotParticipant.set(slotKey, list);
  }

  for (const [slotKey, list] of edgesBySlotParticipant) {
    list.sort((left, right) => edgeScore(right) - edgeScore(left));
    edgesBySlotParticipant.set(slotKey, list);
  }

  const slots = familyCandidates.map((candidate) => ({
    key: `${candidate.familyKey}|${candidate.slotIndex}`,
    schemaKey: candidate.key,
    familyKey: candidate.familyKey,
    slotIndex: candidate.slotIndex,
    stateSupportReplayCount: candidate.supportReplayCount,
    identitySupportReplayCount: candidate.unambiguousSupportReplayCount,
  }));
  const participants = uniqueSorted(gatedEdges.map((edge) => edge.participantId));
  const solution = solveOneToOne(slots, participants, edgesBySlotParticipant);
  const assignedSlotKeys = new Set(solution.assignments.map((assignment) => assignment.slot.key));
  const assignedParticipantIds = new Set(solution.assignments.map((assignment) => assignment.edge.participantId));

  const assignments = solution.assignments
    .sort((left, right) => left.slot.slotIndex - right.slot.slotIndex)
    .map(({ slot, edge }) => {
      const ranked = rankedBySlot.get(slot.key) ?? [];
      const rank = ranked.findIndex((candidate) => candidate.participantId === edge.participantId) + 1;
      const runnerUp = ranked.find((candidate) => candidate.participantId !== edge.participantId) ?? null;
      const score = edgeScore(edge);
      const runnerUpScore = runnerUp ? edgeScore(runnerUp) : null;
      const winnerGap = runnerUpScore == null ? null : score - runnerUpScore;
      return {
        schemaKey: slot.schemaKey,
        familyKey: slot.familyKey,
        slotIndex: slot.slotIndex,
        participantId: edge.participantId,
        champion: edge.champion,
        teamId: edge.teamId,
        teamPosition: edge.teamPosition,
        score,
        rank,
        winnerGap,
        stable: rank === 1 && (winnerGap == null || winnerGap >= thresholds.minWinnerGap),
        metricCount: edge.metricCount,
        metrics: edge.metrics,
        identityWeight: edge.identityWeight,
        identityMetricCount: edge.identityMetricCount,
        genericMetricCount: edge.genericMetricCount,
        weightedSupportScore: edge.weightedSupportScore,
        avgCorrelation: edge.avgCorrelation,
        avgNormalizedRmse: edge.avgNormalizedRmse,
        bestScore: edge.bestScore,
        runnerUp: runnerUp
          ? {
              participantId: runnerUp.participantId,
              champion: runnerUp.champion,
              teamPosition: runnerUp.teamPosition,
              score: runnerUpScore,
              identityWeight: runnerUp.identityWeight,
              weightedSupportScore: runnerUp.weightedSupportScore,
              metricCount: runnerUp.metricCount,
            }
          : null,
      };
    });

  return {
    familyKey,
    candidateSlotCount: slots.length,
    edgeCount: familyEdges.length,
    gatedEdgeCount: gatedEdges.length,
    participantCount: participants.length,
    assignmentCount: assignments.length,
    stableAssignmentCount: assignments.filter((assignment) => assignment.stable).length,
    assignedParticipantIds: uniqueSorted([...assignedParticipantIds]),
    assignments,
    unresolvedSlots: slots
      .filter((slot) => !assignedSlotKeys.has(slot.key))
      .map((slot) => {
        const ranked = rankedBySlot.get(slot.key) ?? [];
        return {
          schemaKey: slot.schemaKey,
          familyKey: slot.familyKey,
          slotIndex: slot.slotIndex,
          candidateCount: ranked.length,
          gatedCandidateCount: ranked.filter((edge) => edge.passesEdgeGate).length,
          topCandidates: ranked.slice(0, 5).map((edge) => ({
            participantId: edge.participantId,
            champion: edge.champion,
            teamPosition: edge.teamPosition,
            score: edgeScore(edge),
            passesEdgeGate: edge.passesEdgeGate,
            identityWeight: edge.identityWeight,
            weightedSupportScore: edge.weightedSupportScore,
            metricCount: edge.metricCount,
            metrics: edge.metrics,
          })),
        };
      }),
  };
}

function assignReplay(replay, stateCandidates, thresholds) {
  const edges = buildReplayEdges(replay, stateCandidates, thresholds);
  const familyKeys = uniqueSorted(stateCandidates.map((candidate) => candidate.familyKey));
  const families = familyKeys.map((familyKey) => assignFamily(replay, familyKey, stateCandidates, edges, thresholds));
  const assignmentCount = families.reduce((sum, family) => sum + family.assignmentCount, 0);
  const stableAssignmentCount = families.reduce((sum, family) => sum + family.stableAssignmentCount, 0);
  return {
    replayId: replay.replayId,
    versionGroup: replay.versionGroup,
    gameVersion: replay.gameVersion,
    candidateStateSlotCount: stateCandidates.length,
    edgeCount: edges.length,
    gatedEdgeCount: edges.filter((edge) => edge.passesEdgeGate).length,
    assignmentCount,
    stableAssignmentCount,
    families,
  };
}

function buildAssignments(report, schema, thresholds) {
  const candidatesByVersion = stateCandidateIndex(schema);
  const replays = [];

  for (const replay of report.replays ?? []) {
    if (replay.skipped) {
      continue;
    }
    const stateCandidates = candidatesByVersion.get(replay.versionGroup) ?? [];
    if (!stateCandidates.length) {
      replays.push({
        replayId: replay.replayId,
        versionGroup: replay.versionGroup,
        gameVersion: replay.gameVersion,
        skipped: true,
        reason: "no-promoted-state-slots-for-version",
      });
      continue;
    }
    replays.push(assignReplay(replay, stateCandidates, thresholds));
  }

  const analyzedReplays = replays.filter((replay) => !replay.skipped);
  return {
    generatedAtUtc: new Date().toISOString(),
    sourceReportGeneratedAtUtc: report.generatedAtUtc ?? null,
    sourceSchemaGeneratedAtUtc: schema.generatedAtUtc ?? null,
    thresholds,
    replayCount: replays.length,
    analyzedReplayCount: analyzedReplays.length,
    skippedReplayCount: replays.length - analyzedReplays.length,
    totals: {
      candidateStateSlotCount: analyzedReplays.reduce((sum, replay) => sum + replay.candidateStateSlotCount, 0),
      edgeCount: analyzedReplays.reduce((sum, replay) => sum + replay.edgeCount, 0),
      gatedEdgeCount: analyzedReplays.reduce((sum, replay) => sum + replay.gatedEdgeCount, 0),
      assignmentCount: analyzedReplays.reduce((sum, replay) => sum + replay.assignmentCount, 0),
      stableAssignmentCount: analyzedReplays.reduce((sum, replay) => sum + replay.stableAssignmentCount, 0),
    },
    replays,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const parityReportPath = args.parityReportPath
    ? resolveAbsolute(repoRoot, args.parityReportPath)
    : path.join(artifactRoot, "keyframe-api-parity.json");
  const schemaPath = args.schemaPath
    ? resolveAbsolute(repoRoot, args.schemaPath)
    : path.join(artifactRoot, "keyframe-parity-schema.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-slot-assignments.json");

  if (!fs.existsSync(parityReportPath)) {
    throw new Error(`Keyframe parity report not found at ${parityReportPath}.`);
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Keyframe parity schema not found at ${schemaPath}.`);
  }

  const report = readJson(parityReportPath);
  const schema = readJson(schemaPath);
  const thresholds = {
    minMetricCount: args.minMetricCount,
    minEdgeIdentityWeight: args.minEdgeIdentityWeight,
    minEdgeWeightedScore: args.minEdgeWeightedScore,
    minWinnerGap: args.minWinnerGap,
  };
  const assignments = buildAssignments(report, schema, thresholds);
  writeJson(outputPath, assignments);

  console.log(`Wrote keyframe slot assignments to ${outputPath}`);
  console.log(`analyzed replays: ${assignments.analyzedReplayCount}/${assignments.replayCount}`);
  console.log(`assignments: ${assignments.totals.assignmentCount}`);
  console.log(`stable assignments: ${assignments.totals.stableAssignmentCount}`);
}

main();
