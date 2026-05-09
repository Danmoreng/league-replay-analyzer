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
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-list-path" && index + 1 < argv.length) args.replayListPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/summarize_movement_candidate_failure_sources.mjs [--artifact-root artifacts] [--version-group 16.9] [--replay-list-path <path>] [--output-path <path>]");
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

function classifyFailure(match) {
  if (!match) return ["no_candidate"];
  const reasons = [];
  if ((match.minAxisCorrelation ?? Math.min(match.xCorrelation ?? 0, match.yCorrelation ?? 0)) < 0.55) reasons.push("axis_below_0.55");
  if ((match.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY) > 0.18) reasons.push("rmse_above_0.18");
  if ((match.pathCorrelation ?? 0) < 0.15) reasons.push("path_below_0.15");
  return reasons.length ? reasons : ["candidate_failed_validation"];
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function incrementNested(map, outerKey, innerKey) {
  const inner = map.get(outerKey) ?? new Map();
  increment(inner, innerKey);
  map.set(outerKey, inner);
}

function mapToObject(map) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, value]) => [key, value instanceof Map ? mapToObject(value) : value]),
  );
}

function bestMatchesByParticipant(candidateMatches) {
  const byParticipant = new Map();
  for (const match of candidateMatches.topMatches ?? []) {
    const current = byParticipant.get(match.participantId);
    if (!current || (match.effectiveScore ?? 0) > (current.effectiveScore ?? 0)) {
      byParticipant.set(match.participantId, match);
    }
  }
  return byParticipant;
}

function summarizeReplay(artifactRoot, replayId) {
  const candidateMatchesPath = path.join(artifactRoot, replayId, "movement-candidate-matches.json");
  if (!fs.existsSync(candidateMatchesPath)) {
    return { replayId, status: "missing" };
  }
  const candidateMatches = readJson(candidateMatchesPath);
  const byParticipant = bestMatchesByParticipant(candidateMatches);
  const participants = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const match = byParticipant.get(participantId) ?? null;
    participants.push({
      participantId,
      champion: match?.champion ?? null,
      teamId: match?.teamId ?? null,
      teamPosition: match?.teamPosition ?? null,
      hasCandidate: match != null,
      passesValidation: match?.passesValidation === true,
      failureReasons: match?.passesValidation === true ? [] : classifyFailure(match),
      familyKey: match?.familyKey ?? null,
      slotIndex: match?.slotIndex ?? null,
      coordinateModelSource: match?.coordinateModelSource ?? "none",
      coordinateModelSupport: match?.coordinateModelSupport ?? 0,
      coordinateModelReplaySupport: match?.coordinateModelReplaySupport ?? 0,
      coordinateModelScore: match?.coordinateModelScore ?? null,
      minAxisCorrelation: match?.minAxisCorrelation ?? Math.min(match?.xCorrelation ?? 0, match?.yCorrelation ?? 0),
      pathCorrelation: match?.pathCorrelation ?? null,
      normalizedDistanceRmse: match?.normalizedDistanceRmse ?? null,
      effectiveScore: match?.effectiveScore ?? null,
    });
  }
  return {
    replayId,
    status: "present",
    participantCount: participants.length,
    candidateParticipantCount: participants.filter((participant) => participant.hasCandidate).length,
    passingParticipantCount: participants.filter((participant) => participant.passesValidation).length,
    participants,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replays = discoverReplayIds(args).map((replayId) => summarizeReplay(artifactRoot, replayId));
  const presentReplays = replays.filter((replay) => replay.status === "present");
  const failureByModelSource = new Map();
  const failureByFamily = new Map();
  const failureReasonByModelSource = new Map();
  const failureReasonByFamily = new Map();
  let expectedParticipantCount = 0;
  let passingParticipantCount = 0;
  for (const replay of presentReplays) {
    expectedParticipantCount += replay.participantCount;
    passingParticipantCount += replay.passingParticipantCount;
    for (const participant of replay.participants) {
      if (participant.passesValidation) continue;
      const source = participant.coordinateModelSource ?? "none";
      const family = participant.familyKey ?? "none";
      increment(failureByModelSource, source);
      increment(failureByFamily, family);
      for (const reason of participant.failureReasons ?? ["unknown"]) {
        incrementNested(failureReasonByModelSource, source, reason);
        incrementNested(failureReasonByFamily, family, reason);
      }
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-candidate-failure-sources/v1",
    versionGroup: args.versionGroup,
    artifactRoot,
    runtimeInput: false,
    runtimeApiData: false,
    note: "Offline diagnostic over movement-candidate-matches.json. Uses Riot fixture validation labels and must not be used for runtime identity.",
    replayCount: replays.length,
    presentReplayCount: presentReplays.length,
    totals: {
      expectedParticipantCount,
      passingParticipantCount,
      failingParticipantCount: expectedParticipantCount - passingParticipantCount,
      failureByModelSource: mapToObject(failureByModelSource),
      failureReasonByModelSource: mapToObject(failureReasonByModelSource),
      topFailureFamilies: Object.fromEntries([...failureByFamily.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))).slice(0, 12)),
      failureReasonByFamily: mapToObject(failureReasonByFamily),
    },
    replays,
  };
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-candidate-failure-sources-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement candidate failure sources to ${outputPath}`);
  console.log(`candidate-match passing participants=${passingParticipantCount}/${expectedParticipantCount}`);
}

main();
