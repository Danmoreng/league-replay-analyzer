import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    cliPath: null,
    topIntervals: 8,
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
    } else if (arg === "--top-intervals" && index + 1 < argv.length) {
      args.topIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.topIntervals) || args.topIntervals <= 0) {
    throw new Error("--top-intervals must be a positive integer.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/summarize_reconstruction_chunk_targets.mjs [--input-path artifacts-keyframes/timeline-reconstruction-model-16.9.json] [--top-intervals 8] [--cli <rofl_core_cli.exe>]");
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

function summarizeFamilies(records) {
  const byFamily = new Map();
  for (const record of records) {
    const entry = byFamily.get(record.familyKey) ?? {
      familyKey: record.familyKey,
      length: record.length,
      firstByte: record.firstByte,
      count: 0,
      offsets: [],
      sampleHexPreview: record.hexPreview,
      sampleAsciiPreview: record.asciiPreview,
    };
    entry.count += 1;
    entry.offsets.push(record.offset);
    byFamily.set(record.familyKey, entry);
  }
  return [...byFamily.values()]
    .sort((left, right) => right.count - left.count || right.length - left.length || left.familyKey.localeCompare(right.familyKey));
}

function replayPathFor(replayId) {
  return path.resolve("replays", `${replayId}.rofl`);
}

function validateOutput(output) {
  if (output.summarySchema !== "rofl-reconstruction-chunk-target-summary/v1") {
    throw new Error("Unexpected reconstruction chunk target summary schema.");
  }
  if (output.mode !== "offline-decoder-target-summary" || output.runtimeInput !== false) {
    throw new Error("Reconstruction chunk target summary must be marked offline-only and non-runtime.");
  }
  if ((output.rows ?? []).length === 0) {
    throw new Error("Reconstruction chunk target summary has no eventful interval rows.");
  }
  for (const row of output.rows ?? []) {
    if (!row.replayId || !Number.isFinite(row.apiIntervalIndex) || (row.eventCounts?.total ?? 0) <= 0) {
      throw new Error(`Invalid reconstruction interval row: ${JSON.stringify(row)}`);
    }
    if ((row.chunks ?? []).length === 0) {
      throw new Error(`Reconstruction interval has no chunk targets: ${JSON.stringify(row)}`);
    }
    for (const chunk of row.chunks ?? []) {
      if (!Number.isFinite(chunk.chunkId) ||
        !Number.isFinite(chunk.payloadOffset) ||
        !Number.isFinite(chunk.length) ||
        !Number.isFinite(chunk.uncompressedLength) ||
        chunk.codec !== "zstd" ||
        (chunk.subrecordCount ?? 0) <= 0 ||
        (chunk.topFamilies ?? []).length === 0) {
        throw new Error(`Invalid reconstruction chunk target: ${JSON.stringify(chunk)}`);
      }
    }
  }
}

function summarizeAggregateFamilies(rows) {
  const byFamily = new Map();
  for (const row of rows ?? []) {
    for (const chunk of row.chunks ?? []) {
      for (const family of chunk.topFamilies ?? []) {
        const entry = byFamily.get(family.familyKey) ?? {
          familyKey: family.familyKey,
          length: family.length,
          firstByte: family.firstByte,
          totalRecords: 0,
          chunkCount: 0,
          intervalCount: 0,
          chunks: [],
          sampleHexPreview: family.sampleHexPreview,
          sampleAsciiPreview: family.sampleAsciiPreview,
        };
        entry.totalRecords += family.count ?? 0;
        entry.chunkCount += 1;
        entry.chunks.push({
          replayId: row.replayId,
          apiIntervalIndex: row.apiIntervalIndex,
          chunkId: chunk.chunkId,
          count: family.count,
          offsets: family.offsets,
        });
        byFamily.set(family.familyKey, entry);
      }
    }
  }
  for (const entry of byFamily.values()) {
    entry.intervalCount = new Set(entry.chunks.map((chunk) => `${chunk.replayId}:${chunk.apiIntervalIndex}`)).size;
  }
  return [...byFamily.values()]
    .sort((left, right) =>
      right.chunkCount - left.chunkCount ||
      right.intervalCount - left.intervalCount ||
      right.totalRecords - left.totalRecords ||
      right.length - left.length ||
      left.familyKey.localeCompare(right.familyKey),
    );
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "timeline-reconstruction-model-16.9.json"));
  const audit = readJson(inputPath);
  const cliPath = resolveCliPath(args.cliPath);
  const intervals = (audit.summary?.topEventfulIntervals ?? []).slice(0, args.topIntervals);
  const chunkCache = new Map();
  const rows = intervals.map((interval) => {
    const replayPath = replayPathFor(interval.replayId);
    const chunks = (interval.chunkTargets ?? []).map((target) => {
      const cacheKey = `${interval.replayId}:${target.chunkId}`;
      let parsed = chunkCache.get(cacheKey);
      if (!parsed) {
        const dump = runCli(cliPath, ["--dump-chunk-subrecords", replayPath, "--chunk-id", String(target.chunkId)]);
        parsed = parseSubrecords(dump);
        chunkCache.set(cacheKey, parsed);
      }
      return {
        ...target,
        subrecordCount: parsed.subrecordCount,
        decompressedSize: parsed.decompressedSize,
        topFamilies: summarizeFamilies(parsed.records).slice(0, 12),
      };
    });
    return {
      replayId: interval.replayId,
      apiIntervalIndex: interval.apiIntervalIndex,
      startMs: interval.startMs,
      endMs: interval.endMs,
      eventCounts: interval.eventCounts,
      priority: interval.priority,
      chunks,
    };
  });
  const output = {
    summarySchema: "rofl-reconstruction-chunk-target-summary/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-target-summary",
    runtimeInput: false,
    inputPath,
    cliPath,
    topIntervalCount: rows.length,
    aggregateTopFamilies: summarizeAggregateFamilies(rows).slice(0, 32),
    rows,
  };
  validateOutput(output);
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, "reconstruction-chunk-target-summary-16.9.json"));
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction chunk target summary to ${outputPath}`);
  console.log(`intervals: ${rows.length}`);
  console.log(`chunks: ${rows.reduce((sum, row) => sum + row.chunks.length, 0)}`);
}

main();
