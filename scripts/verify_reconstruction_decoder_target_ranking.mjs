import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    minTargets: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--min-targets" && index + 1 < argv.length) {
      args.minTargets = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/verify_reconstruction_decoder_target_ranking.mjs [--artifact-root artifacts-keyframes] [--input-path <path>]");
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
  assert(output.rankingSchema === "rofl-reconstruction-decoder-target-ranking/v1", "Unexpected decoder target ranking schema.", {
    schema: output.rankingSchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-target-ranking" && output.runtimeInput === false, "Decoder target ranking must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert((output.targets ?? []).length >= args.minTargets, "Too few decoder targets.", {
    targetCount: (output.targets ?? []).length,
    minTargets: args.minTargets,
  });
  let previousScore = Number.POSITIVE_INFINITY;
  for (const target of output.targets ?? []) {
    assert(target.familyKey &&
      Number.isFinite(target.score) &&
      target.score <= previousScore &&
      typeof target.classification === "string" &&
      typeof target.recommendation === "string" &&
      target.evidence?.topByte &&
      Number.isFinite(target.evidence?.fillerPenalty) &&
      Number.isFinite(target.evidence?.repeatedTokenScore),
      "Invalid decoder target row.",
      target,
    );
    previousScore = target.score;
  }
  const primary = (output.targets ?? []).filter((target) => target.classification === "primary-structured-token-target");
  assert(primary.length > 0, "Decoder ranking must identify at least one primary structured-token target.", output.targets);
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "reconstruction-decoder-target-ranking-16.9.json"));
  const output = readJson(inputPath);
  verify(output, args, inputPath);
  console.log(`Verified reconstruction decoder target ranking: ${inputPath}`);
  console.log(`targets=${(output.targets ?? []).length}, top=${output.targets?.[0]?.familyKey ?? "none"}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
