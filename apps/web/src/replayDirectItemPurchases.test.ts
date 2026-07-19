import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayDirectItemPurchaseTimestamp,
  replayDirectItemPurchaseLabel,
  summarizeReplayDirectItemPurchaseDiagnostics,
  type ReplayDirectItemPurchaseEvent,
  type ReplayDirectItemPurchasesResult,
} from "./replayDirectItemPurchases";

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

function directPurchase(componentItem: boolean): ReplayDirectItemPurchaseEvent {
  return {
    type: "DIRECT_ADD_ONLY_ITEM_PURCHASE",
    timestampMillis: 754_999,
    participantId: 4,
    participantNetworkId: 0x400000b1,
    participantNetworkIdHex: "0x400000B1",
    itemId: componentItem ? 3802 : 3157,
    componentItem,
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
      addBlock: {
        family: "add",
        channel: 1,
        packetType: 0x0369,
        packetTypeHex: "0x0369",
        contentLength: 14,
        blockParam: 0x400000b1,
        blockParamHex: "0x400000B1",
        provenance: framedProvenance,
      },
    },
  };
}

const result: ReplayDirectItemPurchasesResult = {
  schema: "rofl-replay-direct-item-purchases/v1",
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
    contentLengths: [14, 15],
    blockingPacketTypes: [0x03f9, 0x0146, 0x0081],
    blockingPacketTypesHex: ["0x03F9", "0x0146", "0x0081"],
    isolationToleranceMillis: 1,
    staticItemCatalog: {
      provider: "Riot Data Dragon",
      version: "16.14.1",
      locale: "en_US",
      sourceUrl: "https://ddragon.leagueoflegends.com/cdn/16.14.1/data/en_US/item.json",
      sourceByteLength: 583_139,
      sourceSha256: "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75",
      entryCount: 706,
      realItemIdCount: 212,
      componentItemIdCount: 71,
    },
  },
  events: [directPurchase(true)],
  diagnostics: {
    footerRecordCount: 91,
    chunkRecordCount: 60,
    decompressedChunkBytes: 10_000,
    packetBlockCount: 25_000,
    knownInventoryOperationPacketCount: 12,
    profiledAddUpdatePacketCount: 10,
    knownOwnerTimeGroupCount: 10,
    profiledSingleAddOnlyGroupCount: 1,
    rejectedNonSingletonGroupCount: 2,
    rejectedNonAddOrLengthGroupCount: 6,
    rejectedNeighborOperationGroupCount: 0,
    rejectedUnavailableItemIdGroupCount: 0,
    rejectedStaticItemCatalogGroupCount: 1,
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
  },
};

describe("direct add-only item purchase presentation helpers", () => {
  it("formats replay timestamps as a match clock", () => {
    expect(formatReplayDirectItemPurchaseTimestamp(0)).toBe("0:00");
    expect(formatReplayDirectItemPurchaseTimestamp(754_999)).toBe("12:34");
  });

  it("uses a German direct-component-purchase label without asserting inventory state", () => {
    expect(replayDirectItemPurchaseLabel(directPurchase(true), () => "Ahri", () => "Verlorenes Kapitel")).toBe(
      "Ahri · direkter Komponenten-Kauf: Verlorenes Kapitel",
    );
  });

  it("uses the same safe direct-purchase label for a non-component item", () => {
    expect(replayDirectItemPurchaseLabel(directPurchase(false), () => "Ahri", () => "Zhonjas Stundenglas")).toBe(
      "Ahri · direkter Item-Kauf: Zhonjas Stundenglas",
    );
  });

  it("keeps the contract replay-only and fail-closed for unavailable item state", () => {
    const event = directPurchase(true);
    expect(result.schema).toBe("rofl-replay-direct-item-purchases/v1");
    expect(result.source).toEqual({
      replayPath: null,
      replayId: null,
      matchId: null,
      runtimeInput: "rofl-only",
      riotApiInput: false,
    });
    expect(event.classification).toBe("direct-add-only");
    expect(event.availability).toEqual({
      slot: false,
      itemInstance: false,
      countOrCharges: false,
      price: false,
      goldState: false,
      inventoryState: false,
    });
    expect(event).not.toHaveProperty("slot");
    expect(event).not.toHaveProperty("itemInstance");
    expect(event).not.toHaveProperty("inventory");
    expect(event.provenance.addBlock).toMatchObject({
      family: "add",
      channel: 1,
      packetType: 0x0369,
      contentLength: 14,
      blockParam: 0x400000b1,
      provenance: framedProvenance,
    });
    expect(result.diagnostics.inventoryStateAvailable).toBe(false);
  });

  it("states that the stream remains a strict subset", () => {
    expect(summarizeReplayDirectItemPurchaseDiagnostics(result)).toBe(
      "1 direkte Add-only-Item-Käufe mit exakter Paketrahmung dekodiert; kein vollständiger Kauf- oder Inventarverlauf.",
    );
  });

  it("keeps direct purchases distinct on the product timeline without inventing inventory", () => {
    const productSource = readFileSync(
      fileURLToPath(new URL("./components/ProductReplayView.vue", import.meta.url)),
      "utf8",
    );
    const appSource = readFileSync(fileURLToPath(new URL("./App.vue", import.meta.url)), "utf8");

    expect(appSource).toContain("extractReplayDirectItemPurchasesWithWasm(buffer)");
    expect(productSource).toContain("kind: \"direct-purchase\"");
    expect(productSource).toContain("Komponenten-Käufe");
    expect(productSource).toContain("addProvenanceKey");
    expect(productSource).toContain(".sort(compareItemPurchaseEvents)");
    expect(productSource).toContain("kein Slot- oder Inventarstand");
    expect(productSource).not.toMatch(/directItemPurchases(?:\.value)?\.items\s*=/);
  });
});
