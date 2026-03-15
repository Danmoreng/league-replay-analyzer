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

function buildClassicFixture(): ArrayBuffer {
  const metadata =
    '{"gameLength":123456,"lastGameChunkId":66,"lastKeyFrameId":32,"statsJson":"[{\\"TEAM\\":\\"100\\",\\"SKIN\\":\\"Ornn\\",\\"RIOT_ID_GAME_NAME\\":\\"TheBearinator\\",\\"RIOT_ID_TAG_LINE\\":\\"BABBA\\",\\"TEAM_POSITION\\":\\"TOP\\",\\"WIN\\":\\"Win\\",\\"CHAMPIONS_KILLED\\":\\"3\\",\\"NUM_DEATHS\\":\\"7\\",\\"ASSISTS\\":\\"6\\",\\"GOLD_EARNED\\":\\"10373\\",\\"TOTAL_DAMAGE_DEALT_TO_CHAMPIONS\\":\\"27239\\",\\"VISION_SCORE\\":\\"17\\"}]"}';
  const encryptedKey = "QUJDREVGR0g=";

  const metadataOffset = 288;
  const payloadHeaderOffset = metadataOffset + metadata.length;
  const payloadHeaderSize = 34 + encryptedKey.length;
  const payloadOffset = payloadHeaderOffset + payloadHeaderSize;
  const bytes = new Uint8Array(payloadOffset + 17);

  writeAscii(bytes, 0, "RIOT");
  bytes[4] = 0x02;
  bytes[5] = 0x00;
  writeAscii(bytes, 16, "16.5.752.7101");

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
    });
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
      binaryHeaderAvailable: false,
      payloadHeaderAvailable: false,
      segmentTableAvailable: false,
    });
    expect(summary.warnings[0]).toContain("footer size parsing");
    expect(summary.gameLengthMillis).toBe(1895012);
  });
});
