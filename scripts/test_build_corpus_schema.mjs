#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildComparableSchema, buildSchemaFingerprint } from "./build_corpus_schema.mjs";

function makeSchema() {
  return {
    generatedAtUtc: "2026-07-20T10:00:00.000Z",
    schemaFingerprint: "legacy-large-fingerprint",
    source: { replayCount: 2 },
    aliasClusters: [{ ignored: true }],
    rankedPatterns: [{ ignored: true }],
    bundleRankedPatterns: [{ ignored: true }],
    promotedPatterns: [{ patternKey: "kept-pattern" }],
    bundlePromotedPatterns: [{ patternKey: "kept-bundle" }],
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCorpusSchemaBuild(artifactRoot, manifestPath, outputPath) {
  const result = spawnSync(process.execPath, [
    path.resolve("scripts/build_corpus_schema.mjs"),
    "--artifact-root", artifactRoot,
    "--corpus-manifest", manifestPath,
    "--output-path", outputPath,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

const schema = makeSchema();
const comparable = JSON.stringify(buildComparableSchema(schema));
const expected = `sha256:${createHash("sha256").update(comparable, "utf8").digest("hex")}`;
assert.equal(buildSchemaFingerprint(schema), expected);
assert.match(buildSchemaFingerprint(schema), /^sha256:[a-f0-9]{64}$/);

const transientOnlyChange = makeSchema();
transientOnlyChange.generatedAtUtc = "2026-07-21T12:34:56.000Z";
transientOnlyChange.schemaFingerprint = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
transientOnlyChange.aliasClusters = [{ changed: true }];
transientOnlyChange.rankedPatterns = [{ changed: true }];
transientOnlyChange.bundleRankedPatterns = [{ changed: true }];
assert.equal(buildSchemaFingerprint(transientOnlyChange), buildSchemaFingerprint(schema));

const semanticChange = makeSchema();
semanticChange.promotedPatterns = [{ patternKey: "different-pattern" }];
assert.notEqual(buildSchemaFingerprint(semanticChange), buildSchemaFingerprint(schema));

const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lra-corpus-schema-"));
try {
  const replayId = "Replay-1";
  const replayDir = path.join(artifactRoot, replayId);
  const manifestPath = path.join(artifactRoot, "corpus-manifest.json");
  const outputPath = path.join(artifactRoot, "corpus-schema.json");

  writeJson(manifestPath, {
    processed: [{ replayId, artifactDir: replayDir }],
  });
  writeJson(path.join(replayDir, "run-manifest.json"), {
    replayId,
    summary: { gameVersion: "16.14.794.5912" },
    families: [],
  });
  writeJson(path.join(replayDir, "summary.json"), { gameVersion: "16.14.794.5912" });
  writeJson(path.join(replayDir, "provisional-schema.json"), {
    promotedPatterns: [],
    rankedPatterns: [],
  });
  writeJson(path.join(replayDir, "candidate-matches.json"), { topMatches: [] });

  assert.match(runCorpusSchemaBuild(artifactRoot, manifestPath, outputPath), /Wrote corpus schema/);
  const firstSchema = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.match(firstSchema.schemaFingerprint, /^sha256:[a-f0-9]{64}$/);

  assert.match(runCorpusSchemaBuild(artifactRoot, manifestPath, outputPath), /Corpus schema unchanged/);

  const legacySchema = {
    ...firstSchema,
    schemaFingerprint: JSON.stringify(buildComparableSchema(firstSchema)),
  };
  writeJson(outputPath, legacySchema);
  assert.match(runCorpusSchemaBuild(artifactRoot, manifestPath, outputPath), /Wrote corpus schema/);
  const migratedSchema = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  assert.equal(migratedSchema.schemaFingerprint, firstSchema.schemaFingerprint);
  assert.deepEqual(buildComparableSchema(migratedSchema), buildComparableSchema(firstSchema));
  assert.match(runCorpusSchemaBuild(artifactRoot, manifestPath, outputPath), /Corpus schema unchanged/);
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
}

console.log("corpus schema fingerprint tests passed");
