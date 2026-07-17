import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { KILL_PACKET_PROFILES } from "./extract_replay_kills.mjs";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const STANDARD_WARD_TYPES = new Set([
  "BLUE_TRINKET",
  "CONTROL_WARD",
  "SIGHT_WARD",
  "YELLOW_TRINKET",
]);

const WARD_LIFECYCLE_PROFILES = Object.freeze({
  "15.22": Object.freeze({
    placementPacketType: 0x0308,
    placementOwnerPacketType: 0x0420,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x0017,
    removalContentLengths: Object.freeze([21, 28, 29]),
    killerOwnerPacketType: 0x044e,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "15.23": Object.freeze({
    placementPacketType: 0x0368,
    placementOwnerPacketType: 0x01bf,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x020a,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x028b,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "15.24": Object.freeze({
    placementPacketType: 0x02ce,
    placementOwnerPacketType: 0x0227,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x009c,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x0220,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "16.1": Object.freeze({
    placementPacketType: 0x037f,
    placementOwnerPacketType: 0x0335,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x0059,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x021a,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "16.5": Object.freeze({
    placementPacketType: 0x03f8,
    placementOwnerPacketType: 0x024f,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x023f,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x01fe,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "16.6": Object.freeze({
    placementPacketType: 0x0311,
    placementOwnerPacketType: 0x011d,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x0271,
    removalContentLengths: Object.freeze([21, 28, 29]),
    killerOwnerPacketType: 0x03fd,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "16.7": Object.freeze({
    placementPacketType: 0x0162,
    placementOwnerPacketType: 0x033b,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x039c,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x0301,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
  "16.9": Object.freeze({
    placementPacketType: 0x0041,
    placementOwnerPacketType: 0x04ac,
    placementOwnerContentLengths: Object.freeze([2, 3, 4]),
    removalPacketType: 0x02e6,
    removalContentLengths: Object.freeze([28, 29]),
    killerOwnerPacketType: 0x02f6,
    killerOwnerContentLengths: Object.freeze([6, 7]),
  }),
});

function parseArgs(argv) {
  const args = {
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    replayId: null,
    versionGroup: null,
    outputPath: path.join("artifacts", "packet-ward-lifecycle-validation.json"),
    timestampToleranceMillis: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--output" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--timestamp-tolerance-ms" && index + 1 < argv.length) {
      args.timestampToleranceMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/validate_packet_ward_lifecycle.mjs [options]",
        "",
        "Options:",
        "  --replay-dir <path>             Directory containing .rofl files.",
        "  --api-root <path>               Offline Riot fixture root.",
        "  --replay-id <platform-game>     Validate one replay.",
        "  --version-group <major.minor>   Validate one patch group.",
        "  --output <path>                 Write validation JSON.",
        "  --timestamp-tolerance-ms <n>    Timestamp tolerance; default 1.",
        "",
        "Candidate extraction is replay-only. Offline timelines are used solely to",
        "derive and validate patch classifiers and never enter runtime decoding.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function normalizeReplayId(value) {
  return String(value).replace("_", "-");
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function packetTypeHex(value) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
}

function byteHex(value) {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
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
    if (kind < 1 || kind > 3 || compressedLength < 4 || uncompressedLength === 0) continue;
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
      headerOffset,
      payloadOffset,
      compressedLength,
      uncompressedLength,
    });
  }
  return records.sort((left, right) => left.headerOffset - right.headerOffset);
}

function parsePacketStream(payload, record, visitor) {
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
      timestampSeconds += payload[cursor++] * 0.001;
    } else {
      timestampSeconds = payload.readFloatLE(cursor);
      cursor += 4;
    }
    let contentLength;
    if (marker & 0x10) contentLength = payload[cursor++];
    else {
      contentLength = payload.readUInt32LE(cursor);
      cursor += 4;
    }
    let packetType;
    if (marker & 0x40) packetType = previousPacketType;
    else {
      packetType = payload.readUInt16LE(cursor);
      cursor += 2;
    }
    let blockParam;
    if (marker & 0x20) blockParam = (previousBlockParam + payload.readInt8(cursor++)) >>> 0;
    else {
      blockParam = payload.readUInt32LE(cursor);
      cursor += 4;
    }
    const contentOffset = cursor;
    const endOffset = contentOffset + contentLength;
    if (endOffset > payload.length) {
      throw new Error(`Packet content overruns chunk ${record.chunkId}.`);
    }
    visitor({
      channel,
      packetType,
      timestampMillis: Math.round(timestampSeconds * 1000),
      blockParam,
      contentLength,
      payload: payload.subarray(contentOffset, endOffset),
      chunkId: record.chunkId,
      blockIndex,
      headerOffset,
    });
    previousPacketType = packetType;
    previousBlockParam = blockParam;
    cursor = endOffset;
    blockIndex += 1;
  }
  return blockIndex;
}

function discoverFixtures(args) {
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  const requestedReplayId = args.replayId ? normalizeReplayId(args.replayId) : null;
  return fs.readdirSync(apiRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const replayId = normalizeReplayId(entry.name);
      const replayPath = path.join(replayDir, `${replayId}.rofl`);
      const matchPath = path.join(apiRoot, entry.name, "match.json");
      const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
      if (
        !fs.existsSync(replayPath) ||
        !fs.existsSync(matchPath) ||
        !fs.existsSync(timelinePath)
      ) {
        return null;
      }
      const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
      return {
        replayId,
        replayPath,
        timelinePath,
        gameVersion: match.info?.gameVersion ?? "unknown",
        versionGroup: versionGroup(match.info?.gameVersion),
      };
    })
    .filter(Boolean)
    .filter((fixture) => !requestedReplayId || fixture.replayId === requestedReplayId)
    .filter((fixture) => !args.versionGroup || fixture.versionGroup === args.versionGroup)
    .filter((fixture) => WARD_LIFECYCLE_PROFILES[fixture.versionGroup])
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectWardEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "WARD_PLACED" || event.type === "WARD_KILL")
    .map((event, index) => ({
      id: index,
      type: event.type,
      timestampMillis: event.timestamp,
      wardType: event.wardType ?? "UNKNOWN",
      actorParticipantId:
        event.type === "WARD_PLACED" ? (event.creatorId ?? null) : (event.killerId ?? null),
      standardWard: STANDARD_WARD_TYPES.has(event.wardType),
    }));
}

function buildTimestampWindow(events, toleranceMillis) {
  const window = new Map();
  for (const event of events) {
    for (let delta = -toleranceMillis; delta <= toleranceMillis; delta += 1) {
      const timestamp = event.timestampMillis + delta;
      const values = window.get(timestamp) ?? [];
      values.push(event);
      window.set(timestamp, values);
    }
  }
  return window;
}

function readFixture(fixture, toleranceMillis) {
  const profile = WARD_LIFECYCLE_PROFILES[fixture.versionGroup];
  const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
  const events = collectWardEvents(timeline);
  const placedEvents = events.filter((event) => event.type === "WARD_PLACED");
  const killEvents = events.filter((event) => event.type === "WARD_KILL");
  const placedWindow = buildTimestampWindow(placedEvents, toleranceMillis);
  const killWindow = buildTimestampWindow(killEvents, toleranceMillis);

  const bytes = fs.readFileSync(fixture.replayPath);
  const metadataLength = bytes.readUInt32LE(bytes.length - 4);
  const metadataOffset = bytes.length - 4 - metadataLength;
  const records = findFooterRecords(bytes, metadataOffset).filter((record) => record.kind === 1);
  const placementBlocks = [];
  const placementOwnerBlocks = [];
  const removalBlocks = [];
  const killerOwnerBlocks = [];
  let packetBlockCount = 0;

  for (const record of records) {
    const compressed = bytes.subarray(
      record.payloadOffset,
      record.payloadOffset + record.compressedLength,
    );
    const payload = zlib.zstdDecompressSync(compressed);
    packetBlockCount += parsePacketStream(payload, record, (block) => {
      if (block.channel !== 1) return;
      if (block.packetType === profile.placementPacketType && block.contentLength === 3) {
        placementBlocks.push({
          ...block,
          matchingEvents: placedWindow.get(block.timestampMillis) ?? [],
        });
      }
      if (
        block.packetType === profile.placementOwnerPacketType &&
        profile.placementOwnerContentLengths.includes(block.contentLength)
      ) {
        placementOwnerBlocks.push(block);
      }
      if (
        block.packetType === profile.removalPacketType &&
        profile.removalContentLengths.includes(block.contentLength)
      ) {
        removalBlocks.push({
          ...block,
          matchingEvents: killWindow.get(block.timestampMillis) ?? [],
        });
      }
      if (
        block.packetType === profile.killerOwnerPacketType &&
        profile.killerOwnerContentLengths.includes(block.contentLength)
      ) {
        killerOwnerBlocks.push({
          ...block,
          matchingEvents: killWindow.get(block.timestampMillis) ?? [],
        });
      }
    });
  }
  return {
    fixture,
    profile,
    events,
    placedEvents,
    killEvents,
    placementBlocks,
    placementOwnerBlocks,
    removalBlocks,
    killerOwnerBlocks,
    packetBlockCount,
  };
}

function derivePayloadClassifier(rows) {
  const eventBlocks = rows.flatMap((row) =>
    row.placementBlocks.filter((block) =>
      block.matchingEvents.some((event) => event.standardWard),
    ),
  );
  const otherBlocks = rows.flatMap((row) =>
    row.placementBlocks.filter(
      (block) => !block.matchingEvents.some((event) => event.standardWard),
    ),
  );
  const candidates = [];
  for (let offset = 0; offset < 3; offset += 1) {
    for (let mask = 1; mask <= 0xff; mask += 1) {
      const accepted = new Set(eventBlocks.map((block) => block.payload[offset] & mask));
      const falsePositiveCount = otherBlocks.filter((block) =>
        accepted.has(block.payload[offset] & mask),
      ).length;
      candidates.push({
        offset,
        mask,
        maskHex: byteHex(mask),
        acceptedValues: [...accepted].sort((left, right) => left - right),
        acceptedValuesHex: [...accepted].sort((left, right) => left - right).map(byteHex),
        eventBlockCount: eventBlocks.length,
        otherBlockCount: otherBlocks.length,
        falsePositiveCount,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      left.falsePositiveCount - right.falsePositiveCount ||
      left.acceptedValues.length - right.acceptedValues.length ||
      right.mask - left.mask ||
      left.offset - right.offset,
  );
  return candidates[0];
}

function eventMatched(events, blocks, toleranceMillis) {
  return events.filter((event) =>
    blocks.some((block) => Math.abs(block.timestampMillis - event.timestampMillis) <= toleranceMillis),
  );
}

function matchOwnedEvents(events, candidates, toleranceMillis) {
  const usedCandidateIndexes = new Set();
  let matchedCount = 0;
  for (const event of [...events].sort(
    (left, right) => left.timestampMillis - right.timestampMillis,
  )) {
    const candidateIndex = candidates.findIndex(
      (candidate, index) =>
        !usedCandidateIndexes.has(index) &&
        candidate.ownerParticipantId === event.actorParticipantId &&
        Math.abs(candidate.timestampMillis - event.timestampMillis) <= toleranceMillis,
    );
    if (candidateIndex >= 0) {
      usedCandidateIndexes.add(candidateIndex);
      matchedCount += 1;
    }
  }
  return matchedCount;
}

function pairPlacementOwners(
  row,
  classifiedPlacements,
  championNetworkIdBase,
  toleranceMillis,
) {
  const ownerBlocks = row.placementOwnerBlocks
    .map((block) => ({
      ...block,
      ownerParticipantId: block.blockParam - championNetworkIdBase,
    }))
    .filter(
      (block) => block.ownerParticipantId >= 1 && block.ownerParticipantId <= 10,
    );
  const pairs = [];
  for (const placement of classifiedPlacements) {
    const owner = ownerBlocks
      .filter(
        (block) =>
          block.chunkId === placement.chunkId &&
          block.blockIndex < placement.blockIndex &&
          Math.abs(block.timestampMillis - placement.timestampMillis) <= toleranceMillis,
      )
      .sort((left, right) => right.blockIndex - left.blockIndex)[0];
    if (!owner) continue;
    const firstPlacementAfterOwner = classifiedPlacements
      .filter(
        (candidate) =>
          candidate.chunkId === placement.chunkId &&
          candidate.blockIndex > owner.blockIndex &&
          Math.abs(candidate.timestampMillis - owner.timestampMillis) <= toleranceMillis,
      )
      .sort((left, right) => left.blockIndex - right.blockIndex)[0];
    if (firstPlacementAfterOwner !== placement) continue;
    pairs.push({
      ...placement,
      ownerParticipantId: owner.ownerParticipantId,
      ownerBlockIndex: owner.blockIndex,
    });
  }
  return pairs;
}

function linkKillerOwners(
  row,
  linkedRemovals,
  championNetworkIdBase,
  toleranceMillis,
) {
  return linkedRemovals.flatMap((removal) => {
    const candidates = row.killerOwnerBlocks
      .map((block) => ({
        ...block,
        ownerParticipantId: block.blockParam - championNetworkIdBase,
      }))
      .filter(
        (block) =>
          block.ownerParticipantId >= 1 &&
          block.ownerParticipantId <= 10 &&
          block.chunkId === removal.chunkId &&
          block.blockIndex < removal.blockIndex &&
          Math.abs(block.timestampMillis - removal.timestampMillis) <= toleranceMillis,
      )
      .sort((left, right) => right.blockIndex - left.blockIndex);
    if (candidates.length === 0) return [];
    return [{
      ...removal,
      ownerParticipantId: candidates[0].ownerParticipantId,
      ownerBlockIndex: candidates[0].blockIndex,
      ownerCandidateCount: candidates.length,
    }];
  });
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function validatePatch(group, rows, toleranceMillis) {
  const classifier = derivePayloadClassifier(rows);
  const championNetworkIdBase = KILL_PACKET_PROFILES[group].championNetworkIdBase;
  const fixtureReports = [];

  for (const row of rows) {
    const standardPlacedEvents = row.placedEvents.filter((event) => event.standardWard);
    const standardKillEvents = row.killEvents.filter((event) => event.standardWard);
    const classifiedPlacements = row.placementBlocks.filter((block) =>
      classifier.acceptedValues.includes(block.payload[classifier.offset] & classifier.mask),
    );
    const pairedPlacements = pairPlacementOwners(
      row,
      classifiedPlacements,
      championNetworkIdBase,
      toleranceMillis,
    );
    const wardEntityIds = new Set(pairedPlacements.map((block) => block.blockParam));
    const linkedRemovals = row.removalBlocks.filter((block) => wardEntityIds.has(block.blockParam));
    const matchedPlacementEvents = eventMatched(
      standardPlacedEvents,
      pairedPlacements,
      toleranceMillis,
    );
    const placementOwnerMatchedEventCount = matchOwnedEvents(
      standardPlacedEvents,
      pairedPlacements,
      toleranceMillis,
    );
    const matchedKillEvents = eventMatched(standardKillEvents, linkedRemovals, toleranceMillis);
    const linkedKillerOwners = linkKillerOwners(
      row,
      linkedRemovals,
      championNetworkIdBase,
      toleranceMillis,
    );
    const killerOwnerMatchedEventCount = matchOwnedEvents(
      standardKillEvents,
      linkedKillerOwners,
      toleranceMillis,
    );
    const eventLinkedRemovals = linkedRemovals.filter((block) =>
      standardKillEvents.some(
        (event) => Math.abs(block.timestampMillis - event.timestampMillis) <= toleranceMillis,
      ),
    );
    const extraPlacements = classifiedPlacements.filter((block) =>
      !standardPlacedEvents.some(
        (event) => Math.abs(block.timestampMillis - event.timestampMillis) <= toleranceMillis,
      ),
    );
    const extraPairedPlacements = pairedPlacements.filter((block) =>
      !standardPlacedEvents.some(
        (event) => Math.abs(block.timestampMillis - event.timestampMillis) <= toleranceMillis,
      ),
    );
    const extraLinkedRemovals = linkedRemovals.filter((block) =>
      !standardKillEvents.some(
        (event) => Math.abs(block.timestampMillis - event.timestampMillis) <= toleranceMillis,
      ),
    );

    fixtureReports.push({
      replayId: row.fixture.replayId,
      gameVersion: row.fixture.gameVersion,
      standardWardPlacementEventCount: standardPlacedEvents.length,
      classifiedPlacementBlockCount: classifiedPlacements.length,
      pairedPlacementBlockCount: pairedPlacements.length,
      matchedPlacementEventCount: matchedPlacementEvents.length,
      placementOwnerMatchedEventCount,
      extraClassifiedPlacementBlockCount: extraPlacements.length,
      extraPairedPlacementBlockCount: extraPairedPlacements.length,
      distinctWardEntityIdCount: wardEntityIds.size,
      standardWardKillEventCount: standardKillEvents.length,
      linkedRemovalBlockCount: linkedRemovals.length,
      eventLinkedRemovalBlockCount: eventLinkedRemovals.length,
      matchedKillEventCount: matchedKillEvents.length,
      extraLinkedRemovalBlockCount: extraLinkedRemovals.length,
      removalContentLengths: countBy(linkedRemovals, (block) => String(block.contentLength)),
      linkedKillerOwnerCount: linkedKillerOwners.length,
      killerOwnerMatchedEventCount,
      killerOwnerCandidateCollisionCount: linkedKillerOwners.filter(
        (block) => block.ownerCandidateCount > 1,
      ).length,
      packetBlockCount: row.packetBlockCount,
    });
  }

  const totals = {
    replayCount: fixtureReports.length,
    standardWardPlacementEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.standardWardPlacementEventCount,
      0,
    ),
    classifiedPlacementBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.classifiedPlacementBlockCount,
      0,
    ),
    pairedPlacementBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.pairedPlacementBlockCount,
      0,
    ),
    matchedPlacementEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.matchedPlacementEventCount,
      0,
    ),
    extraClassifiedPlacementBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.extraClassifiedPlacementBlockCount,
      0,
    ),
    extraPairedPlacementBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.extraPairedPlacementBlockCount,
      0,
    ),
    placementOwnerMatchedEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.placementOwnerMatchedEventCount,
      0,
    ),
    standardWardKillEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.standardWardKillEventCount,
      0,
    ),
    linkedRemovalBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.linkedRemovalBlockCount,
      0,
    ),
    eventLinkedRemovalBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.eventLinkedRemovalBlockCount,
      0,
    ),
    matchedKillEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.matchedKillEventCount,
      0,
    ),
    extraLinkedRemovalBlockCount: fixtureReports.reduce(
      (sum, row) => sum + row.extraLinkedRemovalBlockCount,
      0,
    ),
    killerOwnerMatchedEventCount: fixtureReports.reduce(
      (sum, row) => sum + row.killerOwnerMatchedEventCount,
      0,
    ),
    linkedKillerOwnerCount: fixtureReports.reduce(
      (sum, row) => sum + row.linkedKillerOwnerCount,
      0,
    ),
    killerOwnerCandidateCollisionCount: fixtureReports.reduce(
      (sum, row) => sum + row.killerOwnerCandidateCollisionCount,
      0,
    ),
  };
  return {
    versionGroup: group,
    profile: {
      placementPacketType: rows[0].profile.placementPacketType,
      placementPacketTypeHex: packetTypeHex(rows[0].profile.placementPacketType),
      placementContentLength: 3,
      placementPayloadClassifier: classifier,
      placementOwnerPacketType: rows[0].profile.placementOwnerPacketType,
      placementOwnerPacketTypeHex: packetTypeHex(rows[0].profile.placementOwnerPacketType),
      placementOwnerContentLengths: rows[0].profile.placementOwnerContentLengths,
      removalPacketType: rows[0].profile.removalPacketType,
      removalPacketTypeHex: packetTypeHex(rows[0].profile.removalPacketType),
      removalContentLengths: rows[0].profile.removalContentLengths,
      killerOwnerPacketType: rows[0].profile.killerOwnerPacketType,
      killerOwnerPacketTypeHex: packetTypeHex(rows[0].profile.killerOwnerPacketType),
      killerOwnerContentLengths: rows[0].profile.killerOwnerContentLengths,
      championNetworkIdBase,
    },
    totals,
    exactPlacementProfile:
      totals.matchedPlacementEventCount === totals.standardWardPlacementEventCount &&
      totals.pairedPlacementBlockCount === totals.standardWardPlacementEventCount &&
      totals.placementOwnerMatchedEventCount === totals.standardWardPlacementEventCount &&
      totals.extraPairedPlacementBlockCount === 0,
    exactRemovalProfile:
      totals.matchedKillEventCount === totals.standardWardKillEventCount &&
      totals.linkedRemovalBlockCount === totals.standardWardKillEventCount &&
      totals.extraLinkedRemovalBlockCount === 0,
    exactKillerOwnerForDecodedRemovals:
      totals.linkedKillerOwnerCount === totals.linkedRemovalBlockCount &&
      totals.killerOwnerMatchedEventCount === totals.matchedKillEventCount,
    fixtures: fixtureReports,
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("This script requires zstdDecompressSync support.");
  }
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No matching replay/API fixture pairs were found.");

  const rawRows = [];
  for (const [index, fixture] of fixtures.entries()) {
    console.log(
      `[${index + 1}/${fixtures.length}] ${fixture.replayId} (${fixture.versionGroup})`,
    );
    rawRows.push(readFixture(fixture, args.timestampToleranceMillis));
  }
  const grouped = Object.groupBy(rawRows, (row) => row.fixture.versionGroup);
  const patchGroups = Object.entries(grouped)
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([group, rows]) => validatePatch(group, rows, args.timestampToleranceMillis));

  const totals = {
    replayCount: fixtures.length,
    standardWardPlacementEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.standardWardPlacementEventCount,
      0,
    ),
    matchedPlacementEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.matchedPlacementEventCount,
      0,
    ),
    pairedPlacementBlockCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.pairedPlacementBlockCount,
      0,
    ),
    placementOwnerMatchedEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.placementOwnerMatchedEventCount,
      0,
    ),
    extraClassifiedPlacementBlockCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.extraClassifiedPlacementBlockCount,
      0,
    ),
    extraPairedPlacementBlockCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.extraPairedPlacementBlockCount,
      0,
    ),
    standardWardKillEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.standardWardKillEventCount,
      0,
    ),
    matchedKillEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.matchedKillEventCount,
      0,
    ),
    extraLinkedRemovalBlockCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.extraLinkedRemovalBlockCount,
      0,
    ),
    killerOwnerMatchedEventCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.killerOwnerMatchedEventCount,
      0,
    ),
    linkedKillerOwnerCount: patchGroups.reduce(
      (sum, patch) => sum + patch.totals.linkedKillerOwnerCount,
      0,
    ),
  };

  const report = {
    schema: "rofl-packet-ward-lifecycle-validation/v2",
    generatedAtUtc: new Date().toISOString(),
    provenance: {
      replayPacketInput: "rofl-only",
      riotApiRuntimeInput: false,
      offlineValidationLabels: ["WARD_PLACED", "WARD_KILL", "wardType", "creatorId", "killerId"],
      timestampToleranceMillis: args.timestampToleranceMillis,
      compactBlockParamSemantics: "signed-int8-delta",
      scope: "Standard ward types only; traps and UNDEFINED labels are excluded.",
      runtimeCandidateInput: "Replay packet stream and patch profile only.",
      validationOnlyInput:
        "Offline Riot timeline labels are joined after replay-native extraction.",
    },
    totals,
    patchGroups,
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ward lifecycle validation to ${outputPath}`);
}

main();
