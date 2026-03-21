import fs from "fs";
import path from "path";

import {
  average,
  median,
  mode,
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    corpusManifest: null,
    outputPath: null,
    maxRankedPatterns: 32,
    minReplaySupport: 2,
    minMedianParticipants: 6,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--corpus-manifest" && index + 1 < argv.length) {
      args.corpusManifest = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--max-ranked-patterns" && index + 1 < argv.length) {
      args.maxRankedPatterns = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-replay-support" && index + 1 < argv.length) {
      args.minReplaySupport = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-median-participants" && index + 1 < argv.length) {
      args.minMedianParticipants = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/build_corpus_schema.mjs [--artifact-root <path>] [--corpus-manifest <path>] [--output-path <path>]");
}

function buildPatternKey(pattern) {
  return `${pattern.familyKey}|${pattern.offset}|${pattern.decode}|${pattern.metric}`;
}

function getReplayGameVersion(runManifest, summaryJson) {
  return runManifest?.summary?.gameVersion ?? summaryJson?.gameVersion ?? "unknown";
}

function buildTransformSummary(matches) {
  const slopes = [];
  const intercepts = [];
  for (const match of matches) {
    if (!Number.isFinite(match.slope) || !Number.isFinite(match.intercept)) {
      continue;
    }
    slopes.push(match.slope);
    intercepts.push(match.intercept);
  }

  return {
    slopeMedian: median(slopes),
    interceptMedian: median(intercepts),
    sampleCount: slopes.length,
  };
}

function qualifyReplayPattern(entry) {
  return (
    entry.supportParticipants >= 6 &&
    entry.averageCorrelation >= 0.5 &&
    entry.averageNormalizedRmse <= 1.0 &&
    entry.averageValidatorScore >= 0.6
  );
}

function loadReplayEntries(artifactDir, maxRankedPatterns) {
  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const provisionalSchemaPath = path.join(artifactDir, "provisional-schema.json");
  const candidateMatchesPath = path.join(artifactDir, "candidate-matches.json");
  const summaryPath = path.join(artifactDir, "summary.json");

  if (!fs.existsSync(runManifestPath) || !fs.existsSync(provisionalSchemaPath) || !fs.existsSync(candidateMatchesPath)) {
    return null;
  }

  const runManifest = readJson(runManifestPath);
  const provisionalSchema = readJson(provisionalSchemaPath);
  const candidateMatches = readJson(candidateMatchesPath);
  const summaryJson = fs.existsSync(summaryPath) ? readJson(summaryPath) : null;

  const replayId = runManifest.replayId;
  const gameVersion = getReplayGameVersion(runManifest, summaryJson);
  const versionGroup = parseVersionGroup(gameVersion);
  const promotedKeys = new Set((provisionalSchema.promotedPatterns ?? []).map((pattern) => pattern.patternKey));

  const rankedPatterns = (provisionalSchema.rankedPatterns ?? []).slice(0, maxRankedPatterns);
  const replayEntries = rankedPatterns.map((pattern) => {
    const topMatches = (candidateMatches.topMatches ?? []).filter((match) =>
      match.familyKey === pattern.familyKey &&
      match.offset === pattern.offset &&
      match.decodeLabel === pattern.decode &&
      match.metricKey === pattern.metric &&
      match.slotIndex >= pattern.rowBand[0] &&
      match.slotIndex <= pattern.rowBand[1],
    );

    const slotFrequencies = new Map();
    for (const hit of pattern.participantHits ?? []) {
      slotFrequencies.set(hit.slotIndex, (slotFrequencies.get(hit.slotIndex) ?? 0) + 1);
    }

    const dominantSlotEntry = [...slotFrequencies.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0] ?? null;
    const dominantSlotSupport = dominantSlotEntry ? dominantSlotEntry[1] / Math.max((pattern.participantHits ?? []).length, 1) : 0;

    return {
      replayId,
      gameVersion,
      versionGroup,
      patternKey: buildPatternKey(pattern),
      sourcePatternKey: pattern.patternKey,
      familyKey: pattern.familyKey,
      family: pattern.family,
      familyLength: pattern.familyLength,
      familyFirstByte: pattern.familyFirstByte,
      offset: pattern.offset,
      decode: pattern.decode,
      metric: pattern.metric,
      metricLabel: pattern.metricLabel,
      rowArchetype: pattern.rowArchetype,
      rowBand: pattern.rowBand,
      confidence: pattern.confidence,
      supportParticipants: pattern.support.participants,
      supportRows: pattern.support.rows,
      averageCorrelation: pattern.support.avgCorrelation,
      averageNormalizedRmse: pattern.support.avgNormalizedRmse,
      averageValidatorScore: pattern.support.avgValidatorScore,
      averageEffectiveScore: pattern.support.avgEffectiveScore,
      promoted: promotedKeys.has(pattern.patternKey),
      dominantSlot: dominantSlotEntry?.[0] ?? null,
      dominantSlotSupport,
      slotFrequencies: [...slotFrequencies.entries()].map(([slotIndex, count]) => ({ slotIndex, count })),
      recommendedSlots: (pattern.rawWindowCandidates ?? [])
        .map((candidate) => candidate.slotIndex)
        .filter((value, index, array) => array.indexOf(value) === index),
      transform: buildTransformSummary(topMatches),
    };
  });

  return {
    replayId,
    gameVersion,
    versionGroup,
    replayEntries,
  };
}

function summarizeGroup(patternKey, entries, replayCountByVersionGroup) {
  const confidenceValues = entries.map((entry) => entry.confidence);
  const participantValues = entries.map((entry) => entry.supportParticipants);
  const rowValues = entries.map((entry) => entry.supportRows);
  const correlationValues = entries.map((entry) => entry.averageCorrelation);
  const rmseValues = entries.map((entry) => entry.averageNormalizedRmse);
  const validatorValues = entries.map((entry) => entry.averageValidatorScore);
  const effectiveValues = entries.map((entry) => entry.averageEffectiveScore);
  const rowStarts = entries.map((entry) => entry.rowBand[0]);
  const rowEnds = entries.map((entry) => entry.rowBand[1]);
  const slopes = entries.map((entry) => entry.transform.slopeMedian).filter(Number.isFinite);
  const intercepts = entries.map((entry) => entry.transform.interceptMedian).filter(Number.isFinite);
  const slotCounts = new Map();
  for (const entry of entries) {
    for (const slot of entry.recommendedSlots) {
      slotCounts.set(slot, (slotCounts.get(slot) ?? 0) + 1);
    }
  }

  const versionGroupEntries = new Map();
  for (const entry of entries) {
    const list = versionGroupEntries.get(entry.versionGroup) ?? [];
    list.push(entry);
    versionGroupEntries.set(entry.versionGroup, list);
  }

  let heldOutEligible = 0;
  let heldOutHits = 0;
  for (const [versionGroup, groupEntries] of versionGroupEntries.entries()) {
    const replayCount = replayCountByVersionGroup.get(versionGroup) ?? 0;
    if (replayCount < 2) {
      continue;
    }

    for (const entry of groupEntries) {
      const trainEntries = groupEntries.filter((candidate) => candidate.replayId !== entry.replayId && qualifyReplayPattern(candidate));
      if (trainEntries.length === 0) {
        continue;
      }
      heldOutEligible += 1;
      if (qualifyReplayPattern(entry)) {
        heldOutHits += 1;
      }
    }
  }

  const heldOutRate = heldOutEligible > 0 ? heldOutHits / heldOutEligible : null;
  const promotedReplayCount = entries.filter((entry) => entry.promoted).length;
  const recommendedSlots = [...slotCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, 8)
    .map(([slotIndex, count]) => ({ slotIndex, replayCount: count }));

  const exemplar = entries[0];
  const confidence =
    average(confidenceValues) *
    (0.5 + Math.min(1, entries.length / 3)) *
    (0.5 + Math.min(1, promotedReplayCount / 2)) *
    (heldOutRate == null ? 0.9 : (0.5 + heldOutRate));

  return {
    patternKey,
    familyKey: exemplar.familyKey,
    family: exemplar.family,
    familyLength: exemplar.familyLength,
    familyFirstByte: exemplar.familyFirstByte,
    metric: exemplar.metric,
    metricLabel: exemplar.metricLabel,
    decode: exemplar.decode,
    offset: exemplar.offset,
    rowArchetype: mode(entries.map((entry) => entry.rowArchetype)) ?? "unknown",
    recommendedRowBand: [Math.round(median(rowStarts)), Math.round(median(rowEnds))],
    recommendedSlots,
    confidence,
    transform: {
      slopeMedian: median(slopes),
      interceptMedian: median(intercepts),
      sampleCount: slopes.length,
    },
    support: {
      replays: entries.length,
      promotedReplays: promotedReplayCount,
      versionGroups: [...new Set(entries.map((entry) => entry.versionGroup))],
      replayIds: entries.map((entry) => entry.replayId),
      medianParticipants: median(participantValues),
      medianRows: median(rowValues),
      medianCorrelation: median(correlationValues),
      medianNormalizedRmse: median(rmseValues),
      medianValidatorScore: median(validatorValues),
      medianEffectiveScore: median(effectiveValues),
      heldOutEligible,
      heldOutHits,
      heldOutRate,
    },
    perReplay: entries
      .sort((left, right) => right.confidence - left.confidence)
      .map((entry) => ({
        replayId: entry.replayId,
        gameVersion: entry.gameVersion,
        versionGroup: entry.versionGroup,
        confidence: entry.confidence,
        promoted: entry.promoted,
        rowBand: entry.rowBand,
        supportParticipants: entry.supportParticipants,
        averageCorrelation: entry.averageCorrelation,
        averageNormalizedRmse: entry.averageNormalizedRmse,
        averageValidatorScore: entry.averageValidatorScore,
        dominantSlot: entry.dominantSlot,
        dominantSlotSupport: entry.dominantSlotSupport,
        transform: entry.transform,
      })),
  };
}

function promoteGroup(group, minReplaySupport, minMedianParticipants) {
  return (
    group.support.replays >= minReplaySupport &&
    group.support.medianParticipants >= minMedianParticipants &&
    group.support.medianCorrelation >= 0.55 &&
    group.support.medianNormalizedRmse <= 0.9 &&
    group.support.medianValidatorScore >= 0.7 &&
    (group.support.heldOutEligible === 0 || group.support.heldOutRate >= 0.5) &&
    group.transform.sampleCount >= 2
  );
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const corpusManifestPath = args.corpusManifest
    ? resolveAbsolute(repoRoot, args.corpusManifest)
    : path.join(artifactRoot, "corpus-manifest.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "corpus-schema.json");

  if (!fs.existsSync(corpusManifestPath)) {
    throw new Error(`Corpus manifest not found at ${corpusManifestPath}`);
  }

  const corpusManifest = readJson(corpusManifestPath);
  const replayArtifacts = [];
  for (const processed of corpusManifest.processed ?? []) {
    const artifactDir = processed.artifactDir ?? path.join(artifactRoot, processed.replayName.replace(/\.rofl$/i, ""));
    const replayArtifact = loadReplayEntries(artifactDir, args.maxRankedPatterns);
    if (replayArtifact) {
      replayArtifacts.push(replayArtifact);
    }
  }

  if (replayArtifacts.length === 0) {
    throw new Error(`No replay artifacts with provisional schema data were found from ${corpusManifestPath}`);
  }

  const replayCountByVersionGroup = new Map();
  for (const replayArtifact of replayArtifacts) {
    replayCountByVersionGroup.set(
      replayArtifact.versionGroup,
      (replayCountByVersionGroup.get(replayArtifact.versionGroup) ?? 0) + 1,
    );
  }

  const patternGroups = new Map();
  for (const replayArtifact of replayArtifacts) {
    for (const entry of replayArtifact.replayEntries) {
      const list = patternGroups.get(entry.patternKey) ?? [];
      list.push(entry);
      patternGroups.set(entry.patternKey, list);
    }
  }

  const rankedPatterns = [...patternGroups.entries()]
    .map(([patternKey, entries]) => summarizeGroup(patternKey, entries, replayCountByVersionGroup))
    .sort((left, right) =>
      right.confidence - left.confidence ||
      right.support.replays - left.support.replays ||
      right.support.medianCorrelation - left.support.medianCorrelation,
    );

  const promotedPatterns = rankedPatterns.filter((group) => promoteGroup(group, args.minReplaySupport, args.minMedianParticipants));

  const corpusSchema = {
    generatedAtUtc: new Date().toISOString(),
    source: {
      artifactRoot,
      corpusManifestPath,
      replayCount: replayArtifacts.length,
    },
    thresholds: {
      minReplaySupport: args.minReplaySupport,
      minMedianParticipants: args.minMedianParticipants,
      minMedianCorrelation: 0.55,
      maxMedianNormalizedRmse: 0.9,
      minMedianValidatorScore: 0.7,
      minHeldOutRate: 0.5,
      minTransformSamples: 2,
    },
    versionGroups: [...replayCountByVersionGroup.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([versionGroup, replayCount]) => ({ versionGroup, replayCount })),
    promotedPatterns,
    rankedPatterns: rankedPatterns.slice(0, 128),
  };

  writeJson(outputPath, corpusSchema);
  console.log(`Wrote corpus schema to ${outputPath}`);
  console.log(`Promoted ${promotedPatterns.length} corpus patterns from ${rankedPatterns.length} ranked patterns.`);
}

main();
