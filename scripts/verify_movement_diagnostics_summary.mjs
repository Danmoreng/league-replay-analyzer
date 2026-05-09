#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function parseArgs(argv) {
  const args = {
    inputPath: path.resolve("artifacts-keyframes", "movement-diagnostics-summary-16.9.json"),
    versionGroup: "16.9",
    expectedReplayCount: 20,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = path.resolve(argv[++index]);
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--expected-replay-count" && index + 1 < argv.length) {
      args.expectedReplayCount = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.expectedReplayCount) || args.expectedReplayCount <= 0) {
    throw new Error(`Invalid --expected-replay-count value: ${args.expectedReplayCount}`);
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/verify_movement_diagnostics_summary.mjs [--input-path artifacts-keyframes/movement-diagnostics-summary-16.9.json] [--version-group 16.9] [--expected-replay-count 20]");
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function requireDiagnostic(summary, key) {
  const diagnostic = summary.diagnostics?.[key];
  assert(diagnostic != null, `Missing movement diagnostic: ${key}`);
  assert(diagnostic.key === key, `Diagnostic key mismatch for ${key}`, diagnostic);
  assert(diagnostic.totals != null, `Diagnostic totals missing for ${key}`, diagnostic);
  return diagnostic;
}

function verifyTotalsShape(diagnostic, expectedReplayCount) {
  const totals = diagnostic.totals;
  assert(totals.replayCount === expectedReplayCount, `Unexpected replay count for ${diagnostic.key}`, totals);
  assert(totals.expectedParticipantCount === expectedReplayCount * 10, `Unexpected expected participant count for ${diagnostic.key}`, totals);
  assert(totals.missingReplayCount === 0, `Movement diagnostic has missing replays for ${diagnostic.key}`, totals);
  assert(Number.isFinite(totals.assignmentRate), `Assignment rate missing for ${diagnostic.key}`, totals);
  assert(Number.isFinite(totals.passRatePerAssignment), `Pass rate missing for ${diagnostic.key}`, totals);
  assert(Number.isFinite(totals.passRatePerExpectedParticipant), `Expected-participant pass rate missing for ${diagnostic.key}`, totals);
  assert(totals.assignmentCount >= totals.passingAssignmentCount, `Passing assignments exceed assignments for ${diagnostic.key}`, totals);
  assert(totals.completeReplayCount >= 0 && totals.perfectReplayCount >= 0, `Invalid complete/perfect replay counts for ${diagnostic.key}`, totals);
  for (const key of [
    "assignedByRoleAndStatus",
    "assignedByFamilyAndStatus",
    "assignedByFamilySlotAndStatus",
    "assignedByFamilySlotRoleAndStatus",
    "unmatchedByRole",
    "unmatchedTopCandidateByRole",
    "topRejectedFamilyByRole",
    "topRejectedFamilySlotByRole",
    "assignmentConfidenceByStatus",
    "diagnosticQualityGates",
    "collisionPressureByStatus",
    "assignedOwnerRankByStatus",
    "assignmentRiskMatrix",
    "topCollisionHubs",
  ]) {
    assert(totals[key] != null && typeof totals[key] === "object", `Missing ${key} for ${diagnostic.key}`, totals);
  }
}

function sumNestedStatusCounts(object, statusKeys) {
  let total = 0;
  for (const row of Object.values(object ?? {})) {
    for (const statusKey of statusKeys) {
      total += row?.[statusKey] ?? 0;
    }
  }
  return total;
}

function sumObjectCounts(object) {
  return Object.values(object ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
}

function verifyBreakdownConsistency(diagnostic) {
  const totals = diagnostic.totals;
  const assignedByRole = sumNestedStatusCounts(totals.assignedByRoleAndStatus, ["passing", "failing"]);
  const assignedByFamily = sumNestedStatusCounts(totals.assignedByFamilyAndStatus, ["passing", "failing"]);
  const assignedByFamilySlot = sumNestedStatusCounts(totals.assignedByFamilySlotAndStatus, ["passing", "failing"]);
  assert(assignedByRole === totals.assignmentCount, `Role assignment breakdown does not sum to assignment count for ${diagnostic.key}`, { assignedByRole, totals });
  assert(assignedByFamily === totals.assignmentCount, `Family assignment breakdown does not sum to assignment count for ${diagnostic.key}`, { assignedByFamily, totals });
  assert(assignedByFamilySlot === totals.assignmentCount, `Family-slot assignment breakdown does not sum to assignment count for ${diagnostic.key}`, { assignedByFamilySlot, totals });
  assert(sumObjectCounts(totals.unmatchedByRole) === totals.unmatchedParticipantCount, `Unmatched-by-role breakdown does not sum for ${diagnostic.key}`, totals);
  assert(sumNestedStatusCounts(totals.unmatchedTopCandidateByRole, ["missing", "collision", "below_threshold", "unassigned_above_threshold"]) === totals.unmatchedParticipantCount, `Unmatched top-candidate breakdown does not sum for ${diagnostic.key}`, totals);
  for (const status of ["passing", "failing"]) {
    const confidence = totals.assignmentConfidenceByStatus?.[status];
    assert(confidence != null, `Missing assignment confidence ${status} bucket for ${diagnostic.key}`, totals.assignmentConfidenceByStatus);
    for (const key of ["entityScoreMargin", "participantScoreMargin"]) {
      assert(confidence[key] != null && typeof confidence[key] === "object", `Missing ${key} confidence for ${diagnostic.key}/${status}`, confidence);
      assert(confidence[key].count <= totals.assignmentCount, `Confidence count exceeds assignment count for ${diagnostic.key}/${status}/${key}`, {
        confidence: confidence[key],
        totals,
      });
    }
  }
  for (const [gateKey, gate] of Object.entries(totals.diagnosticQualityGates ?? {})) {
    assert(gate.runtimeApiData === false, `Diagnostic quality gate must be non-runtime API data for ${diagnostic.key}/${gateKey}`, gate);
    assert(gate.assignmentCount >= gate.passingAssignmentCount, `Diagnostic quality gate passing count exceeds assignments for ${diagnostic.key}/${gateKey}`, gate);
    assert(gate.assignmentCount <= totals.assignmentCount, `Diagnostic quality gate count exceeds assignment count for ${diagnostic.key}/${gateKey}`, {
      gate,
      totals,
    });
  }
  for (const bucket of Object.values(totals.collisionPressureByStatus ?? {})) {
    assert((bucket.passing ?? 0) + (bucket.failing ?? 0) <= totals.assignmentCount, `Collision pressure bucket exceeds assignment count for ${diagnostic.key}`, {
      bucket,
      totals,
    });
  }
  assert(sumNestedStatusCounts(totals.assignedOwnerRankByStatus, ["passing", "failing"]) <= totals.assignmentCount, `Assigned-owner-rank breakdown exceeds assignment count for ${diagnostic.key}`, totals.assignedOwnerRankByStatus);
  const riskMatrixTotal = Object.values(totals.assignmentRiskMatrix ?? {}).reduce((sum, row) => sum + (row.assignmentCount ?? 0), 0);
  assert(riskMatrixTotal <= totals.assignmentCount, `Assignment risk matrix exceeds assignment count for ${diagnostic.key}`, {
    riskMatrixTotal,
    totals,
  });
  assert(Array.isArray(totals.topCollisionHubs), `topCollisionHubs must be an array for ${diagnostic.key}`, totals.topCollisionHubs);
  assert(totals.topCollisionHubs.length <= 20, `topCollisionHubs must be capped for ${diagnostic.key}`, totals.topCollisionHubs);
}

function main() {
  const args = parseArgs(process.argv);
  const summary = readJson(args.inputPath);
  assert(summary.schema === "movement-diagnostics-summary/v1", "Unexpected movement diagnostics summary schema", summary.schema);
  assert(summary.versionGroup === args.versionGroup, "Unexpected movement diagnostics version group", {
    expected: args.versionGroup,
    actual: summary.versionGroup,
  });
  assert(summary.replayCount === args.expectedReplayCount, "Unexpected movement diagnostics replay count", {
    expected: args.expectedReplayCount,
    actual: summary.replayCount,
  });

  const defaultDiagnostic = requireDiagnostic(summary, "default");
  const noPriors = requireDiagnostic(summary, "noPriors");
  const minScore = requireDiagnostic(summary, "minScore046NoPriors");
  const strict = requireDiagnostic(summary, "strictReplayOnly");
  const strictMinScore = requireDiagnostic(summary, "strictMinScore044");
  const strictTopOwner = requireDiagnostic(summary, "strictTopOwner");
  const strictMinScoreTopOwner = requireDiagnostic(summary, "strictMinScore044TopOwner");
  const strictDuplicateEntities = requireDiagnostic(summary, "strictMinScore044DuplicateEntities");
  const strictMax50 = requireDiagnostic(summary, "strictMinScore044Max50");
  const strictMax50Supplemented = requireDiagnostic(summary, "strictMinScore044Max50Supplemented");
  const strictMax50CandidateSupplemented = requireDiagnostic(summary, "strictMinScore044Max50CandidateSupplemented");
  const strictCurrentMax128 = requireDiagnostic(summary, "strictMinScore044CurrentMax128");
  const strictCurrentMax128ReducedRole = requireDiagnostic(summary, "strictMinScore044CurrentMax128ReducedRole");
  const strictCurrentMax128ReducedRoleAliases = requireDiagnostic(summary, "strictMinScore044CurrentMax128ReducedRoleAliases");

  for (const diagnostic of [defaultDiagnostic, noPriors, minScore, strict, strictMinScore, strictTopOwner, strictMinScoreTopOwner, strictDuplicateEntities, strictMax50, strictMax50Supplemented, strictMax50CandidateSupplemented, strictCurrentMax128, strictCurrentMax128ReducedRole, strictCurrentMax128ReducedRoleAliases]) {
    verifyTotalsShape(diagnostic, args.expectedReplayCount);
    verifyBreakdownConsistency(diagnostic);
  }

  for (const diagnostic of [defaultDiagnostic, noPriors, minScore, strict, strictMinScore, strictTopOwner, strictMinScoreTopOwner, strictMax50, strictMax50Supplemented, strictMax50CandidateSupplemented, strictCurrentMax128, strictCurrentMax128ReducedRole]) {
    assert(diagnostic.totals.duplicateClaimedEntityCount === 0, `${diagnostic.key} must preserve one-to-one entity assignment`, diagnostic.totals);
  }

  assert(defaultDiagnostic.totals.usesIdentityPriorsCount === args.expectedReplayCount, "Default movement diagnostic should document identity-prior dependence", defaultDiagnostic.totals);
  assert(noPriors.totals.usesIdentityPriorsCount === 0, "No-priors diagnostic must disable identity priors", noPriors.totals);
  assert(minScore.totals.usesIdentityPriorsCount === 0, "No-priors min-score diagnostic must disable identity priors", minScore.totals);
  assert(strict.totals.usesIdentityPriorsCount === 0, "Strict replay-only diagnostic must disable identity priors", strict.totals);
  assert(strictMinScore.totals.usesIdentityPriorsCount === 0, "Strict min-score diagnostic must disable identity priors", strictMinScore.totals);
  assert(strictTopOwner.totals.usesIdentityPriorsCount === 0, "Strict top-owner diagnostic must disable identity priors", strictTopOwner.totals);
  assert(strictMinScoreTopOwner.totals.usesIdentityPriorsCount === 0, "Strict min-score top-owner diagnostic must disable identity priors", strictMinScoreTopOwner.totals);
  assert(strictDuplicateEntities.totals.usesIdentityPriorsCount === 0, "Strict duplicate-entity diagnostic must disable identity priors", strictDuplicateEntities.totals);
  assert(strictMax50.totals.usesIdentityPriorsCount === 0, "Strict max50 diagnostic must disable identity priors", strictMax50.totals);
  assert(strictMax50Supplemented.totals.usesIdentityPriorsCount === 0, "Strict supplemented max50 diagnostic must disable identity priors", strictMax50Supplemented.totals);
  assert(strictMax50CandidateSupplemented.totals.usesIdentityPriorsCount === 0, "Strict candidate-match supplemented max50 diagnostic must disable identity priors", strictMax50CandidateSupplemented.totals);
  assert(strictCurrentMax128.totals.usesIdentityPriorsCount === 0, "Strict current max128 diagnostic must disable identity priors", strictCurrentMax128.totals);
  assert(strictCurrentMax128ReducedRole.totals.usesIdentityPriorsCount === 0, "Strict current max128 reduced-role diagnostic must disable identity priors", strictCurrentMax128ReducedRole.totals);
  assert(strictCurrentMax128ReducedRoleAliases.totals.usesIdentityPriorsCount === 0, "Strict current max128 reduced-role alias diagnostic must disable identity priors", strictCurrentMax128ReducedRoleAliases.totals);
  assert(strict.totals.usesSupportHypothesesCount === 0 && strict.totals.unknownSupportHypothesesCount === 0, "Strict replay-only diagnostic must disable support hypotheses on every replay", strict.totals);
  assert(strictMinScore.totals.usesSupportHypothesesCount === 0 && strictMinScore.totals.unknownSupportHypothesesCount === 0, "Strict min-score diagnostic must disable support hypotheses on every replay", strictMinScore.totals);
  assert(strictTopOwner.totals.usesSupportHypothesesCount === 0 && strictTopOwner.totals.unknownSupportHypothesesCount === 0, "Strict top-owner diagnostic must disable support hypotheses on every replay", strictTopOwner.totals);
  assert(strictMinScoreTopOwner.totals.usesSupportHypothesesCount === 0 && strictMinScoreTopOwner.totals.unknownSupportHypothesesCount === 0, "Strict min-score top-owner diagnostic must disable support hypotheses on every replay", strictMinScoreTopOwner.totals);
  assert(strictDuplicateEntities.totals.usesSupportHypothesesCount === 0 && strictDuplicateEntities.totals.unknownSupportHypothesesCount === 0, "Strict duplicate-entity diagnostic must disable support hypotheses on every replay", strictDuplicateEntities.totals);
  assert(strictMax50.totals.usesSupportHypothesesCount === 0 && strictMax50.totals.unknownSupportHypothesesCount === 0, "Strict max50 diagnostic must disable support hypotheses on every replay", strictMax50.totals);
  assert(strictMax50Supplemented.totals.usesSupportHypothesesCount === 0 && strictMax50Supplemented.totals.unknownSupportHypothesesCount === 0, "Strict supplemented max50 diagnostic must disable support hypotheses on every replay", strictMax50Supplemented.totals);
  assert(strictMax50CandidateSupplemented.totals.usesSupportHypothesesCount === 0 && strictMax50CandidateSupplemented.totals.unknownSupportHypothesesCount === 0, "Strict candidate-match supplemented max50 diagnostic must disable support hypotheses on every replay", strictMax50CandidateSupplemented.totals);
  assert(strictCurrentMax128.totals.usesSupportHypothesesCount === 0 && strictCurrentMax128.totals.unknownSupportHypothesesCount === 0, "Strict current max128 diagnostic must disable support hypotheses on every replay", strictCurrentMax128.totals);
  assert(strictCurrentMax128ReducedRole.totals.usesSupportHypothesesCount === 0 && strictCurrentMax128ReducedRole.totals.unknownSupportHypothesesCount === 0, "Strict current max128 reduced-role diagnostic must disable support hypotheses on every replay", strictCurrentMax128ReducedRole.totals);
  assert(strictCurrentMax128ReducedRoleAliases.totals.usesSupportHypothesesCount === 0 && strictCurrentMax128ReducedRoleAliases.totals.unknownSupportHypothesesCount === 0, "Strict current max128 reduced-role alias diagnostic must disable support hypotheses on every replay", strictCurrentMax128ReducedRoleAliases.totals);
  assert(noPriors.totals.usesSupportHypothesesCount === args.expectedReplayCount, "No-priors diagnostic should expose support-hypothesis dependence", noPriors.totals);
  assert(minScore.totals.usesSupportHypothesesCount === args.expectedReplayCount, "No-priors min-score diagnostic should expose support-hypothesis dependence", minScore.totals);

  assert(strict.totals.assignmentCount < strict.totals.expectedParticipantCount, "Strict replay-only movement unexpectedly reached complete assignment coverage; review promotion gates", strict.totals);
  assert(strict.totals.completeReplayCount === 0 && strict.totals.perfectReplayCount === 0, "Strict replay-only movement unexpectedly has complete/perfect replays; review promotion gates", strict.totals);
  assert(strictMinScore.totals.assignmentCount >= strict.totals.assignmentCount, "Strict min-score probe should not reduce replay-only assignment coverage", {
    strict: strict.totals,
    strictMinScore: strictMinScore.totals,
  });
  assert(strictMinScore.totals.completeReplayCount === 0 && strictMinScore.totals.perfectReplayCount === 0, "Strict min-score replay-only movement unexpectedly has complete/perfect replays; review promotion gates", strictMinScore.totals);
  assert(strictMinScore.totals.passRatePerAssignment <= strict.totals.passRatePerAssignment, "Strict min-score probe should expose coverage/quality tradeoff before promotion", {
    strict: strict.totals,
    strictMinScore: strictMinScore.totals,
  });
  assert(strictMinScore.totals.diagnosticQualityGates?.geographyEntityMargin?.assignmentCount > 0, "Strict min-score summary must include geography/entity-margin gate evidence", strictMinScore.totals.diagnosticQualityGates);
  assert(strictMinScore.totals.diagnosticQualityGates.geographyEntityMargin.assignmentCount < strictMinScore.totals.assignmentCount, "Strict min-score geography/entity-margin gate should remain selective", {
    gate: strictMinScore.totals.diagnosticQualityGates.geographyEntityMargin,
    totals: strictMinScore.totals,
  });
  assert(strictMinScore.totals.diagnosticQualityGates.geographyEntityMargin.passRatePerAssignment > strictMinScore.totals.passRatePerAssignment, "Strict min-score geography/entity-margin gate should document precision improvement without solving coverage", {
    gate: strictMinScore.totals.diagnosticQualityGates.geographyEntityMargin,
    totals: strictMinScore.totals,
  });
  assert((strict.totals.unmatchedTopCandidateByRole?.TOP?.collision ?? 0) > 0, "Strict replay-only diagnostics should expose assignment collision pressure on unmatched TOP participants", strict.totals.unmatchedTopCandidateByRole);
  assert((strictMinScore.totals.unmatchedTopCandidateByRole?.BOTTOM?.collision ?? 0) > 0, "Strict min-score diagnostics should expose assignment collision pressure on unmatched BOTTOM participants", strictMinScore.totals.unmatchedTopCandidateByRole);
  assert((strictMinScore.totals.collisionPressureByStatus?.["7_plus"]?.passing ?? 0) + (strictMinScore.totals.collisionPressureByStatus?.["7_plus"]?.failing ?? 0) > 0, "Strict min-score diagnostics should expose high collision pressure hubs", strictMinScore.totals.collisionPressureByStatus);
  assert((strictMinScore.totals.assignedOwnerRankByStatus?.rank_2_to_3?.passing ?? 0) + (strictMinScore.totals.assignedOwnerRankByStatus?.rank_2_to_3?.failing ?? 0) > 0, "Strict min-score diagnostics should expose non-top entity owner assignments", strictMinScore.totals.assignedOwnerRankByStatus);
  assert(Object.keys(strictMinScore.totals.assignmentRiskMatrix ?? {}).length > 0, "Strict min-score diagnostics should expose assignment risk matrix", strictMinScore.totals.assignmentRiskMatrix);
  assert(strictTopOwner.totals.passRatePerExpectedParticipant <= strict.totals.passRatePerExpectedParticipant, "Top-owner bias should remain diagnostic-only unless it improves strict expected-participant pass rate", {
    strict: strict.totals,
    strictTopOwner: strictTopOwner.totals,
  });
  assert(strictMinScoreTopOwner.totals.passRatePerExpectedParticipant <= strictMinScore.totals.passRatePerExpectedParticipant, "Top-owner bias should remain diagnostic-only unless it improves strict min-score expected-participant pass rate", {
    strictMinScore: strictMinScore.totals,
    strictMinScoreTopOwner: strictMinScoreTopOwner.totals,
  });
  assert(strictDuplicateEntities.totals.duplicateClaimedEntityCount > 0, "Strict duplicate-entity diagnostic should expose duplicate entity claims", strictDuplicateEntities.totals);
  assert(strictDuplicateEntities.totals.assignmentCount > strictMinScore.totals.assignmentCount, "Strict duplicate-entity diagnostic should increase assignment coverage over one-to-one strict min-score", {
    strictMinScore: strictMinScore.totals,
    strictDuplicateEntities: strictDuplicateEntities.totals,
  });
  assert(strictDuplicateEntities.totals.passRatePerAssignment <= strictMinScore.totals.passRatePerAssignment, "Duplicate-entity diagnostic should document collision ambiguity instead of becoming a promotion path", {
    strictMinScore: strictMinScore.totals,
    strictDuplicateEntities: strictDuplicateEntities.totals,
  });
  assert(strictMax50.totals.assignmentCount >= strictMinScore.totals.assignmentCount, "Strict max50 diagnostic should not reduce assignment coverage versus strict min-score baseline", {
    strictMinScore: strictMinScore.totals,
    strictMax50: strictMax50.totals,
  });
  assert(strictMax50.totals.perfectReplayCount === 0, "Strict max50 diagnostic unexpectedly reached perfect replay coverage; review promotion gates", strictMax50.totals);
  assert(strictMax50.totals.passRatePerAssignment <= strictMinScore.totals.passRatePerAssignment, "Strict max50 diagnostic should document the extraction-width coverage/precision tradeoff", {
    strictMinScore: strictMinScore.totals,
    strictMax50: strictMax50.totals,
  });
  assert(strictMax50Supplemented.totals.assignmentCount >= strictMax50.totals.assignmentCount, "Strict supplemented max50 diagnostic should not reduce assignment coverage versus unsupplemented max50", {
    strictMax50: strictMax50.totals,
    strictMax50Supplemented: strictMax50Supplemented.totals,
  });
  assert(strictMax50Supplemented.totals.perfectReplayCount === 0, "Strict supplemented max50 diagnostic unexpectedly reached perfect replay coverage; review promotion gates", strictMax50Supplemented.totals);
  assert(strictMax50CandidateSupplemented.totals.assignmentCount >= strictMax50Supplemented.totals.assignmentCount, "Strict candidate-match supplemented max50 diagnostic should not reduce assignment coverage versus max50 supplemented", {
    strictMax50Supplemented: strictMax50Supplemented.totals,
    strictMax50CandidateSupplemented: strictMax50CandidateSupplemented.totals,
  });
  assert(strictMax50CandidateSupplemented.totals.perfectReplayCount === 0, "Strict candidate-match supplemented max50 diagnostic unexpectedly reached perfect replay coverage; review promotion gates", strictMax50CandidateSupplemented.totals);
  assert(strictCurrentMax128.totals.assignmentCount >= strictMax50Supplemented.totals.assignmentCount, "Strict current max128 diagnostic should not reduce assignment coverage versus max50 supplemented", {
    strictMax50Supplemented: strictMax50Supplemented.totals,
    strictCurrentMax128: strictCurrentMax128.totals,
  });
  assert(strictCurrentMax128.totals.perfectReplayCount === 0, "Strict current max128 diagnostic unexpectedly reached perfect replay coverage; review promotion gates", strictCurrentMax128.totals);
  assert(strictCurrentMax128ReducedRole.totals.assignmentCount >= strictCurrentMax128.totals.assignmentCount, "Reduced role-anchor score profile should document assignment coverage headroom on current max128 extraction", {
    strictCurrentMax128: strictCurrentMax128.totals,
    strictCurrentMax128ReducedRole: strictCurrentMax128ReducedRole.totals,
  });
  assert(strictCurrentMax128ReducedRole.totals.passingAssignmentCount >= strictCurrentMax128.totals.passingAssignmentCount, "Reduced role-anchor score profile should not reduce validation-passing assignment count", {
    strictCurrentMax128: strictCurrentMax128.totals,
    strictCurrentMax128ReducedRole: strictCurrentMax128ReducedRole.totals,
  });
  assert(strictCurrentMax128ReducedRole.totals.perfectReplayCount === 0, "Reduced role-anchor score profile unexpectedly reached perfect replay coverage; review promotion gates", strictCurrentMax128ReducedRole.totals);
  assert(strictCurrentMax128ReducedRoleAliases.totals.assignmentCount > strictCurrentMax128ReducedRole.totals.assignmentCount, "Alias-preserving diagnostic should document coverage recovered from canonicalization collapse", {
    strictCurrentMax128ReducedRole: strictCurrentMax128ReducedRole.totals,
    strictCurrentMax128ReducedRoleAliases: strictCurrentMax128ReducedRoleAliases.totals,
  });
  assert(strictCurrentMax128ReducedRoleAliases.totals.passingAssignmentCount > strictCurrentMax128ReducedRole.totals.passingAssignmentCount, "Alias-preserving diagnostic should recover additional validation-passing assignments", {
    strictCurrentMax128ReducedRole: strictCurrentMax128ReducedRole.totals,
    strictCurrentMax128ReducedRoleAliases: strictCurrentMax128ReducedRoleAliases.totals,
  });
  assert(strictCurrentMax128ReducedRoleAliases.totals.perfectReplayCount === 0, "Alias-preserving diagnostic unexpectedly reached perfect replay coverage; review promotion gates", strictCurrentMax128ReducedRoleAliases.totals);
  assert(strictCurrentMax128ReducedRoleAliases.totals.duplicateClaimedEntityCount > 0, "Alias-preserving diagnostic should expose alias-level duplicate claims before promotion", strictCurrentMax128ReducedRoleAliases.totals);
  assert(minScore.totals.assignmentCount > noPriors.totals.assignmentCount, "Min-score probe should demonstrate the coverage/quality tradeoff", {
    noPriors: noPriors.totals,
    minScore: minScore.totals,
  });
  assert(minScore.totals.passRatePerAssignment < noPriors.totals.passRatePerAssignment, "Min-score probe should not look better than the default no-priors gate without review", {
    noPriors: noPriors.totals,
    minScore: minScore.totals,
  });

  console.log(`Verified movement diagnostics summary: ${args.inputPath}`);
  console.log(`strict replay-only assigned=${strict.totals.assignmentCount}/${strict.totals.expectedParticipantCount}, passing=${strict.totals.passingAssignmentCount}/${strict.totals.assignmentCount}`);
}

main();
