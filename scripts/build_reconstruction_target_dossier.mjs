import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    rankingPath: null,
    analysisPath: null,
    samplesPath: null,
    outputPath: null,
    familyKey: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--ranking-path" && index + 1 < argv.length) {
      args.rankingPath = argv[++index];
    } else if (arg === "--analysis-path" && index + 1 < argv.length) {
      args.analysisPath = argv[++index];
    } else if (arg === "--samples-path" && index + 1 < argv.length) {
      args.samplesPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--family-key" && index + 1 < argv.length) {
      args.familyKey = argv[++index];
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
  console.log("Usage: node ./scripts/build_reconstruction_target_dossier.mjs [--family-key 241-0x02]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validateInputs(ranking, analysis, samples) {
  if (ranking.rankingSchema !== "rofl-reconstruction-decoder-target-ranking/v1" ||
    ranking.mode !== "offline-decoder-target-ranking" ||
    ranking.runtimeInput !== false) {
    throw new Error("Invalid decoder target ranking input.");
  }
  if (analysis.analysisSchema !== "rofl-reconstruction-family-sample-analysis/v1" ||
    analysis.mode !== "offline-decoder-sample-analysis" ||
    analysis.runtimeInput !== false) {
    throw new Error("Invalid family sample analysis input.");
  }
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1" ||
    samples.mode !== "offline-decoder-samples" ||
    samples.runtimeInput !== false) {
    throw new Error("Invalid family samples input.");
  }
}

function collectSampleSummary(sampleFamily) {
  return (sampleFamily.samples ?? []).map((sample) => ({
    replayId: sample.replayId,
    recordCount: sample.recordCount,
    sampledRecords: (sample.records ?? []).length,
    chunks: [...new Set((sample.records ?? []).map((record) => record.chunkId))].sort((left, right) => left - right),
    offsets: (sample.records ?? []).map((record) => record.offset).slice(0, 12),
    firstHexPreview: sample.records?.[0]?.hex?.slice(0, 96) ?? null,
  }));
}

function validateOutput(output) {
  if (output.dossierSchema !== "rofl-reconstruction-target-dossier/v1") {
    throw new Error("Unexpected target dossier schema.");
  }
  if (output.mode !== "offline-decoder-target-dossier" || output.runtimeInput !== false) {
    throw new Error("Target dossier must be offline-only and non-runtime.");
  }
  if (!output.familyKey || !output.ranking || !output.analysis || (output.sampleSummary ?? []).length === 0) {
    throw new Error("Target dossier is missing required evidence.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const rankingPath = path.resolve(args.rankingPath ?? path.join(args.artifactRoot, "reconstruction-decoder-target-ranking-16.9.json"));
  const analysisPath = path.resolve(args.analysisPath ?? path.join(args.artifactRoot, "reconstruction-family-sample-analysis-16.9.json"));
  const samplesPath = path.resolve(args.samplesPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const ranking = readJson(rankingPath);
  const analysis = readJson(analysisPath);
  const samples = readJson(samplesPath);
  validateInputs(ranking, analysis, samples);
  const familyKey = args.familyKey ?? ranking.targets?.[0]?.familyKey;
  const rankingTarget = (ranking.targets ?? []).find((target) => target.familyKey === familyKey);
  const analysisFamily = (analysis.families ?? []).find((family) => family.familyKey === familyKey);
  const sampleFamily = (samples.families ?? []).find((family) => family.familyKey === familyKey);
  if (!rankingTarget || !analysisFamily || !sampleFamily) {
    throw new Error(`Family ${familyKey} not found in ranking, analysis, and samples.`);
  }
  const output = {
    dossierSchema: "rofl-reconstruction-target-dossier/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-target-dossier",
    runtimeInput: false,
    familyKey,
    inputPaths: {
      rankingPath,
      analysisPath,
      samplesPath,
    },
    status: "decoder_target_only_not_runtime_api_data",
    nextDecoderQuestion: "Determine whether the repeated token grammar in this family maps to chunk-delta events/state updates between keyframes.",
    ranking: rankingTarget,
    analysis: {
      length: analysisFamily.length,
      firstByte: analysisFamily.firstByte,
      sampledRecords: analysisFamily.sampledRecords,
      sampledReplays: analysisFamily.sampledReplays,
      commonPrefixBytes: analysisFamily.commonPrefixBytes,
      stabilityMap: analysisFamily.stabilityMap,
      topBytes: analysisFamily.topBytes,
      topU16Words: analysisFamily.topU16Words,
      topU32Words: analysisFamily.topU32Words,
      topByteSequences: analysisFamily.topByteSequences,
    },
    sampleSummary: collectSampleSummary(sampleFamily),
  };
  validateOutput(output);
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-target-dossier-${familyKey.replace(/[^A-Za-z0-9]+/g, "-")}-16.9.json`));
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction target dossier to ${outputPath}`);
  console.log(`family=${familyKey}, classification=${rankingTarget.classification}, score=${rankingTarget.score}`);
}

main();
