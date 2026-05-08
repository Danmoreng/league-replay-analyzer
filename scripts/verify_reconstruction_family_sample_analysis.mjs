import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    minFamilies: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--min-families" && index + 1 < argv.length) {
      args.minFamilies = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/verify_reconstruction_family_sample_analysis.mjs [--artifact-root artifacts-keyframes] [--input-path <path>] [--min-families 1]");
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
  assert(output.analysisSchema === "rofl-reconstruction-family-sample-analysis/v1", "Unexpected reconstruction family sample analysis schema.", {
    schema: output.analysisSchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-sample-analysis" && output.runtimeInput === false, "Family sample analysis must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert((output.families ?? []).length >= args.minFamilies, "Too few analyzed families.", {
    familyCount: (output.families ?? []).length,
    minFamilies: args.minFamilies,
  });
  for (const family of output.families ?? []) {
    assert(family.familyKey &&
      Number.isFinite(family.length) &&
      typeof family.firstByte === "string" &&
      (family.sampledRecords ?? 0) > 0 &&
      (family.sampledReplays ?? 0) > 0 &&
      Number.isFinite(family.commonPrefixBytes) &&
      typeof family.stabilityMap === "string" &&
      (family.topBytes ?? []).length > 0 &&
      (family.sampleLocations ?? []).length > 0,
      "Invalid analyzed family row.",
      family,
    );
    for (const byte of family.topBytes ?? []) {
      assert(/^0x[0-9A-F]{2}$/.test(byte.value) && (byte.count ?? 0) > 0, "Invalid byte frequency row.", byte);
    }
    for (const word of family.topU16Words ?? []) {
      assert(/^0x[0-9A-F]{4}$/.test(word.value) && (word.count ?? 0) > 0, "Invalid u16 frequency row.", word);
    }
    for (const word of family.topU32Words ?? []) {
      assert(/^0x[0-9A-F]{8}$/.test(word.value) && (word.count ?? 0) > 0, "Invalid u32 frequency row.", word);
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-family-sample-analysis-16.9.json"));
  const output = readJson(inputPath);
  verify(output, args, inputPath);
  console.log(`Verified reconstruction family sample analysis: ${inputPath}`);
  console.log(`families=${(output.families ?? []).length}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
