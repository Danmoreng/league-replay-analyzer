#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    replay: "",
    event: "CHAMPION_KILL",
    quietChunk: null,
    cliPath: null,
    top: 15,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--replay" && index + 1 < args.length) {
      params.replay = args[++index];
      continue;
    }
    if (arg === "--event" && index + 1 < args.length) {
      params.event = args[++index];
      continue;
    }
    if (arg === "--quiet" && index + 1 < args.length) {
      params.quietChunk = Number.parseInt(args[++index], 10);
      continue;
    }
    if (arg === "--cli" && index + 1 < args.length) {
      params.cliPath = resolve(args[++index]);
      continue;
    }
    if (arg === "--top" && index + 1 < args.length) {
      params.top = Number.parseInt(args[++index], 10);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!params.replay) {
    throw new Error("Usage: node ./scripts/payload-pattern-hunter.mjs --replay <path-to-rofl> [--event CHAMPION_KILL] [--quiet <chunk-id>] [--cli <path>] [--top <n>]");
  }
  if (!Number.isFinite(params.top) || params.top <= 0) {
    throw new Error("--top must be a positive integer");
  }

  return params;
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

function deriveMatchId(replayPath) {
  const replayName = basename(replayPath);
  const match = replayName.match(/^([A-Za-z0-9]+)-(\d+)\.rofl$/);
  if (!match) {
    throw new Error(`Could not derive Match ID from ${replayName}`);
  }
  return `${match[1].toUpperCase()}_${match[2]}`;
}

function loadTimeline(matchId) {
  const timelinePath = resolve("replays", "api", matchId, "timeline.json");
  if (!existsSync(timelinePath)) {
    throw new Error(`Riot timeline not found at ${timelinePath}`);
  }
  return JSON.parse(readFileSync(timelinePath, "utf8"));
}

function loadSummary(cliPath, replayPath) {
  return JSON.parse(runCli(cliPath, ["--summary", replayPath]));
}

function dumpChunk(cliPath, replayPath, chunkId) {
  return runCli(cliPath, ["--dump-chunk-subrecords", replayPath, "--chunk-id", String(chunkId)]);
}

function parseSubrecords(dumpText) {
  const records = [];
  const regex = /Subrecord #(\d+) \(offset=(\d+), length=(\d+)\)\r?\n  Hex: ([0-9A-F ]+)\r?\n  Ascii: "([^"]*)"/g;
  for (const match of dumpText.matchAll(regex)) {
    const hex = match[4].trim();
    const firstByte = hex.split(" ", 1)[0];
    records.push({
      index: Number.parseInt(match[1], 10),
      offset: Number.parseInt(match[2], 10),
      length: Number.parseInt(match[3], 10),
      firstByte,
      familyKey: `${firstByte}:${match[3]}`,
      hexPreview: hex,
    });
  }
  return records;
}

function collectChunkFamilies(cliPath, replayPath, chunkIds) {
  const result = new Map();
  for (const chunkId of chunkIds) {
    const dump = dumpChunk(cliPath, replayPath, chunkId);
    const records = parseSubrecords(dump);
    result.set(chunkId, records);
  }
  return result;
}

function findQuietChunk(summary, eventChunkSet, explicitQuietChunk) {
  if (explicitQuietChunk != null) {
    return explicitQuietChunk;
  }

  const chunkIds = (summary.container.segments ?? [])
    .filter((segment) => segment.type === "chunk")
    .map((segment) => segment.chunkId)
    .sort((left, right) => left - right);

  const quietChunk = chunkIds.find((chunkId) => !eventChunkSet.has(chunkId));
  if (quietChunk == null) {
    throw new Error("Could not find a quiet chunk with zero target events. Pass --quiet explicitly.");
  }
  return quietChunk;
}

function eventChunksFromTimeline(summary, timeline, eventType) {
  const firstRegularChunkId = (summary.container.segments ?? [])
    .filter((segment) => segment.type === "chunk")
    .map((segment) => segment.chunkId)
    .sort((left, right) => left - right)[0];

  if (firstRegularChunkId == null) {
    throw new Error("Replay summary does not expose any chunk segments.");
  }

  const events = [];
  for (const frame of timeline.info.frames ?? []) {
    for (const event of frame.events ?? []) {
      if (event.type !== eventType) {
        continue;
      }
      const chunkId = firstRegularChunkId + Math.floor(event.timestamp / 30000);
      events.push({ ...event, chunkId });
    }
  }
  return { firstRegularChunkId, events };
}

function tallyFamilies(records) {
  const counts = new Map();
  for (const record of records) {
    counts.set(record.familyKey, (counts.get(record.familyKey) ?? 0) + 1);
  }
  return counts;
}

function describeFamily(familyKey) {
  const [firstByte, length] = familyKey.split(":");
  return `0x${firstByte}/${length}`;
}

function main() {
  const params = parseArgs();
  const replayPath = resolve(params.replay);
  const cliPath = resolveCliPath(params.cliPath);
  const matchId = deriveMatchId(replayPath);
  const timeline = loadTimeline(matchId);
  const summary = loadSummary(cliPath, replayPath);
  const { firstRegularChunkId, events } = eventChunksFromTimeline(summary, timeline, params.event);
  const eventChunkIds = [...new Set(events.map((event) => event.chunkId))].sort((left, right) => left - right);
  const eventChunkSet = new Set(eventChunkIds);
  const quietChunkId = findQuietChunk(summary, eventChunkSet, params.quietChunk);
  const allNeededChunkIds = [...new Set([quietChunkId, ...eventChunkIds])].sort((left, right) => left - right);
  const chunkFamilies = collectChunkFamilies(cliPath, replayPath, allNeededChunkIds);
  const quietCounts = tallyFamilies(chunkFamilies.get(quietChunkId) ?? []);

  const familyStats = new Map();
  for (const chunkId of eventChunkIds) {
    const records = chunkFamilies.get(chunkId) ?? [];
    const chunkCounts = tallyFamilies(records);
    const chunkEventCount = events.filter((event) => event.chunkId === chunkId).length;
    for (const [familyKey, count] of chunkCounts.entries()) {
      if (!familyStats.has(familyKey)) {
        familyStats.set(familyKey, {
          familyKey,
          eventfulChunks: new Set(),
          totalCount: 0,
          maxCountInChunk: 0,
          matchingEventCountChunks: 0,
          quietCount: quietCounts.get(familyKey) ?? 0,
        });
      }
      const stat = familyStats.get(familyKey);
      stat.eventfulChunks.add(chunkId);
      stat.totalCount += count;
      stat.maxCountInChunk = Math.max(stat.maxCountInChunk, count);
      if (count === chunkEventCount) {
        stat.matchingEventCountChunks += 1;
      }
    }
  }

  const ubiquitousFamilies = [];
  const eventBiasedFamilies = [];
  for (const stat of familyStats.values()) {
    const presentInAllEventful = stat.eventfulChunks.size === eventChunkIds.length;
    const absentInQuiet = stat.quietCount === 0;
    const quietComparable = stat.quietCount > 0;
    if (presentInAllEventful && quietComparable) {
      ubiquitousFamilies.push(stat);
    }
    if (presentInAllEventful && absentInQuiet) {
      eventBiasedFamilies.push(stat);
    }
  }

  eventBiasedFamilies.sort((left, right) =>
    right.eventfulChunks.size - left.eventfulChunks.size ||
    right.totalCount - left.totalCount ||
    left.familyKey.localeCompare(right.familyKey),
  );
  ubiquitousFamilies.sort((left, right) =>
    right.totalCount - left.totalCount ||
    left.familyKey.localeCompare(right.familyKey),
  );

  console.log(`Replay: ${basename(replayPath)}`);
  console.log(`CLI: ${cliPath}`);
  console.log(`Event type: ${params.event}`);
  console.log(`First regular chunkId: ${firstRegularChunkId}`);
  console.log(`Target events: ${events.length}`);
  console.log(`Eventful chunks: ${eventChunkIds.join(", ") || "(none)"}`);
  console.log(`Quiet chunk: ${quietChunkId}`);
  console.log("");
  console.log(`Quiet chunk family count: ${(chunkFamilies.get(quietChunkId) ?? []).length} records, ${quietCounts.size} unique families`);
  console.log("");

  if (eventBiasedFamilies.length === 0) {
    console.log("Event-biased families present in every eventful chunk and absent from the quiet chunk: none");
  } else {
    console.log("Event-biased families present in every eventful chunk and absent from the quiet chunk:");
    for (const stat of eventBiasedFamilies.slice(0, params.top)) {
      console.log(`  ${describeFamily(stat.familyKey)} | totalInEventfulChunks=${stat.totalCount} | maxPerChunk=${stat.maxCountInChunk} | eventCountMatches=${stat.matchingEventCountChunks}/${eventChunkIds.length}`);
    }
  }

  console.log("");
  console.log("Ubiquitous families present in every eventful chunk and also present in the quiet chunk:");
  for (const stat of ubiquitousFamilies.slice(0, params.top)) {
    console.log(`  ${describeFamily(stat.familyKey)} | totalInEventfulChunks=${stat.totalCount} | quietChunkCount=${stat.quietCount} | maxPerChunk=${stat.maxCountInChunk}`);
  }

  console.log("");
  console.log("Per-eventful-chunk unique families vs quiet baseline:");
  for (const chunkId of eventChunkIds) {
    const chunkCounts = tallyFamilies(chunkFamilies.get(chunkId) ?? []);
    const uniqueFamilies = [...chunkCounts.keys()].filter((familyKey) => !quietCounts.has(familyKey));
    const eventCount = events.filter((event) => event.chunkId === chunkId).length;
    console.log(`  Chunk ${chunkId}: events=${eventCount}, uniqueFamilies=${uniqueFamilies.length}, totalFamilies=${chunkCounts.size}`);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
