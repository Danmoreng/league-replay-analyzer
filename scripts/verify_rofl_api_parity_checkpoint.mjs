#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    replayId: "EUW1-7840220945",
    artifactRoot: "artifacts-keyframes",
    versionGroup: "16.9",
    requirePerfectMatch: true,
    verifyIncompleteGate: true,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--allow-validation-mismatch") {
      args.requirePerfectMatch = false;
    } else if (arg === "--skip-incomplete-gate") {
      args.verifyIncompleteGate = false;
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
  console.log("Usage: node ./scripts/verify_rofl_api_parity_checkpoint.mjs [--replay-id EUW1-7840220945] [--artifact-root artifacts-keyframes] [--version-group 16.9] [--allow-validation-mismatch] [--skip-incomplete-gate]");
}

function runStep(label, scriptPath, args, options = {}) {
  console.log(`\n[${label}] node ${scriptPath} ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  const expectedStatus = options.expectedStatus ?? 0;
  if (result.status !== expectedStatus) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
  }
  if (expectedStatus !== 0) {
    console.log(`[${label}] expected failure observed with exit code ${expectedStatus}.`);
  }
}

function verifyGoalAuditOutput(replayId, artifactRoot) {
  const auditPath = path.resolve(process.cwd(), artifactRoot, replayId, "rofl-api-parity-goal-audit.json");
  const audit = JSON.parse(fs.readFileSync(auditPath, "utf8"));
  if (audit.auditSchema !== "rofl-api-parity-goal-audit/v1") {
    throw new Error(`Goal audit has unexpected schema marker: ${audit.auditSchema ?? "missing"}.`);
  }
  if (audit.completionStatus !== "not_complete") {
    throw new Error(`Goal audit should remain not_complete while full parity gaps remain: ${audit.completionStatus}.`);
  }
  if ((audit.successCriteria ?? []).length < 8) {
    throw new Error("Goal audit must restate concrete success criteria.");
  }
  if ((audit.promptToArtifactChecklist ?? []).length !== (audit.checks ?? []).length) {
    throw new Error("Goal audit prompt-to-artifact checklist must map every check.");
  }
  const checklistByRequirement = new Map((audit.promptToArtifactChecklist ?? []).map((entry) => [entry.requirement, entry]));
  for (const requirement of [
    "Improve replay-only participant identity linkage using ROFL-only evidence.",
    "Full API-data parity from ROFL-only extraction.",
  ]) {
    const entry = checklistByRequirement.get(requirement);
    if (!entry || entry.status === "satisfied" || (entry.gapCount ?? 0) <= 0) {
      throw new Error(`Goal audit checklist must keep '${requirement}' open with concrete gaps: ${JSON.stringify(entry)}`);
    }
  }
}

function verifyShapeGapOutput(replayId, artifactRoot) {
  const reportPath = path.resolve(process.cwd(), artifactRoot, replayId, "rofl-api-shape-gap-report.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.shapeGapSchema !== "rofl-api-shape-gap-report/v1") {
    throw new Error(`Shape gap report has unexpected schema marker: ${report.shapeGapSchema ?? "missing"}.`);
  }
  if (report.mode !== "offline-validation-only" || report.runtimeInput !== false) {
    throw new Error("Shape gap report must be offline-validation-only and non-runtime.");
  }
  if (report.validatedArtifact?.runtimeRiotApiFiles !== false || report.validatedArtifact?.decoderArtifactSupervised !== false) {
    throw new Error("Shape gap report must target the unsupervised ROFL-only runtime artifact.");
  }
  if ((report.totals?.missingLeafPathCount ?? 0) <= 0) {
    throw new Error("Shape gap report unexpectedly found no missing Riot API shape paths.");
  }
  const categories = new Set((report.sections ?? []).flatMap((section) =>
    (section.missingCategories ?? []).map((entry) => entry.category),
  ));
  for (const category of [
    "timeline-events",
  ]) {
    if (!categories.has(category)) {
      throw new Error(`Shape gap report is missing expected category '${category}'.`);
    }
  }
}

function verifyRiotValidationOutput(replayId, artifactRoot) {
  const reportPath = path.resolve(process.cwd(), artifactRoot, replayId, "rofl-api-metrics-riot-validation.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.validationSchema !== "rofl-api-metrics-riot-validation/v1") {
    throw new Error(`Riot validation report has unexpected schema marker: ${report.validationSchema ?? "missing"}.`);
  }
  if (report.mode !== "offline-validation-only") {
    throw new Error(`Riot validation report must be offline-validation-only, got ${report.mode ?? "missing"}.`);
  }
  if (report.validatedArtifact?.runtimeRiotApiFiles !== false || report.validatedArtifact?.decoderArtifactSupervised !== false) {
    throw new Error("Riot validation report must target the unsupervised ROFL-only runtime artifact.");
  }
  const totals = report.totals ?? {};
  if (totals.failCount !== 0 || totals.teamFailCount !== 0 || totals.finalTimelineFailCount !== 0 || totals.metadataFailCount !== 0) {
    throw new Error(`Riot validation report contains required parity failures: ${JSON.stringify(totals)}`);
  }
  if ((totals.comparisonCount ?? 0) < 1530 || totals.passCount !== totals.comparisonCount) {
    throw new Error(`Riot validation report has insufficient participant parity coverage: ${JSON.stringify(totals)}`);
  }
  if ((totals.teamComparisonCount ?? 0) < 18 || totals.teamPassCount !== totals.teamComparisonCount) {
    throw new Error(`Riot validation report has insufficient team parity coverage: ${JSON.stringify(totals)}`);
  }
  if ((totals.finalTimelineComparisonCount ?? 0) < 170 || totals.finalTimelinePassCount !== totals.finalTimelineComparisonCount) {
    throw new Error(`Riot validation report has insufficient final timeline parity coverage: ${JSON.stringify(totals)}`);
  }
  if ((totals.metadataComparisonCount ?? 0) < 7 || totals.metadataPassCount !== totals.metadataComparisonCount) {
    throw new Error(`Riot validation report has insufficient metadata parity coverage: ${JSON.stringify(totals)}`);
  }
  if ((totals.identifierComparisonCount ?? 0) < 22 || totals.identifierPassCount !== 0) {
    throw new Error(`Riot validation report must keep identifier parity separate and non-blocking: ${JSON.stringify(totals)}`);
  }
}

function verifyChallengeGapOutput(replayId, artifactRoot) {
  const reportPath = path.resolve(process.cwd(), artifactRoot, replayId, "rofl-challenge-gap-candidates.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.challengeGapCandidateSchema !== "rofl-challenge-gap-candidates/v1") {
    throw new Error(`Challenge gap candidate report has unexpected schema marker: ${report.challengeGapCandidateSchema ?? "missing"}.`);
  }
  if (report.mode !== "offline-analysis-only" || report.runtimeInput !== false) {
    throw new Error("Challenge gap candidate report must be offline-analysis-only and non-runtime.");
  }
  if ((report.totals?.challengeKeyCount ?? 0) <= 0 || (report.totals?.notFoundCount ?? 0) <= 0) {
    throw new Error("Challenge gap candidate report must include unresolved challenge gaps.");
  }
  if ((report.totals?.exactNormalizedCount ?? 0) <= 0 || (report.totals?.exactValueParityPassCount ?? 0) <= 0) {
    throw new Error("Challenge gap candidate report must validate exact-normalized ROFL stat candidates by value.");
  }
  if ((report.totals?.rejectedExactValueMismatchCount ?? 0) <= 0) {
    throw new Error("Challenge gap candidate report must record exact-name candidates rejected by value mismatch.");
  }
  if ((report.totals?.corpusReplayCount ?? 0) < 20) {
    throw new Error(`Challenge gap candidate report must include patch-corpus support evidence: ${JSON.stringify(report.totals)}`);
  }
  if ((report.totals?.fuzzyAllZeroOnlyCount ?? 0) <= 0) {
    throw new Error("Challenge gap candidate report must identify all-zero-only fuzzy candidates instead of treating them as promotable parity.");
  }
  if ((report.totals?.fuzzyValidatedNonZeroCount ?? 0) !== 0) {
    throw new Error(`Challenge gap candidate report found unexpected non-zero fuzzy candidates that need explicit promotion review: ${JSON.stringify(report.totals)}`);
  }
  const turretTakedowns = (report.candidates ?? []).find((entry) => entry.challengeKey === "turretTakedowns");
  const killingSprees = (report.candidates ?? []).find((entry) => entry.challengeKey === "killingSprees");
  const snowballsHit = (report.candidates ?? []).find((entry) => entry.challengeKey === "snowballsHit");
  if (turretTakedowns?.promotionStatus !== "promoted_validated_exact") {
    throw new Error(`turretTakedowns challenge candidate must be promoted only after exact value parity: ${JSON.stringify(turretTakedowns)}`);
  }
  if (turretTakedowns?.corpusSupport?.supportedStatKeys?.[0]?.evidenceStrength !== "validated_nonzero") {
    throw new Error(`turretTakedowns challenge candidate must have non-zero corpus support: ${JSON.stringify(turretTakedowns?.corpusSupport)}`);
  }
  if (killingSprees?.promotionStatus !== "rejected_value_mismatch") {
    throw new Error(`killingSprees challenge candidate must remain rejected when exact-name values do not match Riot challenge semantics: ${JSON.stringify(killingSprees)}`);
  }
  const snowballsSupport = snowballsHit?.corpusSupport?.supportedStatKeys?.find((entry) => entry.statKey === "Missions_SnowballsHit");
  if (snowballsSupport?.evidenceStrength !== "all_zero_only") {
    throw new Error(`snowballsHit fuzzy candidate must remain all-zero-only evidence, not promoted parity: ${JSON.stringify(snowballsHit)}`);
  }
}

function verifyRuntimeArtifactOutput(replayId, artifactRoot) {
  const artifactPath = path.resolve(process.cwd(), artifactRoot, replayId, "rofl-api-metrics.json");
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  if (artifact.artifactSchema !== "rofl-api-parity-checkpoint/v1") {
    throw new Error(`ROFL API artifact has unexpected schema marker: ${artifact.artifactSchema ?? "missing"}.`);
  }
  if (artifact.extractionMode !== "rofl-only-final-stats") {
    throw new Error(`ROFL API artifact has unexpected extraction mode: ${artifact.extractionMode ?? "missing"}.`);
  }
  const proof = artifact.roflOnlyExtractionProof ?? {};
  if (proof.proofSchema !== "rofl-only-extraction-proof/v1") {
    throw new Error(`ROFL API artifact is missing the ROFL-only extraction proof: ${proof.proofSchema ?? "missing"}.`);
  }
  if (proof.runtimeInputPolicy?.riotApiRuntimeInput !== false || proof.runtimeInputPolicy?.supervisedFixtureRole !== "offline-validation-only") {
    throw new Error(`ROFL-only extraction proof has unsafe runtime policy: ${JSON.stringify(proof.runtimeInputPolicy ?? null)}`);
  }
  const manifest = artifact.artifactManifest ?? {};
  if (manifest.sourceReplay?.runtimeInput !== true || manifest.replayDerivedSummary?.runtimeInput !== true) {
    throw new Error(`Artifact manifest must mark ROFL replay inputs as runtime inputs: ${JSON.stringify(manifest)}`);
  }
  if (manifest.primaryRuntimeArtifact?.runtimeInput !== false) {
    throw new Error(`Artifact manifest must not treat the generated output as an input: ${JSON.stringify(manifest.primaryRuntimeArtifact ?? null)}`);
  }
  if ((manifest.decoderDiagnostics ?? []).length < 4 || !(manifest.decoderDiagnostics ?? []).every((entry) => entry.runtimeInput === false && entry.runtimeApiData === false)) {
    throw new Error(`Artifact manifest must mark decoder diagnostics as non-runtime/non-API data: ${JSON.stringify(manifest.decoderDiagnostics ?? null)}`);
  }
  const diagnosticRoles = new Set((manifest.decoderDiagnostics ?? []).map((entry) => entry.role));
  for (const role of [
    "rejected-position-candidate-diagnostic",
    "offline-position-validation-diagnostic",
    "replay-only-no-priors-position-diagnostic",
    "offline-no-priors-position-validation-diagnostic",
    "strict-replay-only-position-diagnostic",
    "offline-strict-replay-only-position-validation-diagnostic",
    "replay-only-startup-roster-token-diagnostic",
    "offline-handle-graph-row-link-diagnostic",
    "offline-startup-keyframe-row-link-diagnostic",
    "offline-event-family-correlation-diagnostic",
  ]) {
    if (!diagnosticRoles.has(role)) {
      throw new Error(`Artifact manifest missing decoder diagnostic role '${role}': ${JSON.stringify(manifest.decoderDiagnostics ?? null)}`);
    }
  }
  if ((manifest.offlineValidationReports ?? []).length < 3 || !(manifest.offlineValidationReports ?? []).every((entry) => entry.runtimeInput === false)) {
    throw new Error(`Artifact manifest must mark validation reports as offline-only: ${JSON.stringify(manifest.offlineValidationReports ?? null)}`);
  }
  if ((proof.perParticipantProof ?? []).length !== 10) {
    throw new Error(`ROFL-only extraction proof must include all 10 participants: ${proof.perParticipantProof?.length ?? "missing"}.`);
  }
  const remainingGapKeys = (artifact.remainingParityGaps ?? []).map((entry) => entry.key).sort();
  const proofGapKeys = [...(proof.remainingGapKeys ?? [])].sort();
  if (JSON.stringify(remainingGapKeys) !== JSON.stringify(proofGapKeys)) {
    throw new Error(`ROFL-only extraction proof remainingGapKeys do not match remainingParityGaps: ${JSON.stringify({ proofGapKeys, remainingGapKeys })}`);
  }
  if (
    proof.apiShapeProof?.matchShape?.missingLeafPathCount !== 0 ||
    proof.apiShapeProof?.timelineShape?.missingLeafPathCount !== 70 ||
    proof.apiShapeProof?.timelineShape?.runtimeEmission !== "empty-events-arrays" ||
    proof.apiShapeProof?.fullApiShapeParity !== false
  ) {
    throw new Error(`ROFL-only extraction proof must summarize current match/timeline API shape parity gaps: ${JSON.stringify(proof.apiShapeProof ?? null)}`);
  }
  if (!(proof.perParticipantProof ?? []).every((entry) =>
    entry.finalScalarMetricCount === 5 &&
    entry.finalDamageMetricCount === 12 &&
    (entry.unresolvedRuntimeFields ?? []).includes("position") &&
    (entry.unresolvedRuntimeFields ?? []).includes("championStats")
  )) {
    throw new Error(`ROFL-only extraction proof per-participant counts/gaps are incomplete: ${JSON.stringify(proof.perParticipantProof ?? [])}`);
  }
  const proofPositionCandidate = (proof.notPromotedRuntimeCandidates ?? []).find((entry) => entry.surface === "position x/y movement tracks");
  if (
    proofPositionCandidate?.runtimeApiData !== false ||
    proofPositionCandidate?.assignedParticipantCount !== 9 ||
    proofPositionCandidate?.expectedParticipantCount !== 10 ||
    proofPositionCandidate?.offlinePassingAssignmentCount !== 7 ||
    proofPositionCandidate?.noPriorsAssignedParticipantCount !== 8 ||
    proofPositionCandidate?.noPriorsOfflinePassingAssignmentCount !== 7
  ) {
    throw new Error(`ROFL-only extraction proof must summarize rejected position candidate counts: ${JSON.stringify(proofPositionCandidate ?? null)}`);
  }
}

function verifyParticipantMovementOutput(replayId) {
  const movementPath = path.resolve(process.cwd(), "artifacts", replayId, "participant-movement.json");
  const movement = JSON.parse(fs.readFileSync(movementPath, "utf8"));
  if (movement.replayId !== replayId) {
    throw new Error(`Participant movement artifact replay id mismatch: ${movement.replayId ?? "missing"}.`);
  }
  if ((movement.assignments ?? []).length !== 9) {
    throw new Error(`Focused movement artifact must preserve the 9/10 assignment blocker: ${movement.assignments?.length ?? "missing"}.`);
  }
  if ((movement.unmatchedParticipants ?? []).length !== 1) {
    throw new Error(`Focused movement artifact must preserve exactly one unmatched participant: ${JSON.stringify(movement.unmatchedParticipants ?? [])}`);
  }
  const unmatched = movement.unmatchedParticipants[0];
  if (unmatched.champion !== "Malphite" || unmatched.teamPosition !== "TOP") {
    throw new Error(`Focused movement unmatched participant changed unexpectedly: ${JSON.stringify(unmatched)}`);
  }
  if ((unmatched.topRejectedEntityCandidates ?? []).length === 0) {
    throw new Error("Focused movement unmatched participant must include top rejected entity candidates.");
  }
  if (!(unmatched.topRejectedEntityCandidates ?? []).some((candidate) => candidate.assignedToOtherParticipant === true)) {
    throw new Error(`Focused movement near-miss evidence must show candidates already assigned elsewhere: ${JSON.stringify(unmatched.topRejectedEntityCandidates)}`);
  }
  if ((movement.unassignedEntities ?? []).length !== 2) {
    throw new Error(`Focused movement artifact must preserve two unassigned entities: ${JSON.stringify(movement.unassignedEntities ?? [])}`);
  }
  if (!(movement.unassignedEntities ?? []).every((entity) => (entity.topRejectedParticipantCandidates ?? []).length > 0)) {
    throw new Error(`Focused movement unassigned entities must include rejected participant candidates: ${JSON.stringify(movement.unassignedEntities ?? [])}`);
  }
}

function verifyAssignedMovementValidationOutput(replayId) {
  const validationPath = path.resolve(process.cwd(), "artifacts", replayId, "assigned-movement-validation-report.json");
  const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
  if (validation.replayId !== replayId) {
    throw new Error(`Assigned movement validation replay id mismatch: ${validation.replayId ?? "missing"}.`);
  }
  if (validation.summary?.assignmentCount !== 9 || validation.summary?.passingAssignmentCount !== 7) {
    throw new Error(`Focused movement validation must preserve 7/9 quality blocker: ${JSON.stringify(validation.summary)}`);
  }
}

function verifyParticipantMovementNoPriorsOutput(replayId) {
  const movementPath = path.resolve(process.cwd(), "artifacts", replayId, "participant-movement-no-priors.json");
  const movement = JSON.parse(fs.readFileSync(movementPath, "utf8"));
  if (movement.replayId !== replayId) {
    throw new Error(`No-priors participant movement replay id mismatch: ${movement.replayId ?? "missing"}.`);
  }
  if (movement.priorsPath !== null) {
    throw new Error(`No-priors participant movement must disable identity priors: ${movement.priorsPath}.`);
  }
  if ((movement.assignments ?? []).length !== 8 || (movement.unmatchedParticipants ?? []).length !== 2) {
    throw new Error(`No-priors movement diagnostic must preserve the 8/10 replay-only assignment blocker: ${JSON.stringify({
      assignments: movement.assignments?.length ?? null,
      unmatchedParticipants: movement.unmatchedParticipants?.length ?? null,
    })}`);
  }
}

function verifyAssignedMovementNoPriorsValidationOutput(replayId) {
  const validationPath = path.resolve(process.cwd(), "artifacts", replayId, "assigned-movement-no-priors-validation-report.json");
  const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
  if (validation.replayId !== replayId) {
    throw new Error(`No-priors movement validation replay id mismatch: ${validation.replayId ?? "missing"}.`);
  }
  if (validation.summary?.assignmentCount !== 8 || validation.summary?.passingAssignmentCount !== 7) {
    throw new Error(`No-priors movement validation must preserve 7/8 quality evidence: ${JSON.stringify(validation.summary)}`);
  }
}

function verifyParticipantMovementStrictReplayOnlyOutput(replayId) {
  const movementPath = path.resolve(process.cwd(), "artifacts", replayId, "participant-movement-strict-replay-only-probe.json");
  const movement = JSON.parse(fs.readFileSync(movementPath, "utf8"));
  if (movement.replayId !== replayId) {
    throw new Error(`Strict replay-only participant movement replay id mismatch: ${movement.replayId ?? "missing"}.`);
  }
  if (movement.priorsPath !== null) {
    throw new Error(`Strict replay-only participant movement must disable identity priors: ${movement.priorsPath}.`);
  }
  if (movement.normalization?.useSupportHypotheses !== false) {
    throw new Error(`Strict replay-only participant movement must disable support hypotheses: ${JSON.stringify(movement.normalization ?? null)}`);
  }
  if ((movement.assignments ?? []).length !== 4 || (movement.unmatchedParticipants ?? []).length !== 6) {
    throw new Error(`Strict replay-only movement diagnostic must preserve the 4/10 runtime-promotion blocker: ${JSON.stringify({
      assignments: movement.assignments?.length ?? null,
      unmatchedParticipants: movement.unmatchedParticipants?.length ?? null,
    })}`);
  }
}

function verifyAssignedMovementStrictReplayOnlyValidationOutput(replayId) {
  const validationPath = path.resolve(process.cwd(), "artifacts", replayId, "assigned-movement-strict-replay-only-probe-validation-report.json");
  const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
  if (validation.replayId !== replayId) {
    throw new Error(`Strict replay-only movement validation replay id mismatch: ${validation.replayId ?? "missing"}.`);
  }
  if (validation.summary?.assignmentCount !== 4 || validation.summary?.passingAssignmentCount !== 3) {
    throw new Error(`Strict replay-only movement validation must preserve 3/4 quality evidence: ${JSON.stringify(validation.summary)}`);
  }
}

function verifyIdentityAssignmentOutput(artifactRoot, versionGroup) {
  const assignmentPath = path.resolve(process.cwd(), artifactRoot, `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
  const assignments = JSON.parse(fs.readFileSync(assignmentPath, "utf8"));
  if (assignments.assignmentSchema !== "rofl-keyframe-stat-slot-assignments/v1") {
    throw new Error(`Identity assignment artifact has unexpected schema marker: ${assignments.assignmentSchema ?? "missing"}.`);
  }
  if (assignments.versionGroup !== versionGroup) {
    throw new Error(`Identity assignment artifact version group mismatch: ${assignments.versionGroup ?? "missing"}.`);
  }
  const rejectionSummary = assignments.totals?.rejectionSummary;
  if (rejectionSummary?.status !== "not_assigned") {
    throw new Error("Identity assignment artifact must include a not_assigned rejection summary while no runtime-safe identity exists.");
  }
  if (!(rejectionSummary.primaryBlockers ?? []).includes("no-candidate-has-required-metric-count")) {
    throw new Error(`Identity rejection summary must explain missing multi-metric support: ${JSON.stringify(rejectionSummary)}`);
  }
  if (!(rejectionSummary.primaryBlockers ?? []).includes("positive-support-exists-but-no-accepted-edge-support")) {
    throw new Error(`Identity rejection summary must explain why positive support did not become accepted edges: ${JSON.stringify(rejectionSummary)}`);
  }
  if (Object.keys(rejectionSummary.byMetric ?? {}).length === 0) {
    throw new Error("Identity rejection summary must include per-metric blockers.");
  }
}

function verifyIdentityComparisonOutput(artifactRoot, versionGroup) {
  const comparisonPath = path.resolve(process.cwd(), artifactRoot, `keyframe-rofl-stat-supervised-comparison-${versionGroup}.json`);
  const comparison = JSON.parse(fs.readFileSync(comparisonPath, "utf8"));
  if (comparison.comparisonSchema !== "rofl-keyframe-stat-supervised-comparison/v1") {
    throw new Error(`Identity comparison artifact has unexpected schema marker: ${comparison.comparisonSchema ?? "missing"}.`);
  }
  if (comparison.versionGroup !== versionGroup) {
    throw new Error(`Identity comparison artifact version group mismatch: ${comparison.versionGroup ?? "missing"}.`);
  }
}

function verifyIdentitySupportSweepOutput(artifactRoot, versionGroup) {
  const sweepPath = path.resolve(process.cwd(), artifactRoot, `keyframe-rofl-stat-support-threshold-sweep-${versionGroup}.json`);
  const sweep = JSON.parse(fs.readFileSync(sweepPath, "utf8"));
  if (sweep.sweepSchema !== "rofl-keyframe-stat-support-threshold-sweep/v1") {
    throw new Error(`Identity support sweep artifact has unexpected schema marker: ${sweep.sweepSchema ?? "missing"}.`);
  }
  if (sweep.versionGroup !== versionGroup) {
    throw new Error(`Identity support sweep artifact version group mismatch: ${sweep.versionGroup ?? "missing"}.`);
  }
  const rows = sweep.rows ?? [];
  const defaultRow = rows.find((row) => row.minSupportScore === 0.35);
  if (!defaultRow) {
    throw new Error("Identity support sweep is missing the default minSupportScore=0.35 row.");
  }
  if (defaultRow.assignmentCount !== 0 || defaultRow.canonicalCandidateCount !== 0) {
    throw new Error("Default identity support threshold produced runtime-unsafe assignments.");
  }
  const canonicalRows = rows.filter((row) => (row.canonicalCandidateCount ?? 0) > 0);
  if (canonicalRows.length > 0) {
    throw new Error(`Identity support sweep produced canonical candidates that are not yet runtime-exported: ${JSON.stringify(canonicalRows)}`);
  }
  const unsafeSingleMetric = (sweep.negativeControlRows ?? []).find((row) => row.name === "unsafe-single-metric");
  if (!unsafeSingleMetric) {
    throw new Error("Identity support sweep must include the unsafe single-metric negative control.");
  }
  if ((unsafeSingleMetric.assignmentCount ?? 0) <= 0) {
    throw new Error(`Unsafe single-metric negative control should demonstrate tempting but rejected assignments: ${JSON.stringify(unsafeSingleMetric)}`);
  }
  if ((unsafeSingleMetric.comparisonCounts?.conflict ?? 0) <= 0) {
    throw new Error(`Unsafe single-metric negative control must prove relaxed identity assignments conflict offline: ${JSON.stringify(unsafeSingleMetric)}`);
  }
}

function verifyKeyframeIdentifierTokenScanOutput(artifactRoot, versionGroup) {
  const scanPath = path.resolve(process.cwd(), artifactRoot, "keyframe-identifier-token-scan.json");
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
  if (scan.stableOnly !== true) {
    throw new Error(`Keyframe identifier token scan must use strict stable-only mode: ${JSON.stringify(scan)}`);
  }
  if ((scan.scannedRows ?? 0) <= 0 || (scan.rawCandidateCount ?? 0) <= 0) {
    throw new Error(`Keyframe identifier token scan must inspect candidate rows: ${JSON.stringify(scan)}`);
  }
  if (scan.thresholds?.minSupportRows !== 3 || scan.thresholds?.minHitRate !== 0.75) {
    throw new Error(`Keyframe identifier token scan thresholds changed unexpectedly: ${JSON.stringify(scan.thresholds ?? null)}`);
  }
  const rosterOrderKinds = new Set(["participantId", "rosterIndex", "rosterOrdinal", "teamId", "championId"]);
  const rosterOrderCandidates = (scan.candidates ?? [])
    .filter((candidate) => candidate.versionGroup === versionGroup && rosterOrderKinds.has(candidate.tokenKind));
  if (rosterOrderCandidates.length !== 0) {
    throw new Error(`Strict keyframe identifier token scan found roster/order candidates that need promotion review: ${JSON.stringify(rosterOrderCandidates)}`);
  }
}

function verifyRelaxedKeyframeIdentifierTokenScanOutput(artifactRoot, versionGroup) {
  const scanPath = path.resolve(process.cwd(), artifactRoot, `keyframe-identifier-token-scan-relaxed-${versionGroup}.json`);
  const scan = JSON.parse(fs.readFileSync(scanPath, "utf8"));
  if (scan.stableOnly !== false) {
    throw new Error(`Relaxed keyframe identifier token scan must use all assignments: ${JSON.stringify(scan)}`);
  }
  if ((scan.scannedRows ?? 0) <= 0 || (scan.rawCandidateCount ?? 0) <= 0) {
    throw new Error(`Relaxed keyframe identifier token scan must inspect candidate rows: ${JSON.stringify(scan)}`);
  }
  if (scan.thresholds?.minSupportRows !== 1 || scan.thresholds?.minHitRate !== 0.25) {
    throw new Error(`Relaxed keyframe identifier token scan thresholds changed unexpectedly: ${JSON.stringify(scan.thresholds ?? null)}`);
  }
  const rosterOrderKinds = new Set(["participantId", "rosterIndex", "rosterOrdinal", "teamId", "championId"]);
  const rosterOrderCandidates = (scan.candidates ?? [])
    .filter((candidate) => candidate.versionGroup === versionGroup && rosterOrderKinds.has(candidate.tokenKind));
  if (rosterOrderCandidates.some((candidate) => (candidate.hitRate ?? 0) >= 0.75 && (candidate.hitRows ?? 0) >= 3)) {
    throw new Error(`Relaxed keyframe identifier token scan produced a strict-quality roster/order candidate that needs promotion review: ${JSON.stringify(rosterOrderCandidates)}`);
  }
}

function verifyStartupKeyframeRowLinkOutput(artifactRoot, versionGroup) {
  const diagnosticPath = path.resolve(process.cwd(), artifactRoot, `startup-keyframe-row-link-diagnostic-${versionGroup}.json`);
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, "utf8"));
  if (diagnostic.schema !== "startup-keyframe-row-link-diagnostic/v1") {
    throw new Error(`Startup/keyframe row-link diagnostic has unexpected schema marker: ${diagnostic.schema ?? "missing"}.`);
  }
  if (diagnostic.versionGroup !== versionGroup) {
    throw new Error(`Startup/keyframe row-link diagnostic version group mismatch: ${diagnostic.versionGroup ?? "missing"}.`);
  }
  if (diagnostic.status !== "not_promoted" || diagnostic.runtimeInput !== false || diagnostic.runtimeApiData !== false) {
    throw new Error(`Startup/keyframe row-link diagnostic must remain non-runtime/not-promoted: ${JSON.stringify(diagnostic)}`);
  }
  if (diagnostic.assessment?.startupRosterOrderTokens !== "present" ||
    diagnostic.assessment?.keyframeRosterOrderTokens !== "not_found" ||
    diagnostic.assessment?.directStartupToKeyframeRowLink !== "not_found" ||
    diagnostic.assessment?.runtimePromotion !== "blocked") {
    throw new Error(`Startup/keyframe row-link diagnostic must preserve the current blocked linkage assessment: ${JSON.stringify(diagnostic.assessment ?? null)}`);
  }
  if ((diagnostic.startupRosterOrderCandidates ?? []).length === 0 ||
    !(diagnostic.blockerSummary ?? []).some((blocker) => String(blocker).includes("directStartupToKeyframeRowLink=not_found"))) {
    throw new Error(`Startup/keyframe row-link diagnostic must include startup candidates and the direct-link blocker: ${JSON.stringify(diagnostic)}`);
  }
  if (diagnostic.relaxedKeyframeIdentifierTokenScan?.status !== "relaxed_diagnostic_only_not_runtime_api_data" ||
    diagnostic.relaxedKeyframeIdentifierTokenScan?.runtimeInput !== false ||
    diagnostic.relaxedKeyframeIdentifierTokenScan?.runtimeApiData !== false) {
    throw new Error(`Startup/keyframe row-link diagnostic must include the relaxed token scan as offline-only evidence: ${JSON.stringify(diagnostic.relaxedKeyframeIdentifierTokenScan ?? null)}`);
  }
}

function verifyTimelineReconstructionOutput(replayId, artifactRoot) {
  const reportPath = path.resolve(process.cwd(), artifactRoot, replayId, "timeline-reconstruction-model.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.auditSchema !== "rofl-timeline-reconstruction-model/v1") {
    throw new Error(`Timeline reconstruction audit has unexpected schema marker: ${report.auditSchema ?? "missing"}.`);
  }
  if (report.mode !== "offline-structure-audit" || report.runtimeInput !== false) {
    throw new Error("Timeline reconstruction audit must be offline-structure-audit and non-runtime.");
  }
  const row = report.rows?.[0];
  if (row?.replayId !== replayId) {
    throw new Error(`Timeline reconstruction audit row does not match replay ${replayId}: ${row?.replayId ?? "missing"}.`);
  }
  if (row.structural?.apiFramesEqualKeyframesPlusOne !== true) {
    throw new Error("Timeline reconstruction audit must verify API frames equal replay keyframes plus one.");
  }
  if (row.structural?.keyframeChunkFormulaHolds !== true || row.structural?.chunkRecordFormulaHolds !== true) {
    throw new Error("Timeline reconstruction audit must verify keyframe/chunk record formulas.");
  }
  if (row.reconstructionModel?.model !== "keyframe-baseline-plus-chunk-deltas") {
    throw new Error("Timeline reconstruction audit must record the keyframe baseline plus chunk-delta model.");
  }
  const topInterval = row.topEventfulIntervals?.[0];
  if (!topInterval || (topInterval.eventCounts?.total ?? 0) <= 0) {
    throw new Error("Timeline reconstruction audit must record eventful intervals for decoder targeting.");
  }
  const missingChunkTarget = (topInterval.chunkTargets ?? []).find((chunk) =>
    !Number.isFinite(chunk.chunkId) ||
    !Number.isFinite(chunk.id) ||
    !Number.isFinite(chunk.payloadOffset) ||
    !Number.isFinite(chunk.length) ||
    !Number.isFinite(chunk.uncompressedLength) ||
    chunk.codec !== "zstd"
  );
  if ((topInterval.chunkTargets ?? []).length === 0 || missingChunkTarget) {
    throw new Error(`Timeline reconstruction audit eventful intervals must include concrete zstd chunk payload targets: ${JSON.stringify(topInterval)}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const exportScript = path.join("scripts", "export_rofl_api_metrics.mjs");
  const verifyScript = path.join("scripts", "verify_rofl_api_metrics.mjs");
  const validateScript = path.join("scripts", "validate_rofl_api_metrics_against_riot.mjs");
  const shapeGapScript = path.join("scripts", "audit_rofl_api_shape_gap.mjs");
  const challengeGapScript = path.join("scripts", "audit_rofl_challenge_gap_candidates.mjs");
  const timelineReconstructionScript = path.join("scripts", "audit_timeline_reconstruction_model.mjs");
  const assignMovementScript = path.join("scripts", "assign_replay_movement.mjs");
  const validateAssignedMovementScript = path.join("scripts", "validate_assigned_movement.mjs");
  const summarizeMovementOracleScript = path.join("scripts", "summarize_movement_oracle_coverage.mjs");
  const verifyMovementOracleScript = path.join("scripts", "verify_movement_oracle_coverage.mjs");
  const summarizeMovementAssignmentOracleGapScript = path.join("scripts", "summarize_movement_assignment_oracle_gap.mjs");
  const verifyMovementAssignmentOracleGapScript = path.join("scripts", "verify_movement_assignment_oracle_gap.mjs");
  const summarizeMovementIdentitySignalsScript = path.join("scripts", "summarize_movement_identity_signal_candidates.mjs");
  const verifyMovementIdentitySignalsScript = path.join("scripts", "verify_movement_identity_signal_candidates.mjs");
  const summarizeMovementScoreGapsScript = path.join("scripts", "summarize_movement_score_component_gaps.mjs");
  const verifyMovementScoreGapsScript = path.join("scripts", "verify_movement_score_component_gaps.mjs");
  const summarizeMovementHiddenOraclesScript = path.join("scripts", "summarize_movement_hidden_oracle_sources.mjs");
  const verifyMovementHiddenOraclesScript = path.join("scripts", "verify_movement_hidden_oracle_sources.mjs");
  const compareMovementCandidateExtractionScript = path.join("scripts", "compare_movement_candidate_to_extracted_oracle.mjs");
  const verifyMovementCandidateExtractionScript = path.join("scripts", "verify_movement_candidate_to_extracted_oracle.mjs");
  const auditMovementPositionGoalScript = path.join("scripts", "audit_movement_position_goal.mjs");
  const summarizeReconstructionChunksScript = path.join("scripts", "summarize_reconstruction_chunk_targets.mjs");
  const verifyReconstructionChunksScript = path.join("scripts", "verify_reconstruction_chunk_targets.mjs");
  const compareReconstructionChunksScript = path.join("scripts", "compare_reconstruction_chunk_families.mjs");
  const verifyReconstructionChunkComparisonScript = path.join("scripts", "verify_reconstruction_chunk_family_comparison.mjs");
  const exportReconstructionFamilySamplesScript = path.join("scripts", "export_reconstruction_family_samples.mjs");
  const verifyReconstructionFamilySamplesScript = path.join("scripts", "verify_reconstruction_family_samples.mjs");
  const analyzeReconstructionFamilySamplesScript = path.join("scripts", "analyze_reconstruction_family_samples.mjs");
  const verifyReconstructionFamilySampleAnalysisScript = path.join("scripts", "verify_reconstruction_family_sample_analysis.mjs");
  const rankReconstructionDecoderTargetsScript = path.join("scripts", "rank_reconstruction_decoder_targets.mjs");
  const verifyReconstructionDecoderTargetsScript = path.join("scripts", "verify_reconstruction_decoder_target_ranking.mjs");
  const scanReconstructionRowGridsScript = path.join("scripts", "scan_reconstruction_row_grid_candidates.mjs");
  const verifyReconstructionRowGridsScript = path.join("scripts", "verify_reconstruction_row_grid_candidates.mjs");
  const analyzeReconstructionRowGridFieldsScript = path.join("scripts", "analyze_reconstruction_row_grid_fields.mjs");
  const verifyReconstructionRowGridFieldsScript = path.join("scripts", "verify_reconstruction_row_grid_field_analysis.mjs");
  const buildReconstructionTargetDossierScript = path.join("scripts", "build_reconstruction_target_dossier.mjs");
  const verifyReconstructionTargetDossierScript = path.join("scripts", "verify_reconstruction_target_dossier.mjs");
  const buildReconstructionTargetNeighborhoodScript = path.join("scripts", "build_reconstruction_target_neighborhood.mjs");
  const verifyReconstructionTargetNeighborhoodScript = path.join("scripts", "verify_reconstruction_target_neighborhood.mjs");
  const analyzeReconstructionTargetTableScript = path.join("scripts", "analyze_reconstruction_target_table.mjs");
  const verifyReconstructionTargetTableScript = path.join("scripts", "verify_reconstruction_target_table_analysis.mjs");
  const inferReconstructionRowIdentityScript = path.join("scripts", "infer_reconstruction_row_identity.mjs");
  const verifyReconstructionRowIdentityScript = path.join("scripts", "verify_reconstruction_row_identity.mjs");
  const correlateReconstructionFamiliesEventsScript = path.join("scripts", "correlate_reconstruction_families_events.mjs");
  const verifyReconstructionFamilyEventCorrelationScript = path.join("scripts", "verify_reconstruction_family_event_correlation.mjs");
  const auditScript = path.join("scripts", "audit_rofl_api_parity_goal.mjs");
  const assignIdentityScript = path.join("scripts", "assign_keyframe_slots_from_rofl_stats.mjs");
  const compareIdentityScript = path.join("scripts", "compare_rofl_stat_assignments_to_supervised.mjs");
  const sweepIdentitySupportScript = path.join("scripts", "sweep_rofl_identity_support_thresholds.mjs");
  const scanKeyframeIdentifierTokensScript = path.join("scripts", "scan_keyframe_identifier_tokens.mjs");
  const verifyHandleGraphScoresScript = path.join("scripts", "verify_keyframe_handle_graph_scores.mjs");
  const analyzeStartupKeyframeRowLinksScript = path.join("scripts", "analyze_startup_keyframe_row_links.mjs");
  const sharedArgs = [
    "--replay-id",
    args.replayId,
    "--artifact-root",
    args.artifactRoot,
  ];
  const identityAssignmentPath = path.join(args.artifactRoot, `keyframe-rofl-stat-slot-assignments-${args.versionGroup}.json`);

  runStep("rebuild-rofl-identity-evidence", assignIdentityScript, [
    "--version-group",
    args.versionGroup,
    "--artifact-root",
    args.artifactRoot,
    "--output-path",
    identityAssignmentPath,
  ]);
  verifyIdentityAssignmentOutput(args.artifactRoot, args.versionGroup);
  runStep("compare-rofl-identity-evidence-offline", compareIdentityScript, [
    "--version-group",
    args.versionGroup,
    "--artifact-root",
    args.artifactRoot,
  ]);
  verifyIdentityComparisonOutput(args.artifactRoot, args.versionGroup);
  runStep("sweep-rofl-identity-support-thresholds", sweepIdentitySupportScript, [
    "--version-group",
    args.versionGroup,
    "--artifact-root",
    args.artifactRoot,
  ]);
  verifyIdentitySupportSweepOutput(args.artifactRoot, args.versionGroup);
  runStep("scan-keyframe-identifier-tokens", scanKeyframeIdentifierTokensScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  verifyKeyframeIdentifierTokenScanOutput(args.artifactRoot, args.versionGroup);
  runStep("scan-keyframe-identifier-tokens-relaxed", scanKeyframeIdentifierTokensScript, [
    "--artifact-root",
    args.artifactRoot,
    "--all-assignments",
    "--min-support-rows",
    "1",
    "--min-hit-rate",
    "0.25",
    "--output-path",
    path.join(args.artifactRoot, `keyframe-identifier-token-scan-relaxed-${args.versionGroup}.json`),
  ]);
  verifyRelaxedKeyframeIdentifierTokenScanOutput(args.artifactRoot, args.versionGroup);

  runStep("verify-keyframe-handle-graph-scores", verifyHandleGraphScoresScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);

  runStep("offline-timeline-reconstruction-audit", timelineReconstructionScript, sharedArgs);
  verifyTimelineReconstructionOutput(args.replayId, args.artifactRoot);
  runStep("summarize-reconstruction-chunks", summarizeReconstructionChunksScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("verify-reconstruction-chunks", verifyReconstructionChunksScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("compare-reconstruction-chunks", compareReconstructionChunksScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("verify-reconstruction-chunk-family-comparison", verifyReconstructionChunkComparisonScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("export-reconstruction-family-samples", exportReconstructionFamilySamplesScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("verify-reconstruction-family-samples", verifyReconstructionFamilySamplesScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("analyze-reconstruction-family-samples", analyzeReconstructionFamilySamplesScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("verify-reconstruction-family-sample-analysis", verifyReconstructionFamilySampleAnalysisScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("rank-reconstruction-decoder-targets", rankReconstructionDecoderTargetsScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("verify-reconstruction-decoder-targets", verifyReconstructionDecoderTargetsScript, [
    "--artifact-root",
    args.artifactRoot,
  ]);
  runStep("scan-reconstruction-row-grids", scanReconstructionRowGridsScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  runStep("verify-reconstruction-row-grids", verifyReconstructionRowGridsScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  runStep("analyze-reconstruction-row-grid-fields", analyzeReconstructionRowGridFieldsScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  runStep("verify-reconstruction-row-grid-fields", verifyReconstructionRowGridFieldsScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  for (const familyKey of ["241-0x02", "241-0x04"]) {
    runStep(`build-reconstruction-target-dossier-${familyKey}`, buildReconstructionTargetDossierScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
    ]);
    runStep(`verify-reconstruction-target-dossier-${familyKey}`, verifyReconstructionTargetDossierScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
    ]);
    runStep(`build-reconstruction-target-neighborhood-${familyKey}`, buildReconstructionTargetNeighborhoodScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
    ]);
    runStep(`verify-reconstruction-target-neighborhood-${familyKey}`, verifyReconstructionTargetNeighborhoodScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
    ]);
    runStep(`analyze-reconstruction-target-table-${familyKey}`, analyzeReconstructionTargetTableScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
      "--row-count",
      "10",
      "--row-size",
      "24",
    ]);
    runStep(`verify-reconstruction-target-table-${familyKey}`, verifyReconstructionTargetTableScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
    ]);
    runStep(`infer-reconstruction-row-identity-${familyKey}`, inferReconstructionRowIdentityScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
      "--version-group",
      args.versionGroup,
    ]);
    runStep(`verify-reconstruction-row-identity-${familyKey}`, verifyReconstructionRowIdentityScript, [
      "--artifact-root",
      args.artifactRoot,
      "--family-key",
      familyKey,
      "--version-group",
      args.versionGroup,
    ]);
  }
  runStep("analyze-startup-keyframe-row-links", analyzeStartupKeyframeRowLinksScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  verifyStartupKeyframeRowLinkOutput(args.artifactRoot, args.versionGroup);
  runStep("correlate-reconstruction-families-events", correlateReconstructionFamiliesEventsScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  runStep("verify-reconstruction-family-event-correlation", verifyReconstructionFamilyEventCorrelationScript, [
    "--artifact-root",
    args.artifactRoot,
    "--version-group",
    args.versionGroup,
  ]);
  const movementArtifactDir = path.join("artifacts", args.replayId);
  const participantMovementPath = path.join(movementArtifactDir, "participant-movement.json");
  const participantMovementNoPriorsPath = path.join(movementArtifactDir, "participant-movement-no-priors.json");
  const participantMovementStrictReplayOnlyPath = path.join(movementArtifactDir, "participant-movement-strict-replay-only-probe.json");
  runStep("assign-movement", assignMovementScript, [
    "--artifact-dir",
    movementArtifactDir,
  ]);
  verifyParticipantMovementOutput(args.replayId);
  runStep("validate-assigned-movement", validateAssignedMovementScript, [
    "--participant-movement-path",
    participantMovementPath,
  ]);
  verifyAssignedMovementValidationOutput(args.replayId);
  runStep("assign-movement-no-priors-diagnostic", assignMovementScript, [
    "--artifact-dir",
    movementArtifactDir,
    "--priors-path",
    path.join(movementArtifactDir, "no-priors.json"),
    "--output-path",
    participantMovementNoPriorsPath,
  ]);
  verifyParticipantMovementNoPriorsOutput(args.replayId);
  runStep("validate-assigned-movement-no-priors-diagnostic", validateAssignedMovementScript, [
    "--participant-movement-path",
    participantMovementNoPriorsPath,
    "--output-path",
    path.join(movementArtifactDir, "assigned-movement-no-priors-validation-report.json"),
  ]);
  verifyAssignedMovementNoPriorsValidationOutput(args.replayId);
  runStep("assign-movement-strict-replay-only-diagnostic", assignMovementScript, [
    "--artifact-dir",
    movementArtifactDir,
    "--priors-path",
    path.join(movementArtifactDir, "no-priors.json"),
    "--output-path",
    participantMovementStrictReplayOnlyPath,
    "--ignore-support-hypotheses",
  ]);
  verifyParticipantMovementStrictReplayOnlyOutput(args.replayId);
  runStep("validate-assigned-movement-strict-replay-only-diagnostic", validateAssignedMovementScript, [
    "--participant-movement-path",
    participantMovementStrictReplayOnlyPath,
    "--output-path",
    path.join(movementArtifactDir, "assigned-movement-strict-replay-only-probe-validation-report.json"),
  ]);
  verifyAssignedMovementStrictReplayOnlyValidationOutput(args.replayId);
  runStep("summarize-movement-oracle-coverage", summarizeMovementOracleScript, [
    "--artifact-root",
    "artifacts",
    "--version-group",
    args.versionGroup,
  ]);
  runStep("verify-movement-oracle-coverage", verifyMovementOracleScript, [
    "--version-group",
    args.versionGroup,
  ]);
  runStep("summarize-movement-assignment-oracle-gap", summarizeMovementAssignmentOracleGapScript, [
    "--artifact-root",
    "artifacts",
    "--version-group",
    args.versionGroup,
    "--movement-file",
    "extracted-movement-current-max128.json",
    "--assignment-file",
    "participant-movement-strict-min0.44-current-max128-reduced-role-probe.json",
    "--validation-file",
    "assigned-movement-strict-min0.44-current-max128-reduced-role-probe-validation-report.json",
    "--output-path",
    path.join(args.artifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}-current-max128-reduced-role.json`),
  ]);
  runStep("verify-movement-assignment-oracle-gap", verifyMovementAssignmentOracleGapScript, [
    "--version-group",
    args.versionGroup,
    "--input-path",
    path.join(args.artifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}-current-max128-reduced-role.json`),
  ]);
  runStep("summarize-movement-identity-signals", summarizeMovementIdentitySignalsScript, [
    "--version-group",
    args.versionGroup,
  ]);
  runStep("verify-movement-identity-signals", verifyMovementIdentitySignalsScript, [
    "--version-group",
    args.versionGroup,
  ]);
  runStep("summarize-movement-score-gaps", summarizeMovementScoreGapsScript, [
    "--version-group",
    args.versionGroup,
    "--gap-path",
    path.join(args.artifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}-current-max128-reduced-role.json`),
    "--output-path",
    path.join(args.artifactRoot, `movement-score-component-gaps-${args.versionGroup}-current-max128-reduced-role.json`),
  ]);
  runStep("verify-movement-score-gaps", verifyMovementScoreGapsScript, [
    "--version-group",
    args.versionGroup,
    "--input-path",
    path.join(args.artifactRoot, `movement-score-component-gaps-${args.versionGroup}-current-max128-reduced-role.json`),
    "--expected-wrong-assignment-count",
    "61",
  ]);
  runStep("summarize-movement-hidden-oracles", summarizeMovementHiddenOraclesScript, [
    "--version-group",
    args.versionGroup,
    "--gap-path",
    path.join(args.artifactRoot, `movement-assignment-oracle-gap-${args.versionGroup}-current-max128-reduced-role.json`),
    "--output-path",
    path.join(args.artifactRoot, `movement-hidden-oracle-sources-${args.versionGroup}.json`),
  ]);
  runStep("verify-movement-hidden-oracles", verifyMovementHiddenOraclesScript, [
    "--version-group",
    args.versionGroup,
    "--input-path",
    path.join(args.artifactRoot, `movement-hidden-oracle-sources-${args.versionGroup}.json`),
  ]);
  runStep("compare-movement-candidate-extraction", compareMovementCandidateExtractionScript, [
    "--version-group",
    args.versionGroup,
    "--movement-file",
    "extracted-movement-current-max128.json",
    "--output-path",
    path.join(args.artifactRoot, `movement-candidate-to-extracted-oracle-comparison-${args.versionGroup}-current-max128.json`),
  ]);
  runStep("verify-movement-candidate-extraction", verifyMovementCandidateExtractionScript, [
    "--input-path",
    path.join(args.artifactRoot, `movement-candidate-to-extracted-oracle-comparison-${args.versionGroup}-current-max128.json`),
    "--version-group",
    args.versionGroup,
  ]);
  runStep("movement-position-goal-audit", auditMovementPositionGoalScript, [
    "--version-group",
    args.versionGroup,
  ]);
  runStep("movement-position-goal-audit-require-complete-negative-gate", auditMovementPositionGoalScript, [
    "--version-group",
    args.versionGroup,
    "--require-complete",
  ], {
    expectedStatus: 2,
  });
  runStep("export", exportScript, [
    ...sharedArgs,
    "--version-group",
    args.versionGroup,
  ]);
  verifyRuntimeArtifactOutput(args.replayId, args.artifactRoot);
  runStep("verify-runtime", verifyScript, sharedArgs);
  runStep(
    "offline-riot-validation",
    validateScript,
    args.requirePerfectMatch ? [...sharedArgs, "--require-perfect-match"] : sharedArgs,
  );
  verifyRiotValidationOutput(args.replayId, args.artifactRoot);
  runStep("offline-shape-gap-audit", shapeGapScript, sharedArgs);
  verifyShapeGapOutput(args.replayId, args.artifactRoot);
  runStep("offline-challenge-gap-audit", challengeGapScript, sharedArgs);
  verifyChallengeGapOutput(args.replayId, args.artifactRoot);
  runStep("goal-audit", auditScript, sharedArgs);
  verifyGoalAuditOutput(args.replayId, args.artifactRoot);
  if (args.verifyIncompleteGate) {
    runStep("goal-audit-require-complete-negative-gate", auditScript, [...sharedArgs, "--require-complete"], {
      expectedStatus: 2,
    });
  }

  console.log(`\nROFL API parity checkpoint verified for ${args.replayId}.`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
