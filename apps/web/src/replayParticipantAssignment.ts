import type { ReplayEntitySlabAnalysisResult, ReplayFamilyScanItem } from "./replayInvestigation";
import type { RiotFixtureBundle } from "./riotApiFixtures";
import type { ReplayScalarCorrelationReport, ReplayScalarMetricMatch } from "./replayScalarCorrelation";

interface SlotArchetypeInfo {
  familyKey: string;
  familyLength: number;
  familyFirstByte: number;
  familyLabel: string;
  slotIndex: number;
  archetype: string;
}

export interface ReplayParticipantSlotCandidate {
  familyKey: string;
  familyLength: number;
  familyFirstByte: number;
  familyLabel: string;
  slotIndex: number;
  participantId: number;
  champion: string;
  teamId: number;
  archetype: string;
  distinctMetrics: number;
  distinctLanes: number;
  metricKeys: string[];
  score: number;
  averageCorrelation: number;
  averageNormalizedRmse: number;
  support: ReplayScalarMetricMatch[];
}

export interface ReplayParticipantSlotAssignmentReport {
  assignments: ReplayParticipantSlotCandidate[];
  topCandidates: ReplayParticipantSlotCandidate[];
  summary: string;
}

const metricWeights = new Map<string, number>([
  ["level", 1.6],
  ["xp", 1.55],
  ["totalGold", 1.45],
  ["minionsKilled", 1.35],
  ["jungleMinionsKilled", 1.35],
  ["healthMax", 1.1],
  ["powerMax", 1.05],
  ["currentGold", 0.95],
  ["health", 0.9],
  ["power", 0.85],
  ["movementSpeed", 0.6],
  ["damageToChampions", 0.7],
  ["damageTaken", 0.65],
  ["totalDamageDone", 0.65],
]);

function buildFamilyKey(family: ReplayFamilyScanItem): string {
  return `${family.length}:${family.firstByte}`;
}

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function buildSlotArchetypes(
  analyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayEntitySlabAnalysisResult }>,
): Map<string, SlotArchetypeInfo> {
  const result = new Map<string, SlotArchetypeInfo>();

  for (const { family, analysis } of analyses) {
    const familyKey = buildFamilyKey(family);
    const familyLabel = `${family.length} / ${formatByte(family.firstByte)}`;
    const rankedSlots = [
      ...analysis.topDynamicSlots,
      ...analysis.topMixedSlots,
    ];
    for (const slot of rankedSlots) {
      result.set(`${familyKey}:${slot.slotIndex}`, {
        familyKey,
        familyLength: family.length,
        familyFirstByte: family.firstByte,
        familyLabel,
        slotIndex: slot.slotIndex,
        archetype: slot.archetype,
      });
    }
  }

  return result;
}

function metricWeight(metricKey: string): number {
  return metricWeights.get(metricKey) ?? 1;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function assignReplayParticipants(
  scalarReport: ReplayScalarCorrelationReport,
  entityAnalyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayEntitySlabAnalysisResult }>,
  bundle: RiotFixtureBundle,
): ReplayParticipantSlotAssignmentReport {
  const archetypes = buildSlotArchetypes(entityAnalyses);
  const grouped = new Map<string, { archetype: SlotArchetypeInfo; participantId: number; champion: string; teamId: number; byMetric: Map<string, ReplayScalarMetricMatch> }>();

  for (const match of scalarReport.allMatches) {
    const archetype = archetypes.get(`${match.familyKey}:${match.slotIndex}`);
    if (!archetype) {
      continue;
    }
    const groupKey = `${match.familyKey}:${match.slotIndex}:${match.participantId}`;
    const group = grouped.get(groupKey) ?? {
      archetype,
      participantId: match.participantId,
      champion: match.champion,
      teamId: match.teamId,
      byMetric: new Map<string, ReplayScalarMetricMatch>(),
    };
    const previous = group.byMetric.get(match.metricKey);
    if (!previous || match.score > previous.score) {
      group.byMetric.set(match.metricKey, match);
    }
    grouped.set(groupKey, group);
  }

  const candidates: ReplayParticipantSlotCandidate[] = [];
  for (const group of grouped.values()) {
    const support = Array.from(group.byMetric.values()).sort((left, right) => right.score - left.score);
    if (support.length < 2) {
      continue;
    }
    const distinctLanes = new Set(support.map((match) => `${match.laneIndex}:${match.decodeLabel}`)).size;
    const weightedScore = support.reduce((sum, match) => sum + (match.score * metricWeight(match.metricKey)), 0);
    const averageCorrelation = average(support.map((match) => Math.max(0, match.correlation)));
    const averageNormalizedRmse = average(support.map((match) => match.normalizedRmse));
    const consistencyBonus = Math.min(0.75, Math.max(0, support.length - 1) * 0.18);
    const laneBonus = Math.min(0.25, Math.max(0, distinctLanes - 1) * 0.06);
    const archetypeBonus = group.archetype.archetype === "dynamic_state_like" ? 0.25 : 0.12;
    const score = weightedScore + consistencyBonus + laneBonus + archetypeBonus;

    candidates.push({
      familyKey: group.archetype.familyKey,
      familyLength: group.archetype.familyLength,
      familyFirstByte: group.archetype.familyFirstByte,
      familyLabel: group.archetype.familyLabel,
      slotIndex: group.archetype.slotIndex,
      participantId: group.participantId,
      champion: group.champion,
      teamId: group.teamId,
      archetype: group.archetype.archetype,
      distinctMetrics: support.length,
      distinctLanes,
      metricKeys: support.map((match) => match.metricKey),
      score,
      averageCorrelation,
      averageNormalizedRmse,
      support,
    });
  }

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (right.distinctMetrics !== left.distinctMetrics) {
      return right.distinctMetrics - left.distinctMetrics;
    }
    if (left.averageNormalizedRmse !== right.averageNormalizedRmse) {
      return left.averageNormalizedRmse - right.averageNormalizedRmse;
    }
    return right.averageCorrelation - left.averageCorrelation;
  });

  const assignments: ReplayParticipantSlotCandidate[] = [];
  const usedParticipants = new Set<number>();
  const usedSlots = new Set<string>();
  for (const candidate of candidates) {
    const slotKey = `${candidate.familyKey}:${candidate.slotIndex}`;
    if (usedParticipants.has(candidate.participantId) || usedSlots.has(slotKey)) {
      continue;
    }
    assignments.push(candidate);
    usedParticipants.add(candidate.participantId);
    usedSlots.add(slotKey);
    if (assignments.length >= bundle.match.info.participants.length) {
      break;
    }
  }

  let summary = "No stable participant-slot assignment emerged from the current scalar evidence.";
  if (assignments.length > 0) {
    const best = assignments[0];
    summary = `Assigned ${assignments.length}/${bundle.match.info.participants.length} participants. Best current row is ${best.familyLabel} slot ${best.slotIndex} -> ${best.champion} using ${best.distinctMetrics} metrics.`;
  }

  return {
    assignments,
    topCandidates: candidates.slice(0, 40),
    summary,
  };
}
