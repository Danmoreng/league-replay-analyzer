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
    "match-metadata",
    "participant-challenges",
    "match-participant-event-flags",
    "match-participant-account-profile",
    "match-participant-static-id-mapping",
    "team-bans",
    "team-objective-first-flags",
    "timeline-events",
    "timeline-participant-frames",
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
  if ((totals.finalTimelineComparisonCount ?? 0) < 120 || totals.finalTimelinePassCount !== totals.finalTimelineComparisonCount) {
    throw new Error(`Riot validation report has insufficient final timeline parity coverage: ${JSON.stringify(totals)}`);
  }
  if ((totals.metadataComparisonCount ?? 0) < 5 || totals.metadataPassCount !== totals.metadataComparisonCount) {
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

function main() {
  const args = parseArgs(process.argv);
  const exportScript = path.join("scripts", "export_rofl_api_metrics.mjs");
  const verifyScript = path.join("scripts", "verify_rofl_api_metrics.mjs");
  const validateScript = path.join("scripts", "validate_rofl_api_metrics_against_riot.mjs");
  const shapeGapScript = path.join("scripts", "audit_rofl_api_shape_gap.mjs");
  const challengeGapScript = path.join("scripts", "audit_rofl_challenge_gap_candidates.mjs");
  const auditScript = path.join("scripts", "audit_rofl_api_parity_goal.mjs");
  const assignIdentityScript = path.join("scripts", "assign_keyframe_slots_from_rofl_stats.mjs");
  const compareIdentityScript = path.join("scripts", "compare_rofl_stat_assignments_to_supervised.mjs");
  const sweepIdentitySupportScript = path.join("scripts", "sweep_rofl_identity_support_thresholds.mjs");
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

  runStep("export", exportScript, sharedArgs);
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
