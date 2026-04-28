import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import { buildSummaryRoster, readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    replayRoot: "replays",
    apiRoot: "replays/api",
    analyzerExe: "build/packages/rofl-core/rofl_core_cli.exe",
    outputPath: null,
    length: null,
    firstByte: null,
    minReplayCount: 2,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--replay-root" && index + 1 < argv.length) args.replayRoot = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--analyzer-exe" && index + 1 < argv.length) args.analyzerExe = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--length" && index + 1 < argv.length) args.length = Number.parseInt(argv[++index], 10);
    else if (arg === "--first-byte" && index + 1 < argv.length) args.firstByte = Number.parseInt(argv[++index], 0);
    else if (arg === "--min-replay-count" && index + 1 < argv.length) args.minReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/scan_startup_roster_tokens.mjs [--artifact-root <path>] [--replay-root <path>] [--api-root <path>] [--analyzer-exe <path>]");
}

function safeInt(value) {
  const parsed = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function low32DecimalString(value) {
  const text = `${value ?? ""}`.trim();
  if (!/^\d+$/.test(text)) return null;
  return Number(BigInt(text) & 0xffffffffn);
}

function readApiParticipants(apiRoot, replayId) {
  const fixtureId = replayId.replaceAll("-", "_");
  const matchPath = path.join(apiRoot, fixtureId, "match.json");
  if (!fs.existsSync(matchPath)) return new Map();
  const match = readJson(matchPath);
  return new Map((match.info?.participants ?? []).map((participant) => [participant.participantId, participant]));
}

function tokenSpecs(summary, apiParticipants) {
  return buildSummaryRoster(summary).flatMap((entry) => {
    const participantId = entry.rosterIndex + 1;
    const apiParticipant = apiParticipants.get(participantId);
    const statMap = entry.statMap ?? {};
    return [
      { participantId, champion: entry.champion, kind: "participantId", value: participantId },
      { participantId, champion: entry.champion, kind: "rosterIndex", value: entry.rosterIndex },
      { participantId, champion: entry.champion, kind: "rosterOrdinal", value: entry.rosterIndex + 1 },
      { participantId, champion: entry.champion, kind: "teamId", value: safeInt(entry.team) },
      { participantId, champion: entry.champion, kind: "championId", value: safeInt(apiParticipant?.championId) },
      { participantId, champion: entry.champion, kind: "summonerIdLow32", value: low32DecimalString(statMap.SUMMONER_ID ?? statMap.ID) },
      { participantId, champion: entry.champion, kind: "spell1Id", value: safeInt(apiParticipant?.summoner1Id ?? statMap.SUMMONER_SPELL_1) },
      { participantId, champion: entry.champion, kind: "spell2Id", value: safeInt(apiParticipant?.summoner2Id ?? statMap.SUMMONER_SPELL_2) },
      { participantId, champion: entry.champion, kind: "championNameAscii", value: entry.champion, text: true },
      { participantId, champion: entry.champion, kind: "riotNameAscii", value: statMap.RIOT_ID_GAME_NAME, text: true },
      { participantId, champion: entry.champion, kind: "puuidAscii", value: statMap.PUUID, text: true },
    ].filter((token) => token.value != null && `${token.value}` !== "");
  });
}

function findNumberOffsets(buffer, value, width) {
  const offsets = [];
  if (value == null || !Number.isFinite(Number(value))) return offsets;
  const numeric = BigInt(value);
  const maxValue = (1n << BigInt(width * 8)) - 1n;
  if (numeric < 0n || numeric > maxValue) return offsets;
  const needle = Buffer.alloc(width);
  for (let index = 0; index < width; index += 1) {
    needle[index] = Number((numeric >> BigInt(index * 8)) & 0xffn);
  }
  for (let offset = 0; offset <= buffer.length - width; offset += 1) {
    let matches = true;
    for (let index = 0; index < width; index += 1) {
      if (buffer[offset + index] !== needle[index]) {
        matches = false;
        break;
      }
    }
    if (matches) offsets.push(offset);
  }
  return offsets;
}

function findAsciiOffsets(buffer, value) {
  const text = `${value ?? ""}`;
  if (text.length < 3) return [];
  const needle = Buffer.from(text, "utf8");
  const offsets = [];
  let cursor = buffer.indexOf(needle);
  while (cursor >= 0) {
    offsets.push(cursor);
    cursor = buffer.indexOf(needle, cursor + 1);
  }
  return offsets;
}

function addHit(buckets, keyParts, hit) {
  const key = keyParts.join("|");
  const bucket = buckets.get(key) ?? {
    versionGroup: hit.versionGroup,
    kind: hit.kind,
    width: hit.width,
    offset: hit.offset,
    participantOrdinalDelta: hit.offset - hit.participantId,
    hitCount: 0,
    replays: new Set(),
    examples: [],
  };
  bucket.hitCount += 1;
  bucket.replays.add(hit.replayId);
  if (bucket.examples.length < 8) bucket.examples.push(hit);
  buckets.set(key, bucket);
}

function dumpStartupRecord(analyzerExe, replayPath, length, firstByte) {
  const raw = execFileSync(analyzerExe, [
    "--dump-subrecord-family-json",
    replayPath,
    "--length", String(length),
    "--first-byte", `0x${firstByte.toString(16)}`,
    "--record-type", "startup",
    "--max-records", "1",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  const hex = parsed.records?.[0]?.hex;
  return hex ? Buffer.from(hex, "hex") : null;
}

function findStartupFamily(analyzerExe, replayPath, forcedLength, forcedFirstByte) {
  if (forcedLength != null && forcedFirstByte != null) {
    return { length: forcedLength, firstByte: forcedFirstByte };
  }
  const raw = execFileSync(analyzerExe, [
    "--scan-families-json",
    replayPath,
    "--min-length", "1",
    "--min-records", "1",
    "--top-families", "8",
    "--record-type", "startup",
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  const family = (parsed.families ?? [])
    .filter((entry) => entry.length > 16)
    .sort((left, right) => right.length - left.length)[0];
  return family ? { length: family.length, firstByte: family.firstByte } : null;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const replayRoot = resolveAbsolute(repoRoot, args.replayRoot);
  const apiRoot = resolveAbsolute(repoRoot, args.apiRoot);
  const analyzerExe = resolveAbsolute(repoRoot, args.analyzerExe);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "startup-roster-token-scan.json");
  const schemaPath = path.join(artifactRoot, "keyframe-parity-schema.json");
  const schema = readJson(schemaPath);
  const buckets = new Map();
  const replaySummaries = [];

  for (const replay of schema.replaySummaries ?? []) {
    const replayPath = path.join(replayRoot, `${replay.replayId}.rofl`);
    const summaryPath = path.join(artifactRoot, replay.replayId, "summary.json");
    if (!fs.existsSync(replayPath) || !fs.existsSync(summaryPath)) continue;
    const startupFamily = findStartupFamily(analyzerExe, replayPath, args.length, args.firstByte);
    if (!startupFamily) {
      replaySummaries.push({ replayId: replay.replayId, versionGroup: replay.versionGroup, foundStartupRecord: false });
      continue;
    }
    const buffer = dumpStartupRecord(analyzerExe, replayPath, startupFamily.length, startupFamily.firstByte);
    if (!buffer) {
      replaySummaries.push({ replayId: replay.replayId, versionGroup: replay.versionGroup, foundStartupRecord: false, startupFamily });
      continue;
    }
    const summary = readJson(summaryPath);
    const specs = tokenSpecs(summary, readApiParticipants(apiRoot, replay.replayId));
    let hitCount = 0;
    for (const spec of specs) {
      if (spec.text) {
        for (const offset of findAsciiOffsets(buffer, spec.value)) {
          hitCount += 1;
          addHit(buckets, [replay.versionGroup, spec.kind, "ascii", offset], {
            replayId: replay.replayId, versionGroup: replay.versionGroup, participantId: spec.participantId,
            champion: spec.champion, kind: spec.kind, width: "ascii", offset, value: spec.value,
          });
        }
      } else {
        for (const width of [1, 2, 4, 8]) {
          for (const offset of findNumberOffsets(buffer, spec.value, width)) {
            hitCount += 1;
            addHit(buckets, [replay.versionGroup, spec.kind, width, offset], {
              replayId: replay.replayId, versionGroup: replay.versionGroup, participantId: spec.participantId,
              champion: spec.champion, kind: spec.kind, width, offset, value: spec.value,
            });
          }
        }
      }
    }
    replaySummaries.push({ replayId: replay.replayId, versionGroup: replay.versionGroup, foundStartupRecord: true, startupFamily, hitCount });
  }

  const candidates = [...buckets.values()]
    .map((bucket) => ({ ...bucket, replays: [...bucket.replays].sort(), replayCount: bucket.replays.size }))
    .filter((bucket) => bucket.replayCount >= args.minReplayCount)
    .sort((left, right) => right.replayCount - left.replayCount || right.hitCount - left.hitCount || left.offset - right.offset);
  writeJson(outputPath, {
    generatedAtUtc: new Date().toISOString(),
    forcedLength: args.length,
    forcedFirstByte: args.firstByte,
    replayCount: replaySummaries.length,
    candidateCount: candidates.length,
    replaySummaries,
    candidates,
  });
  console.log(`Wrote startup roster token scan to ${outputPath}`);
  console.log(`replays scanned: ${replaySummaries.length}`);
  console.log(`candidates: ${candidates.length}`);
}

main();
