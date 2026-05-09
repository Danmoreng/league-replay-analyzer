import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    candidateLimit: 8,
    inputPath: null,
    samplesPath: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--candidate-limit" && index + 1 < argv.length) {
      args.candidateLimit = Number.parseInt(argv[++index], 10);
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--samples-path" && index + 1 < argv.length) {
      args.samplesPath = argv[++index];
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
  console.log("Usage: node ./scripts/analyze_reconstruction_row_grid_fields.mjs [--artifact-root artifacts-keyframes] [--version-group 16.9]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function hexToBytes(hex) {
  const bytes = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytes;
}

function byteHex(value) {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function flattenRecords(samples, familyKey) {
  const family = (samples.families ?? []).find((entry) => entry.familyKey === familyKey);
  return (family?.samples ?? [])
    .flatMap((sample) =>
      (sample.records ?? []).map((record) => ({
        replayId: sample.replayId,
        chunkId: record.chunkId,
        offset: record.offset,
        bytes: hexToBytes(record.hex),
      })),
    )
    .sort((left, right) =>
      left.replayId.localeCompare(right.replayId) ||
      left.chunkId - right.chunkId ||
      left.offset - right.offset,
    );
}

function rowsForRecord(record, hypothesis) {
  return Array.from({ length: hypothesis.rowCount }, (_, rowIndex) => {
    const start = hypothesis.headerBytes + rowIndex * hypothesis.rowSize;
    return record.bytes.slice(start, start + hypothesis.rowSize);
  });
}

function summarizeValues(values, limit = 8) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, limit)
    .map(([value, count]) => ({ value: byteHex(value), count }));
}

function analyzeByteColumns(records, candidate) {
  const { rowCount, rowSize } = candidate.hypothesis;
  const rowsByRecord = records.map((record) => rowsForRecord(record, candidate.hypothesis));
  const columns = [];
  for (let byteOffset = 0; byteOffset < rowSize; byteOffset += 1) {
    const values = rowsByRecord.flatMap((rows) => rows.map((row) => row[byteOffset]));
    const distinctValues = new Set(values);
    const rowDistinctCounts = Array.from({ length: rowCount }, (_, rowIndex) =>
      new Set(rowsByRecord.map((rows) => rows[rowIndex][byteOffset])).size,
    );
    const rowConstantCount = rowDistinctCounts.filter((count) => count === 1).length;
    const perRecordDistinctCounts = rowsByRecord.map((rows) => new Set(rows.map((row) => row[byteOffset])).size);
    const meanPerRecordDistinctCount = perRecordDistinctCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, perRecordDistinctCounts.length);
    columns.push({
      byteOffset,
      distinctValueCount: distinctValues.size,
      topValues: summarizeValues(values),
      rowConstantCount,
      maxRowDistinctCount: Math.max(...rowDistinctCounts),
      rowDistinctCounts,
      meanPerRecordDistinctCount,
      likelyRowDiscriminator: meanPerRecordDistinctCount >= Math.min(4, rowCount) && rowConstantCount >= Math.ceil(rowCount * 0.6),
      likelyRecordConstant: distinctValues.size <= 2 && rowConstantCount >= Math.ceil(rowCount * 0.8),
    });
  }
  return columns;
}

function summarizeCandidate(candidate, samples) {
  const records = flattenRecords(samples, candidate.familyKey);
  const columns = analyzeByteColumns(records, candidate);
  const rowDiscriminatorColumns = columns
    .filter((column) => column.likelyRowDiscriminator)
    .sort((left, right) =>
      right.meanPerRecordDistinctCount - left.meanPerRecordDistinctCount ||
      left.maxRowDistinctCount - right.maxRowDistinctCount ||
      left.byteOffset - right.byteOffset,
    );
  const recordConstantColumns = columns
    .filter((column) => column.likelyRecordConstant)
    .sort((left, right) => left.distinctValueCount - right.distinctValueCount || left.byteOffset - right.byteOffset);

  return {
    familyKey: candidate.familyKey,
    hypothesis: candidate.hypothesis,
    candidateScore: candidate.score,
    candidateStatus: candidate.status,
    runtimeInput: false,
    runtimeApiData: false,
    participantIdentity: false,
    recordCount: records.length,
    replayCount: new Set(records.map((record) => record.replayId)).size,
    rowContinuity: {
      sameRowWinRate: candidate.sameRowWinRate,
      nearestSameIndexRate: candidate.nearestSameIndexRate,
      duplicateRowRate: candidate.duplicateRowRate,
    },
    fieldPromotionAssessment: {
      status: "not_promoted",
      reasons: [
        "byte columns are unlabeled ROFL row-grid evidence",
        "row discriminator candidates are not mapped to roster order, team, champion, or participantId",
        "row continuity remains below participant identity promotion gates",
      ],
    },
    rowDiscriminatorColumns: rowDiscriminatorColumns.slice(0, 8),
    recordConstantColumns: recordConstantColumns.slice(0, 8),
    columns,
  };
}

function validateCandidateScan(scan) {
  if (scan.schema !== "rofl-reconstruction-row-grid-candidates/v1") {
    throw new Error(`Unexpected row-grid candidate schema: ${scan.schema ?? "missing"}`);
  }
  if (scan.mode !== "offline-row-grid-candidate-scan" || scan.runtimeInput !== false) {
    throw new Error("Row-grid candidate scan must be offline-only and non-runtime.");
  }
}

function validateSamples(samples) {
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1") {
    throw new Error(`Unexpected family samples schema: ${samples.sampleSchema ?? "missing"}`);
  }
  if (samples.mode !== "offline-decoder-samples" || samples.runtimeInput !== false) {
    throw new Error("Family samples must be offline-only and non-runtime.");
  }
}

function validateOutput(output) {
  if (output.schema !== "rofl-reconstruction-row-grid-field-analysis/v1") {
    throw new Error("Unexpected row-grid field analysis schema.");
  }
  if (output.mode !== "offline-row-grid-field-analysis" || output.runtimeInput !== false) {
    throw new Error("Row-grid field analysis must be offline-only and non-runtime.");
  }
  if ((output.candidates ?? []).length === 0) {
    throw new Error("Row-grid field analysis has no candidates.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-row-grid-candidates-${args.versionGroup}.json`));
  const samplesPath = path.resolve(args.samplesPath ?? path.join(args.artifactRoot, `reconstruction-family-samples-${args.versionGroup}.json`));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-row-grid-field-analysis-${args.versionGroup}.json`));
  const scan = readJson(inputPath);
  const samples = readJson(samplesPath);
  validateCandidateScan(scan);
  validateSamples(samples);

  const candidates = (scan.topCandidates ?? [])
    .slice(0, args.candidateLimit)
    .map((candidate) => summarizeCandidate(candidate, samples));
  const output = {
    schema: "rofl-reconstruction-row-grid-field-analysis/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    mode: "offline-row-grid-field-analysis",
    runtimeInput: false,
    status: "field_hypothesis_only_not_runtime_api_data",
    inputPath,
    samplesPath,
    candidateLimit: args.candidateLimit,
    note: "This profiles byte columns inside row-grid candidates. It does not decode semantics or promote participant identity.",
    candidates,
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction row-grid field analysis to ${outputPath}`);
  console.log(`candidates=${candidates.length}, top=${candidates[0]?.familyKey ?? "none"}`);
}

main();
