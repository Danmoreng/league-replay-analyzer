import type {
  ReplayFamilyScanItem,
  ReplayScalarFamilyAnalysisResult,
  ReplayScalarLane,
  ReplayScalarSample,
  ReplayScalarSlot,
} from "./replayInvestigation";
import type { RiotFixtureBundle } from "./riotApiFixtures";

interface ScalarPoint {
  timestamp: number;
  value: number;
}

interface ScalarMetricDefinition {
  key: string;
  label: string;
  monotonic: boolean;
  read: (participantFrame: RiotParticipantFrame) => number | null;
}

interface RiotParticipantFrame {
  currentGold?: number;
  totalGold?: number;
  xp?: number;
  level?: number;
  minionsKilled?: number;
  jungleMinionsKilled?: number;
  championStats?: {
    health?: number;
    healthMax?: number;
    power?: number;
    powerMax?: number;
    movementSpeed?: number;
  };
  damageStats?: {
    totalDamageDoneToChampions?: number;
    totalDamageTaken?: number;
    totalDamageDone?: number;
  };
}

interface ScalarCandidateSeries {
  familyKey: string;
  familyLength: number;
  familyFirstByte: number;
  slotIndex: number;
  laneIndex: number;
  decodeLabel: string;
  activeSamples: number;
  uniqueValues: number;
  changedTransitions: number;
  points: ScalarPoint[];
}

export interface ReplayScalarMetricMatch {
  familyKey: string;
  familyLength: number;
  familyFirstByte: number;
  candidateKey: string;
  slotIndex: number;
  laneIndex: number;
  decodeLabel: string;
  participantId: number;
  champion: string;
  teamId: number;
  metricKey: string;
  metricLabel: string;
  overlap: number;
  uniqueValues: number;
  changedTransitions: number;
  affineRmse: number;
  normalizedRmse: number;
  correlation: number;
  deltaCorrelation: number;
  slope: number;
  intercept: number;
  score: number;
}

export interface ReplayScalarCorrelationReport {
  topScalarMatches: ReplayScalarMetricMatch[];
  allMatches: ReplayScalarMetricMatch[];
  summary: string;
}

const scalarMetrics: ScalarMetricDefinition[] = [
  { key: "level", label: "Level", monotonic: true, read: (frame) => frame.level ?? null },
  { key: "currentGold", label: "Current Gold", monotonic: false, read: (frame) => frame.currentGold ?? null },
  { key: "totalGold", label: "Total Gold", monotonic: true, read: (frame) => frame.totalGold ?? null },
  { key: "xp", label: "XP", monotonic: true, read: (frame) => frame.xp ?? null },
  { key: "minionsKilled", label: "CS", monotonic: true, read: (frame) => frame.minionsKilled ?? null },
  { key: "jungleMinionsKilled", label: "Jungle CS", monotonic: true, read: (frame) => frame.jungleMinionsKilled ?? null },
  { key: "health", label: "Health", monotonic: false, read: (frame) => frame.championStats?.health ?? null },
  { key: "healthMax", label: "Max Health", monotonic: true, read: (frame) => frame.championStats?.healthMax ?? null },
  { key: "power", label: "Power", monotonic: false, read: (frame) => frame.championStats?.power ?? null },
  { key: "powerMax", label: "Max Power", monotonic: true, read: (frame) => frame.championStats?.powerMax ?? null },
  { key: "movementSpeed", label: "Move Speed", monotonic: false, read: (frame) => frame.championStats?.movementSpeed ?? null },
  { key: "damageToChampions", label: "Damage To Champs", monotonic: true, read: (frame) => frame.damageStats?.totalDamageDoneToChampions ?? null },
  { key: "damageTaken", label: "Damage Taken", monotonic: true, read: (frame) => frame.damageStats?.totalDamageTaken ?? null },
  { key: "totalDamageDone", label: "Total Damage Done", monotonic: true, read: (frame) => frame.damageStats?.totalDamageDone ?? null },
];

function buildFamilyKey(family: ReplayFamilyScanItem): string {
  return `${family.length}:${family.firstByte}`;
}

function buildCandidateKey(candidate: ScalarCandidateSeries): string {
  return `${candidate.slotIndex}:${candidate.laneIndex}:${candidate.decodeLabel}`;
}

function reinterpretF32(rawU32: number): number {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint32(0, rawU32 >>> 0, true);
  return view.getFloat32(0, true);
}

function signExtend16(value: number): number {
  const masked = value & 0xffff;
  return masked & 0x8000 ? masked - 0x10000 : masked;
}

function buildScalarMetricSeries(bundle: RiotFixtureBundle): Map<number, Map<string, ScalarPoint[]>> {
  const result = new Map<number, Map<string, ScalarPoint[]>>();

  for (const frame of bundle.timeline.info.frames) {
    const participantFrames = frame.participantFrames as Record<string, RiotParticipantFrame>;
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      const participantId = Number(rawParticipantId);
      const participantMetrics = result.get(participantId) ?? new Map<string, ScalarPoint[]>();
      for (const metric of scalarMetrics) {
        const value = metric.read(participantFrame);
        if (value == null || !Number.isFinite(value)) {
          continue;
        }
        const list = participantMetrics.get(metric.key) ?? [];
        list.push({ timestamp: frame.timestamp, value });
        participantMetrics.set(metric.key, list);
      }
      result.set(participantId, participantMetrics);
    }
  }

  return result;
}

function interpolateScalar(points: ScalarPoint[], timestamp: number): number | null {
  if (points.length === 0) {
    return null;
  }
  if (timestamp <= points[0].timestamp) {
    return points[0].value;
  }
  if (timestamp >= points[points.length - 1].timestamp) {
    return points[points.length - 1].value;
  }

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (timestamp > right.timestamp) {
      continue;
    }
    const span = right.timestamp - left.timestamp;
    if (span <= 0) {
      return right.value;
    }
    const t = (timestamp - left.timestamp) / span;
    return left.value + ((right.value - left.value) * t);
  }

  return points[points.length - 1]?.value ?? null;
}

function fitAffine1D(rawValues: number[], targetValues: number[]) {
  const n = Math.min(rawValues.length, targetValues.length);
  if (n < 3) {
    return { valid: false, slope: 0, intercept: 0, rmse: Number.POSITIVE_INFINITY };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let index = 0; index < n; index += 1) {
    const x = rawValues[index];
    const y = targetValues[index];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denominator = (n * sumXX) - (sumX * sumX);
  if (Math.abs(denominator) < 1e-9) {
    const intercept = sumY / n;
    let squaredError = 0;
    for (let index = 0; index < n; index += 1) {
      const error = intercept - targetValues[index];
      squaredError += error * error;
    }
    return {
      valid: false,
      slope: 0,
      intercept,
      rmse: Math.sqrt(squaredError / n),
    };
  }

  const slope = ((n * sumXY) - (sumX * sumY)) / denominator;
  const intercept = (sumY - (slope * sumX)) / n;
  let squaredError = 0;
  for (let index = 0; index < n; index += 1) {
    const predicted = (slope * rawValues[index]) + intercept;
    const error = predicted - targetValues[index];
    squaredError += error * error;
  }

  return {
    valid: true,
    slope,
    intercept,
    rmse: Math.sqrt(squaredError / n),
  };
}

function pearsonCorrelation(left: number[], right: number[]): number {
  const n = Math.min(left.length, right.length);
  if (n < 3) {
    return 0;
  }

  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < n; index += 1) {
    sumLeft += left[index];
    sumRight += right[index];
  }
  const meanLeft = sumLeft / n;
  const meanRight = sumRight / n;

  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < n; index += 1) {
    const leftDelta = left[index] - meanLeft;
    const rightDelta = right[index] - meanRight;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }

  if (leftVariance <= 1e-9 || rightVariance <= 1e-9) {
    return 0;
  }
  return numerator / Math.sqrt(leftVariance * rightVariance);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => {
    const delta = value - mean;
    return sum + (delta * delta);
  }, 0) / values.length;
  return Math.sqrt(variance);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countApproxUnique(values: number[]): number {
  const buckets = new Set(values.map((value) => Math.round(value * 1000) / 1000));
  return buckets.size;
}

function buildDecodedSeries(slot: ReplayScalarSlot, lane: ReplayScalarLane, family: ReplayFamilyScanItem): ScalarCandidateSeries[] {
  const rawSamples = lane.samples;
  if (rawSamples.length < 6 || lane.changedTransitions === 0) {
    return [];
  }

  const build = (decodeLabel: string, decode: (sample: ReplayScalarSample) => number | null): ScalarCandidateSeries | null => {
    const points: ScalarPoint[] = [];
    for (const sample of rawSamples) {
      const value = decode(sample);
      if (value == null || !Number.isFinite(value)) {
        continue;
      }
      points.push({ timestamp: sample.timestamp, value });
    }
    const uniqueValues = countApproxUnique(points.map((point) => point.value));
    if (points.length < 6 || uniqueValues < 4) {
      return null;
    }
    return {
      familyKey: buildFamilyKey(family),
      familyLength: family.length,
      familyFirstByte: family.firstByte,
      slotIndex: slot.slotIndex,
      laneIndex: lane.laneIndex,
      decodeLabel,
      activeSamples: points.length,
      uniqueValues,
      changedTransitions: lane.changedTransitions,
      points,
    };
  };

  return [
    build("u32", (sample) => sample.rawU32 >>> 0),
    build("i32", (sample) => sample.rawU32 | 0),
    build("f32", (sample) => {
      const value = reinterpretF32(sample.rawU32);
      return Number.isFinite(value) && Math.abs(value) <= 1e9 ? value : null;
    }),
    build("u16lo", (sample) => sample.rawU32 & 0xffff),
    build("u16hi", (sample) => sample.rawU32 >>> 16),
    build("i16lo", (sample) => signExtend16(sample.rawU32)),
    build("i16hi", (sample) => signExtend16(sample.rawU32 >>> 16)),
    build("u8_0", (sample) => sample.rawU32 & 0xff),
    build("u8_1", (sample) => (sample.rawU32 >>> 8) & 0xff),
    build("u8_2", (sample) => (sample.rawU32 >>> 16) & 0xff),
    build("u8_3", (sample) => (sample.rawU32 >>> 24) & 0xff),
  ].filter((candidate): candidate is ScalarCandidateSeries => candidate !== null);
}

function compareCandidateToMetric(
  candidate: ScalarCandidateSeries,
  participantId: number,
  champion: string,
  teamId: number,
  metric: ScalarMetricDefinition,
  targetPoints: ScalarPoint[],
): ReplayScalarMetricMatch | null {
  if (candidate.points.length < 6 || targetPoints.length < 3) {
    return null;
  }

  const rawValues: number[] = [];
  const targetValues: number[] = [];
  for (const point of candidate.points) {
    const target = interpolateScalar(targetPoints, point.timestamp);
    if (target == null || !Number.isFinite(target)) {
      continue;
    }
    rawValues.push(point.value);
    targetValues.push(target);
  }

  const overlap = rawValues.length;
  if (overlap < 6) {
    return null;
  }

  const fit = fitAffine1D(rawValues, targetValues);
  if (!Number.isFinite(fit.rmse)) {
    return null;
  }

  const predictedValues = rawValues.map((value) => (fit.slope * value) + fit.intercept);
  const predictedDiffs: number[] = [];
  const targetDiffs: number[] = [];
  for (let index = 1; index < predictedValues.length; index += 1) {
    predictedDiffs.push(predictedValues[index] - predictedValues[index - 1]);
    targetDiffs.push(targetValues[index] - targetValues[index - 1]);
  }

  const targetStdDev = standardDeviation(targetValues);
  const normalizedRmse = fit.rmse / Math.max(targetStdDev, 1);
  const correlation = pearsonCorrelation(predictedValues, targetValues);
  const deltaCorrelation = pearsonCorrelation(predictedDiffs, targetDiffs);
  let monotonicAgreement = 1;
  if (metric.monotonic && targetDiffs.length > 0) {
    let agreements = 0;
    for (let index = 0; index < targetDiffs.length; index += 1) {
      const targetDelta = targetDiffs[index];
      const predictedDelta = predictedDiffs[index];
      const sameDirection = (targetDelta >= -1e-6 && predictedDelta >= -1e-6) || (targetDelta <= 1e-6 && predictedDelta <= 1e-6);
      if (sameDirection) {
        agreements += 1;
      }
    }
    monotonicAgreement = agreements / targetDiffs.length;
  }

  const overlapFactor = Math.min(1, overlap / 16);
  const uniqueFactor = Math.min(1, candidate.uniqueValues / 12);
  const rmseFactor = 1 / (1 + normalizedRmse);
  const correlationFactor = clamp(correlation, 0, 1);
  const deltaFactor = clamp(Number.isFinite(deltaCorrelation) ? deltaCorrelation : 0, 0, 1);
  const monotonicFactor = metric.monotonic ? monotonicAgreement : 0.75;
  const slopeFactor = metric.monotonic && fit.slope < 0 ? 0.2 : 1;
  const score = overlapFactor * uniqueFactor * rmseFactor * ((0.5 * correlationFactor) + (0.2 * deltaFactor) + (0.3 * monotonicFactor)) * slopeFactor;

  return {
    familyKey: candidate.familyKey,
    familyLength: candidate.familyLength,
    familyFirstByte: candidate.familyFirstByte,
    candidateKey: buildCandidateKey(candidate),
    slotIndex: candidate.slotIndex,
    laneIndex: candidate.laneIndex,
    decodeLabel: candidate.decodeLabel,
    participantId,
    champion,
    teamId,
    metricKey: metric.key,
    metricLabel: metric.label,
    overlap,
    uniqueValues: candidate.uniqueValues,
    changedTransitions: candidate.changedTransitions,
    affineRmse: fit.rmse,
    normalizedRmse,
    correlation,
    deltaCorrelation,
    slope: fit.slope,
    intercept: fit.intercept,
    score,
  };
}

export function correlateReplayScalars(
  analyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayScalarFamilyAnalysisResult }>,
  bundle: RiotFixtureBundle,
): ReplayScalarCorrelationReport {
  const metricSeries = buildScalarMetricSeries(bundle);
  const participants = bundle.match.info.participants;
  const matches: ReplayScalarMetricMatch[] = [];

  for (const { family, analysis } of analyses) {
    for (const slot of analysis.slots) {
      for (const lane of slot.lanes) {
        const candidates = buildDecodedSeries(slot, lane, family);
        for (const candidate of candidates) {
          for (const participant of participants) {
            const participantMetrics = metricSeries.get(participant.participantId);
            if (!participantMetrics) {
              continue;
            }
            for (const metric of scalarMetrics) {
              const targetSeries = participantMetrics.get(metric.key) ?? [];
              const match = compareCandidateToMetric(
                candidate,
                participant.participantId,
                participant.championName,
                participant.teamId,
                metric,
                targetSeries,
              );
              if (match) {
                matches.push(match);
              }
            }
          }
        }
      }
    }
  }

  matches.sort((left, right) => right.score - left.score || left.normalizedRmse - right.normalizedRmse || right.correlation - left.correlation);

  let summary = "No convincing scalar correlations were found yet.";
  const top = matches[0];
  if (top) {
    summary = `Best scalar match is slot ${top.slotIndex} lane ${top.laneIndex} ${top.decodeLabel} against ${top.champion} ${top.metricLabel} (corr ${top.correlation.toFixed(2)}, nRMSE ${top.normalizedRmse.toFixed(2)}).`;
  }

  return {
    topScalarMatches: matches.slice(0, 64),
    allMatches: matches,
    summary,
  };
}
