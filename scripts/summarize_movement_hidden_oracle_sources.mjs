#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    gapPath: "artifacts-keyframes/movement-assignment-oracle-gap-16.9-current-max128-reduced-role-wide.json",
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--gap-path" && index + 1 < argv.length) args.gapPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/summarize_movement_hidden_oracle_sources.mjs [--gap-path <path>] [--artifact-root artifacts] [--version-group 16.9] [--output-path <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function compactEntityKey(entityKey) {
  return String(entityKey ?? "").split("|").slice(0, 5).join("|");
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) =>
    right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))));
}

function allParticipantCandidateCompacts(participant) {
  const candidates = [];
  if (participant.entityKey) {
    candidates.push(participant.entityKey);
  }
  if (participant.assignedEntityKey) {
    candidates.push(participant.assignedEntityKey);
  }
  for (const candidate of participant.assignmentConfidence?.topEntityAlternatives ?? []) {
    candidates.push(candidate.entityKey);
  }
  for (const candidate of participant.topRejectedEntityCandidates ?? []) {
    candidates.push(candidate.entityKey);
  }
  return new Set(candidates.map(compactEntityKey));
}

function assignmentParticipant(assignmentArtifact, rosterIndex) {
  const assignment = (assignmentArtifact.assignments ?? []).find((entry) => entry.rosterIndex === rosterIndex);
  if (assignment) return assignment;
  return (assignmentArtifact.unmatchedParticipants ?? []).find((entry) => entry.rosterIndex === rosterIndex) ?? null;
}

function classifyHiddenOracle({ oracleCompact, movement, assignmentArtifact }) {
  const rawEntity = (movement.entities ?? []).find((entity) => compactEntityKey(entity.entityKey) === oracleCompact) ?? null;
  const assignedEntity = (assignmentArtifact.assignments ?? []).find((assignment) => compactEntityKey(assignment.entityKey) === oracleCompact) ?? null;
  const unassignedEntity = (assignmentArtifact.unassignedEntities ?? []).find((entity) => compactEntityKey(entity.entityKey) === oracleCompact) ?? null;
  const discardedAlias = (assignmentArtifact.discardedAliases ?? []).find((alias) => compactEntityKey(alias.discardedEntityKey) === oracleCompact) ?? null;
  const keptAliasAssignment = discardedAlias
    ? (assignmentArtifact.assignments ?? []).find((assignment) => compactEntityKey(assignment.entityKey) === compactEntityKey(discardedAlias.keptEntityKey)) ?? null
    : null;
  const keptAliasUnassigned = discardedAlias
    ? (assignmentArtifact.unassignedEntities ?? []).find((entity) => compactEntityKey(entity.entityKey) === compactEntityKey(discardedAlias.keptEntityKey)) ?? null
    : null;

  if (assignedEntity) return { reason: "oracle_entity_assigned_to_other_participant", rawEntity, assignedEntity };
  if (unassignedEntity) return { reason: "oracle_entity_canonical_unassigned_but_not_participant_candidate", rawEntity, unassignedEntity };
  if (discardedAlias && keptAliasAssignment) return { reason: "oracle_discarded_alias_kept_entity_assigned", rawEntity, discardedAlias, keptAliasAssignment };
  if (discardedAlias && keptAliasUnassigned) return { reason: "oracle_discarded_alias_kept_entity_unassigned", rawEntity, discardedAlias, keptAliasUnassigned };
  if (discardedAlias) return { reason: "oracle_discarded_alias_kept_entity_missing", rawEntity, discardedAlias };
  if (rawEntity) return { reason: "oracle_raw_entity_present_but_missing_from_canonical_assignment_artifact", rawEntity };
  return { reason: "oracle_raw_entity_missing_from_extracted_movement" };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const gapPath = resolveAbsolute(root, args.gapPath);
  const gap = readJson(gapPath);
  const reasonCounts = new Map();
  const statusCounts = new Map();
  const examples = [];

  for (const replay of gap.replays ?? []) {
    const replayDir = path.join(artifactRoot, replay.replayId);
    const movementPath = path.join(replayDir, gap.movementFile);
    const assignmentPath = path.join(replayDir, gap.assignmentFile);
    if (!fs.existsSync(movementPath) || !fs.existsSync(assignmentPath)) {
      increment(reasonCounts, "missing_replay_artifacts");
      continue;
    }
    const movement = readJson(movementPath);
    const assignmentArtifact = readJson(assignmentPath);
    for (const participant of replay.participants ?? []) {
      if (!participant.oraclePassesValidation || !participant.oracleEntityKey) continue;
      const participantArtifact = assignmentParticipant(assignmentArtifact, participant.rosterIndex);
      const participantCandidateCompacts = allParticipantCandidateCompacts(participantArtifact ?? {});
      const oracleCompact = compactEntityKey(participant.oracleEntityKey);
      const visible = participantCandidateCompacts.has(oracleCompact);
      const status = visible ? "oracle_visible" : "oracle_hidden";
      increment(statusCounts, `${participant.status}:${status}`);
      if (visible) continue;

      const classification = classifyHiddenOracle({ oracleCompact, movement, assignmentArtifact });
      increment(reasonCounts, classification.reason);
      if (examples.length < 30) {
        examples.push({
          replayId: replay.replayId,
          rosterIndex: participant.rosterIndex,
          champion: participant.champion,
          team: participant.team,
          teamPosition: participant.teamPosition,
          participantStatus: participant.status,
          assignedEntityKey: participant.assignedEntityKey ?? null,
          oracleEntityKey: participant.oracleEntityKey,
          reason: classification.reason,
          rawEntityPresent: classification.rawEntity != null,
          discardedAlias: classification.discardedAlias
            ? {
                keptEntityKey: classification.discardedAlias.keptEntityKey,
                discardedEntityKey: classification.discardedAlias.discardedEntityKey,
                keptPatternKey: classification.discardedAlias.keptPatternKey ?? null,
                discardedPatternKey: classification.discardedAlias.discardedPatternKey ?? null,
              }
            : null,
          keptAliasAssignedRosterIndex: classification.keptAliasAssignment?.rosterIndex ?? null,
          keptAliasUnassigned: classification.keptAliasUnassigned != null,
          assignedToOtherRosterIndex: classification.assignedEntity?.rosterIndex ?? null,
        });
      }
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-hidden-oracle-sources/v1",
    versionGroup: args.versionGroup,
    mode: "offline-oracle-diagnostic",
    runtimeInput: false,
    runtimeApiData: false,
    note: "Classifies validation-labelled oracle movement entities that are absent from the participant's recorded replay-only alternatives; labels are offline diagnostics only.",
    gapPath,
    artifactRoot,
    totals: {
      statusCounts: sortedObject(statusCounts),
      hiddenReasonCounts: sortedObject(reasonCounts),
      hiddenCount: [...reasonCounts.values()].reduce((sum, count) => sum + count, 0),
    },
    examples,
  };
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-hidden-oracle-sources-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement hidden-oracle source summary to ${outputPath}`);
  console.log(`hidden=${output.totals.hiddenCount}`);
}

main();
