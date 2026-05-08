import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
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
  console.log("Usage: node ./scripts/rank_reconstruction_decoder_targets.mjs [--artifact-root artifacts-keyframes]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function topSequence(family) {
  const buckets = [
    ...(family.topByteSequences?.length8 ?? []),
    ...(family.topByteSequences?.length6 ?? []),
    ...(family.topByteSequences?.length4 ?? []),
  ];
  return buckets.sort((left, right) =>
    right.count - left.count ||
    left.distinctOffsets - right.distinctOffsets ||
    left.value.localeCompare(right.value),
  )[0] ?? null;
}

function repeatedTokenScore(family, sequence) {
  if (!sequence || family.sampledRecords <= 0) {
    return 0;
  }
  const perRecord = sequence.count / family.sampledRecords;
  const offsetSpread = sequence.distinctOffsets / Math.max(1, family.length);
  return clamp((perRecord * 10) - (offsetSpread * 18), 0, 40);
}

function fillerPenalty(family) {
  const topByte = family.topBytes?.[0];
  if (!topByte || family.length <= 0 || family.sampledRecords <= 0) {
    return 0;
  }
  const totalBytes = family.length * family.sampledRecords;
  const byteShare = topByte.count / totalBytes;
  const longRun = (family.topByteSequences?.length8 ?? []).find((sequence) => sequence.value === "65 65 65 65 65 65 65 65");
  const longRunSpread = longRun ? longRun.distinctOffsets / Math.max(1, family.length) : 0;
  let penalty = 0;
  if (byteShare > 0.4) {
    penalty += (byteShare - 0.4) * 80;
  }
  if (longRunSpread > 0.2) {
    penalty += longRunSpread * 30;
  }
  return clamp(penalty, 0, 50);
}

function classifyTarget(score, penalty, family) {
  if (family.length <= 2) {
    return "tiny-token-fragment";
  }
  if (penalty >= 25) {
    return "bulk-or-filler-heavy";
  }
  if (score >= 55) {
    return "primary-structured-token-target";
  }
  if (score >= 30) {
    return "secondary-token-target";
  }
  return "low-priority";
}

function rankFamily(family) {
  const sequence = topSequence(family);
  const targetOnlyScore = family.backgroundRecords === 0 ? 20 : 0;
  const supportScore = clamp((family.targetChunks ?? 0) * 3 + (family.targetIntervals ?? 0) * 4 + (family.sampledReplays ?? 0) * 3, 0, 30);
  const prefixScore = family.commonPrefixBytes > 0 ? clamp(12 - family.commonPrefixBytes, 0, 10) : 0;
  const tokenScore = repeatedTokenScore(family, sequence);
  const penalty = fillerPenalty(family);
  const score = Math.round((targetOnlyScore + supportScore + prefixScore + tokenScore - penalty) * 100) / 100;
  return {
    familyKey: family.familyKey,
    score,
    classification: classifyTarget(score, penalty, family),
    evidence: {
      targetRecords: family.targetRecords,
      backgroundRecords: family.backgroundRecords,
      targetChunks: family.targetChunks,
      targetIntervals: family.targetIntervals,
      sampledRecords: family.sampledRecords,
      sampledReplays: family.sampledReplays,
      commonPrefixBytes: family.commonPrefixBytes,
      topByte: family.topBytes?.[0] ?? null,
      topSequence: sequence,
      fillerPenalty: Math.round(penalty * 100) / 100,
      repeatedTokenScore: Math.round(tokenScore * 100) / 100,
    },
    recommendation: recommendationFor(family, score, penalty, sequence),
  };
}

function recommendationFor(family, score, penalty, sequence) {
  if (family.length <= 2) {
    return "Keep as a possible delimiter/opcode fragment; inspect adjacent records rather than decoding it alone.";
  }
  if (penalty >= 25) {
    return "Deprioritize as a direct event/state record until the surrounding container grammar is clearer.";
  }
  if (score >= 55) {
    return `Inspect this family first; repeated sequence '${sequence?.value ?? "unknown"}' has useful offset evidence.`;
  }
  if (score >= 30) {
    return "Inspect after primary targets; evidence is event-enriched but less structured.";
  }
  return "Retain as background evidence only.";
}

function validateAnalysis(analysis) {
  if (analysis.analysisSchema !== "rofl-reconstruction-family-sample-analysis/v1") {
    throw new Error(`Unexpected sample analysis schema: ${analysis.analysisSchema ?? "missing"}`);
  }
  if (analysis.mode !== "offline-decoder-sample-analysis" || analysis.runtimeInput !== false) {
    throw new Error("Sample analysis must be offline-only and non-runtime.");
  }
}

function validateOutput(output) {
  if (output.rankingSchema !== "rofl-reconstruction-decoder-target-ranking/v1") {
    throw new Error("Unexpected decoder target ranking schema.");
  }
  if (output.mode !== "offline-decoder-target-ranking" || output.runtimeInput !== false) {
    throw new Error("Decoder target ranking must be offline-only and non-runtime.");
  }
  if ((output.targets ?? []).length === 0) {
    throw new Error("Decoder target ranking has no targets.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-family-sample-analysis-16.9.json"));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, "reconstruction-decoder-target-ranking-16.9.json"));
  const analysis = readJson(inputPath);
  validateAnalysis(analysis);
  const targets = (analysis.families ?? [])
    .map(rankFamily)
    .sort((left, right) =>
      right.score - left.score ||
      left.classification.localeCompare(right.classification) ||
      left.familyKey.localeCompare(right.familyKey),
    );
  const output = {
    rankingSchema: "rofl-reconstruction-decoder-target-ranking/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-decoder-target-ranking",
    runtimeInput: false,
    inputPath,
    note: "This ranks offline reverse-engineering targets. It does not promote any family to runtime API parity.",
    targets,
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction decoder target ranking to ${outputPath}`);
  console.log(`targets=${targets.length}, top=${targets[0]?.familyKey ?? "none"} (${targets[0]?.classification ?? "none"})`);
}

main();
