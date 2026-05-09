import fs from "fs";
import path from "path";

import {
  buildPositionSeries,
  interpolate,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  summonersRiftBounds,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    participantMovementPath: null,
    fixtureDir: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--participant-movement-path" && index + 1 < argv.length) {
      args.participantMovementPath = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.participantMovementPath) {
    throw new Error("Missing required --participant-movement-path <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/validate_assigned_movement.mjs --participant-movement-path <path> [--fixture-dir <path>] [--output-path <path>]");
}

function findApiParticipant(assignment, apiParticipants) {
  let best = null;
  for (const apiParticipant of apiParticipants) {
    let score = 0;
    if (assignment.champion && apiParticipant.champion && assignment.champion === apiParticipant.champion) {
      score += 4;
    }
    if (assignment.team != null && apiParticipant.teamId != null && Number(assignment.team) === Number(apiParticipant.teamId)) {
      score += 2;
    }
    if (assignment.teamPosition && apiParticipant.teamPosition && assignment.teamPosition === apiParticipant.teamPosition) {
      score += 2;
    }

    if (!best || score > best.score) {
      best = { apiParticipant, score };
    }
  }
  return best;
}

function toValueSeries(points, key) {
  return (points ?? []).map((point) => ({
    timestamp: point.timestamp,
    value: point[key],
  }));
}

function stepDistances(points) {
  const distances = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    distances.push(Math.sqrt((dx * dx) + (dy * dy)));
  }
  return distances;
}

function comparePositionSeries(extractedSeries, targetSeries) {
  const extractedX = toValueSeries(extractedSeries, "x");
  const extractedY = toValueSeries(extractedSeries, "y");
  const alignedExtracted = [];
  const alignedTarget = [];

  const targetX = toValueSeries(targetSeries, "x");
  const targetY = toValueSeries(targetSeries, "y");
  for (const point of extractedSeries ?? []) {
    const targetPointX = interpolate(targetX, point.timestamp);
    const targetPointY = interpolate(targetY, point.timestamp);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(targetPointX) || !Number.isFinite(targetPointY)) {
      continue;
    }
    alignedExtracted.push({ timestamp: point.timestamp, x: point.x, y: point.y });
    alignedTarget.push({ timestamp: point.timestamp, x: targetPointX, y: targetPointY });
  }

  if (alignedExtracted.length < 4) {
    return {
      overlap: alignedExtracted.length,
      xCorrelation: 0,
      yCorrelation: 0,
      averageAxisCorrelation: 0,
      pathCorrelation: 0,
      distanceRmse: Number.POSITIVE_INFINITY,
      normalizedDistanceRmse: Number.POSITIVE_INFINITY,
      passes: false,
    };
  }

  const extractedXValues = alignedExtracted.map((point) => point.x);
  const extractedYValues = alignedExtracted.map((point) => point.y);
  const targetXValues = alignedTarget.map((point) => point.x);
  const targetYValues = alignedTarget.map((point) => point.y);

  let squaredDistanceError = 0;
  for (let index = 0; index < alignedExtracted.length; index += 1) {
    const dx = alignedExtracted[index].x - alignedTarget[index].x;
    const dy = alignedExtracted[index].y - alignedTarget[index].y;
    squaredDistanceError += (dx * dx) + (dy * dy);
  }

  const xCorrelation = pearsonCorrelation(extractedXValues, targetXValues);
  const yCorrelation = pearsonCorrelation(extractedYValues, targetYValues);
  const averageAxisCorrelation = (xCorrelation + yCorrelation) / 2;
  const extractedStepDistances = stepDistances(alignedExtracted);
  const targetStepDistances = stepDistances(alignedTarget);
  const pathCorrelation = pearsonCorrelation(extractedStepDistances, targetStepDistances);
  const distanceRmse = Math.sqrt(squaredDistanceError / alignedExtracted.length);
  const normalizedDistanceRmse = distanceRmse / summonersRiftBounds.diagonal;
  const passes =
    alignedExtracted.length >= 4 &&
    averageAxisCorrelation >= 0.55 &&
    normalizedDistanceRmse <= 0.18 &&
    pathCorrelation >= 0.15;

  return {
    overlap: alignedExtracted.length,
    xCorrelation,
    yCorrelation,
    averageAxisCorrelation,
    pathCorrelation,
    distanceRmse,
    normalizedDistanceRmse,
    passes,
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const participantMovementPath = resolveAbsolute(repoRoot, args.participantMovementPath);
  const participantMovement = readJson(participantMovementPath);
  const replayId = participantMovement.replayId;
  const fixtureDir = args.fixtureDir
    ? resolveAbsolute(repoRoot, args.fixtureDir)
    : path.join(repoRoot, "replays", "api", replayId.replace(/-/g, "_"));
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(path.dirname(participantMovementPath), "assigned-movement-validation-report.json");

  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
    throw new Error(`Fixture bundle not found under ${fixtureDir}`);
  }

  const matchJson = readJson(matchPath);
  const timelineJson = readJson(timelinePath);
  const { participants: apiParticipants, positionSeriesByParticipant } = buildPositionSeries(matchJson, timelineJson);

  const assignments = [];
  for (const assignment of participantMovement.assignments ?? []) {
    const apiMatch = findApiParticipant(assignment, apiParticipants);
    if (!apiMatch?.apiParticipant || apiMatch.score < 6) {
      assignments.push({
        rosterIndex: assignment.rosterIndex,
        champion: assignment.champion,
        team: assignment.team,
        teamPosition: assignment.teamPosition,
        entityKey: assignment.entityKey,
        status: "unmatched",
      });
      continue;
    }

    const targetSeries = positionSeriesByParticipant.get(apiMatch.apiParticipant.participantId) ?? [];
    const comparison = comparePositionSeries(assignment.trajectory ?? [], targetSeries);
    assignments.push({
      rosterIndex: assignment.rosterIndex,
      champion: assignment.champion,
      team: assignment.team,
      teamPosition: assignment.teamPosition,
      entityKey: assignment.entityKey,
      entityGroupKey: assignment.entityGroupKey ?? null,
      matchedParticipantId: apiMatch.apiParticipant.participantId,
      score: assignment.score,
      entityQuality: assignment.entityQuality ?? null,
      status: "matched",
      validation: comparison,
    });
  }

  const matchedAssignments = assignments.filter((assignment) => assignment.status === "matched");
  const summary = {
    assignmentCount: assignments.length,
    matchedAssignmentCount: matchedAssignments.length,
    passingAssignmentCount: matchedAssignments.filter((assignment) => assignment.validation.passes).length,
    averageAxisCorrelation: matchedAssignments.reduce((sum, assignment) => sum + assignment.validation.averageAxisCorrelation, 0) / Math.max(matchedAssignments.length, 1),
    averagePathCorrelation: matchedAssignments.reduce((sum, assignment) => sum + assignment.validation.pathCorrelation, 0) / Math.max(matchedAssignments.length, 1),
    averageNormalizedDistanceRmse: matchedAssignments.reduce((sum, assignment) => sum + assignment.validation.normalizedDistanceRmse, 0) / Math.max(matchedAssignments.length, 1),
  };

  const report = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    participantMovementPath,
    fixtureDir,
    summary,
    assignments,
  };

  writeJson(outputPath, report);
  console.log(`Wrote assigned movement validation report to ${outputPath}`);
}

main();
