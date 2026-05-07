import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    requireFullAssignedRowCoverage: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--allow-missing-assigned-rows") {
      args.requireFullAssignedRowCoverage = false;
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
  console.log("Usage: node ./scripts/verify_keyframe_state_exports.mjs [--version-group 16.9] [--artifact-root <path>] [--allow-missing-assigned-rows]");
}

function assert(condition, message, details = null) {
  if (!condition) {
    const suffix = details ? ` ${JSON.stringify(details)}` : "";
    throw new Error(`${message}${suffix}`);
  }
}

function countRows(exportJson) {
  return (exportJson.replays ?? []).reduce((sum, replay) => sum + (replay.participants ?? []).length, 0);
}

function countMetricSeries(exportJson) {
  return (exportJson.replays ?? []).reduce(
    (sum, replay) => sum + (replay.participants ?? []).reduce(
      (inner, participant) => inner + Object.keys(participant.metrics ?? {}).length,
      0,
    ),
    0,
  );
}

function verifyQualityReport(quality, expectedRows, expectedVersionGroup, label) {
  assert(quality.versionGroup === expectedVersionGroup, `${label} quality report has unexpected version group`, {
    versionGroup: quality.versionGroup,
    expectedVersionGroup,
  });
  assert(quality.totals?.metricSeriesCount === expectedRows, `${label} quality metric-series count differs from export`, {
    qualityMetricSeriesCount: quality.totals?.metricSeriesCount,
    expectedRows,
  });
  assert((quality.totals?.violationCount ?? 0) === 0, `${label} quality report has fit-gate violations`, {
    violationCount: quality.totals?.violationCount,
    violations: (quality.violations ?? []).slice(0, 8),
  });
}

function verifyBlockerReport(blockers, coverage, summary, expectedVersionGroup) {
  assert(blockers.versionGroup === expectedVersionGroup, "Blocker report has unexpected version group", {
    versionGroup: blockers.versionGroup,
    expectedVersionGroup,
  });
  const coverageBlocked = (coverage.replays ?? [])
    .filter((replay) => replay.blocker)
    .map((replay) => replay.replayId)
    .sort();
  const summaryBlocked = (summary.blockedReplays ?? [])
    .map((replay) => replay.replayId)
    .sort();
  const blockerRows = (blockers.blockers ?? [])
    .map((replay) => replay.replayId)
    .sort();
  assert(JSON.stringify(coverageBlocked) === JSON.stringify(summaryBlocked), "Coverage and latest summary disagree on blocked replay ids", {
    coverageBlocked,
    summaryBlocked,
  });
  assert(JSON.stringify(coverageBlocked) === JSON.stringify(blockerRows), "Blocker report and coverage disagree on blocked replay ids", {
    coverageBlocked,
    blockerRows,
  });
  assert(blockers.totals?.blockedReplayCount === coverageBlocked.length, "Blocker report count differs from coverage", {
    blockedReplayCount: blockers.totals?.blockedReplayCount,
    coverageBlockedReplayCount: coverageBlocked.length,
  });
}

function verifyStateBandScan(scan, blockers, expectedVersionGroup) {
  assert(scan.versionGroup === expectedVersionGroup, "State-band scan has unexpected version group", {
    versionGroup: scan.versionGroup,
    expectedVersionGroup,
  });
  const blockerRows = (blockers.blockers ?? [])
    .map((replay) => replay.replayId)
    .sort();
  const scanRows = (scan.scans ?? [])
    .map((replay) => replay.replayId)
    .sort();
  assert(JSON.stringify(blockerRows) === JSON.stringify(scanRows), "State-band scan and blocker report disagree on replay ids", {
    blockerRows,
    scanRows,
  });
  assert(scan.totals?.replayCount === blockerRows.length, "State-band scan replay count differs from blocker report", {
    scanReplayCount: scan.totals?.replayCount,
    blockerReplayCount: blockerRows.length,
  });
  assert(blockers.totals?.blockedWithStateBandScan === blockerRows.length, "Blocker report is missing state-band scan rows", {
    blockedWithStateBandScan: blockers.totals?.blockedWithStateBandScan,
    blockerReplayCount: blockerRows.length,
  });
  assert(scan.parameters?.rowOffsetMinActiveSamples === 4, "State-band scan is missing the expected row-offset min-active-samples threshold", {
    rowOffsetMinActiveSamples: scan.parameters?.rowOffsetMinActiveSamples,
  });
  const scanSuppressed = (scan.scans ?? []).reduce(
    (sum, replay) => sum + (replay.raw?.suppressedByMinActiveSamplesSlotCount ?? 0),
    0,
  );
  const blockerSuppressed = (blockers.blockers ?? []).reduce(
    (sum, replay) => sum + (replay.stateBandScan?.rawSlotsSuppressedByMinActiveSamples ?? 0),
    0,
  );
  assert(scanSuppressed === blockerSuppressed, "State-band scan and blocker report disagree on suppressed slot count", {
    scanSuppressed,
    blockerSuppressed,
  });
  const lowSampleDiagnosticCount = (blockers.blockers ?? []).filter(
    (replay) => (replay.lowSampleStateBandDiagnostic?.cleanedFieldCount ?? 0) > 0,
  ).length;
  assert((blockers.totals?.blockedWithLowSampleStateBandFields ?? 0) === lowSampleDiagnosticCount, "Blocker report low-sample diagnostic count is inconsistent", {
    total: blockers.totals?.blockedWithLowSampleStateBandFields,
    lowSampleDiagnosticCount,
  });
  const lowSampleParityExportCount = (blockers.blockers ?? []).filter(
    (replay) => (replay.lowSampleParityDiagnostic?.export?.metricSeriesCount ?? 0) > 0,
  ).length;
  assert((blockers.totals?.blockedWithLowSampleParityExports ?? 0) === lowSampleParityExportCount, "Blocker report low-sample parity export count is inconsistent", {
    total: blockers.totals?.blockedWithLowSampleParityExports,
    lowSampleParityExportCount,
  });
  const lowSampleMissingAmbiguity = (blockers.blockers ?? []).filter(
    (replay) =>
      (replay.lowSampleParityDiagnostic?.assignments?.assignmentCount ?? 0) > 0 &&
      !replay.lowSampleParityDiagnostic?.assignments?.ambiguity,
  );
  assert(lowSampleMissingAmbiguity.length === 0, "Low-sample parity diagnostics are missing assignment ambiguity summaries", {
    replayIds: lowSampleMissingAmbiguity.map((replay) => replay.replayId),
  });
}

function verifyIdentityOrder(summary) {
  const stable = summary.identityOrder?.stable;
  const allAssignments = summary.identityOrder?.allAssignments;
  assert(stable != null && allAssignments != null, "Latest summary is missing identity-order analysis", {
    identityOrder: summary.identityOrder,
  });
  assert(stable.assignmentRowCount === summary.stable?.assignedRows, "Stable identity-order row count differs from latest summary", {
    identityOrderRows: stable.assignmentRowCount,
    summaryRows: summary.stable?.assignedRows,
  });
  assert(allAssignments.assignmentRowCount === summary.allAssignments?.assignedRows, "All-assignment identity-order row count differs from latest summary", {
    identityOrderRows: allAssignments.assignmentRowCount,
    summaryRows: summary.allAssignments?.assignedRows,
  });
}

function verifyReplayOnlyRoflStats(summary, artifactRoot, versionGroup) {
  const roflStats = summary.replayOnlyRoflStats;
  assert(roflStats != null, "Latest summary is missing replay-only ROFL stats assignment analysis", {});
  assert(Number.isFinite(roflStats.assignmentCount) && Number.isFinite(roflStats.edgeCount), "Replay-only ROFL stats summary has invalid counts", roflStats);
  const roflStatsPath = path.join(artifactRoot, `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
  const roflStatsArtifact = loadRequiredJson(roflStatsPath);
  assert(roflStatsArtifact.versionGroup === versionGroup, "Replay-only ROFL stats artifact has unexpected version group", {
    versionGroup: roflStatsArtifact.versionGroup,
    expectedVersionGroup: versionGroup,
  });
  assert(roflStats.assignmentCount === roflStatsArtifact.totals?.assignmentCount, "Replay-only ROFL stats assignment count differs from raw artifact", {
    summaryAssignmentCount: roflStats.assignmentCount,
    artifactAssignmentCount: roflStatsArtifact.totals?.assignmentCount,
  });
  assert(roflStats.edgeCount === roflStatsArtifact.totals?.edgeCount, "Replay-only ROFL stats edge count differs from raw artifact", {
    summaryEdgeCount: roflStats.edgeCount,
    artifactEdgeCount: roflStatsArtifact.totals?.edgeCount,
  });
  const confidence = roflStatsArtifact.totals?.confidence;
  assert(confidence != null, "Replay-only ROFL stats artifact is missing confidence totals", {});
  assert((confidence.assignmentCount ?? 0) === roflStatsArtifact.totals?.assignmentCount, "Replay-only ROFL stats confidence totals do not sum to assignment count", {
    confidenceAssignmentCount: confidence.assignmentCount,
    assignmentCount: roflStatsArtifact.totals?.assignmentCount,
  });
  assert(((confidence.canonicalCandidateCount ?? 0) + (confidence.diagnosticOnlyCount ?? 0)) === roflStatsArtifact.totals?.assignmentCount, "Replay-only ROFL stats canonical/diagnostic split does not sum to assignment count", {
    confidence,
    assignmentCount: roflStatsArtifact.totals?.assignmentCount,
  });
  assert(JSON.stringify(roflStats.confidence ?? null) === JSON.stringify(confidence), "Latest summary replay-only ROFL stats confidence differs from raw artifact", {
    summaryConfidence: roflStats.confidence,
    artifactConfidence: confidence,
  });
  const comparisonPath = path.join(artifactRoot, `keyframe-rofl-stat-supervised-comparison-${versionGroup}.json`);
  const comparison = loadRequiredJson(comparisonPath);
  assert(comparison.versionGroup === versionGroup, "Replay-only ROFL stats supervised comparison has unexpected version group", {
    versionGroup: comparison.versionGroup,
    expectedVersionGroup: versionGroup,
  });
  assert(comparison.totals?.assignmentCount === roflStatsArtifact.totals?.assignmentCount, "Replay-only ROFL stats supervised comparison assignment count differs from raw artifact", {
    comparisonAssignmentCount: comparison.totals?.assignmentCount,
    artifactAssignmentCount: roflStatsArtifact.totals?.assignmentCount,
  });
  assert(comparison.totals?.canonicalCandidateCount === confidence.canonicalCandidateCount, "Replay-only ROFL stats comparison canonical count differs from raw confidence totals", {
    comparisonCanonicalCandidateCount: comparison.totals?.canonicalCandidateCount,
    artifactCanonicalCandidateCount: confidence.canonicalCandidateCount,
  });
  assert((comparison.totals?.byConfidence?.["diagnostic-only"] ?? 0) === confidence.diagnosticOnlyCount, "Replay-only ROFL stats comparison diagnostic count differs from raw confidence totals", {
    comparisonByConfidence: comparison.totals?.byConfidence,
    artifactDiagnosticOnlyCount: confidence.diagnosticOnlyCount,
  });
  assert(Number.isFinite(comparison.totals?.stableSupervisedConflictCount), "Replay-only ROFL stats comparison is missing stable-supervision conflict totals", {
    comparisonTotals: comparison.totals,
  });
  assert(Number.isFinite(comparison.totals?.unstableSupervisedConflictCount), "Replay-only ROFL stats comparison is missing unstable-supervision conflict totals", {
    comparisonTotals: comparison.totals,
  });
  assert(JSON.stringify(roflStats.supervisedComparison ?? null) === JSON.stringify(comparison.totals), "Latest summary replay-only ROFL stats supervised comparison differs from comparison artifact", {
    summaryComparison: roflStats.supervisedComparison,
    artifactComparison: comparison.totals,
  });
  const validationPath = path.join(artifactRoot, `keyframe-state-rofl-stat-validation-${versionGroup}.json`);
  const validation = loadRequiredJson(validationPath);
  assert(validation.versionGroup === versionGroup, "Keyframe ROFL stats validation has unexpected version group", {
    versionGroup: validation.versionGroup,
    expectedVersionGroup: versionGroup,
  });
  assert((validation.totals?.comparisonCount ?? 0) === (validation.totals?.passCount ?? 0) + (validation.totals?.failCount ?? 0), "Keyframe ROFL stats validation totals are inconsistent", {
    validationTotals: validation.totals,
  });
  assert((validation.totals?.stableComparisonCount ?? 0) === (validation.totals?.stablePassCount ?? 0) + (validation.totals?.stableFailCount ?? 0), "Keyframe ROFL stats validation stable totals are inconsistent", {
    validationTotals: validation.totals,
  });
  assert(Number.isFinite(validation.totals?.finalWindowComparisonCount), "Keyframe ROFL stats validation is missing final-window totals", {
    validationTotals: validation.totals,
  });
  assert((validation.totals?.finalWindowComparisonCount ?? 0) === (validation.totals?.finalWindowPassCount ?? 0) + (validation.totals?.finalWindowFailCount ?? 0), "Keyframe ROFL stats validation final-window totals are inconsistent", {
    validationTotals: validation.totals,
  });
  assert((validation.totals?.outsideFinalWindowComparisonCount ?? 0) === (validation.totals?.outsideFinalWindowPassCount ?? 0) + (validation.totals?.outsideFinalWindowFailCount ?? 0), "Keyframe ROFL stats validation outside-final-window totals are inconsistent", {
    validationTotals: validation.totals,
  });
  assert((validation.totals?.comparisonCount ?? 0) === (validation.totals?.finalWindowComparisonCount ?? 0) + (validation.totals?.outsideFinalWindowComparisonCount ?? 0), "Keyframe ROFL stats validation final-window split does not sum to comparison count", {
    validationTotals: validation.totals,
  });
  const validationFailureCount = validation.totals?.failCount ?? 0;
  const groupedFailureCounts = [
    validation.failureSummary?.byReplay,
    validation.failureSummary?.byMetric,
    validation.failureSummary?.bySourceFamily,
  ];
  for (const groupedFailures of groupedFailureCounts) {
    assert(groupedFailures != null, "Keyframe ROFL stats validation is missing failure grouping", {
      failureSummary: validation.failureSummary,
    });
    const groupedCount = Object.values(groupedFailures).reduce((sum, count) => sum + count, 0);
    assert(groupedCount === validationFailureCount, "Keyframe ROFL stats validation failure grouping does not match fail count", {
      groupedFailures,
      groupedCount,
      validationFailureCount,
    });
  }
  const expectedValidationSummary = {
    totals: validation.totals,
    failureSummary: validation.failureSummary ?? null,
  };
  assert(JSON.stringify(roflStats.exportedStateValidation ?? null) === JSON.stringify(expectedValidationSummary), "Latest summary keyframe ROFL stats validation differs from validation artifact", {
    summaryValidation: roflStats.exportedStateValidation,
    artifactValidation: expectedValidationSummary,
  });
}

function badH16Corrections(exportJson) {
  return (exportJson.replays ?? []).flatMap((replay) =>
    (replay.participants ?? [])
      .filter((participant) => participant.sourceFamilyKey === "24672-0x60-h0")
      .filter((participant) =>
        participant.familyKey !== "24672-0x60-h16" ||
        participant.slotIndex !== participant.sourceSlotIndex - 1 ||
        participant.structuralCorrection !== "h0-discovery-to-h16-structural-family",
      )
      .map((participant) => ({
        replayId: replay.replayId,
        participantId: participant.participant?.participantId,
        familyKey: participant.familyKey,
        slotIndex: participant.slotIndex,
        sourceFamilyKey: participant.sourceFamilyKey,
        sourceSlotIndex: participant.sourceSlotIndex,
        structuralCorrection: participant.structuralCorrection,
      })),
  );
}

function loadRequiredJson(filePath) {
  assert(fs.existsSync(filePath), "Required artifact is missing", { filePath });
  return readJson(filePath);
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const stablePath = path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}.json`);
  const allPath = path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}-all-assignments.json`);
  const coveragePath = path.join(artifactRoot, `keyframe-export-coverage-${args.versionGroup}.json`);
  const summaryPath = path.join(artifactRoot, `latest-keyframe-state-summary-${args.versionGroup}.json`);
  const stableQualityPath = path.join(artifactRoot, `keyframe-state-quality-${args.versionGroup}.json`);
  const allQualityPath = path.join(artifactRoot, `keyframe-state-quality-${args.versionGroup}-all-assignments.json`);
  const blockersPath = path.join(artifactRoot, `keyframe-blockers-${args.versionGroup}.json`);
  const stateBandScanPath = path.join(artifactRoot, `keyframe-state-band-scan-${args.versionGroup}.json`);

  const stableExport = loadRequiredJson(stablePath);
  const allExport = loadRequiredJson(allPath);
  const coverage = loadRequiredJson(coveragePath);
  const summary = loadRequiredJson(summaryPath);
  const stableQuality = loadRequiredJson(stableQualityPath);
  const allQuality = loadRequiredJson(allQualityPath);
  const blockers = loadRequiredJson(blockersPath);
  const stateBandScan = loadRequiredJson(stateBandScanPath);
  const stableRows = countRows(stableExport);
  const allRows = countRows(allExport);
  const stableMetrics = countMetricSeries(stableExport);
  const allMetrics = countMetricSeries(allExport);

  assert(stableExport.filters?.versionGroup === args.versionGroup, "Stable export has unexpected version-group filter", stableExport.filters);
  assert(allExport.filters?.versionGroup === args.versionGroup, "All-assignment export has unexpected version-group filter", allExport.filters);
  assert(stableRows === coverage.totals?.stableExportedParticipantCount, "Stable export row count differs from coverage", {
    stableRows,
    coverageRows: coverage.totals?.stableExportedParticipantCount,
  });
  assert(allRows === coverage.totals?.allExportedParticipantCount, "All-assignment export row count differs from coverage", {
    allRows,
    coverageRows: coverage.totals?.allExportedParticipantCount,
  });
  assert(stableRows === summary.stable?.assignedRows, "Stable export row count differs from latest summary", {
    stableRows,
    summaryRows: summary.stable?.assignedRows,
  });
  assert(allRows === summary.allAssignments?.assignedRows, "All-assignment export row count differs from latest summary", {
    allRows,
    summaryRows: summary.allAssignments?.assignedRows,
  });
  assert(stableMetrics === summary.stable?.metricSeries, "Stable metric-series count differs from latest summary", {
    stableMetrics,
    summaryMetricSeries: summary.stable?.metricSeries,
  });
  assert(allMetrics === summary.allAssignments?.metricSeries, "All-assignment metric-series count differs from latest summary", {
    allMetrics,
    summaryMetricSeries: summary.allAssignments?.metricSeries,
  });
  verifyQualityReport(stableQuality, stableMetrics, args.versionGroup, "Stable export");
  verifyQualityReport(allQuality, allMetrics, args.versionGroup, "All-assignment export");
  verifyBlockerReport(blockers, coverage, summary, args.versionGroup);
  verifyStateBandScan(stateBandScan, blockers, args.versionGroup);
  verifyIdentityOrder(summary);
  verifyReplayOnlyRoflStats(summary, artifactRoot, args.versionGroup);

  if (args.requireFullAssignedRowCoverage) {
    assert((coverage.totals?.stableMissingRowCount ?? 0) === 0, "Stable export is missing assigned rows", {
      stableMissingRowCount: coverage.totals?.stableMissingRowCount,
    });
    assert((coverage.totals?.allMissingRowCount ?? 0) === 0, "All-assignment export is missing assigned rows", {
      allMissingRowCount: coverage.totals?.allMissingRowCount,
    });
  }

  const badCorrections = [
    ...badH16Corrections(stableExport),
    ...badH16Corrections(allExport),
  ];
  assert(badCorrections.length === 0, "Found invalid h0-to-h16 correction rows", { badCorrections: badCorrections.slice(0, 8) });

  console.log(`Verified keyframe state exports for ${args.versionGroup}.`);
  console.log(`Stable rows=${stableRows}, metrics=${stableMetrics}; all rows=${allRows}, metrics=${allMetrics}.`);
}

main();
