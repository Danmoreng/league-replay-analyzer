import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { KILL_PACKET_PROFILES } from "./extract_replay_kills.mjs";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TARGET_EVENT_TYPES = new Set(["WARD_PLACED", "WARD_KILL"]);

function parseArgs(argv) {
  const args = {
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    replayId: null,
    versionGroup: null,
    outputPath: path.join("artifacts", "packet-ward-discovery.json"),
    timestampToleranceMillis: 1,
    topCandidates: 30,
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
    } else if (arg === "--top-candidates" && index + 1 < argv.length) {
      args.topCandidates = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/discover_packet_wards.mjs [options]",
        "",
        "Options:",
        "  --replay-dir <path>             Directory containing .rofl files.",
        "  --api-root <path>               Offline Riot fixture root.",
        "  --replay-id <platform-game>     Analyze one replay.",
        "  --version-group <major.minor>   Analyze one patch group.",
        "  --output <path>                 Write the discovery report JSON.",
        "  --timestamp-tolerance-ms <n>    Timestamp tolerance; default 1.",
        "  --top-candidates <n>            Candidates per patch/event; default 30.",
        "",
        "Replay packet data is the candidate source. Riot timeline ward events are",
        "read only after fixture discovery and are used strictly as offline labels.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.timestampToleranceMillis) || args.timestampToleranceMillis < 0) {
    throw new Error("--timestamp-tolerance-ms must be a non-negative integer.");
  }
  if (!Number.isInteger(args.topCandidates) || args.topCandidates <= 0) {
    throw new Error("--top-candidates must be a positive integer.");
  }
  return args;
}

function normalizeReplayId(value) {
  return String(value).replace("_", "-");
}

function fixtureIdForReplay(replayId) {
  return replayId.replace("-", "_");
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function packetTypeHex(value) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
}

function networkIdHex(value) {
  return `0x${value.toString(16).padStart(8, "0").toUpperCase()}`;
}

function signatureKey(channel, packetType, contentLength) {
  return `${channel}:${packetType}:${contentLength}`;
}

function parseSignatureKey(key) {
  const [channel, packetType, contentLength] = key.split(":").map(Number);
  return {
    channel,
    packetType,
    packetTypeHex: packetTypeHex(packetType),
    contentLength,
  };
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
      if (cursor + 1 > payload.length) throw new Error("Truncated compact timestamp.");
      timestampSeconds += payload[cursor++] * 0.001;
    } else {
      if (cursor + 4 > payload.length) throw new Error("Truncated absolute timestamp.");
      timestampSeconds = payload.readFloatLE(cursor);
      cursor += 4;
      if (!Number.isFinite(timestampSeconds)) throw new Error("Non-finite timestamp.");
    }

    let contentLength;
    if (marker & 0x10) {
      if (cursor + 1 > payload.length) throw new Error("Truncated compact content length.");
      contentLength = payload[cursor++];
    } else {
      if (cursor + 4 > payload.length) throw new Error("Truncated content length.");
      contentLength = payload.readUInt32LE(cursor);
      cursor += 4;
    }

    let packetType;
    if (marker & 0x40) {
      packetType = previousPacketType;
    } else {
      if (cursor + 2 > payload.length) throw new Error("Truncated packet type.");
      packetType = payload.readUInt16LE(cursor);
      cursor += 2;
    }

    let blockParam;
    if (marker & 0x20) {
      if (cursor + 1 > payload.length) throw new Error("Truncated compact block parameter.");
      blockParam = (previousBlockParam + payload.readInt8(cursor++)) >>> 0;
    } else {
      if (cursor + 4 > payload.length) throw new Error("Truncated block parameter.");
      blockParam = payload.readUInt32LE(cursor);
      cursor += 4;
    }

    const contentOffset = cursor;
    const endOffset = contentOffset + contentLength;
    if (endOffset > payload.length) {
      throw new Error(
        `Packet content overruns chunk ${record.chunkId}: ${endOffset} > ${payload.length}.`,
      );
    }

    visitor({
      channel,
      packetType,
      timestampMillis: Math.round(timestampSeconds * 1000),
      blockParam,
      contentLength,
      payload: payload.subarray(contentOffset, endOffset),
      segmentId: record.segmentId,
      chunkId: record.chunkId,
      segmentHeaderOffset: record.headerOffset,
      segmentPayloadOffset: record.payloadOffset,
      blockIndex,
      headerOffset,
      contentOffset,
      endOffset,
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
  if (!fs.existsSync(replayDir) || !fs.existsSync(apiRoot)) return [];

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
        matchPath,
        timelinePath,
        gameVersion: match.info?.gameVersion ?? "unknown",
        versionGroup: versionGroup(match.info?.gameVersion),
      };
    })
    .filter(Boolean)
    .filter((fixture) => !requestedReplayId || fixture.replayId === requestedReplayId)
    .filter((fixture) => !args.versionGroup || fixture.versionGroup === args.versionGroup)
    .filter((fixture) => KILL_PACKET_PROFILES[fixture.versionGroup])
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectWardEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => TARGET_EVENT_TYPES.has(event.type))
    .map((event, index) => ({
      id: index,
      type: event.type,
      timestampMillis: event.timestamp,
      wardType: event.wardType ?? "UNKNOWN",
      actorParticipantId:
        event.type === "WARD_PLACED" ? (event.creatorId ?? null) : (event.killerId ?? null),
    }));
}

function addToMapCount(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function candidateKey(eventType, signature) {
  return `${eventType}|${signature}`;
}

function getCandidate(candidates, eventType, signature) {
  const key = candidateKey(eventType, signature);
  let candidate = candidates.get(key);
  if (!candidate) {
    candidate = {
      eventType,
      signature,
      matchedEventIds: new Set(),
      matchedReplayIds: new Set(),
      eventOccurrenceCount: 0,
      ownerMatchedEventIds: new Set(),
      ownerOccurrenceCount: 0,
      actorKnownOccurrenceCount: 0,
      wardTypeEventIds: new Map(),
      samples: new Map(),
      blockParamKinds: new Map(),
    };
    candidates.set(key, candidate);
  }
  return candidate;
}

function addSample(candidate, wardType, sample) {
  let samples = candidate.samples.get(wardType);
  if (!samples) {
    samples = [];
    candidate.samples.set(wardType, samples);
  }
  if (samples.length < 4) samples.push(sample);
}

function addWardTypeEvent(candidate, wardType, eventId) {
  let eventIds = candidate.wardTypeEventIds.get(wardType);
  if (!eventIds) {
    eventIds = new Set();
    candidate.wardTypeEventIds.set(wardType, eventIds);
  }
  eventIds.add(eventId);
}

function analyzeFixture(fixture, state, toleranceMillis) {
  const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
  const events = collectWardEvents(timeline);
  const eventWindow = new Map();
  for (const event of events) {
    const eventId = `${fixture.replayId}:${event.id}`;
    event.globalId = eventId;
    for (let delta = -toleranceMillis; delta <= toleranceMillis; delta += 1) {
      const timestamp = event.timestampMillis + delta;
      const values = eventWindow.get(timestamp) ?? [];
      values.push(event);
      eventWindow.set(timestamp, values);
    }
    const eventTypeState = state.eventTotals.get(event.type) ?? {
      eventCount: 0,
      replayIds: new Set(),
      wardTypes: new Map(),
    };
    eventTypeState.eventCount += 1;
    eventTypeState.replayIds.add(fixture.replayId);
    addToMapCount(eventTypeState.wardTypes, event.wardType);
    state.eventTotals.set(event.type, eventTypeState);
  }

  const bytes = fs.readFileSync(fixture.replayPath);
  const metadataLength = bytes.readUInt32LE(bytes.length - 4);
  const metadataOffset = bytes.length - 4 - metadataLength;
  const records = findFooterRecords(bytes, metadataOffset).filter((record) => record.kind === 1);
  const profile = KILL_PACKET_PROFILES[fixture.versionGroup];
  let packetBlockCount = 0;
  let decompressedBytes = 0;

  for (const record of records) {
    const compressed = bytes.subarray(
      record.payloadOffset,
      record.payloadOffset + record.compressedLength,
    );
    const payload = zlib.zstdDecompressSync(compressed);
    if (payload.length !== record.uncompressedLength) {
      throw new Error(
        `${fixture.replayId} chunk ${record.chunkId} decompressed length mismatch.`,
      );
    }
    decompressedBytes += payload.length;
    packetBlockCount += parsePacketStream(payload, record, (block) => {
      const signature = signatureKey(block.channel, block.packetType, block.contentLength);
      addToMapCount(state.signatureTotals, signature);
      const matchingEvents = eventWindow.get(block.timestampMillis);
      if (!matchingEvents) return;

      const eventsByType = new Map();
      for (const event of matchingEvents) {
        const values = eventsByType.get(event.type) ?? [];
        values.push(event);
        eventsByType.set(event.type, values);
      }

      for (const [eventType, typedEvents] of eventsByType) {
        const candidate = getCandidate(state.candidates, eventType, signature);
        candidate.eventOccurrenceCount += 1;
        candidate.matchedReplayIds.add(fixture.replayId);
        const mappedParticipantId = block.blockParam - profile.championNetworkIdBase;
        const blockParamKind =
          mappedParticipantId >= 1 && mappedParticipantId <= 10
            ? "champion-network-id"
            : block.blockParam === 0
              ? "zero"
              : "other";
        addToMapCount(candidate.blockParamKinds, blockParamKind);

        for (const event of typedEvents) {
          candidate.matchedEventIds.add(event.globalId);
          addWardTypeEvent(candidate, event.wardType, event.globalId);
          const actorKnown = Number.isInteger(event.actorParticipantId);
          if (actorKnown) {
            candidate.actorKnownOccurrenceCount += 1;
            if (mappedParticipantId === event.actorParticipantId) {
              candidate.ownerOccurrenceCount += 1;
              candidate.ownerMatchedEventIds.add(event.globalId);
            }
          }
          addSample(candidate, event.wardType, {
            replayId: fixture.replayId,
            timestampMillis: event.timestampMillis,
            actorParticipantId: event.actorParticipantId,
            mappedParticipantId:
              mappedParticipantId >= 1 && mappedParticipantId <= 10
                ? mappedParticipantId
                : null,
            blockParam: block.blockParam,
            blockParamHex: networkIdHex(block.blockParam),
            payloadHex: block.payload.subarray(0, 128).toString("hex"),
            payloadTruncated: block.payload.length > 128,
            chunkId: block.chunkId,
            blockIndex: block.blockIndex,
          });
        }
      }
    });
  }

  return {
    replayId: fixture.replayId,
    gameVersion: fixture.gameVersion,
    versionGroup: fixture.versionGroup,
    wardPlacedCount: events.filter((event) => event.type === "WARD_PLACED").length,
    wardKillCount: events.filter((event) => event.type === "WARD_KILL").length,
    chunkRecordCount: records.length,
    packetBlockCount,
    decompressedBytes,
  };
}

function mapCountsToObject(map) {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function serializeCandidates(state, eventType, topCandidates) {
  const totals = state.eventTotals.get(eventType);
  if (!totals) return [];
  return [...state.candidates.values()]
    .filter((candidate) => candidate.eventType === eventType)
    .map((candidate) => {
      const totalOccurrenceCount = state.signatureTotals.get(candidate.signature) ?? 0;
      const matchedEventCount = candidate.matchedEventIds.size;
      const ownerMatchedEventCount = candidate.ownerMatchedEventIds.size;
      const coverage = matchedEventCount / totals.eventCount;
      const occurrencePrecision =
        totalOccurrenceCount > 0 ? candidate.eventOccurrenceCount / totalOccurrenceCount : 0;
      const ownerEventCoverage =
        totals.eventCount > 0 ? ownerMatchedEventCount / totals.eventCount : 0;
      return {
        ...parseSignatureKey(candidate.signature),
        matchedEventCount,
        totalEventCount: totals.eventCount,
        coverage,
        matchedReplayCount: candidate.matchedReplayIds.size,
        eventfulReplayCount: totals.replayIds.size,
        eventOccurrenceCount: candidate.eventOccurrenceCount,
        totalOccurrenceCount,
        nonEventOccurrenceCount: totalOccurrenceCount - candidate.eventOccurrenceCount,
        occurrencePrecision,
        ownerMatchedEventCount,
        ownerEventCoverage,
        ownerOccurrenceCount: candidate.ownerOccurrenceCount,
        actorKnownOccurrenceCount: candidate.actorKnownOccurrenceCount,
        directOwnerOccurrenceRatio:
          candidate.actorKnownOccurrenceCount > 0
            ? candidate.ownerOccurrenceCount / candidate.actorKnownOccurrenceCount
            : 0,
        exactOneBlockPerEvent:
          matchedEventCount === totals.eventCount &&
          candidate.eventOccurrenceCount === totals.eventCount &&
          totalOccurrenceCount === totals.eventCount,
        wardTypeMatchedEventCounts: Object.fromEntries(
          [...candidate.wardTypeEventIds.entries()]
            .map(([wardType, eventIds]) => [wardType, eventIds.size])
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
        blockParamKinds: mapCountsToObject(candidate.blockParamKinds),
        samples: Object.fromEntries(
          [...candidate.samples.entries()].sort(([left], [right]) => left.localeCompare(right)),
        ),
      };
    })
    .sort(
      (left, right) =>
        Number(right.exactOneBlockPerEvent) - Number(left.exactOneBlockPerEvent) ||
        right.coverage - left.coverage ||
        right.ownerEventCoverage - left.ownerEventCoverage ||
        right.occurrencePrecision - left.occurrencePrecision ||
        left.nonEventOccurrenceCount - right.nonEventOccurrenceCount ||
        left.totalOccurrenceCount - right.totalOccurrenceCount,
    )
    .slice(0, topCandidates);
}

function main() {
  const args = parseArgs(process.argv);
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error("This script requires a Node.js build with zstdDecompressSync support.");
  }
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No matching replay/API fixture pairs were found.");

  const states = new Map();
  const fixtureRows = [];
  for (const [index, fixture] of fixtures.entries()) {
    console.log(
      `[${index + 1}/${fixtures.length}] ${fixture.replayId} (${fixture.versionGroup})`,
    );
    let state = states.get(fixture.versionGroup);
    if (!state) {
      state = {
        signatureTotals: new Map(),
        candidates: new Map(),
        eventTotals: new Map(),
      };
      states.set(fixture.versionGroup, state);
    }
    fixtureRows.push(analyzeFixture(fixture, state, args.timestampToleranceMillis));
  }

  const patchGroups = [...states.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([group, state]) => ({
      versionGroup: group,
      replayCount: fixtureRows.filter((row) => row.versionGroup === group).length,
      eventTotals: Object.fromEntries(
        [...state.eventTotals.entries()].map(([eventType, totals]) => [
          eventType,
          {
            eventCount: totals.eventCount,
            eventfulReplayCount: totals.replayIds.size,
            wardTypes: mapCountsToObject(totals.wardTypes),
          },
        ]),
      ),
      candidates: {
        WARD_PLACED: serializeCandidates(state, "WARD_PLACED", args.topCandidates),
        WARD_KILL: serializeCandidates(state, "WARD_KILL", args.topCandidates),
      },
    }));

  const report = {
    schema: "rofl-packet-ward-discovery/v1",
    generatedAtUtc: new Date().toISOString(),
    provenance: {
      replayPacketInput: "rofl-only",
      riotApiRuntimeInput: false,
      offlineValidationLabels: ["WARD_PLACED", "WARD_KILL"],
      timestampToleranceMillis: args.timestampToleranceMillis,
      compactBlockParamSemantics: "signed-int8-delta",
    },
    corpus: {
      replayCount: fixtureRows.length,
      patchGroupCount: patchGroups.length,
      packetBlockCount: fixtureRows.reduce((sum, row) => sum + row.packetBlockCount, 0),
      wardPlacedEventCount: fixtureRows.reduce((sum, row) => sum + row.wardPlacedCount, 0),
      wardKillEventCount: fixtureRows.reduce((sum, row) => sum + row.wardKillCount, 0),
    },
    patchGroups,
    fixtures: fixtureRows,
  };

  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ward packet discovery report to ${outputPath}`);
}

main();
