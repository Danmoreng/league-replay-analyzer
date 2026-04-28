import fs from "fs";
import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    schemaPath: null,
    outputPath: null,
    topSlots: 32,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--schema-path" && index + 1 < argv.length) {
      args.schemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--top-slots" && index + 1 < argv.length) {
      args.topSlots = Number.parseInt(argv[++index], 10);
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
  console.log("Usage: node ./scripts/diagnose_keyframe_slot_conflicts.mjs [--artifact-root <path>] [--schema-path <path>] [--output-path <path>] [--top-slots <count>]");
}

function candidateSource(schema) {
  const byKey = new Map();
  for (const candidate of schema.promotedParticipantStateSlotCandidates ?? []) {
    byKey.set(candidate.key, candidate);
  }
  for (const candidate of schema.promotedParticipantSlotCandidates ?? []) {
    byKey.set(candidate.key, candidate);
  }
  for (const candidate of schema.rankedParticipantIdentityCandidates ?? schema.rankedParticipantSlotCandidates ?? []) {
    byKey.set(candidate.key, candidate);
  }
  return [...byKey.values()];
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    if (value == null) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || String(left.key).localeCompare(String(right.key)));
}

function compactCandidate(candidate) {
  const ambiguousExamples = (candidate.examples ?? []).filter((example) => !example.unambiguous);
  const participantIds = countBy((candidate.examples ?? []).map((example) => example.participantId));
  const champions = countBy((candidate.examples ?? []).map((example) => example.champion));
  return {
    key: candidate.key,
    versionGroup: candidate.versionGroup,
    familyKey: candidate.familyKey,
    slotIndex: candidate.slotIndex,
    statePromoted: candidate.statePromoted,
    identityPromoted: candidate.identityPromoted,
    supportReplayCount: candidate.supportReplayCount,
    unambiguousSupportReplayCount: candidate.unambiguousSupportReplayCount,
    ambiguousReplayCount: candidate.ambiguousReplayCount,
    stateStrongReplayCount: candidate.stateStrongReplayCount,
    strongReplayCount: candidate.strongReplayCount,
    identityStrongReplayCount: candidate.identityStrongReplayCount,
    stateAvgMetricCount: candidate.stateAvgMetricCount,
    stateAvgIdentityWeight: candidate.stateAvgIdentityWeight,
    stateAvgIdentityMetricCount: candidate.stateAvgIdentityMetricCount,
    stateAvgGenericMetricCount: candidate.stateAvgGenericMetricCount,
    stateAvgCorrelation: candidate.stateAvgCorrelation,
    stateAvgNormalizedRmse: candidate.stateAvgNormalizedRmse,
    avgMetricCount: candidate.avgMetricCount,
    avgIdentityWeight: candidate.avgIdentityWeight,
    avgIdentityMetricCount: candidate.avgIdentityMetricCount,
    avgGenericMetricCount: candidate.avgGenericMetricCount,
    avgCorrelation: candidate.avgCorrelation,
    avgNormalizedRmse: candidate.avgNormalizedRmse,
    stateMetrics: candidate.stateMetrics,
    metrics: candidate.metrics,
    participantIds: participantIds.slice(0, 8),
    champions: champions.slice(0, 8),
    ambiguousReplays: (candidate.ambiguousReplays ?? []).slice(0, 16),
    ambiguousExamples: ambiguousExamples.slice(0, 8),
  };
}

function buildDiagnostics(schema, topSlots) {
  const candidates = candidateSource(schema);
  const conflicted = candidates
    .filter((candidate) => (candidate.ambiguousReplayCount ?? 0) > 0)
    .sort((left, right) =>
      (right.ambiguousReplayCount ?? 0) - (left.ambiguousReplayCount ?? 0) ||
      (right.supportReplayCount ?? 0) - (left.supportReplayCount ?? 0) ||
      (right.avgIdentityWeight ?? 0) - (left.avgIdentityWeight ?? 0) ||
      left.key.localeCompare(right.key),
    );

  const statePromoted = candidates.filter((candidate) => candidate.statePromoted);
  const identityPromoted = candidates.filter((candidate) => candidate.identityPromoted ?? candidate.promoted);
  const ambiguousStatePromoted = statePromoted.filter((candidate) => (candidate.ambiguousReplayCount ?? 0) > 0);
  const nearIdentity = candidates
    .filter((candidate) => !candidate.identityPromoted)
    .filter((candidate) => (candidate.identityStrongReplayCount ?? 0) > 0 || (candidate.unambiguousSupportReplayCount ?? 0) > 0)
    .sort((left, right) =>
      (right.identityStrongReplayCount ?? 0) - (left.identityStrongReplayCount ?? 0) ||
      (right.unambiguousSupportReplayCount ?? 0) - (left.unambiguousSupportReplayCount ?? 0) ||
      (right.avgIdentityWeight ?? 0) - (left.avgIdentityWeight ?? 0) ||
      left.key.localeCompare(right.key),
    );

  return {
    generatedAtUtc: new Date().toISOString(),
    sourceSchemaGeneratedAtUtc: schema.generatedAtUtc ?? null,
    thresholds: schema.thresholds ?? null,
    replayCount: schema.replayCount ?? null,
    summary: {
      candidateCount: candidates.length,
      statePromotedSlotCount: statePromoted.length,
      identityPromotedSlotCount: identityPromoted.length,
      conflictedSlotCount: conflicted.length,
      ambiguousStatePromotedSlotCount: ambiguousStatePromoted.length,
      nearIdentitySlotCount: nearIdentity.length,
    },
    topConflictedSlots: conflicted.slice(0, topSlots).map(compactCandidate),
    ambiguousStatePromotedSlots: ambiguousStatePromoted.slice(0, topSlots).map(compactCandidate),
    nearIdentitySlots: nearIdentity.slice(0, topSlots).map(compactCandidate),
  };
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const schemaPath = args.schemaPath
    ? resolveAbsolute(repoRoot, args.schemaPath)
    : path.join(artifactRoot, "keyframe-parity-schema.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(artifactRoot, "keyframe-slot-conflicts.json");

  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Keyframe parity schema not found at ${schemaPath}. Run build_keyframe_parity_schema.mjs first.`);
  }

  const schema = readJson(schemaPath);
  const diagnostics = buildDiagnostics(schema, args.topSlots);
  writeJson(outputPath, diagnostics);

  console.log(`Wrote keyframe slot conflict diagnostics to ${outputPath}`);
  console.log(`state-promoted slots: ${diagnostics.summary.statePromotedSlotCount}`);
  console.log(`identity-promoted slots: ${diagnostics.summary.identityPromotedSlotCount}`);
  console.log(`conflicted slots: ${diagnostics.summary.conflictedSlotCount}`);
  console.log(`near-identity slots: ${diagnostics.summary.nearIdentitySlotCount}`);
}

main();
