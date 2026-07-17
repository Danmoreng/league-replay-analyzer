import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const STANDARD_WARD_TYPES = new Set([
  "BLUE_TRINKET", "CONTROL_WARD", "SIGHT_WARD", "YELLOW_TRINKET",
]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "ward-entity-position-research.json"),
    versionGroup: null,
    replayId: null,
    neighborhoodRadius: 12,
    oracleWindowMillis: 5000,
    minimumCandidateSupport: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index].replace("_", "-");
    else if (arg === "--neighborhood-radius" && index + 1 < argv.length) args.neighborhoodRadius = Number(argv[++index]);
    else if (arg === "--oracle-window-ms" && index + 1 < argv.length) args.oracleWindowMillis = Number(argv[++index]);
    else if (arg === "--minimum-candidate-support" && index + 1 < argv.length) args.minimumCandidateSupport = Number(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function packetTypeHex(value) {
  return `0x${value.toString(16).padStart(4, "0").toUpperCase()}`;
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
    if ([1, 2, 3, 5, 6, 7].some((offset) => bytes[headerOffset + offset] !== 0)) continue;
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

function parsePacketStream(payload, record) {
  const blocks = [];
  let cursor = 0;
  let timestampSeconds = 0;
  let previousPacketType = 0;
  let previousBlockParam = 0;
  let blockIndex = 0;
  while (cursor < payload.length) {
    const headerOffset = cursor;
    const marker = payload[cursor++];
    const channel = marker & 0x0f;
    if (marker & 0x80) timestampSeconds += payload[cursor++] * 0.001;
    else { timestampSeconds = payload.readFloatLE(cursor); cursor += 4; }
    const contentLength = marker & 0x10 ? payload[cursor++] : payload.readUInt32LE(cursor);
    if (!(marker & 0x10)) cursor += 4;
    const packetType = marker & 0x40 ? previousPacketType : payload.readUInt16LE(cursor);
    if (!(marker & 0x40)) cursor += 2;
    const blockParam = marker & 0x20
      ? (previousBlockParam + payload.readInt8(cursor++)) >>> 0
      : payload.readUInt32LE(cursor);
    if (!(marker & 0x20)) cursor += 4;
    const contentOffset = cursor;
    const endOffset = contentOffset + contentLength;
    if (endOffset > payload.length) throw new Error(`Packet overrun in segment ${record.segmentId}.`);
    blocks.push({
      channel, packetType, blockParam, contentLength,
      timestampMillis: Math.round(timestampSeconds * 1000),
      segmentId: record.segmentId, chunkId: record.chunkId, kind: record.kind,
      blockIndex, headerOffset, contentOffset, endOffset,
      payload: payload.subarray(contentOffset, endOffset),
    });
    previousPacketType = packetType;
    previousBlockParam = blockParam;
    cursor = endOffset;
    blockIndex += 1;
  }
  return blocks;
}

function extractWards(cliPath, replayPath) {
  const result = spawnSync(cliPath, ["--extract-replay-wards-json", replayPath], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return JSON.parse(result.stdout);
}

function discoverFixtures(args) {
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  return fs.readdirSync(apiRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const replayId = entry.name.replace("_", "-");
      const replayPath = path.join(replayDir, `${replayId}.rofl`);
      const matchPath = path.join(apiRoot, entry.name, "match.json");
      const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
      if (!fs.existsSync(replayPath) || !fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) return null;
      const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
      return { replayId, replayPath, timelinePath, versionGroup: versionGroup(match.info?.gameVersion) };
    })
    .filter(Boolean)
    .filter((fixture) => !args.replayId || fixture.replayId === args.replayId)
    .filter((fixture) => !args.versionGroup || fixture.versionGroup === args.versionGroup)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectApiPlacements(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "WARD_PLACED" && STANDARD_WARD_TYPES.has(event.wardType));
}

function nearestFrameOracle(timeline, participantId, timestampMillis, windowMillis) {
  let best = null;
  for (const frame of timeline.info?.frames ?? []) {
    const participant = frame.participantFrames?.[String(participantId)];
    const position = participant?.position;
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    const deltaMillis = Math.abs((frame.timestamp ?? 0) - timestampMillis);
    if (deltaMillis > windowMillis || (best && best.deltaMillis <= deltaMillis)) continue;
    const otherPositions = Object.values(frame.participantFrames ?? {})
      .map((entry) => entry.position)
      .filter((value) => Number.isFinite(value?.x) && Number.isFinite(value?.y));
    best = { x: position.x, y: position.y, deltaMillis, otherPositions };
  }
  return best;
}

function addAggregate(map, key, seed, sample) {
  const row = map.get(key) ?? {
    ...seed,
    count: 0,
    samples: [],
    _replayIds: new Set(),
    _wardEntityNetworkIds: new Set(),
    _payloadFingerprints: new Set(),
    _placementKeys: new Set(),
  };
  row.count += 1;
  if (sample?.replayId) row._replayIds.add(sample.replayId);
  if (Number.isInteger(sample?.wardEntityNetworkId)) {
    row._wardEntityNetworkIds.add(sample.wardEntityNetworkId);
  }
  if (sample?.payloadFingerprint) row._payloadFingerprints.add(sample.payloadFingerprint);
  if (sample?.placementKey) row._placementKeys.add(sample.placementKey);
  if (row.samples.length < 4 && sample) row.samples.push(sample);
  map.set(key, row);
  return row;
}

function serializeAggregates(map) {
  return [...map.values()].map(({
    _replayIds, _wardEntityNetworkIds, _payloadFingerprints, _placementKeys, ...row
  }) => {
    const serialized = {
      ...row,
      distinctReplayCount: _replayIds.size,
      distinctWardEntityCount: _wardEntityNetworkIds.size,
      distinctPayloadCount: _payloadFingerprints.size,
      distinctPlacementCount: _placementKeys.size,
    };
    if (Number.isFinite(row.payloadEntropySum)) {
      serialized.meanPayloadEntropyBitsPerByte = row.payloadEntropySum / row.count;
      serialized.meanZeroByteRate = row.zeroByteRateSum / row.count;
      delete serialized.payloadEntropySum;
      delete serialized.zeroByteRateSum;
    }
    return serialized;
  });
}

function lifecycleTimeBucket(deltaMillis, isMarker = false) {
  if (isMarker) return "placement-marker";
  if (Math.abs(deltaMillis) <= 1) return "same-time";
  if (Math.abs(deltaMillis) <= 100) return "near-100ms";
  if (Math.abs(deltaMillis) <= 1000) return "near-1s";
  return deltaMillis > 0 ? "post-placement" : "pre-placement";
}

function payloadEntropy(payload) {
  if (payload.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of payload) counts[byte] += 1;
  let entropy = 0;
  for (const count of counts) {
    if (count === 0) continue;
    const probability = count / payload.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function zeroByteRate(payload) {
  if (payload.length === 0) return 0;
  let zeroCount = 0;
  for (const byte of payload) if (byte === 0) zeroCount += 1;
  return zeroCount / payload.length;
}

function containsUInt32LE(payload, value) {
  for (let offset = 0; offset + 4 <= payload.length; offset += 1) {
    if (payload.readUInt32LE(offset) === value) return true;
  }
  return false;
}

function payloadFingerprint(payload) {
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function addPayloadDifferential(map, key, seed, left, right, sample) {
  const row = map.get(key) ?? {
    ...seed,
    pairCount: 0,
    equalByteCountSum: 0,
    comparedByteCountSum: 0,
    offsets: [],
    samples: [],
  };
  const length = Math.min(left.length, right.length);
  let equalByteCount = 0;
  const equalOffsets = [];
  for (let offset = 0; offset < length; offset += 1) {
    const stat = row.offsets[offset] ?? {
      comparisonCount: 0,
      equalCount: 0,
      leftValues: new Set(),
      rightValues: new Set(),
    };
    stat.comparisonCount += 1;
    stat.leftValues.add(left[offset]);
    stat.rightValues.add(right[offset]);
    if (left[offset] === right[offset]) {
      stat.equalCount += 1;
      equalByteCount += 1;
      equalOffsets.push(offset);
    }
    row.offsets[offset] = stat;
  }
  row.pairCount += 1;
  row.equalByteCountSum += equalByteCount;
  row.comparedByteCountSum += length;
  if (row.samples.length < 4) row.samples.push({
    ...sample,
    leftLength: left.length,
    rightLength: right.length,
    equalByteCount,
    comparedByteCount: length,
    equalOffsets,
  });
  map.set(key, row);
}

function serializePayloadDifferentials(map) {
  return [...map.values()].map(({ offsets, ...row }) => {
    const offsetStats = offsets.flatMap((stat, offset) => stat ? [{
      offset,
      comparisonCount: stat.comparisonCount,
      equalCount: stat.equalCount,
      equalityRate: stat.equalCount / stat.comparisonCount,
      distinctLeftByteCount: stat.leftValues.size,
      distinctRightByteCount: stat.rightValues.size,
    }] : []);
    return {
      ...row,
      meanEqualByteRate: row.equalByteCountSum / row.comparedByteCountSum,
      highEqualityVariableOffsets: offsetStats.filter((stat) =>
        stat.comparisonCount >= Math.min(20, row.pairCount) &&
        stat.equalityRate >= 0.8 &&
        stat.distinctLeftByteCount >= 4 && stat.distinctRightByteCount >= 4
      ),
      bestOffsetStats: offsetStats
        .sort((left, right) =>
          right.equalityRate - left.equalityRate ||
          right.comparisonCount - left.comparisonCount ||
          right.distinctLeftByteCount - left.distinctLeftByteCount
        )
        .slice(0, 32),
    };
  }).sort((left, right) => right.pairCount - left.pairCount);
}

function scanPayloadHandles(payload, wardIds) {
  const matches = [];
  if (payload.length < 4) return matches;
  const stride = payload.length <= 1024 ? 1 : 4;
  for (let offset = 0; offset + 4 <= payload.length; offset += stride) {
    const value = payload.readUInt32LE(offset);
    if (wardIds.has(value)) matches.push({ offset, wardEntityNetworkId: value, stride });
  }
  return matches;
}

const COORDINATE_DECODERS = Object.freeze([
  { name: "f32le", width: 4, read: (payload, offset) => payload.readFloatLE(offset) },
  { name: "u16le", width: 2, read: (payload, offset) => payload.readUInt16LE(offset) },
  { name: "u16le-half", width: 2, read: (payload, offset) => payload.readUInt16LE(offset) / 2 },
  { name: "i16le-plus-7500", width: 2, read: (payload, offset) => payload.readInt16LE(offset) + 7500 },
  { name: "i16le-half-plus-7500", width: 2, read: (payload, offset) => (payload.readInt16LE(offset) / 2) + 7500 },
]);

function scanCoordinateCandidates(occurrences, minimumSupport) {
  const aggregates = new Map();
  for (const occurrence of occurrences) {
    const payload = occurrence.payload;
    for (const decoder of COORDINATE_DECODERS) {
      const limit = Math.min(payload.length, 128);
      for (let offset = 0; offset + (decoder.width * 2) <= limit; offset += 1) {
        const x = decoder.read(payload, offset);
        const y = decoder.read(payload, offset + decoder.width);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const key = [occurrence.versionGroup, occurrence.relativeIndex,
          occurrence.packetType, occurrence.contentLength, occurrence.blockParamRelation,
          decoder.name, offset].join("|");
        const row = aggregates.get(key) ?? {
          versionGroup: occurrence.versionGroup,
          relativeIndex: occurrence.relativeIndex,
          packetType: occurrence.packetType,
          packetTypeHex: packetTypeHex(occurrence.packetType),
          contentLength: occurrence.contentLength,
          blockParamRelation: occurrence.blockParamRelation,
          encoding: decoder.name,
          xOffset: offset,
          yOffset: offset + decoder.width,
          opportunityCount: 0,
          inBoundsCount: 0,
          nearOwnerCount: 0,
          closerThanMedianParticipantCount: 0,
          samples: [],
        };
        row.opportunityCount += 1;
        const inBounds = x >= 0 && x <= 15000 && y >= 0 && y <= 15000;
        if (inBounds) {
          row.inBoundsCount += 1;
          const distance = Math.hypot(x - occurrence.oracle.x, y - occurrence.oracle.y);
          const maximumDistance = 1500 + (0.8 * occurrence.oracle.deltaMillis);
          if (distance <= maximumDistance) row.nearOwnerCount += 1;
          const otherDistances = occurrence.oracle.otherPositions
            .map((position) => Math.hypot(x - position.x, y - position.y))
            .sort((left, right) => left - right);
          const medianDistance = otherDistances[Math.floor(otherDistances.length / 2)] ?? Infinity;
          if (distance < medianDistance) row.closerThanMedianParticipantCount += 1;
          if (row.samples.length < 4) row.samples.push({
            replayId: occurrence.replayId,
            timestampMillis: occurrence.timestampMillis,
            oracleDeltaMillis: occurrence.oracle.deltaMillis,
            decoded: { x, y },
            ownerFramePosition: { x: occurrence.oracle.x, y: occurrence.oracle.y },
            distance,
          });
        }
        aggregates.set(key, row);
      }
    }
  }
  return [...aggregates.values()]
    .filter((row) => row.opportunityCount >= minimumSupport)
    .map((row) => ({
      ...row,
      inBoundsRate: row.inBoundsCount / row.opportunityCount,
      nearOwnerRate: row.nearOwnerCount / row.opportunityCount,
      closerThanMedianParticipantRate:
        row.closerThanMedianParticipantCount / row.opportunityCount,
    }))
    .sort((left, right) =>
      right.nearOwnerRate - left.nearOwnerRate ||
      right.closerThanMedianParticipantRate - left.closerThanMedianParticipantRate ||
      right.opportunityCount - left.opportunityCount
    );
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  const fixtures = discoverFixtures(args);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  if (fixtures.length === 0) throw new Error("No matching fixtures found.");

  const blockParamAggregates = new Map();
  const payloadHandleAggregates = new Map();
  const neighborhoodAggregates = new Map();
  const neighborhoodFamilyAggregates = new Map();
  const removalNeighborhoodAggregates = new Map();
  const removalNeighborhoodFamilyAggregates = new Map();
  const placementRemovalDifferentials = new Map();
  const removalSiblingDifferentials = new Map();
  const coordinateOccurrences = [];
  const replayRows = [];

  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    console.log(`[${fixtureIndex + 1}/${fixtures.length}] ${fixture.replayId} (${fixture.versionGroup})`);
    const extracted = extractWards(cliPath, fixture.replayPath);
    const placements = extracted.events.filter((event) => event.type === "WARD_PLACED");
    const placementById = new Map(placements.map((event) => [event.wardEntityNetworkId, event]));
    const wardIds = new Set(placementById.keys());
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const apiPlacements = collectApiPlacements(timeline);
    for (const placement of placements) {
      const api = apiPlacements.find((event) =>
        event.creatorId === placement.ownerParticipantId &&
        Math.abs(event.timestamp - placement.timestampMillis) <= 1
      );
      placement.wardTypeOracle = api?.wardType ?? null;
      placement.positionOracle = nearestFrameOracle(
        timeline, placement.ownerParticipantId, placement.timestampMillis,
        args.oracleWindowMillis,
      );
    }

    const bytes = fs.readFileSync(fixture.replayPath);
    const metadataLength = bytes.readUInt32LE(bytes.length - 4);
    const metadataOffset = bytes.length - 4 - metadataLength;
    const records = findFooterRecords(bytes, metadataOffset);
    const segmentBlocks = new Map();
    let blockParamOccurrenceCount = 0;
    let payloadHandleOccurrenceCount = 0;
    for (const record of records) {
      const decompressed = zlib.zstdDecompressSync(bytes.subarray(
        record.payloadOffset, record.payloadOffset + record.compressedLength,
      ));
      const blocks = parsePacketStream(decompressed, record);
      segmentBlocks.set(`${record.kind}:${record.segmentId}:${record.chunkId}`, blocks);
      for (const block of blocks) {
        const placement = placementById.get(block.blockParam);
        if (placement) {
          blockParamOccurrenceCount += 1;
          const isMarker = block.kind === 1 &&
            block.segmentId === placement.provenance.markerBlock.segmentId &&
            block.blockIndex === placement.provenance.markerBlock.blockIndex;
          const deltaMillis = block.timestampMillis - placement.timestampMillis;
          const timeBucket = lifecycleTimeBucket(deltaMillis, isMarker);
          const key = [fixture.versionGroup, block.kind, block.packetType,
            block.contentLength, timeBucket].join("|");
          addAggregate(blockParamAggregates, key, {
            versionGroup: fixture.versionGroup,
            segmentKind: block.kind,
            packetType: block.packetType,
            packetTypeHex: packetTypeHex(block.packetType),
            contentLength: block.contentLength,
            lifecycleTimeBucket: timeBucket,
          }, { replayId: fixture.replayId, wardEntityNetworkId: block.blockParam, deltaMillis });
        }
        for (const match of scanPayloadHandles(block.payload, wardIds)) {
          payloadHandleOccurrenceCount += 1;
          const linkedPlacement = placementById.get(match.wardEntityNetworkId);
          const deltaMillis = block.timestampMillis - linkedPlacement.timestampMillis;
          const timeBucket = lifecycleTimeBucket(deltaMillis);
          const key = [fixture.versionGroup, block.kind, block.packetType,
            block.contentLength, match.offset, timeBucket].join("|");
          addAggregate(payloadHandleAggregates, key, {
            versionGroup: fixture.versionGroup,
            segmentKind: block.kind,
            packetType: block.packetType,
            packetTypeHex: packetTypeHex(block.packetType),
            contentLength: block.contentLength,
            payloadOffset: match.offset,
            lifecycleTimeBucket: timeBucket,
          }, {
            replayId: fixture.replayId,
            wardEntityNetworkId: match.wardEntityNetworkId,
            deltaMillis,
            scanStride: match.stride,
          });
        }
      }
    }

    let placementWithOracleCount = 0;
    const placementHighEntropyByWard = new Map();
    for (const placement of placements) {
      const marker = placement.provenance.markerBlock;
      const blocks = segmentBlocks.get(`1:${marker.segmentId}:${marker.chunkId}`) ?? [];
      const oracle = placement.positionOracle;
      if (oracle) placementWithOracleCount += 1;
      for (let relativeIndex = -args.neighborhoodRadius;
           relativeIndex <= args.neighborhoodRadius;
           relativeIndex += 1) {
        const block = blocks[marker.blockIndex + relativeIndex];
        if (!block || Math.abs(block.timestampMillis - placement.timestampMillis) > 1) continue;
        const relation = block.blockParam === placement.wardEntityNetworkId
          ? "ward-entity"
          : block.blockParam === placement.ownerNetworkId ? "owner-champion" : "other";
        const signatureKey = [fixture.versionGroup, relativeIndex, block.packetType,
          block.contentLength, relation].join("|");
        const entropy = payloadEntropy(block.payload);
        const zeros = zeroByteRate(block.payload);
        const wardIdInPayload = containsUInt32LE(block.payload, placement.wardEntityNetworkId);
        const ownerIdInPayload = containsUInt32LE(block.payload, placement.ownerNetworkId);
        const placementKey = `${fixture.replayId}:${placement.wardEntityNetworkId}:${placement.timestampMillis}`;
        const neighborhoodSample = {
          replayId: fixture.replayId,
          wardEntityNetworkId: placement.wardEntityNetworkId,
          placementKey,
          timestampMillis: placement.timestampMillis,
          payloadFingerprint: payloadFingerprint(block.payload),
          payloadPrefixHex: block.payload.subarray(0, 32).toString("hex"),
          payloadEntropyBitsPerByte: entropy,
          wardIdInPayload,
          ownerIdInPayload,
        };
        const aggregate = addAggregate(neighborhoodAggregates, signatureKey, {
          versionGroup: fixture.versionGroup,
          relativeIndex,
          packetType: block.packetType,
          packetTypeHex: packetTypeHex(block.packetType),
          contentLength: block.contentLength,
          blockParamRelation: relation,
          payloadEntropySum: 0,
          zeroByteRateSum: 0,
          wardIdInPayloadCount: 0,
          ownerIdInPayloadCount: 0,
        }, neighborhoodSample);
        aggregate.payloadEntropySum += entropy;
        aggregate.zeroByteRateSum += zeros;
        if (wardIdInPayload) aggregate.wardIdInPayloadCount += 1;
        if (ownerIdInPayload) aggregate.ownerIdInPayloadCount += 1;
        const familyKey = [fixture.versionGroup, block.packetType, relation].join("|");
        const family = addAggregate(neighborhoodFamilyAggregates, familyKey, {
          versionGroup: fixture.versionGroup,
          packetType: block.packetType,
          packetTypeHex: packetTypeHex(block.packetType),
          blockParamRelation: relation,
          minimumContentLength: block.contentLength,
          maximumContentLength: block.contentLength,
          payloadEntropySum: 0,
          zeroByteRateSum: 0,
          wardIdInPayloadCount: 0,
          ownerIdInPayloadCount: 0,
          contentLengthCounts: {},
          relativeIndexCounts: {},
        }, neighborhoodSample);
        family.minimumContentLength = Math.min(family.minimumContentLength, block.contentLength);
        family.maximumContentLength = Math.max(family.maximumContentLength, block.contentLength);
        family.payloadEntropySum += entropy;
        family.zeroByteRateSum += zeros;
        if (wardIdInPayload) family.wardIdInPayloadCount += 1;
        if (ownerIdInPayload) family.ownerIdInPayloadCount += 1;
        family.contentLengthCounts[block.contentLength] =
          (family.contentLengthCounts[block.contentLength] ?? 0) + 1;
        family.relativeIndexCounts[relativeIndex] =
          (family.relativeIndexCounts[relativeIndex] ?? 0) + 1;
        if (oracle && block.contentLength >= 4 && block.contentLength <= 128) {
          coordinateOccurrences.push({
            replayId: fixture.replayId,
            versionGroup: fixture.versionGroup,
            relativeIndex,
            packetType: block.packetType,
            contentLength: block.contentLength,
            blockParamRelation: relation,
            timestampMillis: placement.timestampMillis,
            payload: Buffer.from(block.payload),
            oracle,
          });
        }
        if (relation === "ward-entity" && block.contentLength >= 40) {
          const candidates = placementHighEntropyByWard.get(placement.wardEntityNetworkId) ?? [];
          candidates.push({ packetType: block.packetType, payload: Buffer.from(block.payload) });
          placementHighEntropyByWard.set(placement.wardEntityNetworkId, candidates);
        }
      }
    }
    const linkedRemovals = extracted.events.filter((event) =>
      event.type === "WARD_KILL" && placementById.has(event.wardEntityNetworkId)
    );
    const removalHighEntropyByWard = new Map();
    for (const removal of linkedRemovals) {
      const marker = removal.provenance.removalBlock;
      const blocks = segmentBlocks.get(`1:${marker.segmentId}:${marker.chunkId}`) ?? [];
      for (let relativeIndex = -args.neighborhoodRadius;
           relativeIndex <= args.neighborhoodRadius;
           relativeIndex += 1) {
        const block = blocks[marker.blockIndex + relativeIndex];
        if (!block || Math.abs(block.timestampMillis - removal.timestampMillis) > 1) continue;
        const relation = block.blockParam === removal.wardEntityNetworkId
          ? "removed-ward"
          : block.blockParam === removal.killerNetworkId ? "killer-champion" : "other";
        const entropy = payloadEntropy(block.payload);
        const zeros = zeroByteRate(block.payload);
        const wardIdInPayload = containsUInt32LE(block.payload, removal.wardEntityNetworkId);
        const ownerIdInPayload = containsUInt32LE(block.payload, removal.killerNetworkId);
        const placementKey = `${fixture.replayId}:${removal.wardEntityNetworkId}`;
        const sample = {
          replayId: fixture.replayId,
          wardEntityNetworkId: removal.wardEntityNetworkId,
          placementKey,
          timestampMillis: removal.timestampMillis,
          eventBlockParam: block.blockParam,
          eventBlockParamHex: `0x${block.blockParam.toString(16).padStart(8, "0").toUpperCase()}`,
          payloadFingerprint: payloadFingerprint(block.payload),
          payloadPrefixHex: block.payload.subarray(0, 32).toString("hex"),
          payloadEntropyBitsPerByte: entropy,
          wardIdInPayload,
          ownerIdInPayload,
        };
        const signatureKey = [fixture.versionGroup, relativeIndex, block.packetType,
          block.contentLength, relation].join("|");
        const aggregate = addAggregate(removalNeighborhoodAggregates, signatureKey, {
          versionGroup: fixture.versionGroup,
          relativeIndex,
          packetType: block.packetType,
          packetTypeHex: packetTypeHex(block.packetType),
          contentLength: block.contentLength,
          blockParamRelation: relation,
          payloadEntropySum: 0,
          zeroByteRateSum: 0,
          wardIdInPayloadCount: 0,
          ownerIdInPayloadCount: 0,
        }, sample);
        aggregate.payloadEntropySum += entropy;
        aggregate.zeroByteRateSum += zeros;
        if (wardIdInPayload) aggregate.wardIdInPayloadCount += 1;
        if (ownerIdInPayload) aggregate.ownerIdInPayloadCount += 1;
        const familyKey = [fixture.versionGroup, block.packetType, relation].join("|");
        const family = addAggregate(removalNeighborhoodFamilyAggregates, familyKey, {
          versionGroup: fixture.versionGroup,
          packetType: block.packetType,
          packetTypeHex: packetTypeHex(block.packetType),
          blockParamRelation: relation,
          minimumContentLength: block.contentLength,
          maximumContentLength: block.contentLength,
          payloadEntropySum: 0,
          zeroByteRateSum: 0,
          wardIdInPayloadCount: 0,
          ownerIdInPayloadCount: 0,
          contentLengthCounts: {},
          relativeIndexCounts: {},
        }, sample);
        family.minimumContentLength = Math.min(family.minimumContentLength, block.contentLength);
        family.maximumContentLength = Math.max(family.maximumContentLength, block.contentLength);
        family.payloadEntropySum += entropy;
        family.zeroByteRateSum += zeros;
        if (wardIdInPayload) family.wardIdInPayloadCount += 1;
        if (ownerIdInPayload) family.ownerIdInPayloadCount += 1;
        family.contentLengthCounts[block.contentLength] =
          (family.contentLengthCounts[block.contentLength] ?? 0) + 1;
        family.relativeIndexCounts[relativeIndex] =
          (family.relativeIndexCounts[relativeIndex] ?? 0) + 1;
        if (relation === "other" && block.contentLength >= 40) {
          const candidates = removalHighEntropyByWard.get(removal.wardEntityNetworkId) ?? [];
          candidates.push({
            packetType: block.packetType,
            blockParam: block.blockParam,
            payload: Buffer.from(block.payload),
          });
          removalHighEntropyByWard.set(removal.wardEntityNetworkId, candidates);
        }
      }
    }
    for (const removal of linkedRemovals) {
      const placementsForWard = placementHighEntropyByWard.get(removal.wardEntityNetworkId) ?? [];
      const removalsForWard = removalHighEntropyByWard.get(removal.wardEntityNetworkId) ?? [];
      for (const placementCandidate of placementsForWard) {
        const compatible = removalsForWard.filter((candidate) =>
          candidate.packetType === placementCandidate.packetType
        );
        if (compatible.length === 0) continue;
        const scored = compatible.map((candidate) => {
          const length = Math.min(placementCandidate.payload.length, candidate.payload.length);
          let equalCount = 0;
          for (let offset = 0; offset < length; offset += 1) {
            if (placementCandidate.payload[offset] === candidate.payload[offset]) equalCount += 1;
          }
          return { candidate, equalCount, length };
        }).sort((left, right) => right.equalCount - left.equalCount || right.length - left.length);
        const best = scored[0];
        const key = [fixture.versionGroup, placementCandidate.packetType].join("|");
        addPayloadDifferential(placementRemovalDifferentials, key, {
          versionGroup: fixture.versionGroup,
          packetType: placementCandidate.packetType,
          packetTypeHex: packetTypeHex(placementCandidate.packetType),
          comparison: "placement-to-best-removal-spawn",
        }, placementCandidate.payload, best.candidate.payload, {
          replayId: fixture.replayId,
          wardEntityNetworkId: removal.wardEntityNetworkId,
          removalEntityNetworkId: best.candidate.blockParam,
        });
      }
      const byPacketType = new Map();
      for (const candidate of removalsForWard) {
        const siblings = byPacketType.get(candidate.packetType) ?? [];
        siblings.push(candidate);
        byPacketType.set(candidate.packetType, siblings);
      }
      for (const [packetType, siblings] of byPacketType) {
        if (siblings.length !== 2) continue;
        const key = [fixture.versionGroup, packetType].join("|");
        addPayloadDifferential(removalSiblingDifferentials, key, {
          versionGroup: fixture.versionGroup,
          packetType,
          packetTypeHex: packetTypeHex(packetType),
          comparison: "removal-spawn-siblings",
        }, siblings[0].payload, siblings[1].payload, {
          replayId: fixture.replayId,
          wardEntityNetworkId: removal.wardEntityNetworkId,
          leftEntityNetworkId: siblings[0].blockParam,
          rightEntityNetworkId: siblings[1].blockParam,
        });
      }
    }
    replayRows.push({
      replayId: fixture.replayId,
      versionGroup: fixture.versionGroup,
      placementCount: placements.length,
      placementWithNearFrameOracleCount: placementWithOracleCount,
      blockParamOccurrenceCount,
      payloadHandleOccurrenceCount,
      linkedRemovalCount: linkedRemovals.length,
    });
  }

  const coordinateCandidates = scanCoordinateCandidates(
    coordinateOccurrences,
    args.minimumCandidateSupport,
  );
  const placementCountsByVersion = Object.fromEntries(Object.entries(
    replayRows.reduce((counts, row) => {
      counts[row.versionGroup] = (counts[row.versionGroup] ?? 0) + row.placementCount;
      return counts;
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right)));
  const placementNeighborhoodSignatures = serializeAggregates(neighborhoodAggregates)
    .sort((a, b) => b.count - a.count);
  const spawnPacketCandidates = placementNeighborhoodSignatures
    .filter((row) => row.contentLength > 3 && row.count >= args.minimumCandidateSupport)
    .map((row) => ({
      ...row,
      placementCoverageRate: row.count / placementCountsByVersion[row.versionGroup],
    }))
    .sort((left, right) =>
      right.placementCoverageRate - left.placementCoverageRate ||
      right.distinctReplayCount - left.distinctReplayCount ||
      right.count - left.count ||
      right.contentLength - left.contentLength
    );
  const placementNeighborhoodPacketFamilies = serializeAggregates(neighborhoodFamilyAggregates)
    .map((row) => ({
      ...row,
      placementCoverageRate:
        row.distinctPlacementCount / placementCountsByVersion[row.versionGroup],
      meanPacketsPerCoveredPlacement: row.count / row.distinctPlacementCount,
    }))
    .sort((left, right) =>
      right.placementCoverageRate - left.placementCoverageRate ||
      right.distinctReplayCount - left.distinctReplayCount ||
      right.count - left.count
    );
  const report = {
    schema: "rofl-ward-entity-position-research/v1",
    generatedAtUtc: new Date().toISOString(),
    promotionGate: false,
    provenance: {
      candidateInput: "ROFL packet blocks and productive wardEntityNetworkId values only.",
      offlineOracle: "Nearest Riot participant-frame position within the configured window; this is the placer position, not a ward-position label.",
      riotApiRuntimeInput: false,
      warning: "Proximity to the placer is a falsification aid and cannot prove ward-coordinate semantics.",
    },
    parameters: args,
    totals: {
      replayCount: replayRows.length,
      placementCount: replayRows.reduce((sum, row) => sum + row.placementCount, 0),
      placementWithNearFrameOracleCount: replayRows.reduce((sum, row) => sum + row.placementWithNearFrameOracleCount, 0),
      linkedRemovalCount: replayRows.reduce((sum, row) => sum + row.linkedRemovalCount, 0),
      blockParamOccurrenceCount: replayRows.reduce((sum, row) => sum + row.blockParamOccurrenceCount, 0),
      payloadHandleOccurrenceCount: replayRows.reduce((sum, row) => sum + row.payloadHandleOccurrenceCount, 0),
      coordinateOccurrenceCount: coordinateOccurrences.length,
      placementCountsByVersion,
    },
    replayRows,
    blockParamSignatures: serializeAggregates(blockParamAggregates).sort((a, b) => b.count - a.count),
    payloadHandleSignatures: serializeAggregates(payloadHandleAggregates).sort((a, b) => b.count - a.count),
    placementNeighborhoodSignatures,
    placementNeighborhoodPacketFamilies,
    removalNeighborhoodSignatures: serializeAggregates(removalNeighborhoodAggregates)
      .sort((a, b) => b.count - a.count),
    removalNeighborhoodPacketFamilies: serializeAggregates(removalNeighborhoodFamilyAggregates)
      .map((row) => ({
        ...row,
        meanPacketsPerCoveredRemoval: row.count / row.distinctPlacementCount,
      }))
      .sort((left, right) =>
        right.distinctPlacementCount - left.distinctPlacementCount ||
        right.distinctReplayCount - left.distinctReplayCount ||
        right.count - left.count
      ),
    placementRemovalPayloadDifferentials:
      serializePayloadDifferentials(placementRemovalDifferentials),
    removalSiblingPayloadDifferentials:
      serializePayloadDifferentials(removalSiblingDifferentials),
    spawnPacketCandidates: spawnPacketCandidates.slice(0, 200),
    coordinateCandidates: coordinateCandidates.slice(0, 200),
    strictCoordinateCandidates: coordinateCandidates.filter((candidate) =>
      candidate.opportunityCount >= args.minimumCandidateSupport &&
      candidate.inBoundsRate >= 0.95 && candidate.nearOwnerRate >= 0.9 &&
      candidate.closerThanMedianParticipantRate >= 0.8
    ),
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify({ totals: report.totals,
    strictCoordinateCandidateCount: report.strictCoordinateCandidates.length }, null, 2));
}

main();
