import fs from "fs";
import path from "path";

import {
  buildFieldIndex,
  buildSummaryRoster,
  clamp,
  fieldSamplesToSeries,
  lastFiniteValue,
  median,
  parseVersionGroup,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";
import {
  addFamilySupportTrust as addFamilySupportTrustToMap,
  buildBundleRecommendedPatterns as buildBundleRecommendedPatternsFromUtils,
  bundleSupportMetricKeys as bundleSupportMetricKeysFromUtils,
  evaluateSiblingAnchorCompatibility,
  isBundleSlotTrusted as isBundleSlotTrustedBySupport,
  resolveLayoutSlotCluster,
  siblingAnchorMetric,
  volatileBundleMetricKeys,
} from "./lib/scalar-bundle-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactDir: null,
    schemaPath: "artifacts/corpus-schema.json",
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-dir" && index + 1 < argv.length) {
      args.artifactDir = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
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

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/extract_replay_stats.mjs --artifact-dir <path> [--schema-path <path>] [--output-path <path>]");
}

function buildSchemaFingerprint(schema) {
  if (!schema || typeof schema !== "object") {
    return null;
  }

  return JSON.stringify({
    ...schema,
    generatedAtUtc: null,
    aliasClusters: null,
    rankedPatterns: null,
    bundleRankedPatterns: null,
  });
}

function normalizeRecordTransform(transform, seriesLength) {
  if (!transform || typeof transform !== "object") {
    return null;
  }

  const boundedSampleCount = Number.isFinite(transform.sampleCount)
    ? Math.max(0, Math.min(transform.sampleCount, Math.max(0, seriesLength)))
    : 0;

  return {
    slopeMedian: Number.isFinite(transform.slopeMedian) ? transform.slopeMedian : 1,
    interceptMedian: Number.isFinite(transform.interceptMedian) ? transform.interceptMedian : 0,
    sampleCount: boundedSampleCount,
  };
}

function scoreMetricValue(metricKey, expected, actual) {
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) {
    return 0;
  }

  const diff = Math.abs(actual - expected);
  switch (metricKey) {
    case "level":
      return Math.max(0, 1 - (diff / 2));
    case "totalGold":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 900)));
    case "xp":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 800)));
    case "minionsKilled":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.3, 25)));
    case "jungleMinionsKilled":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.4, 12)));
    case "healthMax":
    case "powerMax":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.3, 120)));
    case "health":
    case "power":
    case "currentGold":
      return Math.max(0, 1 - (diff / Math.max(expected * 0.5, 150)));
    default:
      return Math.max(0, 1 - (diff / Math.max(expected * 0.35, 100)));
  }
}

function isMetricAssignable(metricKey, roster) {
  return roster.some((entry) => Number.isFinite(entry.finalMetrics?.[metricKey]));
}

function derivePatternTransform(pattern, candidateMatches) {
  const matches = (candidateMatches?.topMatches ?? []).filter((match) =>
    match.familyKey === pattern.familyKey &&
    match.offset === pattern.offset &&
    match.decodeLabel === pattern.decode &&
    match.metricKey === pattern.metric,
  );

  const slopes = matches.map((match) => match.slope).filter(Number.isFinite);
  const intercepts = matches.map((match) => match.intercept).filter(Number.isFinite);
  return {
    slopeMedian: slopes.length > 0 ? median(slopes) : 1,
    interceptMedian: intercepts.length > 0 ? median(intercepts) : 0,
    sampleCount: slopes.length,
  };
}

function getMetricBounds(metricKey) {
  switch (metricKey) {
    case "level":
      return { min: 1, max: 18 };
    case "currentGold":
      return { min: 0, max: 5000 };
    case "totalGold":
      return { min: 0, max: 30000 };
    case "xp":
      return { min: 0, max: 40000 };
    case "minionsKilled":
      return { min: 0, max: 500 };
    case "jungleMinionsKilled":
      return { min: 0, max: 350 };
    case "health":
      return { min: 0, max: 8000 };
    case "healthMax":
      return { min: 200, max: 9000 };
    case "power":
      return { min: 0, max: 4000 };
    case "powerMax":
      return { min: 0, max: 5000 };
    case "movementSpeed":
      return { min: 120, max: 1200 };
    default:
      return null;
  }
}

function computeSelectionScore(source, pattern) {
  const confidence = pattern.confidence ?? 0;
  switch (source) {
    case "bundle-promoted":
      return confidence + 0.42 + (0.06 * Math.min(3, pattern.bundleSupport?.strongMetricCount ?? 0));
    case "bundle-recommended": {
      let score = confidence + 0.02 + (0.03 * Math.min(3, pattern.bundleSupport?.strongMetricCount ?? 0));
      if ((pattern.bundleSupport?.passCount ?? 0) > 0) {
        score += 0.08;
      }
      if (
        (pattern.bundleSupport?.passCount ?? 0) === 0 &&
        (volatileBundleMetricKeys.has(pattern.metric) || pattern.metric === "movementSpeed")
      ) {
        score -= 0.06;
      }
      return score;
    }
    case "replay-promoted":
      return confidence + 0.25;
    case "corpus-promoted":
      return confidence + 0.12 + (0.02 * Math.min(3, pattern.aliasSupport?.support?.replays ?? pattern.support?.replays ?? 0));
    case "replay-ranked":
      return confidence + 0.05;
    case "corpus-ranked":
      return confidence + 0.02 + (0.01 * Math.min(3, pattern.support?.replays ?? 0));
    case "candidate-ranked":
      return confidence + 0.22 + (0.03 * Math.min(1, pattern.transform?.sampleCount ?? 0));
    default:
      return confidence;
  }
}

function parsePatternDescriptor(groupKey) {
  const [versionGroup, familyKey, offsetText, decode] = String(groupKey ?? "").split("|");
  const offset = Number.parseInt(offsetText, 10);
  if (!versionGroup || !familyKey || !Number.isFinite(offset) || !decode) {
    return null;
  }

  return {
    versionGroup,
    familyKey,
    offset,
    decode,
  };
}

const bundleSupportMetricKeys = new Set([
  "level",
  "xp",
  "totalGold",
  "currentGold",
  "minionsKilled",
  "jungleMinionsKilled",
]);

function uniqueSortedNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
}

function appendMapList(map, key, value) {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function collectPatternSlots(pattern) {
  const directSlots = (pattern.rawWindowCandidates ?? [])
    .map((candidate) => candidate.slotIndex)
    .filter(Number.isFinite);
  if (directSlots.length > 0) {
    return uniqueSortedNumbers(directSlots);
  }

  const [rowStart, rowEnd] = pattern.rowBand ?? [];
  if (Number.isFinite(rowStart) && Number.isFinite(rowEnd)) {
    const slots = [];
    for (let slotIndex = rowStart; slotIndex <= rowEnd; slotIndex += 1) {
      slots.push(slotIndex);
    }
    return uniqueSortedNumbers(slots);
  }

  return [];
}

function scoreBundleClusterMatch(localPattern, corpusPattern) {
  const localSlots = uniqueSortedNumbers(
    (localPattern.recommendedSlots ?? [])
      .map((slot) => slot.slotIndex)
      .filter(Number.isFinite),
  );
  const corpusSlots = uniqueSortedNumbers(
    (corpusPattern.recommendedSlots ?? [])
      .map((slot) => slot.slotIndex)
      .filter(Number.isFinite),
  );
  const exactOverlap = localSlots.filter((slotIndex) => corpusSlots.includes(slotIndex)).length;
  const nearOverlap = localSlots.filter((slotIndex) =>
    corpusSlots.some((candidate) => Math.abs(candidate - slotIndex) <= 1),
  ).length;
  const localBand = localPattern.recommendedRowBand ?? localPattern.rowBand ?? [0, 0];
  const corpusBand = corpusPattern.recommendedRowBand ?? corpusPattern.rowBand ?? [0, 0];
  const localCenter = (localBand[0] + localBand[1]) / 2;
  const corpusCenter = (corpusBand[0] + corpusBand[1]) / 2;
  const centerDistance = Number.isFinite(localCenter) && Number.isFinite(corpusCenter)
    ? Math.abs(localCenter - corpusCenter)
    : 3;

  let score = corpusPattern.confidence ?? 0;
  if (exactOverlap > 0) {
    score += 0.35 + (0.06 * exactOverlap);
  } else if (nearOverlap > 0) {
    score += 0.18 + (0.04 * nearOverlap);
  } else {
    score -= Math.min(0.3, centerDistance * 0.08);
  }
  score += 0.04 * Math.min(3, corpusPattern.bundleSupport?.passCount ?? 0);
  score += 0.02 * Math.min(3, corpusPattern.bundleSupport?.strongMetricCount ?? 0);
  score -= Math.min(0.2, centerDistance * 0.03);
  return score;
}

function selectBestBundleClusterPattern(localPattern, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  return [...candidates]
    .sort((left, right) =>
      scoreBundleClusterMatch(localPattern, right) - scoreBundleClusterMatch(localPattern, left) ||
      (right.bundleSupport?.passCount ?? 0) - (left.bundleSupport?.passCount ?? 0) ||
      (right.confidence ?? 0) - (left.confidence ?? 0),
    )[0] ?? null;
}

function collectPatternRecommendedSlots(pattern) {
  const recommendedSlots = uniqueSortedNumbers(
    (pattern?.recommendedSlots ?? [])
      .map((slot) => slot.slotIndex)
      .filter(Number.isFinite),
  );
  if (recommendedSlots.length > 0) {
    return recommendedSlots;
  }

  const slotClusterBand = Array.isArray(pattern?.slotClusterBand) ? pattern.slotClusterBand : null;
  if (slotClusterBand && Number.isFinite(slotClusterBand[0]) && Number.isFinite(slotClusterBand[1])) {
    const slots = [];
    for (let slotIndex = slotClusterBand[0]; slotIndex <= slotClusterBand[1]; slotIndex += 1) {
      slots.push(slotIndex);
    }
    return uniqueSortedNumbers(slots);
  }

  const [rowStart, rowEnd] = pattern?.recommendedRowBand ?? pattern?.rowBand ?? [];
  if (Number.isFinite(rowStart) && Number.isFinite(rowEnd)) {
    const slots = [];
    for (let slotIndex = rowStart; slotIndex <= rowEnd; slotIndex += 1) {
      slots.push(slotIndex);
    }
    return uniqueSortedNumbers(slots);
  }

  return [];
}

function patternSlotDistance(leftPattern, rightPattern) {
  const leftSlots = collectPatternRecommendedSlots(leftPattern);
  const rightSlots = collectPatternRecommendedSlots(rightPattern);
  if (leftSlots.length === 0 || rightSlots.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let bestDistance = Number.POSITIVE_INFINITY;
  for (const leftSlot of leftSlots) {
    for (const rightSlot of rightSlots) {
      bestDistance = Math.min(bestDistance, Math.abs(leftSlot - rightSlot));
    }
  }
  return bestDistance;
}

function isStrongExactMovementSpeedCandidate(pattern) {
  return (
    pattern?.source === "candidate-ranked" &&
    pattern.metric === "movementSpeed" &&
    (pattern.matchScore ?? 0) >= 0.32 &&
    (pattern.confidence ?? 0) >= 0.5
  );
}

function shouldSuppressBundleMovementSpeedPattern(bundlePattern, exactCandidates) {
  if (bundlePattern.metric !== "movementSpeed") {
    return false;
  }

  return exactCandidates.some((candidate) =>
    candidate.familyKey === bundlePattern.familyKey &&
    patternSlotDistance(bundlePattern, candidate) <= 1,
  );
}

function buildBundleFamilySupportAnchors(localRankedPatterns, familyKey) {
  const supportPatterns = localRankedPatterns
    .filter((pattern) => pattern.familyKey === familyKey)
    .filter((pattern) => bundleSupportMetricKeys.has(pattern.metric))
    .filter((pattern) => (pattern.confidence ?? 0) >= 0.28);
  if (supportPatterns.length === 0) {
    return null;
  }

  const slotWeights = new Map();
  for (const pattern of supportPatterns) {
    const slots = collectPatternSlots(pattern);
    if (slots.length === 0) {
      continue;
    }
    const metricWeight = bundleSupportMetricKeys.has(pattern.metric) ? 1.15 : 1;
    const patternWeight = Math.max(0.05, (pattern.confidence ?? 0) * metricWeight);
    for (const slotIndex of slots) {
      slotWeights.set(slotIndex, (slotWeights.get(slotIndex) ?? 0) + patternWeight);
    }
  }

  const rankedSlots = [...slotWeights.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  if (rankedSlots.length === 0) {
    return null;
  }

  const primarySlot = rankedSlots[0][0];
  const anchorSlots = rankedSlots
    .filter(([slotIndex, weight]) =>
      Math.abs(slotIndex - primarySlot) <= 1 ||
      weight >= (rankedSlots[0][1] * 0.7),
    )
    .map(([slotIndex]) => slotIndex);
  const compactSlots = uniqueSortedNumbers(anchorSlots);
  if (compactSlots.length === 0) {
    return null;
  }

  return {
    slots: compactSlots,
    band: [compactSlots[0], compactSlots[compactSlots.length - 1]],
    supportMetricCount: new Set(supportPatterns.map((pattern) => pattern.metric)).size,
  };
}

function clampSlotsToAnchor(recommendedSlots, rowBand, supportAnchor) {
  if (!supportAnchor) {
    return { recommendedSlots, rowBand };
  }

  const allowedMin = supportAnchor.band[0] - 1;
  const allowedMax = supportAnchor.band[1] + 1;
  const clampedSlots = uniqueSortedNumbers(
    (recommendedSlots ?? [])
      .map((slot) => slot.slotIndex)
      .filter((slotIndex) => slotIndex >= allowedMin && slotIndex <= allowedMax),
  ).map((slotIndex) => ({ slotIndex, replayCount: 1 }));

  const bandStart = Number.isFinite(rowBand?.[0]) ? rowBand[0] : allowedMin;
  const bandEnd = Number.isFinite(rowBand?.[1]) ? rowBand[1] : allowedMax;
  const clampedBand = [
    Math.max(bandStart, allowedMin),
    Math.min(bandEnd, allowedMax),
  ];
  const normalizedBand = clampedBand[0] <= clampedBand[1]
    ? clampedBand
    : [supportAnchor.band[0], supportAnchor.band[1]];

  const normalizedSlots = clampedSlots.length > 0
    ? clampedSlots
    : supportAnchor.slots.map((slotIndex) => ({ slotIndex, replayCount: 1 }));

  return {
    recommendedSlots: normalizedSlots,
    rowBand: normalizedBand,
  };
}

function shouldPreserveStrongPowerLocalOverride(familyKey, metricKey, localOverride, supportAnchor) {
  if (metricKey !== "power" || !localOverride || !supportAnchor) {
    return false;
  }

  const overrideSlots = collectPatternSlots(localOverride);
  if (overrideSlots.length === 0) {
    return false;
  }

  const allowedMin = supportAnchor.band[0] - 1;
  const allowedMax = supportAnchor.band[1] + 1;
  const outsideSlots = overrideSlots.filter((slotIndex) => slotIndex < allowedMin || slotIndex > allowedMax);
  if (outsideSlots.length === 0) {
    return false;
  }

  const nearestDistance = Math.min(
    ...outsideSlots.map((slotIndex) =>
      Math.min(
        Math.abs(slotIndex - supportAnchor.band[0]),
        Math.abs(slotIndex - supportAnchor.band[1]),
      ),
    ),
  );
  if (familyKey === "6912-0xC6-h0") {
    if (nearestDistance > 4) {
      return false;
    }
    return (localOverride.confidence ?? 0) >= 0.44;
  }

  if (familyKey === "61894-0x00-h6") {
    const lateOutsideSlots = outsideSlots.filter((slotIndex) => slotIndex > allowedMax);
    if (lateOutsideSlots.length === 0 || lateOutsideSlots.length !== outsideSlots.length) {
      return false;
    }
    if (nearestDistance > 3) {
      return false;
    }
    return (
      (localOverride.matchScore ?? 0) >= 0.45 &&
      (localOverride.confidence ?? 0) >= 0.58
    );
  }

  return false;
}

function decodeCategory(decodeLabel) {
  if (String(decodeLabel).startsWith("f")) {
    return "float";
  }
  if (String(decodeLabel).startsWith("u")) {
    return "unsigned";
  }
  if (String(decodeLabel).startsWith("i")) {
    return "signed";
  }
  return "other";
}

function scoreLocalOverrideMatch(pattern, descriptor, supportAnchor) {
  let score = pattern.matchScore ?? pattern.support?.avgEffectiveScore ?? pattern.confidence ?? 0;
  score += 0.35 * (pattern.confidence ?? 0);
  if (pattern.decode === descriptor.decode) {
    score += 0.12;
  } else if (decodeCategory(pattern.decode) === decodeCategory(descriptor.decode)) {
    score += 0.05;
  }

  const offsetDistance = Math.abs((pattern.offset ?? descriptor.offset) - descriptor.offset);
  score -= Math.min(0.1, offsetDistance * 0.015);

  const patternSlots = collectPatternSlots(pattern);
  if (supportAnchor && patternSlots.length > 0) {
    const overlap = patternSlots.filter((slotIndex) => supportAnchor.slots.includes(slotIndex)).length;
    const nearOverlap = patternSlots.filter((slotIndex) =>
      supportAnchor.slots.some((supportSlot) => Math.abs(slotIndex - supportSlot) <= 1),
    ).length;
    if (overlap > 0) {
      score += 0.18;
    } else if (nearOverlap > 0) {
      score += 0.08;
    }

    if (descriptor.familyKey === "61894-0x00-h6" && pattern.metric === "power") {
      const lateOutsideSlots = patternSlots.filter((slotIndex) => slotIndex > (supportAnchor.band[1] + 1));
      const earlyOutsideSlots = patternSlots.filter((slotIndex) => slotIndex < (supportAnchor.band[0] - 1));
      if (
        lateOutsideSlots.length > 0 &&
        earlyOutsideSlots.length === 0 &&
        (pattern.matchScore ?? 0) >= 0.45 &&
        (pattern.confidence ?? 0) >= 0.58
      ) {
        score += 0.28;
      }
    }

  }

  return score;
}

function buildCandidateMatchOverrideOptions(candidateMatches, familyKey, metricKey) {
  return (candidateMatches?.topMatches ?? [])
    .filter((match) => match.familyKey === familyKey && match.metricKey === metricKey)
    .slice(0, 12)
    .map((match) => ({
      patternKey: `candidate-match|${familyKey}|${match.slotIndex}|${match.offset}|${match.decodeLabel}|${metricKey}`,
      familyKey,
      metric: metricKey,
      offset: match.offset,
      decode: match.decodeLabel,
      confidence: clamp(0.2 + (match.effectiveScore ?? match.baseScore ?? 0), 0, 0.95),
      matchScore: match.effectiveScore ?? match.baseScore ?? 0,
      rowBand: [match.slotIndex, match.slotIndex],
      rawWindowCandidates: [{
        slotIndex: match.slotIndex,
        replayCount: 1,
      }],
      transform: {
        slopeMedian: match.slope ?? 1,
        interceptMedian: match.intercept ?? 0,
        sampleCount: 1,
      },
    }));
}

function buildBundleRecommendedPatterns(artifactDir, runManifest, summaryJson, provisionalSchema, candidateMatches) {
  const artifactRoot = path.dirname(artifactDir);
  const versionGroup = parseVersionGroup(runManifest.summary?.gameVersion ?? summaryJson.gameVersion ?? "unknown");
  const familyKeys = new Set((runManifest.families ?? []).map((family) => family.familyKey));
  const recommendedPatterns = [];
  const localRankedPatterns = provisionalSchema?.rankedPatterns ?? [];

  for (const familyKey of familyKeys) {
    const recommendationPath = path.join(
      artifactRoot,
      "scalar-metric-discovery",
      versionGroup,
      `family-bundle-recommendations-${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
    );
    const bundleCatalogPath = path.join(
      artifactRoot,
      "scalar-metric-discovery",
      versionGroup,
      `family-bundles-${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
    );
    if (!fs.existsSync(recommendationPath)) {
      continue;
    }

    const recommendation = readJson(recommendationPath);
    const bundleCatalog = fs.existsSync(bundleCatalogPath) ? readJson(bundleCatalogPath) : null;
    const bundles = (bundleCatalog?.bundles ?? [])
      .filter((bundle) => (bundle.bundleScore ?? 0) >= 0.8)
      .slice(0, 4);
    if (bundles.length === 0 && !recommendation.primaryBundle) {
      continue;
    }
    const supportAnchor = buildBundleFamilySupportAnchors(localRankedPatterns, familyKey);

    const selectedBundles = bundles.length > 0
      ? bundles
      : [{
          ...recommendation.primaryBundle,
          metrics: recommendation.primaryBundle.recommendedMetrics ?? [],
        }];

    for (const [bundleIndex, bundle] of selectedBundles.entries()) {
      for (const metricRecommendation of bundle.metrics ?? []) {
        const descriptor = parsePatternDescriptor(metricRecommendation.groupKey);
        if (!descriptor) {
          continue;
        }

        const overrideOptions = [
          ...localRankedPatterns
            .filter((pattern) => pattern.familyKey === descriptor.familyKey && pattern.metric === metricRecommendation.metric),
          ...buildCandidateMatchOverrideOptions(candidateMatches, descriptor.familyKey, metricRecommendation.metric),
        ];
        const localOverride = overrideOptions
          .map((pattern) => ({
            pattern,
            overrideScore: scoreLocalOverrideMatch(pattern, descriptor, supportAnchor),
          }))
          .sort((left, right) =>
            right.overrideScore - left.overrideScore ||
            (right.pattern.confidence ?? 0) - (left.pattern.confidence ?? 0)
          )[0]?.pattern ?? null;
        const acceptedLocalOverride = localOverride && scoreLocalOverrideMatch(localOverride, descriptor, supportAnchor) >= 0.28
          ? localOverride
          : null;

        const roundedSlot = Math.round(metricRecommendation.medianSlotIndex ?? bundle.slotBand?.[0] ?? 0);
        const slotFloor = Math.floor(metricRecommendation.medianSlotIndex ?? roundedSlot);
        const slotCeil = Math.ceil(metricRecommendation.medianSlotIndex ?? roundedSlot);
        const recommendedSlots = acceptedLocalOverride?.rawWindowCandidates?.length
          ? acceptedLocalOverride.rawWindowCandidates.map((candidate) => ({ slotIndex: candidate.slotIndex, replayCount: 1 }))
          : [slotFloor, slotCeil, roundedSlot]
            .filter((slotIndex, index, array) => Number.isFinite(slotIndex) && array.indexOf(slotIndex) === index)
            .map((slotIndex) => ({ slotIndex, replayCount: metricRecommendation.replaySupport ?? 1 }));
        const rowBand = acceptedLocalOverride?.rowBand ?? [
          Math.min(slotFloor, Math.floor(bundle.slotBand?.[0] ?? slotFloor)),
          Math.max(slotCeil, Math.ceil(bundle.slotBand?.[1] ?? slotCeil)),
        ];
        const anchoredSelection = shouldPreserveStrongPowerLocalOverride(
          descriptor.familyKey,
          metricRecommendation.metric,
          acceptedLocalOverride,
          supportAnchor,
        )
          ? { recommendedSlots, rowBand }
          : clampSlotsToAnchor(recommendedSlots, rowBand, supportAnchor);
        const bundleConfidence = clamp(
          (0.45 * (bundle.bundleScore ?? 0)) +
          (0.55 * (metricRecommendation.bundleCandidateScore ?? 0)),
          0,
          0.98,
        );

        recommendedPatterns.push({
          patternKey: `bundle|${bundleIndex}|${metricRecommendation.groupKey}`,
          familyKey: descriptor.familyKey,
          metric: metricRecommendation.metric,
          metricLabel: metricRecommendation.metric,
          confidence: Math.max(bundleConfidence, acceptedLocalOverride?.confidence ?? 0),
          recommendedRowBand: anchoredSelection.rowBand,
          recommendedSlots: anchoredSelection.recommendedSlots,
          offset: acceptedLocalOverride?.offset ?? descriptor.offset,
          decode: acceptedLocalOverride?.decode ?? descriptor.decode,
          transform: { slopeMedian: 1, interceptMedian: 0, sampleCount: 0 },
          bundleSupport: {
            familyKey,
            bundleScore: bundle.bundleScore,
            replayOverlap: bundle.replayOverlap,
            strongMetricCount: bundle.strongMetricCount,
            localOverridePatternKey: acceptedLocalOverride?.patternKey ?? null,
            supportAnchor,
            bundleIndex,
          },
        });
      }
    }
  }

  return recommendedPatterns;
}

function loadScalarFamilyLayout(artifactRoot, versionGroup, familyKey) {
  const layoutPath = path.join(
    artifactRoot,
    "scalar-family-layout",
    versionGroup,
    `${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
  );
  if (!fs.existsSync(layoutPath)) {
    return null;
  }
  return readJson(layoutPath);
}

function buildFamilyLayoutIndex(artifactRoot, versionGroup, familyKeys) {
  const layouts = new Map();
  for (const familyKey of familyKeys) {
    const layout = loadScalarFamilyLayout(artifactRoot, versionGroup, familyKey);
    if (layout) {
      layouts.set(familyKey, layout);
    }
  }
  return layouts;
}

function applyFamilyLayoutPrior(pattern, familyLayout) {
  if (!familyLayout) {
    return pattern;
  }

  const metricSummary = (familyLayout.metricAssignmentSummary ?? [])
    .find((entry) => entry.metric === pattern.metric) ?? null;
  const variantHints = (familyLayout.rowVariantSummary ?? [])
    .filter((variant) =>
      (variant.assignedMetrics ?? []).includes(pattern.metric) ||
      (variant.unresolvedMetrics ?? []).includes(pattern.metric),
    );

  const layoutSlots = [
    ...(metricSummary?.slotCounts ?? []).map((entry) => entry.value),
    ...variantHints.flatMap((variant) => {
      const [start, end] = variant.slotBand ?? [];
      const slots = [];
      if (Number.isFinite(start) && Number.isFinite(end)) {
        for (let slotIndex = start; slotIndex <= end; slotIndex += 1) {
          slots.push(slotIndex);
        }
      }
      if (Number.isFinite(variant.dominantSlot)) {
        slots.push(variant.dominantSlot);
      }
      return slots;
    }),
  ].filter(Number.isFinite);

  if (layoutSlots.length === 0) {
    return pattern;
  }

  const recommendedSlots = [
    ...(pattern.recommendedSlots ?? []).map((slot) => slot.slotIndex),
    ...layoutSlots,
  ]
    .filter((slotIndex, index, array) => array.indexOf(slotIndex) === index)
    .sort((left, right) => left - right)
    .map((slotIndex) => ({ slotIndex, replayCount: 1 }));

  const rowBandValues = [
    ...(pattern.recommendedRowBand ?? []),
    ...layoutSlots,
  ].filter(Number.isFinite);
  const recommendedRowBand = rowBandValues.length > 0
    ? [Math.min(...rowBandValues), Math.max(...rowBandValues)]
    : pattern.recommendedRowBand;

  let selectionScore = pattern.selectionScore;
  if ((metricSummary?.assignmentCount ?? 0) > 0) {
    selectionScore += 0.04;
  }
  if (variantHints.length > 0) {
    selectionScore += Math.min(0.04, 0.01 * variantHints.length);
  }

  return {
    ...pattern,
    recommendedSlots,
    recommendedRowBand,
    selectionScore,
  };
}

function buildResolvedClusterSlots(pattern, cluster, observedSlots) {
  const clusterBand = Array.isArray(cluster?.slotBand) ? cluster.slotBand : null;
  const normalizedObservedSlots = uniqueSortedNumbers(observedSlots ?? []);
  const inBandObservedSlots = clusterBand
    ? normalizedObservedSlots.filter((slotIndex) => slotIndex >= clusterBand[0] && slotIndex <= clusterBand[1])
    : normalizedObservedSlots;
  if (inBandObservedSlots.length > 0) {
    return inBandObservedSlots.map((slotIndex) => ({ slotIndex, replayCount: 1 }));
  }

  const existingSlots = uniqueSortedNumbers(
    (pattern.recommendedSlots ?? [])
      .map((slot) => slot.slotIndex)
      .filter(Number.isFinite),
  );
  const inBandExistingSlots = clusterBand
    ? existingSlots.filter((slotIndex) => slotIndex >= clusterBand[0] && slotIndex <= clusterBand[1])
    : existingSlots;
  if (inBandExistingSlots.length > 0) {
    return inBandExistingSlots.map((slotIndex) => ({ slotIndex, replayCount: 1 }));
  }

  const clusterSlots = uniqueSortedNumbers(cluster?.slots ?? []);
  if (clusterSlots.length > 0) {
    return clusterSlots.map((slotIndex) => ({ slotIndex, replayCount: 1 }));
  }

  return pattern.recommendedSlots ?? [];
}

function resolveSelectedPatternSlotClusters(selectedPatterns, participantOutputs, familyLayouts) {
  const resolvedPatterns = selectedPatterns.map((pattern) => {
    if (pattern.source !== "bundle-recommended" && pattern.source !== "bundle-promoted") {
      return pattern;
    }

    const familyLayout = familyLayouts.get(pattern.familyKey);
    if (!familyLayout) {
      return pattern;
    }

    const participantMetricRecords = participantOutputs
      .map((participant) => participant.metrics?.[pattern.metric] ?? null)
      .filter((record) =>
        record &&
        record.patternKey === pattern.patternKey &&
        record.familyKey === pattern.familyKey &&
        Number.isFinite(record.slotIndex),
      );

    const slotCounts = new Map();
    for (const record of participantMetricRecords) {
      slotCounts.set(record.slotIndex, (slotCounts.get(record.slotIndex) ?? 0) + 1);
    }
    const dominantSlot = [...slotCounts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
    const observedSlots = uniqueSortedNumbers(participantMetricRecords.map((record) => record.slotIndex));
    const cluster = resolveLayoutSlotCluster(familyLayout, {
      metric: pattern.metric,
      dominantSlot,
      recommendedSlots: observedSlots.length > 0
        ? observedSlots
        : (pattern.recommendedSlots ?? []).map((slot) => slot.slotIndex).filter(Number.isFinite),
      rowBand: pattern.recommendedRowBand ?? null,
      slotClusterKey: pattern.slotClusterKey ?? null,
      slotClusterCenter: pattern.slotClusterCenter ?? null,
      slotClusterBand: pattern.slotClusterBand ?? null,
    });
    if (!cluster) {
      return pattern;
    }

    return {
      ...pattern,
      recommendedRowBand: cluster.slotBand ?? pattern.recommendedRowBand,
      recommendedSlots: buildResolvedClusterSlots(pattern, cluster, observedSlots),
      slotClusterKey: cluster.key,
      slotClusterCenter: cluster.center,
      slotClusterBand: cluster.slotBand ?? null,
    };
  });

  const resolvedPatternByKey = new Map(resolvedPatterns.map((pattern) => [pattern.patternKey, pattern]));
  for (const participant of participantOutputs) {
    for (const record of Object.values(participant.metrics ?? {})) {
      const resolvedPattern = resolvedPatternByKey.get(record?.patternKey);
      if (!resolvedPattern) {
        continue;
      }
      record.slotClusterKey = resolvedPattern.slotClusterKey ?? null;
      record.slotClusterCenter = resolvedPattern.slotClusterCenter ?? null;
      record.slotClusterBand = resolvedPattern.slotClusterBand ?? null;
    }
  }

  return resolvedPatterns;
}

function normalizePattern(pattern, candidateMatches, source) {
  const recommendedSlots = pattern.recommendedSlots
    ? pattern.recommendedSlots
    : (pattern.rawWindowCandidates ?? []).map((candidate) => ({ slotIndex: candidate.slotIndex, replayCount: 1 }));
  const rowBand = pattern.recommendedRowBand ?? pattern.rowBand ?? [0, 0];
  return {
    patternKey: pattern.patternKey,
    familyKey: pattern.familyKey,
    metric: pattern.metric,
    metricLabel: pattern.metricLabel,
    confidence: pattern.confidence,
    recommendedRowBand: rowBand,
    recommendedSlots,
    offset: pattern.offset,
    decode: pattern.decode,
    transform: pattern.transform?.sampleCount > 0 ? pattern.transform : derivePatternTransform(pattern, candidateMatches),
    selectionScore: computeSelectionScore(source, pattern),
    source,
    slotClusterKey: pattern.slotClusterKey ?? null,
    slotClusterCenter: pattern.slotClusterCenter ?? null,
    slotClusterBand: pattern.slotClusterBand ?? null,
    matchScore: pattern.matchScore ?? null,
    bundleSupport: pattern.bundleSupport ?? null,
  };
}

function buildBundleSelectionKey(pattern) {
  if (pattern.source !== "bundle-promoted" && pattern.source !== "bundle-recommended") {
    return null;
  }

  const slotClusterKey = pattern.slotClusterKey ?? null;
  if (slotClusterKey) {
    return `${pattern.familyKey}|${pattern.metric}|${slotClusterKey}`;
  }

  const slotKey = (pattern.recommendedSlots ?? [])
    .map((slot) => slot.slotIndex)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .join(",");
  if (slotKey.length > 0) {
    return `${pattern.familyKey}|${pattern.metric}|slots:${slotKey}`;
  }

  const [rowStart, rowEnd] = pattern.recommendedRowBand ?? [];
  if (Number.isFinite(rowStart) && Number.isFinite(rowEnd)) {
    return `${pattern.familyKey}|${pattern.metric}|band:${rowStart}-${rowEnd}`;
  }

  return `${pattern.familyKey}|${pattern.metric}|pattern:${pattern.patternKey}`;
}

function evaluateSeriesPlausibility(metricKey, series) {
  if (!series.length) {
    return 0;
  }

  const values = series.map((point) => point.value).filter(Number.isFinite);
  if (!values.length) {
    return 0;
  }

  let minExpected = -Infinity;
  let maxExpected = Infinity;
  let monotonic = false;
  let jumpThreshold = Infinity;
  switch (metricKey) {
    case "level":
      minExpected = 1;
      maxExpected = 18;
      monotonic = true;
      jumpThreshold = 2;
      break;
    case "totalGold":
      minExpected = 0;
      maxExpected = 30000;
      monotonic = true;
      jumpThreshold = 4500;
      break;
    case "xp":
      minExpected = 0;
      maxExpected = 40000;
      monotonic = true;
      jumpThreshold = 6500;
      break;
    case "minionsKilled":
      minExpected = 0;
      maxExpected = 500;
      monotonic = true;
      jumpThreshold = 40;
      break;
    case "jungleMinionsKilled":
      minExpected = 0;
      maxExpected = 350;
      monotonic = true;
      jumpThreshold = 35;
      break;
    case "health": {
      minExpected = 0;
      maxExpected = 8000;
      const inRangeRatio = values.filter((value) => value >= minExpected && value <= maxExpected).length / values.length;
      const span = Math.max(...values) - Math.min(...values);
      const spanFactor = clamp(span / Math.max(Math.max(...values), 600), 0, 1);
      const nonNegativeFactor = values.filter((value) => value >= -1e-6).length / values.length;
      const extremeOutlierFactor = values.some((value) => value < -250 || value > 12000) ? 0.55 : 1;
      return ((0.5 * inRangeRatio) + (0.25 * nonNegativeFactor) + (0.25 * Math.max(0.35, spanFactor))) * extremeOutlierFactor;
    }
    case "healthMax": {
      minExpected = 200;
      maxExpected = 9000;
      const inRangeRatio = values.filter((value) => value >= minExpected && value <= maxExpected).length / values.length;
      let stabilityCount = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (Math.abs(values[index] - values[index - 1]) <= 250) {
          stabilityCount += 1;
        }
      }
      const stabilityRatio = values.length > 1 ? stabilityCount / (values.length - 1) : 1;
      const extremeOutlierFactor = values.some((value) => value < -250 || value > 14000) ? 0.5 : 1;
      return ((0.6 * inRangeRatio) + (0.4 * stabilityRatio)) * extremeOutlierFactor;
    }
    case "power": {
      minExpected = 0;
      maxExpected = 4000;
      const inRangeRatio = values.filter((value) => value >= minExpected && value <= maxExpected).length / values.length;
      const span = Math.max(...values) - Math.min(...values);
      const spanFactor = clamp(span / Math.max(Math.max(...values), 250), 0, 1);
      const nonNegativeFactor = values.filter((value) => value >= -1e-6).length / values.length;
      const extremeOutlierFactor = values.some((value) => value < -200 || value > 7000) ? 0.55 : 1;
      return ((0.5 * inRangeRatio) + (0.2 * nonNegativeFactor) + (0.3 * Math.max(0.25, spanFactor))) * extremeOutlierFactor;
    }
    case "powerMax": {
      minExpected = 0;
      maxExpected = 5000;
      const inRangeRatio = values.filter((value) => value >= minExpected && value <= maxExpected).length / values.length;
      let stabilityCount = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (Math.abs(values[index] - values[index - 1]) <= 200) {
          stabilityCount += 1;
        }
      }
      const stabilityRatio = values.length > 1 ? stabilityCount / (values.length - 1) : 1;
      const extremeOutlierFactor = values.some((value) => value < -200 || value > 8000) ? 0.5 : 1;
      return ((0.6 * inRangeRatio) + (0.4 * stabilityRatio)) * extremeOutlierFactor;
    }
    case "movementSpeed": {
      minExpected = 120;
      maxExpected = 1200;
      const inRangeRatio = values.filter((value) => value >= minExpected && value <= maxExpected).length / values.length;
      let moderateChanges = 0;
      let extremeJumps = 0;
      for (let index = 1; index < values.length; index += 1) {
        const diff = Math.abs(values[index] - values[index - 1]);
        if (diff >= 1 && diff <= 220) {
          moderateChanges += 1;
        }
        if (diff > 1000) {
          extremeJumps += 1;
        }
      }
      const changeRatio = values.length > 1 ? moderateChanges / (values.length - 1) : 0.5;
      const extremeOutlierFactor = values.some((value) => value < -500 || value > 2500) ? 0.25 : 1;
      const jumpPenalty = extremeJumps > 0 ? 0.35 : 1;
      return ((0.62 * inRangeRatio) + (0.38 * Math.max(0.2, changeRatio))) * extremeOutlierFactor * jumpPenalty;
    }
    default:
      return 0.5;
  }

  const inRangeCount = values.filter((value) => value >= minExpected && value <= maxExpected).length;
  const inRangeRatio = inRangeCount / values.length;

  let monotonicRatio = 1;
  if (monotonic && values.length > 1) {
    let okay = 0;
    let extremeJumps = 0;
    for (let index = 1; index < values.length; index += 1) {
      const diff = values[index] - values[index - 1];
      if (diff >= -1e-6) {
        okay += 1;
      }
      if (Math.abs(diff) > jumpThreshold) {
        extremeJumps += 1;
      }
    }
    monotonicRatio = okay / (values.length - 1);
    const extremeJumpRatio = extremeJumps / (values.length - 1);
    const jumpPenalty = extremeJumpRatio > 0
      ? Math.max(0.22, 1 - (1.35 * extremeJumpRatio))
      : 1;
    return ((0.7 * inRangeRatio) + (0.3 * monotonicRatio)) * jumpPenalty;
  }

  return (0.7 * inRangeRatio) + (0.3 * monotonicRatio);
}

function pickBestTransform(pattern, field, roster) {
  const transformCandidates = [];
  const preferred = pattern.transform ?? { slopeMedian: 1, interceptMedian: 0, sampleCount: 0 };
  transformCandidates.push({
    slopeMedian: preferred.slopeMedian ?? 1,
    interceptMedian: preferred.interceptMedian ?? 0,
    sampleCount: preferred.sampleCount ?? 0,
    label: "learned",
  });
  transformCandidates.push({
    slopeMedian: 1,
    interceptMedian: 0,
    sampleCount: 0,
    label: "identity",
  });

  let best = null;
  for (const transform of transformCandidates) {
    const series = fieldSamplesToSeries(field, {
      slope: transform.slopeMedian,
      intercept: transform.interceptMedian,
    });
    if (series.length === 0) {
      continue;
    }

    const finalValue = lastFiniteValue(series);
    if (!Number.isFinite(finalValue)) {
      continue;
    }

    let bestRosterScore = 0;
    for (const rosterEntry of roster) {
      const expected = rosterEntry.finalMetrics?.[pattern.metric];
      if (!Number.isFinite(expected)) {
        continue;
      }
      bestRosterScore = Math.max(bestRosterScore, scoreMetricValue(pattern.metric, expected, finalValue));
    }

    const plausibilityScore = evaluateSeriesPlausibility(pattern.metric, series);

    let heuristicBonus = 0;
    if (pattern.metric === "level" && finalValue >= 1 && finalValue <= 18) {
      heuristicBonus += 0.1;
    }
    if ((pattern.metric === "minionsKilled" || pattern.metric === "jungleMinionsKilled") && finalValue >= 0 && finalValue <= 400) {
      heuristicBonus += 0.05;
    }

    const score = (0.7 * bestRosterScore) + (0.3 * plausibilityScore) + heuristicBonus;
    if (!best || score > best.score) {
      best = {
        transform,
        series,
        finalValue,
        plausibilityScore,
        score,
      };
    }
  }

  return best;
}

function chooseSchemaPatterns(corpusSchema, provisionalSchema, candidateMatches, runManifest, roster, artifactDir, summaryJson, familyLayouts) {
  const familyKeys = new Set((runManifest.families ?? []).map((family) => family.familyKey));
  const metricCaps = new Map([
    ["level", 3],
    ["xp", 2],
    ["totalGold", 2],
    ["currentGold", 1],
    ["minionsKilled", 2],
    ["jungleMinionsKilled", 1],
    ["health", 2],
    // Keep one bundle-backed slab candidate and one exact-family alternative.
    ["movementSpeed", 2],
    ["power", 2],
    ["powerMax", 2],
  ]);

  const corpusPromoted = (corpusSchema.promotedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "corpus-promoted"));

  const localPromoted = (provisionalSchema.promotedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "replay-promoted"));

  const localRanked = (provisionalSchema.rankedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 16)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "replay-ranked"));

  const rankedCorpus = (corpusSchema.rankedPatterns ?? [])
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .filter((pattern) => isMetricAssignable(pattern.metric, roster))
    .filter((pattern) => (pattern.support?.replays ?? 0) >= 2)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 12)
    .map((pattern) => normalizePattern(pattern, candidateMatches, "corpus-ranked"));

  const bundlePromotedByFamilyMetric = new Map();
  for (const pattern of (corpusSchema.bundlePromotedPatterns ?? []).filter((entry) => familyKeys.has(entry.familyKey))) {
    appendMapList(bundlePromotedByFamilyMetric, `${pattern.familyKey}|${pattern.metric}`, pattern);
  }

  const weakCandidateMetricKeys = new Set([
    "health",
    "healthMax",
    "movementSpeed",
    "power",
    "powerMax",
  ]);
  const candidateLocal = [];
  for (const familyKey of familyKeys) {
    for (const metricKey of weakCandidateMetricKeys) {
      const allowCandidateWithoutRosterAnchor = metricKey === "movementSpeed";
      if (!allowCandidateWithoutRosterAnchor && !isMetricAssignable(metricKey, roster)) {
        continue;
      }
      candidateLocal.push(
        ...buildCandidateMatchOverrideOptions(candidateMatches, familyKey, metricKey)
          .slice(0, 3)
          .map((pattern) => normalizePattern(pattern, candidateMatches, "candidate-ranked")),
      );
    }
  }
  const strongExactMovementSpeedCandidates = candidateLocal.filter(isStrongExactMovementSpeedCandidate);

  const bundleRecommended = buildBundleRecommendedPatternsFromUtils(artifactDir, runManifest, summaryJson, provisionalSchema, candidateMatches)
    .filter((pattern) => familyKeys.has(pattern.familyKey))
    .map((pattern) => {
      const promoted = selectBestBundleClusterPattern(
        pattern,
        bundlePromotedByFamilyMetric.get(`${pattern.familyKey}|${pattern.metric}`) ?? [],
      );
      const preserveLocalBundleSlots = shouldPreserveStrongPowerLocalOverride(
        pattern.familyKey,
        pattern.metric,
        pattern,
        pattern.bundleSupport?.supportAnchor ?? null,
      );
      const allowPromotedTransformOverride =
        pattern.metric === "powerMax" ||
        !volatileBundleMetricKeys.has(pattern.metric) ||
        (pattern.transform?.sampleCount ?? 0) < 8;
      const promotedTransform = promoted &&
        allowPromotedTransformOverride &&
        (promoted.transform?.sampleCount ?? 0) > (pattern.transform?.sampleCount ?? 0)
        ? promoted.transform
        : null;
      const mergedPattern = promoted
        ? {
          ...pattern,
          confidence: Math.max(pattern.confidence ?? 0, promoted.confidence ?? 0),
          transform: promotedTransform ?? pattern.transform,
          recommendedRowBand: preserveLocalBundleSlots
            ? pattern.recommendedRowBand
            : (promoted.recommendedRowBand ?? pattern.recommendedRowBand),
          recommendedSlots: preserveLocalBundleSlots
            ? pattern.recommendedSlots
            : (promoted.recommendedSlots ?? pattern.recommendedSlots),
          slotClusterKey: preserveLocalBundleSlots
            ? (pattern.slotClusterKey ?? null)
            : (promoted.slotClusterKey ?? null),
          slotClusterCenter: preserveLocalBundleSlots
            ? (pattern.slotClusterCenter ?? null)
            : (promoted.slotClusterCenter ?? pattern.slotClusterCenter ?? null),
          slotClusterBand: preserveLocalBundleSlots
            ? (pattern.slotClusterBand ?? null)
            : (promoted.slotClusterBand ?? pattern.slotClusterBand ?? null),
          bundleSupport: {
            ...(pattern.bundleSupport ?? {}),
            ...(promoted.bundleSupport ?? {}),
            strongMetricCount: Math.max(
              pattern.bundleSupport?.strongMetricCount ?? 0,
              promoted.bundleSupport?.strongMetricCount ?? 0,
            ),
            passCount: Math.max(
              pattern.bundleSupport?.passCount ?? 0,
              promoted.bundleSupport?.passCount ?? 0,
            ),
          },
        }
        : pattern;
      const normalized = normalizePattern(mergedPattern, candidateMatches, promoted ? "bundle-promoted" : "bundle-recommended");
      return applyFamilyLayoutPrior(normalized, familyLayouts.get(normalized.familyKey));
    })
    .filter((pattern) => !shouldSuppressBundleMovementSpeedPattern(pattern, strongExactMovementSpeedCandidates));
  const preferredBundleFamilyKeys = new Set(bundleRecommended.map((pattern) => pattern.familyKey));

  const selected = [];
  const selectedKeys = new Set();
  const selectedBundleKeys = new Set();
  const selectedMetricCounts = new Map();
  const selectedMetricFamilies = new Map();
  const candidates = [...bundleRecommended, ...candidateLocal, ...corpusPromoted, ...localPromoted, ...localRanked, ...rankedCorpus]
      .map((pattern) => {
        let bonus = 0;
      if (
        pattern.source !== "bundle-recommended" &&
        preferredBundleFamilyKeys.has(pattern.familyKey) &&
        isMetricAssignable(pattern.metric, roster)
      ) {
        bonus += 0.12;
        if (["level", "currentGold", "xp", "totalGold", "minionsKilled", "jungleMinionsKilled"].includes(pattern.metric)) {
          bonus += 0.08;
        }
      }
      const layoutPattern = applyFamilyLayoutPrior(pattern, familyLayouts.get(pattern.familyKey));
      return {
          ...layoutPattern,
          selectionScore: layoutPattern.selectionScore + bonus,
        };
      })
    .sort((left, right) =>
      right.selectionScore - left.selectionScore ||
      right.confidence - left.confidence ||
      left.patternKey.localeCompare(right.patternKey),
    );

  for (const pattern of candidates) {
    if (selectedKeys.has(pattern.patternKey)) {
      continue;
    }
    const bundleSelectionKey = buildBundleSelectionKey(pattern);
    if (bundleSelectionKey && selectedBundleKeys.has(bundleSelectionKey)) {
      continue;
    }
    const metricCount = selectedMetricCounts.get(pattern.metric) ?? 0;
    const metricCap = (metricCaps.get(pattern.metric) ?? 1) + (
      pattern.source !== "bundle-recommended" &&
      preferredBundleFamilyKeys.has(pattern.familyKey) &&
      isMetricAssignable(pattern.metric, roster)
        ? 1
        : 0
    );
    if (metricCount >= metricCap) {
      continue;
    }
    if (pattern.metric === "movementSpeed") {
      const selectedFamilies = selectedMetricFamilies.get(pattern.metric) ?? new Set();
      if (metricCount > 0 && selectedFamilies.has(pattern.familyKey)) {
        continue;
      }
    }
    selected.push(pattern);
    selectedKeys.add(pattern.patternKey);
    if (bundleSelectionKey) {
      selectedBundleKeys.add(bundleSelectionKey);
    }
    selectedMetricCounts.set(pattern.metric, metricCount + 1);
    const metricFamilies = selectedMetricFamilies.get(pattern.metric) ?? new Set();
    metricFamilies.add(pattern.familyKey);
    selectedMetricFamilies.set(pattern.metric, metricFamilies);
  }

  if (selected.length > 0) {
    return selected;
  }

  return [];
}

function patternProcessingPriority(pattern) {
  if (bundleSupportMetricKeysFromUtils.has(pattern.metric)) {
    return 0;
  }
  switch (pattern.metric) {
    case "healthMax":
    case "movementSpeed":
      return 1;
    case "health":
    case "power":
    case "powerMax":
      return 2;
    default:
      return 3;
  }
}

function orderPatternsForExtraction(selectedPatterns) {
  return [...selectedPatterns].sort((left, right) =>
    patternProcessingPriority(left) - patternProcessingPriority(right) ||
    right.selectionScore - left.selectionScore ||
    right.confidence - left.confidence ||
    left.patternKey.localeCompare(right.patternKey)
  );
}

function candidateOutputScore(metric, record) {
  let score = (record.confidence ?? 0) + (0.08 * (record.plausibilityScore ?? 0));
  if (record.transformLabel !== "identity") {
    score += 0.05;
  }
  if (Number.isFinite(record.siblingAnchorScore)) {
    score += 0.12 * record.siblingAnchorScore;
  }
  if (Number.isFinite(record.layoutAnchorScore)) {
    score += 0.1 * record.layoutAnchorScore;
  }
  if (Number.isFinite(record.variantAnchorScore)) {
    score += 0.11 * record.variantAnchorScore;
  }
  if (Number.isFinite(record.familyAnchorScore)) {
    score += 0.08 * record.familyAnchorScore;
  }
  if (volatileBundleMetricKeys.has(metric)) {
    if (record.transformLabel === "identity") {
      score -= 0.12;
    }
    if (record.source === "bundle-recommended") {
      score -= 0.04;
    }
  }
  return score;
}

function buildCandidateRows(pattern, familyFieldIndex, roster) {
  const rowBandSlots = [];
  for (let slotIndex = pattern.recommendedRowBand[0]; slotIndex <= pattern.recommendedRowBand[1]; slotIndex += 1) {
    rowBandSlots.push(slotIndex);
  }

  const candidateSlots = [
    ...(pattern.recommendedSlots ?? []).map((slot) => slot.slotIndex),
    ...rowBandSlots,
  ].filter((value, index, array) => array.indexOf(value) === index);

  const candidates = [];
  for (const slotIndex of candidateSlots) {
    const fieldEntry = familyFieldIndex.get(`${slotIndex}|${pattern.offset}|${pattern.decode}`);
    if (!fieldEntry) {
      continue;
    }

    const transformed = pickBestTransform(pattern, fieldEntry.field, roster);
    if (!transformed) {
      continue;
    }
    if (
      pattern.metric === "movementSpeed" &&
      pattern.source === "bundle-recommended" &&
      (transformed.transform.sampleCount ?? 0) < 4
    ) {
      continue;
    }
    const plausibilityFloor = pattern.source === "bundle-recommended" ? 0.45 : 0.55;
    if (transformed.plausibilityScore < plausibilityFloor) {
      continue;
    }
    const metricBounds = getMetricBounds(pattern.metric);
    if (
      metricBounds &&
      (!Number.isFinite(transformed.finalValue) || transformed.finalValue < metricBounds.min || transformed.finalValue > metricBounds.max)
    ) {
      continue;
    }

    candidates.push({
      familyKey: pattern.familyKey,
      slotIndex,
      metric: pattern.metric,
      metricLabel: pattern.metricLabel,
      patternConfidence: pattern.confidence,
      field: fieldEntry.field,
      transform: {
        slopeMedian: transformed.transform.slopeMedian,
        interceptMedian: transformed.transform.interceptMedian,
        sampleCount: transformed.transform.sampleCount ?? 0,
      },
      transformLabel: transformed.transform.label,
      plausibilityScore: transformed.plausibilityScore,
      series: transformed.series,
      finalValue: transformed.finalValue,
    });
  }

  return candidates;
}

function maybeRefineCandidateForParticipant(candidate, rosterEntry) {
  if (!rosterEntry || !candidate.field) {
    return candidate;
  }

  const expectedFinalValue = rosterEntry.finalMetrics?.[candidate.metric];
  if (!Number.isFinite(expectedFinalValue)) {
    return candidate;
  }

  const refined = pickBestTransform(candidate.pattern, candidate.field, [rosterEntry]);
  if (!refined) {
    return candidate;
  }

  const plausibilityFloor = candidate.pattern.source === "bundle-recommended" ? 0.45 : 0.55;
  if ((refined.plausibilityScore ?? 0) < plausibilityFloor) {
    return candidate;
  }

  const metricBounds = getMetricBounds(candidate.metric);
  if (
    metricBounds &&
    (!Number.isFinite(refined.finalValue) || refined.finalValue < metricBounds.min || refined.finalValue > metricBounds.max)
  ) {
    return candidate;
  }

  const currentFit = (
    scoreMetricValue(candidate.metric, expectedFinalValue, candidate.finalValue) +
    (0.05 * Math.min(1, candidate.plausibilityScore ?? 0)) +
    (candidate.transformLabel !== "identity" ? 0.02 : 0)
  );
  const refinedFit = (
    scoreMetricValue(candidate.metric, expectedFinalValue, refined.finalValue) +
    (0.05 * Math.min(1, refined.plausibilityScore ?? 0)) +
    (refined.transform.label !== "identity" ? 0.02 : 0)
  );
  if (refinedFit <= currentFit + 0.015) {
    return candidate;
  }

  return {
    ...candidate,
    transform: {
      slopeMedian: refined.transform.slopeMedian,
      interceptMedian: refined.transform.interceptMedian,
      sampleCount: refined.transform.sampleCount ?? 0,
    },
    transformLabel: refined.transform.label,
    plausibilityScore: refined.plausibilityScore,
    series: refined.series,
    finalValue: refined.finalValue,
  };
}

function findLayoutAnchoredParticipant(candidate, participantOutputs, familyLayout) {
  if (!familyLayout) {
    return null;
  }

  const relative = (familyLayout.relativeSlotSummary ?? [])
    .find((entry) => entry.metric === candidate.metric) ?? null;
  if (!relative || !relative.anchorMetric || !Array.isArray(relative.deltaCounts) || relative.deltaCounts.length === 0) {
    return null;
  }

  const dominantDelta = relative.deltaCounts[0]?.delta;
  if (!Number.isFinite(dominantDelta)) {
    return null;
  }

  const matches = participantOutputs
    .map((participantOutput) => {
      const anchorRecord = participantOutput.metrics?.[relative.anchorMetric] ?? null;
      if (!anchorRecord || anchorRecord.familyKey !== candidate.familyKey) {
        return null;
      }
      const expectedSlot = (anchorRecord.slotIndex ?? candidate.slotIndex) + dominantDelta;
      const slotDistance = Math.abs(candidate.slotIndex - expectedSlot);
      if (slotDistance > 1) {
        return null;
      }
      const score = 0.9 - (0.18 * slotDistance) + (0.03 * (candidate.plausibilityScore ?? 0));
      return {
        rosterIndex: participantOutput.rosterIndex,
        anchorMetric: relative.anchorMetric,
        dominantDelta,
        slotDistance,
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score ||
      left.slotDistance - right.slotDistance ||
      left.rosterIndex - right.rosterIndex
    );

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const [best, second] = matches;
    if (
      Math.abs((best.score ?? 0) - (second.score ?? 0)) < 0.08 &&
      (best.slotDistance ?? 99) === (second.slotDistance ?? 99)
    ) {
      return null;
    }
  }

  return matches[0];
}

function findVariantAnchoredParticipant(candidate, participantOutputs, familyLayout) {
  if (!familyLayout) {
    return null;
  }

  const variants = (familyLayout.rowVariantSummary ?? [])
    .filter((variant) =>
      (variant.assignedMetrics ?? []).includes(candidate.metric) ||
      (variant.unresolvedMetrics ?? []).includes(candidate.metric),
    );
  if (variants.length === 0) {
    return null;
  }

  const matches = participantOutputs
    .map((participantOutput) => {
      let best = null;
      for (const variant of variants) {
        const [start, end] = variant.slotBand ?? [];
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
          continue;
        }

        const dominantSlot = Number.isFinite(variant.dominantSlot) ? variant.dominantSlot : null;
        const dominantDistance = dominantSlot == null ? 0 : Math.abs(candidate.slotIndex - dominantSlot);
        const inBand = candidate.slotIndex >= (start - 1) && candidate.slotIndex <= (end + 1);
        if (!inBand && dominantDistance > 1) {
          continue;
        }

        const matchingAssignedMetrics = (variant.assignedMetrics ?? [])
          .map((metricKey) => participantOutput.metrics?.[metricKey] ?? null)
          .filter((metricRecord) =>
            metricRecord &&
            metricRecord.familyKey === candidate.familyKey &&
            Number.isFinite(metricRecord.slotIndex) &&
            metricRecord.slotIndex >= (start - 1) &&
            metricRecord.slotIndex <= (end + 1),
          );
        if (matchingAssignedMetrics.length === 0) {
          continue;
        }

        const score = (
          0.58 +
          (0.12 * Math.min(2, matchingAssignedMetrics.length)) +
          (0.08 * Math.max(0, 1 - (dominantDistance * 0.5))) +
          (0.05 * Math.min(1, candidate.plausibilityScore ?? 0)) +
          (0.03 * Math.min(1, (variant.replayCount ?? 0) / 2))
        );
        if (!best || score > best.score) {
          best = {
            rosterIndex: participantOutput.rosterIndex,
            variantKey: variant.variantKey,
            dominantDistance,
            matchedMetricCount: matchingAssignedMetrics.length,
            score,
          };
        }
      }
      return best;
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.score - left.score ||
      left.dominantDistance - right.dominantDistance ||
      right.matchedMetricCount - left.matchedMetricCount ||
      left.rosterIndex - right.rosterIndex
    );

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const [best, second] = matches;
    if (
      Math.abs((best.score ?? 0) - (second.score ?? 0)) < 0.08 &&
      (best.dominantDistance ?? 99) === (second.dominantDistance ?? 99) &&
      (best.matchedMetricCount ?? 0) === (second.matchedMetricCount ?? 0)
    ) {
      return null;
    }
  }

  return matches[0];
}

function findSiblingAnchoredParticipant(candidate, participantOutputs) {
  const siblingMetric = siblingAnchorMetric(candidate.metric);
  if (!siblingMetric) {
    return null;
  }

  const matches = participantOutputs
    .map((participantOutput) => {
      const siblingRecord = participantOutput.metrics[siblingMetric] ?? null;
      const compatibility = evaluateSiblingAnchorCompatibility(candidate.metric, candidate, siblingRecord);
      if (!compatibility.compatible) {
        return null;
      }
      return {
        rosterIndex: participantOutput.rosterIndex,
        siblingMetric,
        compatibility,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.compatibility.score - left.compatibility.score ||
      left.compatibility.slotDistance - right.compatibility.slotDistance ||
      left.rosterIndex - right.rosterIndex
    );

  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const [best, second] = matches;
    if (
      Math.abs((best.compatibility.score ?? 0) - (second.compatibility.score ?? 0)) < 0.08 &&
      (best.compatibility.slotDistance ?? 99) === (second.compatibility.slotDistance ?? 99)
    ) {
      return null;
    }
  }

  return matches[0];
}

function familyAnchorWeight(metricKey) {
  switch (metricKey) {
    case "xp":
      return 1;
    case "totalGold":
      return 0.96;
    case "level":
      return 0.84;
    case "minionsKilled":
    case "jungleMinionsKilled":
      return 0.74;
    case "healthMax":
      return 0.86;
    case "powerMax":
      return 0.82;
    default:
      return 0;
  }
}

function crossFamilyAnchorWeight(metricKey) {
  switch (metricKey) {
    case "xp":
      return 1;
    case "totalGold":
      return 0.94;
    case "level":
      return 0.82;
    case "healthMax":
      return 0.88;
    case "power":
      return 0.78;
    case "powerMax":
      return 0.75;
    default:
      return 0;
  }
}

function findCrossFamilySlotAnchor(candidate, participantOutputs) {
  if (candidate.metric !== "movementSpeed") {
    return null;
  }

  const matches = [];
  for (const participantOutput of participantOutputs) {
    for (const [metricKey, metricRecord] of Object.entries(participantOutput.metrics ?? {})) {
      const weight = crossFamilyAnchorWeight(metricKey);
      if (weight <= 0) {
        continue;
      }
      const slotDistance = Math.abs((metricRecord.slotIndex ?? candidate.slotIndex) - candidate.slotIndex);
      if (slotDistance > 2) {
        continue;
      }

      let score = weight - (0.2 * slotDistance) + (0.05 * (candidate.plausibilityScore ?? 0));
      if (metricRecord.familyKey === candidate.familyKey) {
        score += 0.06;
      }
      if (metricRecord.source === "bundle-promoted" || metricRecord.source === "corpus-promoted") {
        score += 0.04;
      }
      matches.push({
        rosterIndex: participantOutput.rosterIndex,
        anchorMetric: metricKey,
        score,
        slotDistance,
        sameFamily: metricRecord.familyKey === candidate.familyKey,
      });
    }
  }

  matches.sort((left, right) =>
    right.score - left.score ||
    left.slotDistance - right.slotDistance ||
    Number(right.sameFamily) - Number(left.sameFamily) ||
    left.rosterIndex - right.rosterIndex
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const [best, second] = matches;
    if (
      Math.abs((best.score ?? 0) - (second.score ?? 0)) < 0.08 &&
      (best.slotDistance ?? 99) === (second.slotDistance ?? 99)
    ) {
      return null;
    }
  }

  return matches[0];
}

function findNearbyFamilyAnchor(candidate, participantOutputs) {
  if (!["healthMax", "power"].includes(candidate.metric)) {
    return null;
  }

  const maxDistance = candidate.metric === "healthMax" ? 2 : 1;
  const matches = [];
  for (const participantOutput of participantOutputs) {
    for (const [metricKey, metricRecord] of Object.entries(participantOutput.metrics ?? {})) {
      if (metricRecord.familyKey !== candidate.familyKey) {
        continue;
      }
      const weight = familyAnchorWeight(metricKey);
      if (weight <= 0) {
        continue;
      }
      const slotDistance = Math.abs((metricRecord.slotIndex ?? candidate.slotIndex) - candidate.slotIndex);
      if (slotDistance > maxDistance) {
        continue;
      }
      if (
        candidate.metric === "power" &&
        metricKey === "powerMax" &&
        Number.isFinite(metricRecord.finalValue) &&
        Number.isFinite(candidate.finalValue) &&
        candidate.finalValue > (metricRecord.finalValue * 1.05)
      ) {
        continue;
      }

      let score = weight - (0.22 * slotDistance) + (0.04 * (candidate.plausibilityScore ?? 0));
      if (metricRecord.source === "bundle-promoted" || metricRecord.source === "corpus-promoted") {
        score += 0.04;
      }
      matches.push({
        rosterIndex: participantOutput.rosterIndex,
        anchorMetric: metricKey,
        score,
        slotDistance,
      });
    }
  }

  matches.sort((left, right) =>
    right.score - left.score ||
    left.slotDistance - right.slotDistance ||
    left.rosterIndex - right.rosterIndex
  );
  if (matches.length === 0) {
    return null;
  }
  if (matches.length > 1) {
    const [best, second] = matches;
    if (
      Math.abs((best.score ?? 0) - (second.score ?? 0)) < 0.08 &&
      (best.slotDistance ?? 99) === (second.slotDistance ?? 99)
    ) {
      return null;
    }
  }

  return matches[0];
}

function buildPatternEdges(pattern, candidates, roster) {
  const edges = [];
  for (const candidate of candidates) {
    for (const rosterEntry of roster) {
      const expected = rosterEntry.finalMetrics[pattern.metric];
      if (!Number.isFinite(expected) || !Number.isFinite(candidate.finalValue)) {
        continue;
      }

      const score = scoreMetricValue(pattern.metric, expected, candidate.finalValue);
      if (score <= 0.2) {
        continue;
      }

      edges.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        rosterIndex: rosterEntry.rosterIndex,
        metric: pattern.metric,
        score,
      });
    }
  }

  edges.sort((left, right) => right.score - left.score);
  return edges;
}

function assignPatternCandidates(edges) {
  const assignedSlots = new Set();
  const assignedRoster = new Set();
  const assignments = [];
  for (const edge of edges) {
    const slotKey = `${edge.familyKey}|${edge.slotIndex}`;
    if (assignedSlots.has(slotKey) || assignedRoster.has(edge.rosterIndex)) {
      continue;
    }
    assignments.push(edge);
    assignedSlots.add(slotKey);
    assignedRoster.add(edge.rosterIndex);
  }

  return assignments;
}

function addFamilyAssignmentEvidence(familyAssignmentEvidence, edge, patternConfidence) {
  const familyMap = familyAssignmentEvidence.get(edge.familyKey) ?? new Map();
  const slotMap = familyMap.get(edge.slotIndex) ?? new Map();
  slotMap.set(edge.rosterIndex, (slotMap.get(edge.rosterIndex) ?? 0) + (edge.score * patternConfidence));
  familyMap.set(edge.slotIndex, slotMap);
  familyAssignmentEvidence.set(edge.familyKey, familyMap);
}

function addFamilySupportTrust(familySupportTrust, edge, patternConfidence) {
  const familyMap = familySupportTrust.get(edge.familyKey) ?? new Map();
  const slotTrust = familyMap.get(edge.slotIndex) ?? {
    weightedScore: 0,
    metricKeys: new Set(),
    metricScores: new Map(),
  };
  const weighted = edge.score * patternConfidence;
  slotTrust.weightedScore += weighted;
  slotTrust.metricKeys.add(edge.metric);
  slotTrust.metricScores.set(edge.metric, (slotTrust.metricScores.get(edge.metric) ?? 0) + weighted);
  familyMap.set(edge.slotIndex, slotTrust);
  familySupportTrust.set(edge.familyKey, familyMap);
}

function getFamilySupportTrust(familySupportTrust, familyKey, slotIndex) {
  const slotTrust = familySupportTrust.get(familyKey)?.get(slotIndex);
  if (!slotTrust) {
    return { weightedScore: 0, metricCount: 0 };
  }
  return {
    weightedScore: slotTrust.weightedScore,
    metricCount: slotTrust.metricKeys.size,
    metricScores: slotTrust.metricScores,
  };
}

function isBundleSlotTrusted(familySupportTrust, candidate) {
  const trust = getFamilySupportTrust(familySupportTrust, candidate.familyKey, candidate.slotIndex);
  const strongAnchorScore = Math.max(
    trust.metricScores?.get("xp") ?? 0,
    trust.metricScores?.get("totalGold") ?? 0,
    trust.metricScores?.get("minionsKilled") ?? 0,
    trust.metricScores?.get("jungleMinionsKilled") ?? 0,
  );
  if (strongAnchorScore >= 0.24) {
    return true;
  }
  if (trust.metricCount >= 2 && trust.weightedScore >= 0.45) {
    return true;
  }
  if (trust.metricCount >= 1 && trust.weightedScore >= 0.95) {
    return true;
  }
  return false;
}

function solveFamilyAssignments(familyMap) {
  const slotIndices = [...familyMap.keys()].sort((left, right) => left - right);
  if (!slotIndices.length) {
    return new Map();
  }

  const rosterIndices = [...new Set(
    slotIndices.flatMap((slotIndex) => [...(familyMap.get(slotIndex) ?? new Map()).keys()]),
  )].sort((left, right) => left - right);
  const rosterBitByIndex = new Map(rosterIndices.map((rosterIndex, index) => [rosterIndex, index]));
  const slotOptions = slotIndices.map((slotIndex) =>
    [...(familyMap.get(slotIndex) ?? new Map()).entries()]
      .map(([rosterIndex, score]) => ({ rosterIndex, score }))
      .sort((left, right) => right.score - left.score)
      .slice(0, 8),
  );

  if (slotIndices.length > 12 || rosterIndices.length > 12) {
    const assignments = new Map();
    const usedRoster = new Set();
    const flattened = slotIndices.flatMap((slotIndex, slotOffset) =>
      slotOptions[slotOffset].map((option) => ({
        slotIndex,
        rosterIndex: option.rosterIndex,
        score: option.score,
      })),
    ).sort((left, right) => right.score - left.score);
    for (const option of flattened) {
      if (assignments.has(option.slotIndex) || usedRoster.has(option.rosterIndex)) {
        continue;
      }
      assignments.set(option.slotIndex, option.rosterIndex);
      usedRoster.add(option.rosterIndex);
    }
    return assignments;
  }

  const memo = new Map();
  function search(slotOffset, usedMask) {
    if (slotOffset >= slotIndices.length) {
      return { score: 0, assignments: [] };
    }

    const memoKey = `${slotOffset}|${usedMask}`;
    if (memo.has(memoKey)) {
      return memo.get(memoKey);
    }

    let best = search(slotOffset + 1, usedMask);
    for (const option of slotOptions[slotOffset]) {
      const rosterBit = rosterBitByIndex.get(option.rosterIndex);
      if (rosterBit == null) {
        continue;
      }
      const bitMask = (1 << rosterBit);
      if ((usedMask & bitMask) !== 0) {
        continue;
      }

      const suffix = search(slotOffset + 1, usedMask | bitMask);
      const score = option.score + suffix.score;
      if (score > best.score) {
        best = {
          score,
          assignments: [
            { slotIndex: slotIndices[slotOffset], rosterIndex: option.rosterIndex },
            ...suffix.assignments,
          ],
        };
      }
    }

    memo.set(memoKey, best);
    return best;
  }

  const solution = search(0, 0);
  return new Map(solution.assignments.map((assignment) => [assignment.slotIndex, assignment.rosterIndex]));
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactDir = resolveAbsolute(repoRoot, args.artifactDir);
  const schemaPath = resolveAbsolute(repoRoot, args.schemaPath);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactDir, "extracted-stats.json");

  const runManifestPath = path.join(artifactDir, "run-manifest.json");
  const summaryPath = path.join(artifactDir, "summary.json");
  const provisionalSchemaPath = path.join(artifactDir, "provisional-schema.json");
  const candidateMatchesPath = path.join(artifactDir, "candidate-matches.json");
  if (!fs.existsSync(runManifestPath)) {
    throw new Error(`Run manifest not found at ${runManifestPath}`);
  }
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Replay summary not found at ${summaryPath}. Re-run artifact generation with the updated runner.`);
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Corpus schema not found at ${schemaPath}`);
  }

  const runManifest = readJson(runManifestPath);
  const summaryJson = readJson(summaryPath);
  const corpusSchema = readJson(schemaPath);
  const provisionalSchema = fs.existsSync(provisionalSchemaPath) ? readJson(provisionalSchemaPath) : { promotedPatterns: [], rankedPatterns: [] };
  const candidateMatches = fs.existsSync(candidateMatchesPath) ? readJson(candidateMatchesPath) : { topMatches: [] };
  const roster = buildSummaryRoster(summaryJson);
  const versionGroup = parseVersionGroup(runManifest.summary?.gameVersion ?? summaryJson.gameVersion ?? "unknown");
  const familyLayouts = buildFamilyLayoutIndex(
    path.dirname(artifactDir),
    versionGroup,
    new Set((runManifest.families ?? []).map((family) => family.familyKey)),
  );
  const selectedPatterns = chooseSchemaPatterns(corpusSchema, provisionalSchema, candidateMatches, runManifest, roster, artifactDir, summaryJson, familyLayouts);
  const orderedPatterns = orderPatternsForExtraction(selectedPatterns);

  const familyFieldIndex = new Map();
  for (const family of runManifest.families ?? []) {
    const cleanedPath = path.join(artifactDir, "families", family.familyKey, "cleaned.json");
    if (!fs.existsSync(cleanedPath)) {
      continue;
    }
    familyFieldIndex.set(family.familyKey, buildFieldIndex(readJson(cleanedPath)));
  }

  const familyAssignmentEvidence = new Map();
  const familySupportTrust = new Map();
  const directAssignments = new Map();
  const candidateRows = [];

  for (const pattern of orderedPatterns) {
    const fieldIndex = familyFieldIndex.get(pattern.familyKey);
    if (!fieldIndex) {
      continue;
    }

    const patternCandidates = buildCandidateRows(pattern, fieldIndex, roster);
    candidateRows.push(...patternCandidates.map((candidate) => ({ ...candidate, pattern })));

    const patternEdges = buildPatternEdges(pattern, patternCandidates, roster);
    for (const edge of patternEdges) {
      addFamilyAssignmentEvidence(familyAssignmentEvidence, edge, pattern.confidence);
    }

    const metricAssignments = assignPatternCandidates(patternEdges);
    for (const assignment of metricAssignments) {
      directAssignments.set(`${assignment.familyKey}|${assignment.slotIndex}|${assignment.metric}`, assignment.rosterIndex);
      if (bundleSupportMetricKeysFromUtils.has(assignment.metric)) {
        addFamilySupportTrustToMap(familySupportTrust, assignment, pattern.confidence);
      }
    }
  }

  const finalSlotAssignments = new Map();
  for (const [familyKey, familyMap] of familyAssignmentEvidence.entries()) {
    const familyAssignments = solveFamilyAssignments(familyMap);
    for (const [slotIndex, rosterIndex] of familyAssignments.entries()) {
      const rosterScore = familyMap.get(slotIndex)?.get(rosterIndex) ?? 0;
      if (rosterScore >= 0.2) {
        finalSlotAssignments.set(`${familyKey}|${slotIndex}`, rosterIndex);
      }
    }
  }

  const participantOutputs = roster.map((entry) => ({
    rosterIndex: entry.rosterIndex,
    champion: entry.champion,
    team: entry.team,
    teamPosition: entry.teamPosition,
    riotIdGameName: entry.riotIdGameName,
    riotIdTagLine: entry.riotIdTagLine,
    metrics: {},
  }));

  const unresolvedCandidates = [];
  for (const candidate of candidateRows) {
    const slotKey = `${candidate.familyKey}|${candidate.slotIndex}`;
    const directKey = `${candidate.familyKey}|${candidate.slotIndex}|${candidate.metric}`;
    const directRosterIndex =
      directAssignments.get(directKey) ??
      finalSlotAssignments.get(slotKey) ??
      null;
    const siblingAnchored = findSiblingAnchoredParticipant(candidate, participantOutputs);
    const acceptedSiblingAnchor = siblingAnchored && (siblingAnchored.compatibility?.score ?? 0) >= 0.85
      ? siblingAnchored
      : null;
    const variantAnchored = findVariantAnchoredParticipant(candidate, participantOutputs, familyLayouts.get(candidate.familyKey));
    const acceptedVariantAnchor = variantAnchored && (variantAnchored.score ?? 0) >= 0.76
      ? variantAnchored
      : null;
    const crossFamilyAnchored = findCrossFamilySlotAnchor(candidate, participantOutputs);
    const acceptedCrossFamilyAnchor = crossFamilyAnchored && (crossFamilyAnchored.score ?? 0) >= 0.78
      ? crossFamilyAnchored
      : null;
    const familyAnchored = findNearbyFamilyAnchor(candidate, participantOutputs);
    const acceptedFamilyAnchor = familyAnchored && (familyAnchored.score ?? 0) >= 0.7
      ? familyAnchored
      : null;
    const layoutAnchored = findLayoutAnchoredParticipant(candidate, participantOutputs, familyLayouts.get(candidate.familyKey));
    const acceptedLayoutAnchor = layoutAnchored && (layoutAnchored.score ?? 0) >= 0.72
      ? layoutAnchored
      : null;
    const rosterIndex =
      directRosterIndex ??
      acceptedSiblingAnchor?.rosterIndex ??
      acceptedVariantAnchor?.rosterIndex ??
      acceptedCrossFamilyAnchor?.rosterIndex ??
      acceptedLayoutAnchor?.rosterIndex ??
      acceptedFamilyAnchor?.rosterIndex ??
      null;

    if (
      candidate.pattern.source === "bundle-recommended" &&
      !isBundleSlotTrustedBySupport(familySupportTrust, candidate) &&
      !acceptedSiblingAnchor &&
      !acceptedVariantAnchor &&
      !acceptedLayoutAnchor &&
      !acceptedFamilyAnchor
    ) {
      unresolvedCandidates.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        metric: candidate.metric,
        finalValue: candidate.finalValue,
        patternConfidence: candidate.pattern.confidence,
        reason: "bundle-slot-untrusted",
      });
      continue;
    }

    if (rosterIndex == null) {
      unresolvedCandidates.push({
        familyKey: candidate.familyKey,
        slotIndex: candidate.slotIndex,
        metric: candidate.metric,
        finalValue: candidate.finalValue,
        patternConfidence: candidate.pattern.confidence,
      });
      continue;
    }

    const participantOutput = participantOutputs.find((entry) => entry.rosterIndex === rosterIndex);
    if (!participantOutput) {
      continue;
    }
    const rosterEntry = roster.find((entry) => entry.rosterIndex === rosterIndex) ?? null;
    const refinedCandidate = maybeRefineCandidateForParticipant(candidate, rosterEntry);

    if (refinedCandidate.metric === "health") {
      const sibling = participantOutput.metrics.healthMax ?? null;
      const siblingAnchored = sibling &&
        sibling.familyKey === refinedCandidate.familyKey &&
        Math.abs((sibling.slotIndex ?? refinedCandidate.slotIndex) - refinedCandidate.slotIndex) <= 1;
      if (!siblingAnchored) {
        unresolvedCandidates.push({
          familyKey: refinedCandidate.familyKey,
          slotIndex: refinedCandidate.slotIndex,
          metric: refinedCandidate.metric,
          finalValue: refinedCandidate.finalValue,
          patternConfidence: refinedCandidate.pattern.confidence,
          reason: "health-without-healthmax-anchor",
        });
        continue;
      }
    }

    const existing = participantOutput.metrics[refinedCandidate.metric];
    const record = {
      patternKey: refinedCandidate.pattern.patternKey,
      familyKey: refinedCandidate.familyKey,
      slotIndex: refinedCandidate.slotIndex,
      source: refinedCandidate.pattern.source,
      confidence: refinedCandidate.pattern.confidence,
      transform: normalizeRecordTransform(refinedCandidate.transform, refinedCandidate.series.length),
      transformLabel: refinedCandidate.transformLabel,
      plausibilityScore: refinedCandidate.plausibilityScore,
      siblingAnchorScore: acceptedSiblingAnchor?.compatibility?.score ?? null,
      layoutAnchorScore: acceptedLayoutAnchor?.score ?? null,
      variantAnchorScore: acceptedVariantAnchor?.score ?? null,
      familyAnchorScore: acceptedFamilyAnchor?.score ?? acceptedCrossFamilyAnchor?.score ?? null,
      finalValue: refinedCandidate.finalValue,
      slotClusterKey: refinedCandidate.pattern.slotClusterKey ?? null,
      slotClusterCenter: refinedCandidate.pattern.slotClusterCenter ?? null,
      slotClusterBand: refinedCandidate.pattern.slotClusterBand ?? null,
      timeline: refinedCandidate.series.map((point) => ({
        timestamp: point.timestamp,
        value: point.value,
      })),
    };

    if (!existing || candidateOutputScore(refinedCandidate.metric, record) > candidateOutputScore(refinedCandidate.metric, existing)) {
      participantOutput.metrics[refinedCandidate.metric] = record;
    }
  }

  const resolvedPatterns = resolveSelectedPatternSlotClusters(orderedPatterns, participantOutputs, familyLayouts);

  const extractedStats = {
    replayId: runManifest.replayId,
    generatedAtUtc: new Date().toISOString(),
    schemaPath,
    schemaFingerprint: corpusSchema.schemaFingerprint ?? buildSchemaFingerprint(corpusSchema),
    gameVersion: runManifest.summary?.gameVersion ?? summaryJson.gameVersion ?? "unknown",
    roster: roster.map((entry) => ({
      rosterIndex: entry.rosterIndex,
      champion: entry.champion,
      team: entry.team,
      teamPosition: entry.teamPosition,
      riotIdGameName: entry.riotIdGameName,
      riotIdTagLine: entry.riotIdTagLine,
      finalMetrics: entry.finalMetrics,
    })),
    selectedPatterns: resolvedPatterns.map((pattern) => ({
      patternKey: pattern.patternKey,
      familyKey: pattern.familyKey,
      metric: pattern.metric,
      source: pattern.source,
      confidence: pattern.confidence,
      recommendedRowBand: pattern.recommendedRowBand,
      recommendedSlots: pattern.recommendedSlots,
      transform: pattern.transform,
      slotClusterKey: pattern.slotClusterKey ?? null,
      slotClusterCenter: pattern.slotClusterCenter ?? null,
      slotClusterBand: pattern.slotClusterBand ?? null,
    })),
    participants: participantOutputs,
    unresolvedCandidates,
  };

  writeJson(outputPath, extractedStats);
  console.log(`Wrote extracted replay stats to ${outputPath}`);
  console.log(`Assigned ${participantOutputs.reduce((sum, participant) => sum + Object.keys(participant.metrics).length, 0)} metric timelines.`);
}

main();
