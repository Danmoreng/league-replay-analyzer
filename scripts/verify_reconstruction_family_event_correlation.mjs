import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = { artifactRoot: "artifacts-keyframes", inputPath: null, versionGroup: "16.9" };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_reconstruction_family_event_correlation.mjs [--version-group 16.9]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, details = null) {
  if (!condition) throw new Error(`${message}${details == null ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-family-event-correlation-${args.versionGroup}.json`));
  const output = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  assert(output.schema === "rofl-reconstruction-family-event-correlation/v1", "Unexpected event correlation schema.", output.schema);
  assert(output.mode === "offline-validation-only" && output.runtimeInput === false, "Event correlation must be offline-only and non-runtime.", {
    mode: output.mode,
    runtimeInput: output.runtimeInput,
  });
  assert(output.status === "offline_validation_only_not_runtime_api_data", "Event correlation must not claim runtime API parity.", output.status);
  assert(output.promotionAssessment?.runtimeApiData === false, "Event correlation must not promote runtime API data.", output.promotionAssessment);
  assert(output.promotionAssessment?.status === "not_promoted", "Event correlation must remain not_promoted.", output.promotionAssessment);
  assert((output.promotionAssessment?.reasons ?? []).some((reason) => reason.includes("offline validation labels")), "Event correlation promotion assessment must mention offline validation labels.", output.promotionAssessment);
  assert(output.versionGroup === args.versionGroup, "Version group mismatch.", { expected: args.versionGroup, actual: output.versionGroup });
  assert((output.rows ?? []).length >= 10, "Event correlation needs enough selected intervals.", output.selection);
  assert((output.rows ?? []).some((row) => row.cohort === "eventful") && (output.rows ?? []).some((row) => row.cohort === "quiet"), "Event correlation must include eventful and quiet cohorts.");
  assert((output.correlations ?? []).length > 0, "Event correlation rows are missing.");
  assert(output.normalization?.familyRates?.includes("total subrecords"), "Event correlation must document subrecord normalization.", output.normalization);
  assert(output.normalization?.specificEnrichment?.includes("all eventful intervals"), "Event correlation must document specific enrichment normalization.", output.normalization);
  assert(output.correlationMethods?.spearman?.includes("average ranks"), "Event correlation must document tied-rank Spearman handling.", output.correlationMethods);
  assert(output.correlationMethods?.pearson?.includes("normalized family rates"), "Event correlation must document Pearson inputs.", output.correlationMethods);
  for (const familyKey of ["241-0x02", "241-0x04"]) {
    assert((output.selection?.familyKeys ?? []).includes(familyKey), `Missing target family ${familyKey}.`, output.selection);
    assert((output.correlations ?? []).some((row) => row.familyKey === familyKey && row.category === "total"), `Missing total correlation for ${familyKey}.`);
  }
  const badRows = (output.rows ?? []).filter((row) =>
    !row.replayId ||
    !Number.isFinite(row.apiIntervalIndex) ||
    !Number.isFinite(row.totalSubrecords) ||
    row.totalSubrecords <= 0 ||
    row.eventCounts == null ||
    row.familyCounts == null ||
    row.familyRates == null
  );
  assert(badRows.length === 0, "Invalid event correlation interval rows.", badRows.slice(0, 3));
  const invalidRates = (output.rows ?? []).flatMap((row) =>
    Object.entries(row.familyRates ?? {})
      .filter(([, rate]) => !Number.isFinite(rate) || rate < 0 || rate > 1)
      .map(([familyKey, rate]) => ({ replayId: row.replayId, apiIntervalIndex: row.apiIntervalIndex, familyKey, rate })),
  );
  assert(invalidRates.length === 0, "Event correlation has invalid normalized family rates.", invalidRates.slice(0, 5));
  const invalidCorrelations = (output.correlations ?? []).filter((row) =>
    row.familyKey == null ||
    row.category == null ||
    (row.pearson != null && (!Number.isFinite(row.pearson) || row.pearson < -1 || row.pearson > 1)) ||
    (row.spearman != null && (!Number.isFinite(row.spearman) || row.spearman < -1 || row.spearman > 1)) ||
    (row.specificEnrichment != null && (!Number.isFinite(row.specificEnrichment) || row.specificEnrichment < 0))
  );
  assert(invalidCorrelations.length === 0, "Event correlation has invalid correlation rows.", invalidCorrelations.slice(0, 5));
  console.log(`Verified reconstruction family event correlation: ${inputPath}`);
  console.log(`intervals=${output.rows.length}, correlations=${output.correlations.length}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
