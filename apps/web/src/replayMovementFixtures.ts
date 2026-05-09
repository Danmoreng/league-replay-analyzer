export interface ReplayMovementValidationResult {
  overlap: number;
  xCorrelation: number;
  yCorrelation: number;
  averageAxisCorrelation: number;
  pathCorrelation: number;
  distanceRmse: number;
  normalizedDistanceRmse: number;
  passes: boolean;
}

export interface ReplayMovementValidationAssignment {
  rosterIndex: number;
  matchedParticipantId?: number;
  status?: string;
  validation?: ReplayMovementValidationResult;
}

export interface ReplayMovementValidationReport {
  summary?: {
    assignmentCount?: number;
    matchedAssignmentCount?: number;
    passingAssignmentCount?: number;
    averageAxisCorrelation?: number;
    averagePathCorrelation?: number;
    averageNormalizedDistanceRmse?: number;
  };
  assignments?: ReplayMovementValidationAssignment[];
}

export interface ReplayMovementAssignment {
  rosterIndex: number;
  champion: string;
  team: number;
  teamPosition?: string;
  score?: number;
  trajectory: Array<{
    timestamp: number;
    x: number;
    y: number;
  }>;
}

export interface ReplayMovementFixture {
  replayId: string;
  assignments: ReplayMovementAssignment[];
}

export interface LoadedReplayMovementFixture {
  movement: ReplayMovementFixture;
  validation: ReplayMovementValidationReport | null;
}

export async function loadReplayMovementFixture(matchId: string): Promise<LoadedReplayMovementFixture | null> {
  const base = `/replay-movement-fixtures/${encodeURIComponent(matchId)}`;
  const movementResponse = await fetch(`${base}/participant-movement.json`);
  if (!movementResponse.ok) {
    if (movementResponse.status === 404) {
      return null;
    }
    throw new Error(`Failed to load replay movement fixture for ${matchId}.`);
  }

  const movement = (await movementResponse.json()) as ReplayMovementFixture;

  let validation: ReplayMovementValidationReport | null = null;
  const validationResponse = await fetch(`${base}/assigned-movement-validation-report.json`);
  if (validationResponse.ok) {
    validation = (await validationResponse.json()) as ReplayMovementValidationReport;
  }

  return {
    movement,
    validation,
  };
}
