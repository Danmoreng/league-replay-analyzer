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
  experience: number;
  level: number;
  totalGold: number;
  laneMinionsKilled: number;
  neutralMinionsKilled: number;
  provenance: {
    snapshotBlock: ReplayParticipantStatSnapshotBlock;
  };
}

export interface ReplayParticipantStatSnapshotsResult {
  schema: "rofl-replay-participant-stat-snapshots/v3";
  generatedAtUtc?: string;
  source: {
    replayPath: string | null;
    replayId: string | null;
    matchId: string | null;
    runtimeInput: "rofl-only";
    riotApiInput: false;
  };
  gameVersion: string;
  versionGroup: "16.14";
  profile: {
    segmentType: "keyframe";
    channel: 1;
    snapshotPacketType: number;
    snapshotPacketTypeHex: string;
    snapshotContentLength: number;
    championNetworkIdBase: number;
    championNetworkIdBaseHex: string;
    levelDerivation: "patch-16.14-xp-thresholds-with-replay-final-level-cap";
    neutralMinionsKilledProjection: "floor-plus-1e-5";
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
    experience: requiredFiniteNumber(record.experience, "snapshot.experience"),
    level: requiredInteger(record.level, "snapshot.level", 1),
    totalGold: requiredFiniteNumber(record.totalGold, "snapshot.totalGold"),
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
  requiredLiteral(record.schema, "rofl-replay-participant-stat-snapshots/v3", "schema");
  const source = requiredRecord(record.source, "source");
  const profile = requiredRecord(record.profile, "profile");
  const diagnostics = requiredRecord(record.diagnostics, "diagnostics");
  if (!Array.isArray(record.snapshots)) {
    throw new Error("Participant stat snapshots: 'snapshots' must be an array.");
  }

  const snapshots = record.snapshots.map(parseSnapshot);
  if (record.gameVersion !== "16.14.794.5912") {
    throw new Error(
      "Participant stat snapshots: 'gameVersion' must be the exact supported 16.14 build.",
    );
  }
  if (
    profile.snapshotPacketType !== 0x02eb ||
    profile.snapshotContentLength !== 1479 ||
    profile.championNetworkIdBase !== 0x400000ad
  ) {
    throw new Error(
      "Participant stat snapshots: profile packet, length, or champion owner base is unsupported.",
    );
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
      snapshot.level > 20 ||
      block.packetType !== profile.snapshotPacketType ||
      block.contentLength !== profile.snapshotContentLength ||
      block.blockParam !== profile.championNetworkIdBase + snapshot.participantId
    ) {
      throw new Error(
        "Participant stat snapshots: snapshot provenance does not match the selected exact profile.",
      );
    }
    const previous = previousByParticipant.get(snapshot.participantId);
    if (
      previous &&
      (snapshot.experience < previous.experience ||
        snapshot.level < previous.level ||
        snapshot.totalGold < previous.totalGold ||
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
    schema: "rofl-replay-participant-stat-snapshots/v3",
    ...(typeof record.generatedAtUtc === "string" ? { generatedAtUtc: record.generatedAtUtc } : {}),
    source: {
      replayPath: requiredNullableString(source.replayPath, "source.replayPath"),
      replayId: requiredNullableString(source.replayId, "source.replayId"),
      matchId: requiredNullableString(source.matchId, "source.matchId"),
      runtimeInput: requiredLiteral(source.runtimeInput, "rofl-only", "source.runtimeInput"),
      riotApiInput: requiredLiteral(source.riotApiInput, false, "source.riotApiInput"),
    },
    gameVersion: requiredString(record.gameVersion, "gameVersion"),
    versionGroup: requiredLiteral(record.versionGroup, "16.14", "versionGroup"),
    profile: {
      segmentType: requiredLiteral(profile.segmentType, "keyframe", "profile.segmentType"),
      channel: requiredLiteral(profile.channel, 1, "profile.channel"),
      snapshotPacketType: requiredInteger(
        profile.snapshotPacketType,
        "profile.snapshotPacketType",
        1,
      ),
      snapshotPacketTypeHex: requiredString(
        profile.snapshotPacketTypeHex,
        "profile.snapshotPacketTypeHex",
      ),
      snapshotContentLength: requiredInteger(
        profile.snapshotContentLength,
        "profile.snapshotContentLength",
        1,
      ),
      championNetworkIdBase: requiredInteger(
        profile.championNetworkIdBase,
        "profile.championNetworkIdBase",
        1,
      ),
      championNetworkIdBaseHex: requiredString(
        profile.championNetworkIdBaseHex,
        "profile.championNetworkIdBaseHex",
      ),
      levelDerivation: requiredLiteral(
        profile.levelDerivation,
        "patch-16.14-xp-thresholds-with-replay-final-level-cap",
        "profile.levelDerivation",
      ),
      neutralMinionsKilledProjection: requiredLiteral(
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
