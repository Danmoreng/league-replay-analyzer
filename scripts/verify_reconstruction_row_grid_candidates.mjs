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
  console.log("Usage: node ./scripts/verify_reconstruction_row_grid_candidates.mjs [--artifact-root artifacts-keyframes] [--version-group 16.9]");
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
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-row-grid-candidates-${args.versionGroup}.json`));
  const artifact = readJson(inputPath);

  assert(artifact.schema === "rofl-reconstruction-row-grid-candidates/v1", "Unexpected row-grid candidate schema.");
  assert(artifact.mode === "offline-row-grid-candidate-scan", "Unexpected row-grid candidate mode.");
  assert(artifact.runtimeInput === false, "Row-grid candidate scan must not be runtime input.");
  assert(artifact.status === "candidate_scan_only_not_runtime_api_data", "Unexpected row-grid candidate status.");
  assert(artifact.versionGroup === args.versionGroup, "Version group mismatch.");
  assert(Number.isInteger(artifact.scannedFamilies) && artifact.scannedFamilies > 0, "No scanned families recorded.");
  assert(Number.isInteger(artifact.candidateCount) && artifact.candidateCount > 0, "No row-grid candidates recorded.");
  assert((artifact.candidates ?? []).length === artifact.candidateCount, "Candidate count mismatch.");
  assert((artifact.topCandidates ?? []).length > 0, "Missing top candidates.");
  assert((artifact.candidates ?? []).every((candidate) =>
    candidate.runtimeApiData === false &&
    candidate.participantIdentity === false &&
    ["not_promoted", "promotable_shape_candidate_needs_semantics"].includes(candidate.status) &&
    [5, 10].includes(candidate.hypothesis?.rowCount) &&
    Number.isFinite(candidate.sameRowWinRate) &&
    Number.isFinite(candidate.nearestSameIndexRate) &&
    Number.isFinite(candidate.duplicateRowRate) &&
    Number.isFinite(candidate.score) &&
    (candidate.perRow ?? []).length === candidate.hypothesis.rowCount
  ), "Row-grid candidates must remain non-runtime shape hypotheses with complete per-row evidence.");
  assert((artifact.candidates ?? []).some((candidate) => candidate.familyKey === "241-0x02" && candidate.hypothesis.rowCount === 10), "Missing known 241-0x02 ten-row control candidate.");
  assert((artifact.candidates ?? []).some((candidate) => candidate.familyKey === "241-0x04" && candidate.hypothesis.rowCount === 10), "Missing known 241-0x04 ten-row control candidate.");

  console.log(`Verified reconstruction row-grid candidates: ${inputPath}`);
  console.log(`candidates=${artifact.candidateCount}, top=${artifact.topCandidates[0]?.familyKey ?? "none"} score=${artifact.topCandidates[0]?.score ?? 0}`);
}

main();
