import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    familyKey: "241-0x02",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
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
  console.log("Usage: node ./scripts/verify_reconstruction_target_dossier.mjs [--family-key 241-0x02]");
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

function safeFamilyKey(familyKey) {
  return familyKey.replace(/[^A-Za-z0-9]+/g, "-");
}

function verify(output, args, inputPath) {
  assert(output.dossierSchema === "rofl-reconstruction-target-dossier/v1", "Unexpected target dossier schema.", {
    schema: output.dossierSchema,
    inputPath,
  });
  assert(output.mode === "offline-decoder-target-dossier" && output.runtimeInput === false, "Target dossier must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert(output.familyKey === args.familyKey, "Target dossier family mismatch.", {
    expected: args.familyKey,
    actual: output.familyKey,
  });
  assert(output.status === "decoder_target_only_not_runtime_api_data", "Target dossier must not promote runtime API data.", output.status);
  assert(output.ranking?.classification === "primary-structured-token-target" &&
    (output.ranking?.score ?? 0) > 0 &&
    output.analysis?.sampledRecords > 0 &&
    (output.analysis?.topByteSequences?.length4 ?? []).length > 0 &&
    (output.sampleSummary ?? []).length > 0,
    "Target dossier is missing primary evidence.",
    output,
  );
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-target-dossier-${safeFamilyKey(args.familyKey)}-16.9.json`));
  const output = readJson(inputPath);
  verify(output, args, inputPath);
  console.log(`Verified reconstruction target dossier: ${inputPath}`);
  console.log(`family=${output.familyKey}, classification=${output.ranking.classification}, score=${output.ranking.score}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
