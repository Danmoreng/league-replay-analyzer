#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    outputPath: null,
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
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!args.replayId) {
    throw new Error("--replay-id is required.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/audit_rofl_challenge_gap_candidates.mjs --replay-id <id>");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  return separatorIndex < 0 ? replayId : `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function normalizeKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function readStatsJson(summary) {
  const metadata = typeof summary.metadataJson === "string"
    ? JSON.parse(summary.metadataJson)
    : summary.metadataJson;
  return JSON.parse(metadata.statsJson ?? "[]");
}

function getPath(value, pathText) {
  return pathText.split(".").reduce((cursor, segment) => cursor?.[segment], value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const summaryPath = path.join(artifactRoot, args.replayId, "summary.json");
  const fixtureDir = path.join(resolveAbsolute(root, args.apiRoot), normalizeFixtureReplayId(args.replayId));
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(artifactRoot, args.replayId, "rofl-challenge-gap-candidates.json");
  const summary = readJson(summaryPath);
  const match = readJson(path.join(fixtureDir, "match.json"));
  const artifactPath = path.join(artifactRoot, args.replayId, "rofl-api-metrics.json");
  const artifact = fs.existsSync(artifactPath) ? readJson(artifactPath) : null;
  const statsJson = readStatsJson(summary);
  const statKeys = Object.keys(statsJson[0] ?? {}).sort();
  const statKeysByNormalized = new Map(statKeys.map((key) => [normalizeKey(key), key]));
  const challengeKeys = Object.keys(match.info?.participants?.[0]?.challenges ?? {}).sort();
  const candidates = challengeKeys.map((challengeKey) => {
    const normalized = normalizeKey(challengeKey);
    const exactNormalized = statKeysByNormalized.get(normalized) ?? null;
    const contains = statKeys
      .filter((statKey) => {
        const statNormalized = normalizeKey(statKey);
        return statNormalized.includes(normalized) || normalized.includes(statNormalized);
      })
      .slice(0, 12);
    const valueParity = exactNormalized
      ? match.info.participants.map((participant, index) => {
          const riotValue = numberOrNull(participant.challenges?.[challengeKey]);
          const roflValue = numberOrNull(statsJson[index]?.[exactNormalized]);
          return {
            participantId: participant.participantId,
            riotValue,
            roflValue,
            pass: riotValue === roflValue,
          };
        })
      : [];
    const valueParityPassCount = valueParity.filter((entry) => entry.pass).length;
    const valueParityFailCount = valueParity.length - valueParityPassCount;
    const promotedArtifactValues = artifact
      ? match.info.participants.map((participant, index) => ({
          participantId: participant.participantId,
          value: getPath(artifact.match?.info?.participants?.[index], `challenges.${challengeKey}`) ?? null,
        }))
      : [];
    const promotedInArtifact = promotedArtifactValues.some((entry) => entry.value != null);
    const promotionStatus = exactNormalized == null
      ? "no_exact_rofl_stat"
      : valueParityFailCount === 0 && promotedInArtifact
        ? "promoted_validated_exact"
        : valueParityFailCount === 0
          ? "validated_exact_not_promoted"
          : "rejected_value_mismatch";
    return {
      challengeKey,
      exactNormalized,
      contains,
      status: exactNormalized ? "candidate_exact_normalized" : (contains.length ? "candidate_fuzzy" : "not_found"),
      valueParity: exactNormalized
        ? {
            comparisonCount: valueParity.length,
            passCount: valueParityPassCount,
            failCount: valueParityFailCount,
            mismatches: valueParity.filter((entry) => !entry.pass),
          }
        : null,
      promotedInArtifact,
      promotionStatus,
    };
  });
  const exactCandidates = candidates.filter((entry) => entry.status === "candidate_exact_normalized");
  const output = {
    challengeGapCandidateSchema: "rofl-challenge-gap-candidates/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-analysis-only",
    runtimeInput: false,
    replayId: args.replayId,
    summaryPath,
    fixtureDir,
    artifactPath,
    totals: {
      challengeKeyCount: challengeKeys.length,
      statKeyCount: statKeys.length,
      exactNormalizedCount: candidates.filter((entry) => entry.status === "candidate_exact_normalized").length,
      fuzzyCandidateCount: candidates.filter((entry) => entry.status === "candidate_fuzzy").length,
      notFoundCount: candidates.filter((entry) => entry.status === "not_found").length,
      exactValueParityPassCount: exactCandidates.filter((entry) => entry.valueParity?.failCount === 0).length,
      exactValueParityFailCount: exactCandidates.filter((entry) => (entry.valueParity?.failCount ?? 0) > 0).length,
      promotedValidatedExactCount: exactCandidates.filter((entry) => entry.promotionStatus === "promoted_validated_exact").length,
      rejectedExactValueMismatchCount: exactCandidates.filter((entry) => entry.promotionStatus === "rejected_value_mismatch").length,
    },
    candidates,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  writeJson(outputPath, output);
  console.log(`Wrote ROFL challenge gap candidates to ${outputPath}`);
  console.log(`challenge candidates: exact=${output.totals.exactNormalizedCount}, fuzzy=${output.totals.fuzzyCandidateCount}, missing=${output.totals.notFoundCount}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
