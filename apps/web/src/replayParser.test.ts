import { describe, expect, it } from "vite-plus/test";

import { parseReplayBuffer } from "./replayParser";

function writeU16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeU64LE(bytes: Uint8Array, offset: number, value: bigint): void {
  writeU32LE(bytes, offset, Number(value & 0xffffffffn));
  writeU32LE(bytes, offset + 4, Number((value >> 32n) & 0xffffffffn));
}

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    bytes[offset + index] = text.charCodeAt(index);
  }
}

function writeZstdRecordHeader(
  bytes: Uint8Array,
  offset: number,
  id: number,
  relatedId: number,
  kind: number,
  uncompressedLength: number,
  compressedLength: number,
): void {
  bytes[offset] = id;
  bytes[offset + 4] = relatedId;
  bytes[offset + 8] = kind;
  writeU32LE(bytes, offset + 9, uncompressedLength);
  writeU32LE(bytes, offset + 13, compressedLength);
}

function writeZstdPayload(bytes: Uint8Array, offset: number, compressedLength: number): void {
  bytes[offset] = 0x28;
  bytes[offset + 1] = 0xb5;
  bytes[offset + 2] = 0x2f;
  bytes[offset + 3] = 0xfd;
  for (let index = 4; index < compressedLength; index += 1) {
    bytes[offset + index] = (offset + index) & 0xff;
  }
}

function buildClassicFixture(
  options: { version?: string; invalidLevel?: boolean } = {},
): ArrayBuffer {
  const metadata =
    '{"gameLength":123456,"lastGameChunkId":66,"lastKeyFrameId":32,"statsJson":"[{\\"TEAM\\":\\"100\\",\\"SKIN\\":\\"Ornn\\",\\"RIOT_ID_GAME_NAME\\":\\"TheBearinator\\",\\"RIOT_ID_TAG_LINE\\":\\"BABBA\\",\\"TEAM_POSITION\\":\\"TOP\\",\\"WIN\\":\\"Win\\",\\"CHAMPIONS_KILLED\\":\\"3\\",\\"NUM_DEATHS\\":\\"7\\",\\"ASSISTS\\":\\"6\\",\\"LEVEL\\":\\"16\\",\\"EXP\\":\\"18423\\",\\"MINIONS_KILLED\\":\\"211\\",\\"NEUTRAL_MINIONS_KILLED\\":\\"17\\",\\"ITEM0\\":\\"3078\\",\\"ITEM1\\":\\"3110\\",\\"ITEM2\\":\\"0\\",\\"ITEM3\\":\\"3047\\",\\"ITEM4\\":\\"2504\\",\\"ITEM5\\":\\"3065\\",\\"ITEM6\\":\\"3340\\",\\"GOLD_EARNED\\":\\"10373\\",\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\":\\"27239\\",\\"VISION_SCORE\\":\\"17\\",\\"WARD_PLACED\\":\\"9\\",\\"WARD_KILLED\\":\\"3\\"}]"}'.replace(
      '\\"LEVEL\\":\\"16\\"',
      `\\"LEVEL\\":\\"${options.invalidLevel ? "xx" : "16"}\\"`,
    );
  const encryptedKey = "QUJDREVGR0g=";

  const metadataOffset = 288;
  const payloadHeaderOffset = metadataOffset + metadata.length;
  const payloadHeaderSize = 34 + encryptedKey.length;
  const payloadOffset = payloadHeaderOffset + payloadHeaderSize;
  const bytes = new Uint8Array(payloadOffset + 17);

  writeAscii(bytes, 0, "RIOT");
  bytes[4] = 0x02;
  bytes[5] = 0x00;
  writeAscii(bytes, 16, options.version ?? "16.5.752.7101");

  writeU16LE(bytes, 262, 288);
  writeU32LE(bytes, 264, bytes.length);
  writeU32LE(bytes, 268, metadataOffset);
  writeU32LE(bytes, 272, metadata.length);
  writeU32LE(bytes, 276, payloadHeaderOffset);
  writeU32LE(bytes, 280, payloadHeaderSize);
  writeU32LE(bytes, 284, payloadOffset);

  writeAscii(bytes, metadataOffset, metadata);

  writeU64LE(bytes, payloadHeaderOffset, 7779216102n);
  writeU32LE(bytes, payloadHeaderOffset + 8, 123456);
  writeU32LE(bytes, payloadHeaderOffset + 12, 0);
  writeU32LE(bytes, payloadHeaderOffset + 16, 1);
  writeU32LE(bytes, payloadHeaderOffset + 20, 0);
  writeU32LE(bytes, payloadHeaderOffset + 24, 1);
  writeU32LE(bytes, payloadHeaderOffset + 28, 30000);
  writeU16LE(bytes, payloadHeaderOffset + 32, encryptedKey.length);
  writeAscii(bytes, payloadHeaderOffset + 34, encryptedKey);

  writeU32LE(bytes, payloadOffset, 1);
  bytes[payloadOffset + 4] = 1;
  writeU32LE(bytes, payloadOffset + 5, 100);
  writeU32LE(bytes, payloadOffset + 9, 0);
  writeU32LE(bytes, payloadOffset + 13, 0);

  return bytes.buffer;
}

function buildFooterFixture(): ArrayBuffer {
  const metadata =
    '{"gameLength":1895012,"lastGameChunkId":66,"lastKeyFrameId":32,"statsJson":"[]"}';
  const bytes = new Uint8Array(64 + metadata.length + 4);

  writeAscii(bytes, 0, "RIOT");
  bytes[4] = 0x02;
  bytes[5] = 0x00;
  writeAscii(bytes, 16, "16.5.752.7101");

  const metadataOffset = bytes.length - 4 - metadata.length;
  writeAscii(bytes, metadataOffset, metadata);
  writeU32LE(bytes, bytes.length - 4, metadata.length);

  return bytes.buffer;
}

function buildFooterZstdFixture(): ArrayBuffer {
  const metadata = '{"gameLength":240000,"lastGameChunkId":4,"lastKeyFrameId":1,"statsJson":"[]"}';

  const startupHeader = 28;
  const startupCompressed = 12;
  const startupPayload = startupHeader + 17;
  const keyframeHeader = startupPayload + startupCompressed;
  const keyframeCompressed = 14;
  const keyframePayload = keyframeHeader + 17;
  const chunk3Header = keyframePayload + keyframeCompressed;
  const chunk3Compressed = 16;
  const chunk3Payload = chunk3Header + 17;
  const chunk4Header = chunk3Payload + chunk3Compressed;
  const chunk4Compressed = 10;
  const chunk4Payload = chunk4Header + 17;
  const metadataOffset = chunk4Payload + chunk4Compressed;
  const bytes = new Uint8Array(metadataOffset + metadata.length + 4);

  writeAscii(bytes, 0, "RIOT");
  bytes[4] = 0x02;
  bytes[5] = 0x00;
  writeAscii(bytes, 16, "16.5.752.7101");

  writeZstdRecordHeader(bytes, startupHeader, 1, 2, 3, 64, startupCompressed);
  writeZstdPayload(bytes, startupPayload, startupCompressed);

  writeZstdRecordHeader(bytes, keyframeHeader, 1, 3, 2, 80, keyframeCompressed);
  writeZstdPayload(bytes, keyframePayload, keyframeCompressed);

  writeZstdRecordHeader(bytes, chunk3Header, 3, 4, 1, 96, chunk3Compressed);
  writeZstdPayload(bytes, chunk3Payload, chunk3Compressed);

  writeZstdRecordHeader(bytes, chunk4Header, 4, 5, 1, 48, chunk4Compressed);
  writeZstdPayload(bytes, chunk4Payload, chunk4Compressed);

  writeAscii(bytes, metadataOffset, metadata);
  writeU32LE(bytes, bytes.length - 4, metadata.length);

  return bytes.buffer;
}

describe("parseReplayBuffer", () => {
  it("parses classic ROFL container fields and player stats", () => {
    const summary = parseReplayBuffer(buildClassicFixture());

    expect(summary.gameVersion).toBe("16.5.752.7101");
    expect(summary.gameLengthMillis).toBe(123456);
    expect(summary.lastGameChunkId).toBe(66);
    expect(summary.lastKeyFrameId).toBe(32);
    expect(summary.playerCount).toBe(1);
    expect(summary.container).toMatchObject({
      format: "classic-rofl",
      metadataSource: "binary-header",
      binaryHeaderPresent: true,
      payloadHeaderPresent: true,
      segmentTablePresent: true,
      matchId: 7779216102,
      chunkCount: 1,
    });
    expect(summary.capabilities).toMatchObject({
      metadataAvailable: true,
      playerStatsAvailable: true,
      validatedFinalPlayerStatsAvailable: true,
      binaryHeaderAvailable: true,
      payloadHeaderAvailable: true,
      segmentTableAvailable: true,
    });
    expect(summary.container.segments[0]).toMatchObject({
      id: 1,
      type: "chunk",
      length: 100,
      chunkId: 0,
      offset: 0,
      headerOffset: summary.container.payloadOffset,
      payloadOffset: summary.container.payloadOffset + 17,
      uncompressedLength: 0,
      codec: "unknown",
    });
    expect(summary.players[0]).toMatchObject({
      level: 16,
      experience: 18423,
      laneMinionsKilled: 211,
      neutralMinionsKilled: 17,
      items: [3078, 3110, 0, 3047, 2504, 3065, 3340],
      wardsPlaced: 9,
      wardsKilled: 3,
    });
  });

  it("does not promote complete final player stats outside validated patch groups", () => {
    const summary = parseReplayBuffer(buildClassicFixture({ version: "16.4.752.7101" }));

    expect(summary.capabilities.validatedFinalPlayerStatsAvailable).toBe(false);
  });

  it.each(["15.22", "15.23", "15.24", "16.1", "16.5", "16.6", "16.7", "16.9"])(
    "promotes complete integer final player stats for validated patch group %s",
    (versionGroup) => {
      const summary = parseReplayBuffer(
        buildClassicFixture({ version: `${versionGroup}.752.7101` }),
      );

      expect(summary.capabilities.validatedFinalPlayerStatsAvailable).toBe(true);
    },
  );

  it("does not promote final player stats when any required raw field is not an integer", () => {
    const summary = parseReplayBuffer(buildClassicFixture({ invalidLevel: true }));

    expect(summary.players[0].level).toBe(0);
    expect(summary.capabilities.validatedFinalPlayerStatsAvailable).toBe(false);
  });

  it("parses footer-sized metadata fallback when classic header layout is absent", () => {
    const summary = parseReplayBuffer(buildFooterFixture());

    expect(summary.container).toMatchObject({
      format: "rofl2-like-footer",
      metadataSource: "footer-size",
      binaryHeaderPresent: false,
      payloadHeaderPresent: false,
      segmentTablePresent: false,
    });
    expect(summary.capabilities).toMatchObject({
      metadataAvailable: true,
      playerStatsAvailable: false,
      validatedFinalPlayerStatsAvailable: false,
      binaryHeaderAvailable: false,
      payloadHeaderAvailable: false,
      segmentTableAvailable: false,
    });
    expect(summary.warnings[0]).toContain("footer size parsing");
    expect(summary.gameLengthMillis).toBe(1895012);
  });

  it("indexes footer-style zstd records into startup, keyframe, and chunk segments", () => {
    const summary = parseReplayBuffer(buildFooterZstdFixture());

    expect(summary.container).toMatchObject({
      format: "rofl2-like-footer",
      metadataSource: "footer-size",
      payloadOffset: 28,
      segmentTablePresent: true,
      startupChunkEndId: 2,
      gameStartChunkId: 3,
      keyframeCount: 1,
      chunkCount: 2,
    });
    expect(summary.capabilities).toMatchObject({
      metadataAvailable: true,
      binaryHeaderAvailable: false,
      payloadHeaderAvailable: false,
      segmentTableAvailable: true,
    });
    expect(summary.container.segments).toHaveLength(4);
    expect(summary.container.segments[0]).toMatchObject({
      id: 1,
      type: "startup",
      chunkId: 2,
      payloadOffset: 45,
      uncompressedLength: 64,
      codec: "zstd",
    });
    expect(summary.container.segments[1]).toMatchObject({
      id: 1,
      type: "keyframe",
      chunkId: 3,
      codec: "zstd",
    });
    expect(summary.container.segments[2]).toMatchObject({
      id: 3,
      type: "chunk",
      chunkId: 4,
      codec: "zstd",
    });
    expect(summary.warnings.at(-1)).toContain("Footer-style zstd records were indexed");
  });
});
