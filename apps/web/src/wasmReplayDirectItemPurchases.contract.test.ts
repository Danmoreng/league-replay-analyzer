import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ReplayDirectItemPurchasesResult } from "./replayDirectItemPurchases";

type ExtractReplayDirectItemPurchases = (
  buffer: ArrayBuffer,
  profileJson?: string,
) => Promise<ReplayDirectItemPurchasesResult>;

const gameVersion = "16.14.794.5912";
const championNetworkIdBase = 0x400000ad;
const addUpdatePacketType = 0x0369;
const removalPacketType = 0x03f9;
const removalContextPacketType = 0x0146;

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

function hexPayload(value: string): number[] {
  return Array.from(Buffer.from(value, "hex"));
}

function zeros(length: number): number[] {
  return Array.from({ length }, () => 0);
}

/**
 * Saved exact-build research payload from EUW1-7920341366, participant 10,
 * at 357640 ms: item ID 1001. It is a pinned catalog component, not a
 * synthetic bit-field example.
 */
const componentPurchasePayload = hexPayload("220f7df10982c05e894bf9d8d86f1a");

// Saved exact-build research payloads for intentionally excluded grants.
const biscuitGrantPayload = hexPayload("080f59e0a882d41e615bd8d8111b"); // 2010
const footwearGrantPayload = hexPayload("1817af005b92c04e03d9f9d8d86f1a"); // 2422

function buildDirectPurchaseReplay(replayGameVersion = gameVersion): ArrayBuffer {
  const payload: number[] = [];

  // One isolated, replay-researched component purchase must be emitted.
  appendPacket(payload, 2, addUpdatePacketType, championNetworkIdBase + 2, componentPurchasePayload);

  // A same-timestamp add/removal operation is not add-only.
  appendPacket(payload, 3, addUpdatePacketType, championNetworkIdBase + 3, componentPurchasePayload);
  appendPacket(payload, 3, removalPacketType, championNetworkIdBase + 3, zeros(6));

  // A blocking operation within the exact ±1 ms isolation window suppresses the add.
  appendPacket(payload, 4, addUpdatePacketType, championNetworkIdBase + 4, componentPurchasePayload);
  appendPacket(payload, 4.001, removalContextPacketType, championNetworkIdBase + 4, zeros(2));

  // Structural IDs 2010 and 2422 are deliberately absent from the pinned real-item set.
  appendPacket(payload, 5, addUpdatePacketType, championNetworkIdBase + 5, biscuitGrantPayload);
  appendPacket(payload, 6, addUpdatePacketType, championNetworkIdBase + 6, footwearGrantPayload);

  // The first formally underidentified item-ID input symbol must fail closed.
  appendPacket(payload, 7, addUpdatePacketType, championNetworkIdBase + 7, zeros(14));

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

describe("direct item-purchase Wasm ABI contract", () => {
  const originalFetch = globalThis.fetch;
  const canonicalProfileJson = readFileSync(
    fileURLToPath(
      new URL("../../../packages/rofl-core/profiles/replay-decoder-profiles.v1.json", import.meta.url),
    ),
    "utf8",
  );
  const canonicalProfile = JSON.parse(canonicalProfileJson) as {
    schema: string;
    registryId: string;
    revision: string;
  };
  let extractReplayDirectItemPurchasesWithWasm: ExtractReplayDirectItemPurchases;

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

    ({ extractReplayDirectItemPurchasesWithWasm } = await import("./wasmReplayParser"));
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it("crosses the real Wasm ABI with the canonical catalog profile and fails closed", async () => {
    const result = await extractReplayDirectItemPurchasesWithWasm(
      buildDirectPurchaseReplay(),
      canonicalProfileJson,
    );

    expect(result.schema).toBe("rofl-replay-direct-item-purchases/v1");
    expect(result.source).toMatchObject({ runtimeInput: "rofl-only", riotApiInput: false });
    expect(result.gameVersion).toBe(gameVersion);
    expect(result.versionGroup).toBe("16.14");
    expect(result.profile).toMatchObject({
      origin: "external",
      schema: canonicalProfile.schema,
      registryId: canonicalProfile.registryId,
      revision: canonicalProfile.revision,
      fingerprint: fnv1a64(canonicalProfileJson),
      segmentType: "chunk",
      channel: 1,
      championNetworkIdBase,
      addUpdatePacketType,
      contentLengths: [14, 15],
      blockingPacketTypes: [removalPacketType, removalContextPacketType, 0x0081],
      isolationToleranceMillis: 1,
      staticItemCatalog: expect.objectContaining({
        provider: "Riot Data Dragon",
        version: "16.14.1",
        entryCount: 706,
        realItemIdCount: 212,
        componentItemIdCount: 71,
      }),
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        type: "DIRECT_ADD_ONLY_ITEM_PURCHASE",
        timestampMillis: 2000,
        participantId: 2,
        participantNetworkId: championNetworkIdBase + 2,
        participantNetworkIdHex: "0x400000AF",
        itemId: 1001,
        componentItem: true,
        classification: "direct-add-only",
        availability: {
          slot: false,
          itemInstance: false,
          countOrCharges: false,
          price: false,
          goldState: false,
          inventoryState: false,
        },
        provenance: {
          addBlock: expect.objectContaining({
            family: "add",
            channel: 1,
            packetType: addUpdatePacketType,
            packetTypeHex: "0x0369",
            contentLength: 15,
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
      chunkRecordCount: 1,
      packetBlockCount: 8,
      knownInventoryOperationPacketCount: 8,
      profiledAddUpdatePacketCount: 6,
      knownOwnerTimeGroupCount: 7,
      profiledSingleAddOnlyGroupCount: 5,
      rejectedNonSingletonGroupCount: 1,
      rejectedNonAddOrLengthGroupCount: 1,
      rejectedNeighborOperationGroupCount: 1,
      rejectedUnavailableItemIdGroupCount: 1,
      rejectedStaticItemCatalogGroupCount: 2,
      emittedEventCount: 1,
      componentItemEventCount: 1,
      exactPacketFraming: true,
      coverage: "strict-direct-add-only-subset-not-complete",
      generalPurchaseClassificationAvailable: false,
      slotAvailable: false,
      itemInstanceAvailable: false,
      countOrChargesAvailable: false,
      priceAvailable: false,
      goldStateAvailable: false,
      inventoryStateAvailable: false,
      removedItemIdentityAvailable: false,
      undoAvailable: false,
    });
  });

  it("propagates an unsupported exact build through the real JSON error boundary", async () => {
    let caught: unknown;
    try {
      await extractReplayDirectItemPurchasesWithWasm(
        buildDirectPurchaseReplay("16.14.794.5913"),
        canonicalProfileJson,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(
      "Inventory direct purchase subset decoder is restricted to exact build 16.14.794.5912",
    );
  });
});
