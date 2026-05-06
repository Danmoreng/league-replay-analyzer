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
    versionGroup: "16.9",
    topFamilies: 32,
    maxRecords: 0,
    replayId: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--replay-root" && index + 1 < argv.length) args.replayRoot = argv[++index];
    else if (arg === "--analyzer-exe" && index + 1 < argv.length) args.analyzerExe = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--top-families" && index + 1 < argv.length) args.topFamilies = Number.parseInt(argv[++index], 10);
    else if (arg === "--max-records" && index + 1 < argv.length) args.maxRecords = Number.parseInt(argv[++index], 10);
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/run_keyframe_handle_graph_corpus.mjs [--version-group 16.9] [--top-families 32] [--max-records 0]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function replayIdsForVersion(artifactRoot, versionGroup, replayId) {
  if (replayId) return [replayId];
  const schema = readJson(path.join(artifactRoot, "keyframe-parity-schema.json"));
  return (schema.replaySummaries ?? [])
    .filter((entry) => !versionGroup || entry.versionGroup === versionGroup)
    .map((entry) => entry.replayId)
    .sort();
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replayRoot = resolveAbsolute(root, args.replayRoot);
  const analyzerExe = resolveAbsolute(root, args.analyzerExe);
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(artifactRoot, "keyframe-handle-graph-corpus.json");

  const replays = [];
  const headerBuckets = new Map();
  const patternBuckets = new Map();
  for (const replayId of replayIdsForVersion(artifactRoot, args.versionGroup, args.replayId)) {
    const replayPath = path.join(replayRoot, `${replayId}.rofl`);
    if (!fs.existsSync(replayPath)) continue;
    const raw = execFileSync(analyzerExe, [
      "--scan-keyframe-handle-graph-json",
      replayPath,
      "--top-families", String(args.topFamilies),
      "--max-records", String(args.maxRecords),
    ], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    const report = JSON.parse(raw);
    replays.push({
      replayId,
      versionGroup: report.versionGroup,
      familyCount: report.families?.length ?? 0,
      rowReferencePatternCount: report.rowReferencePatterns?.length ?? 0,
    });

    for (const finding of report.headerFindings ?? []) {
      const bucket = headerBuckets.get(finding.familyKey) ?? {
        familyKey: finding.familyKey,
        replayCount: 0,
        u16le0EqualsLengthCount: 0,
        firstTwoBytesSameAsFirstByteCount: 0,
        examples: [],
      };
      bucket.replayCount += 1;
      if (finding.u16le0EqualsLength) bucket.u16le0EqualsLengthCount += 1;
      if (finding.firstTwoBytesSameAsFirstByte) bucket.firstTwoBytesSameAsFirstByteCount += 1;
      if (bucket.examples.length < 4) bucket.examples.push({ replayId, ...finding });
      headerBuckets.set(finding.familyKey, bucket);
    }

    for (const pattern of report.rowReferencePatterns ?? []) {
      const key = [pattern.sourceFamilyKey, pattern.sourceOffset, pattern.width, pattern.targetFamilyKey].join("|");
      const bucket = patternBuckets.get(key) ?? {
        sourceFamilyKey: pattern.sourceFamilyKey,
        sourceOffset: pattern.sourceOffset,
        width: pattern.width,
        targetFamilyKey: pattern.targetFamilyKey,
        replayCount: 0,
        totalCount: 0,
        totalSegmentCount: 0,
        maxSourceRowCount: 0,
        maxTargetRowCountObserved: 0,
        examples: [],
      };
      bucket.replayCount += 1;
      bucket.totalCount += pattern.count ?? 0;
      bucket.totalSegmentCount += pattern.segmentCount ?? 0;
      bucket.maxSourceRowCount = Math.max(bucket.maxSourceRowCount, pattern.sourceRowCount ?? 0);
      bucket.maxTargetRowCountObserved = Math.max(bucket.maxTargetRowCountObserved, pattern.targetRowCountObserved ?? 0);
      if (bucket.examples.length < 4) bucket.examples.push({ replayId, examples: pattern.examples?.slice(0, 2) ?? [] });
      patternBuckets.set(key, bucket);
    }
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    replayRoot,
    analyzerExe,
    filters: {
      versionGroup: args.versionGroup,
      topFamilies: args.topFamilies,
      maxRecords: args.maxRecords,
      replayId: args.replayId,
    },
    replayCount: replays.length,
    replays,
    headerSummary: [...headerBuckets.values()].sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.u16le0EqualsLengthCount - left.u16le0EqualsLengthCount ||
      left.familyKey.localeCompare(right.familyKey)
    ),
    rowReferencePatternSummary: [...patternBuckets.values()].sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.maxSourceRowCount - left.maxSourceRowCount ||
      right.maxTargetRowCountObserved - left.maxTargetRowCountObserved ||
      right.totalCount - left.totalCount
    ).slice(0, 500),
  };

  writeJson(outputPath, output);
  console.log(`Wrote keyframe handle graph corpus summary to ${outputPath}`);
  console.log(`Scanned ${replays.length} replay(s), ${output.rowReferencePatternSummary.length} aggregate row-reference pattern(s).`);
}

main();
