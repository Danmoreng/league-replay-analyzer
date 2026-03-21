import fs from "fs";
import path from "path";

import {
  clamp,
  median,
  parseVersionGroup,
  readJson,
} from "./decoder-schema-utils.mjs";

export const bundleSupportMetricKeys = new Set([
  "level",
  "xp",
  "totalGold",
  "currentGold",
  "minionsKilled",
  "jungleMinionsKilled",
]);

export const volatileBundleMetricKeys = new Set([
  "health",
  "power",
  "powerMax",
]);

export function siblingAnchorMetric(metricKey) {
  switch (metricKey) {
    case "health":
      return "healthMax";
    case "power":
      return "powerMax";
    default:
      return null;
  }
}

export function evaluateSiblingAnchorCompatibility(metricKey, candidate, siblingRecord) {
  const siblingMetric = siblingAnchorMetric(metricKey);
  if (!siblingMetric || !candidate || !siblingRecord) {
    return { compatible: false, score: 0 };
  }
  if (candidate.familyKey !== siblingRecord.familyKey) {
    return { compatible: false, score: 0 };
  }

  const slotDistance = Math.abs((candidate.slotIndex ?? 0) - (siblingRecord.slotIndex ?? 0));
  if (slotDistance > 1) {
    return { compatible: false, score: 0 };
  }

  const siblingFinalValue = siblingRecord.finalValue;
  const candidateFinalValue = candidate.finalValue;
  if (!Number.isFinite(siblingFinalValue) || !Number.isFinite(candidateFinalValue) || siblingFinalValue <= 0) {
    return { compatible: false, score: 0 };
  }
  if (candidateFinalValue < 0 || candidateFinalValue > (siblingFinalValue * 1.05)) {
    return { compatible: false, score: 0 };
  }

  const candidateSeries = candidate.series ?? [];
  const siblingSeries = siblingRecord.timeline ?? [];
  const siblingValueByTimestamp = new Map(
    siblingSeries
      .filter((point) => Number.isFinite(point?.timestamp) && Number.isFinite(point?.value))
      .map((point) => [point.timestamp, point.value]),
  );
  const overlap = candidateSeries.filter((point) => siblingValueByTimestamp.has(point.timestamp));
  if (overlap.length === 0) {
    return { compatible: false, score: 0 };
  }

  let underBoundCount = 0;
  let meaningfullyBelowCount = 0;
  for (const point of overlap) {
    const siblingValue = siblingValueByTimestamp.get(point.timestamp);
    if (!Number.isFinite(point.value) || !Number.isFinite(siblingValue) || siblingValue <= 0) {
      continue;
    }
    if (point.value <= (siblingValue * 1.05)) {
      underBoundCount += 1;
    }
    if (point.value <= (siblingValue * 0.98)) {
      meaningfullyBelowCount += 1;
    }
  }

  const underBoundRatio = underBoundCount / overlap.length;
  const belowRatio = meaningfullyBelowCount / overlap.length;
  if (underBoundRatio < 0.85) {
    return { compatible: false, score: 0 };
  }

  const finalRatio = candidateFinalValue / siblingFinalValue;
  const score = clamp(
    (0.45 * underBoundRatio) +
    (0.2 * belowRatio) +
    (0.25 * Math.max(0, 1 - (slotDistance * 0.4))) +
    (0.1 * Math.max(0, 1 - Math.abs(finalRatio - 0.6))),
    0,
    1,
  );

  return {
    compatible: true,
    score,
    siblingMetric,
    slotDistance,
    finalRatio,
  };
}

export function parsePatternDescriptor(groupKey) {
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

export function parseBundlePatternKey(patternKey) {
  const value = String(patternKey ?? "");
  if (!value.startsWith("bundle|")) {
    return null;
  }

  const parts = value.split("|");
  if (parts.length < 6) {
    return null;
  }

  const [, bundleIndexText, versionGroup, familyKey, offsetText, decode] = parts;
  const offset = Number.parseInt(offsetText, 10);
  const bundleIndex = Number.parseInt(bundleIndexText, 10);
  if (!Number.isFinite(bundleIndex) || !Number.isFinite(offset)) {
    return null;
  }

  return {
    bundleIndex,
    versionGroup,
    familyKey,
    offset,
    decode,
  };
}

export function uniqueSortedNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right);
}

export function collectPatternSlots(pattern) {
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

export function buildBundleFamilySupportClusters(localRankedPatterns, familyKey) {
  const supportPatterns = localRankedPatterns
    .filter((pattern) => pattern.familyKey === familyKey)
    .filter((pattern) => bundleSupportMetricKeys.has(pattern.metric))
    .filter((pattern) => (pattern.confidence ?? 0) >= 0.28);
  if (supportPatterns.length === 0) {
    return [];
  }

  const slotWeights = new Map();
  const slotHits = new Map();
  for (const pattern of supportPatterns) {
    const slots = collectPatternSlots(pattern);
    if (slots.length === 0) {
      continue;
    }
    const metricWeight = bundleSupportMetricKeys.has(pattern.metric) ? 1.15 : 1;
    const patternWeight = Math.max(0.05, (pattern.confidence ?? 0) * metricWeight);
    for (const slotIndex of slots) {
      slotWeights.set(slotIndex, (slotWeights.get(slotIndex) ?? 0) + patternWeight);
      const hits = slotHits.get(slotIndex) ?? [];
      hits.push(pattern);
      slotHits.set(slotIndex, hits);
    }
  }

  const rankedSlots = [...slotWeights.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
  if (rankedSlots.length === 0) {
    return [];
  }

  const slotEntries = [...slotWeights.entries()].sort((left, right) => left[0] - right[0]);
  const clusters = [];
  let currentCluster = [];
  for (const entry of slotEntries) {
    if (currentCluster.length === 0) {
      currentCluster.push(entry);
      continue;
    }

    const previousSlot = currentCluster[currentCluster.length - 1][0];
    if ((entry[0] - previousSlot) <= 2) {
      currentCluster.push(entry);
      continue;
    }

    clusters.push(currentCluster);
    currentCluster = [entry];
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  return clusters
    .map((clusterEntries, clusterIndex) => {
      const compactSlots = clusterEntries.map(([slotIndex]) => slotIndex);
      const clusterPatterns = compactSlots.flatMap((slotIndex) => slotHits.get(slotIndex) ?? []);
      const clusterWeights = clusterEntries.map(([, weight]) => weight);
      const championHints = [...new Set(
        clusterPatterns.flatMap((pattern) =>
          (pattern.participantHits ?? [])
            .filter((hit) => compactSlots.includes(hit.slotIndex ?? compactSlots[0]))
            .slice(0, 4)
            .map((hit) => hit.champion),
        ).filter(Boolean),
      )];

      return {
        clusterKey: `c${clusterIndex}`,
        slots: compactSlots,
        band: [compactSlots[0], compactSlots[compactSlots.length - 1]],
        center: median(compactSlots),
        supportMetricCount: new Set(clusterPatterns.map((pattern) => pattern.metric)).size,
        weightedScore: clusterWeights.reduce((sum, value) => sum + value, 0),
        championHints,
      };
    })
    .sort((left, right) =>
      right.weightedScore - left.weightedScore ||
      right.supportMetricCount - left.supportMetricCount ||
      left.center - right.center
    );
}

export function buildBundleFamilySupportAnchors(localRankedPatterns, familyKey) {
  return buildBundleFamilySupportClusters(localRankedPatterns, familyKey)[0] ?? null;
}

export function clampSlotsToAnchor(recommendedSlots, rowBand, supportAnchor) {
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

export function selectBundleSupportCluster(metricRecommendation, supportClusters, acceptedLocalOverride = null) {
  if (!Array.isArray(supportClusters) || supportClusters.length === 0) {
    return null;
  }

  const overrideSlots = acceptedLocalOverride ? collectPatternSlots(acceptedLocalOverride) : [];
  const overrideCenter = overrideSlots.length > 0 ? median(overrideSlots) : null;
  const recommendationCenter = Number.isFinite(metricRecommendation?.medianSlotIndex)
    ? metricRecommendation.medianSlotIndex
    : overrideCenter;

  return [...supportClusters]
    .map((cluster) => {
      let score = cluster.weightedScore + (0.14 * cluster.supportMetricCount);
      if (Number.isFinite(recommendationCenter) && Number.isFinite(cluster.center)) {
        score -= Math.min(1.2, Math.abs(recommendationCenter - cluster.center) * 0.22);
      }
      if (overrideSlots.length > 0) {
        const overlap = overrideSlots.filter((slotIndex) => cluster.slots.includes(slotIndex)).length;
        const nearOverlap = overrideSlots.filter((slotIndex) =>
          cluster.slots.some((clusterSlot) => Math.abs(clusterSlot - slotIndex) <= 1),
        ).length;
        if (overlap > 0) {
          score += 0.5 + (0.08 * overlap);
        } else if (nearOverlap > 0) {
          score += 0.22 + (0.04 * nearOverlap);
        }
      }
      return { cluster, score };
    })
    .sort((left, right) =>
      right.score - left.score ||
      right.cluster.weightedScore - left.cluster.weightedScore ||
      right.cluster.supportMetricCount - left.cluster.supportMetricCount
    )[0]?.cluster ?? null;
}

export function decodeCategory(decodeLabel) {
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

export function scoreLocalOverrideMatch(pattern, descriptor, supportAnchor) {
  let score = pattern.matchScore ?? pattern.support?.avgEffectiveScore ?? pattern.confidence ?? 0;
  score += 0.35 * (pattern.confidence ?? 0);
  if (pattern.decode === descriptor.decode) {
    score += 0.12;
  } else if (decodeCategory(pattern.decode) === decodeCategory(descriptor.decode)) {
    score += 0.05;
  }

  const offsetDistance = Math.abs((pattern.offset ?? descriptor.offset) - descriptor.offset);
  score -= Math.min(0.1, offsetDistance * 0.015);

  const transformSampleCount = pattern.transform?.sampleCount ?? 0;
  if (transformSampleCount >= 8) {
    score += 0.08;
  } else if (transformSampleCount >= 4) {
    score += 0.04;
  } else if (volatileBundleMetricKeys.has(pattern.metric)) {
    score -= 0.22;
  } else if (transformSampleCount <= 1) {
    score -= 0.08;
  }

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
  }

  const candidateChampions = [
    ...(pattern.participantHits ?? []).map((hit) => hit.champion),
    ...(pattern.champions ?? []),
  ].filter(Boolean);
  if (supportAnchor?.championHints?.length && candidateChampions.length) {
    const championOverlap = candidateChampions.filter((champion) => supportAnchor.championHints.includes(champion)).length;
    if (championOverlap > 0) {
      score += Math.min(0.16, 0.06 * championOverlap);
    }
  }

  return score;
}

export function buildCandidateMatchOverrideOptions(candidateMatches, familyKey, metricKey) {
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
      participantHits: match.champion
        ? [{
          slotIndex: match.slotIndex,
          champion: match.champion,
        }]
        : [],
      transform: {
        slopeMedian: match.slope ?? 1,
        interceptMedian: match.intercept ?? 0,
        sampleCount: 1,
      },
    }));
}

export function loadBundleFamilyArtifacts(artifactRoot, versionGroup, familyKey) {
  const safeFamilyKey = familyKey.replace(/[^A-Za-z0-9._-]+/g, "_");
  const recommendationPath = path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `family-bundle-recommendations-${safeFamilyKey}.json`,
  );
  const bundleCatalogPath = path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `family-bundles-${safeFamilyKey}.json`,
  );
  if (!fs.existsSync(recommendationPath)) {
    return null;
  }

  return {
    recommendation: readJson(recommendationPath),
    bundleCatalog: fs.existsSync(bundleCatalogPath) ? readJson(bundleCatalogPath) : null,
  };
}

export function buildBundleRecommendedPatterns(artifactDir, runManifest, summaryJson, provisionalSchema, candidateMatches) {
  const artifactRoot = path.dirname(artifactDir);
  const versionGroup = parseVersionGroup(runManifest.summary?.gameVersion ?? summaryJson.gameVersion ?? "unknown");
  const familyKeys = new Set((runManifest.families ?? []).map((family) => family.familyKey));
  const recommendedPatterns = [];
  const localRankedPatterns = provisionalSchema?.rankedPatterns ?? [];

  for (const familyKey of familyKeys) {
    const bundleArtifacts = loadBundleFamilyArtifacts(artifactRoot, versionGroup, familyKey);
    if (!bundleArtifacts) {
      continue;
    }

    const bundles = (bundleArtifacts.bundleCatalog?.bundles ?? [])
      .filter((bundle) => (bundle.bundleScore ?? 0) >= 0.8)
      .slice(0, 4);
    if (bundles.length === 0 && !bundleArtifacts.recommendation.primaryBundle) {
      continue;
    }
    const supportClusters = buildBundleFamilySupportClusters(localRankedPatterns, familyKey);
    const supportAnchor = supportClusters[0] ?? null;

    const selectedBundles = bundles.length > 0
      ? bundles
      : [{
          ...bundleArtifacts.recommendation.primaryBundle,
          metrics: bundleArtifacts.recommendation.primaryBundle.recommendedMetrics ?? [],
        }];

    for (const [bundleIndex, bundle] of selectedBundles.entries()) {
      for (const metricRecommendation of bundle.metrics ?? []) {
        const descriptor = parsePatternDescriptor(metricRecommendation.groupKey);
        if (!descriptor) {
          continue;
        }

        const localOverrideOptions = localRankedPatterns
          .filter((pattern) => pattern.familyKey === descriptor.familyKey && pattern.metric === metricRecommendation.metric);
        const candidateOverrideOptions = volatileBundleMetricKeys.has(metricRecommendation.metric) && localOverrideOptions.length > 0
          ? []
          : buildCandidateMatchOverrideOptions(candidateMatches, descriptor.familyKey, metricRecommendation.metric);
        const overrideOptions = [
          ...localOverrideOptions,
          ...candidateOverrideOptions,
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
        const minimumOverrideScore = volatileBundleMetricKeys.has(metricRecommendation.metric) ? 0.34 : 0.28;
        const acceptedLocalOverride = localOverride &&
          scoreLocalOverrideMatch(localOverride, descriptor, supportAnchor) >= minimumOverrideScore &&
          (
            !volatileBundleMetricKeys.has(metricRecommendation.metric) ||
            (localOverride.transform?.sampleCount ?? 0) >= 4
          )
          ? localOverride
          : null;

        if (volatileBundleMetricKeys.has(metricRecommendation.metric) && !acceptedLocalOverride) {
          continue;
        }

        const selectedSupportCluster = selectBundleSupportCluster(
          metricRecommendation,
          supportClusters,
          acceptedLocalOverride,
        ) ?? supportAnchor;

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
        const anchoredSelection = clampSlotsToAnchor(recommendedSlots, rowBand, selectedSupportCluster);
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
          transform: acceptedLocalOverride?.transform ?? { slopeMedian: 1, interceptMedian: 0, sampleCount: 0 },
          bundleSupport: {
            familyKey,
            bundleScore: bundle.bundleScore,
            replayOverlap: bundle.replayOverlap,
            strongMetricCount: bundle.strongMetricCount,
            localOverridePatternKey: acceptedLocalOverride?.patternKey ?? null,
            supportAnchor: selectedSupportCluster,
            bundleIndex,
          },
        });
      }
    }
  }

  return recommendedPatterns;
}

export function addFamilySupportTrust(familySupportTrust, edge, patternConfidence) {
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

export function getFamilySupportTrust(familySupportTrust, familyKey, slotIndex) {
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

export function isBundleSlotTrusted(familySupportTrust, candidate) {
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
