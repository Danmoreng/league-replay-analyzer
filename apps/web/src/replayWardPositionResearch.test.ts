import { describe, expect, it } from "vite-plus/test";

import type { ReplayWardResult } from "./replayWards";
import {
  buildReplayWardPositionResearchMarkers,
  listReplayWardPositionHypotheses,
  replayWardPositionResearchCompatibility,
  wardFloatApiFitHypothesisId,
  type ReplayWardPositionResearchResult,
} from "./replayWardPositionResearch";

const wards = {
  schema: "rofl-replay-wards/v1",
  gameVersion: "16.9.772.8292",
  versionGroup: "16.9",
  source: {
    replayPath: null,
    replayId: "EUW1-123",
    matchId: "123",
    runtimeInput: "rofl-only",
    riotApiInput: false,
  },
  events: [
    {
      type: "WARD_PLACED",
      timestampMillis: 10_000,
      wardEntityNetworkId: 101,
      wardEntityNetworkIdHex: "0x00000065",
      ownerParticipantId: 1,
    },
    {
      type: "WARD_KILL",
      timestampMillis: 30_000,
      wardEntityNetworkId: 101,
      wardEntityNetworkIdHex: "0x00000065",
      killerParticipantId: 6,
    },
    {
      type: "WARD_PLACED",
      timestampMillis: 20_000,
      wardEntityNetworkId: 102,
      wardEntityNetworkIdHex: "0x00000066",
      ownerParticipantId: 7,
    },
  ],
} as ReplayWardResult;

const research = {
  schema: "rofl-ward-position-candidates-research/v1",
  generatedAtUtc: "2026-07-17T00:00:00Z",
  researchOnly: true,
  promotionGate: false,
  positionAvailable: false,
  source: {
    replayPath: null,
    replayId: "EUW1-123",
    matchId: "123",
    runtimeInput: "rofl-only",
    riotApiInput: false,
    clientBinaryInput: false,
  },
  gameVersion: "16.9.772.8292",
  versionGroup: "16.9",
  hypotheses: [],
  placements: [
    {
      timestampMillis: 10_000,
      wardEntityNetworkId: 101,
      wardEntityNetworkIdHex: "0x00000065",
      ownerParticipantId: 1,
      ownerNetworkId: 201,
      ownerNetworkIdHex: "0x000000C9",
      spawnBlocks: {
        primary: {
          packetRole: "primary",
          packetType: 0x00d6,
          packetTypeHex: "0x00D6",
          blockParam: 101,
          blockParamHex: "0x00000065",
          contentLength: 16,
          payloadHex: "00000000000000004505010045020500",
          provenance: {
            segmentType: "chunk",
            segmentId: 1,
            chunkId: 1,
            segmentHeaderOffset: 0,
            segmentPayloadOffset: 0,
            blockIndex: 1,
            decompressedHeaderOffset: 0,
            decompressedContentOffset: 0,
            decompressedEndOffset: 16,
          },
        },
        companion: null,
      },
      candidates: [],
    },
    {
      timestampMillis: 20_000,
      wardEntityNetworkId: 102,
      wardEntityNetworkIdHex: "0x00000066",
      ownerParticipantId: 7,
      ownerNetworkId: 207,
      ownerNetworkIdHex: "0x000000CF",
      candidates: [],
    },
  ],
} as ReplayWardPositionResearchResult;

describe("ward position research presentation", () => {
  it("binds the research payload to the exact replay and patch group", () => {
    expect(replayWardPositionResearchCompatibility(wards, research)).toEqual({
      compatible: true,
      reason: null,
    });

    expect(
      replayWardPositionResearchCompatibility(wards, {
        ...research,
        source: { ...research.source, replayId: "EUW1-999" },
      }),
    ).toEqual({ compatible: false, reason: "Replay-ID passt nicht zum geladenen Replay." });

    expect(
      replayWardPositionResearchCompatibility(wards, {
        ...research,
        versionGroup: "16.8",
      }),
    ).toEqual({ compatible: false, reason: "Patchgruppe passt nicht zum geladenen Replay." });

    expect(
      replayWardPositionResearchCompatibility(wards, {
        ...research,
        source: { ...research.source, clientBinaryInput: true },
      } as unknown as ReplayWardPositionResearchResult),
    ).toEqual({
      compatible: false,
      reason: "Research-Gates oder Replay-only-Provenienz fehlen.",
    });
  });

  it("lists flexible hypotheses and rejects out-of-bounds values instead of clamping", () => {
    expect(listReplayWardPositionHypotheses(wards, research)).toEqual([
      {
        id: wardFloatApiFitHypothesisId,
        xSource: "p[8..10] → Float32 BE; Byte 3 = 0",
        ySource: "p[12..14] → Float32 BE; Byte 3 = 0",
        label: "Float32-Symbolmodell · API-offline-fit",
        description:
          "Live aus den Spawn-Paketbytes des geladenen .rofl; die Symboltabellen wurden offline an 95 gespeicherten Kill-Ankern gefittet. 48/2.625 Corpus-Platzierungen, nicht promotet.",
        candidateCount: 1,
        placementCount: 1,
        coverage: 0.5,
      },
    ]);
  });

  it("can show every bounded placement independently of replay time", () => {
    const markers = buildReplayWardPositionResearchMarkers(
      wards,
      research,
      wardFloatApiFitHypothesisId,
      0,
      {
        visibilityMode: "all-placements",
        showActiveLinkedWards: false,
        showEventPulses: false,
      },
    );

    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      state: "all-placement",
      leftPercent: (7_016 / 15_000) * 100,
      topPercent: 100 - (7_803 / 15_000) * 100,
      xSource: "p[8..10] → Float32 BE; Byte 3 = 0",
      ySource: "p[12..14] → Float32 BE; Byte 3 = 0",
    });
  });

  it("shows linked wards over their exact interval and uses bounded event pulses", () => {
    const active = buildReplayWardPositionResearchMarkers(
      wards,
      research,
      wardFloatApiFitHypothesisId,
      18_000,
      {
        visibilityMode: "timeline",
        showActiveLinkedWards: true,
        showEventPulses: false,
      },
    );
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      state: "active-linked",
      leftPercent: (7_016 / 15_000) * 100,
      topPercent: 100 - (7_803 / 15_000) * 100,
    });

    const killed = buildReplayWardPositionResearchMarkers(
      wards,
      research,
      wardFloatApiFitHypothesisId,
      32_000,
      {
        visibilityMode: "timeline",
        showActiveLinkedWards: true,
        showEventPulses: true,
      },
    );
    expect(killed).toHaveLength(1);
    expect(killed[0].state).toBe("kill-pulse");

    expect(
      buildReplayWardPositionResearchMarkers(wards, research, wardFloatApiFitHypothesisId, 40_000, {
        visibilityMode: "timeline",
        showActiveLinkedWards: true,
        showEventPulses: true,
      }),
    ).toEqual([]);
  });
});
