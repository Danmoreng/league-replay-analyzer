#!/usr/bin/env node

import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

const requiredFullParityGaps = [
  "non-stats match metadata",
  "non-final participant identity",
  "non-final scalar calibration",
  "true Riot API PUUID identity parity",
  "positions",
  "timeline events",
  "inventory timeline",
  "damage timeline",
];

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    replayId: null,
    inputPath: null,
    outputPath: null,
    requireComplete: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--require-complete") {
      args.requireComplete = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.replayId && !args.inputPath) {
    throw new Error("Either --replay-id or --input-path is required.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/audit_rofl_api_parity_goal.mjs --replay-id <id> [--require-complete]");
}

function pass(condition, evidence = [], gaps = []) {
  return {
    status: condition ? "satisfied" : "missing",
    evidence,
    gaps,
  };
}

function checklistByRequirement(artifact) {
  return new Map((artifact.parityChecklist ?? []).map((entry) => [entry.requirement, entry]));
}

function statusForChecklist(status) {
  if (status === "satisfied") {
    return "satisfied";
  }
  if (status === "partial") {
    return "partial";
  }
  return "not_satisfied";
}

function buildPromptToArtifactChecklist(checks) {
  return checks.map((check, index) => ({
    item: index + 1,
    requirement: check.requirement,
    status: statusForChecklist(check.status),
    evidenceCount: check.evidence?.length ?? 0,
    gapCount: check.gaps?.length ?? 0,
    primaryEvidence: (check.evidence ?? []).slice(0, 8),
    gaps: check.gaps ?? [],
  }));
}

function readOptionalJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return readJson(filePath);
}

function findRuntimeRiotApiReferences(value, pathParts = []) {
  const matches = [];
  if (typeof value === "string") {
    if (value.replaceAll("\\", "/").toLowerCase().includes("replays/api")) {
      matches.push(pathParts.join(".") || "<root>");
    }
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      matches.push(...findRuntimeRiotApiReferences(item, [...pathParts, String(index)]));
    });
    return matches;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      matches.push(...findRuntimeRiotApiReferences(child, [...pathParts, key]));
    }
  }
  return matches;
}

function buildAudit(artifact, inputPath) {
  const docsPath = path.join(process.cwd(), "docs", "rofl-api-parity.md");
  const docsText = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : "";
  const validationPath = path.join(path.dirname(inputPath), "rofl-api-metrics-riot-validation.json");
  const validation = readOptionalJson(validationPath);
  const shapeGapPath = path.join(path.dirname(inputPath), "rofl-api-shape-gap-report.json");
  const shapeGap = readOptionalJson(shapeGapPath);
  const challengeGapPath = path.join(path.dirname(inputPath), "rofl-challenge-gap-candidates.json");
  const challengeGap = readOptionalJson(challengeGapPath);
  const timelineReconstructionPath = path.join(path.dirname(inputPath), "timeline-reconstruction-model.json");
  const timelineReconstruction = readOptionalJson(timelineReconstructionPath);
  const reconstructionTargetDossier02Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-dossier-241-0x02-16.9.json");
  const reconstructionTargetDossier04Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-dossier-241-0x04-16.9.json");
  const reconstructionTargetNeighborhood02Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-neighborhood-241-0x02-16.9.json");
  const reconstructionTargetNeighborhood04Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-neighborhood-241-0x04-16.9.json");
  const reconstructionTargetTable02Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-table-analysis-241-0x02-16.9.json");
  const reconstructionTargetTable04Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-target-table-analysis-241-0x04-16.9.json");
  const reconstructionRowIdentity02Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-row-identity-241-0x02-16.9.json");
  const reconstructionRowIdentity04Path = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-row-identity-241-0x04-16.9.json");
  const reconstructionRowGridCandidatesPath = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-row-grid-candidates-16.9.json");
  const reconstructionRowGridFieldAnalysisPath = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-row-grid-field-analysis-16.9.json");
  const reconstructionFamilyEventCorrelationPath = path.join(process.cwd(), "artifacts-keyframes", "reconstruction-family-event-correlation-16.9.json");
  const reconstructionTargetDossier02 = readOptionalJson(reconstructionTargetDossier02Path);
  const reconstructionTargetDossier04 = readOptionalJson(reconstructionTargetDossier04Path);
  const reconstructionTargetNeighborhood02 = readOptionalJson(reconstructionTargetNeighborhood02Path);
  const reconstructionTargetNeighborhood04 = readOptionalJson(reconstructionTargetNeighborhood04Path);
  const reconstructionTargetTable02 = readOptionalJson(reconstructionTargetTable02Path);
  const reconstructionTargetTable04 = readOptionalJson(reconstructionTargetTable04Path);
  const reconstructionRowIdentity02 = readOptionalJson(reconstructionRowIdentity02Path);
  const reconstructionRowIdentity04 = readOptionalJson(reconstructionRowIdentity04Path);
  const reconstructionRowGridCandidates = readOptionalJson(reconstructionRowGridCandidatesPath);
  const reconstructionRowGridFieldAnalysis = readOptionalJson(reconstructionRowGridFieldAnalysisPath);
  const reconstructionFamilyEventCorrelation = readOptionalJson(reconstructionFamilyEventCorrelationPath);
  const artifactRelativePath = path.relative(process.cwd(), inputPath).replaceAll("\\", "/");
  const auditRelativePath = path.relative(process.cwd(), path.join(path.dirname(inputPath), "rofl-api-parity-goal-audit.json")).replaceAll("\\", "/");
  const shapeGapRelativePath = path.relative(process.cwd(), shapeGapPath).replaceAll("\\", "/");
  const challengeGapRelativePath = path.relative(process.cwd(), challengeGapPath).replaceAll("\\", "/");
  const timelineReconstructionRelativePath = path.relative(process.cwd(), timelineReconstructionPath).replaceAll("\\", "/");
  const reconstructionTargetDossier02RelativePath = path.relative(process.cwd(), reconstructionTargetDossier02Path).replaceAll("\\", "/");
  const reconstructionTargetDossier04RelativePath = path.relative(process.cwd(), reconstructionTargetDossier04Path).replaceAll("\\", "/");
  const reconstructionTargetNeighborhood02RelativePath = path.relative(process.cwd(), reconstructionTargetNeighborhood02Path).replaceAll("\\", "/");
  const reconstructionTargetNeighborhood04RelativePath = path.relative(process.cwd(), reconstructionTargetNeighborhood04Path).replaceAll("\\", "/");
  const reconstructionTargetTable02RelativePath = path.relative(process.cwd(), reconstructionTargetTable02Path).replaceAll("\\", "/");
  const reconstructionTargetTable04RelativePath = path.relative(process.cwd(), reconstructionTargetTable04Path).replaceAll("\\", "/");
  const reconstructionRowIdentity02RelativePath = path.relative(process.cwd(), reconstructionRowIdentity02Path).replaceAll("\\", "/");
  const reconstructionRowIdentity04RelativePath = path.relative(process.cwd(), reconstructionRowIdentity04Path).replaceAll("\\", "/");
  const reconstructionRowGridCandidatesRelativePath = path.relative(process.cwd(), reconstructionRowGridCandidatesPath).replaceAll("\\", "/");
  const reconstructionRowGridFieldAnalysisRelativePath = path.relative(process.cwd(), reconstructionRowGridFieldAnalysisPath).replaceAll("\\", "/");
  const reconstructionFamilyEventCorrelationRelativePath = path.relative(process.cwd(), reconstructionFamilyEventCorrelationPath).replaceAll("\\", "/");
  const identityCorpusPath = path.join(process.cwd(), "artifacts-keyframes", "keyframe-rofl-stat-slot-assignments-16.9.json");
  const identityCorpus = readOptionalJson(identityCorpusPath);
  const identityThresholdSweepPath = path.join(process.cwd(), "artifacts-keyframes", "keyframe-rofl-stat-support-threshold-sweep-16.9.json");
  const identityThresholdSweep = readOptionalJson(identityThresholdSweepPath);
  const rowIdentityStatusAllowed = (row) =>
    (row.status === "unstable_identity" || row.status === "duplicate_rejected") &&
    row.participantId === null &&
    row.runtimeApiData === false;
  const duplicateRejectedRowCount = (rowIdentityArtifact) =>
    (rowIdentityArtifact?.rowIdentity ?? []).filter((row) => row.status === "duplicate_rejected").length;
  const runtimeRiotApiReferences = findRuntimeRiotApiReferences(artifact);
  const byRequirement = checklistByRequirement(artifact);
  const fullParity = byRequirement.get("Full API data parity from ROFL-only extraction.");
  const fullParityGaps = new Set(fullParity?.gaps ?? []);
  const artifactIdentityChecklist = byRequirement.get("Improve replay-only participant identity linkage using ROFL-only evidence.");
  const artifactFilteringChecklist = byRequirement.get("Filter noisy candidates and avoid exposing low-confidence affine artifacts as real API data.");
  const artifactVerificationChecklist = byRequirement.get("Add verification that proves ROFL-only fields and remaining gaps.");
  const sourceInputClasses = artifact.source?.inputClasses ?? {};
  const nonFinalIdentity = artifact.rejectedCandidateArtifacts?.nonFinalScalarIdentity;
  const rejectedCandidates = artifact.rejectedCandidateArtifacts ?? {};
  const runtimeReconstructionRowIdentity = rejectedCandidates.reconstructionRowIdentity ?? {};
  const identityLinkage = artifact.identityLinkage ?? {};
  const identityEvidenceMatrix = identityLinkage.evidenceMatrix ?? [];
  const roflDerivedFieldMap = artifact.roflDerivedFieldMap ?? {};
  const fieldCoverage = artifact.fieldCoverage ?? {};
  const remainingGapByKey = new Map((artifact.remainingParityGaps ?? []).map((entry) => [entry.key, entry]));
  const extractionProof = artifact.roflOnlyExtractionProof ?? {};
  const extractionProofBySurface = new Map((extractionProof.decodedFromRoflOnly ?? []).map((entry) => [entry.surface, entry]));
  const proofPositionCandidate = (extractionProof.notPromotedRuntimeCandidates ?? []).find((entry) => entry.surface === "position x/y movement tracks");
  const matchMetadataGaps = fieldCoverage.matchMetadataGaps ?? {};
  const matchParticipantGaps = fieldCoverage.matchParticipantGaps ?? {};
  const matchTeamGaps = fieldCoverage.matchTeamGaps ?? {};
  const matchMetadataGapFields = matchMetadataGaps.fields ?? [];
  const matchMetadataGapSources = matchMetadataGaps.inspectedSources ?? [];
  const matchMetadataAvailableMetadataJsonFields = matchMetadataGaps.availableMetadataJsonFields ?? [];
  const matchMetadataGapReason = matchMetadataGaps.reason ?? "";
  const coverageStatuses = Object.keys(artifact.coverageStatusLegend ?? {});
  const coverageRows = artifact.coverage ?? [];
  const coverageRowsComplete = coverageRows.length === 10 && coverageRows.every((row) =>
    row.participantId >= 1 &&
    row.participantId <= 10 &&
    Object.keys(row.metrics ?? {}).length >= 11 &&
    row.metricStatusCounts?.decoded === 5 &&
    (row.metricStatusCounts?.not_found ?? 0) >= 5 &&
    Object.values(row.metrics ?? {}).every((metric) => coverageStatuses.includes(metric.status)),
  );
  const nonFinalCoverageAnnotations = coverageRows.flatMap((row) =>
    Object.entries(row.metrics ?? {})
      .filter(([, metric]) => metric.nonFinalKeyframeCandidate != null)
      .map(([metric, entry]) => ({
        participantId: row.participantId,
        metric,
        status: entry.nonFinalKeyframeCandidate.status,
        targetDuplicateCount: entry.nonFinalKeyframeCandidate.targetDuplicateCount ?? null,
      })),
  );
  const duplicateRejectedCoverageAnnotations = nonFinalCoverageAnnotations.filter((entry) =>
    entry.status === "duplicate_rejected" && (entry.targetDuplicateCount ?? 0) > 1,
  );
  const finalFrame = artifact.frames?.at(-1) ?? null;
  const finalParticipantFrameCount = Object.keys(finalFrame?.participantFrames ?? {}).length;
  const timelineFrames = artifact.timeline?.info?.frames ?? [];
  const finalTimelineFrame = timelineFrames.at(-1) ?? null;
  const finalParticipantFrames = Object.values(finalTimelineFrame?.participantFrames ?? {});
  const finalParticipantFramesHaveApiContainers = finalParticipantFrames.every((frame) =>
    frame?.championStats != null &&
    frame?.damageStats != null &&
    Array.isArray(finalTimelineFrame?.events)
  );

  const checks = [
    {
      requirement: "Build a clean replay-derived output that mirrors Riot match/timeline API structures without Riot API runtime data.",
      ...pass(
        artifact.artifactSchema === "rofl-api-parity-checkpoint/v1" &&
          artifact.extractionMode === "rofl-only-final-stats" &&
          artifact.match?.metadata != null &&
          artifact.match?.info != null &&
          artifact.timeline?.metadata != null &&
          artifact.timeline?.info != null &&
          extractionProof.proofSchema === "rofl-only-extraction-proof/v1" &&
          extractionProof.runtimeInputPolicy?.riotApiRuntimeInput === false &&
          extractionProof.runtimeInputPolicy?.supervisedFixtureRole === "offline-validation-only" &&
          extractionProof.apiShapeProof?.matchShape?.missingLeafPathCount === 0 &&
          extractionProof.apiShapeProof?.timelineShape?.missingLeafPathCount === 70 &&
          extractionProof.apiShapeProof?.timelineShape?.runtimeEmission === "empty-events-arrays" &&
          extractionProof.apiShapeProof?.fullApiShapeParity === false &&
          JSON.stringify([...(extractionProof.remainingGapKeys ?? [])].sort()) === JSON.stringify([...remainingGapByKey.keys()].sort()) &&
          proofPositionCandidate?.runtimeApiData === false &&
          proofPositionCandidate?.assignedParticipantCount === 9 &&
          proofPositionCandidate?.noPriorsAssignedParticipantCount === 8 &&
          artifact.artifactManifest?.sourceReplay?.runtimeInput === true &&
          artifact.artifactManifest?.replayDerivedSummary?.runtimeInput === true &&
          artifact.artifactManifest?.primaryRuntimeArtifact?.runtimeInput === false &&
          (artifact.artifactManifest?.decoderDiagnostics ?? []).some((entry) => entry.role === "replay-only-no-priors-position-diagnostic" && entry.runtimeInput === false && entry.runtimeApiData === false) &&
          (artifact.artifactManifest?.decoderDiagnostics ?? []).some((entry) => entry.role === "replay-only-startup-roster-token-diagnostic" && entry.runtimeInput === false && entry.runtimeApiData === false) &&
          (artifact.artifactManifest?.decoderDiagnostics ?? []).some((entry) => entry.role === "offline-handle-graph-row-link-diagnostic" && entry.runtimeInput === false && entry.runtimeApiData === false) &&
          (artifact.artifactManifest?.decoderDiagnostics ?? []).some((entry) => entry.role === "offline-event-family-correlation-diagnostic" && entry.runtimeInput === false && entry.runtimeApiData === false) &&
          (artifact.artifactManifest?.offlineValidationReports ?? []).length >= 3 &&
          (artifact.artifactManifest?.offlineValidationReports ?? []).every((entry) => entry.runtimeInput === false) &&
          artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles === false &&
          sourceInputClasses.riotApiFixtures?.class === "offline-validation-only" &&
          runtimeRiotApiReferences.length === 0,
        [
          "artifactSchema=rofl-api-parity-checkpoint/v1",
          "extractionMode=rofl-only-final-stats",
          "match.metadata and match.info exist",
          "timeline.metadata and timeline.info exist",
          `roflOnlyExtractionProof=${extractionProof.proofSchema ?? null}`,
          `roflOnlyExtractionProof.riotApiRuntimeInput=${extractionProof.runtimeInputPolicy?.riotApiRuntimeInput ?? null}`,
          `roflOnlyExtractionProof.supervisedFixtureRole=${extractionProof.runtimeInputPolicy?.supervisedFixtureRole ?? null}`,
          `roflOnlyExtractionProof.apiShapeProof=${JSON.stringify(extractionProof.apiShapeProof ?? null)}`,
          `roflOnlyExtractionProof.remainingGapKeys=${(extractionProof.remainingGapKeys ?? []).join(",")}`,
          `roflOnlyExtractionProof.positionCandidate=${JSON.stringify(proofPositionCandidate ?? null)}`,
          `artifactManifest.sourceReplay.runtimeInput=${artifact.artifactManifest?.sourceReplay?.runtimeInput ?? null}`,
          `artifactManifest.decoderDiagnostics=${artifact.artifactManifest?.decoderDiagnostics?.length ?? null}`,
          `artifactManifest.offlineValidationReports=${artifact.artifactManifest?.offlineValidationReports?.length ?? null}`,
          "source.roflOnlyInputs.runtimeRiotApiFiles=false",
          "source.inputClasses.riotApiFixtures.class=offline-validation-only",
          `runtime Riot API path references=${runtimeRiotApiReferences.length}`,
        ],
        runtimeRiotApiReferences.map((match) => `runtime artifact references replays/api at ${match}`),
      ),
    },
    {
      requirement: "Include all 10 participants from ROFL metadata/statsJson.",
      ...pass(
        artifact.totals?.rosterParticipantCount === 10 &&
          (artifact.match?.info?.participants ?? []).length === 10 &&
          (artifact.timeline?.info?.participants ?? []).length === 10,
        [
          `totals.rosterParticipantCount=${artifact.totals?.rosterParticipantCount}`,
          `match.info.participants.length=${(artifact.match?.info?.participants ?? []).length}`,
          `timeline.info.participants.length=${(artifact.timeline?.info?.participants ?? []).length}`,
        ],
      ),
    },
    {
      requirement: "Emit API-shaped match data where decoded.",
      ...pass(
        artifact.match?.metadata?.matchId != null &&
          Array.isArray(artifact.match?.metadata?.participants) &&
          artifact.match.metadata.participants.length === 10 &&
          artifact.match?.info?.gameId != null &&
          artifact.match?.info?.platformId != null &&
          (artifact.match?.info?.participants ?? []).length === 10 &&
          (artifact.match?.info?.teams ?? []).length === 2 &&
          (artifact.matchCoverage ?? []).length === 10 &&
          (artifact.matchCoverage ?? []).every((row) => row.status === "decoded" && row.apiLikeStatCount >= 100) &&
          fieldCoverage.matchParticipantChallenges?.status === "partial" &&
          (fieldCoverage.matchParticipantChallenges?.decodedFields ?? []).includes("participants[].challenges.turretTakedowns") &&
          roflDerivedFieldMap.match?.["info.participants[].challenges.turretTakedowns"]?.source === "rofl-metadata-statsJson",
        [
          `match.metadata.matchId=${artifact.match?.metadata?.matchId ?? null}`,
          `match.metadata.participants.length=${artifact.match?.metadata?.participants?.length ?? null}`,
          `match.info.gameId=${artifact.match?.info?.gameId ?? null}`,
          `match.info.platformId=${artifact.match?.info?.platformId ?? null}`,
          `match.info.participants.length=${artifact.match?.info?.participants?.length ?? null}`,
          `match.info.teams.length=${artifact.match?.info?.teams?.length ?? null}`,
          `matchCoverage rows=${(artifact.matchCoverage ?? []).length}`,
          `min apiLikeStatCount=${Math.min(...(artifact.matchCoverage ?? []).map((row) => row.apiLikeStatCount ?? 0))}`,
          `fieldMap match.info.participants=${roflDerivedFieldMap.match?.["info.participants"]?.source ?? null}`,
          `fieldCoverage matchParticipantChallenges.status=${fieldCoverage.matchParticipantChallenges?.status ?? null}`,
          `fieldCoverage matchParticipantChallenges.decodedFields=${(fieldCoverage.matchParticipantChallenges?.decodedFields ?? []).join(",")}`,
          `fieldMap match.info.participants[].challenges.turretTakedowns=${roflDerivedFieldMap.match?.["info.participants[].challenges.turretTakedowns"]?.source ?? null}`,
          `fieldMap match.info.teams=${roflDerivedFieldMap.match?.["info.teams"]?.source ?? null}`,
        ],
      ),
    },
    {
      requirement: "Expose frames[].participantFrames with real ROFL-derived metrics.",
      ...pass(
        finalParticipantFrameCount === 10 &&
          timelineFrames.length > 0 &&
          finalParticipantFrames.length === 10 &&
          finalParticipantFramesHaveApiContainers &&
          artifact.totals?.roflOnlyFinalMetricSeriesCount === 50 &&
          artifact.totals?.emittedMetricPointCount === 50 &&
          extractionProofBySurface.get("timeline.info.frames[-1].participantFrames final scalar metrics")?.metricPointCount === 50 &&
          extractionProofBySurface.get("timeline.info.frames[-1].participantFrames final damageStats")?.metricPointCount === 120 &&
          (extractionProof.perParticipantProof ?? []).length === 10 &&
          (extractionProof.perParticipantProof ?? []).every((entry) =>
            entry.source === "rofl-metadata-statsJson" &&
            entry.participantIdentity === "rofl-summary-roster-order" &&
            entry.runtimeApiData === true &&
            entry.finalScalarMetricCount === 5 &&
            entry.finalDamageMetricCount === 12 &&
            (entry.unresolvedRuntimeFields ?? []).includes("position") &&
            (entry.unresolvedRuntimeFields ?? []).includes("currentGold") &&
            (entry.unresolvedRuntimeFields ?? []).includes("goldPerSecond") &&
            (entry.unresolvedRuntimeFields ?? []).includes("timeEnemySpentControlled") &&
            (entry.unresolvedRuntimeFields ?? []).includes("championStats")
          ),
        [
          `final frame participantFrames=${finalParticipantFrameCount}`,
          `timeline.info.frames.length=${timelineFrames.length}`,
          `timeline final participantFrames=${finalParticipantFrames.length}`,
          `timeline final events array=${Array.isArray(finalTimelineFrame?.events)}`,
          `participantFrames include championStats/damageStats=${finalParticipantFramesHaveApiContainers}`,
          `roflOnlyFinalMetricSeriesCount=${artifact.totals?.roflOnlyFinalMetricSeriesCount}`,
          `emittedMetricPointCount=${artifact.totals?.emittedMetricPointCount}`,
          `roflOnlyExtractionProof.finalScalarMetricPointCount=${extractionProofBySurface.get("timeline.info.frames[-1].participantFrames final scalar metrics")?.metricPointCount ?? null}`,
          `roflOnlyExtractionProof.finalDamageMetricPointCount=${extractionProofBySurface.get("timeline.info.frames[-1].participantFrames final damageStats")?.metricPointCount ?? null}`,
          `roflOnlyExtractionProof.perParticipantProof=${extractionProof.perParticipantProof?.length ?? null}`,
          `fieldMap timeline currentGold=${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].currentGold"]?.status ?? null}:${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].currentGold"]?.calibration ?? null}`,
          `fieldMap timeline events=${roflDerivedFieldMap.timeline?.["info.frames[].events"]?.status ?? null}`,
          "final frame provenance uses rofl-metadata-statsJson/direct-final-stat",
        ],
      ),
    },
    {
      requirement: "Add explicit per-participant/per-metric coverage statuses.",
      ...pass(
        coverageRowsComplete &&
          ["decoded", "noisy", "unstable_identity", "duplicate_rejected", "not_found"].every((status) => coverageStatuses.includes(status)) &&
          nonFinalCoverageAnnotations.length > 0 &&
          duplicateRejectedCoverageAnnotations.length > 0,
        [
          `coverage rows=${coverageRows.length}`,
          `coverage rows complete=${coverageRowsComplete}`,
          `coverage metrics per participant=${coverageRows.map((row) => Object.keys(row.metrics ?? {}).length).join(",")}`,
          `coverage decoded counts=${coverageRows.map((row) => row.metricStatusCounts?.decoded ?? 0).join(",")}`,
          `coverage not_found counts=${coverageRows.map((row) => row.metricStatusCounts?.not_found ?? 0).join(",")}`,
          `coverageStatusLegend=${coverageStatuses.join(",")}`,
          `coverageSummary=${JSON.stringify(artifact.totals?.coverageSummary ?? {})}`,
          `nonFinalKeyframeCandidate annotations=${nonFinalCoverageAnnotations.length}`,
          `duplicate_rejected non-final annotations=${duplicateRejectedCoverageAnnotations.length}`,
        ],
      ),
    },
    {
      requirement: "Improve replay-only participant identity linkage using ROFL-only evidence.",
      status: "partial",
      evidence: [
        "final frame identity uses rofl-summary-roster-order",
        `identityLinkage.finalRosterIdentity.status=${identityLinkage.finalRosterIdentity?.status ?? null}`,
        `identityLinkage.finalRosterIdentity.participantCount=${identityLinkage.finalRosterIdentity?.participantCount ?? null}`,
        `identityLinkage.roflMetadataParticipantIdentifiers.status=${identityLinkage.roflMetadataParticipantIdentifiers?.status ?? null}`,
        `identityLinkage.roflMetadataParticipantIdentifiers.apiFieldCompatibility=${identityLinkage.roflMetadataParticipantIdentifiers?.apiFieldCompatibility ?? null}`,
        `identityLinkage.riotApiIdentifierParity.status=${identityLinkage.riotApiIdentifierParity?.status ?? null}`,
        `identityLinkage.evidenceMatrix=${JSON.stringify(identityEvidenceMatrix.map((entry) => [entry.evidenceClass, entry.status, entry.promotion, entry.runtimeApiData]))}`,
        `metricSet=${nonFinalIdentity?.assignmentArtifact?.metricSet ?? null}`,
        `identity corpus path=${identityCorpusPath}`,
        `identity corpus analyzedReplayCount=${identityCorpus?.analyzedReplayCount ?? null}`,
        `identity corpus assignmentCount=${identityCorpus?.totals?.assignmentCount ?? null}`,
        `identity corpus canonicalCandidateCount=${identityCorpus?.totals?.confidence?.canonicalCandidateCount ?? null}`,
        `identity corpus rejectionSummary.status=${identityCorpus?.totals?.rejectionSummary?.status ?? null}`,
        `identity corpus rejectionSummary.primaryBlockers=${(identityCorpus?.totals?.rejectionSummary?.primaryBlockers ?? []).join(",")}`,
        `identity corpus rejectionSummary.metrics=${Object.keys(identityCorpus?.totals?.rejectionSummary?.byMetric ?? {}).join(",")}`,
        `startup roster token scan status=${nonFinalIdentity?.startupRosterTokenScan?.status ?? null}`,
        `startup roster token scan replay count=${nonFinalIdentity?.startupRosterTokenScan?.scannedReplayCount ?? null}`,
        `startup roster token scan full-corpus roster/order candidates=${nonFinalIdentity?.startupRosterTokenScan?.fullCorpusRosterOrderCandidateCount ?? null}`,
        `startup roster token scan top candidates=${JSON.stringify((nonFinalIdentity?.startupRosterTokenScan?.topReplayOnlyCandidates ?? []).slice(0, 3))}`,
        `handle graph row-link status=${nonFinalIdentity?.handleGraphRowLinkCandidates?.status ?? null}`,
        `handle graph row-link candidate count=${nonFinalIdentity?.handleGraphRowLinkCandidates?.candidateCount ?? null}`,
        `handle graph row-link confidence counts=${JSON.stringify(nonFinalIdentity?.handleGraphRowLinkCandidates?.confidenceCounts ?? {})}`,
        `handle graph row-link top=${nonFinalIdentity?.handleGraphRowLinkCandidates?.topConfidence ?? null}:${nonFinalIdentity?.handleGraphRowLinkCandidates?.topScore ?? null}`,
        `identity threshold sweep path=${identityThresholdSweepPath}`,
        `identity threshold sweep schema=${identityThresholdSweep?.sweepSchema ?? null}`,
        `identity threshold sweep rows=${(identityThresholdSweep?.rows ?? []).length}`,
        `identity threshold sweep assignments=${JSON.stringify((identityThresholdSweep?.rows ?? []).map((row) => [row.minSupportScore, row.assignmentCount]))}`,
        `identity negative controls=${JSON.stringify((identityThresholdSweep?.negativeControlRows ?? []).map((row) => [row.name, row.assignmentCount, row.comparisonCounts]))}`,
        `canonicalCandidateCount=${nonFinalIdentity?.assignmentArtifact?.canonicalCandidateCount ?? null}`,
        `supportBelowMetricScoreCount=${nonFinalIdentity?.assignmentArtifact?.diagnostics?.supportBelowMetricScoreCount ?? null}`,
        `supportBelowMetricScoreCountsByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.supportBelowMetricScoreCountsByMetric ?? {})}`,
        `ambiguousFinalTargetSupportCountsByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.ambiguousFinalTargetSupportCountsByMetric ?? {})}`,
        `ambiguousFinalTargetRejectedSupportCountsByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.ambiguousFinalTargetRejectedSupportCountsByMetric ?? {})}`,
        `duplicateFinalTargetValueCountsByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.duplicateFinalTargetValueCountsByMetric ?? {})}`,
        `duplicateFinalTargetExamplesByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.duplicateFinalTargetExamplesByMetric ?? {})}`,
        `topWeakSupportExamplesByMetric=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.diagnostics?.topWeakSupportExamplesByMetric ?? {})}`,
        `metricSupportQuality=${JSON.stringify(nonFinalIdentity?.assignmentArtifact?.metricSupportQuality ?? {})}`,
        `nextDecoderTargets=${JSON.stringify(identityLinkage.nonFinalScalarIdentity?.nextDecoderTargets ?? [])}`,
        `241-0x02 table promotion=${reconstructionTargetTable02?.promotionAssessment?.status ?? null}`,
        `241-0x02 row coherence=${reconstructionTargetTable02?.coherenceScores?.sameRowWinRate ?? null}`,
        `241-0x02 row identity gate=${reconstructionRowIdentity02?.promotionAssessment?.status ?? null}`,
        `241-0x02 duplicate rejected rows=${reconstructionRowIdentity02?.evidence?.duplicateRejectedRowCount ?? null}`,
        `241-0x04 table promotion=${reconstructionTargetTable04?.promotionAssessment?.status ?? null}`,
        `241-0x04 row coherence=${reconstructionTargetTable04?.coherenceScores?.sameRowWinRate ?? null}`,
        `241-0x04 row identity gate=${reconstructionRowIdentity04?.promotionAssessment?.status ?? null}`,
        `241-0x04 duplicate rejected rows=${reconstructionRowIdentity04?.evidence?.duplicateRejectedRowCount ?? null}`,
        `row grid candidate scan=${reconstructionRowGridCandidates?.status ?? null}`,
        `row grid top candidate=${reconstructionRowGridCandidates?.topCandidates?.[0]?.familyKey ?? null}:${reconstructionRowGridCandidates?.topCandidates?.[0]?.status ?? null}:${reconstructionRowGridCandidates?.topCandidates?.[0]?.score ?? null}`,
        `row grid field analysis=${reconstructionRowGridFieldAnalysis?.status ?? null}`,
        `row grid field top candidate=${reconstructionRowGridFieldAnalysis?.candidates?.[0]?.familyKey ?? null}:${reconstructionRowGridFieldAnalysis?.candidates?.[0]?.fieldPromotionAssessment?.status ?? null}`,
        `runtime reconstruction row identity status=${runtimeReconstructionRowIdentity.status ?? null}`,
        `runtime reconstruction row identity artifacts=${(runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).map((entry) => `${entry.familyKey}:${entry.promotionStatus}:${JSON.stringify(entry.rowStatusCounts ?? {})}`).join(";")}`,
      ],
      gaps: [
        "accepted replay-only non-final keyframe participant identity is not available yet",
        ...((reconstructionTargetTable02?.promotionAssessment?.status === "not_promoted" &&
          reconstructionTargetTable04?.promotionAssessment?.status === "not_promoted" &&
          reconstructionRowIdentity02?.promotionAssessment?.status === "not_promoted" &&
          reconstructionRowIdentity04?.promotionAssessment?.status === "not_promoted") ? [
          "241-row table targets are structurally plausible but not promotable for participant identity yet",
        ] : []),
        ...(identityThresholdSweep?.sweepSchema === "rofl-keyframe-stat-support-threshold-sweep/v1" ? [] : ["identity threshold sweep schema missing or unsupported"]),
        ...((identityThresholdSweep?.negativeControlRows ?? []).some((row) => row.name === "unsafe-single-metric" && (row.assignmentCount ?? 0) > 0 && (row.comparisonCounts?.conflict ?? 0) > 0) ? [] : ["identity threshold sweep missing unsafe single-metric negative control conflicts"]),
        ...(nonFinalIdentity?.startupRosterTokenScan?.status === "diagnostic_only_not_runtime_api_data" &&
          nonFinalIdentity?.startupRosterTokenScan?.runtimeApiData === false &&
          nonFinalIdentity?.startupRosterTokenScan?.scannedReplayCount === 20 &&
          (nonFinalIdentity?.startupRosterTokenScan?.fullCorpusRosterOrderCandidateCount ?? 0) > 0
          ? []
          : ["startup roster token diagnostic missing or not marked as non-runtime evidence"]),
        ...(nonFinalIdentity?.handleGraphRowLinkCandidates?.status === "not_promoted" &&
          nonFinalIdentity?.handleGraphRowLinkCandidates?.runtimeApiData === false &&
          nonFinalIdentity?.handleGraphRowLinkCandidates?.candidateCount > 0 &&
          nonFinalIdentity?.handleGraphRowLinkCandidates?.topConfidence === "weak"
          ? []
          : ["handle graph row-link diagnostic missing or not rejected as weak evidence"]),
        ...(["ROFL metadata/statsJson roster", "roster order", "team/champion metadata", "cross-metric final stats consistency", "startup roster/order tokens", "keyframe row identity gates", "handle graph row links"].every((evidenceClass) =>
          identityEvidenceMatrix.some((entry) => entry.evidenceClass === evidenceClass && (entry.evidenceRefs ?? []).length > 0)
        ) ? [] : ["identityLinkage evidence matrix missing one or more replay-only evidence classes"]),
      ],
    },
    {
      requirement: "Filter noisy candidates with metric-specific gates and avoid exposing low-confidence affine artifacts.",
      ...pass(
        (artifact.totals?.researchKeyframeMetricSeriesCount ?? 0) === 0 &&
          nonFinalIdentity?.assignmentArtifact?.thresholds?.minSupportScore != null &&
          nonFinalIdentity?.assignmentArtifact?.canonicalCandidateCount === 0 &&
          rejectedCandidates.positions != null &&
          rejectedCandidates.positions?.participantMovementArtifact?.assignmentCount === 9 &&
          rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipantCount === 1 &&
          rejectedCandidates.positions?.participantMovementArtifact?.usesIdentityPriors === true &&
          rejectedCandidates.positions?.offlineValidation?.passingAssignmentCount === 7 &&
          rejectedCandidates.positions?.offlineValidation?.runtimeInput === false &&
          (rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("9/10")) &&
          (rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("identity priors")) &&
          (rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("7/9")) &&
          (rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("no-priors") && blocker.includes("8/10")) &&
          rejectedCandidates.positions?.qualityGateSummary?.assignedParticipantCount === 9 &&
          rejectedCandidates.positions?.qualityGateSummary?.expectedParticipantCount === 10 &&
          rejectedCandidates.positions?.qualityGateSummary?.offlinePassingAssignmentCount === 7 &&
          rejectedCandidates.positions?.qualityGateSummary?.noPriorsAssignedParticipantCount === 8 &&
          rejectedCandidates.positions?.qualityGateSummary?.noPriorsOfflinePassingAssignmentCount === 7 &&
          proofPositionCandidate?.runtimeApiData === false &&
          proofPositionCandidate?.assignedParticipantCount === 9 &&
          proofPositionCandidate?.expectedParticipantCount === 10 &&
          proofPositionCandidate?.offlinePassingAssignmentCount === 7 &&
          proofPositionCandidate?.noPriorsAssignedParticipantCount === 8 &&
          proofPositionCandidate?.noPriorsOfflinePassingAssignmentCount === 7 &&
          rejectedCandidates.positions?.qualityGateSummary?.runtimeInput === false &&
          rejectedCandidates.positions?.noPriorsDiagnostic?.status === "diagnostic_only_not_runtime_api_data" &&
          rejectedCandidates.positions?.noPriorsDiagnostic?.runtimeInput === false &&
          rejectedCandidates.positions?.noPriorsDiagnostic?.usesIdentityPriors === false &&
          (rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).length === 2 &&
          (rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Vayne" && participant.teamPosition === "TOP") &&
          (rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Malphite" && participant.teamPosition === "TOP") &&
          (rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipants ?? []).length === 1 &&
          (rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipants?.[0]?.topRejectedEntityCandidates ?? []).length > 0 &&
          (rejectedCandidates.positions?.participantMovementArtifact?.unassignedEntities ?? []).length === 2 &&
          (rejectedCandidates.positions?.perParticipantCoverage ?? []).length === 10 &&
          (rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "not_found") &&
          (rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) =>
            entry.status === "not_found" && (entry.topRejectedEntityCandidates ?? []).some((candidate) => candidate.assignedToOtherParticipant === true)
          ) &&
          (rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "noisy") &&
          (rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "unstable_identity") &&
          rejectedCandidates.itemEvents != null &&
          rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount === 689 &&
          rejectedCandidates.itemEvents?.candidateArtifact?.strongCandidateCount === 93 &&
          rejectedCandidates.itemEvents?.eventInventory?.globalEventCount === 472 &&
          rejectedCandidates.itemEvents?.offlineValidation?.runtimeInput === false &&
          rejectedCandidates.inventoryTimeline != null &&
          rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.itemEventCandidateCount === 689 &&
          rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.eventTypeCounts?.ITEM_DESTROYED === 209 &&
          rejectedCandidates.inventoryTimeline?.runtimeInput === false &&
          rejectedCandidates.championStatsFinal != null &&
          rejectedCandidates.damageTimeline != null,
        [
          `researchKeyframeMetricSeriesCount=${artifact.totals?.researchKeyframeMetricSeriesCount ?? 0}`,
          `minSupportScore=${nonFinalIdentity?.assignmentArtifact?.thresholds?.minSupportScore ?? null}`,
          `canonicalCandidateCount=${nonFinalIdentity?.assignmentArtifact?.canonicalCandidateCount ?? null}`,
          `positions.status=${rejectedCandidates.positions?.status ?? null}`,
          `positions.assignmentCount=${rejectedCandidates.positions?.participantMovementArtifact?.assignmentCount ?? null}`,
          `positions.unmatchedParticipantCount=${rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipantCount ?? null}`,
          `positions.usesIdentityPriors=${rejectedCandidates.positions?.participantMovementArtifact?.usesIdentityPriors ?? null}`,
          `positions.offlinePassingAssignments=${rejectedCandidates.positions?.offlineValidation?.passingAssignmentCount ?? null}`,
          `positions.offlineValidation.runtimeInput=${rejectedCandidates.positions?.offlineValidation?.runtimeInput ?? null}`,
          `positions.noPriorsDiagnostic=${JSON.stringify(rejectedCandidates.positions?.noPriorsDiagnostic ?? {})}`,
          `roflOnlyExtractionProof.positionCandidate=${JSON.stringify(proofPositionCandidate ?? null)}`,
          `positions.promotionBlockers=${JSON.stringify(rejectedCandidates.positions?.promotionBlockers ?? [])}`,
          `positions.qualityGateSummary=${JSON.stringify(rejectedCandidates.positions?.qualityGateSummary ?? {})}`,
          `positions.unmatchedNearMissCandidates=${rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipants?.[0]?.topRejectedEntityCandidates?.length ?? null}`,
          `positions.unassignedEntityNearMissCandidates=${(rejectedCandidates.positions?.participantMovementArtifact?.unassignedEntities ?? []).map((entity) => entity.topRejectedParticipantCandidates?.length ?? 0).join(",")}`,
          `positions.perParticipantCoverage=${rejectedCandidates.positions?.perParticipantCoverage?.length ?? null}`,
          `positions.perParticipantStatuses=${JSON.stringify(Object.fromEntries(Object.entries((rejectedCandidates.positions?.perParticipantCoverage ?? []).reduce((counts, entry) => {
            counts[entry.status] = (counts[entry.status] ?? 0) + 1;
            return counts;
          }, {})).sort(([left], [right]) => left.localeCompare(right))))}`,
          `itemEvents.status=${rejectedCandidates.itemEvents?.status ?? null}`,
          `itemEvents.candidateCount=${rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount ?? null}`,
          `itemEvents.strongCandidateCount=${rejectedCandidates.itemEvents?.candidateArtifact?.strongCandidateCount ?? null}`,
          `itemEvents.globalEventCount=${rejectedCandidates.itemEvents?.eventInventory?.globalEventCount ?? null}`,
          `inventoryTimeline.status=${rejectedCandidates.inventoryTimeline?.status ?? null}`,
          `inventoryTimeline.itemEventCandidateCount=${rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.itemEventCandidateCount ?? null}`,
          `inventoryTimeline.itemDestroyedCount=${rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.eventTypeCounts?.ITEM_DESTROYED ?? null}`,
          `championStatsFinal.status=${rejectedCandidates.championStatsFinal?.status ?? null}`,
          `damageTimeline.status=${rejectedCandidates.damageTimeline?.status ?? null}`,
        ],
        [
          ...(!rejectedCandidates.positions ? ["missing position rejection evidence"] : []),
          ...(rejectedCandidates.positions?.participantMovementArtifact?.assignmentCount !== 9 ? ["position rejection evidence missing 9/10 assignment blocker"] : []),
          ...(rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipantCount !== 1 ? ["position rejection evidence missing unmatched participant blocker"] : []),
          ...(rejectedCandidates.positions?.participantMovementArtifact?.usesIdentityPriors !== true ? ["position rejection evidence missing identity-prior blocker"] : []),
          ...(rejectedCandidates.positions?.offlineValidation?.passingAssignmentCount !== 7 ? ["position rejection evidence missing failed validation assignment blocker"] : []),
          ...(rejectedCandidates.positions?.offlineValidation?.runtimeInput !== false ? ["position offline validation must be non-runtime"] : []),
          ...(!(rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("9/10")) ? ["position promotion blockers missing 9/10 assignment evidence"] : []),
          ...(!(rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("identity priors")) ? ["position promotion blockers missing identity-prior evidence"] : []),
          ...(!(rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("7/9")) ? ["position promotion blockers missing 7/9 offline-quality evidence"] : []),
          ...(!(rejectedCandidates.positions?.promotionBlockers ?? []).some((blocker) => blocker.includes("no-priors") && blocker.includes("8/10")) ? ["position promotion blockers missing no-priors replay-only assignment evidence"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.assignedParticipantCount !== 9 ? ["position quality gate missing assigned participant count"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.expectedParticipantCount !== 10 ? ["position quality gate missing expected participant count"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.offlinePassingAssignmentCount !== 7 ? ["position quality gate missing offline passing assignment count"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.noPriorsAssignedParticipantCount !== 8 ? ["position quality gate missing no-priors assigned participant count"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.noPriorsOfflinePassingAssignmentCount !== 7 ? ["position quality gate missing no-priors offline passing count"] : []),
          ...(proofPositionCandidate?.runtimeApiData !== false ? ["roflOnlyExtractionProof position candidate must be non-runtime API data"] : []),
          ...(proofPositionCandidate?.assignedParticipantCount !== 9 ? ["roflOnlyExtractionProof position candidate missing 9 assigned participants"] : []),
          ...(proofPositionCandidate?.expectedParticipantCount !== 10 ? ["roflOnlyExtractionProof position candidate missing expected participant count"] : []),
          ...(proofPositionCandidate?.offlinePassingAssignmentCount !== 7 ? ["roflOnlyExtractionProof position candidate missing 7 offline passing assignments"] : []),
          ...(proofPositionCandidate?.noPriorsAssignedParticipantCount !== 8 ? ["roflOnlyExtractionProof position candidate missing no-priors assigned count"] : []),
          ...(proofPositionCandidate?.noPriorsOfflinePassingAssignmentCount !== 7 ? ["roflOnlyExtractionProof position candidate missing no-priors passing count"] : []),
          ...(rejectedCandidates.positions?.qualityGateSummary?.runtimeInput !== false ? ["position quality gate must be non-runtime"] : []),
          ...(rejectedCandidates.positions?.noPriorsDiagnostic?.status !== "diagnostic_only_not_runtime_api_data" ? ["position evidence missing no-priors diagnostic status"] : []),
          ...(rejectedCandidates.positions?.noPriorsDiagnostic?.runtimeInput !== false ? ["position no-priors diagnostic must be non-runtime"] : []),
          ...(rejectedCandidates.positions?.noPriorsDiagnostic?.usesIdentityPriors !== false ? ["position no-priors diagnostic must disable identity priors"] : []),
          ...((rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).length !== 2 ? ["position no-priors diagnostic missing two unmatched participants"] : []),
          ...(!(rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Vayne" && participant.teamPosition === "TOP") ? ["position no-priors diagnostic missing Vayne TOP unmatched participant"] : []),
          ...(!(rejectedCandidates.positions?.noPriorsDiagnostic?.unmatchedParticipants ?? []).some((participant) => participant.champion === "Malphite" && participant.teamPosition === "TOP") ? ["position no-priors diagnostic missing Malphite TOP unmatched participant"] : []),
          ...((rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipants ?? []).length !== 1 ? ["position artifact missing unmatched participant near-miss summary"] : []),
          ...((rejectedCandidates.positions?.participantMovementArtifact?.unmatchedParticipants?.[0]?.topRejectedEntityCandidates ?? []).length === 0 ? ["position artifact missing unmatched participant rejected entity candidates"] : []),
          ...((rejectedCandidates.positions?.participantMovementArtifact?.unassignedEntities ?? []).length !== 2 ? ["position artifact missing unassigned entity near-miss summaries"] : []),
          ...((rejectedCandidates.positions?.perParticipantCoverage ?? []).length !== 10 ? ["position rejection evidence missing per-participant coverage"] : []),
          ...(!(rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "not_found") ? ["position rejection evidence missing not_found participant"] : []),
          ...(!(rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) =>
            entry.status === "not_found" && (entry.topRejectedEntityCandidates ?? []).some((candidate) => candidate.assignedToOtherParticipant === true)
          ) ? ["position per-participant coverage missing unmatched near-miss reason"] : []),
          ...(!(rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "noisy") ? ["position rejection evidence missing noisy participant"] : []),
          ...(!(rejectedCandidates.positions?.perParticipantCoverage ?? []).some((entry) => entry.status === "unstable_identity") ? ["position rejection evidence missing unstable_identity participant"] : []),
          ...(!rejectedCandidates.itemEvents ? ["missing item-event rejection evidence"] : []),
          ...(rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount !== 689 ? ["item-event rejection evidence missing focused replay candidate count"] : []),
          ...(rejectedCandidates.itemEvents?.candidateArtifact?.strongCandidateCount !== 93 ? ["item-event rejection evidence missing focused replay strong candidate count"] : []),
          ...(rejectedCandidates.itemEvents?.eventInventory?.globalEventCount !== 472 ? ["item-event rejection evidence missing offline event inventory count"] : []),
          ...(rejectedCandidates.itemEvents?.offlineValidation?.runtimeInput !== false ? ["item-event offline validation must be non-runtime"] : []),
          ...(!rejectedCandidates.inventoryTimeline ? ["missing inventory timeline rejection evidence"] : []),
          ...(rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.itemEventCandidateCount !== 689 ? ["inventory timeline rejection missing item-event candidate count"] : []),
          ...(rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact?.eventTypeCounts?.ITEM_DESTROYED !== 209 ? ["inventory timeline rejection missing item-destroyed event count"] : []),
          ...(rejectedCandidates.inventoryTimeline?.runtimeInput !== false ? ["inventory timeline rejection must be non-runtime"] : []),
          ...(!rejectedCandidates.championStatsFinal ? ["missing final championStats rejection evidence"] : []),
          ...(!rejectedCandidates.damageTimeline ? ["missing damage timeline rejection evidence"] : []),
        ],
      ),
    },
    {
      requirement: "Keep supervised Riot API fixtures only for offline validation.",
      ...pass(
        fieldCoverage.offlineRiotValidation?.runtimeInput === false &&
          sourceInputClasses.riotApiFixtures?.requiredForRuntime === false &&
          sourceInputClasses.riotApiFixtures?.runtimePromotionAllowed === false &&
          (extractionProof.offlineValidationOnly ?? []).length >= 3 &&
          (extractionProof.offlineValidationOnly ?? []).every((entry) => entry.runtimeInput === false) &&
          validation?.validationSchema === "rofl-api-metrics-riot-validation/v1" &&
          validation?.mode === "offline-validation-only" &&
          validation?.replayId === artifact.source?.replayId &&
          validation?.inputPath === inputPath &&
          validation?.validatedArtifact?.runtimeRiotApiFiles === false &&
          validation?.validatedArtifact?.decoderArtifactSupervised === false &&
          (validation?.totals?.identifierComparisonCount ?? 0) >= 22 &&
          validation?.totals?.identifierPassCount === 0 &&
          (validation?.totals?.finalTimelineComparisonCount ?? 0) >= 170 &&
          validation?.totals?.finalTimelinePassCount === validation?.totals?.finalTimelineComparisonCount &&
          shapeGap?.shapeGapSchema === "rofl-api-shape-gap-report/v1" &&
          shapeGap?.mode === "offline-validation-only" &&
          shapeGap?.runtimeInput === false &&
          challengeGap?.challengeGapCandidateSchema === "rofl-challenge-gap-candidates/v1" &&
          challengeGap?.mode === "offline-analysis-only" &&
          challengeGap?.runtimeInput === false &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "timeline-events")) &&
          !(shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "participant-challenges")) &&
          (fieldCoverage.matchParticipantChallenges?.apiShapedNotFoundFields ?? []).length >= 120 &&
          !(shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-event-flags")) &&
          !(shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-account-profile")) &&
          !(shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "team-bans")) &&
          (matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].firstBloodKill") &&
          (matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].profileIcon") &&
          (matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].championId") &&
          (matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].championId") &&
          (matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].pickTurn") &&
          (challengeGap?.totals?.exactValueParityPassCount ?? 0) > 0 &&
          (challengeGap?.totals?.rejectedExactValueMismatchCount ?? 0) > 0 &&
          (challengeGap?.totals?.corpusReplayCount ?? 0) >= 20 &&
          (challengeGap?.totals?.fuzzyAllZeroOnlyCount ?? 0) > 0 &&
          (challengeGap?.totals?.fuzzyValidatedNonZeroCount ?? 0) === 0 &&
          (challengeGap?.candidates ?? []).some((entry) => entry.challengeKey === "turretTakedowns" && entry.promotionStatus === "promoted_validated_exact") &&
          (challengeGap?.candidates ?? []).some((entry) => entry.challengeKey === "turretTakedowns" && entry.corpusSupport?.supportedStatKeys?.[0]?.evidenceStrength === "validated_nonzero") &&
          (challengeGap?.candidates ?? []).some((entry) => entry.challengeKey === "killingSprees" && entry.promotionStatus === "rejected_value_mismatch") &&
          (challengeGap?.candidates ?? []).some((entry) => entry.challengeKey === "snowballsHit" && (entry.corpusSupport?.supportedStatKeys ?? []).some((candidate) => candidate.statKey === "Missions_SnowballsHit" && candidate.evidenceStrength === "all_zero_only")),
        [
          "fieldCoverage.offlineRiotValidation.runtimeInput=false",
          `roflOnlyExtractionProof.offlineValidationOnly=${(extractionProof.offlineValidationOnly ?? []).length}`,
          "source.inputClasses.riotApiFixtures.requiredForRuntime=false",
          "source.inputClasses.riotApiFixtures.runtimePromotionAllowed=false",
          `validationPath=${validationPath}`,
          `validation.validationSchema=${validation?.validationSchema ?? null}`,
          `validation.mode=${validation?.mode ?? null}`,
          `validation.replayId=${validation?.replayId ?? null}`,
          `validation.inputPath=${validation?.inputPath ?? null}`,
          `validation.validatedArtifact.runtimeRiotApiFiles=${validation?.validatedArtifact?.runtimeRiotApiFiles ?? null}`,
          `validation.validatedArtifact.decoderArtifactSupervised=${validation?.validatedArtifact?.decoderArtifactSupervised ?? null}`,
          `validation participant parity=${validation?.totals?.passCount ?? null}/${validation?.totals?.comparisonCount ?? null}`,
          `validation team parity=${validation?.totals?.teamPassCount ?? null}/${validation?.totals?.teamComparisonCount ?? null}`,
          `validation final timeline parity=${validation?.totals?.finalTimelinePassCount ?? null}/${validation?.totals?.finalTimelineComparisonCount ?? null}`,
          `validation metadata parity=${validation?.totals?.metadataPassCount ?? null}/${validation?.totals?.metadataComparisonCount ?? null}`,
          `validation identifier parity=${validation?.totals?.identifierPassCount ?? null}/${validation?.totals?.identifierComparisonCount ?? null} non-blocking`,
          `shapeGapPath=${shapeGapPath}`,
          `shapeGap.shapeGapSchema=${shapeGap?.shapeGapSchema ?? null}`,
          `shapeGap.mode=${shapeGap?.mode ?? null}`,
          `shapeGap.runtimeInput=${shapeGap?.runtimeInput ?? null}`,
          `shapeGap matched=${shapeGap?.totals?.matchedLeafPathCount ?? null}/${shapeGap?.totals?.riotLeafPathCount ?? null}`,
          `shapeGap missing=${shapeGap?.totals?.missingLeafPathCount ?? null}`,
          `shapeGap missingCategories=${JSON.stringify((shapeGap?.sections ?? []).map((section) => [section.section, (section.missingCategories ?? []).map((entry) => [entry.category, entry.missingLeafPathCount])]))}`,
          `matchParticipantGaps.apiShapedNotFoundFields=${JSON.stringify(matchParticipantGaps.apiShapedNotFoundFields ?? [])}`,
          `challengeGapPath=${challengeGapPath}`,
          `challengeGap.challengeGapCandidateSchema=${challengeGap?.challengeGapCandidateSchema ?? null}`,
          `challengeGap.mode=${challengeGap?.mode ?? null}`,
          `challengeGap.runtimeInput=${challengeGap?.runtimeInput ?? null}`,
          `challengeGap exact=${challengeGap?.totals?.exactNormalizedCount ?? null}`,
          `challengeGap exactValueParityPass=${challengeGap?.totals?.exactValueParityPassCount ?? null}`,
          `challengeGap rejectedExactValueMismatch=${challengeGap?.totals?.rejectedExactValueMismatchCount ?? null}`,
          `challengeGap corpusReplayCount=${challengeGap?.totals?.corpusReplayCount ?? null}`,
          `challengeGap fuzzyAllZeroOnly=${challengeGap?.totals?.fuzzyAllZeroOnlyCount ?? null}`,
          `challengeGap fuzzyValidatedNonZero=${challengeGap?.totals?.fuzzyValidatedNonZeroCount ?? null}`,
          `challengeGap fuzzy=${challengeGap?.totals?.fuzzyCandidateCount ?? null}`,
          `challengeGap missing=${challengeGap?.totals?.notFoundCount ?? null}`,
          `challengeGap turretTakedowns promotion=${(challengeGap?.candidates ?? []).find((entry) => entry.challengeKey === "turretTakedowns")?.promotionStatus ?? null}`,
          `challengeGap turretTakedowns corpusEvidence=${(challengeGap?.candidates ?? []).find((entry) => entry.challengeKey === "turretTakedowns")?.corpusSupport?.supportedStatKeys?.[0]?.evidenceStrength ?? null}`,
          `challengeGap killingSprees promotion=${(challengeGap?.candidates ?? []).find((entry) => entry.challengeKey === "killingSprees")?.promotionStatus ?? null}`,
          `challengeGap snowballsHit corpusEvidence=${(challengeGap?.candidates ?? []).find((entry) => entry.challengeKey === "snowballsHit")?.corpusSupport?.supportedStatKeys?.find((candidate) => candidate.statKey === "Missions_SnowballsHit")?.evidenceStrength ?? null}`,
        ],
        [
          ...(!validation ? ["offline validation report missing"] : []),
          ...((extractionProof.offlineValidationOnly ?? []).length < 3 ? ["roflOnlyExtractionProof missing offline validation reports"] : []),
          ...(!(extractionProof.offlineValidationOnly ?? []).every((entry) => entry.runtimeInput === false) ? ["roflOnlyExtractionProof offline validation entries must be non-runtime"] : []),
          ...(!shapeGap ? ["offline shape gap report missing"] : []),
          ...(!challengeGap ? ["offline challenge gap report missing"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "timeline-events")) ? ["shape gap report missing timeline-events category"] : []),
          ...(shapeGap && (shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "participant-challenges")) ? ["shape gap report still has participant-challenges after API-shaped null placeholders"] : []),
          ...((fieldCoverage.matchParticipantChallenges?.apiShapedNotFoundFields ?? []).length < 120 ? ["fieldCoverage.matchParticipantChallenges missing API-shaped challenge not_found markers"] : []),
          ...(shapeGap && (shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-event-flags")) ? ["shape gap report still has match-participant-event-flags after API-shaped null placeholders"] : []),
          ...(shapeGap && (shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-account-profile")) ? ["shape gap report still has match-participant-account-profile after API-shaped null placeholders"] : []),
          ...(!(matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].firstBloodKill") ? ["fieldCoverage.matchParticipantGaps missing API-shaped firstBloodKill not_found marker"] : []),
          ...(!(matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].profileIcon") ? ["fieldCoverage.matchParticipantGaps missing API-shaped profileIcon not_found marker"] : []),
          ...(!(matchParticipantGaps.apiShapedNotFoundFields ?? []).includes("info.participants[].championId") ? ["fieldCoverage.matchParticipantGaps missing API-shaped championId not_promoted marker"] : []),
          ...(shapeGap && (shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "team-bans")) ? ["shape gap report still has team-bans category after API-shaped null placeholders"] : []),
          ...(!(matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].championId") ? ["fieldCoverage.matchTeamGaps missing API-shaped ban championId not_found marker"] : []),
          ...(!(matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].pickTurn") ? ["fieldCoverage.matchTeamGaps missing API-shaped ban pickTurn not_found marker"] : []),
          ...(challengeGap && (challengeGap.totals?.exactValueParityPassCount ?? 0) <= 0 ? ["challenge gap report has no exact value parity pass"] : []),
          ...(challengeGap && (challengeGap.totals?.rejectedExactValueMismatchCount ?? 0) <= 0 ? ["challenge gap report has no rejected exact value mismatch"] : []),
          ...(challengeGap && (challengeGap.totals?.corpusReplayCount ?? 0) < 20 ? ["challenge gap report has insufficient patch-corpus support"] : []),
          ...(challengeGap && (challengeGap.totals?.fuzzyAllZeroOnlyCount ?? 0) <= 0 ? ["challenge gap report does not identify all-zero-only fuzzy candidates"] : []),
          ...(challengeGap && (challengeGap.totals?.fuzzyValidatedNonZeroCount ?? 0) !== 0 ? ["challenge gap report has unreviewed non-zero fuzzy candidates"] : []),
          ...(validation && validation.validationSchema !== "rofl-api-metrics-riot-validation/v1" ? ["validation schema marker is not rofl-api-metrics-riot-validation/v1"] : []),
          ...(validation && validation.mode !== "offline-validation-only" ? ["validation mode is not offline-validation-only"] : []),
          ...(validation && validation.replayId !== artifact.source?.replayId ? ["validation replay id does not match runtime artifact"] : []),
          ...(validation && validation.inputPath !== inputPath ? ["validation input path does not match runtime artifact path"] : []),
          ...(validation && validation.validatedArtifact?.runtimeRiotApiFiles !== false ? ["validation target does not declare runtime Riot API files disabled"] : []),
          ...(validation && validation.validatedArtifact?.decoderArtifactSupervised !== false ? ["validation target is supervised"] : []),
          ...(validation && (validation.totals?.identifierComparisonCount ?? 0) < 22 ? ["validation identifier comparison coverage is below per-participant puuid/summonerId coverage"] : []),
          ...(validation && validation.totals?.identifierPassCount !== 0 ? ["validation identifier parity unexpectedly passed"] : []),
          ...(validation && (validation.totals?.finalTimelineComparisonCount ?? 0) < 170 ? ["validation final timeline scalar/damage comparison coverage is below expected coverage"] : []),
          ...(validation && validation.totals?.finalTimelinePassCount !== validation.totals?.finalTimelineComparisonCount ? ["validation final timeline scalar/damage parity failed"] : []),
        ],
      ),
    },
    {
      requirement: "Target latest patch 16.9 first.",
      ...pass(
        artifact.source?.versionGroup === "16.9",
        [
          `source.versionGroup=${artifact.source?.versionGroup}`,
          `source.gameVersion=${artifact.source?.gameVersion}`,
        ],
      ),
    },
    {
      requirement: "Produce at least one useful ROFL-only parity artifact for a replay in replays/.",
      ...pass(
        typeof artifact.source?.replayPath === "string" &&
          artifact.source.replayPath.replaceAll("\\", "/").includes("/replays/") &&
          fs.existsSync(artifact.source.replayPath),
        [
          `artifact=${inputPath}`,
          `source.replayPath=${artifact.source?.replayPath}`,
        ],
      ),
    },
    {
      requirement: "Document what still does not match Riot API parity.",
      ...pass(
        fullParity?.status === "not_satisfied" &&
          requiredFullParityGaps.every((gap) => fullParityGaps.has(gap)) &&
          matchMetadataGaps.status === "not_found" &&
          matchMetadataGapFields.includes("info.queueId") &&
          matchMetadataGapFields.includes("info.gameStartTimestamp") &&
          matchMetadataGapSources.includes("summary.metadataJson") &&
          matchMetadataAvailableMetadataJsonFields.includes("statsJson") &&
          matchMetadataGapReason.includes("not Riot queue/map/mode") &&
          matchParticipantGaps.status === "not_found" &&
          !(matchParticipantGaps.fields ?? []).includes("info.participants[].lane") &&
          !(matchParticipantGaps.fields ?? []).includes("info.participants[].role") &&
          !(matchParticipantGaps.fields ?? []).includes("info.participants[].timePlayed") &&
          (matchParticipantGaps.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].firstBloodKill") &&
          (matchParticipantGaps.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].profileIcon") &&
          matchTeamGaps.status === "not_found" &&
          (matchTeamGaps.fields ?? []).includes("info.teams[].bans[].championId") &&
          (matchTeamGaps.fields ?? []).includes("info.teams[].objectives.dragon.first") &&
          (matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].objectives.*.first") &&
          (matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].championId") &&
          (matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].pickTurn") &&
          roflDerivedFieldMap.match?.["info.teams[].objectives.*.first"]?.status === "not_found" &&
          roflDerivedFieldMap.match?.["info.teams[].bans"]?.status === "not_found" &&
          (artifact.match?.info?.teams ?? []).every((team) =>
            (team.bans ?? []).length === 5 &&
            team.bans.every((ban) => ban.championId === null && ban.pickTurn === null)
          ) &&
          (artifact.match?.info?.teams ?? []).every((team) =>
            Object.values(team.objectives ?? {}).every((objective) => Object.hasOwn(objective, "first") && objective.first === null)
          ) &&
          (matchTeamGaps.decodedTeamFields ?? []).includes("info.teams[].objectives.*.kills") &&
          artifact.fieldCoverage?.matchTeams?.corpusValidation?.status === "partially_stable" &&
          (artifact.fieldCoverage?.matchTeams?.corpusValidation?.knownUnstableFields ?? []).includes("info.teams[].objectives.dragon.kills") &&
          (matchTeamGaps.unstableDecodedFields ?? []).includes("info.teams[].objectives.dragon.kills") &&
          artifact.fieldCoverage?.timelineNonFinalParticipantFrames?.reconstructionDirection?.model === "keyframe-baseline-plus-chunk-deltas" &&
          artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.status === "not_promoted" &&
          artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.source === "chunk-row-identity-gates" &&
          artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.runtimeInput === false &&
          roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.status === "not_promoted" &&
          roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.source === "chunk-row-identity-gates" &&
          roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.participantIdentity === "not-established" &&
          (artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.candidateFamilies ?? []).some((entry) =>
            entry.familyKey === "241-0x02" && entry.expectedRowCount === 10 && entry.promotionStatus === "not_promoted"
          ) &&
          (artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.candidateFamilies ?? []).some((entry) =>
            entry.familyKey === "241-0x04" && entry.expectedRowCount === 10 && entry.promotionStatus === "not_promoted"
          ) &&
          artifact.fieldCoverage?.timelineEvents?.source === "chunk-delta-events-not-extracted" &&
          (artifact.fieldCoverage?.timelineEvents?.apiShapedNotFoundFields ?? []).length === 70 &&
          artifact.fieldCoverage?.timelineEvents?.runtimeEmission === "empty-events-arrays" &&
          artifact.fieldCoverage?.timelineEvents?.rejectedItemEventEvidence?.candidateCount === rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount &&
          artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.status === "not_promoted" &&
          artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.runtimeApiData === false &&
          artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.selectedIntervalCount === 40 &&
          remainingGapByKey.get("timelineEvents")?.runtimeApiData === false &&
          (remainingGapByKey.get("timelineEvents")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")) &&
          (remainingGapByKey.get("timelineEvents")?.evidenceRefs ?? []).includes("rejectedCandidateArtifacts.itemEvents.eventFamilyCorrelation") &&
          roflDerivedFieldMap.timeline?.["info.frames[].events"]?.source === artifact.fieldCoverage?.timelineEvents?.source &&
          (roflDerivedFieldMap.timeline?.["info.frames[].events"]?.apiShapedNotFoundFields ?? []).length === 70 &&
          roflDerivedFieldMap.timeline?.["info.frames[].events"]?.runtimeEmission === "empty-events-arrays" &&
          roflDerivedFieldMap.timeline?.["info.frames[].events"]?.rejectedItemEventEvidence?.candidateCount === rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount &&
          JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.eventFamilyCorrelation ?? null) === JSON.stringify(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation ?? null) &&
          JSON.stringify(artifact.fieldCoverage?.inventoryTimeline?.rejectedCandidateEvidence ?? null) === JSON.stringify(rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact ?? null) &&
          artifact.fieldCoverage?.inventoryTimeline?.runtimeInput === false &&
          remainingGapByKey.get("inventoryTimeline")?.runtimeApiData === false &&
          (remainingGapByKey.get("inventoryTimeline")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")) &&
          artifact.fieldCoverage?.positions?.source === "state-reconstruction-not-extracted-for-16.9" &&
          (artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []).length === 10 &&
          JSON.stringify(artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []) === JSON.stringify(rejectedCandidates.positions?.perParticipantCoverage ?? []) &&
          JSON.stringify(artifact.fieldCoverage?.positions?.noPriorsDiagnostic ?? null) === JSON.stringify(rejectedCandidates.positions?.noPriorsDiagnostic ?? null) &&
          remainingGapByKey.get("positions")?.runtimeApiData === false &&
          (remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("9/10")) &&
          (remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("no-priors") && String(blocker).includes("8/10")) &&
          (remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("rejectedCandidateArtifacts.positions.noPriorsDiagnostic") &&
          (remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("fieldCoverage.positions.noPriorsDiagnostic") &&
          (remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("artifactManifest.decoderDiagnostics.replay-only-no-priors-position-diagnostic") &&
          (remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("artifactManifest.decoderDiagnostics.offline-no-priors-position-validation-diagnostic") &&
          remainingGapByKey.get("nonFinalParticipantIdentity")?.runtimeApiData === false &&
          remainingGapByKey.get("damageTimeline")?.runtimeApiData === false &&
          roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.status === "not_promoted" &&
          JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.perParticipantCoverage ?? []) === JSON.stringify(artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []) &&
          JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.noPriorsDiagnostic ?? null) === JSON.stringify(artifact.fieldCoverage?.positions?.noPriorsDiagnostic ?? null) &&
          JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.statusCounts ?? {}) === JSON.stringify(artifact.fieldCoverage?.positions?.statusCounts ?? {}) &&
          JSON.stringify((artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []).reduce((counts, entry) => {
            counts[entry.status] = (counts[entry.status] ?? 0) + 1;
            return counts;
          }, {})) === JSON.stringify(artifact.fieldCoverage?.positions?.statusCounts ?? {}) &&
          timelineReconstruction?.auditSchema === "rofl-timeline-reconstruction-model/v1" &&
          timelineReconstruction?.mode === "offline-structure-audit" &&
          timelineReconstruction?.runtimeInput === false &&
          timelineReconstruction?.rows?.[0]?.replayId === artifact.source?.replayId &&
          timelineReconstruction?.rows?.[0]?.structural?.apiFramesEqualKeyframesPlusOne === true &&
          timelineReconstruction?.rows?.[0]?.structural?.keyframeChunkFormulaHolds === true &&
          timelineReconstruction?.rows?.[0]?.structural?.chunkRecordFormulaHolds === true &&
          timelineReconstruction?.rows?.[0]?.reconstructionModel?.model === "keyframe-baseline-plus-chunk-deltas" &&
          reconstructionTargetDossier02?.dossierSchema === "rofl-reconstruction-target-dossier/v1" &&
          reconstructionTargetDossier02?.runtimeInput === false &&
          reconstructionTargetDossier02?.status === "decoder_target_only_not_runtime_api_data" &&
          reconstructionTargetDossier02?.familyKey === "241-0x02" &&
          reconstructionTargetDossier04?.dossierSchema === "rofl-reconstruction-target-dossier/v1" &&
          reconstructionTargetDossier04?.runtimeInput === false &&
          reconstructionTargetDossier04?.status === "decoder_target_only_not_runtime_api_data" &&
          reconstructionTargetDossier04?.familyKey === "241-0x04" &&
          reconstructionTargetNeighborhood02?.schema === "rofl-reconstruction-target-neighborhood/v1" &&
          reconstructionTargetNeighborhood02?.runtimeInput === false &&
          reconstructionTargetNeighborhood02?.status === "decoder_context_only_not_runtime_api_data" &&
          (reconstructionTargetNeighborhood02?.rows ?? []).length > 0 &&
          reconstructionTargetNeighborhood04?.schema === "rofl-reconstruction-target-neighborhood/v1" &&
          reconstructionTargetNeighborhood04?.runtimeInput === false &&
          reconstructionTargetNeighborhood04?.status === "decoder_context_only_not_runtime_api_data" &&
          (reconstructionTargetNeighborhood04?.rows ?? []).length > 0 &&
          reconstructionTargetTable02?.schema === "rofl-reconstruction-target-table-analysis/v1" &&
          reconstructionTargetTable02?.runtimeInput === false &&
          reconstructionTargetTable02?.status === "decoder_hypothesis_only_not_runtime_api_data" &&
          reconstructionTargetTable02?.hypothesis?.payloadLength === 241 &&
          reconstructionTargetTable02?.hypothesis?.rowCount === 10 &&
          reconstructionTargetTable02?.hypothesis?.rowSize === 24 &&
          Number.isFinite(reconstructionTargetTable02?.coherenceScores?.sameRowWinRate) &&
          reconstructionTargetTable02?.coherenceScores?.sameRowWinRate < 0.75 &&
          reconstructionTargetTable02?.promotionAssessment?.runtimeApiData === false &&
          reconstructionTargetTable02?.promotionAssessment?.status === "not_promoted" &&
          reconstructionTargetTable04?.schema === "rofl-reconstruction-target-table-analysis/v1" &&
          reconstructionTargetTable04?.runtimeInput === false &&
          reconstructionTargetTable04?.status === "decoder_hypothesis_only_not_runtime_api_data" &&
          reconstructionTargetTable04?.hypothesis?.payloadLength === 241 &&
          reconstructionTargetTable04?.hypothesis?.rowCount === 10 &&
          reconstructionTargetTable04?.hypothesis?.rowSize === 24 &&
          Number.isFinite(reconstructionTargetTable04?.coherenceScores?.sameRowWinRate) &&
          reconstructionTargetTable04?.coherenceScores?.sameRowWinRate < 0.75 &&
          reconstructionTargetTable04?.promotionAssessment?.runtimeApiData === false &&
          reconstructionTargetTable04?.promotionAssessment?.status === "not_promoted" &&
          reconstructionRowIdentity02?.schema === "rofl-reconstruction-row-identity/v1" &&
          reconstructionRowIdentity02?.mode === "offline-row-identity-gate" &&
          reconstructionRowIdentity02?.runtimeInput === false &&
          reconstructionRowIdentity02?.status === "identity_gate_only_not_runtime_api_data" &&
          reconstructionRowIdentity02?.hypothesis?.rowCount === 10 &&
          reconstructionRowIdentity02?.evidence?.sameRowWinRate < 0.75 &&
          reconstructionRowIdentity02?.evidence?.rowTrackCoherence === false &&
          reconstructionRowIdentity02?.promotionAssessment?.runtimeApiData === false &&
          reconstructionRowIdentity02?.promotionAssessment?.participantIdentity === false &&
          reconstructionRowIdentity02?.promotionAssessment?.status === "not_promoted" &&
          reconstructionRowIdentity02?.evidence?.duplicateRejectedRowCount === duplicateRejectedRowCount(reconstructionRowIdentity02) &&
          (reconstructionRowIdentity02?.rowIdentity ?? []).length === 10 &&
          (reconstructionRowIdentity02?.rowIdentity ?? []).every(rowIdentityStatusAllowed) &&
          reconstructionRowIdentity04?.schema === "rofl-reconstruction-row-identity/v1" &&
          reconstructionRowIdentity04?.mode === "offline-row-identity-gate" &&
          reconstructionRowIdentity04?.runtimeInput === false &&
          reconstructionRowIdentity04?.status === "identity_gate_only_not_runtime_api_data" &&
          reconstructionRowIdentity04?.hypothesis?.rowCount === 10 &&
          reconstructionRowIdentity04?.evidence?.sameRowWinRate < 0.75 &&
          reconstructionRowIdentity04?.evidence?.rowTrackCoherence === false &&
          reconstructionRowIdentity04?.promotionAssessment?.runtimeApiData === false &&
          reconstructionRowIdentity04?.promotionAssessment?.participantIdentity === false &&
          reconstructionRowIdentity04?.promotionAssessment?.status === "not_promoted" &&
          reconstructionRowIdentity04?.evidence?.duplicateRejectedRowCount === duplicateRejectedRowCount(reconstructionRowIdentity04) &&
          (reconstructionRowIdentity04?.rowIdentity ?? []).length === 10 &&
          (reconstructionRowIdentity04?.rowIdentity ?? []).every(rowIdentityStatusAllowed) &&
          reconstructionRowGridCandidates?.schema === "rofl-reconstruction-row-grid-candidates/v1" &&
          reconstructionRowGridCandidates?.mode === "offline-row-grid-candidate-scan" &&
          reconstructionRowGridCandidates?.runtimeInput === false &&
          reconstructionRowGridCandidates?.status === "candidate_scan_only_not_runtime_api_data" &&
          (reconstructionRowGridCandidates?.candidateCount ?? 0) > 0 &&
          (reconstructionRowGridCandidates?.topCandidates ?? []).every((candidate) =>
            candidate.runtimeApiData === false &&
            candidate.participantIdentity === false &&
            candidate.status === "not_promoted"
          ) &&
          reconstructionRowGridFieldAnalysis?.schema === "rofl-reconstruction-row-grid-field-analysis/v1" &&
          reconstructionRowGridFieldAnalysis?.mode === "offline-row-grid-field-analysis" &&
          reconstructionRowGridFieldAnalysis?.runtimeInput === false &&
          reconstructionRowGridFieldAnalysis?.status === "field_hypothesis_only_not_runtime_api_data" &&
          (reconstructionRowGridFieldAnalysis?.candidates ?? []).length > 0 &&
          (reconstructionRowGridFieldAnalysis?.candidates ?? []).every((candidate) =>
            candidate.runtimeApiData === false &&
            candidate.participantIdentity === false &&
            candidate.fieldPromotionAssessment?.status === "not_promoted"
          ) &&
          runtimeReconstructionRowIdentity.status === "not_promoted" &&
          runtimeReconstructionRowIdentity.runtimeInput === false &&
          runtimeReconstructionRowIdentity.rowGridCandidateScan?.status === "candidate_scan_only_not_runtime_api_data" &&
          runtimeReconstructionRowIdentity.rowGridCandidateScan?.runtimeInput === false &&
          runtimeReconstructionRowIdentity.rowGridFieldAnalysis?.status === "field_hypothesis_only_not_runtime_api_data" &&
          runtimeReconstructionRowIdentity.rowGridFieldAnalysis?.runtimeInput === false &&
          (runtimeReconstructionRowIdentity.reason ?? "").includes("stable replay-only participant identity") &&
          (artifactIdentityChecklist?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity.status=not_promoted") &&
          (artifactIdentityChecklist?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridCandidateScan.status=candidate_scan_only_not_runtime_api_data") &&
          (artifactIdentityChecklist?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity.rowGridFieldAnalysis.status=field_hypothesis_only_not_runtime_api_data") &&
          (artifactIdentityChecklist?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity.status=not_promoted") &&
          (artifactFilteringChecklist?.evidence ?? []).includes("241-family row identity gates keep duplicate_rejected/unstable_identity rows out of runtime participantFrames") &&
          (artifactVerificationChecklist?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity cross-checks rejectedCandidateArtifacts.reconstructionRowIdentity") &&
          (runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).some((entry) =>
            entry.familyKey === "241-0x02" &&
            entry.promotionStatus === "not_promoted" &&
            entry.runtimeApiData === false &&
            entry.participantIdentity === false &&
            entry.sameRowWinRate < 0.75 &&
            ((entry.rowStatusCounts?.duplicate_rejected ?? 0) + (entry.rowStatusCounts?.unstable_identity ?? 0)) === 10
          ) &&
          (runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).some((entry) =>
            entry.familyKey === "241-0x04" &&
            entry.promotionStatus === "not_promoted" &&
            entry.runtimeApiData === false &&
            entry.participantIdentity === false &&
            entry.sameRowWinRate < 0.75 &&
            ((entry.rowStatusCounts?.duplicate_rejected ?? 0) + (entry.rowStatusCounts?.unstable_identity ?? 0)) === 10
          ) &&
          reconstructionFamilyEventCorrelation?.schema === "rofl-reconstruction-family-event-correlation/v1" &&
          reconstructionFamilyEventCorrelation?.mode === "offline-validation-only" &&
          reconstructionFamilyEventCorrelation?.runtimeInput === false &&
          reconstructionFamilyEventCorrelation?.status === "offline_validation_only_not_runtime_api_data" &&
          reconstructionFamilyEventCorrelation?.promotionAssessment?.runtimeApiData === false &&
          reconstructionFamilyEventCorrelation?.promotionAssessment?.status === "not_promoted" &&
          reconstructionFamilyEventCorrelation?.correlationMethods?.spearman?.includes("average ranks") &&
          reconstructionFamilyEventCorrelation?.correlationMethods?.pearson?.includes("normalized family rates") &&
          (reconstructionFamilyEventCorrelation?.rows ?? []).length >= 10 &&
          (reconstructionFamilyEventCorrelation?.selection?.familyKeys ?? []).includes("241-0x02") &&
          (reconstructionFamilyEventCorrelation?.selection?.familyKeys ?? []).includes("241-0x04") &&
          (reconstructionFamilyEventCorrelation?.correlations ?? []).some((row) => row.familyKey === "241-0x02" && row.category === "total") &&
          (reconstructionFamilyEventCorrelation?.correlations ?? []).some((row) => row.familyKey === "241-0x04" && row.category === "total") &&
          docsText.includes(artifactRelativePath) &&
          docsText.includes(auditRelativePath) &&
          docsText.includes(shapeGapRelativePath) &&
          docsText.includes(challengeGapRelativePath) &&
          docsText.includes(timelineReconstructionRelativePath) &&
          docsText.includes(reconstructionTargetDossier02RelativePath) &&
          docsText.includes(reconstructionTargetDossier04RelativePath) &&
          docsText.includes(reconstructionTargetNeighborhood02RelativePath) &&
          docsText.includes(reconstructionTargetNeighborhood04RelativePath) &&
          docsText.includes(reconstructionTargetTable02RelativePath) &&
          docsText.includes(reconstructionTargetTable04RelativePath) &&
          docsText.includes(reconstructionRowIdentity02RelativePath) &&
          docsText.includes(reconstructionRowIdentity04RelativePath) &&
          docsText.includes(reconstructionRowGridCandidatesRelativePath) &&
          docsText.includes(reconstructionRowGridFieldAnalysisRelativePath) &&
          docsText.includes(reconstructionFamilyEventCorrelationRelativePath) &&
          docsText.includes("inspected ROFL sources") &&
          docsText.includes("npm run audit:rofl-api-shape-gap") &&
          docsText.includes("npm run audit:rofl-challenge-gaps") &&
          docsText.includes("npm run verify:rofl-api-parity") &&
          docsText.includes("npm run analyze:reconstruction-target-table") &&
          docsText.includes("npm run scan:reconstruction-row-grids") &&
          docsText.includes("npm run analyze:reconstruction-row-grid-fields") &&
          docsText.includes("npm run correlate:reconstruction-families-events") &&
          docsText.includes("same-row win rate") &&
          docsText.includes("row identity gate") &&
          docsText.includes("duplicate_rejected") &&
          docsText.includes("rejectedCandidateArtifacts.reconstructionRowIdentity") &&
          docsText.includes("roflOnlyExtractionProof") &&
          docsText.includes("per-participant decoded scalar/damage metric counts") &&
          docsText.includes("remainingParityGaps") &&
          docsText.includes("participant-movement-no-priors.json") &&
          docsText.includes("assigned-movement-no-priors-validation-report.json") &&
          docsText.includes("npm run assign:movement") &&
          docsText.includes("npm run validate:assigned-movement") &&
          docsText.includes("fieldCoverage.positions.noPriorsDiagnostic") &&
          docsText.includes("roflDerivedFieldMap.timeline[\"info.frames[].participantFrames[].position\"].noPriorsDiagnostic") &&
          docsText.includes("8/10 participants") &&
          docsText.includes("7/8 assigned tracks") &&
          docsText.includes("Vayne TOP") &&
          docsText.includes("Malphite TOP") &&
          docsText.includes("startup-roster-token-scan.json") &&
          docsText.includes("replay-only-startup-roster-token-diagnostic") &&
          docsText.includes("20 replays") &&
          docsText.includes("keyframe-handle-graph-candidate-scores.json") &&
          docsText.includes("offline-handle-graph-row-link-diagnostic") &&
          docsText.includes("260 row-link candidates") &&
          docsText.includes("top score 0.333") &&
          docsText.includes("roflDerivedFieldMap.timeline[\"info.frames[].participantFrames[].nonFinalParticipantIdentity\"]") &&
          docsText.includes("nearest-row index stability") &&
          docsText.includes("row-discriminator") &&
          docsText.includes("not promotable for participant identity") &&
          docsText.includes("offline validation labels only") &&
          docsText.includes("keyframes as baseline snapshots") &&
          docsText.includes("chunk/subrecord updates between keyframes"),
        [
          "docs/rofl-api-parity.md",
          `docs exists=${fs.existsSync(docsPath)}`,
          `docs name ${artifactRelativePath}`,
          `docs name ${auditRelativePath}`,
          `docs name ${shapeGapRelativePath}`,
          `docs name ${challengeGapRelativePath}`,
          "docs name npm run audit:rofl-api-shape-gap",
          "docs name npm run audit:rofl-challenge-gaps",
          "docs name npm run verify:rofl-api-parity",
          "parityChecklist full parity is not_satisfied",
          "docs name roflOnlyExtractionProof",
          "docs name remainingParityGaps",
          "docs name participant-movement-no-priors.json",
          "docs name assigned-movement-no-priors-validation-report.json",
          "docs name npm run assign:movement",
          "docs name npm run validate:assigned-movement",
          "docs name fieldCoverage.positions.noPriorsDiagnostic",
          "docs name roflDerivedFieldMap.timeline position noPriorsDiagnostic",
          "docs name startup-roster-token-scan.json",
          "docs name replay-only-startup-roster-token-diagnostic",
          "docs name keyframe-handle-graph-candidate-scores.json",
          "docs name offline-handle-graph-row-link-diagnostic",
          `fullParityGaps=${[...fullParityGaps].join(",")}`,
          `fieldCoverage.matchMetadataGaps.status=${matchMetadataGaps.status ?? null}`,
          `fieldCoverage.matchMetadataGaps.fields=${matchMetadataGapFields.join(",")}`,
          `fieldCoverage.matchMetadataGaps.inspectedSources=${matchMetadataGapSources.join(",")}`,
          `fieldCoverage.matchMetadataGaps.availableMetadataJsonFields=${matchMetadataAvailableMetadataJsonFields.join(",")}`,
          `fieldCoverage.matchMetadataGaps.reason=${matchMetadataGapReason}`,
          `fieldCoverage.matchParticipantGaps.status=${matchParticipantGaps.status ?? null}`,
          `fieldCoverage.matchParticipantGaps.fields=${(matchParticipantGaps.fields ?? []).join(",")}`,
          `fieldCoverage.matchTeamGaps.status=${matchTeamGaps.status ?? null}`,
          `fieldCoverage.matchTeamGaps.fields=${(matchTeamGaps.fields ?? []).join(",")}`,
          `fieldCoverage.matchTeamGaps.apiShapedNotFoundFields=${(matchTeamGaps.apiShapedNotFoundFields ?? []).join(",")}`,
          `fieldCoverage.matchTeamGaps.decodedTeamFields=${(matchTeamGaps.decodedTeamFields ?? []).join(",")}`,
          `fieldCoverage.matchTeams.corpusValidation.status=${artifact.fieldCoverage?.matchTeams?.corpusValidation?.status ?? null}`,
          `fieldCoverage.matchTeams.corpusValidation.knownUnstableFields=${(artifact.fieldCoverage?.matchTeams?.corpusValidation?.knownUnstableFields ?? []).join(",")}`,
          `fieldCoverage.matchTeamGaps.unstableDecodedFields=${(matchTeamGaps.unstableDecodedFields ?? []).join(",")}`,
          `fieldCoverage.timelineNonFinalParticipantFrames.reconstructionDirection.model=${artifact.fieldCoverage?.timelineNonFinalParticipantFrames?.reconstructionDirection?.model ?? null}`,
          `fieldCoverage.timelineNonFinalParticipantIdentity.status=${artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.status ?? null}`,
          `fieldCoverage.timelineNonFinalParticipantIdentity.source=${artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.source ?? null}`,
          `fieldMap.timeline.nonFinalParticipantIdentity=${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.status ?? null}:${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.source ?? null}`,
          `fieldCoverage.timelineEvents.source=${artifact.fieldCoverage?.timelineEvents?.source ?? null}`,
          `fieldCoverage.timelineEvents.apiShapedNotFoundFields=${artifact.fieldCoverage?.timelineEvents?.apiShapedNotFoundFields?.length ?? null}`,
          `fieldCoverage.timelineEvents.runtimeEmission=${artifact.fieldCoverage?.timelineEvents?.runtimeEmission ?? null}`,
          `fieldCoverage.timelineEvents.rejectedItemEventCandidateCount=${artifact.fieldCoverage?.timelineEvents?.rejectedItemEventEvidence?.candidateCount ?? null}`,
          `fieldCoverage.timelineEvents.eventFamilyCorrelation=${JSON.stringify(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation ?? null)}`,
          `remainingParityGaps.keys=${[...remainingGapByKey.keys()].join(",")}`,
          `remainingParityGaps.positions=${JSON.stringify(remainingGapByKey.get("positions") ?? null)}`,
          `remainingParityGaps.timelineEvents=${JSON.stringify(remainingGapByKey.get("timelineEvents") ?? null)}`,
          `remainingParityGaps.inventoryTimeline=${JSON.stringify(remainingGapByKey.get("inventoryTimeline") ?? null)}`,
          `fieldMap.timeline.events.source=${roflDerivedFieldMap.timeline?.["info.frames[].events"]?.source ?? null}`,
          `fieldMap.timeline.events.apiShapedNotFoundFields=${roflDerivedFieldMap.timeline?.["info.frames[].events"]?.apiShapedNotFoundFields?.length ?? null}`,
          `fieldMap.timeline.events.runtimeEmission=${roflDerivedFieldMap.timeline?.["info.frames[].events"]?.runtimeEmission ?? null}`,
          `fieldMap.timeline.events.rejectedItemEventCandidateCount=${roflDerivedFieldMap.timeline?.["info.frames[].events"]?.rejectedItemEventEvidence?.candidateCount ?? null}`,
          `fieldMap.timeline.events.eventFamilyCorrelation=${JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.eventFamilyCorrelation ?? null)}`,
          `fieldCoverage.inventoryTimeline.matchesRejectedInventory=${JSON.stringify(artifact.fieldCoverage?.inventoryTimeline?.rejectedCandidateEvidence ?? null) === JSON.stringify(rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact ?? null)}`,
          `fieldCoverage.inventoryTimeline.runtimeInput=${artifact.fieldCoverage?.inventoryTimeline?.runtimeInput ?? null}`,
          `fieldCoverage.positions.source=${artifact.fieldCoverage?.positions?.source ?? null}`,
          `fieldCoverage.positions.perParticipantCoverage=${artifact.fieldCoverage?.positions?.perParticipantCoverage?.length ?? null}`,
          `fieldCoverage.positions.matchesRejectedPositions=${JSON.stringify(artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []) === JSON.stringify(rejectedCandidates.positions?.perParticipantCoverage ?? [])}`,
          `fieldCoverage.positions.statusCounts=${JSON.stringify(artifact.fieldCoverage?.positions?.statusCounts ?? {})}`,
          `fieldMap.timeline.position.status=${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.status ?? null}`,
          `fieldMap.timeline.position.perParticipantCoverage=${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.perParticipantCoverage?.length ?? null}`,
          `fieldMap.timeline.position.statusCounts=${JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.statusCounts ?? {})}`,
          `timelineReconstructionPath=${timelineReconstructionPath}`,
          `timelineReconstruction.auditSchema=${timelineReconstruction?.auditSchema ?? null}`,
          `timelineReconstruction.mode=${timelineReconstruction?.mode ?? null}`,
          `timelineReconstruction.runtimeInput=${timelineReconstruction?.runtimeInput ?? null}`,
          `timelineReconstruction replayId=${timelineReconstruction?.rows?.[0]?.replayId ?? null}`,
          `timelineReconstruction apiFrameCount=${timelineReconstruction?.rows?.[0]?.structural?.apiFrameCount ?? null}`,
          `timelineReconstruction replayKeyframeCount=${timelineReconstruction?.rows?.[0]?.structural?.replayKeyframeCount ?? null}`,
          `timelineReconstruction apiFramesEqualKeyframesPlusOne=${timelineReconstruction?.rows?.[0]?.structural?.apiFramesEqualKeyframesPlusOne ?? null}`,
          `timelineReconstruction keyframeChunkFormulaHolds=${timelineReconstruction?.rows?.[0]?.structural?.keyframeChunkFormulaHolds ?? null}`,
          `timelineReconstruction chunkRecordFormulaHolds=${timelineReconstruction?.rows?.[0]?.structural?.chunkRecordFormulaHolds ?? null}`,
          `reconstructionTargetDossier02=${reconstructionTargetDossier02RelativePath}`,
          `reconstructionTargetDossier02.status=${reconstructionTargetDossier02?.status ?? null}`,
          `reconstructionTargetDossier04=${reconstructionTargetDossier04RelativePath}`,
          `reconstructionTargetDossier04.status=${reconstructionTargetDossier04?.status ?? null}`,
          `reconstructionTargetNeighborhood02=${reconstructionTargetNeighborhood02RelativePath}`,
          `reconstructionTargetNeighborhood02.rows=${reconstructionTargetNeighborhood02?.rows?.length ?? null}`,
          `reconstructionTargetNeighborhood04=${reconstructionTargetNeighborhood04RelativePath}`,
          `reconstructionTargetNeighborhood04.rows=${reconstructionTargetNeighborhood04?.rows?.length ?? null}`,
          `reconstructionTargetTable02=${reconstructionTargetTable02RelativePath}`,
          `reconstructionTargetTable02.status=${reconstructionTargetTable02?.status ?? null}`,
          `reconstructionTargetTable02.sameRowWinRate=${reconstructionTargetTable02?.coherenceScores?.sameRowWinRate ?? null}`,
          `reconstructionTargetTable02.promotion=${reconstructionTargetTable02?.promotionAssessment?.status ?? null}`,
          `reconstructionTargetTable04=${reconstructionTargetTable04RelativePath}`,
          `reconstructionTargetTable04.status=${reconstructionTargetTable04?.status ?? null}`,
          `reconstructionTargetTable04.sameRowWinRate=${reconstructionTargetTable04?.coherenceScores?.sameRowWinRate ?? null}`,
          `reconstructionTargetTable04.promotion=${reconstructionTargetTable04?.promotionAssessment?.status ?? null}`,
          `reconstructionRowIdentity02=${reconstructionRowIdentity02RelativePath}`,
          `reconstructionRowIdentity02.status=${reconstructionRowIdentity02?.status ?? null}`,
          `reconstructionRowIdentity02.sameRowWinRate=${reconstructionRowIdentity02?.evidence?.sameRowWinRate ?? null}`,
          `reconstructionRowIdentity02.duplicateRejectedRowCount=${reconstructionRowIdentity02?.evidence?.duplicateRejectedRowCount ?? null}`,
          `reconstructionRowIdentity02.promotion=${reconstructionRowIdentity02?.promotionAssessment?.status ?? null}`,
          `reconstructionRowIdentity04=${reconstructionRowIdentity04RelativePath}`,
          `reconstructionRowIdentity04.status=${reconstructionRowIdentity04?.status ?? null}`,
          `reconstructionRowIdentity04.sameRowWinRate=${reconstructionRowIdentity04?.evidence?.sameRowWinRate ?? null}`,
          `reconstructionRowIdentity04.duplicateRejectedRowCount=${reconstructionRowIdentity04?.evidence?.duplicateRejectedRowCount ?? null}`,
          `reconstructionRowIdentity04.promotion=${reconstructionRowIdentity04?.promotionAssessment?.status ?? null}`,
          `runtimeReconstructionRowIdentity.status=${runtimeReconstructionRowIdentity.status ?? null}`,
          `runtimeReconstructionRowIdentity.runtimeInput=${runtimeReconstructionRowIdentity.runtimeInput ?? null}`,
          `runtimeReconstructionRowIdentity.artifacts=${(runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).map((entry) => `${entry.familyKey}:${entry.promotionStatus}:${entry.sameRowWinRate}`).join(";")}`,
          `artifactIdentityChecklist.hasRowIdentity=${(artifactIdentityChecklist?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity.status=not_promoted")}`,
          `artifactFilteringChecklist.hasRowIdentityGate=${(artifactFilteringChecklist?.evidence ?? []).includes("241-family row identity gates keep duplicate_rejected/unstable_identity rows out of runtime participantFrames")}`,
          `artifactVerificationChecklist.hasRowIdentityCrossCheck=${(artifactVerificationChecklist?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity cross-checks rejectedCandidateArtifacts.reconstructionRowIdentity")}`,
          `reconstructionFamilyEventCorrelation=${reconstructionFamilyEventCorrelationRelativePath}`,
          `reconstructionFamilyEventCorrelation.rows=${reconstructionFamilyEventCorrelation?.rows?.length ?? null}`,
          `reconstructionFamilyEventCorrelation.status=${reconstructionFamilyEventCorrelation?.status ?? null}`,
          `reconstructionFamilyEventCorrelation.promotion=${reconstructionFamilyEventCorrelation?.promotionAssessment?.status ?? null}`,
          `reconstructionFamilyEventCorrelation.spearman=${reconstructionFamilyEventCorrelation?.correlationMethods?.spearman ?? null}`,
        ],
        [
          ...requiredFullParityGaps.filter((gap) => !fullParityGaps.has(gap)),
          ...(matchMetadataGaps.status !== "not_found" ? ["fieldCoverage.matchMetadataGaps status is not not_found"] : []),
          ...(!matchMetadataGapFields.includes("info.queueId") ? ["fieldCoverage.matchMetadataGaps missing info.queueId"] : []),
          ...(!matchMetadataGapFields.includes("info.gameStartTimestamp") ? ["fieldCoverage.matchMetadataGaps missing info.gameStartTimestamp"] : []),
          ...(!matchMetadataGapSources.includes("summary.metadataJson") ? ["fieldCoverage.matchMetadataGaps missing inspected summary.metadataJson source"] : []),
          ...(!matchMetadataAvailableMetadataJsonFields.includes("statsJson") ? ["fieldCoverage.matchMetadataGaps missing available statsJson metadata key"] : []),
          ...(!matchMetadataGapReason.includes("not Riot queue/map/mode") ? ["fieldCoverage.matchMetadataGaps reason does not explain missing queue/map/mode"] : []),
          ...(matchParticipantGaps.status !== "not_found" ? ["fieldCoverage.matchParticipantGaps status is not not_found"] : []),
          ...((matchParticipantGaps.fields ?? []).includes("info.participants[].lane") ? ["fieldCoverage.matchParticipantGaps still includes promoted lane"] : []),
          ...((matchParticipantGaps.fields ?? []).includes("info.participants[].role") ? ["fieldCoverage.matchParticipantGaps still includes promoted role"] : []),
          ...((matchParticipantGaps.fields ?? []).includes("info.participants[].timePlayed") ? ["fieldCoverage.matchParticipantGaps still includes promoted timePlayed"] : []),
          ...(!(matchParticipantGaps.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].firstBloodKill") ? ["fieldCoverage.matchParticipantGaps missing firstBloodKill gap evidence"] : []),
          ...(!(matchParticipantGaps.rejectedCandidateEvidence ?? []).some((entry) => entry.field === "info.participants[].profileIcon") ? ["fieldCoverage.matchParticipantGaps missing profileIcon gap evidence"] : []),
          ...(matchTeamGaps.status !== "not_found" ? ["fieldCoverage.matchTeamGaps status is not not_found"] : []),
          ...(!(matchTeamGaps.fields ?? []).includes("info.teams[].bans[].championId") ? ["fieldCoverage.matchTeamGaps missing bans championId"] : []),
          ...(!(matchTeamGaps.fields ?? []).includes("info.teams[].objectives.dragon.first") ? ["fieldCoverage.matchTeamGaps missing dragon first objective"] : []),
          ...(!(matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].objectives.*.first") ? ["fieldCoverage.matchTeamGaps missing API-shaped first objective not_found marker"] : []),
          ...(!(matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].championId") ? ["fieldCoverage.matchTeamGaps missing API-shaped ban championId not_found marker"] : []),
          ...(!(matchTeamGaps.apiShapedNotFoundFields ?? []).includes("info.teams[].bans[].pickTurn") ? ["fieldCoverage.matchTeamGaps missing API-shaped ban pickTurn not_found marker"] : []),
          ...(roflDerivedFieldMap.match?.["info.teams[].objectives.*.first"]?.status !== "not_found" ? ["roflDerivedFieldMap missing not_found first objective marker"] : []),
          ...(roflDerivedFieldMap.match?.["info.teams[].bans"]?.status !== "not_found" ? ["roflDerivedFieldMap missing not_found team bans marker"] : []),
          ...(!(artifact.match?.info?.teams ?? []).every((team) =>
            (team.bans ?? []).length === 5 &&
            team.bans.every((ban) => ban.championId === null && ban.pickTurn === null)
          ) ? ["match.info.teams bans must expose null placeholder fields"] : []),
          ...(!(artifact.match?.info?.teams ?? []).every((team) =>
            Object.values(team.objectives ?? {}).every((objective) => Object.hasOwn(objective, "first") && objective.first === null)
          ) ? ["match.info.teams objectives must expose null first fields"] : []),
          ...(!(matchTeamGaps.decodedTeamFields ?? []).includes("info.teams[].objectives.*.kills") ? ["fieldCoverage.matchTeamGaps does not distinguish decoded objective kills"] : []),
          ...(artifact.fieldCoverage?.matchTeams?.corpusValidation?.status !== "partially_stable" ? ["fieldCoverage.matchTeams missing partially_stable corpus validation status"] : []),
          ...(!(artifact.fieldCoverage?.matchTeams?.corpusValidation?.knownUnstableFields ?? []).includes("info.teams[].objectives.dragon.kills") ? ["fieldCoverage.matchTeams corpus validation missing objective instability"] : []),
          ...(!(matchTeamGaps.unstableDecodedFields ?? []).includes("info.teams[].objectives.dragon.kills") ? ["fieldCoverage.matchTeamGaps missing unstable decoded objective fields"] : []),
          ...(artifact.fieldCoverage?.timelineNonFinalParticipantFrames?.reconstructionDirection?.model !== "keyframe-baseline-plus-chunk-deltas" ? ["fieldCoverage.timelineNonFinalParticipantFrames missing chunk-delta reconstruction direction"] : []),
          ...(artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.status !== "not_promoted" ? ["fieldCoverage.timelineNonFinalParticipantIdentity missing not_promoted status"] : []),
          ...(artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.source !== "chunk-row-identity-gates" ? ["fieldCoverage.timelineNonFinalParticipantIdentity missing chunk row identity source"] : []),
          ...(artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.runtimeInput !== false ? ["fieldCoverage.timelineNonFinalParticipantIdentity must be non-runtime"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.status !== "not_promoted" ? ["roflDerivedFieldMap missing non-final participant identity not_promoted status"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.source !== "chunk-row-identity-gates" ? ["roflDerivedFieldMap missing non-final participant identity chunk row gate source"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].nonFinalParticipantIdentity"]?.participantIdentity !== "not-established" ? ["roflDerivedFieldMap missing non-final participant identity rejection marker"] : []),
          ...(!(artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.candidateFamilies ?? []).some((entry) =>
            entry.familyKey === "241-0x02" && entry.expectedRowCount === 10 && entry.promotionStatus === "not_promoted"
          ) ? ["fieldCoverage.timelineNonFinalParticipantIdentity missing 241-0x02 summary"] : []),
          ...(!(artifact.fieldCoverage?.timelineNonFinalParticipantIdentity?.candidateFamilies ?? []).some((entry) =>
            entry.familyKey === "241-0x04" && entry.expectedRowCount === 10 && entry.promotionStatus === "not_promoted"
          ) ? ["fieldCoverage.timelineNonFinalParticipantIdentity missing 241-0x04 summary"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.source !== "chunk-delta-events-not-extracted" ? ["fieldCoverage.timelineEvents missing chunk-delta event extraction source"] : []),
          ...((artifact.fieldCoverage?.timelineEvents?.apiShapedNotFoundFields ?? []).length !== 70 ? ["fieldCoverage.timelineEvents missing API-shaped event leaf gap list"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.runtimeEmission !== "empty-events-arrays" ? ["fieldCoverage.timelineEvents missing empty event array runtime policy"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.rejectedItemEventEvidence?.candidateCount !== rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount ? ["fieldCoverage.timelineEvents rejected item-event evidence does not match rejectedCandidateArtifacts.itemEvents"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.status !== "not_promoted" ? ["fieldCoverage.timelineEvents missing not-promoted event-family correlation diagnostic"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.runtimeApiData !== false ? ["fieldCoverage.timelineEvents event-family correlation must be non-runtime API data"] : []),
          ...(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation?.selectedIntervalCount !== 40 ? ["fieldCoverage.timelineEvents event-family correlation missing selected interval count"] : []),
          ...(remainingGapByKey.get("timelineEvents")?.runtimeApiData !== false ? ["remainingParityGaps timelineEvents must be non-runtime"] : []),
          ...(!(remainingGapByKey.get("timelineEvents")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")) ? ["remainingParityGaps timelineEvents missing item-event candidate blocker"] : []),
          ...(!(remainingGapByKey.get("timelineEvents")?.evidenceRefs ?? []).includes("rejectedCandidateArtifacts.itemEvents.eventFamilyCorrelation") ? ["remainingParityGaps timelineEvents missing event-family correlation evidence ref"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.source !== artifact.fieldCoverage?.timelineEvents?.source ? ["roflDerivedFieldMap timeline events source does not match fieldCoverage.timelineEvents"] : []),
          ...((roflDerivedFieldMap.timeline?.["info.frames[].events"]?.apiShapedNotFoundFields ?? []).length !== 70 ? ["roflDerivedFieldMap timeline events missing API-shaped event leaf gap list"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.runtimeEmission !== "empty-events-arrays" ? ["roflDerivedFieldMap timeline events missing empty event array runtime policy"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.rejectedItemEventEvidence?.candidateCount !== rejectedCandidates.itemEvents?.candidateArtifact?.candidateCount ? ["roflDerivedFieldMap timeline events rejected item-event evidence does not match rejectedCandidateArtifacts.itemEvents"] : []),
          ...(JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].events"]?.eventFamilyCorrelation ?? null) !== JSON.stringify(artifact.fieldCoverage?.timelineEvents?.eventFamilyCorrelation ?? null) ? ["roflDerivedFieldMap timeline events event-family correlation does not match fieldCoverage.timelineEvents"] : []),
          ...(JSON.stringify(artifact.fieldCoverage?.inventoryTimeline?.rejectedCandidateEvidence ?? null) !== JSON.stringify(rejectedCandidates.inventoryTimeline?.relatedCandidateArtifact ?? null) ? ["fieldCoverage.inventoryTimeline rejected evidence does not match rejectedCandidateArtifacts.inventoryTimeline"] : []),
          ...(artifact.fieldCoverage?.inventoryTimeline?.runtimeInput !== false ? ["fieldCoverage.inventoryTimeline must be non-runtime"] : []),
          ...(remainingGapByKey.get("inventoryTimeline")?.runtimeApiData !== false ? ["remainingParityGaps inventoryTimeline must be non-runtime"] : []),
          ...(!(remainingGapByKey.get("inventoryTimeline")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("itemEventCandidateCount=689")) ? ["remainingParityGaps inventoryTimeline missing item-event candidate blocker"] : []),
          ...(artifact.fieldCoverage?.positions?.source !== "state-reconstruction-not-extracted-for-16.9" ? ["fieldCoverage.positions missing state reconstruction source"] : []),
          ...((artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []).length !== 10 ? ["fieldCoverage.positions missing per-participant movement coverage"] : []),
          ...(JSON.stringify(artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []) !== JSON.stringify(rejectedCandidates.positions?.perParticipantCoverage ?? []) ? ["fieldCoverage.positions per-participant coverage does not match rejected position evidence"] : []),
          ...(JSON.stringify(artifact.fieldCoverage?.positions?.noPriorsDiagnostic ?? null) !== JSON.stringify(rejectedCandidates.positions?.noPriorsDiagnostic ?? null) ? ["fieldCoverage.positions no-priors diagnostic does not match rejected position evidence"] : []),
          ...(remainingGapByKey.get("positions")?.runtimeApiData !== false ? ["remainingParityGaps positions must be non-runtime"] : []),
          ...(!(remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("9/10")) ? ["remainingParityGaps positions missing 9/10 blocker"] : []),
          ...(!(remainingGapByKey.get("positions")?.blockerSummary ?? []).some((blocker) => String(blocker).includes("no-priors") && String(blocker).includes("8/10")) ? ["remainingParityGaps positions missing no-priors 8/10 blocker"] : []),
          ...(!(remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("rejectedCandidateArtifacts.positions.noPriorsDiagnostic") ? ["remainingParityGaps positions missing rejected no-priors evidence ref"] : []),
          ...(!(remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("fieldCoverage.positions.noPriorsDiagnostic") ? ["remainingParityGaps positions missing fieldCoverage no-priors evidence ref"] : []),
          ...(!(remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("artifactManifest.decoderDiagnostics.replay-only-no-priors-position-diagnostic") ? ["remainingParityGaps positions missing manifest no-priors evidence ref"] : []),
          ...(!(remainingGapByKey.get("positions")?.evidenceRefs ?? []).includes("artifactManifest.decoderDiagnostics.offline-no-priors-position-validation-diagnostic") ? ["remainingParityGaps positions missing manifest no-priors validation evidence ref"] : []),
          ...(remainingGapByKey.get("nonFinalParticipantIdentity")?.runtimeApiData !== false ? ["remainingParityGaps nonFinalParticipantIdentity must be non-runtime"] : []),
          ...(remainingGapByKey.get("damageTimeline")?.runtimeApiData !== false ? ["remainingParityGaps damageTimeline must be non-runtime"] : []),
          ...(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.status !== "not_promoted" ? ["roflDerivedFieldMap timeline position missing not_promoted status"] : []),
          ...(JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.perParticipantCoverage ?? []) !== JSON.stringify(artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []) ? ["roflDerivedFieldMap timeline position per-participant coverage does not match fieldCoverage.positions"] : []),
          ...(JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.noPriorsDiagnostic ?? null) !== JSON.stringify(artifact.fieldCoverage?.positions?.noPriorsDiagnostic ?? null) ? ["roflDerivedFieldMap timeline position no-priors diagnostic does not match fieldCoverage.positions"] : []),
          ...(JSON.stringify(roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].position"]?.statusCounts ?? {}) !== JSON.stringify(artifact.fieldCoverage?.positions?.statusCounts ?? {}) ? ["roflDerivedFieldMap timeline position statusCounts do not match fieldCoverage.positions"] : []),
          ...(JSON.stringify((artifact.fieldCoverage?.positions?.perParticipantCoverage ?? []).reduce((counts, entry) => {
            counts[entry.status] = (counts[entry.status] ?? 0) + 1;
            return counts;
          }, {})) !== JSON.stringify(artifact.fieldCoverage?.positions?.statusCounts ?? {}) ? ["fieldCoverage.positions statusCounts do not match per-participant entries"] : []),
          ...(!timelineReconstruction ? ["timeline reconstruction audit missing"] : []),
          ...(timelineReconstruction && timelineReconstruction.auditSchema !== "rofl-timeline-reconstruction-model/v1" ? ["timeline reconstruction audit schema mismatch"] : []),
          ...(timelineReconstruction && timelineReconstruction.mode !== "offline-structure-audit" ? ["timeline reconstruction audit mode mismatch"] : []),
          ...(timelineReconstruction && timelineReconstruction.runtimeInput !== false ? ["timeline reconstruction audit must be non-runtime"] : []),
          ...(timelineReconstruction && timelineReconstruction.rows?.[0]?.replayId !== artifact.source?.replayId ? ["timeline reconstruction audit replay mismatch"] : []),
          ...(timelineReconstruction && timelineReconstruction.rows?.[0]?.structural?.apiFramesEqualKeyframesPlusOne !== true ? ["timeline reconstruction audit missing API frame/keyframe +1 evidence"] : []),
          ...(timelineReconstruction && timelineReconstruction.rows?.[0]?.structural?.keyframeChunkFormulaHolds !== true ? ["timeline reconstruction audit missing keyframe chunk formula evidence"] : []),
          ...(timelineReconstruction && timelineReconstruction.rows?.[0]?.structural?.chunkRecordFormulaHolds !== true ? ["timeline reconstruction audit missing chunk record formula evidence"] : []),
          ...(timelineReconstruction && timelineReconstruction.rows?.[0]?.reconstructionModel?.model !== "keyframe-baseline-plus-chunk-deltas" ? ["timeline reconstruction audit missing reconstruction model"] : []),
          ...(!reconstructionTargetDossier02 ? ["241-0x02 target dossier artifact missing"] : []),
          ...(reconstructionTargetDossier02 && reconstructionTargetDossier02.dossierSchema !== "rofl-reconstruction-target-dossier/v1" ? ["241-0x02 target dossier schema mismatch"] : []),
          ...(reconstructionTargetDossier02 && reconstructionTargetDossier02.runtimeInput !== false ? ["241-0x02 target dossier must be non-runtime"] : []),
          ...(reconstructionTargetDossier02 && reconstructionTargetDossier02.status !== "decoder_target_only_not_runtime_api_data" ? ["241-0x02 target dossier status must remain target-only"] : []),
          ...(reconstructionTargetDossier02 && reconstructionTargetDossier02.familyKey !== "241-0x02" ? ["241-0x02 target dossier family mismatch"] : []),
          ...(!reconstructionTargetDossier04 ? ["241-0x04 target dossier artifact missing"] : []),
          ...(reconstructionTargetDossier04 && reconstructionTargetDossier04.dossierSchema !== "rofl-reconstruction-target-dossier/v1" ? ["241-0x04 target dossier schema mismatch"] : []),
          ...(reconstructionTargetDossier04 && reconstructionTargetDossier04.runtimeInput !== false ? ["241-0x04 target dossier must be non-runtime"] : []),
          ...(reconstructionTargetDossier04 && reconstructionTargetDossier04.status !== "decoder_target_only_not_runtime_api_data" ? ["241-0x04 target dossier status must remain target-only"] : []),
          ...(reconstructionTargetDossier04 && reconstructionTargetDossier04.familyKey !== "241-0x04" ? ["241-0x04 target dossier family mismatch"] : []),
          ...(!reconstructionTargetNeighborhood02 ? ["241-0x02 target neighborhood artifact missing"] : []),
          ...(reconstructionTargetNeighborhood02 && reconstructionTargetNeighborhood02.schema !== "rofl-reconstruction-target-neighborhood/v1" ? ["241-0x02 target neighborhood schema mismatch"] : []),
          ...(reconstructionTargetNeighborhood02 && reconstructionTargetNeighborhood02.runtimeInput !== false ? ["241-0x02 target neighborhood must be non-runtime"] : []),
          ...(reconstructionTargetNeighborhood02 && reconstructionTargetNeighborhood02.status !== "decoder_context_only_not_runtime_api_data" ? ["241-0x02 target neighborhood status must remain context-only"] : []),
          ...(reconstructionTargetNeighborhood02 && (reconstructionTargetNeighborhood02.rows ?? []).length <= 0 ? ["241-0x02 target neighborhood rows missing"] : []),
          ...(!reconstructionTargetNeighborhood04 ? ["241-0x04 target neighborhood artifact missing"] : []),
          ...(reconstructionTargetNeighborhood04 && reconstructionTargetNeighborhood04.schema !== "rofl-reconstruction-target-neighborhood/v1" ? ["241-0x04 target neighborhood schema mismatch"] : []),
          ...(reconstructionTargetNeighborhood04 && reconstructionTargetNeighborhood04.runtimeInput !== false ? ["241-0x04 target neighborhood must be non-runtime"] : []),
          ...(reconstructionTargetNeighborhood04 && reconstructionTargetNeighborhood04.status !== "decoder_context_only_not_runtime_api_data" ? ["241-0x04 target neighborhood status must remain context-only"] : []),
          ...(reconstructionTargetNeighborhood04 && (reconstructionTargetNeighborhood04.rows ?? []).length <= 0 ? ["241-0x04 target neighborhood rows missing"] : []),
          ...(!reconstructionTargetTable02 ? ["241-0x02 target table artifact missing"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.schema !== "rofl-reconstruction-target-table-analysis/v1" ? ["241-0x02 target table schema mismatch"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.runtimeInput !== false ? ["241-0x02 target table must be non-runtime"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.status !== "decoder_hypothesis_only_not_runtime_api_data" ? ["241-0x02 target table status must remain hypothesis-only"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.hypothesis?.payloadLength !== 241 ? ["241-0x02 target table payload length mismatch"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.hypothesis?.rowCount !== 10 ? ["241-0x02 target table row count mismatch"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.hypothesis?.rowSize !== 24 ? ["241-0x02 target table row size mismatch"] : []),
          ...(reconstructionTargetTable02 && !Number.isFinite(reconstructionTargetTable02.coherenceScores?.sameRowWinRate) ? ["241-0x02 target table coherence missing"] : []),
          ...(reconstructionTargetTable02 && Number.isFinite(reconstructionTargetTable02.coherenceScores?.sameRowWinRate) && reconstructionTargetTable02.coherenceScores.sameRowWinRate >= 0.75 ? ["241-0x02 table coherence now strong enough to review promotion gates"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.promotionAssessment?.runtimeApiData !== false ? ["241-0x02 target table promotion must not emit runtime API data"] : []),
          ...(reconstructionTargetTable02 && reconstructionTargetTable02.promotionAssessment?.status !== "not_promoted" ? ["241-0x02 target table must remain not_promoted"] : []),
          ...(!reconstructionTargetTable04 ? ["241-0x04 target table artifact missing"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.schema !== "rofl-reconstruction-target-table-analysis/v1" ? ["241-0x04 target table schema mismatch"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.runtimeInput !== false ? ["241-0x04 target table must be non-runtime"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.status !== "decoder_hypothesis_only_not_runtime_api_data" ? ["241-0x04 target table status must remain hypothesis-only"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.hypothesis?.payloadLength !== 241 ? ["241-0x04 target table payload length mismatch"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.hypothesis?.rowCount !== 10 ? ["241-0x04 target table row count mismatch"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.hypothesis?.rowSize !== 24 ? ["241-0x04 target table row size mismatch"] : []),
          ...(reconstructionTargetTable04 && !Number.isFinite(reconstructionTargetTable04.coherenceScores?.sameRowWinRate) ? ["241-0x04 target table coherence missing"] : []),
          ...(reconstructionTargetTable04 && Number.isFinite(reconstructionTargetTable04.coherenceScores?.sameRowWinRate) && reconstructionTargetTable04.coherenceScores.sameRowWinRate >= 0.75 ? ["241-0x04 table coherence now strong enough to review promotion gates"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.promotionAssessment?.runtimeApiData !== false ? ["241-0x04 target table promotion must not emit runtime API data"] : []),
          ...(reconstructionTargetTable04 && reconstructionTargetTable04.promotionAssessment?.status !== "not_promoted" ? ["241-0x04 target table must remain not_promoted"] : []),
          ...(!reconstructionRowIdentity02 ? ["241-0x02 row identity gate artifact missing"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.schema !== "rofl-reconstruction-row-identity/v1" ? ["241-0x02 row identity schema mismatch"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.mode !== "offline-row-identity-gate" ? ["241-0x02 row identity mode mismatch"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.runtimeInput !== false ? ["241-0x02 row identity gate must be non-runtime"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.status !== "identity_gate_only_not_runtime_api_data" ? ["241-0x02 row identity status mismatch"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.hypothesis?.rowCount !== 10 ? ["241-0x02 row identity row count mismatch"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.evidence?.sameRowWinRate >= 0.75 ? ["241-0x02 row identity coherence now strong enough to review promotion gates"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.evidence?.rowTrackCoherence !== false ? ["241-0x02 row identity must reject row-track coherence"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.promotionAssessment?.runtimeApiData !== false ? ["241-0x02 row identity promotion must not emit runtime API data"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.promotionAssessment?.participantIdentity !== false ? ["241-0x02 row identity must not claim participant identity"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.promotionAssessment?.status !== "not_promoted" ? ["241-0x02 row identity must remain not_promoted"] : []),
          ...(reconstructionRowIdentity02 && reconstructionRowIdentity02.evidence?.duplicateRejectedRowCount !== duplicateRejectedRowCount(reconstructionRowIdentity02) ? ["241-0x02 row identity duplicate count mismatch"] : []),
          ...(reconstructionRowIdentity02 && !(reconstructionRowIdentity02.rowIdentity ?? []).every(rowIdentityStatusAllowed) ? ["241-0x02 row identity entries must remain rejected-or-unstable/null/non-runtime"] : []),
          ...(!reconstructionRowIdentity04 ? ["241-0x04 row identity gate artifact missing"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.schema !== "rofl-reconstruction-row-identity/v1" ? ["241-0x04 row identity schema mismatch"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.mode !== "offline-row-identity-gate" ? ["241-0x04 row identity mode mismatch"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.runtimeInput !== false ? ["241-0x04 row identity gate must be non-runtime"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.status !== "identity_gate_only_not_runtime_api_data" ? ["241-0x04 row identity status mismatch"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.hypothesis?.rowCount !== 10 ? ["241-0x04 row identity row count mismatch"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.evidence?.sameRowWinRate >= 0.75 ? ["241-0x04 row identity coherence now strong enough to review promotion gates"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.evidence?.rowTrackCoherence !== false ? ["241-0x04 row identity must reject row-track coherence"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.promotionAssessment?.runtimeApiData !== false ? ["241-0x04 row identity promotion must not emit runtime API data"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.promotionAssessment?.participantIdentity !== false ? ["241-0x04 row identity must not claim participant identity"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.promotionAssessment?.status !== "not_promoted" ? ["241-0x04 row identity must remain not_promoted"] : []),
          ...(reconstructionRowIdentity04 && reconstructionRowIdentity04.evidence?.duplicateRejectedRowCount !== duplicateRejectedRowCount(reconstructionRowIdentity04) ? ["241-0x04 row identity duplicate count mismatch"] : []),
          ...(reconstructionRowIdentity04 && !(reconstructionRowIdentity04.rowIdentity ?? []).every(rowIdentityStatusAllowed) ? ["241-0x04 row identity entries must remain rejected-or-unstable/null/non-runtime"] : []),
          ...(runtimeReconstructionRowIdentity.status !== "not_promoted" ? ["runtime artifact reconstructionRowIdentity must remain not_promoted"] : []),
          ...(runtimeReconstructionRowIdentity.runtimeInput !== false ? ["runtime artifact reconstructionRowIdentity must be non-runtime"] : []),
          ...(!(runtimeReconstructionRowIdentity.reason ?? "").includes("stable replay-only participant identity") ? ["runtime artifact reconstructionRowIdentity missing identity blocker reason"] : []),
          ...(!(artifactIdentityChecklist?.evidence ?? []).includes("rejectedCandidateArtifacts.reconstructionRowIdentity.status=not_promoted") ? ["artifact parityChecklist missing reconstruction row identity rejection evidence"] : []),
          ...(!(artifactIdentityChecklist?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity.status=not_promoted") ? ["artifact parityChecklist missing non-final participant identity field coverage evidence"] : []),
          ...(!(artifactFilteringChecklist?.evidence ?? []).includes("241-family row identity gates keep duplicate_rejected/unstable_identity rows out of runtime participantFrames") ? ["artifact parityChecklist missing row identity gate filtering evidence"] : []),
          ...(!(artifactVerificationChecklist?.evidence ?? []).includes("fieldCoverage.timelineNonFinalParticipantIdentity cross-checks rejectedCandidateArtifacts.reconstructionRowIdentity") ? ["artifact parityChecklist missing row identity cross-check verification evidence"] : []),
          ...(!(runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).some((entry) =>
            entry.familyKey === "241-0x02" &&
            entry.promotionStatus === "not_promoted" &&
            entry.runtimeApiData === false &&
            entry.participantIdentity === false &&
            entry.sameRowWinRate < 0.75 &&
            entry.minCoherence === 0.75 &&
            (entry.strongestRows ?? []).length > 0 &&
            (entry.strongestRows ?? []).every((row) => row.runtimeApiData === false && row.participantId === null) &&
            ((entry.rowStatusCounts?.duplicate_rejected ?? 0) + (entry.rowStatusCounts?.unstable_identity ?? 0)) === 10
          ) ? ["runtime artifact reconstructionRowIdentity missing rejected 241-0x02 summary"] : []),
          ...(!(runtimeReconstructionRowIdentity.rowIdentityArtifacts ?? []).some((entry) =>
            entry.familyKey === "241-0x04" &&
            entry.promotionStatus === "not_promoted" &&
            entry.runtimeApiData === false &&
            entry.participantIdentity === false &&
            entry.sameRowWinRate < 0.75 &&
            entry.minCoherence === 0.75 &&
            (entry.strongestRows ?? []).length > 0 &&
            (entry.strongestRows ?? []).every((row) => row.runtimeApiData === false && row.participantId === null) &&
            ((entry.rowStatusCounts?.duplicate_rejected ?? 0) + (entry.rowStatusCounts?.unstable_identity ?? 0)) === 10
          ) ? ["runtime artifact reconstructionRowIdentity missing rejected 241-0x04 summary"] : []),
          ...(!reconstructionRowGridCandidates ? ["row-grid candidate scan artifact missing"] : []),
          ...(reconstructionRowGridCandidates && reconstructionRowGridCandidates.schema !== "rofl-reconstruction-row-grid-candidates/v1" ? ["row-grid candidate scan schema mismatch"] : []),
          ...(reconstructionRowGridCandidates && reconstructionRowGridCandidates.runtimeInput !== false ? ["row-grid candidate scan must be non-runtime"] : []),
          ...(reconstructionRowGridCandidates && reconstructionRowGridCandidates.status !== "candidate_scan_only_not_runtime_api_data" ? ["row-grid candidate scan status mismatch"] : []),
          ...(reconstructionRowGridCandidates && (reconstructionRowGridCandidates.candidateCount ?? 0) <= 0 ? ["row-grid candidate scan has no candidates"] : []),
          ...(reconstructionRowGridCandidates && !(reconstructionRowGridCandidates.topCandidates ?? []).every((candidate) =>
            candidate.runtimeApiData === false &&
            candidate.participantIdentity === false &&
            candidate.status === "not_promoted"
          ) ? ["row-grid top candidates must remain non-runtime and not_promoted"] : []),
          ...(!reconstructionRowGridFieldAnalysis ? ["row-grid field analysis artifact missing"] : []),
          ...(reconstructionRowGridFieldAnalysis && reconstructionRowGridFieldAnalysis.schema !== "rofl-reconstruction-row-grid-field-analysis/v1" ? ["row-grid field analysis schema mismatch"] : []),
          ...(reconstructionRowGridFieldAnalysis && reconstructionRowGridFieldAnalysis.runtimeInput !== false ? ["row-grid field analysis must be non-runtime"] : []),
          ...(reconstructionRowGridFieldAnalysis && reconstructionRowGridFieldAnalysis.status !== "field_hypothesis_only_not_runtime_api_data" ? ["row-grid field analysis status mismatch"] : []),
          ...(reconstructionRowGridFieldAnalysis && (reconstructionRowGridFieldAnalysis.candidates ?? []).length <= 0 ? ["row-grid field analysis has no candidates"] : []),
          ...(reconstructionRowGridFieldAnalysis && !(reconstructionRowGridFieldAnalysis.candidates ?? []).every((candidate) =>
            candidate.runtimeApiData === false &&
            candidate.participantIdentity === false &&
            candidate.fieldPromotionAssessment?.status === "not_promoted"
          ) ? ["row-grid field candidates must remain non-runtime and not_promoted"] : []),
          ...(runtimeReconstructionRowIdentity.rowGridCandidateScan?.status !== "candidate_scan_only_not_runtime_api_data" ? ["runtime artifact reconstructionRowIdentity missing row-grid scan summary"] : []),
          ...(runtimeReconstructionRowIdentity.rowGridCandidateScan?.runtimeInput !== false ? ["runtime artifact row-grid scan summary must be non-runtime"] : []),
          ...(runtimeReconstructionRowIdentity.rowGridFieldAnalysis?.status !== "field_hypothesis_only_not_runtime_api_data" ? ["runtime artifact reconstructionRowIdentity missing row-grid field analysis summary"] : []),
          ...(runtimeReconstructionRowIdentity.rowGridFieldAnalysis?.runtimeInput !== false ? ["runtime artifact row-grid field analysis summary must be non-runtime"] : []),
          ...(!reconstructionFamilyEventCorrelation ? ["family event correlation artifact missing"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.schema !== "rofl-reconstruction-family-event-correlation/v1" ? ["family event correlation schema mismatch"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.mode !== "offline-validation-only" ? ["family event correlation mode must be offline-validation-only"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.runtimeInput !== false ? ["family event correlation must be non-runtime"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.status !== "offline_validation_only_not_runtime_api_data" ? ["family event correlation status must remain validation-only"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.promotionAssessment?.runtimeApiData !== false ? ["family event correlation promotion must not emit runtime API data"] : []),
          ...(reconstructionFamilyEventCorrelation && reconstructionFamilyEventCorrelation.promotionAssessment?.status !== "not_promoted" ? ["family event correlation must remain not_promoted"] : []),
          ...(reconstructionFamilyEventCorrelation && !reconstructionFamilyEventCorrelation.correlationMethods?.spearman?.includes("average ranks") ? ["family event correlation missing tied-rank Spearman method"] : []),
          ...(reconstructionFamilyEventCorrelation && !reconstructionFamilyEventCorrelation.correlationMethods?.pearson?.includes("normalized family rates") ? ["family event correlation missing Pearson input method"] : []),
          ...(reconstructionFamilyEventCorrelation && (reconstructionFamilyEventCorrelation.rows ?? []).length < 10 ? ["family event correlation has too few intervals"] : []),
          ...(reconstructionFamilyEventCorrelation && !(reconstructionFamilyEventCorrelation.selection?.familyKeys ?? []).includes("241-0x02") ? ["family event correlation missing 241-0x02"] : []),
          ...(reconstructionFamilyEventCorrelation && !(reconstructionFamilyEventCorrelation.selection?.familyKeys ?? []).includes("241-0x04") ? ["family event correlation missing 241-0x04"] : []),
          ...(reconstructionFamilyEventCorrelation && !(reconstructionFamilyEventCorrelation.correlations ?? []).some((row) => row.familyKey === "241-0x02" && row.category === "total") ? ["family event correlation missing 241-0x02 total correlation"] : []),
          ...(reconstructionFamilyEventCorrelation && !(reconstructionFamilyEventCorrelation.correlations ?? []).some((row) => row.familyKey === "241-0x04" && row.category === "total") ? ["family event correlation missing 241-0x04 total correlation"] : []),
          ...(!fs.existsSync(docsPath) ? ["docs/rofl-api-parity.md missing"] : []),
          ...(!docsText.includes(artifactRelativePath) ? [`docs missing ${artifactRelativePath}`] : []),
          ...(!docsText.includes(auditRelativePath) ? [`docs missing ${auditRelativePath}`] : []),
          ...(!docsText.includes(shapeGapRelativePath) ? [`docs missing ${shapeGapRelativePath}`] : []),
          ...(!docsText.includes(challengeGapRelativePath) ? [`docs missing ${challengeGapRelativePath}`] : []),
          ...(!docsText.includes(timelineReconstructionRelativePath) ? [`docs missing ${timelineReconstructionRelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetDossier02RelativePath) ? [`docs missing ${reconstructionTargetDossier02RelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetDossier04RelativePath) ? [`docs missing ${reconstructionTargetDossier04RelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetNeighborhood02RelativePath) ? [`docs missing ${reconstructionTargetNeighborhood02RelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetNeighborhood04RelativePath) ? [`docs missing ${reconstructionTargetNeighborhood04RelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetTable02RelativePath) ? [`docs missing ${reconstructionTargetTable02RelativePath}`] : []),
          ...(!docsText.includes(reconstructionTargetTable04RelativePath) ? [`docs missing ${reconstructionTargetTable04RelativePath}`] : []),
          ...(!docsText.includes(reconstructionRowIdentity02RelativePath) ? [`docs missing ${reconstructionRowIdentity02RelativePath}`] : []),
          ...(!docsText.includes(reconstructionRowIdentity04RelativePath) ? [`docs missing ${reconstructionRowIdentity04RelativePath}`] : []),
          ...(!docsText.includes(reconstructionRowGridCandidatesRelativePath) ? [`docs missing ${reconstructionRowGridCandidatesRelativePath}`] : []),
          ...(!docsText.includes(reconstructionRowGridFieldAnalysisRelativePath) ? [`docs missing ${reconstructionRowGridFieldAnalysisRelativePath}`] : []),
          ...(!docsText.includes(reconstructionFamilyEventCorrelationRelativePath) ? [`docs missing ${reconstructionFamilyEventCorrelationRelativePath}`] : []),
          ...(!docsText.includes("inspected ROFL sources") ? ["docs missing inspected ROFL sources metadata-gap wording"] : []),
          ...(!docsText.includes("npm run audit:rofl-api-shape-gap") ? ["docs missing shape gap command"] : []),
          ...(!docsText.includes("npm run audit:rofl-challenge-gaps") ? ["docs missing challenge gap command"] : []),
          ...(!docsText.includes("roflOnlyExtractionProof") ? ["docs missing roflOnlyExtractionProof section"] : []),
          ...(!docsText.includes("per-participant decoded scalar/damage metric counts") ? ["docs missing per-participant proof wording"] : []),
          ...(!docsText.includes("remainingParityGaps") ? ["docs missing remainingParityGaps section"] : []),
          ...(!docsText.includes("participant-movement-no-priors.json") ? ["docs missing no-priors movement diagnostic artifact"] : []),
          ...(!docsText.includes("assigned-movement-no-priors-validation-report.json") ? ["docs missing no-priors movement validation artifact"] : []),
          ...(!docsText.includes("npm run assign:movement") ? ["docs missing no-priors movement assignment command"] : []),
          ...(!docsText.includes("npm run validate:assigned-movement") ? ["docs missing no-priors movement validation command"] : []),
          ...(!docsText.includes("fieldCoverage.positions.noPriorsDiagnostic") ? ["docs missing fieldCoverage no-priors position diagnostic wording"] : []),
          ...(!docsText.includes("roflDerivedFieldMap.timeline[\"info.frames[].participantFrames[].position\"].noPriorsDiagnostic") ? ["docs missing field-map no-priors position diagnostic wording"] : []),
          ...(!docsText.includes("8/10 participants") ? ["docs missing no-priors 8/10 assignment result"] : []),
          ...(!docsText.includes("7/8 assigned tracks") ? ["docs missing no-priors 7/8 validation result"] : []),
          ...(!docsText.includes("Vayne TOP") ? ["docs missing Vayne TOP no-priors unmatched participant"] : []),
          ...(!docsText.includes("Malphite TOP") ? ["docs missing Malphite TOP no-priors unmatched participant"] : []),
          ...(!docsText.includes("startup-roster-token-scan.json") ? ["docs missing startup roster token scan artifact"] : []),
          ...(!docsText.includes("replay-only-startup-roster-token-diagnostic") ? ["docs missing startup roster diagnostic manifest role"] : []),
          ...(!docsText.includes("20 replays") ? ["docs missing startup roster scan 16.9 replay count"] : []),
          ...(!docsText.includes("keyframe-handle-graph-candidate-scores.json") ? ["docs missing handle graph candidate score artifact"] : []),
          ...(!docsText.includes("offline-handle-graph-row-link-diagnostic") ? ["docs missing handle graph manifest role"] : []),
          ...(!docsText.includes("260 row-link candidates") ? ["docs missing handle graph candidate count"] : []),
          ...(!docsText.includes("top score 0.333") ? ["docs missing handle graph top score"] : []),
          ...(!docsText.includes("npm run verify:rofl-api-parity") ? ["docs missing full checkpoint command"] : []),
          ...(!docsText.includes("npm run analyze:reconstruction-target-table") ? ["docs missing target table analysis command"] : []),
          ...(!docsText.includes("npm run infer:reconstruction-row-identity") ? ["docs missing row identity gate command"] : []),
          ...(!docsText.includes("npm run scan:reconstruction-row-grids") ? ["docs missing row-grid scan command"] : []),
          ...(!docsText.includes("npm run analyze:reconstruction-row-grid-fields") ? ["docs missing row-grid field analysis command"] : []),
          ...(!docsText.includes("npm run correlate:reconstruction-families-events") ? ["docs missing family event correlation command"] : []),
          ...(!docsText.includes("same-row win rate") ? ["docs missing target table coherence wording"] : []),
          ...(!docsText.includes("row identity gate") ? ["docs missing row identity gate wording"] : []),
          ...(!docsText.includes("duplicate_rejected") ? ["docs missing row duplicate rejection wording"] : []),
          ...(!docsText.includes("rejectedCandidateArtifacts.reconstructionRowIdentity") ? ["docs missing runtime reconstruction row identity rejection wording"] : []),
          ...(!docsText.includes("roflDerivedFieldMap.timeline[\"info.frames[].participantFrames[].nonFinalParticipantIdentity\"]") ? ["docs missing non-final participant identity field-map wording"] : []),
          ...(!docsText.includes("nearest-row index stability") ? ["docs missing row-grid nearest-index wording"] : []),
          ...(!docsText.includes("row-discriminator") ? ["docs missing row-grid field discriminator wording"] : []),
          ...(!docsText.includes("not promotable for participant identity") ? ["docs missing 241 participant identity non-promotion wording"] : []),
          ...(!docsText.includes("offline validation labels only") ? ["docs missing event correlation validation-only wording"] : []),
          ...(!docsText.includes("keyframes as baseline snapshots") ? ["docs missing keyframe baseline reconstruction direction"] : []),
          ...(!docsText.includes("chunk/subrecord updates between keyframes") ? ["docs missing chunk/subrecord delta reconstruction direction"] : []),
        ],
      ),
    },
    {
      requirement: "Full API-data parity from ROFL-only extraction.",
      status: fullParity?.status === "satisfied" ? "satisfied" : "not_satisfied",
      evidence: [
        `parityChecklist status=${fullParity?.status ?? "missing"}`,
        `shapeGap missing=${shapeGap?.totals?.missingLeafPathCount ?? null}`,
      ],
      gaps: [...fullParityGaps],
    },
  ];

  const missingOrIncomplete = checks.filter((check) => check.status !== "satisfied");
  const promptToArtifactChecklist = buildPromptToArtifactChecklist(checks);
  return {
    auditSchema: "rofl-api-parity-goal-audit/v1",
    generatedAtUtc: new Date().toISOString(),
    inputPath,
    replayId: artifact.source?.replayId ?? null,
    objective: "Achieve API-data parity from ROFL-only extraction.",
    successCriteria: [
      "runtime artifact is generated from ROFL metadata/statsJson without Riot API runtime input",
      "all 10 participants are present in API-shaped match and timeline structures",
      "decoded match/timeline fields identify their ROFL source and validation coverage",
      "per-participant/per-metric coverage states decoded, noisy, unstable_identity, duplicate_rejected, or not_found",
      "low-confidence keyframe candidates are rejected unless replay-only identity is stable",
      "offline Riot API fixtures are used only for validation and gap analysis",
      "latest patch 16.9 has at least one useful ROFL-only artifact and documented gaps",
      "full Riot match/timeline API parity is reached only when shape-gap and goal checks have no missing items",
    ],
    completionStatus: missingOrIncomplete.length === 0 ? "complete" : "not_complete",
    promptToArtifactChecklist,
    checks,
    missingOrIncomplete,
  };
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = resolveAbsolute(
    root,
    args.inputPath ?? path.join(artifactRoot, args.replayId, "rofl-api-metrics.json"),
  );
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(path.dirname(inputPath), "rofl-api-parity-goal-audit.json");
  const artifact = readJson(inputPath);
  const audit = buildAudit(artifact, inputPath);
  writeJson(outputPath, audit);

  console.log(`Wrote ROFL API parity goal audit to ${outputPath}`);
  console.log(`Goal completion status: ${audit.completionStatus}`);
  console.log(`Satisfied checks: ${audit.checks.length - audit.missingOrIncomplete.length}/${audit.checks.length}`);
  if (audit.missingOrIncomplete.length > 0) {
    console.log(`Open checks: ${audit.missingOrIncomplete.map((check) => check.requirement).join("; ")}`);
  }
  if (args.requireComplete && audit.completionStatus !== "complete") {
    console.log("ROFL API parity goal is not complete.");
    process.exit(2);
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
