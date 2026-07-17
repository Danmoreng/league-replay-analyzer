export type ReplayObjectiveMonsterType =
  | "DRAGON"
  | "ATAKHAN"
  | "BARON_NASHOR"
  | "RIFTHERALD"
  | "HORDE"
  | "UNKNOWN";

export interface ReplayObjectiveProvenance {
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

export interface ReplayObjectiveEvent {
  type: "ELITE_MONSTER_KILL";
  timestampMillis: number;
  monsterType: ReplayObjectiveMonsterType;
  monsterSubtype: null;
  killerParticipantId: null;
  killerTeamId: null;
  contentLength: number;
  discriminator: number;
  provenance: ReplayObjectiveProvenance;
}

export interface ReplayObjectiveResult {
  schema: "rofl-replay-objectives/v1";
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
    packetType: number;
    packetTypeHex: string;
    minimumContentLength: number;
    maximumContentLength: number;
    discriminatorOffset: number;
    classifier: string;
  };
  replay: {
    gameLengthMillis: number | null;
    lastGameChunkId: number | null;
    lastKeyFrameId: number | null;
  };
  events: ReplayObjectiveEvent[];
  diagnostics: {
    footerRecordCount: number;
    chunkRecordCount: number;
    decompressedChunkBytes: number;
    packetBlockCount: number;
    candidatePacketBlockCount: number;
    profileLengthPacketBlockCount: number;
    rejectedContentLengthBlockCount: number;
    decodedObjectiveEventCount: number;
    unknownMonsterTypeCount: number;
    monsterCounts: Partial<Record<ReplayObjectiveMonsterType, number>>;
    exactPacketFraming: boolean;
    killerOwnershipAvailable: false;
    elementalDragonSubtypeAvailable: false;
  };
}

const monsterLabels: Record<ReplayObjectiveMonsterType, string> = {
  DRAGON: "Dragon",
  ATAKHAN: "Atakhan",
  BARON_NASHOR: "Baron Nashor",
  RIFTHERALD: "Rift Herald",
  HORDE: "Horde / Void Grubs",
  UNKNOWN: "Unknown elite monster",
};

export function formatReplayObjectiveTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function replayObjectiveMonsterLabel(monsterType: ReplayObjectiveMonsterType): string {
  return monsterLabels[monsterType];
}

export function summarizeReplayObjectiveDiagnostics(result: ReplayObjectiveResult): string {
  const diagnostics = result.diagnostics;
  const framing = diagnostics.exactPacketFraming ? "exact packet framing" : "inexact framing";
  const unknownCandidateSummary = diagnostics.unknownMonsterTypeCount === 0
    ? "No profile-length candidates had an unknown monster class."
    : `${diagnostics.unknownMonsterTypeCount} profile-length ${
        diagnostics.unknownMonsterTypeCount === 1 ? "candidate was" : "candidates were"
      } rejected because the monster class was unknown.`;
  return `${diagnostics.decodedObjectiveEventCount} elite-monster objectives decoded with ${framing}; every emitted event has a broad monster class. ${unknownCandidateSummary} Killer ownership and elemental dragon subtype remain unresolved.`;
}
