import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

const DEFAULT_SLOTS = "84,85,86,87,88,89,90,91,93,94,95,96";
const DEFAULT_ROW_OFFSET_MIN_ACTIVE_SAMPLES = 4;

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    replayRoot: "replays",
    analyzerExe: "build/packages/rofl-core/rofl_core_cli.exe",
    versionGroup: "16.9",
    replayId: null,
    blockersPath: null,
    outputPath: null,
    familyKey: "24672-0x60-h0",
    length: 24672,
    firstByte: "0x60",
    headerSize: 0,
    stride: 16,
    slots: DEFAULT_SLOTS,
    topFields: 24,
    minActiveSamples: DEFAULT_ROW_OFFSET_MIN_ACTIVE_SAMPLES,
    recordType: "keyframe",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--replay-root" && index + 1 < argv.length) {
      args.replayRoot = argv[++index];
    } else if (arg === "--analyzer-exe" && index + 1 < argv.length) {
      args.analyzerExe = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--blockers" && index + 1 < argv.length) {
      args.blockersPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--family-key" && index + 1 < argv.length) {
      args.familyKey = argv[++index];
    } else if (arg === "--length" && index + 1 < argv.length) {
      args.length = Number.parseInt(argv[++index], 10);
    } else if (arg === "--first-byte" && index + 1 < argv.length) {
      args.firstByte = argv[++index];
    } else if (arg === "--header-size" && index + 1 < argv.length) {
      args.headerSize = Number.parseInt(argv[++index], 10);
    } else if (arg === "--stride" && index + 1 < argv.length) {
      args.stride = Number.parseInt(argv[++index], 10);
    } else if (arg === "--slots" && index + 1 < argv.length) {
      args.slots = argv[++index];
    } else if (arg === "--top-fields" && index + 1 < argv.length) {
      args.topFields = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-active-samples" && index + 1 < argv.length) {
      args.minActiveSamples = Number.parseInt(argv[++index], 10);
    } else if (arg === "--record-type" && index + 1 < argv.length) {
      args.recordType = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.length) || args.length <= 0) {
    throw new Error("--length must be a positive integer.");
  }
  if (!Number.isInteger(args.headerSize) || args.headerSize < 0) {
    throw new Error("--header-size must be a non-negative integer.");
  }
  if (!Number.isInteger(args.stride) || args.stride <= 0) {
    throw new Error("--stride must be a positive integer.");
  }
  if (!Number.isInteger(args.topFields) || args.topFields <= 0) {
    throw new Error("--top-fields must be a positive integer.");
  }
  if (!Number.isInteger(args.minActiveSamples) || args.minActiveSamples <= 0) {
    throw new Error("--min-active-samples must be a positive integer.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/scan_keyframe_state_band.mjs [--version-group 16.9] [--replay-id <id>] [--blockers <path>] [--slots 84,85,...] [--min-active-samples 4] [--output-path <path>]");
}

function commandJson(exe, args) {
  const result = spawnSync(exe, args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${exe} ${args.join(" ")} failed with exit ${result.status}: ${(result.stderr || result.stdout).trim()}`);
  }
  const raw = result.stdout.trim();
  if (!raw) {
    throw new Error(`${exe} ${args.join(" ")} returned empty stdout.`);
  }
  return JSON.parse(raw);
}

function fieldCount(scan) {
  return (scan.slots ?? []).reduce((sum, slot) => sum + (slot.fields ?? []).length, 0);
}

function slotSummaries(scan, minActiveSamples) {
  return (scan.slots ?? []).map((slot) => ({
    slotIndex: slot.slotIndex,
    activeRecords: slot.activeRecords,
    chunkSpanStart: slot.chunkSpanStart,
    chunkSpanEnd: slot.chunkSpanEnd,
    fieldCount: (slot.fields ?? []).length,
    suppressedByMinActiveSamples:
      (slot.fields ?? []).length === 0 &&
      Number.isFinite(slot.activeRecords) &&
      slot.activeRecords > 0 &&
      slot.activeRecords < minActiveSamples,
  }));
}

function suppressedSlotCount(scan, minActiveSamples) {
  return slotSummaries(scan, minActiveSamples).filter((slot) => slot.suppressedByMinActiveSamples).length;
}

function replayIdsFromArgs(root, args, artifactRoot) {
  if (args.replayId) {
    return [args.replayId];
  }

  const blockersPath = resolveAbsolute(root, args.blockersPath ?? path.join(artifactRoot, `keyframe-blockers-${args.versionGroup}.json`));
  const blockers = readJson(blockersPath);
  return (blockers.blockers ?? []).map((blocker) => blocker.replayId).sort();
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replayRoot = resolveAbsolute(root, args.replayRoot);
  const analyzerExe = resolveAbsolute(root, args.analyzerExe);
  if (!fs.existsSync(analyzerExe)) {
    throw new Error(`Analyzer executable not found: ${analyzerExe}`);
  }

  const replayIds = replayIdsFromArgs(root, args, artifactRoot);
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `keyframe-state-band-scan-${args.versionGroup}.json`),
  );

  const scans = replayIds.map((replayId) => {
    const replayPath = path.join(replayRoot, `${replayId}.rofl`);
    if (!fs.existsSync(replayPath)) {
      throw new Error(`Replay file not found: ${replayPath}`);
    }

    const common = [
      replayPath,
      "--length", `${args.length}`,
      "--first-byte", args.firstByte,
      "--header-size", `${args.headerSize}`,
      "--stride", `${args.stride}`,
      "--slots", args.slots,
      "--top-fields", `${args.topFields}`,
      "--min-active-samples", `${args.minActiveSamples}`,
      "--record-type", args.recordType,
    ];
    const raw = commandJson(analyzerExe, ["--analyze-row-offsets-json", ...common]);
    const cleaned = commandJson(analyzerExe, ["--analyze-clean-row-offsets-json", ...common]);

    return {
      replayId,
      familyKey: args.familyKey,
      length: args.length,
      firstByte: args.firstByte,
      headerSize: args.headerSize,
      stride: args.stride,
      slots: args.slots.split(",").map((slot) => Number.parseInt(slot, 10)),
      raw: {
        recordCount: raw.recordCount,
        elementCount: raw.elementCount,
        fieldCount: fieldCount(raw),
        minActiveSamples: raw.minActiveSamples ?? args.minActiveSamples,
        suppressedByMinActiveSamplesSlotCount: suppressedSlotCount(raw, args.minActiveSamples),
        slotSummaries: slotSummaries(raw, args.minActiveSamples),
      },
      cleaned: {
        recordCount: cleaned.recordCount,
        elementCount: cleaned.elementCount,
        fieldCount: fieldCount(cleaned),
        minActiveSamples: cleaned.minActiveSamples ?? args.minActiveSamples,
        signatureByteCount: (cleaned.signatureBytes ?? []).length,
        targetCount: (cleaned.targetCounts ?? []).length,
        suppressedByMinActiveSamplesSlotCount: suppressedSlotCount(cleaned, args.minActiveSamples),
        slotSummaries: slotSummaries(cleaned, args.minActiveSamples),
      },
    };
  });

  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    analyzerExe,
    replayRoot,
    parameters: {
      familyKey: args.familyKey,
      length: args.length,
      firstByte: args.firstByte,
      headerSize: args.headerSize,
      stride: args.stride,
      slots: args.slots,
      topFields: args.topFields,
      recordType: args.recordType,
      rowOffsetMinActiveSamples: args.minActiveSamples,
    },
    totals: {
      replayCount: scans.length,
      rawFieldCount: scans.reduce((sum, scan) => sum + scan.raw.fieldCount, 0),
      cleanedFieldCount: scans.reduce((sum, scan) => sum + scan.cleaned.fieldCount, 0),
      replaysWithRawFields: scans.filter((scan) => scan.raw.fieldCount > 0).length,
      replaysWithCleanedFields: scans.filter((scan) => scan.cleaned.fieldCount > 0).length,
      rawSlotsSuppressedByMinActiveSamples: scans.reduce((sum, scan) => sum + scan.raw.suppressedByMinActiveSamplesSlotCount, 0),
      cleanedSlotsSuppressedByMinActiveSamples: scans.reduce((sum, scan) => sum + scan.cleaned.suppressedByMinActiveSamplesSlotCount, 0),
    },
    scans,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ${outputPath}`);
  console.log(`State-band scan: ${scans.length} replay(s), raw fields=${output.totals.rawFieldCount}, cleaned fields=${output.totals.cleanedFieldCount}.`);
}

main();
