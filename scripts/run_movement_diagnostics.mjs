#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: "16.9",
    replayListPath: null,
    outputPath: null,
    summaryOutputPath: null,
    skipDefault: false,
    skipNoPriors: false,
    skipMinScoreProbe: false,
    skipStrictReplayOnly: false,
    skipStrictMinScoreProbe: false,
    skipTopOwnerProbes: false,
    skipDuplicateEntityProbe: false,
    skipMaxPatternProbe: false,
    skipSupplementedMaxPatternProbe: false,
    skipCandidateSupplementedMaxPatternProbe: false,
    skipCurrentMax128PatternProbe: false,
    skipCurrentMax128ReducedRoleProbe: false,
    minScoreProbe: 0.46,
    strictMinScoreProbe: 0.44,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--replay-list-path" && index + 1 < argv.length) {
      args.replayListPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--summary-output-path" && index + 1 < argv.length) {
      args.summaryOutputPath = argv[++index];
    } else if (arg === "--min-score-probe" && index + 1 < argv.length) {
      args.minScoreProbe = Number(argv[++index]);
    } else if (arg === "--strict-min-score-probe" && index + 1 < argv.length) {
      args.strictMinScoreProbe = Number(argv[++index]);
    } else if (arg === "--skip-default") {
      args.skipDefault = true;
    } else if (arg === "--skip-no-priors") {
      args.skipNoPriors = true;
    } else if (arg === "--skip-min-score-probe") {
      args.skipMinScoreProbe = true;
    } else if (arg === "--skip-strict-replay-only") {
      args.skipStrictReplayOnly = true;
    } else if (arg === "--skip-strict-min-score-probe") {
      args.skipStrictMinScoreProbe = true;
    } else if (arg === "--skip-top-owner-probes") {
      args.skipTopOwnerProbes = true;
    } else if (arg === "--skip-duplicate-entity-probe") {
      args.skipDuplicateEntityProbe = true;
    } else if (arg === "--skip-max-pattern-probe") {
      args.skipMaxPatternProbe = true;
    } else if (arg === "--skip-supplemented-max-pattern-probe") {
      args.skipSupplementedMaxPatternProbe = true;
    } else if (arg === "--skip-candidate-supplemented-max-pattern-probe") {
      args.skipCandidateSupplementedMaxPatternProbe = true;
    } else if (arg === "--skip-current-max128-pattern-probe") {
      args.skipCurrentMax128PatternProbe = true;
    } else if (arg === "--skip-current-max128-reduced-role-probe") {
      args.skipCurrentMax128ReducedRoleProbe = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.minScoreProbe) || args.minScoreProbe < 0 || args.minScoreProbe > 1) {
    throw new Error(`Invalid --min-score-probe value: ${args.minScoreProbe}`);
  }
  if (!Number.isFinite(args.strictMinScoreProbe) || args.strictMinScoreProbe < 0 || args.strictMinScoreProbe > 1) {
    throw new Error(`Invalid --strict-min-score-probe value: ${args.strictMinScoreProbe}`);
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/run_movement_diagnostics.mjs [--version-group 16.9] [--artifact-root artifacts] [--replay-list-path <path>] [--output-path <path>] [--summary-output-path <path>] [--min-score-probe 0.46] [--strict-min-score-probe 0.44] [--skip-default] [--skip-no-priors] [--skip-min-score-probe] [--skip-strict-replay-only] [--skip-strict-min-score-probe] [--skip-top-owner-probes] [--skip-duplicate-entity-probe] [--skip-max-pattern-probe] [--skip-supplemented-max-pattern-probe] [--skip-candidate-supplemented-max-pattern-probe] [--skip-current-max128-pattern-probe] [--skip-current-max128-reduced-role-probe]");
}

function runNode(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`${scriptPath} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

function replayListPathForVersion(versionGroup) {
  return path.join("artifacts-keyframes", `keyframe-rofl-stat-slot-assignments-${versionGroup}.json`);
}

function discoverReplayIds(args) {
  const replayListPath = args.replayListPath ?? replayListPathForVersion(args.versionGroup);
  const resolvedReplayListPath = resolveAbsolute(process.cwd(), replayListPath);
  if (fs.existsSync(resolvedReplayListPath)) {
    const replayList = readJson(resolvedReplayListPath);
    return (replayList.replays ?? [])
      .filter((replay) => !replay.skipped)
      .map((replay) => replay.replayId)
      .filter(Boolean)
      .sort();
  }

  const artifactRoot = resolveAbsolute(process.cwd(), args.artifactRoot);
  return fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function existingArtifactDir(artifactRoot, replayId) {
  const artifactDir = path.join(artifactRoot, replayId);
  return fs.existsSync(path.join(artifactDir, "extracted-movement.json")) ? artifactDir : null;
}

function scoreLabel(score) {
  return String(score);
}

function runAssignAndValidate({ artifactDir, movementOutputPath, validationOutputPath, assignArgs = [] }) {
  runNode(path.join("scripts", "assign_replay_movement.mjs"), [
    "--artifact-dir",
    artifactDir,
    "--output-path",
    movementOutputPath,
    ...assignArgs,
  ]);
  runNode(path.join("scripts", "validate_assigned_movement.mjs"), [
    "--participant-movement-path",
    movementOutputPath,
    "--output-path",
    validationOutputPath,
  ]);
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const replayIds = discoverReplayIds(args);
  const rows = [];

  for (const replayId of replayIds) {
    const artifactDir = existingArtifactDir(artifactRoot, replayId);
    if (!artifactDir) {
      rows.push({
        replayId,
        status: "skipped",
        reason: "missing extracted-movement.json",
      });
      continue;
    }

    const row = {
      replayId,
      status: "processed",
      diagnostics: [],
    };

    if (!args.skipDefault) {
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, "participant-movement.json"),
        validationOutputPath: path.join(artifactDir, "assigned-movement-validation-report.json"),
      });
      row.diagnostics.push("default");
    }

    if (!args.skipNoPriors) {
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, "participant-movement-no-priors-probe.json"),
        validationOutputPath: path.join(artifactDir, "assigned-movement-no-priors-probe-validation-report.json"),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
        ],
      });
      row.diagnostics.push("no-priors");
    }

    if (!args.skipMinScoreProbe) {
      const minScoreLabel = scoreLabel(args.minScoreProbe);
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, `participant-movement-no-priors-min${minScoreLabel}-probe.json`),
        validationOutputPath: path.join(artifactDir, `assigned-movement-no-priors-min${minScoreLabel}-probe-validation-report.json`),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--min-assignment-score",
          String(args.minScoreProbe),
        ],
      });
      row.diagnostics.push(`no-priors-min${args.minScoreProbe}`);
    }

    if (!args.skipStrictReplayOnly) {
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, "participant-movement-strict-replay-only-probe.json"),
        validationOutputPath: path.join(artifactDir, "assigned-movement-strict-replay-only-probe-validation-report.json"),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--ignore-support-hypotheses",
        ],
      });
      row.diagnostics.push("strict-replay-only");
    }

    if (!args.skipStrictMinScoreProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-probe.json`),
        validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-probe-validation-report.json`),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--ignore-support-hypotheses",
          "--min-assignment-score",
          String(args.strictMinScoreProbe),
        ],
      });
      row.diagnostics.push(`strict-min${args.strictMinScoreProbe}`);
    }

    if (!args.skipTopOwnerProbes) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, "participant-movement-strict-top-owner-probe.json"),
        validationOutputPath: path.join(artifactDir, "assigned-movement-strict-top-owner-probe-validation-report.json"),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--ignore-support-hypotheses",
          "--prefer-top-entity-owner",
        ],
      });
      row.diagnostics.push("strict-top-owner");

      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-top-owner-probe.json`),
        validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-top-owner-probe-validation-report.json`),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--ignore-support-hypotheses",
          "--min-assignment-score",
          String(args.strictMinScoreProbe),
          "--prefer-top-entity-owner",
        ],
      });
      row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-top-owner`);
    }

    if (!args.skipDuplicateEntityProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      runAssignAndValidate({
        artifactDir,
        movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-duplicate-entities-probe.json`),
        validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-duplicate-entities-probe-validation-report.json`),
        assignArgs: [
          "--priors-path",
          path.join(artifactDir, "no-priors.json"),
          "--ignore-support-hypotheses",
          "--min-assignment-score",
          String(args.strictMinScoreProbe),
          "--allow-duplicate-entities",
        ],
      });
      row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-duplicate-entities`);
    }

    if (!args.skipMaxPatternProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      const maxPatternMovementPath = path.join(artifactDir, "extracted-movement-max50.json");
      if (fs.existsSync(maxPatternMovementPath)) {
        runAssignAndValidate({
          artifactDir,
          movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-max50-probe.json`),
          validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-max50-probe-validation-report.json`),
          assignArgs: [
            "--movement-path",
            maxPatternMovementPath,
            "--priors-path",
            path.join(artifactDir, "no-priors.json"),
            "--ignore-support-hypotheses",
            "--min-assignment-score",
            String(args.strictMinScoreProbe),
          ],
        });
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50`);
      } else {
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50-missing`);
      }
    }

    if (!args.skipSupplementedMaxPatternProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      const maxPatternMovementPath = path.join(artifactDir, "extracted-movement-max50-supplemented.json");
      if (fs.existsSync(maxPatternMovementPath)) {
        runAssignAndValidate({
          artifactDir,
          movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-max50-supplemented-probe.json`),
          validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-max50-supplemented-probe-validation-report.json`),
          assignArgs: [
            "--movement-path",
            maxPatternMovementPath,
            "--priors-path",
            path.join(artifactDir, "no-priors.json"),
            "--ignore-support-hypotheses",
            "--min-assignment-score",
            String(args.strictMinScoreProbe),
          ],
        });
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50-supplemented`);
      } else {
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50-supplemented-missing`);
      }
    }

    if (!args.skipCandidateSupplementedMaxPatternProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      const maxPatternMovementPath = path.join(artifactDir, "extracted-movement-max50-candidate-supplemented.json");
      if (fs.existsSync(maxPatternMovementPath)) {
        runAssignAndValidate({
          artifactDir,
          movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-max50-candidate-supplemented-probe.json`),
          validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-max50-candidate-supplemented-probe-validation-report.json`),
          assignArgs: [
            "--movement-path",
            maxPatternMovementPath,
            "--priors-path",
            path.join(artifactDir, "no-priors.json"),
            "--ignore-support-hypotheses",
            "--min-assignment-score",
            String(args.strictMinScoreProbe),
          ],
        });
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50-candidate-supplemented`);
      } else {
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-max50-candidate-supplemented-missing`);
      }
    }

    if (!args.skipCurrentMax128PatternProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      const maxPatternMovementPath = path.join(artifactDir, "extracted-movement-current-max128.json");
      if (fs.existsSync(maxPatternMovementPath)) {
        runAssignAndValidate({
          artifactDir,
          movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-current-max128-probe.json`),
          validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-current-max128-probe-validation-report.json`),
          assignArgs: [
            "--movement-path",
            maxPatternMovementPath,
            "--priors-path",
            path.join(artifactDir, "no-priors.json"),
            "--ignore-support-hypotheses",
            "--min-assignment-score",
            String(args.strictMinScoreProbe),
          ],
        });
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-current-max128`);
      } else {
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-current-max128-missing`);
      }
    }

    if (!args.skipCurrentMax128ReducedRoleProbe) {
      const strictMinScoreLabel = scoreLabel(args.strictMinScoreProbe);
      const maxPatternMovementPath = path.join(artifactDir, "extracted-movement-current-max128.json");
      if (fs.existsSync(maxPatternMovementPath)) {
        runAssignAndValidate({
          artifactDir,
          movementOutputPath: path.join(artifactDir, `participant-movement-strict-min${strictMinScoreLabel}-current-max128-reduced-role-probe.json`),
          validationOutputPath: path.join(artifactDir, `assigned-movement-strict-min${strictMinScoreLabel}-current-max128-reduced-role-probe-validation-report.json`),
          assignArgs: [
            "--movement-path",
            maxPatternMovementPath,
            "--priors-path",
            path.join(artifactDir, "no-priors.json"),
            "--ignore-support-hypotheses",
            "--min-assignment-score",
            String(args.strictMinScoreProbe),
            "--score-profile",
            "reduced-role-anchor",
          ],
        });
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-current-max128-reduced-role`);
      } else {
        row.diagnostics.push(`strict-min${args.strictMinScoreProbe}-current-max128-reduced-role-missing`);
      }
    }

    rows.push(row);
  }

  const output = {
    schema: "movement-diagnostics-run/v1",
    generatedAtUtc: new Date().toISOString(),
    versionGroup: args.versionGroup,
    artifactRoot,
    replayCount: rows.length,
    processedReplayCount: rows.filter((row) => row.status === "processed").length,
    skippedReplayCount: rows.filter((row) => row.status === "skipped").length,
    rows,
  };
  const outputPath = resolveAbsolute(
    root,
    args.outputPath ?? path.join("artifacts-keyframes", `movement-diagnostics-run-${args.versionGroup}.json`),
  );
  writeJson(outputPath, output);

  if (args.summaryOutputPath) {
    runNode(path.join("scripts", "summarize_movement_diagnostics.mjs"), [
      "--artifact-root",
      artifactRoot,
      "--version-group",
      args.versionGroup,
      "--output-path",
      resolveAbsolute(root, args.summaryOutputPath),
    ]);
  }

  console.log(`Wrote movement diagnostics run report to ${outputPath}`);
  console.log(`processed=${output.processedReplayCount} skipped=${output.skippedReplayCount}`);
}

main();
