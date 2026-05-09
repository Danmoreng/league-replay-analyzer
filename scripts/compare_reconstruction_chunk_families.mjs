import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    cliPath: null,
    topEventfulIntervals: 3,
    quietIntervals: 3,
    minQuietStartIndex: 4,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--cli" && index + 1 < argv.length) {
      args.cliPath = argv[++index];
    } else if (arg === "--top-eventful-intervals" && index + 1 < argv.length) {
      args.topEventfulIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--quiet-intervals" && index + 1 < argv.length) {
      args.quietIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-quiet-start-index" && index + 1 < argv.length) {
      args.minQuietStartIndex = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  for (const [name, value] of Object.entries({
    topEventfulIntervals: args.topEventfulIntervals,
    quietIntervals: args.quietIntervals,
    minQuietStartIndex: args.minQuietStartIndex,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative integer.`);
    }
  }
  if (args.topEventfulIntervals === 0 || args.quietIntervals === 0) {
    throw new Error("Both --top-eventful-intervals and --quiet-intervals must be greater than zero.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/compare_reconstruction_chunk_families.mjs [--top-eventful-intervals 3] [--quiet-intervals 3] [--cli <rofl_core_cli.exe>]");
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
  if (!found) {
    throw new Error(`rofl_core_cli.exe not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

function runCli(cliPath, args) {
  return execFileSync(cliPath, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function parseSubrecords(dumpText) {
  const records = [];
  const headerMatch = dumpText.match(/Found (\d+) subrecords in chunk (\d+) \(decompressed size=(\d+) bytes\)/);
  const regex = /Subrecord #(\d+) \(offset=(\d+), length=(\d+)\)\r?\n  Hex: ([0-9A-F ]+)\r?\n  Ascii: "([^"]*)"/g;
  for (const match of dumpText.matchAll(regex)) {
    const hexPreview = match[4].trim();
    const firstByte = hexPreview.split(" ", 1)[0] ?? null;
    records.push({
      index: Number.parseInt(match[1], 10),
      offset: Number.parseInt(match[2], 10),
      length: Number.parseInt(match[3], 10),
      firstByte,
      familyKey: `${match[3]}-0x${firstByte}`,
      hexPreview,
      asciiPreview: match[5],
    });
  }
  return {
    chunkId: headerMatch ? Number.parseInt(headerMatch[2], 10) : null,
    subrecordCount: headerMatch ? Number.parseInt(headerMatch[1], 10) : records.length,
    decompressedSize: headerMatch ? Number.parseInt(headerMatch[3], 10) : null,
    records,
  };
}

function replayPathFor(replayId) {
  return path.resolve("replays", `${replayId}.rofl`);
}

function eventScore(interval) {
  const counts = interval.eventCounts ?? {};
  return (counts.championKills ?? 0) * 100 +
    (counts.buildingKills ?? 0) * 80 +
    (counts.eliteMonsterKills ?? 0) * 70 +
    (counts.wardEvents ?? 0) * 10 +
    (counts.itemEvents ?? 0) * 5 +
    (counts.total ?? 0);
}

function flattenIntervals(audit) {
  const intervals = [];
  for (const row of audit.rows ?? []) {
    for (const interval of row.intervals ?? []) {
      intervals.push({
        replayId: row.replayId,
        apiIntervalIndex: interval.apiIntervalIndex,
        startMs: interval.startMs,
        endMs: interval.endMs,
        durationMs: interval.durationMs,
        chunkIds: interval.chunkIds,
        chunkTargets: interval.chunkTargets,
        eventCounts: interval.eventCounts,
        priority: eventScore(interval),
      });
    }
  }
  return intervals;
}

function selectRows(audit, topEventfulIntervals, quietIntervals, minQuietStartIndex) {
  const intervals = flattenIntervals(audit)
    .filter((interval) => (interval.chunkTargets ?? []).length > 0);
  const eventful = [...intervals]
    .sort((left, right) => right.priority - left.priority || (right.eventCounts?.total ?? 0) - (left.eventCounts?.total ?? 0))
    .slice(0, topEventfulIntervals);
  const eventfulKeys = new Set(eventful.map((interval) => `${interval.replayId}:${interval.apiIntervalIndex}`));
  const quiet = [...intervals]
    .filter((interval) => !eventfulKeys.has(`${interval.replayId}:${interval.apiIntervalIndex}`))
    .filter((interval) => interval.apiIntervalIndex >= minQuietStartIndex)
    .sort((left, right) =>
      (left.eventCounts?.total ?? 0) - (right.eventCounts?.total ?? 0) ||
      left.priority - right.priority ||
      left.replayId.localeCompare(right.replayId) ||
      left.apiIntervalIndex - right.apiIntervalIndex,
    )
    .slice(0, quietIntervals);
  return { eventful, quiet };
}

function collectChunkFamilies(cliPath, intervals, label) {
  const chunkCache = new Map();
  const families = new Map();
  const rows = [];
  for (const interval of intervals) {
    const chunks = [];
    for (const target of interval.chunkTargets ?? []) {
      const cacheKey = `${interval.replayId}:${target.chunkId}`;
      let parsed = chunkCache.get(cacheKey);
      if (!parsed) {
        const dump = runCli(cliPath, ["--dump-chunk-subrecords", replayPathFor(interval.replayId), "--chunk-id", String(target.chunkId)]);
        parsed = parseSubrecords(dump);
        chunkCache.set(cacheKey, parsed);
      }
      const chunkFamilies = new Map();
      for (const record of parsed.records) {
        const family = chunkFamilies.get(record.familyKey) ?? {
          familyKey: record.familyKey,
          length: record.length,
          firstByte: record.firstByte,
          count: 0,
          sampleHexPreview: record.hexPreview,
          sampleAsciiPreview: record.asciiPreview,
        };
        family.count += 1;
        chunkFamilies.set(record.familyKey, family);
      }
      for (const family of chunkFamilies.values()) {
        const aggregate = families.get(family.familyKey) ?? {
          familyKey: family.familyKey,
          length: family.length,
          firstByte: family.firstByte,
          recordCount: 0,
          chunkCount: 0,
          intervalKeys: new Set(),
          sampleHexPreview: family.sampleHexPreview,
          sampleAsciiPreview: family.sampleAsciiPreview,
        };
        aggregate.recordCount += family.count;
        aggregate.chunkCount += 1;
        aggregate.intervalKeys.add(`${interval.replayId}:${interval.apiIntervalIndex}`);
        families.set(family.familyKey, aggregate);
      }
      chunks.push({
        ...target,
        subrecordCount: parsed.subrecordCount,
        decompressedSize: parsed.decompressedSize,
        familyCount: chunkFamilies.size,
      });
    }
    rows.push({
      label,
      replayId: interval.replayId,
      apiIntervalIndex: interval.apiIntervalIndex,
      startMs: interval.startMs,
      endMs: interval.endMs,
      eventCounts: interval.eventCounts,
      priority: interval.priority,
      chunks,
    });
  }
  return { families, rows };
}

function scoreFamilies(eventful, quiet) {
  const keys = new Set([...eventful.families.keys(), ...quiet.families.keys()]);
  return [...keys].map((familyKey) => {
    const target = eventful.families.get(familyKey);
    const background = quiet.families.get(familyKey);
    const targetRecords = target?.recordCount ?? 0;
    const backgroundRecords = background?.recordCount ?? 0;
    const targetChunks = target?.chunkCount ?? 0;
    const backgroundChunks = background?.chunkCount ?? 0;
    const targetIntervals = target?.intervalKeys.size ?? 0;
    const backgroundIntervals = background?.intervalKeys.size ?? 0;
    return {
      familyKey,
      length: target?.length ?? background?.length,
      firstByte: target?.firstByte ?? background?.firstByte,
      targetRecords,
      backgroundRecords,
      targetChunks,
      backgroundChunks,
      targetIntervals,
      backgroundIntervals,
      recordDelta: targetRecords - backgroundRecords,
      chunkDelta: targetChunks - backgroundChunks,
      targetOnly: targetRecords > 0 && backgroundRecords === 0,
      enrichmentRatio: Number(((targetRecords + 1) / (backgroundRecords + 1)).toFixed(3)),
      sampleHexPreview: target?.sampleHexPreview ?? background?.sampleHexPreview,
      sampleAsciiPreview: target?.sampleAsciiPreview ?? background?.sampleAsciiPreview,
    };
  }).sort((left, right) =>
    Number(right.targetOnly) - Number(left.targetOnly) ||
    right.chunkDelta - left.chunkDelta ||
    right.recordDelta - left.recordDelta ||
    right.enrichmentRatio - left.enrichmentRatio ||
    right.targetRecords - left.targetRecords ||
    left.familyKey.localeCompare(right.familyKey),
  );
}

function validateOutput(output) {
  if (output.comparisonSchema !== "rofl-reconstruction-chunk-family-comparison/v1") {
    throw new Error("Unexpected reconstruction chunk family comparison schema.");
  }
  if (output.mode !== "offline-decoder-target-comparison" || output.runtimeInput !== false) {
    throw new Error("Reconstruction chunk family comparison must be offline-only and non-runtime.");
  }
  if ((output.rows?.eventful ?? []).length === 0 || (output.rows?.quiet ?? []).length === 0) {
    throw new Error("Comparison requires both eventful and quiet interval rows.");
  }
  if ((output.enrichedFamilies ?? []).length === 0) {
    throw new Error("Comparison produced no enriched family rankings.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "timeline-reconstruction-model-16.9.json"));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, "reconstruction-chunk-family-comparison-16.9.json"));
  const audit = readJson(inputPath);
  const cliPath = resolveCliPath(args.cliPath);
  const selected = selectRows(audit, args.topEventfulIntervals, args.quietIntervals, args.minQuietStartIndex);
  const eventful = collectChunkFamilies(cliPath, selected.eventful, "eventful");
  const quiet = collectChunkFamilies(cliPath, selected.quiet, "quiet");
  const output = {
    comparisonSchema: "rofl-reconstruction-chunk-family-comparison/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-target-comparison",
    runtimeInput: false,
    inputPath,
    cliPath,
    selection: {
      topEventfulIntervals: args.topEventfulIntervals,
      quietIntervals: args.quietIntervals,
      minQuietStartIndex: args.minQuietStartIndex,
    },
    counts: {
      eventfulIntervals: eventful.rows.length,
      quietIntervals: quiet.rows.length,
      eventfulChunks: eventful.rows.reduce((sum, row) => sum + row.chunks.length, 0),
      quietChunks: quiet.rows.reduce((sum, row) => sum + row.chunks.length, 0),
    },
    enrichedFamilies: scoreFamilies(eventful, quiet).slice(0, 64),
    rows: {
      eventful: eventful.rows,
      quiet: quiet.rows,
    },
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction chunk family comparison to ${outputPath}`);
  console.log(`eventful intervals: ${output.counts.eventfulIntervals}, quiet intervals: ${output.counts.quietIntervals}`);
  console.log(`eventful chunks: ${output.counts.eventfulChunks}, quiet chunks: ${output.counts.quietChunks}`);
}

main();
