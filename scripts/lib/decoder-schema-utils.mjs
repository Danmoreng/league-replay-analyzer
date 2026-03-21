import fs from "fs";
import path from "path";

export const metricDefinitions = [
  {
    key: "level",
    label: "Level",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 0.9,
    minOverlap: 6,
    summaryStatKeys: ["LEVEL"],
    readFrame: (frame) => frame.level ?? null,
  },
  {
    key: "currentGold",
    label: "Current Gold",
    monotonic: false,
    minCorrelation: 0.4,
    maxNormalizedRmse: 1.1,
    minOverlap: 6,
    summaryStatKeys: ["CURRENT_GOLD"],
    readFrame: (frame) => frame.currentGold ?? null,
  },
  {
    key: "totalGold",
    label: "Total Gold",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 1.0,
    minOverlap: 6,
    summaryStatKeys: ["GOLD_EARNED", "TOTAL_GOLD"],
    readFrame: (frame) => frame.totalGold ?? null,
  },
  {
    key: "xp",
    label: "XP",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 1.0,
    minOverlap: 6,
    summaryStatKeys: ["EXP"],
    readFrame: (frame) => frame.xp ?? null,
  },
  {
    key: "minionsKilled",
    label: "CS",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 1.0,
    minOverlap: 6,
    summaryStatKeys: ["MINIONS_KILLED", "CREEP_SCORE"],
    readFrame: (frame) => frame.minionsKilled ?? null,
  },
  {
    key: "jungleMinionsKilled",
    label: "Jungle CS",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 1.0,
    minOverlap: 6,
    summaryStatKeys: [
      "NEUTRAL_MINIONS_KILLED",
      "NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE",
      "NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE",
    ],
    readFrame: (frame) => frame.jungleMinionsKilled ?? null,
  },
  {
    key: "health",
    label: "Health",
    monotonic: false,
    minCorrelation: 0.4,
    maxNormalizedRmse: 1.1,
    minOverlap: 6,
    summaryStatKeys: ["CURRENT_HEALTH", "HEALTH"],
    readFrame: (frame) => frame.championStats?.health ?? null,
  },
  {
    key: "healthMax",
    label: "Max Health",
    monotonic: true,
    minCorrelation: 0.45,
    maxNormalizedRmse: 1.0,
    minOverlap: 6,
    summaryStatKeys: ["MAX_HEALTH", "HEALTH_MAX"],
    readFrame: (frame) => frame.championStats?.healthMax ?? null,
  },
  {
    key: "power",
    label: "Power",
    monotonic: false,
    minCorrelation: 0.35,
    maxNormalizedRmse: 1.15,
    minOverlap: 6,
    summaryStatKeys: ["CURRENT_MANA", "CURRENT_POWER", "MANA"],
    readFrame: (frame) => frame.championStats?.power ?? null,
  },
  {
    key: "powerMax",
    label: "Max Power",
    monotonic: true,
    minCorrelation: 0.4,
    maxNormalizedRmse: 1.05,
    minOverlap: 6,
    summaryStatKeys: ["MAX_MANA", "POWER_MAX", "MAX_POWER"],
    readFrame: (frame) => frame.championStats?.powerMax ?? null,
  },
  {
    key: "movementSpeed",
    label: "Move Speed",
    monotonic: false,
    minCorrelation: 0.35,
    maxNormalizedRmse: 1.2,
    minOverlap: 6,
    summaryStatKeys: ["MOVE_SPEED", "MOVEMENT_SPEED"],
    readFrame: (frame) => frame.championStats?.movementSpeed ?? null,
  },
];

export const metricDefinitionByKey = new Map(metricDefinitions.map((metric) => [metric.key, metric]));
export const summonersRiftBounds = {
  minX: 0,
  maxX: 16000,
  minY: 0,
  maxY: 16000,
  diagonal: Math.sqrt((16000 * 16000) + (16000 * 16000)),
};

export function resolveAbsolute(root, targetPath) {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(root, targetPath);
}

export function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return JSON.parse(text);
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function safeNumber(value) {
  const parsed = typeof value === "number" ? value : Number.parseFloat(`${value ?? ""}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function average(values) {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function median(values) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if ((sorted.length % 2) === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

export function mode(values) {
  if (!values.length) {
    return null;
  }
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || `${left[0]}`.localeCompare(`${right[0]}`))[0][0];
}

export function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }
  const mean = average(values);
  const variance = average(values.map((value) => {
    const delta = value - mean;
    return delta * delta;
  }));
  return Math.sqrt(variance);
}

export function pearsonCorrelation(left, right) {
  const length = Math.min(left.length, right.length);
  if (length < 3) {
    return 0;
  }

  let sumLeft = 0;
  let sumRight = 0;
  for (let index = 0; index < length; index += 1) {
    sumLeft += left[index];
    sumRight += right[index];
  }

  const meanLeft = sumLeft / length;
  const meanRight = sumRight / length;

  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < length; index += 1) {
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

export function fitAffine1D(rawValues, targetValues) {
  const length = Math.min(rawValues.length, targetValues.length);
  if (length < 3) {
    return { valid: false, slope: 0, intercept: 0, rmse: Number.POSITIVE_INFINITY };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let index = 0; index < length; index += 1) {
    const x = rawValues[index];
    const y = targetValues[index];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }

  const denominator = (length * sumXX) - (sumX * sumX);
  if (Math.abs(denominator) < 1e-9) {
    const intercept = sumY / length;
    let squaredError = 0;
    for (let index = 0; index < length; index += 1) {
      const error = intercept - targetValues[index];
      squaredError += error * error;
    }
    return {
      valid: false,
      slope: 0,
      intercept,
      rmse: Math.sqrt(squaredError / length),
    };
  }

  const slope = ((length * sumXY) - (sumX * sumY)) / denominator;
  const intercept = (sumY - (slope * sumX)) / length;

  let squaredError = 0;
  for (let index = 0; index < length; index += 1) {
    const predicted = (slope * rawValues[index]) + intercept;
    const error = predicted - targetValues[index];
    squaredError += error * error;
  }

  return {
    valid: true,
    slope,
    intercept,
    rmse: Math.sqrt(squaredError / length),
  };
}

export function interpolate(points, timestamp) {
  if (!points.length) {
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

export function normalizeTeamPosition(value) {
  const normalized = `${value ?? ""}`.trim().toUpperCase();
  switch (normalized) {
    case "UTILITY":
    case "SUPPORT":
      return "UTILITY";
    case "BOTTOM":
    case "BOT":
    case "ADC":
      return "BOTTOM";
    case "MID":
    case "MIDDLE":
      return "MIDDLE";
    case "JG":
    case "JUNGLE":
      return "JUNGLE";
    case "TOP":
      return "TOP";
    default:
      return normalized || "UNKNOWN";
  }
}

export function parseVersionGroup(gameVersion) {
  const parts = `${gameVersion ?? ""}`.split(".");
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return `${parts[0]}.${parts[1]}`;
  }
  return gameVersion ?? "unknown";
}

function parseSummaryMetadata(summaryJson) {
  if (!summaryJson?.metadataJson) {
    return { metadata: null, statsJson: [] };
  }

  const metadata = typeof summaryJson.metadataJson === "string"
    ? JSON.parse(summaryJson.metadataJson)
    : summaryJson.metadataJson;
  const statsJson = typeof metadata?.statsJson === "string"
    ? JSON.parse(metadata.statsJson)
    : (metadata?.statsJson ?? []);

  return { metadata, statsJson };
}

function readRosterMetricFromStats(statMap, metricKey) {
  const metric = metricDefinitionByKey.get(metricKey);
  if (!metric) {
    return null;
  }

  if (metricKey === "minionsKilled") {
    const laneCs = safeNumber(statMap.MINIONS_KILLED) ?? safeNumber(statMap.CREEP_SCORE) ?? 0;
    return laneCs;
  }

  if (metricKey === "jungleMinionsKilled") {
    const direct = safeNumber(statMap.NEUTRAL_MINIONS_KILLED);
    if (direct != null) {
      return direct;
    }
    const own = safeNumber(statMap.NEUTRAL_MINIONS_KILLED_YOUR_JUNGLE) ?? 0;
    const enemy = safeNumber(statMap.NEUTRAL_MINIONS_KILLED_ENEMY_JUNGLE) ?? 0;
    return own + enemy;
  }

  for (const key of metric.summaryStatKeys ?? []) {
    const value = safeNumber(statMap[key]);
    if (value != null) {
      return value;
    }
  }

  return null;
}

export function buildSummaryRoster(summaryJson) {
  const { statsJson } = parseSummaryMetadata(summaryJson);
  const players = Array.isArray(summaryJson?.players) ? summaryJson.players : [];

  return players.map((player, index) => {
    const statMap = statsJson[index] ?? {};
    const team = safeNumber(statMap.TEAM) ?? safeNumber(player.team) ?? null;
    const teamPosition = normalizeTeamPosition(statMap.TEAM_POSITION ?? player.teamPosition);
    const champion = statMap.SKIN ?? player.champion ?? null;
    const finalMetrics = {};
    for (const metric of metricDefinitions) {
      finalMetrics[metric.key] = readRosterMetricFromStats(statMap, metric.key);
    }

    return {
      rosterIndex: index,
      champion,
      team,
      teamPosition,
      riotIdGameName: statMap.RIOT_ID_GAME_NAME ?? player.riotIdGameName ?? null,
      riotIdTagLine: statMap.RIOT_ID_TAG_LINE ?? player.riotIdTagLine ?? null,
      finalMetrics,
      statMap,
      summaryPlayer: player,
    };
  });
}

export function buildMetricSeries(matchJson, timelineJson, requestedMetricKeys = null) {
  const allowed = requestedMetricKeys ? new Set(requestedMetricKeys) : null;
  const metrics = allowed
    ? metricDefinitions.filter((metric) => allowed.has(metric.key))
    : metricDefinitions;

  const participants = matchJson.info.participants.map((participant) => ({
    participantId: participant.participantId,
    champion: participant.championName,
    teamId: participant.teamId,
    teamPosition: normalizeTeamPosition(participant.teamPosition ?? participant.individualPosition),
  }));

  const metricSeriesByParticipant = new Map();
  for (const participant of participants) {
    metricSeriesByParticipant.set(participant.participantId, new Map());
  }

  for (const frame of timelineJson.info.frames) {
    const participantFrames = frame.participantFrames ?? {};
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      const participantId = Number.parseInt(rawParticipantId, 10);
      const targetMap = metricSeriesByParticipant.get(participantId);
      if (!targetMap) {
        continue;
      }
      for (const metric of metrics) {
        const value = metric.readFrame(participantFrame);
        if (value == null || !Number.isFinite(value)) {
          continue;
        }
        const list = targetMap.get(metric.key) ?? [];
        list.push({ timestamp: frame.timestamp, value });
        targetMap.set(metric.key, list);
      }
    }
  }

  return {
    participants,
    participantById: new Map(participants.map((participant) => [participant.participantId, participant])),
    metricSeriesByParticipant,
  };
}

export function buildPositionSeries(matchJson, timelineJson) {
  const participants = matchJson.info.participants.map((participant) => ({
    participantId: participant.participantId,
    champion: participant.championName,
    teamId: participant.teamId,
    teamPosition: normalizeTeamPosition(participant.teamPosition ?? participant.individualPosition),
  }));

  const positionSeriesByParticipant = new Map();
  for (const participant of participants) {
    positionSeriesByParticipant.set(participant.participantId, []);
  }

  for (const frame of timelineJson.info.frames ?? []) {
    const participantFrames = frame.participantFrames ?? {};
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      const participantId = Number.parseInt(rawParticipantId, 10);
      const position = participantFrame.position;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
        continue;
      }

      const list = positionSeriesByParticipant.get(participantId);
      if (!list) {
        continue;
      }

      list.push({
        timestamp: frame.timestamp,
        x: position.x,
        y: position.y,
        movementSpeed: safeNumber(participantFrame.championStats?.movementSpeed),
      });
    }
  }

  return {
    participants,
    participantById: new Map(participants.map((participant) => [participant.participantId, participant])),
    positionSeriesByParticipant,
  };
}

export function findBestRosterMatch(apiParticipant, roster) {
  let best = null;
  for (const entry of roster) {
    let score = 0;
    if (entry.champion && apiParticipant.champion && entry.champion === apiParticipant.champion) {
      score += 4;
    }
    if (entry.team != null && apiParticipant.teamId != null && Number(entry.team) === Number(apiParticipant.teamId)) {
      score += 2;
    }
    if (entry.teamPosition && apiParticipant.teamPosition && entry.teamPosition === apiParticipant.teamPosition) {
      score += 2;
    }

    if (!best || score > best.score) {
      best = { rosterEntry: entry, score };
    }
  }
  return best;
}

export function buildFieldIndex(cleanedJson) {
  const fieldIndex = new Map();
  for (const slot of cleanedJson?.slots ?? []) {
    for (const field of slot.fields ?? []) {
      const key = `${slot.slotIndex}|${field.offset}|${field.decodeLabel}`;
      fieldIndex.set(key, {
        slotIndex: slot.slotIndex,
        offset: field.offset,
        decodeLabel: field.decodeLabel,
        field,
      });
    }
  }
  return fieldIndex;
}

export function fieldSamplesToSeries(field, transform = null) {
  const slope = transform?.slope ?? 1;
  const intercept = transform?.intercept ?? 0;
  return (field?.samples ?? [])
    .filter((sample) => Number.isFinite(sample.decoded) && Number.isFinite(sample.timestamp))
    .map((sample) => ({
      timestamp: sample.timestamp,
      rawValue: sample.decoded,
      value: (slope * sample.decoded) + intercept,
    }));
}

export function lastFiniteValue(points) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    if (Number.isFinite(points[index].value)) {
      return points[index].value;
    }
  }
  return null;
}
