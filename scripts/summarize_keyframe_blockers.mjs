import fs from "fs";
import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    coveragePath: null,
    parityReportPath: null,
    outputPath: null,
    familyKey: "24672-0x60-h0",
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--coverage" && index + 1 < argv.length) {
      args.coveragePath = argv[++index];
    } else if (arg === "--parity-report" && index + 1 < argv.length) {
      args.parityReportPath = argv[++index];
    } else if (arg === "--family-key" && index + 1 < argv.length) {
      args.familyKey = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_keyframe_blockers.mjs [--version-group 16.9] [--artifact-root <path>] [--coverage <path>] [--parity-report <path>] [--family-key 24672-0x60-h0]");
}

function maybeReadJson(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function summarizeCleaned(cleanedPath) {
  const cleaned = maybeReadJson(cleanedPath);
  if (!cleaned) {
    return {
      exists: false,
      slotCount: 0,
      fieldCount: 0,
      maxActiveSamples: 0,
      slots: [],
    };
  }

  const slots = (cleaned.slots ?? []).map((slot) => {
    const fields = slot.fields ?? [];
    return {
      slotIndex: slot.slotIndex,
      fieldCount: fields.length,
      maxActiveSamples: fields.reduce((max, field) => Math.max(max, field.activeSamples ?? 0), 0),
      maxDistinctApiFrameCount: fields.reduce((max, field) => {
        const frames = new Set((field.samples ?? [])
          .map((sample) => sample.apiFrameIndex)
          .filter((value) => Number.isFinite(value)));
        return Math.max(max, frames.size);
      }, 0),
    };
  });

  return {
    exists: true,
    slotCount: slots.length,
    fieldCount: slots.reduce((sum, slot) => sum + slot.fieldCount, 0),
    maxActiveSamples: slots.reduce((max, slot) => Math.max(max, slot.maxActiveSamples), 0),
    maxDistinctApiFrameCount: slots.reduce((max, slot) => Math.max(max, slot.maxDistinctApiFrameCount), 0),
    slots,
  };
}

function summarizeShortDiagnostic(root, replayId) {
  const parityPath = path.join(root, "tmp", `keyframe-parity-${replayId}-short5.json`);
  const assignmentsPath = path.join(root, "tmp", `keyframe-slot-assignments-${replayId}-short5.json`);
  const exportPath = path.join(root, "tmp", `keyframe-state-${replayId}-short5.json`);
  if (!fs.existsSync(parityPath) && !fs.existsSync(assignmentsPath) && !fs.existsSync(exportPath)) {
    return null;
  }

  const parity = maybeReadJson(parityPath);
  const assignments = maybeReadJson(assignmentsPath);
  const exportJson = maybeReadJson(exportPath);
  return {
    parityPath: fs.existsSync(parityPath) ? parityPath : null,
    assignmentsPath: fs.existsSync(assignmentsPath) ? assignmentsPath : null,
    exportPath: fs.existsSync(exportPath) ? exportPath : null,
    diagnosticOnly: true,
    reason: "Uses five-point metric overlap and is not part of the canonical latest-patch export.",
    parity: parity ? {
      minOverlap: parity.minOverlap,
      candidateCount: parity.totals?.candidateCount ?? 0,
      passingMatchCount: parity.totals?.passingMatchCount ?? 0,
      participantSlotEvidenceCount: parity.totals?.participantSlotEvidenceCount ?? 0,
    } : null,
    assignments: assignments ? {
      assignmentCount: assignments.totals?.assignmentCount ?? 0,
      stableAssignmentCount: assignments.totals?.stableAssignmentCount ?? 0,
      edgeCount: assignments.totals?.edgeCount ?? 0,
      gatedEdgeCount: assignments.totals?.gatedEdgeCount ?? 0,
    } : null,
    export: exportJson ? {
      participantSeriesCount: exportJson.totals?.participantSeriesCount ?? 0,
      metricSeriesCount: exportJson.totals?.metricSeriesCount ?? 0,
      pointCount: exportJson.totals?.pointCount ?? 0,
    } : null,
  };
}

function buildStateBandScanIndex(scanPath) {
  const scan = maybeReadJson(scanPath);
  if (!scan) {
    return { scan: null, byReplay: new Map() };
  }

  return {
    scan,
    byReplay: new Map((scan.scans ?? []).map((entry) => [entry.replayId, entry])),
  };
}

function summarizeLowSampleStateBandDiagnostic(root, artifactRoot, versionGroup, replayId) {
  const scanPath = path.join(artifactRoot, `keyframe-state-band-scan-${versionGroup}-${replayId}-min3.json`);
  const scan = maybeReadJson(scanPath);
  const replayScan = (scan?.scans ?? []).find((entry) => entry.replayId === replayId) ?? null;
  if (!scan || !replayScan) {
    return null;
  }

  return {
    scanPath,
    diagnosticOnly: true,
    reason: "Uses a three-sample row-offset emission threshold and is not part of the canonical latest-patch export.",
    rowOffsetMinActiveSamples: scan.parameters?.rowOffsetMinActiveSamples ?? null,
    rawFieldCount: replayScan.raw?.fieldCount ?? 0,
    cleanedFieldCount: replayScan.cleaned?.fieldCount ?? 0,
    rawSlotsSuppressedByMinActiveSamples: replayScan.raw?.suppressedByMinActiveSamplesSlotCount ?? 0,
    cleanedSlotsSuppressedByMinActiveSamples: replayScan.cleaned?.suppressedByMinActiveSamplesSlotCount ?? 0,
  };
}

function median(values) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return (sorted.length % 2) === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeAssignmentAmbiguity(assignments) {
  const rows = (assignments?.replays ?? []).flatMap((replay) =>
    (replay.families ?? []).flatMap((family) =>
      (family.assignments ?? []).map((assignment) => ({
        replayId: replay.replayId,
        familyKey: family.familyKey,
        slotIndex: assignment.slotIndex,
        participantId: assignment.participantId,
        champion: assignment.champion,
        rank: assignment.rank,
        winnerGap: assignment.winnerGap,
        score: assignment.score,
        runnerUpParticipantId: assignment.runnerUp?.participantId ?? null,
        runnerUpScore: assignment.runnerUp?.score ?? null,
        stable: Boolean(assignment.stable),
      })),
    ),
  );
  const gaps = rows.map((row) => row.winnerGap).filter((value) => Number.isFinite(value));
  const ranks = rows.map((row) => row.rank).filter((value) => Number.isFinite(value));

  return {
    assignedRowCount: rows.length,
    stableRowCount: rows.filter((row) => row.stable).length,
    rankOneRowCount: rows.filter((row) => row.rank === 1).length,
    nonPositiveWinnerGapCount: rows.filter((row) => Number.isFinite(row.winnerGap) && row.winnerGap <= 0).length,
    maxWinnerGap: gaps.length ? Math.max(...gaps) : null,
    medianWinnerGap: median(gaps),
    minWinnerGap: gaps.length ? Math.min(...gaps) : null,
    medianRank: median(ranks),
    topRows: rows
      .sort((left, right) =>
        (right.winnerGap ?? Number.NEGATIVE_INFINITY) - (left.winnerGap ?? Number.NEGATIVE_INFINITY) ||
        (right.score ?? Number.NEGATIVE_INFINITY) - (left.score ?? Number.NEGATIVE_INFINITY)
      )
      .slice(0, 5),
  };
}

function summarizeLowSampleParityDiagnostic(root, replayId) {
  const parityPath = path.join(root, "tmp", `keyframe-parity-${replayId}-min3.json`);
  const assignmentsPath = path.join(root, "tmp", `keyframe-slot-assignments-${replayId}-min3.json`);
  const exportPath = path.join(root, "tmp", `keyframe-state-${replayId}-min3-all.json`);
  const qualityPath = path.join(root, "tmp", `keyframe-state-quality-${replayId}-min3-all.json`);
  if (![parityPath, assignmentsPath, exportPath, qualityPath].some((filePath) => fs.existsSync(filePath))) {
    return null;
  }

  const parity = maybeReadJson(parityPath);
  const assignments = maybeReadJson(assignmentsPath);
  const exportJson = maybeReadJson(exportPath);
  const quality = maybeReadJson(qualityPath);
  return {
    parityPath: fs.existsSync(parityPath) ? parityPath : null,
    assignmentsPath: fs.existsSync(assignmentsPath) ? assignmentsPath : null,
    exportPath: fs.existsSync(exportPath) ? exportPath : null,
    qualityPath: fs.existsSync(qualityPath) ? qualityPath : null,
    diagnosticOnly: true,
    reason: "Uses three-sample field emission and three-point parity overlap; assignments are not stable and exported metric series fail canonical quality gates.",
    parity: parity ? {
      minOverlap: parity.minOverlap,
      candidateCount: parity.totals?.candidateCount ?? 0,
      passingMatchCount: parity.totals?.passingMatchCount ?? 0,
      participantSlotEvidenceCount: parity.totals?.participantSlotEvidenceCount ?? 0,
    } : null,
    assignments: assignments ? {
      assignmentCount: assignments.totals?.assignmentCount ?? 0,
      stableAssignmentCount: assignments.totals?.stableAssignmentCount ?? 0,
      edgeCount: assignments.totals?.edgeCount ?? 0,
      gatedEdgeCount: assignments.totals?.gatedEdgeCount ?? 0,
      ambiguity: summarizeAssignmentAmbiguity(assignments),
    } : null,
    export: exportJson ? {
      participantSeriesCount: exportJson.totals?.participantSeriesCount ?? 0,
      metricSeriesCount: exportJson.totals?.metricSeriesCount ?? 0,
      pointCount: exportJson.totals?.pointCount ?? 0,
    } : null,
    quality: quality ? {
      metricSeriesCount: quality.totals?.metricSeriesCount ?? 0,
      violationCount: quality.totals?.violationCount ?? 0,
    } : null,
  };
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const coveragePath = resolveAbsolute(root, args.coveragePath ?? path.join(artifactRoot, `keyframe-export-coverage-${args.versionGroup}.json`));
  const parityReportPath = resolveAbsolute(root, args.parityReportPath ?? path.join(artifactRoot, "keyframe-api-parity.json"));
  const outputPath = resolveAbsolute(root, args.outputPath ?? path.join(artifactRoot, `keyframe-blockers-${args.versionGroup}.json`));
  const stateBandScanPath = path.join(artifactRoot, `keyframe-state-band-scan-${args.versionGroup}.json`);

  const coverage = readJson(coveragePath);
  const parityReport = readJson(parityReportPath);
  const parityByReplay = new Map((parityReport.replays ?? []).map((replay) => [replay.replayId, replay]));
  const stateBandScan = buildStateBandScanIndex(stateBandScanPath);
  const blockedCoverageRows = (coverage.replays ?? [])
    .filter((replay) => replay.blocker)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));

  const blockers = blockedCoverageRows.map((coverageReplay) => {
    const replayDir = path.join(artifactRoot, coverageReplay.replayId);
    const manifest = maybeReadJson(path.join(replayDir, "run-manifest.json"));
    const family = (manifest?.families ?? []).find((entry) => entry.familyKey === args.familyKey) ?? null;
    const parityReplay = parityByReplay.get(coverageReplay.replayId) ?? null;
    const cleanedPath = path.join(replayDir, "families", args.familyKey, "cleaned.json");
    const stateBandReplay = stateBandScan.byReplay.get(coverageReplay.replayId) ?? null;

    return {
      replayId: coverageReplay.replayId,
      gameVersion: coverageReplay.gameVersion,
      blocker: coverageReplay.blocker,
      coverage: {
        candidateStateSlotCount: coverageReplay.candidateStateSlotCount,
        edgeCount: coverageReplay.edgeCount,
        gatedEdgeCount: coverageReplay.gatedEdgeCount,
        assignmentCount: coverageReplay.assignmentCount,
        stableAssignmentCount: coverageReplay.stableAssignmentCount,
      },
      parity: parityReplay ? {
        replayKeyframeCount: parityReplay.replayKeyframeCount,
        apiFrameCount: parityReplay.apiFrameCount,
        candidateCount: parityReplay.candidateCount,
        matchCount: parityReplay.matchCount,
        passingMatchCount: parityReplay.passingMatchCount,
        participantSlotEvidenceCount: parityReplay.participantSlotEvidenceCount,
      } : null,
      family: family ? {
        familyKey: family.familyKey,
        length: family.length,
        firstByte: family.firstByte,
        headerSize: family.headerSize,
        stride: family.stride,
        recordCount: family.recordCount,
        segmentCount: family.segmentCount,
        chunkCount: family.chunkCount,
        selectedSlotCount: (family.selectedSlots ?? []).length,
        dynamicSlotCount: (family.dynamicSlots ?? []).length,
        mixedSlotCount: (family.mixedSlots ?? []).length,
        hasSchema: Boolean(family.files?.schema),
        hasCleaned: Boolean(family.files?.cleaned),
      } : null,
      cleaned: summarizeCleaned(cleanedPath),
      stateBandScan: stateBandReplay ? {
        rawFieldCount: stateBandReplay.raw?.fieldCount ?? 0,
        cleanedFieldCount: stateBandReplay.cleaned?.fieldCount ?? 0,
        rawRecordCount: stateBandReplay.raw?.recordCount ?? null,
        cleanedRecordCount: stateBandReplay.cleaned?.recordCount ?? null,
        rawSlotsSuppressedByMinActiveSamples: stateBandReplay.raw?.suppressedByMinActiveSamplesSlotCount ?? 0,
        cleanedSlotsSuppressedByMinActiveSamples: stateBandReplay.cleaned?.suppressedByMinActiveSamplesSlotCount ?? 0,
        slotCount: (stateBandReplay.slots ?? []).length,
      } : null,
      lowSampleStateBandDiagnostic: summarizeLowSampleStateBandDiagnostic(root, artifactRoot, args.versionGroup, coverageReplay.replayId),
      lowSampleParityDiagnostic: summarizeLowSampleParityDiagnostic(root, coverageReplay.replayId),
      shortSeriesDiagnostic: summarizeShortDiagnostic(root, coverageReplay.replayId),
    };
  });

  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    familyKey: args.familyKey,
    coveragePath,
    parityReportPath,
    stateBandScanPath: fs.existsSync(stateBandScanPath) ? stateBandScanPath : null,
    totals: {
      replayCount: coverage.totals?.replayCount ?? 0,
      blockedReplayCount: blockers.length,
      blockedWithCanonicalParityCandidates: blockers.filter((blocker) => (blocker.parity?.candidateCount ?? 0) > 0).length,
      blockedWithCleanedFields: blockers.filter((blocker) => blocker.cleaned.exists).length,
      blockedWithStateBandScan: blockers.filter((blocker) => blocker.stateBandScan).length,
      blockedWithStateBandRawFields: blockers.filter((blocker) => (blocker.stateBandScan?.rawFieldCount ?? 0) > 0).length,
      blockedWithStateBandCleanedFields: blockers.filter((blocker) => (blocker.stateBandScan?.cleanedFieldCount ?? 0) > 0).length,
      blockedWithLowSampleStateBandFields: blockers.filter((blocker) => (blocker.lowSampleStateBandDiagnostic?.cleanedFieldCount ?? 0) > 0).length,
      blockedWithLowSampleParityExports: blockers.filter((blocker) => (blocker.lowSampleParityDiagnostic?.export?.metricSeriesCount ?? 0) > 0).length,
      blockedWithShortSeriesDiagnostic: blockers.filter((blocker) => blocker.shortSeriesDiagnostic).length,
    },
    blockers,
  };

  writeJson(outputPath, output);
  console.log(`Wrote ${outputPath}`);
  console.log(`Blockers: ${blockers.length}; cleaned fields: ${output.totals.blockedWithCleanedFields}; short diagnostics: ${output.totals.blockedWithShortSeriesDiagnostic}.`);
}

main();
