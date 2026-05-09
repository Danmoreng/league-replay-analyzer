import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    replayRoot: "replays",
    analyzerExe: "build/packages/rofl-core/rofl_core_cli.exe",
    outputPath: null,
    replayId: null,
    versionGroup: "16.9",
    maxRecords: 32,
    minTokenFrequency: 2,
    minCrossFamilyCount: 2,
    maxFamilies: 12,
    maxStoredRowsPerPattern: 2000,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--replay-root" && index + 1 < argv.length) args.replayRoot = argv[++index];
    else if (arg === "--analyzer-exe" && index + 1 < argv.length) args.analyzerExe = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--max-records" && index + 1 < argv.length) args.maxRecords = Number.parseInt(argv[++index], 10);
    else if (arg === "--min-token-frequency" && index + 1 < argv.length) args.minTokenFrequency = Number.parseInt(argv[++index], 10);
    else if (arg === "--min-cross-family-count" && index + 1 < argv.length) args.minCrossFamilyCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--max-families" && index + 1 < argv.length) args.maxFamilies = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/scan_keyframe_handle_graph.mjs [--artifact-root <path>] [--replay-root <path>] [--analyzer-exe <path>] [--version-group 16.9] [--replay-id <id>]");
}

function listReplayIds(artifactRoot, replayId, versionGroup) {
  if (replayId) return [replayId];
  const schemaPath = path.join(artifactRoot, "keyframe-parity-schema.json");
  if (fs.existsSync(schemaPath)) {
    const schema = readJson(schemaPath);
    return (schema.replaySummaries ?? [])
      .filter((entry) => !versionGroup || entry.versionGroup === versionGroup)
      .map((entry) => entry.replayId)
      .sort();
  }
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function familyKey(family) {
  const firstByte = Number(family.firstByte ?? 0);
  const headerSize = Number(family.recommendedHeaderSize ?? family.headerSize ?? 0);
  return `${family.length}-0x${firstByte.toString(16).toUpperCase().padStart(2, "0")}-h${headerSize}`;
}

function readFamilyScan(artifactRoot, replayId) {
  const scanPath = path.join(artifactRoot, replayId, "family-scan.json");
  if (!fs.existsSync(scanPath)) return [];
  return (readJson(scanPath).families ?? [])
    .filter((family) => Number.isFinite(family.length) && Number.isFinite(family.firstByte))
    .map((family) => ({
      ...family,
      familyKey: familyKey(family),
      headerSize: Number(family.recommendedHeaderSize ?? 0),
      stride: Number(family.recommendedStride ?? 16),
    }));
}

function dumpFamily(analyzerExe, replayPath, family, maxRecords) {
  const raw = execFileSync(analyzerExe, [
    "--dump-subrecord-family-json",
    replayPath,
    "--length", String(family.length),
    "--first-byte", `0x${Number(family.firstByte).toString(16)}`,
    "--record-type", "keyframe",
    "--max-records", String(maxRecords),
  ], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  return (parsed.records ?? []).map((record) => ({
    ...record,
    buffer: Buffer.from(record.hex ?? "", "hex"),
  })).filter((record) => record.buffer.length > 0);
}

function readU16(buffer, offset) {
  return offset + 2 <= buffer.length ? buffer.readUInt16LE(offset) : null;
}

function readU32(buffer, offset) {
  return offset + 4 <= buffer.length ? buffer.readUInt32LE(offset) : null;
}

function readU64(buffer, offset) {
  return offset + 8 <= buffer.length ? buffer.readBigUInt64LE(offset) : null;
}

function firstBytesSummary(buffer, length) {
  const bytes = [...buffer.subarray(0, Math.min(length, buffer.length))];
  return {
    hex: Buffer.from(bytes).toString("hex").toUpperCase(),
    u16le0: readU16(buffer, 0),
    u32le0: readU32(buffer, 0),
    u64le0: readU64(buffer, 0)?.toString(),
  };
}

function classifyToken(value, kind, family, rowIndex, columnOffset) {
  const numeric = typeof value === "bigint" ? value : BigInt(value);
  if (numeric === 0n) return null;
  if (numeric === BigInt(family.firstByte)) return null;
  const repeatedByte = BigInt(family.firstByte) * 0x01010101n;
  if (kind !== "u64" && numeric === repeatedByte) return null;

  const maxRowIndex = family.stride > 0 && family.headerSize < family.length
    ? BigInt(Math.floor((family.length - family.headerSize) / family.stride) - 1)
    : -1n;
  const plausibleRowIndex = numeric >= 0n && maxRowIndex >= 0n && numeric <= maxRowIndex;
  const plausibleTeamId = numeric === 100n || numeric === 200n;
  const smallOrdinal = numeric >= 1n && numeric <= 10n;
  const mediumId = numeric >= 11n && numeric <= 1000n;
  const highHandle = numeric > 1000n;

  return {
    value: numeric.toString(),
    hex: `0x${numeric.toString(16).toUpperCase()}`,
    kind,
    rowIndex,
    columnOffset,
    plausibleRowIndex,
    plausibleTeamId,
    smallOrdinal,
    mediumId,
    highHandle,
  };
}

function collectRowTokens(record, family) {
  const tokens = [];
  if (family.headerSize >= record.buffer.length || family.stride <= 0) return tokens;
  const rowCount = Math.floor((record.buffer.length - family.headerSize) / family.stride);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const rowOffset = family.headerSize + (rowIndex * family.stride);
    for (let offset = 0; offset + 2 <= family.stride; offset += 2) {
      const token = classifyToken(readU16(record.buffer, rowOffset + offset), "u16", family, rowIndex, offset);
      if (token) tokens.push(token);
    }
    for (let offset = 0; offset + 4 <= family.stride; offset += 4) {
      const token = classifyToken(readU32(record.buffer, rowOffset + offset), "u32", family, rowIndex, offset);
      if (token) tokens.push(token);
    }
    for (let offset = 0; offset + 8 <= family.stride; offset += 8) {
      const token = classifyToken(readU64(record.buffer, rowOffset + offset), "u64", family, rowIndex, offset);
      if (token) tokens.push(token);
    }
  }
  return tokens;
}

function rowCountForFamily(family) {
  if (family.headerSize >= family.length || family.stride <= 0) return 0;
  return Math.floor((family.length - family.headerSize) / family.stride);
}

function addToken(bucket, replayId, family, record, token, maxStoredRows) {
  bucket.count += 1;
  bucket.replays.add(replayId);
  bucket.families.add(family.familyKey);
  if (bucket.rows.size < maxStoredRows) {
    bucket.rows.add(`${family.familyKey}:${token.rowIndex}`);
  }
  bucket.offsets.add(`${family.familyKey}:${token.columnOffset}:${token.kind}`);
  if (token.plausibleRowIndex) bucket.plausibleRowIndexHits += 1;
  if (token.plausibleTeamId) bucket.plausibleTeamIdHits += 1;
  if (token.smallOrdinal) bucket.smallOrdinalHits += 1;
  if (token.mediumId) bucket.mediumIdHits += 1;
  if (token.highHandle) bucket.highHandleHits += 1;
  if (bucket.examples.length < 8) {
    bucket.examples.push({
      replayId,
      familyKey: family.familyKey,
      segmentId: record.segmentId,
      chunkId: record.chunkId,
      rowIndex: token.rowIndex,
      offset: token.columnOffset,
      kind: token.kind,
      value: token.value,
      hex: token.hex,
    });
  }
}

function addRowReference(bucket, replayId, sourceFamily, targetFamily, record, token, maxStoredRows) {
  bucket.count += 1;
  bucket.replays.add(replayId);
  if (bucket.sourceRows.size < maxStoredRows) {
    bucket.sourceRows.add(`${replayId}:${sourceFamily.familyKey}:${token.rowIndex}`);
  }
  if (bucket.targetRows.size < maxStoredRows) {
    bucket.targetRows.add(`${replayId}:${targetFamily.familyKey}:${token.value}`);
  }
  if (bucket.examples.length < 8) {
    bucket.examples.push({
      replayId,
      sourceFamilyKey: sourceFamily.familyKey,
      sourceRowIndex: token.rowIndex,
      sourceOffset: token.columnOffset,
      kind: token.kind,
      targetFamilyKey: targetFamily.familyKey,
      targetRowIndex: Number(token.value),
      segmentId: record.segmentId,
      chunkId: record.chunkId,
      rawHex: token.hex,
    });
  }
}

function scanReplay({ artifactRoot, replayRoot, analyzerExe, replayId, maxRecords, maxFamilies, maxStoredRowsPerPattern }) {
  const replayPath = path.join(replayRoot, `${replayId}.rofl`);
  if (!fs.existsSync(replayPath)) return null;
  const families = readFamilyScan(artifactRoot, replayId);
  const targetFamilies = families
    .filter((family) => family.length >= 4096)
    .sort((left, right) =>
      (right.recordCount ?? 0) - (left.recordCount ?? 0) ||
      (right.segmentCount ?? 0) - (left.segmentCount ?? 0) ||
      right.length - left.length
    )
    .slice(0, maxFamilies);
  const headerDiagnostics = [];
  const tokenBuckets = new Map();
  const rowReferenceBuckets = new Map();
  const familyRowCounts = new Map(targetFamilies.map((family) => [family.familyKey, rowCountForFamily(family)]));

  for (const family of targetFamilies) {
    let records = [];
    try {
      records = dumpFamily(analyzerExe, replayPath, family, maxRecords);
    } catch (error) {
      headerDiagnostics.push({
        familyKey: family.familyKey,
        error: String(error.message ?? error),
      });
      continue;
    }
    if (!records.length) continue;

    const first = firstBytesSummary(records[0].buffer, 16);
    headerDiagnostics.push({
      familyKey: family.familyKey,
      length: family.length,
      firstByte: family.firstByte,
      headerSize: family.headerSize,
      stride: family.stride,
      recordCount: records.length,
      first16Hex: first.hex,
      u16le0: first.u16le0,
      u32le0: first.u32le0,
      u64le0: first.u64le0,
      u16le0EqualsLength: first.u16le0 === family.length,
      u32le0EqualsLength: first.u32le0 === family.length,
      firstTwoBytesSameAsFirstByte: records[0].buffer[0] === family.firstByte && records[0].buffer[1] === family.firstByte,
      h0ElementCount: family.length % 16 === 0 ? family.length / 16 : null,
      h16ElementCount: family.length > 16 && ((family.length - 16) % 16) === 0 ? (family.length - 16) / 16 : null,
    });

    for (const record of records) {
      for (const token of collectRowTokens(record, family)) {
        const key = `${token.kind}:${token.value}`;
        const bucket = tokenBuckets.get(key) ?? {
          kind: token.kind,
          value: token.value,
          hex: token.hex,
          count: 0,
          replays: new Set(),
          families: new Set(),
          rows: new Set(),
          offsets: new Set(),
          plausibleRowIndexHits: 0,
          plausibleTeamIdHits: 0,
          smallOrdinalHits: 0,
          mediumIdHits: 0,
          highHandleHits: 0,
          examples: [],
        };
        addToken(bucket, replayId, family, record, token, maxStoredRowsPerPattern);
        tokenBuckets.set(key, bucket);

        const tokenValue = Number(token.value);
        if (Number.isSafeInteger(tokenValue) && tokenValue > 10 && tokenValue < 4096) {
          for (const targetFamily of targetFamilies) {
            const targetRowCount = familyRowCounts.get(targetFamily.familyKey) ?? 0;
            if (tokenValue >= targetRowCount) continue;
            const refKey = [
              token.kind,
              family.familyKey,
              token.columnOffset,
              targetFamily.familyKey,
            ].join("|");
            const refBucket = rowReferenceBuckets.get(refKey) ?? {
              kind: token.kind,
              sourceFamilyKey: family.familyKey,
              sourceOffset: token.columnOffset,
              targetFamilyKey: targetFamily.familyKey,
              targetRowCount,
              count: 0,
              replays: new Set(),
              sourceRows: new Set(),
              targetRows: new Set(),
              examples: [],
            };
            addRowReference(refBucket, replayId, family, targetFamily, record, token, maxStoredRowsPerPattern);
            rowReferenceBuckets.set(refKey, refBucket);
          }
        }
      }
    }
  }

  return {
    replayId,
    headerDiagnostics,
    tokenBuckets,
    rowReferenceBuckets,
  };
}

function materializeBucket(bucket) {
  return {
    kind: bucket.kind,
    value: bucket.value,
    hex: bucket.hex,
    count: bucket.count,
    replayCount: bucket.replays.size,
    familyCount: bucket.families.size,
    rowCount: bucket.rows.size,
    offsetCount: bucket.offsets.size,
    families: [...bucket.families].sort(),
    plausibleRowIndexHits: bucket.plausibleRowIndexHits,
    plausibleTeamIdHits: bucket.plausibleTeamIdHits,
    smallOrdinalHits: bucket.smallOrdinalHits,
    mediumIdHits: bucket.mediumIdHits,
    highHandleHits: bucket.highHandleHits,
    examples: bucket.examples,
  };
}

function materializeRowReferenceBucket(bucket) {
  return {
    kind: bucket.kind,
    sourceFamilyKey: bucket.sourceFamilyKey,
    sourceOffset: bucket.sourceOffset,
    targetFamilyKey: bucket.targetFamilyKey,
    targetRowCount: bucket.targetRowCount,
    count: bucket.count,
    replayCount: bucket.replays.size,
    sourceRowCount: bucket.sourceRows.size,
    targetRowCountObserved: bucket.targetRows.size,
    examples: bucket.examples,
  };
}

function handleLikeScore(bucket) {
  const value = BigInt(bucket.value);
  if (value <= 10n) return 0;
  if (bucket.replayCount < 2) return 0;
  if (bucket.familyCount < 2 || bucket.familyCount > 10) return 0;
  if (bucket.rowCount > 400) return 0;
  if (bucket.count > 2000) return 0;
  if (bucket.kind === "u16" && value < 1024n) return 0;

  let score = 0;
  score += bucket.replayCount * 10;
  score += bucket.familyCount * 5;
  score += Math.min(bucket.rowCount, 100) * 0.25;
  if (bucket.kind === "u32") score += 15;
  if (bucket.kind === "u64") score += 10;
  if (bucket.highHandleHits > 0) score += 8;
  if (bucket.plausibleRowIndexHits > 0) score += 6;
  if (bucket.plausibleTeamIdHits > 0) score -= 20;
  if (bucket.smallOrdinalHits > 0) score -= 20;
  return score;
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const replayRoot = resolveAbsolute(repoRoot, args.replayRoot);
  const analyzerExe = resolveAbsolute(repoRoot, args.analyzerExe);
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-handle-graph-scan.json");

  const replayIds = listReplayIds(artifactRoot, args.replayId, args.versionGroup);
  const aggregate = new Map();
  const rowReferenceAggregate = new Map();
  const replayResults = [];

  for (const replayId of replayIds) {
    const result = scanReplay({
      artifactRoot,
      replayRoot,
      analyzerExe,
      replayId,
      maxRecords: args.maxRecords,
      maxFamilies: args.maxFamilies,
      maxStoredRowsPerPattern: args.maxStoredRowsPerPattern,
    });
    if (!result) continue;
    replayResults.push({
      replayId,
      headerDiagnostics: result.headerDiagnostics,
    });
    for (const bucket of result.tokenBuckets.values()) {
      const key = `${bucket.kind}:${bucket.value}`;
      const target = aggregate.get(key) ?? {
        ...bucket,
        count: 0,
        replays: new Set(),
        families: new Set(),
        rows: new Set(),
        offsets: new Set(),
        plausibleRowIndexHits: 0,
        plausibleTeamIdHits: 0,
        smallOrdinalHits: 0,
        mediumIdHits: 0,
        highHandleHits: 0,
        examples: [],
      };
      target.count += bucket.count;
      for (const replay of bucket.replays) target.replays.add(replay);
      for (const family of bucket.families) target.families.add(family);
      for (const row of bucket.rows) {
        if (target.rows.size < args.maxStoredRowsPerPattern) target.rows.add(row);
      }
      for (const offset of bucket.offsets) target.offsets.add(offset);
      target.plausibleRowIndexHits += bucket.plausibleRowIndexHits;
      target.plausibleTeamIdHits += bucket.plausibleTeamIdHits;
      target.smallOrdinalHits += bucket.smallOrdinalHits;
      target.mediumIdHits += bucket.mediumIdHits;
      target.highHandleHits += bucket.highHandleHits;
      for (const example of bucket.examples) {
        if (target.examples.length < 8) target.examples.push(example);
      }
      aggregate.set(key, target);
    }
    for (const bucket of result.rowReferenceBuckets.values()) {
      const key = `${bucket.kind}|${bucket.sourceFamilyKey}|${bucket.sourceOffset}|${bucket.targetFamilyKey}`;
      const target = rowReferenceAggregate.get(key) ?? {
        ...bucket,
        count: 0,
        replays: new Set(),
        sourceRows: new Set(),
        targetRows: new Set(),
        examples: [],
      };
      target.count += bucket.count;
      for (const replay of bucket.replays) target.replays.add(replay);
      for (const sourceRow of bucket.sourceRows) {
        if (target.sourceRows.size < args.maxStoredRowsPerPattern) target.sourceRows.add(sourceRow);
      }
      for (const targetRow of bucket.targetRows) {
        if (target.targetRows.size < args.maxStoredRowsPerPattern) target.targetRows.add(targetRow);
      }
      for (const example of bucket.examples) {
        if (target.examples.length < 8) target.examples.push(example);
      }
      rowReferenceAggregate.set(key, target);
    }
  }

  const rankedCrossFamilyTokens = [...aggregate.values()]
    .filter((bucket) => bucket.count >= args.minTokenFrequency && bucket.families.size >= args.minCrossFamilyCount)
    .map(materializeBucket)
    .sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.familyCount - left.familyCount ||
      right.rowCount - left.rowCount ||
      right.count - left.count ||
      left.kind.localeCompare(right.kind) ||
      (BigInt(left.value) < BigInt(right.value) ? -1 : 1)
    )
    .slice(0, 500);

  const rankedHandleLikeTokens = [...aggregate.values()]
    .map((bucket) => ({ bucket, score: handleLikeScore(bucket) }))
    .filter((entry) => entry.score > 0)
    .map((entry) => ({
      ...materializeBucket(entry.bucket),
      handleLikeScore: entry.score,
    }))
    .sort((left, right) =>
      right.handleLikeScore - left.handleLikeScore ||
      right.replayCount - left.replayCount ||
      right.familyCount - left.familyCount ||
      right.rowCount - left.rowCount ||
      right.count - left.count ||
      (BigInt(left.value) < BigInt(right.value) ? -1 : 1)
    )
    .slice(0, 200);

  const rankedRowReferencePatterns = [...rowReferenceAggregate.values()]
    .filter((bucket) => bucket.replays.size >= 2 && bucket.count >= 20)
    .map(materializeRowReferenceBucket)
    .sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.sourceRowCount - left.sourceRowCount ||
      right.targetRowCountObserved - left.targetRowCountObserved ||
      right.count - left.count ||
      left.sourceFamilyKey.localeCompare(right.sourceFamilyKey) ||
      left.sourceOffset - right.sourceOffset ||
      left.targetFamilyKey.localeCompare(right.targetFamilyKey)
    )
    .slice(0, 500);

  const headerFindings = replayResults.flatMap((replay) =>
    replay.headerDiagnostics.map((diagnostic) => ({ replayId: replay.replayId, ...diagnostic }))
  );

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    replayRoot,
    analyzerExe,
    filters: {
      replayId: args.replayId,
      versionGroup: args.versionGroup,
      maxRecords: args.maxRecords,
      maxFamilies: args.maxFamilies,
      minTokenFrequency: args.minTokenFrequency,
      minCrossFamilyCount: args.minCrossFamilyCount,
    },
    replayCount: replayResults.length,
    headerFindings,
    suspiciousHeaderFindings: headerFindings.filter((entry) =>
      entry.u16le0EqualsLength ||
      entry.u32le0EqualsLength ||
      entry.firstTwoBytesSameAsFirstByte
    ),
    rankedCrossFamilyTokens,
    rankedHandleLikeTokens,
    rankedRowReferencePatterns,
  };

  writeJson(outputPath, output);
  console.log(`Wrote keyframe handle graph scan to ${outputPath}`);
  console.log(`Scanned ${replayResults.length} replay(s), found ${rankedCrossFamilyTokens.length} cross-family token candidate(s), ${rankedHandleLikeTokens.length} handle-like candidate(s), ${rankedRowReferencePatterns.length} row-reference pattern(s).`);
}

main();
