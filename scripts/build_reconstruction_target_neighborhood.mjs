import { execFileSync } from "node:child_process";
import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    samplesPath: null,
    outputPath: null,
    cliPath: null,
    familyKey: "241-0x02",
    windowSize: 6,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--samples-path" && index + 1 < argv.length) args.samplesPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--family-key" && index + 1 < argv.length) args.familyKey = argv[++index];
    else if (arg === "--window-size" && index + 1 < argv.length) args.windowSize = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/build_reconstruction_target_neighborhood.mjs [--family-key 241-0x02] [--window-size 6]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isFinite(args.windowSize) || args.windowSize < 1) throw new Error("--window-size must be positive.");
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function safeFamilyKey(familyKey) {
  return familyKey.replace(/[^A-Za-z0-9]+/g, "-");
}

function parseFamilyKey(familyKey) {
  const match = familyKey.match(/^(\d+)-0x([0-9A-Fa-f]{2})$/);
  if (!match) throw new Error(`Invalid family key: ${familyKey}`);
  return {
    length: Number.parseInt(match[1], 10),
    firstByteHex: match[2].toUpperCase(),
    firstByte: Number.parseInt(match[2], 16),
  };
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

function parseChunkDump(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^Subrecord #(\d+) \(offset=(\d+), length=(\d+)\)/);
    if (header) {
      current = {
        index: Number.parseInt(header[1], 10),
        offset: Number.parseInt(header[2], 10),
        length: Number.parseInt(header[3], 10),
        hexPreview: null,
      };
      records.push(current);
      continue;
    }
    const hex = line.match(/^\s+Hex: ([0-9A-F ]+)/);
    if (hex && current) current.hexPreview = hex[1].replaceAll(" ", "").toUpperCase();
  }
  return records.map((record) => ({
    ...record,
    firstByteHex: record.hexPreview?.slice(0, 2) ?? null,
    familyKey: `${record.length}-0x${record.hexPreview?.slice(0, 2) ?? "??"}`,
  }));
}

function shortRecord(record) {
  const payloadStartOffset = record.offset;
  const lengthFieldOffset = payloadStartOffset - 2;
  return {
    index: record.index,
    offset: payloadStartOffset,
    recordStartOffset: lengthFieldOffset,
    lengthFieldOffset,
    payloadStartOffset,
    payloadLength: record.length,
    payloadEndOffset: payloadStartOffset + record.length,
    firstByte: record.firstByteHex == null ? null : `0x${record.firstByteHex}`,
    familyKey: record.familyKey,
    headerHex: record.length <= 0xFFFF ? Buffer.from([record.length & 0xFF, (record.length >> 8) & 0xFF]).toString("hex").toUpperCase() : null,
    hexPreview: record.hexPreview?.slice(0, 96) ?? null,
    hexSuffix: record.hexPreview?.slice(-96) ?? null,
  };
}

function increment(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

function main() {
  const args = parseArgs(process.argv);
  const parsed = parseFamilyKey(args.familyKey);
  const samplesPath = path.resolve(args.samplesPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const samples = readJson(samplesPath);
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1" || samples.runtimeInput !== false) {
    throw new Error("Input samples must be offline reconstruction samples.");
  }
  const sampleFamily = (samples.families ?? []).find((family) => family.familyKey === args.familyKey);
  if (!sampleFamily) throw new Error(`Family ${args.familyKey} not found in samples.`);
  const cliPath = resolveCliPath(args.cliPath);
  const chunkKeys = [...new Set((sampleFamily.samples ?? []).flatMap((sample) =>
    (sample.records ?? []).map((record) => `${sample.replayId}:${record.chunkId}`),
  ))].sort((left, right) => {
    const [leftReplayId, leftChunkId] = left.split(":");
    const [rightReplayId, rightChunkId] = right.split(":");
    return leftReplayId.localeCompare(rightReplayId) ||
      Number.parseInt(leftChunkId, 10) - Number.parseInt(rightChunkId, 10);
  });
  const rows = [];
  const previousFamilyFrequency = {};
  const nextFamilyFrequency = {};
  const centered3GramFrequency = {};
  const centered5GramFrequency = {};
  for (const chunkKey of chunkKeys) {
    const [replayId, chunkIdText] = chunkKey.split(":");
    const chunkId = Number.parseInt(chunkIdText, 10);
    const records = parseChunkDump(runChunkDump(cliPath, replayId, chunkId));
    records.forEach((record, zeroIndex) => {
      if (record.length !== parsed.length || record.firstByteHex !== parsed.firstByteHex) return;
      const previous = records.slice(Math.max(0, zeroIndex - args.windowSize), zeroIndex).map(shortRecord);
      const next = records.slice(zeroIndex + 1, zeroIndex + 1 + args.windowSize).map(shortRecord);
      if (previous.length > 0) increment(previousFamilyFrequency, previous.at(-1).familyKey);
      if (next.length > 0) increment(nextFamilyFrequency, next[0].familyKey);
      const centered = records.slice(Math.max(0, zeroIndex - args.windowSize), zeroIndex + 1 + args.windowSize).map((entry) => entry.familyKey);
      const three = records.slice(Math.max(0, zeroIndex - 1), zeroIndex + 2).map((entry) => entry.familyKey).join(" > ");
      const five = records.slice(Math.max(0, zeroIndex - 2), zeroIndex + 3).map((entry) => entry.familyKey).join(" > ");
      increment(centered3GramFrequency, three);
      increment(centered5GramFrequency, five);
      rows.push({
        replayId,
        chunkId,
        targetOffset: record.offset,
        targetIndex: record.index,
        targetFamilyKey: args.familyKey,
        recordStartOffset: record.offset - 2,
        lengthFieldOffset: record.offset - 2,
        payloadStartOffset: record.offset,
        payloadLength: record.length,
        payloadEndOffset: record.offset + record.length,
        previous,
        target: shortRecord(record),
        next,
        centeredFamilySequence: centered,
      });
    });
  }
  const output = {
    schema: "rofl-reconstruction-target-neighborhood/v1",
    generatedAtUtc: new Date().toISOString(),
    familyKey: args.familyKey,
    mode: "offline-decoder-target-neighborhood",
    runtimeInput: false,
    status: "decoder_context_only_not_runtime_api_data",
    inputDossierPath: path.join(args.artifactRoot, `reconstruction-target-dossier-${safeFamilyKey(args.familyKey)}-16.9.json`).replaceAll("\\", "/"),
    inputSamplesPath: samplesPath,
    cliPath,
    windowSize: args.windowSize,
    rows,
    aggregates: {
      rowCount: rows.length,
      previousFamilyFrequency,
      nextFamilyFrequency,
      centered3GramFrequency,
      centered5GramFrequency,
    },
  };
  if (rows.length === 0) throw new Error(`No target rows found for ${args.familyKey}.`);
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-target-neighborhood-${safeFamilyKey(args.familyKey)}-16.9.json`));
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction target neighborhood to ${outputPath}`);
  console.log(`family=${args.familyKey}, rows=${rows.length}`);
}

main();
