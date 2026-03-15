export interface PlayerSummary {
  champion: string;
  riotIdGameName: string;
  riotIdTagLine: string;
  teamPosition: string;
  win: string;
  team: number;
  kills: number;
  deaths: number;
  assists: number;
  goldEarned: number;
  totalDamageToChampions: number;
  visionScore: number;
}

export interface ReplaySummary {
  gameVersion: string;
  fileSize: number;
  gameLengthMillis: number;
  lastGameChunkId: number;
  lastKeyFrameId: number;
  playerCount: number;
  players: PlayerSummary[];
  metadataJson: string;
}

const metadataMarker = new TextEncoder().encode('{"gameLength":');

function findSubsequence(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) {
        continue outer;
      }
    }
    return offset;
  }

  return -1;
}

function scanGameVersion(bytes: Uint8Array): string {
  const limit = Math.min(bytes.length, 256);
  let ascii = "";
  for (let index = 0; index < limit; index += 1) {
    const value = bytes[index];
    ascii += value >= 32 && value <= 126 ? String.fromCharCode(value) : " ";
  }

  const match = ascii.match(/\d+\.\d+\.\d+\.\d+/);
  return match?.[0] ?? "unknown";
}

function extractBalancedJson(bytes: Uint8Array, startOffset: number): string {
  let inString = false;
  let escape = false;
  let depth = 0;

  for (let offset = startOffset; offset < bytes.length; offset += 1) {
    const ch = String.fromCharCode(bytes[offset]);

    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth += 1;
      continue;
    }

    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return new TextDecoder().decode(bytes.slice(startOffset, offset + 1));
      }
    }
  }

  throw new Error("Could not extract embedded metadata JSON from replay.");
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return Number.parseInt(value, 10) || 0;
  }
  return 0;
}

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function normalizePlayer(raw: Record<string, unknown>): PlayerSummary {
  return {
    champion: toText(raw.SKIN),
    riotIdGameName: toText(raw.RIOT_ID_GAME_NAME),
    riotIdTagLine: toText(raw.RIOT_ID_TAG_LINE),
    teamPosition: toText(raw.TEAM_POSITION),
    win: toText(raw.WIN),
    team: toNumber(raw.TEAM),
    kills: toNumber(raw.CHAMPIONS_KILLED),
    deaths: toNumber(raw.NUM_DEATHS),
    assists: toNumber(raw.ASSISTS),
    goldEarned: toNumber(raw.GOLD_EARNED),
    totalDamageToChampions: toNumber(raw.TOTAL_DAMAGE_DEALT_TO_CHAMPIONS),
    visionScore: toNumber(raw.VISION_SCORE),
  };
}

export function parseReplayBuffer(buffer: ArrayBuffer): ReplaySummary {
  const bytes = new Uint8Array(buffer);
  const metadataOffset = findSubsequence(bytes, metadataMarker);
  if (metadataOffset === -1) {
    throw new Error("Could not locate embedded metadata JSON in replay.");
  }

  const metadataJson = extractBalancedJson(bytes, metadataOffset);
  const metadata = JSON.parse(metadataJson) as {
    gameLength?: number;
    lastGameChunkId?: number;
    lastKeyFrameId?: number;
    statsJson?: string;
  };

  const players = metadata.statsJson
    ? (JSON.parse(metadata.statsJson) as Record<string, unknown>[]).map(normalizePlayer)
    : [];

  return {
    gameVersion: scanGameVersion(bytes),
    fileSize: bytes.length,
    gameLengthMillis: metadata.gameLength ?? 0,
    lastGameChunkId: metadata.lastGameChunkId ?? 0,
    lastKeyFrameId: metadata.lastKeyFrameId ?? 0,
    playerCount: players.length,
    players,
    metadataJson,
  };
}
