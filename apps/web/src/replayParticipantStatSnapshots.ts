/**
 * Patch-pinned replay-native participant stat snapshots. These are decoded
 * keyframe states, not final stats and not inferred values between snapshots.
 */
export interface ReplayParticipantStatSnapshotFramedProvenance {
  segmentType: "keyframe";
  segmentId: number;
  chunkId: number;
  segmentHeaderOffset: number;
  segmentPayloadOffset: number;
  blockIndex: number;
  decompressedHeaderOffset: number;
  decompressedContentOffset: number;
  decompressedEndOffset: number;
}

export interface ReplayParticipantStatSnapshotBlock {
  channel: 1;
  packetType: number;
  packetTypeHex: string;
  contentLength: number;
  blockParam: number;
  blockParamHex: string;
  provenance: ReplayParticipantStatSnapshotFramedProvenance;
}

export interface ReplayParticipantStatSnapshot {
  timestampMillis: number;
  participantId: number;
  experience: number | null;
  level: number | null;
  totalGold: number | null;
  laneMinionsKilled: number;
  neutralMinionsKilled: number;
  provenance: {
    snapshotBlock: ReplayParticipantStatSnapshotBlock;
  };
}

export interface ReplayParticipantStatSnapshotsResult {
  schema: "rofl-replay-participant-stat-snapshots/v4";
  generatedAtUtc?: string;
  source: {
    replayPath: string | null;
    replayId: string | null;
    matchId: string | null;
    runtimeInput: "rofl-only";
    riotApiInput: false;
  };
  gameVersion: string;
  versionGroup: "15.22" | "15.23" | "15.24" | "16.1" | "16.5" | "16.6" | "16.7" | "16.9" | "16.14";
  profile: {
    segmentType: "keyframe";
    channel: 1;
    snapshotPacketType: number;
    snapshotPacketTypeHex: string;
    snapshotContentLength: number;
    championNetworkIdBase: number;
    championNetworkIdBaseHex: string;
    experienceAvailable: boolean;
    totalGoldAvailable: boolean;
    levelDerivation: "xp-thresholds-with-replay-final-level-cap" | null;
    neutralMinionsKilledProjection: "floor-plus-1e-5" | "floor-plus-2e-5";
    origin: "external";
    schema: "rofl-replay-decoder-profiles/v1";
    registryId: string;
    revision: string;
    fingerprint: string;
  };
  snapshots: ReplayParticipantStatSnapshot[];
  diagnostics: {
    keyframeRecordCount: number;
    keyframeSegmentCount: number;
    decompressedKeyframeBytes: number;
    packetBlockCount: number;
    profiledSnapshotPacketCount: number;
    rejectedInvalidOwnerPacketCount: number;
    rejectedInvalidValuePacketCount: number;
    emittedSnapshotCount: number;
    exactPacketFraming: true;
    coverage: "profiled-keyframe-participant-stats-only";
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Participant stat snapshots: '${name}' must be an object.`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Participant stat snapshots: '${name}' must be a non-empty string.`);
  }
  return value;
}

function requiredNullableString(value: unknown, name: string): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error(`Participant stat snapshots: '${name}' must be string or null.`);
}

function requiredInteger(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Participant stat snapshots: '${name}' must be a safe integer >= ${minimum}.`);
  }
  return value;
}

function requiredFiniteNumber(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Participant stat snapshots: '${name}' must be a finite number >= ${minimum}.`);
  }
  return value;
}

function requiredNullableFiniteNumber(value: unknown, name: string): number | null {
  return value === null ? null : requiredFiniteNumber(value, name);
}

function requiredNullableInteger(value: unknown, name: string, minimum = 0): number | null {
  return value === null ? null : requiredInteger(value, name, minimum);
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Participant stat snapshots: '${name}' must be boolean.`);
  }
  return value;
}

function requiredLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  name: string,
): T {
  if (value !== expected) {
    throw new Error(`Participant stat snapshots: '${name}' must be ${JSON.stringify(expected)}.`);
  }
  return expected;
}

function parseFramedProvenance(value: unknown): ReplayParticipantStatSnapshotFramedProvenance {
  const record = requiredRecord(value, "snapshotBlock.provenance");
  return {
    segmentType: requiredLiteral(
      record.segmentType,
      "keyframe",
      "snapshotBlock.provenance.segmentType",
    ),
    segmentId: requiredInteger(record.segmentId, "snapshotBlock.provenance.segmentId", 1),
    chunkId: requiredInteger(record.chunkId, "snapshotBlock.provenance.chunkId", 0),
    segmentHeaderOffset: requiredInteger(
      record.segmentHeaderOffset,
      "snapshotBlock.provenance.segmentHeaderOffset",
    ),
    segmentPayloadOffset: requiredInteger(
      record.segmentPayloadOffset,
      "snapshotBlock.provenance.segmentPayloadOffset",
    ),
    blockIndex: requiredInteger(record.blockIndex, "snapshotBlock.provenance.blockIndex"),
    decompressedHeaderOffset: requiredInteger(
      record.decompressedHeaderOffset,
      "snapshotBlock.provenance.decompressedHeaderOffset",
    ),
    decompressedContentOffset: requiredInteger(
      record.decompressedContentOffset,
      "snapshotBlock.provenance.decompressedContentOffset",
    ),
    decompressedEndOffset: requiredInteger(
      record.decompressedEndOffset,
      "snapshotBlock.provenance.decompressedEndOffset",
    ),
  };
}

function parseSnapshot(value: unknown): ReplayParticipantStatSnapshot {
  const record = requiredRecord(value, "snapshot");
  const provenance = requiredRecord(record.provenance, "snapshot.provenance");
  const block = requiredRecord(provenance.snapshotBlock, "snapshot.provenance.snapshotBlock");
  return {
    timestampMillis: requiredInteger(record.timestampMillis, "snapshot.timestampMillis"),
    participantId: requiredInteger(record.participantId, "snapshot.participantId", 1),
    experience: requiredNullableFiniteNumber(record.experience, "snapshot.experience"),
    level: requiredNullableInteger(record.level, "snapshot.level", 1),
    totalGold: requiredNullableFiniteNumber(record.totalGold, "snapshot.totalGold"),
    laneMinionsKilled: requiredInteger(record.laneMinionsKilled, "snapshot.laneMinionsKilled"),
    neutralMinionsKilled: requiredInteger(
      record.neutralMinionsKilled,
      "snapshot.neutralMinionsKilled",
    ),
    provenance: {
      snapshotBlock: {
        channel: requiredLiteral(block.channel, 1, "snapshotBlock.channel"),
        packetType: requiredInteger(block.packetType, "snapshotBlock.packetType", 1),
        packetTypeHex: requiredString(block.packetTypeHex, "snapshotBlock.packetTypeHex"),
        contentLength: requiredInteger(block.contentLength, "snapshotBlock.contentLength", 1),
        blockParam: requiredInteger(block.blockParam, "snapshotBlock.blockParam", 1),
        blockParamHex: requiredString(block.blockParamHex, "snapshotBlock.blockParamHex"),
        provenance: parseFramedProvenance(block.provenance),
      },
    },
  };
}

/**
 * Validates the Wasm JSON boundary before it becomes typed product state.
 * A malformed or widened result is rejected instead of being treated as a
 * sparse snapshot timeline.
 */
export function parseReplayParticipantStatSnapshotsResult(
  value: unknown,
): ReplayParticipantStatSnapshotsResult {
  const record = requiredRecord(value, "result");
  requiredLiteral(record.schema, "rofl-replay-participant-stat-snapshots/v4", "schema");
  const source = requiredRecord(record.source, "source");
  const profile = requiredRecord(record.profile, "profile");
  const diagnostics = requiredRecord(record.diagnostics, "diagnostics");
  if (!Array.isArray(record.snapshots)) {
    throw new Error("Participant stat snapshots: 'snapshots' must be an array.");
  }

  const snapshots = record.snapshots.map(parseSnapshot);
  const supportedExactBuilds = new Set([
    "15.22.724.5161",
    "15.23.728.3286",
    "15.24.733.6673",
    "16.1.737.4870",
    "16.5.752.7101",
    "16.6.755.2788",
    "16.6.756.0931",
    "16.7.758.4427",
    "16.7.760.9485",
    "16.9.771.8383",
    "16.9.772.1032",
    "16.9.772.8292",
    "16.14.794.5912",
  ]);
  const gameVersion = requiredString(record.gameVersion, "gameVersion");
  if (!supportedExactBuilds.has(gameVersion)) {
    throw new Error(
      "Participant stat snapshots: 'gameVersion' has no promoted exact-build CS grammar.",
    );
  }
  const versionGroup = gameVersion
    .split(".")
    .slice(0, 2)
    .join(".") as ReplayParticipantStatSnapshotsResult["versionGroup"];
  if (record.versionGroup !== versionGroup) {
    throw new Error("Participant stat snapshots: 'versionGroup' does not match gameVersion.");
  }
  if (
    !Number.isInteger(profile.snapshotPacketType) ||
    Number(profile.snapshotPacketType) <= 0 ||
    !Number.isInteger(profile.snapshotContentLength) ||
    Number(profile.snapshotContentLength) < 1000 ||
    Number(profile.snapshotContentLength) > 4096 ||
    !Number.isInteger(profile.championNetworkIdBase) ||
    Number(profile.championNetworkIdBase) <= 0
  ) {
    throw new Error(
      "Participant stat snapshots: profile packet, length, or champion owner base is unsupported.",
    );
  }
  const snapshotPacketType = requiredInteger(
    profile.snapshotPacketType,
    "profile.snapshotPacketType",
    1,
  );
  const snapshotContentLength = requiredInteger(
    profile.snapshotContentLength,
    "profile.snapshotContentLength",
    1,
  );
  const championNetworkIdBase = requiredInteger(
    profile.championNetworkIdBase,
    "profile.championNetworkIdBase",
    1,
  );
  const experienceAvailable = requiredBoolean(
    profile.experienceAvailable,
    "profile.experienceAvailable",
  );
  const totalGoldAvailable = requiredBoolean(
    profile.totalGoldAvailable,
    "profile.totalGoldAvailable",
  );
  if (experienceAvailable !== totalGoldAvailable) {
    throw new Error(
      "Participant stat snapshots: XP/level and total-gold availability must change together.",
    );
  }
  if (
    experienceAvailable !==
    (profile.levelDerivation === "xp-thresholds-with-replay-final-level-cap")
  ) {
    throw new Error("Participant stat snapshots: level derivation does not match XP availability.");
  }
  for (let index = 1; index < snapshots.length; index += 1) {
    const previous = snapshots[index - 1];
    const current = snapshots[index];
    if (
      current.timestampMillis === previous.timestampMillis &&
      current.participantId === previous.participantId
    ) {
      throw new Error(
        "Participant stat snapshots: duplicate participant snapshots at one timestamp are ambiguous.",
      );
    }
    if (
      current.timestampMillis < previous.timestampMillis ||
      (current.timestampMillis === previous.timestampMillis &&
        current.participantId < previous.participantId)
    ) {
      throw new Error(
        "Participant stat snapshots: snapshots must be ordered by timestamp and participant.",
      );
    }
  }
  const previousByParticipant = new Map<number, ReplayParticipantStatSnapshot>();
  for (const snapshot of snapshots) {
    const block = snapshot.provenance.snapshotBlock;
    if (
      snapshot.participantId > 10 ||
      (snapshot.level !== null && snapshot.level > 20) ||
      experienceAvailable !== (snapshot.experience !== null && snapshot.level !== null) ||
      totalGoldAvailable !== (snapshot.totalGold !== null) ||
      block.packetType !== snapshotPacketType ||
      block.contentLength !== snapshotContentLength ||
      block.blockParam !== championNetworkIdBase + snapshot.participantId
    ) {
      throw new Error(
        "Participant stat snapshots: snapshot provenance does not match the selected exact profile.",
      );
    }
    const previous = previousByParticipant.get(snapshot.participantId);
    if (
      previous &&
      ((snapshot.experience !== null &&
        previous.experience !== null &&
        snapshot.experience < previous.experience) ||
        (snapshot.level !== null && previous.level !== null && snapshot.level < previous.level) ||
        (snapshot.totalGold !== null &&
          previous.totalGold !== null &&
          snapshot.totalGold < previous.totalGold) ||
        snapshot.laneMinionsKilled < previous.laneMinionsKilled ||
        snapshot.neutralMinionsKilled < previous.neutralMinionsKilled)
    ) {
      throw new Error(
        "Participant stat snapshots: participant values must be monotonic across keyframes.",
      );
    }
    previousByParticipant.set(snapshot.participantId, snapshot);
  }
  const profiledSnapshotPacketCount = requiredInteger(
    diagnostics.profiledSnapshotPacketCount,
    "diagnostics.profiledSnapshotPacketCount",
  );
  const emittedSnapshotCount = requiredInteger(
    diagnostics.emittedSnapshotCount,
    "diagnostics.emittedSnapshotCount",
  );
  const rejectedInvalidOwnerPacketCount = requiredInteger(
    diagnostics.rejectedInvalidOwnerPacketCount,
    "diagnostics.rejectedInvalidOwnerPacketCount",
  );
  const rejectedInvalidValuePacketCount = requiredInteger(
    diagnostics.rejectedInvalidValuePacketCount,
    "diagnostics.rejectedInvalidValuePacketCount",
  );
  if (
    emittedSnapshotCount !== snapshots.length ||
    profiledSnapshotPacketCount !== emittedSnapshotCount ||
    rejectedInvalidOwnerPacketCount !== 0 ||
    rejectedInvalidValuePacketCount !== 0
  ) {
    throw new Error(
      "Participant stat snapshots: diagnostics do not describe a complete fail-closed snapshot stream.",
    );
  }
  const keyframeSegmentCount = requiredInteger(
    diagnostics.keyframeSegmentCount,
    "diagnostics.keyframeSegmentCount",
    1,
  );
  if (snapshots.length !== keyframeSegmentCount * 10) {
    throw new Error(
      "Participant stat snapshots: every keyframe must contain exactly ten participant snapshots.",
    );
  }
  for (let start = 0; start < snapshots.length; start += 10) {
    const timestampMillis = snapshots[start]!.timestampMillis;
    if (start > 0 && timestampMillis <= snapshots[start - 1]!.timestampMillis) {
      throw new Error(
        "Participant stat snapshots: keyframe snapshot groups must be strictly increasing.",
      );
    }
    for (let participantId = 1; participantId <= 10; participantId += 1) {
      const snapshot = snapshots[start + participantId - 1];
      if (
        !snapshot ||
        snapshot.timestampMillis !== timestampMillis ||
        snapshot.participantId !== participantId
      ) {
        throw new Error(
          "Participant stat snapshots: every keyframe must contain participant IDs 1 through 10.",
        );
      }
    }
  }

  return {
    schema: "rofl-replay-participant-stat-snapshots/v4",
    ...(typeof record.generatedAtUtc === "string" ? { generatedAtUtc: record.generatedAtUtc } : {}),
    source: {
      replayPath: requiredNullableString(source.replayPath, "source.replayPath"),
      replayId: requiredNullableString(source.replayId, "source.replayId"),
      matchId: requiredNullableString(source.matchId, "source.matchId"),
      runtimeInput: requiredLiteral(source.runtimeInput, "rofl-only", "source.runtimeInput"),
      riotApiInput: requiredLiteral(source.riotApiInput, false, "source.riotApiInput"),
    },
    gameVersion,
    versionGroup,
    profile: {
      segmentType: requiredLiteral(profile.segmentType, "keyframe", "profile.segmentType"),
      channel: requiredLiteral(profile.channel, 1, "profile.channel"),
      snapshotPacketType,
      snapshotPacketTypeHex: requiredString(
        profile.snapshotPacketTypeHex,
        "profile.snapshotPacketTypeHex",
      ),
      snapshotContentLength,
      championNetworkIdBase,
      championNetworkIdBaseHex: requiredString(
        profile.championNetworkIdBaseHex,
        "profile.championNetworkIdBaseHex",
      ),
      experienceAvailable,
      totalGoldAvailable,
      levelDerivation:
        profile.levelDerivation === null
          ? null
          : requiredLiteral(
              profile.levelDerivation,
              "xp-thresholds-with-replay-final-level-cap",
              "profile.levelDerivation",
            ),
      neutralMinionsKilledProjection:
        profile.neutralMinionsKilledProjection === "floor-plus-2e-5"
          ? "floor-plus-2e-5"
          : requiredLiteral(
              profile.neutralMinionsKilledProjection,
              "floor-plus-1e-5",
              "profile.neutralMinionsKilledProjection",
            ),
      origin: requiredLiteral(profile.origin, "external", "profile.origin"),
      schema: requiredLiteral(profile.schema, "rofl-replay-decoder-profiles/v1", "profile.schema"),
      registryId: requiredString(profile.registryId, "profile.registryId"),
      revision: requiredString(profile.revision, "profile.revision"),
      fingerprint: requiredString(profile.fingerprint, "profile.fingerprint"),
    },
    snapshots,
    diagnostics: {
      keyframeRecordCount: requiredInteger(
        diagnostics.keyframeRecordCount,
        "diagnostics.keyframeRecordCount",
      ),
      keyframeSegmentCount,
      decompressedKeyframeBytes: requiredInteger(
        diagnostics.decompressedKeyframeBytes,
        "diagnostics.decompressedKeyframeBytes",
      ),
      packetBlockCount: requiredInteger(
        diagnostics.packetBlockCount,
        "diagnostics.packetBlockCount",
      ),
      profiledSnapshotPacketCount,
      rejectedInvalidOwnerPacketCount,
      rejectedInvalidValuePacketCount,
      emittedSnapshotCount,
      exactPacketFraming: requiredLiteral(
        diagnostics.exactPacketFraming,
        true,
        "diagnostics.exactPacketFraming",
      ),
      coverage: requiredLiteral(
        diagnostics.coverage,
        "profiled-keyframe-participant-stats-only",
        "diagnostics.coverage",
      ),
    },
  };
}

export function formatReplayParticipantStatSnapshotTimestamp(timestampMillis: number): string {
  const totalSeconds = Math.max(0, Math.floor(timestampMillis / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}
