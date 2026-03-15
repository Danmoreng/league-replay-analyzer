export interface RiotFixtureManifest {
  replayPath: string;
  replayName: string;
  platformId: string;
  regionalRoute: string;
  gameId: string;
  matchId: string;
  fetchedAt: string;
  files: {
    match: string;
    timeline: string;
    accounts: string | null;
  };
  endpoints: {
    match: string;
    timeline: string;
    accountByPuuid: string | null;
  };
}

export interface RiotMatchParticipant {
  participantId: number;
  puuid: string;
  riotIdGameName?: string;
  riotIdTagline?: string;
  championName: string;
  teamId: number;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  lane?: string;
  role?: string;
}

export interface RiotMatchData {
  metadata: {
    matchId: string;
    participants: string[];
  };
  info: {
    gameCreation: number;
    gameDuration: number;
    gameStartTimestamp: number;
    gameEndTimestamp: number;
    gameId: number;
    gameMode: string;
    gameVersion: string;
    mapId: number;
    queueId?: number;
    participants: RiotMatchParticipant[];
  };
}

export interface RiotTimelineEvent {
  timestamp: number;
  type: string;
  participantId?: number;
  killerId?: number;
  victimId?: number;
  itemId?: number;
  buildingType?: string;
  towerType?: string;
  monsterType?: string;
  monsterSubType?: string;
  killerTeamId?: number;
  assistingParticipantIds?: number[];
}

export interface RiotTimelineFrame {
  timestamp: number;
  events: RiotTimelineEvent[];
  participantFrames: Record<string, unknown>;
}

export interface RiotTimelineData {
  metadata: {
    matchId: string;
    participants: string[];
  };
  info: {
    endOfGameResult: string;
    frameInterval: number;
    frames: RiotTimelineFrame[];
    gameId: number;
    participants: Array<{ participantId: number; puuid: string }>;
  };
}

export interface RiotFixtureBundle {
  manifest: RiotFixtureManifest;
  match: RiotMatchData;
  timeline: RiotTimelineData;
}

export function deriveRiotMatchIdFromReplayName(replayName: string): string | null {
  const match = replayName.match(/^([A-Za-z0-9]+)-(\d+)\.rofl$/);
  if (!match) {
    return null;
  }

  return `${match[1].toUpperCase()}_${match[2]}`;
}

export async function loadRiotFixtureBundle(matchId: string): Promise<RiotFixtureBundle | null> {
  const base = `/riot-api-fixtures/${encodeURIComponent(matchId)}`;
  const manifestResponse = await fetch(`${base}/manifest.json`);
  if (!manifestResponse.ok) {
    if (manifestResponse.status === 404) {
      return null;
    }
    throw new Error(`Failed to load Riot fixture manifest for ${matchId}.`);
  }

  const manifest = (await manifestResponse.json()) as RiotFixtureManifest;
  const [match, timeline] = (await Promise.all([
    fetch(`${base}/match.json`),
    fetch(`${base}/timeline.json`),
  ]).then(async ([matchResponse, timelineResponse]) => {
    if (!matchResponse.ok) {
      throw new Error(`Failed to load match.json for ${matchId}.`);
    }
    if (!timelineResponse.ok) {
      throw new Error(`Failed to load timeline.json for ${matchId}.`);
    }
    return Promise.all([
      matchResponse.json() as Promise<RiotMatchData>,
      timelineResponse.json() as Promise<RiotTimelineData>,
    ]);
  })) as [RiotMatchData, RiotTimelineData];

  return {
    manifest,
    match,
    timeline,
  };
}
