import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    roflStatsPath: null,
    supervisedExportPath: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--rofl-stats-path" && index + 1 < argv.length) {
      args.roflStatsPath = argv[++index];
    } else if (arg === "--supervised-export-path" && index + 1 < argv.length) {
      args.supervisedExportPath = argv[++index];
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
  console.log("Usage: node ./scripts/compare_rofl_stat_assignments_to_supervised.mjs [--version-group 16.9] [--artifact-root <path>] [--rofl-stats-path <path>] [--supervised-export-path <path>] [--output-path <path>]");
}

function sourceKey(replayId, familyKey, slotIndex) {
  return `${replayId}|${familyKey}|${slotIndex}`;
}

function buildSupervisedIndex(exportJson) {
  const index = new Map();
  for (const replay of exportJson.replays ?? []) {
    for (const participant of replay.participants ?? []) {
      const familyKey = participant.sourceFamilyKey ?? participant.familyKey;
      const slotIndex = participant.sourceSlotIndex ?? participant.slotIndex;
      index.set(sourceKey(replay.replayId, familyKey, slotIndex), {
        replayId: replay.replayId,
        familyKey,
        slotIndex,
        participantId: participant.participant?.participantId ?? null,
        champion: participant.participant?.champion ?? null,
        teamId: participant.participant?.teamId ?? null,
        teamPosition: participant.participant?.teamPosition ?? null,
        stable: participant.stable ?? false,
        replayLocalAssignment: participant.replayLocalAssignment ?? false,
        exportedFamilyKey: participant.familyKey,
        exportedSlotIndex: participant.slotIndex,
      });
    }
  }
  return index;
}

function flattenRoflAssignments(roflStats) {
  return (roflStats.replays ?? []).flatMap((replay) =>
    (replay.families ?? []).flatMap((family) =>
      (family.assignments ?? []).map((assignment) => ({
        replayId: replay.replayId,
        familyKey: assignment.familyKey,
        slotIndex: assignment.slotIndex,
        expectedParticipantId: assignment.expectedParticipantId,
        rosterIndex: assignment.rosterIndex,
        champion: assignment.champion,
        team: assignment.team,
        teamPosition: assignment.teamPosition,
        score: assignment.score,
        metricCount: assignment.metricCount,
        distinctMetricCount: assignment.distinctMetricCount,
        confidence: assignment.confidence,
        canonicalCandidate: assignment.canonicalCandidate ?? false,
        winnerGap: assignment.winnerGap,
        rejectionReasons: assignment.rejectionReasons ?? [],
      })),
    ),
  );
}

function compareAssignment(assignment, supervisedIndex) {
  const supervised = supervisedIndex.get(sourceKey(assignment.replayId, assignment.familyKey, assignment.slotIndex)) ?? null;
  let result = "missing-supervised";
  if (supervised) {
    result = supervised.participantId === assignment.expectedParticipantId ? "match" : "conflict";
  }

  return {
    ...assignment,
    comparison: result,
    supervised,
  };
}

function countBy(rows, readKey) {
  const counts = {};
  for (const row of rows) {
    const key = readKey(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const roflStatsPath = resolveAbsolute(
    root,
    args.roflStatsPath ?? path.join(artifactRoot, `keyframe-rofl-stat-slot-assignments-${args.versionGroup}.json`),
  );
  const supervisedExportPath = resolveAbsolute(
    root,
    args.supervisedExportPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}-all-assignments.json`),
  );
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `keyframe-rofl-stat-supervised-comparison-${args.versionGroup}.json`),
  );

  const roflStats = readJson(roflStatsPath);
  const supervisedExport = readJson(supervisedExportPath);
  const supervisedIndex = buildSupervisedIndex(supervisedExport);
  const assignments = flattenRoflAssignments(roflStats).map((assignment) => compareAssignment(assignment, supervisedIndex));

  const output = {
    comparisonSchema: "rofl-keyframe-stat-supervised-comparison/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    sources: {
      roflStatsPath,
      supervisedExportPath,
    },
    totals: {
      assignmentCount: assignments.length,
      byComparison: countBy(assignments, (assignment) => assignment.comparison),
      byConfidence: countBy(assignments, (assignment) => assignment.confidence),
      stableSupervisedAssignmentCount: assignments.filter((assignment) => assignment.supervised?.stable).length,
      stableSupervisedMatchCount: assignments.filter((assignment) => assignment.supervised?.stable && assignment.comparison === "match").length,
      stableSupervisedConflictCount: assignments.filter((assignment) => assignment.supervised?.stable && assignment.comparison === "conflict").length,
      unstableSupervisedAssignmentCount: assignments.filter((assignment) => assignment.supervised && !assignment.supervised.stable).length,
      unstableSupervisedMatchCount: assignments.filter((assignment) => assignment.supervised && !assignment.supervised.stable && assignment.comparison === "match").length,
      unstableSupervisedConflictCount: assignments.filter((assignment) => assignment.supervised && !assignment.supervised.stable && assignment.comparison === "conflict").length,
      canonicalCandidateCount: assignments.filter((assignment) => assignment.canonicalCandidate).length,
      canonicalMatchCount: assignments.filter((assignment) => assignment.canonicalCandidate && assignment.comparison === "match").length,
      diagnosticMatchCount: assignments.filter((assignment) => !assignment.canonicalCandidate && assignment.comparison === "match").length,
      diagnosticConflictCount: assignments.filter((assignment) => !assignment.canonicalCandidate && assignment.comparison === "conflict").length,
    },
    assignments,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ROFL stat supervised comparison to ${outputPath}`);
  console.log(`assignments: ${output.totals.assignmentCount}`);
  console.log(`comparison: ${JSON.stringify(output.totals.byComparison)}`);
}

main();
