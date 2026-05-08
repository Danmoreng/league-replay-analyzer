import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    minEventfulIntervals: 1,
    minQuietIntervals: 1,
    minEventfulChunks: 1,
    minQuietChunks: 1,
    minEnrichedFamilies: 1,
    minTargetOnlyFamilies: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--min-eventful-intervals" && index + 1 < argv.length) {
      args.minEventfulIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-quiet-intervals" && index + 1 < argv.length) {
      args.minQuietIntervals = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-eventful-chunks" && index + 1 < argv.length) {
      args.minEventfulChunks = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-quiet-chunks" && index + 1 < argv.length) {
      args.minQuietChunks = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-enriched-families" && index + 1 < argv.length) {
      args.minEnrichedFamilies = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-target-only-families" && index + 1 < argv.length) {
      args.minTargetOnlyFamilies = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/verify_reconstruction_chunk_family_comparison.mjs [--artifact-root artifacts-keyframes] [--input-path <path>]");
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

function assertPositiveInteger(value, name, details) {
  assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer.`, details);
}

function verifyRow(row, label) {
  assert(row.label === label, `Unexpected ${label} row label.`, row);
  assert(row.replayId && Number.isFinite(row.apiIntervalIndex), `Invalid ${label} interval identity.`, row);
  assert(Number.isFinite(row.priority), `Invalid ${label} interval priority.`, row);
  assert((row.chunks ?? []).length > 0, `${label} interval has no chunk rows.`, row);
  for (const chunk of row.chunks ?? []) {
    assert(Number.isFinite(chunk.chunkId) &&
      Number.isFinite(chunk.payloadOffset) &&
      Number.isFinite(chunk.length) &&
      Number.isFinite(chunk.uncompressedLength) &&
      chunk.codec === "zstd" &&
      (chunk.subrecordCount ?? 0) > 0 &&
      (chunk.familyCount ?? 0) > 0,
      `Invalid ${label} chunk row.`,
      chunk,
    );
  }
}

function verifyFamily(family) {
  assert(family.familyKey &&
    Number.isFinite(family.length) &&
    typeof family.firstByte === "string" &&
    Number.isFinite(family.targetRecords) &&
    Number.isFinite(family.backgroundRecords) &&
    Number.isFinite(family.targetChunks) &&
    Number.isFinite(family.backgroundChunks) &&
    Number.isFinite(family.recordDelta) &&
    Number.isFinite(family.chunkDelta) &&
    Number.isFinite(family.enrichmentRatio),
    "Invalid enriched family row.",
    family,
  );
  assert((family.targetRecords > 0 || family.backgroundRecords > 0) &&
    family.recordDelta === family.targetRecords - family.backgroundRecords &&
    family.chunkDelta === family.targetChunks - family.backgroundChunks,
    "Enriched family deltas are inconsistent.",
    family,
  );
  assert(family.targetOnly === (family.targetRecords > 0 && family.backgroundRecords === 0), "targetOnly flag is inconsistent.", family);
}

function verify(output, args, inputPath) {
  assert(output.comparisonSchema === "rofl-reconstruction-chunk-family-comparison/v1", "Unexpected reconstruction chunk family comparison schema.", {
    schema: output.comparisonSchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-target-comparison" && output.runtimeInput === false, "Chunk family comparison must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assertPositiveInteger(output.counts?.eventfulIntervals, "counts.eventfulIntervals", output.counts);
  assertPositiveInteger(output.counts?.quietIntervals, "counts.quietIntervals", output.counts);
  assertPositiveInteger(output.counts?.eventfulChunks, "counts.eventfulChunks", output.counts);
  assertPositiveInteger(output.counts?.quietChunks, "counts.quietChunks", output.counts);
  assert((output.rows?.eventful ?? []).length >= args.minEventfulIntervals, "Too few eventful interval rows.", {
    count: (output.rows?.eventful ?? []).length,
    min: args.minEventfulIntervals,
  });
  assert((output.rows?.quiet ?? []).length >= args.minQuietIntervals, "Too few quiet interval rows.", {
    count: (output.rows?.quiet ?? []).length,
    min: args.minQuietIntervals,
  });
  const eventfulChunkCount = (output.rows?.eventful ?? []).reduce((sum, row) => sum + (row.chunks ?? []).length, 0);
  const quietChunkCount = (output.rows?.quiet ?? []).reduce((sum, row) => sum + (row.chunks ?? []).length, 0);
  assert(eventfulChunkCount === output.counts.eventfulChunks && eventfulChunkCount >= args.minEventfulChunks, "Eventful chunk count mismatch.", {
    eventfulChunkCount,
    counts: output.counts,
    min: args.minEventfulChunks,
  });
  assert(quietChunkCount === output.counts.quietChunks && quietChunkCount >= args.minQuietChunks, "Quiet chunk count mismatch.", {
    quietChunkCount,
    counts: output.counts,
    min: args.minQuietChunks,
  });
  for (const row of output.rows?.eventful ?? []) {
    verifyRow(row, "eventful");
  }
  for (const row of output.rows?.quiet ?? []) {
    verifyRow(row, "quiet");
  }
  assert((output.enrichedFamilies ?? []).length >= args.minEnrichedFamilies, "Too few enriched family rows.", {
    count: (output.enrichedFamilies ?? []).length,
    min: args.minEnrichedFamilies,
  });
  for (const family of output.enrichedFamilies ?? []) {
    verifyFamily(family);
  }
  const targetOnlyCount = (output.enrichedFamilies ?? []).filter((family) => family.targetOnly).length;
  assert(targetOnlyCount >= args.minTargetOnlyFamilies, "Too few target-only enriched families.", {
    targetOnlyCount,
    min: args.minTargetOnlyFamilies,
  });
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-chunk-family-comparison-16.9.json"));
  const output = readJson(inputPath);
  verify(output, args, inputPath);
  const targetOnlyCount = (output.enrichedFamilies ?? []).filter((family) => family.targetOnly).length;
  console.log(`Verified reconstruction chunk family comparison: ${inputPath}`);
  console.log(`eventfulIntervals=${output.counts.eventfulIntervals}, quietIntervals=${output.counts.quietIntervals}, enrichedFamilies=${(output.enrichedFamilies ?? []).length}, targetOnlyFamilies=${targetOnlyCount}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
