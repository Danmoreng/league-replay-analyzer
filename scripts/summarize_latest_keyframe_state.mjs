import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
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
  console.log("Usage: node ./scripts/summarize_latest_keyframe_state.mjs [--version-group 16.9] [--artifact-root <path>] [--output-path <path>]");
}

function loadOptionalJson(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function countRows(exportJson) {
  return (exportJson?.replays ?? []).reduce((sum, replay) => sum + (replay.participants ?? []).length, 0);
}

function countMetricSeries(exportJson) {
  return (exportJson?.replays ?? []).reduce(
    (sum, replay) => sum + (replay.participants ?? []).reduce(
      (inner, participant) => inner + Object.keys(participant.metrics ?? {}).length,
      0,
    ),
    0,
  );
}

function countReplayLocalRows(exportJson) {
  return (exportJson?.replays ?? []).reduce(
    (sum, replay) => sum + (replay.participants ?? []).filter((participant) => participant.replayLocalAssignment).length,
    0,
  );
}

function countCorrectedH16Rows(exportJson) {
  return (exportJson?.replays ?? []).reduce(
    (sum, replay) => sum + (replay.participants ?? []).filter((participant) => participant.familyKey === "24672-0x60-h16").length,
    0,
  );
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const coveragePath = path.join(artifactRoot, `keyframe-export-coverage-${args.versionGroup}.json`);
  const stableExportPath = path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}.json`);
  const allExportPath = path.join(artifactRoot, `keyframe-state-prototype-${args.versionGroup}-all-assignments.json`);
  const handleGraphScorePath = path.join(artifactRoot, "keyframe-handle-graph-candidate-scores.json");
  const stableIdentityOrderPath = path.join(artifactRoot, `keyframe-identity-order-analysis-${args.versionGroup}-stable.json`);
  const allIdentityOrderPath = path.join(artifactRoot, `keyframe-identity-order-analysis-${args.versionGroup}-all.json`);
  const roflStatAssignmentsPath = path.join(artifactRoot, `keyframe-rofl-stat-slot-assignments-${args.versionGroup}.json`);
  const roflStatSupervisedComparisonPath = path.join(artifactRoot, `keyframe-rofl-stat-supervised-comparison-${args.versionGroup}.json`);
  const roflStatValidationPath = path.join(artifactRoot, `keyframe-state-rofl-stat-validation-${args.versionGroup}.json`);
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join(artifactRoot, `latest-keyframe-state-summary-${args.versionGroup}.json`),
  );

  const coverage = readJson(coveragePath);
  const stableExport = readJson(stableExportPath);
  const allExport = readJson(allExportPath);
  const handleGraphScores = loadOptionalJson(handleGraphScorePath);
  const stableIdentityOrder = loadOptionalJson(stableIdentityOrderPath);
  const allIdentityOrder = loadOptionalJson(allIdentityOrderPath);
  const roflStatAssignments = loadOptionalJson(roflStatAssignmentsPath);
  const roflStatSupervisedComparison = loadOptionalJson(roflStatSupervisedComparisonPath);
  const roflStatValidation = loadOptionalJson(roflStatValidationPath);
  const blockedReplays = (coverage.replays ?? [])
    .filter((replay) => replay.blocker)
    .map((replay) => ({
      replayId: replay.replayId,
      blocker: replay.blocker,
      candidateStateSlotCount: replay.candidateStateSlotCount,
      edgeCount: replay.edgeCount,
      assignmentCount: replay.assignmentCount,
    }));

  const output = {
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    artifactRoot,
    sources: {
      coveragePath,
      stableExportPath,
      allExportPath,
      handleGraphScorePath: handleGraphScores ? handleGraphScorePath : null,
      stableIdentityOrderPath: stableIdentityOrder ? stableIdentityOrderPath : null,
      allIdentityOrderPath: allIdentityOrder ? allIdentityOrderPath : null,
      roflStatAssignmentsPath: roflStatAssignments ? roflStatAssignmentsPath : null,
      roflStatSupervisedComparisonPath: roflStatSupervisedComparison ? roflStatSupervisedComparisonPath : null,
      roflStatValidationPath: roflStatValidation ? roflStatValidationPath : null,
    },
    stable: {
      exportedReplayCount: stableExport.totals?.exportedReplayCount ?? 0,
      replayCount: stableExport.totals?.replayCount ?? 0,
      assignedRows: countRows(stableExport),
      metricSeries: countMetricSeries(stableExport),
      pointCount: stableExport.totals?.pointCount ?? 0,
      replayLocalRows: countReplayLocalRows(stableExport),
      correctedH16Rows: countCorrectedH16Rows(stableExport),
    },
    allAssignments: {
      exportedReplayCount: allExport.totals?.exportedReplayCount ?? 0,
      replayCount: allExport.totals?.replayCount ?? 0,
      assignedRows: countRows(allExport),
      metricSeries: countMetricSeries(allExport),
      pointCount: allExport.totals?.pointCount ?? 0,
      replayLocalRows: countReplayLocalRows(allExport),
      correctedH16Rows: countCorrectedH16Rows(allExport),
    },
    coverage: coverage.totals,
    blockedReplays,
    handleGraph: handleGraphScores
      ? {
          candidateCount: handleGraphScores.candidateCount,
          confidenceCounts: handleGraphScores.confidenceCounts,
          topScore: handleGraphScores.candidates?.[0]?.score ?? null,
          supervisedReplayCount: handleGraphScores.supervisedAssignmentSummary?.replayCount ?? null,
          supervisedSlotCount: handleGraphScores.supervisedAssignmentSummary?.slots?.length ?? null,
        }
      : null,
    identityOrder: {
      stable: stableIdentityOrder ? {
        assignmentRowCount: stableIdentityOrder.assignmentRowCount,
        replaySummaryCount: stableIdentityOrder.replaySummaryCount,
        participantIdEqualsRosterOrder: stableIdentityOrder.summary?.participantIdEqualsRosterOrder ?? null,
        aggregateSlotParticipantOrderRate: stableIdentityOrder.summary?.aggregateParticipantIdOrder?.rate ?? null,
        aggregateSlotRoleOrderRate: stableIdentityOrder.summary?.aggregateRoleOrder?.rate ?? null,
      } : null,
      allAssignments: allIdentityOrder ? {
        assignmentRowCount: allIdentityOrder.assignmentRowCount,
        replaySummaryCount: allIdentityOrder.replaySummaryCount,
        participantIdEqualsRosterOrder: allIdentityOrder.summary?.participantIdEqualsRosterOrder ?? null,
        aggregateSlotParticipantOrderRate: allIdentityOrder.summary?.aggregateParticipantIdOrder?.rate ?? null,
        aggregateSlotRoleOrderRate: allIdentityOrder.summary?.aggregateRoleOrder?.rate ?? null,
      } : null,
    },
    replayOnlyRoflStats: roflStatAssignments ? {
      analyzedReplayCount: roflStatAssignments.analyzedReplayCount,
      assignmentCount: roflStatAssignments.totals?.assignmentCount ?? 0,
      edgeCount: roflStatAssignments.totals?.edgeCount ?? 0,
      confidence: roflStatAssignments.totals?.confidence ?? null,
      diagnostics: roflStatAssignments.totals?.diagnostics ?? null,
      thresholds: roflStatAssignments.thresholds ?? null,
      supervisedComparison: roflStatSupervisedComparison ? roflStatSupervisedComparison.totals : null,
      exportedStateValidation: roflStatValidation ? {
        totals: roflStatValidation.totals,
        failureSummary: roflStatValidation.failureSummary ?? null,
      } : null,
    } : null,
    conclusion: "Valid supervised keyframe state extraction exists, but replay-only participant identity linkage remains unresolved.",
  };

  writeJson(outputPath, output);
  console.log(`Wrote latest keyframe state summary to ${outputPath}`);
  console.log(`Stable ${args.versionGroup}: ${output.stable.assignedRows} rows, ${output.stable.metricSeries} metric series across ${output.stable.exportedReplayCount}/${output.stable.replayCount} replay(s).`);
  console.log(`Handle graph: ${output.handleGraph?.confidenceCounts?.strong ?? 0} strong, ${output.handleGraph?.confidenceCounts?.investigate ?? 0} investigate candidate(s).`);
}

main();
