#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    replayListPath: null,
    movementFile: "extracted-movement-max50-supplemented.json",
    assignmentFile: "participant-movement-strict-min0.44-max50-supplemented-probe.json",
    validationFile: "assigned-movement-strict-min0.44-max50-supplemented-probe-validation-report.json",
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-list-path" && index + 1 < argv.length) args.replayListPath = argv[++index];
    else if (arg === "--movement-file" && index + 1 < argv.length) args.movementFile = argv[++index];
    else if (arg === "--assignment-file" && index + 1 < argv.length) args.assignmentFile = argv[++index];
    else if (arg === "--validation-file" && index + 1 < argv.length) args.validationFile = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/summarize_movement_assignment_oracle_gap.mjs [--artifact-root artifacts] [--version-group 16.9] [--movement-file extracted-movement-max50-supplemented.json] [--assignment-file participant-movement-strict-min0.44-max50-supplemented-probe.json] [--validation-file assigned-movement-strict-min0.44-max50-supplemented-probe-validation-report.json] [--output-path <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function replayListPathForVersion(versionGroup) {
  return path.join("artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
}

function discoverReplayIds(args) {
  const replayListPath = resolveAbsolute(process.cwd(), args.replayListPath ?? replayListPathForVersion(args.versionGroup));
  if (fs.existsSync(replayListPath)) {
    const replayList = readJson(replayListPath);
    return (replayList.replays ?? [])
      .filter((replay) => !replay.skipped)
      .map((replay) => replay.replayId)
      .filter(Boolean)
      .sort();
  }
  const artifactRoot = resolveAbsolute(process.cwd(), args.artifactRoot);
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function participantIdForRosterIndex(rosterIndex) {
  return Number.isInteger(rosterIndex) ? rosterIndex + 1 : null;
}

function compactEntityKey(entityKey) {
  return String(entityKey ?? "").split("|").slice(0, 5).join("|");
}

function findOracleAlternative(participant, assignment, oracle) {
  if (!oracle) {
    return null;
  }
  const oracleKey = oracle.compactEntityKey;
  if (assignment) {
    if (compactEntityKey(assignment.entityKey) === oracleKey) {
      return {
        rank: 1,
        score: assignment.score ?? null,
      };
    }
    const alternatives = assignment.assignmentConfidence?.topEntityAlternatives ?? [];
    const index = alternatives.findIndex((candidate) => compactEntityKey(candidate.entityKey) === oracleKey);
    return index >= 0
      ? {
          rank: index + 2,
          score: alternatives[index].score ?? null,
        }
      : null;
  }
  const rejected = participant.topRejectedEntityCandidates ?? [];
  const index = rejected.findIndex((candidate) => compactEntityKey(candidate.entityKey) === oracleKey);
  return index >= 0
    ? {
        rank: index + 1,
        score: rejected[index].score ?? null,
      }
    : null;
}

function rankBucket(rank) {
  if (rank == null) return "outside_recorded_alternatives";
  if (rank === 1) return "rank_1";
  if (rank <= 3) return "rank_2_to_3";
  if (rank <= 5) return "rank_4_to_5";
  if (rank <= 10) return "rank_6_to_10";
  if (rank <= 32) return "rank_11_to_32";
  if (rank <= 64) return "rank_33_to_64";
  return "rank_65_plus";
}

function buildScalarSlotsByFamily(participant) {
  const byFamily = new Map();
  for (const metric of Object.values(participant?.metrics ?? {})) {
    if (!metric.familyKey || !Number.isInteger(metric.slotIndex)) continue;
    const slots = byFamily.get(metric.familyKey) ?? [];
    slots.push(metric.slotIndex);
    byFamily.set(metric.familyKey, slots);
  }
  return byFamily;
}

function nearestScalarSlotDistance(slotsByFamily, entityKey) {
  const parts = String(entityKey ?? "").split("|");
  const familyKey = parts[0];
  const slotIndex = Number(parts[1]);
  if (!familyKey || !Number.isFinite(slotIndex)) return null;
  const slots = slotsByFamily.get(familyKey) ?? [];
  if (!slots.length) return null;
  return Math.min(...slots.map((slot) => Math.abs(slot - slotIndex)));
}

function scalarProximityBucket(assignedDistance, oracleDistance) {
  if (assignedDistance == null && oracleDistance == null) return "neither_family_has_scalar_slot";
  if (oracleDistance != null && (assignedDistance == null || oracleDistance < assignedDistance)) return "oracle_family_closer_to_scalar_slot";
  if (assignedDistance != null && (oracleDistance == null || assignedDistance < oracleDistance)) return "assigned_family_closer_to_scalar_slot";
  return "equal_scalar_slot_distance";
}

function scoreGapBucket(gap) {
  if (!Number.isFinite(gap)) return "unknown";
  if (gap <= 0.01) return "gap_0_to_0.01";
  if (gap <= 0.03) return "gap_0.01_to_0.03";
  if (gap <= 0.06) return "gap_0.03_to_0.06";
  if (gap <= 0.1) return "gap_0.06_to_0.10";
  return "gap_gt_0.10";
}

function bestOracleByParticipant(movement) {
  const byParticipant = new Map();
  for (const entity of movement.entities ?? []) {
    for (const hypothesis of entity.supportHypotheses ?? []) {
      const participantId = hypothesis.participantId;
      if (!participantId) continue;
      const row = {
        entityKey: entity.entityKey,
        compactEntityKey: compactEntityKey(entity.entityKey),
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        participantId,
        passesValidation: hypothesis.passesValidation === true,
        effectiveScore: hypothesis.effectiveScore ?? 0,
        validatorScore: hypothesis.validatorScore ?? 0,
        minAxisCorrelation: hypothesis.minAxisCorrelation ?? 0,
        pathCorrelation: hypothesis.pathCorrelation ?? 0,
        normalizedDistanceRmse: hypothesis.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY,
      };
      const current = byParticipant.get(participantId);
      if (
        !current ||
        Number(row.passesValidation) > Number(current.passesValidation) ||
        (
          row.passesValidation === current.passesValidation &&
          (
            row.effectiveScore > current.effectiveScore ||
            (row.effectiveScore === current.effectiveScore && row.validatorScore > current.validatorScore)
          )
        )
      ) {
        byParticipant.set(participantId, row);
      }
    }
  }
  return byParticipant;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function entityFamily(entityKey) {
  return String(entityKey ?? "").split("|")[0] || "none";
}

function entityGroup(entityKey) {
  const parts = String(entityKey ?? "").split("|");
  return parts.length >= 2 ? parts.slice(0, 2).join("|") : "none";
}

function mapToSortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))));
}

function addNumeric(stats, key, value) {
  if (!Number.isFinite(value)) return;
  const current = stats.get(key) ?? {
    count: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
  };
  current.count += 1;
  current.sum += value;
  current.min = Math.min(current.min, value);
  current.max = Math.max(current.max, value);
  stats.set(key, current);
}

function numericStatsToObject(stats) {
  return Object.fromEntries([...stats.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, {
      count: value.count,
      average: value.count ? value.sum / value.count : null,
      min: value.min,
      max: value.max,
    }]));
}

function classifyParticipant({ participant, assignment, validation, oracle }) {
  if (validation?.validation?.passes === true) return "assigned_passes";
  if (!oracle) return "no_oracle_candidate";
  if (!oracle.passesValidation) return "oracle_candidate_fails_validation";
  if (!assignment) return "passing_oracle_unassigned";
  if (compactEntityKey(assignment.entityKey) === oracle.compactEntityKey) return "assigned_oracle_entity_but_failed";
  return "passing_oracle_available_wrong_entity_assigned";
}

function summarizeReplay(artifactRoot, replayId, args) {
  const replayDir = path.join(artifactRoot, replayId);
  const movementPath = path.join(replayDir, args.movementFile);
  const assignmentPath = path.join(replayDir, args.assignmentFile);
  const validationPath = path.join(replayDir, args.validationFile);
  const statsPath = path.join(replayDir, "extracted-stats.json");
  if (!fs.existsSync(movementPath) || !fs.existsSync(assignmentPath) || !fs.existsSync(validationPath) || !fs.existsSync(statsPath)) {
    return { replayId, status: "missing" };
  }

  const movement = readJson(movementPath);
  const assignmentArtifact = readJson(assignmentPath);
  const validationReport = readJson(validationPath);
  const stats = readJson(statsPath);
  const oracleByParticipant = bestOracleByParticipant(movement);
  const assignmentByRoster = new Map((assignmentArtifact.assignments ?? []).map((assignment) => [assignment.rosterIndex, assignment]));
  const unmatchedByRoster = new Map((assignmentArtifact.unmatchedParticipants ?? []).map((participant) => [participant.rosterIndex, participant]));
  const validationByRoster = new Map((validationReport.assignments ?? []).map((assignment) => [assignment.rosterIndex, assignment]));
  const participants = (stats.roster ?? []).map((participant) => {
    const extractedParticipant = (stats.participants ?? []).find((entry) => entry.rosterIndex === participant.rosterIndex);
    const scalarSlotsByFamily = buildScalarSlotsByFamily(extractedParticipant);
    const participantId = participantIdForRosterIndex(participant.rosterIndex);
    const assignment = assignmentByRoster.get(participant.rosterIndex) ?? null;
    const unmatched = unmatchedByRoster.get(participant.rosterIndex) ?? null;
    const validation = validationByRoster.get(participant.rosterIndex) ?? null;
    const oracle = oracleByParticipant.get(participantId) ?? null;
    const oracleAlternative = findOracleAlternative(unmatched ?? participant, assignment, oracle);
    const oracleReplayOnlyScoreGap = Number.isFinite(assignment?.score) && Number.isFinite(oracleAlternative?.score)
      ? assignment.score - oracleAlternative.score
      : null;
    return {
      rosterIndex: participant.rosterIndex,
      participantId,
      champion: participant.champion,
      team: participant.team,
      teamPosition: participant.teamPosition,
      status: classifyParticipant({ participant, assignment, validation, oracle }),
      assignedEntityKey: assignment?.entityKey ?? null,
      assignedScore: assignment?.score ?? null,
      assignedScoreComponents: assignment?.scoreComponents
        ? {
            entityQuality: assignment.scoreComponents.entityQuality ?? null,
            teamScore: assignment.scoreComponents.teamScore ?? null,
            roleScore: assignment.scoreComponents.roleScore ?? null,
            scalarFamilyScore: assignment.scoreComponents.scalarFamilyScore ?? null,
            trajectoryScore: assignment.scoreComponents.trajectoryScore ?? null,
            minAxisScore: assignment.scoreComponents.minAxisScore ?? null,
            rangeScore: assignment.scoreComponents.rangeScore ?? null,
            evidenceGate: assignment.scoreComponents.evidenceGate ?? null,
          }
        : null,
      assignedPassesValidation: validation?.validation?.passes === true,
      oracleEntityKey: oracle?.entityKey ?? null,
      oraclePassesValidation: oracle?.passesValidation === true,
      oracleEffectiveScore: oracle?.effectiveScore ?? null,
      oracleReplayOnlyRank: oracleAlternative?.rank ?? null,
      oracleReplayOnlyScore: oracleAlternative?.score ?? null,
      oracleReplayOnlyScoreGap,
      scalarProximity: {
        assignedDistance: nearestScalarSlotDistance(scalarSlotsByFamily, assignment?.entityKey),
        oracleDistance: nearestScalarSlotDistance(scalarSlotsByFamily, oracle?.entityKey),
      },
      assignmentConfidence: assignment?.assignmentConfidence ?? null,
    };
  });

  return {
    replayId,
    status: "present",
    participantCount: participants.length,
    assignedCount: participants.filter((participant) => participant.assignedEntityKey).length,
    passingAssignedCount: participants.filter((participant) => participant.assignedPassesValidation).length,
    passingOracleCount: participants.filter((participant) => participant.oraclePassesValidation).length,
    participants,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replays = discoverReplayIds(args).map((replayId) => summarizeReplay(artifactRoot, replayId, args));
  const presentReplays = replays.filter((replay) => replay.status === "present");
  const statusCounts = new Map();
  const statusByRole = new Map();
  const wrongEntityFamilyPairs = new Map();
  const wrongEntityByRole = new Map();
  const wrongEntityShapeCounts = new Map();
  const wrongEntityOracleRankBuckets = new Map();
  const unassignedOracleRankBuckets = new Map();
  const wrongEntityOracleScoreGapBuckets = new Map();
  const wrongEntityScalarProximityBuckets = new Map();
  const assignedPassComponentStats = new Map();
  const wrongEntityComponentStats = new Map();
  for (const replay of presentReplays) {
    for (const participant of replay.participants) {
      increment(statusCounts, participant.status);
      const roleMap = statusByRole.get(participant.teamPosition ?? "UNKNOWN") ?? new Map();
      increment(roleMap, participant.status);
      statusByRole.set(participant.teamPosition ?? "UNKNOWN", roleMap);
      if (participant.status === "passing_oracle_available_wrong_entity_assigned") {
        for (const [key, value] of Object.entries(participant.assignedScoreComponents ?? {})) {
          addNumeric(wrongEntityComponentStats, key, value);
        }
        const assignedFamily = entityFamily(participant.assignedEntityKey);
        const oracleFamily = entityFamily(participant.oracleEntityKey);
        increment(wrongEntityFamilyPairs, `${assignedFamily} -> ${oracleFamily}`);
        increment(wrongEntityByRole, participant.teamPosition ?? "UNKNOWN");
        if (assignedFamily === oracleFamily) {
          increment(wrongEntityShapeCounts, entityGroup(participant.assignedEntityKey) === entityGroup(participant.oracleEntityKey)
            ? "same_family_slot_group"
            : "same_family_different_slot");
        } else {
          increment(wrongEntityShapeCounts, "different_family");
        }
        increment(wrongEntityOracleRankBuckets, rankBucket(participant.oracleReplayOnlyRank));
        increment(wrongEntityOracleScoreGapBuckets, scoreGapBucket(participant.oracleReplayOnlyScoreGap));
        increment(wrongEntityScalarProximityBuckets, scalarProximityBucket(
          participant.scalarProximity?.assignedDistance,
          participant.scalarProximity?.oracleDistance,
        ));
      } else if (participant.status === "passing_oracle_unassigned") {
        increment(unassignedOracleRankBuckets, rankBucket(participant.oracleReplayOnlyRank));
      } else if (participant.status === "assigned_passes") {
        for (const [key, value] of Object.entries(participant.assignedScoreComponents ?? {})) {
          addNumeric(assignedPassComponentStats, key, value);
        }
      }
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-assignment-oracle-gap-summary/v1",
    versionGroup: args.versionGroup,
    artifactRoot,
    movementFile: args.movementFile,
    assignmentFile: args.assignmentFile,
    validationFile: args.validationFile,
    runtimeInput: false,
    runtimeApiData: false,
    note: "Offline diagnostic that compares replay-only assignments against validation-labelled movement oracle candidates; do not use as runtime identity input.",
    replayCount: replays.length,
    presentReplayCount: presentReplays.length,
    totals: {
      expectedParticipantCount: presentReplays.reduce((sum, replay) => sum + replay.participantCount, 0),
      assignedCount: presentReplays.reduce((sum, replay) => sum + replay.assignedCount, 0),
      passingAssignedCount: presentReplays.reduce((sum, replay) => sum + replay.passingAssignedCount, 0),
      passingOracleCount: presentReplays.reduce((sum, replay) => sum + replay.passingOracleCount, 0),
      statusCounts: mapToSortedObject(statusCounts),
      statusByRole: Object.fromEntries([...statusByRole.entries()]
        .sort(([left], [right]) => String(left).localeCompare(String(right)))
        .map(([role, counts]) => [role, mapToSortedObject(counts)])),
      wrongEntityBreakdown: {
        shapeCounts: mapToSortedObject(wrongEntityShapeCounts),
        byRole: mapToSortedObject(wrongEntityByRole),
        oracleReplayOnlyRankBuckets: mapToSortedObject(wrongEntityOracleRankBuckets),
        unassignedOracleReplayOnlyRankBuckets: mapToSortedObject(unassignedOracleRankBuckets),
        oracleReplayOnlyScoreGapBuckets: mapToSortedObject(wrongEntityOracleScoreGapBuckets),
        scalarProximityBuckets: mapToSortedObject(wrongEntityScalarProximityBuckets),
        assignedPassScoreComponents: numericStatsToObject(assignedPassComponentStats),
        wrongEntityScoreComponents: numericStatsToObject(wrongEntityComponentStats),
        topAssignedToOracleFamilyPairs: Object.fromEntries([...wrongEntityFamilyPairs.entries()]
          .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
          .slice(0, 12)),
      },
    },
    replays,
  };
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-assignment-oracle-gap-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement assignment/oracle gap summary to ${outputPath}`);
  console.log(`wrong-entity assignments=${output.totals.statusCounts.passing_oracle_available_wrong_entity_assigned ?? 0}`);
}

main();
