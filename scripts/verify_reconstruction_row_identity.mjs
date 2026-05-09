import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    familyKey: "241-0x02",
    minCoherence: 0.75,
    duplicateRateThreshold: 0.5,
    versionGroup: "16.9",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--family-key" && index + 1 < argv.length) args.familyKey = argv[++index];
    else if (arg === "--min-coherence" && index + 1 < argv.length) args.minCoherence = Number.parseFloat(argv[++index]);
    else if (arg === "--duplicate-rate-threshold" && index + 1 < argv.length) args.duplicateRateThreshold = Number.parseFloat(argv[++index]);
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_reconstruction_row_identity.mjs [--family-key 241-0x02] [--version-group 16.9]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!Number.isFinite(args.minCoherence) || args.minCoherence < 0 || args.minCoherence > 1) {
    throw new Error("--min-coherence must be a number in [0, 1].");
  }
  if (!Number.isFinite(args.duplicateRateThreshold) || args.duplicateRateThreshold < 0 || args.duplicateRateThreshold > 1) {
    throw new Error("--duplicate-rate-threshold must be a number in [0, 1].");
  }
  return args;
}

function safeFamilyKey(familyKey) {
  return familyKey.replace(/[^A-Za-z0-9]+/g, "-");
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
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-row-identity-${safeFamilyKey(args.familyKey)}-${args.versionGroup}.json`));
  const artifact = readJson(inputPath);

  assert(artifact.schema === "rofl-reconstruction-row-identity/v1", `Unexpected schema: ${artifact.schema ?? "missing"}`);
  assert(artifact.versionGroup === args.versionGroup, `Version group mismatch: ${artifact.versionGroup ?? "missing"}`);
  assert(artifact.familyKey === args.familyKey, `Family key mismatch: ${artifact.familyKey ?? "missing"}`);
  assert(artifact.mode === "offline-row-identity-gate", `Unexpected mode: ${artifact.mode ?? "missing"}`);
  assert(artifact.runtimeInput === false, "Row identity gate must be non-runtime.");
  assert(artifact.status === "identity_gate_only_not_runtime_api_data", `Unexpected status: ${artifact.status ?? "missing"}`);
  assert(artifact.hypothesis?.rowCount === 10, `Expected 10 rows, got ${artifact.hypothesis?.rowCount ?? "missing"}`);
  assert(artifact.hypothesis?.rowSize === 24, `Expected 24-byte rows, got ${artifact.hypothesis?.rowSize ?? "missing"}`);
  assert(artifact.hypothesis?.payloadLength === 241, `Expected 241-byte payload, got ${artifact.hypothesis?.payloadLength ?? "missing"}`);
  assert(artifact.hypothesis?.minCoherence === args.minCoherence, `Min coherence mismatch: ${artifact.hypothesis?.minCoherence ?? "missing"}`);
  assert(artifact.hypothesis?.duplicateRateThreshold === args.duplicateRateThreshold, `Duplicate rate threshold mismatch: ${artifact.hypothesis?.duplicateRateThreshold ?? "missing"}`);
  assert(Number.isFinite(artifact.evidence?.sameRowWinRate), "sameRowWinRate must be finite.");
  assert(artifact.evidence.sameRowWinRate < args.minCoherence, "Current 241 row identity gate should remain below promotion threshold.");
  assert(artifact.evidence?.rowTrackCoherence === false, "rowTrackCoherence should be false below threshold.");
  assert(Number.isInteger(artifact.evidence?.duplicateRejectedRowCount), "duplicateRejectedRowCount must be an integer.");
  assert(artifact.promotionAssessment?.status === "not_promoted", `Promotion status must remain not_promoted, got ${artifact.promotionAssessment?.status ?? "missing"}`);
  assert(artifact.promotionAssessment?.runtimeApiData === false, "Promotion assessment must not emit runtime API data.");
  assert(artifact.promotionAssessment?.participantIdentity === false, "Promotion assessment must not claim participant identity.");
  assert((artifact.promotionAssessment?.reasons ?? []).some((reason) => reason.includes("below the identity promotion threshold")), "Promotion reasons must mention the identity threshold.");
  assert((artifact.promotionAssessment?.reasons ?? []).some((reason) => reason.includes("row-to-participant mapping")), "Promotion reasons must mention missing row-to-participant mapping.");
  assert((artifact.rowIdentity ?? []).length === 10, `Expected 10 row identity entries, got ${(artifact.rowIdentity ?? []).length}`);
  const allowedStatuses = new Set(["unstable_identity", "duplicate_rejected"]);
  let unstableCount = 0;
  let duplicateRejectedCount = 0;
  for (const [index, row] of artifact.rowIdentity.entries()) {
    assert(row.rowIndex === index, `Row index mismatch at ${index}: ${row.rowIndex ?? "missing"}`);
    assert(allowedStatuses.has(row.status), `Row ${index} has unexpected status: ${row.status ?? "missing"}`);
    assert(row.participantId === null, `Row ${index} should not expose participantId.`);
    assert(row.runtimeApiData === false, `Row ${index} must be non-runtime.`);
    assert(Number.isFinite(row.sameRowWinRate) || row.sameRowWinRate === null, `Row ${index} sameRowWinRate must be finite or null.`);
    assert(Number.isInteger(row.duplicateRecordCount), `Row ${index} duplicateRecordCount must be an integer.`);
    assert(Number.isFinite(row.duplicateRecordRate), `Row ${index} duplicateRecordRate must be finite.`);
    if (row.status === "unstable_identity") unstableCount += 1;
    if (row.status === "duplicate_rejected") {
      duplicateRejectedCount += 1;
      assert(row.duplicateRecordRate >= args.duplicateRateThreshold, `Row ${index} duplicate_rejected below threshold.`);
      assert((row.reason ?? "").includes("duplicated"), `Row ${index} duplicate_rejected reason must mention duplication.`);
    }
  }
  assert(unstableCount > 0, "At least one row should remain unstable_identity.");
  assert(duplicateRejectedCount === artifact.evidence.duplicateRejectedRowCount, "duplicateRejectedRowCount must match rowIdentity statuses.");

  console.log(`Verified reconstruction row identity gate: ${inputPath}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
