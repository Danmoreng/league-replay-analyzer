import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    minIntervals: 1,
    minChunks: 1,
    minAggregateFamilies: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--min-intervals" && index + 1 < argv.length) {
      args.minIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-chunks" && index + 1 < argv.length) {
      args.minChunks = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-aggregate-families" && index + 1 < argv.length) {
      args.minAggregateFamilies = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/verify_reconstruction_chunk_targets.mjs [--artifact-root artifacts-keyframes] [--input-path <path>] [--min-intervals 1] [--min-chunks 1]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message, details = null) {
  if (!condition) {
    const suffix = details == null ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function verify(output, args, inputPath) {
  assert(output.summarySchema === "rofl-reconstruction-chunk-target-summary/v1", "Unexpected reconstruction chunk target summary schema.", {
    schema: output.summarySchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-target-summary" && output.runtimeInput === false, "Reconstruction chunk target summary must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert((output.rows ?? []).length >= args.minIntervals, "Reconstruction chunk target summary has too few interval rows.", {
    rowCount: (output.rows ?? []).length,
    minIntervals: args.minIntervals,
  });
  const chunks = (output.rows ?? []).flatMap((row) => row.chunks ?? []);
  assert(chunks.length >= args.minChunks, "Reconstruction chunk target summary has too few chunk rows.", {
    chunkCount: chunks.length,
    minChunks: args.minChunks,
  });
  assert((output.aggregateTopFamilies ?? []).length >= args.minAggregateFamilies, "Reconstruction chunk target summary has too few aggregate family rows.", {
    aggregateFamilyCount: (output.aggregateTopFamilies ?? []).length,
    minAggregateFamilies: args.minAggregateFamilies,
  });
  for (const row of output.rows ?? []) {
    assert(row.replayId && Number.isFinite(row.apiIntervalIndex) && (row.eventCounts?.total ?? 0) > 0, "Invalid reconstruction interval row.", row);
    assert((row.chunks ?? []).length > 0, "Reconstruction interval row has no chunks.", row);
  }
  for (const chunk of chunks) {
    assert(Number.isFinite(chunk.chunkId) &&
      Number.isFinite(chunk.payloadOffset) &&
      Number.isFinite(chunk.length) &&
      Number.isFinite(chunk.uncompressedLength) &&
      chunk.codec === "zstd" &&
      (chunk.subrecordCount ?? 0) > 0 &&
      (chunk.topFamilies ?? []).length > 0,
      "Invalid reconstruction chunk target.",
      chunk,
    );
  }
  for (const family of output.aggregateTopFamilies ?? []) {
    assert(family.familyKey &&
      Number.isFinite(family.length) &&
      (family.totalRecords ?? 0) > 0 &&
      (family.chunkCount ?? 0) > 0 &&
      (family.intervalCount ?? 0) > 0,
      "Invalid aggregate reconstruction family row.",
      family,
    );
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-chunk-target-summary-16.9.json"));
  const output = readJson(inputPath);
  verify(output, args, inputPath);
  const chunks = (output.rows ?? []).reduce((sum, row) => sum + (row.chunks ?? []).length, 0);
  console.log(`Verified reconstruction chunk target summary: ${inputPath}`);
  console.log(`intervals=${(output.rows ?? []).length}, chunks=${chunks}, aggregateFamilies=${(output.aggregateTopFamilies ?? []).length}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
