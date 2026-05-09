#!/usr/bin/env node

import path from "path";
import fs from "fs";

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

const allowedCoverageStatuses = new Set([
  "decoded",
  "noisy",
  "unstable_identity",
  "duplicate_rejected",
  "not_found",
]);

const requiredCoverageStatusLegend = [
  "decoded",
  "noisy",
  "unstable_identity",
  "duplicate_rejected",
  "not_found",
];

const requiredApiLikeStats = [
  "puuid",
  "championName",
  "win",
  "allInPings",
  "kills",
  "deaths",
  "assists",
  "champLevel",
  "goldEarned",
  "goldSpent",
  "damageDealtToBuildings",
  "damageDealtToEpicMonsters",
  "damageDealtToObjectives",
  "damageDealtToTurrets",
  "physicalDamageDealt",
  "totalMinionsKilled",
  "neutralMinionsKilled",
  "magicDamageDealt",
  "trueDamageDealt",
  "totalDamageDealtToChampions",
  "totalDamageTaken",
  "totalUnitsHealed",
  "visionScore",
  "wardsPlaced",
  "wardsKilled",
  "spell1Casts",
  "spell2Casts",
  "spell3Casts",
  "spell4Casts",
  "summoner1Casts",
  "summoner2Casts",
  "teamEarlySurrendered",
  "teamIGNBSurrendered",
  "gameEndedInEarlySurrender",
  "gameEndedInSurrender",
  "gameEndedInIGNBSurrender",
  "challenges",
  "item0",
  "item1",
  "item2",
  "item3",
  "item4",
  "item5",
  "item6",
  "summoner1Id",
  "summoner2Id",
  "perks",
];

const minApiLikeStatsPerParticipant = 100;

const requiredFieldCoverage = {
  runtimeInputPolicy: "decoded",
  matchMetadata: "decoded",
  matchMetadataGaps: "not_found",
  matchParticipants: "decoded",
  matchParticipantGaps: "not_found",
  matchTeams: "decoded",
  matchTeamGaps: "not_found",
  timelineFinalParticipantFrames: "decoded",
  timelineNonFinalParticipantFrames: "not_found",
  timelineNonFinalParticipantIdentity: "not_promoted",
  timelineEvents: "not_found",
  positions: "not_found",
  inventoryTimeline: "not_found",
  damageTimeline: "not_found",
  offlineRiotValidation: "validation-only",
};

const finalTimelineMetricPaths = new Map([
  ["totalGold", ["totalGold"]],
  ["level", ["level"]],
  ["xp", ["xp"]],
  ["minionsKilled", ["minionsKilled"]],
  ["jungleMinionsKilled", ["jungleMinionsKilled"]],
]);

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    replayId: null,
    inputPath: null,
    requireTimelineSeries: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--allow-empty-timeline") {
      args.requireTimelineSeries = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.replayId && !args.inputPath) {
    throw new Error("Either --replay-id or --input-path is required.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/verify_rofl_api_metrics.mjs --replay-id <id> [--artifact-root artifacts-keyframes] [--input-path <path>] [--allow-empty-timeline]");
}

function assert(condition, message, details = null) {
  if (!condition) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

function countFrameMetrics(frames) {
  return frames.reduce(
    (sum, frame) => sum + Object.values(frame.participantFrames ?? {}).reduce(
      (inner, participantFrame) => inner +
        Object.entries(participantFrame)
          .filter(([key, value]) => key !== "championStats" && key !== "damageStats" && key !== "participantId" && value != null && typeof value !== "object")
          .length +
        Object.values(participantFrame.championStats ?? {}).filter((value) => value != null).length,
      0,
    ),
    0,
  );
}

function getNested(value, pathParts) {
  return pathParts.reduce((cursor, key) => cursor?.[key], value);
}

function parseReplayGameId(replayId) {
  const idPart = String(replayId ?? "").split("-").at(-1);
  const parsed = Number.parseInt(idPart, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseReplayPlatformId(replayId) {
  const platformId = String(replayId ?? "").split("-")[0];
  return platformId || null;
}

function assertNoRuntimeRiotApiPath(value, pathParts = []) {
  if (typeof value === "string") {
    const normalized = value.replaceAll("\\", "/").toLowerCase();
    assert(!normalized.includes("replays/api/"), "Artifact contains a Riot API fixture path in runtime source data", {
      path: pathParts.join("."),
      value,
    });
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    assertNoRuntimeRiotApiPath(child, [...pathParts, key]);
  }
}

function verifyFieldCoverage(artifact) {
  const fieldCoverage = artifact.fieldCoverage ?? {};
  const rowIdentityArtifacts = artifact.rejectedCandidateArtifacts?.reconstructionRowIdentity?.rowIdentityArtifacts ?? [];
  for (const [key, status] of Object.entries(requiredFieldCoverage)) {
    assert(fieldCoverage[key]?.status === status, "Field coverage entry is missing or has unexpected status", {
      key,
      expectedStatus: status,
      actual: fieldCoverage[key],
    });
  }
  assert(fieldCoverage.runtimeInputPolicy?.source === "rofl-only", "Runtime input policy coverage must be ROFL-only", {
    runtimeInputPolicy: fieldCoverage.runtimeInputPolicy,
  });
  assert(fieldCoverage.matchParticipants?.source === "rofl-metadata-statsJson", "Match participant coverage must identify statsJson as source", {
    matchParticipants: fieldCoverage.matchParticipants,
  });
  assert((fieldCoverage.matchMetadataGaps?.fields ?? []).includes("info.queueId"), "Match metadata gaps must include missing Riot queue/map/mode fields", {
    matchMetadataGaps: fieldCoverage.matchMetadataGaps,
  });
  assert((fieldCoverage.matchMetadataGaps?.inspectedSources ?? []).includes("summary.metadataJson"), "Match metadata gaps must record inspected ROFL metadata sources", {
    matchMetadataGaps: fieldCoverage.matchMetadataGaps,
  });
  assert((fieldCoverage.matchMetadataGaps?.availableMetadataJsonFields ?? []).includes("statsJson"), "Match metadata gaps must record available decoded metadataJson fields", {
    matchMetadataGaps: fieldCoverage.matchMetadataGaps,
  });
  assert(typeof fieldCoverage.matchMetadataGaps?.reason === "string" && fieldCoverage.matchMetadataGaps.reason.includes("not Riot queue/map/mode"), "Match metadata gaps must explain why Riot metadata fields remain missing", {
    matchMetadataGaps: fieldCoverage.matchMetadataGaps,
  });
  for (const field of [
    "info.gameCreation",
    "info.gameEndTimestamp",
    "info.gameMode",
    "info.gameName",
    "info.gameStartTimestamp",
    "info.gameType",
    "info.mapId",
    "info.queueId",
    "info.tournamentCode",
  ]) {
    assert((fieldCoverage.matchMetadataGaps?.apiShapedNotFoundFields ?? []).includes(field), "Match metadata gaps must mark API-shaped unresolved fields", {
      field,
      matchMetadataGaps: fieldCoverage.matchMetadataGaps,
    });
    assert(artifact.roflDerivedFieldMap?.match?.[field]?.status === "not_found", "Field map must keep unresolved match metadata out of decoded parity", {
      field,
      fieldMap: artifact.roflDerivedFieldMap?.match?.[field],
    });
    const infoKey = field.replace("info.", "");
    assert(Object.hasOwn(artifact.match?.info ?? {}, infoKey) && artifact.match.info[infoKey] === null, "Match info must emit unresolved metadata as API-shaped null", {
      field,
      value: artifact.match?.info?.[infoKey],
    });
  }
  assert(fieldCoverage.matchParticipants?.participantCount === 10, "Match participant field coverage must report 10 participants", {
    matchParticipants: fieldCoverage.matchParticipants,
  });
  assert(!(fieldCoverage.matchParticipantGaps?.fields ?? []).includes("info.participants[].lane"), "Match participant gaps must not include promoted lane field", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert(!(fieldCoverage.matchParticipantGaps?.fields ?? []).includes("info.participants[].role"), "Match participant gaps must not include promoted role field", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert(!(fieldCoverage.matchParticipantGaps?.fields ?? []).includes("info.participants[].timePlayed"), "Match participant gaps must not include promoted timePlayed field", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert((fieldCoverage.matchParticipantGaps?.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].firstBloodKill" && entry.status === "not_found"), "Match participant gaps must document event-derived first blood gap", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert((fieldCoverage.matchParticipantGaps?.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].profileIcon" && entry.status === "not_found"), "Match participant gaps must document missing profile icon source", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert((fieldCoverage.matchParticipantGaps?.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].championId" && entry.status === "not_promoted"), "Match participant gaps must document unpromoted championId mapping", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  assert((fieldCoverage.matchParticipantGaps?.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].eligibleForProgression" && entry.status === "not_promoted"), "Match participant gaps must not promote eligibleForProgression without a ROFL source", {
    matchParticipantGaps: fieldCoverage.matchParticipantGaps,
  });
  for (const field of [
    "info.participants[].championId",
    "info.participants[].eligibleForProgression",
    "info.participants[].firstBloodAssist",
    "info.participants[].firstBloodKill",
    "info.participants[].firstTowerAssist",
    "info.participants[].firstTowerKill",
    "info.participants[].profileIcon",
    "info.participants[].summonerLevel",
  ]) {
    assert((fieldCoverage.matchParticipantGaps?.apiShapedNotFoundFields ?? []).includes(field), "Match participant gaps must mark API-shaped unresolved fields", {
      field,
      matchParticipantGaps: fieldCoverage.matchParticipantGaps,
    });
    assert(["not_found", "not_promoted"].includes(artifact.roflDerivedFieldMap?.match?.[field]?.status), "Field map must keep unresolved participant fields out of decoded parity", {
      field,
      fieldMap: artifact.roflDerivedFieldMap?.match?.[field],
    });
  }
  assert((artifact.match?.info?.participants ?? []).every((participant) =>
    participant.championId === null &&
    participant.eligibleForProgression === null &&
    participant.firstBloodAssist === null &&
    participant.firstBloodKill === null &&
    participant.firstTowerAssist === null &&
    participant.firstTowerKill === null &&
    participant.profileIcon === null &&
    participant.summonerLevel === null
  ), "API-shaped unresolved match participant fields must remain null", {
    participants: artifact.match?.info?.participants,
  });
  assert((fieldCoverage.matchTeamGaps?.fields ?? []).includes("info.teams[].bans[].championId"), "Match team gaps must include missing pick/ban data", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert((fieldCoverage.matchTeamGaps?.fields ?? []).includes("info.teams[].objectives.dragon.first"), "Match team gaps must include missing first-objective fields", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert((fieldCoverage.matchTeamGaps?.apiShapedNotFoundFields ?? []).includes("info.teams[].objectives.*.first"), "Match team gaps must mark API-shaped first-objective fields as not_found", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert((fieldCoverage.matchTeamGaps?.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].championId"), "Match team gaps must mark API-shaped ban champion IDs as not_found", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert((fieldCoverage.matchTeamGaps?.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].pickTurn"), "Match team gaps must mark API-shaped ban pick turns as not_found", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert((fieldCoverage.matchTeamGaps?.decodedTeamFields ?? []).includes("info.teams[].objectives.*.kills"), "Match team gaps must distinguish decoded objective kill counts from missing first-objective fields", {
    matchTeamGaps: fieldCoverage.matchTeamGaps,
  });
  assert(artifact.roflDerivedFieldMap?.match?.["info.teams[].objectives.*.first"]?.status === "not_found", "Field map must mark first-objective fields as not_found", {
    fieldMap: artifact.roflDerivedFieldMap?.match?.["info.teams[].objectives.*.first"],
  });
  assert(artifact.roflDerivedFieldMap?.match?.["info.teams[].bans"]?.status === "not_found", "Field map must mark team bans as not_found", {
    fieldMap: artifact.roflDerivedFieldMap?.match?.["info.teams[].bans"],
  });
  assert((artifact.match?.info?.teams ?? []).every((team) =>
    (team.bans ?? []).length === 5 &&
    team.bans.every((ban) => ban.championId === null && ban.pickTurn === null)
  ), "API-shaped team bans must include null fields until ROFL pick/ban source is decoded", {
    teams: artifact.match?.info?.teams,
  });
  assert((artifact.match?.info?.teams ?? []).every((team) =>
    Object.values(team.objectives ?? {}).every((objective) => Object.hasOwn(objective, "first") && objective.first === null)
  ), "API-shaped team objectives must include null first fields until ROFL event-order source is decoded", {
    teams: artifact.match?.info?.teams,
  });
  assert(fieldCoverage.matchParticipantChallenges?.status === "partial", "Match challenge coverage must be explicitly partial", {
    matchParticipantChallenges: fieldCoverage.matchParticipantChallenges,
  });
  assert((fieldCoverage.matchParticipantChallenges?.decodedFields ?? []).includes("participants[].challenges.turretTakedowns"), "Match challenge coverage must name decoded ROFL challenge fields", {
    matchParticipantChallenges: fieldCoverage.matchParticipantChallenges,
  });
  assert((fieldCoverage.matchParticipantChallenges?.apiShapedNotFoundFields ?? []).length >= 120, "Match challenge coverage must list API-shaped unresolved challenge leaves", {
    matchParticipantChallenges: fieldCoverage.matchParticipantChallenges,
  });
  assert(artifact.roflDerivedFieldMap?.match?.["info.participants[].challenges.*"]?.status === "not_found", "Field map must keep unresolved challenge leaves out of decoded parity", {
    fieldMap: artifact.roflDerivedFieldMap?.match?.["info.participants[].challenges.*"],
  });
  assert((artifact.match?.info?.participants ?? []).every((participant) =>
    participant.challenges?.turretTakedowns != null &&
    Object.keys(participant.challenges ?? {}).length >= 126 &&
    Object.entries(participant.challenges ?? {})
      .filter(([key]) => key !== "turretTakedowns")
      .every(([key, value]) => value === null || (key === "legendaryItemUsed" && Array.isArray(value) && value.every((entry) => entry === null)))
  ), "Match participants must emit unresolved challenge leaves as API-shaped nulls while preserving promoted turretTakedowns", {
    sample: artifact.match?.info?.participants?.[0]?.challenges,
  });
  assert((fieldCoverage.matchParticipantChallenges?.gaps ?? []).length > 0, "Match challenge coverage must describe remaining challenge gaps", {
    matchParticipantChallenges: fieldCoverage.matchParticipantChallenges,
  });
  assert(fieldCoverage.timelineFinalParticipantFrames?.participantCount === 10, "Final timeline participant frame coverage must report 10 participants", {
    timelineFinalParticipantFrames: fieldCoverage.timelineFinalParticipantFrames,
  });
  assert((fieldCoverage.timelineFinalParticipantFrames?.metrics ?? []).length >= 5, "Final timeline participant frame coverage is missing decoded metrics", {
    timelineFinalParticipantFrames: fieldCoverage.timelineFinalParticipantFrames,
  });
  assert(fieldCoverage.timelineNonFinalParticipantFrames?.reconstructionDirection?.model === "keyframe-baseline-plus-chunk-deltas", "Non-final timeline coverage must document the keyframe plus chunk-delta reconstruction direction", {
    timelineNonFinalParticipantFrames: fieldCoverage.timelineNonFinalParticipantFrames,
  });
  assert(fieldCoverage.timelineNonFinalParticipantIdentity?.source === "chunk-row-identity-gates", "Non-final participant identity coverage must point at chunk row identity gates", {
    timelineNonFinalParticipantIdentity: fieldCoverage.timelineNonFinalParticipantIdentity,
  });
  assert(fieldCoverage.timelineNonFinalParticipantIdentity?.runtimeInput === false, "Non-final participant identity coverage must be marked non-runtime", {
    timelineNonFinalParticipantIdentity: fieldCoverage.timelineNonFinalParticipantIdentity,
  });
  for (const familyKey of ["241-0x02", "241-0x04"]) {
    const family = (fieldCoverage.timelineNonFinalParticipantIdentity?.candidateFamilies ?? []).find((entry) => entry.familyKey === familyKey);
    const rejectedFamily = rowIdentityArtifacts.find((entry) => entry.familyKey === familyKey);
    assert(family?.promotionStatus === "not_promoted" && family?.expectedRowCount === 10, "Non-final participant identity coverage must summarize rejected 241-family gates", {
      familyKey,
      timelineNonFinalParticipantIdentity: fieldCoverage.timelineNonFinalParticipantIdentity,
    });
    assert(rejectedFamily != null, "Rejected candidate artifacts must include row identity evidence for every coverage family", {
      familyKey,
      rowIdentityArtifacts,
    });
    assert(family.expectedRowCount === rejectedFamily.rowCount, "Non-final participant identity coverage row count must match rejected candidate evidence", {
      family,
      rejectedFamily,
    });
    assert(family.promotionStatus === rejectedFamily.promotionStatus, "Non-final participant identity coverage promotion status must match rejected candidate evidence", {
      family,
      rejectedFamily,
    });
    assert(JSON.stringify(family.rowStatuses ?? []) === JSON.stringify(Object.keys(rejectedFamily.rowStatusCounts ?? {}).sort()), "Non-final participant identity coverage row statuses must match rejected candidate evidence", {
      family,
      rejectedFamily,
    });
    assert((family.rowStatuses ?? []).includes("unstable_identity"), "Non-final participant identity coverage must preserve unstable row status evidence", {
      familyKey,
      family,
    });
  }
  assert(fieldCoverage.timelineEvents?.source === "chunk-delta-events-not-extracted", "Timeline event coverage must point at chunk-delta event extraction", {
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert((fieldCoverage.timelineEvents?.apiShapedNotFoundFields ?? []).length === 70, "Timeline event coverage must enumerate the remaining API event leaf gap", {
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert(fieldCoverage.timelineEvents?.runtimeEmission === "empty-events-arrays", "Timeline event coverage must document why fake null event objects are not emitted", {
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert(fieldCoverage.timelineEvents?.rejectedItemEventEvidence?.candidateCount === artifact.rejectedCandidateArtifacts?.itemEvents?.candidateArtifact?.candidateCount, "Timeline event coverage must mirror rejected item-event candidate counts", {
    timelineEvents: fieldCoverage.timelineEvents,
    itemEvents: artifact.rejectedCandidateArtifacts?.itemEvents,
  });
  assert(fieldCoverage.timelineEvents?.eventFamilyCorrelation?.status === "not_promoted" &&
    fieldCoverage.timelineEvents?.eventFamilyCorrelation?.runtimeApiData === false &&
    fieldCoverage.timelineEvents?.eventFamilyCorrelation?.selectedIntervalCount === 40 &&
    (fieldCoverage.timelineEvents?.eventFamilyCorrelation?.selectedFamilyKeys ?? []).includes("241-0x02") &&
    (fieldCoverage.timelineEvents?.eventFamilyCorrelation?.topCorrelations ?? []).length > 0,
    "Timeline event coverage must include offline event-family correlation diagnostics without promoting them", {
      timelineEvents: fieldCoverage.timelineEvents,
    });
  assert((artifact.timeline?.info?.frames ?? []).every((frame) => Array.isArray(frame.events) && frame.events.length === 0), "Timeline frames must keep events empty until ROFL event decoding exists", {
    frames: artifact.timeline?.info?.frames,
  });
  assert(fieldCoverage.positions?.source === "state-reconstruction-not-extracted-for-16.9", "Position coverage must point at state reconstruction as the missing extraction layer", {
    positions: fieldCoverage.positions,
  });
  assert((fieldCoverage.positions?.perParticipantCoverage ?? []).length === 10, "Position coverage must report per-participant movement status for all 10 participants when movement evidence exists", {
    positions: fieldCoverage.positions,
  });
  assert((fieldCoverage.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "not_found"), "Position coverage must preserve unmatched participant status", {
    positions: fieldCoverage.positions,
  });
  assert((fieldCoverage.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "noisy"), "Position coverage must preserve noisy movement candidate status", {
    positions: fieldCoverage.positions,
  });
  assert((fieldCoverage.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "unstable_identity"), "Position coverage must preserve unstable movement identity status", {
    positions: fieldCoverage.positions,
  });
  const positionStatusCounts = (fieldCoverage.positions?.perParticipantCoverage ?? []).reduce((counts, entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }, {});
  assert(JSON.stringify(positionStatusCounts) === JSON.stringify(fieldCoverage.positions?.statusCounts ?? {}), "Position coverage statusCounts must match per-participant entries", {
    computed: positionStatusCounts,
    positions: fieldCoverage.positions,
  });
  assert(JSON.stringify(fieldCoverage.positions?.perParticipantCoverage ?? []) === JSON.stringify(artifact.rejectedCandidateArtifacts?.positions?.perParticipantCoverage ?? []), "Position field coverage must mirror rejected position candidate per-participant evidence", {
    fieldCoverage: fieldCoverage.positions,
    rejectedPositions: artifact.rejectedCandidateArtifacts?.positions,
  });
  assert(JSON.stringify(fieldCoverage.positions?.noPriorsDiagnostic ?? null) === JSON.stringify(artifact.rejectedCandidateArtifacts?.positions?.noPriorsDiagnostic ?? null), "Position field coverage must mirror no-priors diagnostic evidence", {
    fieldCoverage: fieldCoverage.positions,
    rejectedPositions: artifact.rejectedCandidateArtifacts?.positions,
  });
  for (const field of [
    "info.frames[].participantFrames[].championStats.*",
    "info.frames[].participantFrames[].currentGold",
    "info.frames[].participantFrames[].goldPerSecond",
    "info.frames[].participantFrames[].position.x",
    "info.frames[].participantFrames[].position.y",
    "info.frames[].participantFrames[].timeEnemySpentControlled",
  ]) {
    assert((fieldCoverage.timelineNonFinalParticipantFrames?.apiShapedNotFoundFields ?? []).includes(field), "Timeline participant frame gaps must mark API-shaped unresolved fields", {
      field,
      timelineNonFinalParticipantFrames: fieldCoverage.timelineNonFinalParticipantFrames,
    });
  }
  const timelineParticipantFrames = Object.values(artifact.timeline?.info?.frames?.at(-1)?.participantFrames ?? {});
  assert(timelineParticipantFrames.every((frame) =>
    frame.currentGold === null &&
    frame.goldPerSecond === null &&
    frame.timeEnemySpentControlled === null &&
    frame.position?.x === null &&
    frame.position?.y === null
  ), "Final timeline participant frames must emit unresolved scalar/position fields as API-shaped nulls", {
    sample: timelineParticipantFrames[0],
  });
  assert(timelineParticipantFrames.every((frame) =>
    Object.keys(frame.championStats ?? {}).length >= 25 &&
    Object.values(frame.championStats ?? {}).every((value) => value === null)
  ), "Final timeline championStats must be API-shaped null leaves until decoded", {
    sample: timelineParticipantFrames[0]?.championStats,
  });
  assert(fieldCoverage.inventoryTimeline?.source === "not-extracted", "Inventory timeline coverage must remain not-extracted", {
    inventoryTimeline: fieldCoverage.inventoryTimeline,
  });
  assert(JSON.stringify(fieldCoverage.inventoryTimeline?.rejectedCandidateEvidence ?? null) === JSON.stringify(artifact.rejectedCandidateArtifacts?.inventoryTimeline?.relatedCandidateArtifact ?? null), "Inventory timeline coverage must mirror rejected inventory candidate evidence", {
    inventoryTimeline: fieldCoverage.inventoryTimeline,
    rejectedInventoryTimeline: artifact.rejectedCandidateArtifacts?.inventoryTimeline,
  });
  assert(fieldCoverage.inventoryTimeline?.runtimeInput === false, "Inventory timeline coverage must be non-runtime", {
    inventoryTimeline: fieldCoverage.inventoryTimeline,
  });
  assert(fieldCoverage.offlineRiotValidation?.runtimeInput === false, "Offline Riot validation must be marked as non-runtime input", {
    offlineRiotValidation: fieldCoverage.offlineRiotValidation,
  });
  assert(fieldCoverage.offlineRiotValidation?.source === "riot-api-fixtures", "Offline Riot validation source must avoid fixture paths", {
    offlineRiotValidation: fieldCoverage.offlineRiotValidation,
  });
}

function verifyCoverageStatusLegend(artifact) {
  const legend = artifact.coverageStatusLegend ?? {};
  for (const status of requiredCoverageStatusLegend) {
    assert(typeof legend[status] === "string" && legend[status].length > 0, "Coverage status legend is missing a required status", {
      status,
      legend,
    });
  }
  const undocumentedStatuses = Object.keys(legend).filter((status) => !allowedCoverageStatuses.has(status));
  assert(undocumentedStatuses.length === 0, "Coverage status legend contains unsupported statuses", {
    undocumentedStatuses,
  });
}

function verifyParityChecklist(artifact) {
  const checklist = artifact.parityChecklist ?? [];
  assert(Array.isArray(checklist) && checklist.length >= 10, "Parity checklist is missing or too small", {
    checklistLength: checklist.length,
  });
  const byRequirement = new Map(checklist.map((entry) => [entry.requirement, entry]));
  const fullParity = byRequirement.get("Full API data parity from ROFL-only extraction.");
  assert(fullParity?.status === "not_satisfied", "Artifact must not claim full API parity while known gaps remain", {
    fullParity,
  });
  const fullParityGaps = new Set(fullParity?.gaps ?? []);
  for (const gap of [
    "non-stats match metadata",
    "non-final participant identity",
    "non-final scalar calibration",
    "true Riot API PUUID identity parity",
    "positions",
    "timeline events",
    "inventory timeline",
    "damage timeline",
  ]) {
    assert(fullParityGaps.has(gap), "Full parity checklist is missing a known gap", {
      gap,
      fullParity,
    });
  }
  const remainingParityGaps = artifact.remainingParityGaps ?? [];
  assert(Array.isArray(remainingParityGaps) && remainingParityGaps.length >= 5, "Artifact must include a compact machine-readable remainingParityGaps table", {
    remainingParityGaps,
  });
  const remainingGapByKey = new Map(remainingParityGaps.map((entry) => [entry.key, entry]));
  for (const key of [
    "nonFinalParticipantIdentity",
    "positions",
    "timelineEvents",
    "inventoryTimeline",
    "damageTimeline",
  ]) {
    const entry = remainingGapByKey.get(key);
    assert(entry && entry.runtimeApiData === false && typeof entry.nextDecoderStep === "string" && entry.nextDecoderStep.length > 0, "remainingParityGaps entry must be explicit and non-runtime", {
      key,
      entry,
    });
  }
  assert((remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("9/10")), "remainingParityGaps.positions must preserve movement assignment blocker", {
    positions: remainingGapByKey.get("positions"),
  });
  assert((remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("no-priors") && String(blocker).includes("8/10")), "remainingParityGaps.positions must preserve no-priors replay-only assignment blocker", {
    positions: remainingGapByKey.get("positions"),
  });
  for (const evidenceRef of [
    "rejectedCandidateArtifacts.positions.noPriorsDiagnostic",
    "fieldCoverage.positions.noPriorsDiagnostic",
    "artifactManifest.decoderDiagnostics.replay-only-no-priors-position-diagnostic",
    "artifactManifest.decoderDiagnostics.offline-no-priors-position-validation-diagnostic",
  ]) {
    assert((remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes(evidenceRef), `remainingParityGaps.positions must reference ${evidenceRef}`, {
      positions: remainingGapByKey.get("positions"),
    });
  }
  assert((remainingGapByKey.get("timelineEvents")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")), "remainingParityGaps.timelineEvents must preserve rejected item-event candidate count", {
    timelineEvents: remainingGapByKey.get("timelineEvents"),
  });
  assert((remainingGapByKey.get("inventoryTimeline")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")), "remainingParityGaps.inventoryTimeline must mirror rejected inventory candidate evidence", {
    inventoryTimeline: remainingGapByKey.get("inventoryTimeline"),
  });
  const proof = artifact.roflOnlyExtractionProof ?? {};
  assert(proof.proofSchema === "rofl-only-extraction-proof/v1", "Artifact must include a versioned ROFL-only extraction proof", {
    proof,
  });
  assert(proof.runtimeInputPolicy?.riotApiRuntimeInput === false &&
    proof.runtimeInputPolicy?.replayFileRequired === true &&
    proof.runtimeInputPolicy?.supervisedFixtureRole === "offline-validation-only",
    "ROFL-only extraction proof must explicitly separate runtime replay input from offline fixtures", {
      runtimeInputPolicy: proof.runtimeInputPolicy,
    });
  assert(proof.apiShapeProof?.status === "partial" &&
    proof.apiShapeProof?.runtimeInput === false &&
    proof.apiShapeProof?.matchShape?.status === "api_shaped" &&
    proof.apiShapeProof?.matchShape?.missingLeafPathCount === 0 &&
    proof.apiShapeProof?.matchShape?.offlineShapeGapMatchedLeafPathCount === 342 &&
    proof.apiShapeProof?.timelineShape?.status === "partial" &&
    proof.apiShapeProof?.timelineShape?.missingLeafPathCount === 70 &&
    proof.apiShapeProof?.timelineShape?.runtimeEmission === "empty-events-arrays" &&
    (proof.apiShapeProof?.timelineShape?.missingLeafPaths ?? []).length === 70 &&
    proof.apiShapeProof?.fullApiShapeParity === false,
    "ROFL-only extraction proof must summarize match/timeline API shape parity and the remaining timeline event shape gap", {
      apiShapeProof: proof.apiShapeProof,
    });
  const proofBySurface = new Map((proof.decodedFromRoflOnly ?? []).map((entry) => [entry.surface, entry]));
  assert(proofBySurface.get("match.info.participants")?.participantCount === 10, "ROFL-only extraction proof must cover all 10 match participants", {
    decodedFromRoflOnly: proof.decodedFromRoflOnly,
  });
  assert(proofBySurface.get("timeline.info.frames[-1].participantFrames final scalar metrics")?.metricPointCount === 50, "ROFL-only extraction proof must count final scalar timeline points", {
    decodedFromRoflOnly: proof.decodedFromRoflOnly,
  });
  assert(proofBySurface.get("timeline.info.frames[-1].participantFrames final damageStats")?.metricPointCount === 120, "ROFL-only extraction proof must count final damageStats points", {
    decodedFromRoflOnly: proof.decodedFromRoflOnly,
  });
  assert((proof.perParticipantProof ?? []).length === 10 &&
    (proof.perParticipantProof ?? []).every((entry) =>
      Number.isInteger(entry.participantId) &&
      entry.participantId >= 1 &&
      entry.participantId <= 10 &&
      entry.source === "rofl-metadata-statsJson" &&
      entry.participantIdentity === "rofl-summary-roster-order" &&
      entry.runtimeApiData === true &&
      entry.finalScalarMetricCount === 5 &&
      entry.finalDamageMetricCount === 12 &&
      (entry.unresolvedRuntimeFields ?? []).includes("position") &&
      (entry.unresolvedRuntimeFields ?? []).includes("currentGold") &&
      (entry.unresolvedRuntimeFields ?? []).includes("goldPerSecond") &&
      (entry.unresolvedRuntimeFields ?? []).includes("timeEnemySpentControlled") &&
      (entry.unresolvedRuntimeFields ?? []).includes("championStats")
    ),
    "ROFL-only extraction proof must include per-participant decoded/gap evidence for all 10 participants", {
      perParticipantProof: proof.perParticipantProof,
    });
  assert((proof.offlineValidationOnly ?? []).length >= 3 &&
    (proof.offlineValidationOnly ?? []).every((entry) => entry.runtimeInput === false),
    "ROFL-only extraction proof must mark validation reports offline-only", {
      offlineValidationOnly: proof.offlineValidationOnly,
    });
  assert((proof.remainingGapKeys ?? []).includes("positions") &&
    (proof.remainingGapKeys ?? []).includes("timelineEvents"),
    "ROFL-only extraction proof must link to remaining parity gaps", {
      remainingGapKeys: proof.remainingGapKeys,
    });
  assert(JSON.stringify([...(proof.remainingGapKeys ?? [])].sort()) === JSON.stringify([...remainingGapByKey.keys()].sort()), "ROFL-only extraction proof remainingGapKeys must match remainingParityGaps keys", {
    remainingGapKeys: proof.remainingGapKeys,
    remainingParityGapKeys: [...remainingGapByKey.keys()],
  });
  const proofPositionCandidate = (proof.notPromotedRuntimeCandidates ?? []).find((entry) => entry.surface === "position x/y movement tracks");
  assert(proofPositionCandidate?.runtimeInput === false &&
    proofPositionCandidate?.runtimeApiData === false &&
    proofPositionCandidate?.assignedParticipantCount === 9 &&
    proofPositionCandidate?.expectedParticipantCount === 10 &&
    proofPositionCandidate?.offlinePassingAssignmentCount === 7 &&
    proofPositionCandidate?.noPriorsAssignedParticipantCount === 8 &&
    proofPositionCandidate?.noPriorsOfflinePassingAssignmentCount === 7,
    "ROFL-only extraction proof must summarize rejected position candidate counts", {
      proofPositionCandidate,
    });
  const runtimePolicy = byRequirement.get("Runtime extraction does not use Riot API data.");
  assert(runtimePolicy?.status === "satisfied", "Parity checklist must mark runtime Riot API exclusion satisfied", {
    runtimePolicy,
  });
  const tenParticipants = byRequirement.get("Include all 10 participants from ROFL metadata/statsJson.");
  assert(tenParticipants?.status === "satisfied", "Parity checklist must mark 10 participant extraction satisfied", {
    tenParticipants,
  });
  const timeline = byRequirement.get("Emit API-shaped timeline data where decoded.");
  assert(timeline?.status === "partial" && (timeline.gaps ?? []).length > 0, "Timeline checklist must remain partial with explicit gaps", {
    timeline,
  });
  const identity = byRequirement.get("Improve replay-only participant identity linkage using ROFL-only evidence.");
  assert(identity?.status === "partial", "Identity checklist must remain partial until non-final replay-only identity is accepted", {
    identity,
  });
  for (const evidence of [
    "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.metricSet=conservative",
    "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.thresholds",
    "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.diagnostics",
    "rejectedCandidateArtifacts.reconstructionRowIdentity.status=not_promoted",
    "rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridCandidateScan.status=candidate_scan_only_not_runtime_api_data",
    "rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridFieldAnalysis.status=field_hypothesis_only_not_runtime_api_data",
    "fieldCoverage.timelineNonFinalParticipantIdentity.status=not_promoted",
  ]) {
    assert((identity.evidence ?? []).includes(evidence), "Identity checklist is missing concrete non-final scalar evidence", {
      evidence,
      identity,
    });
  }
  const filtering = byRequirement.get("Filter noisy candidates and avoid exposing low-confidence affine artifacts as real API data.");
  assert((filtering?.evidence ?? []).includes("weak per-metric supports are filtered by minSupportScore before edge creation"), "Filtering checklist must mention metric-specific support gates", {
    filtering,
  });
  assert((filtering?.evidence ?? []).includes("241-family row identity gates keep duplicate_rejected/unstable_identity rows out of runtime participantFrames"), "Filtering checklist must mention rejected 241 row identity gates", {
    filtering,
  });
  const docs = byRequirement.get("Document what still does not match Riot API parity.");
  assert((docs?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity"), "Documentation checklist must mention reconstruction row identity rejection evidence", {
    docs,
  });
  const verification = byRequirement.get("Add verification that proves ROFL-only fields and remaining gaps.");
  assert((verification?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity cross-checks rejectedCandidateArtifacts.reconstructionRowIdentity"), "Verification checklist must mention row identity field coverage cross-checks", {
    verification,
  });
}

function verifyRejectedCandidateArtifacts(artifact) {
  const rejected = artifact.rejectedCandidateArtifacts ?? {};
  const nonFinalScalarIdentity = rejected.nonFinalScalarIdentity;
  assert(nonFinalScalarIdentity != null, "Artifact must include non-final scalar identity candidate evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(["not_found", "rejected_for_runtime"].includes(nonFinalScalarIdentity.status), "Non-final scalar identity evidence has an unsupported status", {
    nonFinalScalarIdentity,
  });
  if (nonFinalScalarIdentity.assignmentArtifact?.exists) {
    assert(Number.isFinite(nonFinalScalarIdentity.assignmentArtifact.assignmentCount), "Non-final scalar identity evidence must include assignment counts", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.thresholds != null, "Non-final scalar identity evidence must include replay-only acceptance thresholds", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.thresholds.maxFinalTargetDuplicateCount === 1, "Non-final scalar identity evidence must reject duplicated final-stat anchors by default", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.metricSet === "conservative", "Default non-final scalar identity evidence must use the conservative replay-only metric set", {
      nonFinalScalarIdentity,
    });
    assert(Array.isArray(nonFinalScalarIdentity.assignmentArtifact.allowedMetrics) && nonFinalScalarIdentity.assignmentArtifact.allowedMetrics.length > 0, "Non-final scalar identity evidence must list allowed replay-only metrics", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.diagnostics != null, "Non-final scalar identity evidence must include diagnostic totals", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.metricSupportQuality != null, "Non-final scalar identity evidence must include per-metric support quality", {
      nonFinalScalarIdentity,
    });
    for (const key of [
      "slotMetricValueCountsByMetric",
      "comparedMetricCountsByMetric",
      "positiveMetricScoreCountsByMetric",
      "supportBelowMetricScoreCountsByMetric",
      "topWeakSupportExamplesByMetric",
      "acceptedEdgeSupportCountsByMetric",
      "ambiguousFinalTargetSupportCountsByMetric",
      "ambiguousFinalTargetRejectedSupportCountsByMetric",
      "duplicateFinalTargetValueCountsByMetric",
      "duplicateFinalTargetParticipantCountsByMetric",
      "duplicateFinalTargetExamplesByMetric",
    ]) {
      assert(nonFinalScalarIdentity.assignmentArtifact.diagnostics[key] != null, `Non-final scalar identity diagnostics must include ${key}`, {
        nonFinalScalarIdentity,
      });
    }
    const duplicateTargetMetricCount = Object.keys(nonFinalScalarIdentity.assignmentArtifact.diagnostics.duplicateFinalTargetValueCountsByMetric ?? {}).length;
    assert(duplicateTargetMetricCount > 0, "Non-final scalar identity diagnostics must report duplicated final-stat anchors", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.assignmentArtifact.rejectionReasonCounts != null, "Non-final scalar identity evidence must include rejection reason counts", {
      nonFinalScalarIdentity,
    });
    assert(Array.isArray(nonFinalScalarIdentity.assignmentArtifact.strongestReplayDiagnostics), "Non-final scalar identity evidence must include strongest replay diagnostics", {
      nonFinalScalarIdentity,
    });
    assert(Array.isArray(nonFinalScalarIdentity.assignmentArtifact.strongestRejectedAssignments), "Non-final scalar identity evidence must include strongest rejected assignments", {
      nonFinalScalarIdentity,
    });
    for (const assignment of nonFinalScalarIdentity.assignmentArtifact.strongestRejectedAssignments) {
      assert(assignment.canonicalCandidate === false, "Rejected identity assignment summary must not include accepted canonical candidates", {
        assignment,
      });
      assert((assignment.rejectionReasons ?? []).length > 0, "Rejected identity assignment summary must include rejection reasons", {
        assignment,
      });
      assert(Array.isArray(assignment.support), "Rejected identity assignment summary must include support metrics", {
        assignment,
      });
    }
    assert((nonFinalScalarIdentity.assignmentArtifact.canonicalCandidateCount ?? 0) === 0, "Default artifact must not have accepted replay-only keyframe identity candidates until runtime export is updated", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.offlineComparison?.runtimeInput === false, "Non-final scalar identity comparison must be marked offline-only", {
      nonFinalScalarIdentity,
    });
    assert(nonFinalScalarIdentity.startupRosterTokenScan?.status === "diagnostic_only_not_runtime_api_data" &&
      nonFinalScalarIdentity.startupRosterTokenScan?.runtimeInput === false &&
      nonFinalScalarIdentity.startupRosterTokenScan?.runtimeApiData === false &&
      nonFinalScalarIdentity.startupRosterTokenScan?.versionGroup === "16.9" &&
      nonFinalScalarIdentity.startupRosterTokenScan?.scannedReplayCount === 20 &&
      nonFinalScalarIdentity.startupRosterTokenScan?.fullCorpusRosterOrderCandidateCount > 0 &&
      (nonFinalScalarIdentity.startupRosterTokenScan?.topReplayOnlyCandidates ?? []).length > 0,
      "Non-final identity evidence must include the replay-only startup roster token diagnostic without promoting it", {
        startupRosterTokenScan: nonFinalScalarIdentity.startupRosterTokenScan,
      });
    assert(nonFinalScalarIdentity.handleGraphRowLinkCandidates?.status === "not_promoted" &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.runtimeInput === false &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.runtimeApiData === false &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.schema === "keyframe-handle-graph-candidate-scores.v1" &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.replayCount === 20 &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.candidateCount > 0 &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.confidenceCounts?.weak === nonFinalScalarIdentity.handleGraphRowLinkCandidates?.candidateCount &&
      nonFinalScalarIdentity.handleGraphRowLinkCandidates?.topConfidence === "weak",
      "Non-final identity evidence must include handle-graph row-link candidates as not-promoted diagnostics", {
        handleGraphRowLinkCandidates: nonFinalScalarIdentity.handleGraphRowLinkCandidates,
      });
  }

  const reconstructionRowIdentity = rejected.reconstructionRowIdentity;
  assert(reconstructionRowIdentity != null, "Artifact must include reconstruction row identity rejection evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(reconstructionRowIdentity.status === "not_promoted", "Reconstruction row identity evidence must remain not_promoted", {
    reconstructionRowIdentity,
  });
  assert(reconstructionRowIdentity.runtimeInput === false, "Reconstruction row identity evidence must be non-runtime", {
    reconstructionRowIdentity,
  });
  assert((reconstructionRowIdentity.reason ?? "").includes("stable replay-only participant identity"), "Reconstruction row identity evidence must explain the participant identity blocker", {
    reconstructionRowIdentity,
  });
  const rowGridCandidateScan = reconstructionRowIdentity.rowGridCandidateScan;
  assert(rowGridCandidateScan?.exists === true, "Reconstruction row identity evidence must include the generic row-grid candidate scan", {
    reconstructionRowIdentity,
  });
  assert(rowGridCandidateScan.schema === "rofl-reconstruction-row-grid-candidates/v1", "Row-grid candidate scan summary has unexpected schema", {
    rowGridCandidateScan,
  });
  assert(rowGridCandidateScan.status === "candidate_scan_only_not_runtime_api_data", "Row-grid candidate scan must remain candidate-only", {
    rowGridCandidateScan,
  });
  assert(rowGridCandidateScan.runtimeInput === false, "Row-grid candidate scan must be non-runtime", {
    rowGridCandidateScan,
  });
  assert((rowGridCandidateScan.candidateCount ?? 0) > 0 && (rowGridCandidateScan.topCandidates ?? []).length > 0, "Row-grid candidate scan must summarize candidate evidence", {
    rowGridCandidateScan,
  });
  assert((rowGridCandidateScan.topCandidates ?? []).every((candidate) =>
    candidate.runtimeApiData === false &&
    candidate.participantIdentity === false &&
    candidate.status === "not_promoted"
  ), "Runtime artifact must not promote row-grid shape candidates as participant identity", {
    rowGridCandidateScan,
  });
  const rowGridFieldAnalysis = reconstructionRowIdentity.rowGridFieldAnalysis;
  assert(rowGridFieldAnalysis?.exists === true, "Reconstruction row identity evidence must include row-grid field analysis", {
    reconstructionRowIdentity,
  });
  assert(rowGridFieldAnalysis.schema === "rofl-reconstruction-row-grid-field-analysis/v1", "Row-grid field analysis summary has unexpected schema", {
    rowGridFieldAnalysis,
  });
  assert(rowGridFieldAnalysis.status === "field_hypothesis_only_not_runtime_api_data", "Row-grid field analysis must remain hypothesis-only", {
    rowGridFieldAnalysis,
  });
  assert(rowGridFieldAnalysis.runtimeInput === false, "Row-grid field analysis must be non-runtime", {
    rowGridFieldAnalysis,
  });
  assert((rowGridFieldAnalysis.candidateCount ?? 0) > 0 && (rowGridFieldAnalysis.topCandidates ?? []).length > 0, "Row-grid field analysis must summarize candidate byte-column evidence", {
    rowGridFieldAnalysis,
  });
  assert((rowGridFieldAnalysis.topCandidates ?? []).every((candidate) =>
    candidate.runtimeApiData === false &&
    candidate.participantIdentity === false &&
    candidate.promotionStatus === "not_promoted"
  ), "Runtime artifact must not promote row-grid field hypotheses as participant identity", {
    rowGridFieldAnalysis,
  });
  const rowIdentityArtifacts = reconstructionRowIdentity.rowIdentityArtifacts ?? [];
  assert(rowIdentityArtifacts.length >= 2, "Reconstruction row identity evidence must include both 241-family row gates", {
    reconstructionRowIdentity,
  });
  for (const familyKey of ["241-0x02", "241-0x04"]) {
    const artifactSummary = rowIdentityArtifacts.find((entry) => entry.familyKey === familyKey);
    assert(artifactSummary != null, `Missing reconstruction row identity summary for ${familyKey}`, {
      reconstructionRowIdentity,
    });
    assert(artifactSummary.status === "identity_gate_only_not_runtime_api_data", `Unexpected row identity status for ${familyKey}`, {
      artifactSummary,
    });
    assert(artifactSummary.promotionStatus === "not_promoted", `Row identity gate must remain not_promoted for ${familyKey}`, {
      artifactSummary,
    });
    assert(artifactSummary.runtimeApiData === false, `Row identity gate must not emit runtime API data for ${familyKey}`, {
      artifactSummary,
    });
    assert(artifactSummary.participantIdentity === false, `Row identity gate must not claim participant identity for ${familyKey}`, {
      artifactSummary,
    });
    assert(Number.isFinite(artifactSummary.sameRowWinRate) && artifactSummary.sameRowWinRate < 0.75, `Row identity same-row win rate must remain below promotion threshold for ${familyKey}`, {
      artifactSummary,
    });
    assert(artifactSummary.minCoherence === 0.75 &&
      Number.isFinite(artifactSummary.duplicateRateThreshold) &&
      (artifactSummary.promotionReasons ?? []).includes("row-to-participant mapping is not established from ROFL-only evidence") &&
      (artifactSummary.strongestRows ?? []).length > 0 &&
      (artifactSummary.strongestRows ?? []).every((row) => row.runtimeApiData === false && row.participantId === null && ["duplicate_rejected", "unstable_identity"].includes(row.status)),
      `Row identity gate must expose per-row blocker details for ${familyKey}`, {
        artifactSummary,
      });
    assert(artifactSummary.rowCount === 10, `Row identity gate must summarize 10 rows for ${familyKey}`, {
      artifactSummary,
    });
    const rejectedOrUnstableCount =
      (artifactSummary.rowStatusCounts?.duplicate_rejected ?? 0) +
      (artifactSummary.rowStatusCounts?.unstable_identity ?? 0);
    assert(rejectedOrUnstableCount === 10, `Every row identity summary row must remain rejected or unstable for ${familyKey}`, {
      artifactSummary,
    });
  }

  const positions = rejected.positions;
  assert(positions != null, "Artifact must include position candidate rejection evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(["not_found", "rejected_for_runtime"].includes(positions.status), "Position candidate evidence has an unsupported status", {
    positions,
  });
  if (positions.status === "rejected_for_runtime") {
    assert(positions.participantMovementArtifact?.assignmentCount < 10 ||
      positions.offlineValidation?.passingAssignmentCount < positions.offlineValidation?.assignmentCount ||
      positions.participantMovementArtifact?.usesIdentityPriors === true,
      "Rejected position candidate must document an actual runtime promotion blocker", {
        positions,
      });
    assert(positions.offlineValidation?.runtimeInput === false, "Position validation must be marked offline-only", {
      positions,
    });
    assert(positions.participantMovementArtifact?.assignmentCount === 9, "Focused replay movement evidence should preserve the 9/10 assignment blocker", {
      positions,
    });
    assert(positions.participantMovementArtifact?.unmatchedParticipantCount === 1, "Focused replay movement evidence should preserve the unmatched participant blocker", {
      positions,
    });
    assert(positions.participantMovementArtifact?.usesIdentityPriors === true, "Rejected position candidate must record identity-prior dependency", {
      positions,
    });
    assert(positions.offlineValidation?.passingAssignmentCount === 7, "Focused replay movement evidence should preserve failed offline-validation assignments", {
      positions,
    });
    assert(Array.isArray(positions.promotionBlockers) && positions.promotionBlockers.length >= 3, "Rejected position evidence must list concrete runtime promotion blockers", {
      positions,
    });
    assert((positions.promotionBlockers ?? []).some((blocker) => blocker.includes("9/10")), "Position blockers must preserve incomplete participant assignment evidence", {
      blockers: positions.promotionBlockers,
    });
    assert((positions.promotionBlockers ?? []).some((blocker) => blocker.includes("identity priors")), "Position blockers must preserve identity-prior dependency evidence", {
      blockers: positions.promotionBlockers,
    });
    assert((positions.promotionBlockers ?? []).some((blocker) => blocker.includes("7/9")), "Position blockers must preserve failed offline-quality evidence", {
      blockers: positions.promotionBlockers,
    });
    assert((positions.promotionBlockers ?? []).some((blocker) => blocker.includes("no-priors") && blocker.includes("8/10")), "Position blockers must preserve the replay-only no-priors assignment drop", {
      blockers: positions.promotionBlockers,
    });
    assert(positions.qualityGateSummary?.expectedParticipantCount === 10 &&
      positions.qualityGateSummary?.assignedParticipantCount === 9 &&
      positions.qualityGateSummary?.unmatchedParticipantCount === 1 &&
      positions.qualityGateSummary?.usesIdentityPriors === true &&
      positions.qualityGateSummary?.offlineAssignmentCount === 9 &&
      positions.qualityGateSummary?.offlinePassingAssignmentCount === 7 &&
      positions.qualityGateSummary?.noPriorsAssignedParticipantCount === 8 &&
      positions.qualityGateSummary?.noPriorsUnmatchedParticipantCount === 2 &&
      positions.qualityGateSummary?.noPriorsOfflineAssignmentCount === 8 &&
      positions.qualityGateSummary?.noPriorsOfflinePassingAssignmentCount === 7 &&
      positions.qualityGateSummary?.runtimeInput === false,
      "Position quality gate summary must mirror movement assignment and offline-validation blockers", {
        qualityGateSummary: positions.qualityGateSummary,
      });
    assert(positions.noPriorsDiagnostic?.status === "diagnostic_only_not_runtime_api_data" &&
      positions.noPriorsDiagnostic?.runtimeInput === false &&
      positions.noPriorsDiagnostic?.usesIdentityPriors === false &&
      positions.noPriorsDiagnostic?.assignmentCount === 8 &&
      positions.noPriorsDiagnostic?.unmatchedParticipantCount === 2 &&
      (positions.noPriorsDiagnostic?.unmatchedParticipants ?? []).length === 2 &&
      (positions.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Vayne" && participant.teamPosition === "TOP") &&
      (positions.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Malphite" && participant.teamPosition === "TOP") &&
      (positions.noPriorsDiagnostic?.unmatchedParticipants ?? []).every((participant) => (participant.topRejectedEntityCandidates ?? []).length > 0) &&
      positions.noPriorsDiagnostic?.offlineValidation?.assignmentCount === 8 &&
      positions.noPriorsDiagnostic?.offlineValidation?.passingAssignmentCount === 7 &&
      positions.noPriorsDiagnostic?.offlineValidation?.runtimeInput === false,
      "Position evidence must include the no-priors replay-only diagnostic without promoting it", {
        noPriorsDiagnostic: positions.noPriorsDiagnostic,
      });
    const unmatchedPositionCoverage = (positions.perParticipantCoverage ?? []).find((entry) => entry.status === "not_found");
    assert((positions.participantMovementArtifact?.unmatchedParticipants ?? []).length === 1 &&
      (positions.participantMovementArtifact?.unmatchedParticipants?.[0]?.topRejectedEntityCandidates ?? []).length > 0,
      "Position movement artifact must preserve top rejected candidates for the unmatched participant", {
        participantMovementArtifact: positions.participantMovementArtifact,
      });
    assert((unmatchedPositionCoverage?.topRejectedEntityCandidates ?? []).length > 0 &&
      (unmatchedPositionCoverage?.topRejectedEntityCandidates ?? []).some((candidate) => candidate.assignedToOtherParticipant === true),
      "Position per-participant coverage must expose why the unmatched participant was not promoted", {
        unmatchedPositionCoverage,
      });
    assert((positions.participantMovementArtifact?.unassignedEntities ?? []).length === 2 &&
      (positions.participantMovementArtifact?.unassignedEntities ?? []).every((entity) => (entity.topRejectedParticipantCandidates ?? []).length > 0),
      "Position movement artifact must preserve top rejected participant candidates for unassigned entities", {
        participantMovementArtifact: positions.participantMovementArtifact,
      });
    assertNoRuntimeRiotApiPath(positions, ["rejectedCandidateArtifacts", "positions"]);
    assert((positions.perParticipantCoverage ?? []).length === 10, "Rejected position evidence must include per-participant coverage", {
      positions,
    });
    assert((positions.perParticipantCoverage ?? []).every((entry) =>
      ["unstable_identity", "noisy", "not_found"].includes(entry.status) &&
      entry.runtimeApiData === false
    ), "Position per-participant coverage must use explicit non-runtime statuses", {
      positions,
    });
  }

  const itemEvents = rejected.itemEvents;
  assert(itemEvents != null, "Artifact must include item-event candidate rejection evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(["not_found", "rejected_for_runtime"].includes(itemEvents.status), "Item-event candidate evidence has an unsupported status", {
    itemEvents,
  });
  if (itemEvents.status === "rejected_for_runtime") {
    assert((itemEvents.candidateArtifact?.candidateCount ?? 0) > 0, "Rejected item-event candidate evidence must include candidate counts", {
      itemEvents,
    });
    assert(itemEvents.candidateArtifact?.candidateCount === 689 && itemEvents.candidateArtifact?.strongCandidateCount === 93, "Focused replay item-event evidence must preserve candidate blocker counts", {
      itemEvents,
    });
    assert(itemEvents.eventInventory?.globalEventCount === 472, "Focused replay item-event evidence must preserve offline event inventory count", {
      itemEvents,
    });
    assert(itemEvents.eventInventory?.eventTypeCounts?.ITEM_PURCHASED === 249, "Focused replay item-event evidence must preserve item purchase event count", {
      itemEvents,
    });
    assert(itemEvents.offlineValidation?.runtimeInput === false, "Item-event validation must be marked offline-only", {
      itemEvents,
    });
    assertNoRuntimeRiotApiPath(itemEvents, ["rejectedCandidateArtifacts", "itemEvents"]);
  }

  const inventoryTimeline = rejected.inventoryTimeline;
  assert(inventoryTimeline != null, "Artifact must include inventory timeline candidate evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(["not_found", "rejected_for_runtime"].includes(inventoryTimeline.status), "Inventory timeline candidate evidence has an unsupported status", {
    inventoryTimeline,
  });
  if (inventoryTimeline.status === "rejected_for_runtime") {
    assert(inventoryTimeline.runtimeInput === false, "Inventory timeline rejected evidence must be marked non-runtime", {
      inventoryTimeline,
    });
    assert(inventoryTimeline.relatedCandidateArtifact?.itemEventCandidateCount === itemEvents.candidateArtifact?.candidateCount, "Inventory timeline rejection must point at rejected item-event candidate count", {
      inventoryTimeline,
      itemEvents,
    });
    assert(inventoryTimeline.relatedCandidateArtifact?.eventTypeCounts?.ITEM_DESTROYED === 209, "Inventory timeline rejection must preserve item-destroyed event count", {
      inventoryTimeline,
    });
    assertNoRuntimeRiotApiPath(inventoryTimeline, ["rejectedCandidateArtifacts", "inventoryTimeline"]);
  }

  const championStatsFinal = rejected.championStatsFinal;
  assert(championStatsFinal != null, "Artifact must include final championStats rejection evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(championStatsFinal.status === "not_promoted", "Final championStats evidence must remain not_promoted until ROFL semantics are decoded", {
    championStatsFinal,
  });
  assert(championStatsFinal.rejectedCandidateSummary?.inspectedSource === "summary.metadataJson.statsJson", "Final championStats rejection evidence must identify inspected ROFL source", {
    championStatsFinal,
  });
  assert((championStatsFinal.rejectedCandidateSummary?.collisionClasses ?? []).length > 0, "Final championStats rejection evidence must describe collision classes", {
    championStatsFinal,
  });

  const damageTimeline = rejected.damageTimeline;
  assert(damageTimeline != null, "Artifact must include damage timeline candidate evidence", {
    rejectedCandidateArtifacts: artifact.rejectedCandidateArtifacts,
  });
  assert(["not_found", "rejected_for_runtime"].includes(damageTimeline.status), "Damage timeline candidate evidence has an unsupported status", {
    damageTimeline,
  });
  if (damageTimeline.status === "rejected_for_runtime") {
    assert(damageTimeline.extractedStatsArtifact?.runtimeInput === false, "Damage timeline research artifact must be marked non-runtime", {
      damageTimeline,
    });
  }
}

function verifyIdentityLinkage(artifact) {
  const identityLinkage = artifact.identityLinkage ?? {};
  const evidenceMatrix = identityLinkage.evidenceMatrix ?? [];
  for (const evidenceClass of [
    "ROFL metadata/statsJson roster",
    "roster order",
    "team/champion metadata",
    "cross-metric final stats consistency",
    "startup roster/order tokens",
    "keyframe row identity gates",
    "handle graph row links",
  ]) {
    assert(evidenceMatrix.some((entry) =>
      entry.evidenceClass === evidenceClass &&
      Array.isArray(entry.evidenceRefs) &&
      entry.evidenceRefs.length > 0 &&
      (entry.runtimeApiData === true || entry.runtimeApiData === false)
    ), `Identity linkage evidence matrix must include ${evidenceClass}`, {
      evidenceMatrix,
    });
  }
  assert(evidenceMatrix.some((entry) => entry.evidenceClass === "keyframe row identity gates" && entry.promotion === "not_promoted" && entry.runtimeApiData === false), "Identity evidence matrix must keep row identity gates not promoted", {
    evidenceMatrix,
  });
  assert(evidenceMatrix.some((entry) => entry.evidenceClass === "ROFL metadata/statsJson roster" && entry.promotion === "accepted_for_final_roster_identity" && entry.runtimeApiData === true), "Identity evidence matrix must mark ROFL metadata/statsJson as final roster identity", {
    evidenceMatrix,
  });
  assert(identityLinkage.finalRosterIdentity?.status === "decoded", "Identity linkage summary must mark final roster identity decoded", {
    identityLinkage,
  });
  assert(identityLinkage.finalRosterIdentity?.participantCount === 10, "Identity linkage summary must include all 10 final roster participants", {
    identityLinkage,
  });
  assert(identityLinkage.finalRosterIdentity?.emittedTimelineParticipantCount === 10, "Identity linkage summary must include all 10 emitted timeline participants", {
    identityLinkage,
  });
  assert(identityLinkage.finalRosterIdentity?.method === "rofl-summary-roster-order", "Identity linkage summary must state the final roster linkage method", {
    identityLinkage,
  });
  assert(identityLinkage.riotApiIdentifierParity?.status === "not_found", "Identity linkage summary must not claim Riot API PUUID parity", {
    identityLinkage,
  });
  assert(identityLinkage.roflMetadataParticipantIdentifiers?.status === "decoded_internal", "Identity linkage summary must mark ROFL metadata identifiers as internal decoded identifiers", {
    identityLinkage,
  });
  assert(identityLinkage.roflMetadataParticipantIdentifiers?.count === 10, "Identity linkage summary must count all 10 ROFL metadata participant identifiers", {
    identityLinkage,
  });
  assert(identityLinkage.roflMetadataParticipantIdentifiers?.apiFieldCompatibility === "shape-only", "ROFL metadata participant identifiers must be marked shape-only for API compatibility", {
    identityLinkage,
  });
  assert((identityLinkage.roflMetadataParticipantIdentifiers?.fields ?? []).includes("info.participants[].summonerId"), "ROFL metadata participant identifiers must include summonerId as shape-only identifier coverage", {
    identityLinkage,
  });
  assert((identityLinkage.riotApiIdentifierParity?.fields ?? []).includes("info.participants[].summonerId"), "Riot API identifier parity gap must include summonerId", {
    identityLinkage,
  });
  assert(identityLinkage.riotApiIdentifierParity?.runtimeInput === false, "Riot API identifier parity must not be runtime input", {
    identityLinkage,
  });
  assert(identityLinkage.nonFinalScalarIdentity?.metricSet === "conservative", "Identity linkage summary must report conservative non-final metric set", {
    identityLinkage,
  });
  assert(identityLinkage.nonFinalScalarIdentity?.canonicalCandidateCount === 0, "Identity linkage summary must report no accepted non-final scalar identity candidates", {
    identityLinkage,
  });
  assert(identityLinkage.nonFinalScalarIdentity?.startupRosterTokenScan?.status === "diagnostic_only_not_runtime_api_data" &&
    identityLinkage.nonFinalScalarIdentity?.startupRosterTokenScan?.runtimeApiData === false &&
    identityLinkage.nonFinalScalarIdentity?.startupRosterTokenScan?.scannedReplayCount === 20,
    "Identity linkage summary must surface the startup roster token diagnostic as non-runtime evidence", {
      identityLinkage,
    });
  assert(identityLinkage.nonFinalScalarIdentity?.handleGraphRowLinkCandidates?.status === "not_promoted" &&
    identityLinkage.nonFinalScalarIdentity?.handleGraphRowLinkCandidates?.runtimeApiData === false &&
    identityLinkage.nonFinalScalarIdentity?.handleGraphRowLinkCandidates?.topConfidence === "weak",
    "Identity linkage summary must surface handle-graph row-link candidates as not-promoted evidence", {
      identityLinkage,
    });
  assert(Array.isArray(identityLinkage.nonFinalScalarIdentity?.nextDecoderTargets) && identityLinkage.nonFinalScalarIdentity.nextDecoderTargets.length > 0, "Identity linkage summary must include next decoder target metrics", {
    identityLinkage,
  });
}

function verifyRoflDerivedFieldMap(artifact) {
  const fieldMap = artifact.roflDerivedFieldMap ?? {};
  const fieldCoverage = artifact.fieldCoverage ?? {};
  const requiredDecoded = [
    ["match", "metadata.matchId", "rofl-file-name"],
    ["match", "metadata.participants", "rofl-metadata-statsJson"],
    ["match", "info.endOfGameResult", "rofl-metadata-statsJson"],
    ["match", "info.participants", "rofl-metadata-statsJson"],
    ["match", "info.participants[].challenges.turretTakedowns", "rofl-metadata-statsJson"],
    ["match", "info.teams", "participant-final-statsJson-aggregation"],
    ["timeline", "metadata.matchId", "rofl-file-name"],
    ["timeline", "info.endOfGameResult", "rofl-metadata-statsJson"],
    ["timeline", "info.participants", "rofl-metadata-statsJson"],
    ["timeline", "info.frames[].participantFrames[].level", "rofl-metadata-statsJson"],
    ["timeline", "info.frames[].participantFrames[].totalGold", "rofl-metadata-statsJson"],
    ["timeline", "info.frames[].participantFrames[].xp", "rofl-metadata-statsJson"],
    ["timeline", "info.frames[].participantFrames[].minionsKilled", "rofl-metadata-statsJson"],
    ["timeline", "info.frames[].participantFrames[].jungleMinionsKilled", "rofl-metadata-statsJson"],
  ];
  for (const [section, key, source] of requiredDecoded) {
    const entry = fieldMap[section]?.[key];
    assert(["decoded", "decoded_internal"].includes(entry?.status), "ROFL-derived field map is missing a decoded field", {
      section,
      key,
      entry,
    });
    assert(entry?.source === source, "ROFL-derived field map has an unexpected source", {
      section,
      key,
      expectedSource: source,
      entry,
    });
  }
  assert(fieldMap.timeline?.["info.frames[].events"]?.status === "not_found", "ROFL-derived field map must keep timeline events missing", {
    entry: fieldMap.timeline?.["info.frames[].events"],
  });
  assert(fieldMap.timeline?.["info.frames[].events"]?.source === fieldCoverage.timelineEvents?.source, "Timeline event field map source must match coverage", {
    fieldMap: fieldMap.timeline?.["info.frames[].events"],
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert(JSON.stringify(fieldMap.timeline?.["info.frames[].events"]?.apiShapedNotFoundFields ?? []) === JSON.stringify(fieldCoverage.timelineEvents?.apiShapedNotFoundFields ?? []), "Timeline event field map must mirror coverage gap leaves", {
    fieldMap: fieldMap.timeline?.["info.frames[].events"],
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert(fieldMap.timeline?.["info.frames[].events"]?.runtimeEmission === "empty-events-arrays", "Timeline event field map must document empty events runtime policy", {
    entry: fieldMap.timeline?.["info.frames[].events"],
  });
  assert(fieldMap.timeline?.["info.frames[].events"]?.rejectedItemEventEvidence?.candidateCount === artifact.rejectedCandidateArtifacts?.itemEvents?.candidateArtifact?.candidateCount, "Timeline event field map must mirror rejected item-event candidate counts", {
    fieldMap: fieldMap.timeline?.["info.frames[].events"],
    itemEvents: artifact.rejectedCandidateArtifacts?.itemEvents,
  });
  assert(JSON.stringify(fieldMap.timeline?.["info.frames[].events"]?.eventFamilyCorrelation ?? null) === JSON.stringify(fieldCoverage.timelineEvents?.eventFamilyCorrelation ?? null), "Timeline event field map must mirror event-family correlation diagnostics", {
    fieldMap: fieldMap.timeline?.["info.frames[].events"],
    timelineEvents: fieldCoverage.timelineEvents,
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].currentGold"]?.status === "not_promoted", "ROFL-derived field map must not promote final currentGold without API parity", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].currentGold"],
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].position"]?.status === "not_promoted", "ROFL-derived field map must not promote position candidates", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].position"],
  });
  assert(JSON.stringify(fieldMap.timeline?.["info.frames[].participantFrames[].position"]?.perParticipantCoverage ?? []) === JSON.stringify(fieldCoverage.positions?.perParticipantCoverage ?? []), "Position field map must mirror position coverage", {
    fieldMap: fieldMap.timeline?.["info.frames[].participantFrames[].position"],
    positions: fieldCoverage.positions,
  });
  assert(JSON.stringify(fieldMap.timeline?.["info.frames[].participantFrames[].position"]?.statusCounts ?? {}) === JSON.stringify(fieldCoverage.positions?.statusCounts ?? {}), "Position field map statusCounts must mirror position coverage", {
    fieldMap: fieldMap.timeline?.["info.frames[].participantFrames[].position"],
    positions: fieldCoverage.positions,
  });
  assert(JSON.stringify(fieldMap.timeline?.["info.frames[].participantFrames[].position"]?.noPriorsDiagnostic ?? null) === JSON.stringify(fieldCoverage.positions?.noPriorsDiagnostic ?? null), "Position field map must mirror no-priors position coverage", {
    fieldMap: fieldMap.timeline?.["info.frames[].participantFrames[].position"],
    positions: fieldCoverage.positions,
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.status === "not_promoted", "ROFL-derived field map must not promote non-final participant identity", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"],
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.source === "chunk-row-identity-gates", "ROFL-derived field map must point non-final participant identity at chunk row gates", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"],
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].championStats"]?.status === "shape_only", "ROFL-derived field map must mark championStats container shape-only", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].championStats"],
  });
  assert(fieldMap.timeline?.["info.frames[].participantFrames[].damageStats"]?.status === "decoded", "ROFL-derived field map must mark final damageStats as decoded", {
    entry: fieldMap.timeline?.["info.frames[].participantFrames[].damageStats"],
  });
}

function verifyFinalFrameCoverage(artifact) {
  const finalFrames = (artifact.frames ?? []).filter((frame) => frame.provenance?.frameKind === "final-stats");
  assert(finalFrames.length === 1, "Artifact must contain exactly one final statsJson timeline frame", {
    finalFrameCount: finalFrames.length,
  });
  const finalFrame = finalFrames[0];
  assert(finalFrame.provenance?.values === "rofl-metadata-statsJson", "Final timeline frame must declare statsJson provenance", {
    provenance: finalFrame.provenance,
  });
  const coverageByParticipant = new Map((artifact.coverage ?? []).map((entry) => [entry.participantId, entry]));
  const mismatches = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const participantFrame = finalFrame.participantFrames?.[String(participantId)];
    const participantCoverage = coverageByParticipant.get(participantId);
    for (const [metric, pathParts] of finalTimelineMetricPaths) {
      const value = getNested(participantFrame, pathParts);
      const coverage = participantCoverage?.metrics?.[metric];
      if (!Number.isFinite(value) || coverage?.status !== "decoded" ||
          coverage?.provenance?.values !== "rofl-metadata-statsJson" ||
          coverage?.provenance?.participantIdentity !== "rofl-summary-roster-order" ||
          coverage?.provenance?.calibration !== "direct-final-stat") {
        mismatches.push({
          participantId,
          metric,
          value,
          coverage,
        });
      }
    }
  }
  assert(mismatches.length === 0, "Final frame metrics do not match decoded ROFL-only coverage", {
    mismatches: mismatches.slice(0, 16),
  });
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = resolveAbsolute(
    root,
    args.inputPath ?? path.join(artifactRoot, args.replayId, "rofl-api-metrics.json"),
  );
  const artifact = readJson(inputPath);

  assert(artifact.artifactSchema === "rofl-api-parity-checkpoint/v1", "Artifact has unexpected schema marker", {
    artifactSchema: artifact.artifactSchema,
  });
  assert(artifact.extractionMode === "rofl-only-final-stats", "Default artifact must declare ROFL-only final-stats extraction mode", {
    extractionMode: artifact.extractionMode,
  });
  verifyCoverageStatusLegend(artifact);
  verifyFieldCoverage(artifact);
  verifyFinalFrameCoverage(artifact);
  verifyParityChecklist(artifact);
  verifyRejectedCandidateArtifacts(artifact);
  verifyIdentityLinkage(artifact);
  verifyRoflDerivedFieldMap(artifact);
  assertNoRuntimeRiotApiPath(artifact, []);

  assert(artifact.artifactManifest?.sourceReplay?.runtimeInput === true &&
    artifact.artifactManifest?.replayDerivedSummary?.runtimeInput === true &&
    artifact.artifactManifest?.primaryRuntimeArtifact?.runtimeInput === false &&
    (artifact.artifactManifest?.decoderDiagnostics ?? []).length >= 4 &&
    (artifact.artifactManifest?.decoderDiagnostics ?? []).every((entry) => entry.runtimeInput === false && entry.runtimeApiData === false) &&
    (artifact.artifactManifest?.offlineValidationReports ?? []).length >= 3 &&
    (artifact.artifactManifest?.offlineValidationReports ?? []).every((entry) => entry.runtimeInput === false),
    "Artifact manifest must distinguish runtime ROFL inputs from offline validation reports", {
      artifactManifest: artifact.artifactManifest,
    });
  const diagnosticRoles = new Set((artifact.artifactManifest?.decoderDiagnostics ?? []).map((entry) => entry.role));
  for (const role of [
    "rejected-position-candidate-diagnostic",
    "offline-position-validation-diagnostic",
    "replay-only-no-priors-position-diagnostic",
    "offline-no-priors-position-validation-diagnostic",
    "replay-only-startup-roster-token-diagnostic",
    "offline-handle-graph-row-link-diagnostic",
    "offline-event-family-correlation-diagnostic",
  ]) {
    assert(diagnosticRoles.has(role), `Artifact manifest must include decoder diagnostic role '${role}'`, {
      decoderDiagnostics: artifact.artifactManifest?.decoderDiagnostics,
    });
  }
  assert((artifact.artifactManifest?.sourceReplay?.path ?? "").replaceAll("\\", "/").includes("/replays/") &&
    !(artifact.artifactManifest?.sourceReplay?.path ?? "").replaceAll("\\", "/").includes("/replays/api/"),
    "Artifact manifest source replay must point at a ROFL replay, not Riot API fixtures", {
      sourceReplay: artifact.artifactManifest?.sourceReplay,
    });
  assert(artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles === false, "Artifact does not declare Riot API files as disabled for runtime extraction", {
    roflOnlyInputs: artifact.source?.roflOnlyInputs,
  });
  assert(artifact.source?.decoderArtifactSupervised === false, "Default runtime artifact must not depend on supervised decoder artifacts", {
    decoderArtifactSupervised: artifact.source?.decoderArtifactSupervised,
    researchInputPath: artifact.source?.researchInputPath,
  });
  assert(artifact.source?.researchInputPath == null, "Default runtime artifact should not declare a research input path", {
    researchInputPath: artifact.source?.researchInputPath,
  });
  const inputClasses = artifact.source?.inputClasses ?? {};
  assert(inputClasses.runtimeReplayFile?.class === "runtime-rofl", "Source input classes must tag the replay file as runtime ROFL input", {
    inputClasses,
  });
  assert(inputClasses.runtimeReplayFile?.requiredForRuntime === true, "Runtime replay input must be marked required", {
    inputClasses,
  });
  assert(inputClasses.replayDerivedSummary?.class === "generated-rofl-summary", "Source input classes must tag the replay summary as ROFL-derived", {
    inputClasses,
  });
  assert(inputClasses.replayDerivedSummary?.requiredForRuntime === true, "Replay-derived summary must be marked required", {
    inputClasses,
  });
  assert(inputClasses.decoderSchemasAndDiagnostics?.class === "repo-local-generated-diagnostics", "Decoder diagnostics must be tagged as repo-local generated diagnostics", {
    inputClasses,
  });
  assert(inputClasses.decoderSchemasAndDiagnostics?.runtimePromotionAllowed === false, "Decoder diagnostics must not be implicitly promoted to runtime data", {
    inputClasses,
  });
  assert(inputClasses.riotApiFixtures?.class === "offline-validation-only", "Riot fixtures must be tagged validation-only", {
    inputClasses,
  });
  assert(inputClasses.riotApiFixtures?.requiredForRuntime === false, "Riot fixtures must not be required for runtime", {
    inputClasses,
  });
  assert(inputClasses.riotApiFixtures?.runtimePromotionAllowed === false, "Riot fixtures must not be allowed for runtime promotion", {
    inputClasses,
  });
  assert((artifact.totals?.researchKeyframeMetricSeriesCount ?? 0) === 0, "Default runtime artifact must not include research keyframe metric series", {
    researchKeyframeMetricSeriesCount: artifact.totals?.researchKeyframeMetricSeriesCount,
  });
  assert((artifact.seriesQuality ?? []).length === 0, "Default runtime artifact must not include research series quality rows", {
    seriesQualityCount: (artifact.seriesQuality ?? []).length,
  });
  assert((artifact.researchKeyframeSeriesQuality ?? []).length === 0, "Default runtime artifact must not include research keyframe quality rows", {
    researchKeyframeSeriesQualityCount: (artifact.researchKeyframeSeriesQuality ?? []).length,
  });
  assert((artifact.droppedSeries ?? []).length === 0, "Default runtime artifact must not include dropped research series rows", {
    droppedSeriesCount: (artifact.droppedSeries ?? []).length,
  });
  const replayPath = artifact.source?.replayPath;
  const summaryPath = artifact.source?.summaryPath;
  assert(typeof summaryPath === "string" && summaryPath.endsWith("summary.json"), "Artifact source is missing a summary artifact path", {
    summaryPath,
  });
  assert(fs.existsSync(summaryPath), "Artifact source summary path does not exist", {
    summaryPath,
  });
  assert(!summaryPath.replaceAll("\\", "/").toLowerCase().includes("replays/api/"), "Artifact source summary path must not be a Riot API fixture", {
    summaryPath,
  });
  assert(typeof replayPath === "string" && replayPath.endsWith(".rofl"), "Artifact source is missing a .rofl replay path", {
    replayPath,
  });
  assert(fs.existsSync(replayPath), "Artifact source replay path does not exist", {
    replayPath,
  });
  assert(replayPath.replaceAll("\\", "/").toLowerCase().includes("/replays/"), "Artifact source replay path is not under replays/", {
    replayPath,
  });
  assert(artifact.source?.roflOnlyInputs?.rosterAndFinalStats === true, "Artifact does not declare ROFL roster/final-stat extraction", {
    roflOnlyInputs: artifact.source?.roflOnlyInputs,
  });
  assert(artifact.totals?.rosterParticipantCount === 10, "Artifact does not expose all 10 roster participants", {
    rosterParticipantCount: artifact.totals?.rosterParticipantCount,
  });
  assert(artifact.totals?.timelineParticipantCount === 10, "Artifact timeline participant total does not reflect all emitted participantFrames", {
    timelineParticipantCount: artifact.totals?.timelineParticipantCount,
  });
  assert((artifact.match?.participants ?? []).length === 10, "Match participant list does not contain 10 participants", {
    matchParticipantCount: (artifact.match?.participants ?? []).length,
  });
  assert((artifact.match?.info?.participants ?? []).length === 10, "Riot-like match.info.participants does not contain 10 participants", {
    matchInfoParticipantCount: (artifact.match?.info?.participants ?? []).length,
  });
  assert((artifact.match?.metadata?.participants ?? []).length === 10, "Riot-like match.metadata.participants does not contain 10 PUUIDs", {
    matchMetadataParticipantCount: (artifact.match?.metadata?.participants ?? []).length,
  });
  assert((artifact.timeline?.metadata?.participants ?? []).length === 10, "Riot-like timeline.metadata.participants does not contain 10 PUUIDs", {
    timelineMetadataParticipantCount: (artifact.timeline?.metadata?.participants ?? []).length,
  });
  assert(JSON.stringify(artifact.match?.metadata?.participants ?? []) === JSON.stringify(artifact.timeline?.metadata?.participants ?? []), "Match and timeline metadata participant PUUID lists differ", {
    matchMetadataParticipants: artifact.match?.metadata?.participants,
    timelineMetadataParticipants: artifact.timeline?.metadata?.participants,
  });
  assert(artifact.match?.info?.gameId === parseReplayGameId(artifact.source?.replayId), "Riot-like match.info.gameId does not match replay id", {
    gameId: artifact.match?.info?.gameId,
    replayId: artifact.source?.replayId,
  });
  assert(artifact.match?.metadata?.matchId === artifact.source?.replayId?.replace("-", "_"), "Riot-like match.metadata.matchId does not match replay id", {
    matchId: artifact.match?.metadata?.matchId,
    replayId: artifact.source?.replayId,
  });
  assert(artifact.timeline?.metadata?.matchId === artifact.source?.replayId?.replace("-", "_"), "Riot-like timeline.metadata.matchId does not match replay id", {
    matchId: artifact.timeline?.metadata?.matchId,
    replayId: artifact.source?.replayId,
  });
  assert(artifact.match?.info?.platformId === parseReplayPlatformId(artifact.source?.replayId), "Riot-like match.info.platformId does not match replay id prefix", {
    platformId: artifact.match?.info?.platformId,
    replayId: artifact.source?.replayId,
  });
  assert((artifact.match?.info?.teams ?? []).length === 2, "Riot-like match.info.teams does not contain two teams", {
    teamCount: (artifact.match?.info?.teams ?? []).length,
  });
  const badTeams = (artifact.match?.info?.teams ?? []).filter((team) =>
    ![100, 200].includes(team.teamId) ||
    typeof team.win !== "boolean" ||
    team.provenance?.values !== "rofl-metadata-statsJson"
  );
  assert(badTeams.length === 0, "Team summaries are missing expected IDs, win flag, or provenance", {
    badTeams,
  });
  assert((artifact.timeline?.info?.frames ?? []).length === (artifact.frames ?? []).length, "Riot-like timeline.info.frames differs from top-level frames", {
    timelineFrameCount: (artifact.timeline?.info?.frames ?? []).length,
    topLevelFrameCount: (artifact.frames ?? []).length,
  });
  assert(artifact.timeline?.info?.gameId === parseReplayGameId(artifact.source?.replayId), "Riot-like timeline.info.gameId does not match replay id", {
    gameId: artifact.timeline?.info?.gameId,
    replayId: artifact.source?.replayId,
  });
  assert((artifact.timeline?.info?.participants ?? []).length === 10, "Riot-like timeline.info.participants does not contain 10 participants", {
    timelineParticipantInfoCount: (artifact.timeline?.info?.participants ?? []).length,
  });
  const badTimelineParticipants = (artifact.timeline?.info?.participants ?? []).filter((participant) =>
    !Number.isInteger(participant.participantId) ||
    participant.participantId < 1 ||
    participant.participantId > 10 ||
    typeof participant.puuid !== "string" ||
    participant.puuid.length === 0
  );
  assert(badTimelineParticipants.length === 0, "Riot-like timeline.info.participants has invalid participant ids or puuids", {
    badTimelineParticipants,
  });
  const badFrames = (artifact.timeline?.info?.frames ?? []).filter((frame) => !Array.isArray(frame.events));
  assert(badFrames.length === 0, "Timeline frames must include an events array", {
    badFrameCount: badFrames.length,
  });
  const badParticipantFrames = [];
  const emittedTimelineParticipantIds = new Set();
  for (const frame of artifact.timeline?.info?.frames ?? []) {
    for (const [participantId, participantFrame] of Object.entries(frame.participantFrames ?? {})) {
      emittedTimelineParticipantIds.add(Number(participantId));
      if (!participantFrame.championStats || typeof participantFrame.championStats !== "object" ||
          !participantFrame.damageStats || typeof participantFrame.damageStats !== "object") {
        badParticipantFrames.push({
          timestamp: frame.timestamp,
          participantId,
          reason: "missing-api-shaped-stat-containers",
        });
      }
      if (participantFrame.participantId !== Number(participantId)) {
        badParticipantFrames.push({
          timestamp: frame.timestamp,
          participantId,
          embeddedParticipantId: participantFrame.participantId,
        });
      }
    }
  }
  assert(badParticipantFrames.length === 0, "Participant frames must include matching participantId", {
    badParticipantFrames: badParticipantFrames.slice(0, 16),
  });
  const finalFrame = artifact.timeline?.info?.frames?.at(-1);
  const missingDamageStats = Object.entries(finalFrame?.participantFrames ?? {}).filter(([, frame]) =>
    typeof frame.damageStats?.totalDamageDoneToChampions !== "number" ||
    typeof frame.damageStats?.totalDamageTaken !== "number"
  );
  assert(missingDamageStats.length === 0, "Final timeline participant frames must include ROFL-derived cumulative damageStats", {
    missingDamageStats,
  });
  assert(emittedTimelineParticipantIds.size === 10, "Timeline participantFrames do not cover all 10 participants", {
    emittedTimelineParticipantIds: [...emittedTimelineParticipantIds].sort((left, right) => left - right),
  });
  assert((artifact.participants ?? []).length === 10, "Top-level participant list does not contain 10 participants", {
    participantCount: (artifact.participants ?? []).length,
  });
  assert((artifact.coverage ?? []).length === 10, "Coverage does not contain one row per participant", {
    coverageCount: (artifact.coverage ?? []).length,
  });
  assert((artifact.matchCoverage ?? []).length === 10, "Match coverage does not contain one row per participant", {
    matchCoverageCount: (artifact.matchCoverage ?? []).length,
  });
  assert(artifact.totals?.matchCoverageSummary?.decodedParticipants === 10, "Match coverage summary does not mark all participants decoded", {
    matchCoverageSummary: artifact.totals?.matchCoverageSummary,
  });

  const participantsMissingFinalStats = (artifact.match?.participants ?? [])
    .filter((participant) => Object.keys(participant.finalMetrics ?? {}).length === 0)
    .map((participant) => participant.participantId);
  assert(participantsMissingFinalStats.length === 0, "Some participants have no ROFL final metrics", {
    participantsMissingFinalStats,
  });
  const participantsMissingApiLikeStats = (artifact.match?.participants ?? [])
    .filter((participant) => Object.keys(participant.apiLikeStats ?? {}).length < minApiLikeStatsPerParticipant)
    .map((participant) => ({
      participantId: participant.participantId,
      statCount: Object.keys(participant.apiLikeStats ?? {}).length,
    }));
  assert(participantsMissingApiLikeStats.length === 0, "Some participants have too few ROFL statsJson API-like fields", {
    participantsMissingApiLikeStats,
  });
  const weakMatchCoverage = (artifact.matchCoverage ?? [])
    .filter((entry) => entry.status !== "decoded" || entry.apiLikeStatCount < minApiLikeStatsPerParticipant || entry.finalMetricCount < 5);
  assert(weakMatchCoverage.length === 0, "Match coverage has weak or undecoded participant rows", {
    weakMatchCoverage,
  });
  const participantsMissingRequiredStats = (artifact.match?.participants ?? [])
    .map((participant) => ({
      participantId: participant.participantId,
      missing: requiredApiLikeStats.filter((key) => participant.apiLikeStats?.[key] == null),
    }))
    .filter((entry) => entry.missing.length > 0);
  assert(participantsMissingRequiredStats.length === 0, "Some participants are missing required ROFL API-like stats", {
    participantsMissingRequiredStats,
  });
  const missingApiLikeStatsProvenance = (artifact.match?.participants ?? [])
    .filter((participant) => participant.provenance?.apiLikeStats !== "rofl-metadata-statsJson")
    .map((participant) => participant.participantId);
  assert(missingApiLikeStatsProvenance.length === 0, "Some participants are missing ROFL apiLikeStats provenance", {
    missingApiLikeStatsProvenance,
  });

  const badCoverageStatuses = [];
  const coverageStatusCounts = {};
  for (const participantCoverage of artifact.coverage ?? []) {
    const participantStatusCounts = {};
    for (const [metric, coverage] of Object.entries(participantCoverage.metrics ?? {})) {
      coverageStatusCounts[coverage.status] = (coverageStatusCounts[coverage.status] ?? 0) + 1;
      participantStatusCounts[coverage.status] = (participantStatusCounts[coverage.status] ?? 0) + 1;
      if (!allowedCoverageStatuses.has(coverage.status)) {
        badCoverageStatuses.push({
          participantId: participantCoverage.participantId,
          metric,
          status: coverage.status,
        });
      }
    }
    assert(JSON.stringify(participantStatusCounts) === JSON.stringify(participantCoverage.metricStatusCounts ?? {}), "Participant coverage status counts do not match metric rows", {
      participantId: participantCoverage.participantId,
      counted: participantStatusCounts,
      reported: participantCoverage.metricStatusCounts,
    });
  }
  assert(badCoverageStatuses.length === 0, "Coverage contains unsupported statuses", {
    badCoverageStatuses: badCoverageStatuses.slice(0, 16),
  });
  assert(JSON.stringify(coverageStatusCounts) === JSON.stringify(artifact.totals?.coverageSummary ?? {}), "Coverage summary does not match coverage rows", {
    counted: coverageStatusCounts,
    reported: artifact.totals?.coverageSummary,
  });
  const nonFinalCandidateAnnotations = (artifact.coverage ?? []).flatMap((participantCoverage) =>
    Object.entries(participantCoverage.metrics ?? {})
      .filter(([, coverage]) => coverage.nonFinalKeyframeCandidate != null)
      .map(([metric, coverage]) => ({
        participantId: participantCoverage.participantId,
        metric,
        annotation: coverage.nonFinalKeyframeCandidate,
      })),
  );
  assert(nonFinalCandidateAnnotations.length > 0, "Coverage must annotate rejected non-final keyframe candidates where identity diagnostics found them", {
    nonFinalCandidateAnnotations,
  });
  const unsupportedNonFinalStatuses = nonFinalCandidateAnnotations.filter((entry) =>
    !allowedCoverageStatuses.has(entry.annotation.status),
  );
  assert(unsupportedNonFinalStatuses.length === 0, "Non-final keyframe coverage annotations contain unsupported statuses", {
    unsupportedNonFinalStatuses,
  });
  const duplicateRejectedAnnotations = nonFinalCandidateAnnotations.filter((entry) =>
    entry.annotation.status === "duplicate_rejected" && (entry.annotation.targetDuplicateCount ?? 0) > 1,
  );
  assert(duplicateRejectedAnnotations.length > 0, "Coverage must identify duplicated final-stat anchors as rejected non-final identity evidence", {
    nonFinalCandidateAnnotations,
  });

  const decodedCoverageCount = (artifact.coverage ?? []).reduce(
    (sum, participantCoverage) => sum + Object.values(participantCoverage.metrics ?? {}).filter((coverage) => coverage.status === "decoded").length,
    0,
  );
  assert(decodedCoverageCount === artifact.totals?.decodedCoverageMetricCount, "Decoded coverage count differs from decoded coverage metric total", {
    decodedCoverageCount,
    decodedCoverageMetricCount: artifact.totals?.decodedCoverageMetricCount,
  });
  assert(countFrameMetrics(artifact.frames ?? []) === artifact.totals?.emittedMetricPointCount, "Frame metric count differs from emitted metric point total", {
    countedFrameMetrics: countFrameMetrics(artifact.frames ?? []),
    emittedMetricPointCount: artifact.totals?.emittedMetricPointCount,
  });
  if (args.requireTimelineSeries) {
    assert((artifact.totals?.roflOnlyFinalMetricSeriesCount ?? 0) > 0, "Artifact has no ROFL-only final timeline metric series", {
      totals: artifact.totals,
    });
  }

  assert(artifact.parityGaps?.timelineEvents === "not_extracted", "Artifact should explicitly report timeline event extraction gap", {
    parityGaps: artifact.parityGaps,
  });
  assert(artifact.parityGaps?.fullTimelineParticipantIdentity === "incomplete", "Artifact should explicitly report participant identity gap", {
    parityGaps: artifact.parityGaps,
  });

  const missingDecodedProvenance = (artifact.seriesQuality ?? [])
    .filter((series) =>
      series.provenance?.values !== "rofl-keyframe-field" ||
      !series.provenance?.participantIdentity ||
      !series.provenance?.calibration
    )
    .map((series) => ({
      participantId: series.participantId,
      metric: series.metric,
      provenance: series.provenance,
    }));
  assert(missingDecodedProvenance.length === 0, "Decoded series are missing provenance", {
    missingDecodedProvenance: missingDecodedProvenance.slice(0, 16),
  });

  console.log(`Verified ROFL API metrics artifact: ${inputPath}`);
  console.log(`Roster participants=10, ROFL-only final series=${artifact.totals.roflOnlyFinalMetricSeriesCount}, metric points=${artifact.totals.emittedMetricPointCount}.`);
}

main();
