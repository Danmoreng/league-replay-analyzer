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
    corpusSchema: "artifacts/corpus-schema.json",
    corpusManifest: "artifacts/corpus-manifest.json",
    versionGroup: null,
    familyKey: null,
    slotRadius: 1,
    maxFieldsPerSlot: 12,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--corpus-schema" && index + 1 < argv.length) {
      args.corpusSchema = argv[++index];
    } else if (arg === "--corpus-manifest" && index + 1 < argv.length) {
      args.corpusManifest = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--family-key" && index + 1 < argv.length) {
      args.familyKey = argv[++index];
    } else if (arg === "--slot-radius" && index + 1 < argv.length) {
      args.slotRadius = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-fields-per-slot" && index + 1 < argv.length) {
      args.maxFieldsPerSlot = Number.parseInt(argv[++index], 10);
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.versionGroup) {
    throw new Error("Missing required --version-group <value> argument.");
  }
  if (!args.familyKey) {
    throw new Error("Missing required --family-key <value> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/analyze_scalar_family_layout.mjs --version-group <value> --family-key <family> [--artifact-root <path>] [--corpus-schema <path>] [--corpus-manifest <path>] [--slot-radius <n>] [--max-fields-per-slot <n>] [--output-path <path>]");
}

function buildOutputPath(artifactRoot, versionGroup, familyKey, explicitOutputPath) {
  if (explicitOutputPath) {
    return explicitOutputPath;
  }
  return path.join(
    artifactRoot,
    "scalar-family-layout",
    versionGroup,
    `${familyKey.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`,
  );
}

function groupBy(items, keyFn) {
  const grouped = new Map();
  for (const item of items) {
    const key = keyFn(item);
    const bucket = grouped.get(key) ?? [];
    bucket.push(item);
    grouped.set(key, bucket);
  }
  return grouped;
}

function slotListFromPattern(pattern) {
  const direct = (pattern.recommendedSlots ?? [])
    .map((slot) => slot.slotIndex)
    .filter(Number.isFinite);
  if (direct.length > 0) {
    return [...new Set(direct)].sort((left, right) => left - right);
  }

  const start = pattern.recommendedRowBand?.[0];
  const end = pattern.recommendedRowBand?.[1];
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return [];
  }

  const slots = [];
  for (let slotIndex = start; slotIndex <= end; slotIndex += 1) {
    slots.push(slotIndex);
  }
  return slots;
}

function normalizePatternSummary(pattern) {
  return {
    patternKey: pattern.patternKey,
    metric: pattern.metric,
    sourceType: pattern.sourceType ?? pattern.source ?? "unknown",
    offset: pattern.offset,
    decode: pattern.decode,
    confidence: pattern.confidence ?? 0,
    recommendedRowBand: pattern.recommendedRowBand ?? pattern.rowBand ?? null,
    recommendedSlots: slotListFromPattern(pattern),
    transform: pattern.transform ?? null,
    support: pattern.support ?? null,
    bundleSupport: pattern.bundleSupport ?? null,
  };
}

function chooseAnchorMetric(assignments) {
  const priorities = ["xp", "totalGold", "level", "healthMax", "powerMax", "power"];
  const counts = new Map();
  for (const assignment of assignments) {
    counts.set(assignment.metric, (counts.get(assignment.metric) ?? 0) + 1);
  }
  return priorities.find((metric) => (counts.get(metric) ?? 0) > 0) ?? null;
}

function summarizeCounts(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([value, count]) => ({ value, count }));
}

function summarizeDeltaCounts(entries) {
  const counts = new Map();
  for (const entry of entries) {
    counts.set(entry.delta, (counts.get(entry.delta) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .map(([delta, count]) => ({ delta, count }));
}

function summarizeField(field, windowMetricMap) {
  const windowKey = `${field.offset}|${field.decodeLabel}`;
  return {
    offset: field.offset,
    width: field.width,
    decodeLabel: field.decodeLabel,
    score: field.score,
    directionHint: field.directionHint,
    minValue: field.minValue,
    maxValue: field.maxValue,
    linkedMetrics: windowMetricMap.get(windowKey) ?? [],
  };
}

function clusterSlotEntries(assignedMetrics, unresolvedCandidates) {
  const entries = [
    ...assignedMetrics.map((entry) => ({
      slotIndex: entry.slotIndex,
      kind: "assigned",
      metric: entry.metric,
    })),
    ...unresolvedCandidates.map((entry) => ({
      slotIndex: entry.slotIndex,
      kind: "unresolved",
      metric: entry.metric,
    })),
  ].filter((entry) => Number.isFinite(entry.slotIndex))
    .sort((left, right) => left.slotIndex - right.slotIndex || left.metric.localeCompare(right.metric));

  const clusters = [];
  for (const entry of entries) {
    const current = clusters[clusters.length - 1];
    if (!current || entry.slotIndex > (current.maxSlot + 1)) {
      clusters.push({
        minSlot: entry.slotIndex,
        maxSlot: entry.slotIndex,
        entries: [entry],
      });
      continue;
    }

    current.maxSlot = Math.max(current.maxSlot, entry.slotIndex);
    current.entries.push(entry);
  }

  return clusters.map((cluster) => ({
    slotBand: [cluster.minSlot, cluster.maxSlot],
    dominantSlot: Math.round(median(cluster.entries.map((entry) => entry.slotIndex))),
    assignedMetrics: [...new Set(cluster.entries.filter((entry) => entry.kind === "assigned").map((entry) => entry.metric))].sort(),
    unresolvedMetrics: [...new Set(cluster.entries.filter((entry) => entry.kind === "unresolved").map((entry) => entry.metric))].sort(),
  }));
}

function collectSlotProfiles(cleanedFamily, interestingSlots, maxFieldsPerSlot, windowMetricMap) {
  const slotSet = new Set(interestingSlots);
  return (cleanedFamily.slots ?? [])
    .filter((slot) => slotSet.has(slot.slotIndex))
    .sort((left, right) => left.slotIndex - right.slotIndex)
    .map((slot) => ({
      slotIndex: slot.slotIndex,
      activeRecords: slot.activeRecords,
      chunkSpanStart: slot.chunkSpanStart,
      chunkSpanEnd: slot.chunkSpanEnd,
      fieldCount: (slot.fields ?? []).length,
      topFields: (slot.fields ?? [])
        .slice(0, maxFieldsPerSlot)
        .map((field) => summarizeField(field, windowMetricMap)),
    }));
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const corpusSchemaPath = resolveAbsolute(repoRoot, args.corpusSchema);
  const corpusManifestPath = resolveAbsolute(repoRoot, args.corpusManifest);
  const outputPath = resolveAbsolute(
    repoRoot,
    buildOutputPath(artifactRoot, args.versionGroup, args.familyKey, args.outputPath),
  );

  const corpusSchema = readJson(corpusSchemaPath);
  const corpusManifest = readJson(corpusManifestPath);

  const familyPatterns = [
    ...(corpusSchema.bundlePromotedPatterns ?? []),
    ...(corpusSchema.bundleRankedPatterns ?? []),
    ...(corpusSchema.promotedPatterns ?? []),
    ...(corpusSchema.rankedPatterns ?? []),
  ]
    .filter((pattern) => pattern.familyKey === args.familyKey)
    .filter((pattern) => {
      const versionGroups = pattern.support?.versionGroups ?? [];
      return versionGroups.length === 0 || versionGroups.includes(args.versionGroup);
    })
    .filter((pattern, index, array) => array.findIndex((candidate) => candidate.patternKey === pattern.patternKey) === index);

  const familyPatternsNormalized = familyPatterns.map(normalizePatternSummary);
  const windowMetricMap = new Map();
  for (const pattern of familyPatternsNormalized) {
    const windowKey = `${pattern.offset}|${pattern.decode}`;
    const existing = windowMetricMap.get(windowKey) ?? [];
    existing.push(`${pattern.metric}:${pattern.sourceType}`);
    windowMetricMap.set(windowKey, [...new Set(existing)].sort());
  }

  const relevantReplays = [];
  const assignments = [];
  for (const replay of corpusManifest.processed ?? []) {
    const artifactDir = replay.artifactDir;
    const runManifestPath = path.join(artifactDir, "run-manifest.json");
    const extractedStatsPath = path.join(artifactDir, "extracted-stats.json");
    if (!fs.existsSync(runManifestPath) || !fs.existsSync(extractedStatsPath)) {
      continue;
    }

    const runManifest = readJson(runManifestPath);
    const gameVersion = runManifest.summary?.gameVersion ?? runManifest.gameVersion ?? "unknown";
    const versionGroup = parseVersionGroup(gameVersion);
    if (versionGroup !== args.versionGroup) {
      continue;
    }
    if (!(runManifest.families ?? []).some((family) => family.familyKey === args.familyKey)) {
      continue;
    }

    const extractedStats = readJson(extractedStatsPath);
    const validationReportPath = path.join(artifactDir, "validation-report.json");
    const validationReport = fs.existsSync(validationReportPath) ? readJson(validationReportPath) : null;
    const validationByRosterIndex = new Map((validationReport?.participants ?? []).map((participant) => [participant.rosterIndex, participant]));
    const cleanedFamilyPath = path.join(artifactDir, "families", args.familyKey, "cleaned.json");
    const cleanedFamily = fs.existsSync(cleanedFamilyPath) ? readJson(cleanedFamilyPath) : { slots: [] };

    const replayAssignments = [];
    const interestingSlotSet = new Set();
    for (const participant of extractedStats.participants ?? []) {
      const validationParticipant = validationByRosterIndex.get(participant.rosterIndex) ?? { metrics: {} };
      for (const [metric, record] of Object.entries(participant.metrics ?? {})) {
        if (record.familyKey !== args.familyKey) {
          continue;
        }
        replayAssignments.push({
          replayId: extractedStats.replayId,
          gameVersion,
          rosterIndex: participant.rosterIndex,
          champion: participant.champion,
          teamPosition: participant.teamPosition,
          metric,
          slotIndex: record.slotIndex,
          source: record.source,
          confidence: record.confidence,
          transformLabel: record.transformLabel,
          finalValue: record.finalValue,
          siblingAnchorScore: record.siblingAnchorScore ?? null,
          familyAnchorScore: record.familyAnchorScore ?? null,
          validation: validationParticipant.metrics?.[metric] ?? null,
        });
        interestingSlotSet.add(record.slotIndex);
      }
    }

    const replayUnresolved = (extractedStats.unresolvedCandidates ?? [])
      .filter((candidate) => candidate.familyKey === args.familyKey)
      .map((candidate) => ({
        slotIndex: candidate.slotIndex,
        metric: candidate.metric,
        finalValue: candidate.finalValue,
        reason: candidate.reason ?? null,
      }));
    for (const candidate of replayUnresolved) {
      if (Number.isFinite(candidate.slotIndex)) {
        interestingSlotSet.add(candidate.slotIndex);
      }
    }

    const familySelectedPatterns = (extractedStats.selectedPatterns ?? [])
      .filter((pattern) => pattern.familyKey === args.familyKey)
      .map((pattern) => ({
        patternKey: pattern.patternKey,
        metric: pattern.metric,
        source: pattern.source,
        offset: pattern.offset ?? null,
        decode: pattern.decode ?? null,
        recommendedRowBand: pattern.recommendedRowBand ?? null,
        recommendedSlots: slotListFromPattern(pattern),
      }));
    for (const pattern of familySelectedPatterns) {
      for (const slotIndex of pattern.recommendedSlots) {
        for (let delta = -args.slotRadius; delta <= args.slotRadius; delta += 1) {
          interestingSlotSet.add(slotIndex + delta);
        }
      }
    }

    for (const assignment of replayAssignments) {
      for (let delta = -args.slotRadius; delta <= args.slotRadius; delta += 1) {
        interestingSlotSet.add(assignment.slotIndex + delta);
      }
    }

    const slotProfiles = collectSlotProfiles(
      cleanedFamily,
      [...interestingSlotSet].filter(Number.isFinite),
      args.maxFieldsPerSlot,
      windowMetricMap,
    );
    const slotClusters = clusterSlotEntries(replayAssignments, replayUnresolved);

    relevantReplays.push({
      replayId: extractedStats.replayId,
      artifactDir,
      gameVersion,
      assignedMetricCount: replayAssignments.length,
      selectedPatterns: familySelectedPatterns,
      assignedMetrics: replayAssignments,
      unresolvedCandidates: replayUnresolved,
      slotClusters,
      slotProfiles,
    });
    assignments.push(...replayAssignments);
  }

  const anchorMetric = chooseAnchorMetric(assignments);
  const assignmentsByReplayRoster = groupBy(assignments, (entry) => `${entry.replayId}|${entry.rosterIndex}`);
  const relativeSlotSummary = [];
  if (anchorMetric) {
    const anchorAwareAssignments = [];
    for (const entryList of assignmentsByReplayRoster.values()) {
      const anchor = entryList.find((entry) => entry.metric === anchorMetric) ?? null;
      if (!anchor) {
        continue;
      }
      for (const entry of entryList) {
        if (entry.metric === anchorMetric) {
          continue;
        }
        anchorAwareAssignments.push({
          anchorMetric,
          targetMetric: entry.metric,
          replayId: entry.replayId,
          rosterIndex: entry.rosterIndex,
          delta: entry.slotIndex - anchor.slotIndex,
          targetSlotIndex: entry.slotIndex,
          anchorSlotIndex: anchor.slotIndex,
        });
      }
    }

    const grouped = groupBy(anchorAwareAssignments, (entry) => entry.targetMetric);
    for (const [metric, entries] of grouped.entries()) {
      const deltas = summarizeDeltaCounts(entries);
      relativeSlotSummary.push({
        anchorMetric,
        metric,
        observationCount: entries.length,
        dominantDelta: deltas[0]?.delta ?? null,
        deltaCounts: deltas,
        medianDelta: median(entries.map((entry) => entry.delta)),
      });
    }
  }

  const metricAssignmentSummary = [...groupBy(assignments, (entry) => entry.metric).entries()]
    .map(([metric, entries]) => ({
      metric,
      assignmentCount: entries.length,
      replayIds: [...new Set(entries.map((entry) => entry.replayId))].sort(),
      slotCounts: summarizeCounts(entries.map((entry) => entry.slotIndex)),
      sourceCounts: summarizeCounts(entries.map((entry) => entry.source)),
      averageConfidence: average(entries.map((entry) => entry.confidence ?? 0)),
      passCount: entries.filter((entry) => entry.validation?.passes).length,
      validationCount: entries.filter((entry) => entry.validation).length,
      averageCorrelation: average(entries.map((entry) => entry.validation?.correlation).filter(Number.isFinite)),
      averageNormalizedRmse: average(entries.map((entry) => entry.validation?.normalizedRmse).filter(Number.isFinite)),
    }))
    .sort((left, right) => right.assignmentCount - left.assignmentCount || left.metric.localeCompare(right.metric));

  const rowVariantSummary = [...groupBy(
    relevantReplays.flatMap((replay) =>
      replay.slotClusters.map((cluster) => ({
        replayId: replay.replayId,
        ...cluster,
      }))
    ),
    (cluster) => `${cluster.slotBand.join("-")}|${cluster.assignedMetrics.join(",")}|${cluster.unresolvedMetrics.join(",")}`,
  ).entries()]
    .map(([variantKey, clusters]) => ({
      variantKey,
      replayCount: clusters.length,
      replayIds: clusters.map((cluster) => cluster.replayId).sort(),
      slotBand: clusters[0].slotBand,
      dominantSlot: median(clusters.map((cluster) => cluster.dominantSlot)),
      assignedMetrics: clusters[0].assignedMetrics,
      unresolvedMetrics: clusters[0].unresolvedMetrics,
    }))
    .sort((left, right) => right.replayCount - left.replayCount || left.variantKey.localeCompare(right.variantKey));

  const layoutWindows = [...groupBy(familyPatternsNormalized, (pattern) => `${pattern.offset}|${pattern.decode}`).entries()]
    .map(([windowKey, patterns]) => ({
      windowKey,
      offset: patterns[0].offset,
      decode: patterns[0].decode,
      metrics: [...new Set(patterns.map((pattern) => pattern.metric))].sort(),
      sourceTypes: [...new Set(patterns.map((pattern) => pattern.sourceType))].sort(),
      confidence: average(patterns.map((pattern) => pattern.confidence ?? 0)),
      recommendedSlots: [...new Set(patterns.flatMap((pattern) => pattern.recommendedSlots ?? []))].sort((left, right) => left - right),
      recommendedRowBands: patterns.map((pattern) => pattern.recommendedRowBand).filter(Boolean),
    }))
    .sort((left, right) => left.offset - right.offset || left.decode.localeCompare(right.decode));

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    versionGroup: args.versionGroup,
    familyKey: args.familyKey,
    anchorMetric,
    replayCount: relevantReplays.length,
    schemaPatterns: familyPatternsNormalized,
    layoutWindows,
    metricAssignmentSummary,
    relativeSlotSummary,
    rowVariantSummary,
    replays: relevantReplays.map((replay) => ({
      replayId: replay.replayId,
      gameVersion: replay.gameVersion,
      assignedMetricCount: replay.assignedMetricCount,
      selectedPatterns: replay.selectedPatterns,
      assignedMetrics: replay.assignedMetrics,
      unresolvedCandidates: replay.unresolvedCandidates,
      slotClusters: replay.slotClusters,
      slotProfiles: replay.slotProfiles,
    })),
    inferredLayout: {
      canonicalRowMetric: mode(metricAssignmentSummary.map((summary) => summary.metric)) ?? null,
      slotSpan: (() => {
        const allSlots = assignments.map((entry) => entry.slotIndex).filter(Number.isFinite);
        return allSlots.length > 0
          ? { min: Math.min(...allSlots), max: Math.max(...allSlots) }
          : null;
      })(),
    },
  };

  writeJson(outputPath, output);
  console.log(`Wrote scalar family layout analysis to ${outputPath}`);
  console.log(`Analyzed ${relevantReplays.length} replays for ${args.familyKey} in ${args.versionGroup}.`);
}

main();
