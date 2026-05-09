import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = { artifactRoot: "artifacts-keyframes", inputPath: null, familyKey: "241-0x02" };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--family-key" && index + 1 < argv.length) args.familyKey = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_reconstruction_target_table_analysis.mjs [--family-key 241-0x02]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function safeFamilyKey(familyKey) {
  return familyKey.replace(/[^A-Za-z0-9]+/g, "-");
}

function assert(condition, message, details = null) {
  if (!condition) throw new Error(`${message}${details == null ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-target-table-analysis-${safeFamilyKey(args.familyKey)}-16.9.json`));
  const output = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  assert(output.schema === "rofl-reconstruction-target-table-analysis/v1", "Unexpected table analysis schema.", output.schema);
  assert(output.mode === "offline-decoder-target-table-analysis" && output.runtimeInput === false, "Table analysis must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert(output.status === "decoder_hypothesis_only_not_runtime_api_data", "Table analysis must remain a hypothesis artifact.", output.status);
  assert(output.familyKey === args.familyKey, "Table analysis family mismatch.", { expected: args.familyKey, actual: output.familyKey });
  assert(output.hypothesis?.payloadLength === 241 && output.hypothesis?.headerBytes === 1 &&
    output.hypothesis?.rowCount === 10 && output.hypothesis?.rowSize === 24, "Unexpected table hypothesis.", output.hypothesis);
  assert((output.records ?? []).length > 0, "Table analysis has no records.");
  for (const record of output.records ?? []) {
    assert((record.rowHex ?? []).length === 10, "Record does not split into 10 rows.", record);
    assert(record.rowHex.every((row) => typeof row === "string" && row.length === 48), "Record row size is not 24 bytes.", record);
  }
  const types = new Set((output.fieldInterpretations ?? []).map((entry) => entry.type));
  for (const type of ["u16", "i16", "u32", "i32", "f32"]) {
    assert(types.has(type), `Missing ${type} field interpretation.`);
  }
  assert(Number.isFinite(output.coherenceScores?.sameRowWins) &&
    Number.isFinite(output.coherenceScores?.comparisons) &&
    Array.isArray(output.coherenceScores?.perRow) &&
    output.coherenceScores.perRow.length === 10, "Missing row coherence scores.", output.coherenceScores);
  assert(output.promotionAssessment?.runtimeApiData === false, "Table analysis must not promote runtime API data.", output.promotionAssessment);
  assert(["not_promoted", "review_required"].includes(output.promotionAssessment?.status), "Table analysis has invalid promotion status.", output.promotionAssessment);
  assert((output.promotionAssessment?.reasons ?? []).length > 0, "Table analysis promotion assessment must explain its status.", output.promotionAssessment);
  console.log(`Verified reconstruction target table analysis: ${inputPath}`);
  console.log(`family=${output.familyKey}, records=${output.records.length}, sameRowWinRate=${output.coherenceScores.sameRowWinRate}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
