import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    inputPath: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
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
  console.log("Usage: node ./scripts/scan_reconstruction_row_grid_candidates.mjs [--artifact-root artifacts-keyframes] [--version-group 16.9]");
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

function rowHex(bytes, start, size) {
  return bytes
    .slice(start, start + size)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("");
}

function hammingDistance(left, right) {
  let distance = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left.charCodeAt(index) !== right.charCodeAt(index)) {
      distance += 1;
    }
  }
  return distance + Math.abs(left.length - right.length);
}

function flattenRecords(family) {
  return (family.samples ?? [])
    .flatMap((sample) =>
      (sample.records ?? []).map((record) => ({
        replayId: sample.replayId,
        chunkId: record.chunkId,
        offset: record.offset,
        length: record.length,
        bytes: hexToBytes(record.hex),
      })),
    )
    .sort((left, right) =>
      left.replayId.localeCompare(right.replayId) ||
      left.chunkId - right.chunkId ||
      left.offset - right.offset,
    );
}

function buildRows(record, headerBytes, rowCount, rowSize) {
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    rowHex(record.bytes, headerBytes + rowIndex * rowSize, rowSize),
  );
}

function duplicateRows(rows) {
  const counts = new Map();
  for (const row of rows) {
    counts.set(row, (counts.get(row) ?? 0) + 1);
  }
  return [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
}

function bestCurrentRowIndex(previousRow, currentRows) {
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let tie = false;
  for (let index = 0; index < currentRows.length; index += 1) {
    const distance = hammingDistance(previousRow, currentRows[index]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
      tie = false;
    } else if (distance === bestDistance) {
      tie = true;
    }
  }
  return { bestIndex, bestDistance, tie };
}

function scoreCandidate(family, records, headerBytes, rowCount, rowSize) {
  const rowsByRecord = records.map((record) => ({
    replayId: record.replayId,
    chunkId: record.chunkId,
    offset: record.offset,
    rows: buildRows(record, headerBytes, rowCount, rowSize),
  }));

  let adjacentPairs = 0;
  let sameRowWins = 0;
  let nearestSameIndexWins = 0;
  let nearestComparisons = 0;
  let ambiguousNearest = 0;
  const perRow = Array.from({ length: rowCount }, (_, rowIndex) => ({
    rowIndex,
    sameRowWins: 0,
    comparisons: 0,
    nearestSameIndexWins: 0,
  }));

  for (let index = 1; index < rowsByRecord.length; index += 1) {
    const previous = rowsByRecord[index - 1];
    const current = rowsByRecord[index];
    if (previous.replayId !== current.replayId) {
      continue;
    }
    adjacentPairs += 1;
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      perRow[rowIndex].comparisons += 1;
      if (previous.rows[rowIndex] === current.rows[rowIndex]) {
        sameRowWins += 1;
        perRow[rowIndex].sameRowWins += 1;
      }
      const nearest = bestCurrentRowIndex(previous.rows[rowIndex], current.rows);
      if (!nearest.tie) {
        nearestComparisons += 1;
        if (nearest.bestIndex === rowIndex) {
          nearestSameIndexWins += 1;
          perRow[rowIndex].nearestSameIndexWins += 1;
        }
      } else {
        ambiguousNearest += 1;
      }
    }
  }

  const duplicateRowCount = rowsByRecord.reduce((sum, record) => sum + duplicateRows(record.rows), 0);
  const totalRows = rowsByRecord.length * rowCount;
  const comparisons = adjacentPairs * rowCount;
  const sameRowWinRate = comparisons > 0 ? sameRowWins / comparisons : 0;
  const nearestSameIndexRate = nearestComparisons > 0 ? nearestSameIndexWins / nearestComparisons : 0;
  const duplicateRowRate = totalRows > 0 ? duplicateRowCount / totalRows : 0;
  const score = Math.round((sameRowWinRate * 55 + nearestSameIndexRate * 35 + (1 - duplicateRowRate) * 10) * 100) / 100;

  return {
    familyKey: family.familyKey,
    length: family.length,
    hypothesis: {
      headerBytes,
      rowCount,
      rowSize,
      payloadRemainderBytes: family.length - headerBytes - rowCount * rowSize,
    },
    recordCount: rowsByRecord.length,
    replayCount: new Set(rowsByRecord.map((record) => record.replayId)).size,
    adjacentPairs,
    sameRowWins,
    comparisons,
    sameRowWinRate,
    nearestSameIndexWins,
    nearestComparisons,
    nearestSameIndexRate,
    ambiguousNearest,
    duplicateRowCount,
    duplicateRowRate,
    score,
    status: score >= 75 && sameRowWinRate >= 0.75 && duplicateRowRate < 0.2
      ? "promotable_shape_candidate_needs_semantics"
      : "not_promoted",
    runtimeApiData: false,
    participantIdentity: false,
    perRow: perRow.map((row) => ({
      ...row,
      sameRowWinRate: row.comparisons > 0 ? row.sameRowWins / row.comparisons : 0,
      nearestSameIndexRate: row.comparisons > 0 ? row.nearestSameIndexWins / row.comparisons : 0,
    })),
  };
}

function candidateHypotheses(length) {
  const candidates = [];
  for (const rowCount of [10, 5]) {
    for (let headerBytes = 0; headerBytes <= 16; headerBytes += 1) {
      const remainder = length - headerBytes;
      if (remainder <= 0 || remainder % rowCount !== 0) {
        continue;
      }
      const rowSize = remainder / rowCount;
      if (rowSize >= 4 && rowSize <= 128) {
        candidates.push({ headerBytes, rowCount, rowSize });
      }
    }
  }
  return candidates;
}

function validateSamples(samples) {
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1") {
    throw new Error(`Unexpected sample schema: ${samples.sampleSchema ?? "missing"}`);
  }
  if (samples.mode !== "offline-decoder-samples" || samples.runtimeInput !== false) {
    throw new Error("Family samples must be offline-only and non-runtime.");
  }
}

function validateOutput(output) {
  if (output.schema !== "rofl-reconstruction-row-grid-candidates/v1") {
    throw new Error("Unexpected output schema.");
  }
  if (output.mode !== "offline-row-grid-candidate-scan" || output.runtimeInput !== false) {
    throw new Error("Row grid scan must be offline-only and non-runtime.");
  }
  if ((output.candidates ?? []).length === 0) {
    throw new Error("Row grid scan produced no candidates.");
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, `reconstruction-family-samples-${args.versionGroup}.json`));
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-row-grid-candidates-${args.versionGroup}.json`));
  const samples = readJson(inputPath);
  validateSamples(samples);

  const candidates = [];
  for (const family of samples.families ?? []) {
    const records = flattenRecords(family);
    if (records.length < 2 || family.length < 20) {
      continue;
    }
    for (const hypothesis of candidateHypotheses(family.length)) {
      candidates.push(scoreCandidate(family, records, hypothesis.headerBytes, hypothesis.rowCount, hypothesis.rowSize));
    }
  }

  candidates.sort((left, right) =>
    right.score - left.score ||
    right.sameRowWinRate - left.sameRowWinRate ||
    left.familyKey.localeCompare(right.familyKey) ||
    left.hypothesis.headerBytes - right.hypothesis.headerBytes,
  );

  const output = {
    schema: "rofl-reconstruction-row-grid-candidates/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    mode: "offline-row-grid-candidate-scan",
    runtimeInput: false,
    inputPath,
    status: "candidate_scan_only_not_runtime_api_data",
    note: "This scans row-grid shape hypotheses for replay-only identity research. Candidates are not participant identity and are not runtime API data.",
    scannedFamilies: (samples.families ?? []).length,
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 12),
    candidates,
  };
  validateOutput(output);
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction row-grid candidate scan to ${outputPath}`);
  console.log(`candidates=${candidates.length}, top=${candidates[0]?.familyKey ?? "none"} score=${candidates[0]?.score ?? 0}`);
}

main();
