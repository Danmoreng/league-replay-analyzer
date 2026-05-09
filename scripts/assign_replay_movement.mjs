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
// Keep assignment precision above raw coverage: weaker tracks stay unassigned.
const defaultMinimumAssignmentScore = 0.5;
const defaultDiagnosticAlternativeLimit = 64;

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    movementPath: null,
    statsPath: null,
    priorsPath: null,
    outputPath: null,
    minimumAssignmentScore: defaultMinimumAssignmentScore,
    useSupportHypotheses: true,
    preferTopEntityOwner: false,
    allowDuplicateEntities: false,
    scoreProfile: "default",
    diagnosticAlternativeLimit: defaultDiagnosticAlternativeLimit,
    keepAliasEntities: false,
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
    } else if (arg === "--min-assignment-score" && index + 1 < argv.length) {
      args.minimumAssignmentScore = Number(argv[++index]);
    } else if (arg === "--ignore-support-hypotheses") {
      args.useSupportHypotheses = false;
    } else if (arg === "--prefer-top-entity-owner") {
      args.preferTopEntityOwner = true;
    } else if (arg === "--allow-duplicate-entities") {
      args.allowDuplicateEntities = true;
    } else if (arg === "--keep-alias-entities") {
      args.keepAliasEntities = true;
    } else if (arg === "--score-profile" && index + 1 < argv.length) {
      args.scoreProfile = argv[++index];
    } else if (arg === "--diagnostic-alternative-limit" && index + 1 < argv.length) {
      args.diagnosticAlternativeLimit = Number.parseInt(argv[++index], 10);
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
  if (!Number.isFinite(args.minimumAssignmentScore) || args.minimumAssignmentScore < 0 || args.minimumAssignmentScore > 1) {
    throw new Error(`Invalid --min-assignment-score value: ${args.minimumAssignmentScore}`);
  }
  if (!["default", "reduced-role-anchor"].includes(args.scoreProfile)) {
    throw new Error(`Invalid --score-profile value: ${args.scoreProfile}`);
  }
  if (!Number.isInteger(args.diagnosticAlternativeLimit) || args.diagnosticAlternativeLimit < 1 || args.diagnosticAlternativeLimit > 2048) {
    throw new Error(`Invalid --diagnostic-alternative-limit value: ${args.diagnosticAlternativeLimit}`);
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/assign_replay_movement.mjs --artifact-dir <path> [--movement-path <path>] [--stats-path <path>] [--priors-path <path>] [--output-path <path>] [--min-assignment-score <0..1>] [--ignore-support-hypotheses] [--prefer-top-entity-owner] [--allow-duplicate-entities] [--keep-alias-entities] [--score-profile default|reduced-role-anchor] [--diagnostic-alternative-limit 64]");
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
    let labelScore = 0;
    if (participant.champion && hypothesis.champion && participant.champion === hypothesis.champion) {
      labelScore += 4;
    }
    if (participant.team != null && hypothesis.teamId != null && Number(participant.team) === Number(hypothesis.teamId)) {
      labelScore += 2;
    }
    if (participant.teamPosition && hypothesis.teamPosition && participant.teamPosition === hypothesis.teamPosition) {
      labelScore += 2;
    }

    const normalizedDistanceRmse = Number.isFinite(hypothesis.normalizedDistanceRmse)
      ? hypothesis.normalizedDistanceRmse
      : Number.POSITIVE_INFINITY;

    const candidate = {
      hypothesis,
      labelScore,
      passesValidation: Number(Boolean(hypothesis.passesValidation)),
      validatorScore: hypothesis.validatorScore ?? 0,
      effectiveScore: hypothesis.effectiveScore ?? 0,
      minAxisCorrelation: hypothesis.minAxisCorrelation ?? 0,
      pathCorrelation: hypothesis.pathCorrelation ?? 0,
      rangeRatio: hypothesis.rangeRatio ?? 0,
      normalizedDistanceRmse,
    };

    if (
      !best
      || candidate.labelScore > best.labelScore
      || (
        candidate.labelScore === best.labelScore
        && (
          candidate.passesValidation > best.passesValidation
          || (
            candidate.passesValidation === best.passesValidation
            && (
              candidate.validatorScore > best.validatorScore
              || (
                candidate.validatorScore === best.validatorScore
                && (
                  candidate.effectiveScore > best.effectiveScore
                  || (
                    candidate.effectiveScore === best.effectiveScore
                    && (
                      candidate.minAxisCorrelation > best.minAxisCorrelation
                      || (
                        candidate.minAxisCorrelation === best.minAxisCorrelation
                        && (
                          candidate.pathCorrelation > best.pathCorrelation
                          || (
                            candidate.pathCorrelation === best.pathCorrelation
                            && (
                              candidate.rangeRatio > best.rangeRatio
                              || (
                                candidate.rangeRatio === best.rangeRatio
                                && candidate.normalizedDistanceRmse < best.normalizedDistanceRmse
                              )
                            )
                          )
                        )
                      )
                    )
                  )
                )
              )
            )
          )
        )
      )
    ) {
      best = candidate;
    }
  }

  if (!best || best.labelScore < 6) {
    return null;
  }
  return best.hypothesis;
}

function resolveEntityProjection(entity, participant, useSupportHypotheses) {
  const exactHypothesis = useSupportHypotheses ? findSupportHypothesis(entity, participant) : null;
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

function supportHypothesisKey(hypothesis) {
  return [
    hypothesis?.participantId ?? "",
    hypothesis?.champion ?? "",
    hypothesis?.teamId ?? "",
    hypothesis?.teamPosition ?? "",
    hypothesis?.mapping ?? "",
  ].join("|");
}

function mergeSupportHypotheses(group) {
  const merged = new Map();
  for (const entity of group) {
    for (const hypothesis of entity.supportHypotheses ?? []) {
      const key = supportHypothesisKey(hypothesis);
      const existing = merged.get(key);
      if (
        !existing ||
        Number(hypothesis.passesValidation) > Number(existing.passesValidation) ||
        (Number(hypothesis.passesValidation) === Number(existing.passesValidation) &&
          (hypothesis.effectiveScore ?? 0) > (existing.effectiveScore ?? 0)) ||
        (
          Number(hypothesis.passesValidation) === Number(existing.passesValidation) &&
          (hypothesis.effectiveScore ?? 0) === (existing.effectiveScore ?? 0) &&
          (hypothesis.validatorScore ?? 0) > (existing.validatorScore ?? 0)
        )
      ) {
        merged.set(key, hypothesis);
      }
    }
  }

  return [...merged.values()].sort((left, right) =>
    Number(right.passesValidation) - Number(left.passesValidation) ||
    (right.effectiveScore ?? 0) - (left.effectiveScore ?? 0) ||
    (right.validatorScore ?? 0) - (left.validatorScore ?? 0) ||
    (left.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY) - (right.normalizedDistanceRmse ?? Number.POSITIVE_INFINITY)
  );
}

function canonicalizeEntities(entities, keepAliasEntities = false) {
  if (keepAliasEntities) {
    return {
      keptEntities: (entities ?? []).map((entity) => {
        const trajectoryStats = entity.trajectoryStats ?? computeTrajectoryStats(entity.trajectory ?? []);
        return {
          ...entity,
          trajectoryStats,
          entityQuality: computeEntityQuality({
            ...entity,
            trajectoryStats,
          }),
          aliasEntityKeys: [entity.entityKey],
          entityGroupKey: `${entity.familyKey}|${entity.slotIndex}`,
        };
      }),
      discardedAliases: [],
    };
  }

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
    const primary = {
      ...ranked[0],
      supportHypotheses: mergeSupportHypotheses(ranked),
    };
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

function scoreWeightsForProfile(scoreProfile) {
  if (scoreProfile === "reduced-role-anchor") {
    return {
      teamScore: 0.18,
      roleScore: 0.08,
      scalarFamilyScore: 0.1,
      centerBias: 0.08,
      trajectoryScore: 0.16,
      minAxisScore: 0.14,
      rangeScore: 0.12,
      directSupportScore: 0.1,
      directValidatorScore: 0.05,
      exactPriorScore: 0.1,
      familyPriorScore: 0.05,
    };
  }
  return {
    teamScore: 0.14,
    roleScore: 0.18,
    scalarFamilyScore: 0.1,
    centerBias: 0.08,
    trajectoryScore: 0.12,
    minAxisScore: 0.12,
    rangeScore: 0.11,
    directSupportScore: 0.1,
    directValidatorScore: 0.05,
    exactPriorScore: 0.1,
    familyPriorScore: 0.05,
  };
}

function scoreEntityForParticipant(entity, participant, scalarSlotsByFamily, priors, versionGroup, useSupportHypotheses, scoreProfile) {
  const projection = resolveEntityProjection(entity, participant, useSupportHypotheses);
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
  const sourcePathCorrelation = clamp(sourceMetrics?.avgPathCorrelation ?? 0, -1, 1);
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

  const weights = scoreWeightsForProfile(scoreProfile);
  const rawScore =
    (weights.teamScore * teamScore) +
    (weights.roleScore * roleScore) +
    (weights.scalarFamilyScore * scalarFamilyScore) +
    (weights.centerBias * centerBias) +
    (weights.trajectoryScore * trajectoryScore) +
    (weights.minAxisScore * minAxisScore) +
    (weights.rangeScore * rangeScore) +
    (weights.directSupportScore * directSupportScore) +
    (weights.directValidatorScore * directValidatorScore) +
    (weights.exactPriorScore * exactPriorScore) +
    (weights.familyPriorScore * familyPriorScore);

  let evidenceGate = 1;
  if (entityQuality < 0.55) {
    evidenceGate *= clamp(entityQuality / 0.55, 0, 1);
  }
  if (minAxisScore < 0.25) {
    evidenceGate *= clamp(minAxisScore / 0.25, 0, 1);
  }
  if (rangeScore < 0.4) {
    evidenceGate *= clamp(rangeScore / 0.4, 0, 1);
  }
  if (sourcePathCorrelation < 0) {
    evidenceGate *= 0.2;
  } else if (sourcePathCorrelation < 0.1) {
    evidenceGate *= clamp(sourcePathCorrelation / 0.1, 0.35, 1);
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
      sourcePathCorrelation,
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
      scoreProfile,
    },
    resolved: projection,
  };
}

function buildTopEntityOwnerOffsets(scoreMatrix) {
  const entityCount = scoreMatrix[0]?.length ?? 0;
  const topOwnerOffsets = new Map();
  for (let entityOffset = 0; entityOffset < entityCount; entityOffset += 1) {
    let bestParticipantOffset = null;
    let bestScore = -Infinity;
    for (let participantOffset = 0; participantOffset < scoreMatrix.length; participantOffset += 1) {
      const score = scoreMatrix[participantOffset]?.[entityOffset]?.score;
      if (Number.isFinite(score) && score > bestScore) {
        bestParticipantOffset = participantOffset;
        bestScore = score;
      }
    }
    if (bestParticipantOffset != null) {
      topOwnerOffsets.set(entityOffset, bestParticipantOffset);
    }
  }
  return topOwnerOffsets;
}

function assignmentSolveScore(scoreEntry, participantOffset, entityOffset, topOwnerOffsets, preferTopEntityOwner) {
  if (!preferTopEntityOwner) {
    return scoreEntry.score;
  }
  const topOwnerOffset = topOwnerOffsets.get(entityOffset);
  const ownerMultiplier = topOwnerOffset === participantOffset ? 1.08 : 0.88;
  return scoreEntry.score * ownerMultiplier;
}

function solveAssignments(participants, entities, scoreMatrix, minimumAssignmentScore, preferTopEntityOwner) {
  const participantCount = participants.length;
  const entityCount = entities.length;
  if (participantCount === 0 || entityCount === 0) {
    return [];
  }

  const topOwnerOffsets = buildTopEntityOwnerOffsets(scoreMatrix);
  let states = new Map([[0, { score: 0, assignments: [] }]]);
  const fullMask = (1 << participantCount) - 1;

  for (let entityOffset = 0; entityOffset < entityCount; entityOffset += 1) {
    const nextStates = new Map(states);
    for (const [mask, state] of states.entries()) {
      if (mask === fullMask) {
        continue;
      }
      for (let participantOffset = 0; participantOffset < participantCount; participantOffset += 1) {
        const participantBit = 1 << participantOffset;
        if ((mask & participantBit) !== 0) {
          continue;
        }

        const scoreEntry = scoreMatrix[participantOffset]?.[entityOffset];
        if (!scoreEntry || scoreEntry.score < minimumAssignmentScore) {
          continue;
        }

        const nextMask = mask | participantBit;
        const score = state.score + assignmentSolveScore(scoreEntry, participantOffset, entityOffset, topOwnerOffsets, preferTopEntityOwner);
        const current = nextStates.get(nextMask);
        if (!current || score > current.score) {
          nextStates.set(nextMask, {
            score,
            assignments: [
              ...state.assignments,
              {
                participantOffset,
                entityOffset,
                scoreEntry,
              },
            ],
          });
        }
      }
    }
    states = nextStates;
  }

  return [...states.values()]
    .sort((left, right) =>
      right.score - left.score ||
      right.assignments.length - left.assignments.length
    )[0]?.assignments ?? [];
}

function solveDuplicateEntityAssignments(participants, entities, scoreMatrix, minimumAssignmentScore, preferTopEntityOwner) {
  const topOwnerOffsets = buildTopEntityOwnerOffsets(scoreMatrix);
  const assignments = [];
  for (let participantOffset = 0; participantOffset < participants.length; participantOffset += 1) {
    let best = null;
    for (let entityOffset = 0; entityOffset < entities.length; entityOffset += 1) {
      const scoreEntry = scoreMatrix[participantOffset]?.[entityOffset];
      if (!scoreEntry || scoreEntry.score < minimumAssignmentScore) {
        continue;
      }
      const solveScore = assignmentSolveScore(scoreEntry, participantOffset, entityOffset, topOwnerOffsets, preferTopEntityOwner);
      if (!best || solveScore > best.solveScore) {
        best = {
          participantOffset,
          entityOffset,
          scoreEntry,
          solveScore,
        };
      }
    }
    if (best) {
      assignments.push(best);
    }
  }
  return assignments;
}

function summarizeParticipantCandidateScores(participantOffset, participants, entities, scoreMatrix, assignedEntityKeys, minimumAssignmentScore, diagnosticAlternativeLimit) {
  const participant = participants[participantOffset];
  return (scoreMatrix[participantOffset] ?? [])
    .map((scoreEntry, entityOffset) => {
      const entity = entities[entityOffset];
      return {
        entityKey: entity.entityKey,
        entityGroupKey: entity.entityGroupKey,
        familyKey: entity.familyKey,
        patternKey: entity.patternKey ?? null,
        slotIndex: entity.slotIndex,
        score: scoreEntry?.score ?? null,
        belowMinimumAssignmentScore: (scoreEntry?.score ?? 0) < minimumAssignmentScore,
        assignedToOtherParticipant: assignedEntityKeys.has(entity.entityKey),
        entityQuality: entity.entityQuality ?? null,
        scoreComponents: scoreEntry?.components ?? null,
        participant: {
          rosterIndex: participant.rosterIndex,
          champion: participant.champion,
          team: participant.team,
          teamPosition: participant.teamPosition,
        },
      };
    })
    .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity))
    .slice(0, diagnosticAlternativeLimit);
}

function summarizeEntityCandidateScores(entityOffset, participants, entities, scoreMatrix, assignedRoster, minimumAssignmentScore, diagnosticAlternativeLimit) {
  const entity = entities[entityOffset];
  return participants
    .map((participant, participantOffset) => {
      const scoreEntry = scoreMatrix[participantOffset]?.[entityOffset];
      return {
        rosterIndex: participant.rosterIndex,
        champion: participant.champion,
        team: participant.team,
        teamPosition: participant.teamPosition,
        score: scoreEntry?.score ?? null,
        belowMinimumAssignmentScore: (scoreEntry?.score ?? 0) < minimumAssignmentScore,
        participantAlreadyAssigned: assignedRoster.has(participant.rosterIndex),
        scoreComponents: scoreEntry?.components ?? null,
      };
    })
    .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity))
    .slice(0, diagnosticAlternativeLimit)
    .map((candidate) => ({
      ...candidate,
      entityKey: entity.entityKey,
      entityGroupKey: entity.entityGroupKey,
      familyKey: entity.familyKey,
      patternKey: entity.patternKey ?? null,
      slotIndex: entity.slotIndex,
    }));
}

function summarizeAssignmentConfidence(assignment, participants, entities, scoreMatrix, minimumAssignmentScore, diagnosticAlternativeLimit) {
  const participantAlternatives = (scoreMatrix[assignment.participantOffset] ?? [])
    .map((scoreEntry, entityOffset) => ({
      entityOffset,
      entityKey: entities[entityOffset]?.entityKey ?? null,
      entityGroupKey: entities[entityOffset]?.entityGroupKey ?? null,
      familyKey: entities[entityOffset]?.familyKey ?? null,
      slotIndex: entities[entityOffset]?.slotIndex ?? null,
      score: scoreEntry?.score ?? null,
      belowMinimumAssignmentScore: (scoreEntry?.score ?? 0) < minimumAssignmentScore,
      scoreComponents: scoreEntry?.components ?? null,
    }))
    .filter((candidate) => candidate.entityOffset !== assignment.entityOffset)
    .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity))
    .slice(0, diagnosticAlternativeLimit);

  const entityAlternatives = participants
    .map((participant, participantOffset) => {
      const scoreEntry = scoreMatrix[participantOffset]?.[assignment.entityOffset];
      return {
        participantOffset,
        rosterIndex: participant.rosterIndex,
        champion: participant.champion,
        team: participant.team,
        teamPosition: participant.teamPosition,
        score: scoreEntry?.score ?? null,
        belowMinimumAssignmentScore: (scoreEntry?.score ?? 0) < minimumAssignmentScore,
        scoreComponents: scoreEntry?.components ?? null,
      };
    })
    .filter((candidate) => candidate.participantOffset !== assignment.participantOffset)
    .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity))
  const ownerRanking = [
    {
      participantOffset: assignment.participantOffset,
      rosterIndex: participants[assignment.participantOffset]?.rosterIndex ?? null,
      champion: participants[assignment.participantOffset]?.champion ?? null,
      team: participants[assignment.participantOffset]?.team ?? null,
      teamPosition: participants[assignment.participantOffset]?.teamPosition ?? null,
      score: assignment.scoreEntry.score,
      scoreComponents: assignment.scoreEntry.components ?? null,
      assignedOwner: true,
      belowMinimumAssignmentScore: assignment.scoreEntry.score < minimumAssignmentScore,
    },
    ...entityAlternatives.map((candidate) => ({
      ...candidate,
      assignedOwner: false,
    })),
  ].sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity));
  const assignedOwnerRank = ownerRanking.findIndex((candidate) => candidate.assignedOwner) + 1;
  const entityAlternativesForOutput = entityAlternatives.slice(0, diagnosticAlternativeLimit);

  const bestEntityAlternativeScore = participantAlternatives[0]?.score ?? null;
  const bestParticipantAlternativeScore = entityAlternativesForOutput[0]?.score ?? null;
  return {
    assignedScore: assignment.scoreEntry.score,
    bestEntityAlternativeScore,
    bestParticipantAlternativeScore,
    assignedOwnerRank,
    assignedOwnerIsTopEntityParticipant: assignedOwnerRank === 1,
    entityScoreMargin: Number.isFinite(bestEntityAlternativeScore)
      ? assignment.scoreEntry.score - bestEntityAlternativeScore
      : null,
    participantScoreMargin: Number.isFinite(bestParticipantAlternativeScore)
      ? assignment.scoreEntry.score - bestParticipantAlternativeScore
      : null,
    topEntityAlternatives: participantAlternatives,
    topParticipantAlternatives: entityAlternativesForOutput,
  };
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

  const { keptEntities: entities, discardedAliases } = canonicalizeEntities(movement.entities ?? [], args.keepAliasEntities);
  const participantsWithScores = participants.map((participant) => ({
    ...participant,
    scalarSlotsByFamily: buildScalarIndex(participant),
  }));
  const scoreMatrix = participantsWithScores.map((participant) =>
    entities.map((entity) => scoreEntityForParticipant(entity, participant, participant.scalarSlotsByFamily, priors, versionGroup, args.useSupportHypotheses, args.scoreProfile)),
  );

  const assignments = args.allowDuplicateEntities
    ? solveDuplicateEntityAssignments(participantsWithScores, entities, scoreMatrix, args.minimumAssignmentScore, args.preferTopEntityOwner)
    : solveAssignments(participantsWithScores, entities, scoreMatrix, args.minimumAssignmentScore, args.preferTopEntityOwner);
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
        assignmentConfidence: summarizeAssignmentConfidence(
          assignment,
          participantsWithScores,
          entities,
          scoreMatrix,
          args.minimumAssignmentScore,
          args.diagnosticAlternativeLimit,
        ),
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
        topRejectedEntityCandidates: summarizeParticipantCandidateScores(
          participantsWithScores.indexOf(participant),
          participantsWithScores,
          entities,
          scoreMatrix,
          assignedEntityKeys,
          args.minimumAssignmentScore,
          args.diagnosticAlternativeLimit,
        ),
      })),
    unassignedEntities: entities
      .map((entity, entityOffset) => ({ entity, entityOffset }))
      .filter(({ entity }) => !assignedEntityKeys.has(entity.entityKey))
      .map(({ entity, entityOffset }) => ({
        entityKey: entity.entityKey,
        entityGroupKey: entity.entityGroupKey,
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        entityQuality: entity.entityQuality,
        topRejectedParticipantCandidates: summarizeEntityCandidateScores(
          entityOffset,
          participantsWithScores,
          entities,
          scoreMatrix,
          assignedRoster,
          args.minimumAssignmentScore,
          args.diagnosticAlternativeLimit,
        ),
      })),
    discardedAliases,
    normalization: {
      versionGroup,
      rawEntityCount: movement.entities?.length ?? 0,
      canonicalEntityCount: entities.length,
      discardedAliasCount: discardedAliases.length,
      minimumAssignmentScore: args.minimumAssignmentScore,
      useSupportHypotheses: args.useSupportHypotheses,
      preferTopEntityOwner: args.preferTopEntityOwner,
      allowDuplicateEntities: args.allowDuplicateEntities,
      keepAliasEntities: args.keepAliasEntities,
      scoreProfile: args.scoreProfile,
      diagnosticAlternativeLimit: args.diagnosticAlternativeLimit,
    },
  };

  writeJson(outputPath, participantMovement);
  console.log(`Wrote participant-labelled movement to ${outputPath}`);
  console.log(`Assigned ${participantMovement.assignments.length} movement tracks to participants.`);
}

main();
