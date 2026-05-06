import path from "path";

import {
  average,
  fitAffine1D,
  median,
  pearsonCorrelation,
  readJson,
  resolveAbsolute,
  standardDeviation,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    outputPath: null,
    includeUnstable: false,
    metrics: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--metrics" && index + 1 < argv.length) {
      args.metrics = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg === "--include-unstable") {
      args.includeUnstable = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/export_keyframe_state_prototype.mjs [--artifact-root <path>] [--api-root <path>] [--replay-id <id>] [--metrics currentGold,health] [--include-unstable] [--output-path <path>]");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  return separatorIndex < 0 ? replayId : `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function keyFor(parts) {
  return parts.join("|");
}

function readApiParticipants(apiRoot, replayId) {
  const manifestPath = path.join(apiRoot, normalizeFixtureReplayId(replayId), "manifest.json");
  const manifest = readJson(manifestPath);
  const match = readJson(path.join(path.dirname(manifestPath), manifest.matchFile ?? "match.json"));
  return new Map((match.info?.participants ?? []).map((participant) => [
    participant.participantId,
    {
      participantId: participant.participantId,
      champion: participant.championName,
      teamId: participant.teamId,
      teamPosition: participant.teamPosition,
      summonerName: participant.summonerName,
      riotIdGameName: participant.riotIdGameName,
      riotIdTagline: participant.riotIdTagline,
    },
  ]));
}

function readMetricValue(frame, metric) {
  if (!frame) {
    return null;
  }
  if (metric === "level") return finiteNumber(frame.level);
  if (metric === "xp") return finiteNumber(frame.xp);
  if (metric === "totalGold") return finiteNumber(frame.totalGold);
  if (metric === "currentGold") return finiteNumber(frame.currentGold);
  if (metric === "minionsKilled") return finiteNumber(frame.minionsKilled);
  if (metric === "jungleMinionsKilled") return finiteNumber(frame.jungleMinionsKilled);
  if (metric === "health") return finiteNumber(frame.championStats?.health);
  if (metric === "healthMax") return finiteNumber(frame.championStats?.healthMax);
  if (metric === "power") return finiteNumber(frame.championStats?.power);
  if (metric === "powerMax") return finiteNumber(frame.championStats?.powerMax);
  if (metric === "movementSpeed") return finiteNumber(frame.championStats?.movementSpeed);
  return null;
}

function readApiFrames(apiRoot, replayId) {
  const fixtureDir = path.join(apiRoot, normalizeFixtureReplayId(replayId));
  const manifest = readJson(path.join(fixtureDir, "manifest.json"));
  const timeline = readJson(path.join(fixtureDir, manifest.timelineFile ?? "timeline.json"));
  return timeline.info?.frames ?? [];
}

function buildMatchIndex(parityReport) {
  const index = new Map();
  for (const replay of parityReport.replays ?? []) {
    for (const match of replay.topMatches ?? []) {
      if (!match.pass) {
        continue;
      }
      const key = keyFor([
        replay.replayId,
        match.familyKey,
        match.slotIndex,
        match.participantId,
        match.metric,
        match.offset,
        match.decodeLabel,
      ]);
      const current = index.get(key);
      if (!current || (match.score ?? 0) > (current.score ?? 0)) {
        index.set(key, match);
      }
    }
  }
  return index;
}

function selectField(cleaned, slotIndex, offset, decodeLabel) {
  const slot = (cleaned.slots ?? []).find((entry) => entry.slotIndex === slotIndex);
  if (!slot) {
    return null;
  }

  return (slot.fields ?? [])
    .filter((field) => field.offset === offset && field.decodeLabel === decodeLabel)
    .sort((left, right) => (right.activeSamples ?? 0) - (left.activeSamples ?? 0) || (right.width ?? 0) - (left.width ?? 0))[0] ?? null;
}

function rawFieldPoints(field) {
  const byFrame = new Map();
  for (const sample of field.samples ?? []) {
    const frameIndex = finiteNumber(sample.apiFrameIndex);
    const decoded = finiteNumber(sample.decoded);
    if (frameIndex == null || decoded == null) {
      continue;
    }
    const values = byFrame.get(frameIndex) ?? [];
    values.push(decoded);
    byFrame.set(frameIndex, values);
  }

  return [...byFrame.entries()]
    .map(([apiFrameIndex, values]) => {
      const raw = median(values);
      return {
        apiFrameIndex,
        timestamp: apiFrameIndex * 60000,
        raw,
        sampleCount: values.length,
      };
    })
    .sort((left, right) => left.apiFrameIndex - right.apiFrameIndex);
}

function fitMetric(points, apiFrames, participantId, metric) {
  const rawValues = [];
  const targetValues = [];
  for (const point of points) {
    const target = readMetricValue(apiFrames[point.apiFrameIndex]?.participantFrames?.[String(participantId)], metric);
    if (target == null) {
      continue;
    }
    rawValues.push(point.raw);
    targetValues.push(target);
  }

  const fit = fitAffine1D(rawValues, targetValues);
  const predictedValues = rawValues.map((raw) => (fit.slope * raw) + fit.intercept);
  const targetStdDev = standardDeviation(targetValues);
  return {
    ...fit,
    comparedPoints: rawValues.length,
    correlation: rawValues.length >= 3 ? pearsonCorrelation(predictedValues, targetValues) : null,
    normalizedRmse: targetStdDev > 1e-9 ? fit.rmse / targetStdDev : null,
  };
}

function transformPoints(points, fit) {
  return points.map((point) => ({
    ...point,
    value: (fit.slope * point.raw) + fit.intercept,
  }));
}

function summarizeErrors(points, apiFrames, participantId, metric) {
  const errors = [];
  for (const point of points) {
    const apiValue = readMetricValue(apiFrames[point.apiFrameIndex]?.participantFrames?.[String(participantId)], metric);
    if (apiValue == null) {
      continue;
    }
    errors.push(Math.abs(point.value - apiValue));
  }
  return {
    comparedPoints: errors.length,
    meanAbsError: errors.length ? average(errors) : null,
    maxAbsError: errors.length ? Math.max(...errors) : null,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const apiRoot = resolveAbsolute(root, args.apiRoot);
  const assignments = readJson(path.join(artifactRoot, "keyframe-slot-assignments.json"));
  const parityReport = readJson(path.join(artifactRoot, "keyframe-api-parity.json"));
  const matchIndex = buildMatchIndex(parityReport);
  const metricAllowList = args.metrics ? new Set(args.metrics) : null;

  const replayRows = (assignments.replays ?? [])
    .filter((replay) => !args.replayId || replay.replayId === args.replayId);

  const exportedReplays = [];
  const totals = {
    replayCount: replayRows.length,
    exportedReplayCount: 0,
    assignmentCount: 0,
    stableAssignmentCount: 0,
    participantSeriesCount: 0,
    metricSeriesCount: 0,
    pointCount: 0,
  };

  for (const replay of replayRows) {
    const apiParticipants = readApiParticipants(apiRoot, replay.replayId);
    const apiFrames = readApiFrames(apiRoot, replay.replayId);
    const exportedParticipants = [];

    for (const family of replay.families ?? []) {
      const cleanedPath = path.join(artifactRoot, replay.replayId, "families", family.familyKey, "cleaned.json");
      let cleaned = null;
      try {
        cleaned = readJson(cleanedPath);
      } catch {
        continue;
      }

      for (const assignment of family.assignments ?? []) {
        totals.assignmentCount += 1;
        if (assignment.stable) {
          totals.stableAssignmentCount += 1;
        }
        if (!args.includeUnstable && !assignment.stable) {
          continue;
        }

        const series = {};
        const metricSummaries = {};
        for (const metric of assignment.metrics ?? []) {
          if (metricAllowList && !metricAllowList.has(metric)) {
            continue;
          }
          const support = (parityReport.replays ?? [])
            .find((entry) => entry.replayId === replay.replayId)
            ?.participantSlotEvidence
            ?.find((entry) => entry.familyKey === family.familyKey && entry.slotIndex === assignment.slotIndex && entry.participantId === assignment.participantId)
            ?.support
            ?.filter((entry) => entry.metric === metric)
            ?.sort((left, right) => (right.score ?? 0) - (left.score ?? 0)) ?? [];

          const supportEntry = support[0];
          if (!supportEntry) {
            continue;
          }

          const indexedMatch = matchIndex.get(keyFor([
            replay.replayId,
            family.familyKey,
            assignment.slotIndex,
            assignment.participantId,
            metric,
            supportEntry.offset,
            supportEntry.decodeLabel,
          ]));

          const field = selectField(cleaned, assignment.slotIndex, supportEntry.offset, supportEntry.decodeLabel);
          if (!field) {
            continue;
          }

          const rawPoints = rawFieldPoints(field);
          if (!rawPoints.length) {
            continue;
          }
          const localFit = fitMetric(rawPoints, apiFrames, assignment.participantId, metric);
          const match = indexedMatch && Number.isFinite(indexedMatch.slope) && Number.isFinite(indexedMatch.intercept)
            ? indexedMatch
            : localFit;
          if (!Number.isFinite(match.slope) || !Number.isFinite(match.intercept) || localFit.comparedPoints < 3) {
            continue;
          }
          const points = transformPoints(rawPoints, match);
          const errorSummary = summarizeErrors(points, apiFrames, assignment.participantId, metric);
          series[metric] = points;
          metricSummaries[metric] = {
            offset: supportEntry.offset,
            decodeLabel: supportEntry.decodeLabel,
            slope: match.slope,
            intercept: match.intercept,
            fitSource: indexedMatch ? "stored-top-match" : "local-fit",
            correlation: match.correlation ?? localFit.correlation,
            normalizedRmse: match.normalizedRmse ?? localFit.normalizedRmse,
            score: match.score ?? supportEntry.score,
            pointCount: points.length,
            ...errorSummary,
          };
          totals.metricSeriesCount += 1;
          totals.pointCount += points.length;
        }

        if (!Object.keys(series).length) {
          continue;
        }

        exportedParticipants.push({
          participant: apiParticipants.get(assignment.participantId) ?? {
            participantId: assignment.participantId,
            champion: assignment.champion,
            teamId: assignment.teamId,
            teamPosition: assignment.teamPosition,
          },
          familyKey: family.familyKey,
          slotIndex: assignment.slotIndex,
          stable: assignment.stable,
          assignmentScore: assignment.score,
          winnerGap: assignment.winnerGap,
          metrics: metricSummaries,
          series,
        });
        totals.participantSeriesCount += 1;
      }
    }

    if (exportedParticipants.length) {
      exportedReplays.push({
        replayId: replay.replayId,
        versionGroup: replay.versionGroup,
        gameVersion: replay.gameVersion,
        participants: exportedParticipants,
      });
      totals.exportedReplayCount += 1;
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    apiRoot,
    supervised: true,
    note: "Prototype export uses API-supervised keyframe slot assignments and per-field affine parity fits. It is not replay-only decoding yet.",
    filters: {
      replayId: args.replayId,
      includeUnstable: args.includeUnstable,
      metrics: args.metrics,
    },
    totals,
    replays: exportedReplays,
  };

  const outputPath = resolveAbsolute(root, args.outputPath ?? (
    args.replayId
      ? path.join(artifactRoot, args.replayId, "keyframe-state-prototype.json")
      : path.join(artifactRoot, "keyframe-state-prototype.json")
  ));
  writeJson(outputPath, output);
  console.log(`Wrote keyframe state prototype to ${outputPath}`);
  console.log(`Exported ${totals.participantSeriesCount} participant series, ${totals.metricSeriesCount} metric series, ${totals.pointCount} points across ${totals.exportedReplayCount}/${totals.replayCount} replay(s).`);
}

main();
