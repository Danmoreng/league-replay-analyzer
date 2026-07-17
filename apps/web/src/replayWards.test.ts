import { describe, expect, it } from "vite-plus/test";

import {
  formatReplayWardTimestamp,
  replayWardEventLabel,
  summarizeReplayWardDiagnostics,
  type ReplayWardEvent,
  type ReplayWardResult,
} from "./replayWards";

const provenance = {
  segmentType: "chunk",
  segmentId: 8,
  chunkId: 8,
  segmentHeaderOffset: 100,
  segmentPayloadOffset: 117,
  blockIndex: 42,
  decompressedHeaderOffset: 200,
  decompressedContentOffset: 212,
  decompressedEndOffset: 215,
};
const placed: ReplayWardEvent = {
  type: "WARD_PLACED",
  timestampMillis: 754_999,
  wardEntityNetworkId: 0x40001000,
  wardEntityNetworkIdHex: "0x40001000",
  ownerParticipantId: 4,
  ownerNetworkId: 0x400000b1,
  ownerNetworkIdHex: "0x400000B1",
  wardType: null,
  position: null,
  provenance: { ownerBlock: provenance, markerBlock: provenance },
};
const killed: ReplayWardEvent = {
  type: "WARD_KILL",
  timestampMillis: 760_000,
  wardEntityNetworkId: 0x40001000,
  wardEntityNetworkIdHex: "0x40001000",
  killerParticipantId: 7,
  killerNetworkId: 0x400000b4,
  killerNetworkIdHex: "0x400000B4",
  wardType: null,
  position: null,
  removalReason: null,
  provenance: { killerOwnerBlock: provenance, removalBlock: provenance },
};
const diagnostics: ReplayWardResult["diagnostics"] = {
  footerRecordCount: 91,
  chunkRecordCount: 60,
  decompressedChunkBytes: 10_000,
  packetBlockCount: 25_000,
  candidatePlacementMarkerBlockCount: 2,
  classifiedPlacementMarkerBlockCount: 1,
  rejectedPlacementContentLengthBlockCount: 0,
  rejectedPlacementClassifierBlockCount: 1,
  rejectedUnpairedPlacementMarkerBlockCount: 0,
  decodedWardPlacementEventCount: 1,
  candidateRemovalBlockCount: 2,
  rejectedUntrackedRemovalBlockCount: 0,
  rejectedTrackedUnprofiledRemovalBlockCount: 1,
  rejectedMissingKillerOwnerBlockCount: 0,
  killerOwnerCandidateCollisionCount: 0,
  decodedWardKillEventCount: 1,
  exactPacketFraming: true,
  placementCoverage: "exact-on-validated-corpus",
  removalCoverage: "conservative-partial",
  wardTypeAvailable: false,
  positionAvailable: false,
  visionRadiusAvailable: false,
  removalReasonAvailable: false,
};
const result = { diagnostics } as ReplayWardResult;

describe("replay ward presentation helpers", () => {
  it("formats replay timestamps as a match clock", () => {
    expect(formatReplayWardTimestamp(0)).toBe("0:00");
    expect(formatReplayWardTimestamp(754_999)).toBe("12:34");
  });
  it("labels placements and kills without inventing ward subtypes", () => {
    const label = (id: number) => (id === 4 ? "Ahri" : "Lee Sin");
    expect(replayWardEventLabel(placed, label)).toBe("Ahri placed a ward");
    expect(replayWardEventLabel(killed, label)).toBe("Lee Sin destroyed a ward");
  });
  it("states exact placement and conservative partial removal coverage", () => {
    expect(summarizeReplayWardDiagnostics(result)).toBe(
      "1 ward placements decoded with exact framing and exact corpus coverage; 1 ward kills decoded with conservative partial removal coverage. Ward subtype and position remain unavailable.",
    );
  });
});
