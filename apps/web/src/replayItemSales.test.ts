import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayItemSaleTimestamp,
  replayItemSaleLabel,
  summarizeReplayItemSaleDiagnostics,
  type ReplayItemSaleEvent,
  type ReplayItemSalesResult,
} from "./replayItemSales";

const framedProvenance = {
  segmentType: "chunk",
  segmentId: 8,
  chunkId: 8,
  segmentHeaderOffset: 100,
  segmentPayloadOffset: 117,
  blockIndex: 42,
  decompressedHeaderOffset: 200,
  decompressedContentOffset: 212,
  decompressedEndOffset: 227,
};

const event: ReplayItemSaleEvent = {
  type: "ITEM_SOLD_OPERATION",
  timestampMillis: 754_999,
  participantId: 4,
  participantNetworkId: 0x400000b1,
  participantNetworkIdHex: "0x400000B1",
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
    removalBlock: {
      family: "removal",
      channel: 1,
      packetType: 0x03f9,
      packetTypeHex: "0x03F9",
      contentLength: 6,
      blockParam: 0x400000b1,
      blockParamHex: "0x400000B1",
      provenance: framedProvenance,
    },
  },
};

const result: ReplayItemSalesResult = {
  schema: "rofl-replay-item-sales/v1",
  source: {
    replayPath: null,
    replayId: null,
    matchId: null,
    runtimeInput: "rofl-only",
    riotApiInput: false,
  },
  gameVersion: "16.14.794.5912",
  versionGroup: "16.14",
  profile: {
    segmentType: "chunk",
    channel: 1,
    championNetworkIdBase: 0x400000ad,
    championNetworkIdBaseHex: "0x400000AD",
    addUpdatePacketType: 0x0369,
    addUpdatePacketTypeHex: "0x0369",
    addUpdateContentLengths: [14, 15],
    removalPacketType: 0x03f9,
    removalPacketTypeHex: "0x03F9",
    removalContentLengths: [6, 7],
    groupTimestampToleranceMillis: 0,
    requiredAddUpdateCount: 0,
    requiredRemovalCount: 1,
    payload0LowNibbleValues: [2, 5],
    payload2LowBitsMask: 3,
    payload2RejectedLowBitsValue: 3,
    salePayloadByte2Values: [0x30, 0x6e, 0x7a, 0xea, 0xee, 0xf9],
  },
  events: [event],
  diagnostics: {
    footerRecordCount: 91,
    chunkRecordCount: 60,
    decompressedChunkBytes: 10_000,
    packetBlockCount: 25_000,
    profiledInventoryOperationPacketCount: 12,
    profiledAddUpdatePacketCount: 4,
    profiledRemovalPacketCount: 8,
    ownerTimestampGroupCount: 10,
    singleRemovalNoAddGroupCount: 1,
    rejectedGroupShapeCount: 9,
    rejectedPayloadPredicateGroupCount: 0,
    rejectedUnprofiledSaleDiscriminatorGroupCount: 0,
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
  },
};

describe("item sale-operation presentation helpers", () => {
  it("formats replay timestamps as a match clock", () => {
    expect(formatReplayItemSaleTimestamp(0)).toBe("0:00");
    expect(formatReplayItemSaleTimestamp(754_999)).toBe("12:34");
  });

  it("uses a neutral German label that names neither item, inventory, nor gold", () => {
    const label = replayItemSaleLabel(event, () => "Ahri");
    expect(label).toBe("Ahri · Verkaufsoperation");
    expect(label).not.toMatch(/Item|Inventar|Gold/i);
  });

  it("keeps the sale contract replay-only and fail-closed for all unproven state", () => {
    expect(result.schema).toBe("rofl-replay-item-sales/v1");
    expect(result.source).toEqual({
      replayPath: null,
      replayId: null,
      matchId: null,
      runtimeInput: "rofl-only",
      riotApiInput: false,
    });
    expect(event.availability).toEqual({
      soldItemId: false,
      slot: false,
      itemInstance: false,
      countOrCharges: false,
      price: false,
      goldGain: false,
      inventoryState: false,
      undo: false,
    });
    for (const field of [
      "soldItemId",
      "slot",
      "itemInstance",
      "countOrCharges",
      "price",
      "goldGain",
      "inventoryState",
      "undo",
    ]) {
      expect(event).not.toHaveProperty(field);
    }
    expect(event.provenance.removalBlock).toMatchObject({
      family: "removal",
      channel: 1,
      packetType: 0x03f9,
      contentLength: 6,
      blockParam: 0x400000b1,
      provenance: framedProvenance,
    });
  });

  it("states the strict operation-only boundary in diagnostics", () => {
    expect(summarizeReplayItemSaleDiagnostics(result)).toBe(
      "1 Verkaufsoperation mit exakter Paketrahmung dekodiert; Item, Inventar und Goldgewinn sind weiterhin nicht verfügbar.",
    );
  });

  it("keeps sale research available without mounting it in the product view", () => {
    const appSource = readFileSync(fileURLToPath(new URL("./App.vue", import.meta.url)), "utf8");
    const productSource = readFileSync(
      fileURLToPath(new URL("./components/ProductReplayView.vue", import.meta.url)),
      "utf8",
    );

    expect(appSource).toContain("extractReplayItemSalesWithWasm(buffer)");
    expect(productSource).not.toContain('kind: "sale-operation"');
    expect(productSource).not.toContain("itemSales?.events");
    expect(productSource).not.toContain("player.items");
    expect(productSource).not.toMatch(/sale[^\n]*(?:itemIcon|itemName)\s*\(/i);
  });
});
