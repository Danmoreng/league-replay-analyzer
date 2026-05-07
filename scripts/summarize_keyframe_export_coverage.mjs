import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    assignmentsPath: null,
    stableExportPath: null,
    allExportPath: null,
    versionGroup: "16.9",
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--assignments-path" && index + 1 < argv.length) {
      args.assignmentsPath = argv[++index];
    } else if (arg === "--stable-export" && index + 1 < argv.length) {
      args.stableExportPath = argv[++index];
    } else if (arg === "--all-export" && index + 1 < argv.length) {
      args.allExportPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_keyframe_export_coverage.mjs [--version-group 16.9] [--artifact-root <path>] [--stable-export <path>] [--all-export <path>] [--output-path <path>]");
}

function exportRowKey(participant) {
  return [
    participant?.participant?.participantId ?? participant?.participantId ?? "",
    participant?.familyKey ?? "",
    participant?.slotIndex ?? "",
  ].join("|");
}

function assignmentRowKey(versionGroup, assignment) {
  const normalized = normalizeAssignmentSlot(versionGroup, assignment);
  return [
    assignment.participantId ?? "",
    normalized.familyKey,
    normalized.slotIndex,
  ].join("|");
}

function exportedParticipantIndex(exportJson) {
  const byReplay = new Map();
  for (const replay of exportJson.replays ?? []) {
    const participants = new Map();
    for (const participant of replay.participants ?? []) {
      participants.set(exportRowKey(participant), participant);
    }
    byReplay.set(replay.replayId, participants);
  }
  return byReplay;
}

function metricCounts(participants) {
  const counts = new Map();
  for (const participant of participants) {
    for (const metric of Object.keys(participant.metrics ?? {})) {
      counts.set(metric, (counts.get(metric) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function countReplayLocalRows(participants) {
  return participants.filter((participant) => participant.replayLocalAssignment).length;
}

function normalizeAssignmentSlot(versionGroup, assignment) {
  if (versionGroup === "16.9" && assignment.familyKey === "24672-0x60-h0") {
    return {
      familyKey: "24672-0x60-h16",
      slotIndex: assignment.slotIndex - 1,
      sourceFamilyKey: assignment.familyKey,
      sourceSlotIndex: assignment.slotIndex,
    };
  }
  return {
    familyKey: assignment.familyKey,
    slotIndex: assignment.slotIndex,
    sourceFamilyKey: assignment.familyKey,
    sourceSlotIndex: assignment.slotIndex,
  };
}

function collectReplayAssignments(replay) {
  return (replay.families ?? []).flatMap((family) =>
    (family.assignments ?? []).map((assignment) => ({
      ...assignment,
      familyKey: family.familyKey,
    })),
  );
}

function summarizeReplay(replay, stableIndex, allIndex) {
  const assignments = collectReplayAssignments(replay);
  const stableParticipants = stableIndex.get(replay.replayId) ?? new Map();
  const allParticipants = allIndex.get(replay.replayId) ?? new Map();
  const stableAssignmentRows = new Set(
    assignments.filter((assignment) => assignment.stable).map((assignment) => assignmentRowKey(replay.versionGroup, assignment)),
  );
  const assignedRows = new Set(assignments.map((assignment) => assignmentRowKey(replay.versionGroup, assignment)));
  const stableExportedParticipants = [...stableParticipants.keys()];
  const allExportedParticipants = [...allParticipants.keys()];
  const stableMissingRows = [...stableAssignmentRows]
    .filter((rowKey) => !stableParticipants.has(rowKey))
    .sort();
  const allMissingRows = [...assignedRows]
    .filter((rowKey) => !allParticipants.has(rowKey))
    .sort();
  const correctedAssignments = assignments
    .map((assignment) => normalizeAssignmentSlot(replay.versionGroup, assignment))
    .filter((assignment) => assignment.familyKey === "24672-0x60-h16");
  const familySummaries = (replay.families ?? []).map((family) => ({
    familyKey: family.familyKey,
    normalizedFamilyKey: replay.versionGroup === "16.9" && family.familyKey === "24672-0x60-h0"
      ? "24672-0x60-h16"
      : family.familyKey,
    candidateSlotCount: family.candidateSlotCount ?? 0,
    edgeCount: family.edgeCount ?? 0,
    gatedEdgeCount: family.gatedEdgeCount ?? 0,
    assignmentCount: family.assignmentCount ?? 0,
    stableAssignmentCount: family.stableAssignmentCount ?? 0,
    assignedParticipantIds: family.assignedParticipantIds ?? [],
  }));
  const blocker = (() => {
    if (assignments.length > 0 && stableAssignmentRows.size === 0) {
      return "unstable-assignments-only";
    }
    if (assignments.length > 0) {
      return null;
    }
    const candidateStateSlotCount = replay.candidateStateSlotCount ?? 0;
    const edgeCount = replay.edgeCount ?? 0;
    if (candidateStateSlotCount > 0 && edgeCount === 0) {
      return "candidate-state-slots-without-identity-edges";
    }
    if (candidateStateSlotCount > 0) {
      return "candidate-state-slots-without-assignments";
    }
    return "no-candidate-state-slots";
  })();

  return {
    replayId: replay.replayId,
    gameVersion: replay.gameVersion,
    candidateStateSlotCount: replay.candidateStateSlotCount ?? 0,
    edgeCount: replay.edgeCount ?? 0,
    gatedEdgeCount: replay.gatedEdgeCount ?? 0,
    assignmentCount: assignments.length,
    stableAssignmentCount: assignments.filter((assignment) => assignment.stable).length,
    correctedH16AssignmentCount: correctedAssignments.length,
    stableExportedParticipantCount: stableExportedParticipants.length,
    allExportedParticipantCount: allExportedParticipants.length,
    stableReplayLocalExportedRowCount: countReplayLocalRows([...stableParticipants.values()]),
    allReplayLocalExportedRowCount: countReplayLocalRows([...allParticipants.values()]),
    stableMissingRows,
    allMissingRows,
    blocker,
    families: familySummaries,
    stableMetricCounts: metricCounts([...stableParticipants.values()]),
    allMetricCounts: metricCounts([...allParticipants.values()]),
  };
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const assignmentsPath = resolveAbsolute(root, args.assignmentsPath ?? path.join(artifactRoot, "keyframe-slot-assignments.json"));
  const stableExportPath = resolveAbsolute(root, args.stableExportPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}.json`));
  const allExportPath = resolveAbsolute(root, args.allExportPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}-all-assignments.json`));
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join(artifactRoot, `keyframe-export-coverage-${args.versionGroup}.json`));

  const assignments = readJson(assignmentsPath);
  const stableExport = readJson(stableExportPath);
  const allExport = readJson(allExportPath);
  const stableIndex = exportedParticipantIndex(stableExport);
  const allIndex = exportedParticipantIndex(allExport);
  const replays = (assignments.replays ?? [])
    .filter((replay) => replay.versionGroup === args.versionGroup)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
  const replaySummaries = replays.map((replay) => summarizeReplay(replay, stableIndex, allIndex));

  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    artifactRoot,
    assignmentsPath,
    stableExportPath,
    allExportPath,
    totals: {
      replayCount: replaySummaries.length,
      stableExportedReplayCount: stableExport.totals?.exportedReplayCount ?? stableIndex.size,
      allExportedReplayCount: allExport.totals?.exportedReplayCount ?? allIndex.size,
      assignmentCount: sum(replaySummaries, "assignmentCount"),
      stableAssignmentCount: sum(replaySummaries, "stableAssignmentCount"),
      correctedH16AssignmentCount: sum(replaySummaries, "correctedH16AssignmentCount"),
      candidateStateSlotCount: sum(replaySummaries, "candidateStateSlotCount"),
      edgeCount: sum(replaySummaries, "edgeCount"),
      gatedEdgeCount: sum(replaySummaries, "gatedEdgeCount"),
      stableExportedParticipantCount: sum(replaySummaries, "stableExportedParticipantCount"),
      allExportedParticipantCount: sum(replaySummaries, "allExportedParticipantCount"),
      stableReplayLocalExportedRowCount: sum(replaySummaries, "stableReplayLocalExportedRowCount"),
      allReplayLocalExportedRowCount: sum(replaySummaries, "allReplayLocalExportedRowCount"),
      stableMissingRowCount: replaySummaries.reduce((total, replay) => total + replay.stableMissingRows.length, 0),
      allMissingRowCount: replaySummaries.reduce((total, replay) => total + replay.allMissingRows.length, 0),
      blockerCounts: Object.fromEntries(
        [...replaySummaries.reduce((counts, replay) => {
          if (replay.blocker) {
            counts.set(replay.blocker, (counts.get(replay.blocker) ?? 0) + 1);
          }
          return counts;
        }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    replays: replaySummaries,
  };

  writeJson(outputPath, output);
  console.log(`Wrote keyframe export coverage to ${outputPath}`);
  console.log(`Stable export: ${output.totals.stableExportedParticipantCount}/${output.totals.stableAssignmentCount} stable assigned rows across ${output.totals.stableExportedReplayCount}/${output.totals.replayCount} replay(s).`);
  console.log(`All export: ${output.totals.allExportedParticipantCount}/${output.totals.assignmentCount} assigned rows across ${output.totals.allExportedReplayCount}/${output.totals.replayCount} replay(s).`);
}

main();
