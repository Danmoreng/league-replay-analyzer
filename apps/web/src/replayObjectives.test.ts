import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayObjectiveTimestamp,
  replayObjectiveMonsterLabel,
  summarizeReplayObjectiveDiagnostics,
  type ReplayObjectiveResult,
} from "./replayObjectives";

const result: ReplayObjectiveResult = {
  schema: "rofl-replay-objectives/v1",
  generatedAtUtc: "2026-07-16T20:00:00Z",
  source: {
    replayPath: null,
    replayId: null,
    matchId: null,
    runtimeInput: "rofl-only",
    riotApiInput: false,
  },
  gameVersion: "16.9.1.1",
  versionGroup: "16.9",
  profile: {
    channel: 1,
    packetType: 0x01eb,
    packetTypeHex: "0x01EB",
    minimumContentLength: 132,
    maximumContentLength: 133,
    discriminatorOffset: 2,
    classifier: "payload[2] identifies the monster class.",
  },
  replay: {
    gameLengthMillis: 1_800_000,
    lastGameChunkId: 60,
    lastKeyFrameId: 30,
  },
  events: [],
  diagnostics: {
    footerRecordCount: 91,
    chunkRecordCount: 60,
    decompressedChunkBytes: 10_000,
    packetBlockCount: 25_000,
    candidatePacketBlockCount: 10,
    profileLengthPacketBlockCount: 9,
    rejectedContentLengthBlockCount: 1,
    decodedObjectiveEventCount: 8,
    unknownMonsterTypeCount: 1,
    monsterCounts: {
      DRAGON: 4,
      BARON_NASHOR: 1,
      RIFTHERALD: 1,
      HORDE: 2,
    },
    exactPacketFraming: true,
    killerOwnershipAvailable: false,
    elementalDragonSubtypeAvailable: false,
  },
};

describe("replay objective presentation helpers", () => {
  it("formats objective timestamps as a match clock", () => {
    expect(formatReplayObjectiveTimestamp(0)).toBe("0:00");
    expect(formatReplayObjectiveTimestamp(1_265_999)).toBe("21:05");
  });

  it("uses broad, human-readable monster labels without inventing subtypes", () => {
    expect(replayObjectiveMonsterLabel("DRAGON")).toBe("Dragon");
    expect(replayObjectiveMonsterLabel("RIFTHERALD")).toBe("Rift Herald");
    expect(replayObjectiveMonsterLabel("HORDE")).toBe("Horde / Void Grubs");
  });

  it("states the current semantic boundary in its diagnostic summary", () => {
    expect(summarizeReplayObjectiveDiagnostics(result)).toBe(
      "8 elite-monster objectives decoded with exact packet framing; every emitted event has a broad monster class. 1 profile-length candidate was rejected because the monster class was unknown. Killer ownership and elemental dragon subtype remain unresolved.",
    );
  });
});
