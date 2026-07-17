import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ReplayWardResult } from "./replayWards";
import type { ReplayWardPositionResearchResult } from "./replayWardPositionResearch";

type ExtractReplayWards = (buffer: ArrayBuffer) => Promise<ReplayWardResult>;
type ExtractReplayWardPositionCandidates = (
  buffer: ArrayBuffer,
) => Promise<ReplayWardPositionResearchResult>;

const championBase = 0x400000ad;
const placementMarkerPacketType = 0x0041;
const placementOwnerPacketType = 0x04ac;
const removalPacketType = 0x02e6;
const killerOwnerPacketType = 0x02f6;
const primarySpawnPacketType = 0x00d6;
const companionSpawnPacketType = 0x01ad;
const firstWardId = 0x50000001;
const secondWardId = 0x50000002;

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

function zeros(length: number): number[] {
  return Array.from({ length }, () => 0);
}

function researchSpawnContent(seed: number): number[] {
  return Array.from({ length: 63 }, (_, index) => (seed + index * 3) & 0xff);
}

function buildWardReplay(gameVersion = "16.9.772.8292"): ArrayBuffer {
  const payload: number[] = [];

  appendPacket(payload, 2, placementOwnerPacketType, championBase + 1, zeros(2));
  appendPacket(
    payload,
    2,
    primarySpawnPacketType,
    firstWardId,
    researchSpawnContent(0x10),
  );
  appendPacket(
    payload,
    2,
    companionSpawnPacketType,
    firstWardId,
    researchSpawnContent(0x20),
  );
  appendPacket(payload, 2, placementMarkerPacketType, firstWardId, [0, 0, 0xb0]);
  appendPacket(payload, 3, placementOwnerPacketType, championBase + 2, zeros(4));
  appendPacket(
    payload,
    3,
    primarySpawnPacketType,
    secondWardId,
    researchSpawnContent(0x30),
  );
  appendPacket(
    payload,
    3,
    companionSpawnPacketType,
    secondWardId,
    researchSpawnContent(0x40),
  );
  appendPacket(payload, 3, placementMarkerPacketType, secondWardId, [0, 0, 0xb0]);

  appendPacket(payload, 4, killerOwnerPacketType, championBase + 3, zeros(7));
  appendPacket(payload, 4, removalPacketType, firstWardId, zeros(28));

  appendPacket(payload, 5, killerOwnerPacketType, championBase + 5, zeros(6));
  appendPacket(payload, 5, removalPacketType, secondWardId, zeros(27));

  const compressed = zstdCompressSync(Buffer.from(payload));
  const metadata = new TextEncoder().encode(
    '{"gameLength":60000,"lastGameChunkId":1,"lastKeyFrameId":0,"statsJson":"[]"}',
  );
  const headerOffset = 32;
  const payloadOffset = headerOffset + 17;
  const metadataOffset = payloadOffset + compressed.length;
  const bytes = new Uint8Array(metadataOffset + metadata.length + 4);
  const view = new DataView(bytes.buffer);

  bytes.set(new TextEncoder().encode("RIOT"), 0);
  bytes[4] = 0x02;
  bytes.set(new TextEncoder().encode(gameVersion), 16);

  bytes[headerOffset] = 1;
  bytes[headerOffset + 4] = 2;
  bytes[headerOffset + 8] = 1;
  view.setUint32(headerOffset + 9, payload.length, true);
  view.setUint32(headerOffset + 13, compressed.length, true);
  bytes.set(compressed, payloadOffset);
  bytes.set(metadata, metadataOffset);
  view.setUint32(bytes.length - 4, metadata.length, true);

  return bytes.buffer;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("ward Wasm ABI contract", () => {
  const originalFetch = globalThis.fetch;
  let extractReplayWardsWithWasm: ExtractReplayWards;
  let extractReplayWardPositionCandidatesWithWasm: ExtractReplayWardPositionCandidates;

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

    ({
      extractReplayWardsWithWasm,
      extractReplayWardPositionCandidatesWithWasm,
    } = await import("./wasmReplayParser"));
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("crosses the real generated Wasm ABI and returns normalized ward events", async () => {
    const result = await extractReplayWardsWithWasm(buildWardReplay());

    expect(result.schema).toBe("rofl-replay-wards/v1");
    expect(result.source.runtimeInput).toBe("rofl-only");
    expect(result.source.riotApiInput).toBe(false);
    expect(result.gameVersion).toBe("16.9.772.8292");
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.type)).toEqual([
      "WARD_PLACED",
      "WARD_PLACED",
      "WARD_KILL",
    ]);
    expect(result.events[0]).toMatchObject({
      timestampMillis: 2000,
      wardEntityNetworkId: firstWardId,
      ownerParticipantId: 1,
      wardType: null,
      position: null,
    });
    expect(result.events[2]).toMatchObject({
      timestampMillis: 4000,
      wardEntityNetworkId: firstWardId,
      killerParticipantId: 3,
      wardType: null,
      position: null,
      removalReason: null,
    });
    expect(result.diagnostics).toMatchObject({
      decodedWardPlacementEventCount: 2,
      decodedWardKillEventCount: 1,
      rejectedTrackedUnprofiledRemovalBlockCount: 1,
      exactPacketFraming: true,
      placementCoverage: "exact-on-validated-corpus",
      removalCoverage: "conservative-partial",
      wardTypeAvailable: false,
      positionAvailable: false,
    });
  });

  it("propagates an unsupported decoder profile through the real JSON error boundary", async () => {
    let caught: unknown;
    try {
      await extractReplayWardsWithWasm(buildWardReplay("17.0.0.0"));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("Unsupported replay version 17.0.0.0");
  });

  it("keeps eight replay-only ward marker hypotheses behind the research gates", async () => {
    const buffer = buildWardReplay();
    const productive = await extractReplayWardsWithWasm(buffer.slice(0));
    const research = await extractReplayWardPositionCandidatesWithWasm(buffer);

    expect(research).toMatchObject({
      schema: "rofl-ward-position-candidates-research/v1",
      researchOnly: true,
      promotionGate: false,
      positionAvailable: false,
      source: {
        runtimeInput: "rofl-only",
        riotApiInput: false,
        clientBinaryInput: false,
      },
      gameVersion: "16.9.772.8292",
      versionGroup: "16.9",
    });
    expect(research.hypotheses).toHaveLength(8);
    expect(research.placements).toHaveLength(2);
    expect(research.placements[0]).toMatchObject({
      timestampMillis: 2000,
      wardEntityNetworkId: firstWardId,
      ownerParticipantId: 1,
      spawnBlocks: {
        primary: {
          packetRole: "primary",
          packetType: primarySpawnPacketType,
          blockParam: firstWardId,
          contentLength: 63,
        },
        companion: {
          packetRole: "companion",
          packetType: companionSpawnPacketType,
          blockParam: firstWardId,
          contentLength: 63,
        },
      },
    });
    expect(research.placements[0]?.spawnBlocks?.primary?.payloadHex).toHaveLength(126);
    expect(research.placements[0]?.spawnBlocks?.companion?.payloadHex).toHaveLength(126);
    expect(research.placements[0]?.candidates).toHaveLength(8);
    expect(research.placements[0]?.candidates.map((candidate) => candidate.hypothesisId)).toEqual(
      research.hypotheses?.map((hypothesis) => hypothesis.id),
    );
    expect(
      research.placements[0]?.candidates.every(
        (candidate) =>
          Number.isFinite(candidate.x) &&
          Number.isFinite(candidate.y) &&
          candidate.x >= 0 &&
          candidate.x <= 15_000 &&
          candidate.y >= 0 &&
          candidate.y <= 15_000,
      ),
    ).toBe(true);
    expect(productive.events.filter((event) => event.type === "WARD_PLACED")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ wardEntityNetworkId: firstWardId, position: null }),
        expect.objectContaining({ wardEntityNetworkId: secondWardId, position: null }),
      ]),
    );
  });
});
