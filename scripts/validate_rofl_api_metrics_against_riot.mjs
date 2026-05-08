#!/usr/bin/env node

import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

const participantComparisons = [
  ["participantId", "participantId"],
  ["championName", "championName"],
  ["summonerName", "summonerName"],
  ["riotIdGameName", "riotIdGameName"],
  ["riotIdTagline", "riotIdTagline"],
  ["teamId", "teamId"],
  ["teamPosition", "teamPosition"],
  ["individualPosition", "individualPosition"],
  ["lane", "lane"],
  ["role", "role"],
  ["win", "win"],
  ["kills", "kills"],
  ["deaths", "deaths"],
  ["assists", "assists"],
  ["champLevel", "champLevel"],
  ["champExperience", "champExperience"],
  ["timePlayed", "timePlayed", { maxAbsDiff: 1, interpretation: "ROFL statsJson TIME_PLAYED is a final whole-second counter that can differ from Riot Match-V5 by one second at game end." }],
  ["goldEarned", "goldEarned"],
  ["goldSpent", "goldSpent"],
  ["totalMinionsKilled", "totalMinionsKilled"],
  ["neutralMinionsKilled", "neutralMinionsKilled"],
  ["totalAllyJungleMinionsKilled", "totalAllyJungleMinionsKilled"],
  ["totalEnemyJungleMinionsKilled", "totalEnemyJungleMinionsKilled"],
  ["damageDealtToBuildings", "damageDealtToBuildings"],
  ["damageDealtToEpicMonsters", "damageDealtToEpicMonsters"],
  ["damageDealtToObjectives", "damageDealtToObjectives"],
  ["damageDealtToTurrets", "damageDealtToTurrets"],
  ["physicalDamageDealt", "physicalDamageDealt"],
  ["physicalDamageDealtToChampions", "physicalDamageDealtToChampions"],
  ["totalDamageDealtToChampions", "totalDamageDealtToChampions"],
  ["totalDamageDealt", "totalDamageDealt"],
  ["magicDamageDealt", "magicDamageDealt"],
  ["magicDamageDealtToChampions", "magicDamageDealtToChampions"],
  ["trueDamageDealt", "trueDamageDealt"],
  ["trueDamageDealtToChampions", "trueDamageDealtToChampions"],
  ["totalDamageTaken", "totalDamageTaken"],
  ["physicalDamageTaken", "physicalDamageTaken"],
  ["magicDamageTaken", "magicDamageTaken"],
  ["trueDamageTaken", "trueDamageTaken"],
  ["totalHeal", "totalHeal"],
  ["totalHealsOnTeammates", "totalHealsOnTeammates"],
  ["totalUnitsHealed", "totalUnitsHealed"],
  ["totalDamageShieldedOnTeammates", "totalDamageShieldedOnTeammates"],
  ["damageSelfMitigated", "damageSelfMitigated"],
  ["timeCCingOthers", "timeCCingOthers"],
  ["totalTimeCCDealt", "totalTimeCCDealt"],
  ["totalTimeSpentDead", "totalTimeSpentDead"],
  ["visionScore", "visionScore"],
  ["wardsPlaced", "wardsPlaced"],
  ["wardsKilled", "wardsKilled"],
  ["detectorWardsPlaced", "detectorWardsPlaced"],
  ["sightWardsBoughtInGame", "sightWardsBoughtInGame"],
  ["visionWardsBoughtInGame", "visionWardsBoughtInGame"],
  ["consumablesPurchased", "consumablesPurchased"],
  ["itemsPurchased", "itemsPurchased"],
  ["turretKills", "turretKills"],
  ["turretTakedowns", "turretTakedowns"],
  ["turretsLost", "turretsLost"],
  ["inhibitorKills", "inhibitorKills"],
  ["inhibitorTakedowns", "inhibitorTakedowns"],
  ["inhibitorsLost", "inhibitorsLost"],
  ["nexusKills", "nexusKills"],
  ["nexusTakedowns", "nexusTakedowns"],
  ["nexusLost", "nexusLost"],
  ["dragonKills", "dragonKills"],
  ["baronKills", "baronKills"],
  ["objectivesStolen", "objectivesStolen"],
  ["objectivesStolenAssists", "objectivesStolenAssists"],
  ["largestKillingSpree", "largestKillingSpree"],
  ["largestMultiKill", "largestMultiKill"],
  ["allInPings", "allInPings"],
  ["assistMePings", "assistMePings"],
  ["basicPings", "basicPings"],
  ["commandPings", "commandPings"],
  ["dangerPings", "dangerPings"],
  ["enemyMissingPings", "enemyMissingPings"],
  ["enemyVisionPings", "enemyVisionPings"],
  ["getBackPings", "getBackPings"],
  ["holdPings", "holdPings"],
  ["needVisionPings", "needVisionPings"],
  ["onMyWayPings", "onMyWayPings"],
  ["pushPings", "pushPings"],
  ["retreatPings", "retreatPings"],
  ["visionClearedPings", "visionClearedPings"],
  ["spell1Casts", "spell1Casts"],
  ["spell2Casts", "spell2Casts"],
  ["spell3Casts", "spell3Casts"],
  ["spell4Casts", "spell4Casts"],
  ["summoner1Casts", "summoner1Casts"],
  ["summoner2Casts", "summoner2Casts"],
  ["largestCriticalStrike", "largestCriticalStrike"],
  ["longestTimeSpentLiving", "longestTimeSpentLiving"],
  ["killingSprees", "killingSprees"],
  ["doubleKills", "doubleKills"],
  ["tripleKills", "tripleKills"],
  ["quadraKills", "quadraKills"],
  ["pentaKills", "pentaKills"],
  ["unrealKills", "unrealKills"],
  ["championTransform", "championTransform"],
  ["roleBoundItem", "roleBoundItem"],
  ["playerAugment1", "playerAugment1"],
  ["playerAugment2", "playerAugment2"],
  ["playerAugment3", "playerAugment3"],
  ["playerAugment4", "playerAugment4"],
  ["playerAugment5", "playerAugment5"],
  ["playerAugment6", "playerAugment6"],
  ["playerSubteamId", "playerSubteamId"],
  ["subteamPlacement", "subteamPlacement"],
  ["placement", "placement"],
  ["PlayerScore0", "PlayerScore0"],
  ["PlayerScore1", "PlayerScore1"],
  ["PlayerScore2", "PlayerScore2"],
  ["PlayerScore3", "PlayerScore3"],
  ["PlayerScore4", "PlayerScore4"],
  ["PlayerScore5", "PlayerScore5"],
  ["PlayerScore6", "PlayerScore6"],
  ["PlayerScore7", "PlayerScore7"],
  ["PlayerScore8", "PlayerScore8"],
  ["PlayerScore9", "PlayerScore9"],
  ["PlayerScore10", "PlayerScore10"],
  ["PlayerScore11", "PlayerScore11"],
  ["PlayerBehavior.PlayerBehavior_IsHeroInCombat", "PlayerBehavior.PlayerBehavior_IsHeroInCombat"],
  ["teamEarlySurrendered", "teamEarlySurrendered"],
  ["teamIGNBSurrendered", "teamIGNBSurrendered"],
  ["gameEndedInEarlySurrender", "gameEndedInEarlySurrender"],
  ["gameEndedInSurrender", "gameEndedInSurrender"],
  ["gameEndedInIGNBSurrender", "gameEndedInIGNBSurrender"],
  ["challenges.turretTakedowns", "challenges.turretTakedowns"],
  ["missions.playerScore0", "missions.playerScore0"],
  ["missions.playerScore1", "missions.playerScore1"],
  ["missions.playerScore2", "missions.playerScore2"],
  ["missions.playerScore3", "missions.playerScore3"],
  ["missions.playerScore4", "missions.playerScore4"],
  ["missions.playerScore5", "missions.playerScore5"],
  ["missions.playerScore6", "missions.playerScore6"],
  ["missions.playerScore7", "missions.playerScore7"],
  ["missions.playerScore8", "missions.playerScore8"],
  ["missions.playerScore9", "missions.playerScore9"],
  ["missions.playerScore10", "missions.playerScore10"],
  ["missions.playerScore11", "missions.playerScore11"],
  ["item0", "item0"],
  ["item1", "item1"],
  ["item2", "item2"],
  ["item3", "item3"],
  ["item4", "item4"],
  ["item5", "item5"],
  ["item6", "item6"],
  ["summoner1Id", "summoner1Id"],
  ["summoner2Id", "summoner2Id"],
  ["perks.statPerks.offense", "perks.statPerks.offense"],
  ["perks.statPerks.flex", "perks.statPerks.flex"],
  ["perks.statPerks.defense", "perks.statPerks.defense"],
  ["perks.styles", "perks.styles"],
];

const teamComparisons = [
  ["win", "win"],
  ["objectives.champion.kills", "objectives.champion.kills"],
  ["objectives.tower.kills", "objectives.tower.kills"],
  ["objectives.inhibitor.kills", "objectives.inhibitor.kills"],
  ["objectives.dragon.kills", "objectives.dragon.kills"],
  ["objectives.baron.kills", "objectives.baron.kills"],
  ["objectives.atakhan.kills", "objectives.atakhan.kills"],
  ["objectives.horde.kills", "objectives.horde.kills"],
  ["objectives.riftHerald.kills", "objectives.riftHerald.kills"],
];

const finalTimelineParticipantComparisons = [
  ["damageStats.magicDamageDone", "damageStats.magicDamageDone"],
  ["damageStats.magicDamageDoneToChampions", "damageStats.magicDamageDoneToChampions"],
  ["damageStats.magicDamageTaken", "damageStats.magicDamageTaken"],
  ["damageStats.physicalDamageDone", "damageStats.physicalDamageDone"],
  ["damageStats.physicalDamageDoneToChampions", "damageStats.physicalDamageDoneToChampions"],
  ["damageStats.physicalDamageTaken", "damageStats.physicalDamageTaken"],
  ["damageStats.totalDamageDone", "damageStats.totalDamageDone"],
  ["damageStats.totalDamageDoneToChampions", "damageStats.totalDamageDoneToChampions"],
  ["damageStats.totalDamageTaken", "damageStats.totalDamageTaken"],
  ["damageStats.trueDamageDone", "damageStats.trueDamageDone"],
  ["damageStats.trueDamageDoneToChampions", "damageStats.trueDamageDoneToChampions"],
  ["damageStats.trueDamageTaken", "damageStats.trueDamageTaken"],
];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    inputPath: null,
    fixtureDir: null,
    outputPath: null,
    requirePerfectMatch: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--require-perfect-match") {
      args.requirePerfectMatch = true;
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
  console.log("Usage: node ./scripts/validate_rofl_api_metrics_against_riot.mjs --replay-id <id> [--require-perfect-match]");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  return separatorIndex < 0 ? replayId : `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((cursor, key) => cursor?.[key], value);
}

function normalizeValue(value) {
  if (value === "") {
    return null;
  }
  return value;
}

function compareValue(left, right) {
  if ((left && typeof left === "object") || (right && typeof right === "object")) {
    return compareJson(left, right);
  }
  return normalizeValue(left) === normalizeValue(right);
}

function compareValueWithOptions(left, right, options = {}) {
  if (options.maxAbsDiff != null && Number.isFinite(left) && Number.isFinite(right)) {
    return Math.abs(left - right) <= options.maxAbsDiff;
  }
  return compareValue(left, right);
}

function compareJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
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

function assert(condition, message, details = null) {
  if (!condition) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

function verifyValidatedArtifactContract(artifact) {
  assert(artifact.extractionMode === "rofl-only-final-stats", "Riot validation must target the default ROFL-only final-stats artifact", {
    extractionMode: artifact.extractionMode,
  });
  assert(artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles === false, "Validated artifact must declare Riot API files disabled for runtime extraction", {
    roflOnlyInputs: artifact.source?.roflOnlyInputs,
  });
  assert(artifact.source?.decoderArtifactSupervised === false, "Validated artifact must not depend on supervised decoder artifacts", {
    decoderArtifactSupervised: artifact.source?.decoderArtifactSupervised,
  });
  assert(artifact.source?.researchInputPath == null, "Validated artifact must not declare a research input path", {
    researchInputPath: artifact.source?.researchInputPath,
  });
  assert(artifact.fieldCoverage?.offlineRiotValidation?.runtimeInput === false, "Validated artifact must mark Riot fixtures as validation-only", {
    offlineRiotValidation: artifact.fieldCoverage?.offlineRiotValidation,
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
  verifyValidatedArtifactContract(artifact);
  const replayId = args.replayId ?? artifact.source?.replayId;
  const fixtureDir = resolveAbsolute(
    root,
    args.fixtureDir ?? path.join(args.apiRoot, normalizeFixtureReplayId(replayId)),
  );
  const match = readJson(path.join(fixtureDir, "match.json"));
  const timeline = readJson(path.join(fixtureDir, "timeline.json"));
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(path.dirname(inputPath), "rofl-api-metrics-riot-validation.json");

  const riotByParticipantId = new Map((match.info?.participants ?? []).map((participant) => [
    participant.participantId,
    participant,
  ]));
  const riotByTeamId = new Map((match.info?.teams ?? []).map((team) => [
    team.teamId,
    team,
  ]));

  const metadataComparisons = [
    {
      field: "match.metadata.matchId",
      roflValue: artifact.match?.metadata?.matchId,
      riotValue: match.metadata?.matchId ?? `${parseReplayPlatformId(replayId)}_${parseReplayGameId(replayId)}`,
      pass: compareValue(artifact.match?.metadata?.matchId, match.metadata?.matchId ?? `${parseReplayPlatformId(replayId)}_${parseReplayGameId(replayId)}`),
    },
    {
      field: "timeline.metadata.matchId",
      roflValue: artifact.timeline?.metadata?.matchId,
      riotValue: match.metadata?.matchId ?? `${parseReplayPlatformId(replayId)}_${parseReplayGameId(replayId)}`,
      pass: compareValue(artifact.timeline?.metadata?.matchId, match.metadata?.matchId ?? `${parseReplayPlatformId(replayId)}_${parseReplayGameId(replayId)}`),
    },
    {
      field: "match.info.gameId",
      roflValue: artifact.match?.info?.gameId,
      riotValue: match.info?.gameId ?? parseReplayGameId(replayId),
      pass: compareValue(artifact.match?.info?.gameId, match.info?.gameId ?? parseReplayGameId(replayId)),
    },
    {
      field: "timeline.info.gameId",
      roflValue: artifact.timeline?.info?.gameId,
      riotValue: match.info?.gameId ?? parseReplayGameId(replayId),
      pass: compareValue(artifact.timeline?.info?.gameId, match.info?.gameId ?? parseReplayGameId(replayId)),
    },
    {
      field: "match.info.platformId",
      roflValue: artifact.match?.info?.platformId,
      riotValue: match.info?.platformId ?? parseReplayPlatformId(replayId),
      pass: compareValue(artifact.match?.info?.platformId, match.info?.platformId ?? parseReplayPlatformId(replayId)),
    },
    {
      field: "match.info.endOfGameResult",
      roflValue: artifact.match?.info?.endOfGameResult,
      riotValue: match.info?.endOfGameResult,
      pass: compareValue(artifact.match?.info?.endOfGameResult, match.info?.endOfGameResult),
    },
    {
      field: "timeline.info.endOfGameResult",
      roflValue: artifact.timeline?.info?.endOfGameResult,
      riotValue: timeline.info?.endOfGameResult,
      pass: compareValue(artifact.timeline?.info?.endOfGameResult, timeline.info?.endOfGameResult),
    },
  ];
  const identifierComparisons = [
    {
      field: "match.metadata.participants",
      roflValue: artifact.match?.metadata?.participants ?? [],
      riotValue: match.metadata?.participants ?? [],
      pass: compareJson(artifact.match?.metadata?.participants ?? [], match.metadata?.participants ?? []),
      requiredForCheckpoint: false,
      interpretation: "ROFL statsJson participant identifiers are replay-local/anonymized and do not currently equal Riot API PUUIDs.",
    },
    {
      field: "timeline.metadata.participants",
      roflValue: artifact.timeline?.metadata?.participants ?? [],
      riotValue: match.metadata?.participants ?? [],
      pass: compareJson(artifact.timeline?.metadata?.participants ?? [], match.metadata?.participants ?? []),
      requiredForCheckpoint: false,
      interpretation: "ROFL statsJson participant identifiers are replay-local/anonymized and do not currently equal Riot API PUUIDs.",
    },
  ];
  for (const roflParticipant of artifact.match?.info?.participants ?? []) {
    const riotParticipant = riotByParticipantId.get(roflParticipant.participantId);
    if (!riotParticipant) {
      continue;
    }
    identifierComparisons.push(
      {
        field: `match.info.participants[${roflParticipant.participantId}].puuid`,
        participantId: roflParticipant.participantId,
        roflValue: roflParticipant.puuid ?? null,
        riotValue: riotParticipant.puuid ?? null,
        pass: compareValue(roflParticipant.puuid ?? null, riotParticipant.puuid ?? null),
        requiredForCheckpoint: false,
        interpretation: "ROFL statsJson PUUID-like values are replay-local/anonymized and do not currently equal Riot API PUUIDs.",
      },
      {
        field: `match.info.participants[${roflParticipant.participantId}].summonerId`,
        participantId: roflParticipant.participantId,
        roflValue: roflParticipant.summonerId ?? null,
        riotValue: riotParticipant.summonerId ?? null,
        pass: compareValue(roflParticipant.summonerId ?? null, riotParticipant.summonerId ?? null),
        requiredForCheckpoint: false,
        interpretation: "ROFL statsJson summoner IDs are legacy/replay-local identifiers and do not currently equal Riot API encrypted summoner IDs.",
      },
    );
  }

  const comparisons = [];
  for (const roflParticipant of artifact.match?.info?.participants ?? []) {
    const riotParticipant = riotByParticipantId.get(roflParticipant.participantId);
    if (!riotParticipant) {
      comparisons.push({
        participantId: roflParticipant.participantId,
        field: "*",
        pass: false,
        reason: "missing-riot-participant",
      });
      continue;
    }

    for (const [roflPath, riotPath, options = {}] of participantComparisons) {
      const roflValue = getPath(roflParticipant, roflPath);
      const riotValue = getPath(riotParticipant, riotPath);
      comparisons.push({
        participantId: roflParticipant.participantId,
        championName: roflParticipant.championName,
        field: roflPath,
        roflValue,
        riotValue,
        pass: compareValueWithOptions(roflValue, riotValue, options),
        ...(options.maxAbsDiff != null ? { maxAbsDiff: options.maxAbsDiff } : {}),
        ...(options.interpretation ? { interpretation: options.interpretation } : {}),
      });
    }
  }

  const teamComparisonRows = [];
  for (const roflTeam of artifact.match?.info?.teams ?? []) {
    const riotTeam = riotByTeamId.get(roflTeam.teamId);
    if (!riotTeam) {
      teamComparisonRows.push({
        teamId: roflTeam.teamId,
        field: "*",
        pass: false,
        reason: "missing-riot-team",
      });
      continue;
    }
    for (const [roflPath, riotPath] of teamComparisons) {
      const roflValue = getPath(roflTeam, roflPath);
      const riotValue = getPath(riotTeam, riotPath);
      teamComparisonRows.push({
        teamId: roflTeam.teamId,
        field: roflPath,
        roflValue,
        riotValue,
        pass: compareValue(roflValue, riotValue),
      });
    }
  }

  const failures = comparisons.filter((comparison) => !comparison.pass);
  const teamFailures = teamComparisonRows.filter((comparison) => !comparison.pass);
  const roflFinalTimelineFrame = artifact.timeline?.info?.frames?.at(-1) ?? null;
  const riotFinalTimelineFrame = timeline.info?.frames?.at(-1) ?? null;
  const finalTimelineComparisonRows = [];
  for (const [participantId, roflFrame] of Object.entries(roflFinalTimelineFrame?.participantFrames ?? {})) {
    const riotFrame = riotFinalTimelineFrame?.participantFrames?.[participantId];
    if (!riotFrame) {
      finalTimelineComparisonRows.push({
        participantId: Number(participantId),
        field: "*",
        pass: false,
        reason: "missing-riot-final-participant-frame",
      });
      continue;
    }
    for (const [roflPath, riotPath] of finalTimelineParticipantComparisons) {
      const roflValue = getPath(roflFrame, roflPath);
      const riotValue = getPath(riotFrame, riotPath);
      finalTimelineComparisonRows.push({
        participantId: Number(participantId),
        field: roflPath,
        roflValue,
        riotValue,
        pass: compareValue(roflValue, riotValue),
      });
    }
  }
  const finalTimelineFailures = finalTimelineComparisonRows.filter((comparison) => !comparison.pass);
  const metadataFailures = metadataComparisons.filter((comparison) => !comparison.pass);
  const identifierFailures = identifierComparisons.filter((comparison) => !comparison.pass);
  const output = {
    validationSchema: "rofl-api-metrics-riot-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    replayId,
    inputPath,
    fixtureDir,
    mode: "offline-validation-only",
    validatedArtifact: {
      extractionMode: artifact.extractionMode,
      decoderArtifactSupervised: artifact.source?.decoderArtifactSupervised ?? null,
      runtimeRiotApiFiles: artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles ?? null,
      researchInputPath: artifact.source?.researchInputPath ?? null,
    },
    totals: {
      comparisonCount: comparisons.length,
      passCount: comparisons.length - failures.length,
      failCount: failures.length,
      participantCount: (artifact.match?.info?.participants ?? []).length,
      teamComparisonCount: teamComparisonRows.length,
      teamPassCount: teamComparisonRows.length - teamFailures.length,
      teamFailCount: teamFailures.length,
      teamCount: (artifact.match?.info?.teams ?? []).length,
      finalTimelineComparisonCount: finalTimelineComparisonRows.length,
      finalTimelinePassCount: finalTimelineComparisonRows.length - finalTimelineFailures.length,
      finalTimelineFailCount: finalTimelineFailures.length,
      metadataComparisonCount: metadataComparisons.length,
      metadataPassCount: metadataComparisons.length - metadataFailures.length,
      metadataFailCount: metadataFailures.length,
      identifierComparisonCount: identifierComparisons.length,
      identifierPassCount: identifierComparisons.length - identifierFailures.length,
      identifierFailCount: identifierFailures.length,
    },
    failures,
    teamFailures,
    finalTimelineFailures,
    metadataFailures,
    identifierFailures,
    metadataComparisons,
    identifierComparisons,
    comparisons,
    teamComparisons: teamComparisonRows,
    finalTimelineComparisons: finalTimelineComparisonRows,
  };

  writeJson(outputPath, output);
  console.log(`Wrote Riot fixture validation to ${outputPath}`);
  console.log(`ROFL/API participant stat parity: ${output.totals.passCount}/${output.totals.comparisonCount}`);
  console.log(`ROFL/API team stat parity: ${output.totals.teamPassCount}/${output.totals.teamComparisonCount}`);
  console.log(`ROFL/API final timeline damage parity: ${output.totals.finalTimelinePassCount}/${output.totals.finalTimelineComparisonCount}`);
  console.log(`ROFL/API metadata parity: ${output.totals.metadataPassCount}/${output.totals.metadataComparisonCount}`);
  console.log(`ROFL/API identifier parity: ${output.totals.identifierPassCount}/${output.totals.identifierComparisonCount} (non-blocking)`);

  if (args.requirePerfectMatch && (failures.length > 0 || teamFailures.length > 0 || finalTimelineFailures.length > 0 || metadataFailures.length > 0)) {
    throw new Error(`ROFL/API validation failed ${failures.length} participant, ${teamFailures.length} team, ${finalTimelineFailures.length} final timeline, and ${metadataFailures.length} metadata comparison(s).`);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
