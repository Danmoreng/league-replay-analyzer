import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayPurchaseLinkedItemUpdateTimestamp,
  replayPurchaseLinkedItemUpdateLabel,
  summarizeReplayPurchaseLinkedItemUpdateDiagnostics,
  type ReplayPurchaseLinkedItemUpdateBlock,
  type ReplayPurchaseLinkedItemUpdatesResult,
  type ReplayPurchaseLinkedResultingItemUpdateEvent,
} from "./replayPurchaseLinkedItemUpdates";

const provenance = {
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

const event: ReplayPurchaseLinkedResultingItemUpdateEvent = {
  type: "PURCHASE_LINKED_RESULTING_ITEM_UPDATE",
  timestampMillis: 754_999,
  participantId: 4,
  participantNetworkId: 0x400000b1,
  participantNetworkIdHex: "0x400000B1",
  resultingItemId: 3157,
  purchaseLinked: true,
  matchedTemplateIndex: 0,
  matchedTemplateSignature: "add(3157)",
  provenance: {
    addBlock: {
      family: "add",
      packetType: 0x0369,
      packetTypeHex: "0x0369",
      contentLength: 14,
      provenance,
    },
    groupBlocks: [],
  },
};

const result: ReplayPurchaseLinkedItemUpdatesResult = {
  schema: "rofl-replay-purchase-linked-item-updates/v1",
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
    removalPacketType: 0x03f9,
    removalPacketTypeHex: "0x03F9",
    removalContentLengths: [6, 7],
    removalContextPacketType: 0x0146,
    removalContextPacketTypeHex: "0x0146",
    removalContextContentLengths: [2, 3, 4],
    undoComponentPacketType: 0x0081,
    undoComponentPacketTypeHex: "0x0081",
    templateCount: 1,
  },
  events: [event],
  diagnostics: {
    footerRecordCount: 91,
    chunkRecordCount: 60,
    decompressedChunkBytes: 10_000,
    packetBlockCount: 25_000,
    profiledAddUpdatePacketCount: 12,
    profiledOwnerTimeGroupCount: 10,
    matchedTemplateGroupCount: 1,
    rejectedNonmatchingGroupCount: 9,
    rejectedUnavailableItemIdGroupCount: 0,
    emittedEventCount: 1,
    unavailableAddUpdatePacketCount: 11,
    exactPacketFraming: true,
    coverage: "strict-subset-not-complete",
    generalPurchaseClassificationAvailable: false,
    automaticStateUpdateClassificationAvailable: false,
    consumedComponentIdentityAvailable: false,
    removedItemIdentityAvailable: false,
    slotAvailable: false,
    itemInstanceAvailable: false,
    countOrChargesAvailable: false,
    priceAvailable: false,
    goldStateAvailable: false,
    undoAvailable: false,
    inventoryStateAvailable: false,
    completePurchaseTimelineAvailable: false,
    inventoryTimelineAvailable: false,
    currentInventoryAvailable: false,
  },
};

describe("purchase-linked resulting-item update presentation helpers", () => {
  it("formats replay timestamps as a match clock", () => {
    expect(formatReplayPurchaseLinkedItemUpdateTimestamp(0)).toBe("0:00");
    expect(formatReplayPurchaseLinkedItemUpdateTimestamp(754_999)).toBe("12:34");
  });

  it("labels only the strict resulting-item subset", () => {
    expect(replayPurchaseLinkedItemUpdateLabel(event, () => "Ahri")).toBe(
      "Ahri · kaufverknüpftes Ergebnis-Item-Update 3157 (strenger Teilbestand)",
    );
  });

  it("keeps replay-only provenance and excludes inventory-state fields", () => {
    expect(result.source).toEqual({
      replayPath: null,
      replayId: null,
      matchId: null,
      runtimeInput: "rofl-only",
      riotApiInput: false,
    });
    expect(event).not.toHaveProperty("slot");
    expect(event).not.toHaveProperty("beforeItemId");
    expect(event).not.toHaveProperty("inventory");
    expect(event).not.toHaveProperty("currentItems");
    expect(event.provenance.addBlock).toMatchObject({
      family: "add",
      packetType: 0x0369,
      contentLength: 14,
      provenance,
    });
    expect(event.provenance.groupBlocks).toEqual([]);
  });

  it("accepts only emitted packet-family names in event provenance", () => {
    const families: ReplayPurchaseLinkedItemUpdateBlock["family"][] = [
      "add",
      "removal",
      "removalContext",
      "undoComponent",
    ];

    expect(families).toEqual(["add", "removal", "removalContext", "undoComponent"]);
  });

  it("states that the stream is not a complete purchase or inventory timeline", () => {
    expect(summarizeReplayPurchaseLinkedItemUpdateDiagnostics(result)).toBe(
      "1 purchase-linked resulting-item updates decoded with exact framing; this strict subset is not a complete purchase or inventory timeline.",
    );
  });

  it("keeps purchase research out of the focused product view", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./components/ProductReplayView.vue", import.meta.url)),
      "utf8",
    );

    expect(source).toContain('kind: "kill"');
    expect(source).toContain('kind: "objective"');
    expect(source).not.toContain('kind: "purchase-update"');
    expect(source).not.toContain("resultingItemId");
    expect(source).not.toContain("purchaseLinkedItemUpdates?.events");
    expect(source).not.toContain("totalGold");
    expect(source).not.toContain("player.items");
    expect(source).not.toContain("function finalItems");
    expect(source).not.toContain("health-bar");
    expect(source).not.toMatch(/purchaseLinkedItemUpdates(?:\.value)?\.items\s*=/);
  });

  it("resets playback early and prevents stale overlapping replay loads", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.vue", import.meta.url)), "utf8");
    const summaryAssignment = source.indexOf("summary.value = parsedSummary");
    const earlyDuration = source.indexOf(
      "setDuration(parsedSummary.gameLengthMillis)",
      summaryAssignment,
    );
    const firstDecoder = source.indexOf('let killStatus = "Kill timeline unavailable."');

    expect(source).toContain("const requestId = ++replayLoadRequest");
    expect(source).toContain("requestId === replayLoadRequest");
    expect(summaryAssignment).toBeGreaterThan(-1);
    expect(earlyDuration).toBeGreaterThan(summaryAssignment);
    expect(earlyDuration).toBeLessThan(firstDecoder);
  });
});
