import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    topBytes: 12,
    topWords: 12,
    topSequences: 12,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--top-bytes" && index + 1 < argv.length) {
      args.topBytes = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-words" && index + 1 < argv.length) {
      args.topWords = Number.parseInt(argv[++index], 10);
    } else if (arg === "--top-sequences" && index + 1 < argv.length) {
      args.topSequences = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/analyze_reconstruction_family_samples.mjs [--artifact-root artifacts-keyframes] [--top-bytes 12] [--top-words 12] [--top-sequences 12]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function bytesFromHex(hex) {
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

function hexByte(value) {
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function hexWord(value) {
  return value.toString(16).toUpperCase().padStart(8, "0");
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map, limit) {
  return [...map.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, limit);
}

function sequenceKey(bytes, offset, length) {
  return bytes.slice(offset, offset + length).map(hexByte).join(" ");
}

function commonPrefixLength(records) {
  if (records.length === 0) {
    return 0;
  }
  const first = records[0].bytes;
  let length = 0;
  outer:
  for (; length < first.length; length += 1) {
    for (const record of records.slice(1)) {
      if (record.bytes[length] !== first[length]) {
        break outer;
      }
    }
  }
  return length;
}

function stabilityMap(records, maxBytes = 96) {
  const limit = Math.min(maxBytes, records[0]?.bytes.length ?? 0);
  const chars = [];
  for (let offset = 0; offset < limit; offset += 1) {
    const values = new Set(records.map((record) => record.bytes[offset]));
    if (values.size === 1) {
      chars.push(".");
    } else if (values.size <= Math.max(2, Math.ceil(records.length * 0.25))) {
      chars.push("*");
    } else {
      chars.push("X");
    }
  }
  return chars.join("");
}

function analyzeFamily(family, args) {
  const records = (family.samples ?? []).flatMap((sample) =>
    (sample.records ?? []).map((record) => ({
      replayId: sample.replayId,
      chunkId: record.chunkId,
      offset: record.offset,
      bytes: bytesFromHex(record.hex),
    })),
  );
  const byteCounts = new Map();
  const u32Counts = new Map();
  const u16Counts = new Map();
  const seq4Counts = new Map();
  const seq6Counts = new Map();
  const seq8Counts = new Map();
  for (const record of records) {
    for (const byte of record.bytes) {
      increment(byteCounts, `0x${hexByte(byte)}`);
    }
    for (let index = 0; index + 1 < record.bytes.length; index += 2) {
      const value = record.bytes[index] | (record.bytes[index + 1] << 8);
      increment(u16Counts, `0x${value.toString(16).toUpperCase().padStart(4, "0")}`);
    }
    for (let index = 0; index + 3 < record.bytes.length; index += 4) {
      const value = record.bytes[index] |
        (record.bytes[index + 1] << 8) |
        (record.bytes[index + 2] << 16) |
        (record.bytes[index + 3] << 24);
      increment(u32Counts, `0x${hexWord(value >>> 0)}`);
    }
    for (let index = 0; index + 3 < record.bytes.length; index += 1) {
      increment(seq4Counts, sequenceKey(record.bytes, index, 4));
    }
    for (let index = 0; index + 5 < record.bytes.length; index += 1) {
      increment(seq6Counts, sequenceKey(record.bytes, index, 6));
    }
    for (let index = 0; index + 7 < record.bytes.length; index += 1) {
      increment(seq8Counts, sequenceKey(record.bytes, index, 8));
    }
  }
  return {
    familyKey: family.familyKey,
    length: family.length,
    firstByte: family.firstByte,
    sampledRecords: records.length,
    sampledReplays: new Set(records.map((record) => record.replayId)).size,
    targetRecords: family.targetRecords,
    backgroundRecords: family.backgroundRecords,
    targetChunks: family.targetChunks,
    backgroundChunks: family.backgroundChunks,
    commonPrefixBytes: commonPrefixLength(records),
    stabilityMap: stabilityMap(records),
    topBytes: sortedCounts(byteCounts, args.topBytes),
    topU16Words: sortedCounts(u16Counts, args.topWords),
    topU32Words: sortedCounts(u32Counts, args.topWords),
    topByteSequences: {
      length4: sortedCounts(seq4Counts, args.topSequences),
      length6: sortedCounts(seq6Counts, args.topSequences),
      length8: sortedCounts(seq8Counts, args.topSequences),
    },
    sampleLocations: records.slice(0, 8).map((record) => ({
      replayId: record.replayId,
      chunkId: record.chunkId,
      offset: record.offset,
    })),
  };
}

function validateSamples(samples) {
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1") {
    throw new Error(`Unexpected sample schema: ${samples.sampleSchema ?? "missing"}`);
  }
  if (samples.mode !== "offline-decoder-samples" || samples.runtimeInput !== false) {
    throw new Error("Sample input must be offline-only and non-runtime.");
  }
}

function validateOutput(output) {
  if (output.analysisSchema !== "rofl-reconstruction-family-sample-analysis/v1") {
    throw new Error("Unexpected sample analysis schema.");
  }
  if (output.mode !== "offline-decoder-sample-analysis" || output.runtimeInput !== false) {
    throw new Error("Sample analysis must be offline-only and non-runtime.");
  }
  if ((output.families ?? []).length === 0) {
    throw new Error("Sample analysis has no families.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, "reconstruction-family-sample-analysis-16.9.json"));
  const samples = readJson(inputPath);
  validateSamples(samples);
  const families = (samples.families ?? []).map((family) => analyzeFamily(family, args));
  const output = {
    analysisSchema: "rofl-reconstruction-family-sample-analysis/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-sample-analysis",
    runtimeInput: false,
    inputPath,
    selection: {
      topBytes: args.topBytes,
      topWords: args.topWords,
      topSequences: args.topSequences,
    },
    families,
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction family sample analysis to ${outputPath}`);
  console.log(`families=${families.length}`);
}

main();
