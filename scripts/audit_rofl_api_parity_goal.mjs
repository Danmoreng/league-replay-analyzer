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
  const artifactRelativePath = path.relative(process.cwd(), inputPath).replaceAll("\\", "/");
  const auditRelativePath = path.relative(process.cwd(), path.join(path.dirname(inputPath), "rofl-api-parity-goal-audit.json")).replaceAll("\\", "/");
  const shapeGapRelativePath = path.relative(process.cwd(), shapeGapPath).replaceAll("\\", "/");
  const challengeGapRelativePath = path.relative(process.cwd(), challengeGapPath).replaceAll("\\", "/");
  const identityCorpusPath = path.join(process.cwd(), "artifacts-keyframes", "keyframe-rofl-stat-slot-assignments-16.9.json");
  const identityCorpus = readOptionalJson(identityCorpusPath);
  const identityThresholdSweepPath = path.join(process.cwd(), "artifacts-keyframes", "keyframe-rofl-stat-support-threshold-sweep-16.9.json");
  const identityThresholdSweep = readOptionalJson(identityThresholdSweepPath);
  const runtimeRiotApiReferences = findRuntimeRiotApiReferences(artifact);
  const byRequirement = checklistByRequirement(artifact);
  const fullParity = byRequirement.get("Full API data parity from ROFL-only extraction.");
  const fullParityGaps = new Set(fullParity?.gaps ?? []);
  const sourceInputClasses = artifact.source?.inputClasses ?? {};
  const nonFinalIdentity = artifact.rejectedCandidateArtifacts?.nonFinalScalarIdentity;
  const rejectedCandidates = artifact.rejectedCandidateArtifacts ?? {};
  const identityLinkage = artifact.identityLinkage ?? {};
  const roflDerivedFieldMap = artifact.roflDerivedFieldMap ?? {};
  const fieldCoverage = artifact.fieldCoverage ?? {};
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
    row.metricStatusCounts?.decoded === 6 &&
    row.metricStatusCounts?.not_found === 5 &&
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
          artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles === false &&
          sourceInputClasses.riotApiFixtures?.class === "offline-validation-only" &&
          runtimeRiotApiReferences.length === 0,
        [
          "artifactSchema=rofl-api-parity-checkpoint/v1",
          "extractionMode=rofl-only-final-stats",
          "match.metadata and match.info exist",
          "timeline.metadata and timeline.info exist",
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
          artifact.totals?.roflOnlyFinalMetricSeriesCount === 60 &&
          artifact.totals?.emittedMetricPointCount === 60,
        [
          `final frame participantFrames=${finalParticipantFrameCount}`,
          `timeline.info.frames.length=${timelineFrames.length}`,
          `timeline final participantFrames=${finalParticipantFrames.length}`,
          `timeline final events array=${Array.isArray(finalTimelineFrame?.events)}`,
          `participantFrames include championStats/damageStats=${finalParticipantFramesHaveApiContainers}`,
          `roflOnlyFinalMetricSeriesCount=${artifact.totals?.roflOnlyFinalMetricSeriesCount}`,
          `emittedMetricPointCount=${artifact.totals?.emittedMetricPointCount}`,
          `fieldMap timeline currentGold=${roflDerivedFieldMap.timeline?.["info.frames[].participantFrames[].currentGold"]?.calibration ?? null}`,
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
        `metricSet=${nonFinalIdentity?.assignmentArtifact?.metricSet ?? null}`,
        `identity corpus path=${identityCorpusPath}`,
        `identity corpus analyzedReplayCount=${identityCorpus?.analyzedReplayCount ?? null}`,
        `identity corpus assignmentCount=${identityCorpus?.totals?.assignmentCount ?? null}`,
        `identity corpus canonicalCandidateCount=${identityCorpus?.totals?.confidence?.canonicalCandidateCount ?? null}`,
        `identity corpus rejectionSummary.status=${identityCorpus?.totals?.rejectionSummary?.status ?? null}`,
        `identity corpus rejectionSummary.primaryBlockers=${(identityCorpus?.totals?.rejectionSummary?.primaryBlockers ?? []).join(",")}`,
        `identity corpus rejectionSummary.metrics=${Object.keys(identityCorpus?.totals?.rejectionSummary?.byMetric ?? {}).join(",")}`,
        `identity threshold sweep path=${identityThresholdSweepPath}`,
        `identity threshold sweep schema=${identityThresholdSweep?.sweepSchema ?? null}`,
        `identity threshold sweep rows=${(identityThresholdSweep?.rows ?? []).length}`,
        `identity threshold sweep assignments=${JSON.stringify((identityThresholdSweep?.rows ?? []).map((row) => [row.minSupportScore, row.assignmentCount]))}`,
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
      ],
      gaps: [
        "accepted replay-only non-final keyframe participant identity is not available yet",
        ...(identityThresholdSweep?.sweepSchema === "rofl-keyframe-stat-support-threshold-sweep/v1" ? [] : ["identity threshold sweep schema missing or unsupported"]),
      ],
    },
    {
      requirement: "Filter noisy candidates with metric-specific gates and avoid exposing low-confidence affine artifacts.",
      ...pass(
        (artifact.totals?.researchKeyframeMetricSeriesCount ?? 0) === 0 &&
          nonFinalIdentity?.assignmentArtifact?.thresholds?.minSupportScore != null &&
          nonFinalIdentity?.assignmentArtifact?.canonicalCandidateCount === 0 &&
          rejectedCandidates.positions != null &&
          rejectedCandidates.itemEvents != null &&
          rejectedCandidates.inventoryTimeline != null &&
          rejectedCandidates.damageTimeline != null,
        [
          `researchKeyframeMetricSeriesCount=${artifact.totals?.researchKeyframeMetricSeriesCount ?? 0}`,
          `minSupportScore=${nonFinalIdentity?.assignmentArtifact?.thresholds?.minSupportScore ?? null}`,
          `canonicalCandidateCount=${nonFinalIdentity?.assignmentArtifact?.canonicalCandidateCount ?? null}`,
          `positions.status=${rejectedCandidates.positions?.status ?? null}`,
          `itemEvents.status=${rejectedCandidates.itemEvents?.status ?? null}`,
          `inventoryTimeline.status=${rejectedCandidates.inventoryTimeline?.status ?? null}`,
          `damageTimeline.status=${rejectedCandidates.damageTimeline?.status ?? null}`,
        ],
        [
          ...(!rejectedCandidates.positions ? ["missing position rejection evidence"] : []),
          ...(!rejectedCandidates.itemEvents ? ["missing item-event rejection evidence"] : []),
          ...(!rejectedCandidates.inventoryTimeline ? ["missing inventory timeline rejection evidence"] : []),
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
          validation?.validationSchema === "rofl-api-metrics-riot-validation/v1" &&
          validation?.mode === "offline-validation-only" &&
          validation?.replayId === artifact.source?.replayId &&
          validation?.inputPath === inputPath &&
          validation?.validatedArtifact?.runtimeRiotApiFiles === false &&
          validation?.validatedArtifact?.decoderArtifactSupervised === false &&
          (validation?.totals?.identifierComparisonCount ?? 0) >= 22 &&
          validation?.totals?.identifierPassCount === 0 &&
          (validation?.totals?.finalTimelineComparisonCount ?? 0) >= 120 &&
          validation?.totals?.finalTimelinePassCount === validation?.totals?.finalTimelineComparisonCount &&
          shapeGap?.shapeGapSchema === "rofl-api-shape-gap-report/v1" &&
          shapeGap?.mode === "offline-validation-only" &&
          shapeGap?.runtimeInput === false &&
          challengeGap?.challengeGapCandidateSchema === "rofl-challenge-gap-candidates/v1" &&
          challengeGap?.mode === "offline-analysis-only" &&
          challengeGap?.runtimeInput === false &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "timeline-events")) &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "participant-challenges")) &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-event-flags")) &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-account-profile")) &&
          (shapeGap?.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "team-bans")) &&
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
          ...(!shapeGap ? ["offline shape gap report missing"] : []),
          ...(!challengeGap ? ["offline challenge gap report missing"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "timeline-events")) ? ["shape gap report missing timeline-events category"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "participant-challenges")) ? ["shape gap report missing participant-challenges category"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-event-flags")) ? ["shape gap report missing match-participant-event-flags category"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "match-participant-account-profile")) ? ["shape gap report missing match-participant-account-profile category"] : []),
          ...(shapeGap && !(shapeGap.sections ?? []).some((section) => (section.missingCategories ?? []).some((entry) => entry.category === "team-bans")) ? ["shape gap report missing team-bans category"] : []),
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
          ...(validation && (validation.totals?.finalTimelineComparisonCount ?? 0) < 120 ? ["validation final timeline damage comparison coverage is below expected coverage"] : []),
          ...(validation && validation.totals?.finalTimelinePassCount !== validation.totals?.finalTimelineComparisonCount ? ["validation final timeline damage parity failed"] : []),
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
          (matchTeamGaps.decodedTeamFields ?? []).includes("info.teams[].objectives.*.kills") &&
          docsText.includes(artifactRelativePath) &&
          docsText.includes(auditRelativePath) &&
          docsText.includes(shapeGapRelativePath) &&
          docsText.includes(challengeGapRelativePath) &&
          docsText.includes("inspected ROFL sources") &&
          docsText.includes("npm run audit:rofl-api-shape-gap") &&
          docsText.includes("npm run audit:rofl-challenge-gaps") &&
          docsText.includes("npm run verify:rofl-api-parity"),
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
          `fieldCoverage.matchTeamGaps.decodedTeamFields=${(matchTeamGaps.decodedTeamFields ?? []).join(",")}`,
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
          ...(!(matchTeamGaps.decodedTeamFields ?? []).includes("info.teams[].objectives.*.kills") ? ["fieldCoverage.matchTeamGaps does not distinguish decoded objective kills"] : []),
          ...(!fs.existsSync(docsPath) ? ["docs/rofl-api-parity.md missing"] : []),
          ...(!docsText.includes(artifactRelativePath) ? [`docs missing ${artifactRelativePath}`] : []),
          ...(!docsText.includes(auditRelativePath) ? [`docs missing ${auditRelativePath}`] : []),
          ...(!docsText.includes(shapeGapRelativePath) ? [`docs missing ${shapeGapRelativePath}`] : []),
          ...(!docsText.includes(challengeGapRelativePath) ? [`docs missing ${challengeGapRelativePath}`] : []),
          ...(!docsText.includes("inspected ROFL sources") ? ["docs missing inspected ROFL sources metadata-gap wording"] : []),
          ...(!docsText.includes("npm run audit:rofl-api-shape-gap") ? ["docs missing shape gap command"] : []),
          ...(!docsText.includes("npm run audit:rofl-challenge-gaps") ? ["docs missing challenge gap command"] : []),
          ...(!docsText.includes("npm run verify:rofl-api-parity") ? ["docs missing full checkpoint command"] : []),
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
  return {
    auditSchema: "rofl-api-parity-goal-audit/v1",
    generatedAtUtc: new Date().toISOString(),
    inputPath,
    replayId: artifact.source?.replayId ?? null,
    objective: "Achieve API-data parity from ROFL-only extraction.",
    completionStatus: missingOrIncomplete.length === 0 ? "complete" : "not_complete",
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
