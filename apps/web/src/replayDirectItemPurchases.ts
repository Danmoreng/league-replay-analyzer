/**
 * Strict replay-only direct purchases. An event is emitted only when the
 * patch profile proves an add-only inventory operation to be a purchase.
 * It deliberately does not describe a slot, item instance, charge count, or
 * any current inventory state.
 */
export interface ReplayDirectItemPurchaseFramedProvenance {
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

export interface ReplayDirectItemPurchaseAddBlock {
  family: "add";
  channel: number;
  packetType: number;
  packetTypeHex: string;
  contentLength: number;
  blockParam: number;
  blockParamHex: string;
  provenance: ReplayDirectItemPurchaseFramedProvenance;
}

/** Explicitly records the intentionally unavailable per-event state. */
export interface ReplayDirectItemPurchaseAvailability {
  slot: false;
  itemInstance: false;
  countOrCharges: false;
  price: false;
  goldState: false;
  inventoryState: false;
}

export interface ReplayDirectItemPurchaseEvent {
  type: "DIRECT_ADD_ONLY_ITEM_PURCHASE";
  timestampMillis: number;
  participantId: number;
  participantNetworkId: number;
  participantNetworkIdHex: string;
  itemId: number;
  /** True for a pinned Data Dragon item with a non-empty `into` relation. */
  componentItem: boolean;
  classification: "direct-add-only";
  availability: ReplayDirectItemPurchaseAvailability;
  provenance: {
    addBlock: ReplayDirectItemPurchaseAddBlock;
  };
}

export interface ReplayDirectItemPurchasesResult {
  schema: "rofl-replay-direct-item-purchases/v1";
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
    blockingPacketTypes: number[];
    blockingPacketTypesHex: string[];
    isolationToleranceMillis: number;
    staticItemCatalog: {
      provider: string;
      version: string;
      locale: string;
      sourceUrl: string;
      sourceByteLength: number;
      sourceSha256: string;
      entryCount: number;
      realItemIdCount: number;
      componentItemIdCount: number;
    };
    origin?: "built-in" | "external";
    schema?: string;
    registryId?: string;
    revision?: string;
    fingerprint?: string;
  };
  events: ReplayDirectItemPurchaseEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    knownInventoryOperationPacketCount: number;
    profiledAddUpdatePacketCount: number;
    knownOwnerTimeGroupCount: number;
    profiledSingleAddOnlyGroupCount: number;
    rejectedNonSingletonGroupCount: number;
    rejectedNonAddOrLengthGroupCount: number;
    rejectedNeighborOperationGroupCount: number;
    rejectedUnavailableItemIdGroupCount: number;
    rejectedStaticItemCatalogGroupCount: number;
    emittedEventCount: number;
    componentItemEventCount: number;
    exactPacketFraming: boolean;
    coverage: "strict-direct-add-only-subset-not-complete";
    generalPurchaseClassificationAvailable: false;
    slotAvailable: false;
    itemInstanceAvailable: false;
    countOrChargesAvailable: false;
    priceAvailable: false;
    goldStateAvailable: false;
    inventoryStateAvailable: false;
    removedItemIdentityAvailable: false;
    undoAvailable: false;
  };
}

export type ReplayDirectItemPurchaseParticipantLabel = (participantId: number) => string;
export type ReplayDirectItemPurchaseItemLabel = (itemId: number) => string;

export function formatReplayDirectItemPurchaseTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * German, timeline-safe label. The wording intentionally describes only the
 * decoded operation and never claims that the item occupies an inventory slot.
 */
export function replayDirectItemPurchaseLabel(
  event: ReplayDirectItemPurchaseEvent,
  participantLabel: ReplayDirectItemPurchaseParticipantLabel = (participantId) =>
    `Spieler ${participantId}`,
  itemLabel: ReplayDirectItemPurchaseItemLabel = (itemId) => `Item ${itemId}`,
): string {
  const purchaseKind = event.componentItem ? "direkter Komponenten-Kauf" : "direkter Item-Kauf";
  return `${participantLabel(event.participantId)} · ${purchaseKind}: ${itemLabel(event.itemId)}`;
}

export function summarizeReplayDirectItemPurchaseDiagnostics(
  result: ReplayDirectItemPurchasesResult,
): string {
  const framing = result.diagnostics.exactPacketFraming ? "exakter Paketrahmung" : "ungenauer Paketrahmung";
  return `${result.diagnostics.emittedEventCount} direkte Add-only-Item-Käufe mit ${framing} dekodiert; kein vollständiger Kauf- oder Inventarverlauf.`;
}
