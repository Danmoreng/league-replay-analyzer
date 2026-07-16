export interface ReplayKillParticipant {
  participantId: number;
  championName: string | null;
  teamId: number | null;
  teamPosition: string | null;
  riotIdGameName: string | null;
  riotIdTagLine: string | null;
  finalKills: number;
  finalDeaths: number;
  finalAssists: number;
}

export interface ReplayKillProvenance {
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

export interface ReplayKillEvent {
  type: "CHAMPION_KILL";
  timestampMillis: number;
  victimParticipantId: number;
  killerParticipantId: number;
  assistingParticipantIds: number[];
  victimNetworkId: number;
  victimNetworkIdHex: string;
  killerNetworkId: number | null;
  killerNetworkIdHex: string | null;
  assistingNetworkIds: number[];
  provenance: {
    deathMarker: ReplayKillProvenance;
    ownerSequence: ReplayKillProvenance[];
  };
}

export interface ReplayKillKdaValidationRow {
  participantId: number;
  expected: {
    kills: number;
    deaths: number;
    assists: number;
  };
  decoded: {
    kills: number;
    deaths: number;
    assists: number;
  };
  pass: boolean;
}

export interface ReplayKillKdaValidation {
  source: string;
  runtimeInput: string;
  participantCount: number;
  passingParticipantCount: number;
  pass: boolean;
  rows: ReplayKillKdaValidationRow[];
}

export interface ReplayKillResult {
  schema: "rofl-replay-kills/v1";
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
    channel: number;
    ownerSequencePacketType: number;
    ownerSequencePacketTypeHex: string;
    deathMarkerPacketType: number;
    deathMarkerPacketTypeHex: string;
    championNetworkIdBase: number;
    championNetworkIdBaseHex: string;
    ownerOrder: string;
    executionRule: string;
  };
  replay: {
    gameLengthMillis: number | null;
    lastGameChunkId: number | null;
    lastKeyFrameId: number | null;
    metadataOffset: number;
    metadataLength: number;
  };
  participants: ReplayKillParticipant[];
  events: ReplayKillEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    relevantPacketBlockCount: number;
    ownerSequenceBlockCount: number;
    deathMarkerBlockCount: number;
    ignoredDeathMarkerBlockCount: number;
    decodedKillEventCount: number;
    pendingOwnerBlockCount: number;
    exactPacketFraming: boolean;
    signedCompactBlockParamDelta: boolean;
    finalKdaValidation: ReplayKillKdaValidation;
  };
}

export function formatReplayKillTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function replayKillParticipantName(participant: ReplayKillParticipant | undefined): string {
  if (!participant) {
    return "Unknown participant";
  }

  if (participant.riotIdGameName) {
    return participant.riotIdTagLine
      ? `${participant.riotIdGameName}#${participant.riotIdTagLine}`
      : participant.riotIdGameName;
  }

  return `Participant ${participant.participantId}`;
}

export function summarizeReplayKillDiagnostics(result: ReplayKillResult): string {
  const diagnostics = result.diagnostics;
  const validation = diagnostics.finalKdaValidation;
  const framing = diagnostics.exactPacketFraming ? "exact framing" : "inexact framing";
  const kda = validation.pass
    ? `K/D/A matches all ${validation.participantCount} participants`
    : `K/D/A matches ${validation.passingParticipantCount}/${validation.participantCount} participants`;

  return `${diagnostics.decodedKillEventCount} kills decoded with ${framing}; ${kda}.`;
}
