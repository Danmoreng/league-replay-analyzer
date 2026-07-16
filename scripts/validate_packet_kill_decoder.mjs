import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PATCH_PROFILES = Object.freeze({
  "15.22": Object.freeze({
    ownerSequencePacketType: 0x0015,
    deathMarkerPacketType: 0x01d4,
    championNetworkIdBase: 0x40000099,
    evidenceReplayCount: 2,
  }),
  "15.23": Object.freeze({
    ownerSequencePacketType: 0x0105,
    deathMarkerPacketType: 0x0343,
    championNetworkIdBase: 0x400004cc,
    evidenceReplayCount: 1,
  }),
  "15.24": Object.freeze({
    ownerSequencePacketType: 0x01d8,
    deathMarkerPacketType: 0x020e,
    championNetworkIdBase: 0x40000147,
    evidenceReplayCount: 1,
  }),
  "16.1": Object.freeze({
    ownerSequencePacketType: 0x02d6,
    deathMarkerPacketType: 0x0093,
    championNetworkIdBase: 0x400000ad,
    evidenceReplayCount: 2,
  }),
  "16.5": Object.freeze({
    ownerSequencePacketType: 0x021a,
    deathMarkerPacketType: 0x03ef,
    championNetworkIdBase: 0x400000ad,
    evidenceReplayCount: 1,
  }),
  "16.6": Object.freeze({
    ownerSequencePacketType: 0x02ec,
    deathMarkerPacketType: 0x001a,
    championNetworkIdBase: 0x400000ad,
    evidenceReplayCount: 11,
  }),
  "16.7": Object.freeze({
    ownerSequencePacketType: 0x0052,
    deathMarkerPacketType: 0x0452,
    championNetworkIdBase: 0x400000ad,
    evidenceReplayCount: 9,
  }),
  "16.9": Object.freeze({
    ownerSequencePacketType: 0x0073,
    deathMarkerPacketType: 0x02cb,
    championNetworkIdBase: 0x400000ad,
    evidenceReplayCount: 20,
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: null,
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    replayId: null,
    versionGroup: null,
    outputPath: path.join("artifacts", "packet-kill-decoder-validation.json"),
    maxBlocks: 100_000,
    timestampToleranceMillis: 1,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--max-blocks" && index + 1 < argv.length) args.maxBlocks = Number.parseInt(argv[++index], 10);
    else if (arg === "--timestamp-tolerance-ms" && index + 1 < argv.length) {
      args.timestampToleranceMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/validate_packet_kill_decoder.mjs [options]",
        "",
        "Options:",
        "  --cli <path>                    rofl_core_cli executable.",
        "  --replay-dir <path>             Replay directory (default: replays).",
        "  --api-root <path>               Offline Riot fixtures (default: replays/api).",
        "  --replay-id <platform-game>     Validate one replay, for example EUW1-7843571343.",
        "  --version-group <major.minor>   Validate one supported patch group.",
        "  --output-path <path>            JSON report path.",
        "  --max-blocks <n>                Per-packet-type dump limit (default: 100000).",
        "  --timestamp-tolerance-ms <n>    Offline comparison tolerance (default: 1).",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.maxBlocks) || args.maxBlocks <= 0) {
    throw new Error("--max-blocks must be a positive integer.");
  }
  if (!Number.isInteger(args.timestampToleranceMillis) || args.timestampToleranceMillis < 0) {
    throw new Error("--timestamp-tolerance-ms must be a non-negative integer.");
  }
  if (args.versionGroup && !PATCH_PROFILES[args.versionGroup]) {
    throw new Error(`Unsupported --version-group ${args.versionGroup}.`);
  }

  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeReplayId(value) {
  return String(value).replace("_", "-");
}

function fixtureIdForReplay(replayId) {
  return replayId.replace("-", "_");
}

function versionGroupFromGameVersion(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function packetTypeHex(value) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
}

function parseNumeric(value, fieldName) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`Packet dump block is missing numeric ${fieldName}.`);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function resolveCliPath(explicitPath) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [
        path.resolve("build", "packages", "rofl-core", "rofl_core_cli.exe"),
        path.resolve("build", "packages", "rofl-core", "Release", "rofl_core_cli.exe"),
        path.resolve("build", "packages", "rofl-core", "Debug", "rofl_core_cli.exe"),
      ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`rofl_core_cli executable not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace < firstBrace) {
      throw new Error(`CLI did not emit a JSON object: ${trimmed.slice(0, 500)}`);
    }
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
}

function extractRawBlocks(payload) {
  const candidates = [
    payload.blocks,
    payload.packetBlocks,
    payload.results,
    payload.dump?.blocks,
    payload.packetTypeDump?.blocks,
  ];
  const blocks = candidates.find(Array.isArray);
  if (!blocks) {
    throw new Error("Packet dump JSON does not contain a recognized blocks array.");
  }
  return blocks;
}

function normalizeBlock(raw, expectedPacketType) {
  const provenance = raw.provenance ?? {};
  const timestampMillis = firstDefined(
    raw.timestampMillis,
    raw.timestamp_millis,
    raw.timeMillis,
    raw.time_millis,
  );
  const timestampSeconds = firstDefined(
    raw.timestampSeconds,
    raw.timestamp_seconds,
    raw.timestamp,
  );
  const resolvedTimestampMillis = timestampMillis === undefined
    ? Math.round(parseNumeric(timestampSeconds, "timestampSeconds") * 1000)
    : Math.round(parseNumeric(timestampMillis, "timestampMillis"));

  const packetType = parseNumeric(
    firstDefined(raw.packetType, raw.packet_type, raw.type, expectedPacketType),
    "packetType",
  );
  const blockParam = parseNumeric(
    firstDefined(raw.blockParam, raw.block_param, raw.param),
    "blockParam",
  );
  const segmentId = parseNumeric(
    firstDefined(
      raw.segmentId,
      raw.segment_id,
      raw.recordId,
      raw.record_id,
      provenance.segmentId,
      provenance.segment_id,
      0,
    ),
    "segmentId",
  );
  const chunkId = parseNumeric(
    firstDefined(
      raw.chunkId,
      raw.chunk_id,
      raw.relatedChunkId,
      raw.related_chunk_id,
      provenance.chunkId,
      provenance.chunk_id,
      segmentId,
    ),
    "chunkId",
  );
  const headerOffset = parseNumeric(
    firstDefined(raw.headerOffset, raw.header_offset, raw.sourceOffset, raw.source_offset, 0),
    "headerOffset",
  );
  const segmentHeaderOffset = parseNumeric(
    firstDefined(
      raw.segmentHeaderOffset,
      raw.segment_header_offset,
      provenance.segmentHeaderOffset,
      provenance.segment_header_offset,
      0,
    ),
    "segmentHeaderOffset",
  );
  const blockIndex = parseNumeric(
    firstDefined(raw.blockIndex, raw.block_index, 0),
    "blockIndex",
  );

  return {
    packetType,
    timestampMillis: resolvedTimestampMillis,
    blockParam,
    segmentId,
    chunkId,
    segmentHeaderOffset,
    headerOffset,
    blockIndex,
    contentLength: firstDefined(raw.contentLength, raw.content_length, null),
    contentHex: firstDefined(raw.contentHex, raw.content_hex, raw.contentHexPreview, null),
  };
}

function compareSourceOrder(left, right) {
  return left.segmentHeaderOffset - right.segmentHeaderOffset ||
    left.chunkId - right.chunkId ||
    left.segmentId - right.segmentId ||
    left.headerOffset - right.headerOffset ||
    left.blockIndex - right.blockIndex ||
    left.packetType - right.packetType;
}

function runPacketDump(cliPath, replayPath, packetType, maxBlocks) {
  const stdout = execFileSync(
    cliPath,
    [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      packetTypeHex(packetType),
      "--segment-type",
      "chunk",
      "--max-blocks",
      String(maxBlocks),
    ],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const payload = parseJsonOutput(stdout);
  return extractRawBlocks(payload).map((block) => normalizeBlock(block, packetType));
}

function collectApiKillEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "CHAMPION_KILL")
    .map((event, index) => ({
      index,
      timestampMillis: event.timestamp,
      victimId: event.victimId,
      killerId: event.killerId ?? 0,
      assistingParticipantIds: [...(event.assistingParticipantIds ?? [])],
    }));
}

function ownerToParticipantId(ownerNetworkId, championNetworkIdBase) {
  const participantId = ownerNetworkId - championNetworkIdBase;
  return Number.isInteger(participantId) && participantId >= 1 && participantId <= 10
    ? participantId
    : null;
}

function decodeKillEvents(blocks, profile, timestampToleranceMillis) {
  const sorted = [...blocks].sort(compareSourceOrder);
  const decodedEvents = [];
  const errors = [];
  let pendingOwnerBlocks = [];
  let ignoredMarkerCount = 0;

  for (const block of sorted) {
    if (block.packetType === profile.ownerSequencePacketType) {

      pendingOwnerBlocks.push(block);
      continue;
    }
    if (block.packetType !== profile.deathMarkerPacketType) continue;

    const matchingOwnerBlocks = pendingOwnerBlocks.filter(
      (ownerBlock) =>
        Math.abs(ownerBlock.timestampMillis - block.timestampMillis) <= timestampToleranceMillis,
    );
    const participantIds = matchingOwnerBlocks.map((ownerBlock) =>
      ownerToParticipantId(ownerBlock.blockParam, profile.championNetworkIdBase)
    );
    const markerVictimId = ownerToParticipantId(
      block.blockParam,
      profile.championNetworkIdBase,
    );

    if (participantIds.length === 0) {
      ignoredMarkerCount += 1;
      pendingOwnerBlocks = [];
      continue;
    }
    if (participantIds.some((value) => value === null)) {
      errors.push({
        code: "invalid-owner-sequence",
        markerTimestampMillis: block.timestampMillis,
        markerBlockParam: block.blockParam,
        ownerBlockParams: matchingOwnerBlocks.map((ownerBlock) => ownerBlock.blockParam),
      });
      pendingOwnerBlocks = [];
      continue;
    }
    if (markerVictimId === null || participantIds[0] !== markerVictimId) {
      errors.push({
        code: "marker-victim-mismatch",
        markerTimestampMillis: block.timestampMillis,
        markerVictimId,
        firstOwnerParticipantId: participantIds[0],
      });
    }

    const isExecution = participantIds.length === 1;
    decodedEvents.push({
      timestampMillis: block.timestampMillis,
      victimId: participantIds[0],
      killerId: isExecution ? 0 : participantIds.at(-1),
      assistingParticipantIds: isExecution ? [] : participantIds.slice(1, -1),
      victimNetworkId: block.blockParam,
      ownerNetworkIds: matchingOwnerBlocks.map((ownerBlock) => ownerBlock.blockParam),
      source: {
        chunkId: block.chunkId,
        segmentId: block.segmentId,
        segmentHeaderOffset: block.segmentHeaderOffset,
        headerOffset: block.headerOffset,
      },
    });
    pendingOwnerBlocks = [];
  }

  return { decodedEvents, errors, ignoredMarkerCount };
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareDecodedToApi(decodedEvents, apiEvents, timestampToleranceMillis) {
  const usedApiIndexes = new Set();
  const matches = [];
  const mismatches = [];

  for (const decoded of decodedEvents) {
    const matchIndex = apiEvents.findIndex((api, index) =>
      !usedApiIndexes.has(index) &&
      Math.abs(api.timestampMillis - decoded.timestampMillis) <= timestampToleranceMillis &&
      api.victimId === decoded.victimId &&
      api.killerId === decoded.killerId &&
      arraysEqual(api.assistingParticipantIds, decoded.assistingParticipantIds)
    );
    if (matchIndex >= 0) {
      usedApiIndexes.add(matchIndex);
      const api = apiEvents[matchIndex];
      matches.push({
        decodedIndex: matches.length + mismatches.length,
        apiIndex: matchIndex,
        timestampDeltaMillis: decoded.timestampMillis - api.timestampMillis,
      });
    } else {
      mismatches.push(decoded);
    }
  }

  const missingApiEvents = apiEvents.filter((_, index) => !usedApiIndexes.has(index));
  return {
    exactMatchCount: matches.length,
    decodedMismatchCount: mismatches.length,
    missingApiEventCount: missingApiEvents.length,
    maximumAbsoluteTimestampDeltaMillis: matches.length === 0
      ? null
      : Math.max(...matches.map((match) => Math.abs(match.timestampDeltaMillis))),
    mismatches,
    missingApiEvents,
  };
}

function discoverFixtureRows(apiRoot, replayDir, replayId, versionGroup) {
  if (!fs.existsSync(apiRoot)) {
    throw new Error(`Offline API fixture root does not exist: ${apiRoot}`);
  }
  const requestedReplayId = replayId ? normalizeReplayId(replayId) : null;
  const rows = [];

  for (const entry of fs.readdirSync(apiRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const matchPath = path.join(apiRoot, entry.name, "match.json");
    const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
    if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) continue;

    const match = readJson(matchPath);
    const normalizedReplayId = normalizeReplayId(match.metadata?.matchId ?? entry.name);
    if (requestedReplayId && normalizedReplayId !== requestedReplayId) continue;
    const fixtureVersionGroup = versionGroupFromGameVersion(match.info?.gameVersion);
    if (versionGroup && fixtureVersionGroup !== versionGroup) continue;
    if (!PATCH_PROFILES[fixtureVersionGroup]) continue;

    const replayPath = path.resolve(replayDir, `${normalizedReplayId}.rofl`);
    if (!fs.existsSync(replayPath)) continue;
    rows.push({
      replayId: normalizedReplayId,
      fixtureId: fixtureIdForReplay(normalizedReplayId),
      versionGroup: fixtureVersionGroup,
      gameVersion: match.info.gameVersion,
      replayPath,
      matchPath: path.resolve(matchPath),
      timelinePath: path.resolve(timelinePath),
    });
  }

  rows.sort((left, right) =>
    left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true }) ||
    left.replayId.localeCompare(right.replayId)
  );
  if (rows.length === 0) {
    throw new Error("No supported replay/API fixture pairs matched the requested filters.");
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = resolveCliPath(args.cliPath);
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  const outputPath = path.resolve(args.outputPath);
  const fixtures = discoverFixtureRows(
    apiRoot,
    replayDir,
    args.replayId,
    args.versionGroup,
  );
  const rows = [];

  for (const fixture of fixtures) {
    const profile = PATCH_PROFILES[fixture.versionGroup];
    console.log(
      `Validating ${fixture.replayId} (${fixture.versionGroup}, ` +
      `${packetTypeHex(profile.ownerSequencePacketType)} + ` +
      `${packetTypeHex(profile.deathMarkerPacketType)})`,
    );
    const sequenceBlocks = runPacketDump(
      cliPath,
      fixture.replayPath,
      profile.ownerSequencePacketType,
      args.maxBlocks,
    );
    const markerBlocks = runPacketDump(
      cliPath,
      fixture.replayPath,
      profile.deathMarkerPacketType,
      args.maxBlocks,
    );
    const { decodedEvents, errors, ignoredMarkerCount } = decodeKillEvents(
      [...sequenceBlocks, ...markerBlocks],
      profile,
      args.timestampToleranceMillis,
    );
    const timeline = readJson(fixture.timelinePath);
    const apiEvents = collectApiKillEvents(timeline);
    const comparison = compareDecodedToApi(
      decodedEvents,
      apiEvents,
      args.timestampToleranceMillis,
    );
    const pass =
      markerBlocks.length < args.maxBlocks &&
      sequenceBlocks.length < args.maxBlocks &&
      errors.length === 0 &&
      decodedEvents.length === apiEvents.length &&
      comparison.exactMatchCount === apiEvents.length &&
      comparison.decodedMismatchCount === 0 &&
      comparison.missingApiEventCount === 0;

    rows.push({
      replayId: fixture.replayId,
      versionGroup: fixture.versionGroup,
      gameVersion: fixture.gameVersion,
      status: pass ? "pass" : "fail",
      profile: {
        ownerSequencePacketType: profile.ownerSequencePacketType,
        ownerSequencePacketTypeHex: packetTypeHex(profile.ownerSequencePacketType),
        deathMarkerPacketType: profile.deathMarkerPacketType,
        deathMarkerPacketTypeHex: packetTypeHex(profile.deathMarkerPacketType),
        championNetworkIdBase: profile.championNetworkIdBase,
        championNetworkIdBaseHex: `0x${profile.championNetworkIdBase.toString(16).toUpperCase()}`,
      },
      provenance: {
        replayOnlyExtractionInput: fixture.replayPath,
        offlineValidationInputs: [fixture.matchPath, fixture.timelinePath],
        runtimeInput: false,
      },
      counts: {
        ownerSequenceBlocks: sequenceBlocks.length,
        deathMarkerBlocks: markerBlocks.length,
        ignoredDeathMarkerBlocks: ignoredMarkerCount,
        decodedKillEvents: decodedEvents.length,
        apiKillEvents: apiEvents.length,
      },
      comparison,
      decoderErrors: errors,
      decodedEvents,
    });
  }

  const byVersionGroup = Object.entries(Object.groupBy(rows, (row) => row.versionGroup))
    .map(([versionGroup, groupRows]) => ({
      versionGroup,
      replayCount: groupRows.length,
      passingReplayCount: groupRows.filter((row) => row.status === "pass").length,
      decodedKillEventCount: groupRows.reduce(
        (sum, row) => sum + row.counts.decodedKillEvents,
        0,
      ),
      exactMatchCount: groupRows.reduce(
        (sum, row) => sum + row.comparison.exactMatchCount,
        0,
      ),
      apiKillEventCount: groupRows.reduce(
        (sum, row) => sum + row.counts.apiKillEvents,
        0,
      ),
    }))
    .sort((left, right) =>
      left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true })
    );
  const totals = {
    replayCount: rows.length,
    passingReplayCount: rows.filter((row) => row.status === "pass").length,
    decodedKillEventCount: rows.reduce(
      (sum, row) => sum + row.counts.decodedKillEvents,
      0,
    ),
    exactMatchCount: rows.reduce(
      (sum, row) => sum + row.comparison.exactMatchCount,
      0,
    ),
    apiKillEventCount: rows.reduce(
      (sum, row) => sum + row.counts.apiKillEvents,
      0,
    ),
  };

  const output = {
    schema: "rofl-packet-kill-decoder-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-validation-only",
    runtimeInput: false,
    status: totals.passingReplayCount === totals.replayCount
      ? "validated"
      : "validation-failed",
    methodology: {
      replayExtraction:
        "Packet blocks, source order, timestamps, types, and block parameters come from ROFL files.",
      offlineLabels:
        "Riot timeline CHAMPION_KILL events are loaded only for validation in this script.",
      runtimeProfileSelection:
        "A production decoder must select the profile from replay gameVersion metadata, not Riot API data.",
      ownerSequence: "[victim, ...ordered assists, killer]; a one-owner sequence is an execution.",
      marker:
        "The fixed-five-byte death marker closes the owner sequence and its blockParam is the victim network ID.",
      timestampToleranceMillis: args.timestampToleranceMillis,
    },
    cliPath,
    profiles: Object.fromEntries(
      Object.entries(PATCH_PROFILES).map(([versionGroup, profile]) => [
        versionGroup,
        {
          ...profile,
          ownerSequencePacketTypeHex: packetTypeHex(profile.ownerSequencePacketType),
          deathMarkerPacketTypeHex: packetTypeHex(profile.deathMarkerPacketType),
          championNetworkIdBaseHex: `0x${profile.championNetworkIdBase.toString(16).toUpperCase()}`,
        },
      ]),
    ),
    totals,
    byVersionGroup,
    rows,
  };
  writeJson(outputPath, output);
  console.log(`Wrote packet kill decoder validation to ${outputPath}`);
  console.log(
    `replays=${totals.passingReplayCount}/${totals.replayCount}, ` +
    `kills=${totals.exactMatchCount}/${totals.apiKillEventCount}`,
  );
  if (output.status !== "validated") process.exitCode = 1;
}

main();
