#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

function printHelp() {
  console.log(`Usage:
  node ./scripts/correlate-replay-api.mjs --replay <path-to-rofl> [options]
  node ./scripts/correlate-replay-api.mjs --all [options]

Options:
  --replay <path>         Replay file path. Can be provided multiple times.
  --all                   Analyze every .rofl file under ./replays.
  --api-root <path>       Riot fixture root. Defaults to ./replays/api.
  --cli <path>            Path to rofl_core_cli.exe. Defaults to the first existing Debug/Release/root build output.
  --top-windows <count>   Number of eventful chunk windows to print. Defaults to 8.
  --json                  Emit machine-readable JSON instead of text.
  --help                  Show this help text.
`);
}

function parseArgs(argv) {
  const args = {
    replayPaths: [],
    analyzeAll: false,
    apiRoot: resolve("replays", "api"),
    cliPath: null,
    topWindows: 8,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--replay") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --replay");
      }
      args.replayPaths.push(resolve(value));
      continue;
    }
    if (arg === "--all") {
      args.analyzeAll = true;
      continue;
    }
    if (arg === "--api-root") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --api-root");
      }
      args.apiRoot = resolve(value);
      continue;
    }
    if (arg === "--cli") {
      const value = argv[++index];
      if (!value) {
        throw new Error("Missing value for --cli");
      }
      args.cliPath = resolve(value);
      continue;
    }
    if (arg === "--top-windows") {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error("--top-windows must be a positive number");
      }
      args.topWindows = value;
      continue;
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!args.analyzeAll && args.replayPaths.length === 0) {
    throw new Error("Pass at least one --replay path or use --all.");
  }
  args.cliPath = resolveCliPath(args.cliPath);

  return args;
}

function resolveCliPath(explicitPath) {
  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`rofl_core_cli.exe not found at ${explicitPath}`);
    }
    return explicitPath;
  }

  const candidates = [
    resolve("build", "packages", "rofl-core", "Debug", "rofl_core_cli.exe"),
    resolve("build", "packages", "rofl-core", "Release", "rofl_core_cli.exe"),
    resolve("build", "packages", "rofl-core", "rofl_core_cli.exe"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`rofl_core_cli.exe not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runCli(cliPath, args) {
  const command = `& ${psQuote(cliPath)} ${args.map(psQuote).join(" ")}`;
  return execFileSync("pwsh", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function deriveMatchIdFromReplayPath(replayPath) {
  const replayName = basename(replayPath);
  const match = replayName.match(/^([A-Za-z0-9]+)-(\d+)\.rofl$/);
  if (!match) {
    throw new Error(`Could not derive Riot match ID from ${replayName}. Expected PLATFORM-GAMEID.rofl.`);
  }
  return `${match[1].toUpperCase()}_${match[2]}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadReplaySummary(cliPath, replayPath) {
  return JSON.parse(runCli(cliPath, ["--summary", replayPath]));
}

function flattenTimelineEvents(timeline) {
  return (timeline.info.frames ?? []).flatMap((frame, frameIndex) =>
    (frame.events ?? []).map((event) => ({ ...event, frameIndex })),
  );
}

function countMatchingEvents(events, predicate) {
  let count = 0;
  for (const event of events) {
    if (predicate(event)) {
      count += 1;
    }
  }
  return count;
}

function correlateChunkWindow(chunk, timelineFrames, timelineEvents, gameLengthMillis) {
  const windowStartMs = Math.max(0, (chunk.chunkId - 4) * 30000);
  const windowEndMs = Math.min(gameLengthMillis, windowStartMs + 30000);
  const apiIntervalIndex = Math.max(0, Math.floor((chunk.chunkId - 4) / 2));
  const intervalStartMs = timelineFrames[apiIntervalIndex]?.timestamp ?? windowStartMs;
  const intervalEndMs = timelineFrames[apiIntervalIndex + 1]?.timestamp ?? gameLengthMillis;
  const events = timelineEvents.filter((event) => event.timestamp >= windowStartMs && event.timestamp < windowEndMs);

  const counts = {
    total: events.length,
    championKills: countMatchingEvents(events, (event) => event.type === "CHAMPION_KILL"),
    buildingKills: countMatchingEvents(events, (event) => event.type === "BUILDING_KILL"),
    eliteMonsterKills: countMatchingEvents(events, (event) => event.type === "ELITE_MONSTER_KILL"),
    itemEvents: countMatchingEvents(events, (event) => event.type.startsWith("ITEM_")),
    wardEvents: countMatchingEvents(events, (event) => event.type.includes("WARD")),
  };

  const eventTypeCounts = new Map();
  for (const event of events) {
    eventTypeCounts.set(event.type, (eventTypeCounts.get(event.type) ?? 0) + 1);
  }

  const topEventTypes = [...eventTypeCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 4)
    .map(([type, count]) => ({ type, count }));

  return {
    chunkId: chunk.chunkId,
    chunkRecordId: chunk.id,
    windowStartMs,
    windowEndMs,
    apiIntervalIndex,
    intervalStartMs,
    intervalEndMs,
    endsOnKeyframeBoundary: chunk.chunkId % 2 === 1,
    compressedLength: chunk.length,
    uncompressedLength: chunk.uncompressedLength,
    counts,
    topEventTypes,
  };
}

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) {
    return null;
  }
  const avgX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const avgY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let sumXY = 0;
  let sumXX = 0;
  let sumYY = 0;
  for (let index = 0; index < xs.length; index += 1) {
    const dx = xs[index] - avgX;
    const dy = ys[index] - avgY;
    sumXY += dx * dy;
    sumXX += dx * dx;
    sumYY += dy * dy;
  }
  if (sumXX <= 0 || sumYY <= 0) {
    return null;
  }
  return sumXY / Math.sqrt(sumXX * sumYY);
}

function formatRatio(numerator, denominator) {
  return `${numerator}/${denominator}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatFloat(value) {
  return value == null ? "n/a" : value.toFixed(4);
}

function analyzeReplay(replayPath, options) {
  const matchId = deriveMatchIdFromReplayPath(replayPath);
  const apiDir = resolve(options.apiRoot, matchId);
  const matchPath = resolve(apiDir, "match.json");
  const timelinePath = resolve(apiDir, "timeline.json");
  if (!existsSync(matchPath) || !existsSync(timelinePath)) {
    throw new Error(`Missing API fixture bundle for ${matchId} under ${apiDir}`);
  }

  const replaySummary = loadReplaySummary(options.cliPath, replayPath);
  const match = readJson(matchPath);
  const timeline = readJson(timelinePath);
  const timelineFrames = timeline.info.frames ?? [];
  const timelineEvents = flattenTimelineEvents(timeline);
  const keyframes = (replaySummary.container.segments ?? []).filter((segment) => segment.type === "keyframe");
  const chunks = (replaySummary.container.segments ?? [])
    .filter((segment) => segment.type === "chunk")
    .sort((left, right) => left.chunkId - right.chunkId);

  const matchedPlayers = replaySummary.players.map((player) => {
    const apiParticipant = match.info.participants.find(
      (participant) =>
        participant.teamId === player.team &&
        participant.teamPosition === player.teamPosition &&
        participant.championName === player.champion,
    );
    const apiWin = apiParticipant?.win ? "Win" : "Fail";
    return {
      player,
      apiParticipant,
      exact: {
        champion: apiParticipant?.championName === player.champion,
        team: apiParticipant?.teamId === player.team,
        teamPosition: apiParticipant?.teamPosition === player.teamPosition,
        riotId:
          `${apiParticipant?.riotIdGameName ?? ""}#${apiParticipant?.riotIdTagline ?? ""}` ===
          `${player.riotIdGameName}#${player.riotIdTagLine}`,
        kills: apiParticipant?.kills === player.kills,
        deaths: apiParticipant?.deaths === player.deaths,
        assists: apiParticipant?.assists === player.assists,
        goldEarned: apiParticipant?.goldEarned === player.goldEarned,
        damage: apiParticipant?.totalDamageDealtToChampions === player.totalDamageToChampions,
        vision: apiParticipant?.visionScore === player.visionScore,
        win: apiWin === player.win,
      },
      goldDelta: apiParticipant ? player.goldEarned - apiParticipant.goldEarned : null,
    };
  });

  const exactFieldCounts = {};
  for (const field of ["champion", "team", "teamPosition", "riotId", "kills", "deaths", "assists", "goldEarned", "damage", "vision", "win"]) {
    exactFieldCounts[field] = matchedPlayers.filter((entry) => entry.exact[field]).length;
  }

  const goldDeltaHistogram = Object.fromEntries(
    [...matchedPlayers.reduce((map, entry) => {
      if (entry.goldDelta == null) {
        return map;
      }
      const key = String(entry.goldDelta);
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map()).entries()].sort((left, right) => Number(left[0]) - Number(right[0])),
  );

  const keyframeChunkFormulaHolds = keyframes.every((segment) => segment.chunkId === (2 * segment.id) + 1);
  const chunkRecordFormulaHolds = chunks.every((segment) => segment.chunkId === segment.id + 1);
  const actualLastChunkId = chunks.at(-1)?.chunkId ?? 0;
  const apiFramesMatchReplayKeyframes = timelineFrames.length === replaySummary.container.keyframeCount + 1;
  const lastTimelineFrameTimestamp = timelineFrames.at(-1)?.timestamp ?? 0;
  const lastTimelineIntervalMs = timelineFrames.length > 1
    ? timelineFrames.at(-1).timestamp - timelineFrames.at(-2).timestamp
    : 0;
  const tailShorterThan30s = lastTimelineIntervalMs < 30000;
  const lastChunkIdIsOdd = (replaySummary.lastGameChunkId % 2) === 1;

  const chunkWindows = chunks.map((chunk) => correlateChunkWindow(chunk, timelineFrames, timelineEvents, replaySummary.gameLengthMillis));
  const correlations = {
    compressedVsEvents: pearson(chunkWindows.map((window) => window.compressedLength), chunkWindows.map((window) => window.counts.total)),
    compressedVsKills: pearson(chunkWindows.map((window) => window.compressedLength), chunkWindows.map((window) => window.counts.championKills)),
    compressedVsObjectives: pearson(
      chunkWindows.map((window) => window.compressedLength),
      chunkWindows.map((window) => window.counts.eliteMonsterKills + window.counts.buildingKills),
    ),
    uncompressedVsEvents: pearson(chunkWindows.map((window) => window.uncompressedLength), chunkWindows.map((window) => window.counts.total)),
    uncompressedVsKills: pearson(chunkWindows.map((window) => window.uncompressedLength), chunkWindows.map((window) => window.counts.championKills)),
  };

  const topEventfulWindows = [...chunkWindows]
    .filter((window) => window.counts.total > 0)
    .sort((left, right) => {
      const leftObjectives = left.counts.eliteMonsterKills + left.counts.buildingKills;
      const rightObjectives = right.counts.eliteMonsterKills + right.counts.buildingKills;
      if (rightObjectives !== leftObjectives) {
        return rightObjectives - leftObjectives;
      }
      if (right.counts.championKills !== left.counts.championKills) {
        return right.counts.championKills - left.counts.championKills;
      }
      if (right.counts.total !== left.counts.total) {
        return right.counts.total - left.counts.total;
      }
      return right.compressedLength - left.compressedLength;
    })
    .slice(0, options.topWindows);

  return {
    replayPath,
    replayName: basename(replayPath),
    matchId,
    replaySummary,
    playerBridge: {
      matchedPlayers: matchedPlayers.filter((entry) => entry.apiParticipant).length,
      totalReplayPlayers: replaySummary.players.length,
      exactFieldCounts,
      goldDeltaHistogram,
    },
    structural: {
      startupChunkEndId: replaySummary.container.startupChunkEndId,
      gameStartChunkId: replaySummary.container.gameStartChunkId,
      apiFrameCount: timelineFrames.length,
      replayKeyframeCount: replaySummary.container.keyframeCount,
      replayChunkCount: replaySummary.container.chunkCount,
      keyframeChunkFormulaHolds,
      chunkRecordFormulaHolds,
      apiFramesMatchReplayKeyframes,
      lastTimelineFrameTimestamp,
      lastTimelineIntervalMs,
      metadataLastChunkRecordId: replaySummary.lastGameChunkId,
      actualLastChunkId,
      tailShorterThan30s,
      tailParityMatchesHalfMinuteModel: lastChunkIdIsOdd === tailShorterThan30s,
    },
    duration: {
      replayGameLengthMillis: replaySummary.gameLengthMillis,
      matchGameDurationMillis: match.info.gameDuration * 1000,
      diffReplayMinusMatchMillis: replaySummary.gameLengthMillis - (match.info.gameDuration * 1000),
      lastTimelineFrameTimestamp,
      diffReplayMinusLastTimelineFrameMillis: replaySummary.gameLengthMillis - lastTimelineFrameTimestamp,
    },
    chunkWindows,
    correlations,
    topEventfulWindows,
  };
}

function summarizeCorpus(analyses) {
  const corpus = {
    replayCount: analyses.length,
    matchedPlayers: 0,
    totalPlayers: 0,
    exactFieldCounts: {
      champion: 0,
      team: 0,
      teamPosition: 0,
      riotId: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      goldEarned: 0,
      damage: 0,
      vision: 0,
      win: 0,
    },
    goldDeltaHistogram: {},
    framePlusOneMatches: 0,
    keyframeChunkFormulaMatches: 0,
    chunkRecordFormulaMatches: 0,
    tailParityMatches: 0,
    replayMinusMatchDiffs: [],
    replayMinusLastTimelineDiffs: [],
    chunkWindows: [],
  };

  for (const analysis of analyses) {
    corpus.matchedPlayers += analysis.playerBridge.matchedPlayers;
    corpus.totalPlayers += analysis.playerBridge.totalReplayPlayers;
    for (const [field, count] of Object.entries(analysis.playerBridge.exactFieldCounts)) {
      corpus.exactFieldCounts[field] += count;
    }
    for (const [delta, count] of Object.entries(analysis.playerBridge.goldDeltaHistogram)) {
      corpus.goldDeltaHistogram[delta] = (corpus.goldDeltaHistogram[delta] ?? 0) + count;
    }
    if (analysis.structural.apiFramesMatchReplayKeyframes) {
      corpus.framePlusOneMatches += 1;
    }
    if (analysis.structural.keyframeChunkFormulaHolds) {
      corpus.keyframeChunkFormulaMatches += 1;
    }
    if (analysis.structural.chunkRecordFormulaHolds) {
      corpus.chunkRecordFormulaMatches += 1;
    }
    if (analysis.structural.tailParityMatchesHalfMinuteModel) {
      corpus.tailParityMatches += 1;
    }
    corpus.replayMinusMatchDiffs.push(analysis.duration.diffReplayMinusMatchMillis);
    corpus.replayMinusLastTimelineDiffs.push(analysis.duration.diffReplayMinusLastTimelineFrameMillis);
    corpus.chunkWindows.push(...analysis.chunkWindows);
  }

  corpus.chunkCorrelations = {
    compressedVsEvents: pearson(corpus.chunkWindows.map((window) => window.compressedLength), corpus.chunkWindows.map((window) => window.counts.total)),
    compressedVsKills: pearson(corpus.chunkWindows.map((window) => window.compressedLength), corpus.chunkWindows.map((window) => window.counts.championKills)),
    compressedVsObjectives: pearson(
      corpus.chunkWindows.map((window) => window.compressedLength),
      corpus.chunkWindows.map((window) => window.counts.eliteMonsterKills + window.counts.buildingKills),
    ),
    uncompressedVsEvents: pearson(corpus.chunkWindows.map((window) => window.uncompressedLength), corpus.chunkWindows.map((window) => window.counts.total)),
    uncompressedVsKills: pearson(corpus.chunkWindows.map((window) => window.uncompressedLength), corpus.chunkWindows.map((window) => window.counts.championKills)),
  };

  return corpus;
}

function renderAnalysisText(analysis, options) {
  const lines = [];
  lines.push(`Replay: ${analysis.replayName}`);
  lines.push(`Match ID: ${analysis.matchId}`);
  lines.push("");
  lines.push("Metadata bridge:");
  lines.push(`  Participants matched: ${formatRatio(analysis.playerBridge.matchedPlayers, analysis.playerBridge.totalReplayPlayers)}`);
  lines.push(`  Exact champion/team/position/riotId: ${formatRatio(analysis.playerBridge.exactFieldCounts.champion, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.team, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.teamPosition, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.riotId, analysis.playerBridge.totalReplayPlayers)}`);
  lines.push(`  Exact K/D/A/damage/vision/win: ${formatRatio(analysis.playerBridge.exactFieldCounts.kills, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.deaths, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.assists, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.damage, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.vision, analysis.playerBridge.totalReplayPlayers)}, ${formatRatio(analysis.playerBridge.exactFieldCounts.win, analysis.playerBridge.totalReplayPlayers)}`);
  const goldDeltas = Object.entries(analysis.playerBridge.goldDeltaHistogram).map(([delta, count]) => `${delta}:${count}`).join(", ") || "none";
  lines.push(`  Exact goldEarned: ${formatRatio(analysis.playerBridge.exactFieldCounts.goldEarned, analysis.playerBridge.totalReplayPlayers)} | deltas=${goldDeltas}`);
  lines.push("");
  lines.push("Timeline structure:");
  lines.push(`  Replay gameLengthMillis: ${formatNumber(analysis.duration.replayGameLengthMillis)}`);
  lines.push(`  Match-V5 gameDuration ms: ${formatNumber(analysis.duration.matchGameDurationMillis)} | diff=${analysis.duration.diffReplayMinusMatchMillis}`);
  lines.push(`  Timeline last frame ts: ${formatNumber(analysis.duration.lastTimelineFrameTimestamp)} | replay-lastFrame diff=${analysis.duration.diffReplayMinusLastTimelineFrameMillis}`);
  lines.push(`  API frames vs replay keyframes: ${analysis.structural.apiFrameCount} vs ${analysis.structural.replayKeyframeCount} | frameCount == keyframes + 1 => ${analysis.structural.apiFramesMatchReplayKeyframes ? "yes" : "no"}`);
  lines.push(`  Replay chunks: ${analysis.structural.replayChunkCount} | startupEnd=${analysis.structural.startupChunkEndId} | gameStart=${analysis.structural.gameStartChunkId}`);
  lines.push(`  keyframe.chunkId == 2*id+1 => ${analysis.structural.keyframeChunkFormulaHolds ? "yes" : "no"}`);
  lines.push(`  chunk.chunkId == chunk.id+1 => ${analysis.structural.chunkRecordFormulaHolds ? "yes" : "no"}`);
  lines.push(`  Chunk id mapping: metadata lastGameChunkId=${analysis.structural.metadataLastChunkRecordId} | actual highest chunkId=${analysis.structural.actualLastChunkId}`);
  lines.push(`  Final API frame interval: ${analysis.structural.lastTimelineIntervalMs} ms | tail-parity half-minute model => ${analysis.structural.tailParityMatchesHalfMinuteModel ? "yes" : "no"}`);
  lines.push("");
  lines.push("30s chunk window correlations:");
  lines.push(`  compressed vs all events: ${formatFloat(analysis.correlations.compressedVsEvents)}`);
  lines.push(`  compressed vs champion kills: ${formatFloat(analysis.correlations.compressedVsKills)}`);
  lines.push(`  compressed vs objectives: ${formatFloat(analysis.correlations.compressedVsObjectives)}`);
  lines.push(`  uncompressed vs all events: ${formatFloat(analysis.correlations.uncompressedVsEvents)}`);
  lines.push(`  uncompressed vs champion kills: ${formatFloat(analysis.correlations.uncompressedVsKills)}`);
  lines.push("");
  lines.push(`Top ${Math.min(options.topWindows, analysis.topEventfulWindows.length)} eventful 30s chunk windows:`);
  for (const window of analysis.topEventfulWindows) {
    const objectives = window.counts.eliteMonsterKills + window.counts.buildingKills;
    const eventTypes = window.topEventTypes.map((entry) => `${entry.type}:${entry.count}`).join(", ");
    lines.push(`  chunkId=${window.chunkId} [${formatNumber(window.windowStartMs)}..${formatNumber(window.windowEndMs)} ms] interval=${window.apiIntervalIndex} boundary=${window.endsOnKeyframeBoundary ? "yes" : "no"} kills=${window.counts.championKills} objectives=${objectives} events=${window.counts.total} compressed=${formatNumber(window.compressedLength)} eventTypes=${eventTypes || "none"}`);
  }
  return lines.join("\n");
}

function renderCorpusText(corpus) {
  const goldDeltas = Object.entries(corpus.goldDeltaHistogram)
    .sort((left, right) => Number(left[0]) - Number(right[0]))
    .map(([delta, count]) => `${delta}:${count}`)
    .join(", ");
  return [
    "Corpus summary:",
    `  Replays analyzed: ${corpus.replayCount}`,
    `  Players matched against Match-V5: ${formatRatio(corpus.matchedPlayers, corpus.totalPlayers)}`,
    `  Exact fields: champion=${formatRatio(corpus.exactFieldCounts.champion, corpus.totalPlayers)}, team=${formatRatio(corpus.exactFieldCounts.team, corpus.totalPlayers)}, teamPosition=${formatRatio(corpus.exactFieldCounts.teamPosition, corpus.totalPlayers)}, riotId=${formatRatio(corpus.exactFieldCounts.riotId, corpus.totalPlayers)}, kills=${formatRatio(corpus.exactFieldCounts.kills, corpus.totalPlayers)}, deaths=${formatRatio(corpus.exactFieldCounts.deaths, corpus.totalPlayers)}, assists=${formatRatio(corpus.exactFieldCounts.assists, corpus.totalPlayers)}, damage=${formatRatio(corpus.exactFieldCounts.damage, corpus.totalPlayers)}, vision=${formatRatio(corpus.exactFieldCounts.vision, corpus.totalPlayers)}, win=${formatRatio(corpus.exactFieldCounts.win, corpus.totalPlayers)}, goldEarned=${formatRatio(corpus.exactFieldCounts.goldEarned, corpus.totalPlayers)}`,
    `  Gold delta histogram (replay - API): ${goldDeltas}`,
    `  frameCount == keyframes + 1: ${formatRatio(corpus.framePlusOneMatches, corpus.replayCount)}`,
    `  keyframe.chunkId == 2*id+1: ${formatRatio(corpus.keyframeChunkFormulaMatches, corpus.replayCount)}`,
    `  chunk.chunkId == chunk.id+1: ${formatRatio(corpus.chunkRecordFormulaMatches, corpus.replayCount)}`,
    `  Tail parity matches 30s model: ${formatRatio(corpus.tailParityMatches, corpus.replayCount)}`,
    `  Replay-minus-Match duration diff ms: min=${Math.min(...corpus.replayMinusMatchDiffs)}, max=${Math.max(...corpus.replayMinusMatchDiffs)}`,
    `  Replay-minus-lastTimelineFrame diff ms: min=${Math.min(...corpus.replayMinusLastTimelineDiffs)}, max=${Math.max(...corpus.replayMinusLastTimelineDiffs)}`,
    `  Aggregate chunk correlations: compressed/events=${formatFloat(corpus.chunkCorrelations.compressedVsEvents)}, compressed/kills=${formatFloat(corpus.chunkCorrelations.compressedVsKills)}, compressed/objectives=${formatFloat(corpus.chunkCorrelations.compressedVsObjectives)}, uncompressed/events=${formatFloat(corpus.chunkCorrelations.uncompressedVsEvents)}, uncompressed/kills=${formatFloat(corpus.chunkCorrelations.uncompressedVsKills)}`,
  ].join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const replaysDir = resolve("replays");
  const targets = options.analyzeAll
    ? [...new Set(readdirSync(replaysDir).filter((name) => name.endsWith(".rofl")).map((name) => resolve(replaysDir, name)))]
    : [...new Set(options.replayPaths)];

  const analyses = targets.map((replayPath) => analyzeReplay(replayPath, options));
  const corpus = summarizeCorpus(analyses);

  if (options.json) {
    console.log(JSON.stringify({ analyses, corpus }, null, 2));
    return;
  }

  for (let index = 0; index < analyses.length; index += 1) {
    if (index > 0) {
      console.log("\n---\n");
    }
    console.log(renderAnalysisText(analyses[index], options));
  }

  if (analyses.length > 1) {
    console.log("\n===\n");
    console.log(renderCorpusText(corpus));
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

