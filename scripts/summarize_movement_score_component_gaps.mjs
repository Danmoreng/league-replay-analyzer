#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

const componentKeys = [
  "teamScore",
  "roleScore",
  "scalarFamilyScore",
  "centerBias",
  "trajectoryScore",
  "minAxisScore",
  "rangeScore",
  "entityQuality",
];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    keyframeArtifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    gapPath: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--keyframe-artifact-root" && index + 1 < argv.length) {
      args.keyframeArtifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--gap-path" && index + 1 < argv.length) {
      args.gapPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_movement_score_component_gaps.mjs [--version-group 16.9]");
}

function addNumeric(stats, key, value) {
  if (!Number.isFinite(value)) {
    return;
  }
  const entry = stats.get(key) ?? { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY, positive: 0, negative: 0, zero: 0 };
  entry.count += 1;
  entry.sum += value;
  entry.min = Math.min(entry.min, value);
  entry.max = Math.max(entry.max, value);
  if (value > 0.000001) entry.positive += 1;
  else if (value < -0.000001) entry.negative += 1;
  else entry.zero += 1;
  stats.set(key, entry);
}

function numericObject(stats) {
  return Object.fromEntries([...stats.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => [key, {
    count: value.count,
    average: value.count > 0 ? value.sum / value.count : null,
    min: value.count > 0 ? value.min : null,
    max: value.count > 0 ? value.max : null,
    positive: value.positive,
    negative: value.negative,
    zero: value.zero,
  }]));
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) =>
    right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
  ));
}

function candidateFromAssignment(assignment) {
  return {
    entityKey: assignment.entityKey,
    score: assignment.score,
    scoreComponents: assignment.scoreComponents ?? {},
    assigned: true,
  };
}

function candidateFromAlternative(candidate) {
  return {
    entityKey: candidate.entityKey,
    score: candidate.score,
    scoreComponents: candidate.scoreComponents ?? {},
    assignedToOtherParticipant: candidate.assignedToOtherParticipant ?? false,
  };
}

function candidatesForParticipant(assignmentArtifact, rosterIndex) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate?.entityKey || seen.has(candidate.entityKey)) {
      return;
    }
    seen.add(candidate.entityKey);
    candidates.push(candidate);
  };

  const assignment = (assignmentArtifact.assignments ?? []).find((entry) => entry.rosterIndex === rosterIndex);
  if (assignment) {
    add(candidateFromAssignment(assignment));
    for (const alternative of assignment.assignmentConfidence?.topEntityAlternatives ?? []) {
      add(candidateFromAlternative(alternative));
    }
  }
  const unmatched = (assignmentArtifact.unmatchedParticipants ?? []).find((entry) => entry.rosterIndex === rosterIndex);
  for (const alternative of unmatched?.topRejectedEntityCandidates ?? []) {
    add(candidateFromAlternative(alternative));
  }
  return candidates;
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const keyframeArtifactRoot = resolveAbsolute(root, args.keyframeArtifactRoot);
  const gapPath = args.gapPath
    ? resolveAbsolute(root, args.gapPath)
    : path.join(keyframeArtifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}.json`);
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(keyframeArtifactRoot, `movement-score-component-gaps-${args.versionGroup}.json`);
  const gap = readJson(gapPath);

  const componentDeltas = new Map();
  const scoreDeltas = new Map();
  const statusCounts = new Map();
  const oracleVisibilityCounts = new Map();
  const examples = [];

  for (const replay of gap.replays ?? []) {
    const assignmentPath = path.join(artifactRoot, replay.replayId, gap.assignmentFile ?? "participant-movement-strict-min0.44-max50-supplemented-probe.json");
    if (!fs.existsSync(assignmentPath)) {
      increment(statusCounts, "missing_assignment_artifact");
      continue;
    }
    const assignmentArtifact = readJson(assignmentPath);
    for (const participant of replay.participants ?? []) {
      if (participant.status !== "passing_oracle_available_wrong_entity_assigned" || !participant.oracleEntityKey) {
        continue;
      }
      increment(statusCounts, participant.status);
      const candidates = candidatesForParticipant(assignmentArtifact, participant.rosterIndex);
      const assigned = candidates.find((candidate) => candidate.entityKey === participant.assignedEntityKey);
      const oracle = candidates.find((candidate) => candidate.entityKey === participant.oracleEntityKey);
      if (!assigned) {
        increment(oracleVisibilityCounts, "assigned_not_visible");
        continue;
      }
      if (!oracle) {
        increment(oracleVisibilityCounts, "oracle_not_visible_in_recorded_alternatives");
        continue;
      }
      increment(oracleVisibilityCounts, "oracle_visible");
      addNumeric(scoreDeltas, "oracleMinusAssignedScore", (oracle.score ?? 0) - (assigned.score ?? 0));
      for (const key of componentKeys) {
        const oracleValue = oracle.scoreComponents?.[key];
        const assignedValue = assigned.scoreComponents?.[key];
        if (Number.isFinite(oracleValue) && Number.isFinite(assignedValue)) {
          addNumeric(componentDeltas, key, oracleValue - assignedValue);
        }
      }
      if (examples.length < 20) {
        const exampleComponentDeltas = {};
        for (const key of componentKeys) {
          const oracleValue = oracle.scoreComponents?.[key];
          const assignedValue = assigned.scoreComponents?.[key];
          exampleComponentDeltas[key] = Number.isFinite(oracleValue) && Number.isFinite(assignedValue)
            ? oracleValue - assignedValue
            : null;
        }
        examples.push({
          replayId: replay.replayId,
          rosterIndex: participant.rosterIndex,
          champion: participant.champion,
          team: participant.team,
          teamPosition: participant.teamPosition,
          assignedEntityKey: participant.assignedEntityKey,
          oracleEntityKey: participant.oracleEntityKey,
          assignedScore: assigned.score ?? null,
          oracleScore: oracle.score ?? null,
          scoreDelta: Number.isFinite(oracle.score) && Number.isFinite(assigned.score) ? oracle.score - assigned.score : null,
          componentDeltas: exampleComponentDeltas,
        });
      }
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-score-component-gaps/v1",
    versionGroup: args.versionGroup,
    mode: "offline-oracle-diagnostic",
    status: "diagnostic_only_not_runtime_api_data",
    runtimeInput: false,
    runtimeApiData: false,
    note: "Compares replay-only score components for selected wrong assignments against validation-labelled oracle alternatives when recorded; do not use labels at runtime.",
    gapPath,
    statusCounts: sortedObject(statusCounts),
    oracleVisibilityCounts: sortedObject(oracleVisibilityCounts),
    scoreDeltas: numericObject(scoreDeltas),
    componentDeltas: numericObject(componentDeltas),
    examples,
  };

  writeJson(outputPath, output);
  console.log(`Wrote movement score component gap summary to ${outputPath}`);
  console.log(`wrong assignments=${statusCounts.get("passing_oracle_available_wrong_entity_assigned") ?? 0}, visible oracle alternatives=${oracleVisibilityCounts.get("oracle_visible") ?? 0}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
