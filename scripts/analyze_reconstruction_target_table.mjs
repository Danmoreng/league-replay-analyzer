import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    samplesPath: null,
    outputPath: null,
    familyKey: "241-0x02",
    rowCount: 10,
    rowSize: 24,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--samples-path" && index + 1 < argv.length) args.samplesPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--family-key" && index + 1 < argv.length) args.familyKey = argv[++index];
    else if (arg === "--row-count" && index + 1 < argv.length) args.rowCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--row-size" && index + 1 < argv.length) args.rowSize = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/analyze_reconstruction_target_table.mjs [--family-key 241-0x02] [--row-count 10] [--row-size 24]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function safeFamilyKey(familyKey) {
  return familyKey.replace(/[^A-Za-z0-9]+/g, "-");
}

function parseFamilyKey(familyKey) {
  const match = familyKey.match(/^(\d+)-0x([0-9A-Fa-f]{2})$/);
  if (!match) throw new Error(`Invalid family key: ${familyKey}`);
  return { length: Number.parseInt(match[1], 10), firstByteHex: match[2].toUpperCase() };
}

function readUInt16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readInt16LE(bytes, offset) {
  const value = readUInt16LE(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readUInt32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function readInt32LE(bytes, offset) {
  return readUInt32LE(bytes, offset) | 0;
}

function readFloat32LE(bytes, offset) {
  const buffer = Buffer.from(bytes.slice(offset, offset + 4));
  return buffer.readFloatLE(0);
}

function stats(values) {
  const finite = values.filter(Number.isFinite);
  const distinct = new Set(finite.map((value) => Object.is(value, -0) ? 0 : value));
  const zeroCount = finite.filter((value) => value === 0).length;
  const smallIntegerCount = finite.filter((value) => Number.isInteger(value) && value >= 0 && value <= 20000).length;
  const mapCoordinateCount = finite.filter((value) => value >= 0 && value <= 16000).length;
  const monotonicPairs = finite.slice(1).filter((value, index) => value >= finite[index]).length;
  return {
    min: finite.length ? Math.min(...finite) : null,
    max: finite.length ? Math.max(...finite) : null,
    distinctCount: distinct.size,
    zeroCount,
    sampleCount: finite.length,
    smallIntegerLikelihood: finite.length ? smallIntegerCount / finite.length : 0,
    mapCoordinateLikelihood: finite.length ? mapCoordinateCount / finite.length : 0,
    monotonicity: finite.length > 1 ? monotonicPairs / (finite.length - 1) : null,
  };
}

function byteDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    distance += Math.abs(left[index] - right[index]);
  }
  return distance;
}

function rowCoherence(records, rowCount) {
  const byReplay = new Map();
  for (const record of records) {
    const rows = byReplay.get(record.replayId) ?? [];
    rows.push(record);
    byReplay.set(record.replayId, rows);
  }
  let sameRowWins = 0;
  let comparisons = 0;
  const perRow = Array.from({ length: rowCount }, (_, rowIndex) => ({ rowIndex, sameRowWins: 0, comparisons: 0 }));
  for (const replayRecords of byReplay.values()) {
    replayRecords.sort((left, right) => left.chunkId - right.chunkId || left.offset - right.offset);
    for (let index = 1; index < replayRecords.length; index += 1) {
      const previous = replayRecords[index - 1];
      const current = replayRecords[index];
      for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
        const sameDistance = byteDistance(previous.rows[rowIndex], current.rows[rowIndex]);
        const bestDistance = Math.min(...current.rows.map((row) => byteDistance(previous.rows[rowIndex], row)));
        comparisons += 1;
        perRow[rowIndex].comparisons += 1;
        if (sameDistance === bestDistance) {
          sameRowWins += 1;
          perRow[rowIndex].sameRowWins += 1;
        }
      }
    }
  }
  return {
    sameRowWins,
    comparisons,
    sameRowWinRate: comparisons ? sameRowWins / comparisons : null,
    perRow: perRow.map((row) => ({
      ...row,
      sameRowWinRate: row.comparisons ? row.sameRowWins / row.comparisons : null,
    })),
  };
}

function promotionAssessment(coherenceScores) {
  const sameRowWinRate = coherenceScores.sameRowWinRate;
  const rowTrackCoherence = Number.isFinite(sameRowWinRate) && sameRowWinRate >= 0.75;
  return {
    status: rowTrackCoherence ? "review_required" : "not_promoted",
    runtimeApiData: false,
    rowTrackCoherence,
    reasons: rowTrackCoherence
      ? [
        "row coherence is high enough to require a manual promotion-gate review",
        "participant identity and semantic field meaning are still not decoded by this artifact",
      ]
      : [
        "row coherence is below promotion threshold",
        "participant identity is not established",
        "field semantics are not decoded",
      ],
  };
}

function main() {
  const args = parseArgs(process.argv);
  const parsed = parseFamilyKey(args.familyKey);
  if (parsed.length !== 1 + args.rowCount * args.rowSize) {
    throw new Error(`Family length ${parsed.length} does not match 1 + ${args.rowCount} * ${args.rowSize}.`);
  }
  const samplesPath = path.resolve(args.samplesPath ?? path.join(args.artifactRoot, "reconstruction-family-samples-16.9.json"));
  const samples = JSON.parse(fs.readFileSync(samplesPath, "utf8"));
  if (samples.sampleSchema !== "rofl-reconstruction-family-samples/v1" || samples.runtimeInput !== false) {
    throw new Error("Input samples must be offline reconstruction samples.");
  }
  const sampleFamily = (samples.families ?? []).find((family) => family.familyKey === args.familyKey);
  if (!sampleFamily) throw new Error(`Family ${args.familyKey} not found in samples.`);
  const records = [];
  for (const sample of sampleFamily.samples ?? []) {
    for (const record of sample.records ?? []) {
      const payload = [...Buffer.from(record.hex, "hex")];
      const rows = [];
      for (let rowIndex = 0; rowIndex < args.rowCount; rowIndex += 1) {
        rows.push(payload.slice(1 + rowIndex * args.rowSize, 1 + (rowIndex + 1) * args.rowSize));
      }
      records.push({ replayId: sample.replayId, chunkId: record.chunkId, offset: record.offset, tableKind: payload[0], rows });
    }
  }
  const interpretations = [];
  for (const type of ["u16", "i16", "u32", "i32", "f32"]) {
    const step = type.endsWith("16") ? 2 : 4;
    for (let offset = 0; offset < args.rowSize; offset += step) {
      const values = [];
      for (const record of records) {
        for (const row of record.rows) {
          if (type === "u16") values.push(readUInt16LE(row, offset));
          else if (type === "i16") values.push(readInt16LE(row, offset));
          else if (type === "u32") values.push(readUInt32LE(row, offset));
          else if (type === "i32") values.push(readInt32LE(row, offset));
          else values.push(readFloat32LE(row, offset));
        }
      }
      const summary = stats(values);
      interpretations.push({
        type,
        offset,
        ...summary,
        floatLikelihood: type === "f32"
          ? values.filter((value) => Number.isFinite(value) && Math.abs(value) < 1_000_000).length / values.length
          : 0,
        stableIdLikelihood: summary.distinctCount > args.rowCount && summary.distinctCount <= records.length * args.rowCount ? 0.5 : 0,
      });
    }
  }
  const coherenceScores = rowCoherence(records, args.rowCount);
  const output = {
    schema: "rofl-reconstruction-target-table-analysis/v1",
    generatedAtUtc: new Date().toISOString(),
    familyKey: args.familyKey,
    mode: "offline-decoder-target-table-analysis",
    runtimeInput: false,
    status: "decoder_hypothesis_only_not_runtime_api_data",
    inputSamplesPath: samplesPath,
    hypothesis: {
      payloadLength: parsed.length,
      headerBytes: 1,
      rowCount: args.rowCount,
      rowSize: args.rowSize,
    },
    records: records.map((record) => ({
      replayId: record.replayId,
      chunkId: record.chunkId,
      offset: record.offset,
      tableKind: `0x${record.tableKind.toString(16).padStart(2, "0").toUpperCase()}`,
      rowHex: record.rows.map((row) => Buffer.from(row).toString("hex").toUpperCase()),
    })),
    fieldInterpretations: interpretations,
    coherenceScores,
    promotionAssessment: promotionAssessment(coherenceScores),
  };
  const outputPath = path.resolve(args.outputPath ?? path.join(args.artifactRoot, `reconstruction-target-table-analysis-${safeFamilyKey(args.familyKey)}-16.9.json`));
  writeJson(outputPath, output);
  console.log(`Wrote reconstruction target table analysis to ${outputPath}`);
  console.log(`family=${args.familyKey}, records=${records.length}, sameRowWinRate=${output.coherenceScores.sameRowWinRate}`);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

main();
