#!/usr/bin/env node

// Research only. The only inputs are saved .rofl files plus the checked-in
// replay decoder profile used to derive already-promoted ward entity IDs.
// This script must not be used as a runtime decoder or as a movement parser.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.14",
  exactReplayBuild: "16.14.794.5912",
  channel: 1,
  firstPacketType: 0x0328,
  companionPacketType: 0x0170,
  championNetworkIdBase: 0x400000ad,
});

const WARD_DECODER_PROFILE = Object.freeze({
  origin: "external",
  schema: "rofl-replay-decoder-profiles/v1",
  registryId: "league-replay-analyzer-offline-validated",
  revision: "2026-07-25-cross-patch-cs",
  fingerprint: "fnv1a64:5cf4895f9e6d3f4c",
});

// Fixed before this maintained research checkpoint. D7 is fully processed and
// asserted before any H3 replay is opened.
const FIXTURE_SPLIT = Object.freeze({
  discovery: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664",
    "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492",
    "EUW1-7920550565",
  ]),
  holdout: Object.freeze([
    "EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430",
  ]),
});

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    replayCount: 7,
    firstPacketCount: 4652,
    companionPacketCount: 3668,
    exactPairCount: 3668,
    unpairedFirstPacketCount: 984,
    unpairedCompanionPacketCount: 0,
    wardPlacementCount: 998,
    wardLinkedPairCount: 534,
    distinctWardEntityCount: 534,
    strictlyAfterPlacementCount: 534,
    wardPairLengthCounts: Object.freeze({ 17: 534 }),
    minimumWardPlacementDeltaMillis: 60002,
    maximumWardPlacementDeltaMillis: 127173,
    knownWardRemovalCount: 312,
    linkedPairsWithKnownRemoval: 22,
    linkedPairsBeforeKnownRemoval: 22,
    linkedPairsAtOrAfterKnownRemoval: 0,
    championBlockParamCount: 0,
    rawSelfHandleU32PairCount: 0,
  }),
  holdout: Object.freeze({
    replayCount: 3,
    firstPacketCount: 3156,
    companionPacketCount: 2646,
    exactPairCount: 2646,
    unpairedFirstPacketCount: 510,
    unpairedCompanionPacketCount: 0,
    wardPlacementCount: 479,
    wardLinkedPairCount: 225,
    distinctWardEntityCount: 225,
    strictlyAfterPlacementCount: 225,
    wardPairLengthCounts: Object.freeze({ 17: 225 }),
    minimumWardPlacementDeltaMillis: 60081,
    maximumWardPlacementDeltaMillis: 127243,
    knownWardRemovalCount: 172,
    linkedPairsWithKnownRemoval: 7,
    linkedPairsBeforeKnownRemoval: 7,
    linkedPairsAtOrAfterKnownRemoval: 0,
    championBlockParamCount: 0,
    rawSelfHandleU32PairCount: 0,
  }),
});

function fail(message, detail = undefined) {
  const suffix = detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function assert(condition, message, detail = undefined) {
  if (!condition) fail(message, detail);
}

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    decoderProfilesPath: path.join("packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json"),
    outputPath: path.join("artifacts", "movement-entity-handles-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (argument === "--decoder-profiles" && index + 1 < argv.length) args.decoderProfilesPath = argv[++index];
    else if (argument === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log([
        "Usage: node ./scripts/research_movement_entity_handles_16_14.mjs [options]",
        "",
        "Saved .rofl research only; it emits no runtime movement/entity decoder.",
        "  --cli <path>                 Native rofl_core_cli executable.",
        "  --replay-dir <path>          Directory containing saved .rofl files.",
        "  --decoder-profiles <path>    Exact external decoder profile JSON.",
        "  --output <path>              Deterministic JSON report path.",
      ].join("\n"));
      process.exit(0);
    } else {
      fail(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return args;
}

function countBy(rows, selector) {
  const totals = new Map();
  for (const row of rows) {
    const key = String(selector(row));
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })));
}

function addCountMaps(rows, selector) {
  const totals = new Map();
  for (const row of rows) {
    for (const [key, value] of Object.entries(selector(row))) {
      totals.set(key, (totals.get(key) ?? 0) + value);
    }
  }
  return Object.fromEntries([...totals.entries()].sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true })));
}

function runCli(cliPath, cliArgs) {
  const result = spawnSync(cliPath, cliArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail("Native CLI failed.", { stderr: result.stderr.trim(), status: result.status });
  return JSON.parse(result.stdout);
}

function loadPacketBlocks(args, replayId) {
  const replayPath = path.join(args.replayDir, `${replayId}.rofl`);
  const dump = runCli(args.cliPath, [
    "--dump-packet-types-json", replayPath,
    "--packet-type", String(PROFILE.firstPacketType),
    "--packet-type", String(PROFILE.companionPacketType),
    "--segment-type", "all",
    "--max-blocks", "0",
  ]);
  assert(dump.valid === true && !dump.errors?.length && dump.gameVersion === PROFILE.exactReplayBuild,
    "Packet framing/version gate failed.", { replayId, gameVersion: dump.gameVersion, errors: dump.errors ?? [] });
  const byType = new Map((dump.packetTypeDumps ?? []).map((entry) => [entry.packetType, entry]));
  for (const packetType of [PROFILE.firstPacketType, PROFILE.companionPacketType]) {
    const entry = byType.get(packetType);
    assert(entry && entry.emittedBlockCount === entry.matchingBlockCount && entry.truncated === false,
      "Packet dump is incomplete.", { replayId, packetType, entry: entry ?? null });
  }
  return [...(byType.get(PROFILE.firstPacketType).blocks ?? []), ...(byType.get(PROFILE.companionPacketType).blocks ?? [])]
    .filter((block) => block.channel === PROFILE.channel && block.segmentType === "chunk")
    .sort((left, right) => left.segmentId - right.segmentId || left.sourceOffset - right.sourceOffset);
}

function loadReplayOnlyWardEvents(args, replayId) {
  const replayPath = path.join(args.replayDir, `${replayId}.rofl`);
  const decoded = runCli(args.cliPath, ["--extract-replay-wards-json", replayPath, "--decoder-profiles", args.decoderProfilesPath]);
  assert(decoded.source?.runtimeInput === "rofl-only" && decoded.source?.riotApiInput === false && decoded.gameVersion === PROFILE.exactReplayBuild,
    "Ward source/version gate failed.", { replayId, source: decoded.source ?? null, gameVersion: decoded.gameVersion });
  for (const [key, value] of Object.entries(WARD_DECODER_PROFILE)) {
    assert(decoded.profile?.[key] === value, `Ward decoder profile provenance gate failed: ${key}.`,
      { replayId, actual: decoded.profile?.[key] ?? null, expected: value });
  }
  return (decoded.events ?? []).filter((event) =>
    (event.type === "WARD_PLACED" || event.type === "WARD_KILL") &&
    Number.isInteger(event.wardEntityNetworkId) && Number.isFinite(event.timestampMillis));
}

function payloadHasRawU32(hex, value) {
  const payload = Buffer.from(hex, "hex");
  for (let offset = 0; offset + 4 <= payload.length; offset += 1) {
    if (payload.readUInt32LE(offset) === value || payload.readUInt32BE(offset) === value) return true;
  }
  return false;
}

function analyzeReplay(args, replayId) {
  const blocks = loadPacketBlocks(args, replayId);
  const wardEvents = loadReplayOnlyWardEvents(args, replayId);
  const firstPackets = blocks.filter((block) => block.packetType === PROFILE.firstPacketType);
  const companionPackets = blocks.filter((block) => block.packetType === PROFILE.companionPacketType);
  const pairs = [];
  for (let index = 1; index < blocks.length; index += 1) {
    const first = blocks[index - 1];
    const companion = blocks[index];
    if (first.packetType !== PROFILE.firstPacketType || companion.packetType !== PROFILE.companionPacketType) continue;
    if (first.segmentId !== companion.segmentId || first.chunkId !== companion.chunkId ||
      companion.blockIndex !== first.blockIndex + 1 || first.timestampMillis !== companion.timestampMillis ||
      first.blockParam !== companion.blockParam || first.contentLength !== companion.contentLength) continue;
    pairs.push({ first, companion });
  }
  const pairedFirstOffsets = new Set(pairs.map((pair) => `${pair.first.segmentId}/${pair.first.chunkId}/${pair.first.sourceOffset}`));
  const pairedCompanionOffsets = new Set(pairs.map((pair) => `${pair.companion.segmentId}/${pair.companion.chunkId}/${pair.companion.sourceOffset}`));
  const placements = wardEvents.filter((event) => event.type === "WARD_PLACED");
  const removals = wardEvents.filter((event) => event.type === "WARD_KILL");
  const placementByEntity = new Map(placements.map((event) => [event.wardEntityNetworkId, event]));
  const removalByEntity = new Map(removals.map((event) => [event.wardEntityNetworkId, event]));
  const wardLinks = pairs
    .map((pair) => ({ pair, placement: placementByEntity.get(pair.first.blockParam) }))
    .filter((link) => link.placement);
  const wardLinksWithRemoval = wardLinks
    .map((link) => ({ ...link, removal: removalByEntity.get(link.pair.first.blockParam) }))
    .filter((link) => link.removal);
  const placementDeltas = wardLinks.map((link) => link.pair.first.timestampMillis - link.placement.timestampMillis);
  const isChampionParam = (value) => value >= PROFILE.championNetworkIdBase + 1 && value <= PROFILE.championNetworkIdBase + 10;
  return {
    replayId,
    firstPacketCount: firstPackets.length,
    companionPacketCount: companionPackets.length,
    exactPairCount: pairs.length,
    unpairedFirstPacketCount: firstPackets.length - pairedFirstOffsets.size,
    unpairedCompanionPacketCount: companionPackets.length - pairedCompanionOffsets.size,
    pairedPayloadLengthCounts: countBy(pairs, (pair) => pair.first.contentLength),
    championBlockParamCount: pairs.filter((pair) => isChampionParam(pair.first.blockParam)).length,
    rawSelfHandleU32PairCount: pairs.filter((pair) =>
      payloadHasRawU32(pair.first.contentHex, pair.first.blockParam) || payloadHasRawU32(pair.companion.contentHex, pair.companion.blockParam)).length,
    wardPlacementCount: placements.length,
    wardLinkedPairCount: wardLinks.length,
    distinctWardEntityCount: new Set(wardLinks.map((link) => link.pair.first.blockParam)).size,
    strictlyAfterPlacementCount: placementDeltas.filter((delta) => delta > 0).length,
    wardPairLengthCounts: countBy(wardLinks, (link) => link.pair.first.contentLength),
    minimumWardPlacementDeltaMillis: placementDeltas.length ? Math.min(...placementDeltas) : null,
    maximumWardPlacementDeltaMillis: placementDeltas.length ? Math.max(...placementDeltas) : null,
    knownWardRemovalCount: removals.length,
    linkedPairsWithKnownRemoval: wardLinksWithRemoval.length,
    linkedPairsBeforeKnownRemoval: wardLinksWithRemoval.filter((link) => link.pair.first.timestampMillis < link.removal.timestampMillis).length,
    linkedPairsAtOrAfterKnownRemoval: wardLinksWithRemoval.filter((link) => link.pair.first.timestampMillis >= link.removal.timestampMillis).length,
  };
}

function aggregate(rows) {
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  return {
    replayCount: rows.length,
    firstPacketCount: total("firstPacketCount"),
    companionPacketCount: total("companionPacketCount"),
    exactPairCount: total("exactPairCount"),
    unpairedFirstPacketCount: total("unpairedFirstPacketCount"),
    unpairedCompanionPacketCount: total("unpairedCompanionPacketCount"),
    pairedPayloadLengthCounts: addCountMaps(rows, (row) => row.pairedPayloadLengthCounts),
    championBlockParamCount: total("championBlockParamCount"),
    rawSelfHandleU32PairCount: total("rawSelfHandleU32PairCount"),
    wardPlacementCount: total("wardPlacementCount"),
    wardLinkedPairCount: total("wardLinkedPairCount"),
    distinctWardEntityCount: total("distinctWardEntityCount"),
    strictlyAfterPlacementCount: total("strictlyAfterPlacementCount"),
    wardPairLengthCounts: addCountMaps(rows, (row) => row.wardPairLengthCounts),
    minimumWardPlacementDeltaMillis: Math.min(...rows.map((row) => row.minimumWardPlacementDeltaMillis).filter(Number.isFinite)),
    maximumWardPlacementDeltaMillis: Math.max(...rows.map((row) => row.maximumWardPlacementDeltaMillis).filter(Number.isFinite)),
    knownWardRemovalCount: total("knownWardRemovalCount"),
    linkedPairsWithKnownRemoval: total("linkedPairsWithKnownRemoval"),
    linkedPairsBeforeKnownRemoval: total("linkedPairsBeforeKnownRemoval"),
    linkedPairsAtOrAfterKnownRemoval: total("linkedPairsAtOrAfterKnownRemoval"),
  };
}

function assertExpected(summary, expected, splitName) {
  for (const [key, value] of Object.entries(expected)) {
    assert(JSON.stringify(summary[key]) === JSON.stringify(value), `${splitName} expected-count gate failed: ${key}`, { actual: summary[key], expected: value });
  }
  assert(summary.exactPairCount === summary.companionPacketCount, `${splitName} requires every 0x0170 to have exactly one immediate 0x0328 companion.`);
  assert(summary.wardLinkedPairCount === summary.distinctWardEntityCount, `${splitName} ward entity links must be one pair per exact ward entity ID.`);
  assert(summary.wardLinkedPairCount === summary.strictlyAfterPlacementCount, `${splitName} known ward links must occur strictly after replay-only placement.`);
  assert(summary.linkedPairsWithKnownRemoval === summary.linkedPairsBeforeKnownRemoval && summary.linkedPairsAtOrAfterKnownRemoval === 0,
    `${splitName} known-removal ordering gate failed.`);
}

const args = parseArgs(process.argv);
assert(fs.existsSync(args.cliPath), "Native CLI path does not exist.");
assert(fs.existsSync(args.decoderProfilesPath), "Decoder profile path does not exist.");

// D7 discovery: fully load, select the exact structural/ward-ID relation, and
// freeze every gate before H3 is opened.
const discoveryRows = FIXTURE_SPLIT.discovery.map((replayId) => analyzeReplay(args, replayId));
const discovery = aggregate(discoveryRows);
assertExpected(discovery, EXPECTED.discovery, "D7");
const frozenD7Gates = Object.freeze({
  immediateCompanionOrder: "0x0328 then 0x0170",
  consecutiveBlockIndexInSameChunk: true,
  sameTimestampBlockParamAndPayloadLength: true,
  exactKnownWardEntityIdEquality: true,
  wardLinkStrictlyAfterReplayOnlyPlacement: true,
  noChampionOwnerSemantics: true,
  noRawPayloadSelfHandleCodec: true,
});

// H3 validation starts only after D7 selection/freeze completes.
const holdoutRows = FIXTURE_SPLIT.holdout.map((replayId) => analyzeReplay(args, replayId));
const holdout = aggregate(holdoutRows);
assertExpected(holdout, EXPECTED.holdout, "H3");

const output = {
  schema: "rofl-movement-entity-handles-research/v1",
  researchOnly: true,
  promotionGate: false,
  runtimeInput: false,
  runtimeApiData: false,
  clientBinaryInput: false,
  sourceInput: "saved-rofl-plus-profiled-replay-only-ward-oracle",
  profile: {
    versionGroup: PROFILE.versionGroup,
    exactReplayBuild: PROFILE.exactReplayBuild,
    channel: PROFILE.channel,
    firstPacketType: "0x0328",
    companionPacketType: "0x0170",
    fixtureSplit: FIXTURE_SPLIT,
  },
  wardDecoderProfile: WARD_DECODER_PROFILE,
  frozenD7Gates,
  discovery,
  holdout,
  allCorpus: aggregate([...discoveryRows, ...holdoutRows]),
  conclusion: {
    exactStructuralFinding: "Every profiled 0x0170 chunk block immediately follows one 0x0328 chunk block with the same timestamp, blockParam, and payload length.",
    exactEntityHandleFinding: "A strict subset of these pair blockParams exactly equals an already replay-decoded WARD_PLACED wardEntityNetworkId; each matched pair is after that placement and, where a conservative WARD_KILL exists for the ID, before it.",
    boundary: "This only establishes a generic entity-handle relation for the matched ward subset. It does not decode owner, champion identity, entity class outside that subset, operation, payload fields, coordinates, teleport flags, path/count, or waypoints.",
  },
};

fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
fs.writeFileSync(args.outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${args.outputPath}`);
