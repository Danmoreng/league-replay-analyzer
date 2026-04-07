#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  normalizeTeamPosition,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const inventoryEventTypes = new Set([
  "ITEM_PURCHASED",
  "ITEM_SOLD",
  "ITEM_DESTROYED",
  "ITEM_UNDO",
]);

function parseArgs(argv) {
  const args = {
    fixtureDir: null,
    replayId: null,
    apiRoot: "replays/api",
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.fixtureDir && !args.replayId) {
    throw new Error("Pass --fixture-dir <path> or --replay-id <PLATFORM-GAMEID>.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/extract_api_static_state.mjs --fixture-dir <path> [options]");
  console.log("       node ./scripts/extract_api_static_state.mjs --replay-id <PLATFORM-GAMEID> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --api-root <path>     API fixtures root (default: replays/api).");
  console.log("  --output-path <path>  Output path (default: <fixture>/api-static-state.json).");
}

function toFixtureFolderName(replayId) {
  return String(replayId).replace(/-/g, "_");
}

function chooseFixtureDir(repoRoot, args) {
  if (args.fixtureDir) {
    return resolveAbsolute(repoRoot, args.fixtureDir);
  }
  const apiRoot = resolveAbsolute(repoRoot, args.apiRoot);
  return path.join(apiRoot, toFixtureFolderName(args.replayId));
}

function createParticipantRecord(participant) {
  return {
    participantId: participant.participantId,
    puuid: participant.puuid ?? null,
    riotIdGameName: participant.riotIdGameName ?? null,
    riotIdTagline: participant.riotIdTagline ?? null,
    champion: participant.championName,
    teamId: participant.teamId,
    teamPosition: normalizeTeamPosition(participant.teamPosition ?? participant.individualPosition),
    timelines: {
      state: [],
    },
    itemEvents: [],
    inventoryTimeline: [],
  };
}

function readParticipantState(frameParticipant) {
  return {
    level: frameParticipant.level ?? null,
    currentGold: frameParticipant.currentGold ?? null,
    totalGold: frameParticipant.totalGold ?? null,
    xp: frameParticipant.xp ?? null,
    minionsKilled: frameParticipant.minionsKilled ?? null,
    jungleMinionsKilled: frameParticipant.jungleMinionsKilled ?? null,
    health: frameParticipant.championStats?.health ?? null,
    healthMax: frameParticipant.championStats?.healthMax ?? null,
    power: frameParticipant.championStats?.power ?? null,
    powerMax: frameParticipant.championStats?.powerMax ?? null,
    movementSpeed: frameParticipant.championStats?.movementSpeed ?? null,
    position: frameParticipant.position
      ? {
        x: frameParticipant.position.x,
        y: frameParticipant.position.y,
      }
      : null,
  };
}

function addItemToInventory(inventory, itemId) {
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return;
  }
  inventory.push(itemId);
}

function removeItemFromInventory(inventory, itemId) {
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return false;
  }
  const index = inventory.indexOf(itemId);
  if (index < 0) {
    return false;
  }
  inventory.splice(index, 1);
  return true;
}

function pushInventorySnapshot(participantRecord, timestamp, reason) {
  participantRecord.inventoryTimeline.push({
    timestamp,
    reason,
    items: [...participantRecord._inventory],
  });
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const fixtureDir = chooseFixtureDir(repoRoot, args);
  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    throw new Error(`Fixture bundle not found under ${fixtureDir}`);
  }

  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(fixtureDir, "api-static-state.json");

  const match = readJson(matchPath);
  const timeline = readJson(timelinePath);
  const replayId = `${match.metadata.matchId ?? args.replayId ?? path.basename(fixtureDir).replace(/_/g, "-")}`;
  const participants = match.info.participants ?? [];
  const participantById = new Map();
  for (const participant of participants) {
    const record = createParticipantRecord(participant);
    record._inventory = [];
    participantById.set(participant.participantId, record);
  }

  for (const frame of timeline.info.frames ?? []) {
    const timestamp = frame.timestamp ?? null;
    const frameParticipantMap = frame.participantFrames ?? {};
    for (const [rawParticipantId, frameParticipant] of Object.entries(frameParticipantMap)) {
      const participantId = Number.parseInt(rawParticipantId, 10);
      const participantRecord = participantById.get(participantId);
      if (!participantRecord) {
        continue;
      }

      participantRecord.timelines.state.push({
        timestamp,
        ...readParticipantState(frameParticipant),
      });
    }
  }

  for (const frame of timeline.info.frames ?? []) {
    for (const event of frame.events ?? []) {
      if (!inventoryEventTypes.has(event.type)) {
        continue;
      }

      const participantId = Number.parseInt(`${event.participantId ?? ""}`, 10);
      const participantRecord = participantById.get(participantId);
      if (!participantRecord) {
        continue;
      }

      const itemId = Number.isFinite(event.itemId) ? event.itemId : null;
      const beforeId = Number.isFinite(event.beforeId) ? event.beforeId : null;
      const afterId = Number.isFinite(event.afterId) ? event.afterId : null;
      const timestamp = event.timestamp ?? frame.timestamp ?? null;

      if (event.type === "ITEM_PURCHASED") {
        addItemToInventory(participantRecord._inventory, itemId);
      } else if (event.type === "ITEM_SOLD" || event.type === "ITEM_DESTROYED") {
        removeItemFromInventory(participantRecord._inventory, itemId);
      } else if (event.type === "ITEM_UNDO") {
        if (Number.isFinite(beforeId) && beforeId > 0) {
          removeItemFromInventory(participantRecord._inventory, beforeId);
        }
        if (Number.isFinite(afterId) && afterId > 0) {
          addItemToInventory(participantRecord._inventory, afterId);
        }
      }

      participantRecord.itemEvents.push({
        timestamp,
        type: event.type,
        itemId,
        beforeId,
        afterId,
        goldGain: Number.isFinite(event.goldGain) ? event.goldGain : null,
      });
      pushInventorySnapshot(participantRecord, timestamp, event.type);
    }
  }

  const outputParticipants = [...participantById.values()].map((participant) => {
    const finalInventory = [...participant._inventory];
    const itemEventSummary = participant.itemEvents.reduce((summary, event) => {
      summary[event.type] = (summary[event.type] ?? 0) + 1;
      return summary;
    }, {});

    return {
      participantId: participant.participantId,
      puuid: participant.puuid,
      riotIdGameName: participant.riotIdGameName,
      riotIdTagline: participant.riotIdTagline,
      champion: participant.champion,
      teamId: participant.teamId,
      teamPosition: participant.teamPosition,
      timelines: participant.timelines,
      itemEvents: participant.itemEvents,
      inventoryTimeline: participant.inventoryTimeline,
      finalInventory,
      itemEventSummary,
    };
  });

  const output = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    fixtureDir,
    source: {
      matchPath,
      timelinePath,
    },
    summary: {
      participantCount: outputParticipants.length,
      frameCount: timeline.info.frames?.length ?? 0,
      totalItemEvents: outputParticipants.reduce((sum, participant) => sum + participant.itemEvents.length, 0),
    },
    participants: outputParticipants,
  };

  writeJson(outputPath, output);
  console.log(`Wrote API static state to ${outputPath}`);
  console.log(`Participants: ${output.summary.participantCount}, frames: ${output.summary.frameCount}, item events: ${output.summary.totalItemEvents}`);
}

main();
