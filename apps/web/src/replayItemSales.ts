/**
 * Strict replay-only item-sale operations. The classifier proves a sale
 * operation, not the identity of the item that was sold and not an inventory
 * transition. Every omitted state value is represented as explicitly false.
 */
export interface ReplayItemSaleFramedProvenance {
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

export interface ReplayItemSaleRemovalBlock {
  family: "removal";
  channel: number;
  packetType: number;
  packetTypeHex: string;
  contentLength: number;
  blockParam: number;
  blockParamHex: string;
  provenance: ReplayItemSaleFramedProvenance;
}

export interface ReplayItemSaleAvailability {
  soldItemId: false;
  slot: false;
  itemInstance: false;
  countOrCharges: false;
  price: false;
  goldGain: false;
  inventoryState: false;
  undo: false;
}

export interface ReplayItemSaleEvent {
  type: "ITEM_SOLD_OPERATION";
  timestampMillis: number;
  participantId: number;
  participantNetworkId: number;
  participantNetworkIdHex: string;
  availability: ReplayItemSaleAvailability;
  provenance: {
    removalBlock: ReplayItemSaleRemovalBlock;
  };
}

export interface ReplayItemSalesResult {
  schema: "rofl-replay-item-sales/v1";
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
    addUpdateContentLengths: number[];
    removalPacketType: number;
    removalPacketTypeHex: string;
    removalContentLengths: number[];
    groupTimestampToleranceMillis: 0;
    requiredAddUpdateCount: 0;
    requiredRemovalCount: 1;
    payload0LowNibbleValues: number[];
    payload2LowBitsMask: 3;
    payload2RejectedLowBitsValue: 3;
    salePayloadByte2Values: number[];
    salePayloadByte2ValuesHex?: string[];
    origin?: "built-in" | "external";
    schema?: string;
    registryId?: string;
    revision?: string;
    fingerprint?: string;
  };
  events: ReplayItemSaleEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    profiledInventoryOperationPacketCount: number;
    profiledAddUpdatePacketCount: number;
    profiledRemovalPacketCount: number;
    ownerTimestampGroupCount: number;
    singleRemovalNoAddGroupCount: number;
    rejectedGroupShapeCount: number;
    rejectedPayloadPredicateGroupCount: number;
    rejectedUnprofiledSaleDiscriminatorGroupCount: number;
    emittedEventCount: number;
    exactPacketFraming: true;
    coverage: "exact-sale-operation-only";
    soldItemIdAvailable: false;
    slotAvailable: false;
    itemInstanceAvailable: false;
    countOrChargesAvailable: false;
    priceAvailable: false;
    goldGainAvailable: false;
    inventoryStateAvailable: false;
    undoAvailable: false;
  };
}

export type ReplayItemSaleParticipantLabel = (participantId: number) => string;

export function formatReplayItemSaleTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The sale decoder intentionally cannot identify the sold item, inventory
 * slot, or gold amount, so the product label makes no such claim.
 */
export function replayItemSaleLabel(
  event: ReplayItemSaleEvent,
  participantLabel: ReplayItemSaleParticipantLabel = (participantId) => `Spieler ${participantId}`,
): string {
  return `${participantLabel(event.participantId)} · Verkaufsoperation`;
}

export function summarizeReplayItemSaleDiagnostics(result: ReplayItemSalesResult): string {
  const framing = result.diagnostics.exactPacketFraming ? "exakter Paketrahmung" : "ungenauer Paketrahmung";
  const operationLabel =
    result.diagnostics.emittedEventCount === 1 ? "Verkaufsoperation" : "Verkaufsoperationen";
  return `${result.diagnostics.emittedEventCount} ${operationLabel} mit ${framing} dekodiert; Item, Inventar und Goldgewinn sind weiterhin nicht verfügbar.`;
}
