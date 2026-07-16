import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

export const KILL_PACKET_PROFILES = Object.freeze({
  "15.22": Object.freeze({
    ownerSequencePacketType: 0x0015,
    deathMarkerPacketType: 0x01d4,
    championNetworkIdBase: 0x40000099,
  }),
  "15.23": Object.freeze({
    ownerSequencePacketType: 0x0105,
    deathMarkerPacketType: 0x0343,
    championNetworkIdBase: 0x400004cc,
  }),
  "15.24": Object.freeze({
    ownerSequencePacketType: 0x01d8,
    deathMarkerPacketType: 0x020e,
    championNetworkIdBase: 0x40000147,
  }),
  "16.1": Object.freeze({
    ownerSequencePacketType: 0x02d6,
    deathMarkerPacketType: 0x0093,
    championNetworkIdBase: 0x400000ad,
  }),
  "16.5": Object.freeze({
    ownerSequencePacketType: 0x021a,
    deathMarkerPacketType: 0x03ef,
    championNetworkIdBase: 0x400000ad,
  }),
  "16.6": Object.freeze({
    ownerSequencePacketType: 0x02ec,
    deathMarkerPacketType: 0x001a,
    championNetworkIdBase: 0x400000ad,
  }),
  "16.7": Object.freeze({
    ownerSequencePacketType: 0x0052,
    deathMarkerPacketType: 0x0452,
    championNetworkIdBase: 0x400000ad,
  }),
  "16.9": Object.freeze({
    ownerSequencePacketType: 0x0073,
    deathMarkerPacketType: 0x02cb,
    championNetworkIdBase: 0x400000ad,
  }),
});

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_VERSION_SCAN_BYTES = 1024 * 1024;

function packetTypeHex(value) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
}

function networkIdHex(value) {
  return `0x${value.toString(16).padStart(8, "0").toUpperCase()}`;
}

function versionGroupFromGameVersion(gameVersion) {
  return gameVersion.split(".").slice(0, 2).join(".");
}

function extractGameVersion(bytes) {
  const prefix = bytes.subarray(0, Math.min(bytes.length, MAX_VERSION_SCAN_BYTES)).toString("latin1");
  const versions = [
    ...new Set(
      [...prefix.matchAll(/(?:^|[^0-9])(\d{1,2}\.\d{1,2}\.\d{1,5}\.\d{1,5})(?![0-9])/g)]
        .map((match) => match[1]),
    ),
  ];
  if (versions.length === 0) {
    throw new Error("Replay game version was not found in the ROFL header region.");
  }
  const supported = versions.filter((version) => KILL_PACKET_PROFILES[versionGroupFromGameVersion(version)]);
  if (supported.length === 0) {
    throw new Error(
      `Unsupported replay version ${versions.join(", ")}. ` +
      `Supported groups: ${Object.keys(KILL_PACKET_PROFILES).join(", ")}.`,
    );
  }
  const supportedGroups = new Set(supported.map(versionGroupFromGameVersion));
  if (supportedGroups.size !== 1) {
    throw new Error(`Replay version/profile is ambiguous: ${supported.join(", ")}.`);
  }
  return supported[0];
}

function parseFooterMetadata(bytes) {
  if (bytes.length < 4) {
    throw new Error("ROFL file is too short to contain footer metadata.");
  }
  const metadataLength = bytes.readUInt32LE(bytes.length - 4);
  const metadataOffset = bytes.length - 4 - metadataLength;
  if (metadataLength === 0 || metadataOffset < 0 || metadataOffset >= bytes.length - 4) {
    throw new Error("ROFL footer metadata length is invalid.");
  }
  let metadata;
  try {
    metadata = JSON.parse(bytes.subarray(metadataOffset, bytes.length - 4).toString("utf8"));
  } catch (error) {
    throw new Error(`ROFL footer metadata is not valid JSON: ${error.message}`);
  }
  return { metadata, metadataOffset, metadataLength };
}

function parseParticipants(metadata) {
  if (typeof metadata.statsJson !== "string") return [];
  let rows;
  try {
    rows = JSON.parse(metadata.statsJson);
  } catch (error) {
    throw new Error(`Replay statsJson is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(rows)) {
    throw new Error("Replay statsJson must contain a participant array.");
  }
  return rows.map((row, index) => ({
    participantId: index + 1,
    championName: row.SKIN ?? null,
    teamId: Number.parseInt(row.TEAM, 10) || null,
    teamPosition: row.TEAM_POSITION ?? row.INDIVIDUAL_POSITION ?? null,
    riotIdGameName: row.RIOT_ID_GAME_NAME ?? null,
    riotIdTagLine: row.RIOT_ID_TAG_LINE ?? null,
    finalKills: Number.parseInt(row.CHAMPIONS_KILLED, 10) || 0,
    finalDeaths: Number.parseInt(row.NUM_DEATHS, 10) || 0,
    finalAssists: Number.parseInt(row.ASSISTS, 10) || 0,
  }));
}

function findFooterRecords(bytes, metadataOffset) {
  const records = [];
  let cursor = 0;
  while (cursor < metadataOffset) {
    const payloadOffset = bytes.indexOf(ZSTD_MAGIC, cursor);
    if (payloadOffset < 0 || payloadOffset >= metadataOffset) break;
    cursor = payloadOffset + 1;
    const headerOffset = payloadOffset - 17;
    if (headerOffset < 0) continue;
    const kind = bytes[headerOffset + 8];
    const uncompressedLength = bytes.readUInt32LE(headerOffset + 9);
    const compressedLength = bytes.readUInt32LE(headerOffset + 13);
    if (kind < 1 || kind > 3 || compressedLength < ZSTD_MAGIC.length || uncompressedLength === 0) {
      continue;
    }
    if (payloadOffset + compressedLength > metadataOffset) continue;
    if (
      bytes[headerOffset + 1] !== 0 ||
      bytes[headerOffset + 2] !== 0 ||
      bytes[headerOffset + 3] !== 0 ||
      bytes[headerOffset + 5] !== 0 ||
      bytes[headerOffset + 6] !== 0 ||
      bytes[headerOffset + 7] !== 0
    ) {
      continue;
    }
    records.push({
      segmentId: bytes[headerOffset],
      chunkId: bytes[headerOffset + 4],
      kind,
      segmentType: kind === 1 ? "chunk" : kind === 2 ? "keyframe" : "startup",
      headerOffset,
      payloadOffset,
      compressedLength,
      uncompressedLength,
    });
  }
  records.sort((left, right) => left.headerOffset - right.headerOffset);
  if (records.length === 0) {
    throw new Error("No footer-style zstd replay records were found.");
  }
  return records;
}

function parseRelevantPacketBlocks(payload, record, profile) {
  const relevantBlocks = [];
  let cursor = 0;
  let timestampSeconds = 0;
  let previousPacketType = 0;
  let previousBlockParam = 0;
  let blockIndex = 0;

  while (cursor < payload.length) {
    const headerOffset = cursor;
    const marker = payload[cursor++];
    const channel = marker & 0x0f;

    if (marker & 0x80) {
      if (cursor + 1 > payload.length) {
        throw new Error(`Truncated packet timestamp in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      timestampSeconds += payload[cursor++] * 0.001;
    } else {
      if (cursor + 4 > payload.length) {
        throw new Error(`Truncated absolute packet timestamp in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      timestampSeconds = payload.readFloatLE(cursor);
      cursor += 4;
      if (!Number.isFinite(timestampSeconds)) {
        throw new Error(`Non-finite packet timestamp in chunk ${record.chunkId} at ${headerOffset}.`);
      }
    }

    let contentLength;
    if (marker & 0x10) {
      if (cursor + 1 > payload.length) {
        throw new Error(`Truncated compact content length in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      contentLength = payload[cursor++];
    } else {
      if (cursor + 4 > payload.length) {
        throw new Error(`Truncated content length in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      contentLength = payload.readUInt32LE(cursor);
      cursor += 4;
    }

    let packetType;
    if (marker & 0x40) {
      packetType = previousPacketType;
    } else {
      if (cursor + 2 > payload.length) {
        throw new Error(`Truncated packet type in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      packetType = payload.readUInt16LE(cursor);
      cursor += 2;
    }

    let blockParam;
    let blockParamSignedDelta = null;
    if (marker & 0x20) {
      if (cursor + 1 > payload.length) {
        throw new Error(`Truncated compact block parameter in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      blockParamSignedDelta = payload.readInt8(cursor++);
      blockParam = (previousBlockParam + blockParamSignedDelta) >>> 0;
    } else {
      if (cursor + 4 > payload.length) {
        throw new Error(`Truncated block parameter in chunk ${record.chunkId} at ${headerOffset}.`);
      }
      blockParam = payload.readUInt32LE(cursor);
      cursor += 4;
    }

    const contentOffset = cursor;
    const endOffset = contentOffset + contentLength;
    if (endOffset > payload.length) {
      throw new Error(
        `Packet content overruns chunk ${record.chunkId} at ${headerOffset}: ` +
        `${endOffset} > ${payload.length}.`,
      );
    }

    if (
      channel === 1 &&
      (packetType === profile.ownerSequencePacketType ||
        packetType === profile.deathMarkerPacketType)
    ) {
      relevantBlocks.push({
        packetType,
        channel,
        timestampMillis: Math.round(timestampSeconds * 1000),
        blockParam,
        blockParamSignedDelta,
        contentLength,
        contentHex: payload.subarray(contentOffset, endOffset).toString("hex"),
        segmentId: record.segmentId,
        chunkId: record.chunkId,
        segmentHeaderOffset: record.headerOffset,
        segmentPayloadOffset: record.payloadOffset,
        blockIndex,
        headerOffset,
        contentOffset,
        endOffset,
      });
    }

    previousPacketType = packetType;
    previousBlockParam = blockParam;
    cursor = endOffset;
    blockIndex += 1;
  }

  return { relevantBlocks, blockCount: blockIndex, consumedBytes: cursor };
}

function ownerToParticipantId(ownerNetworkId, profile) {
  const participantId = ownerNetworkId - profile.championNetworkIdBase;
  return Number.isInteger(participantId) && participantId >= 1 && participantId <= 10
    ? participantId
    : null;
}

function blockProvenance(block) {
  return {
    segmentType: "chunk",
    segmentId: block.segmentId,
    chunkId: block.chunkId,
    segmentHeaderOffset: block.segmentHeaderOffset,
    segmentPayloadOffset: block.segmentPayloadOffset,
    blockIndex: block.blockIndex,
    decompressedHeaderOffset: block.headerOffset,
    decompressedContentOffset: block.contentOffset,
    decompressedEndOffset: block.endOffset,
  };
}

function decodeKillEvents(relevantBlocks, profile) {
  const events = [];
  const errors = [];
  let pendingOwnerBlocks = [];
  let ignoredMarkerCount = 0;

  for (const block of relevantBlocks) {
    if (block.packetType === profile.ownerSequencePacketType) {

      pendingOwnerBlocks.push(block);
      continue;
    }

    const ownerBlocks = pendingOwnerBlocks.filter(
      (ownerBlock) => Math.abs(ownerBlock.timestampMillis - block.timestampMillis) <= 1,
    );
    const participantIds = ownerBlocks.map((ownerBlock) =>
      ownerToParticipantId(ownerBlock.blockParam, profile)
    );
    const victimParticipantId = ownerToParticipantId(block.blockParam, profile);

    if (block.contentLength !== 5) {
      errors.push({
        code: "unexpected-death-marker-length",
        message: `Death marker length is ${block.contentLength}, expected 5.`,
        provenance: blockProvenance(block),
      });
    }
    if (ownerBlocks.length === 0) {
      ignoredMarkerCount += 1;
      pendingOwnerBlocks = [];
      continue;
    }
    if (participantIds.some((participantId) => participantId === null)) {
      errors.push({
        code: "owner-outside-champion-range",
        message: "Owner sequence contains a network ID outside the profiled champion range.",
        ownerNetworkIds: ownerBlocks.map((ownerBlock) => networkIdHex(ownerBlock.blockParam)),
        provenance: blockProvenance(block),
      });
      pendingOwnerBlocks = [];
      continue;
    }
    if (victimParticipantId === null || participantIds[0] !== victimParticipantId) {
      errors.push({
        code: "death-marker-victim-mismatch",
        message: "Death marker owner does not equal the first owner-sequence champion.",
        markerNetworkId: networkIdHex(block.blockParam),
        firstOwnerNetworkId: networkIdHex(ownerBlocks[0].blockParam),
        provenance: blockProvenance(block),
      });
      pendingOwnerBlocks = [];
      continue;
    }

    const isExecution = participantIds.length === 1;
    const killerParticipantId = isExecution ? 0 : participantIds.at(-1);
    const assistingParticipantIds = isExecution ? [] : participantIds.slice(1, -1);
    events.push({
      type: "CHAMPION_KILL",
      timestampMillis: block.timestampMillis,
      victimParticipantId,
      killerParticipantId,
      assistingParticipantIds,
      victimNetworkId: block.blockParam,
      victimNetworkIdHex: networkIdHex(block.blockParam),
      killerNetworkId: isExecution ? null : ownerBlocks.at(-1).blockParam,
      killerNetworkIdHex: isExecution ? null : networkIdHex(ownerBlocks.at(-1).blockParam),
      assistingNetworkIds: isExecution
        ? []
        : ownerBlocks.slice(1, -1).map((ownerBlock) => ownerBlock.blockParam),
      provenance: {
        deathMarker: blockProvenance(block),
        ownerSequence: ownerBlocks.map(blockProvenance),
      },
    });
    pendingOwnerBlocks = [];
  }

  return {
    events,
    errors,
    ignoredMarkerCount,
    pendingOwnerBlockCount: pendingOwnerBlocks.length,
  };
}

function validateFinalKda(participants, events) {
  const rows = participants.map((participant) => {
    const decodedKills = events.filter(
      (event) => event.killerParticipantId === participant.participantId,
    ).length;
    const decodedDeaths = events.filter(
      (event) => event.victimParticipantId === participant.participantId,
    ).length;
    const decodedAssists = events.filter(
      (event) => event.assistingParticipantIds.includes(participant.participantId),
    ).length;
    return {
      participantId: participant.participantId,
      expected: {
        kills: participant.finalKills,
        deaths: participant.finalDeaths,
        assists: participant.finalAssists,
      },
      decoded: {
        kills: decodedKills,
        deaths: decodedDeaths,
        assists: decodedAssists,
      },
      pass:
        decodedKills === participant.finalKills &&
        decodedDeaths === participant.finalDeaths &&
        decodedAssists === participant.finalAssists,
    };
  });
  return {
    source: "replay-metadata-statsJson",
    runtimeInput: "rofl-only",
    participantCount: rows.length,
    passingParticipantCount: rows.filter((row) => row.pass).length,
    pass: rows.length === 10 && rows.every((row) => row.pass),
    rows,
  };
}

export function extractReplayKills(replayPath) {
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("This extractor requires a Node.js build with zstdDecompressSync support.");
  }
  const absoluteReplayPath = path.resolve(replayPath);
  const bytes = fs.readFileSync(absoluteReplayPath);
  const gameVersion = extractGameVersion(bytes);
  const versionGroup = versionGroupFromGameVersion(gameVersion);
  const profile = KILL_PACKET_PROFILES[versionGroup];
  if (!profile) {
    throw new Error(`No kill packet profile is available for replay version ${gameVersion}.`);
  }

  const { metadata, metadataOffset, metadataLength } = parseFooterMetadata(bytes);
  const records = findFooterRecords(bytes, metadataOffset);
  const chunkRecords = records.filter((record) => record.segmentType === "chunk");
  if (chunkRecords.length === 0) {
    throw new Error("Replay contains no footer-style chunk records.");
  }

  const relevantBlocks = [];
  let packetBlockCount = 0;
  let decompressedChunkBytes = 0;
  for (const record of chunkRecords) {
    const compressed = bytes.subarray(
      record.payloadOffset,
      record.payloadOffset + record.compressedLength,
    );
    let payload;
    try {
      payload = zlib.zstdDecompressSync(compressed);
    } catch (error) {
      throw new Error(
        `Failed to decompress chunk ${record.chunkId} (segment ${record.segmentId}): ${error.message}`,
      );
    }
    if (payload.length !== record.uncompressedLength) {
      throw new Error(
        `Chunk ${record.chunkId} decompressed to ${payload.length} bytes, ` +
        `expected ${record.uncompressedLength}.`,
      );
    }
    const parsed = parseRelevantPacketBlocks(payload, record, profile);
    if (parsed.consumedBytes !== payload.length) {
      throw new Error(
        `Chunk ${record.chunkId} packet framing consumed ${parsed.consumedBytes}/${payload.length} bytes.`,
      );
    }
    relevantBlocks.push(...parsed.relevantBlocks);
    packetBlockCount += parsed.blockCount;
    decompressedChunkBytes += payload.length;
  }

  const decoded = decodeKillEvents(relevantBlocks, profile);
  if (decoded.errors.length > 0) {
    const firstError = decoded.errors[0];
    throw new Error(
      `Kill decoding failed with ${decoded.errors.length} error(s). ` +
      `${firstError.code}: ${firstError.message}`,
    );
  }

  const participants = parseParticipants(metadata);
  const finalKdaValidation = validateFinalKda(participants, decoded.events);
  if (!finalKdaValidation.pass) {
    throw new Error(
      `Decoded kill events do not match replay metadata final K/D/A for ` +
      `${finalKdaValidation.participantCount - finalKdaValidation.passingParticipantCount} participant(s).`,
    );
  }

  const replayId = path.basename(absoluteReplayPath, path.extname(absoluteReplayPath));
  const ownerSequenceBlockCount = relevantBlocks.filter(
    (block) => block.packetType === profile.ownerSequencePacketType,
  ).length;
  const deathMarkerBlockCount = relevantBlocks.filter(
    (block) => block.packetType === profile.deathMarkerPacketType,
  ).length;

  return {
    schema: "rofl-replay-kills/v1",
    generatedAtUtc: new Date().toISOString(),
    source: {
      replayPath: absoluteReplayPath,
      replayId,
      matchId: replayId.replace("-", "_"),
      runtimeInput: "rofl-only",
      riotApiInput: false,
    },
    gameVersion,
    versionGroup,
    profile: {
      channel: 1,
      ownerSequencePacketType: profile.ownerSequencePacketType,
      ownerSequencePacketTypeHex: packetTypeHex(profile.ownerSequencePacketType),
      deathMarkerPacketType: profile.deathMarkerPacketType,
      deathMarkerPacketTypeHex: packetTypeHex(profile.deathMarkerPacketType),
      championNetworkIdBase: profile.championNetworkIdBase,
      championNetworkIdBaseHex: networkIdHex(profile.championNetworkIdBase),
      ownerOrder: "[victim, ...ordered assists, killer]",
      executionRule: "A one-owner sequence has killerParticipantId=0.",
    },
    replay: {
      gameLengthMillis: metadata.gameLength ?? null,
      lastGameChunkId: metadata.lastGameChunkId ?? null,
      lastKeyFrameId: metadata.lastKeyFrameId ?? null,
      metadataOffset,
      metadataLength,
    },
    participants,
    events: decoded.events,
    diagnostics: {
      footerRecordCount: records.length,
      chunkRecordCount: chunkRecords.length,
      decompressedChunkBytes,
      packetBlockCount,
      relevantPacketBlockCount: relevantBlocks.length,
      ownerSequenceBlockCount,
      deathMarkerBlockCount,
      ignoredDeathMarkerBlockCount: decoded.ignoredMarkerCount,
      decodedKillEventCount: decoded.events.length,
      pendingOwnerBlockCount: decoded.pendingOwnerBlockCount,
      exactPacketFraming: true,
      signedCompactBlockParamDelta: true,
      finalKdaValidation,
    },
  };
}

function parseArgs(argv) {
  const args = {
    replayPath: null,
    outputPath: null,
    compact: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!args.replayPath && !arg.startsWith("--")) args.replayPath = arg;
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--compact") args.compact = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/extract_replay_kills.mjs <replay.rofl> [options]",
        "",
        "Options:",
        "  --output <path>  Write normalized JSON to a file instead of stdout.",
        "  --compact        Emit compact JSON.",
        "",
        "Extraction is ROFL-only. Riot API fixtures are not read.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!args.replayPath) {
    throw new Error("Missing replay path. Use --help for usage.");
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const output = extractReplayKills(args.replayPath);
  const json = args.compact ? JSON.stringify(output) : JSON.stringify(output, null, 2);
  if (args.outputPath) {
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${json}\n`);
    console.log(`Wrote ${output.events.length} replay-derived kill events to ${outputPath}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
