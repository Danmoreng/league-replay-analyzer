#!/usr/bin/env node

// Offline research only. This harness reads saved ROFL packet blocks. Saved
// Riot timelines are used only after extraction as labels for falsification.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CHAMPION_OWNER_BASE = 0x400000ad;
const TIMESTAMP_TOLERANCE_MS = 1;

const PROFILES = Object.freeze({
  "16.9": Object.freeze({
    versionGroup: "16.9",
    packetType: 0x0165,
    channel: 1,
    dumpSegmentType: "all",
    candidateSegmentType: "chunk",
    expected: Object.freeze({
      replayCount: 20,
      undoLabelCount: 147,
      candidateBlockCount: 78,
      ownerMatchedBlockCount: 78,
      falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 78,
      minimumContentLength: 67,
      maximumContentLength: 245,
      keyframeOwnerBlockCount: 5720,
      allSegmentOwnerBlockCount: 5798,
    }),
  }),
  "16.14": Object.freeze({
    versionGroup: "16.14",
    packetType: 0x0081,
    channel: 1,
    dumpSegmentType: "all",
    candidateSegmentType: "chunk",
    expected: Object.freeze({
      replayCount: 10,
      undoLabelCount: 62,
      candidateBlockCount: 31,
      ownerMatchedBlockCount: 31,
      falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 31,
      minimumContentLength: 68,
      maximumContentLength: 146,
      keyframeOwnerBlockCount: 3200,
      allSegmentOwnerBlockCount: 3231,
    }),
  }),
});

function parseArgs(argv) {
  const args = {
    profile: null,
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile" && index + 1 < argv.length) args.profile = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/research_inventory_undo_component_families.mjs --profile 16.9|16.14 [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!PROFILES[args.profile]) throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(", ")}`);
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function hex(value, width = 4) {
  return `0x${value.toString(16).padStart(width, "0").toUpperCase()}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectFixtures(replayDir, apiRoot, profile) {
  return fs.readdirSync(replayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => {
      const replayId = path.basename(entry.name, ".rofl");
      const fixtureDir = path.join(apiRoot, replayId.replaceAll("-", "_"));
      const matchPath = path.join(fixtureDir, "match.json");
      const timelinePath = path.join(fixtureDir, "timeline.json");
      if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) return null;
      const match = readJson(matchPath);
      if (versionGroup(match.info?.gameVersion) !== profile.versionGroup) return null;
      return { replayId, replayPath: path.join(replayDir, entry.name), matchPath, timelinePath, gameVersion: match.info?.gameVersion ?? null };
    })
    .filter(Boolean)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectUndoLabels(timelinePath, replayId) {
  const timeline = readJson(timelinePath);
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_UNDO" && Number.isFinite(event.participantId) && Number.isFinite(event.timestamp))
    .map((event, index) => ({
      id: `${replayId}:${index}`,
      replayId,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
    }));
}

function dumpProfileBlocks(cliPath, fixture, profile) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", fixture.replayPath,
    "--packet-type", String(profile.packetType),
    "--segment-type", profile.dumpSegmentType,
    "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `Packet dump failed for ${fixture.replayId}`);
  const dump = JSON.parse(result.stdout);
  if (dump.schema !== "packet-types-dump.v1" || dump.valid !== true) throw new Error(`Unexpected packet dump for ${fixture.replayId}`);
  return (dump.packetTypeDumps ?? []).flatMap((packetDump) => packetDump.blocks ?? [])
    .filter((block) => block.packetType === profile.packetType && block.channel === profile.channel)
    .map((block) => ({
      replayId: fixture.replayId,
      packetType: block.packetType,
      channel: block.channel,
      segmentType: block.segmentType,
      segmentId: block.segmentId,
      chunkId: block.chunkId,
      timestampMillis: block.timestampMillis,
      blockParam: block.blockParam,
      participantId: block.blockParam - CHAMPION_OWNER_BASE,
      contentLength: block.contentLength,
    }));
}

function isOwnerTimestampMatch(block, label) {
  return block.replayId === label.replayId
    && block.participantId === label.participantId
    && Math.abs(block.timestampMillis - label.timestampMillis) <= TIMESTAMP_TOLERANCE_MS;
}

function score(blocks, labels) {
  const positives = blocks.filter((block) => labels.some((label) => isOwnerTimestampMatch(block, label)));
  const matchedLabels = labels.filter((label) => blocks.some((block) => isOwnerTimestampMatch(block, label)));
  const falsePositives = blocks.length - positives.length;
  return {
    candidateBlockCount: blocks.length,
    ownerMatchedBlockCount: positives.length,
    falsePositiveBlockCount: falsePositives,
    matchedUndoLabelCount: matchedLabels.length,
    precision: blocks.length ? positives.length / blocks.length : 0,
    recall: labels.length ? matchedLabels.length / labels.length : 0,
  };
}

function leaveOneReplayOut(blocks, labels, replayIds) {
  const folds = replayIds.map((holdoutReplayId) => {
    const trainBlocks = blocks.filter((block) => block.replayId !== holdoutReplayId);
    const trainLabels = labels.filter((label) => label.replayId !== holdoutReplayId);
    const holdoutBlocks = blocks.filter((block) => block.replayId === holdoutReplayId);
    const holdoutLabels = labels.filter((label) => label.replayId === holdoutReplayId);
    const train = score(trainBlocks, trainLabels);
    // The type/channel/owner rule is profile-fixed. A fold without clean
    // training evidence fails closed instead of interpreting holdout bytes.
    const trainedExact = train.ownerMatchedBlockCount > 0 && train.falsePositiveBlockCount === 0;
    const holdout = trainedExact ? score(holdoutBlocks, holdoutLabels) : {
      candidateBlockCount: 0, ownerMatchedBlockCount: 0, falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 0, precision: null, recall: 0,
    };
    return { holdoutReplayId, trainedExact, ...holdout };
  });
  const total = folds.reduce((current, fold) => ({
    candidateBlockCount: current.candidateBlockCount + fold.candidateBlockCount,
    ownerMatchedBlockCount: current.ownerMatchedBlockCount + fold.ownerMatchedBlockCount,
    falsePositiveBlockCount: current.falsePositiveBlockCount + fold.falsePositiveBlockCount,
    matchedUndoLabelCount: current.matchedUndoLabelCount + fold.matchedUndoLabelCount,
  }), { candidateBlockCount: 0, ownerMatchedBlockCount: 0, falsePositiveBlockCount: 0, matchedUndoLabelCount: 0 });
  return {
    ...total,
    precision: total.candidateBlockCount ? total.ownerMatchedBlockCount / total.candidateBlockCount : 0,
    recall: labels.length ? total.matchedUndoLabelCount / labels.length : 0,
    allTrainingFoldsExact: folds.every((fold) => fold.trainedExact),
    folds,
  };
}

function countBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = String(key(row));
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function main() {
  const args = parseArgs(process.argv);
  const profile = PROFILES[args.profile];
  const repoRoot = process.cwd();
  const cliPath = path.resolve(repoRoot, args.cliPath);
  const replayDir = path.resolve(repoRoot, args.replayDir);
  const apiRoot = path.resolve(repoRoot, args.apiRoot);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const fixtures = collectFixtures(replayDir, apiRoot, profile);
  const labels = [];
  const blocks = [];
  const allOwnerBlocks = [];
  const keyframeOwnerBlocks = [];
  const replayRows = [];
  for (const fixture of fixtures) {
    const replayLabels = collectUndoLabels(fixture.timelinePath, fixture.replayId);
    const replayDumpBlocks = dumpProfileBlocks(cliPath, fixture, profile);
    const replayOwnerBlocks = replayDumpBlocks.filter((block) => block.participantId >= 1 && block.participantId <= 10);
    const replayBlocks = replayOwnerBlocks.filter((block) => block.segmentType === profile.candidateSegmentType);
    const replayKeyframeBlocks = replayOwnerBlocks.filter((block) => block.segmentType === "keyframe");
    labels.push(...replayLabels);
    blocks.push(...replayBlocks);
    allOwnerBlocks.push(...replayOwnerBlocks);
    keyframeOwnerBlocks.push(...replayKeyframeBlocks);
    replayRows.push({
      replayId: fixture.replayId,
      gameVersion: fixture.gameVersion,
      undoLabelCount: replayLabels.length,
      candidateBlockCount: replayBlocks.length,
      ownerMatchedBlockCount: score(replayBlocks, replayLabels).ownerMatchedBlockCount,
      falsePositiveBlockCount: score(replayBlocks, replayLabels).falsePositiveBlockCount,
      keyframeOwnerBlockCount: replayKeyframeBlocks.length,
      allSegmentOwnerBlockCount: replayOwnerBlocks.length,
    });
  }
  const total = score(blocks, labels);
  const expected = profile.expected;
  const actual = {
    replayCount: fixtures.length,
    undoLabelCount: labels.length,
    ...total,
    minimumContentLength: blocks.length ? Math.min(...blocks.map((block) => block.contentLength)) : null,
    maximumContentLength: blocks.length ? Math.max(...blocks.map((block) => block.contentLength)) : null,
    keyframeOwnerBlockCount: keyframeOwnerBlocks.length,
    allSegmentOwnerBlockCount: allOwnerBlocks.length,
  };
  const loro = leaveOneReplayOut(blocks, labels, fixtures.map((fixture) => fixture.replayId));
  const expectedMatches = Object.entries(expected).every(([key, value]) => actual[key] === value);
  const exactnessPass = total.ownerMatchedBlockCount > 0 && total.falsePositiveBlockCount === 0 && total.precision === 1;
  const loroPass = loro.allTrainingFoldsExact && loro.falsePositiveBlockCount === 0 && loro.precision === 1;
  const passed = expectedMatches && exactnessPass && loroPass;
  const output = {
    schema: "rofl-inventory-undo-component-family-research/v1",
    generatedAtUtc: new Date().toISOString(),
    status: passed ? "research-validated-not-promoted" : "research-regression",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: {
      versionGroup: profile.versionGroup,
      packetType: hex(profile.packetType),
      channel: profile.channel,
      dumpSegmentType: profile.dumpSegmentType,
      candidateSegmentType: profile.candidateSegmentType,
      ownerFormula: `blockParam - ${hex(CHAMPION_OWNER_BASE)} == participantId`,
      timestampToleranceMillis: TIMESTAMP_TOLERANCE_MS,
    },
    methodology: {
      replayInput: "Exact-framed saved ROFL packet blocks only.",
      timelineRole: "Saved Riot Timeline ITEM_UNDO labels only, applied after replay extraction.",
      falsePositiveDefinition: "Any profile block without a same-replay, same-owner ITEM_UNDO label within +/-1 ms.",
    },
    expectedCorpus: expected,
    actualCorpus: actual,
    structuralSummary: {
      channels: countBy(blocks, (block) => block.channel),
      segmentTypes: countBy(blocks, (block) => block.segmentType),
      contentLengths: countBy(blocks, (block) => block.contentLength),
      ownerRangeBlockCount: blocks.filter((block) => block.participantId >= 1 && block.participantId <= 10).length,
      allSegmentTypes: countBy(allOwnerBlocks, (block) => block.segmentType),
      keyframeOwnerBlockCount: keyframeOwnerBlocks.length,
      allSegmentOwnerBlockCount: allOwnerBlocks.length,
    },
    leaveOneReplayOut: loro,
    replayRows,
    patchMapping: {
      priorPatch169ComponentFamily: "0x0165",
      currentPatch1614ComponentFamily: "0x0081",
      conclusion: "The profiles are exact undo-associated component families within their separate patch corpora, but are partial-coverage research evidence only.",
    },
    nonPromotionReason: "The family does not decode item ID, slots, instances, operation ordering, or the remaining ITEM_UNDO labels; no runtime inventory API is authorized.",
    gates: { expectedMatches, exactnessPass, loroPass, passed },
  };
  const outputPath = path.resolve(repoRoot, args.outputPath ?? path.join("tmp", "research-inventory-undo-component-families", `${profile.versionGroup}.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(`profile=${profile.versionGroup} packet=${hex(profile.packetType)} matches=${total.ownerMatchedBlockCount}/${labels.length} extras=${total.falsePositiveBlockCount} LORO=${loro.precision}/${loro.recall} passed=${passed}`);
  if (!passed) process.exitCode = 1;
}

main();
