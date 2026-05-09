import fs from "fs";
import path from "path";

import {
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: null,
    corpusManifest: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--corpus-manifest" && index + 1 < argv.length) {
      args.corpusManifest = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.artifactRoot && !args.corpusManifest) {
    throw new Error("Missing required --artifact-root <path> or --corpus-manifest <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/build_movement_identity_priors.mjs [--artifact-root <path>] [--corpus-manifest <path>] [--output-path <path>]");
}

function ensureBucket(map, key) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = new Map();
    map.set(key, bucket);
  }
  return bucket;
}

function accumulateLabel(bucket, labelKey, participantHit, replayId) {
  const current = bucket.get(labelKey) ?? {
    teamId: participantHit.teamId,
    teamPosition: participantHit.teamPosition,
    support: 0,
    totalEffectiveScore: 0,
    totalAxisCorrelation: 0,
    champions: new Set(),
    replays: new Set(),
  };
  current.support += 1;
  current.totalEffectiveScore += participantHit.effectiveScore ?? 0;
  current.totalAxisCorrelation += ((participantHit.xCorrelation ?? 0) + (participantHit.yCorrelation ?? 0)) / 2;
  if (participantHit.champion) {
    current.champions.add(participantHit.champion);
  }
  current.replays.add(replayId);
  bucket.set(labelKey, current);
}

function finalizeBucket(bucket) {
  const entries = [...bucket.entries()].map(([labelKey, value]) => ({
    labelKey,
    teamId: value.teamId,
    teamPosition: value.teamPosition,
    support: value.support,
    replayCount: value.replays.size,
    averageEffectiveScore: value.totalEffectiveScore / Math.max(value.support, 1),
    averageAxisCorrelation: value.totalAxisCorrelation / Math.max(value.support, 1),
    champions: [...value.champions].sort(),
  }));
  const maxSupport = Math.max(...entries.map((entry) => entry.support), 1);
  const maxScore = Math.max(...entries.map((entry) => entry.averageEffectiveScore), 1e-9);
  return entries
    .map((entry) => ({
      ...entry,
      normalizedScore:
        (0.55 * (entry.support / maxSupport))
        + (0.45 * (entry.averageEffectiveScore / maxScore)),
    }))
    .sort((left, right) =>
      right.normalizedScore - left.normalizedScore
      || right.support - left.support
      || right.averageEffectiveScore - left.averageEffectiveScore,
    );
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const corpusManifestPath = args.corpusManifest
    ? resolveAbsolute(repoRoot, args.corpusManifest)
    : null;
  const artifactRoot = args.artifactRoot
    ? resolveAbsolute(repoRoot, args.artifactRoot)
    : path.dirname(corpusManifestPath);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "movement-identity-priors.json");

  const manifest = corpusManifestPath
    ? readJson(corpusManifestPath)
    : {
      processed: fs.readdirSync(artifactRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          replayId: entry.name,
          artifactDir: path.join(artifactRoot, entry.name),
        })),
    };

  const exactBuckets = new Map();
  const familyBuckets = new Map();
  let replayCount = 0;
  for (const replay of manifest.processed ?? []) {
    const artifactDir = replay.artifactDir ? resolveAbsolute(repoRoot, replay.artifactDir) : path.join(artifactRoot, replay.replayId);
    const summaryPath = path.join(artifactDir, "summary.json");
    const schemaPath = path.join(artifactDir, "movement-provisional-schema.json");
    if (!fs.existsSync(summaryPath) || !fs.existsSync(schemaPath)) {
      continue;
    }

    const summary = readJson(summaryPath);
    const schema = readJson(schemaPath);
    const versionGroup = parseVersionGroup(summary.gameVersion);
    replayCount += 1;

    const bestHitBySlotAndParticipant = new Map();
    for (const pattern of [...(schema.promotedPatterns ?? []), ...(schema.rankedPatterns ?? []).slice(0, 32)]) {
      for (const hit of pattern.participantHits ?? []) {
        const key = `${pattern.familyKey}|${hit.slotIndex}|${hit.participantId}`;
        const current = bestHitBySlotAndParticipant.get(key);
        if (!current || (hit.effectiveScore ?? 0) > (current.effectiveScore ?? 0)) {
          bestHitBySlotAndParticipant.set(key, {
            ...hit,
            familyKey: pattern.familyKey,
            versionGroup,
          });
        }
      }
    }

    for (const hit of bestHitBySlotAndParticipant.values()) {
      const labelKey = `${hit.teamId}|${hit.teamPosition}`;
      const exactKey = `${hit.versionGroup}|${hit.familyKey}|${hit.slotIndex}`;
      const familyKey = `${hit.versionGroup}|${hit.familyKey}`;
      accumulateLabel(ensureBucket(exactBuckets, exactKey), labelKey, hit, replay.replayId);
      accumulateLabel(ensureBucket(familyBuckets, familyKey), labelKey, hit, replay.replayId);
    }
  }

  const priors = {
    generatedAtUtc: new Date().toISOString(),
    replayCount,
    exactSlotPriors: Object.fromEntries(
      [...exactBuckets.entries()].map(([key, bucket]) => [key, finalizeBucket(bucket)]),
    ),
    familyPriors: Object.fromEntries(
      [...familyBuckets.entries()].map(([key, bucket]) => [key, finalizeBucket(bucket)]),
    ),
  };

  writeJson(outputPath, priors);
  console.log(`Wrote movement identity priors to ${outputPath}`);
}

main();
