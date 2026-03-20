import type { ReplayEntitySlabAnalysisResult, ReplayFamilyScanItem, ReplayScalarFamilyAnalysisResult } from "./replayInvestigation";
import type { RiotFixtureBundle } from "./riotApiFixtures";
import { assignReplayParticipants, type ReplayParticipantSlotAssignmentReport, type ReplayParticipantSlotCandidate } from "./replayParticipantAssignment";
import { correlateReplayScalars, type ReplayScalarCorrelationReport, type ReplayScalarMetricMatch } from "./replayScalarCorrelation";

export interface ReplayDeepFamilyInput {
  family: ReplayFamilyScanItem;
  entityAnalysis: ReplayEntitySlabAnalysisResult;
  schemaData: any;
  cleanedData: any;
}

export interface ReplayDeepFamilySummary {
  familyKey: string;
  familyLabel: string;
  familyLength: number;
  familyFirstByte: number;
  descriptorRowCount: number;
  cleanedRowCount: number;
  cleanedFieldCount: number;
  topMatch: ReplayScalarMetricMatch | null;
  topParticipant: ReplayParticipantSlotCandidate | null;
  score: number;
}

export interface ReplayDeepAnalysisReport {
  families: ReplayDeepFamilySummary[];
  topMatches: ReplayScalarMetricMatch[];
  participantAssignments: ReplayParticipantSlotAssignmentReport;
  scalarReport: ReplayScalarCorrelationReport;
  summary: string;
}

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function buildFamilyKey(family: ReplayFamilyScanItem): string {
  return `${family.length}:${family.firstByte}`;
}

export function estimateElementCount(family: ReplayFamilyScanItem): number {
  const usable = family.length - Math.max(family.recommendedHeaderSize, 0);
  if (usable <= 0 || family.recommendedStride <= 0) {
    return 0;
  }
  return Math.floor(usable / family.recommendedStride);
}

export function deriveDeepCleanedRows(
  family: ReplayFamilyScanItem,
  entityAnalysis: ReplayEntitySlabAnalysisResult,
  fallbackRows: number[] = [],
): number[] {
  const elementCount = estimateElementCount(family);
  const rows = new Set<number>();

  for (const slot of entityAnalysis.topDynamicSlots.slice(0, 8)) {
    if (slot.slotIndex < elementCount) {
      rows.add(slot.slotIndex);
    }
  }
  for (const slot of entityAnalysis.topMixedSlots.slice(0, 6)) {
    if (slot.slotIndex < elementCount) {
      rows.add(slot.slotIndex);
    }
  }
  for (const row of fallbackRows) {
    if (row >= 0 && row < elementCount) {
      rows.add(row);
    }
  }

  const selected = Array.from(rows).sort((left, right) => left - right);
  if (selected.length > 0) {
    return selected.slice(0, 10);
  }

  const start = Math.min(12, Math.max(elementCount - 1, 0));
  const result: number[] = [];
  for (let index = start; index < Math.min(start + 12, elementCount); index += 1) {
    result.push(index);
  }
  return result;
}

export function cleanedFieldsToScalarFamilyAnalysis(
  familyContext: ReplayFamilyScanItem,
  cleanedFieldsData: any,
): ReplayScalarFamilyAnalysisResult {
  const mappedSlots = Array.isArray(cleanedFieldsData?.slots)
    ? cleanedFieldsData.slots.map((slot: any) => ({
        rank: 0,
        slotIndex: slot.slotIndex,
        score: 0,
        activeRecords: slot.activeRecords ?? 0,
        totalLaneSamples: 0,
        maxActiveLanes: 0,
        topFirstByte: 0,
        topFirstByteCount: 0,
        topMask: 0,
        topMaskBits: "",
        topMaskCount: 0,
        chunkSpanStart: slot.chunkSpanStart ?? 0,
        chunkSpanEnd: slot.chunkSpanEnd ?? 0,
        lanes: (slot.fields || []).map((field: any) => ({
          laneIndex: field.offset,
          activeSamples: field.activeSamples ?? 0,
          nonZeroSamples: field.nonZeroSamples ?? 0,
          uniqueValues: field.uniqueValues ?? 0,
          transitions: field.transitions ?? 0,
          changedTransitions: field.changedTransitions ?? 0,
          minU32: field.minValue ?? 0,
          maxU32: field.maxValue ?? 0,
          minFiniteF32: 0,
          maxFiniteF32: 0,
          samples: (field.samples || []).map((sample: any) => ({
            chunkId: sample.chunkId ?? 0,
            recordIndex: sample.recordIndex ?? 0,
            timestamp: sample.timestamp ?? 0,
            rawU32: sample.raw !== undefined ? sample.raw : (sample.u32 ?? 0),
            firstByte: 0,
            mask: 0,
            maskBits: "",
          })),
        })),
      }))
    : [];

  return {
    length: familyContext.length,
    firstByte: familyContext.firstByte,
    recordCount: cleanedFieldsData?.recordCount ?? 0,
    headerSize: familyContext.recommendedHeaderSize,
    stride: familyContext.recommendedStride,
    gameLengthMillis: 0,
    chunkBaseId: 0,
    elementCount: cleanedFieldsData?.elementCount ?? 0,
    laneCount: 0,
    slots: mappedSlots,
  };
}

export function correlateCleanedFields(
  familyContext: ReplayFamilyScanItem,
  cleanedFieldsData: any,
  bundle: RiotFixtureBundle,
): ReplayScalarCorrelationReport {
  return correlateReplayScalars([
    { family: familyContext, analysis: cleanedFieldsToScalarFamilyAnalysis(familyContext, cleanedFieldsData) },
  ], bundle);
}

export function buildReplayDeepAnalysisReport(
  inputs: ReplayDeepFamilyInput[],
  bundle: RiotFixtureBundle,
): ReplayDeepAnalysisReport {
  const scalarAnalyses = inputs.map((input) => ({
    family: input.family,
    analysis: cleanedFieldsToScalarFamilyAnalysis(input.family, input.cleanedData),
  }));
  const entityAnalyses = inputs.map((input) => ({
    family: input.family,
    analysis: input.entityAnalysis,
  }));

  const scalarReport = correlateReplayScalars(scalarAnalyses, bundle);
  const participantAssignments = assignReplayParticipants(scalarReport, entityAnalyses, bundle);

  const families: ReplayDeepFamilySummary[] = inputs.map((input) => {
    const familyKey = buildFamilyKey(input.family);
    const familyLabel = `${input.family.length} / ${formatByte(input.family.firstByte)}`;
    const descriptorRows = Array.isArray(input.schemaData?.descriptorRows)
      ? input.schemaData.descriptorRows.filter((row: any) => row?.descriptorLike)
      : [];
    const cleanedSlots = Array.isArray(input.cleanedData?.slots) ? input.cleanedData.slots : [];
    const cleanedFieldCount = cleanedSlots.reduce((sum: number, slot: any) => sum + ((slot.fields || []).length), 0);
    const topMatch = scalarReport.topScalarMatches.find((match) => match.familyKey === familyKey) ?? null;
    const topParticipant = participantAssignments.topCandidates.find((candidate) => candidate.familyKey === familyKey) ?? null;
    const score = (topMatch?.score ?? 0) + (topParticipant?.score ?? 0);
    return {
      familyKey,
      familyLabel,
      familyLength: input.family.length,
      familyFirstByte: input.family.firstByte,
      descriptorRowCount: descriptorRows.length,
      cleanedRowCount: cleanedSlots.length,
      cleanedFieldCount,
      topMatch,
      topParticipant,
      score,
    };
  }).sort((left, right) => right.score - left.score || right.cleanedFieldCount - left.cleanedFieldCount);

  const bestFamily = families[0];
  const bestMatch = scalarReport.topScalarMatches[0];
  let summary = 'Automatic deep analysis did not find a strong cleaned-field lead yet.';
  if (bestFamily && bestMatch) {
    summary = `Best cleaned-field family is ${bestFamily.familyLabel}. Current top lead is row ${bestMatch.slotIndex}, offset ${bestMatch.laneIndex}, ${bestMatch.decodeLabel} -> ${bestMatch.champion} ${bestMatch.metricLabel} (corr ${bestMatch.correlation.toFixed(2)}, nRMSE ${bestMatch.normalizedRmse.toFixed(2)}).`;
  }

  return {
    families,
    topMatches: scalarReport.topScalarMatches.slice(0, 24),
    participantAssignments,
    scalarReport,
    summary,
  };
}
