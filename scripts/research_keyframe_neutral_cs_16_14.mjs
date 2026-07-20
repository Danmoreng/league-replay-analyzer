#!/usr/bin/env node

// Replay-only candidate extraction plus offline Timeline validation for the
// exact-build 16.14 keyframe neutral/jungle-CS lane. Discovery selects the
// smallest fixed projection epsilon that makes every D7 label exact. H3 is
// consulted only after that rule is frozen.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_PATH = path.join(
  "scripts",
  "manifests",
  "replay-participant-stat-snapshots-16.14.expected.json",
);
const PROFILE_PATH = path.join(
  "packages",
  "rofl-core",
  "profiles",
  "replay-decoder-profiles.v1.json",
);
const CANDIDATE_OFFSETS = [131, 133, 135, 137];

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("tmp", "keyframe-neutral-cs-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/research_keyframe_neutral_cs_16_14.mjs " +
          "[--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) {
    throw new Error(
      `${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
    );
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function dumpSnapshotBlocks(cliPath, replayPath) {
  const result = spawnSync(
    cliPath,
    [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      "0x02EB",
      "--segment-type",
      "keyframe",
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Packet dump exited with ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function decodeFloat32(payload, offsets, cipherToPlain) {
  const bytes = offsets.map((offset) => cipherToPlain[payload[offset]]);
  const buffer = Buffer.from(bytes);
  return buffer.readFloatLE(0);
}

function projectionInterval(value, expected) {
  // floor(value + epsilon) == expected iff:
  // expected - value <= epsilon < expected + 1 - value.
  return { minimumInclusive: expected - value, maximumExclusive: expected + 1 - value };
}

function summarize(rows, epsilon) {
  const mismatches = rows.filter((row) => Math.floor(row.value + epsilon) !== row.expected);
  const byParticipant = new Map();
  for (const row of rows) {
    const key = `${row.replayId}:${row.participantId}`;
    const previous = byParticipant.get(key);
    assert(!previous || row.timestampMillis > previous.timestampMillis,
      "Candidate track timestamps are not strictly increasing.", { previous, row });
    assert(!previous || row.value >= previous.value,
      "Candidate track is not replay-native monotonic.", { previous, row });
    byParticipant.set(key, row);
  }
  return {
    snapshotCount: rows.length,
    participantTrackCount: byParticipant.size,
    finiteNonnegativeCount: rows.filter((row) => Number.isFinite(row.value) && row.value >= 0).length,
    exactProjectedCount: rows.length - mismatches.length,
    mismatchCount: mismatches.length,
    mismatchExamples: mismatches.slice(0, 10),
    maximumValue: Math.max(...rows.map((row) => row.value)),
  };
}

function main() {
  const args = parseArgs(process.argv);
  for (const key of ["cliPath", "replayDir", "apiRoot", "outputPath"]) {
    args[key] = path.resolve(args[key]);
  }
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);
  const manifest = readJson(MANIFEST_PATH);
  const registry = readJson(PROFILE_PATH);
  const selected = registry.profiles.filter(
    (profile) =>
      profile.versionGroup === manifest.versionGroup &&
      profile.acceptedGameVersions.includes(manifest.exactReplayBuild),
  );
  assert(selected.length === 1, "Canonical profile selection is not unique.");
  const grammar = selected[0].keyframeParticipantStats;
  assert(grammar && grammar.packetType === 0x02eb && grammar.contentLength === 1479,
    "Canonical keyframe participant grammar is unavailable.");
  assert(Array.isArray(grammar.cipherToPlain) && grammar.cipherToPlain.length === 256,
    "Canonical keyframe cipher is unavailable.");

  const rows = [];
  for (const fixture of manifest.fixtures) {
    const replayPath = path.join(args.replayDir, `${fixture.replayId}.rofl`);
    const timelinePath = path.join(
      args.apiRoot,
      fixture.replayId.replaceAll("-", "_"),
      "timeline.json",
    );
    assert(fs.existsSync(replayPath) && fs.existsSync(timelinePath),
      `Missing frozen fixture for ${fixture.replayId}.`);
    const dump = dumpSnapshotBlocks(args.cliPath, replayPath);
    const frames = readJson(timelinePath).info?.frames;
    assert(dump.gameVersion === manifest.exactReplayBuild && dump.valid === true,
      `${fixture.replayId} packet dump failed the exact-build/framing gate.`);
    assert(dump.blocks.length === fixture.expectedSnapshotCount,
      `${fixture.replayId} snapshot block count drifted.`);
    for (let index = 0; index < dump.blocks.length; index += 1) {
      const block = dump.blocks[index];
      const groupIndex = Math.floor(index / 10);
      const participantId = block.blockParam - grammar.championNetworkIdBase;
      const frame = frames?.[groupIndex];
      const expected = frame?.participantFrames?.[participantId]?.jungleMinionsKilled;
      assert(
        block.channel === grammar.channel &&
          block.packetType === grammar.packetType &&
          block.contentLength === grammar.contentLength &&
          participantId >= 1 &&
          participantId <= 10 &&
          Number.isInteger(expected) &&
          Math.abs(frame.timestamp - block.timestampMillis) <= 1,
        `${fixture.replayId} candidate/API ordering or provenance drifted.`,
        { index, block, frameTimestamp: frame?.timestamp, participantId, expected },
      );
      const value = decodeFloat32(
        Buffer.from(block.contentHex, "hex"),
        CANDIDATE_OFFSETS,
        grammar.cipherToPlain,
      );
      assert(Number.isFinite(value) && value >= 0,
        `${fixture.replayId} candidate is not finite/nonnegative.`, { index, value });
      rows.push({
        replayId: fixture.replayId,
        partition: fixture.partition,
        groupIndex,
        timestampMillis: block.timestampMillis,
        participantId,
        value,
        expected,
      });
    }
  }

  const discovery = rows.filter((row) => row.partition === "D7");
  const holdout = rows.filter((row) => row.partition === "H3");
  const discoveryInterval = discovery.reduce(
    (result, row) => {
      const interval = projectionInterval(row.value, row.expected);
      return {
        minimumInclusive: Math.max(result.minimumInclusive, interval.minimumInclusive),
        maximumExclusive: Math.min(result.maximumExclusive, interval.maximumExclusive),
      };
    },
    { minimumInclusive: 0, maximumExclusive: Number.POSITIVE_INFINITY },
  );
  assert(discoveryInterval.minimumInclusive < discoveryInterval.maximumExclusive,
    "D7 has no shared floor-plus-epsilon projection interval.", discoveryInterval);
  // Select the smallest decimal epsilon at 1e-5 precision that closes D7. This
  // is frozen before H3 is summarized and remains far below the smallest
  // observed semantic fractional increment (0.05).
  const selectedEpsilon = Math.ceil(discoveryInterval.minimumInclusive * 100_000) / 100_000;
  assert(selectedEpsilon < discoveryInterval.maximumExclusive,
    "Rounded D7 epsilon escaped the exact projection interval.", {
      discoveryInterval,
      selectedEpsilon,
    });

  const report = {
    schema: "rofl-keyframe-neutral-cs-research/v1",
    generatedAtUtc: new Date().toISOString(),
    status: "validated-candidate",
    exactReplayBuild: manifest.exactReplayBuild,
    source: {
      candidateInput: "Saved ROFL packet bytes plus canonical external profile only.",
      offlineOracle: "Saved Riot Timeline jungleMinionsKilled after replay-only extraction.",
      runtimeRiotInput: false,
    },
    candidate: {
      packetType: grammar.packetType,
      contentLength: grammar.contentLength,
      championNetworkIdBase: grammar.championNetworkIdBase,
      decodedFloat32LeOffsets: CANDIDATE_OFFSETS,
      projection: "floor(value + epsilon)",
      selectedEpsilon,
      selectedOn: "D7 only",
      discoveryProjectionInterval: discoveryInterval,
    },
    summaries: {
      D7: summarize(discovery, selectedEpsilon),
      H3: summarize(holdout, selectedEpsilon),
      combined: summarize(rows, selectedEpsilon),
    },
  };
  assert(report.summaries.D7.mismatchCount === 0,
    "Selected projection does not close D7.", report.summaries.D7);
  assert(report.summaries.H3.mismatchCount === 0,
    "Frozen D7 projection does not reproduce H3.", report.summaries.H3);
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, candidate: report.candidate, summaries: report.summaries }, null, 2));
}

main();
