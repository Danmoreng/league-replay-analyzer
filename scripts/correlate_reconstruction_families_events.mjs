import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    cliPath: null,
    versionGroup: "16.9",
    familyKeys: ["241-0x02", "241-0x04", "512-0x00", "2-0xC7"],
    maxEventfulIntervals: 20,
    maxQuietIntervals: 20,
    minQuietStartIndex: 4,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--family-keys" && index + 1 < argv.length) args.familyKeys = argv[++index].split(",").map((key) => key.trim()).filter(Boolean);
    else if (arg === "--max-eventful-intervals" && index + 1 < argv.length) args.maxEventfulIntervals = Number.parseInt(argv[++index], 10);
    else if (arg === "--max-quiet-intervals" && index + 1 < argv.length) args.maxQuietIntervals = Number.parseInt(argv[++index], 10);
    else if (arg === "--min-quiet-start-index" && index + 1 < argv.length) args.minQuietStartIndex = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/correlate_reconstruction_families_events.mjs [--version-group 16.9] [--family-keys 241-0x02,241-0x04]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  for (const [name, value] of Object.entries({
    maxEventfulIntervals: args.maxEventfulIntervals,
    maxQuietIntervals: args.maxQuietIntervals,
    minQuietStartIndex: args.minQuietStartIndex,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a non-negative integer.`);
    }
  }
  if (args.familyKeys.length === 0) {
    throw new Error("--family-keys must include at least one family key.");
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveCliPath(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : [
    path.resolve("build", "packages", "rofl-core", "Debug", "rofl_core_cli.exe"),
    path.resolve("build", "packages", "rofl-core", "Release", "rofl_core_cli.exe"),
    path.resolve("build", "packages", "rofl-core", "rofl_core_cli.exe"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`rofl_core_cli.exe not found. Checked: ${candidates.join(", ")}`);
  return found;
}

function replayPathFor(replayId) {
  return path.resolve("replays", `${replayId}.rofl`);
}

function runChunkDump(cliPath, replayId, chunkId) {
  return execFileSync(cliPath, ["--dump-chunk-subrecords", replayPathFor(replayId), "--chunk-id", String(chunkId)], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function parseSubrecords(dumpText) {
  const records = [];
  const regex = /Subrecord #(\d+) \(offset=(\d+), length=(\d+)\)\r?\n  Hex: ([0-9A-F ]+)/g;
  for (const match of dumpText.matchAll(regex)) {
    const firstByte = match[4].trim().split(" ", 1)[0] ?? "??";
    records.push({
      index: Number.parseInt(match[1], 10),
      offset: Number.parseInt(match[2], 10),
      length: Number.parseInt(match[3], 10),
      familyKey: `${match[3]}-0x${firstByte}`,
    });
  }
  return records;
}

function eventPriority(interval) {
  const counts = interval.eventCounts ?? {};
  return (counts.championKills ?? 0) * 100 +
    (counts.buildingKills ?? 0) * 80 +
    (counts.eliteMonsterKills ?? 0) * 70 +
    (counts.wardEvents ?? 0) * 10 +
    (counts.itemEvents ?? 0) * 5 +
    (counts.total ?? 0);
}

function flattenIntervals(audit) {
  return (audit.rows ?? []).flatMap((row) => (row.intervals ?? []).map((interval) => ({
    replayId: row.replayId,
    apiIntervalIndex: interval.apiIntervalIndex,
    startMs: interval.startMs,
    endMs: interval.endMs,
    durationMs: interval.durationMs,
    chunkTargets: interval.chunkTargets ?? [],
    eventCounts: interval.eventCounts ?? {},
    priority: eventPriority(interval),
  }))).filter((interval) => interval.chunkTargets.length > 0);
}

function selectIntervals(intervals, maxEventfulIntervals, maxQuietIntervals, minQuietStartIndex) {
  const eventful = [...intervals]
    .filter((interval) => (interval.eventCounts.total ?? 0) > 0)
    .sort((left, right) => right.priority - left.priority || (right.eventCounts.total ?? 0) - (left.eventCounts.total ?? 0))
    .slice(0, maxEventfulIntervals)
    .map((interval) => ({ ...interval, cohort: "eventful" }));
  const eventfulKeys = new Set(eventful.map((interval) => `${interval.replayId}:${interval.apiIntervalIndex}`));
  const quiet = [...intervals]
    .filter((interval) => !eventfulKeys.has(`${interval.replayId}:${interval.apiIntervalIndex}`))
    .filter((interval) => interval.apiIntervalIndex >= minQuietStartIndex)
    .sort((left, right) =>
      (left.eventCounts.total ?? 0) - (right.eventCounts.total ?? 0) ||
      left.priority - right.priority ||
      left.replayId.localeCompare(right.replayId) ||
      left.apiIntervalIndex - right.apiIntervalIndex)
    .slice(0, maxQuietIntervals)
    .map((interval) => ({ ...interval, cohort: "quiet" }));
  return [...eventful, ...quiet];
}

function rank(values) {
  const sorted = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array.from({ length: values.length }, () => null);
  for (let index = 0; index < sorted.length;) {
    let end = index + 1;
    while (end < sorted.length && sorted[end].value === sorted[index].value) end += 1;
    const averageRank = (index + 1 + end) / 2;
    for (let tied = index; tied < end; tied += 1) {
      ranks[sorted[tied].index] = averageRank;
    }
    index = end;
  }
  return ranks;
}

function pearson(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftDenominator = 0;
  let rightDenominator = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftDenominator += leftDelta * leftDelta;
    rightDenominator += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftDenominator * rightDenominator);
  return denominator === 0 ? null : numerator / denominator;
}

function summarizeFamily(rows, familyKey, category) {
  const allRates = rows.map((row) => row.familyRates[familyKey] ?? 0);
  const categoryCounts = rows.map((row) => row.eventCounts[category] ?? 0);
  const eventfulRows = rows.filter((row) => (row.eventCounts[category] ?? 0) > 0);
  const allEventfulRows = rows.filter((row) => (row.eventCounts.total ?? 0) > 0);
  const eventfulRate = eventfulRows.reduce((sum, row) => sum + (row.familyRates[familyKey] ?? 0), 0) / Math.max(1, eventfulRows.length);
  const allEventfulRate = allEventfulRows.reduce((sum, row) => sum + (row.familyRates[familyKey] ?? 0), 0) / Math.max(1, allEventfulRows.length);
  return {
    familyKey,
    category,
    pearson: pearson(allRates, categoryCounts),
    spearman: pearson(rank(allRates), rank(categoryCounts)),
    categoryIntervalCount: eventfulRows.length,
    meanRateInCategoryIntervals: eventfulRate,
    meanRateInAllEventfulIntervals: allEventfulRate,
    specificEnrichment: allEventfulRate === 0 ? null : eventfulRate / allEventfulRate,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `timeline-reconstruction-model-${args.versionGroup}.json`));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-family-event-correlation-${args.versionGroup}.json`));
  const audit = readJson(inputPath);
  if (audit.auditSchema !== "rofl-timeline-reconstruction-model/v1" || audit.runtimeInput !== false) {
    throw new Error("Input must be the offline timeline reconstruction audit.");
  }
  const cliPath = resolveCliPath(args.cliPath);
  const selected = selectIntervals(flattenIntervals(audit), args.maxEventfulIntervals, args.maxQuietIntervals, args.minQuietStartIndex);
  const chunkCache = new Map();
  const familyKeys = new Set(args.familyKeys);
  const rows = selected.map((interval) => {
    const familyCounts = Object.fromEntries([...familyKeys].map((key) => [key, 0]));
    let totalSubrecords = 0;
    let totalBytes = 0;
    for (const chunk of interval.chunkTargets) {
      const cacheKey = `${interval.replayId}:${chunk.chunkId}`;
      let records = chunkCache.get(cacheKey);
      if (!records) {
        records = parseSubrecords(runChunkDump(cliPath, interval.replayId, chunk.chunkId));
        chunkCache.set(cacheKey, records);
      }
      totalSubrecords += records.length;
      totalBytes += chunk.uncompressedLength ?? 0;
      for (const record of records) {
        if (familyKeys.has(record.familyKey)) familyCounts[record.familyKey] += 1;
      }
    }
    const familyRates = Object.fromEntries(Object.entries(familyCounts).map(([key, count]) => [key, totalSubrecords === 0 ? 0 : count / totalSubrecords]));
    return {
      cohort: interval.cohort,
      replayId: interval.replayId,
      apiIntervalIndex: interval.apiIntervalIndex,
      startMs: interval.startMs,
      endMs: interval.endMs,
      durationMs: interval.durationMs,
      chunkCount: interval.chunkTargets.length,
      totalSubrecords,
      totalBytes,
      eventCounts: interval.eventCounts,
      familyCounts,
      familyRates,
    };
  });
  const categories = ["total", "championKills", "buildingKills", "eliteMonsterKills", "itemEvents", "wardEvents"];
  const correlations = [...familyKeys].flatMap((familyKey) => categories.map((category) => summarizeFamily(rows, familyKey, category)));
  const output = {
    schema: "rofl-reconstruction-family-event-correlation/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    mode: "offline-validation-only",
    runtimeInput: false,
    status: "offline_validation_only_not_runtime_api_data",
    inputPath,
    cliPath,
    selection: {
      familyKeys: [...familyKeys],
      maxEventfulIntervals: args.maxEventfulIntervals,
      maxQuietIntervals: args.maxQuietIntervals,
      minQuietStartIndex: args.minQuietStartIndex,
      selectedIntervals: rows.length,
    },
    normalization: {
      familyRates: "family record count / total subrecords in selected interval chunks",
      specificEnrichment: "mean target family rate in category intervals / mean target family rate in all eventful intervals",
    },
    correlationMethods: {
      pearson: "Pearson correlation over normalized family rates and interval event category counts.",
      spearman: "Pearson correlation over average ranks; tied values receive the average tied rank.",
    },
    promotionAssessment: {
      status: "not_promoted",
      runtimeApiData: false,
      reasons: [
        "uses Riot timeline event categories as offline validation labels",
        "family-event correlation does not decode event payload semantics",
        "actor identity, event type payload fields, and timestamps are not reconstructed from ROFL-only records",
      ],
    },
    rows,
    correlations,
  };
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction family event correlation to ${outputPath}`);
  console.log(`intervals=${rows.length}, families=${familyKeys.size}`);
}

main();
