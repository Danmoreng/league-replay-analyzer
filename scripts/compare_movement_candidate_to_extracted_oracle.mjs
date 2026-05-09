#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    replayListPath: null,
    movementFile: "extracted-movement.json",
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--replay-list-path" && index + 1 < argv.length) args.replayListPath = argv[++index];
    else if (arg === "--movement-file" && index + 1 < argv.length) args.movementFile = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/compare_movement_candidate_to_extracted_oracle.mjs [--artifact-root artifacts] [--version-group 16.9] [--replay-list-path <path>] [--movement-file extracted-movement.json] [--output-path <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function replayListPathForVersion(versionGroup) {
  return path.join("artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
}

function discoverReplayIds(args) {
  const replayListPath = resolveAbsolute(process.cwd(), args.replayListPath ?? replayListPathForVersion(args.versionGroup));
  if (fs.existsSync(replayListPath)) {
    const replayList = readJson(replayListPath);
    return (replayList.replays ?? [])
      .filter((replay) => !replay.skipped)
      .map((replay) => replay.replayId)
      .filter(Boolean)
      .sort();
  }
  const artifactRoot = resolveAbsolute(process.cwd(), args.artifactRoot);
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function participantIdForRosterIndex(rosterIndex) {
  return Number.isInteger(rosterIndex) ? rosterIndex + 1 : null;
}

function bestCandidateMatches(candidateMatches) {
  const byParticipant = new Map();
  for (const match of candidateMatches.topMatches ?? []) {
    const current = byParticipant.get(match.participantId);
    if (!current || Number(match.passesValidation) - Number(current.passesValidation) > 0 || (
      match.passesValidation === current.passesValidation &&
      (match.effectiveScore ?? 0) > (current.effectiveScore ?? 0)
    )) {
      byParticipant.set(match.participantId, match);
    }
  }
  return byParticipant;
}

function extractedOracleByParticipant(extractedMovement) {
  const byParticipant = new Map();
  for (const entity of extractedMovement.entities ?? []) {
    for (const hypothesis of entity.supportHypotheses ?? []) {
      const participantId = hypothesis.participantId;
      if (!participantId) continue;
      const current = byParticipant.get(participantId);
      const row = {
        entityKey: entity.entityKey,
        familyKey: entity.familyKey,
        slotIndex: entity.slotIndex,
        passesValidation: hypothesis.passesValidation === true,
        effectiveScore: hypothesis.effectiveScore ?? null,
        normalizedDistanceRmse: hypothesis.normalizedDistanceRmse ?? null,
        minAxisCorrelation: hypothesis.minAxisCorrelation ?? null,
        pathCorrelation: hypothesis.pathCorrelation ?? null,
      };
      if (!current || Number(row.passesValidation) - Number(current.passesValidation) > 0 || (
        row.passesValidation === current.passesValidation &&
        (row.effectiveScore ?? 0) > (current.effectiveScore ?? 0)
      )) {
        byParticipant.set(participantId, row);
      }
    }
  }
  return byParticipant;
}

function compactCandidateKey(match) {
  if (!match) return null;
  return [match.familyKey, match.slotIndex, match.leftOffset, match.rightOffset, match.mapping].join("|");
}

function buildSchemaRawPairIndex(schema) {
  const index = new Map();
  for (const section of ["promotedPatterns", "rankedPatterns"]) {
    for (const [patternIndex, pattern] of (schema?.[section] ?? []).entries()) {
      for (const candidate of pattern.rawPairCandidates ?? []) {
        const key = [pattern.familyKey, candidate.slotIndex, pattern.xField?.offset, pattern.yField?.offset, pattern.mapping].join("|");
        const current = index.get(key) ?? [];
        current.push({
          section,
          patternIndex,
          patternKey: pattern.patternKey,
          confidence: pattern.confidence ?? null,
          rawPairKey: candidate.rawPairKey ?? null,
        });
        index.set(key, current);
      }
    }
  }
  return index;
}

function buildDiscoveredRawPairIndex(candidateMatchesReport) {
  const index = new Set();
  for (const candidate of candidateMatchesReport.rawPairCandidates ?? []) {
    if (candidate.rawPairKey) {
      index.add(candidate.rawPairKey);
      continue;
    }
    if (
      candidate.familyKey != null &&
      candidate.slotIndex != null &&
      candidate.leftOffset != null &&
      candidate.leftDecodeLabel != null &&
      candidate.rightOffset != null &&
      candidate.rightDecodeLabel != null &&
      candidate.mapping != null
    ) {
      index.add([
        candidate.familyKey,
        candidate.slotIndex,
        candidate.leftOffset,
        candidate.leftDecodeLabel,
        candidate.rightOffset,
        candidate.rightDecodeLabel,
        candidate.mapping,
      ].join("|"));
    }
  }
  return index;
}

function buildExtractedCandidateIndex(extractedMovement) {
  const index = new Set();
  for (const entity of extractedMovement.entities ?? []) {
    const parts = String(entity.entityKey ?? "").split("|");
    if (parts.length < 5) continue;
    index.add([parts[0], parts[1], parts[2], parts[3], parts[4]].join("|"));
  }
  return index;
}

function buildExtractedPatternIndex(extractedMovement) {
  return new Set((extractedMovement.patterns ?? []).map((pattern) => pattern.patternKey).filter(Boolean));
}

function classifyLostCandidate(candidate, extracted, schemaIndex, extractedIndex, extractedPatternIndex, discoveredRawPairIndex) {
  const key = compactCandidateKey(candidate);
  if (!key) return "missing_candidate_match";
  const rawPairKey = [
    candidate.familyKey,
    candidate.slotIndex,
    candidate.leftOffset,
    candidate.leftDecodeLabel,
    candidate.rightOffset,
    candidate.rightDecodeLabel,
    candidate.mapping,
  ].join("|");
  const schemaRows = schemaIndex.get(key) ?? [];
  if (schemaRows.length === 0) {
    return discoveredRawPairIndex.has(rawPairKey)
      ? "discovered_raw_pair_omitted_from_truncated_schema"
      : "absent_from_discovered_raw_pairs";
  }
  if (!extractedIndex.has(key)) {
    if (!schemaRows.some((row) => extractedPatternIndex.has(row.patternKey))) {
      const rankedIndexes = schemaRows
        .filter((row) => row.section === "rankedPatterns" && Number.isInteger(row.patternIndex))
        .map((row) => row.patternIndex);
      const minRank = rankedIndexes.length ? Math.min(...rankedIndexes) : null;
      if (minRank == null) return "schema_pattern_not_selected_unranked";
      if (minRank < 10) return "schema_pattern_not_selected_rank_0_9";
      if (minRank < 20) return "schema_pattern_not_selected_rank_10_19";
      if (minRank < 40) return "schema_pattern_not_selected_rank_20_39";
      return "schema_pattern_not_selected_rank_40_plus";
    }
    return "selected_schema_pattern_candidate_not_extracted";
  }
  if (!extracted) return "extracted_candidate_without_support_hypothesis";
  if (extracted.familyKey !== candidate.familyKey || extracted.slotIndex !== candidate.slotIndex) return "different_extracted_candidate_selected";
  return "extracted_candidate_present_pass_lost";
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToSortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0]))));
}

function summarizeReplay(artifactRoot, replayId, movementFile) {
  const replayDir = path.join(artifactRoot, replayId);
  const candidateMatchesPath = path.join(replayDir, "movement-candidate-matches.json");
  const extractedMovementPath = path.join(replayDir, movementFile);
  const schemaPath = path.join(replayDir, "movement-provisional-schema.json");
  const statsPath = path.join(replayDir, "extracted-stats.json");
  if (!fs.existsSync(candidateMatchesPath) || !fs.existsSync(extractedMovementPath) || !fs.existsSync(schemaPath) || !fs.existsSync(statsPath)) {
    return { replayId, status: "missing" };
  }

  const candidateMatchesReport = readJson(candidateMatchesPath);
  const candidateMatches = bestCandidateMatches(candidateMatchesReport);
  const extractedMovement = readJson(extractedMovementPath);
  const extractedOracle = extractedOracleByParticipant(extractedMovement);
  const schemaIndex = buildSchemaRawPairIndex(readJson(schemaPath));
  const discoveredRawPairIndex = buildDiscoveredRawPairIndex(candidateMatchesReport);
  const extractedIndex = buildExtractedCandidateIndex(extractedMovement);
  const extractedPatternIndex = buildExtractedPatternIndex(extractedMovement);
  const stats = readJson(statsPath);
  const participants = (stats.roster ?? []).map((participant) => {
    const participantId = participantIdForRosterIndex(participant.rosterIndex);
    const candidate = candidateMatches.get(participantId) ?? null;
    const extracted = extractedOracle.get(participantId) ?? null;
    const candidatePasses = candidate?.passesValidation === true;
    const extractedPasses = extracted?.passesValidation === true;
    return {
      participantId,
      rosterIndex: participant.rosterIndex,
      champion: participant.champion,
      team: participant.team,
      teamPosition: participant.teamPosition,
      candidatePasses,
      extractedPasses,
      status: candidatePasses && extractedPasses
        ? "preserved_pass"
        : candidatePasses
          ? "lost_candidate_pass"
          : extractedPasses
            ? "extracted_only_pass"
            : "no_pass",
      lostReason: candidatePasses && !extractedPasses
        ? classifyLostCandidate(candidate, extracted, schemaIndex, extractedIndex, extractedPatternIndex, discoveredRawPairIndex)
        : null,
      candidate: candidate
        ? {
            familyKey: candidate.familyKey,
            slotIndex: candidate.slotIndex,
            rawPairKey: [candidate.familyKey, candidate.slotIndex, candidate.leftOffset, candidate.leftDecodeLabel, candidate.rightOffset, candidate.rightDecodeLabel, candidate.mapping].join("|"),
            coordinateModelSource: candidate.coordinateModelSource ?? "none",
            coordinateModelSupport: candidate.coordinateModelSupport ?? 0,
            coordinateModelReplaySupport: candidate.coordinateModelReplaySupport ?? 0,
            effectiveScore: candidate.effectiveScore ?? null,
            normalizedDistanceRmse: candidate.normalizedDistanceRmse ?? null,
            minAxisCorrelation: candidate.minAxisCorrelation ?? Math.min(candidate.xCorrelation ?? 0, candidate.yCorrelation ?? 0),
            pathCorrelation: candidate.pathCorrelation ?? null,
          }
        : null,
      extracted,
    };
  });
  return {
    replayId,
    status: "present",
    participants,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replays = discoverReplayIds(args).map((replayId) => summarizeReplay(artifactRoot, replayId, args.movementFile));
  const presentReplays = replays.filter((replay) => replay.status === "present");
  const statusCounts = new Map();
  const lostByFamily = new Map();
  const lostByModelSource = new Map();
  const lostByRole = new Map();
  const lostByReason = new Map();
  for (const replay of presentReplays) {
    for (const participant of replay.participants) {
      increment(statusCounts, participant.status);
      if (participant.status === "lost_candidate_pass") {
        increment(lostByFamily, participant.candidate?.familyKey ?? "none");
        increment(lostByModelSource, participant.candidate?.coordinateModelSource ?? "none");
        increment(lostByRole, participant.teamPosition ?? "UNKNOWN");
        increment(lostByReason, participant.lostReason ?? "unknown");
      }
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "movement-candidate-to-extracted-oracle-comparison/v1",
    versionGroup: args.versionGroup,
    artifactRoot,
    movementFile: args.movementFile,
    runtimeInput: false,
    runtimeApiData: false,
    note: "Offline comparison of validation-labelled candidate matches against extracted movement support hypotheses.",
    replayCount: replays.length,
    presentReplayCount: presentReplays.length,
    totals: {
      expectedParticipantCount: presentReplays.reduce((sum, replay) => sum + replay.participants.length, 0),
      statusCounts: mapToSortedObject(statusCounts),
      lostCandidatePassCount: statusCounts.get("lost_candidate_pass") ?? 0,
      lostCandidatePassByFamily: mapToSortedObject(lostByFamily),
      lostCandidatePassByModelSource: mapToSortedObject(lostByModelSource),
      lostCandidatePassByRole: mapToSortedObject(lostByRole),
      lostCandidatePassByReason: mapToSortedObject(lostByReason),
    },
    replays,
  };
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join("artifacts-keyframes", `movement-candidate-to-extracted-oracle-comparison-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote movement candidate/extracted oracle comparison to ${outputPath}`);
  console.log(`lost candidate-match passes=${output.totals.lostCandidatePassCount}`);
}

main();
