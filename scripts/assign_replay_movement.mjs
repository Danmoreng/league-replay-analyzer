import fs from "fs";
import path from "path";

import {
  buildSummaryRoster,
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const blueFountain = { x: 600, y: 600 };
const redFountain = { x: 14400, y: 14400 };
const blueRoleAnchors = {
  TOP: { x: 2500, y: 11200 },
  JUNGLE: { x: 5600, y: 7600 },
  MIDDLE: { x: 7200, y: 7200 },
  BOTTOM: { x: 11200, y: 2500 },
  UTILITY: { x: 10500, y: 3200 },
  UNKNOWN: { x: 7200, y: 7200 },
};
const minimumAssignmentScore = 0.38;

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    movementPath: null,
    statsPath: null,
    priorsPath: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--movement-path" && index + 1 < argv.length) {
      args.movementPath = argv[++index];
    } else if (arg === "--stats-path" && index + 1 < argv.length) {
      args.statsPath = argv[++index];
    } else if (arg === "--priors-path" && index + 1 < argv.length) {
      args.priorsPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactDir) {
    throw new Error("Missing required --artifact-dir <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/assign_replay_movement.mjs --artifact-dir <path> [--movement-path <path>] [--stats-path <path>] [--priors-path <path>] [--output-path <path>]");
}

function mirroredAnchor(anchor) {
  return {
    x: 15000 - anchor.x,
    y: 15000 - anchor.y,
  };
}

function getRoleAnchor(team, teamPosition) {
  const normalized = blueRoleAnchors[teamPosition] ? teamPosition : "UNKNOWN";
  const blueAnchor = blueRoleAnchors[normalized];
  return Number(team) === 200 ? mirroredAnchor(blueAnchor) : blueAnchor;
}

function distance(left, right) {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return Math.sqrt((dx * dx) + (dy * dy));
}

function scoreDistance(value, scale) {
  return 1 / (1 + (value / scale));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildScalarIndex(participant) {
  const byFamily = new Map();
  for (const metric of Object.values(participant.metrics ?? {})) {
    const list = byFamily.get(metric.familyKey) ?? [];
    list.push(metric.slotIndex);
    byFamily.set(metric.familyKey, list);
  }
  return byFamily;
}

function applyTransformsToSamples(rawSamples, transformX, transformY) {
  return (rawSamples ?? []).map((sample) => ({
    timestamp: sample.timestamp,
    x: ((transformX?.slope ?? 1) * sample.rawX) + (transformX?.intercept ?? 0),
    y: ((transformY?.slope ?? 1) * sample.rawY) + (transformY?.intercept ?? 0),
  }));
}

function chooseEarlyPoint(trajectory) {
  if (!trajectory.length) {
    return null;
  }
  if (trajectory.length === 1) {
    return trajectory[0];
  }
  return trajectory[1];
}

function computeTrajectoryStats(trajectory) {
  if (!trajectory.length) {
    return {
      pointCount: 0,
      uniquePointRatio: 0,
      displacement: 0,
      pathLength: 0,
      xRange: 0,
      yRange: 0,
      movementQuality: 0,
    };
  }

  let minX = trajectory[0].x;
  let maxX = trajectory[0].x;
  let minY = trajectory[0].y;
  let maxY = trajectory[0].y;
  let pathLength = 0;
  const uniquePoints = new Set();
  for (let index = 0; index < trajectory.length; index += 1) {
    const point = trajectory[index];
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    uniquePoints.add(`${Math.round(point.x)}|${Math.round(point.y)}`);

    if (index === 0) {
      continue;
    }

    const previous = trajectory[index - 1];
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    pathLength += Math.sqrt((dx * dx) + (dy * dy));
  }

  const first = trajectory[0];
  const last = trajectory[trajectory.length - 1];
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const displacement = Math.sqrt((dx * dx) + (dy * dy));
  const uniquePointRatio = uniquePoints.size / trajectory.length;
  const xRange = maxX - minX;
  const yRange = maxY - minY;
  const movementQuality = clamp(
    (Math.min(1, (xRange + yRange) / 6000) * 0.45)
      + (Math.min(1, pathLength / 9000) * 0.35)
      + (uniquePointRatio * 0.2),
    0,
    1,
  );

  return {
    pointCount: trajectory.length,
    uniquePointRatio,
    displacement,
    pathLength,
    xRange,
    yRange,
    movementQuality,
  };
}

function computeEntityQuality(entity) {
  const sourceMetrics = entity.sourceMetrics ?? {};
  const trajectoryStats = entity.trajectoryStats ?? computeTrajectoryStats(entity.trajectory ?? []);
  const axisScore = clamp(sourceMetrics.avgAxisCorrelation ?? 0, 0, 1);
  const minAxisScore = clamp(sourceMetrics.avgMinAxisCorrelation ?? 0, 0, 1);
  const pathScore = clamp((sourceMetrics.avgPathCorrelation ?? 0), 0, 1);
  const validatorScore = clamp(sourceMetrics.avgValidatorScore ?? 0, 0, 1);
  const rmseScore = 1 - clamp(sourceMetrics.avgNormalizedDistanceRmse ?? 1, 0, 1);
  const rangeScore = clamp(sourceMetrics.avgRangeRatio ?? 0, 0, 1);
  const boundsScore = clamp(entity.boundsRatio ?? 0, 0, 1);

  return clamp(
    (validatorScore * 0.26)
    + (axisScore * 0.15)
    + (minAxisScore * 0.16)
    + (pathScore * 0.12)
    + (rmseScore * 0.15)
    + (rangeScore * 0.11)
    + (boundsScore * 0.1)
    + ((trajectoryStats.movementQuality ?? 0) * 0.1),
    0,
    1,
  );
}

function findSupportHypothesis(entity, participant) {
  let best = null;
  for (const hypothesis of entity.supportHypotheses ?? []) {
    let score = 0;
    if (participant.champion && hypothesis.champion && participant.champion === hypothesis.champion) {
      score += 4;
    }
    if (participant.team != null && hypothesis.teamId != null && Number(participant.team) === Number(hypothesis.teamId)) {
      score += 2;
    }
    if (participant.teamPosition && hypothesis.teamPosition && participant.teamPosition === hypothesis.teamPosition) {
      score += 2;
    }

    if (!best || score > best.score || (score === best.score && (hypothesis.effectiveScore ?? 0) > (best.hypothesis.effectiveScore ?? 0))) {
      best = { hypothesis, score };
    }
  }

  if (!best || best.score < 6) {
    return null;
  }
  return best.hypothesis;
}

function resolveEntityProjection(entity, participant) {
  const exactHypothesis = findSupportHypothesis(entity, participant);
  if (exactHypothesis) {
    return {
      trajectory: exactHypothesis.trajectory ?? entity.trajectory ?? [],
      trajectoryStats: exactHypothesis.trajectoryStats ?? computeTrajectoryStats(exactHypothesis.trajectory ?? []),
      sourceMetrics: {
        avgAxisCorrelation: ((exactHypothesis.xCorrelation ?? 0) + (exactHypothesis.yCorrelation ?? 0)) / 2,
        avgMinAxisCorrelation: exactHypothesis.minAxisCorrelation ?? 0,
        avgPathCorrelation: exactHypothesis.pathCorrelation ?? 0,
        avgNormalizedDistanceRmse: exactHypothesis.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY,
        avgRangeRatio: exactHypothesis.rangeRatio ?? 0,
        avgValidatorScore: exactHypothesis.validatorScore ?? 0,
        avgEffectiveScore: exactHypothesis.effectiveScore ?? 0,
      },
      directSupport: exactHypothesis,
    };
  }

  return {
    trajectory: entity.trajectory ?? [],
    trajectoryStats: entity.trajectoryStats ?? computeTrajectoryStats(entity.trajectory ?? []),
    sourceMetrics: entity.sourceMetrics ?? {},
    directSupport: null,
  };
}

function canonicalizeEntities(entities) {
  const groups = new Map();
  for (const entity of entities) {
    const trajectoryStats = entity.trajectoryStats ?? computeTrajectoryStats(entity.trajectory ?? []);
    const normalized = {
      ...entity,
      trajectoryStats,
      entityQuality: computeEntityQuality({
        ...entity,
        trajectoryStats,
      }),
    };
    const groupKey = `${normalized.familyKey}|${normalized.slotIndex}`;
    const list = groups.get(groupKey) ?? [];
    list.push(normalized);
    groups.set(groupKey, list);
  }

  const keptEntities = [];
  const discardedAliases = [];
  for (const [groupKey, group] of groups.entries()) {
    const ranked = [...group].sort((left, right) =>
      right.entityQuality - left.entityQuality
      || right.boundsRatio - left.boundsRatio
      || (right.sourceMetrics?.avgValidatorScore ?? 0) - (left.sourceMetrics?.avgValidatorScore ?? 0)
      || (right.trajectoryStats?.movementQuality ?? 0) - (left.trajectoryStats?.movementQuality ?? 0),
    );
    const primary = ranked[0];
    primary.aliasEntityKeys = ranked.map((entity) => entity.entityKey);
    primary.entityGroupKey = groupKey;
    keptEntities.push(primary);

    for (const alias of ranked.slice(1)) {
      discardedAliases.push({
        entityGroupKey: groupKey,
        keptEntityKey: primary.entityKey,
        discardedEntityKey: alias.entityKey,
        keptPatternKey: primary.patternKey ?? null,
        discardedPatternKey: alias.patternKey ?? null,
      });
    }
  }

  return {
    keptEntities,
    discardedAliases,
  };
}

function lookupPriorScore(priors, versionGroup, entity, participant) {
  if (!priors) {
    return { exactPriorScore: 0, familyPriorScore: 0 };
  }

  const labelKey = `${participant.team}|${participant.teamPosition}`;
  const exactKey = `${versionGroup}|${entity.familyKey}|${entity.slotIndex}`;
  const familyKey = `${versionGroup}|${entity.familyKey}`;
  const exactPrior = priors.exactSlotPriors?.[exactKey] ?? [];
  const familyPrior = priors.familyPriors?.[familyKey] ?? [];
  return {
    exactPriorScore: exactPrior.find((entry) => entry.labelKey === labelKey)?.normalizedScore ?? 0,
    familyPriorScore: familyPrior.find((entry) => entry.labelKey === labelKey)?.normalizedScore ?? 0,
  };
}

function scoreEntityForParticipant(entity, participant, scalarSlotsByFamily, priors, versionGroup) {
  const projection = resolveEntityProjection(entity, participant);
  const trajectory = projection.trajectory;
  if (!trajectory.length) {
    return {
      score: 0,
      components: {
        entityQuality: 0,
      },
      resolved: projection,
    };
  }

  const sourceMetrics = projection.sourceMetrics;
  const startPoint = trajectory[0];
  const earlyPoint = chooseEarlyPoint(trajectory);
  const fountainAnchor = Number(participant.team) === 200 ? redFountain : blueFountain;
  const oppositeFountain = Number(participant.team) === 200 ? blueFountain : redFountain;
  const roleAnchor = getRoleAnchor(participant.team, participant.teamPosition);
  const trajectoryStats = projection.trajectoryStats ?? computeTrajectoryStats(trajectory);
  const entityQuality = computeEntityQuality({
    ...entity,
    trajectory,
    trajectoryStats,
    sourceMetrics,
  });
  const minAxisScore = clamp(sourceMetrics?.avgMinAxisCorrelation ?? 0, 0, 1);
  const rangeScore = clamp(sourceMetrics?.avgRangeRatio ?? 0, 0, 1);
  const directSupportScore = clamp((projection.directSupport?.effectiveScore ?? 0) / 0.35, 0, 1);
  const directValidatorScore = clamp(projection.directSupport?.validatorScore ?? 0, 0, 1);
  const { exactPriorScore, familyPriorScore } = lookupPriorScore(priors, versionGroup, entity, participant);

  const sameTeamDistance = distance(startPoint, fountainAnchor);
  const oppositeTeamDistance = distance(startPoint, oppositeFountain);
  const teamScore = clamp(
    scoreDistance(sameTeamDistance, 4000) - (0.8 * scoreDistance(oppositeTeamDistance, 4000)),
    0,
    1,
  );
  const roleScore = earlyPoint ? scoreDistance(distance(earlyPoint, roleAnchor), 3500) : 0;

  let scalarFamilyScore = 0;
  const scalarSlots = scalarSlotsByFamily.get(entity.familyKey) ?? [];
  if (scalarSlots.length > 0) {
    const nearest = Math.min(...scalarSlots.map((slotIndex) => Math.abs(slotIndex - entity.slotIndex)));
    if (nearest === 0) {
      scalarFamilyScore = 1;
    } else if (nearest === 1) {
      scalarFamilyScore = 0.65;
    } else if (nearest <= 2) {
      scalarFamilyScore = 0.4;
    } else if (nearest <= 4) {
      scalarFamilyScore = 0.15;
    }
  }

  const center = { x: 7500, y: 7500 };
  const centerBias = earlyPoint ? scoreDistance(distance(earlyPoint, center), 8000) : 0.5;
  const trajectoryScore = clamp(
    (trajectoryStats.movementQuality ?? 0) * 0.75
    + (Math.min(1, (trajectoryStats.uniquePointRatio ?? 0)) * 0.25),
    0,
    1,
  );

  const rawScore =
    (0.14 * teamScore) +
    (0.18 * roleScore) +
    (0.1 * scalarFamilyScore) +
    (0.08 * centerBias) +
    (0.12 * trajectoryScore) +
    (0.12 * minAxisScore) +
    (0.11 * rangeScore) +
    (0.1 * directSupportScore) +
    (0.05 * directValidatorScore) +
    (0.1 * exactPriorScore) +
    (0.05 * familyPriorScore);

  let evidenceGate = 1;
  if (entityQuality < 0.55) {
    evidenceGate *= clamp(entityQuality / 0.55, 0, 1);
  }
  if (minAxisScore < 0.18) {
    evidenceGate *= clamp(minAxisScore / 0.18, 0, 1);
  }
  if (rangeScore < 0.3) {
    evidenceGate *= clamp(rangeScore / 0.3, 0, 1);
  }
  if ((trajectoryStats.movementQuality ?? 0) < 0.2) {
    evidenceGate *= clamp((trajectoryStats.movementQuality ?? 0) / 0.2, 0, 1);
  }

  const score = rawScore * (0.45 + (0.55 * entityQuality)) * evidenceGate;

  return {
    score,
    components: {
      entityQuality,
      minAxisScore,
      rangeScore,
      directSupportScore,
      directValidatorScore,
      evidenceGate,
      teamScore,
      roleScore,
      scalarFamilyScore,
      centerBias,
      trajectoryScore,
      exactPriorScore,
      familyPriorScore,
      sameTeamDistance,
      oppositeTeamDistance,
    },
    resolved: projection,
  };
}

function solveAssignments(participants, entities, scoreMatrix) {
  const participantCount = participants.length;
  const entityCount = entities.length;
  if (participantCount === 0 || entityCount === 0) {
    return [];
  }

  const memo = new Map();
  function search(participantOffset, usedMask) {
    if (participantOffset >= participantCount) {
      return { score: 0, assignments: [] };
    }

    const memoKey = `${participantOffset}|${usedMask}`;
    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }

    let best = search(participantOffset + 1, usedMask);
    for (let entityOffset = 0; entityOffset < entityCount; entityOffset += 1) {
      const bitMask = (1 << entityOffset);
      if ((usedMask & bitMask) !== 0) {
        continue;
      }

      const scoreEntry = scoreMatrix[participantOffset][entityOffset];
      if (!scoreEntry || scoreEntry.score < minimumAssignmentScore) {
        continue;
      }

      const suffix = search(participantOffset + 1, usedMask | bitMask);
      const score = scoreEntry.score + suffix.score;
      if (score > best.score) {
        best = {
          score,
          assignments: [
            {
              participantOffset,
              entityOffset,
              scoreEntry,
            },
            ...suffix.assignments,
          ],
        };
      }
    }

    memo.set(memoKey, best);
    return best;
  }

  return search(0, 0).assignments;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const movementPath = args.movementPath
    ? resolveAbsolute(repoRoot, args.movementPath)
    : path.join(artifactDir, "extracted-movement.json");
  const statsPath = args.statsPath
    ? resolveAbsolute(repoRoot, args.statsPath)
    : path.join(artifactDir, "extracted-stats.json");
  const priorsPath = args.priorsPath
    ? resolveAbsolute(repoRoot, args.priorsPath)
    : path.join(path.dirname(artifactDir), "movement-identity-priors.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "participant-movement.json");

  const summaryPath = path.join(artifactDir, "summary.json");
  if (!fs.existsSync(movementPath)) {
    throw new Error(`Extracted movement not found at ${movementPath}`);
  }
  if (!fs.existsSync(statsPath)) {
    throw new Error(`Extracted stats not found at ${statsPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Replay summary not found at ${summaryPath}`);
  }

  const movement = readJson(movementPath);
  const stats = readJson(statsPath);
  const summary = readJson(summaryPath);
  const priors = fs.existsSync(priorsPath) ? readJson(priorsPath) : null;
  const versionGroup = parseVersionGroup(summary.gameVersion);
  const roster = stats.roster?.length ? stats.roster : buildSummaryRoster(summary);
  const participants = roster.map((entry) => {
    const extractedParticipant = (stats.participants ?? []).find((participant) => participant.rosterIndex === entry.rosterIndex);
    return {
      ...entry,
      metrics: extractedParticipant?.metrics ?? {},
    };
  });

  const { keptEntities: entities, discardedAliases } = canonicalizeEntities(movement.entities ?? []);
  const participantsWithScores = participants.map((participant) => ({
    ...participant,
    scalarSlotsByFamily: buildScalarIndex(participant),
  }));
  const scoreMatrix = participantsWithScores.map((participant) =>
    entities.map((entity) => scoreEntityForParticipant(entity, participant, participant.scalarSlotsByFamily, priors, versionGroup)),
  );

  const assignments = solveAssignments(participantsWithScores, entities, scoreMatrix);
  const assignedEntityKeys = new Set(assignments.map((assignment) => entities[assignment.entityOffset].entityKey));
  const assignedRoster = new Set(assignments.map((assignment) => participantsWithScores[assignment.participantOffset].rosterIndex));

  const participantMovement = {
    replayId: movement.replayId,
    generatedAtUtc: new Date().toISOString(),
    movementPath,
    statsPath,
    priorsPath: fs.existsSync(priorsPath) ? priorsPath : null,
    assignments: assignments.map((assignment) => {
      const participant = participantsWithScores[assignment.participantOffset];
      const entity = entities[assignment.entityOffset];
      return {
        rosterIndex: participant.rosterIndex,
        champion: participant.champion,
        team: participant.team,
        teamPosition: participant.teamPosition,
        entityKey: entity.entityKey,
        entityGroupKey: entity.entityGroupKey,
        familyKey: entity.familyKey,
        patternKey: entity.patternKey ?? null,
        slotIndex: entity.slotIndex,
        score: assignment.scoreEntry.score,
        scoreComponents: assignment.scoreEntry.components,
        entityQuality: entity.entityQuality,
        sourceMetrics: assignment.scoreEntry.resolved?.sourceMetrics ?? entity.sourceMetrics ?? {},
        trajectoryStats: assignment.scoreEntry.resolved?.trajectoryStats ?? entity.trajectoryStats ?? computeTrajectoryStats(entity.trajectory ?? []),
        aliasEntityKeys: entity.aliasEntityKeys ?? [entity.entityKey],
        directSupport: assignment.scoreEntry.resolved?.directSupport ?? null,
        trajectory: assignment.scoreEntry.resolved?.trajectory ?? entity.trajectory,
      };
    }),
    unmatchedParticipants: participantsWithScores
      .filter((participant) => !assignedRoster.has(participant.rosterIndex))
      .map((participant) => ({
        rosterIndex: participant.rosterIndex,
        champion: participant.champion,
        team: participant.team,
        teamPosition: participant.teamPosition,
      })),
    unassignedEntities: entities
      .filter((entity) => !assignedEntityKeys.has(entity.entityKey))
      .map((entity) => ({
        entityKey: entity.entityKey,
        entityGroupKey: entity.entityGroupKey,
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        entityQuality: entity.entityQuality,
      })),
    discardedAliases,
    normalization: {
      versionGroup,
      rawEntityCount: movement.entities?.length ?? 0,
      canonicalEntityCount: entities.length,
      discardedAliasCount: discardedAliases.length,
      minimumAssignmentScore,
    },
  };

  writeJson(outputPath, participantMovement);
  console.log(`Wrote participant-labelled movement to ${outputPath}`);
  console.log(`Assigned ${participantMovement.assignments.length} movement tracks to participants.`);
}

main();
