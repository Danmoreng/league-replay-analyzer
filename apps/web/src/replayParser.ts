export interface PlayerSummary {
  champion: string;
  riotIdGameName: string;
  riotIdTagLine: string;
  teamPosition: string;
  win: string;
  team: number;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalDamageToChampions: number;
  visionScore: number;
}

export interface ReplaySegmentSummary {
  id: number;
  type: string;
  length: number;
  chunkId: number;
  offset: number;
  headerOffset: number;
  payloadOffset: number;
  uncompressedLength: number;
  codec: string;
}

export interface ReplayContainerSummary {
  format: string;
  metadataSource: string;
  metadataOffset: number;
  metadataSize: number;
  payloadHeaderOffset: number;
  payloadHeaderSize: number;
  payloadOffset: number;
  matchId: number;
  keyframeCount: number;
  chunkCount: number;
  startupChunkEndId: number;
  gameStartChunkId: number;
  keyframeIntervalMillis: number;
  binaryHeaderPresent: boolean;
  payloadHeaderPresent: boolean;
  segmentTablePresent: boolean;
  segments: ReplaySegmentSummary[];
}

export interface ReplayCapabilities {
  metadataAvailable: boolean;
  playerStatsAvailable: boolean;
  binaryHeaderAvailable: boolean;
  payloadHeaderAvailable: boolean;
  segmentTableAvailable: boolean;
  payloadDecodingAvailable: boolean;
  movementTimelineAvailable: boolean;
}

export interface ReplaySummary {
  gameVersion: string;
  fileSize: number;
  gameLengthMillis: number;
  lastGameChunkId: number;
  lastKeyFrameId: number;
  playerCount: number;
  container: ReplayContainerSummary;
  capabilities: ReplayCapabilities;
  warnings: string[];
  players: PlayerSummary[];
  metadataJson: string;
}

const metadataMarker = new TextEncoder().encode('{"gameLength":');
const knownHeaderLength = 288;
const knownPayloadHeaderMinimumSize = 34;
const knownSegmentHeaderLength = 17;
const footerLengthFieldSize = 4;
const footerRecordHeaderLength = 17;

function findSubsequence(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) {
        continue outer;
      }
    }
    return offset;
  }

  return -1;
}

function scanGameVersion(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, 256);
  let ascii = "";
  for (let index = 0; index < limit; index += 1) {
    const value = bytes[index];
    ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : " ";
  }

  const match = ascii.match(/\d+\.\d+\.\d+\.\d+/);
  return match?.[0] ?? "unknown";
}

function extractBalancedJson(bytes: Uint8Array, startOffset: number): string {
  let inString = false;
  let escape = false;
  let depth = 0;

  for (let offset = startOffset; offset < bytes.length; offset += 1) {
    const ch = String.fromCharCode(bytes[offset]);

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return new TextDecoder().decode(bytes.slice(startOffset, offset + 1));
      }
    }
  }

  throw new Error("Could not extract embedded metadata JSON from replay.");
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 2 > bytes.length) {
    return null;
  }

  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }

  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function readU64LE(bytes: Uint8Array, offset: number): number | null {
  const lo = readU32LE(bytes, offset);
  const hi = readU32LE(bytes, offset + 4);
  if (lo === null || hi === null) {
    return null;
  }

  return hi * 2 ** 32 + lo;
}

function isRangeValid(offset: number, length: number, totalSize: number): boolean {
  return offset >= 0 && length >= 0 && offset + length <= totalSize;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10) || 0;
  }
  return 0;
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizePlayer(raw: Record<string, unknown>): PlayerSummary {
  return {
    champion: toText(raw.SKIN),
    riotIdGameName: toText(raw.RIOT_ID_GAME_NAME),
    riotIdTagLine: toText(raw.RIOT_ID_TAG_LINE),
    teamPosition: toText(raw.TEAM_POSITION),
    win: toText(raw.WIN),
    team: toNumber(raw.TEAM),
    kills: toNumber(raw.CHAMPIONS_KILLED),
    deaths: toNumber(raw.NUM_DEATHS),
    assists: toNumber(raw.ASSISTS),
    goldEarned: toNumber(raw.GOLD_EARNED),
    totalDamageToChampions: toNumber(raw.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
    visionScore: toNumber(raw.VISION_SCORE),
  };
}

function buildEmptyContainer(
  format: string,
  metadataSource: string,
  metadataOffset: number,
  metadataSize: number,
): ReplayContainerSummary {
  return {
    format,
    metadataSource,
    metadataOffset,
    metadataSize,
    payloadHeaderOffset: 0,
    payloadHeaderSize: 0,
    payloadOffset: 0,
    matchId: 0,
    keyframeCount: 0,
    chunkCount: 0,
    startupChunkEndId: 0,
    gameStartChunkId: 0,
    keyframeIntervalMillis: 0,
    binaryHeaderPresent: false,
    payloadHeaderPresent: false,
    segmentTablePresent: false,
    segments: [],
  };
}

function buildEmptyCapabilities(): ReplayCapabilities {
  return {
    metadataAvailable: false,
    playerStatsAvailable: false,
    binaryHeaderAvailable: false,
    payloadHeaderAvailable: false,
    segmentTableAvailable: false,
    payloadDecodingAvailable: false,
    movementTimelineAvailable: false,
  };
}

function tryParseClassicContainer(bytes: Uint8Array): ReplayContainerSummary | null {
  if (bytes.length < knownHeaderLength) {
    return null;
  }

  if (new TextDecoder().decode(bytes.slice(0, 4)) !== "RIOT") {
    return null;
  }

  const headerLength = readU16LE(bytes, 262);
  const metadataOffset = readU32LE(bytes, 268);
  const metadataSize = readU32LE(bytes, 272);
  const payloadHeaderOffset = readU32LE(bytes, 276);
  const payloadHeaderSize = readU32LE(bytes, 280);
  const payloadOffset = readU32LE(bytes, 284);

  if (
    headerLength !== knownHeaderLength ||
    metadataOffset === null ||
    metadataSize === null ||
    payloadHeaderOffset === null ||
    payloadHeaderSize === null ||
    payloadOffset === null ||
    metadataSize === 0 ||
    payloadHeaderSize < knownPayloadHeaderMinimumSize
  ) {
    return null;
  }

  if (
    !isRangeValid(metadataOffset, metadataSize, bytes.length) ||
    !isRangeValid(payloadHeaderOffset, payloadHeaderSize, bytes.length) ||
    payloadOffset > bytes.length ||
    metadataOffset < headerLength ||
    payloadHeaderOffset < metadataOffset ||
    payloadOffset < payloadHeaderOffset + payloadHeaderSize
  ) {
    return null;
  }

  const matchId = readU64LE(bytes, payloadHeaderOffset) ?? 0;
  const keyframeCount = readU32LE(bytes, payloadHeaderOffset + 12) ?? 0;
  const chunkCount = readU32LE(bytes, payloadHeaderOffset + 16) ?? 0;
  const startupChunkEndId = readU32LE(bytes, payloadHeaderOffset + 20) ?? 0;
  const gameStartChunkId = readU32LE(bytes, payloadHeaderOffset + 24) ?? 0;
  const keyframeIntervalMillis = readU32LE(bytes, payloadHeaderOffset + 28) ?? 0;
  const encryptionKeyLength = readU16LE(bytes, payloadHeaderOffset + 32) ?? 0;
  const payloadHeaderPresent =
    knownPayloadHeaderMinimumSize + encryptionKeyLength <= payloadHeaderSize;

  const segments: ReplaySegmentSummary[] = [];
  let segmentTablePresent = false;
  if (payloadHeaderPresent) {
    const segmentCount = keyframeCount + chunkCount;
    const tableSize = segmentCount * knownSegmentHeaderLength;
    if (isRangeValid(payloadOffset, tableSize, bytes.length)) {
      segmentTablePresent = true;
      for (let index = 0; index < segmentCount; index += 1) {
        const entryOffset = payloadOffset + index * knownSegmentHeaderLength;
        const id = readU32LE(bytes, entryOffset) ?? 0;
        const typeByte = bytes[entryOffset + 4] ?? 0;
        const length = readU32LE(bytes, entryOffset + 5) ?? 0;
        const chunkId = readU32LE(bytes, entryOffset + 9) ?? 0;
        const offset = readU32LE(bytes, entryOffset + 13) ?? 0;
        segments.push({
          id,
          type: typeByte === 1 ? "chunk" : typeByte === 2 ? "keyframe" : "unknown",
          length,
          chunkId,
          offset,
          headerOffset: entryOffset,
          payloadOffset: payloadOffset + tableSize + offset,
          uncompressedLength: 0,
          codec: "unknown",
        });
      }
    }
  }

  return {
    format: "classic-rofl",
    metadataSource: "binary-header",
    metadataOffset,
    metadataSize,
    payloadHeaderOffset,
    payloadHeaderSize,
    payloadOffset,
    matchId,
    keyframeCount,
    chunkCount,
    startupChunkEndId,
    gameStartChunkId,
    keyframeIntervalMillis,
    binaryHeaderPresent: true,
    payloadHeaderPresent,
    segmentTablePresent,
    segments,
  };
}

function extractFooterMetadata(
  bytes: Uint8Array,
): { offset: number; size: number; json: string } | null {
  const metadataSize = readU32LE(bytes, bytes.length - footerLengthFieldSize);
  if (metadataSize === null) {
    return null;
  }

  const metadataOffset = bytes.length - footerLengthFieldSize - metadataSize;
  if (!isRangeValid(metadataOffset, metadataSize, bytes.length) || bytes[metadataOffset] !== 0x7b) {
    return null;
  }

  const json = new TextDecoder().decode(bytes.slice(metadataOffset, metadataOffset + metadataSize));
  if (!json.startsWith('{"gameLength":')) {
    return null;
  }

  return { offset: metadataOffset, size: metadataSize, json };
}

function isZstdMagic(bytes: Uint8Array, offset: number): boolean {
  return (
    offset >= 0 &&
    offset + 4 <= bytes.length &&
    bytes[offset] === 0x28 &&
    bytes[offset + 1] === 0xb5 &&
    bytes[offset + 2] === 0x2f &&
    bytes[offset + 3] === 0xfd
  );
}

interface FooterZstdRecord {
  headerOffset: number;
  payloadOffset: number;
  id: number;
  relatedId: number;
  kind: number;
  uncompressedLength: number;
  compressedLength: number;
}

function parseFooterZstdContainer(
  bytes: Uint8Array,
  metadataOffset: number,
  metadataSize: number,
  lastGameChunkId: number,
  lastKeyFrameId: number,
): ReplayContainerSummary | null {
  const records: FooterZstdRecord[] = [];

  for (
    let payloadOffset = footerRecordHeaderLength;
    payloadOffset + 4 <= metadataOffset;
    payloadOffset += 1
  ) {
    if (!isZstdMagic(bytes, payloadOffset)) {
      continue;
    }

    const headerOffset = payloadOffset - footerRecordHeaderLength;
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

    const kind = bytes[headerOffset + 8] ?? 0;
    const uncompressedLength = readU32LE(bytes, headerOffset + 9) ?? 0;
    const compressedLength = readU32LE(bytes, headerOffset + 13) ?? 0;
    if (![1, 2, 3].includes(kind) || uncompressedLength <= 0 || compressedLength <= 0) {
      continue;
    }

    if (
      !isRangeValid(payloadOffset, compressedLength, metadataOffset) ||
      !isZstdMagic(bytes, payloadOffset)
    ) {
      continue;
    }

    records.push({
      headerOffset,
      payloadOffset,
      id: bytes[headerOffset] ?? 0,
      relatedId: bytes[headerOffset + 4] ?? 0,
      kind,
      uncompressedLength,
      compressedLength,
    });
  }

  records.sort((left, right) => left.headerOffset - right.headerOffset);
  const uniqueRecords = records.filter(
    (record, index) => index === 0 || record.headerOffset !== records[index - 1].headerOffset,
  );
  if (uniqueRecords.length === 0) {
    return null;
  }

  let chunkCount = 0;
  let keyframeCount = 0;
  let startupChunkEndId = 0;
  let gameStartChunkId = 0;
  let maxChunkId = 0;
  let maxKeyframeId = 0;

  const segments: ReplaySegmentSummary[] = uniqueRecords.map((record) => {
    let type = "startup";
    if (record.kind === 1) {
      type = "chunk";
      chunkCount += 1;
      maxChunkId = Math.max(maxChunkId, record.id);
      if (gameStartChunkId === 0) {
        gameStartChunkId = record.id;
      }
    } else if (record.kind === 2) {
      type = "keyframe";
      keyframeCount += 1;
      maxKeyframeId = Math.max(maxKeyframeId, record.id);
    } else {
      startupChunkEndId = Math.max(startupChunkEndId, record.relatedId);
    }

    return {
      id: record.id,
      type,
      length: record.compressedLength,
      chunkId: record.relatedId,
      offset: record.headerOffset,
      headerOffset: record.headerOffset,
      payloadOffset: record.payloadOffset,
      uncompressedLength: record.uncompressedLength,
      codec: "zstd",
    };
  });

  if (lastKeyFrameId > 0 && keyframeCount !== lastKeyFrameId) {
    return null;
  }
  if (lastGameChunkId > 0 && maxChunkId > 0 && maxChunkId !== lastGameChunkId) {
    return null;
  }
  if (lastKeyFrameId > 0 && maxKeyframeId > 0 && maxKeyframeId !== lastKeyFrameId) {
    return null;
  }

  return {
    format: "rofl2-like-footer",
    metadataSource: "footer-size",
    metadataOffset,
    metadataSize,
    payloadHeaderOffset: 0,
    payloadHeaderSize: 0,
    payloadOffset: uniqueRecords[0]?.headerOffset ?? 0,
    matchId: 0,
    keyframeCount,
    chunkCount,
    startupChunkEndId,
    gameStartChunkId: gameStartChunkId || (startupChunkEndId > 0 ? startupChunkEndId + 1 : 0),
    keyframeIntervalMillis: 0,
    binaryHeaderPresent: false,
    payloadHeaderPresent: false,
    segmentTablePresent: true,
    segments,
  };
}

export function parseReplayBuffer(buffer: ArrayBuffer): ReplaySummary {
  const bytes = new Uint8Array(buffer);
  const classicContainer = tryParseClassicContainer(bytes);

  let metadataJson = "";
  let container: ReplayContainerSummary;
  const capabilities = buildEmptyCapabilities();
  const warnings: string[] = [];

  if (classicContainer) {
    metadataJson = new TextDecoder().decode(
      bytes.slice(
        classicContainer.metadataOffset,
        classicContainer.metadataOffset + classicContainer.metadataSize,
      ),
    );
    container = classicContainer;
    capabilities.binaryHeaderAvailable = true;
    capabilities.payloadHeaderAvailable = classicContainer.payloadHeaderPresent;
    capabilities.segmentTableAvailable = classicContainer.segmentTablePresent;
  } else {
    const footerMetadata = extractFooterMetadata(bytes);
    if (footerMetadata) {
      metadataJson = footerMetadata.json;
      container = buildEmptyContainer(
        "rofl2-like-footer",
        "footer-size",
        footerMetadata.offset,
        footerMetadata.size,
      );
      warnings.push(
        "Metadata was recovered via footer size parsing after the known classic ROFL header layout did not validate.",
      );
    } else {
      const metadataOffset = findSubsequence(bytes, metadataMarker);
      if (metadataOffset === -1) {
        throw new Error("Could not locate embedded metadata JSON in replay.");
      }
      metadataJson = extractBalancedJson(bytes, metadataOffset);
      container = buildEmptyContainer(
        metadataOffset > bytes.length / 2 ? "footer-metadata-only" : "metadata-scanned",
        "marker-scan",
        metadataOffset,
        metadataJson.length,
      );
      warnings.push(
        "Known classic ROFL header fields were not recognized. Metadata was recovered by scanning for the embedded JSON block instead.",
      );
    }
  }

  const metadata = JSON.parse(metadataJson) as {
    gameLength?: number;
    lastGameChunkId?: number;
    lastKeyFrameId?: number;
    gameVersion?: string;
    statsJson?: string;
  };

  const players = metadata.statsJson
    ? (JSON.parse(metadata.statsJson) as Record<string, unknown>[]).map(normalizePlayer)
    : [];

  if (!classicContainer && container.metadataSource === "footer-size") {
    const footerContainer = parseFooterZstdContainer(
      bytes,
      container.metadataOffset,
      container.metadataSize,
      metadata.lastGameChunkId ?? 0,
      metadata.lastKeyFrameId ?? 0,
    );

    if (footerContainer) {
      container = footerContainer;
      capabilities.segmentTableAvailable = true;
      warnings.push(
        "Footer-style zstd records were indexed from the pre-metadata payload region. Payload decompression and packet decoding are not implemented yet.",
      );
    } else {
      warnings.push(
        "Payload header and segment table parsing are currently available only for the known classic ROFL layout. Payload decoding is not implemented yet.",
      );
    }
  } else if (!classicContainer) {
    warnings.push(
      "Payload header and segment table parsing are currently available only for the known classic ROFL layout. Payload decoding is not implemented yet.",
    );
  }

  capabilities.metadataAvailable = true;
  capabilities.playerStatsAvailable = players.length > 0;

  return {
    gameVersion: scanGameVersion(bytes) || metadata.gameVersion || "unknown",
    fileSize: bytes.length,
    gameLengthMillis: metadata.gameLength ?? 0,
    lastGameChunkId: metadata.lastGameChunkId ?? 0,
    lastKeyFrameId: metadata.lastKeyFrameId ?? 0,
    playerCount: players.length,
    container,
    capabilities,
    warnings,
    players,
    metadataJson,
  };
}
