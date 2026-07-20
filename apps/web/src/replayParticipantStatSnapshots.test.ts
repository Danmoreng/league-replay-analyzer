import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayParticipantStatSnapshotTimestamp,
  parseReplayParticipantStatSnapshotsResult,
  type ReplayParticipantStatSnapshotsResult,
} from "./replayParticipantStatSnapshots";

const result: ReplayParticipantStatSnapshotsResult = {
  schema: "rofl-replay-participant-stat-snapshots/v4",
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
    segmentType: "keyframe",
    channel: 1,
    snapshotPacketType: 0x02eb,
    snapshotPacketTypeHex: "0x02EB",
    snapshotContentLength: 1479,
    championNetworkIdBase: 0x400000ad,
    championNetworkIdBaseHex: "0x400000AD",
    experienceAvailable: true,
    experienceProjection: "float32",
    totalGoldAvailable: true,
    levelDerivation: "xp-thresholds-with-replay-final-level-cap",
    neutralMinionsKilledProjection: "floor-plus-1e-5",
    origin: "external",
    schema: "rofl-replay-decoder-profiles/v1",
    registryId: "participant-stat-snapshots-contract",
    revision: "1",
    fingerprint: "fnv1a64:0123456789abcdef",
  },
  snapshots: Array.from({ length: 10 }, (_, index) => {
    const participantId = index + 1;
    return {
      timestampMillis: 60_020,
      participantId,
      experience: 1_140 + participantId,
      level: 4,
      totalGold: 1_200 + participantId,
      laneMinionsKilled: participantId,
      neutralMinionsKilled: participantId * 4,
      provenance: {
        snapshotBlock: {
          channel: 1 as const,
          packetType: 0x02eb,
          packetTypeHex: "0x02EB",
          contentLength: 1479,
          blockParam: 0x400000ad + participantId,
          blockParamHex: `0x${(0x400000ad + participantId).toString(16).toUpperCase()}`,
          provenance: {
            segmentType: "keyframe" as const,
            segmentId: 2,
            chunkId: 5,
            segmentHeaderOffset: 100,
            segmentPayloadOffset: 117,
            blockIndex: 400 + participantId,
            decompressedHeaderOffset: 800 + participantId,
            decompressedContentOffset: 820 + participantId,
            decompressedEndOffset: 2_299 + participantId,
          },
        },
      },
    };
  }),
  diagnostics: {
    keyframeRecordCount: 1,
    keyframeSegmentCount: 1,
    decompressedKeyframeBytes: 123_456,
    packetBlockCount: 312_321,
    profiledSnapshotPacketCount: 10,
    rejectedInvalidOwnerPacketCount: 0,
    rejectedInvalidValuePacketCount: 0,
    emittedSnapshotCount: 10,
    exactPacketFraming: true,
    coverage: "profiled-keyframe-participant-stats-only",
  },
};

describe("participant stat snapshot contract", () => {
  it("accepts the exact replay-only, externally profiled snapshot schema", () => {
    expect(parseReplayParticipantStatSnapshotsResult(result)).toEqual(result);
  });

  it("accepts a fail-closed CS-only capability without fabricating XP, level, or gold", () => {
    const historical = structuredClone(result);
    historical.gameVersion = "15.24.733.6673";
    historical.versionGroup = "15.24";
    historical.profile.snapshotPacketType = 34;
    historical.profile.snapshotPacketTypeHex = "0x0022";
    historical.profile.snapshotContentLength = 1291;
    historical.profile.championNetworkIdBase = 1073742151;
    historical.profile.championNetworkIdBaseHex = "0x40000147";
    historical.profile.experienceAvailable = false;
    historical.profile.experienceProjection = null;
    historical.profile.totalGoldAvailable = false;
    historical.profile.levelDerivation = null;
    for (const snapshot of historical.snapshots) {
      snapshot.experience = null;
      snapshot.level = null;
      snapshot.totalGold = null;
      snapshot.provenance.snapshotBlock.packetType = 34;
      snapshot.provenance.snapshotBlock.packetTypeHex = "0x0022";
      snapshot.provenance.snapshotBlock.contentLength = 1291;
      snapshot.provenance.snapshotBlock.blockParam =
        historical.profile.championNetworkIdBase + snapshot.participantId;
    }
    expect(parseReplayParticipantStatSnapshotsResult(historical)).toEqual(historical);
  });

  it("accepts replay-native XP and level without pretending cumulative gold is available", () => {
    const xpOnly = structuredClone(result);
    xpOnly.profile.experienceProjection = "floor-invariant";
    xpOnly.profile.totalGoldAvailable = false;
    for (const snapshot of xpOnly.snapshots) {
      snapshot.experience = Math.floor(snapshot.experience!);
      snapshot.totalGold = null;
    }
    expect(parseReplayParticipantStatSnapshotsResult(xpOnly)).toEqual(xpOnly);
  });

  it("formats snapshot timestamps as a match clock", () => {
    expect(formatReplayParticipantStatSnapshotTimestamp(0)).toBe("0:00");
    expect(formatReplayParticipantStatSnapshotTimestamp(754_999)).toBe("12:34");
  });

  it("rejects non-finite values, non-keyframe provenance, unordered, and ambiguous state", () => {
    const nonFinite = structuredClone(result);
    nonFinite.snapshots[0].totalGold = Number.NaN;
    expect(() => parseReplayParticipantStatSnapshotsResult(nonFinite)).toThrow(
      "snapshot.totalGold",
    );

    const invalidLevel = structuredClone(result);
    invalidLevel.snapshots[0].level = 21;
    expect(() => parseReplayParticipantStatSnapshotsResult(invalidLevel)).toThrow(
      "selected exact profile",
    );

    const wrongSegment = structuredClone(result);
    Reflect.set(
      wrongSegment.snapshots[0].provenance.snapshotBlock.provenance,
      "segmentType",
      "chunk",
    );
    expect(() => parseReplayParticipantStatSnapshotsResult(wrongSegment)).toThrow("segmentType");

    const unordered = structuredClone(result);
    unordered.snapshots.reverse();
    expect(() => parseReplayParticipantStatSnapshotsResult(unordered)).toThrow(
      "ordered by timestamp and participant",
    );

    const duplicate = structuredClone(result);
    duplicate.snapshots.push(structuredClone(duplicate.snapshots[0]!));
    duplicate.snapshots.sort(
      (left, right) =>
        left.timestampMillis - right.timestampMillis || left.participantId - right.participantId,
    );
    expect(() => parseReplayParticipantStatSnapshotsResult(duplicate)).toThrow(
      "duplicate participant snapshots",
    );
  });

  it("rejects built-in and incomplete profile provenance instead of widening the boundary", () => {
    const builtIn = structuredClone(result);
    Reflect.set(builtIn.profile, "origin", "built-in");
    expect(() => parseReplayParticipantStatSnapshotsResult(builtIn)).toThrow("profile.origin");

    const incomplete = structuredClone(result);
    Reflect.deleteProperty(incomplete.profile, "fingerprint");
    expect(() => parseReplayParticipantStatSnapshotsResult(incomplete)).toThrow(
      "profile.fingerprint",
    );
  });

  it("rejects partial snapshot streams instead of silently showing surviving rows", () => {
    const rejected = structuredClone(result);
    rejected.diagnostics.profiledSnapshotPacketCount = 3;
    rejected.diagnostics.rejectedInvalidValuePacketCount = 1;
    expect(() => parseReplayParticipantStatSnapshotsResult(rejected)).toThrow(
      "complete fail-closed",
    );
  });

  it("rejects participant XP or level regression across keyframes", () => {
    const decreasing = structuredClone(result);
    const secondGroup = structuredClone(decreasing.snapshots).map((snapshot) => ({
      ...snapshot,
      timestampMillis: snapshot.timestampMillis + 60_000,
    }));
    secondGroup[0]!.experience = 100;
    secondGroup[0]!.level = 1;
    decreasing.snapshots.push(...secondGroup);
    decreasing.diagnostics.keyframeRecordCount = 2;
    decreasing.diagnostics.keyframeSegmentCount = 2;
    decreasing.diagnostics.profiledSnapshotPacketCount = 20;
    decreasing.diagnostics.emittedSnapshotCount = 20;
    expect(() => parseReplayParticipantStatSnapshotsResult(decreasing)).toThrow(
      "monotonic across keyframes",
    );
  });

  it("rejects neutral-CS regression across keyframes", () => {
    const decreasing = structuredClone(result);
    const secondGroup = structuredClone(decreasing.snapshots).map((snapshot) => ({
      ...snapshot,
      timestampMillis: snapshot.timestampMillis + 60_000,
    }));
    secondGroup[0]!.neutralMinionsKilled = 0;
    decreasing.snapshots.push(...secondGroup);
    decreasing.diagnostics.keyframeRecordCount = 2;
    decreasing.diagnostics.keyframeSegmentCount = 2;
    decreasing.diagnostics.profiledSnapshotPacketCount = 20;
    decreasing.diagnostics.emittedSnapshotCount = 20;
    expect(() => parseReplayParticipantStatSnapshotsResult(decreasing)).toThrow(
      "monotonic across keyframes",
    );
  });

  it("uses the profiled Wasm export and validates its decoded JSON before returning it", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./wasmReplayParser.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("extractReplayParticipantStatSnapshotsWithWasm");
    expect(source).toContain("lra_extract_replay_participant_stat_snapshots_buffer_with_profiles");
    expect(source).toContain("parseReplayParticipantStatSnapshotsResult");
    expect(source).toContain("DEFAULT_DECODER_PROFILE_REGISTRY_JSON");
  });

  it("mounts scrub-time neutral CS in the product roster", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./components/ProductReplayView.vue", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("snapshot.neutralMinionsKilled");
    expect(source).toContain("jungleCs: snapshot.neutralMinionsKilled");
    expect(source).toContain("Jungle");
  });
});
