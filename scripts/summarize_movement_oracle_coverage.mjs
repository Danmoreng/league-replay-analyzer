#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    replayListPath: null,
    outputPath: null,
    movementFile: "extracted-movement.json",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-list-path" && index + 1 < argv.length) args.replayListPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--movement-file" && index + 1 < argv.length) args.movementFile = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/summarize_movement_oracle_coverage.mjs [--artifact-root artifacts] [--version-group 16.9] [--replay-list-path <path>] [--output-path <path>] [--movement-file extracted-movement.json]");
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

function buildHypothesisRows(movement) {
  const rows = [];
  for (const entity of movement.entities ?? []) {
    for (const hypothesis of entity.supportHypotheses ?? []) {
      rows.push({
        entityKey: entity.entityKey,
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        participantId: hypothesis.participantId ?? null,
        champion: hypothesis.champion ?? null,
        teamId: hypothesis.teamId ?? null,
        teamPosition: hypothesis.teamPosition ?? null,
        passesValidation: hypothesis.passesValidation === true,
        effectiveScore: hypothesis.effectiveScore ?? null,
        validatorScore: hypothesis.validatorScore ?? null,
        minAxisCorrelation: hypothesis.minAxisCorrelation ?? null,
        pathCorrelation: hypothesis.pathCorrelation ?? null,
        normalizedDistanceRmse: hypothesis.normalizedDistanceRmse ?? null,
      });
    }
  }
  return rows;
}

function bestHypothesisForParticipant(rows, participant) {
  const participantId = participantIdForRosterIndex(participant.rosterIndex);
  const matches = rows
    .filter((row) =>
      row.participantId === participantId ||
      (
        row.champion === participant.champion &&
        Number(row.teamId) === Number(participant.team) &&
        row.teamPosition === participant.teamPosition
      )
    )
    .sort((left, right) =>
      Number(right.passesValidation) - Number(left.passesValidation) ||
      (right.effectiveScore ?? 0) - (left.effectiveScore ?? 0) ||
      (right.validatorScore ?? 0) - (left.validatorScore ?? 0)
    );
  return matches[0] ?? null;
}

function classifyOracleFailure(best) {
  if (!best) {
    return ["no_candidate"];
  }
  const reasons = [];
  if ((best.minAxisCorrelation ?? 0) < 0.55) {
    reasons.push("axis_below_0.55");
  }
  if ((best.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY) > 0.18) {
    reasons.push("rmse_above_0.18");
  }
  if ((best.pathCorrelation ?? 0) < 0.15) {
    reasons.push("path_below_0.15");
  }
  return reasons.length ? reasons : ["candidate_failed_validation"];
}

function summarizeReplay(artifactRoot, replayId, movementFile) {
  const replayDir = path.join(artifactRoot, replayId);
  const movementPath = path.join(replayDir, movementFile);
  const statsPath = path.join(replayDir, "extracted-stats.json");
  if (!fs.existsSync(movementPath) || !fs.existsSync(statsPath)) {
    return {
      replayId,
      status: "missing",
      participants: [],
    };
  }

  const movement = readJson(movementPath);
  const stats = readJson(statsPath);
  const rows = buildHypothesisRows(movement);
  const participants = (stats.roster ?? [])
    .map((participant) => {
      const best = bestHypothesisForParticipant(rows, participant);
      return {
        rosterIndex: participant.rosterIndex,
        participantId: participantIdForRosterIndex(participant.rosterIndex),
        champion: participant.champion,
        team: participant.team,
        teamPosition: participant.teamPosition,
        hasOracleCandidate: best != null,
        hasPassingOracleCandidate: best?.passesValidation === true,
        oracleFailureReasons: best?.passesValidation === true ? [] : classifyOracleFailure(best),
        bestOracleCandidate: best,
      };
    });

  return {
    replayId,
    status: "present",
    runtimeInput: false,
    runtimeApiData: false,
    note: "Uses validation-derived supportHypotheses as an offline oracle only; do not promote as runtime replay-only identity.",
    hypothesisCount: rows.length,
    passingHypothesisCount: rows.filter((row) => row.passesValidation).length,
    participantCount: participants.length,
    oracleCandidateParticipantCount: participants.filter((participant) => participant.hasOracleCandidate).length,
    passingOracleParticipantCount: participants.filter((participant) => participant.hasPassingOracleCandidate).length,
    participants,
  };
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function incrementNested(map, outerKey, innerKey) {
  const inner = map.get(outerKey) ?? new Map();
  inner.set(innerKey, (inner.get(innerKey) ?? 0) + 1);
  map.set(outerKey, inner);
}

function mapToObject(map) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, value]) => [
        key,
        value instanceof Map ? mapToObject(value) : value,
      ]),
  );
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replayIds = discoverReplayIds(args);
  const replays = replayIds.map((replayId) => summarizeReplay(artifactRoot, replayId, args.movementFile));
  const presentReplays = replays.filter((replay) => replay.status === "present");
  const roleCoverage = new Map();
  const rolePassing = new Map();
  const oracleFailureReasons = new Map();
  const oracleFailureReasonsByRole = new Map();
  const oracleFailureFamilies = new Map();
  for (const replay of presentReplays) {
    for (const participant of replay.participants) {
      increment(roleCoverage, participant.teamPosition ?? "UNKNOWN");
      if (participant.hasPassingOracleCandidate) {
        increment(rolePassing, participant.teamPosition ?? "UNKNOWN");
      } else {
        for (const reason of participant.oracleFailureReasons ?? ["unknown"]) {
          increment(oracleFailureReasons, reason);
          incrementNested(oracleFailureReasonsByRole, participant.teamPosition ?? "UNKNOWN", reason);
        }
        increment(oracleFailureFamilies, participant.bestOracleCandidate?.familyKey ?? "none");
      }
    }
  }

  const expectedParticipantCount = presentReplays.reduce((sum, replay) => sum + replay.participantCount, 0);
  const passingOracleParticipantCount = presentReplays.reduce((sum, replay) => sum + replay.passingOracleParticipantCount, 0);
  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-oracle-coverage-summary/v1",
    versionGroup: args.versionGroup,
    artifactRoot,
    movementFile: args.movementFile,
    runtimeInput: false,
    runtimeApiData: false,
    note: "Offline oracle summary derived from extracted movement supportHypotheses. It measures candidate availability and must not be used for runtime participant identity.",
    replayCount: replays.length,
    presentReplayCount: presentReplays.length,
    missingReplayCount: replays.length - presentReplays.length,
    totals: {
      expectedParticipantCount,
      oracleCandidateParticipantCount: presentReplays.reduce((sum, replay) => sum + replay.oracleCandidateParticipantCount, 0),
      passingOracleParticipantCount,
      passRatePerExpectedParticipant: expectedParticipantCount ? passingOracleParticipantCount / expectedParticipantCount : null,
      completeOracleReplayCount: presentReplays.filter((replay) => replay.passingOracleParticipantCount === replay.participantCount).length,
      perfectOracleReplayCount: presentReplays.filter((replay) => replay.passingOracleParticipantCount === 10).length,
      passingOracleByRole: Object.fromEntries([...rolePassing.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)))),
      expectedByRole: Object.fromEntries([...roleCoverage.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)))),
      failingOracleParticipantCount: expectedParticipantCount - passingOracleParticipantCount,
      oracleFailureReasons: mapToObject(oracleFailureReasons),
      oracleFailureReasonsByRole: mapToObject(oracleFailureReasonsByRole),
      topFailingOracleFamilies: Object.fromEntries(
        [...oracleFailureFamilies.entries()]
          .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
          .slice(0, 10),
      ),
    },
    replays,
  };

  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-oracle-coverage-summary-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement oracle coverage summary to ${outputPath}`);
  console.log(`oracle passing participants=${passingOracleParticipantCount}/${expectedParticipantCount}, complete=${output.totals.completeOracleReplayCount}`);
}

main();
