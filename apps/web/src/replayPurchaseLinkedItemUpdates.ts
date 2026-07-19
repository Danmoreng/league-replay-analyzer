/**
 * Strict replay-only subset of item updates whose resulting item was
 * purchase-linked by the decoder. This is intentionally not a purchase or
 * inventory timeline: slots, instances, removals, and current inventory state
 * remain unavailable.
 */
export interface ReplayPurchaseLinkedItemUpdateProvenance {
  segmentType: string;
  segmentId: number;
  chunkId: number;
  segmentHeaderOffset: number;
  segmentPayloadOffset: number;
  blockIndex: number;
  decompressedHeaderOffset: number;
  decompressedContentOffset: number;
  decompressedEndOffset: number;
}

export interface ReplayPurchaseLinkedItemUpdateBlock {
  family: "add" | "removal" | "removalContext" | "undoComponent";
  packetType: number;
  packetTypeHex: string;
  contentLength: number;
  provenance: ReplayPurchaseLinkedItemUpdateProvenance;
}

export interface ReplayPurchaseLinkedResultingItemUpdateEvent {
  type: "PURCHASE_LINKED_RESULTING_ITEM_UPDATE";
  timestampMillis: number;
  participantId: number;
  participantNetworkId: number;
  participantNetworkIdHex: string;
  resultingItemId: number;
  purchaseLinked: true;
  matchedTemplateIndex: number;
  matchedTemplateSignature: string;
  provenance: {
    addBlock: ReplayPurchaseLinkedItemUpdateBlock;
    groupBlocks: ReplayPurchaseLinkedItemUpdateBlock[];
  };
}

export interface ReplayPurchaseLinkedItemUpdatesResult {
  schema: "rofl-replay-purchase-linked-item-updates/v1";
  generatedAtUtc?: string;
  source: {
    replayPath: string | null;
    replayId: string | null;
    matchId: string | null;
    runtimeInput: "rofl-only";
    riotApiInput: false;
  };
  gameVersion: string;
  versionGroup: string;
  profile: {
    segmentType: string;
    channel: number;
    championNetworkIdBase: number;
    championNetworkIdBaseHex: string;
    addUpdatePacketType: number;
    addUpdatePacketTypeHex: string;
    contentLengths: number[];
    removalPacketType: number;
    removalPacketTypeHex: string;
    removalContentLengths: number[];
    removalContextPacketType: number;
    removalContextPacketTypeHex: string;
    removalContextContentLengths: number[];
    undoComponentPacketType: number;
    undoComponentPacketTypeHex: string;
    templateCount: number;
    origin?: "built-in" | "external";
    schema?: string;
    registryId?: string;
    revision?: string;
    fingerprint?: string;
  };
  events: ReplayPurchaseLinkedResultingItemUpdateEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    profiledAddUpdatePacketCount: number;
    profiledOwnerTimeGroupCount: number;
    matchedTemplateGroupCount: number;
    rejectedNonmatchingGroupCount: number;
    rejectedUnavailableItemIdGroupCount: number;
    emittedEventCount: number;
    unavailableAddUpdatePacketCount: number;
    exactPacketFraming: boolean;
    coverage: "strict-subset-not-complete";
    generalPurchaseClassificationAvailable: false;
    automaticStateUpdateClassificationAvailable: false;
    consumedComponentIdentityAvailable: false;
    removedItemIdentityAvailable: false;
    slotAvailable: false;
    itemInstanceAvailable: false;
    countOrChargesAvailable: false;
    priceAvailable: false;
    goldStateAvailable: false;
    undoAvailable: false;
    inventoryStateAvailable: false;
    completePurchaseTimelineAvailable: false;
    inventoryTimelineAvailable: false;
    currentInventoryAvailable: false;
  };
}

export function formatReplayPurchaseLinkedItemUpdateTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function replayPurchaseLinkedItemUpdateLabel(
  event: ReplayPurchaseLinkedResultingItemUpdateEvent,
  participantLabel: (participantId: number) => string = (participantId) =>
    `Participant ${participantId}`,
): string {
  return `${participantLabel(event.participantId)} · kaufverknüpftes Ergebnis-Item-Update ${event.resultingItemId} (strenger Teilbestand)`;
}

export function summarizeReplayPurchaseLinkedItemUpdateDiagnostics(
  result: ReplayPurchaseLinkedItemUpdatesResult,
): string {
  const diagnostics = result.diagnostics;
  const framing = diagnostics.exactPacketFraming ? "exact framing" : "inexact framing";
  return `${diagnostics.emittedEventCount} purchase-linked resulting-item updates decoded with ${framing}; this strict subset is not a complete purchase or inventory timeline.`;
}
