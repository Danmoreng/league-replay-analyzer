import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Research-only Patch 16.9 ward-position analysis. Input is restricted to saved
// ROFL packet bytes. Saved Riot timeline frames are loaded only as an offline
// ranking/falsification oracle and are never copied into runtime decoder state.

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const VERSION_GROUP = "16.9";
const PACKETS = Object.freeze({
  ownerLong: 0x03d9,
  primary: 0x00d6,
  companion: 0x01ad,
  marker: 0x0041,
});
const PRIMARY_SYMBOL_OFFSETS = Object.freeze([13, 14, 15, 9, 10, 11]);
const COMPANION_SYMBOL_OFFSETS = Object.freeze([34, 36, 38, 42, 44, 46]);
const SYMBOL_ZERO = 0xd5;
const MAP_MIN = -250;
const MAP_MAX = 15250;

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "ward-multiview-positions-16.9.json"),
    replayId: null,
    oracleWindowMillis: 5000,
    neighborhoodRadius: 64,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index].replace("_", "-");
    } else if (arg === "--oracle-window-ms" && index + 1 < argv.length) {
      args.oracleWindowMillis = Number(argv[++index]);
    } else if (arg === "--neighborhood-radius" && index + 1 < argv.length) {
      args.neighborhoodRadius = Number(argv[++index]);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.oracleWindowMillis) || args.oracleWindowMillis < 0) {
    throw new Error("--oracle-window-ms must be a non-negative number.");
  }
  if (!Number.isInteger(args.neighborhoodRadius) || args.neighborhoodRadius < 8) {
    throw new Error("--neighborhood-radius must be an integer >= 8.");
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function discoverFixtures(args) {
  const apiRoot = path.resolve(args.apiRoot);
  if (!fs.existsSync(apiRoot)) throw new Error(`API fixture root not found: ${apiRoot}`);
  return fs.readdirSync(apiRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const replayId = entry.name.replace("_", "-");
      const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
      const matchPath = path.join(apiRoot, entry.name, "match.json");
      const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
      if (![replayPath, matchPath, timelinePath].every(fs.existsSync)) return null;
      const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
      return {
        replayId,
        replayPath,
        timelinePath,
        versionGroup: versionGroup(match.info?.gameVersion),
      };
    })
    .filter(Boolean)
    .filter((fixture) => fixture.versionGroup === VERSION_GROUP)
    .filter((fixture) => !args.replayId || fixture.replayId === args.replayId)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
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
      payloadOffset,
      compressedLength,
    });
  }
  return records.sort((left, right) => left.payloadOffset - right.payloadOffset);
}

function parsePacketStream(payload, record) {
  const blocks = [];
  let cursor = 0;
  let timestampSeconds = 0;
  let previousPacketType = 0;
  let previousBlockParam = 0;
  let blockIndex = 0;
  while (cursor < payload.length) {
    const marker = payload[cursor++];
    if (marker & 0x80) timestampSeconds += payload[cursor++] * 0.001;
    else {
      timestampSeconds = payload.readFloatLE(cursor);
      cursor += 4;
    }
    const contentLength = marker & 0x10 ? payload[cursor++] : payload.readUInt32LE(cursor);
    if (!(marker & 0x10)) cursor += 4;
    const packetType = marker & 0x40 ? previousPacketType : payload.readUInt16LE(cursor);
    if (!(marker & 0x40)) cursor += 2;
    const blockParam = marker & 0x20
      ? (previousBlockParam + payload.readInt8(cursor++)) >>> 0
      : payload.readUInt32LE(cursor);
    if (!(marker & 0x20)) cursor += 4;
    const endOffset = cursor + contentLength;
    if (endOffset > payload.length) {
      throw new Error(`Packet overrun in chunk ${record.chunkId}, block ${blockIndex}.`);
    }
    blocks.push({
      packetType,
      blockParam,
      contentLength,
      blockIndex,
      timestampMillis: Math.round(timestampSeconds * 1000),
      payload: Buffer.from(payload.subarray(cursor, endOffset)),
    });
    previousPacketType = packetType;
    previousBlockParam = blockParam;
    cursor = endOffset;
    blockIndex += 1;
  }
  return blocks;
}

function parseChunkSegments(replayPath) {
  const bytes = fs.readFileSync(replayPath);
  if (bytes.length < 4) throw new Error(`Replay is too small: ${replayPath}`);
  const metadataLength = bytes.readUInt32LE(bytes.length - 4);
  const metadataOffset = bytes.length - 4 - metadataLength;
  const records = findFooterRecords(bytes, metadataOffset).filter((record) => record.kind === 1);
  const segments = new Map();
  for (const record of records) {
    const decompressed = zlib.zstdDecompressSync(bytes.subarray(
      record.payloadOffset,
      record.payloadOffset + record.compressedLength,
    ));
    segments.set(
      `${record.segmentId}:${record.chunkId}`,
      parsePacketStream(decompressed, record),
    );
  }
  return segments;
}

function extractWards(cliPath, replayPath) {
  const result = spawnSync(cliPath, ["--extract-replay-wards-json", replayPath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return JSON.parse(result.stdout);
}

function nearestFrameOracle(timeline, participantId, timestampMillis, windowMillis) {
  let best = null;
  for (const frame of timeline.info?.frames ?? []) {
    const participant = frame.participantFrames?.[String(participantId)];
    const position = participant?.position;
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue;
    const deltaMillis = Math.abs((frame.timestamp ?? 0) - timestampMillis);
    if (deltaMillis > windowMillis || (best && best.deltaMillis <= deltaMillis)) continue;
    const otherPositions = Object.values(frame.participantFrames ?? {})
      .map((entry) => entry?.position)
      .filter((value) => Number.isFinite(value?.x) && Number.isFinite(value?.y));
    best = { x: position.x, y: position.y, deltaMillis, otherPositions };
  }
  return best;
}

function blocksNear(blocks, centerIndex, timestampMillis, radius) {
  return blocks.slice(
    Math.max(0, centerIndex - radius),
    Math.min(blocks.length, centerIndex + radius + 1),
  ).filter((block) => Math.abs(block.timestampMillis - timestampMillis) <= 1);
}

function decodeSymbolTriplet(payload, offsets) {
  if (!payload || offsets.some((offset) => offset >= payload.length)) return null;
  const bytes = offsets.map((offset) => payload[offset] ^ SYMBOL_ZERO);
  const value = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16)) >>> 0;
  return { value, bytes };
}

function decodeCompanionPosition(payload, divisor = 2) {
  const x = decodeSymbolTriplet(payload, COMPANION_SYMBOL_OFFSETS.slice(0, 3));
  const y = decodeSymbolTriplet(payload, COMPANION_SYMBOL_OFFSETS.slice(3, 6));
  if (!x || !y) return null;
  return {
    x: x.value / divisor,
    y: y.value / divisor,
    xRaw: x.value,
    yRaw: y.value,
    xBytes: x.bytes,
    yBytes: y.bytes,
  };
}

function inMap(position) {
  return position && position.x >= MAP_MIN && position.x <= MAP_MAX &&
    position.y >= MAP_MIN && position.y <= MAP_MAX;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(fraction * sorted.length)));
  return sorted[index];
}

function summarizeNumbers(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return { count: 0, mean: null, median: null, p95: null, min: null, max: null };
  return {
    count: finite.length,
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    median: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    min: Math.min(...finite),
    max: Math.max(...finite),
  };
}

function createSubstitutionEvidence(rows) {
  const forward = Array.from({ length: 256 }, () => new Uint32Array(256));
  const reverse = Array.from({ length: 256 }, () => new Uint32Array(256));
  let pairCount = 0;
  for (const row of rows) {
    for (let index = 0; index < PRIMARY_SYMBOL_OFFSETS.length; index += 1) {
      const primary = row.primary.payload[PRIMARY_SYMBOL_OFFSETS[index]];
      const companion = row.companion.payload[COMPANION_SYMBOL_OFFSETS[index]];
      forward[primary][companion] += 1;
      reverse[companion][primary] += 1;
      pairCount += 1;
    }
  }
  const mapping = [];
  let forwardConflictCount = 0;
  let reverseConflictCount = 0;
  for (let primary = 0; primary < 256; primary += 1) {
    const companions = [];
    for (let companion = 0; companion < 256; companion += 1) {
      if (forward[primary][companion] > 0) companions.push({ companion, count: forward[primary][companion] });
    }
    if (companions.length > 1) forwardConflictCount += 1;
    if (companions.length > 0) {
      companions.sort((left, right) => right.count - left.count || left.companion - right.companion);
      mapping.push({ primary, companion: companions[0].companion, support: companions[0].count });
    }
  }
  for (let companion = 0; companion < 256; companion += 1) {
    let primaryCount = 0;
    for (let primary = 0; primary < 256; primary += 1) {
      if (reverse[companion][primary] > 0) primaryCount += 1;
    }
    if (primaryCount > 1) reverseConflictCount += 1;
  }
  const lookup = new Int16Array(256).fill(-1);
  for (const entry of mapping) lookup[entry.primary] = entry.companion;
  return {
    lookup,
    report: {
      symbolPairCount: pairCount,
      observedPrimarySymbolCount: mapping.length,
      observedCompanionSymbolCount: new Set(mapping.map((entry) => entry.companion)).size,
      forwardConflictCount,
      reverseConflictCount,
      completePermutationObserved: mapping.length === 256 &&
        new Set(mapping.map((entry) => entry.companion)).size === 256 &&
        forwardConflictCount === 0 && reverseConflictCount === 0,
      mapping,
    },
  };
}

function decodePrimaryPosition(payload, substitution, divisor = 2) {
  if (!payload || PRIMARY_SYMBOL_OFFSETS.some((offset) => offset >= payload.length)) return null;
  const companionSymbols = PRIMARY_SYMBOL_OFFSETS.map((offset) => substitution[payload[offset]]);
  if (companionSymbols.some((symbol) => symbol < 0)) return null;
  const decoded = companionSymbols.map((symbol) => symbol ^ SYMBOL_ZERO);
  const xRaw = (decoded[0] | (decoded[1] << 8) | (decoded[2] << 16)) >>> 0;
  const yRaw = (decoded[3] | (decoded[4] << 8) | (decoded[5] << 16)) >>> 0;
  return { x: xRaw / divisor, y: yRaw / divisor, xRaw, yRaw };
}

function pairRemovalSpawns(blocks, removal, radius) {
  const centerIndex = removal.provenance.removalBlock.blockIndex;
  const nearby = blocksNear(blocks, centerIndex, removal.timestampMillis, radius);
  const primaries = nearby.filter((block) =>
    block.packetType === PACKETS.primary && block.contentLength >= 62 && block.contentLength <= 73 &&
    block.blockParam !== removal.wardEntityNetworkId && block.blockParam !== removal.killerNetworkId
  );
  const companions = nearby.filter((block) =>
    block.packetType === PACKETS.companion && block.contentLength === 63 &&
    block.blockParam !== removal.wardEntityNetworkId && block.blockParam !== removal.killerNetworkId
  );
  return primaries.flatMap((primary) => {
    const matches = companions.filter((companion) =>
      companion.blockParam === primary.blockParam &&
      companion.blockIndex > primary.blockIndex && companion.blockIndex - primary.blockIndex <= 6
    );
    return matches.length === 1 ? [{ primary, companion: matches[0] }] : [];
  });
}

function collectRows(args, fixtures) {
  const cliPath = path.resolve(args.cliPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const placements = [];
  const removalLinks = [];
  const replayRows = [];
  const rejection = {
    missingSegment: 0,
    ownerLongCardinality: 0,
    primaryCardinality: 0,
    companionCardinality: 0,
    sequenceOrder: 0,
  };

  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    console.log(`[${fixtureIndex + 1}/${fixtures.length}] ${fixture.replayId}`);
    const wardResult = extractWards(cliPath, fixture.replayPath);
    const lifecyclePlacements = wardResult.events.filter((event) => event.type === "WARD_PLACED");
    const lifecycleRemovals = wardResult.events.filter((event) => event.type === "WARD_KILL");
    const placementByWard = new Map();
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const segments = parseChunkSegments(fixture.replayPath);
    let exactSpawnSequenceCount = 0;
    let ownerLongSequenceCount = 0;
    let pairedRemovalSpawnCount = 0;

    for (const placement of lifecyclePlacements) {
      const marker = placement.provenance.markerBlock;
      const blocks = segments.get(`${marker.segmentId}:${marker.chunkId}`);
      if (!blocks) {
        rejection.missingSegment += 1;
        continue;
      }
      const nearby = blocksNear(
        blocks,
        marker.blockIndex,
        placement.timestampMillis,
        args.neighborhoodRadius,
      ).filter((block) => block.blockIndex < marker.blockIndex);
      const ownerLongs = nearby.filter((block) =>
        block.packetType === PACKETS.ownerLong &&
        block.blockParam === placement.ownerNetworkId &&
        block.contentLength >= 96 && block.contentLength <= 160
      );
      const primaries = nearby.filter((block) =>
        block.packetType === PACKETS.primary &&
        block.blockParam === placement.wardEntityNetworkId &&
        block.contentLength >= 62 && block.contentLength <= 73
      );
      const companions = nearby.filter((block) =>
        block.packetType === PACKETS.companion &&
        block.blockParam === placement.wardEntityNetworkId && block.contentLength === 63
      );
      if (ownerLongs.length !== 1) rejection.ownerLongCardinality += 1;
      if (primaries.length !== 1) {
        rejection.primaryCardinality += 1;
        continue;
      }
      if (companions.length !== 1) {
        rejection.companionCardinality += 1;
        continue;
      }
      const ownerLong = ownerLongs.length === 1 ? ownerLongs[0] : null;
      const primary = primaries[0];
      const companion = companions[0];
      if (!((!ownerLong || ownerLong.blockIndex < primary.blockIndex) &&
            primary.blockIndex < companion.blockIndex &&
            companion.blockIndex < marker.blockIndex)) {
        rejection.sequenceOrder += 1;
        continue;
      }
      const row = {
        replayId: fixture.replayId,
        wardEntityNetworkId: placement.wardEntityNetworkId,
        ownerParticipantId: placement.ownerParticipantId,
        ownerNetworkId: placement.ownerNetworkId,
        timestampMillis: placement.timestampMillis,
        ownerLong,
        primary,
        companion,
        marker: blocks[marker.blockIndex],
        oracle: nearestFrameOracle(
          timeline,
          placement.ownerParticipantId,
          placement.timestampMillis,
          args.oracleWindowMillis,
        ),
        removals: [],
      };
      placements.push(row);
      placementByWard.set(placement.wardEntityNetworkId, row);
      exactSpawnSequenceCount += 1;
      if (ownerLong) ownerLongSequenceCount += 1;
    }

    for (const removal of lifecycleRemovals) {
      const placement = placementByWard.get(removal.wardEntityNetworkId);
      if (!placement) continue;
      const marker = removal.provenance.removalBlock;
      const blocks = segments.get(`${marker.segmentId}:${marker.chunkId}`);
      if (!blocks) continue;
      const spawnPairs = pairRemovalSpawns(blocks, removal, args.neighborhoodRadius);
      const link = { replayId: fixture.replayId, placement, removal, spawnPairs };
      placement.removals.push(link);
      removalLinks.push(link);
      pairedRemovalSpawnCount += spawnPairs.length;
    }

    replayRows.push({
      replayId: fixture.replayId,
      lifecyclePlacementCount: lifecyclePlacements.length,
      exactSpawnSequenceCount,
      ownerLongSequenceCount,
      lifecycleRemovalCount: lifecycleRemovals.length,
      pairedRemovalSpawnCount,
    });
  }
  return { placements, removalLinks, replayRows, rejection };
}

function scoreCoordinateDivisors(rows) {
  const candidates = [];
  for (const divisor of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
    const positions = rows.map((row) => decodeCompanionPosition(row.companion.payload, divisor));
    const oracleDistances = [];
    const shuffledDistances = [];
    let inBoundsCount = 0;
    let highByteZeroCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const position = positions[index];
      if (inMap(position)) inBoundsCount += 1;
      if (position && position.xBytes[2] === 0 && position.yBytes[2] === 0) {
        highByteZeroCount += 1;
      }
      if (!row.oracle || !position) continue;
      oracleDistances.push(Math.hypot(position.x - row.oracle.x, position.y - row.oracle.y));
      let shuffledIndex = (index + 97) % rows.length;
      while (rows[shuffledIndex].replayId !== row.replayId && shuffledIndex !== index) {
        shuffledIndex = (shuffledIndex + 1) % rows.length;
      }
      const shuffled = positions[shuffledIndex];
      if (shuffled) shuffledDistances.push(
        Math.hypot(shuffled.x - row.oracle.x, shuffled.y - row.oracle.y),
      );
    }
    candidates.push({
      id: `COMPANION-XOR-D5-STRIDE2-U24LE-DIV${divisor}`,
      divisor,
      inBoundsCount,
      inBoundsRate: inBoundsCount / rows.length,
      zeroHighBytePairCount: highByteZeroCount,
      zeroHighBytePairRate: highByteZeroCount / rows.length,
      ownerOracleDistance: summarizeNumbers(oracleDistances),
      shuffledOwnerOracleDistance: summarizeNumbers(shuffledDistances),
    });
  }
  return candidates.sort((left, right) =>
    right.inBoundsRate - left.inBoundsRate ||
    (left.ownerOracleDistance.mean ?? Infinity) - (right.ownerOracleDistance.mean ?? Infinity)
  );
}

function scorePrimaryCompanionAgreement(rows, substitution) {
  let exactRawPairCount = 0;
  let decodedCount = 0;
  const distances = [];
  for (const row of rows) {
    const primary = decodePrimaryPosition(row.primary.payload, substitution, 2);
    const companion = decodeCompanionPosition(row.companion.payload, 2);
    if (!primary || !companion) continue;
    decodedCount += 1;
    if (primary.xRaw === companion.xRaw && primary.yRaw === companion.yRaw) exactRawPairCount += 1;
    distances.push(Math.hypot(primary.x - companion.x, primary.y - companion.y));
  }
  return {
    decodedCount,
    exactRawPairCount,
    exactRawPairRate: decodedCount > 0 ? exactRawPairCount / decodedCount : null,
    distance: summarizeNumbers(distances),
  };
}

function scoreRemovalAgreement(links, substitution) {
  let linkCountWithSpawn = 0;
  let candidateCount = 0;
  let candidateExactCompanionCount = 0;
  let candidateExactPrimaryCount = 0;
  let allCandidatesExactCount = 0;
  let anyCandidateExactCount = 0;
  let twoCandidateLinkCount = 0;
  let twoCandidateBothExactCount = 0;
  let shuffledCandidateExactCount = 0;
  let shuffledCandidateOpportunityCount = 0;
  const candidateDistances = [];
  const candidatesPerLink = [];
  const linksByReplay = new Map();
  for (const link of links) {
    const list = linksByReplay.get(link.replayId) ?? [];
    list.push(link);
    linksByReplay.set(link.replayId, list);
  }
  for (const link of links) {
    const placedCompanion = decodeCompanionPosition(link.placement.companion.payload, 2);
    const placedPrimary = decodePrimaryPosition(link.placement.primary.payload, substitution, 2);
    if (!placedCompanion || !placedPrimary || link.spawnPairs.length === 0) continue;
    linkCountWithSpawn += 1;
    candidatesPerLink.push(link.spawnPairs.length);
    let exactInLink = 0;
    for (const pair of link.spawnPairs) {
      const removedCompanion = decodeCompanionPosition(pair.companion.payload, 2);
      const removedPrimary = decodePrimaryPosition(pair.primary.payload, substitution, 2);
      if (!removedCompanion || !removedPrimary) continue;
      candidateCount += 1;
      const companionExact = placedCompanion.xRaw === removedCompanion.xRaw &&
        placedCompanion.yRaw === removedCompanion.yRaw;
      const primaryExact = placedPrimary.xRaw === removedPrimary.xRaw &&
        placedPrimary.yRaw === removedPrimary.yRaw;
      if (companionExact) {
        candidateExactCompanionCount += 1;
        exactInLink += 1;
      }
      if (primaryExact) candidateExactPrimaryCount += 1;
      candidateDistances.push(Math.hypot(
        placedCompanion.x - removedCompanion.x,
        placedCompanion.y - removedCompanion.y,
      ));
    }
    if (exactInLink > 0) anyCandidateExactCount += 1;
    if (exactInLink === link.spawnPairs.length) allCandidatesExactCount += 1;
    if (link.spawnPairs.length === 2) {
      twoCandidateLinkCount += 1;
      if (exactInLink === 2) twoCandidateBothExactCount += 1;
    }

    const replayLinks = linksByReplay.get(link.replayId) ?? [];
    if (replayLinks.length > 1) {
      const ownIndex = replayLinks.indexOf(link);
      const shuffledPlacement = replayLinks[(ownIndex + 1) % replayLinks.length].placement;
      const shuffled = decodeCompanionPosition(shuffledPlacement.companion.payload, 2);
      if (shuffled) {
        for (const pair of link.spawnPairs) {
          const removed = decodeCompanionPosition(pair.companion.payload, 2);
          if (!removed) continue;
          shuffledCandidateOpportunityCount += 1;
          if (shuffled.xRaw === removed.xRaw && shuffled.yRaw === removed.yRaw) {
            shuffledCandidateExactCount += 1;
          }
        }
      }
    }
  }
  return {
    linkedRemovalCount: links.length,
    linkCountWithSpawn,
    candidatesPerLink: summarizeNumbers(candidatesPerLink),
    candidateCount,
    candidateExactCompanionCount,
    candidateExactCompanionRate: candidateCount > 0 ? candidateExactCompanionCount / candidateCount : null,
    candidateExactPrimaryCount,
    candidateExactPrimaryRate: candidateCount > 0 ? candidateExactPrimaryCount / candidateCount : null,
    anyCandidateExactLinkCount: anyCandidateExactCount,
    allCandidatesExactLinkCount: allCandidatesExactCount,
    twoCandidateLinkCount,
    twoCandidateBothExactCount,
    placementToRemovalDistance: summarizeNumbers(candidateDistances),
    shuffledCandidateOpportunityCount,
    shuffledCandidateExactCount,
    shuffledCandidateExactRate: shuffledCandidateOpportunityCount > 0
      ? shuffledCandidateExactCount / shuffledCandidateOpportunityCount
      : null,
  };
}

function byteRelationScore(rows, readSource, readTarget) {
  const forward = new Map();
  const reverse = new Map();
  let count = 0;
  for (const row of rows) {
    const source = readSource(row);
    const target = readTarget(row);
    if (!Number.isInteger(source) || !Number.isInteger(target)) continue;
    const targets = forward.get(source) ?? new Uint32Array(256);
    targets[target] += 1;
    forward.set(source, targets);
    const sources = reverse.get(target) ?? new Uint32Array(256);
    sources[source] += 1;
    reverse.set(target, sources);
    count += 1;
  }
  const majority = (map) => [...map.values()].reduce((sum, counts) => {
    let best = 0;
    for (const value of counts) best = Math.max(best, value);
    return sum + best;
  }, 0);
  return {
    count,
    distinctSourceCount: forward.size,
    distinctTargetCount: reverse.size,
    forwardAccuracy: count > 0 ? majority(forward) / count : 0,
    reverseAccuracy: count > 0 ? majority(reverse) / count : 0,
  };
}

function leaveOneReplayOutRelation(rows, readSource, readTarget) {
  let opportunityCount = 0;
  let coveredCount = 0;
  let correctCount = 0;
  const replayIds = [...new Set(rows.map((row) => row.replayId))];
  for (const replayId of replayIds) {
    const counts = new Map();
    for (const row of rows) {
      if (row.replayId === replayId) continue;
      const source = readSource(row);
      const target = readTarget(row);
      if (!Number.isInteger(source) || !Number.isInteger(target)) continue;
      const targets = counts.get(source) ?? new Uint32Array(256);
      targets[target] += 1;
      counts.set(source, targets);
    }
    const mapping = new Map();
    for (const [source, targets] of counts) {
      let bestTarget = 0;
      let bestCount = -1;
      for (let target = 0; target < 256; target += 1) {
        if (targets[target] > bestCount) {
          bestTarget = target;
          bestCount = targets[target];
        }
      }
      mapping.set(source, bestTarget);
    }
    for (const row of rows) {
      if (row.replayId !== replayId) continue;
      const source = readSource(row);
      const target = readTarget(row);
      if (!Number.isInteger(source) || !Number.isInteger(target)) continue;
      opportunityCount += 1;
      if (!mapping.has(source)) continue;
      coveredCount += 1;
      if (mapping.get(source) === target) correctCount += 1;
    }
  }
  return {
    opportunityCount,
    coveredCount,
    coverageRate: opportunityCount > 0 ? coveredCount / opportunityCount : null,
    correctCount,
    accuracy: coveredCount > 0 ? correctCount / coveredCount : null,
  };
}

function shuffledRows(rows) {
  const byReplay = new Map();
  for (const row of rows) {
    const list = byReplay.get(row.replayId) ?? [];
    list.push(row);
    byReplay.set(row.replayId, list);
  }
  const targetByRow = new Map();
  for (const list of byReplay.values()) {
    for (let index = 0; index < list.length; index += 1) {
      targetByRow.set(list[index], list[(index + 17) % list.length]);
    }
  }
  return targetByRow;
}

function scanOwnerLongRelations(rows) {
  const minimumLength = Math.min(...rows.map((row) => row.ownerLong.payload.length));
  const shuffled = shuffledRows(rows);
  const targets = COMPANION_SYMBOL_OFFSETS.map((offset, targetIndex) => ({ offset, targetIndex }));
  const ranked = [];
  for (const alignment of ["start", "end"]) {
    for (let position = 0; position < minimumLength; position += 1) {
      const readSource = alignment === "start"
        ? (row) => row.ownerLong.payload[position]
        : (row) => row.ownerLong.payload[row.ownerLong.payload.length - 1 - position];
      for (const target of targets) {
        const readTarget = (row) => row.companion.payload[target.offset];
        const trueScore = byteRelationScore(rows, readSource, readTarget);
        const shuffledScore = byteRelationScore(
          rows,
          readSource,
          (row) => readTarget(shuffled.get(row)),
        );
        const minimumAccuracy = Math.min(trueScore.forwardAccuracy, trueScore.reverseAccuracy);
        const shuffledMinimumAccuracy = Math.min(
          shuffledScore.forwardAccuracy,
          shuffledScore.reverseAccuracy,
        );
        ranked.push({
          alignment,
          offset: alignment === "start" ? position : -1 - position,
          targetCompanionOffset: target.offset,
          targetAxis: target.targetIndex < 3 ? "x" : "y",
          targetByteIndex: target.targetIndex % 3,
          ...trueScore,
          minimumBijectiveAccuracy: minimumAccuracy,
          shuffledMinimumBijectiveAccuracy: shuffledMinimumAccuracy,
          trueMinusShuffledAccuracy: minimumAccuracy - shuffledMinimumAccuracy,
          leaveOneReplayOut: null,
        });
      }
    }
  }
  ranked.sort((left, right) =>
    right.trueMinusShuffledAccuracy - left.trueMinusShuffledAccuracy ||
    right.minimumBijectiveAccuracy - left.minimumBijectiveAccuracy ||
    right.distinctTargetCount - left.distinctTargetCount
  );
  for (const candidate of ranked.slice(0, 32)) {
    const readSource = candidate.alignment === "start"
      ? (row) => row.ownerLong.payload[candidate.offset]
      : (row) => row.ownerLong.payload[row.ownerLong.payload.length + candidate.offset];
    const readTarget = (row) => row.companion.payload[candidate.targetCompanionOffset];
    candidate.leaveOneReplayOut = leaveOneReplayOutRelation(rows, readSource, readTarget);
  }
  return {
    minimumPayloadLength: minimumLength,
    testedRelationCount: ranked.length,
    topRelations: ranked.slice(0, 32),
  };
}

function markersByReplay(rows, substitution) {
  const grouped = {};
  for (const row of rows) {
    const companion = decodeCompanionPosition(row.companion.payload, 2);
    const primary = decodePrimaryPosition(row.primary.payload, substitution, 2);
    const removalCandidates = row.removals.flatMap((link) =>
      link.spawnPairs.map((pair) => {
        const position = decodeCompanionPosition(pair.companion.payload, 2);
        return {
          removalTimestampMillis: link.removal.timestampMillis,
          removalEntityNetworkId: pair.companion.blockParam,
          x: position?.x ?? null,
          y: position?.y ?? null,
          exactPlacementMatch: Boolean(position && companion &&
            position.xRaw === companion.xRaw && position.yRaw === companion.yRaw),
        };
      })
    );
    const marker = {
      wardEntityNetworkId: row.wardEntityNetworkId,
      ownerParticipantId: row.ownerParticipantId,
      timestampMillis: row.timestampMillis,
      candidate: companion ? {
        x: companion.x,
        y: companion.y,
        inBounds: inMap(companion),
        formula: "x/y = u24le(companion[stride-2 lanes] XOR 0xD5) / 2",
      } : null,
      primaryCrossCheckExact: Boolean(companion && primary &&
        companion.xRaw === primary.xRaw && companion.yRaw === primary.yRaw),
      removalCandidates,
    };
    (grouped[row.replayId] ??= []).push(marker);
  }
  return grouped;
}

function main() {
  const args = parseArgs(process.argv);
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No matching Patch 16.9 fixtures found.");
  const collected = collectRows(args, fixtures);
  if (collected.placements.length === 0) throw new Error("No exact placement sequences found.");
  const substitution = createSubstitutionEvidence(collected.placements);
  const divisorScores = scoreCoordinateDivisors(collected.placements);
  const primaryCompanionAgreement = scorePrimaryCompanionAgreement(
    collected.placements,
    substitution.lookup,
  );
  const removalAgreement = scoreRemovalAgreement(
    collected.removalLinks,
    substitution.lookup,
  );
  const ownerLongRelations = scanOwnerLongRelations(collected.placements);
  const best = divisorScores.find((candidate) => candidate.divisor === 2);
  const report = {
    schema: "rofl-ward-position-multiview-research/v1",
    generatedAtUtc: new Date().toISOString(),
    researchOnly: true,
    promotionGate: false,
    positionAvailable: false,
    source: {
      runtimeInput: "saved-rofl-packet-bytes-only",
      offlineRiotFixtureInput: true,
      clientBinaryInput: false,
      leagueInstallationInput: false,
      vanguardInput: false,
    },
    warning: "Candidate positions are research output. Visual plausibility can falsify but cannot promote them.",
    parameters: { ...args, versionGroup: VERSION_GROUP },
    packetProfile: {
      ownerLongPacketType: PACKETS.ownerLong,
      ownerLongPacketTypeHex: "0x03D9",
      primaryPacketType: PACKETS.primary,
      primaryPacketTypeHex: "0x00D6",
      companionPacketType: PACKETS.companion,
      companionPacketTypeHex: "0x01AD",
      placementMarkerPacketType: PACKETS.marker,
      placementMarkerPacketTypeHex: "0x0041",
      strictOrder: ["owner-long", "primary", "companion", "placement-marker"],
    },
    totals: {
      replayCount: fixtures.length,
      lifecyclePlacementCount: collected.replayRows.reduce(
        (sum, row) => sum + row.lifecyclePlacementCount, 0,
      ),
      exactPlacementSequenceCount: collected.placements.length,
      oraclePlacementCount: collected.placements.filter((row) => row.oracle).length,
      linkedRemovalCount: collected.removalLinks.length,
      pairedRemovalSpawnCount: collected.replayRows.reduce(
        (sum, row) => sum + row.pairedRemovalSpawnCount, 0,
      ),
    },
    sequenceRejections: collected.rejection,
    replayRows: collected.replayRows,
    relativeSubstitution: substitution.report,
    coordinateModel: {
      candidateId: "COMPANION-XOR-D5-STRIDE2-U24LE-DIV2",
      xSourceOffsets: [34, 36, 38],
      ySourceOffsets: [42, 44, 46],
      symbolZeroXor: SYMBOL_ZERO,
      fixedPointDivisor: 2,
      primarySourceOffsets: PRIMARY_SYMBOL_OFFSETS,
      bestCandidateScore: best,
      divisorFalsificationScores: divisorScores,
      primaryCompanionAgreement,
    },
    placementRemovalInvariant: removalAgreement,
    ownerLongRelationScan: ownerLongRelations,
    markersByReplay: markersByReplay(collected.placements, substitution.lookup),
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify({
    totals: report.totals,
    completeSubstitution: report.relativeSubstitution.completePermutationObserved,
    coordinateCandidate: report.coordinateModel.bestCandidateScore,
    primaryCompanionAgreement,
    placementRemovalInvariant: removalAgreement,
    ownerLongTopRelations: ownerLongRelations.topRelations.slice(0, 8),
  }, null, 2));
}

main();
