#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const itemEventTypes = new Set([
  "ITEM_PURCHASED",
  "ITEM_SOLD",
  "ITEM_DESTROYED",
  "ITEM_UNDO",
]);

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    fixtureDir: null,
    outputPath: null,
    maxTimeShiftMs: 120000,
    timeStepMs: 1000,
    matchWindowMs: 6000,
    minChanges: 3,
    topFields: 120,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--max-time-shift-ms" && index + 1 < argv.length) {
      args.maxTimeShiftMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--time-step-ms" && index + 1 < argv.length) {
      args.timeStepMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--match-window-ms" && index + 1 < argv.length) {
      args.matchWindowMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-changes" && index + 1 < argv.length) {
      args.minChanges = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-fields" && index + 1 < argv.length) {
      args.topFields = Number.parseInt(argv[++index], 10);
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
  if (!Number.isFinite(args.maxTimeShiftMs) || args.maxTimeShiftMs < 0) {
    throw new Error("--max-time-shift-ms must be a non-negative integer.");
  }
  if (!Number.isFinite(args.timeStepMs) || args.timeStepMs <= 0) {
    throw new Error("--time-step-ms must be a positive integer.");
  }
  if (!Number.isFinite(args.matchWindowMs) || args.matchWindowMs <= 0) {
    throw new Error("--match-window-ms must be a positive integer.");
  }
  if (!Number.isFinite(args.minChanges) || args.minChanges < 1) {
    throw new Error("--min-changes must be at least 1.");
  }
  if (!Number.isFinite(args.topFields) || args.topFields < 1) {
    throw new Error("--top-fields must be at least 1.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/discover_item_event_candidates.mjs --artifact-dir <path> [options]");
  console.log("");
  console.log("Options:");
  console.log("  --fixture-dir <path>        API fixture dir override.");
  console.log("  --output-path <path>        Output JSON path (default: <artifact>/item-event-candidates.json).");
  console.log("  --max-time-shift-ms <int>   Max shift for timestamp search (default: 120000).");
  console.log("  --time-step-ms <int>        Shift step size in milliseconds (default: 1000).");
  console.log("  --match-window-ms <int>     Timestamp match tolerance (default: 6000).");
  console.log("  --min-changes <int>         Minimum detected field changes (default: 3).");
  console.log("  --top-fields <int>          Number of top fields to keep (default: 120).");
}

function buildTimeShifts(maxTimeShiftMs, timeStepMs) {
  const shifts = [];
  for (let shift = -maxTimeShiftMs; shift <= maxTimeShiftMs; shift += timeStepMs) {
    shifts.push(shift);
  }
  if (!shifts.includes(0)) {
    shifts.push(0);
  }
  return [...new Set(shifts)].sort((left, right) => left - right);
}

function findNearestEventIndex(sortedEvents, timestamp, toleranceMs, startIndexHint = 0) {
  let pointer = Math.max(0, startIndexHint);
  while (pointer < sortedEvents.length && sortedEvents[pointer] < (timestamp - toleranceMs)) {
    pointer += 1;
  }

  let nearestIndex = -1;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidateIndex of [pointer - 1, pointer, pointer + 1]) {
    if (candidateIndex < 0 || candidateIndex >= sortedEvents.length) {
      continue;
    }
    const distance = Math.abs(sortedEvents[candidateIndex] - timestamp);
    if (distance <= toleranceMs && distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = candidateIndex;
    }
  }

  return {
    pointer,
    nearestIndex,
    nearestDistance,
  };
}

function evaluateShift(changeTimestamps, eventTimestamps, shiftMs, toleranceMs, maxTimeShiftMs) {
  if (!changeTimestamps.length || !eventTimestamps.length) {
    return {
      shiftMs,
      score: 0,
      matchedChanges: 0,
      matchedEvents: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      averageDistanceMs: null,
    };
  }

  const matchedEventFlags = new Array(eventTimestamps.length).fill(false);
  let matchedChanges = 0;
  let pointer = 0;
  let distanceSum = 0;

  for (const changeTimestamp of changeTimestamps) {
    const alignedTimestamp = changeTimestamp + shiftMs;
    const nearest = findNearestEventIndex(eventTimestamps, alignedTimestamp, toleranceMs, pointer);
    pointer = nearest.pointer;
    if (nearest.nearestIndex >= 0) {
      matchedChanges += 1;
      matchedEventFlags[nearest.nearestIndex] = true;
      distanceSum += nearest.nearestDistance;
    }
  }

  const matchedEvents = matchedEventFlags.reduce((sum, matched) => sum + Number(matched), 0);
  const precision = matchedChanges / changeTimestamps.length;
  const recall = matchedEvents / eventTimestamps.length;
  const f1 = (precision + recall) > 0
    ? (2 * precision * recall) / (precision + recall)
    : 0;
  const averageDistanceMs = matchedChanges > 0 ? distanceSum / matchedChanges : null;
  const distanceScore = matchedChanges > 0
    ? Math.max(0, 1 - ((averageDistanceMs ?? toleranceMs) / toleranceMs))
    : 0;
  const coverageScore = Math.min(1, matchedEvents / 10) * Math.min(1, matchedChanges / 10);
  const shiftPenalty = Math.max(0.2, 1 - ((Math.abs(shiftMs) / Math.max(1, maxTimeShiftMs)) * 0.8));
  const baseScore = (precision * 0.2) + (recall * 0.5) + (f1 * 0.2) + (distanceScore * 0.1);
  const score = baseScore * coverageScore * shiftPenalty;

  return {
    shiftMs,
    score,
    baseScore,
    coverageScore,
    shiftPenalty,
    matchedChanges,
    matchedEvents,
    precision,
    recall,
    f1,
    averageDistanceMs,
  };
}

function findBestShift(changeTimestamps, eventTimestamps, shifts, toleranceMs, maxTimeShiftMs) {
  let best = null;
  for (const shiftMs of shifts) {
    const evaluation = evaluateShift(changeTimestamps, eventTimestamps, shiftMs, toleranceMs, maxTimeShiftMs);
    if (
      !best ||
      evaluation.score > best.score ||
      (evaluation.score === best.score && evaluation.precision > best.precision) ||
      (
        evaluation.score === best.score &&
        evaluation.precision === best.precision &&
        (evaluation.averageDistanceMs ?? Number.POSITIVE_INFINITY) < (best.averageDistanceMs ?? Number.POSITIVE_INFINITY)
      )
    ) {
      best = evaluation;
    }
  }
  return best;
}

function decodeEpsilon(decodeLabel, value) {
  if (String(decodeLabel).startsWith("f")) {
    return Math.max(1e-3, Math.abs(value ?? 0) * 1e-6);
  }
  return 0;
}

function buildFieldChanges(field) {
  const samples = (field.samples ?? [])
    .filter((sample) => Number.isFinite(sample.timestamp) && Number.isFinite(sample.decoded))
    .sort((left, right) => left.timestamp - right.timestamp);
  const changes = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const delta = current.decoded - previous.decoded;
    const epsilon = decodeEpsilon(field.decodeLabel, previous.decoded);
    if (Math.abs(delta) <= epsilon) {
      continue;
    }
    changes.push({
      timestamp: current.timestamp,
      delta,
      absDelta: Math.abs(delta),
    });
  }

  return {
    samples,
    changes,
  };
}

function collectItemEvents(timelineJson) {
  const globalEvents = [];
  const byParticipant = new Map();
  const byType = new Map();

  for (const frame of timelineJson.info.frames ?? []) {
    for (const event of frame.events ?? []) {
      if (!itemEventTypes.has(event.type)) {
        continue;
      }
      const timestamp = event.timestamp;
      if (!Number.isFinite(timestamp)) {
        continue;
      }

      globalEvents.push(timestamp);
      const participantId = Number.parseInt(`${event.participantId ?? ""}`, 10);
      if (Number.isFinite(participantId)) {
        const participantEvents = byParticipant.get(participantId) ?? [];
        participantEvents.push(timestamp);
        byParticipant.set(participantId, participantEvents);
      }

      const typeEvents = byType.get(event.type) ?? [];
      typeEvents.push(timestamp);
      byType.set(event.type, typeEvents);
    }
  }

  globalEvents.sort((left, right) => left - right);
  for (const events of byParticipant.values()) {
    events.sort((left, right) => left - right);
  }
  for (const events of byType.values()) {
    events.sort((left, right) => left - right);
  }

  return {
    globalEvents,
    byParticipant,
    byType,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = process.cwd();
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const summaryPath = path.join(artifactDir, "summary.json");

  if (!fs.existsSync(runManifestPath)) {
    throw new Error(`run-manifest.json not found at ${runManifestPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary.json not found at ${summaryPath}`);
  }

  const runManifest = readJson(runManifestPath);
  const summary = readJson(summaryPath);
  const replayId = runManifest.replayId ?? path.basename(artifactDir);

  const fixtureDir = args.fixtureDir
    ? resolveAbsolute(repoRoot, args.fixtureDir)
    : path.join(repoRoot, "replays", "api", replayId.replace(/-/g, "_"));
  const timelinePath = path.join(fixtureDir, "timeline.json");
  const matchPath = path.join(fixtureDir, "match.json");
  if (!fs.existsSync(timelinePath) || !fs.existsSync(matchPath)) {
    throw new Error(`API fixture bundle not found under ${fixtureDir}`);
  }

  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "item-event-candidates.json");

  const timelineJson = readJson(timelinePath);
  const matchJson = readJson(matchPath);
  const eventIndex = collectItemEvents(timelineJson);
  const shifts = buildTimeShifts(args.maxTimeShiftMs, args.timeStepMs);
  const participantLookup = new Map((matchJson.info.participants ?? []).map((participant) => [
    participant.participantId,
    {
      participantId: participant.participantId,
      champion: participant.championName,
      teamId: participant.teamId,
      teamPosition: participant.teamPosition ?? participant.individualPosition,
    },
  ]));

  const candidates = [];
  for (const family of runManifest.families ?? []) {
    const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    const cleaned = readJson(cleanedPath);
    for (const slot of cleaned.slots ?? []) {
      for (const field of slot.fields ?? []) {
        const fieldSeries = buildFieldChanges(field);
        const changeTimestamps = fieldSeries.changes.map((change) => change.timestamp);
        if (changeTimestamps.length < args.minChanges) {
          continue;
        }

        const globalBest = findBestShift(
          changeTimestamps,
          eventIndex.globalEvents,
          shifts,
          args.matchWindowMs,
          args.maxTimeShiftMs,
        );
        let bestParticipant = null;
        for (const [participantId, events] of eventIndex.byParticipant.entries()) {
          if (!events.length) {
            continue;
          }
          const evaluation = findBestShift(
            changeTimestamps,
            events,
            shifts,
            args.matchWindowMs,
            args.maxTimeShiftMs,
          );
          if (
            !bestParticipant ||
            evaluation.score > bestParticipant.evaluation.score ||
            (
              evaluation.score === bestParticipant.evaluation.score &&
              evaluation.precision > bestParticipant.evaluation.precision
            )
          ) {
            bestParticipant = {
              participantId,
              participant: participantLookup.get(participantId) ?? { participantId },
              evaluation,
            };
          }
        }

        let bestEventType = null;
        for (const [eventType, events] of eventIndex.byType.entries()) {
          const evaluation = findBestShift(
            changeTimestamps,
            events,
            shifts,
            args.matchWindowMs,
            args.maxTimeShiftMs,
          );
          if (
            !bestEventType ||
            evaluation.score > bestEventType.evaluation.score ||
            (
              evaluation.score === bestEventType.evaluation.score &&
              evaluation.precision > bestEventType.evaluation.precision
            )
          ) {
            bestEventType = {
              eventType,
              evaluation,
            };
          }
        }

        const averageAbsDelta = fieldSeries.changes.reduce((sum, change) => sum + change.absDelta, 0) / fieldSeries.changes.length;
        const score = (globalBest?.score ?? 0) * 0.35
          + (bestParticipant?.evaluation.score ?? 0) * 0.5
          + (bestEventType?.evaluation.score ?? 0) * 0.15;

        candidates.push({
          familyKey: family.familyKey,
          slotIndex: slot.slotIndex,
          rowArchetype: family.dynamicSlots?.includes(slot.slotIndex)
            ? "dynamic_state_like"
            : (family.mixedSlots?.includes(slot.slotIndex) ? "mixed" : "other"),
          offset: field.offset,
          width: field.width,
          decodeLabel: field.decodeLabel,
          activeSamples: field.activeSamples ?? fieldSeries.samples.length,
          uniqueValues: field.uniqueValues ?? null,
          changedTransitions: field.changedTransitions ?? fieldSeries.changes.length,
          changeCount: fieldSeries.changes.length,
          averageAbsDelta,
          score,
          globalAlignment: globalBest,
          participantAlignment: bestParticipant
            ? {
              participantId: bestParticipant.participantId,
              champion: bestParticipant.participant.champion ?? null,
              teamId: bestParticipant.participant.teamId ?? null,
              teamPosition: bestParticipant.participant.teamPosition ?? null,
              ...bestParticipant.evaluation,
            }
            : null,
          eventTypeAlignment: bestEventType
            ? {
              eventType: bestEventType.eventType,
              ...bestEventType.evaluation,
            }
            : null,
          changeTimestamps: changeTimestamps.slice(0, 64),
        });
      }
    }
  }

  candidates.sort((left, right) =>
    right.score - left.score
    || (right.globalAlignment?.precision ?? 0) - (left.globalAlignment?.precision ?? 0)
    || (right.participantAlignment?.precision ?? 0) - (left.participantAlignment?.precision ?? 0)
    || (right.changeCount ?? 0) - (left.changeCount ?? 0));

  const familySummaryMap = new Map();
  for (const candidate of candidates) {
    const summaryRow = familySummaryMap.get(candidate.familyKey) ?? {
      familyKey: candidate.familyKey,
      candidateCount: 0,
      averageScoreSum: 0,
      bestScore: 0,
      bestCandidate: null,
      strongCount: 0,
    };
    summaryRow.candidateCount += 1;
    summaryRow.averageScoreSum += candidate.score;
    if (candidate.score > summaryRow.bestScore) {
      summaryRow.bestScore = candidate.score;
      summaryRow.bestCandidate = {
        slotIndex: candidate.slotIndex,
        offset: candidate.offset,
        decodeLabel: candidate.decodeLabel,
        score: candidate.score,
        globalAlignment: candidate.globalAlignment,
        participantAlignment: candidate.participantAlignment,
        eventTypeAlignment: candidate.eventTypeAlignment,
      };
    }
    if (
      candidate.score >= 0.11 &&
      (candidate.globalAlignment?.recall ?? 0) >= 0.02 &&
      (candidate.participantAlignment?.recall ?? 0) >= 0.03 &&
      candidate.changeCount >= 10
    ) {
      summaryRow.strongCount += 1;
    }
    familySummaryMap.set(candidate.familyKey, summaryRow);
  }

  const familySummary = [...familySummaryMap.values()]
    .map((row) => ({
      familyKey: row.familyKey,
      candidateCount: row.candidateCount,
      strongCount: row.strongCount,
      averageScore: row.averageScoreSum / Math.max(1, row.candidateCount),
      bestScore: row.bestScore,
      bestCandidate: row.bestCandidate,
      recommendation: row.strongCount > 0
        ? "prioritize"
        : (row.bestScore >= 0.08 ? "investigate" : "deprioritize"),
    }))
    .sort((left, right) =>
      right.strongCount - left.strongCount
      || right.bestScore - left.bestScore
      || right.averageScore - left.averageScore);

  const output = {
    replayId,
    generatedAtUtc: new Date().toISOString(),
    artifactDir,
    fixtureDir,
    gameVersion: summary.gameVersion ?? null,
    versionGroup: parseVersionGroup(summary.gameVersion ?? "unknown"),
    settings: {
      maxTimeShiftMs: args.maxTimeShiftMs,
      timeStepMs: args.timeStepMs,
      matchWindowMs: args.matchWindowMs,
      minChanges: args.minChanges,
      topFields: args.topFields,
      itemEventTypes: [...itemEventTypes],
    },
    eventInventory: {
      globalEventCount: eventIndex.globalEvents.length,
      participantEventCounts: Object.fromEntries(
        [...eventIndex.byParticipant.entries()].map(([participantId, events]) => [participantId, events.length]),
      ),
      eventTypeCounts: Object.fromEntries(
        [...eventIndex.byType.entries()].map(([eventType, events]) => [eventType, events.length]),
      ),
    },
    summary: {
      candidateCount: candidates.length,
      topCandidateCount: Math.min(args.topFields, candidates.length),
      familySummaryCount: familySummary.length,
      strongCandidateCount: candidates.filter((candidate) =>
        candidate.score >= 0.11
        && (candidate.globalAlignment?.recall ?? 0) >= 0.02
        && (candidate.participantAlignment?.recall ?? 0) >= 0.03
        && candidate.changeCount >= 10).length,
    },
    familySummary,
    topCandidates: candidates.slice(0, args.topFields),
  };

  writeJson(outputPath, output);
  console.log(`Wrote item-event candidates to ${outputPath}`);
  console.log(`Candidates evaluated: ${output.summary.candidateCount}, strong candidates: ${output.summary.strongCandidateCount}`);
}

main();
