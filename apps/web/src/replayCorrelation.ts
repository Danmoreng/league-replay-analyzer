import type { ReplayAnalysisCandidate, ReplayFamilyAnalysisResult, ReplayFamilyScanItem } from "./replayInvestigation";
import type { RiotFixtureBundle, RiotTimelineEvent } from "./riotApiFixtures";

interface PositionPoint {
  timestamp: number;
  x: number;
  y: number;
}

interface ParticipantEventPoint {
  timestamp: number;
  x: number;
  y: number;
  type: string;
}

export interface ReplayPositionMatch {
  familyKey: string;
  familyLength: number;
  familyFirstByte: number;
  candidateKey: string;
  slotIndex: number;
  pairLabel: string;
  participantId: number;
  champion: string;
  teamId: number;
  identityRmse: number;
  affineRmse: number;
  eventRmse: number;
  overlap: number;
  eventMatches: number;
  score: number;
}

export interface ReplayFamilyRanking {
  familyKey: string;
  familyLabel: string;
  familyLength: number;
  familyFirstByte: number;
  bestCandidateKey: string;
  bestParticipantId: number;
  bestChampion: string;
  bestScore: number;
  bestAffineRmse: number;
  bestEventRmse: number;
  classNearTenCount: number;
}

export interface ReplayCorrelationReport {
  familyRankings: ReplayFamilyRanking[];
  topPositionMatches: ReplayPositionMatch[];
  summary: string;
}

function buildFamilyKey(family: ReplayFamilyScanItem): string {
  return `${family.length}:${family.firstByte}`;
}

function buildCandidateKey(candidate: ReplayAnalysisCandidate): string {
  return `${candidate.slotIndex}:${candidate.pairLabel}`;
}

function interpolatePosition(points: PositionPoint[], timestamp: number): PositionPoint | null {
  if (points.length === 0) {
    return null;
  }
  if (timestamp <= points[0].timestamp) {
    return points[0];
  }
  if (timestamp >= points[points.length - 1].timestamp) {
    return points[points.length - 1];
  }

  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (timestamp > right.timestamp) {
      continue;
    }
    const span = right.timestamp - left.timestamp;
    if (span <= 0) {
      return right;
    }
    const t = (timestamp - left.timestamp) / span;
    return {
      timestamp,
      x: left.x + ((right.x - left.x) * t),
      y: left.y + ((right.y - left.y) * t),
    };
  }

  return points[points.length - 1] ?? null;
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
  if (Math.abs(denominator) < 1e-6) {
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

function buildParticipantPositions(bundle: RiotFixtureBundle): Map<number, PositionPoint[]> {
  const positions = new Map<number, PositionPoint[]>();

  for (const frame of bundle.timeline.info.frames) {
    const participantFrames = frame.participantFrames as Record<string, { position?: { x: number; y: number } }>;
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      if (!participantFrame.position) {
        continue;
      }

      const participantId = Number(rawParticipantId);
      const list = positions.get(participantId) ?? [];
      list.push({
        timestamp: frame.timestamp,
        x: participantFrame.position.x,
        y: participantFrame.position.y,
      });
      positions.set(participantId, list);
    }
  }

  return positions;
}

function eventParticipants(event: RiotTimelineEvent): number[] {
  const participants = new Set<number>();
  if (event.participantId && event.participantId > 0) participants.add(event.participantId);
  if (event.killerId && event.killerId > 0) participants.add(event.killerId);
  if (event.victimId && event.victimId > 0) participants.add(event.victimId);
  for (const assistingParticipantId of event.assistingParticipantIds ?? []) {
    if (assistingParticipantId > 0) {
      participants.add(assistingParticipantId);
    }
  }
  return Array.from(participants);
}

function buildParticipantEvents(bundle: RiotFixtureBundle): Map<number, ParticipantEventPoint[]> {
  const eventsByParticipant = new Map<number, ParticipantEventPoint[]>();
  const relevantTypes = new Set(["CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL"]);

  for (const frame of bundle.timeline.info.frames) {
    for (const event of frame.events) {
      if (!relevantTypes.has(event.type) || !event.position) {
        continue;
      }

      for (const participantId of eventParticipants(event)) {
        const list = eventsByParticipant.get(participantId) ?? [];
        list.push({
          timestamp: event.timestamp,
          x: event.position.x,
          y: event.position.y,
          type: event.type,
        });
        eventsByParticipant.set(participantId, list);
      }
    }
  }

  return eventsByParticipant;
}

function compareCandidateToParticipant(
  family: ReplayFamilyScanItem,
  candidate: ReplayAnalysisCandidate,
  participantId: number,
  champion: string,
  teamId: number,
  positions: PositionPoint[],
  events: ParticipantEventPoint[],
): ReplayPositionMatch | null {
  const candidatePoints = candidate.samples;
  if (candidatePoints.length < 8 || positions.length < 2) {
    return null;
  }

  const rawX: number[] = [];
  const rawY: number[] = [];
  const targetX: number[] = [];
  const targetY: number[] = [];
  let identitySquaredError = 0;

  for (const sample of candidatePoints) {
    const target = interpolatePosition(positions, sample.timestamp);
    if (!target) {
      continue;
    }
    rawX.push(sample.x);
    rawY.push(sample.y);
    targetX.push(target.x);
    targetY.push(target.y);
    const dx = sample.x - target.x;
    const dy = sample.y - target.y;
    identitySquaredError += (dx * dx) + (dy * dy);
  }

  const overlap = rawX.length;
  if (overlap < 8) {
    return null;
  }

  const identityRmse = Math.sqrt(identitySquaredError / overlap);
  const xFit = fitAffine1D(rawX, targetX);
  const yFit = fitAffine1D(rawY, targetY);
  const affineRmse = Math.sqrt((xFit.rmse * xFit.rmse) + (yFit.rmse * yFit.rmse));

  let eventMatches = 0;
  let eventSquaredError = 0;
  for (const event of events) {
    let nearestDistance = Number.POSITIVE_INFINITY;
    let nearestDelta = Number.POSITIVE_INFINITY;
    for (const sample of candidatePoints) {
      const delta = Math.abs(sample.timestamp - event.timestamp);
      if (delta > 45000 || delta > nearestDelta) {
        continue;
      }
      const dx = sample.x - event.x;
      const dy = sample.y - event.y;
      nearestDistance = Math.hypot(dx, dy);
      nearestDelta = delta;
    }
    if (Number.isFinite(nearestDistance)) {
      eventMatches += 1;
      eventSquaredError += nearestDistance * nearestDistance;
    }
  }

  const eventRmse = eventMatches > 0 ? Math.sqrt(eventSquaredError / eventMatches) : Number.POSITIVE_INFINITY;
  const overlapScore = Math.min(1, overlap / 30);
  const affineScore = 1 / (1 + (affineRmse / 500));
  const eventScore = Number.isFinite(eventRmse) ? (1 / (1 + (eventRmse / 1000))) : 0.15;
  const score = overlapScore * ((0.75 * affineScore) + (0.25 * eventScore));

  return {
    familyKey: buildFamilyKey(family),
    familyLength: family.length,
    familyFirstByte: family.firstByte,
    candidateKey: buildCandidateKey(candidate),
    slotIndex: candidate.slotIndex,
    pairLabel: candidate.pairLabel,
    participantId,
    champion,
    teamId,
    identityRmse,
    affineRmse,
    eventRmse,
    overlap,
    eventMatches,
    score,
  };
}

export function correlateReplayAnalyses(
  analyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayFamilyAnalysisResult }>,
  bundle: RiotFixtureBundle,
): ReplayCorrelationReport {
  const participantPositions = buildParticipantPositions(bundle);
  const participantEvents = buildParticipantEvents(bundle);
  const participants = bundle.match.info.participants;
  const allMatches: ReplayPositionMatch[] = [];
  const familyRankings: ReplayFamilyRanking[] = [];

  for (const { family, analysis } of analyses) {
    let bestMatch: ReplayPositionMatch | null = null;

    for (const candidate of analysis.candidates) {
      for (const participant of participants) {
        const match = compareCandidateToParticipant(
          family,
          candidate,
          participant.participantId,
          participant.championName,
          participant.teamId,
          participantPositions.get(participant.participantId) ?? [],
          participantEvents.get(participant.participantId) ?? [],
        );
        if (!match) {
          continue;
        }
        allMatches.push(match);
        if (!bestMatch || match.score > bestMatch.score) {
          bestMatch = match;
        }
      }
    }

    if (!bestMatch) {
      continue;
    }

    const classNearTenCount = analysis.classes.filter((classItem) => classItem.members >= 8 && classItem.members <= 12).length;
    familyRankings.push({
      familyKey: buildFamilyKey(family),
      familyLabel: `${family.length} / 0x${family.firstByte.toString(16).toUpperCase().padStart(2, "0")}`,
      familyLength: family.length,
      familyFirstByte: family.firstByte,
      bestCandidateKey: bestMatch.candidateKey,
      bestParticipantId: bestMatch.participantId,
      bestChampion: bestMatch.champion,
      bestScore: bestMatch.score * (1 + (0.05 * classNearTenCount)),
      bestAffineRmse: bestMatch.affineRmse,
      bestEventRmse: bestMatch.eventRmse,
      classNearTenCount,
    });
  }

  familyRankings.sort((left, right) => right.bestScore - left.bestScore || left.bestAffineRmse - right.bestAffineRmse);
  allMatches.sort((left, right) => right.score - left.score || left.affineRmse - right.affineRmse);

  let summary = "No convincing movement correlation was found yet.";
  const topMatch = allMatches[0];
  if (topMatch) {
    summary = topMatch.affineRmse < 1500
      ? `Best current movement candidate is slot ${topMatch.slotIndex} ${topMatch.pairLabel} against ${topMatch.champion} with affine RMSE ${topMatch.affineRmse.toFixed(0)}.`
      : `Best current movement candidate is still weak: slot ${topMatch.slotIndex} ${topMatch.pairLabel} against ${topMatch.champion} with affine RMSE ${topMatch.affineRmse.toFixed(0)}.`;
  }

  return {
    familyRankings: familyRankings.slice(0, 12),
    topPositionMatches: allMatches.slice(0, 24),
    summary,
  };
}
