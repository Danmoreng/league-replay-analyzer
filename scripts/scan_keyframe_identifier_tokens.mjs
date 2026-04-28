import fs from "fs";
import path from "path";

import {
  buildFieldIndex,
  buildSummaryRoster,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    assignmentsPath: null,
    outputPath: null,
    stableOnly: true,
    minSupportRows: 3,
    minHitRate: 0.75,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--assignments-path" && index + 1 < argv.length) {
      args.assignmentsPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--all-assignments") {
      args.stableOnly = false;
    } else if (arg === "--min-support-rows" && index + 1 < argv.length) {
      args.minSupportRows = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-hit-rate" && index + 1 < argv.length) {
      args.minHitRate = Number.parseFloat(argv[++index]);
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
  console.log("Usage: node ./scripts/scan_keyframe_identifier_tokens.mjs [--artifact-root <path>] [--api-root <path>] [--assignments-path <path>] [--output-path <path>] [--all-assignments]");
}

function normalizeChampion(value) {
  return `${value ?? ""}`.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeInt(value) {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  const parsed = Number.parseInt(`${value ?? ""}`, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function u32(value) {
  const parsed = safeInt(value);
  return parsed == null ? null : parsed >>> 0;
}

function low32DecimalString(value) {
  const text = `${value ?? ""}`.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return Number(BigInt(text) & 0xffffffffn);
}

function readApiParticipants(apiRoot, replayId) {
  const fixtureId = replayId.replaceAll("-", "_");
  const matchPath = path.join(apiRoot, fixtureId, "match.json");
  if (!fs.existsSync(matchPath)) {
    return new Map();
  }
  const match = readJson(matchPath);
  return new Map((match.info?.participants ?? []).map((participant) => [participant.participantId, participant]));
}

function buildRosterByParticipant(summary, apiParticipants) {
  const roster = buildSummaryRoster(summary);
  return new Map(roster.map((entry) => {
    const participantId = entry.rosterIndex + 1;
    const apiParticipant = apiParticipants.get(participantId);
    const statMap = entry.statMap ?? {};
    return [participantId, {
      participantId,
      rosterIndex: entry.rosterIndex,
      champion: entry.champion,
      teamId: safeInt(entry.team),
      teamPosition: entry.teamPosition,
      championId: safeInt(apiParticipant?.championId),
      summonerIdLow32: low32DecimalString(statMap.SUMMONER_ID ?? statMap.ID),
      spell1Id: safeInt(apiParticipant?.summoner1Id ?? statMap.SUMMONER_SPELL_1),
      spell2Id: safeInt(apiParticipant?.summoner2Id ?? statMap.SUMMONER_SPELL_2),
    }];
  }));
}

function expectedTokens(rosterEntry) {
  return [
    { kind: "participantId", value: rosterEntry.participantId },
    { kind: "rosterIndex", value: rosterEntry.rosterIndex },
    { kind: "rosterOrdinal", value: rosterEntry.rosterIndex + 1 },
    { kind: "teamId", value: rosterEntry.teamId },
    { kind: "championId", value: rosterEntry.championId },
    { kind: "summonerIdLow32", value: rosterEntry.summonerIdLow32 },
    { kind: "spell1Id", value: rosterEntry.spell1Id },
    { kind: "spell2Id", value: rosterEntry.spell2Id },
  ].filter((token) => token.value != null);
}

function sampleValues(field) {
  const samples = field?.samples ?? [];
  const first = samples[0] ?? null;
  const last = samples[samples.length - 1] ?? null;
  const rawCounts = new Map();
  const decodedCounts = new Map();
  for (const sample of samples) {
    if (Number.isFinite(sample.raw)) {
      rawCounts.set(sample.raw, (rawCounts.get(sample.raw) ?? 0) + 1);
    }
    if (Number.isFinite(sample.decoded) && Number.isInteger(sample.decoded)) {
      decodedCounts.set(sample.decoded, (decodedCounts.get(sample.decoded) ?? 0) + 1);
    }
  }
  const modeRaw = [...rawCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
  const modeDecoded = [...decodedCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
  return [
    { source: "firstRaw", value: first?.raw },
    { source: "lastRaw", value: last?.raw },
    { source: "modeRaw", value: modeRaw },
    { source: "firstDecoded", value: first?.decoded },
    { source: "lastDecoded", value: last?.decoded },
    { source: "modeDecoded", value: modeDecoded },
  ].filter((entry) => Number.isFinite(entry.value) && Number.isInteger(entry.value));
}

function ensureBucket(map, key, seed) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = {
      ...seed,
      comparableRows: 0,
      hitRows: 0,
      replays: new Set(),
      examples: [],
    };
    map.set(key, bucket);
  }
  return bucket;
}

function scanReplay(artifactRoot, apiRoot, replay, stableOnly, buckets) {
  const summaryPath = path.join(artifactRoot, replay.replayId, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    return 0;
  }
  const summary = readJson(summaryPath);
  const apiParticipants = readApiParticipants(apiRoot, replay.replayId);
  const rosterByParticipant = buildRosterByParticipant(summary, apiParticipants);
  const familyIndexes = new Map();
  let scannedRows = 0;

  for (const family of replay.families ?? []) {
    const cleanedPath = path.join(artifactRoot, replay.replayId, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    if (!familyIndexes.has(family.familyKey)) {
      familyIndexes.set(family.familyKey, buildFieldIndex(readJson(cleanedPath)));
    }
    const fieldIndex = familyIndexes.get(family.familyKey);

    for (const assignment of family.assignments ?? []) {
      if (stableOnly && !assignment.stable) {
        continue;
      }
      const rosterEntry = rosterByParticipant.get(assignment.participantId);
      if (!rosterEntry || normalizeChampion(rosterEntry.champion) !== normalizeChampion(assignment.champion)) {
        continue;
      }
      scannedRows += 1;
      const tokens = expectedTokens(rosterEntry);
      const fields = [...fieldIndex.values()].filter((entry) => entry.slotIndex === assignment.slotIndex);

      for (const fieldEntry of fields) {
        const values = sampleValues(fieldEntry.field);
        for (const token of tokens) {
          for (const value of values) {
            const key = [
              replay.versionGroup,
              assignment.familyKey,
              fieldEntry.offset,
              fieldEntry.decodeLabel,
              value.source,
              token.kind,
            ].join("|");
            const bucket = ensureBucket(buckets, key, {
              versionGroup: replay.versionGroup,
              familyKey: assignment.familyKey,
              offset: fieldEntry.offset,
              decodeLabel: fieldEntry.decodeLabel,
              valueSource: value.source,
              tokenKind: token.kind,
            });
            bucket.comparableRows += 1;
            if (u32(value.value) === u32(token.value)) {
              bucket.hitRows += 1;
              bucket.replays.add(replay.replayId);
              if (bucket.examples.length < 8) {
                bucket.examples.push({
                  replayId: replay.replayId,
                  slotIndex: assignment.slotIndex,
                  participantId: assignment.participantId,
                  champion: assignment.champion,
                  expected: token.value,
                  observed: value.value,
                });
              }
            }
          }
        }
      }
    }
  }

  return scannedRows;
}

function finalizeBuckets(buckets, thresholds) {
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      replays: [...bucket.replays].sort(),
      replayCount: bucket.replays.size,
      hitRate: bucket.comparableRows > 0 ? bucket.hitRows / bucket.comparableRows : 0,
    }))
    .filter((bucket) => bucket.hitRows >= thresholds.minSupportRows && bucket.hitRate >= thresholds.minHitRate)
    .sort((left, right) =>
      right.hitRate - left.hitRate ||
      right.hitRows - left.hitRows ||
      right.replayCount - left.replayCount ||
      left.tokenKind.localeCompare(right.tokenKind) ||
      left.offset - right.offset,
    );
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const apiRoot = resolveAbsolute(repoRoot, args.apiRoot);
  const assignmentsPath = args.assignmentsPath
    ? resolveAbsolute(repoRoot, args.assignmentsPath)
    : path.join(artifactRoot, "keyframe-slot-assignments.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-identifier-token-scan.json");

  if (!fs.existsSync(assignmentsPath)) {
    throw new Error(`Keyframe slot assignments not found at ${assignmentsPath}.`);
  }

  const assignments = readJson(assignmentsPath);
  const buckets = new Map();
  let scannedRows = 0;
  for (const replay of assignments.replays ?? []) {
    if (replay.skipped) {
      continue;
    }
    scannedRows += scanReplay(artifactRoot, apiRoot, replay, args.stableOnly, buckets);
  }

  const candidates = finalizeBuckets(buckets, {
    minSupportRows: args.minSupportRows,
    minHitRate: args.minHitRate,
  });
  const output = {
    generatedAtUtc: new Date().toISOString(),
    sourceAssignmentsGeneratedAtUtc: assignments.generatedAtUtc ?? null,
    stableOnly: args.stableOnly,
    scannedRows,
    rawCandidateCount: buckets.size,
    candidateCount: candidates.length,
    thresholds: {
      minSupportRows: args.minSupportRows,
      minHitRate: args.minHitRate,
    },
    candidates,
  };
  writeJson(outputPath, output);

  console.log(`Wrote keyframe identifier token scan to ${outputPath}`);
  console.log(`scanned rows: ${scannedRows}`);
  console.log(`candidate identifiers: ${candidates.length}`);
}

main();
