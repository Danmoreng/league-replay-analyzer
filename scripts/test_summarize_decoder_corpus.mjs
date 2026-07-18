#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildSummary } from "./summarize_decoder_corpus.mjs";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createFixtureRoot() {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lra-scorecard-"));
  const replayId = "Replay-1";
  const replayDir = path.join(artifactRoot, replayId);
  const manifestPath = path.join(artifactRoot, "corpus-manifest.json");

  writeJson(manifestPath, {
    artifactRoot,
    processed: [{
      replayId,
      artifactDir: replayDir,
      validationReportPath: path.join(replayDir, "validation-report.json"),
      assignedMovementValidationPath: path.join(replayDir, "assigned-movement-validation-report.json"),
    }],
  });
  writeJson(path.join(artifactRoot, "corpus-schema.json"), {
    source: {
      artifactRoot,
      corpusManifestPath: manifestPath,
      replayCount: 1,
    },
    versionGroups: [{ versionGroup: "test", replayCount: 1 }],
    promotedPatterns: [{ patternKey: "pattern-1" }],
    rankedPatterns: [],
    bundlePromotedPatterns: [{ patternKey: "bundle-1" }],
    bundleRankedPatterns: [],
  });
  writeJson(path.join(replayDir, "validation-report.json"), {
    participants: {
      one: {
        metrics: {
          gold: { passes: true },
          xp: { passes: false },
        },
      },
    },
  });
  writeJson(path.join(replayDir, "assigned-movement-validation-report.json"), {
    summary: {
      passingAssignmentCount: 3,
      assignmentCount: 4,
    },
  });

  return { artifactRoot, manifestPath, replayDir, replayId };
}

function withFixture(run) {
  const fixture = createFixtureRoot();
  try {
    run(fixture);
  } finally {
    fs.rmSync(fixture.artifactRoot, { recursive: true, force: true });
  }
}

withFixture(({ artifactRoot }) => {
  fs.mkdirSync(path.join(artifactRoot, "research-not-a-replay"));
  const summary = buildSummary(artifactRoot);
  assert.equal(summary.replayCount, 1);
  assert.equal(summary.scalar.totalPasses, 1);
  assert.equal(summary.scalar.totalChecks, 2);
  assert.equal(summary.movement.passingAssignments, 3);
  assert.equal(summary.movement.totalAssignments, 4);
  assert.deepEqual(summary.scorecard, {
    scalarPasses: 1,
    movementPasses: 3,
    promotedPatterns: 1,
    promotedBundlePatterns: 1,
  });
});

withFixture(({ artifactRoot, replayDir }) => {
  fs.rmSync(path.join(replayDir, "validation-report.json"));
  assert.throws(() => buildSummary(artifactRoot), /Missing scalar validation report/);
});

withFixture(({ artifactRoot, replayDir }) => {
  fs.rmSync(path.join(replayDir, "assigned-movement-validation-report.json"));
  assert.throws(() => buildSummary(artifactRoot), /Missing assigned movement validation report/);
});

withFixture(({ artifactRoot, manifestPath, replayDir, replayId }) => {
  writeJson(manifestPath, {
    artifactRoot,
    processed: [
      { replayId, artifactDir: replayDir, validationReportPath: path.join(replayDir, "validation-report.json"), assignedMovementValidationPath: path.join(replayDir, "assigned-movement-validation-report.json") },
      { replayId, artifactDir: replayDir, validationReportPath: path.join(replayDir, "validation-report.json"), assignedMovementValidationPath: path.join(replayDir, "assigned-movement-validation-report.json") },
    ],
  });
  const schemaPath = path.join(artifactRoot, "corpus-schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  schema.source.replayCount = 2;
  writeJson(schemaPath, schema);
  assert.throws(() => buildSummary(artifactRoot), /duplicate replayId/);
});

withFixture(({ artifactRoot }) => {
  const schemaPath = path.join(artifactRoot, "corpus-schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  schema.source.artifactRoot = path.join(artifactRoot, "other-root");
  writeJson(schemaPath, schema);
  assert.throws(() => buildSummary(artifactRoot), /artifact root does not match/);
});

withFixture(({ artifactRoot, manifestPath }) => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.artifactRoot = path.join(artifactRoot, "other-root");
  writeJson(manifestPath, manifest);
  assert.throws(() => buildSummary(artifactRoot), /manifest artifact root does not match/);
});

withFixture(({ artifactRoot, manifestPath }) => {
  fs.rmSync(manifestPath);
  assert.throws(() => buildSummary(artifactRoot), /Missing corpus manifest/);
  const legacy = buildSummary(artifactRoot, { strictManifest: false });
  assert.equal(legacy.replayCount, 1);
});

withFixture(({ artifactRoot }) => {
  const schemaPath = path.join(artifactRoot, "corpus-schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  schema.source.replayCount = 2;
  writeJson(schemaPath, schema);
  assert.throws(() => buildSummary(artifactRoot), /schema replay count/);
});

withFixture(({ artifactRoot }) => {
  writeJson(path.join(artifactRoot, "stale-movement-only", "assigned-movement-validation-report.json"), {
    summary: { passingAssignmentCount: 0, assignmentCount: 0 },
  });
  assert.throws(() => buildSummary(artifactRoot), /Unmanifested score report directory/);
});

withFixture(({ artifactRoot }) => {
  const schemaPath = path.join(artifactRoot, "corpus-schema.json");
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  schema.source.corpusManifestPath = path.join(artifactRoot, "other-manifest.json");
  writeJson(schemaPath, schema);
  assert.throws(() => buildSummary(artifactRoot), /manifest path does not match/);
});

withFixture(({ artifactRoot }) => {
  writeJson(path.join(artifactRoot, "stale-replay", "validation-report.json"), {
    participants: {},
  });
  assert.throws(() => buildSummary(artifactRoot), /Unmanifested score report directory/);
});

console.log("scorecard manifest isolation tests passed");
