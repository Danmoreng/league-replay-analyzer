import fs from "fs";
import path from "path";

import {
  buildSummaryRoster,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    assignmentsPath: null,
    outputPath: null,
    stableOnly: true,
    minAssignmentsPerReplay: 2,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--assignments-path" && index + 1 < argv.length) {
      args.assignmentsPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--all-assignments") {
      args.stableOnly = false;
    } else if (arg === "--min-assignments-per-replay" && index + 1 < argv.length) {
      args.minAssignmentsPerReplay = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/analyze_keyframe_identity_order.mjs [--artifact-root <path>] [--assignments-path <path>] [--output-path <path>] [--all-assignments]");
}

function normalizeChampion(value) {
  return `${value ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function roleRank(role) {
  switch (`${role ?? ""}`.toUpperCase()) {
    case "TOP":
      return 0;
    case "JUNGLE":
      return 1;
    case "MIDDLE":
    case "MID":
      return 2;
    case "BOTTOM":
    case "BOT":
    case "ADC":
      return 3;
    case "UTILITY":
    case "SUPPORT":
      return 4;
    default:
      return 99;
  }
}

function findRosterEntry(roster, assignment) {
  const champion = normalizeChampion(assignment.champion);
  const exact = roster.find((entry) => normalizeChampion(entry.champion) === champion);
  if (exact) {
    return exact;
  }
  return roster.find((entry) =>
    Number(entry.team) === Number(assignment.teamId) &&
    `${entry.teamPosition}`.toUpperCase() === `${assignment.teamPosition}`.toUpperCase(),
  ) ?? null;
}

function summarizeBoolean(rows, key) {
  const total = rows.length;
  const matched = rows.filter((row) => row[key]).length;
  return {
    matched,
    total,
    rate: total > 0 ? matched / total : 0,
  };
}

function sequenceScore(assignments, readExpectedOrder) {
  const rows = assignments
    .map((assignment) => ({
      slotIndex: assignment.slotIndex,
      expectedOrder: readExpectedOrder(assignment),
    }))
    .filter((row) => Number.isFinite(row.expectedOrder))
    .sort((left, right) => left.slotIndex - right.slotIndex);
  if (rows.length < 2) {
    return { comparablePairCount: 0, orderedPairCount: 0, rate: 0 };
  }

  let comparablePairCount = 0;
  let orderedPairCount = 0;
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      if (rows[leftIndex].expectedOrder === rows[rightIndex].expectedOrder) {
        continue;
      }
      comparablePairCount += 1;
      if (rows[leftIndex].expectedOrder < rows[rightIndex].expectedOrder) {
        orderedPairCount += 1;
      }
    }
  }

  return {
    comparablePairCount,
    orderedPairCount,
    rate: comparablePairCount > 0 ? orderedPairCount / comparablePairCount : 0,
  };
}

function readReplayRows(artifactRoot, replay, stableOnly) {
  const summaryPath = path.join(artifactRoot, replay.replayId, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    return [];
  }

  const roster = buildSummaryRoster(readJson(summaryPath));
  const rows = [];
  for (const family of replay.families ?? []) {
    for (const assignment of family.assignments ?? []) {
      if (stableOnly && !assignment.stable) {
        continue;
      }
      const rosterEntry = findRosterEntry(roster, assignment);
      rows.push({
        replayId: replay.replayId,
        versionGroup: replay.versionGroup,
        familyKey: assignment.familyKey,
        slotIndex: assignment.slotIndex,
        participantId: assignment.participantId,
        champion: assignment.champion,
        teamId: assignment.teamId,
        teamPosition: assignment.teamPosition,
        stable: assignment.stable,
        score: assignment.score,
        winnerGap: assignment.winnerGap,
        rosterIndex: rosterEntry?.rosterIndex ?? null,
        rosterChampion: rosterEntry?.champion ?? null,
        rosterTeam: rosterEntry?.team ?? null,
        rosterTeamPosition: rosterEntry?.teamPosition ?? null,
        rosterOrder: rosterEntry ? rosterEntry.rosterIndex + 1 : null,
        expectedParticipantIdFromRoster: rosterEntry ? rosterEntry.rosterIndex + 1 : null,
        roleOrder: (Number(assignment.teamId) === 200 ? 5 : 0) + roleRank(assignment.teamPosition) + 1,
      });
    }
  }
  return rows;
}

function analyze(assignments, artifactRoot, stableOnly, minAssignmentsPerReplay) {
  const rows = [];
  for (const replay of assignments.replays ?? []) {
    if (replay.skipped) {
      continue;
    }
    rows.push(...readReplayRows(artifactRoot, replay, stableOnly));
  }

  const rowsByReplay = new Map();
  for (const row of rows) {
    const list = rowsByReplay.get(row.replayId) ?? [];
    list.push(row);
    rowsByReplay.set(row.replayId, list);
  }

  const replaySummaries = [];
  for (const [replayId, replayRows] of rowsByReplay) {
    if (replayRows.length < minAssignmentsPerReplay) {
      continue;
    }
    replayRows.sort((left, right) => left.slotIndex - right.slotIndex);
    replaySummaries.push({
      replayId,
      versionGroup: replayRows[0]?.versionGroup ?? null,
      assignmentCount: replayRows.length,
      slotSpan: {
        min: Math.min(...replayRows.map((row) => row.slotIndex)),
        max: Math.max(...replayRows.map((row) => row.slotIndex)),
      },
      participantIdSequence: replayRows.map((row) => row.participantId),
      rosterOrderSequence: replayRows.map((row) => row.rosterOrder),
      roleOrderSequence: replayRows.map((row) => row.roleOrder),
      slotMinusParticipantId: replayRows.map((row) => row.slotIndex - row.participantId),
      slotMinusRosterOrder: replayRows
        .filter((row) => Number.isFinite(row.rosterOrder))
        .map((row) => row.slotIndex - row.rosterOrder),
      participantIdOrder: sequenceScore(replayRows, (row) => row.participantId),
      rosterOrder: sequenceScore(replayRows, (row) => row.rosterOrder),
      roleOrder: sequenceScore(replayRows, (row) => row.roleOrder),
      rows: replayRows,
    });
  }

  const participantIdMatchesRoster = rows
    .filter((row) => row.expectedParticipantIdFromRoster != null)
    .map((row) => ({
      ...row,
      matches: row.participantId === row.expectedParticipantIdFromRoster,
    }));

  return {
    generatedAtUtc: new Date().toISOString(),
    sourceAssignmentsGeneratedAtUtc: assignments.generatedAtUtc ?? null,
    stableOnly,
    minAssignmentsPerReplay,
    assignmentRowCount: rows.length,
    replaySummaryCount: replaySummaries.length,
    summary: {
      participantIdEqualsRosterOrder: summarizeBoolean(participantIdMatchesRoster, "matches"),
      aggregateParticipantIdOrder: sequenceScore(rows, (row) => row.participantId),
      aggregateRosterOrder: sequenceScore(rows, (row) => row.rosterOrder),
      aggregateRoleOrder: sequenceScore(rows, (row) => row.roleOrder),
    },
    replaySummaries: replaySummaries.sort((left, right) =>
      right.assignmentCount - left.assignmentCount ||
      right.participantIdOrder.rate - left.participantIdOrder.rate ||
      left.replayId.localeCompare(right.replayId),
    ),
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const assignmentsPath = args.assignmentsPath
    ? resolveAbsolute(repoRoot, args.assignmentsPath)
    : path.join(artifactRoot, "keyframe-slot-assignments.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-identity-order-analysis.json");

  if (!fs.existsSync(assignmentsPath)) {
    throw new Error(`Keyframe slot assignments not found at ${assignmentsPath}.`);
  }

  const assignments = readJson(assignmentsPath);
  const analysis = analyze(assignments, artifactRoot, args.stableOnly, args.minAssignmentsPerReplay);
  writeJson(outputPath, analysis);

  console.log(`Wrote keyframe identity order analysis to ${outputPath}`);
  console.log(`assignment rows: ${analysis.assignmentRowCount}`);
  console.log(`replay summaries: ${analysis.replaySummaryCount}`);
  console.log(`participantId == roster order: ${analysis.summary.participantIdEqualsRosterOrder.matched}/${analysis.summary.participantIdEqualsRosterOrder.total}`);
  console.log(`aggregate slot/participant order rate: ${analysis.summary.aggregateParticipantIdOrder.rate.toFixed(3)}`);
  console.log(`aggregate slot/roster order rate: ${analysis.summary.aggregateRosterOrder.rate.toFixed(3)}`);
  console.log(`aggregate slot/role order rate: ${analysis.summary.aggregateRoleOrder.rate.toFixed(3)}`);
}

main();
