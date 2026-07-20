import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import createReplayModule from "./generated/wasm/rofl_wasm.js";
import productionDecoderProfileRegistryJson from "../../../packages/rofl-core/profiles/replay-decoder-profiles.v1.json?raw";

interface EmscriptenModule {
  cwrap<Fn extends (...args: never[]) => unknown>(
    identifier: string,
    returnType: "number" | "string" | null,
    argTypes: string[],
  ): Fn;
  UTF8ToString(pointer: number): string;
}

const gameVersion = "16.14.794.5912";
const championNetworkIdBase = 0x400000ad;
const snapshotPacketType = 0x02eb;
const snapshotContentLength = 1479;
const experienceOffsets = [83, 85, 87, 89];
const totalGoldOffsets = [109, 115, 117, 119];
const laneMinionsKilledOffsets = [125, 127, 129, 131];
const neutralMinionsKilledOffsets = [133, 135, 137, 139];

interface SnapshotCodec {
  cipherToPlain: number[];
  experienceOffsets: number[];
  totalGoldOffsets: number[];
  laneMinionsKilledOffsets: number[];
  neutralMinionsKilledOffsets: number[];
  neutralMinionsKilledProjection: "floor-plus-1e-5";
}

function appendU16Le(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff);
}

function appendU32Le(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function appendFloat32Le(bytes: number[], value: number): void {
  const encoded = new ArrayBuffer(4);
  new DataView(encoded).setFloat32(0, value, true);
  bytes.push(...new Uint8Array(encoded));
}

function float32LeBytes(value: number): number[] {
  const encoded = new ArrayBuffer(4);
  new DataView(encoded).setFloat32(0, value, true);
  return [...new Uint8Array(encoded)];
}

function appendPacket(
  bytes: number[],
  timestampSeconds: number,
  packetType: number,
  blockParam: number,
  content: number[],
): void {
  bytes.push(0x01);
  appendFloat32Le(bytes, timestampSeconds);
  appendU32Le(bytes, content.length);
  appendU16Le(bytes, packetType);
  appendU32Le(bytes, blockParam);
  bytes.push(...content);
}

function assignCipherBytes(
  payload: number[],
  offsets: number[],
  value: number,
  cipherToPlain: number[],
): void {
  const inverseCipher = Array.from({ length: 256 }, () => -1);
  cipherToPlain.forEach((plain, cipher) => {
    inverseCipher[plain] = cipher;
  });
  const encoded = float32LeBytes(value);
  offsets.forEach((offset, index) => {
    const cipher = inverseCipher[encoded[index] ?? 0];
    if (cipher === undefined || cipher < 0)
      throw new Error("Snapshot test cipher is not bijective.");
    payload[offset] = cipher;
  });
}

function buildSnapshotReplayWithCodec(
  codec: SnapshotCodec,
  replayGameVersion = gameVersion,
): ArrayBuffer {
  const keyframe: number[] = Array.from({ length: snapshotContentLength }, () => 0);
  assignCipherBytes(keyframe, codec.experienceOffsets, 1140, codec.cipherToPlain);
  assignCipherBytes(keyframe, codec.totalGoldOffsets, 1234, codec.cipherToPlain);
  assignCipherBytes(keyframe, codec.laneMinionsKilledOffsets, 55, codec.cipherToPlain);
  assignCipherBytes(keyframe, codec.neutralMinionsKilledOffsets, 19.6, codec.cipherToPlain);
  const payload: number[] = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    appendPacket(payload, 2, snapshotPacketType, championNetworkIdBase + participantId, keyframe);
  }

  const compressed = zstdCompressSync(Buffer.from(payload));
  const finalStats = Array.from({ length: 10 }, () => ({
    LEVEL: "18",
    EXP: "20000",
    MINIONS_KILLED: "100",
    NEUTRAL_MINIONS_KILLED: "100",
    ITEM0: "0",
    ITEM1: "0",
    ITEM2: "0",
    ITEM3: "0",
    ITEM4: "0",
    ITEM5: "0",
    ITEM6: "0",
    WARD_PLACED: "0",
    WARD_KILLED: "0",
  }));
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      gameLength: 60000,
      lastGameChunkId: 0,
      lastKeyFrameId: 1,
      statsJson: JSON.stringify(finalStats),
    }),
  );
  const headerOffset = 32;
  const payloadOffset = headerOffset + 17;
  const metadataOffset = payloadOffset + compressed.length;
  const bytes = new Uint8Array(metadataOffset + metadata.length + 4);
  const view = new DataView(bytes.buffer);

  bytes.set(new TextEncoder().encode("RIOT"), 0);
  bytes[4] = 0x02;
  bytes.set(new TextEncoder().encode(replayGameVersion), 16);
  bytes[headerOffset] = 1;
  bytes[headerOffset + 4] = 3;
  bytes[headerOffset + 8] = 2;
  view.setUint32(headerOffset + 9, payload.length, true);
  view.setUint32(headerOffset + 13, compressed.length, true);
  bytes.set(compressed, payloadOffset);
  bytes.set(metadata, metadataOffset);
  view.setUint32(bytes.length - 4, metadata.length, true);

  return bytes.buffer;
}

function buildSnapshotReplay(replayGameVersion = gameVersion): ArrayBuffer {
  return buildSnapshotReplayWithCodec(
    {
      cipherToPlain: identityCipher(),
      experienceOffsets,
      totalGoldOffsets,
      laneMinionsKilledOffsets,
      neutralMinionsKilledOffsets,
      neutralMinionsKilledProjection: "floor-plus-1e-5",
    },
    replayGameVersion,
  );
}

function identityCipher(): number[] {
  return Array.from({ length: 256 }, (_, value) => value);
}

function productionSnapshotCodec(): SnapshotCodec {
  const registry = JSON.parse(productionDecoderProfileRegistryJson) as {
    profiles?: Array<{
      versionGroup?: string;
      keyframeParticipantStats?: SnapshotCodec;
    }>;
  };
  const codec = registry.profiles?.find(
    (profile) => profile.versionGroup === "16.14",
  )?.keyframeParticipantStats;
  if (!codec)
    throw new Error("Canonical decoder registry has no keyframe participant stats codec.");
  return codec;
}

function snapshotProfileJson(): string {
  return JSON.stringify({
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "wasm-contract-participant-stat-snapshots",
    revision: "1",
    profiles: [
      {
        versionGroup: "16.14",
        finalStatsValidated: true,
        keyframeParticipantStats: {
          acceptedGameVersions: [gameVersion],
          segmentType: "keyframe",
          channel: 1,
          packetType: snapshotPacketType,
          contentLength: snapshotContentLength,
          championNetworkIdBase,
          cipherToPlain: identityCipher(),
          experienceOffsets,
          totalGoldOffsets,
          laneMinionsKilledOffsets,
          neutralMinionsKilledOffsets,
          neutralMinionsKilledProjection: "floor-plus-1e-5",
        },
      },
    ],
  });
}

function profileWithoutSnapshotCapabilityJson(): string {
  return JSON.stringify({
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "wasm-contract-no-participant-stat-snapshots",
    revision: "1",
    profiles: [
      { versionGroup: "16.14", acceptedGameVersions: [gameVersion], finalStatsValidated: true },
    ],
  });
}

function malformedSnapshotProfileJson(): string {
  const profile = JSON.parse(snapshotProfileJson()) as {
    profiles: Array<{ keyframeParticipantStats: { cipherToPlain: number[] } }>;
  };
  profile.profiles[0]?.keyframeParticipantStats.cipherToPlain.pop();
  return JSON.stringify(profile);
}

function partialCsOnlySnapshotProfileJson(): string {
  const profile = JSON.parse(snapshotProfileJson()) as {
    profiles: Array<{ keyframeParticipantStats: Record<string, unknown> }>;
  };
  const codec = profile.profiles[0]!.keyframeParticipantStats;
  const cipher = codec.cipherToPlain as Array<number | null>;
  cipher[0] = null;
  codec.ambiguousCipherMappings = [{ cipher: 0, plain: [0] }];
  delete codec.experienceOffsets;
  delete codec.totalGoldOffsets;
  return JSON.stringify(profile);
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseWasmJson(module: EmscriptenModule, pointer: number): Record<string, unknown> {
  const freeString = module.cwrap<(value: number) => void>("lra_free_string", null, ["number"]);
  try {
    const result = JSON.parse(module.UTF8ToString(pointer)) as Record<string, unknown>;
    if (typeof result.error === "string") throw new Error(result.error);
    return result;
  } finally {
    freeString(pointer);
  }
}

function extractParticipantStatSnapshots(
  module: EmscriptenModule,
  replay: ArrayBuffer,
  profileJson: string,
): Record<string, unknown> {
  const replayBytes = new Uint8Array(replay);
  const profileBytes = new TextEncoder().encode(profileJson);
  const alloc = module.cwrap<(size: number) => number>("lra_alloc_buffer", "number", ["number"]);
  const copy = module.cwrap<
    (destination: number, offset: number, source: Uint8Array, size: number) => void
  >("lra_copy_buffer_chunk", null, ["number", "number", "array", "number"]);
  const free = module.cwrap<(pointer: number) => void>("lra_free_buffer", null, ["number"]);
  const extract = module.cwrap<
    (
      replayPointer: number,
      replaySize: number,
      profilePointer: number,
      profileSize: number,
    ) => number
  >("lra_extract_replay_participant_stat_snapshots_buffer_with_profiles", "number", [
    "number",
    "number",
    "number",
    "number",
  ]);
  const replayPointer = alloc(replayBytes.length);
  const profilePointer = alloc(profileBytes.length);
  if (!replayPointer || !profilePointer) throw new Error("Wasm buffer allocation failed.");

  try {
    copy(replayPointer, 0, replayBytes, replayBytes.length);
    copy(profilePointer, 0, profileBytes, profileBytes.length);
    return parseWasmJson(
      module,
      extract(replayPointer, replayBytes.length, profilePointer, profileBytes.length),
    );
  } finally {
    free(profilePointer);
    free(replayPointer);
  }
}

describe("participant-stat-snapshot Wasm ABI contract", () => {
  const originalFetch = globalThis.fetch;
  let module: EmscriptenModule;

  beforeAll(async () => {
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.startsWith("file:") && url.includes("rofl_wasm.wasm")) {
        const binary = readFileSync(fileURLToPath(new URL(url)));
        return new Response(binary, {
          status: 200,
          headers: { "Content-Type": "application/wasm" },
        });
      }
      return originalFetch(input, init);
    };
    module = (await createReplayModule()) as EmscriptenModule;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("crosses the real Wasm ABI with an external snapshot profile and provenance", () => {
    const profileJson = snapshotProfileJson();
    const result = extractParticipantStatSnapshots(module, buildSnapshotReplay(), profileJson);

    expect(result.schema).toBe("rofl-replay-participant-stat-snapshots/v4");
    expect(result.source).toMatchObject({ runtimeInput: "rofl-only", riotApiInput: false });
    expect(result.gameVersion).toBe(gameVersion);
    expect(result.versionGroup).toBe("16.14");
    expect(result.profile).toMatchObject({
      origin: "external",
      schema: "rofl-replay-decoder-profiles/v1",
      registryId: "wasm-contract-participant-stat-snapshots",
      revision: "1",
      fingerprint: fnv1a64(profileJson),
      segmentType: "keyframe",
      channel: 1,
      snapshotPacketType,
      snapshotContentLength,
      championNetworkIdBase,
      experienceAvailable: true,
      totalGoldAvailable: true,
      levelDerivation: "xp-thresholds-with-replay-final-level-cap",
      neutralMinionsKilledProjection: "floor-plus-1e-5",
    });
    expect(result.snapshots).toHaveLength(10);
    expect(result.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timestampMillis: 2000,
          participantId: 1,
          experience: 1140,
          level: 4,
          totalGold: 1234,
          laneMinionsKilled: 55,
          neutralMinionsKilled: 19,
          provenance: expect.objectContaining({
            snapshotBlock: expect.objectContaining({
              packetType: snapshotPacketType,
              contentLength: snapshotContentLength,
              blockParam: championNetworkIdBase + 1,
              provenance: expect.objectContaining({ segmentType: "keyframe", blockIndex: 0 }),
            }),
          }),
        }),
      ]),
    );
  });

  it("decodes the canonical production profile's cipher and fixed offsets", () => {
    const codec = productionSnapshotCodec();
    expect(codec.experienceOffsets).toEqual([83, 85, 87, 89]);
    expect(codec.totalGoldOffsets).toEqual([115, 117, 119, 121]);
    expect(codec.laneMinionsKilledOffsets).toEqual([123, 125, 127, 129]);
    expect(codec.neutralMinionsKilledOffsets).toEqual([131, 133, 135, 137]);
    expect(codec.neutralMinionsKilledProjection).toBe("floor-plus-1e-5");
    expect(codec.cipherToPlain).toHaveLength(256);

    const result = extractParticipantStatSnapshots(
      module,
      buildSnapshotReplayWithCodec(codec),
      productionDecoderProfileRegistryJson,
    );
    expect(result.profile).toMatchObject({
      registryId: "league-replay-analyzer-offline-validated",
      fingerprint: fnv1a64(productionDecoderProfileRegistryJson),
      snapshotPacketType,
      snapshotContentLength,
      championNetworkIdBase,
    });
    expect(result.snapshots).toHaveLength(10);
    expect(result.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timestampMillis: 2000,
          participantId: 1,
          experience: 1140,
          level: 4,
          totalGold: 1234,
          laneMinionsKilled: 55,
          neutralMinionsKilled: 19,
        }),
      ]),
    );
  });

  it("emits invariant CS from a bounded partial cipher without fabricating other stats", () => {
    const result = extractParticipantStatSnapshots(
      module,
      buildSnapshotReplay(),
      partialCsOnlySnapshotProfileJson(),
    );
    expect(result.profile).toMatchObject({
      experienceAvailable: false,
      totalGoldAvailable: false,
      levelDerivation: null,
    });
    expect(result.snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          participantId: 1,
          experience: null,
          level: null,
          totalGold: null,
          laneMinionsKilled: 55,
          neutralMinionsKilled: 19,
        }),
      ]),
    );
  });

  it("fails closed for missing or malformed snapshot capabilities", () => {
    expect(() =>
      extractParticipantStatSnapshots(
        module,
        buildSnapshotReplay(),
        profileWithoutSnapshotCapabilityJson(),
      ),
    ).toThrow("external decoder registry has no keyframe participant stats profile");
    expect(() =>
      extractParticipantStatSnapshots(
        module,
        buildSnapshotReplay(),
        malformedSnapshotProfileJson(),
      ),
    ).toThrow("cipherToPlain");
  });

  it("fails closed for a non-exact replay build", () => {
    expect(() =>
      extractParticipantStatSnapshots(
        module,
        buildSnapshotReplay("16.14.794.5913"),
        snapshotProfileJson(),
      ),
    ).toThrow("no exact-build grammar for 16.14.794.5913");
  });
});
