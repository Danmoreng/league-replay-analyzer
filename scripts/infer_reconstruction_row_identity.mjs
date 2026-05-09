import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    familyKey: "241-0x02",
    minCoherence: 0.75,
    duplicateRateThreshold: 0.5,
    versionGroup: "16.9",
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--family-key" && index + 1 < argv.length) args.familyKey = argv[++index];
    else if (arg === "--min-coherence" && index + 1 < argv.length) args.minCoherence = Number.parseFloat(argv[++index]);
    else if (arg === "--duplicate-rate-threshold" && index + 1 < argv.length) args.duplicateRateThreshold = Number.parseFloat(argv[++index]);
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/infer_reconstruction_row_identity.mjs [--family-key 241-0x02] [--version-group 16.9]");
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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function buildRowDuplicateEvidence(records, rowCount) {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    let duplicateRecordCount = 0;
    for (const record of records) {
      const rowHex = record.rowHex?.[rowIndex];
      if (!rowHex) continue;
      const sameRowCount = (record.rowHex ?? []).filter((candidate) => candidate === rowHex).length;
      if (sameRowCount > 1) {
        duplicateRecordCount += 1;
      }
    }
    return {
      rowIndex,
      duplicateRecordCount,
      recordCount: records.length,
      duplicateRecordRate: records.length ? duplicateRecordCount / records.length : null,
    };
  });
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-target-table-analysis-${safeFamilyKey(args.familyKey)}-${args.versionGroup}.json`));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-row-identity-${safeFamilyKey(args.familyKey)}-${args.versionGroup}.json`));
  const table = readJson(inputPath);
  if (table.schema !== "rofl-reconstruction-target-table-analysis/v1" || table.runtimeInput !== false) {
    throw new Error("Input must be an offline reconstruction target table analysis artifact.");
  }
  const sameRowWinRate = table.coherenceScores?.sameRowWinRate ?? null;
  const rowTrackCoherence = Number.isFinite(sameRowWinRate) && sameRowWinRate >= args.minCoherence;
  const rowCount = table.hypothesis?.rowCount ?? 0;
  const duplicateEvidence = buildRowDuplicateEvidence(table.records ?? [], rowCount);
  const perRowCoherence = new Map((table.coherenceScores?.perRow ?? []).map((row) => [row.rowIndex, row]));
  const output = {
    schema: "rofl-reconstruction-row-identity/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    familyKey: args.familyKey,
    mode: "offline-row-identity-gate",
    runtimeInput: false,
    status: "identity_gate_only_not_runtime_api_data",
    inputPath,
    hypothesis: {
      rowCount: table.hypothesis?.rowCount ?? null,
      rowSize: table.hypothesis?.rowSize ?? null,
      payloadLength: table.hypothesis?.payloadLength ?? null,
      minCoherence: args.minCoherence,
      duplicateRateThreshold: args.duplicateRateThreshold,
    },
    evidence: {
      sameRowWinRate,
      tablePromotionStatus: table.promotionAssessment?.status ?? null,
      rowTrackCoherence,
      duplicateRejectedRowCount: duplicateEvidence.filter((row) =>
        Number.isFinite(row.duplicateRecordRate) && row.duplicateRecordRate >= args.duplicateRateThreshold,
      ).length,
    },
    promotionAssessment: {
      status: rowTrackCoherence ? "review_required" : "not_promoted",
      runtimeApiData: false,
      participantIdentity: false,
      reasons: rowTrackCoherence
        ? [
          "row coherence meets the review threshold, but field semantics and participant mapping are not decoded here",
        ]
        : [
          "row coherence is below the identity promotion threshold",
          "row-to-participant mapping is not established from ROFL-only evidence",
          "field semantics are not decoded",
        ],
    },
    rowIdentity: duplicateEvidence.map((row) => {
      const duplicateRejected = Number.isFinite(row.duplicateRecordRate) && row.duplicateRecordRate >= args.duplicateRateThreshold;
      const coherence = perRowCoherence.get(row.rowIndex) ?? {};
      return {
        rowIndex: row.rowIndex,
        status: duplicateRejected ? "duplicate_rejected" : rowTrackCoherence ? "review_required" : "unstable_identity",
        participantId: null,
        runtimeApiData: false,
        sameRowWinRate: coherence.sameRowWinRate ?? null,
        duplicateRecordCount: row.duplicateRecordCount,
        duplicateRecordRate: row.duplicateRecordRate,
        reason: duplicateRejected
          ? "same row bytes are duplicated inside too many records to identify one participant"
          : "row continuity is below the identity threshold or lacks participant mapping",
      };
    }),
  };
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction row identity gate to ${outputPath}`);
  console.log(`family=${args.familyKey}, promotion=${output.promotionAssessment.status}, sameRowWinRate=${sameRowWinRate}`);
}

main();
