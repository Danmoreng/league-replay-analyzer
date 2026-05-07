import path from "path";

import { clamp, readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    outputPath: null,
    topCandidates: 100,
    minReplaySupport: 2,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--top-candidates" && index + 1 < argv.length) args.topCandidates = Number.parseInt(argv[++index], 10);
    else if (arg === "--min-replay-support" && index + 1 < argv.length) args.minReplaySupport = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/score_keyframe_handle_graph_candidates.mjs [--artifact-root artifacts-keyframes] [--input-path <path>] [--output-path <path>] [--top-candidates 100] [--min-replay-support 2]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return args;
}

function objectValueCount(value) {
  return Object.keys(value ?? {}).length;
}

function normalizedEntropy(counts) {
  const values = Object.values(counts ?? {}).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length <= 1) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;

  let entropy = 0;
  for (const value of values) {
    const p = value / total;
    entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(values.length);
}

function scorePattern(pattern, corpusReplayCount) {
  const replayCoverage = clamp((pattern.replayCount ?? 0) / Math.max(1, corpusReplayCount), 0, 1);
  const assignedCoverage = clamp((pattern.assignedSourceRowReplayCount ?? 0) / Math.max(1, corpusReplayCount), 0, 1);
  const assignedWithinPattern = clamp((pattern.assignedSourceRowReplayCount ?? 0) / Math.max(1, pattern.replayCount ?? 0), 0, 1);
  const assignedRowCount = objectValueCount(pattern.assignedSourceRows);
  const assignedRowSpecificity = assignedRowCount > 0 ? 1 - clamp((assignedRowCount - 1) / 24, 0, 1) : 0;
  const sourceBreadthPenalty = clamp(((pattern.maxSourceRowCount ?? 0) - 10) / 40, 0, 1);
  const targetBreadthPenalty = clamp(((pattern.maxTargetRowCountObserved ?? 0) - 10) / 40, 0, 1);
  const assignedEntropy = normalizedEntropy(pattern.assignedSourceRows);
  const entropyPenalty = clamp(assignedEntropy, 0, 1);
  const widthBonus = pattern.width === 4 ? 0.04 : pattern.width === 8 ? 0.02 : 0;
  const selfFamilyPenalty = pattern.sourceFamilyKey === pattern.targetFamilyKey ? 0.08 : 0;

  const score = (
    (0.18 * replayCoverage) +
    (0.30 * assignedCoverage) +
    (0.20 * assignedWithinPattern) +
    (0.16 * assignedRowSpecificity) +
    widthBonus -
    (0.10 * sourceBreadthPenalty) -
    (0.10 * targetBreadthPenalty) -
    (0.08 * entropyPenalty) -
    selfFamilyPenalty
  );

  return {
    score,
    components: {
      replayCoverage,
      assignedCoverage,
      assignedWithinPattern,
      assignedRowSpecificity,
      assignedEntropy,
      sourceBreadthPenalty,
      targetBreadthPenalty,
      widthBonus,
      selfFamilyPenalty,
    },
  };
}

function confidenceLabel(entry) {
  if (entry.score >= 0.62 && entry.components.assignedRowSpecificity >= 0.75 && entry.assignedSourceRowReplayCount >= 4) return "strong";
  if (entry.score >= 0.35 && entry.assignedSourceRowReplayCount >= 2) return "investigate";
  return "weak";
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = args.inputPath
    ? resolveAbsolute(root, args.inputPath)
    : path.join(artifactRoot, "keyframe-handle-graph-corpus.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(artifactRoot, "keyframe-handle-graph-candidate-scores.json");

  const corpus = readJson(inputPath);
  const corpusReplayCount = corpus.replayCount ?? 0;
  const scored = [];
  for (const pattern of corpus.rowReferencePatternSummary ?? []) {
    if ((pattern.replayCount ?? 0) < args.minReplaySupport) continue;
    const { score, components } = scorePattern(pattern, corpusReplayCount);
    const assignedRowCount = objectValueCount(pattern.assignedSourceRows);
    scored.push({
      score,
      confidence: "weak",
      sourceFamilyKey: pattern.sourceFamilyKey,
      sourceOffset: pattern.sourceOffset,
      width: pattern.width,
      targetFamilyKey: pattern.targetFamilyKey,
      replayCount: pattern.replayCount ?? 0,
      assignedSourceRowReplayCount: pattern.assignedSourceRowReplayCount ?? 0,
      assignedRowCount,
      maxSourceRowCount: pattern.maxSourceRowCount ?? 0,
      maxTargetRowCountObserved: pattern.maxTargetRowCountObserved ?? 0,
      assignedSourceRows: pattern.assignedSourceRows ?? {},
      components,
      rationale: [
        `coverage=${components.replayCoverage.toFixed(2)}`,
        `assigned=${components.assignedCoverage.toFixed(2)}`,
        `rowSpecificity=${components.assignedRowSpecificity.toFixed(2)}`,
        `sourceBreadthPenalty=${components.sourceBreadthPenalty.toFixed(2)}`,
        `targetBreadthPenalty=${components.targetBreadthPenalty.toFixed(2)}`,
      ],
      examples: pattern.examples?.slice(0, 3) ?? [],
      assignedExamples: pattern.assignedExamples?.slice(0, 3) ?? [],
    });
  }

  scored.sort((left, right) =>
    right.score - left.score ||
    right.assignedSourceRowReplayCount - left.assignedSourceRowReplayCount ||
    right.replayCount - left.replayCount ||
    left.sourceOffset - right.sourceOffset ||
    `${left.targetFamilyKey}`.localeCompare(`${right.targetFamilyKey}`)
  );

  for (const entry of scored) {
    entry.confidence = confidenceLabel(entry);
  }

  const output = {
    generatedAtUtc: new Date().toISOString(),
    schema: "keyframe-handle-graph-candidate-scores.v1",
    inputPath,
    filters: {
      minReplaySupport: args.minReplaySupport,
      topCandidates: args.topCandidates,
      corpusFilters: corpus.filters ?? {},
    },
    replayCount: corpusReplayCount,
    supervisedAssignmentSummary: corpus.supervisedAssignmentSummary ?? null,
    candidateCount: scored.length,
    confidenceCounts: scored.reduce((counts, entry) => {
      counts[entry.confidence] = (counts[entry.confidence] ?? 0) + 1;
      return counts;
    }, {}),
    candidates: scored.slice(0, args.topCandidates),
  };

  writeJson(outputPath, output);
  console.log(`Wrote keyframe handle graph candidate scores to ${outputPath}`);
  console.log(`Scored ${scored.length} candidate pattern(s), top score ${scored[0]?.score?.toFixed(4) ?? "n/a"}.`);
}

main();
