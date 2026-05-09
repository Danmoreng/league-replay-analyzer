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
    focusFamily: "24672-0x60-h16",
    focusSlots: "79,82,83,84,85,86,87,88,90,91,93,94,95,96,97,99,100,479,488,491,494",
    focusNeighborRadius: 2,
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
    else if (arg === "--focus-family" && index + 1 < argv.length) args.focusFamily = argv[++index];
    else if (arg === "--focus-slots" && index + 1 < argv.length) args.focusSlots = argv[++index];
    else if (arg === "--focus-neighbor-radius" && index + 1 < argv.length) args.focusNeighborRadius = Number.parseInt(argv[++index], 10);
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/run_keyframe_handle_graph_corpus.mjs [--version-group 16.9] [--top-families 32] [--max-records 0] [--focus-family 24672-0x60-h16] [--focus-slots a,b,c] [--focus-neighbor-radius 2]");
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

function loadSupervisedAssignments(artifactRoot, versionGroup, focusFamily) {
  const assignmentPath = path.join(artifactRoot, "keyframe-slot-assignments.json");
  if (!fs.existsSync(assignmentPath)) return new Map();

  const report = readJson(assignmentPath);
  const replayMap = new Map();
  const h16FromH0Family = focusFamily.endsWith("-h16")
    ? `${focusFamily.slice(0, -3)}h0`
    : null;
  for (const replay of report.replays ?? []) {
    if (versionGroup && replay.versionGroup !== versionGroup) continue;
    const slotMap = new Map();
    for (const family of replay.families ?? []) {
      const directFamily = family.familyKey === focusFamily;
      const shiftedH0Family = h16FromH0Family && family.familyKey === h16FromH0Family;
      if (!directFamily && !shiftedH0Family) continue;
      for (const assignment of family.assignments ?? []) {
        const slotIndex = shiftedH0Family ? assignment.slotIndex - 1 : assignment.slotIndex;
        if (slotIndex < 0) continue;
        slotMap.set(slotIndex, {
          slotIndex,
          sourceFamilyKey: family.familyKey,
          participantId: assignment.participantId,
          champion: assignment.champion,
          stable: Boolean(assignment.stable),
          metricCount: assignment.metricCount ?? 0,
          score: assignment.score ?? 0,
        });
      }
    }
    if (slotMap.size > 0) replayMap.set(replay.replayId, slotMap);
  }
  return replayMap;
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
  const supervisedAssignmentsByReplay = loadSupervisedAssignments(artifactRoot, args.versionGroup, args.focusFamily);
  const supervisedSlotBuckets = new Map();
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
      "--focus-family", args.focusFamily,
      "--focus-slots", args.focusSlots,
      "--focus-neighbor-radius", String(args.focusNeighborRadius),
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

    const supervisedSlots = supervisedAssignmentsByReplay.get(replayId) ?? new Map();
    for (const assignment of supervisedSlots.values()) {
      const bucket = supervisedSlotBuckets.get(assignment.slotIndex) ?? {
        slotIndex: assignment.slotIndex,
        replayCount: 0,
        stableReplayCount: 0,
        participants: {},
        examples: [],
      };
      bucket.replayCount += 1;
      if (assignment.stable) bucket.stableReplayCount += 1;
      const participantKey = String(assignment.participantId);
      bucket.participants[participantKey] = (bucket.participants[participantKey] ?? 0) + 1;
      if (bucket.examples.length < 4) bucket.examples.push({ replayId, ...assignment });
      supervisedSlotBuckets.set(assignment.slotIndex, bucket);
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
        assignedSourceRowReplayCount: 0,
        assignedSourceRows: {},
        examples: [],
        assignedExamples: [],
      };
      bucket.replayCount += 1;
      bucket.totalCount += pattern.count ?? 0;
      bucket.totalSegmentCount += pattern.segmentCount ?? 0;
      bucket.maxSourceRowCount = Math.max(bucket.maxSourceRowCount, pattern.sourceRowCount ?? 0);
      bucket.maxTargetRowCountObserved = Math.max(bucket.maxTargetRowCountObserved, pattern.targetRowCountObserved ?? 0);
      const assignedRows = (pattern.sourceRows ?? []).filter((row) => supervisedSlots.has(row));
      if (assignedRows.length > 0) {
        bucket.assignedSourceRowReplayCount += 1;
        for (const row of assignedRows) {
          bucket.assignedSourceRows[row] = (bucket.assignedSourceRows[row] ?? 0) + 1;
        }
        if (bucket.assignedExamples.length < 4) {
          bucket.assignedExamples.push({
            replayId,
            assignedRows: assignedRows.slice(0, 8).map((row) => supervisedSlots.get(row)),
          });
        }
      }
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
      focusFamily: args.focusFamily,
      focusSlots: args.focusSlots,
      focusNeighborRadius: args.focusNeighborRadius,
      replayId: args.replayId,
    },
    replayCount: replays.length,
    replays,
    supervisedAssignmentSummary: {
      source: "keyframe-slot-assignments.json",
      mappedFamily: args.focusFamily,
      replayCount: supervisedAssignmentsByReplay.size,
      slots: [...supervisedSlotBuckets.values()].sort((left, right) =>
        right.replayCount - left.replayCount ||
        left.slotIndex - right.slotIndex
      ),
    },
    headerSummary: [...headerBuckets.values()].sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.u16le0EqualsLengthCount - left.u16le0EqualsLengthCount ||
      left.familyKey.localeCompare(right.familyKey)
    ),
    rowReferencePatternSummary: [...patternBuckets.values()].sort((left, right) =>
      right.replayCount - left.replayCount ||
      right.assignedSourceRowReplayCount - left.assignedSourceRowReplayCount ||
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
