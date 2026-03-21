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

export interface ReplayLikelyFieldPattern {
  patternKey: string;
  familyKey: string;
  familyLabel: string;
  familyLength: number;
  familyFirstByte: number;
  laneIndex: number;
  decodeLabel: string;
  metricKey: string;
  metricLabel: string;
  distinctRows: number;
  distinctParticipants: number;
  supportCount: number;
  averageCorrelation: number;
  averageNormalizedRmse: number;
  averageScore: number;
  bestScore: number;
  archetypes: string[];
  rowPreview: number[];
  championPreview: string[];
}

export interface ReplayDeepAnalysisReport {
  families: ReplayDeepFamilySummary[];
  topMatches: ReplayScalarMetricMatch[];
  likelyFieldPatterns: ReplayLikelyFieldPattern[];
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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildLikelyFieldPatterns(
  participantAssignments: ReplayParticipantSlotAssignmentReport,
): ReplayLikelyFieldPattern[] {
  const grouped = new Map<string, {
    familyKey: string;
    familyLabel: string;
    familyLength: number;
    familyFirstByte: number;
    laneIndex: number;
    decodeLabel: string;
    metricKey: string;
    metricLabel: string;
    rows: Set<number>;
    participants: Set<number>;
    champions: Set<string>;
    archetypes: Set<string>;
    scores: number[];
    correlations: number[];
    normalizedRmses: number[];
  }>();

  for (const candidate of participantAssignments.topCandidates.slice(0, 24)) {
    for (const support of candidate.support) {
      const patternKey = `${support.familyKey}:${support.laneIndex}:${support.decodeLabel}:${support.metricKey}`;
      const group = grouped.get(patternKey) ?? {
        familyKey: support.familyKey,
        familyLabel: candidate.familyLabel,
        familyLength: support.familyLength,
        familyFirstByte: support.familyFirstByte,
        laneIndex: support.laneIndex,
        decodeLabel: support.decodeLabel,
        metricKey: support.metricKey,
        metricLabel: support.metricLabel,
        rows: new Set<number>(),
        participants: new Set<number>(),
        champions: new Set<string>(),
        archetypes: new Set<string>(),
        scores: [],
        correlations: [],
        normalizedRmses: [],
      };
      group.rows.add(support.slotIndex);
      group.participants.add(support.participantId);
      group.champions.add(support.champion);
      group.archetypes.add(candidate.archetype);
      group.scores.push(support.score);
      group.correlations.push(support.correlation);
      group.normalizedRmses.push(support.normalizedRmse);
      grouped.set(patternKey, group);
    }
  }

  return Array.from(grouped.entries()).map(([patternKey, group]) => {
    const averageScore = average(group.scores);
    const averageCorrelation = average(group.correlations);
    const averageNormalizedRmse = average(group.normalizedRmses);
    const distinctRows = group.rows.size;
    const distinctParticipants = group.participants.size;
    const supportCount = group.scores.length;
    const bestScore = Math.max(...group.scores);

    return {
      patternKey,
      familyKey: group.familyKey,
      familyLabel: group.familyLabel,
      familyLength: group.familyLength,
      familyFirstByte: group.familyFirstByte,
      laneIndex: group.laneIndex,
      decodeLabel: group.decodeLabel,
      metricKey: group.metricKey,
      metricLabel: group.metricLabel,
      distinctRows,
      distinctParticipants,
      supportCount,
      averageCorrelation,
      averageNormalizedRmse,
      averageScore,
      bestScore,
      archetypes: Array.from(group.archetypes).sort(),
      rowPreview: Array.from(group.rows).sort((left, right) => left - right).slice(0, 6),
      championPreview: Array.from(group.champions).sort().slice(0, 4),
    };
  }).sort((left, right) => {
    if (right.distinctParticipants !== left.distinctParticipants) {
      return right.distinctParticipants - left.distinctParticipants;
    }
    if (right.distinctRows !== left.distinctRows) {
      return right.distinctRows - left.distinctRows;
    }
    if (right.averageScore !== left.averageScore) {
      return right.averageScore - left.averageScore;
    }
    if (left.averageNormalizedRmse !== right.averageNormalizedRmse) {
      return left.averageNormalizedRmse - right.averageNormalizedRmse;
    }
    return right.averageCorrelation - left.averageCorrelation;
  });
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
    likelyFieldPatterns: buildLikelyFieldPatterns(participantAssignments).slice(0, 24),
    participantAssignments,
    scalarReport,
    summary,
  };
}
