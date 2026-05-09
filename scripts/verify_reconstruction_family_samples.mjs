import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    minFamilies: 1,
    minSampledRecords: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--min-families" && index + 1 < argv.length) {
      args.minFamilies = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-sampled-records" && index + 1 < argv.length) {
      args.minSampledRecords = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/verify_reconstruction_family_samples.mjs [--artifact-root artifacts-keyframes] [--input-path <path>] [--min-families 1] [--min-sampled-records 1]");
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
  assert(output.sampleSchema === "rofl-reconstruction-family-samples/v1", "Unexpected reconstruction family sample schema.", {
    schema: output.sampleSchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-samples" && output.runtimeInput === false, "Family samples must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert((output.families ?? []).length >= args.minFamilies, "Too few sampled families.", {
    familyCount: (output.families ?? []).length,
    minFamilies: args.minFamilies,
  });
  let sampledRecordCount = 0;
  for (const family of output.families ?? []) {
    assert(family.familyKey &&
      Number.isFinite(family.length) &&
      typeof family.firstByte === "string" &&
      (family.samples ?? []).length > 0,
      "Invalid sampled family row.",
      family,
    );
    for (const sample of family.samples ?? []) {
      assert(sample.replayId && Number.isFinite(sample.recordCount) && (sample.records ?? []).length > 0, "Invalid replay sample row.", sample);
      for (const record of sample.records ?? []) {
        sampledRecordCount += 1;
        assert(record.segmentType === "chunk" &&
          Number.isFinite(record.chunkId) &&
          Number.isFinite(record.offset) &&
          record.length === family.length &&
          typeof record.hex === "string" &&
          record.hex.length === family.length * 2,
          "Invalid sampled chunk record.",
          record,
        );
      }
    }
  }
  assert(sampledRecordCount >= args.minSampledRecords, "Too few sampled records.", {
    sampledRecordCount,
    minSampledRecords: args.minSampledRecords,
  });
  return sampledRecordCount;
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const output = readJson(inputPath);
  const sampledRecordCount = verify(output, args, inputPath);
  console.log(`Verified reconstruction family samples: ${inputPath}`);
  console.log(`families=${(output.families ?? []).length}, sampledRecords=${sampledRecordCount}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
