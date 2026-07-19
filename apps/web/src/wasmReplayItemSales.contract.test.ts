import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import createReplayModule from "./generated/wasm/rofl_wasm.js";

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
const addUpdatePacketType = 0x0369;
const removalPacketType = 0x03f9;

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

function buildSaleReplay(replayGameVersion = gameVersion): ArrayBuffer {
  const payload: number[] = [];

  // The exact profiled sale discriminator: p[0] low nibble 0x02, p[2] 0x30.
  appendPacket(payload, 2, removalPacketType, championNetworkIdBase + 2, [0x02, 0x00, 0x30, 0, 0, 0]);

  // Same exact framing and owner class, but an unknown p[2] discriminator.
  // It must remain unavailable instead of being widened into a sale event.
  appendPacket(payload, 3, removalPacketType, championNetworkIdBase + 3, [0x02, 0x00, 0x12, 0, 0, 0]);

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
  bytes.set(new TextEncoder().encode(replayGameVersion), 16);
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

function saleProfileJson(): string {
  return JSON.stringify({
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "wasm-contract-item-sales",
    revision: "1",
    profiles: [
      {
        versionGroup: "16.14",
        acceptedGameVersions: [gameVersion],
        inventorySaleSubset: {
          segmentType: "chunk",
          channel: 1,
          championNetworkIdBase,
          add: {
            packetType: addUpdatePacketType,
            contentLengths: { exact: [14, 15] },
          },
          removal: {
            packetType: removalPacketType,
            contentLengths: { exact: [6, 7] },
          },
          exactGroup: {
            addCount: 0,
            removalCount: 1,
            timestampToleranceMillis: 0,
          },
          removalPayload: {
            payload0LowNibbleAllow: [0x02, 0x05],
            payload2LowTwoBitReject: 0x03,
            payload2Allow: [0x30, 0x6e, 0x7a, 0xea, 0xee, 0xf9],
          },
        },
      },
    ],
  });
}

function profileWithoutSalesJson(): string {
  return JSON.stringify({
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "wasm-contract-no-item-sales",
    revision: "1",
    profiles: [
      {
        versionGroup: "16.14",
        acceptedGameVersions: [gameVersion],
        finalStatsValidated: true,
      },
    ],
  });
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16)}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseWasmJson(module: EmscriptenModule, pointer: number): Record<string, unknown> {
  const freeString = module.cwrap<(value: number) => void>("lra_free_string", null, ["number"]);
  try {
    const value = JSON.parse(module.UTF8ToString(pointer)) as Record<string, unknown>;
    if (typeof value.error === "string") throw new Error(value.error);
    return value;
  } finally {
    freeString(pointer);
  }
}

function extractItemSales(
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
    (replayPointer: number, replaySize: number, profilePointer: number, profileSize: number) => number
  >("lra_extract_replay_item_sales_buffer_with_profiles", "number", [
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
    return parseWasmJson(module, extract(replayPointer, replayBytes.length, profilePointer, profileBytes.length));
  } finally {
    free(profilePointer);
    free(replayPointer);
  }
}

describe("item-sale Wasm ABI contract", () => {
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

  it("crosses the real Wasm ABI and rejects an unseen sale discriminator", () => {
    const profileJson = saleProfileJson();
    const result = extractItemSales(module, buildSaleReplay(), profileJson);

    expect(result.schema).toBe("rofl-replay-item-sales/v1");
    expect(result.source).toMatchObject({ runtimeInput: "rofl-only", riotApiInput: false });
    expect(result.gameVersion).toBe(gameVersion);
    expect(result.versionGroup).toBe("16.14");
    expect(result.profile).toMatchObject({
      origin: "external",
      schema: "rofl-replay-decoder-profiles/v1",
      registryId: "wasm-contract-item-sales",
      revision: "1",
      fingerprint: fnv1a64(profileJson),
      segmentType: "chunk",
      channel: 1,
      championNetworkIdBase,
      removalPacketType,
      removalContentLengths: [6, 7],
      salePayloadByte2Values: [0x30, 0x6e, 0x7a, 0xea, 0xee, 0xf9],
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "ITEM_SOLD_OPERATION",
        timestampMillis: 2000,
        participantId: 2,
        participantNetworkId: championNetworkIdBase + 2,
        participantNetworkIdHex: "0x400000AF",
        availability: {
          soldItemId: false,
          slot: false,
          itemInstance: false,
          countOrCharges: false,
          price: false,
          goldGain: false,
          inventoryState: false,
          undo: false,
        },
        provenance: {
          removalBlock: expect.objectContaining({
            family: "removal",
            channel: 1,
            packetType: removalPacketType,
            packetTypeHex: "0x03F9",
            contentLength: 6,
            blockParam: championNetworkIdBase + 2,
            blockParamHex: "0x400000AF",
            provenance: expect.objectContaining({
              segmentType: "chunk",
              segmentId: 1,
              chunkId: 2,
              blockIndex: 0,
              decompressedHeaderOffset: 0,
            }),
          }),
        },
      }),
    ]);
    expect(result.diagnostics).toMatchObject({
      packetBlockCount: 2,
      profiledRemovalPacketCount: 2,
      emittedEventCount: 1,
      exactPacketFraming: true,
      coverage: "exact-sale-operation-only",
      soldItemIdAvailable: false,
      slotAvailable: false,
      itemInstanceAvailable: false,
      countOrChargesAvailable: false,
      priceAvailable: false,
      goldGainAvailable: false,
      inventoryStateAvailable: false,
      undoAvailable: false,
    });
  });

  it("propagates unsupported exact-build and missing-profile errors through the JSON boundary", () => {
    expect(() => extractItemSales(
      module,
      buildSaleReplay("16.14.794.5913"),
      saleProfileJson(),
    )).toThrow("Inventory sale subset decoder is restricted to exact build 16.14.794.5912");
    expect(() => extractItemSales(
      module,
      buildSaleReplay(),
      profileWithoutSalesJson(),
    )).toThrow("external decoder registry has no inventory sale subset profile");
  });
});
