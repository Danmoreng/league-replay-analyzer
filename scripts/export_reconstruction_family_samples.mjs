import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    cliPath: null,
    topFamilies: 6,
    maxRecordsPerReplay: 4,
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
    } else if (arg === "--top-families" && index + 1 < argv.length) {
      args.topFamilies = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-records-per-replay" && index + 1 < argv.length) {
      args.maxRecordsPerReplay = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.topFamilies) || args.topFamilies <= 0) {
    throw new Error("--top-families must be a positive integer.");
  }
  if (!Number.isFinite(args.maxRecordsPerReplay) || args.maxRecordsPerReplay <= 0) {
    throw new Error("--max-records-per-replay must be a positive integer.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/export_reconstruction_family_samples.mjs [--top-families 6] [--max-records-per-replay 4]");
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

function runCliJson(cliPath, args) {
  const stdout = execFileSync(cliPath, args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function replayPathFor(replayId) {
  return path.resolve("replays", `${replayId}.rofl`);
}

function parseFamilyKey(familyKey) {
  const match = familyKey.match(/^(\d+)-0x([0-9A-Fa-f]{2})$/);
  if (!match) {
    throw new Error(`Invalid family key: ${familyKey}`);
  }
  return {
    length: Number.parseInt(match[1], 10),
    firstByteHex: match[2].toUpperCase(),
    firstByteDecimal: Number.parseInt(match[2], 16),
  };
}

function validateComparison(comparison) {
  if (comparison.comparisonSchema !== "rofl-reconstruction-chunk-family-comparison/v1") {
    throw new Error(`Unexpected comparison schema: ${comparison.comparisonSchema ?? "missing"}`);
  }
  if (comparison.mode !== "offline-decoder-target-comparison" || comparison.runtimeInput !== false) {
    throw new Error("Input comparison must be offline-only and non-runtime.");
  }
  if ((comparison.enrichedFamilies ?? []).length === 0) {
    throw new Error("Input comparison has no enriched families.");
  }
}

function validateOutput(output) {
  if (output.sampleSchema !== "rofl-reconstruction-family-samples/v1") {
    throw new Error("Unexpected family sample schema.");
  }
  if (output.mode !== "offline-decoder-samples" || output.runtimeInput !== false) {
    throw new Error("Family samples must be offline-only and non-runtime.");
  }
  if ((output.families ?? []).length === 0) {
    throw new Error("Family sample artifact has no families.");
  }
  for (const family of output.families ?? []) {
    if (!family.familyKey || !Number.isFinite(family.length) || !family.firstByte || (family.samples ?? []).length === 0) {
      throw new Error(`Invalid family sample row: ${JSON.stringify(family)}`);
    }
    for (const sample of family.samples ?? []) {
      if (!sample.replayId || !Number.isFinite(sample.recordCount) || (sample.records ?? []).length === 0) {
        throw new Error(`Invalid replay sample row: ${JSON.stringify(sample)}`);
      }
      for (const record of sample.records ?? []) {
        if (record.segmentType !== "chunk" ||
          !Number.isFinite(record.chunkId) ||
          !Number.isFinite(record.offset) ||
          record.length !== family.length ||
          typeof record.hex !== "string" ||
          record.hex.length !== family.length * 2) {
          throw new Error(`Invalid sampled record: ${JSON.stringify(record)}`);
        }
      }
    }
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-chunk-family-comparison-16.9.json"));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const comparison = readJson(inputPath);
  validateComparison(comparison);
  const cliPath = resolveCliPath(args.cliPath);
  const eventfulReplayIds = [...new Set((comparison.rows?.eventful ?? []).map((row) => row.replayId))];
  const families = (comparison.enrichedFamilies ?? []).slice(0, args.topFamilies).map((family) => {
    const parsed = parseFamilyKey(family.familyKey);
    const samples = eventfulReplayIds.map((replayId) => {
      const dump = runCliJson(cliPath, [
        "--dump-subrecord-family-json",
        replayPathFor(replayId),
        "--length",
        String(parsed.length),
        "--first-byte",
        String(parsed.firstByteDecimal),
        "--record-type",
        "chunk",
        "--max-records",
        String(args.maxRecordsPerReplay),
      ]);
      return {
        replayId,
        recordCount: dump.recordCount,
        records: (dump.records ?? []).map((record) => ({
          segmentId: record.segmentId,
          segmentType: record.segmentType,
          chunkId: record.chunkId,
          offset: record.offset,
          length: record.length,
          hex: record.hex,
        })),
      };
    }).filter((sample) => sample.recordCount > 0 && sample.records.length > 0);
    return {
      familyKey: family.familyKey,
      length: parsed.length,
      firstByte: parsed.firstByteHex,
      targetRecords: family.targetRecords,
      backgroundRecords: family.backgroundRecords,
      targetChunks: family.targetChunks,
      backgroundChunks: family.backgroundChunks,
      targetIntervals: family.targetIntervals,
      backgroundIntervals: family.backgroundIntervals,
      samples,
    };
  });
  const output = {
    sampleSchema: "rofl-reconstruction-family-samples/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-samples",
    runtimeInput: false,
    inputPath,
    cliPath,
    selection: {
      topFamilies: args.topFamilies,
      maxRecordsPerReplay: args.maxRecordsPerReplay,
      eventfulReplayIds,
    },
    families,
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction family samples to ${outputPath}`);
  console.log(`families=${families.length}, replayIds=${eventfulReplayIds.length}`);
}

main();
