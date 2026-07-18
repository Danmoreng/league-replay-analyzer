export interface ReplayWardProvenance {
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

export interface ReplayWardPlacedEvent {
  type: "WARD_PLACED";
  timestampMillis: number;
  wardEntityNetworkId: number;
  wardEntityNetworkIdHex: string;
  ownerParticipantId: number;
  ownerNetworkId: number;
  ownerNetworkIdHex: string;
  wardType: null;
  position: null;
  provenance: { ownerBlock: ReplayWardProvenance; markerBlock: ReplayWardProvenance };
}

export interface ReplayWardKillEvent {
  type: "WARD_KILL";
  timestampMillis: number;
  wardEntityNetworkId: number;
  wardEntityNetworkIdHex: string;
  killerParticipantId: number;
  killerNetworkId: number;
  killerNetworkIdHex: string;
  wardType: null;
  position: null;
  removalReason: null;
  provenance: { killerOwnerBlock: ReplayWardProvenance; removalBlock: ReplayWardProvenance };
}

export type ReplayWardEvent = ReplayWardPlacedEvent | ReplayWardKillEvent;

export interface ReplayWardResult {
  schema: "rofl-replay-wards/v1";
  generatedAtUtc: string;
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
    channel: number;
    placementMarkerPacketType: number;
    placementMarkerPacketTypeHex: string;
    placementContentLength: number;
    placementDiscriminatorOffset: number;
    placementDiscriminatorValues: number[];
    placementDiscriminatorValuesHex: string[];
    placementOwnerPacketType: number;
    placementOwnerPacketTypeHex: string;
    placementOwnerContentLengths: number[];
    placementOwnerContentLengthRange?: [number, number] | null;
    removalPacketType: number;
    removalPacketTypeHex: string;
    removalContentLengths: number[];
    removalContentLengthRange?: [number, number] | null;
    killerOwnerPacketType: number;
    killerOwnerPacketTypeHex: string;
    killerOwnerContentLengths: number[];
    killerOwnerContentLengthRange?: [number, number] | null;
    championNetworkIdBase: number;
    championNetworkIdBaseHex: string;
    timestampToleranceMillis: number;
    origin?: "built-in" | "external";
    schema?: string;
    registryId?: string;
    revision?: string;
    fingerprint?: string;
  };
  replay: {
    gameLengthMillis: number | null;
    lastGameChunkId: number | null;
    lastKeyFrameId: number | null;
  };
  events: ReplayWardEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    candidatePlacementMarkerBlockCount: number;
    classifiedPlacementMarkerBlockCount: number;
    rejectedPlacementContentLengthBlockCount: number;
    rejectedPlacementClassifierBlockCount: number;
    rejectedUnpairedPlacementMarkerBlockCount: number;
    decodedWardPlacementEventCount: number;
    candidateRemovalBlockCount: number;
    rejectedUntrackedRemovalBlockCount: number;
    rejectedTrackedUnprofiledRemovalBlockCount: number;
    rejectedMissingKillerOwnerBlockCount: number;
    killerOwnerCandidateCollisionCount: number;
    decodedWardKillEventCount: number;
    exactPacketFraming: boolean;
    placementCoverage: "exact-on-validated-corpus";
    removalCoverage: "conservative-partial";
    wardTypeAvailable: false;
    positionAvailable: false;
    visionRadiusAvailable: false;
    removalReasonAvailable: false;
  };
}

export type ReplayWardParticipantLabel = (participantId: number) => string;

export function formatReplayWardTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function replayWardEventLabel(
  event: ReplayWardEvent,
  participantLabel: ReplayWardParticipantLabel = (participantId) => `Participant ${participantId}`,
): string {
  return event.type === "WARD_PLACED"
    ? `${participantLabel(event.ownerParticipantId)} placed a ward`
    : `${participantLabel(event.killerParticipantId)} destroyed a ward`;
}

export function summarizeReplayWardDiagnostics(result: ReplayWardResult): string {
  const diagnostics = result.diagnostics;
  const framing = diagnostics.exactPacketFraming ? "exact framing" : "inexact framing";
  return `${diagnostics.decodedWardPlacementEventCount} ward placements decoded with ${framing} and exact corpus coverage; ${diagnostics.decodedWardKillEventCount} ward kills decoded with conservative partial removal coverage. Ward subtype and position remain unavailable.`;
}
