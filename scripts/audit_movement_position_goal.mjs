#!/usr/bin/env node

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    diagnosticsPath: "artifacts-keyframes/movement-diagnostics-summary-16.9.json",
    assignmentOracleGapPath: "artifacts-keyframes/movement-assignment-oracle-gap-16.9-current-max128-reduced-role.json",
    identitySignalPath: "artifacts-keyframes/movement-identity-signal-candidates-16.9.json",
    scoreComponentGapPath: "artifacts-keyframes/movement-score-component-gaps-16.9-current-max128-reduced-role.json",
    hiddenOraclePath: "artifacts-keyframes/movement-hidden-oracle-sources-16.9.json",
    candidateExtractionPath: "artifacts-keyframes/movement-candidate-to-extracted-oracle-comparison-16.9-current-max128.json",
    versionGroup: "16.9",
    expectedReplayCount: 20,
    outputPath: "artifacts-keyframes/movement-position-goal-audit-16.9.json",
    requireComplete: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--diagnostics-path" && index + 1 < argv.length) args.diagnosticsPath = argv[++index];
    else if (arg === "--assignment-oracle-gap-path" && index + 1 < argv.length) args.assignmentOracleGapPath = argv[++index];
    else if (arg === "--identity-signal-path" && index + 1 < argv.length) args.identitySignalPath = argv[++index];
    else if (arg === "--score-component-gap-path" && index + 1 < argv.length) args.scoreComponentGapPath = argv[++index];
    else if (arg === "--hidden-oracle-path" && index + 1 < argv.length) args.hiddenOraclePath = argv[++index];
    else if (arg === "--candidate-extraction-path" && index + 1 < argv.length) args.candidateExtractionPath = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--require-complete") args.requireComplete = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/audit_movement_position_goal.mjs [--diagnostics-path artifacts-keyframes/movement-diagnostics-summary-16.9.json] [--assignment-oracle-gap-path artifacts-keyframes/movement-assignment-oracle-gap-16.9-current-max128-reduced-role.json] [--identity-signal-path artifacts-keyframes/movement-identity-signal-candidates-16.9.json] [--score-component-gap-path artifacts-keyframes/movement-score-component-gaps-16.9-current-max128-reduced-role.json] [--hidden-oracle-path artifacts-keyframes/movement-hidden-oracle-sources-16.9.json] [--candidate-extraction-path artifacts-keyframes/movement-candidate-to-extracted-oracle-comparison-16.9-current-max128.json] [--version-group 16.9] [--expected-replay-count 20] [--output-path <path>] [--require-complete]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function check(name, passed, evidence, blocker) {
  return {
    name,
    passed: Boolean(passed),
    evidence,
    blocker: passed ? null : blocker,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const diagnosticsPath = resolveAbsolute(root, args.diagnosticsPath);
  const assignmentOracleGapPath = resolveAbsolute(root, args.assignmentOracleGapPath);
  const identitySignalPath = resolveAbsolute(root, args.identitySignalPath);
  const scoreComponentGapPath = resolveAbsolute(root, args.scoreComponentGapPath);
  const hiddenOraclePath = resolveAbsolute(root, args.hiddenOraclePath);
  const candidateExtractionPath = resolveAbsolute(root, args.candidateExtractionPath);
  const diagnostics = readJson(diagnosticsPath);
  const gap = readJson(assignmentOracleGapPath);
  const identitySignals = readJson(identitySignalPath);
  const scoreComponentGaps = readJson(scoreComponentGapPath);
  const hiddenOracles = readJson(hiddenOraclePath);
  const candidateExtraction = readJson(candidateExtractionPath);
  const strict = diagnostics.diagnostics?.strictReplayOnly ?? null;
  const strictCurrentMax128 = diagnostics.diagnostics?.strictMinScore044CurrentMax128ReducedRole ?? null;
  const expectedParticipantCount = args.expectedReplayCount * 10;

  const checks = [
    check(
      "strict replay-only diagnostics exist",
      strict != null && strictCurrentMax128 != null,
      {
        strictReplayOnly: strict?.key ?? null,
        strictCurrentMax128ReducedRole: strictCurrentMax128?.key ?? null,
      },
      "Missing strict replay-only movement diagnostics.",
    ),
    check(
      "no identity priors or validation support hypotheses",
      strictCurrentMax128?.totals?.usesIdentityPriorsCount === 0 &&
        strictCurrentMax128?.totals?.usesSupportHypothesesCount === 0 &&
        strictCurrentMax128?.totals?.unknownSupportHypothesesCount === 0,
      {
        usesIdentityPriorsCount: strictCurrentMax128?.totals?.usesIdentityPriorsCount ?? null,
        usesSupportHypothesesCount: strictCurrentMax128?.totals?.usesSupportHypothesesCount ?? null,
        unknownSupportHypothesesCount: strictCurrentMax128?.totals?.unknownSupportHypothesesCount ?? null,
      },
      "Runtime candidate still depends on identity priors or validation-derived support hypotheses.",
    ),
    check(
      "all 16.9 corpus participants assigned",
      strictCurrentMax128?.totals?.assignmentCount === expectedParticipantCount,
      {
        assignmentCount: strictCurrentMax128?.totals?.assignmentCount ?? null,
        expectedParticipantCount,
      },
      `Strict replay-only assignment does not cover all ${expectedParticipantCount} corpus participants.`,
    ),
    check(
      "all assigned participants pass offline position validation",
      strictCurrentMax128?.totals?.passingAssignmentCount === expectedParticipantCount,
      {
        passingAssignmentCount: strictCurrentMax128?.totals?.passingAssignmentCount ?? null,
        expectedParticipantCount,
      },
      `Strict replay-only assignment does not produce ${expectedParticipantCount} validation-passing tracks.`,
    ),
    check(
      "all 20 replay files have perfect 10-player position coverage",
      strictCurrentMax128?.totals?.perfectReplayCount === args.expectedReplayCount,
      {
        perfectReplayCount: strictCurrentMax128?.totals?.perfectReplayCount ?? null,
        expectedReplayCount: args.expectedReplayCount,
      },
      "Not every replay has 10 validation-passing replay-only participant position tracks.",
    ),
    check(
      "assignment/oracle identity gap closed",
      (gap.totals?.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? 0) === 0 &&
        (gap.totals?.statusCounts?.passing_oracle_unassigned ?? 0) === 0,
      {
        wrongEntityCount: gap.totals?.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? null,
        unassignedPassingOracleCount: gap.totals?.statusCounts?.passing_oracle_unassigned ?? null,
      },
      "Passing movement candidates remain available but are assigned to the wrong participant or left unassigned.",
    ),
    check(
      "replay-native entity identity signal selected",
      (identitySignals.promotionGate?.promotableFeatureCount ?? 0) > 0,
      {
        status: identitySignals.status ?? null,
        rowCount: identitySignals.rowCount ?? null,
        promotableFeatureCount: identitySignals.promotionGate?.promotableFeatureCount ?? null,
        topFeature: identitySignals.features?.[0]?.name ?? null,
        topFeatureWeightedPurity: identitySignals.features?.[0]?.weightedPurity ?? null,
        topFeatureAmbiguousValueCount: identitySignals.features?.[0]?.ambiguousValueCount ?? null,
      },
      "Existing replay-derived entity-key features are too ambiguous to identify participant-owned movement tracks.",
    ),
    check(
      "replay-only score separates oracle entities from wrong assignments",
      (scoreComponentGaps.oracleVisibilityCounts?.oracle_not_visible_in_recorded_alternatives ?? 0) === 0 &&
        (scoreComponentGaps.scoreDeltas?.oracleMinusAssignedScore?.negative ?? 0) === 0,
      {
        wrongAssignmentCount: scoreComponentGaps.statusCounts?.passing_oracle_available_wrong_entity_assigned ?? null,
        oracleVisibleCount: scoreComponentGaps.oracleVisibilityCounts?.oracle_visible ?? null,
        oracleHiddenCount: scoreComponentGaps.oracleVisibilityCounts?.oracle_not_visible_in_recorded_alternatives ?? null,
        visibleOracleAverageScoreDelta: scoreComponentGaps.scoreDeltas?.oracleMinusAssignedScore?.average ?? null,
        visibleOraclePositiveScoreDeltaCount: scoreComponentGaps.scoreDeltas?.oracleMinusAssignedScore?.positive ?? null,
        visibleOracleNegativeScoreDeltaCount: scoreComponentGaps.scoreDeltas?.oracleMinusAssignedScore?.negative ?? null,
        roleScoreAverageDelta: scoreComponentGaps.componentDeltas?.roleScore?.average ?? null,
        teamScoreAverageDelta: scoreComponentGaps.componentDeltas?.teamScore?.average ?? null,
        hiddenOracleCount: hiddenOracles.totals?.hiddenCount ?? null,
        hiddenOracleReasonCounts: hiddenOracles.totals?.hiddenReasonCounts ?? null,
      },
      "Current replay-only score keeps many oracle entities hidden or below the selected wrong entity.",
    ),
    check(
      "extraction preserves discovered validation-passing movement candidates",
      (candidateExtraction.totals?.lostCandidatePassCount ?? 0) === 0,
      {
        lostCandidatePassCount: candidateExtraction.totals?.lostCandidatePassCount ?? null,
        lostCandidatePassByReason: candidateExtraction.totals?.lostCandidatePassByReason ?? null,
        preservedPassCount: candidateExtraction.totals?.statusCounts?.preserved_pass ?? null,
        extractedOnlyPassCount: candidateExtraction.totals?.statusCounts?.extracted_only_pass ?? null,
      },
      "Some validation-passing movement candidates are discovered but not preserved into extracted movement entities.",
    ),
  ];

  const passedChecks = checks.filter((entry) => entry.passed).length;
  const output = {
    generatedAtUtc: new Date().toISOString(),
    auditSchema: "movement-position-goal-audit/v1",
    versionGroup: args.versionGroup,
    objective: "Promote replay-only participantFrames.position to runtime output with stable participantId mapping for all 10 players across the 16.9 corpus, without Riot API data or identity priors.",
    status: passedChecks === checks.length ? "complete" : "not_complete",
    diagnosticsPath,
    assignmentOracleGapPath,
    identitySignalPath,
    scoreComponentGapPath,
    hiddenOraclePath,
    candidateExtractionPath,
    expectedReplayCount: args.expectedReplayCount,
    expectedParticipantCount,
    passedChecks,
    totalChecks: checks.length,
    checks,
    openChecks: checks.filter((entry) => !entry.passed).map((entry) => entry.name),
  };
  const outputPath = resolveAbsolute(root, args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote movement position goal audit to ${outputPath}`);
  console.log(`Movement position goal status: ${output.status}`);
  console.log(`Satisfied checks: ${passedChecks}/${checks.length}`);
  if (args.requireComplete && output.status !== "complete") {
    process.exitCode = 2;
  }
}

main();
