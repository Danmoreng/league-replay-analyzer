#!/usr/bin/env node

import path from "path";
import fs from "fs";

import {
  buildSummaryRoster,
  metricDefinitions,
  metricDefinitionByKey,
  readJson,
  resolveAbsolute,
  safeNumber,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const apiMetricPaths = new Map([
  ["totalGold", ["totalGold"]],
  ["level", ["level"]],
  ["xp", ["xp"]],
  ["minionsKilled", ["minionsKilled"]],
  ["jungleMinionsKilled", ["jungleMinionsKilled"]],
  ["health", ["championStats", "health"]],
  ["healthMax", ["championStats", "healthMax"]],
  ["power", ["championStats", "power"]],
  ["powerMax", ["championStats", "powerMax"]],
  ["movementSpeed", ["championStats", "movementSpeed"]],
]);

const integerMetrics = new Set([
  "totalGold",
  "level",
  "xp",
  "minionsKilled",
  "jungleMinionsKilled",
  "health",
  "healthMax",
  "power",
  "powerMax",
  "movementSpeed",
]);

const defaultMaxMeanAbsErrorByMetric = new Map([
  ["currentGold", 150],
  ["totalGold", 500],
  ["level", 1],
  ["xp", 500],
  ["minionsKilled", 8],
  ["jungleMinionsKilled", 2],
  ["health", 200],
  ["healthMax", 200],
  ["power", 100],
  ["powerMax", 100],
  ["movementSpeed", 25],
]);

const riotTimelineChampionStatFields = [
  "abilityHaste",
  "abilityPower",
  "armor",
  "armorPen",
  "armorPenPercent",
  "attackDamage",
  "attackSpeed",
  "bonusArmorPenPercent",
  "bonusMagicPenPercent",
  "ccReduction",
  "cooldownReduction",
  "health",
  "healthMax",
  "healthRegen",
  "lifesteal",
  "magicPen",
  "magicPenPercent",
  "magicResist",
  "movementSpeed",
  "omnivamp",
  "physicalVamp",
  "power",
  "powerMax",
  "powerRegen",
  "spellVamp",
];

const riotMatchChallengeFields16_9 = [
  "12AssistStreakCount",
  "HealFromMapSources",
  "InfernalScalePickup",
  "SWARM_DefeatAatrox",
  "SWARM_DefeatBriar",
  "SWARM_DefeatMiniBosses",
  "SWARM_EvolveWeapon",
  "SWARM_Have3Passives",
  "SWARM_KillEnemy",
  "SWARM_PickupGold",
  "SWARM_ReachLevel50",
  "SWARM_Survive15Min",
  "SWARM_WinWith5EvolvedWeapons",
  "abilityUses",
  "acesBefore15Minutes",
  "alliedJungleMonsterKills",
  "baronTakedowns",
  "blastConeOppositeOpponentCount",
  "bountyGold",
  "buffsStolen",
  "completeSupportQuestInTime",
  "controlWardsPlaced",
  "controlWardTimeCoverageInRiverOrEnemyHalf",
  "damagePerMinute",
  "damageTakenOnTeamPercentage",
  "dancedWithRiftHerald",
  "deathsByEnemyChamps",
  "dodgeSkillShotsSmallWindow",
  "doubleAces",
  "dragonTakedowns",
  "earlyLaningPhaseGoldExpAdvantage",
  "effectiveHealAndShielding",
  "elderDragonKillsWithOpposingSoul",
  "elderDragonMultikills",
  "earliestBaron",
  "earliestDragonTakedown",
  "enemyChampionImmobilizations",
  "enemyJungleMonsterKills",
  "epicMonsterKillsNearEnemyJungler",
  "epicMonsterKillsWithin30SecondsOfSpawn",
  "epicMonsterSteals",
  "epicMonsterStolenWithoutSmite",
  "firstTurretKilled",
  "firstTurretKilledTime",
  "fasterSupportQuestCompletion",
  "fastestLegendary",
  "fistBumpParticipation",
  "flawlessAces",
  "fullTeamTakedown",
  "gameLength",
  "getTakedownsInAllLanesEarlyJungleAsLaner",
  "goldPerMinute",
  "hadOpenNexus",
  "highestChampionDamage",
  "highestCrowdControlScore",
  "highestWardKills",
  "immobilizeAndKillWithAlly",
  "initialBuffCount",
  "initialCrabCount",
  "jungleCsBefore10Minutes",
  "junglerTakedownsNearDamagedEpicMonster",
  "junglerKillsEarlyJungle",
  "kTurretsDestroyedBeforePlatesFall",
  "kda",
  "killAfterHiddenWithAlly",
  "killParticipation",
  "killedChampTookFullTeamDamageSurvived",
  "killingSprees",
  "killsNearEnemyTurret",
  "killsOnOtherLanesEarlyJungleAsLaner",
  "killsOnLanersEarlyJungleAsJungler",
  "killsOnRecentlyHealedByAramPack",
  "killsUnderOwnTurret",
  "killsWithHelpFromEpicMonster",
  "knockEnemyIntoTeamAndKill",
  "landSkillShotsEarlyGame",
  "laneMinionsFirst10Minutes",
  "laningPhaseGoldExpAdvantage",
  "legendaryCount",
  "legendaryItemUsed",
  "lostAnInhibitor",
  "maxCsAdvantageOnLaneOpponent",
  "maxKillDeficit",
  "maxLevelLeadLaneOpponent",
  "mejaisFullStackInTime",
  "moreEnemyJungleThanOpponent",
  "multiKillOneSpell",
  "multiTurretRiftHeraldCount",
  "multikills",
  "multikillsAfterAggressiveFlash",
  "outerTurretExecutesBefore10Minutes",
  "outnumberedKills",
  "outnumberedNexusKill",
  "perfectDragonSoulsTaken",
  "perfectGame",
  "pickKillWithAlly",
  "playedChampSelectPosition",
  "poroExplosions",
  "quickCleanse",
  "quickFirstTurret",
  "quickSoloKills",
  "riftHeraldTakedowns",
  "saveAllyFromDeath",
  "scuttleCrabKills",
  "skillshotsDodged",
  "skillshotsHit",
  "shortestTimeToAceFromFirstTakedown",
  "snowballsHit",
  "soloBaronKills",
  "soloKills",
  "soloTurretsLategame",
  "stealthWardsPlaced",
  "survivedSingleDigitHpCount",
  "survivedThreeImmobilizesInFight",
  "takedownOnFirstTurret",
  "takedowns",
  "takedownsAfterGainingLevelAdvantage",
  "takedownsBeforeJungleMinionSpawn",
  "takedownsFirstXMinutes",
  "takedownsInAlcove",
  "takedownsInEnemyFountain",
  "teamBaronKills",
  "teamDamagePercentage",
  "teamElderDragonKills",
  "teamRiftHeraldKills",
  "tookLargeDamageSurvived",
  "turretPlatesTaken",
  "turretTakedowns",
  "turretsTakenWithRiftHerald",
  "twentyMinionsIn3SecondsCount",
  "twoWardsOneSweeperCount",
  "unseenRecalls",
  "visionScoreAdvantageLaneOpponent",
  "visionScorePerMinute",
  "voidMonsterKill",
  "wardTakedowns",
  "wardTakedownsBefore20M",
  "wardsGuarded",
];

const riotTimelineEventLeafPaths16_9 = [
  "info.frames.[].events.[].actualStartTime",
  "info.frames.[].events.[].afterId",
  "info.frames.[].events.[].assistingParticipantIds.[]",
  "info.frames.[].events.[].beforeId",
  "info.frames.[].events.[].bounty",
  "info.frames.[].events.[].buildingType",
  "info.frames.[].events.[].creatorId",
  "info.frames.[].events.[].gameId",
  "info.frames.[].events.[].goldGain",
  "info.frames.[].events.[].itemId",
  "info.frames.[].events.[].killStreakLength",
  "info.frames.[].events.[].killType",
  "info.frames.[].events.[].killerId",
  "info.frames.[].events.[].killerTeamId",
  "info.frames.[].events.[].laneType",
  "info.frames.[].events.[].level",
  "info.frames.[].events.[].levelUpType",
  "info.frames.[].events.[].monsterSubType",
  "info.frames.[].events.[].monsterType",
  "info.frames.[].events.[].multiKillLength",
  "info.frames.[].events.[].name",
  "info.frames.[].events.[].participantId",
  "info.frames.[].events.[].position.x",
  "info.frames.[].events.[].position.y",
  "info.frames.[].events.[].realTimestamp",
  "info.frames.[].events.[].shutdownBounty",
  "info.frames.[].events.[].skillSlot",
  "info.frames.[].events.[].teamId",
  "info.frames.[].events.[].timestamp",
  "info.frames.[].events.[].towerType",
  "info.frames.[].events.[].type",
  "info.frames.[].events.[].victimDamageDealt.[].basic",
  "info.frames.[].events.[].victimDamageDealt.[].magicDamage",
  "info.frames.[].events.[].victimDamageDealt.[].name",
  "info.frames.[].events.[].victimDamageDealt.[].participantId",
  "info.frames.[].events.[].victimDamageDealt.[].physicalDamage",
  "info.frames.[].events.[].victimDamageDealt.[].spellName",
  "info.frames.[].events.[].victimDamageDealt.[].spellSlot",
  "info.frames.[].events.[].victimDamageDealt.[].trueDamage",
  "info.frames.[].events.[].victimDamageDealt.[].type",
  "info.frames.[].events.[].victimDamageReceived.[].basic",
  "info.frames.[].events.[].victimDamageReceived.[].magicDamage",
  "info.frames.[].events.[].victimDamageReceived.[].name",
  "info.frames.[].events.[].victimDamageReceived.[].participantId",
  "info.frames.[].events.[].victimDamageReceived.[].physicalDamage",
  "info.frames.[].events.[].victimDamageReceived.[].spellName",
  "info.frames.[].events.[].victimDamageReceived.[].spellSlot",
  "info.frames.[].events.[].victimDamageReceived.[].trueDamage",
  "info.frames.[].events.[].victimDamageReceived.[].type",
  "info.frames.[].events.[].victimId",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].basic",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].magicDamage",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].name",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].participantId",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].physicalDamage",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].spellName",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].spellSlot",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].trueDamage",
  "info.frames.[].events.[].victimTeamfightDamageDealt.[].type",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].basic",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].magicDamage",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].name",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].participantId",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].physicalDamage",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].spellName",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].spellSlot",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].trueDamage",
  "info.frames.[].events.[].victimTeamfightDamageReceived.[].type",
  "info.frames.[].events.[].wardType",
  "info.frames.[].events.[].winningTeam",
];

const coverageStatusLegend = {
  decoded: "Metric was emitted from an accepted ROFL-derived source with provenance.",
  noisy: "A candidate existed but failed metric-specific quality or runtime-source gates.",
  unstable_identity: "A candidate existed but participant identity was not stable enough to expose.",
  duplicate_rejected: "A duplicate participant/metric candidate existed and lost to a stronger candidate.",
  not_found: "No accepted ROFL-only source was found for this participant metric.",
};

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    replayId: null,
    summaryPath: null,
    versionGroup: "16.9",
    maxNormalizedRmse: 0.45,
    minCorrelation: 0.85,
    maxMeanAbsError: null,
    includeUnstable: false,
    includeResearchKeyframes: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--summary-path" && index + 1 < argv.length) {
      args.summaryPath = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--max-normalized-rmse" && index + 1 < argv.length) {
      args.maxNormalizedRmse = Number.parseFloat(argv[++index]);
    } else if (arg === "--min-correlation" && index + 1 < argv.length) {
      args.minCorrelation = Number.parseFloat(argv[++index]);
    } else if (arg === "--max-mean-abs-error" && index + 1 < argv.length) {
      args.maxMeanAbsError = Number.parseFloat(argv[++index]);
    } else if (arg === "--include-unstable") {
      args.includeUnstable = true;
    } else if (arg === "--include-research-keyframes") {
      args.includeResearchKeyframes = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.replayId) {
    throw new Error("--replay-id is required.");
  }
  if (!Number.isFinite(args.maxNormalizedRmse) || args.maxNormalizedRmse <= 0) {
    throw new Error("--max-normalized-rmse must be a positive number.");
  }
  if (!Number.isFinite(args.minCorrelation) || args.minCorrelation < -1 || args.minCorrelation > 1) {
    throw new Error("--min-correlation must be between -1 and 1.");
  }
  if (args.maxMeanAbsError != null && (!Number.isFinite(args.maxMeanAbsError) || args.maxMeanAbsError <= 0)) {
    throw new Error("--max-mean-abs-error must be a positive number.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/export_rofl_api_metrics.mjs --replay-id <id> [--version-group 16.9] [--summary-path <path>] [--input-path <path>] [--output-path <path>] [--include-unstable] [--include-research-keyframes] [--max-normalized-rmse 0.45] [--min-correlation 0.85]");
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function setNested(target, segments, value) {
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    cursor[segment] = cursor[segment] ?? {};
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function normalizedValue(metric, value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  if (integerMetrics.has(metric)) {
    return Math.max(0, Math.round(value));
  }
  return value;
}

function metricLimit(metric, args) {
  const definition = metricDefinitionByKey.get(metric);
  return {
    requiredPoints: definition?.minOverlap ?? 6,
    maxNormalizedRmse: Math.min(definition?.maxNormalizedRmse ?? args.maxNormalizedRmse, args.maxNormalizedRmse),
    maxMeanAbsError: args.maxMeanAbsError ?? defaultMaxMeanAbsErrorByMetric.get(metric) ?? null,
  };
}

function assessMetric(metric, summary, args) {
  const limits = metricLimit(metric, args);
  const reasons = [];
  if (!apiMetricPaths.has(metric)) {
    reasons.push("unsupported-api-metric");
  }
  if ((summary.comparedPoints ?? 0) < limits.requiredPoints) {
    reasons.push("insufficient-compared-points");
  }
  if (finite(summary.normalizedRmse) == null || summary.normalizedRmse > limits.maxNormalizedRmse) {
    reasons.push("normalized-rmse-above-useful-threshold");
  }
  if (finite(summary.correlation) == null || summary.correlation < args.minCorrelation) {
    reasons.push("correlation-below-useful-threshold");
  }
  if (limits.maxMeanAbsError != null && (finite(summary.meanAbsError) == null || summary.meanAbsError > limits.maxMeanAbsError)) {
    reasons.push("mean-absolute-error-above-threshold");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    limits,
  };
}

function makeParticipantFrame(participant) {
  return {
    participantId: participant.participantId,
    champion: participant.champion,
    teamId: participant.teamId,
    teamPosition: participant.teamPosition,
    championStats: {},
    damageStats: {},
  };
}

function makeApiShapedChampionStats() {
  return Object.fromEntries(riotTimelineChampionStatFields.map((field) => [field, null]));
}

function makeApiShapedChallenges(decodedChallenges = {}) {
  return {
    ...Object.fromEntries(riotMatchChallengeFields16_9.map((field) => [field, null])),
    legendaryItemUsed: [null],
    ...decodedChallenges,
  };
}

function makeRosterParticipant(rosterEntry) {
  const statMap = rosterEntry.statMap ?? {};
  const finalMetrics = Object.fromEntries(
    Object.entries(rosterEntry.finalMetrics ?? {})
      .filter(([metric, value]) => metric !== "currentGold" && value != null && Number.isFinite(value)),
  );
  return {
    participantId: rosterEntry.rosterIndex + 1,
    championName: rosterEntry.champion,
    teamId: rosterEntry.team,
    teamPosition: rosterEntry.teamPosition,
    riotIdGameName: rosterEntry.riotIdGameName,
    riotIdTagline: rosterEntry.riotIdTagLine,
    finalMetrics,
    apiLikeStats: buildApiLikeStats(statMap),
    provenance: {
      roster: "rofl-summary-players",
      finalMetrics: "rofl-metadata-statsJson",
      apiLikeStats: "rofl-metadata-statsJson",
    },
  };
}

function statNumber(statMap, key) {
  return safeNumber(statMap[key]);
}

function statString(statMap, key) {
  const value = statMap[key];
  return value == null || value === "" ? null : String(value);
}

function boolFromWin(value) {
  if (value === "Win") {
    return true;
  }
  if (value === "Fail") {
    return false;
  }
  return null;
}

function boolFromStatNumber(value) {
  const parsed = safeNumber(value);
  if (parsed == null) {
    return null;
  }
  return parsed !== 0;
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

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

const laneByPlayerPositionCode = new Map([
  [1, "TOP"],
  [2, "MIDDLE"],
  [3, "JUNGLE"],
  [4, "BOTTOM"],
  [5, "UTILITY"],
]);

const roleByPlayerRoleCode = new Map([
  [0, "NONE"],
  [1, "DUO"],
  [2, "SUPPORT"],
  [3, "CARRY"],
  [4, "SOLO"],
]);

function statCodeMap(statMap, statKey, mapping) {
  const code = statNumber(statMap, statKey);
  return code == null ? null : mapping.get(code) ?? null;
}

function statCodeMapOrDefault(statMap, statKey, mapping, fallback) {
  return statCodeMap(statMap, statKey, mapping) ?? fallback;
}

function buildPerkSelection(statMap, index) {
  const perk = statNumber(statMap, `PERK${index}`);
  if (perk == null) {
    return null;
  }
  return compactObject({
    perk,
    var1: statNumber(statMap, `PERK${index}_VAR1`),
    var2: statNumber(statMap, `PERK${index}_VAR2`),
    var3: statNumber(statMap, `PERK${index}_VAR3`),
  });
}

function buildPerkStyle(description, style, selections) {
  if (style == null && !selections.length) {
    return null;
  }
  return {
    description,
    selections,
    style,
  };
}

function buildApiPerks(statMap) {
  const primarySelections = [0, 1, 2, 3]
    .map((index) => buildPerkSelection(statMap, index))
    .filter(Boolean);
  const subSelections = [4, 5]
    .map((index) => buildPerkSelection(statMap, index))
    .filter(Boolean);
  return {
    statPerks: compactObject({
      offense: statNumber(statMap, "STAT_PERK_0"),
      flex: statNumber(statMap, "STAT_PERK_1"),
      defense: statNumber(statMap, "STAT_PERK_2"),
    }),
    styles: [
      buildPerkStyle("primaryStyle", statNumber(statMap, "PERK_PRIMARY_STYLE"), primarySelections),
      buildPerkStyle("subStyle", statNumber(statMap, "PERK_SUB_STYLE"), subSelections),
    ].filter(Boolean),
  };
}

function buildTimelineDamageStats(apiLikeStats) {
  return compactObject({
    magicDamageDone: apiLikeStats.magicDamageDealt,
    magicDamageDoneToChampions: apiLikeStats.magicDamageDealtToChampions,
    magicDamageTaken: apiLikeStats.magicDamageTaken,
    physicalDamageDone: apiLikeStats.physicalDamageDealt,
    physicalDamageDoneToChampions: apiLikeStats.physicalDamageDealtToChampions,
    physicalDamageTaken: apiLikeStats.physicalDamageTaken,
    totalDamageDone: apiLikeStats.totalDamageDealt,
    totalDamageDoneToChampions: apiLikeStats.totalDamageDealtToChampions,
    totalDamageTaken: apiLikeStats.totalDamageTaken,
    trueDamageDone: apiLikeStats.trueDamageDealt,
    trueDamageDoneToChampions: apiLikeStats.trueDamageDealtToChampions,
    trueDamageTaken: apiLikeStats.trueDamageTaken,
  });
}

function buildApiLikeStats(statMap) {
  return compactObject({
    puuid: statString(statMap, "PUUID"),
    summonerId: statString(statMap, "SUMMONER_ID"),
    summonerName: statString(statMap, "NAME"),
    riotIdGameName: statString(statMap, "RIOT_ID_GAME_NAME"),
    riotIdTagline: statString(statMap, "RIOT_ID_TAG_LINE"),
    championName: statString(statMap, "SKIN"),
    lane: statCodeMapOrDefault(statMap, "PLAYER_POSITION", laneByPlayerPositionCode, "NONE"),
    role: statCodeMap(statMap, "PLAYER_ROLE", roleByPlayerRoleCode),
    win: boolFromWin(statMap.WIN),
    kills: statNumber(statMap, "CHAMPIONS_KILLED"),
    deaths: statNumber(statMap, "NUM_DEATHS"),
    assists: statNumber(statMap, "ASSISTS"),
    champLevel: statNumber(statMap, "LEVEL"),
    champExperience: statNumber(statMap, "EXP"),
    timePlayed: statNumber(statMap, "TIME_PLAYED"),
    goldEarned: statNumber(statMap, "GOLD_EARNED"),
    goldSpent: statNumber(statMap, "GOLD_SPENT"),
    totalMinionsKilled: statNumber(statMap, "MINIONS_KILLED"),
    neutralMinionsKilled: statNumber(statMap, "NEUTRAL_MINIONS_KILLED"),
    totalAllyJungleMinionsKilled: statNumber(statMap, "NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE"),
    totalEnemyJungleMinionsKilled: statNumber(statMap, "NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE"),
    neutralMinionsKilledTeamJungle: statNumber(statMap, "NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE"),
    neutralMinionsKilledEnemyJungle: statNumber(statMap, "NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE"),
    totalDamageDealt: statNumber(statMap, "TOTAL_DAMAGE_DEALT"),
    totalDamageDealtToChampions: statNumber(statMap, "TOTAL_DAMAGE_DEALT_TO_CHAMPIONS"),
    damageDealtToBuildings: statNumber(statMap, "TOTAL_DAMAGE_DEALT_TO_BUILDINGS"),
    damageDealtToEpicMonsters: statNumber(statMap, "TOTAL_DAMAGE_DEALT_TO_EPIC_MONSTERS"),
    damageDealtToObjectives: statNumber(statMap, "TOTAL_DAMAGE_DEALT_TO_OBJECTIVES"),
    damageDealtToTurrets: statNumber(statMap, "TOTAL_DAMAGE_DEALT_TO_TURRETS"),
    physicalDamageDealt: statNumber(statMap, "PHYSICAL_DAMAGE_DEALT_PLAYER"),
    physicalDamageDealtToChampions: statNumber(statMap, "PHYSICAL_DAMAGE_DEALT_TO_CHAMPIONS"),
    magicDamageDealt: statNumber(statMap, "MAGIC_DAMAGE_DEALT_PLAYER"),
    magicDamageDealtToChampions: statNumber(statMap, "MAGIC_DAMAGE_DEALT_TO_CHAMPIONS"),
    trueDamageDealt: statNumber(statMap, "TRUE_DAMAGE_DEALT_PLAYER"),
    trueDamageDealtToChampions: statNumber(statMap, "TRUE_DAMAGE_DEALT_TO_CHAMPIONS"),
    totalDamageTaken: statNumber(statMap, "TOTAL_DAMAGE_TAKEN"),
    physicalDamageTaken: statNumber(statMap, "PHYSICAL_DAMAGE_TAKEN"),
    magicDamageTaken: statNumber(statMap, "MAGIC_DAMAGE_TAKEN"),
    trueDamageTaken: statNumber(statMap, "TRUE_DAMAGE_TAKEN"),
    totalHeal: statNumber(statMap, "TOTAL_HEAL"),
    totalHealsOnTeammates: statNumber(statMap, "TOTAL_HEAL_ON_TEAMMATES"),
    totalUnitsHealed: statNumber(statMap, "TOTAL_UNITS_HEALED"),
    totalDamageShieldedOnTeammates: statNumber(statMap, "TOTAL_DAMAGE_SHIELDED_ON_TEAMMATES"),
    damageSelfMitigated: statNumber(statMap, "TOTAL_DAMAGE_SELF_MITIGATED"),
    timeCCingOthers: statNumber(statMap, "TIME_CCING_OTHERS"),
    totalTimeCCDealt: statNumber(statMap, "TOTAL_TIME_CROWD_CONTROL_DEALT"),
    totalTimeSpentDead: statNumber(statMap, "TOTAL_TIME_SPENT_DEAD"),
    visionScore: statNumber(statMap, "VISION_SCORE"),
    wardsPlaced: statNumber(statMap, "WARD_PLACED"),
    wardsKilled: statNumber(statMap, "WARD_KILLED"),
    detectorWardsPlaced: statNumber(statMap, "WARD_PLACED_DETECTOR"),
    sightWardsBoughtInGame: statNumber(statMap, "SIGHT_WARDS_BOUGHT_IN_GAME"),
    visionWardsBoughtInGame: statNumber(statMap, "VISION_WARDS_BOUGHT_IN_GAME"),
    consumablesPurchased: statNumber(statMap, "CONSUMABLES_PURCHASED"),
    itemsPurchased: statNumber(statMap, "ITEMS_PURCHASED"),
    turretKills: statNumber(statMap, "TURRETS_KILLED"),
    turretTakedowns: statNumber(statMap, "TURRET_TAKEDOWNS"),
    turretsLost: statNumber(statMap, "FRIENDLY_TURRET_LOST"),
    inhibitorKills: statNumber(statMap, "BARRACKS_KILLED"),
    inhibitorTakedowns: statNumber(statMap, "BARRACKS_TAKEDOWNS"),
    inhibitorsLost: statNumber(statMap, "FRIENDLY_DAMPEN_LOST"),
    nexusKills: statNumber(statMap, "HQ_KILLED"),
    nexusTakedowns: statNumber(statMap, "HQ_TAKEDOWNS"),
    nexusLost: statNumber(statMap, "FRIENDLY_HQ_LOST"),
    dragonKills: statNumber(statMap, "DRAGON_KILLS"),
    baronKills: statNumber(statMap, "BARON_KILLS"),
    atakhanKills: statNumber(statMap, "ATAKHAN_KILLS"),
    hordeKills: statNumber(statMap, "HORDE_KILLS"),
    riftHeraldKills: statNumber(statMap, "RIFT_HERALD_KILLS"),
    objectivesStolen: statNumber(statMap, "OBJECTIVES_STOLEN"),
    objectivesStolenAssists: statNumber(statMap, "OBJECTIVES_STOLEN_ASSISTS"),
    largestKillingSpree: statNumber(statMap, "LARGEST_KILLING_SPREE"),
    largestMultiKill: statNumber(statMap, "LARGEST_MULTI_KILL"),
    largestCriticalStrike: statNumber(statMap, "LARGEST_CRITICAL_STRIKE"),
    longestTimeSpentLiving: statNumber(statMap, "LONGEST_TIME_SPENT_LIVING"),
    killingSprees: statNumber(statMap, "KILLING_SPREES"),
    doubleKills: statNumber(statMap, "DOUBLE_KILLS"),
    tripleKills: statNumber(statMap, "TRIPLE_KILLS"),
    quadraKills: statNumber(statMap, "QUADRA_KILLS"),
    pentaKills: statNumber(statMap, "PENTA_KILLS"),
    unrealKills: statNumber(statMap, "UNREAL_KILLS"),
    allInPings: statNumber(statMap, "ALL_IN_PINGS"),
    assistMePings: statNumber(statMap, "ASSIST_ME_PINGS"),
    basicPings: statNumber(statMap, "BASIC_PINGS"),
    commandPings: statNumber(statMap, "COMMAND_PINGS"),
    dangerPings: statNumber(statMap, "DANGER_PINGS"),
    enemyMissingPings: statNumber(statMap, "ENEMY_MISSING_PINGS"),
    enemyVisionPings: statNumber(statMap, "ENEMY_VISION_PINGS"),
    getBackPings: statNumber(statMap, "GET_BACK_PINGS"),
    holdPings: statNumber(statMap, "HOLD_PINGS"),
    needVisionPings: statNumber(statMap, "NEED_VISION_PINGS"),
    onMyWayPings: statNumber(statMap, "ON_MY_WAY_PINGS"),
    pushPings: statNumber(statMap, "PUSH_PINGS"),
    retreatPings: statNumber(statMap, "RETREAT_PINGS"),
    visionClearedPings: statNumber(statMap, "VISION_CLEARED_PINGS"),
    spell1Casts: statNumber(statMap, "SPELL1_CAST"),
    spell2Casts: statNumber(statMap, "SPELL2_CAST"),
    spell3Casts: statNumber(statMap, "SPELL3_CAST"),
    spell4Casts: statNumber(statMap, "SPELL4_CAST"),
    summoner1Casts: statNumber(statMap, "SUMMON_SPELL1_CAST"),
    summoner2Casts: statNumber(statMap, "SUMMON_SPELL2_CAST"),
    championTransform: statNumber(statMap, "CHAMPION_TRANSFORM"),
    roleBoundItem: statNumber(statMap, "ROLE_BOUND_ITEM"),
    playerAugment1: statNumber(statMap, "PLAYER_AUGMENT_1"),
    playerAugment2: statNumber(statMap, "PLAYER_AUGMENT_2"),
    playerAugment3: statNumber(statMap, "PLAYER_AUGMENT_3"),
    playerAugment4: statNumber(statMap, "PLAYER_AUGMENT_4"),
    playerAugment5: statNumber(statMap, "PLAYER_AUGMENT_5"),
    playerAugment6: statNumber(statMap, "PLAYER_AUGMENT_6"),
    playerSubteamId: statNumber(statMap, "PLAYER_SUBTEAM"),
    subteamPlacement: statNumber(statMap, "PLAYER_SUBTEAM_PLACEMENT"),
    placement: statNumber(statMap, "PLAYER_SUBTEAM_PLACEMENT"),
    PlayerScore0: statNumber(statMap, "PLAYER_SCORE_0"),
    PlayerScore1: statNumber(statMap, "PLAYER_SCORE_1"),
    PlayerScore2: statNumber(statMap, "PLAYER_SCORE_2"),
    PlayerScore3: statNumber(statMap, "PLAYER_SCORE_3"),
    PlayerScore4: statNumber(statMap, "PLAYER_SCORE_4"),
    PlayerScore5: statNumber(statMap, "PLAYER_SCORE_5"),
    PlayerScore6: statNumber(statMap, "PLAYER_SCORE_6"),
    PlayerScore7: statNumber(statMap, "PLAYER_SCORE_7"),
    PlayerScore8: statNumber(statMap, "PLAYER_SCORE_8"),
    PlayerScore9: statNumber(statMap, "PLAYER_SCORE_9"),
    PlayerScore10: statNumber(statMap, "PLAYER_SCORE_10"),
    PlayerScore11: statNumber(statMap, "PLAYER_SCORE_11"),
    PlayerBehavior: compactObject({
      PlayerBehavior_IsHeroInCombat: statNumber(statMap, "PlayerBehavior_IsHeroInCombat"),
    }),
    teamEarlySurrendered: boolFromStatNumber(statMap.TEAM_EARLY_SURRENDERED),
    teamIGNBSurrendered: boolFromStatNumber(statMap.TEAM_IGNB_SURRENDERED),
    gameEndedInEarlySurrender: boolFromStatNumber(statMap.GAME_ENDED_IN_EARLY_SURRENDER),
    gameEndedInSurrender: boolFromStatNumber(statMap.GAME_ENDED_IN_SURRENDER),
    gameEndedInIGNBSurrender: boolFromStatNumber(statMap.GAME_ENDED_IN_IGNB_SURRENDER),
    challenges: compactObject({
      turretTakedowns: statNumber(statMap, "TURRET_TAKEDOWNS"),
    }),
    missions: compactObject({
      playerScore0: statNumber(statMap, "PLAYER_SCORE_0"),
      playerScore1: statNumber(statMap, "PLAYER_SCORE_1"),
      playerScore2: statNumber(statMap, "PLAYER_SCORE_2"),
      playerScore3: statNumber(statMap, "PLAYER_SCORE_3"),
      playerScore4: statNumber(statMap, "PLAYER_SCORE_4"),
      playerScore5: statNumber(statMap, "PLAYER_SCORE_5"),
      playerScore6: statNumber(statMap, "PLAYER_SCORE_6"),
      playerScore7: statNumber(statMap, "PLAYER_SCORE_7"),
      playerScore8: statNumber(statMap, "PLAYER_SCORE_8"),
      playerScore9: statNumber(statMap, "PLAYER_SCORE_9"),
      playerScore10: statNumber(statMap, "PLAYER_SCORE_10"),
      playerScore11: statNumber(statMap, "PLAYER_SCORE_11"),
    }),
    item0: statNumber(statMap, "ITEM0"),
    item1: statNumber(statMap, "ITEM1"),
    item2: statNumber(statMap, "ITEM2"),
    item3: statNumber(statMap, "ITEM3"),
    item4: statNumber(statMap, "ITEM4"),
    item5: statNumber(statMap, "ITEM5"),
    item6: statNumber(statMap, "ITEM6"),
    summoner1Id: statNumber(statMap, "SUMMONER_SPELL_1"),
    summoner2Id: statNumber(statMap, "SUMMONER_SPELL_2"),
    perks: buildApiPerks(statMap),
  });
}

function buildMatchInfoParticipant(participant) {
  return {
    participantId: participant.participantId,
    puuid: participant.apiLikeStats?.puuid ?? null,
    summonerId: participant.apiLikeStats?.summonerId ?? null,
    summonerName: participant.apiLikeStats?.summonerName ?? "",
    riotIdGameName: participant.riotIdGameName,
    riotIdTagline: participant.riotIdTagline,
    championId: null,
    championName: participant.championName,
    eligibleForProgression: null,
    firstBloodAssist: null,
    firstBloodKill: null,
    firstTowerAssist: null,
    firstTowerKill: null,
    profileIcon: null,
    summonerLevel: null,
    teamId: participant.teamId,
    teamPosition: participant.teamPosition,
    individualPosition: participant.teamPosition,
    ...participant.apiLikeStats,
    challenges: makeApiShapedChallenges(participant.apiLikeStats?.challenges),
    provenance: participant.provenance,
  };
}

function buildTimelineInfoParticipant(participant) {
  return {
    participantId: participant.participantId,
    puuid: participant.apiLikeStats?.puuid ?? null,
  };
}

function buildTeamInfo(rosterParticipants) {
  const byTeam = new Map();
  for (const participant of rosterParticipants) {
    const list = byTeam.get(participant.teamId) ?? [];
    list.push(participant);
    byTeam.set(participant.teamId, list);
  }

  return [...byTeam.entries()]
    .sort(([left], [right]) => left - right)
    .map(([teamId, participants]) => {
      const stats = participants.map((participant) => participant.apiLikeStats ?? {});
      const sum = (key) => stats.reduce((total, stat) => total + (Number.isFinite(stat[key]) ? stat[key] : 0), 0);
      const max = (key) => {
        const values = stats.map((stat) => stat[key]).filter(Number.isFinite);
        return values.length ? Math.max(...values) : 0;
      };
      const winVotes = stats.map((stat) => stat.win).filter((value) => typeof value === "boolean");
      const win = winVotes.length ? winVotes.filter(Boolean).length > (winVotes.length / 2) : null;

      return {
        teamId,
        bans: Array.from({ length: 5 }, () => ({
          championId: null,
          pickTurn: null,
        })),
        win,
        objectives: {
          champion: {
            first: null,
            kills: sum("kills"),
            provenance: "sum-participant-statsJson",
          },
          tower: {
            first: null,
            kills: sum("turretKills"),
            takedowns: sum("turretTakedowns"),
            provenance: "sum-participant-statsJson",
          },
          inhibitor: {
            first: null,
            kills: sum("inhibitorKills"),
            takedowns: sum("inhibitorTakedowns"),
            provenance: "sum-participant-statsJson",
          },
          dragon: {
            first: null,
            kills: max("dragonKills"),
            provenance: "max-participant-statsJson",
          },
          baron: {
            first: null,
            kills: max("baronKills"),
            provenance: "max-participant-statsJson",
          },
          atakhan: {
            first: null,
            kills: max("atakhanKills"),
            provenance: "max-participant-statsJson",
          },
          horde: {
            first: null,
            kills: max("hordeKills"),
            provenance: "max-participant-statsJson",
          },
          riftHerald: {
            first: null,
            kills: max("riftHeraldKills"),
            provenance: "max-participant-statsJson",
          },
        },
        totals: {
          kills: sum("kills"),
          deaths: sum("deaths"),
          assists: sum("assists"),
          goldEarned: sum("goldEarned"),
          totalDamageDealtToChampions: sum("totalDamageDealtToChampions"),
          totalDamageTaken: sum("totalDamageTaken"),
          visionScore: sum("visionScore"),
        },
        provenance: {
          values: "rofl-metadata-statsJson",
          aggregation: "participant-final-stats",
        },
      };
    });
}

function qualitySortKey(entry) {
  return [
    entry.summary.normalizedRmse ?? Number.POSITIVE_INFINITY,
    -(entry.summary.correlation ?? Number.NEGATIVE_INFINITY),
    entry.summary.meanAbsError ?? Number.POSITIVE_INFINITY,
    -(entry.summary.comparedPoints ?? 0),
  ];
}

function compareCandidateQuality(left, right) {
  const leftKey = qualitySortKey(left);
  const rightKey = qualitySortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] !== rightKey[index]) {
      return leftKey[index] - rightKey[index];
    }
  }
  return 0;
}

function addCoverageReason(coverageByParticipant, participantId, metric, status, reason, details = null) {
  const participantCoverage = coverageByParticipant.get(participantId);
  if (!participantCoverage) {
    return;
  }
  const entry = participantCoverage.metrics[metric] ?? {
    status: "not_found",
    reasons: [],
  };
  if (entry.status === "decoded") {
    return;
  }
  entry.status = status;
  if (reason && !entry.reasons.includes(reason)) {
    entry.reasons.push(reason);
  }
  if (details) {
    entry.details = entry.details ?? [];
    entry.details.push(details);
  }
  participantCoverage.metrics[metric] = entry;
}

function setCoverageDecoded(coverageByParticipant, participantId, metric, details) {
  const participantCoverage = coverageByParticipant.get(participantId);
  if (!participantCoverage) {
    return;
  }
  participantCoverage.metrics[metric] = {
    status: "decoded",
    reasons: [],
    ...details,
  };
}

function annotateCoverageMetric(coverageByParticipant, participantId, metric, key, details) {
  const participantCoverage = coverageByParticipant.get(participantId);
  const entry = participantCoverage?.metrics?.[metric];
  if (!entry) {
    return;
  }
  entry[key] = details;
}

function annotateNonFinalIdentityCoverage(coverageByParticipant, rejectedCandidateArtifacts) {
  const diagnostics = rejectedCandidateArtifacts.nonFinalScalarIdentity?.assignmentArtifact?.diagnostics ?? {};
  const weakExamplesByMetric = diagnostics.topWeakSupportExamplesByMetric ?? {};
  for (const [metric, examples] of Object.entries(weakExamplesByMetric)) {
    for (const example of examples ?? []) {
      const participantId = example.expectedParticipantId;
      const duplicateCount = example.targetDuplicateCount ?? 0;
      annotateCoverageMetric(coverageByParticipant, participantId, metric, "nonFinalKeyframeCandidate", {
        status: duplicateCount > 1 ? "duplicate_rejected" : "noisy",
        reason: duplicateCount > 1
          ? "final-stat-anchor-shared-by-multiple-participants"
          : "below-min-support-score",
        familyKey: example.familyKey,
        slotIndex: example.slotIndex,
        predicted: example.predicted,
        target: example.target,
        score: example.score,
        offset: example.offset,
        decodeLabel: example.decodeLabel,
        targetDuplicateCount: duplicateCount,
        targetDuplicateParticipants: example.targetDuplicateParticipants ?? [],
      });
    }
  }
}

function initializeCoverage(rosterParticipants) {
  return new Map(rosterParticipants.map((participant) => [
    participant.participantId,
    {
      participantId: participant.participantId,
      champion: participant.championName,
      metrics: Object.fromEntries(metricDefinitions.map((metric) => [
        metric.key,
        {
          status: "not_found",
          reasons: ["no-accepted-rofl-keyframe-series"],
        },
      ])),
    },
  ]));
}

function buildMatchCoverage(rosterParticipants) {
  return rosterParticipants.map((participant) => {
    const apiLikeStats = participant.apiLikeStats ?? {};
    const finalMetrics = participant.finalMetrics ?? {};
    return {
      participantId: participant.participantId,
      champion: participant.championName,
      status: "decoded",
      provenance: {
        roster: "rofl-summary-players",
        finalMetrics: "rofl-metadata-statsJson",
        apiLikeStats: "rofl-metadata-statsJson",
      },
      finalMetricKeys: Object.keys(finalMetrics).sort(),
      apiLikeStatKeys: Object.keys(apiLikeStats).sort(),
      finalMetricCount: Object.keys(finalMetrics).length,
      apiLikeStatCount: Object.keys(apiLikeStats).length,
    };
  });
}

function buildIdentityLinkageSummary(rosterParticipants, emittedTimelineParticipantIds, rejectedCandidateArtifacts) {
  const nonFinalScalarIdentity = rejectedCandidateArtifacts.nonFinalScalarIdentity ?? {};
  const roflIdentifiers = rosterParticipants.map((participant) => participant.apiLikeStats?.puuid).filter(Boolean);
  const metricSupportQuality = nonFinalScalarIdentity.assignmentArtifact?.metricSupportQuality ?? {};
  const nextDecoderTargets = Object.entries(metricSupportQuality)
    .map(([metric, quality]) => ({
      metric,
      positiveScoreCount: quality.positiveScoreCount ?? 0,
      belowSupportScoreRate: quality.belowSupportScoreRate ?? null,
      acceptedEdgeSupportRate: quality.acceptedEdgeSupportRate ?? null,
      priority: (quality.acceptedEdgeSupportCount ?? 0) === 0 && (quality.positiveScoreCount ?? 0) > 0
        ? "investigate"
        : "monitor",
      reason: (quality.belowSupportScoreRate ?? 0) >= 0.5
        ? "many candidate supports fail metric-specific quality"
        : "candidate supports pass more often but still do not form accepted identity edges",
    }))
    .sort((left, right) =>
      (right.belowSupportScoreRate ?? -1) - (left.belowSupportScoreRate ?? -1) ||
      right.positiveScoreCount - left.positiveScoreCount,
    );
  return {
    evidenceMatrix: [
      {
        evidenceClass: "ROFL metadata/statsJson roster",
        status: rosterParticipants.length === 10 ? "decoded" : "partial",
        runtimeApiData: true,
        participantScope: "final roster and final participantFrames",
        evidenceRefs: ["summary.players", "metadata.statsJson", "match.info.participants", "timeline.info.participants"],
        promotion: "accepted_for_final_roster_identity",
      },
      {
        evidenceClass: "roster order",
        status: emittedTimelineParticipantIds.size === 10 ? "decoded" : "partial",
        runtimeApiData: true,
        participantScope: "participantId 1..10 final frame ordering",
        evidenceRefs: ["identityLinkage.finalRosterIdentity", "coverage[].participantId"],
        promotion: "accepted_for_final_frame_identity_only",
      },
      {
        evidenceClass: "team/champion metadata",
        status: rosterParticipants.every((participant) => participant.teamId != null && participant.championName) ? "decoded" : "partial",
        runtimeApiData: true,
        participantScope: "final roster rows",
        evidenceRefs: ["match.info.participants[].teamId", "match.info.participants[].championName"],
        promotion: "accepted_for_final_roster_identity",
      },
      {
        evidenceClass: "cross-metric final stats consistency",
        status: nonFinalScalarIdentity.assignmentArtifact?.canonicalCandidateCount === 0 ? "rejected" : "partial",
        runtimeApiData: false,
        participantScope: "non-final keyframe scalar rows",
        evidenceRefs: ["rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.metricSupportQuality"],
        promotion: "not_promoted",
        blocker: "positive support does not form accepted multi-metric replay-only identity edges",
      },
      {
        evidenceClass: "startup roster/order tokens",
        status: nonFinalScalarIdentity.startupRosterTokenScan?.status ?? "not_found",
        runtimeApiData: false,
        participantScope: "startup records",
        evidenceRefs: ["rejectedCandidateArtifacts.nonFinalScalarIdentity.startupRosterTokenScan"],
        promotion: "diagnostic_only",
        blocker: "startup tokens are not linked to non-final keyframe state rows",
      },
      {
        evidenceClass: "startup-to-keyframe row link",
        status: nonFinalScalarIdentity.startupKeyframeRowLink?.status ?? "not_found",
        runtimeApiData: false,
        participantScope: "startup roster/order tokens to keyframe row families",
        evidenceRefs: ["rejectedCandidateArtifacts.nonFinalScalarIdentity.startupKeyframeRowLink"],
        promotion: "not_promoted",
        blocker: "no direct startup-token to stable keyframe row identity link is established",
      },
      {
        evidenceClass: "keyframe row identity gates",
        status: rejectedCandidateArtifacts.reconstructionRowIdentity?.status ?? "not_found",
        runtimeApiData: false,
        participantScope: "241-family chunk rows",
        evidenceRefs: ["rejectedCandidateArtifacts.reconstructionRowIdentity.rowIdentityArtifacts"],
        promotion: "not_promoted",
        blocker: "row continuity is below threshold or duplicated and row-to-participant mapping is not established",
      },
      {
        evidenceClass: "handle graph row links",
        status: nonFinalScalarIdentity.handleGraphRowLinkCandidates?.status ?? "not_found",
        runtimeApiData: false,
        participantScope: "candidate row-reference graph",
        evidenceRefs: ["rejectedCandidateArtifacts.nonFinalScalarIdentity.handleGraphRowLinkCandidates"],
        promotion: "not_promoted",
        blocker: "all handle graph row-link candidates remain weak",
      },
    ],
    finalRosterIdentity: {
      status: rosterParticipants.length === 10 ? "decoded" : "partial",
      participantCount: rosterParticipants.length,
      emittedTimelineParticipantCount: emittedTimelineParticipantIds.size,
      method: "rofl-summary-roster-order",
      evidence: [
        "summary.players order",
        "metadata.statsJson order",
        "team/champion metadata",
        "final statsJson rows",
      ],
    },
    roflMetadataParticipantIdentifiers: {
      status: roflIdentifiers.length === 10 ? "decoded_internal" : "partial",
      count: roflIdentifiers.length,
      source: "rofl-metadata-statsJson",
      fields: [
        "metadata.participants[]",
        "info.participants[].puuid",
        "info.participants[].summonerId",
      ],
      apiFieldCompatibility: "shape-only",
      warning: "These identifiers populate API-shaped metadata.participants and participant identifier fields but are not verified Riot API PUUIDs or encrypted summoner IDs.",
    },
    riotApiIdentifierParity: {
      status: "not_found",
      fields: [
        "metadata.participants[]",
        "info.participants[].puuid",
        "info.participants[].summonerId",
      ],
      reason: "ROFL statsJson participant identifiers are replay-local/anonymized or legacy IDs and do not currently equal Riot API PUUIDs or encrypted summoner IDs.",
      runtimeInput: false,
      offlineValidation: "identifier parity is reported by rofl-api-metrics-riot-validation.json as non-blocking",
    },
    nonFinalScalarIdentity: {
      status: nonFinalScalarIdentity.status ?? "not_found",
      metricSet: nonFinalScalarIdentity.assignmentArtifact?.metricSet ?? null,
      assignmentCount: nonFinalScalarIdentity.assignmentArtifact?.assignmentCount ?? null,
      canonicalCandidateCount: nonFinalScalarIdentity.assignmentArtifact?.canonicalCandidateCount ?? null,
      startupRosterTokenScan: nonFinalScalarIdentity.startupRosterTokenScan ?? { exists: false },
      startupKeyframeRowLink: nonFinalScalarIdentity.startupKeyframeRowLink ?? { exists: false },
      handleGraphRowLinkCandidates: nonFinalScalarIdentity.handleGraphRowLinkCandidates ?? { exists: false },
      runtimePromotionGate: {
        status: "blocked",
        runtimeApiData: false,
        requiredGates: [
          {
            gate: "final-roster-identity",
            status: rosterParticipants.length === 10 && emittedTimelineParticipantIds.size === 10 ? "passed" : "blocked",
            evidenceRef: "identityLinkage.finalRosterIdentity",
          },
          {
            gate: "non-final-scalar-identity",
            status: (nonFinalScalarIdentity.assignmentArtifact?.canonicalCandidateCount ?? 0) > 0 ? "passed" : "blocked",
            evidenceRef: "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact",
            blocker: "canonicalCandidateCount=0",
          },
          {
            gate: "startup-token-to-keyframe-row-link",
            status: "blocked",
            evidenceRef: "rejectedCandidateArtifacts.nonFinalScalarIdentity.startupKeyframeRowLink",
            blocker: "directStartupToKeyframeRowLink=not_found",
          },
          {
            gate: "row-identity-coherence",
            status: (rejectedCandidateArtifacts.reconstructionRowIdentity?.rowIdentityArtifacts ?? []).some((entry) => entry.participantIdentity === true)
              ? "passed"
              : "blocked",
            evidenceRef: "rejectedCandidateArtifacts.reconstructionRowIdentity.rowIdentityArtifacts",
            blocker: "241-family row gates remain not_promoted",
          },
          {
            gate: "handle-graph-row-link",
            status: nonFinalScalarIdentity.handleGraphRowLinkCandidates?.topConfidence === "strong" ? "passed" : "blocked",
            evidenceRef: "rejectedCandidateArtifacts.nonFinalScalarIdentity.handleGraphRowLinkCandidates",
            blocker: "handle graph candidates are weak",
          },
          {
            gate: "position-identity-without-priors",
            status: (rejectedCandidateArtifacts.positions?.qualityGateSummary?.noPriorsAssignedParticipantCount ?? 0) === 10 ? "passed" : "blocked",
            evidenceRef: "rejectedCandidateArtifacts.positions.noPriorsDiagnostic",
            blocker: `no-priors assignment=${rejectedCandidateArtifacts.positions?.qualityGateSummary?.noPriorsAssignedParticipantCount ?? null}/10`,
          },
        ],
        nextPromotionStep: "Find a ROFL-only link from startup roster/order evidence to non-final keyframe/chunk state rows, then rerun scalar, row, handle, and movement gates.",
      },
      supportBelowMetricScoreCount: nonFinalScalarIdentity.assignmentArtifact?.diagnostics?.supportBelowMetricScoreCount ?? null,
      ambiguousFinalTargetSupportCountsByMetric:
        nonFinalScalarIdentity.assignmentArtifact?.diagnostics?.ambiguousFinalTargetSupportCountsByMetric ?? {},
      duplicateFinalTargetValueCountsByMetric:
        nonFinalScalarIdentity.assignmentArtifact?.diagnostics?.duplicateFinalTargetValueCountsByMetric ?? {},
      nextDecoderTargets,
      blocker: "no accepted replay-only non-final keyframe participant identity after metric-specific quality gates",
    },
  };
}

function buildRoflDerivedFieldMap(rejectedCandidateArtifacts = {}) {
  return {
    match: {
      "metadata.matchId": {
        status: "decoded",
        source: "rofl-file-name",
      },
      "metadata.participants": {
        status: "decoded_internal",
        source: "rofl-metadata-statsJson",
        note: "API-shaped list populated from ROFL internal participant identifiers, not verified Riot PUUIDs.",
      },
      "info.gameId": {
        status: "decoded",
        source: "rofl-file-name",
      },
      "info.platformId": {
        status: "decoded",
        source: "rofl-file-name",
      },
      "info.gameVersion": {
        status: "decoded",
        source: "rofl-summary",
      },
      "info.gameDuration": {
        status: "decoded",
        source: "rofl-summary",
      },
      "info.gameCreation": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.gameEndTimestamp": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.gameMode": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.gameName": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.gameStartTimestamp": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.gameType": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.mapId": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.queueId": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.tournamentCode": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.endOfGameResult": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        calibration: "derived-final-stats-presence",
      },
      "info.participants": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
      },
      "info.participants[].championId": {
        status: "not_promoted",
        source: "rofl-metadata-champion-name",
        runtimeValue: null,
        note: "ROFL exposes champion names, but no accepted runtime champion-name-to-Riot-id mapping is currently part of the ROFL-only contract.",
      },
      "info.participants[].eligibleForProgression": {
        status: "not_promoted",
        source: "no-decoded-rofl-source",
        runtimeValue: null,
        note: "Constant true matches this fixture but is not promoted without a decoded ROFL source.",
      },
      "info.participants[].firstBloodAssist": {
        status: "not_found",
        source: "requires-event-order-decoder",
        runtimeValue: null,
      },
      "info.participants[].firstBloodKill": {
        status: "not_found",
        source: "requires-event-order-decoder",
        runtimeValue: null,
      },
      "info.participants[].firstTowerAssist": {
        status: "not_found",
        source: "requires-event-order-decoder",
        runtimeValue: null,
      },
      "info.participants[].firstTowerKill": {
        status: "not_found",
        source: "requires-event-order-decoder",
        runtimeValue: null,
      },
      "info.participants[].profileIcon": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.participants[].summonerLevel": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.participants[].challenges.turretTakedowns": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        note: "Other Riot challenge fields remain gaps until their ROFL semantics are validated.",
      },
      "info.participants[].challenges.*": {
        status: "not_found",
        source: "no-accepted-rofl-source",
        runtimeValue: "null-leaf-placeholders-except-promoted-fields",
        promotedFields: [
          "turretTakedowns",
        ],
        note: "Patch 16.9 challenge leaves are API-shaped as null unless their ROFL statsJson semantics are validated.",
      },
      "info.teams": {
        status: "decoded",
        source: "participant-final-statsJson-aggregation",
      },
      "info.teams[].objectives.*.first": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
        note: "API-shaped first objective fields are emitted as null because embedded ROFL final statsJson has objective counts but no event-order source for first objective takers.",
      },
      "info.teams[].bans": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: "array-of-null-placeholders",
        note: "API-shaped ban entries are emitted with null championId and pickTurn because embedded ROFL metadata/statsJson does not contain pick/ban data.",
      },
    },
    timeline: {
      "metadata.matchId": {
        status: "decoded",
        source: "rofl-file-name",
      },
      "metadata.participants": {
        status: "decoded_internal",
        source: "rofl-metadata-statsJson",
        note: "API-shaped list populated from ROFL internal participant identifiers, not verified Riot PUUIDs.",
      },
      "info.gameId": {
        status: "decoded",
        source: "rofl-file-name",
      },
      "info.endOfGameResult": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        calibration: "derived-final-stats-presence",
      },
      "info.participants": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
      },
      "info.frames[].events": {
        status: "not_found",
        source: "chunk-delta-events-not-extracted",
        apiShapedNotFoundFields: riotTimelineEventLeafPaths16_9,
        runtimeEmission: "empty-events-arrays",
        rejectedItemEventEvidence: rejectedCandidateArtifacts.itemEvents?.candidateArtifact ?? null,
        eventFamilyCorrelation: rejectedCandidateArtifacts.itemEvents?.eventFamilyCorrelation ?? { exists: false },
        note: "Runtime frames keep events empty until actual ROFL event records are decoded; no null placeholder event objects are emitted.",
      },
      "info.frames[].participantFrames[].level": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
      "info.frames[].participantFrames[].currentGold": {
        status: "not_promoted",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "GOLD_EARNED - GOLD_SPENT rejected: does not match Riot final timeline currentGold",
        runtimeValue: null,
      },
      "info.frames[].participantFrames[].goldPerSecond": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
      "info.frames[].participantFrames[].nonFinalParticipantIdentity": {
        status: "not_promoted",
        source: "chunk-row-identity-gates",
        participantIdentity: "not-established",
        calibration: "241-family row gates rejected: duplicate_rejected/unstable_identity rows are not runtime API data",
      },
      "info.frames[].participantFrames[].totalGold": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
      "info.frames[].participantFrames[].xp": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
      "info.frames[].participantFrames[].minionsKilled": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
      "info.frames[].participantFrames[].jungleMinionsKilled": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
      "info.frames[].participantFrames[].championStats": {
        status: "shape_only",
        source: "api-container-null-placeholders-until-decoded",
        runtimeValue: "null-leaf-placeholder-object",
      },
      "info.frames[].participantFrames[].damageStats": {
        status: "decoded",
        source: "rofl-metadata-statsJson",
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-cumulative-stat",
      },
      "info.frames[].participantFrames[].position": {
        status: "not_promoted",
        source: "movement-candidates-rejected-for-runtime",
        perParticipantCoverage: rejectedCandidateArtifacts.positions?.perParticipantCoverage ?? [],
        noPriorsDiagnostic: rejectedCandidateArtifacts.positions?.noPriorsDiagnostic ?? null,
        statusCounts: countMetricStatuses(Object.fromEntries((rejectedCandidateArtifacts.positions?.perParticipantCoverage ?? []).map((entry) => [
          entry.participantId,
          entry,
        ]))),
        runtimeValue: {
          x: null,
          y: null,
        },
      },
      "info.frames[].participantFrames[].timeEnemySpentControlled": {
        status: "not_found",
        source: "not-present-in-current-rofl-summary",
        runtimeValue: null,
      },
    },
  };
}

function countMetricStatuses(metrics) {
  const counts = {};
  for (const entry of Object.values(metrics ?? {})) {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
  }
  return counts;
}

function buildArtifactCaveat(includeResearchKeyframes) {
  if (!includeResearchKeyframes) {
    return "Roster, match, and final timeline frame metrics are extracted from ROFL metadata/statsJson only. Non-final keyframe timeline values are omitted from the default artifact until participant identity and scalar calibration are replay-only.";
  }
  return "Roster and final stat metrics are extracted from ROFL metadata/statsJson only. Included research keyframe timeline values are decoded from ROFL keyframe fields, but participant identity and affine field calibration still come from current decoder research artifacts; supervised Riot API fixtures are validation/calibration artifacts, not runtime inputs for this exporter.";
}

function buildFieldCoverage(rejectedCandidateArtifacts = {}) {
  const reconstructionRowIdentity = rejectedCandidateArtifacts.reconstructionRowIdentity ?? {};
  const reconstructionIdentityFamilies = (reconstructionRowIdentity.rowIdentityArtifacts ?? []).map((artifact) => ({
    familyKey: artifact.familyKey,
    expectedRowCount: artifact.rowCount,
    promotionStatus: artifact.promotionStatus,
    rowStatuses: Object.keys(artifact.rowStatusCounts ?? {}).sort(),
  }));
  return {
    runtimeInputPolicy: {
      status: "decoded",
      source: "rofl-only",
      evidence: [
        "source.replayPath points to replays/*.rofl",
        "source.summaryPath points to replay-derived summary.json outside Riot API fixtures",
        "source.roflOnlyInputs.runtimeRiotApiFiles is false",
        "source.decoderArtifactSupervised is false",
      ],
    },
    matchMetadata: {
      status: "decoded",
      source: "rofl-file-name-and-statsJson",
      fields: [
        "metadata.matchId",
        "metadata.participants",
        "info.gameId",
        "info.platformId",
        "info.gameVersion",
        "info.gameDuration",
        "info.endOfGameResult",
      ],
    },
    matchMetadataGaps: {
      status: "not_found",
      source: "not-present-in-current-rofl-summary",
      inspectedSources: [
        "summary.json",
        "summary.metadataJson",
        "summary.metadataJson.statsJson",
      ],
      availableSummaryFields: [
        "gameVersion",
        "fileSize",
        "gameLengthMillis",
        "lastGameChunkId",
        "lastKeyFrameId",
        "playerCount",
        "container",
        "capabilities",
        "warnings",
        "players",
        "metadataJson",
      ],
      availableMetadataJsonFields: [
        "gameLength",
        "lastGameChunkId",
        "lastKeyFrameId",
        "statsJson",
      ],
      reason: "The current decoded ROFL metadata exposes replay duration/chunk/keyframe counters and embedded final statsJson, but not Riot queue/map/mode/type/name or game creation/start/end timestamps.",
      apiShapedNotFoundFields: [
        "info.gameCreation",
        "info.gameEndTimestamp",
        "info.gameMode",
        "info.gameName",
        "info.gameStartTimestamp",
        "info.gameType",
        "info.mapId",
        "info.queueId",
        "info.tournamentCode",
      ],
      fields: [
        "info.queueId",
        "info.mapId",
        "info.gameMode",
        "info.gameType",
        "info.gameName",
        "info.gameCreation",
        "info.gameStartTimestamp",
        "info.gameEndTimestamp",
        "info.tournamentCode",
      ],
    },
    matchParticipants: {
      status: "decoded",
      source: "rofl-metadata-statsJson",
      participantCount: 10,
      fields: [
        "participantId",
        "puuid",
        "championName",
        "teamId",
        "teamPosition",
        "win",
        "kills",
        "deaths",
        "assists",
        "champLevel",
        "goldEarned",
        "goldSpent",
        "totalMinionsKilled",
        "neutralMinionsKilled",
        "damage",
        "vision",
        "items",
        "summoner spells",
        "perks",
      ],
    },
    matchParticipantGaps: {
      status: "not_found",
      source: "not-accepted-as-rofl-api-parity",
      inspectedSources: [
        "summary.players",
        "summary.metadataJson.statsJson",
      ],
      fields: [
        "info.participants[].championId",
        "info.participants[].eligibleForProgression",
        "info.participants[].firstBloodAssist",
        "info.participants[].firstBloodKill",
        "info.participants[].firstTowerAssist",
        "info.participants[].firstTowerKill",
        "info.participants[].profileIcon",
        "info.participants[].summonerLevel",
      ],
      apiShapedNotFoundFields: [
        "info.participants[].championId",
        "info.participants[].eligibleForProgression",
        "info.participants[].firstBloodAssist",
        "info.participants[].firstBloodKill",
        "info.participants[].firstTowerAssist",
        "info.participants[].firstTowerKill",
        "info.participants[].profileIcon",
        "info.participants[].summonerLevel",
      ],
      rejectedCandidateEvidence: [
        {
          field: "info.participants[].championId",
          roflCandidate: "summary.players[].champion / statsJson.SKIN",
          status: "not_promoted",
          reason: "ROFL currently exposes champion names, but this exporter has no accepted ROFL-only champion-name-to-Riot-id mapping table in the runtime contract.",
        },
        {
          field: "info.participants[].firstBloodAssist",
          roflCandidate: "none",
          status: "not_found",
          reason: "Requires event-order kill timeline data; not present in final statsJson.",
        },
        {
          field: "info.participants[].firstBloodKill",
          roflCandidate: "none",
          status: "not_found",
          reason: "Requires event-order kill timeline data; not present in final statsJson.",
        },
        {
          field: "info.participants[].firstTowerAssist",
          roflCandidate: "none",
          status: "not_found",
          reason: "Requires event-order building timeline data; not present in final statsJson.",
        },
        {
          field: "info.participants[].firstTowerKill",
          roflCandidate: "none",
          status: "not_found",
          reason: "Requires event-order building timeline data; not present in final statsJson.",
        },
        {
          field: "info.participants[].profileIcon",
          roflCandidate: "none",
          status: "not_found",
          reason: "No profile icon field is exposed by the current decoded ROFL summary or embedded statsJson.",
        },
        {
          field: "info.participants[].summonerLevel",
          roflCandidate: "none",
          status: "not_found",
          reason: "No summoner level field is exposed by the current decoded ROFL summary or embedded statsJson.",
        },
        {
          field: "info.participants[].eligibleForProgression",
          roflCandidate: "constant true",
          status: "not_promoted",
          reason: "Matches this fixture but no decoded ROFL source has been identified, so it is not exposed as ROFL-derived parity data.",
        },
      ],
    },
    matchParticipantChallenges: {
      status: "partial",
      source: "rofl-metadata-statsJson",
      decodedFields: [
        "participants[].challenges.turretTakedowns",
      ],
      apiShapedNotFoundFields: riotMatchChallengeFields16_9
        .filter((field) => field !== "turretTakedowns")
        .map((field) => `participants[].challenges.${field}`),
      gaps: [
        "most Riot participants[].challenges.* fields are derived challenge/rate/event fields and do not have accepted direct ROFL statsJson parity yet",
      ],
      offlineCandidateReport: "rofl-challenge-gap-candidates.json",
    },
    matchTeams: {
      status: "decoded",
      source: "participant-final-statsJson-aggregation",
      teamCount: 2,
      fields: [
        "teamId",
        "win",
        "objectives.champion.kills",
        "objectives.tower.kills",
        "objectives.inhibitor.kills",
        "objectives.dragon.kills",
        "objectives.baron.kills",
      ],
      corpusValidation: {
        status: "partially_stable",
        validationArtifact: "artifacts-keyframes/rofl-api-parity-corpus-validation-16.9.json",
        patch: "16.9",
        stableOnFocusedReplay: true,
        knownUnstableFields: [
          "info.teams[].objectives.champion.kills",
          "info.teams[].objectives.tower.kills",
          "info.teams[].objectives.inhibitor.kills",
          "info.teams[].objectives.dragon.kills",
          "info.teams[].objectives.baron.kills",
          "info.teams[].objectives.horde.kills",
        ],
        reason: "Participant final statsJson aggregation matches the focused replay, but the 16.9 corpus shows systematic objective undercounts on some replays, so these values remain ROFL-derived candidate parity rather than patch-wide stable parity.",
      },
    },
    matchTeamGaps: {
      status: "not_found",
      source: "not-present-in-current-rofl-summary",
      inspectedSources: [
        "summary.json",
        "summary.metadataJson",
        "summary.metadataJson.statsJson",
      ],
      decodedTeamFields: [
        "info.teams[].win",
        "info.teams[].objectives.*.kills",
      ],
      apiShapedNotFoundFields: [
        "info.teams[].bans[].championId",
        "info.teams[].bans[].pickTurn",
        "info.teams[].objectives.*.first",
      ],
      unstableDecodedFields: [
        "info.teams[].objectives.champion.kills",
        "info.teams[].objectives.tower.kills",
        "info.teams[].objectives.inhibitor.kills",
        "info.teams[].objectives.dragon.kills",
        "info.teams[].objectives.baron.kills",
        "info.teams[].objectives.horde.kills",
      ],
      fields: [
        "info.teams[].bans[].championId",
        "info.teams[].bans[].pickTurn",
        "info.teams[].objectives.atakhan.first",
        "info.teams[].objectives.baron.first",
        "info.teams[].objectives.champion.first",
        "info.teams[].objectives.dragon.first",
        "info.teams[].objectives.horde.first",
        "info.teams[].objectives.inhibitor.first",
        "info.teams[].objectives.riftHerald.first",
        "info.teams[].objectives.tower.first",
      ],
      reason: "Embedded ROFL final statsJson provides final team/objective counts after participant aggregation, but not pick/ban data or event-order fields needed to identify first objective takers.",
    },
    timelineFinalParticipantFrames: {
      status: "decoded",
      source: "rofl-metadata-statsJson",
      participantCount: 10,
      frameKind: "final-stats",
      metrics: [
        "level",
        "totalGold",
        "xp",
        "minionsKilled",
        "jungleMinionsKilled",
      ],
      provenance: {
        participantIdentity: "rofl-summary-roster-order",
        calibration: "direct-final-stat",
      },
    },
    timelineNonFinalParticipantFrames: {
      status: "not_found",
      source: "not-runtime-exported",
      reason: "replay-only participant identity, scalar calibration, and chunk-delta state reconstruction are not accepted yet",
      apiShapedNotFoundFields: [
        "info.frames[].participantFrames[].championStats.*",
        "info.frames[].participantFrames[].currentGold",
        "info.frames[].participantFrames[].goldPerSecond",
        "info.frames[].participantFrames[].position.x",
        "info.frames[].participantFrames[].position.y",
        "info.frames[].participantFrames[].timeEnemySpentControlled",
      ],
      reconstructionDirection: {
        status: "planned",
        model: "keyframe-baseline-plus-chunk-deltas",
        reason: "Riot timeline frames appear to align with replay keyframe boundaries, but chunk/subrecord updates between keyframes likely carry the state changes needed for API-shaped non-final participantFrames.",
        steps: [
          "treat keyframes as baseline snapshots",
          "decode chunk subrecords between keyframes as state deltas and events",
          "apply deltas to the latest baseline state",
          "sample reconstructed state into Riot-shaped timeline frames",
          "validate sampled frames against Riot API fixtures offline only",
        ],
      },
    },
    timelineNonFinalParticipantIdentity: {
      status: "not_promoted",
      source: "chunk-row-identity-gates",
      reason: "241-family row candidates are tracked as decoder evidence but do not establish stable replay-only participant identity.",
      runtimeInput: false,
      candidateFamilies: reconstructionIdentityFamilies,
    },
    timelineCurrentGold: {
      status: "not_promoted",
      source: "rofl-metadata-statsJson",
      candidate: "GOLD_EARNED - GOLD_SPENT",
      reason: "The ROFL final statsJson candidate is internally meaningful but does not match Riot timeline participantFrames.currentGold at the final frame, so it is not emitted as API parity data.",
    },
    timelineEvents: {
      status: "not_found",
      source: "chunk-delta-events-not-extracted",
      apiShapedNotFoundFields: riotTimelineEventLeafPaths16_9,
      runtimeEmission: "empty-events-arrays",
      rejectedItemEventEvidence: rejectedCandidateArtifacts.itemEvents?.candidateArtifact ?? null,
      eventFamilyCorrelation: rejectedCandidateArtifacts.itemEvents?.eventFamilyCorrelation ?? { exists: false },
      reason: "Timeline event leaf shape is tracked as not_found, but null placeholder event objects are not emitted because they would imply events that were not decoded from ROFL.",
      reconstructionDirection: "decode chunk/subrecord event deltas between keyframe baselines before emitting API-shaped timeline events",
    },
    positions: {
      status: "not_found",
      source: "state-reconstruction-not-extracted-for-16.9",
      perParticipantCoverage: rejectedCandidateArtifacts.positions?.perParticipantCoverage ?? [],
      noPriorsDiagnostic: rejectedCandidateArtifacts.positions?.noPriorsDiagnostic ?? null,
      statusCounts: countMetricStatuses(Object.fromEntries((rejectedCandidateArtifacts.positions?.perParticipantCoverage ?? []).map((entry) => [
        entry.participantId,
        entry,
      ]))),
      reconstructionDirection: "decode and identity-link position/entity state through keyframe baselines plus chunk deltas before emitting participantFrames.position",
    },
    inventoryTimeline: {
      status: "not_found",
      source: "not-extracted",
      rejectedCandidateEvidence: rejectedCandidateArtifacts.inventoryTimeline?.relatedCandidateArtifact ?? null,
      runtimeInput: rejectedCandidateArtifacts.inventoryTimeline?.runtimeInput ?? false,
    },
    damageTimeline: {
      status: "not_found",
      source: "not-extracted",
    },
    offlineRiotValidation: {
      status: "validation-only",
      source: "riot-api-fixtures",
      runtimeInput: false,
    },
  };
}

function buildParityChecklist() {
  return [
    {
      requirement: "Runtime extraction does not use Riot API data.",
      status: "satisfied",
      evidence: [
        "source.roflOnlyInputs.runtimeRiotApiFiles=false",
        "source.researchInputPath=null",
        "source.decoderArtifactSupervised=false",
        "verifier rejects Riot API fixture paths anywhere in the runtime artifact",
      ],
    },
    {
      requirement: "Include all 10 participants from ROFL metadata/statsJson.",
      status: "satisfied",
      evidence: [
        "totals.rosterParticipantCount=10",
        "match.info.participants.length=10",
        "matchCoverage has 10 decoded rows",
      ],
    },
    {
      requirement: "Emit API-shaped match data where decoded.",
      status: "satisfied",
      evidence: [
        "match.metadata",
        "match.info.participants",
        "match.info.teams",
        "fieldCoverage.matchParticipants.status=decoded",
        "fieldCoverage.matchTeams.status=decoded",
      ],
    },
    {
      requirement: "Emit API-shaped timeline data where decoded.",
      status: "partial",
      evidence: [
        "timeline.metadata",
        "timeline.info.frames",
        "frames[].participantFrames",
        "one final statsJson frame with all 10 participants",
      ],
      gaps: [
        "non-final timeline participantFrames are not runtime-exported yet",
        "timeline events are not extracted yet",
      ],
    },
    {
      requirement: "Expose frames[].participantFrames with real ROFL-derived metrics.",
      status: "partial",
      evidence: [
        "60 final timeline metric points from rofl-metadata-statsJson",
        "coverage rows prove direct-final-stat calibration",
      ],
      gaps: [
        "only final statsJson frame metrics are emitted",
        "non-final keyframe metrics are omitted until replay-only identity/calibration is accepted",
      ],
    },
    {
      requirement: "Add explicit per-participant/per-metric coverage statuses.",
      status: "satisfied",
      evidence: [
        "coverage has one row per participant",
        "coverageStatusLegend defines decoded/noisy/unstable_identity/duplicate_rejected/not_found",
        "totals.coverageSummary is verified against coverage rows",
      ],
    },
    {
      requirement: "Improve replay-only participant identity linkage using ROFL-only evidence.",
      status: "partial",
      evidence: [
        "final frame identity uses rofl-summary-roster-order",
        "coverage marks non-final identity-dependent fields not_found by default",
        "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.metricSet=conservative",
        "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.thresholds",
        "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.diagnostics",
        "rejectedCandidateArtifacts.nonFinalScalarIdentity.assignmentArtifact.diagnostics.duplicateFinalTargetValueCountsByMetric",
        "rejectedCandidateArtifacts.reconstructionRowIdentity.status=not_promoted",
        "rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridCandidateScan.status=candidate_scan_only_not_runtime_api_data",
        "rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridFieldAnalysis.status=field_hypothesis_only_not_runtime_api_data",
        "fieldCoverage.timelineNonFinalParticipantIdentity.status=not_promoted",
      ],
      gaps: [
        "accepted replay-only non-final keyframe participant identity is not available yet",
        "current 16.9 replay-only scalar identity has 0 canonical candidates after metric-specific quality gates",
      ],
    },
    {
      requirement: "Filter noisy candidates and avoid exposing low-confidence affine artifacts as real API data.",
      status: "satisfied",
      evidence: [
        "default artifact has zero research keyframe series",
        "source.decoderArtifactSupervised=false",
        "non-final research keyframes require --include-research-keyframes",
        "duplicate same-metric keyframe supports are collapsed before scoring",
        "weak per-metric supports are filtered by minSupportScore before edge creation",
        "duplicated final-stat anchors are rejected from accepted support by maxFinalTargetDuplicateCount",
        "241-family row identity gates keep duplicate_rejected/unstable_identity rows out of runtime participantFrames",
      ],
    },
    {
      requirement: "Keep supervised Riot API fixtures only for offline validation.",
      status: "satisfied",
      evidence: [
        "fieldCoverage.offlineRiotValidation.status=validation-only",
        "validate:rofl-api-metrics:riot is separate from export",
      ],
    },
    {
      requirement: "Target latest patch 16.9 first.",
      status: "satisfied",
      evidence: [
        "source.versionGroup=16.9",
        "source.gameVersion=16.9.772.1032",
      ],
    },
    {
      requirement: "Produce one useful ROFL-only parity artifact for a replay in replays/.",
      status: "satisfied",
      evidence: [
        "source.replayPath=replays/EUW1-7840220945.rofl",
        "artifact path artifacts-keyframes/EUW1-7840220945/rofl-api-metrics.json",
      ],
    },
    {
      requirement: "Document what still does not match Riot API parity.",
      status: "satisfied",
      evidence: [
        "docs/rofl-api-parity.md",
        "parityGaps",
        "fieldCoverage missing entries",
        "rejectedCandidateArtifacts for scalar identity, positions, item events, inventory timeline, and damage timeline",
        "rejectedCandidateArtifacts.reconstructionRowIdentity",
      ],
    },
    {
      requirement: "Add verification that proves ROFL-only fields and remaining gaps.",
      status: "satisfied",
      evidence: [
        "verify:rofl-api-metrics",
        "fieldCoverage verifier checks",
        "final frame coverage verifier checks",
        "rejected candidate artifact verifier checks",
        "fieldCoverage.timelineNonFinalParticipantIdentity cross-checks rejectedCandidateArtifacts.reconstructionRowIdentity",
        "offline Riot validation is separate and marked validation-only",
      ],
    },
    {
      requirement: "Full API data parity from ROFL-only extraction.",
      status: "not_satisfied",
      gaps: [
        "non-stats match metadata",
        "non-final participant identity",
        "non-final scalar calibration",
        "true Riot API PUUID identity parity",
        "positions",
        "timeline events",
        "inventory timeline",
        "damage timeline",
      ],
    },
  ];
}

function buildRemainingParityGaps(rejectedCandidateArtifacts) {
  const positions = rejectedCandidateArtifacts.positions ?? {};
  const itemEvents = rejectedCandidateArtifacts.itemEvents ?? {};
  const inventoryTimeline = rejectedCandidateArtifacts.inventoryTimeline ?? {};
  const damageTimeline = rejectedCandidateArtifacts.damageTimeline ?? {};
  const scalarIdentity = rejectedCandidateArtifacts.nonFinalScalarIdentity ?? {};
  const rowIdentity = rejectedCandidateArtifacts.reconstructionRowIdentity ?? {};

  return [
    {
      key: "nonFinalParticipantIdentity",
      apiSurface: "timeline.info.frames[].participantFrames participant linkage before final statsJson frame",
      status: "not_promoted",
      runtimeEmission: "final-frame-only",
      runtimeApiData: false,
      blockerSummary: [
        `scalarIdentityAssignments=${scalarIdentity.assignmentArtifact?.assignmentCount ?? null}`,
        `scalarIdentityCanonicalCandidates=${scalarIdentity.assignmentArtifact?.canonicalCandidateCount ?? null}`,
        `rowIdentityStatus=${rowIdentity.status ?? null}`,
        "runtimePromotionGate=blocked",
        `startupTokenLink=${scalarIdentity.startupRosterTokenScan?.status ?? null}`,
        `startupKeyframeRowLink=${scalarIdentity.startupKeyframeRowLink?.assessment?.directStartupToKeyframeRowLink ?? null}`,
        `handleGraphLink=${scalarIdentity.handleGraphRowLinkCandidates?.status ?? null}`,
        `noPriorsPositionAssignment=${positions.qualityGateSummary?.noPriorsAssignedParticipantCount ?? null}/10`,
      ],
      evidenceRefs: [
        "rejectedCandidateArtifacts.nonFinalScalarIdentity",
        "rejectedCandidateArtifacts.reconstructionRowIdentity",
        "identityLinkage.evidenceMatrix",
        "identityLinkage.nonFinalScalarIdentity.runtimePromotionGate",
        "rejectedCandidateArtifacts.nonFinalScalarIdentity.startupKeyframeRowLink",
        "fieldCoverage.timelineNonFinalParticipantIdentity",
      ],
      nextDecoderStep: "establish stable ROFL-only row/entity-to-participant identity across non-final frames",
    },
    {
      key: "positions",
      apiSurface: "timeline.info.frames[].participantFrames[].position",
      status: positions.status ?? "not_found",
      runtimeEmission: "position.x/y null",
      runtimeApiData: false,
      blockerSummary: positions.promotionBlockers ?? [
        `assignmentCount=${positions.participantMovementArtifact?.assignmentCount ?? null}`,
        `passingAssignmentCount=${positions.offlineValidation?.passingAssignmentCount ?? null}`,
      ],
      evidenceRefs: [
        "rejectedCandidateArtifacts.positions",
        "rejectedCandidateArtifacts.positions.noPriorsDiagnostic",
        "fieldCoverage.positions",
        "fieldCoverage.positions.noPriorsDiagnostic",
        "roflDerivedFieldMap.timeline.info.frames[].participantFrames[].position",
        "artifactManifest.decoderDiagnostics.replay-only-no-priors-position-diagnostic",
        "artifactManifest.decoderDiagnostics.offline-no-priors-position-validation-diagnostic",
      ],
      nextDecoderStep: "replace prior-dependent 9/10 movement assignment with 10/10 ROFL-only identity and quality gates",
    },
    {
      key: "timelineEvents",
      apiSurface: "timeline.info.frames[].events",
      status: "not_found",
      runtimeEmission: "empty events arrays",
      runtimeApiData: false,
      blockerSummary: [
        "chunk-delta event extraction is not decoded",
        `itemEventCandidateCount=${itemEvents.candidateArtifact?.candidateCount ?? null}`,
        `strongItemEventCandidateCount=${itemEvents.candidateArtifact?.strongCandidateCount ?? null}`,
      ],
      evidenceRefs: [
        "fieldCoverage.timelineEvents",
        "rejectedCandidateArtifacts.itemEvents",
        "rejectedCandidateArtifacts.itemEvents.eventFamilyCorrelation",
        "roflDerivedFieldMap.timeline.info.frames[].events",
      ],
      nextDecoderStep: "decode ROFL-only event deltas without supervised Riot timeline events as runtime input",
    },
    {
      key: "inventoryTimeline",
      apiSurface: "timeline participant inventory state over frames",
      status: inventoryTimeline.status ?? "not_found",
      runtimeEmission: "final match item slots only",
      runtimeApiData: false,
      blockerSummary: [
        `itemEventCandidateCount=${inventoryTimeline.relatedCandidateArtifact?.itemEventCandidateCount ?? null}`,
        `globalEventCount=${inventoryTimeline.relatedCandidateArtifact?.globalEventCount ?? null}`,
        "no accepted ROFL-only item event or slot-state timeline decoder",
      ],
      evidenceRefs: [
        "rejectedCandidateArtifacts.inventoryTimeline",
        "fieldCoverage.inventoryTimeline",
      ],
      nextDecoderStep: "promote item-event or item-slot timeline only after ROFL-only event identity is decoded",
    },
    {
      key: "damageTimeline",
      apiSurface: "timeline.info.frames[].participantFrames[].damageStats before final frame",
      status: damageTimeline.status ?? "not_found",
      runtimeEmission: "final damageStats only",
      runtimeApiData: false,
      blockerSummary: [
        "non-final damage stat deltas are not extracted",
        `candidateDamageMetricCount=${damageTimeline.extractedStatsArtifact?.damageMetricKeyCount ?? null}`,
      ],
      evidenceRefs: [
        "rejectedCandidateArtifacts.damageTimeline",
        "fieldCoverage.timelineNonFinalParticipantFrames",
      ],
      nextDecoderStep: "decode non-final damage counters and bind them to stable participant identity",
    },
  ];
}

function buildRoflOnlyExtractionProof(rosterParticipants, frames, rejectedCandidateArtifacts, remainingParityGaps) {
  const finalFrame = frames.at(-1) ?? null;
  const finalParticipantFrameCount = Object.keys(finalFrame?.participantFrames ?? {}).length;
  const decodedFinalMetricKeys = ["level", "totalGold", "xp", "minionsKilled", "jungleMinionsKilled"];
  const decodedFinalDamageKeys = [
    "magicDamageDone",
    "magicDamageDoneToChampions",
    "magicDamageTaken",
    "physicalDamageDone",
    "physicalDamageDoneToChampions",
    "physicalDamageTaken",
    "totalDamageDone",
    "totalDamageDoneToChampions",
    "totalDamageTaken",
    "trueDamageDone",
    "trueDamageDoneToChampions",
    "trueDamageTaken",
  ];

  return {
    proofSchema: "rofl-only-extraction-proof/v1",
    runtimeInputPolicy: {
      riotApiRuntimeInput: false,
      replayFileRequired: true,
      replayDerivedSummaryRequired: true,
      decoderDiagnosticsRequiredForRuntime: false,
      supervisedFixtureRole: "offline-validation-only",
    },
    decodedFromRoflOnly: [
      {
        surface: "match.metadata.matchId",
        source: "rofl-file-name",
        participantIdentity: "not-required",
      },
      {
        surface: "match.info.participants",
        source: "rofl-metadata-statsJson",
        participantCount: rosterParticipants.length,
        participantIdentity: "rofl-summary-roster-order",
      },
      {
        surface: "match.info.teams",
        source: "participant-final-statsJson-aggregation",
        teamCount: 2,
      },
      {
        surface: "timeline.info.frames[-1].participantFrames final scalar metrics",
        source: "rofl-metadata-statsJson",
        participantCount: finalParticipantFrameCount,
        metricKeys: decodedFinalMetricKeys,
        metricPointCount: finalParticipantFrameCount * decodedFinalMetricKeys.length,
      },
      {
        surface: "timeline.info.frames[-1].participantFrames final damageStats",
        source: "rofl-metadata-statsJson",
        participantCount: finalParticipantFrameCount,
        metricKeys: decodedFinalDamageKeys,
        metricPointCount: finalParticipantFrameCount * decodedFinalDamageKeys.length,
      },
    ],
    perParticipantProof: rosterParticipants.map((participant) => ({
      participantId: participant.participantId,
      champion: participant.championName ?? participant.champion ?? null,
      teamId: participant.teamId ?? participant.team ?? null,
      participantIdentity: "rofl-summary-roster-order",
      source: "rofl-metadata-statsJson",
      runtimeApiData: true,
      finalScalarMetricKeys: decodedFinalMetricKeys,
      finalScalarMetricCount: decodedFinalMetricKeys.filter((metric) => participant.finalMetrics?.[metric] != null).length,
      finalDamageMetricKeys: decodedFinalDamageKeys,
      finalDamageMetricCount: decodedFinalDamageKeys.filter((metric) => {
        const damageStats = buildTimelineDamageStats(participant.apiLikeStats ?? {});
        return damageStats[metric] != null;
      }).length,
      unresolvedRuntimeFields: [
        "currentGold",
        "goldPerSecond",
        "position",
        "timeEnemySpentControlled",
        "championStats",
      ],
    })),
    offlineValidationOnly: [
      {
        surface: "Riot match/timeline fixture parity checks",
        runtimeInput: false,
        report: "rofl-api-metrics-riot-validation.json",
      },
      {
        surface: "Riot API shape gap audit",
        runtimeInput: false,
        report: "rofl-api-shape-gap-report.json",
      },
      {
        surface: "challenge candidate audit",
        runtimeInput: false,
        report: "rofl-challenge-gap-candidates.json",
      },
    ],
    apiShapeProof: {
      status: "partial",
      runtimeInput: false,
      source: "runtime-artifact-structure-and-static-16.9-event-leaf-inventory",
      matchShape: {
        status: "api_shaped",
        offlineShapeGapMatchedLeafPathCount: 342,
        offlineShapeGapRiotLeafPathCount: 342,
        missingLeafPathCount: 0,
      },
      timelineShape: {
        status: "partial",
        offlineShapeGapMatchedLeafPathCount: 57,
        offlineShapeGapRiotLeafPathCount: 127,
        missingLeafPathCount: riotTimelineEventLeafPaths16_9.length,
        missingCategory: "timeline-events",
        runtimeEmission: "empty-events-arrays",
        missingLeafPaths: riotTimelineEventLeafPaths16_9,
      },
      fullApiShapeParity: false,
      blocker: "timeline.info.frames[].events leaves are tracked as not_found and are not emitted until ROFL-only event deltas are decoded",
    },
    notPromotedRuntimeCandidates: [
      {
        surface: "non-final participant identity",
        status: rejectedCandidateArtifacts.nonFinalScalarIdentity?.status ?? "not_found",
        runtimeInput: false,
      },
      {
        surface: "position x/y movement tracks",
        status: rejectedCandidateArtifacts.positions?.status ?? "not_found",
        runtimeInput: false,
        runtimeApiData: false,
        assignedParticipantCount: rejectedCandidateArtifacts.positions?.qualityGateSummary?.assignedParticipantCount ?? null,
        expectedParticipantCount: rejectedCandidateArtifacts.positions?.qualityGateSummary?.expectedParticipantCount ?? null,
        offlinePassingAssignmentCount: rejectedCandidateArtifacts.positions?.qualityGateSummary?.offlinePassingAssignmentCount ?? null,
        noPriorsAssignedParticipantCount: rejectedCandidateArtifacts.positions?.qualityGateSummary?.noPriorsAssignedParticipantCount ?? null,
        noPriorsOfflinePassingAssignmentCount: rejectedCandidateArtifacts.positions?.qualityGateSummary?.noPriorsOfflinePassingAssignmentCount ?? null,
      },
      {
        surface: "timeline events",
        status: rejectedCandidateArtifacts.itemEvents?.status ?? "not_found",
        runtimeInput: false,
      },
      {
        surface: "inventory timeline",
        status: rejectedCandidateArtifacts.inventoryTimeline?.status ?? "not_found",
        runtimeInput: false,
      },
    ],
    remainingGapKeys: remainingParityGaps.map((gap) => gap.key),
  };
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function countAssignmentRejectionReasons(roflStatAssignments) {
  const counts = {};
  for (const replay of roflStatAssignments?.replays ?? []) {
    for (const family of replay.families ?? []) {
      for (const assignment of family.assignments ?? []) {
        for (const reason of assignment.rejectionReasons ?? []) {
          counts[reason] = (counts[reason] ?? 0) + 1;
        }
      }
    }
  }
  return counts;
}

function summarizeReplayIdentityDiagnostics(roflStatAssignments) {
  const rows = [];
  for (const replay of roflStatAssignments?.replays ?? []) {
    const assignmentCount = replay.assignmentCount ?? 0;
    const edgeCount = replay.edgeCount ?? 0;
    const maxCandidateScore = replay.diagnostics?.maxCandidateScore ?? null;
    if (assignmentCount <= 0 && edgeCount <= 0 && maxCandidateScore == null) {
      continue;
    }
    rows.push({
      replayId: replay.replayId,
      edgeCount,
      assignmentCount,
      canonicalCandidateCount: replay.canonicalCandidateCount ?? 0,
      diagnosticOnlyCount: replay.diagnosticOnlyCount ?? 0,
      slotWithMetricValueCount: replay.diagnostics?.slotWithMetricValueCount ?? 0,
      maxCandidateScore,
      maxCandidateMetricCount: replay.diagnostics?.maxCandidateMetricCount ?? 0,
    });
  }
  return rows
    .sort((left, right) => {
      const leftScore = Number.isFinite(left.maxCandidateScore) ? left.maxCandidateScore : -Infinity;
      const rightScore = Number.isFinite(right.maxCandidateScore) ? right.maxCandidateScore : -Infinity;
      return right.assignmentCount - left.assignmentCount || right.edgeCount - left.edgeCount || rightScore - leftScore;
    })
    .slice(0, 10);
}

function summarizeIdentityAssignments(roflStatAssignments) {
  const rows = [];
  for (const replay of roflStatAssignments?.replays ?? []) {
    for (const family of replay.families ?? []) {
      for (const assignment of family.assignments ?? []) {
        rows.push({
          replayId: replay.replayId,
          familyKey: assignment.familyKey,
          slotIndex: assignment.slotIndex,
          expectedParticipantId: assignment.expectedParticipantId,
          champion: assignment.champion,
          team: assignment.team,
          teamPosition: assignment.teamPosition,
          confidence: assignment.confidence,
          canonicalCandidate: assignment.canonicalCandidate,
          score: assignment.score,
          metricCount: assignment.metricCount,
          distinctMetricCount: assignment.distinctMetricCount,
          winnerGap: assignment.winnerGap,
          rejectionReasons: assignment.rejectionReasons ?? [],
          support: (assignment.support ?? []).map((support) => ({
            metric: support.metric,
            predicted: support.predicted,
            target: support.target,
            score: support.score,
            offset: support.offset,
            decodeLabel: support.decodeLabel,
          })),
          runnerUp: assignment.runnerUp ?? null,
        });
      }
    }
  }
  return rows
    .sort((left, right) => {
      const leftGap = Number.isFinite(left.winnerGap) ? left.winnerGap : Infinity;
      const rightGap = Number.isFinite(right.winnerGap) ? right.winnerGap : Infinity;
      return Number(left.canonicalCandidate) - Number(right.canonicalCandidate) ||
        leftGap - rightGap ||
        right.score - left.score;
    })
    .slice(0, 10);
}

function summarizeStartupRosterTokenScan(startupRosterTokenScan, versionGroup) {
  if (!startupRosterTokenScan) {
    return {
      exists: false,
    };
  }
  const replayOnlyKinds = new Set([
    "participantId",
    "rosterIndex",
    "rosterOrdinal",
    "teamId",
    "summonerIdLow32",
    "championNameAscii",
    "riotNameAscii",
    "puuidAscii",
  ]);
  const versionCandidates = (startupRosterTokenScan.candidates ?? [])
    .filter((candidate) => candidate.versionGroup === versionGroup && replayOnlyKinds.has(candidate.kind));
  const fullCorpusCandidates = versionCandidates.filter((candidate) =>
    (candidate.replayCount ?? 0) === 20 &&
    ["participantId", "rosterIndex", "rosterOrdinal", "teamId"].includes(candidate.kind),
  );
  return {
    exists: true,
    status: "diagnostic_only_not_runtime_api_data",
    reason: "startup records contain replay-only roster/order-like token hits, but these hits are not yet linked to non-final keyframe state rows",
    runtimeInput: false,
    runtimeApiData: false,
    generatedAtUtc: startupRosterTokenScan.generatedAtUtc ?? null,
    versionGroup,
    scannedReplayCount: (startupRosterTokenScan.replaySummaries ?? [])
      .filter((summary) => summary.versionGroup === versionGroup).length,
    replayOnlyCandidateCount: versionCandidates.length,
    fullCorpusRosterOrderCandidateCount: fullCorpusCandidates.length,
    topReplayOnlyCandidates: versionCandidates
      .sort((left, right) =>
        (right.replayCount ?? 0) - (left.replayCount ?? 0) ||
        (right.hitCount ?? 0) - (left.hitCount ?? 0) ||
        (left.offset ?? 0) - (right.offset ?? 0),
      )
      .slice(0, 8)
      .map((candidate) => ({
        kind: candidate.kind,
        width: candidate.width,
        offset: candidate.offset,
        replayCount: candidate.replayCount ?? null,
        hitCount: candidate.hitCount ?? null,
        participantOrdinalDelta: candidate.participantOrdinalDelta ?? null,
        examples: (candidate.examples ?? []).slice(0, 3).map((example) => ({
          replayId: example.replayId,
          participantId: example.participantId,
          champion: example.champion,
          value: example.value,
        })),
      })),
  };
}

function summarizeHandleGraphCandidateScores(handleGraphScores) {
  if (!handleGraphScores) {
    return {
      exists: false,
    };
  }
  const candidates = handleGraphScores.candidates ?? [];
  const topCandidate = candidates[0] ?? null;
  return {
    exists: true,
    status: "not_promoted",
    reason: "handle graph row-reference candidates are not stable enough to link roster identity to non-final keyframe state rows",
    runtimeInput: false,
    runtimeApiData: false,
    schema: handleGraphScores.schema ?? null,
    replayCount: handleGraphScores.replayCount ?? null,
    candidateCount: handleGraphScores.candidateCount ?? null,
    confidenceCounts: handleGraphScores.confidenceCounts ?? {},
    topScore: topCandidate?.score ?? null,
    topConfidence: topCandidate?.confidence ?? null,
    topCandidate: topCandidate
      ? {
          sourceFamilyKey: topCandidate.sourceFamilyKey,
          sourceOffset: topCandidate.sourceOffset,
          width: topCandidate.width,
          targetFamilyKey: topCandidate.targetFamilyKey,
          replayCount: topCandidate.replayCount,
          assignedSourceRowReplayCount: topCandidate.assignedSourceRowReplayCount,
          assignedRowCount: topCandidate.assignedRowCount,
          components: topCandidate.components ?? null,
        }
      : null,
    topCandidates: candidates.slice(0, 5).map((candidate) => ({
      score: candidate.score,
      confidence: candidate.confidence,
      sourceFamilyKey: candidate.sourceFamilyKey,
      sourceOffset: candidate.sourceOffset,
      width: candidate.width,
      targetFamilyKey: candidate.targetFamilyKey,
      replayCount: candidate.replayCount,
      assignedSourceRowReplayCount: candidate.assignedSourceRowReplayCount,
      assignedRowCount: candidate.assignedRowCount,
    })),
  };
}

function summarizeStartupKeyframeRowLinkDiagnostic(linkDiagnostic) {
  if (!linkDiagnostic) {
    return {
      exists: false,
    };
  }
  return {
    exists: true,
    status: linkDiagnostic.status ?? "not_promoted",
    reason: "startup roster/order tokens are present but no replay-only link to stable keyframe participant rows has been established",
    runtimeInput: linkDiagnostic.runtimeInput ?? false,
    runtimeApiData: linkDiagnostic.runtimeApiData ?? false,
    schema: linkDiagnostic.schema ?? null,
    mode: linkDiagnostic.mode ?? null,
    assessment: linkDiagnostic.assessment ?? null,
    blockerSummary: linkDiagnostic.blockerSummary ?? [],
    startupRosterOrderCandidateCount: (linkDiagnostic.startupRosterOrderCandidates ?? []).length,
    keyframeRowIdentity: (linkDiagnostic.keyframeRowIdentity ?? []).map((entry) => ({
      familyKey: entry.familyKey ?? null,
      status: entry.status ?? null,
      runtimeApiData: entry.runtimeApiData ?? null,
      participantIdentity: entry.participantIdentity ?? null,
      rowCount: entry.rowCount ?? null,
      sameRowWinRate: entry.sameRowWinRate ?? null,
      duplicateRejectedRowCount: entry.duplicateRejectedRowCount ?? null,
      rowStatusCounts: entry.rowStatusCounts ?? {},
    })),
    strongestStartupCandidates: (linkDiagnostic.startupRosterOrderCandidates ?? []).slice(0, 5),
    strongestHandleGraphCandidate: linkDiagnostic.handleGraphRowLinks?.strongestCandidate ?? null,
    nextDecoderStep: linkDiagnostic.nextDecoderStep ?? null,
  };
}

function summarizeEventFamilyCorrelation(eventFamilyCorrelation) {
  if (!eventFamilyCorrelation) {
    return {
      exists: false,
    };
  }
  return {
    exists: true,
    status: eventFamilyCorrelation.promotionAssessment?.status ?? "not_promoted",
    reason: "family/event correlations use offline Riot timeline categories as labels and do not decode event payload semantics",
    runtimeInput: eventFamilyCorrelation.runtimeInput ?? false,
    runtimeApiData: eventFamilyCorrelation.promotionAssessment?.runtimeApiData ?? false,
    schema: eventFamilyCorrelation.schema ?? null,
    mode: eventFamilyCorrelation.mode ?? null,
    selectedIntervalCount: eventFamilyCorrelation.selection?.selectedIntervals ?? null,
    selectedFamilyKeys: eventFamilyCorrelation.selection?.familyKeys ?? [],
    correlationRowCount: (eventFamilyCorrelation.correlations ?? []).length,
    promotionReasons: eventFamilyCorrelation.promotionAssessment?.reasons ?? [],
    topCorrelations: (eventFamilyCorrelation.correlations ?? []).slice(0, 8).map((row) => ({
      familyKey: row.familyKey,
      category: row.category,
      pearson: row.pearson ?? null,
      spearman: row.spearman ?? null,
      eventfulMeanRate: row.eventfulMeanRate ?? null,
      quietMeanRate: row.quietMeanRate ?? null,
      specificEnrichment: row.specificEnrichment ?? null,
    })),
  };
}

function buildRejectedCandidateArtifacts(root, replayId, versionGroup) {
  const roflStatAssignmentsPath = path.join(root, "artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
  const roflStatComparisonPath = path.join(root, "artifacts-keyframes", `keyframe-rofl-stat-supervised-comparison-${versionGroup}.json`);
  const startupRosterTokenScanPath = path.join(root, "artifacts-keyframes", "startup-roster-token-scan.json");
  const handleGraphCandidateScoresPath = path.join(root, "artifacts-keyframes", "keyframe-handle-graph-candidate-scores.json");
  const startupKeyframeRowLinkPath = path.join(root, "artifacts-keyframes", `startup-keyframe-row-link-diagnostic-${versionGroup}.json`);
  const rowIdentity02Path = path.join(root, "artifacts-keyframes", `reconstruction-row-identity-241-0x02-${versionGroup}.json`);
  const rowIdentity04Path = path.join(root, "artifacts-keyframes", `reconstruction-row-identity-241-0x04-${versionGroup}.json`);
  const rowGridCandidatesPath = path.join(root, "artifacts-keyframes", `reconstruction-row-grid-candidates-${versionGroup}.json`);
  const rowGridFieldAnalysisPath = path.join(root, "artifacts-keyframes", `reconstruction-row-grid-field-analysis-${versionGroup}.json`);
  const movementPath = path.join(root, "artifacts", replayId, "participant-movement.json");
  const movementValidationPath = path.join(root, "artifacts", replayId, "assigned-movement-validation-report.json");
  const movementNoPriorsPath = path.join(root, "artifacts", replayId, "participant-movement-no-priors.json");
  const movementNoPriorsValidationPath = path.join(root, "artifacts", replayId, "assigned-movement-no-priors-validation-report.json");
  const itemEventCandidatesPath = path.join(root, "artifacts", replayId, "item-event-candidates.json");
  const eventFamilyCorrelationPath = path.join(root, "artifacts-keyframes", `reconstruction-family-event-correlation-${versionGroup}.json`);
  const extractedStatsPath = path.join(root, "artifacts", replayId, "extracted-stats.json");
  const roflStatAssignments = readOptionalJson(roflStatAssignmentsPath);
  const roflStatComparison = readOptionalJson(roflStatComparisonPath);
  const startupRosterTokenScan = readOptionalJson(startupRosterTokenScanPath);
  const handleGraphCandidateScores = readOptionalJson(handleGraphCandidateScoresPath);
  const startupKeyframeRowLink = readOptionalJson(startupKeyframeRowLinkPath);
  const rowIdentity02 = readOptionalJson(rowIdentity02Path);
  const rowIdentity04 = readOptionalJson(rowIdentity04Path);
  const rowGridCandidates = readOptionalJson(rowGridCandidatesPath);
  const rowGridFieldAnalysis = readOptionalJson(rowGridFieldAnalysisPath);
  const movement = readOptionalJson(movementPath);
  const movementValidation = readOptionalJson(movementValidationPath);
  const movementNoPriors = readOptionalJson(movementNoPriorsPath);
  const movementNoPriorsValidation = readOptionalJson(movementNoPriorsValidationPath);
  const itemEventCandidates = readOptionalJson(itemEventCandidatesPath);
  const eventFamilyCorrelation = readOptionalJson(eventFamilyCorrelationPath);
  const extractedStats = readOptionalJson(extractedStatsPath);
  const extractedMetricKeys = new Set(
    (extractedStats?.participants ?? []).flatMap((participant) => Object.keys(participant.metrics ?? {})),
  );
  const damageMetricKeys = [...extractedMetricKeys].filter((metric) => metric.toLowerCase().includes("damage"));
  const movementValidationByRosterIndex = new Map((movementValidation?.assignments ?? []).map((assignment) => [
    assignment.rosterIndex,
    assignment,
  ]));
  const movementCoverageByParticipant = new Map();
  for (const assignment of movement?.assignments ?? []) {
    const participantId = Number.isInteger(assignment.rosterIndex) ? assignment.rosterIndex + 1 : null;
    const validation = movementValidationByRosterIndex.get(assignment.rosterIndex);
    const validationPasses = validation?.validation?.passes === true;
    movementCoverageByParticipant.set(participantId, {
      participantId,
      champion: assignment.champion ?? null,
      teamId: assignment.team ?? null,
      teamPosition: assignment.teamPosition ?? null,
      status: validationPasses ? "unstable_identity" : "noisy",
      reason: validationPasses
        ? "movement candidate has offline support but runtime identity uses priors and is not 10/10 ROFL-only"
        : "movement candidate failed offline quality validation or lacks validation support",
      entityKey: assignment.entityKey ?? null,
      familyKey: assignment.familyKey ?? null,
      slotIndex: assignment.slotIndex ?? null,
      score: assignment.score ?? null,
      entityQuality: assignment.entityQuality ?? null,
      pointCount: assignment.trajectoryStats?.pointCount ?? null,
      validation: validation
        ? {
            status: validation.status ?? null,
            passes: validation.validation?.passes ?? null,
            averageAxisCorrelation: validation.validation?.averageAxisCorrelation ?? null,
            pathCorrelation: validation.validation?.pathCorrelation ?? null,
            normalizedDistanceRmse: validation.validation?.normalizedDistanceRmse ?? null,
            runtimeInput: false,
          }
        : null,
      runtimeApiData: false,
    });
  }
  for (const participant of movement?.unmatchedParticipants ?? []) {
    const participantId = Number.isInteger(participant.rosterIndex) ? participant.rosterIndex + 1 : null;
    movementCoverageByParticipant.set(participantId, {
      participantId,
      champion: participant.champion ?? null,
      teamId: participant.team ?? null,
      teamPosition: participant.teamPosition ?? null,
      status: "not_found",
      reason: "no accepted movement entity assignment for this roster participant",
      topRejectedEntityCandidates: (participant.topRejectedEntityCandidates ?? []).slice(0, 3).map((candidate) => ({
        entityKey: candidate.entityKey ?? null,
        familyKey: candidate.familyKey ?? null,
        slotIndex: candidate.slotIndex ?? null,
        score: candidate.score ?? null,
        belowMinimumAssignmentScore: candidate.belowMinimumAssignmentScore ?? null,
        assignedToOtherParticipant: candidate.assignedToOtherParticipant ?? null,
      })),
      runtimeApiData: false,
    });
  }
  const movementParticipantCoverage = [...movementCoverageByParticipant.values()]
    .filter((entry) => Number.isInteger(entry.participantId))
    .sort((left, right) => left.participantId - right.participantId);

  return {
    nonFinalScalarIdentity: roflStatAssignments
      ? {
          status: (roflStatAssignments.totals?.confidence?.canonicalCandidateCount ?? 0) > 0
            ? "rejected_for_runtime"
            : "not_found",
          reason: "replay-only keyframe participant identity has no accepted canonical candidates for runtime scalar timeline export",
          assignmentArtifact: {
            exists: true,
            replayCount: roflStatAssignments.replayCount ?? null,
            analyzedReplayCount: roflStatAssignments.analyzedReplayCount ?? null,
            metricSet: roflStatAssignments.metricSet ?? "conservative",
            allowedMetrics: roflStatAssignments.allowedMetrics ?? null,
            thresholds: roflStatAssignments.thresholds ?? null,
            assignmentCount: roflStatAssignments.totals?.assignmentCount ?? null,
            canonicalCandidateCount: roflStatAssignments.totals?.confidence?.canonicalCandidateCount ?? null,
            diagnosticOnlyCount: roflStatAssignments.totals?.confidence?.diagnosticOnlyCount ?? null,
            edgeCount: roflStatAssignments.totals?.edgeCount ?? null,
            diagnostics: roflStatAssignments.totals?.diagnostics ?? null,
            metricSupportQuality: roflStatAssignments.totals?.metricSupportQuality ?? null,
            rejectionReasonCounts: countAssignmentRejectionReasons(roflStatAssignments),
            strongestReplayDiagnostics: summarizeReplayIdentityDiagnostics(roflStatAssignments),
            strongestRejectedAssignments: summarizeIdentityAssignments(roflStatAssignments),
          },
          offlineComparison: roflStatComparison
            ? {
                assignmentCount: roflStatComparison.totals?.assignmentCount ?? null,
                canonicalCandidateCount: roflStatComparison.totals?.canonicalCandidateCount ?? null,
                canonicalMatchCount: roflStatComparison.totals?.canonicalMatchCount ?? null,
                diagnosticConflictCount: roflStatComparison.totals?.diagnosticConflictCount ?? null,
                diagnosticMatchCount: roflStatComparison.totals?.diagnosticMatchCount ?? null,
                runtimeInput: false,
              }
            : {
                exists: false,
              },
          startupRosterTokenScan: summarizeStartupRosterTokenScan(startupRosterTokenScan, versionGroup),
          handleGraphRowLinkCandidates: summarizeHandleGraphCandidateScores(handleGraphCandidateScores),
          startupKeyframeRowLink: summarizeStartupKeyframeRowLinkDiagnostic(startupKeyframeRowLink),
        }
      : {
          status: "not_found",
          reason: "no replay-only keyframe scalar identity assignment artifact found",
          startupRosterTokenScan: summarizeStartupRosterTokenScan(startupRosterTokenScan, versionGroup),
          handleGraphRowLinkCandidates: summarizeHandleGraphCandidateScores(handleGraphCandidateScores),
          startupKeyframeRowLink: summarizeStartupKeyframeRowLinkDiagnostic(startupKeyframeRowLink),
        },
    reconstructionRowIdentity: {
      status: "not_promoted",
      reason: "241-family chunk rows are structurally plausible but do not establish stable replay-only participant identity",
      runtimeInput: false,
      rowGridCandidateScan: rowGridCandidates
        ? {
            exists: true,
            schema: rowGridCandidates.schema ?? null,
            mode: rowGridCandidates.mode ?? null,
            status: rowGridCandidates.status ?? null,
            runtimeInput: rowGridCandidates.runtimeInput ?? null,
            scannedFamilies: rowGridCandidates.scannedFamilies ?? null,
            candidateCount: rowGridCandidates.candidateCount ?? null,
            topCandidates: (rowGridCandidates.topCandidates ?? []).slice(0, 5).map((candidate) => ({
              familyKey: candidate.familyKey,
              headerBytes: candidate.hypothesis?.headerBytes ?? null,
              rowCount: candidate.hypothesis?.rowCount ?? null,
              rowSize: candidate.hypothesis?.rowSize ?? null,
              score: candidate.score ?? null,
              status: candidate.status ?? null,
              sameRowWinRate: candidate.sameRowWinRate ?? null,
              nearestSameIndexRate: candidate.nearestSameIndexRate ?? null,
              duplicateRowRate: candidate.duplicateRowRate ?? null,
              runtimeApiData: candidate.runtimeApiData ?? null,
              participantIdentity: candidate.participantIdentity ?? null,
            })),
          }
        : {
            exists: false,
          },
      rowGridFieldAnalysis: rowGridFieldAnalysis
        ? {
            exists: true,
            schema: rowGridFieldAnalysis.schema ?? null,
            mode: rowGridFieldAnalysis.mode ?? null,
            status: rowGridFieldAnalysis.status ?? null,
            runtimeInput: rowGridFieldAnalysis.runtimeInput ?? null,
            candidateCount: (rowGridFieldAnalysis.candidates ?? []).length,
            topCandidates: (rowGridFieldAnalysis.candidates ?? []).slice(0, 5).map((candidate) => ({
              familyKey: candidate.familyKey,
              headerBytes: candidate.hypothesis?.headerBytes ?? null,
              rowCount: candidate.hypothesis?.rowCount ?? null,
              rowSize: candidate.hypothesis?.rowSize ?? null,
              candidateStatus: candidate.candidateStatus ?? null,
              promotionStatus: candidate.fieldPromotionAssessment?.status ?? null,
              sameRowWinRate: candidate.rowContinuity?.sameRowWinRate ?? null,
              nearestSameIndexRate: candidate.rowContinuity?.nearestSameIndexRate ?? null,
              rowDiscriminatorColumnCount: (candidate.rowDiscriminatorColumns ?? []).length,
              recordConstantColumnCount: (candidate.recordConstantColumns ?? []).length,
              runtimeApiData: candidate.runtimeApiData ?? null,
              participantIdentity: candidate.participantIdentity ?? null,
            })),
          }
        : {
            exists: false,
          },
      rowIdentityArtifacts: [rowIdentity02, rowIdentity04]
        .filter(Boolean)
        .map((artifact) => ({
          exists: true,
          familyKey: artifact.familyKey ?? null,
          versionGroup: artifact.versionGroup ?? null,
          mode: artifact.mode ?? null,
          status: artifact.status ?? null,
          promotionStatus: artifact.promotionAssessment?.status ?? null,
          runtimeApiData: artifact.promotionAssessment?.runtimeApiData ?? null,
          participantIdentity: artifact.promotionAssessment?.participantIdentity ?? null,
          sameRowWinRate: artifact.evidence?.sameRowWinRate ?? null,
          duplicateRejectedRowCount: artifact.evidence?.duplicateRejectedRowCount ?? null,
          minCoherence: artifact.hypothesis?.minCoherence ?? null,
          duplicateRateThreshold: artifact.hypothesis?.duplicateRateThreshold ?? null,
          promotionReasons: artifact.promotionAssessment?.reasons ?? [],
          rowStatusCounts: Object.fromEntries(
            Object.entries((artifact.rowIdentity ?? []).reduce((counts, row) => {
              counts[row.status] = (counts[row.status] ?? 0) + 1;
              return counts;
            }, {})).sort(([left], [right]) => left.localeCompare(right)),
          ),
          strongestRows: (artifact.rowIdentity ?? [])
            .slice()
            .sort((left, right) => (right.sameRowWinRate ?? -1) - (left.sameRowWinRate ?? -1) || left.rowIndex - right.rowIndex)
            .slice(0, 5)
            .map((row) => ({
              rowIndex: row.rowIndex,
              status: row.status,
              sameRowWinRate: row.sameRowWinRate ?? null,
              duplicateRecordRate: row.duplicateRecordRate ?? null,
              duplicateRecordCount: row.duplicateRecordCount ?? null,
              participantId: row.participantId ?? null,
              runtimeApiData: row.runtimeApiData ?? false,
              reason: row.reason ?? null,
            })),
          rowCount: (artifact.rowIdentity ?? []).length,
        })),
    },
    positions: movement || movementValidation
      ? {
          status: "rejected_for_runtime",
          reason: "movement identity is incomplete and still validated with offline Riot fixture comparisons",
          promotionBlockers: [
            ...((movement?.assignments?.length ?? 0) < 10
              ? [`only ${(movement?.assignments?.length ?? 0)}/10 roster participants have movement entity assignments`]
              : []),
            ...((movement?.unmatchedParticipants?.length ?? 0) > 0
              ? [`${movement?.unmatchedParticipants?.length ?? 0} roster participant(s) have no accepted movement entity assignment`]
              : []),
            ...(movement?.priorsPath != null
              ? ["movement identity currently depends on offline identity priors"]
              : []),
            ...(movementValidation && (movementValidation.summary?.passingAssignmentCount ?? 0) < (movementValidation.summary?.assignmentCount ?? 0)
              ? [`only ${movementValidation.summary?.passingAssignmentCount ?? 0}/${movementValidation.summary?.assignmentCount ?? 0} movement assignments pass offline quality validation`]
              : []),
            ...(movementNoPriors && (movementNoPriors.assignments?.length ?? 0) < (movement?.assignments?.length ?? 0)
              ? [`ROFL-only no-priors movement assignment drops to ${movementNoPriors.assignments?.length ?? 0}/10 participants`]
              : []),
          ],
          qualityGateSummary: {
            assignedParticipantCount: movement?.assignments?.length ?? null,
            expectedParticipantCount: 10,
            unmatchedParticipantCount: movement?.unmatchedParticipants?.length ?? null,
            unassignedEntityCount: movement?.unassignedEntities?.length ?? null,
            usesIdentityPriors: movement?.priorsPath != null,
            offlineAssignmentCount: movementValidation?.summary?.assignmentCount ?? null,
            offlinePassingAssignmentCount: movementValidation?.summary?.passingAssignmentCount ?? null,
            offlineMatchedAssignmentCount: movementValidation?.summary?.matchedAssignmentCount ?? null,
            offlinePassRate: Number.isFinite(movementValidation?.summary?.passingAssignmentCount) &&
              Number.isFinite(movementValidation?.summary?.assignmentCount) &&
              movementValidation.summary.assignmentCount > 0
              ? movementValidation.summary.passingAssignmentCount / movementValidation.summary.assignmentCount
              : null,
            averageAxisCorrelation: movementValidation?.summary?.averageAxisCorrelation ?? null,
            averagePathCorrelation: movementValidation?.summary?.averagePathCorrelation ?? null,
            averageNormalizedDistanceRmse: movementValidation?.summary?.averageNormalizedDistanceRmse ?? null,
            noPriorsAssignedParticipantCount: movementNoPriors?.assignments?.length ?? null,
            noPriorsUnmatchedParticipantCount: movementNoPriors?.unmatchedParticipants?.length ?? null,
            noPriorsOfflineAssignmentCount: movementNoPriorsValidation?.summary?.assignmentCount ?? null,
            noPriorsOfflinePassingAssignmentCount: movementNoPriorsValidation?.summary?.passingAssignmentCount ?? null,
            runtimeInput: false,
          },
          participantMovementArtifact: movement
            ? {
                exists: true,
                assignmentCount: movement.assignments?.length ?? 0,
                unmatchedParticipantCount: movement.unmatchedParticipants?.length ?? 0,
                unassignedEntityCount: movement.unassignedEntities?.length ?? 0,
                usesIdentityPriors: movement.priorsPath != null,
                minimumAssignmentScore: movement.normalization?.minimumAssignmentScore ?? null,
                unmatchedParticipants: (movement.unmatchedParticipants ?? []).map((participant) => ({
                  rosterIndex: participant.rosterIndex ?? null,
                  champion: participant.champion ?? null,
                  team: participant.team ?? null,
                  teamPosition: participant.teamPosition ?? null,
                  topRejectedEntityCandidates: (participant.topRejectedEntityCandidates ?? []).slice(0, 3).map((candidate) => ({
                    entityKey: candidate.entityKey ?? null,
                    familyKey: candidate.familyKey ?? null,
                    slotIndex: candidate.slotIndex ?? null,
                    score: candidate.score ?? null,
                    belowMinimumAssignmentScore: candidate.belowMinimumAssignmentScore ?? null,
                    assignedToOtherParticipant: candidate.assignedToOtherParticipant ?? null,
                  })),
                })),
                unassignedEntities: (movement.unassignedEntities ?? []).slice(0, 5).map((entity) => ({
                  entityKey: entity.entityKey ?? null,
                  familyKey: entity.familyKey ?? null,
                  slotIndex: entity.slotIndex ?? null,
                  entityQuality: entity.entityQuality ?? null,
                  topRejectedParticipantCandidates: (entity.topRejectedParticipantCandidates ?? []).slice(0, 3).map((candidate) => ({
                    rosterIndex: candidate.rosterIndex ?? null,
                    champion: candidate.champion ?? null,
                    teamPosition: candidate.teamPosition ?? null,
                    score: candidate.score ?? null,
                    belowMinimumAssignmentScore: candidate.belowMinimumAssignmentScore ?? null,
                    participantAlreadyAssigned: candidate.participantAlreadyAssigned ?? null,
                  })),
                })),
              }
            : {
                exists: false,
              },
          offlineValidation: movementValidation
            ? {
                exists: true,
                assignmentCount: movementValidation.summary?.assignmentCount ?? null,
                passingAssignmentCount: movementValidation.summary?.passingAssignmentCount ?? null,
                matchedAssignmentCount: movementValidation.summary?.matchedAssignmentCount ?? null,
                averageAxisCorrelation: movementValidation.summary?.averageAxisCorrelation ?? null,
                averagePathCorrelation: movementValidation.summary?.averagePathCorrelation ?? null,
                averageNormalizedDistanceRmse: movementValidation.summary?.averageNormalizedDistanceRmse ?? null,
                runtimeInput: false,
              }
            : {
                exists: false,
              },
          noPriorsDiagnostic: movementNoPriors || movementNoPriorsValidation
            ? {
                exists: true,
                status: "diagnostic_only_not_runtime_api_data",
                reason: "diagnostic rerun disables movement identity priors to measure replay-only assignment strength",
                runtimeInput: false,
                assignmentCount: movementNoPriors?.assignments?.length ?? null,
                unmatchedParticipantCount: movementNoPriors?.unmatchedParticipants?.length ?? null,
                unassignedEntityCount: movementNoPriors?.unassignedEntities?.length ?? null,
                usesIdentityPriors: movementNoPriors?.priorsPath != null,
                unmatchedParticipants: (movementNoPriors?.unmatchedParticipants ?? []).map((participant) => ({
                  rosterIndex: participant.rosterIndex ?? null,
                  champion: participant.champion ?? null,
                  team: participant.team ?? null,
                  teamPosition: participant.teamPosition ?? null,
                  topRejectedEntityCandidates: (participant.topRejectedEntityCandidates ?? []).slice(0, 3).map((candidate) => ({
                    entityKey: candidate.entityKey ?? null,
                    familyKey: candidate.familyKey ?? null,
                    slotIndex: candidate.slotIndex ?? null,
                    score: candidate.score ?? null,
                    belowMinimumAssignmentScore: candidate.belowMinimumAssignmentScore ?? null,
                    assignedToOtherParticipant: candidate.assignedToOtherParticipant ?? null,
                  })),
                })),
                offlineValidation: movementNoPriorsValidation
                  ? {
                      exists: true,
                      assignmentCount: movementNoPriorsValidation.summary?.assignmentCount ?? null,
                      passingAssignmentCount: movementNoPriorsValidation.summary?.passingAssignmentCount ?? null,
                      matchedAssignmentCount: movementNoPriorsValidation.summary?.matchedAssignmentCount ?? null,
                      averageAxisCorrelation: movementNoPriorsValidation.summary?.averageAxisCorrelation ?? null,
                      averagePathCorrelation: movementNoPriorsValidation.summary?.averagePathCorrelation ?? null,
                      averageNormalizedDistanceRmse: movementNoPriorsValidation.summary?.averageNormalizedDistanceRmse ?? null,
                      runtimeInput: false,
                    }
                  : {
                      exists: false,
                    },
              }
            : {
                exists: false,
              },
          perParticipantCoverage: movementParticipantCoverage,
        }
      : {
          status: "not_found",
          reason: "no participant movement artifact found for this replay",
          perParticipantCoverage: [],
        },
    itemEvents: itemEventCandidates
      ? {
          status: "rejected_for_runtime",
          reason: "candidate report is supervised against Riot API timeline events and is not a ROFL-only event decoder",
          candidateArtifact: {
            exists: true,
            candidateCount: itemEventCandidates.summary?.candidateCount ?? null,
            strongCandidateCount: itemEventCandidates.summary?.strongCandidateCount ?? null,
            topCandidateCount: itemEventCandidates.summary?.topCandidateCount ?? null,
            familySummaryCount: itemEventCandidates.summary?.familySummaryCount ?? null,
          },
          eventInventory: itemEventCandidates.eventInventory
            ? {
                globalEventCount: itemEventCandidates.eventInventory.globalEventCount ?? null,
                participantEventCounts: itemEventCandidates.eventInventory.participantEventCounts ?? {},
                eventTypeCounts: itemEventCandidates.eventInventory.eventTypeCounts ?? {},
              }
            : null,
          offlineValidation: {
            source: "riot-api-timeline-fixture",
            runtimeInput: false,
          },
          eventFamilyCorrelation: summarizeEventFamilyCorrelation(eventFamilyCorrelation),
        }
      : {
          status: "not_found",
          reason: "no item-event candidate artifact found for this replay",
          eventFamilyCorrelation: summarizeEventFamilyCorrelation(eventFamilyCorrelation),
        },
    inventoryTimeline: itemEventCandidates
      ? {
          status: "rejected_for_runtime",
          reason: "inventory state over time is not reconstructed from ROFL-only item events yet",
          blocker: "item-event candidates are supervised/offline-only and no slot-state timeline decoder exists",
          relatedCandidateArtifact: {
            itemEventCandidateCount: itemEventCandidates.summary?.candidateCount ?? null,
            strongItemEventCandidateCount: itemEventCandidates.summary?.strongCandidateCount ?? null,
            globalEventCount: itemEventCandidates.eventInventory?.globalEventCount ?? null,
            eventTypeCounts: itemEventCandidates.eventInventory?.eventTypeCounts ?? {},
            participantEventCounts: itemEventCandidates.eventInventory?.participantEventCounts ?? {},
          },
          runtimeInput: false,
        }
      : {
          status: "not_found",
          reason: "no ROFL-only item event or inventory slot timeline decoder found for this replay",
        },
    championStatsFinal: {
      status: "not_promoted",
      source: "rofl-metadata-statsJson",
      reason: "No accepted direct final statsJson source matches Riot timeline participantFrames.championStats semantics. Apparent matches are all-zero or unrelated counter collisions, so championStats remains an API-shaped empty container.",
      rejectedCandidateSummary: {
        inspectedSource: "summary.metadataJson.statsJson",
        inspectedApiContainer: "timeline.info.frames[-1].participantFrames[].championStats",
        collisionClasses: [
          "all-zero stat keys matching zero-valued championStats fields",
          "unrelated counters with partial participant value overlap",
        ],
      },
    },
    damageTimeline: damageMetricKeys.length > 0
      ? {
          status: "rejected_for_runtime",
          reason: "damage-like extracted stat metrics exist only in the scalar research artifact and are not mapped to API timeline damage fields",
          extractedStatsArtifact: {
            exists: true,
            damageMetricKeys,
            runtimeInput: false,
          },
        }
      : {
          status: "not_found",
          reason: "no damage timeline candidate metrics found in extracted replay stats",
          extractedStatsArtifact: {
            exists: extractedStats != null,
            metricCount: extractedMetricKeys.size,
          },
        },
  };
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = resolveAbsolute(
    root,
    args.inputPath ?? path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}-all-assignments.json`),
  );
  const summaryPath = resolveAbsolute(
    root,
    args.summaryPath ?? path.join(artifactRoot, args.replayId, "summary.json"),
  );
  const replayPath = resolveAbsolute(root, path.join("replays", `${args.replayId}.rofl`));
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, args.replayId, "rofl-api-metrics.json"),
  );
  const summary = readJson(summaryPath);
  const input = args.includeResearchKeyframes ? readJson(inputPath) : null;
  const replay = input
    ? (input.replays ?? []).find((entry) => entry.replayId === args.replayId)
    : null;
  if (args.includeResearchKeyframes && !replay) {
    throw new Error(`Replay ${args.replayId} was not found in ${inputPath}.`);
  }
  const rosterParticipants = buildSummaryRoster(summary).map(makeRosterParticipant);
  if (rosterParticipants.length !== 10) {
    throw new Error(`Expected 10 ROFL roster participants from ${summaryPath}; found ${rosterParticipants.length}.`);
  }
  const rosterByParticipantId = new Map(rosterParticipants.map((participant) => [participant.participantId, participant]));
  const coverageByParticipant = initializeCoverage(rosterParticipants);

  const participantFrames = new Map();
  const participantsById = new Map();
  const selectedSeries = new Map();
  const seriesQuality = [];
  const droppedSeries = [];

  for (const participantRow of replay?.participants ?? []) {
    const participantId = participantRow.participant?.participantId;
    if (!args.includeUnstable && !participantRow.stable) {
      droppedSeries.push({
        participantId,
        champion: participantRow.participant?.champion,
        metric: "*",
        reasons: ["unstable-participant-assignment"],
      });
      for (const metric of Object.keys(participantRow.metrics ?? participantRow.series ?? {})) {
        addCoverageReason(coverageByParticipant, participantId, metric, "unstable_identity", "unstable-participant-assignment", {
          familyKey: participantRow.familyKey,
          slotIndex: participantRow.slotIndex,
        });
      }
      continue;
    }

    if (!participantsById.has(participantId)) {
      participantsById.set(participantId, {
        ...makeParticipantFrame(participantRow.participant),
        stable: Boolean(participantRow.stable),
        replayLocalAssignment: Boolean(participantRow.replayLocalAssignment),
      });
    } else {
      const current = participantsById.get(participantId);
      current.stable = current.stable && Boolean(participantRow.stable);
      current.replayLocalAssignment = current.replayLocalAssignment && Boolean(participantRow.replayLocalAssignment);
    }

    for (const [metric, points] of Object.entries(participantRow.series ?? {})) {
      const summary = participantRow.metrics?.[metric] ?? {};
      const assessment = assessMetric(metric, summary, args);
      const baseQuality = {
        participantId: participantRow.participant?.participantId,
        champion: participantRow.participant?.champion,
        metric,
        stable: Boolean(participantRow.stable),
        comparedPoints: summary.comparedPoints ?? null,
        pointCount: summary.pointCount ?? null,
        correlation: summary.correlation ?? null,
        normalizedRmse: summary.normalizedRmse ?? null,
        meanAbsError: summary.meanAbsError ?? null,
        maxAbsError: summary.maxAbsError ?? null,
        fitSource: summary.fitSource ?? null,
        familyKey: participantRow.familyKey,
        slotIndex: participantRow.slotIndex,
      };
      if (!assessment.ok) {
        droppedSeries.push({
          ...baseQuality,
          reasons: assessment.reasons,
          limits: assessment.limits,
        });
        addCoverageReason(coverageByParticipant, participantId, metric, "noisy", assessment.reasons[0] ?? "quality-gate-rejected", {
          reasons: assessment.reasons,
          limits: assessment.limits,
          quality: baseQuality,
        });
        continue;
      }

      const seriesKey = `${participantId}|${metric}`;
      const candidate = {
        participantRow,
        metric,
        points,
        summary,
        baseQuality,
        limits: assessment.limits,
      };
      const current = selectedSeries.get(seriesKey);
      if (!current || compareCandidateQuality(candidate, current) < 0) {
        if (current) {
          droppedSeries.push({
            ...current.baseQuality,
            reasons: ["weaker-duplicate-participant-metric-series"],
            limits: current.limits,
          });
          addCoverageReason(coverageByParticipant, participantId, metric, "duplicate_rejected", "weaker-duplicate-participant-metric-series", {
            quality: current.baseQuality,
          });
        }
        selectedSeries.set(seriesKey, candidate);
      } else {
        droppedSeries.push({
          ...baseQuality,
          reasons: ["weaker-duplicate-participant-metric-series"],
          limits: assessment.limits,
        });
        addCoverageReason(coverageByParticipant, participantId, metric, "duplicate_rejected", "weaker-duplicate-participant-metric-series", {
          quality: baseQuality,
        });
      }
    }
  }

  for (const candidate of selectedSeries.values()) {
    const { participantRow, metric, points, summary, baseQuality, limits } = candidate;
    seriesQuality.push({
      ...baseQuality,
      limits,
      provenance: {
        values: "rofl-keyframe-field",
        participantIdentity: "current-keyframe-assignment-artifact",
        calibration: summary.fitSource === "stored-top-match" ? "stored-supervised-parity-fit" : "replay-local-affine-fit",
      },
    });
    if (args.includeResearchKeyframes) {
      setCoverageDecoded(coverageByParticipant, baseQuality.participantId, metric, {
        pointCount: summary.pointCount ?? null,
        comparedPoints: summary.comparedPoints ?? null,
        correlation: summary.correlation ?? null,
        normalizedRmse: summary.normalizedRmse ?? null,
        meanAbsError: summary.meanAbsError ?? null,
        maxAbsError: summary.maxAbsError ?? null,
        familyKey: baseQuality.familyKey,
        slotIndex: baseQuality.slotIndex,
        provenance: {
          values: "rofl-keyframe-field",
          participantIdentity: "current-keyframe-assignment-artifact",
          calibration: summary.fitSource === "stored-top-match" ? "stored-supervised-parity-fit" : "replay-local-affine-fit",
        },
      });
    } else {
      addCoverageReason(coverageByParticipant, baseQuality.participantId, metric, "noisy", "research-keyframe-series-not-runtime-rofl-only", {
        quality: baseQuality,
      });
    }

    if (args.includeResearchKeyframes) {
      for (const point of points) {
        const value = normalizedValue(metric, point.value);
        if (value == null) {
          continue;
        }
        const key = `${point.timestamp}`;
        const frame = participantFrames.get(key) ?? {
          timestamp: point.timestamp,
          apiFrameIndex: point.apiFrameIndex,
          participantFrames: {},
          events: [],
        };
        const participantId = String(participantRow.participant?.participantId);
        const participantFrame = frame.participantFrames[participantId] ?? {
          participantId: participantRow.participant?.participantId,
        };
        setNested(participantFrame, apiMetricPaths.get(metric), value);
        frame.participantFrames[participantId] = participantFrame;
        participantFrames.set(key, frame);
      }
    }
  }

  const finalFrameTimestamp = Number.isFinite(summary.gameLengthMillis) ? summary.gameLengthMillis : null;
  if (finalFrameTimestamp != null) {
    const finalFrame = participantFrames.get(`${finalFrameTimestamp}`) ?? {
      timestamp: finalFrameTimestamp,
      participantFrames: {},
      events: [],
      provenance: {
        values: "rofl-metadata-statsJson",
        frameKind: "final-stats",
      },
    };
    for (const participant of rosterParticipants) {
      const participantId = String(participant.participantId);
      const participantFrame = finalFrame.participantFrames[participantId] ?? {
        participantId: participant.participantId,
        championStats: makeApiShapedChampionStats(),
        damageStats: {},
      };
      participantFrame.championStats = {
        ...makeApiShapedChampionStats(),
        ...(participantFrame.championStats ?? {}),
      };
      participantFrame.damageStats = {
        ...(participantFrame.damageStats ?? {}),
        ...buildTimelineDamageStats(participant.apiLikeStats ?? {}),
      };
      participantFrame.currentGold = null;
      participantFrame.goldPerSecond = null;
      participantFrame.position = {
        x: null,
        y: null,
      };
      participantFrame.timeEnemySpentControlled = null;
      for (const [metric, value] of Object.entries(participant.finalMetrics ?? {})) {
        if (!apiMetricPaths.has(metric) || value == null || !Number.isFinite(value)) {
          continue;
        }
        setNested(participantFrame, apiMetricPaths.get(metric), normalizedValue(metric, value));
        setCoverageDecoded(coverageByParticipant, participant.participantId, metric, {
          pointCount: ((coverageByParticipant.get(participant.participantId)?.metrics?.[metric]?.pointCount ?? 0) + 1),
          provenance: {
            values: "rofl-metadata-statsJson",
            participantIdentity: "rofl-summary-roster-order",
            calibration: "direct-final-stat",
          },
        });
      }
      if (Object.keys(participantFrame).length > 0) {
        finalFrame.participantFrames[participantId] = participantFrame;
      }
    }
    if (Object.keys(finalFrame.participantFrames).length > 0) {
      participantFrames.set(`${finalFrameTimestamp}`, finalFrame);
    }
  }

  seriesQuality.sort((left, right) =>
    left.participantId - right.participantId ||
    left.metric.localeCompare(right.metric)
  );

  const participants = [...participantsById.values()]
    .filter((participant) => seriesQuality.some((series) => series.participantId === participant.participantId))
    .sort((left, right) => left.participantId - right.participantId);

  const frames = [...participantFrames.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .map((frame) => ({
      ...frame,
      participantFrames: Object.fromEntries(
        Object.entries(frame.participantFrames).sort(([left], [right]) => Number(left) - Number(right)),
      ),
    }));
  const emittedTimelineParticipantIds = new Set(
    frames.flatMap((frame) => Object.keys(frame.participantFrames ?? {}).map((participantId) => Number(participantId))),
  );
  const rejectedCandidateArtifacts = buildRejectedCandidateArtifacts(root, args.replayId, args.versionGroup);
  annotateNonFinalIdentityCoverage(coverageByParticipant, rejectedCandidateArtifacts);
  const coverage = [...coverageByParticipant.values()]
    .map((entry) => ({
      ...entry,
      metricStatusCounts: countMetricStatuses(entry.metrics),
    }))
    .sort((left, right) => left.participantId - right.participantId);
  const matchCoverage = buildMatchCoverage(rosterParticipants);
  const decodedCoverageMetricCount = coverage.reduce(
    (sum, participantCoverage) => sum + Object.values(participantCoverage.metrics ?? {}).filter((entry) => entry.status === "decoded").length,
    0,
  );
  const coverageSummary = {};
  for (const participantCoverage of coverage) {
    for (const entry of Object.values(participantCoverage.metrics ?? {})) {
      coverageSummary[entry.status] = (coverageSummary[entry.status] ?? 0) + 1;
    }
  }
  const remainingParityGaps = buildRemainingParityGaps(rejectedCandidateArtifacts);

  const output = {
    artifactSchema: "rofl-api-parity-checkpoint/v1",
    generatedAtUtc: new Date().toISOString(),
    extractionMode: args.includeResearchKeyframes ? "rofl-with-research-keyframe-diagnostics" : "rofl-only-final-stats",
    source: {
      researchInputPath: args.includeResearchKeyframes ? inputPath : null,
      summaryPath,
      replayPath,
      replayId: args.replayId,
      versionGroup: replay?.versionGroup ?? args.versionGroup,
      gameVersion: summary.gameVersion ?? replay?.gameVersion ?? null,
      roflOnlyInputs: {
        rosterAndFinalStats: true,
        runtimeRiotApiFiles: false,
      },
      inputClasses: {
        runtimeReplayFile: {
          class: "runtime-rofl",
          path: replayPath,
          requiredForRuntime: true,
        },
        replayDerivedSummary: {
          class: "generated-rofl-summary",
          path: summaryPath,
          requiredForRuntime: true,
        },
        decoderSchemasAndDiagnostics: {
          class: "repo-local-generated-diagnostics",
          requiredForRuntime: false,
          runtimePromotionAllowed: false,
          note: "Used only to explain rejected candidates unless explicitly exported in research mode.",
        },
        riotApiFixtures: {
          class: "offline-validation-only",
          path: null,
          requiredForRuntime: false,
          runtimePromotionAllowed: false,
        },
      },
      decoderArtifactSupervised: Boolean(input?.supervised),
      note: input?.note ?? null,
    },
    shape: "riot-match-and-timeline-subset",
    caveat: buildArtifactCaveat(args.includeResearchKeyframes),
    artifactManifest: {
      primaryRuntimeArtifact: {
        path: outputPath,
        role: "api-shaped-rofl-only-runtime-output",
        runtimeInput: false,
      },
      sourceReplay: {
        path: replayPath,
        role: "required-runtime-rofl-input",
        runtimeInput: true,
      },
      replayDerivedSummary: {
        path: summaryPath,
        role: "required-runtime-derived-summary",
        runtimeInput: true,
      },
      decoderDiagnostics: [
        {
          path: path.join(root, "artifacts", args.replayId, "participant-movement.json"),
          role: "rejected-position-candidate-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts", args.replayId, "assigned-movement-validation-report.json"),
          role: "offline-position-validation-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts", args.replayId, "participant-movement-no-priors.json"),
          role: "replay-only-no-priors-position-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts", args.replayId, "assigned-movement-no-priors-validation-report.json"),
          role: "offline-no-priors-position-validation-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts-keyframes", "startup-roster-token-scan.json"),
          role: "replay-only-startup-roster-token-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts-keyframes", "keyframe-handle-graph-candidate-scores.json"),
          role: "offline-handle-graph-row-link-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts-keyframes", `startup-keyframe-row-link-diagnostic-${args.versionGroup}.json`),
          role: "offline-startup-keyframe-row-link-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
        {
          path: path.join(root, "artifacts-keyframes", `reconstruction-family-event-correlation-${args.versionGroup}.json`),
          role: "offline-event-family-correlation-diagnostic",
          runtimeInput: false,
          runtimeApiData: false,
        },
      ],
      offlineValidationReports: [
        {
          path: path.join(path.dirname(outputPath), "rofl-api-metrics-riot-validation.json"),
          role: "offline-riot-fixture-validation",
          runtimeInput: false,
        },
        {
          path: path.join(path.dirname(outputPath), "rofl-api-shape-gap-report.json"),
          role: "offline-riot-shape-gap-audit",
          runtimeInput: false,
        },
        {
          path: path.join(path.dirname(outputPath), "rofl-challenge-gap-candidates.json"),
          role: "offline-challenge-gap-audit",
          runtimeInput: false,
        },
      ],
      checkpointCommand: "npm run verify:rofl-api-parity -- --replay-id EUW1-7840220945 --allow-validation-mismatch",
    },
    thresholds: {
      stableParticipantsOnly: !args.includeUnstable,
      maxNormalizedRmse: args.maxNormalizedRmse,
      minCorrelation: args.minCorrelation,
      maxMeanAbsError: args.maxMeanAbsError,
      includeResearchKeyframes: args.includeResearchKeyframes,
    },
    totals: {
      rosterParticipantCount: rosterParticipants.length,
      timelineParticipantCount: emittedTimelineParticipantIds.size,
      frameCount: frames.length,
      researchKeyframeMetricSeriesCount: seriesQuality.length,
      roflOnlyFinalMetricSeriesCount: rosterParticipants.reduce(
        (sum, participant) => sum + Object.keys(participant.finalMetrics ?? {}).filter((metric) => apiMetricPaths.has(metric)).length,
        0,
      ),
      decodedCoverageMetricCount,
      coverageSummary,
      matchCoverageSummary: {
        decodedParticipants: matchCoverage.filter((entry) => entry.status === "decoded").length,
        participantCount: matchCoverage.length,
        minApiLikeStatCount: Math.min(...matchCoverage.map((entry) => entry.apiLikeStatCount)),
        maxApiLikeStatCount: Math.max(...matchCoverage.map((entry) => entry.apiLikeStatCount)),
      },
      droppedSeriesCount: droppedSeries.length,
      emittedMetricPointCount: frames.reduce(
        (sum, frame) => sum + Object.values(frame.participantFrames).reduce(
          (inner, participantFrame) => inner +
            Object.entries(participantFrame)
              .filter(([key, value]) => key !== "championStats" && key !== "damageStats" && key !== "participantId" && value != null && typeof value !== "object")
              .length +
            Object.values(participantFrame.championStats ?? {}).filter((value) => value != null).length,
          0,
        ),
        0,
      ),
    },
    coverageStatusLegend,
    parityChecklist: buildParityChecklist(),
    match: {
      metadata: {
        matchId: args.replayId.replace("-", "_"),
        dataVersion: null,
        participants: rosterParticipants.map((participant) => participant.apiLikeStats?.puuid).filter(Boolean),
        provenance: {
          matchId: "rofl-file-name",
          participants: "rofl-metadata-statsJson",
        },
      },
      info: {
        gameId: parseReplayGameId(args.replayId),
        platformId: parseReplayPlatformId(args.replayId),
        gameVersion: summary.gameVersion ?? replay?.gameVersion ?? null,
        gameDuration: Number.isFinite(summary.gameLengthMillis) ? Math.round(summary.gameLengthMillis / 1000) : null,
        gameDurationMillis: summary.gameLengthMillis ?? null,
        gameCreation: null,
        gameEndTimestamp: null,
        gameMode: null,
        gameName: null,
        gameStartTimestamp: null,
        gameType: null,
        mapId: null,
        queueId: null,
        tournamentCode: null,
        endOfGameResult: rosterParticipants.length === 10 ? "GameComplete" : null,
        participants: rosterParticipants.map(buildMatchInfoParticipant),
        teams: buildTeamInfo(rosterParticipants),
      },
      participants: rosterParticipants,
    },
    timeline: {
      metadata: {
        matchId: args.replayId.replace("-", "_"),
        dataVersion: null,
        participants: rosterParticipants.map((participant) => participant.apiLikeStats?.puuid).filter(Boolean),
        provenance: {
          matchId: "rofl-file-name",
          participants: "rofl-metadata-statsJson",
        },
      },
      info: {
        gameId: parseReplayGameId(args.replayId),
        endOfGameResult: rosterParticipants.length === 10 ? "GameComplete" : null,
        frameInterval: null,
        participants: rosterParticipants.map(buildTimelineInfoParticipant),
        frames,
      },
    },
    participants: rosterParticipants.map((participant) => ({
      ...participant,
      timelineDecoded: emittedTimelineParticipantIds.has(participant.participantId),
    })),
    frames,
    fieldCoverage: buildFieldCoverage(rejectedCandidateArtifacts),
    roflDerivedFieldMap: buildRoflDerivedFieldMap(rejectedCandidateArtifacts),
    identityLinkage: buildIdentityLinkageSummary(rosterParticipants, emittedTimelineParticipantIds, rejectedCandidateArtifacts),
    rejectedCandidateArtifacts,
    remainingParityGaps,
    roflOnlyExtractionProof: buildRoflOnlyExtractionProof(rosterParticipants, frames, rejectedCandidateArtifacts, remainingParityGaps),
    matchCoverage,
    coverage,
    parityGaps: {
      fullTimelineParticipantIdentity: "incomplete",
      fullTimelineScalarCalibration: "incomplete",
      matchMetadata: "partial",
      timelineEvents: "not_extracted",
      positions: "not_extracted_for_16.9",
      inventoryTimeline: "not_extracted",
      damageTimeline: "not_extracted",
      notes: [
        "Match/final participant data is ROFL-only from embedded statsJson.",
        "A final statsJson timeline frame is ROFL-only for all 10 participants.",
        "Non-final keyframe timeline metrics are omitted by default because they still depend on decoder research artifacts for identity/calibration.",
        "Riot API fixtures must remain offline validation inputs only.",
      ],
    },
    researchKeyframeSeriesQuality: seriesQuality,
    seriesQuality,
    droppedSeries,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ROFL API-shaped metrics to ${outputPath}`);
  console.log(`Emitted ${output.totals.roflOnlyFinalMetricSeriesCount} ROFL-only final metric series and ${output.totals.emittedMetricPointCount} metric points across ${output.totals.frameCount} frame(s).`);
  console.log(`Kept ${output.totals.researchKeyframeMetricSeriesCount} research keyframe series as diagnostics; runtime emission=${args.includeResearchKeyframes}.`);
  console.log(`Dropped ${output.totals.droppedSeriesCount} noisy or unstable series.`);
}

main();
