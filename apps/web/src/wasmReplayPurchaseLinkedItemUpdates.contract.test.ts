import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ReplayPurchaseLinkedItemUpdatesResult } from "./replayPurchaseLinkedItemUpdates";

type ExtractReplayPurchaseLinkedItemUpdates = (
  buffer: ArrayBuffer,
  profileJson?: string,
) => Promise<ReplayPurchaseLinkedItemUpdatesResult>;

const gameVersion = "16.14.794.5912";
const championNetworkIdBase = 0x400000ad;
const addUpdatePacketType = 0x0369;
const removalPacketType = 0x03f9;
const removalContextPacketType = 0x0146;
const undoComponentPacketType = 0x0081;

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

function setPayloadBit(payload: number[], bit: number): void {
  payload[bit >>> 3] = (payload[bit >>> 3] ?? 0) | (1 << (bit & 7));
}

/**
 * A profiled 14-byte add/update payload whose replay-only bit grammar resolves
 * to resulting item ID 1001. It deliberately avoids the two unavailable input
 * symbols in the 16.14 profile.
 */
function availableItemPayload(): number[] {
  const payload = zeros(14);
  for (const bit of [67, 71, 73, 75, 78]) setPayloadBit(payload, bit);
  return payload;
}

/** Uses the first formally underidentified symbol: q72/q73/q79 == 0. */
function missingSymbolItemPayload(): number[] {
  return zeros(14);
}

function buildPurchaseReplay(replayGameVersion = gameVersion): ArrayBuffer {
  const payload: number[] = [];

  // This is the frozen strict template removal:6 > removal:6 > add:14.
  appendPacket(payload, 2, removalPacketType, championNetworkIdBase + 2, zeros(6));
  appendPacket(payload, 2, removalPacketType, championNetworkIdBase + 2, zeros(6));
  appendPacket(payload, 2, addUpdatePacketType, championNetworkIdBase + 2, availableItemPayload());

  // A valid add payload alone is not a selected template and must be suppressed.
  appendPacket(payload, 3, removalPacketType, championNetworkIdBase + 3, zeros(6));
  appendPacket(payload, 3, addUpdatePacketType, championNetworkIdBase + 3, availableItemPayload());

  // A selected template with an underidentified item-ID symbol must fail closed.
  appendPacket(payload, 4, removalPacketType, championNetworkIdBase + 4, zeros(6));
  appendPacket(payload, 4, removalPacketType, championNetworkIdBase + 4, zeros(6));
  appendPacket(payload, 4, addUpdatePacketType, championNetworkIdBase + 4, missingSymbolItemPayload());

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

function purchaseProfileJson(): string {
  return JSON.stringify({
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "wasm-contract-purchase-linked-item-updates",
    revision: "1",
    profiles: [
      {
        versionGroup: "16.14",
        acceptedGameVersions: [gameVersion],
        inventoryPurchaseSubset: {
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
          removalContext: {
            packetType: removalContextPacketType,
            contentLengths: { exact: [2, 3, 4] },
          },
          undoComponent: { packetType: undoComponentPacketType },
          templates: [
            [
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 6 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 6 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 6 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
            [
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 6 },
              { family: "removal", contentLength: 7 },
              { family: "removal", contentLength: 7 },
              { family: "add", contentLength: 14 },
            ],
          ],
        },
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
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("purchase-linked item-update Wasm ABI contract", () => {
  const originalFetch = globalThis.fetch;
  let extractReplayPurchaseLinkedItemUpdatesWithWasm: ExtractReplayPurchaseLinkedItemUpdates;

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

    ({ extractReplayPurchaseLinkedItemUpdatesWithWasm } = await import("./wasmReplayParser"));
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("crosses the real Wasm ABI with an external strict profile and fails closed", async () => {
    const profileJson = purchaseProfileJson();
    const result = await extractReplayPurchaseLinkedItemUpdatesWithWasm(
      buildPurchaseReplay(),
      profileJson,
    );

    expect(result.schema).toBe("rofl-replay-purchase-linked-item-updates/v1");
    expect(result.source).toMatchObject({ runtimeInput: "rofl-only", riotApiInput: false });
    expect(result.gameVersion).toBe(gameVersion);
    expect(result.versionGroup).toBe("16.14");
    expect(result.profile).toMatchObject({
      origin: "external",
      schema: "rofl-replay-decoder-profiles/v1",
      registryId: "wasm-contract-purchase-linked-item-updates",
      revision: "1",
      fingerprint: fnv1a64(profileJson),
      segmentType: "chunk",
      channel: 1,
      addUpdatePacketType,
      contentLengths: [14, 15],
      championNetworkIdBase,
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "PURCHASE_LINKED_RESULTING_ITEM_UPDATE",
        timestampMillis: 2000,
        participantId: 2,
        participantNetworkId: championNetworkIdBase + 2,
        participantNetworkIdHex: "0x400000AF",
        resultingItemId: 1001,
        purchaseLinked: true,
        matchedTemplateIndex: 0,
        matchedTemplateSignature: "removal:6>removal:6>add:14",
        provenance: expect.objectContaining({
          addBlock: expect.objectContaining({
            family: "add",
            packetType: addUpdatePacketType,
            contentLength: 14,
          }),
        }),
      }),
    ]);
    expect(result.diagnostics).toMatchObject({
      profiledAddUpdatePacketCount: 3,
      profiledOwnerTimeGroupCount: 3,
      matchedTemplateGroupCount: 2,
      rejectedNonmatchingGroupCount: 1,
      rejectedUnavailableItemIdGroupCount: 1,
      emittedEventCount: 1,
      unavailableAddUpdatePacketCount: 2,
      exactPacketFraming: true,
      coverage: "strict-subset-not-complete",
      generalPurchaseClassificationAvailable: false,
      automaticStateUpdateClassificationAvailable: false,
      inventoryStateAvailable: false,
    });
  });

  it("propagates an unsupported exact build through the real JSON error boundary", async () => {
    let caught: unknown;
    try {
      await extractReplayPurchaseLinkedItemUpdatesWithWasm(
        buildPurchaseReplay("16.14.794.5913"),
        purchaseProfileJson(),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "Inventory purchase subset decoder is restricted to exact build 16.14.794.5912",
    );
  });
});
