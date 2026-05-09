#!/usr/bin/env node

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
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/analyze_startup_keyframe_row_links.mjs [--artifact-root artifacts-keyframes] [--version-group 16.9] [--output-path <path>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function readOptionalJson(filePath) {
  return fs.existsSync(filePath) ? readJson(filePath) : null;
}

function rowIdentitySummary(rowIdentityArtifacts) {
  return rowIdentityArtifacts.map((artifact) => ({
    familyKey: artifact?.familyKey ?? null,
    status: artifact?.promotionAssessment?.status ?? artifact?.status ?? "missing",
    runtimeInput: artifact?.runtimeInput ?? null,
    runtimeApiData: artifact?.promotionAssessment?.runtimeApiData ?? null,
    participantIdentity: artifact?.promotionAssessment?.participantIdentity ?? null,
    rowCount: (artifact?.rowIdentity ?? []).length,
    sameRowWinRate: artifact?.evidence?.sameRowWinRate ?? null,
    duplicateRejectedRowCount: artifact?.evidence?.duplicateRejectedRowCount ?? null,
    rowStatusCounts: (artifact?.rowIdentity ?? []).reduce((counts, row) => {
      counts[row.status ?? "unknown"] = (counts[row.status ?? "unknown"] ?? 0) + 1;
      return counts;
    }, {}),
  }));
}

function summarizeStartupCandidates(startupScan, versionGroup) {
  const candidates = (startupScan?.candidates ?? [])
    .filter((candidate) => candidate.versionGroup === versionGroup)
    .filter((candidate) => ["participantId", "rosterOrdinal", "rosterIndex", "teamId", "championId"].includes(candidate.kind))
    .sort((left, right) =>
      (right.replayCount ?? 0) - (left.replayCount ?? 0) ||
      (right.hitCount ?? 0) - (left.hitCount ?? 0) ||
      `${left.kind}`.localeCompare(`${right.kind}`) ||
      Number(left.offset ?? 0) - Number(right.offset ?? 0)
    );
  return candidates.slice(0, 12).map((candidate) => ({
    kind: candidate.kind,
    width: candidate.width,
    offset: candidate.offset,
    replayCount: candidate.replayCount ?? 0,
    hitCount: candidate.hitCount ?? 0,
    participantOrdinalDelta: candidate.participantOrdinalDelta ?? null,
    exampleCount: (candidate.examples ?? []).length,
  }));
}

function summarizeHandleGraph(handleGraph) {
  const candidates = handleGraph?.candidates ?? [];
  return {
    schema: handleGraph?.schema ?? "missing",
    replayCount: handleGraph?.replayCount ?? 0,
    candidateCount: handleGraph?.candidateCount ?? candidates.length,
    confidenceCounts: handleGraph?.confidenceCounts ?? {},
    strongestConfidence: candidates[0]?.confidence ?? null,
    strongestScore: candidates[0]?.score ?? null,
    strongestCandidate: candidates[0]
      ? {
          sourceFamilyKey: candidates[0].sourceFamilyKey,
          sourceOffset: candidates[0].sourceOffset,
          width: candidates[0].width,
          targetFamilyKey: candidates[0].targetFamilyKey,
          replayCount: candidates[0].replayCount,
          assignedSourceRowReplayCount: candidates[0].assignedSourceRowReplayCount,
          assignedRowCount: candidates[0].assignedRowCount,
        }
      : null,
  };
}

function summarizeKeyframeIdentifierTokens(identifierScan, versionGroup) {
  const candidates = (identifierScan?.candidates ?? [])
    .filter((candidate) => candidate.versionGroup === versionGroup)
    .sort((left, right) =>
      (right.hitRate ?? 0) - (left.hitRate ?? 0) ||
      (right.hitRows ?? 0) - (left.hitRows ?? 0) ||
      `${left.tokenKind}`.localeCompare(`${right.tokenKind}`)
    );
  const rosterOrderKinds = new Set(["participantId", "rosterIndex", "rosterOrdinal", "teamId", "championId"]);
  const rosterOrderCandidates = candidates.filter((candidate) => rosterOrderKinds.has(candidate.tokenKind));
  return {
    schema: identifierScan ? "keyframe-identifier-token-scan" : "missing",
    stableOnly: identifierScan?.stableOnly ?? null,
    scannedRows: identifierScan?.scannedRows ?? 0,
    candidateCount: candidates.length,
    rosterOrderCandidateCount: rosterOrderCandidates.length,
    thresholds: identifierScan?.thresholds ?? null,
    topCandidates: candidates.slice(0, 8).map((candidate) => ({
      familyKey: candidate.familyKey ?? null,
      offset: candidate.offset ?? null,
      decodeLabel: candidate.decodeLabel ?? null,
      valueSource: candidate.valueSource ?? null,
      tokenKind: candidate.tokenKind ?? null,
      comparableRows: candidate.comparableRows ?? null,
      hitRows: candidate.hitRows ?? null,
      replayCount: candidate.replayCount ?? null,
      hitRate: candidate.hitRate ?? null,
    })),
  };
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(artifactRoot, `startup-keyframe-row-link-diagnostic-${args.versionGroup}.json`);

  const startupScanPath = path.join(artifactRoot, "startup-roster-token-scan.json");
  const keyframeIdentifierTokenScanPath = path.join(artifactRoot, "keyframe-identifier-token-scan.json");
  const handleGraphPath = path.join(artifactRoot, "keyframe-handle-graph-candidate-scores.json");
  const rowIdentityPaths = [
    path.join(artifactRoot, `reconstruction-row-identity-241-0x02-${args.versionGroup}.json`),
    path.join(artifactRoot, `reconstruction-row-identity-241-0x04-${args.versionGroup}.json`),
  ];

  const startupScan = readOptionalJson(startupScanPath);
  const keyframeIdentifierTokenScan = readOptionalJson(keyframeIdentifierTokenScanPath);
  const handleGraph = readOptionalJson(handleGraphPath);
  const rowIdentityArtifacts = rowIdentityPaths.map(readOptionalJson).filter(Boolean);
  const startupCandidates = summarizeStartupCandidates(startupScan, args.versionGroup);
  const handleSummary = summarizeHandleGraph(handleGraph);
  const keyframeIdentifierSummary = summarizeKeyframeIdentifierTokens(keyframeIdentifierTokenScan, args.versionGroup);
  const rowSummaries = rowIdentitySummary(rowIdentityArtifacts);
  const fullCorpusStartupCandidateCount = startupCandidates.filter((candidate) =>
    candidate.replayCount === 20 &&
    ["participantId", "rosterOrdinal", "rosterIndex"].includes(candidate.kind)
  ).length;

  const assessment = {
    startupRosterOrderTokens: startupCandidates.length > 0 ? "present" : "not_found",
    keyframeRosterOrderTokens: keyframeIdentifierSummary.rosterOrderCandidateCount > 0 ? "present_needs_review" : "not_found",
    directStartupToKeyframeRowLink: "not_found",
    rowIdentityGate: rowSummaries.every((entry) => entry.status === "not_promoted") ? "blocked" : "review",
    handleGraphGate: handleSummary.strongestConfidence === "weak" ? "blocked" : "review",
    runtimePromotion: "blocked",
  };

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "startup-keyframe-row-link-diagnostic/v1",
    versionGroup: args.versionGroup,
    mode: "offline-linkage-diagnostic",
    status: "not_promoted",
    runtimeInput: false,
    runtimeApiData: false,
    inputPaths: {
      startupRosterTokenScan: startupScanPath,
      keyframeIdentifierTokenScan: keyframeIdentifierTokenScanPath,
      handleGraphCandidateScores: handleGraphPath,
      rowIdentityArtifacts: rowIdentityPaths,
    },
    assessment,
    blockerSummary: [
      `startupRosterOrderCandidateCount=${startupCandidates.length}`,
      `fullCorpusStartupRosterOrderCandidateCount=${fullCorpusStartupCandidateCount}`,
      `keyframeRosterOrderTokenCandidateCount=${keyframeIdentifierSummary.rosterOrderCandidateCount}`,
      "directStartupToKeyframeRowLink=not_found",
      `rowIdentityGate=${assessment.rowIdentityGate}`,
      `handleGraphGate=${assessment.handleGraphGate}`,
    ],
    startupRosterOrderCandidates: startupCandidates,
    keyframeIdentifierTokenScan: keyframeIdentifierSummary,
    keyframeRowIdentity: rowSummaries,
    handleGraphRowLinks: handleSummary,
    nextDecoderStep: "Find a replay-only record edge that carries startup roster/order tokens into a keyframe row family with stable 10-row participant identity.",
  };

  writeJson(outputPath, output);
  console.log(`Wrote startup/keyframe row-link diagnostic to ${outputPath}`);
  console.log(`startup candidates=${startupCandidates.length}, row gates=${rowSummaries.length}, handle confidence=${handleSummary.strongestConfidence ?? "missing"}`);
}

main();
