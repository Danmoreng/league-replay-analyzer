import type { ReplayWardKillEvent, ReplayWardPlacedEvent, ReplayWardResult } from "./replayWards";
import wardFloatSymbolModel16_9 from "./wardFloatSymbolModel16_9.json";

export type ReplayWardPositionPacketRole = "primary" | "companion";

export interface ReplayWardPositionResearchProvenance {
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

export interface ReplayWardPositionResearchSpawnBlock {
  packetRole: ReplayWardPositionPacketRole;
  packetType: number;
  packetTypeHex: string;
  blockParam: number;
  blockParamHex: string;
  contentLength: number;
  payloadHex: string;
  provenance: ReplayWardPositionResearchProvenance;
}

/**
 * A bounded numeric interpretation of replay bytes. It is deliberately not a
 * decoded position and must never be consumed without the research-only gates
 * on ReplayWardPositionResearchResult.
 */
export interface ReplayWardPositionResearchCandidate {
  hypothesisId: string;
  x: number;
  y: number;
  xSource: string;
  ySource: string;
  label?: string;
  description?: string;
}

export interface ReplayWardPositionResearchHypothesis {
  id: string;
  label?: string;
  description?: string;
}

export interface ReplayWardPositionResearchPlacement {
  timestampMillis: number;
  wardEntityNetworkId: number;
  wardEntityNetworkIdHex: string;
  ownerParticipantId: number;
  ownerNetworkId: number;
  ownerNetworkIdHex: string;
  spawnBlocks?: {
    primary: ReplayWardPositionResearchSpawnBlock | null;
    companion: ReplayWardPositionResearchSpawnBlock | null;
  };
  candidates: ReplayWardPositionResearchCandidate[];
}

export interface ReplayWardPositionResearchResult {
  schema: "rofl-ward-position-candidates-research/v1";
  generatedAtUtc: string;
  researchOnly: true;
  promotionGate: false;
  positionAvailable: false;
  source: {
    replayPath: string | null;
    replayId: string | null;
    matchId: string | null;
    runtimeInput: "rofl-only";
    riotApiInput: false;
    clientBinaryInput: false;
  };
  gameVersion: string;
  versionGroup: string;
  hypotheses?: ReplayWardPositionResearchHypothesis[];
  placements: ReplayWardPositionResearchPlacement[];
}

export interface ReplayWardPositionHypothesisSummary {
  id: string;
  xSource: string;
  ySource: string;
  label: string;
  description: string | null;
  candidateCount: number;
  placementCount: number;
  coverage: number;
}

export type ReplayWardPositionReviewStatus = "mapped" | "unresolved";
export type ReplayWardPositionReviewFilter = "all" | ReplayWardPositionReviewStatus;

export interface ReplayWardPositionMissingLaneSymbol {
  axis: "x" | "y";
  primaryOffset: number;
  sourceByte: number | null;
  sourceByteHex: string | null;
  reason: "payload-byte-missing" | "symbol-unmapped";
}

/**
 * One review row for every productive ward placement. `candidate` is kept
 * separate from the productive ward event and remains research-only.
 */
export interface ReplayWardPositionReview {
  hypothesisId: string;
  method: string;
  confidence: "experimental-api-offline-fit";
  status: ReplayWardPositionReviewStatus;
  timestampMillis: number;
  wardEntityNetworkId: number;
  wardEntityNetworkIdHex: string;
  ownerParticipantId: number;
  candidate: ReplayWardPositionResearchCandidate | null;
  missingLaneSymbols: ReplayWardPositionMissingLaneSymbol[];
  missingEvidence: string[];
}

export type ReplayWardPositionMarkerState =
  | "all-placement"
  | "active-linked"
  | "placement-pulse"
  | "kill-pulse";

export interface ReplayWardPositionResearchMarker {
  hypothesisId: string;
  hypothesisLabel: string;
  wardEntityNetworkId: number;
  wardEntityNetworkIdHex: string;
  ownerParticipantId: number;
  placementTimestampMillis: number;
  removalTimestampMillis: number | null;
  x: number;
  y: number;
  leftPercent: number;
  topPercent: number;
  state: ReplayWardPositionMarkerState;
  xSource: string;
  ySource: string;
}

export interface ReplayWardPositionMarkerOptions {
  visibilityMode: "all-placements" | "timeline";
  showActiveLinkedWards: boolean;
  showEventPulses: boolean;
  pulseDurationMillis?: number;
}

export interface ReplayWardPositionCompatibility {
  compatible: boolean;
  reason: string | null;
}

export const wardFloatApiFitHypothesisId = wardFloatSymbolModel16_9.model.id;

const wardFloatApiFitHypothesis: ReplayWardPositionResearchHypothesis = {
  id: wardFloatApiFitHypothesisId,
  label: "Float32-Symbolmodell · API-offline-fit",
  description:
    "Live aus den Spawn-Paketbytes des geladenen .rofl; die Symboltabellen wurden offline an 95 gespeicherten Kill-Ankern gefittet. 48/2.625 Corpus-Platzierungen, nicht promotet.",
};
const wardFloatApiFitXSource = "p[8..10] → Float32 BE; Byte 3 = 0";
const wardFloatApiFitYSource = "p[12..14] → Float32 BE; Byte 3 = 0";
const mapMinimum = 0;
const mapMaximum = 15_000;

function parsePayloadHex(payloadHex: string): Uint8Array | null {
  const normalized = payloadHex.replaceAll(" ", "");
  if (normalized.length === 0 || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    return null;
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

interface ApiFitAxisResolution {
  value: number | null;
  missingLaneSymbols: ReplayWardPositionMissingLaneSymbol[];
}

interface ApiFitCandidateResolution {
  candidate: ReplayWardPositionResearchCandidate | null;
  missingLaneSymbols: ReplayWardPositionMissingLaneSymbol[];
  missingEvidence: string[];
}

function byteHex(value: number): string {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function decodeApiFitAxis(payload: Uint8Array, axis: "x" | "y"): ApiFitAxisResolution {
  const targetBytes: number[] = [];
  const missingLaneSymbols: ReplayWardPositionMissingLaneSymbol[] = [];
  for (const lane of wardFloatSymbolModel16_9.model.lookup[axis]) {
    const sourceByte = payload[lane.primaryOffset];
    if (sourceByte === undefined) {
      missingLaneSymbols.push({
        axis,
        primaryOffset: lane.primaryOffset,
        sourceByte: null,
        sourceByteHex: null,
        reason: "payload-byte-missing",
      });
      continue;
    }
    const targetByte = lane.pairs.find((pair) => pair.from === sourceByte)?.to;
    if (targetByte === undefined) {
      missingLaneSymbols.push({
        axis,
        primaryOffset: lane.primaryOffset,
        sourceByte,
        sourceByteHex: byteHex(sourceByte),
        reason: "symbol-unmapped",
      });
      continue;
    }
    targetBytes[lane.targetFloatByteIndex] = targetByte;
  }

  if (missingLaneSymbols.length > 0) {
    return { value: null, missingLaneSymbols };
  }

  targetBytes[3] = wardFloatSymbolModel16_9.model.lookup.byte3.value;
  if (targetBytes.length !== 4 || targetBytes.some((value) => !Number.isInteger(value))) {
    return { value: null, missingLaneSymbols };
  }
  const bytes = Uint8Array.from(targetBytes);
  return {
    value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, false),
    missingLaneSymbols,
  };
}

function resolveApiFitCandidate(
  research: ReplayWardPositionResearchResult,
  placement: ReplayWardPositionResearchPlacement,
): ApiFitCandidateResolution {
  if (research.versionGroup !== wardFloatSymbolModel16_9.versionGroup) {
    return {
      candidate: null,
      missingLaneSymbols: [],
      missingEvidence: [
        `Modell gilt nur für Patchgruppe ${wardFloatSymbolModel16_9.versionGroup}; geladen ist ${research.versionGroup}.`,
      ],
    };
  }
  const payloadHex = placement.spawnBlocks?.primary?.payloadHex;
  if (!payloadHex) {
    return {
      candidate: null,
      missingLaneSymbols: [],
      missingEvidence: ["Primärer Ward-Spawn-Block fehlt."],
    };
  }
  const payload = parsePayloadHex(payloadHex);
  if (!payload) {
    return {
      candidate: null,
      missingLaneSymbols: [],
      missingEvidence: ["Payload des primären Ward-Spawn-Blocks ist ungültig."],
    };
  }
  const x = decodeApiFitAxis(payload, "x");
  const y = decodeApiFitAxis(payload, "y");
  const missingLaneSymbols = [...x.missingLaneSymbols, ...y.missingLaneSymbols];
  if (x.value === null || y.value === null) {
    const missingEvidence = missingLaneSymbols.map((lane) =>
      lane.reason === "symbol-unmapped"
        ? `${lane.axis.toUpperCase()} p[${lane.primaryOffset}]=${lane.sourceByteHex} fehlt in der Symboltabelle.`
        : `${lane.axis.toUpperCase()} p[${lane.primaryOffset}] fehlt im Spawn-Payload.`,
    );
    return {
      candidate: null,
      missingLaneSymbols,
      missingEvidence:
        missingEvidence.length > 0
          ? missingEvidence
          : ["Float32-Zielbytes konnten nicht vollständig zusammengesetzt werden."],
    };
  }

  const candidate: ReplayWardPositionResearchCandidate = {
    hypothesisId: wardFloatApiFitHypothesisId,
    label: wardFloatApiFitHypothesis.label,
    description: wardFloatApiFitHypothesis.description,
    x: x.value,
    y: y.value,
    xSource: wardFloatApiFitXSource,
    ySource: wardFloatApiFitYSource,
  };
  if (!isBoundedCandidate(candidate)) {
    return {
      candidate: null,
      missingLaneSymbols: [],
      missingEvidence: [
        `Berechneter Kandidat (${candidate.x}, ${candidate.y}) liegt außerhalb 0–15.000 und wurde verworfen.`,
      ],
    };
  }
  return { candidate, missingLaneSymbols: [], missingEvidence: [] };
}

function decodeApiFitCandidate(
  research: ReplayWardPositionResearchResult,
  placement: ReplayWardPositionResearchPlacement,
): ReplayWardPositionResearchCandidate | null {
  return resolveApiFitCandidate(research, placement).candidate;
}

function gameVersionGroup(gameVersion: string): string {
  return gameVersion.split(".").slice(0, 2).join(".");
}

function normalizeId(value: string | null): string | null {
  return value?.trim().replaceAll("_", "-").toUpperCase() || null;
}

function idsConflict(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeId(left);
  const normalizedRight = normalizeId(right);
  return normalizedLeft !== null && normalizedRight !== null && normalizedLeft !== normalizedRight;
}

export function replayWardPositionResearchCompatibility(
  wards: ReplayWardResult,
  research: ReplayWardPositionResearchResult,
): ReplayWardPositionCompatibility {
  if (
    research.schema !== "rofl-ward-position-candidates-research/v1" ||
    research.researchOnly !== true ||
    research.promotionGate !== false ||
    research.positionAvailable !== false ||
    research.source.runtimeInput !== "rofl-only" ||
    research.source.riotApiInput !== false ||
    research.source.clientBinaryInput !== false
  ) {
    return { compatible: false, reason: "Research-Gates oder Replay-only-Provenienz fehlen." };
  }

  const researchVersionGroup = gameVersionGroup(research.gameVersion);
  if (
    research.versionGroup !== researchVersionGroup ||
    researchVersionGroup !== gameVersionGroup(wards.gameVersion) ||
    research.versionGroup !== wards.versionGroup
  ) {
    return { compatible: false, reason: "Patchgruppe passt nicht zum geladenen Replay." };
  }

  if (idsConflict(research.source.replayId, wards.source.replayId)) {
    return { compatible: false, reason: "Replay-ID passt nicht zum geladenen Replay." };
  }

  if (idsConflict(research.source.matchId, wards.source.matchId)) {
    return { compatible: false, reason: "Match-ID passt nicht zum geladenen Replay." };
  }

  return { compatible: true, reason: null };
}

export function buildReplayWardPositionReviews(
  wards: ReplayWardResult,
  research: ReplayWardPositionResearchResult,
  hypothesisId = wardFloatApiFitHypothesisId,
): ReplayWardPositionReview[] {
  if (!replayWardPositionResearchCompatibility(wards, research).compatible) return [];

  const researchPlacementsById = new Map<number, ReplayWardPositionResearchPlacement[]>();
  for (const placement of research.placements) {
    const placements = researchPlacementsById.get(placement.wardEntityNetworkId) ?? [];
    placements.push(placement);
    researchPlacementsById.set(placement.wardEntityNetworkId, placements);
  }

  return wards.events
    .filter((event): event is ReplayWardPlacedEvent => event.type === "WARD_PLACED")
    .map((decodedPlacement) => {
      const researchPlacement = researchPlacementsById
        .get(decodedPlacement.wardEntityNetworkId)
        ?.find((placement) => matchesProductivePlacement(decodedPlacement, placement));

      if (!researchPlacement) {
        return {
          hypothesisId,
          method: hypothesisId,
          confidence: "experimental-api-offline-fit" as const,
          status: "unresolved" as const,
          timestampMillis: decodedPlacement.timestampMillis,
          wardEntityNetworkId: decodedPlacement.wardEntityNetworkId,
          wardEntityNetworkIdHex: decodedPlacement.wardEntityNetworkIdHex,
          ownerParticipantId: decodedPlacement.ownerParticipantId,
          candidate: null,
          missingLaneSymbols: [],
          missingEvidence: ["Passender Research-Spawn-Datensatz fehlt."],
        };
      }

      const resolution =
        hypothesisId === wardFloatApiFitHypothesisId
          ? resolveApiFitCandidate(research, researchPlacement)
          : {
              candidate: null,
              missingLaneSymbols: [],
              missingEvidence: [`Research-Methode ${hypothesisId} wird nicht dargestellt.`],
            };
      return {
        hypothesisId,
        method: hypothesisId,
        confidence: "experimental-api-offline-fit" as const,
        status: resolution.candidate ? ("mapped" as const) : ("unresolved" as const),
        timestampMillis: decodedPlacement.timestampMillis,
        wardEntityNetworkId: decodedPlacement.wardEntityNetworkId,
        wardEntityNetworkIdHex: decodedPlacement.wardEntityNetworkIdHex,
        ownerParticipantId: decodedPlacement.ownerParticipantId,
        candidate: resolution.candidate,
        missingLaneSymbols: resolution.missingLaneSymbols,
        missingEvidence: resolution.missingEvidence,
      };
    })
    .sort((left, right) => left.timestampMillis - right.timestampMillis);
}

export function filterReplayWardPositionReviews(
  reviews: ReplayWardPositionReview[],
  filter: ReplayWardPositionReviewFilter,
): ReplayWardPositionReview[] {
  return filter === "all" ? reviews : reviews.filter((review) => review.status === filter);
}

export function listReplayWardPositionHypotheses(
  wards: ReplayWardResult,
  research: ReplayWardPositionResearchResult,
): ReplayWardPositionHypothesisSummary[] {
  if (!replayWardPositionResearchCompatibility(wards, research).compatible) return [];

  const placementsById = new Map(
    wards.events
      .filter((event): event is ReplayWardPlacedEvent => event.type === "WARD_PLACED")
      .map((event) => [event.wardEntityNetworkId, event]),
  );
  // The eight earlier raw-coordinate variants were visually falsified and are
  // intentionally hidden. Only the new packet-symbol/Float32 candidate is shown.
  const declaredHypotheses = new Map([[wardFloatApiFitHypothesis.id, wardFloatApiFitHypothesis]]);
  const hypotheses = new Map<
    string,
    ReplayWardPositionHypothesisSummary & { placementIds: Set<number> }
  >([
    [
      wardFloatApiFitHypothesis.id,
      {
        id: wardFloatApiFitHypothesis.id,
        xSource: wardFloatApiFitXSource,
        ySource: wardFloatApiFitYSource,
        label: wardFloatApiFitHypothesis.label ?? wardFloatApiFitHypothesis.id,
        description: wardFloatApiFitHypothesis.description ?? null,
        candidateCount: 0,
        placementCount: 0,
        coverage: 0,
        placementIds: new Set<number>(),
      },
    ],
  ]);

  for (const placement of research.placements) {
    const decodedPlacement = placementsById.get(placement.wardEntityNetworkId);
    if (!matchesProductivePlacement(decodedPlacement, placement)) continue;

    const apiFitCandidate = decodeApiFitCandidate(research, placement);
    for (const candidate of apiFitCandidate ? [apiFitCandidate] : []) {
      if (!isBoundedCandidate(candidate)) continue;
      const declared = declaredHypotheses.get(candidate.hypothesisId);
      const xSource = candidate.xSource;
      const ySource = candidate.ySource;
      if (!xSource || !ySource) continue;

      const row = hypotheses.get(candidate.hypothesisId) ?? {
        id: candidate.hypothesisId,
        xSource,
        ySource,
        label: declared?.label ?? candidate.label ?? candidate.hypothesisId,
        description: declared?.description ?? candidate.description ?? null,
        candidateCount: 0,
        placementCount: 0,
        coverage: 0,
        placementIds: new Set<number>(),
      };
      if (row.xSource !== xSource || row.ySource !== ySource) continue;

      row.candidateCount += 1;
      row.placementIds.add(placement.wardEntityNetworkId);
      hypotheses.set(candidate.hypothesisId, row);
    }
  }

  const denominator = Math.max(1, placementsById.size);
  return [...hypotheses.values()]
    .map(({ placementIds, ...hypothesis }) => ({
      ...hypothesis,
      placementCount: placementIds.size,
      coverage: placementIds.size / denominator,
    }))
    .sort(
      (left, right) =>
        right.placementCount - left.placementCount || left.id.localeCompare(right.id),
    );
}

export function buildReplayWardPositionResearchMarkers(
  wards: ReplayWardResult,
  research: ReplayWardPositionResearchResult,
  hypothesisId: string,
  currentTimeMillis: number,
  options: ReplayWardPositionMarkerOptions,
): ReplayWardPositionResearchMarker[] {
  if (!replayWardPositionResearchCompatibility(wards, research).compatible) return [];

  const pulseDurationMillis = Math.max(0, options.pulseDurationMillis ?? 5_000);
  const placementsById = new Map(
    wards.events
      .filter((event): event is ReplayWardPlacedEvent => event.type === "WARD_PLACED")
      .map((event) => [event.wardEntityNetworkId, event]),
  );
  const removalsById = new Map<number, ReplayWardKillEvent>();
  for (const event of wards.events) {
    if (event.type !== "WARD_KILL") continue;
    const current = removalsById.get(event.wardEntityNetworkId);
    if (!current || event.timestampMillis < current.timestampMillis) {
      removalsById.set(event.wardEntityNetworkId, event);
    }
  }
  const declaredHypothesis = research.hypotheses?.find(
    (hypothesis) => hypothesis.id === hypothesisId,
  );

  const markers: ReplayWardPositionResearchMarker[] = [];
  for (const placement of research.placements) {
    const decodedPlacement = placementsById.get(placement.wardEntityNetworkId);
    if (!matchesProductivePlacement(decodedPlacement, placement)) continue;

    const removal = removalsById.get(placement.wardEntityNetworkId);
    const candidate =
      hypothesisId === wardFloatApiFitHypothesisId
        ? decodeApiFitCandidate(research, placement)
        : null;
    if (!candidate) continue;

    let state: ReplayWardPositionMarkerState | null = null;
    if (options.visibilityMode === "all-placements") {
      state = "all-placement";
    } else {
      const afterPlacement = currentTimeMillis >= placement.timestampMillis;
      const sincePlacement = currentTimeMillis - placement.timestampMillis;
      const afterRemoval = removal ? currentTimeMillis >= removal.timestampMillis : false;
      const sinceRemoval = removal
        ? currentTimeMillis - removal.timestampMillis
        : Number.POSITIVE_INFINITY;

      if (options.showEventPulses && afterRemoval && sinceRemoval <= pulseDurationMillis) {
        state = "kill-pulse";
      } else if (
        options.showEventPulses &&
        afterPlacement &&
        sincePlacement <= pulseDurationMillis
      ) {
        state = "placement-pulse";
      } else if (options.showActiveLinkedWards && removal && afterPlacement && !afterRemoval) {
        state = "active-linked";
      }
    }

    // Unlinked wards are intentionally not treated as indefinitely active in
    // timeline mode because the productive removal decoder is conservative.
    if (!state) continue;

    markers.push({
      hypothesisId,
      hypothesisLabel: declaredHypothesis?.label ?? candidate.label ?? candidate.hypothesisId,
      wardEntityNetworkId: placement.wardEntityNetworkId,
      wardEntityNetworkIdHex: placement.wardEntityNetworkIdHex,
      ownerParticipantId: placement.ownerParticipantId,
      placementTimestampMillis: placement.timestampMillis,
      removalTimestampMillis: removal?.timestampMillis ?? null,
      x: candidate.x,
      y: candidate.y,
      leftPercent: (candidate.x / mapMaximum) * 100,
      topPercent: 100 - (candidate.y / mapMaximum) * 100,
      state,
      xSource: candidate.xSource,
      ySource: candidate.ySource,
    });
  }

  return markers.sort(
    (left, right) => left.placementTimestampMillis - right.placementTimestampMillis,
  );
}

function matchesProductivePlacement(
  decodedPlacement: ReplayWardPlacedEvent | undefined,
  researchPlacement: ReplayWardPositionResearchPlacement,
): boolean {
  return (
    decodedPlacement !== undefined &&
    decodedPlacement.timestampMillis === researchPlacement.timestampMillis &&
    decodedPlacement.ownerParticipantId === researchPlacement.ownerParticipantId
  );
}

function isBoundedCandidate(candidate: ReplayWardPositionResearchCandidate): boolean {
  return (
    Number.isFinite(candidate.x) &&
    Number.isFinite(candidate.y) &&
    candidate.x >= mapMinimum &&
    candidate.x <= mapMaximum &&
    candidate.y >= mapMinimum &&
    candidate.y <= mapMaximum
  );
}
