#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    artifactRoot: path.resolve("artifacts"),
    versionGroup: "16.9",
    replayListPath: path.resolve("artifacts-keyframes", "keyframe-rofl-stat-slot-assignments-16.9.json"),
    outputPath: null,
    json: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = path.resolve(argv[++index]);
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
      args.replayListPath = path.resolve("artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${args.versionGroup}.json`);
    } else if (arg === "--replay-list-path" && index + 1 < argv.length) {
      args.replayListPath = path.resolve(argv[++index]);
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = path.resolve(argv[++index]);
    } else if (arg === "--json") {
      args.json = true;
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
  console.log("Usage: node ./scripts/summarize_movement_diagnostics.mjs [--version-group 16.9] [--artifact-root artifacts] [--replay-list-path <path>] [--output-path <path>] [--json]");
}

function discoverReplayIds(args) {
  if (fs.existsSync(args.replayListPath)) {
    const replayList = readJson(args.replayListPath);
    return (replayList.replays ?? [])
      .filter((replay) => !replay.skipped)
      .map((replay) => replay.replayId)
      .filter(Boolean)
      .sort();
  }

  return fs.readdirSync(args.artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

const diagnosticKinds = [
  {
    key: "default",
    label: "default",
    movementFile: "participant-movement.json",
    validationFile: "assigned-movement-validation-report.json",
  },
  {
    key: "noPriors",
    label: "no-priors",
    movementFile: "participant-movement-no-priors-probe.json",
    validationFile: "assigned-movement-no-priors-probe-validation-report.json",
    fallbackMovementFile: "participant-movement-no-priors.json",
    fallbackValidationFile: "assigned-movement-no-priors-validation-report.json",
  },
  {
    key: "minScore046NoPriors",
    label: "no-priors min=0.46",
    movementFile: "participant-movement-no-priors-min0.46-probe.json",
    validationFile: "assigned-movement-no-priors-min0.46-probe-validation-report.json",
  },
  {
    key: "strictReplayOnly",
    label: "strict replay-only",
    movementFile: "participant-movement-strict-replay-only-probe.json",
    validationFile: "assigned-movement-strict-replay-only-probe-validation-report.json",
  },
  {
    key: "strictMinScore044",
    label: "strict replay-only min=0.44",
    movementFile: "participant-movement-strict-min0.44-probe.json",
    validationFile: "assigned-movement-strict-min0.44-probe-validation-report.json",
  },
  {
    key: "strictTopOwner",
    label: "strict replay-only top-owner bias",
    movementFile: "participant-movement-strict-top-owner-probe.json",
    validationFile: "assigned-movement-strict-top-owner-probe-validation-report.json",
  },
  {
    key: "strictMinScore044TopOwner",
    label: "strict replay-only min=0.44 top-owner bias",
    movementFile: "participant-movement-strict-min0.44-top-owner-probe.json",
    validationFile: "assigned-movement-strict-min0.44-top-owner-probe-validation-report.json",
  },
  {
    key: "strictMinScore044DuplicateEntities",
    label: "strict replay-only min=0.44 duplicate-entity diagnostic",
    movementFile: "participant-movement-strict-min0.44-duplicate-entities-probe.json",
    validationFile: "assigned-movement-strict-min0.44-duplicate-entities-probe-validation-report.json",
  },
  {
    key: "strictMinScore044Max50",
    label: "strict replay-only min=0.44 max50 extraction diagnostic",
    movementFile: "participant-movement-strict-min0.44-max50-probe.json",
    validationFile: "assigned-movement-strict-min0.44-max50-probe-validation-report.json",
  },
  {
    key: "strictMinScore044Max50Supplemented",
    label: "strict replay-only min=0.44 max50 supplemented extraction diagnostic",
    movementFile: "participant-movement-strict-min0.44-max50-supplemented-probe.json",
    validationFile: "assigned-movement-strict-min0.44-max50-supplemented-probe-validation-report.json",
  },
  {
    key: "strictMinScore044Max50CandidateSupplemented",
    label: "strict replay-only min=0.44 max50 candidate-match supplemented extraction diagnostic",
    movementFile: "participant-movement-strict-min0.44-max50-candidate-supplemented-probe.json",
    validationFile: "assigned-movement-strict-min0.44-max50-candidate-supplemented-probe-validation-report.json",
  },
  {
    key: "strictMinScore044CurrentMax128",
    label: "strict replay-only min=0.44 current max128 schema extraction diagnostic",
    movementFile: "participant-movement-strict-min0.44-current-max128-probe.json",
    validationFile: "assigned-movement-strict-min0.44-current-max128-probe-validation-report.json",
  },
  {
    key: "strictMinScore044CurrentMax128ReducedRole",
    label: "strict replay-only min=0.44 current max128 reduced role-anchor score diagnostic",
    movementFile: "participant-movement-strict-min0.44-current-max128-reduced-role-probe.json",
    validationFile: "assigned-movement-strict-min0.44-current-max128-reduced-role-probe-validation-report.json",
  },
  {
    key: "strictMinScore044CurrentMax128ReducedRoleAliases",
    label: "strict replay-only min=0.44 current max128 reduced role-anchor alias-preserving diagnostic",
    movementFile: "participant-movement-strict-min0.44-current-max128-reduced-role-aliases-probe.json",
    validationFile: "assigned-movement-strict-min0.44-current-max128-reduced-role-aliases-probe-validation-report.json",
  },
];

function readOptional(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function incrementNestedCounter(map, outerKey, innerKey) {
  const normalizedOuterKey = outerKey ?? "UNKNOWN";
  const normalizedInnerKey = innerKey ?? "unknown";
  const inner = map.get(normalizedOuterKey) ?? new Map();
  inner.set(normalizedInnerKey, (inner.get(normalizedInnerKey) ?? 0) + 1);
  map.set(normalizedOuterKey, inner);
}

function mapToSortedObject(map) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, value]) => [
        key,
        value instanceof Map ? mapToSortedObject(value) : value,
      ]),
  );
}

function createNumericAccumulator() {
  return {
    count: 0,
    sum: 0,
    min: null,
    max: null,
  };
}

function addNumeric(accumulator, value) {
  if (!Number.isFinite(value)) {
    return;
  }
  accumulator.count += 1;
  accumulator.sum += value;
  accumulator.min = accumulator.min == null ? value : Math.min(accumulator.min, value);
  accumulator.max = accumulator.max == null ? value : Math.max(accumulator.max, value);
}

function finalizeNumeric(accumulator) {
  return {
    count: accumulator.count,
    average: accumulator.count ? accumulator.sum / accumulator.count : null,
    min: accumulator.min,
    max: accumulator.max,
  };
}

function createQualityGateCounter() {
  return {
    assignmentCount: 0,
    passingAssignmentCount: 0,
  };
}

function addQualityGate(counter, passes) {
  counter.assignmentCount += 1;
  counter.passingAssignmentCount += passes ? 1 : 0;
}

function finalizeQualityGate(counter) {
  return {
    ...counter,
    passRatePerAssignment: counter.assignmentCount
      ? counter.passingAssignmentCount / counter.assignmentCount
      : null,
  };
}

function collisionPressureBucket(count) {
  if (count >= 7) return "7_plus";
  if (count >= 4) return "4_to_6";
  if (count >= 1) return "1_to_3";
  return "none";
}

function incrementAssignmentRiskCounter(map, key, passes) {
  const normalizedKey = key ?? "unknown";
  const counter = map.get(normalizedKey) ?? {
    assignmentCount: 0,
    passingAssignmentCount: 0,
  };
  counter.assignmentCount += 1;
  counter.passingAssignmentCount += passes ? 1 : 0;
  map.set(normalizedKey, counter);
}

function mapRiskCountersToObject(map) {
  return Object.fromEntries(
    [...map.entries()]
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
      .map(([key, counter]) => [
        key,
        {
          ...counter,
          passRatePerAssignment: counter.assignmentCount
            ? counter.passingAssignmentCount / counter.assignmentCount
            : null,
        },
      ]),
  );
}

function familyFromEntityKey(entityKey) {
  if (!entityKey || typeof entityKey !== "string") {
    return "unknown";
  }
  return entityKey.split("|")[0] || "unknown";
}

function familySlotKey(familyKey, slotIndex) {
  return `${familyKey ?? "unknown"}|slot=${slotIndex ?? "unknown"}`;
}

function summarizeKind(artifactRoot, replayIds, kind) {
  const perReplay = [];
  const assignedByRoleAndStatus = new Map();
  const assignedByFamilyAndStatus = new Map();
  const assignedByFamilySlotAndStatus = new Map();
  const assignedByFamilySlotRoleAndStatus = new Map();
  const unmatchedByRole = new Map();
  const unmatchedTopCandidateByRole = new Map();
  const topRejectedFamilyByRole = new Map();
  const topRejectedFamilySlotByRole = new Map();
  const confidenceByStatus = {
    passing: {
      entityScoreMargin: createNumericAccumulator(),
      participantScoreMargin: createNumericAccumulator(),
    },
    failing: {
      entityScoreMargin: createNumericAccumulator(),
      participantScoreMargin: createNumericAccumulator(),
    },
  };
  const diagnosticQualityGates = {
    geographyEntityMargin: {
      description: "diagnostic-only gate: teamScore >= 0.60 and entityScoreMargin >= 0.02",
      runtimeApiData: false,
      minimumTeamScore: 0.6,
      minimumEntityScoreMargin: 0.02,
      counter: createQualityGateCounter(),
    },
    strongGeography: {
      description: "diagnostic-only gate: teamScore >= 0.65",
      runtimeApiData: false,
      minimumTeamScore: 0.65,
      counter: createQualityGateCounter(),
    },
  };
  const collisionPressureByStatus = new Map();
  const assignedOwnerRankByStatus = new Map();
  const assignmentRiskMatrix = new Map();
  const topCollisionHubs = [];
  const duplicateEntityClaims = [];
  const totals = {
    replayCount: 0,
    missingReplayCount: 0,
    assignmentCount: 0,
    matchedAssignmentCount: 0,
    passingAssignmentCount: 0,
    expectedParticipantCount: 0,
    unmatchedParticipantCount: 0,
    usesIdentityPriorsCount: 0,
    usesSupportHypothesesCount: 0,
    unknownSupportHypothesesCount: 0,
    duplicateEntityClaimCount: 0,
    duplicateClaimedEntityCount: 0,
  };

  for (const replayId of replayIds) {
    const replayDir = path.join(artifactRoot, replayId);
    const movementPath = path.join(replayDir, kind.movementFile);
    const validationPath = path.join(replayDir, kind.validationFile);
    const fallbackMovementPath = kind.fallbackMovementFile ? path.join(replayDir, kind.fallbackMovementFile) : null;
    const fallbackValidationPath = kind.fallbackValidationFile ? path.join(replayDir, kind.fallbackValidationFile) : null;
    const movement = readOptional(movementPath) ?? (fallbackMovementPath ? readOptional(fallbackMovementPath) : null);
    const validation = readOptional(validationPath) ?? (fallbackValidationPath ? readOptional(fallbackValidationPath) : null);

    if (!movement && !validation) {
      totals.missingReplayCount += 1;
      perReplay.push({
        replayId,
        status: "missing",
      });
      continue;
    }

    const assignmentCount = validation?.summary?.assignmentCount ?? movement?.assignments?.length ?? 0;
    const passingAssignmentCount = validation?.summary?.passingAssignmentCount ?? null;
    const matchedAssignmentCount = validation?.summary?.matchedAssignmentCount ?? null;
    const unmatchedParticipantCount = movement?.unmatchedParticipants?.length ?? Math.max(0, 10 - assignmentCount);
    const usesIdentityPriors = movement?.priorsPath != null;
    const usesSupportHypotheses = movement?.normalization?.useSupportHypotheses ?? null;
    const assignmentsByEntityKey = new Map();
    for (const assignment of movement?.assignments ?? []) {
      const list = assignmentsByEntityKey.get(assignment.entityKey) ?? [];
      list.push(assignment);
      assignmentsByEntityKey.set(assignment.entityKey, list);
    }
    const replayDuplicateEntities = [...assignmentsByEntityKey.entries()].filter(([, list]) => list.length > 1);
    totals.duplicateClaimedEntityCount += replayDuplicateEntities.length;
    totals.duplicateEntityClaimCount += replayDuplicateEntities.reduce((sum, [, list]) => sum + list.length, 0);
    for (const [entityKey, list] of replayDuplicateEntities) {
      duplicateEntityClaims.push({
        replayId,
        entityKey,
        claimCount: list.length,
        claims: list.map((assignment) => ({
          rosterIndex: assignment.rosterIndex,
          champion: assignment.champion,
          teamPosition: assignment.teamPosition,
          score: assignment.score ?? null,
        })),
      });
    }

    for (const assignment of validation?.assignments ?? []) {
      const passKey = assignment.validation?.passes === true ? "passing" : "failing";
      const matchingMovementAssignment = (movement?.assignments ?? []).find((entry) => entry.rosterIndex === assignment.rosterIndex);
      const familyKey = matchingMovementAssignment?.familyKey ?? familyFromEntityKey(assignment.entityKey);
      const slotKey = familySlotKey(familyKey, matchingMovementAssignment?.slotIndex ?? "unknown");
      const roleStatusKey = `${assignment.teamPosition ?? "UNKNOWN"}:${passKey}`;
      const teamScore = matchingMovementAssignment?.scoreComponents?.teamScore;
      const entityScoreMargin = matchingMovementAssignment?.assignmentConfidence?.entityScoreMargin;
      if (Number.isFinite(teamScore) && Number.isFinite(entityScoreMargin) && teamScore >= 0.6 && entityScoreMargin >= 0.02) {
        addQualityGate(diagnosticQualityGates.geographyEntityMargin.counter, assignment.validation?.passes === true);
      }
      if (Number.isFinite(teamScore) && teamScore >= 0.65) {
        addQualityGate(diagnosticQualityGates.strongGeography.counter, assignment.validation?.passes === true);
      }
      addNumeric(confidenceByStatus[passKey].entityScoreMargin, matchingMovementAssignment?.assignmentConfidence?.entityScoreMargin);
      addNumeric(confidenceByStatus[passKey].participantScoreMargin, matchingMovementAssignment?.assignmentConfidence?.participantScoreMargin);
      const assignedOwnerRank = matchingMovementAssignment?.assignmentConfidence?.assignedOwnerRank;
      const rankBucket = Number.isInteger(assignedOwnerRank)
        ? (assignedOwnerRank === 1 ? "rank_1" : assignedOwnerRank <= 3 ? "rank_2_to_3" : "rank_4_plus")
        : "unknown";
      incrementNestedCounter(assignedOwnerRankByStatus, rankBucket, passKey);
      incrementNestedCounter(assignedByRoleAndStatus, assignment.teamPosition ?? "UNKNOWN", passKey);
      incrementNestedCounter(assignedByFamilyAndStatus, familyKey, passKey);
      incrementNestedCounter(assignedByFamilySlotAndStatus, slotKey, passKey);
      incrementNestedCounter(assignedByFamilySlotRoleAndStatus, slotKey, roleStatusKey);
    }

    for (const participant of movement?.unmatchedParticipants ?? []) {
      const role = participant.teamPosition ?? "UNKNOWN";
      unmatchedByRole.set(role, (unmatchedByRole.get(role) ?? 0) + 1);
      const topCandidate = participant.topRejectedEntityCandidates?.[0] ?? null;
      let topCandidateStatus = "missing";
      if (topCandidate) {
        if (topCandidate.assignedToOtherParticipant === true) {
          topCandidateStatus = "collision";
        } else if (topCandidate.belowMinimumAssignmentScore === true) {
          topCandidateStatus = "below_threshold";
        } else {
          topCandidateStatus = "unassigned_above_threshold";
        }
      }
      incrementNestedCounter(unmatchedTopCandidateByRole, role, topCandidateStatus);
      const topFamily = topCandidate?.familyKey ?? "none";
      incrementNestedCounter(topRejectedFamilyByRole, role, topFamily);
      incrementNestedCounter(topRejectedFamilySlotByRole, role, familySlotKey(topFamily, topCandidate?.slotIndex ?? "unknown"));
    }

    const assignedByEntityKey = new Map((movement?.assignments ?? []).map((assignment) => [assignment.entityKey, assignment]));
    const validationByRoster = new Map((validation?.assignments ?? []).map((assignment) => [assignment.rosterIndex, assignment]));
    const competitorsByEntityKey = new Map();
    for (const participant of movement?.unmatchedParticipants ?? []) {
      for (const candidate of (participant.topRejectedEntityCandidates ?? []).slice(0, 3)) {
        if (candidate.assignedToOtherParticipant !== true || !assignedByEntityKey.has(candidate.entityKey)) {
          continue;
        }
        const list = competitorsByEntityKey.get(candidate.entityKey) ?? [];
        list.push({
          champion: participant.champion,
          teamPosition: participant.teamPosition,
          score: candidate.score ?? null,
        });
        competitorsByEntityKey.set(candidate.entityKey, list);
      }
    }

    for (const [entityKey, competitors] of competitorsByEntityKey.entries()) {
      const assigned = assignedByEntityKey.get(entityKey);
      const assignedValidation = validationByRoster.get(assigned?.rosterIndex);
      const passKey = assignedValidation?.validation?.passes === true ? "passing" : "failing";
      incrementNestedCounter(collisionPressureByStatus, collisionPressureBucket(competitors.length), passKey);
      topCollisionHubs.push({
        replayId,
        entityKey,
        familyKey: assigned?.familyKey ?? familyFromEntityKey(entityKey),
        slotIndex: assigned?.slotIndex ?? null,
        assignedChampion: assigned?.champion ?? null,
        assignedTeamPosition: assigned?.teamPosition ?? null,
        assignedPassesValidation: assignedValidation?.validation?.passes ?? null,
        competitorCount: competitors.length,
        competitorRoles: Object.fromEntries(
          [...competitors.reduce((map, competitor) => {
            const role = competitor.teamPosition ?? "UNKNOWN";
            map.set(role, (map.get(role) ?? 0) + 1);
            return map;
          }, new Map()).entries()].sort(([left], [right]) => String(left).localeCompare(String(right))),
        ),
      });
    }

    for (const assignment of validation?.assignments ?? []) {
      const matchingMovementAssignment = (movement?.assignments ?? []).find((entry) => entry.rosterIndex === assignment.rosterIndex);
      if (!matchingMovementAssignment) {
        continue;
      }
      const teamScore = matchingMovementAssignment.scoreComponents?.teamScore;
      const entityScoreMargin = matchingMovementAssignment.assignmentConfidence?.entityScoreMargin;
      const assignedOwnerRank = matchingMovementAssignment.assignmentConfidence?.assignedOwnerRank;
      const competitorCount = competitorsByEntityKey.get(matchingMovementAssignment.entityKey)?.length ?? 0;
      const riskParts = [
        Number.isFinite(teamScore) && teamScore >= 0.6 ? "teamStrong" : "teamWeak",
        Number.isFinite(entityScoreMargin) && entityScoreMargin >= 0.02 ? "entityMarginStrong" : "entityMarginWeak",
        assignedOwnerRank === 1 ? "topOwner" : "nonTopOwner",
        competitorCount >= 7 ? "collision7Plus" : competitorCount >= 4 ? "collision4To6" : competitorCount >= 1 ? "collision1To3" : "collisionNone",
      ];
      incrementAssignmentRiskCounter(assignmentRiskMatrix, riskParts.join("|"), assignment.validation?.passes === true);
    }

    totals.replayCount += 1;
    totals.assignmentCount += assignmentCount;
    totals.matchedAssignmentCount += matchedAssignmentCount ?? 0;
    totals.passingAssignmentCount += passingAssignmentCount ?? 0;
    totals.expectedParticipantCount += 10;
    totals.unmatchedParticipantCount += unmatchedParticipantCount;
    totals.usesIdentityPriorsCount += usesIdentityPriors ? 1 : 0;
    totals.usesSupportHypothesesCount += usesSupportHypotheses === true ? 1 : 0;
    totals.unknownSupportHypothesesCount += usesSupportHypotheses == null ? 1 : 0;

    perReplay.push({
      replayId,
      status: "present",
      assignmentCount,
      matchedAssignmentCount,
      passingAssignmentCount,
      unmatchedParticipantCount,
      usesIdentityPriors,
      usesSupportHypotheses,
      averageAxisCorrelation: validation?.summary?.averageAxisCorrelation ?? null,
      averagePathCorrelation: validation?.summary?.averagePathCorrelation ?? null,
      averageNormalizedDistanceRmse: validation?.summary?.averageNormalizedDistanceRmse ?? null,
    });
  }

  const assignmentRate = totals.expectedParticipantCount
    ? totals.assignmentCount / totals.expectedParticipantCount
    : null;
  const passRatePerAssignment = totals.assignmentCount
    ? totals.passingAssignmentCount / totals.assignmentCount
    : null;
  const passRatePerExpectedParticipant = totals.expectedParticipantCount
    ? totals.passingAssignmentCount / totals.expectedParticipantCount
    : null;

  return {
    key: kind.key,
    label: kind.label,
    totals: {
      ...totals,
      assignmentRate,
      passRatePerAssignment,
      passRatePerExpectedParticipant,
      completeReplayCount: perReplay.filter((row) => row.assignmentCount === 10).length,
      perfectReplayCount: perReplay.filter((row) => row.assignmentCount === 10 && row.passingAssignmentCount === 10).length,
      assignedByRoleAndStatus: mapToSortedObject(assignedByRoleAndStatus),
      assignedByFamilyAndStatus: mapToSortedObject(assignedByFamilyAndStatus),
      assignedByFamilySlotAndStatus: mapToSortedObject(assignedByFamilySlotAndStatus),
      assignedByFamilySlotRoleAndStatus: mapToSortedObject(assignedByFamilySlotRoleAndStatus),
      unmatchedByRole: mapToSortedObject(unmatchedByRole),
      unmatchedTopCandidateByRole: mapToSortedObject(unmatchedTopCandidateByRole),
      topRejectedFamilyByRole: mapToSortedObject(topRejectedFamilyByRole),
      topRejectedFamilySlotByRole: mapToSortedObject(topRejectedFamilySlotByRole),
      assignmentConfidenceByStatus: Object.fromEntries(
        Object.entries(confidenceByStatus).map(([status, values]) => [
          status,
          {
            entityScoreMargin: finalizeNumeric(values.entityScoreMargin),
            participantScoreMargin: finalizeNumeric(values.participantScoreMargin),
          },
        ]),
      ),
      diagnosticQualityGates: Object.fromEntries(
        Object.entries(diagnosticQualityGates).map(([key, gate]) => [
          key,
          {
            description: gate.description,
            runtimeApiData: gate.runtimeApiData,
            minimumTeamScore: gate.minimumTeamScore,
            minimumEntityScoreMargin: gate.minimumEntityScoreMargin ?? null,
            ...finalizeQualityGate(gate.counter),
          },
        ]),
      ),
      collisionPressureByStatus: mapToSortedObject(collisionPressureByStatus),
      assignedOwnerRankByStatus: mapToSortedObject(assignedOwnerRankByStatus),
      assignmentRiskMatrix: mapRiskCountersToObject(assignmentRiskMatrix),
      topCollisionHubs: topCollisionHubs
        .sort((left, right) =>
          right.competitorCount - left.competitorCount ||
          String(left.replayId).localeCompare(String(right.replayId)) ||
          String(left.entityKey).localeCompare(String(right.entityKey)),
        )
        .slice(0, 20),
      duplicateEntityClaims: duplicateEntityClaims
        .sort((left, right) =>
          right.claimCount - left.claimCount ||
          String(left.replayId).localeCompare(String(right.replayId)) ||
          String(left.entityKey).localeCompare(String(right.entityKey)),
        )
        .slice(0, 20),
    },
    perReplay: perReplay.sort((left, right) =>
      (left.status === "missing") - (right.status === "missing") ||
      (left.passingAssignmentCount ?? -1) - (right.passingAssignmentCount ?? -1) ||
      (left.assignmentCount ?? -1) - (right.assignmentCount ?? -1) ||
      left.replayId.localeCompare(right.replayId),
    ),
  };
}

function buildSummary(args) {
  const replayIds = discoverReplayIds(args);
  return {
    schema: "movement-diagnostics-summary/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    artifactRoot: args.artifactRoot,
    replayListPath: args.replayListPath,
    replayCount: replayIds.length,
    diagnostics: Object.fromEntries(
      diagnosticKinds.map((kind) => [kind.key, summarizeKind(args.artifactRoot, replayIds, kind)]),
    ),
  };
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function printHuman(summary) {
  console.log(`movement diagnostics: version=${summary.versionGroup} replays=${summary.replayCount}`);
  for (const diagnostic of Object.values(summary.diagnostics)) {
    const totals = diagnostic.totals;
    console.log(
      `${diagnostic.label}: assigned=${totals.assignmentCount}/${totals.expectedParticipantCount} (${formatPercent(totals.assignmentRate)}) passing=${totals.passingAssignmentCount}/${totals.assignmentCount} (${formatPercent(totals.passRatePerAssignment)}) complete=${totals.completeReplayCount} perfect=${totals.perfectReplayCount} missing=${totals.missingReplayCount} priors=${totals.usesIdentityPriorsCount} support_hypotheses=${totals.usesSupportHypothesesCount}`,
    );
    if (totals.unknownSupportHypothesesCount > 0) {
      console.log(`  support_hypotheses_unknown=${totals.unknownSupportHypothesesCount}`);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const summary = buildSummary(args);
  if (args.outputPath) {
    fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
    fs.writeFileSync(args.outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  printHuman(summary);
}

main();
