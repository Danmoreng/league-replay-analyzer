import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayKillTimestamp,
  replayKillParticipantName,
  summarizeReplayKillDiagnostics,
  type ReplayKillResult,
} from "./replayKills";

const result: ReplayKillResult = {
  schema: "rofl-replay-kills/v1",
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
    ownerSequencePacketType: 0x73,
    ownerSequencePacketTypeHex: "0x0073",
    deathMarkerPacketType: 0x2cb,
    deathMarkerPacketTypeHex: "0x02CB",
    championNetworkIdBase: 0x400000ad,
    championNetworkIdBaseHex: "0x400000AD",
    ownerOrder: "[victim, ...ordered assists, killer]",
    executionRule: "A one-owner sequence has killerParticipantId=0.",
  },
  replay: {
    gameLengthMillis: 1_800_000,
    lastGameChunkId: 60,
    lastKeyFrameId: 30,
    metadataOffset: 100,
    metadataLength: 200,
  },
  participants: [],
  events: [],
  diagnostics: {
    footerRecordCount: 91,
    chunkRecordCount: 60,
    decompressedChunkBytes: 10_000,
    packetBlockCount: 25_000,
    relevantPacketBlockCount: 50,
    ownerSequenceBlockCount: 30,
    deathMarkerBlockCount: 20,
    ignoredDeathMarkerBlockCount: 0,
    decodedKillEventCount: 20,
    pendingOwnerBlockCount: 0,
    exactPacketFraming: true,
    signedCompactBlockParamDelta: true,
    finalKdaValidation: {
      source: "replay-metadata-statsJson",
      runtimeInput: "rofl-only",
      participantCount: 10,
      passingParticipantCount: 10,
      pass: true,
      rows: [],
    },
  },
};

describe("replay kill presentation helpers", () => {
  it("formats replay timestamps as a match clock", () => {
    expect(formatReplayKillTimestamp(0)).toBe("0:00");
    expect(formatReplayKillTimestamp(754_999)).toBe("12:34");
  });

  it("uses Riot ID labels when present and stable participant fallbacks otherwise", () => {
    expect(
      replayKillParticipantName({
        participantId: 4,
        championName: "Ahri",
        teamId: 100,
        teamPosition: "MIDDLE",
        riotIdGameName: "Fox",
        riotIdTagLine: "EUW",
        finalKills: 5,
        finalDeaths: 2,
        finalAssists: 9,
      }),
    ).toBe("Fox#EUW");
    expect(
      replayKillParticipantName({
        participantId: 7,
        championName: "Braum",
        teamId: 200,
        teamPosition: "UTILITY",
        riotIdGameName: null,
        riotIdTagLine: null,
        finalKills: 0,
        finalDeaths: 4,
        finalAssists: 12,
      }),
    ).toBe("Participant 7");
  });

  it("summarizes exact packet framing and replay-metadata K/D/A validation", () => {
    expect(summarizeReplayKillDiagnostics(result)).toBe(
      "20 kills decoded with exact framing; K/D/A matches all 10 participants.",
    );
  });
});
