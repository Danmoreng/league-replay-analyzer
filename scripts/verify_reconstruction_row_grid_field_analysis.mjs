import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    inputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
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
  console.log("Usage: node ./scripts/verify_reconstruction_row_grid_field_analysis.mjs [--artifact-root artifacts-keyframes] [--version-group 16.9]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-row-grid-field-analysis-${args.versionGroup}.json`));
  const artifact = readJson(inputPath);

  assert(artifact.schema === "rofl-reconstruction-row-grid-field-analysis/v1", "Unexpected row-grid field analysis schema.");
  assert(artifact.mode === "offline-row-grid-field-analysis", "Unexpected row-grid field analysis mode.");
  assert(artifact.runtimeInput === false, "Row-grid field analysis must be non-runtime.");
  assert(artifact.status === "field_hypothesis_only_not_runtime_api_data", "Unexpected row-grid field analysis status.");
  assert(artifact.versionGroup === args.versionGroup, "Version group mismatch.");
  assert((artifact.candidates ?? []).length > 0, "No row-grid field candidates.");
  assert((artifact.candidates ?? []).every((candidate) =>
    candidate.runtimeInput === false &&
    candidate.runtimeApiData === false &&
    candidate.participantIdentity === false &&
    candidate.fieldPromotionAssessment?.status === "not_promoted" &&
    (candidate.columns ?? []).length === candidate.hypothesis?.rowSize
  ), "Field candidates must remain non-runtime, non-identity hypotheses with complete columns.");
  assert((artifact.candidates ?? []).some((candidate) =>
    (candidate.rowDiscriminatorColumns ?? []).length > 0 ||
    (candidate.recordConstantColumns ?? []).length > 0
  ), "Field analysis should identify at least one byte-column signal or constant.");
  assert((artifact.candidates ?? []).some((candidate) => candidate.familyKey === "241-0x04"), "Expected 241-0x04 field analysis candidate missing.");

  console.log(`Verified reconstruction row-grid field analysis: ${inputPath}`);
  console.log(`candidates=${artifact.candidates.length}, top=${artifact.candidates[0]?.familyKey ?? "none"}`);
}

main();
