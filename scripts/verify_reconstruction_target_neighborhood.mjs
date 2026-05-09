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
      console.log("Usage: node ./scripts/verify_reconstruction_target_neighborhood.mjs [--family-key 241-0x02]");
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
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-target-neighborhood-${safeFamilyKey(args.familyKey)}-16.9.json`));
  const output = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const expectedDossierPath = path.resolve(args.artifactRoot, `reconstruction-target-dossier-${safeFamilyKey(args.familyKey)}-16.9.json`);
  const normalizedInputDossierPath = path.resolve(output.inputDossierPath ?? "");
  assert(output.schema === "rofl-reconstruction-target-neighborhood/v1", "Unexpected neighborhood schema.", output.schema);
  assert(output.mode === "offline-decoder-target-neighborhood" && output.runtimeInput === false, "Neighborhood must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert(output.status === "decoder_context_only_not_runtime_api_data", "Neighborhood must not claim runtime API data.", output.status);
  assert(output.familyKey === args.familyKey, "Neighborhood family mismatch.", { expected: args.familyKey, actual: output.familyKey });
  assert(output.inputDossierPath != null && normalizedInputDossierPath === expectedDossierPath && fs.existsSync(expectedDossierPath), "Neighborhood input dossier must match the target family and exist.", {
    inputDossierPath: output.inputDossierPath,
    expectedDossierPath,
  });
  assert((output.rows ?? []).length > 0, "Neighborhood rows are empty.");
  let previousSortKey = null;
  for (const row of output.rows ?? []) {
    const sortKey = `${row.replayId}:${String(row.chunkId).padStart(6, "0")}:${String(row.targetOffset).padStart(12, "0")}`;
    assert(previousSortKey == null || previousSortKey <= sortKey, "Neighborhood rows must be sorted by replay, chunk, and target offset.", {
      previousSortKey,
      sortKey,
      row,
    });
    previousSortKey = sortKey;
    assert(row.targetFamilyKey === args.familyKey && row.target?.familyKey === args.familyKey, "Target row has wrong family.", row);
    assert(Number.isFinite(row.recordStartOffset) && Number.isFinite(row.lengthFieldOffset) &&
      Number.isFinite(row.payloadStartOffset) && Number.isFinite(row.payloadLength) &&
      Number.isFinite(row.payloadEndOffset), "Target offsets are incomplete.", row);
    assert(row.lengthFieldOffset === row.payloadStartOffset - 2, "Length prefix offset should immediately precede payload.", row);
    assert(row.payloadEndOffset === row.payloadStartOffset + row.payloadLength, "Payload end offset mismatch.", row);
    assert(row.target?.headerHex === "F100", "Target headerHex should preserve the little-endian 241 length prefix.", row.target);
    assert(Array.isArray(row.previous) && Array.isArray(row.next), "Previous/next windows are missing.", row);
    assert(Array.isArray(row.centeredFamilySequence) && row.centeredFamilySequence.includes(args.familyKey), "Centered family sequence is missing target.", row);
  }
  assert(output.aggregates?.rowCount === output.rows.length, "Aggregate row count mismatch.", output.aggregates);
  assert(Object.keys(output.aggregates?.centered3GramFrequency ?? {}).length > 0, "Missing centered 3-gram aggregates.");
  console.log(`Verified reconstruction target neighborhood: ${inputPath}`);
  console.log(`family=${output.familyKey}, rows=${output.rows.length}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
