import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    inputPath: null,
    expectedReplayCount: 20,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) args.artifactRoot = argv[++index];
    else if (arg === "--input-path" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (arg === "--expected-replay-count" && index + 1 < argv.length) args.expectedReplayCount = Number.parseInt(argv[++index], 10);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/verify_keyframe_handle_graph_scores.mjs [--artifact-root artifacts-keyframes] [--input-path <path>] [--expected-replay-count 20]");
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.expectedReplayCount) || args.expectedReplayCount <= 0) {
    throw new Error("--expected-replay-count must be a positive integer.");
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message, details = undefined) {
  if (!condition) {
    const suffix = details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.resolve(args.inputPath ?? path.join(args.artifactRoot, "keyframe-handle-graph-candidate-scores.json"));
  const artifact = readJson(inputPath);

  assert(artifact.schema === "keyframe-handle-graph-candidate-scores.v1", "Unexpected handle graph score schema", artifact.schema);
  assert(artifact.replayCount === args.expectedReplayCount, "Unexpected handle graph replay count", {
    expected: args.expectedReplayCount,
    actual: artifact.replayCount,
  });
  assert(artifact.candidateCount > 0, "Handle graph scorecard must contain candidates", artifact);
  assert((artifact.candidates ?? []).length > 0, "Handle graph scorecard must expose top candidates", artifact);
  assert(artifact.confidenceCounts?.weak === artifact.candidateCount, "Current handle graph candidates must remain weak until promotion review", artifact.confidenceCounts);
  assert((artifact.confidenceCounts?.strong ?? 0) === 0 && (artifact.confidenceCounts?.investigate ?? 0) === 0, "Handle graph scorecard unexpectedly has promotable candidates", artifact.confidenceCounts);

  const top = artifact.candidates[0];
  assert(top.confidence === "weak" && top.score < 0.35, "Top handle graph candidate should remain below investigate threshold", top);
  assert((top.promotionBlockers ?? []).some((blocker) => String(blocker).includes("investigateAssignedReplaySupportBelowThreshold")), "Top handle graph candidate must document low assigned replay support", top);

  const nearMiss = artifact.nearMissSummary;
  assert(nearMiss?.status === "no_promotable_handle_graph_candidate" && nearMiss?.runtimeApiData === false, "Handle graph near-miss summary must be non-promoted and non-runtime", nearMiss);
  assert(nearMiss.topCandidate?.score === top.score && nearMiss.topCandidate?.targetFamilyKey === top.targetFamilyKey, "Near-miss top candidate must mirror the top scored candidate", {
    nearMissTop: nearMiss.topCandidate,
    top,
  });
  assert((nearMiss.topCandidate?.blockers ?? []).some((blocker) => String(blocker).includes("investigateAssignedReplaySupportBelowThreshold")), "Near-miss top candidate must preserve assigned support blocker", nearMiss.topCandidate);
  assert((nearMiss.highCoverageButDiffuseCandidates ?? []).some((candidate) =>
    (candidate.assignedSourceRowReplayCount ?? 0) >= 10 &&
    (candidate.assignedRowCount ?? 0) >= 30 &&
    (candidate.blockers ?? []).some((blocker) => String(blocker).includes("assignedRowEntropyHigh"))
  ), "Near-miss summary must preserve high-coverage diffuse-row blocker evidence", nearMiss.highCoverageButDiffuseCandidates);

  console.log(`Verified keyframe handle graph scorecard: ${inputPath}`);
  console.log(`candidates=${artifact.candidateCount}, topScore=${top.score}, topConfidence=${top.confidence}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
