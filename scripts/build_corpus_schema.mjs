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
import {
  loadBundleFamilyArtifacts,
  parseBundlePatternKey,
} from "./lib/scalar-bundle-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    corpusManifest: null,
    outputPath: null,
    maxRankedPatterns: 128,
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

function computeRowCenter(rowBand) {
  return (rowBand[0] + rowBand[1]) / 2;
}

function computeRowSpan(rowBand) {
  return Math.max(0, rowBand[1] - rowBand[0]);
}

function buildAliasClusterKey(entry) {
  const centerBucket = Math.round(computeRowCenter(entry.rowBand) / 4);
  return `${entry.versionGroup}|${entry.metric}|${entry.rowArchetype}|c${centerBucket}`;
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

function compareScoreVectors(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    if (leftValue === rightValue) {
      continue;
    }
    return leftValue - rightValue;
  }
  return 0;
}

function qualifyReplayPattern(entry) {
  return (
    entry.supportParticipants >= 6 &&
    entry.averageCorrelation >= 0.5 &&
    entry.averageNormalizedRmse <= 1.0 &&
    entry.averageValidatorScore >= 0.6
  );
}

function summarizeAliasCluster(aliasClusterKey, entries, replayCountByVersionGroup) {
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
  const transformSampleCount = entries.reduce((sum, entry) => sum + (entry.transform.sampleCount ?? 0), 0);
  const familyKeys = [...new Set(entries.map((entry) => entry.familyKey))];
  const replayIds = [...new Set(entries.map((entry) => entry.replayId))];
  const versionGroups = [...new Set(entries.map((entry) => entry.versionGroup))];

  const versionGroup = versionGroups[0] ?? "unknown";
  const replayCount = replayCountByVersionGroup.get(versionGroup) ?? 0;
  let heldOutEligible = 0;
  let heldOutHits = 0;
  if (replayCount >= 2) {
    for (const entry of entries) {
      const trainEntries = entries.filter((candidate) => candidate.replayId !== entry.replayId && qualifyReplayPattern(candidate));
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
  const exemplar = [...entries].sort((left, right) => right.confidence - left.confidence)[0];
  const confidence =
    average(confidenceValues) *
    (0.6 + Math.min(1, replayIds.length / 2)) *
    (0.6 + Math.min(1, familyKeys.length / 2)) *
    (heldOutRate == null ? 0.95 : (0.5 + heldOutRate));

  return {
    aliasClusterKey,
    versionGroup,
    metric: exemplar.metric,
    metricLabel: exemplar.metricLabel,
    rowArchetype: mode(entries.map((entry) => entry.rowArchetype)) ?? "unknown",
    recommendedRowBand: [Math.round(median(rowStarts)), Math.round(median(rowEnds))],
    confidence,
    support: {
      replays: replayIds.length,
      replayIds,
      families: familyKeys,
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
    transform: {
      slopeMedian: median(slopes),
      interceptMedian: median(intercepts),
      sampleCount: transformSampleCount,
    },
  };
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
      transform: pattern.transform?.sampleCount > 0 ? pattern.transform : buildTransformSummary(topMatches),
    };
  });

  return {
    replayId,
    gameVersion,
    versionGroup,
    replayEntries,
  };
}

function buildBundleFamilyPatternKey(versionGroup, familyKey, metric) {
  return `bundle-family|${versionGroup}|${familyKey}|${metric}`;
}

function loadBundleReplayEntries(artifactDir) {
  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const summaryPath = path.join(artifactDir, "summary.json");
  const extractedStatsPath = path.join(artifactDir, "extracted-stats.json");
  const validationReportPath = path.join(artifactDir, "validation-report.json");
  if (!fs.existsSync(runManifestPath) || !fs.existsSync(summaryPath) || !fs.existsSync(extractedStatsPath) || !fs.existsSync(validationReportPath)) {
    return [];
  }

  const runManifest = readJson(runManifestPath);
  const summaryJson = readJson(summaryPath);
  const extractedStats = readJson(extractedStatsPath);
  const validationReport = readJson(validationReportPath);
  const replayId = runManifest.replayId;
  const gameVersion = getReplayGameVersion(runManifest, summaryJson);
  const versionGroup = parseVersionGroup(gameVersion);
  const artifactRoot = path.dirname(artifactDir);
  const familySummaryByKey = new Map((runManifest.families ?? []).map((family) => [family.familyKey, family]));
  const validationParticipantByRosterIndex = new Map((validationReport.participants ?? []).map((participant) => [participant.rosterIndex, participant]));

  const replayEntryByKey = new Map();
  for (const selectedPattern of extractedStats.selectedPatterns ?? []) {
    if (selectedPattern.source !== "bundle-recommended" && selectedPattern.source !== "bundle-promoted") {
      continue;
    }

    const descriptor = parseBundlePatternKey(selectedPattern.patternKey);
    if (!descriptor) {
      continue;
    }

    const familySummary = familySummaryByKey.get(selectedPattern.familyKey) ?? null;
    const bundleArtifacts = loadBundleFamilyArtifacts(artifactRoot, versionGroup, selectedPattern.familyKey);
    const bundleEntry = bundleArtifacts?.bundleCatalog?.bundles?.[descriptor.bundleIndex] ?? null;
    const metricBundleEntry = bundleEntry?.metrics?.find((entry) => entry.metric === selectedPattern.metric) ?? null;

    const participantMetricRecords = [];
    for (const participant of extractedStats.participants ?? []) {
      const metricRecord = participant.metrics?.[selectedPattern.metric];
      if (!metricRecord || metricRecord.familyKey !== selectedPattern.familyKey) {
        continue;
      }
      const validationParticipant = validationParticipantByRosterIndex.get(participant.rosterIndex);
      const validationMetric = validationParticipant?.metrics?.[selectedPattern.metric] ?? null;
      participantMetricRecords.push({
        rosterIndex: participant.rosterIndex,
        slotIndex: metricRecord.slotIndex,
        metricRecord,
        validationMetric,
      });
    }

    if (participantMetricRecords.length === 0) {
      continue;
    }

    const slotCounts = new Map();
    for (const record of participantMetricRecords) {
      slotCounts.set(record.slotIndex, (slotCounts.get(record.slotIndex) ?? 0) + 1);
    }
    const dominantSlotEntry = [...slotCounts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0] ?? null;

    const validationMetrics = participantMetricRecords
      .map((record) => record.validationMetric)
      .filter(Boolean);
    const passCount = validationMetrics.filter((metric) => metric.passes).length;
    const avgCorrelation = average(validationMetrics.map((metric) => metric.correlation).filter(Number.isFinite));
    const avgNormalizedRmse = average(validationMetrics.map((metric) => metric.normalizedRmse).filter(Number.isFinite));
    const avgValidatorScore = validationMetrics.length > 0
      ? average(validationMetrics.map((metric) => metric.passes ? 1 : 0))
      : 0;
    const avgEffectiveScore = validationMetrics.length > 0
      ? average(validationMetrics.map((metric) => {
        const corr = Number.isFinite(metric.correlation) ? Math.max(0, metric.correlation) : 0;
        const rmsePenalty = Number.isFinite(metric.normalizedRmse) ? Math.min(1.5, metric.normalizedRmse) : 1.5;
        return corr * Math.max(0, 1.2 - rmsePenalty);
      }))
      : 0;
    const bundleScore = bundleEntry?.bundleScore ?? bundleArtifacts?.recommendation?.primaryBundle?.bundleScore ?? 0;
    const replayOverlap = bundleEntry?.replayOverlap ?? bundleArtifacts?.recommendation?.primaryBundle?.replayOverlap ?? 0;
    const strongMetricCount = bundleEntry?.strongMetricCount ?? bundleArtifacts?.recommendation?.primaryBundle?.strongMetricCount ?? 0;
    const recommendedSlots = selectedPattern.recommendedSlots ?? [];
    const recommendedRowBand = selectedPattern.recommendedRowBand ?? [0, 0];
    const confidenceBoost = (0.82 + (0.18 * Math.min(1, bundleScore))) * (0.7 + (0.3 * Math.min(1, replayOverlap)));

    const replayEntry = {
      replayId,
      gameVersion,
      versionGroup,
      patternKey: buildBundleFamilyPatternKey(versionGroup, selectedPattern.familyKey, selectedPattern.metric),
      sourcePatternKey: selectedPattern.patternKey,
      familyKey: selectedPattern.familyKey,
      family: familySummary ? `${familySummary.length} / 0x${familySummary.firstByte.toString(16).toUpperCase().padStart(2, "0")}` : selectedPattern.familyKey,
      familyLength: familySummary?.length ?? null,
      familyFirstByte: familySummary?.firstByte ?? null,
      offset: descriptor.offset,
      decode: descriptor.decode,
      metric: selectedPattern.metric,
      metricLabel: selectedPattern.metric,
      rowArchetype: "bundle_state_like",
      rowBand: recommendedRowBand,
      confidence: selectedPattern.confidence * confidenceBoost,
      supportParticipants: participantMetricRecords.length,
      supportRows: slotCounts.size,
      averageCorrelation: avgCorrelation,
      averageNormalizedRmse: avgNormalizedRmse,
      averageValidatorScore: avgValidatorScore,
      averageEffectiveScore: avgEffectiveScore,
      promoted: passCount > 0,
      dominantSlot: dominantSlotEntry?.[0] ?? null,
      dominantSlotSupport: dominantSlotEntry ? dominantSlotEntry[1] / participantMetricRecords.length : 0,
      slotFrequencies: [...slotCounts.entries()].map(([slotIndex, count]) => ({ slotIndex, count })),
      recommendedSlots: recommendedSlots
        .map((slot) => slot.slotIndex)
        .filter((value, index, array) => array.indexOf(value) === index),
      transform: selectedPattern.transform ?? { slopeMedian: 1, interceptMedian: 0, sampleCount: 0 },
      bundleSupport: {
        bundleIndex: descriptor.bundleIndex,
        bundleScore,
        replayOverlap,
        strongMetricCount,
        metricReplaySupport: metricBundleEntry?.replaySupport ?? 0,
        metricMedianParticipants: metricBundleEntry?.medianParticipants ?? 0,
        passCount,
      },
    };

    const existing = replayEntryByKey.get(replayEntry.patternKey);
    if (!existing) {
      replayEntryByKey.set(replayEntry.patternKey, replayEntry);
      continue;
    }

    const existingScore = [
      existing.bundleSupport?.passCount ?? 0,
      existing.averageValidatorScore ?? 0,
      existing.averageCorrelation ?? -1,
      -(existing.averageNormalizedRmse ?? Number.POSITIVE_INFINITY),
      existing.averageEffectiveScore ?? 0,
      existing.confidence ?? 0,
    ];
    const nextScore = [
      replayEntry.bundleSupport?.passCount ?? 0,
      replayEntry.averageValidatorScore ?? 0,
      replayEntry.averageCorrelation ?? -1,
      -(replayEntry.averageNormalizedRmse ?? Number.POSITIVE_INFINITY),
      replayEntry.averageEffectiveScore ?? 0,
      replayEntry.confidence ?? 0,
    ];
    if (compareScoreVectors(nextScore, existingScore) > 0) {
      replayEntryByKey.set(replayEntry.patternKey, replayEntry);
    }
  }

  return [...replayEntryByKey.values()];
}

function summarizeGroup(patternKey, entries, replayCountByVersionGroup, aliasSupport = null) {
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
  const transformSampleCount = entries.reduce((sum, entry) => sum + (entry.transform.sampleCount ?? 0), 0);
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
  const bundleEntries = entries.filter((entry) => entry.bundleSupport);

  const exemplar = entries[0];
  const baseConfidence =
    average(confidenceValues) *
    (0.5 + Math.min(1, entries.length / 3)) *
    (0.5 + Math.min(1, promotedReplayCount / 2)) *
    (heldOutRate == null ? 0.9 : (0.5 + heldOutRate));
  const aliasBoost = aliasSupport
    ? (
      0.9 +
      Math.min(0.3, 0.08 * aliasSupport.support.replays) +
      (0.1 * Math.min(1, aliasSupport.support.medianCorrelation))
    )
    : 1;
  const confidence = baseConfidence * aliasBoost;

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
      sampleCount: transformSampleCount,
    },
    sourceType: bundleEntries.length > 0 ? "bundle-family" : "exact-pattern",
    bundleSupport: bundleEntries.length > 0
      ? {
        bundleScore: median(bundleEntries.map((entry) => entry.bundleSupport.bundleScore ?? 0)),
        replayOverlap: median(bundleEntries.map((entry) => entry.bundleSupport.replayOverlap ?? 0)),
        strongMetricCount: median(bundleEntries.map((entry) => entry.bundleSupport.strongMetricCount ?? 0)),
        metricReplaySupport: median(bundleEntries.map((entry) => entry.bundleSupport.metricReplaySupport ?? 0)),
        metricMedianParticipants: median(bundleEntries.map((entry) => entry.bundleSupport.metricMedianParticipants ?? 0)),
        passCount: bundleEntries.reduce((sum, entry) => sum + (entry.bundleSupport.passCount ?? 0), 0),
      }
      : null,
    aliasSupport: aliasSupport
      ? {
        aliasClusterKey: aliasSupport.aliasClusterKey,
        versionGroup: aliasSupport.versionGroup,
        confidence: aliasSupport.confidence,
        recommendedRowBand: aliasSupport.recommendedRowBand,
        support: aliasSupport.support,
      }
      : null,
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
  const aliasSupport = group.aliasSupport?.support ?? null;
  const crossReplaySupport = Math.max(group.support.replays, aliasSupport?.replays ?? 0);
  const participantSupport = Math.max(group.support.medianParticipants, aliasSupport?.medianParticipants ?? 0);
  const correlationSupport = Math.max(group.support.medianCorrelation, aliasSupport?.medianCorrelation ?? 0);
  const rmseSupport = Math.min(group.support.medianNormalizedRmse, aliasSupport?.medianNormalizedRmse ?? Number.POSITIVE_INFINITY);
  const validatorSupport = Math.max(group.support.medianValidatorScore, aliasSupport?.medianValidatorScore ?? 0);
  const heldOutEligible = Math.max(group.support.heldOutEligible, aliasSupport?.heldOutEligible ?? 0);
  const heldOutRate = aliasSupport?.heldOutRate ?? group.support.heldOutRate;

  return (
    crossReplaySupport >= minReplaySupport &&
    participantSupport >= minMedianParticipants &&
    group.support.medianCorrelation >= 0.5 &&
    group.support.medianNormalizedRmse <= 1.0 &&
    group.support.medianValidatorScore >= 0.6 &&
    correlationSupport >= 0.55 &&
    rmseSupport <= 0.9 &&
    validatorSupport >= 0.7 &&
    (heldOutEligible === 0 || heldOutRate >= 0.5) &&
    group.transform.sampleCount >= 2
  );
}

function promoteBundleGroup(group) {
  const bundleSupport = group.bundleSupport ?? null;
  if (!bundleSupport) {
    return false;
  }

  const normalizedRmseLimit =
    (bundleSupport.passCount ?? 0) >= 2 && (group.support.medianCorrelation ?? 0) >= 0.5
      ? 1.25
      : 1.2;

  return (
    group.support.promotedReplays >= 1 &&
    group.support.medianParticipants >= 1 &&
    group.support.medianCorrelation >= 0.3 &&
    group.support.medianNormalizedRmse <= normalizedRmseLimit &&
    bundleSupport.bundleScore >= 0.84 &&
    bundleSupport.replayOverlap >= 0.4 &&
    bundleSupport.strongMetricCount >= 3 &&
    group.transform.sampleCount >= 1
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
  const bundleReplayEntries = [];
  for (const processed of corpusManifest.processed ?? []) {
    const artifactDir = processed.artifactDir ?? path.join(artifactRoot, processed.replayName.replace(/\.rofl$/i, ""));
    const replayArtifact = loadReplayEntries(artifactDir, args.maxRankedPatterns);
    if (replayArtifact) {
      replayArtifacts.push(replayArtifact);
    }
    bundleReplayEntries.push(...loadBundleReplayEntries(artifactDir));
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
  const aliasClusterGroups = new Map();
  for (const replayArtifact of replayArtifacts) {
    for (const entry of replayArtifact.replayEntries) {
      const list = patternGroups.get(entry.patternKey) ?? [];
      list.push(entry);
      patternGroups.set(entry.patternKey, list);

      const aliasClusterKey = buildAliasClusterKey(entry);
      const aliasList = aliasClusterGroups.get(aliasClusterKey) ?? [];
      aliasList.push(entry);
      aliasClusterGroups.set(aliasClusterKey, aliasList);
    }
  }

  const aliasClusterSummaries = new Map(
    [...aliasClusterGroups.entries()].map(([aliasClusterKey, entries]) => [
      aliasClusterKey,
      summarizeAliasCluster(aliasClusterKey, entries, replayCountByVersionGroup),
    ]),
  );

  const aliasSupportByEntryKey = new Map();
  for (const replayArtifact of replayArtifacts) {
    for (const entry of replayArtifact.replayEntries) {
      const aliasClusterKey = buildAliasClusterKey(entry);
      const aliasSummary = aliasClusterSummaries.get(aliasClusterKey) ?? null;
      aliasSupportByEntryKey.set(`${entry.replayId}|${entry.sourcePatternKey}`, aliasSummary);
    }
  }

  const rankedPatterns = [...patternGroups.entries()]
    .map(([patternKey, entries]) => {
      const aliasCandidates = entries
        .map((entry) => aliasSupportByEntryKey.get(`${entry.replayId}|${entry.sourcePatternKey}`))
        .filter(Boolean);
      const aliasSupport = aliasCandidates.sort((left, right) =>
        right.support.replays - left.support.replays ||
        right.support.medianCorrelation - left.support.medianCorrelation ||
        right.confidence - left.confidence,
      )[0] ?? null;
      return summarizeGroup(patternKey, entries, replayCountByVersionGroup, aliasSupport);
    })
    .sort((left, right) =>
      right.confidence - left.confidence ||
      right.support.replays - left.support.replays ||
      right.support.medianCorrelation - left.support.medianCorrelation,
    );

  const promotedPatterns = rankedPatterns.filter((group) => promoteGroup(group, args.minReplaySupport, args.minMedianParticipants));
  const bundlePatternGroups = new Map();
  for (const entry of bundleReplayEntries) {
    const list = bundlePatternGroups.get(entry.patternKey) ?? [];
    list.push(entry);
    bundlePatternGroups.set(entry.patternKey, list);
  }
  const bundleRankedPatterns = [...bundlePatternGroups.entries()]
    .map(([patternKey, entries]) => summarizeGroup(patternKey, entries, replayCountByVersionGroup, null))
    .sort((left, right) =>
      right.confidence - left.confidence ||
      right.support.promotedReplays - left.support.promotedReplays ||
      right.support.medianCorrelation - left.support.medianCorrelation
    );
  const bundlePromotedPatterns = bundleRankedPatterns.filter((group) => promoteBundleGroup(group));

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
    aliasClusters: [...aliasClusterSummaries.values()]
      .filter((cluster) => cluster.support.replays >= 2)
      .sort((left, right) =>
        right.support.replays - left.support.replays ||
        right.support.medianCorrelation - left.support.medianCorrelation ||
        right.confidence - left.confidence,
      )
      .slice(0, 128),
    promotedPatterns,
    rankedPatterns: rankedPatterns.slice(0, 128),
    bundlePromotedPatterns,
    bundleRankedPatterns: bundleRankedPatterns.slice(0, 64),
  };

  writeJson(outputPath, corpusSchema);
  console.log(`Wrote corpus schema to ${outputPath}`);
  console.log(`Promoted ${promotedPatterns.length} corpus patterns from ${rankedPatterns.length} ranked patterns.`);
  console.log(`Promoted ${bundlePromotedPatterns.length} bundle-backed patterns from ${bundleRankedPatterns.length} ranked bundle patterns.`);
}

main();
