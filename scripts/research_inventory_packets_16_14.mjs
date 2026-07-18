#!/usr/bin/env node

// Offline research only. Packet input is restricted to saved .rofl files;
// Riot timeline fixtures are labels and are never decoder/runtime input.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.14",
  championIdBase: 0x400000ad,
  addOrUpdatePacketType: 0x0369,
  addOrUpdateContentLengths: Object.freeze([14, 15]),
  removalPacketType: 0x03f9,
  removalContentLengths: Object.freeze([6, 7]),
  unresolvedRemovalCompanionPacketType: 0x0146,
  unresolvedRemovalCompanionContentLengths: Object.freeze([2, 3, 4]),
});

// Fixed before the 0x0146 companion analysis. These identifiers are a
// research split only; neither the split nor Timeline labels reach runtime.
const FIXTURE_SPLIT = Object.freeze({
  discovery: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664", "EUW1-7920292147",
    "EUW1-7920341366", "EUW1-7920364492", "EUW1-7920550565",
  ]),
  holdout: Object.freeze(["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"]),
});

// This is a profile compatibility boundary, not an item/payload lookup table.
// A byte outside it must stay unavailable until a labelled corpus proves it.
const PROVEN_SALE_BYTE2 = Object.freeze([0x30, 0x6e, 0x7a, 0xea, 0xee, 0xf9]);

const EXPECTED_CORPUS = Object.freeze({
  replayCount: 10,
  apiItemEventCount: 4997,
  apiPurchasedEventCount: 2404,
  apiDestroyedEventCount: 2415,
  apiSoldEventCount: 116,
  apiUndoEventCount: 62,
  addOrUpdatePacketCount: 2519,
  removalPacketCount: 2074,
  uniquelyLabeledAddOrUpdateCount: 1971,
  patch169ItemIdDirectMatchCount: 0,
  patch169ItemIdMismatchCount: 1971,
  exactSaleLabelCount: 116,
  strictSaleCandidateCount: 116,
  strictSaleExtraCount: 0,
  strictSaleMissingCount: 0,
  destroyOnlySingleRemovalGroupCount: 189,
  transformCollisionCount: 3,
  unresolvedRemovalCompanionPacketCount: 4214,
  unresolvedRemovalCompanionNoRemovalDestroyGroupCount: 432,
  unresolvedRemovalCompanionNoRemovalDestroyPacketCount: 434,
  unresolvedRemovalCompanionDoubleDestroyGroupCount: 25,
  unresolvedRemovalCompanionPacketCountOutsideNoRemovalDestroyGroups: 3780,
  unresolvedRemovalCompanionTimingAssociatedPacketCount: 459,
  unresolvedRemovalCompanionPacketCountOutsideProvenTimingShapes: 3755,
  unresolvedRemovalCompanionDuplicateTimingAssociationCount: 0,
  unresolvedRemovalCompanionBlockIndexCollisionCount: 2,
  unresolvedRemovalCompanionInvalidFramingProvenanceCount: 0,
  unresolvedRemovalCompanionAmbiguousAssociationCount: 0,
  unresolvedRemovalCompanionMissingAssociationCount: 0,
});

const EXPECTED_COMPANION_SPLIT = Object.freeze({
  discovery: Object.freeze({
    replayCount: 7,
    packetCount: 2847,
    noRemovalDestroyGroupCount: 267,
    noRemovalDestroyPacketCount: 269,
    doubleDestroyGroupCount: 15,
    packetCountOutsideNoRemovalDestroyGroups: 2578,
    timingAssociatedPacketCount: 284,
    packetCountOutsideProvenTimingShapes: 2563,
    duplicateTimingAssociationCount: 0,
    blockIndexCollisionCount: 1,
  }),
  holdout: Object.freeze({
    replayCount: 3,
    packetCount: 1367,
    noRemovalDestroyGroupCount: 165,
    noRemovalDestroyPacketCount: 165,
    doubleDestroyGroupCount: 10,
    packetCountOutsideNoRemovalDestroyGroups: 1202,
    timingAssociatedPacketCount: 175,
    packetCountOutsideProvenTimingShapes: 1192,
    duplicateTimingAssociationCount: 0,
    blockIndexCollisionCount: 1,
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "inventory-packet-research-16.14.json"),
    timestampToleranceMillis: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--timestamp-tolerance-ms" && index + 1 < argv.length) {
      args.timestampToleranceMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/research_inventory_packets_16_14.mjs [options]",
        "",
        "The script reads saved .rofl files through the native packet dumper.",
        "Saved Riot timeline fixtures are offline labels only; no runtime decoder is emitted.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.timestampToleranceMillis) || args.timestampToleranceMillis < 0) {
    throw new Error("--timestamp-tolerance-ms must be a non-negative integer.");
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function hexByte(value) {
  return `0x${value.toString(16).padStart(2, "0").toUpperCase()}`;
}

function countBy(values, selector) {
  const counts = new Map();
  for (const value of values) {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function dumpPacketTypes(cliPath, replayPath, packetTypes) {
  const packetArgs = packetTypes.flatMap((packetType) => ["--packet-type", String(packetType)]);
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", replayPath,
    ...packetArgs,
    "--segment-type", "chunk",
    "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Packet dump exited with status ${result.status}.`);
  }
  const dump = JSON.parse(result.stdout);
  if (!dump.valid || dump.errors?.length || dump.packetTypeDumps?.length !== packetTypes.length) {
    throw new Error(`${path.basename(replayPath)} failed the exact multi-packet dump gate.`);
  }
  const byType = new Map(dump.packetTypeDumps.map((entry) => [entry.packetType, entry]));
  for (const packetType of packetTypes) {
    const entry = byType.get(packetType);
    if (!entry || entry.emittedBlockCount !== entry.matchingBlockCount || entry.truncated) {
      throw new Error(`${path.basename(replayPath)} did not emit every 0x${packetType.toString(16)} block.`);
    }
  }
  return byType;
}

function discoverFixtures(args) {
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  return fs.readdirSync(replayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => {
      const replayId = path.basename(entry.name, path.extname(entry.name));
      const fixtureDir = path.join(apiRoot, replayId.replaceAll("-", "_"));
      return {
        replayId,
        replayPath: path.join(replayDir, entry.name),
        matchPath: path.join(fixtureDir, "match.json"),
        timelinePath: path.join(fixtureDir, "timeline.json"),
      };
    })
    .filter((fixture) => fs.existsSync(fixture.matchPath) && fs.existsSync(fixture.timelinePath))
    .filter((fixture) => versionGroup(JSON.parse(fs.readFileSync(fixture.matchPath, "utf8")).info?.gameVersion)
      === PROFILE.versionGroup)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectApiItemEvents(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => String(event.type ?? "").startsWith("ITEM_"))
    .filter((event) => Number.isFinite(event.participantId) && Number.isFinite(event.timestamp))
    .map((event) => ({
      type: event.type,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      itemId: Number.isFinite(event.itemId) ? event.itemId : null,
      beforeId: Number.isFinite(event.beforeId) ? event.beforeId : null,
      afterId: Number.isFinite(event.afterId) ? event.afterId : null,
    }));
}

function normalizeBlock(block, kind) {
  return {
    kind,
    participantId: block.blockParam - PROFILE.championIdBase,
    timestampMillis: block.timestampMillis,
    contentLength: block.contentLength,
    contentHex: block.contentHex,
    blockIndex: block.blockIndex,
    sourceOffset: block.sourceOffset,
    segmentId: block.segmentId,
    chunkId: block.chunkId,
    segmentType: block.segmentType,
    segmentPayloadOffset: block.segmentPayloadOffset,
  };
}

function collectProfileBlocks(addDump, removalDump, unresolvedRemovalCompanionDump) {
  const addLengths = new Set(PROFILE.addOrUpdateContentLengths);
  const removalLengths = new Set(PROFILE.removalContentLengths);
  const companionLengths = new Set(PROFILE.unresolvedRemovalCompanionContentLengths);
  const addOrUpdates = (addDump.blocks ?? [])
    .filter((block) => block.channel === 1 && addLengths.has(block.contentLength))
    .map((block) => normalizeBlock(block, "add-or-update"));
  const removals = (removalDump.blocks ?? [])
    .filter((block) => block.channel === 1 && removalLengths.has(block.contentLength))
    .map((block) => normalizeBlock(block, "removal"));
  const unresolvedRemovalCompanions = (unresolvedRemovalCompanionDump.blocks ?? [])
    .filter((block) => block.channel === 1 && companionLengths.has(block.contentLength))
    .map((block) => normalizeBlock(block, "unresolved-removal-companion"));
  return { addOrUpdates, removals, unresolvedRemovalCompanions };
}

function splitName(replayId) {
  if (FIXTURE_SPLIT.discovery.includes(replayId)) return "discovery";
  if (FIXTURE_SPLIT.holdout.includes(replayId)) return "holdout";
  throw new Error(`Fixture ${replayId} is outside the fixed 16.14 research split.`);
}

// This does not classify any 0x0146 packet. It only measures exact timing
// association with a narrowly predeclared Timeline-only label shape. In
// particular, packets outside that shape remain unresolved rather than being
// inferred as removals.
function buildUnresolvedRemovalCompanionTimingGroups(apiEvents, blocks, toleranceMillis) {
  const byEventTime = new Map();
  for (const event of apiEvents.filter((candidate) => ["ITEM_DESTROYED", "ITEM_SOLD"].includes(candidate.type))) {
    const key = `${event.participantId}:${event.timestampMillis}`;
    const group = byEventTime.get(key) ?? {
      participantId: event.participantId,
      timestampMillis: event.timestampMillis,
      events: [],
    };
    group.events.push(event);
    byEventTime.set(key, group);
  }
  return [...byEventTime.values()].map((group) => {
    const nearby = (candidates) => candidates.filter((candidate) => candidate.participantId === group.participantId
      && Math.abs(candidate.timestampMillis - group.timestampMillis) <= toleranceMillis);
    const companions = nearby(blocks.unresolvedRemovalCompanions);
    return {
      ...group,
      addOrUpdates: nearby(blocks.addOrUpdates),
      removals: nearby(blocks.removals),
      unresolvedRemovalCompanions: companions,
      companionTimestampGroupCount: new Set(companions.map((block) => block.timestampMillis)).size,
    };
  });
}

// Packet groups use exact replay time. The ±1 ms window is only an offline
// label association tolerance; it never changes packet grouping or the rule.
function buildTransactionGroups(apiEvents, blocks, toleranceMillis) {
  const groupByPacketKey = new Map();
  for (const block of [...blocks.addOrUpdates, ...blocks.removals]) {
    const key = `${block.participantId}:${block.timestampMillis}`;
    const group = groupByPacketKey.get(key) ?? {
      participantId: block.participantId,
      timestampMillis: block.timestampMillis,
      events: [],
      addOrUpdates: [],
      removals: [],
    };
    if (block.kind === "add-or-update") group.addOrUpdates.push(block);
    else group.removals.push(block);
    groupByPacketKey.set(key, group);
  }
  const groups = [...groupByPacketKey.values()];
  let ambiguousLabelAssociationCount = 0;
  let unassociatedApiEventCount = 0;
  for (const event of apiEvents) {
    const matches = groups.filter((group) => group.participantId === event.participantId
      && Math.abs(group.timestampMillis - event.timestampMillis) <= toleranceMillis);
    if (matches.length === 1) matches[0].events.push(event);
    else if (matches.length === 0) unassociatedApiEventCount += 1;
    else ambiguousLabelAssociationCount += 1;
  }
  groups.sort((left, right) => left.timestampMillis - right.timestampMillis
    || left.participantId - right.participantId);
  return { groups, ambiguousLabelAssociationCount, unassociatedApiEventCount };
}

function readBitsLittleEndian(bytes, bitOffset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) {
    value |= ((bytes[(bitOffset + bit) >> 3] >> ((bitOffset + bit) & 7)) & 1) << bit;
  }
  return value >>> 0;
}

// Intentionally imported as a falsification oracle, never as a 16.14 decoder.
function decodePatch169AddOrUpdateItemId(contentHex) {
  const bytes = Buffer.from(contentHex, "hex");
  const lowSymbol = readBitsLittleEndian(bytes, 34, 6);
  const highSymbol = readBitsLittleEndian(bytes, 42, 6);
  const high = (51 - highSymbol) & 63;
  const encodedHighBit = readBitsLittleEndian(bytes, 40, 1);
  const bitMask = 1 - readBitsLittleEndian(bytes, 32, 1);
  const specialHigh = high === 52 || high === 62 ? 1 : 0;
  const highBit = encodedHighBit ^ bitMask ^ specialHigh;
  return (high << 7) | ((115 - ((highBit << 6) | lowSymbol)) & 127);
}

function isExactSaleLabel(group) {
  return group.events.length === 1 && group.events[0].type === "ITEM_SOLD";
}

function isSaleMaskShape(group) {
  if (group.addOrUpdates.length !== 0 || group.removals.length !== 1) return false;
  const payload = Buffer.from(group.removals[0].contentHex, "hex");
  return [0x02, 0x05].includes(payload[0] & 0x0f) && (payload[2] & 0x03) !== 0x03;
}

function isStrictSale(group, allowedByte2) {
  if (!isSaleMaskShape(group)) return false;
  return allowedByte2.has(Buffer.from(group.removals[0].contentHex, "hex")[2]);
}

function scoreClassifier(groups, predicate) {
  const actual = groups.filter(isExactSaleLabel);
  const decoded = groups.filter(predicate);
  const decodedSet = new Set(decoded);
  return {
    actualSaleCount: actual.length,
    decodedSaleCandidateCount: decoded.length,
    exactOfflineLabelMatchCount: decoded.filter(isExactSaleLabel).length,
    extraDecodedSaleCandidateCount: decoded.filter((group) => !isExactSaleLabel(group)).length,
    missingApiSaleCandidateCount: actual.filter((group) => !decodedSet.has(group)).length,
  };
}

function leaveOneReplayOut(groups) {
  const replayIds = [...new Set(groups.map((group) => group.replayId))].sort();
  return replayIds.map((holdoutReplayId) => {
    const training = groups.filter((group) => group.replayId !== holdoutReplayId);
    const holdout = groups.filter((group) => group.replayId === holdoutReplayId);
    const trainingBytes = new Set(training.filter(isExactSaleLabel).map((group) =>
      Buffer.from(group.removals[0].contentHex, "hex")[2]));
    return {
      holdoutReplayId,
      trainingSalePayloadByte2: [...trainingBytes].sort((left, right) => left - right).map(hexByte),
      ...scoreClassifier(holdout, (group) => isStrictSale(group, trainingBytes)),
    };
  });
}

function unseenDiscriminatorGate(groups) {
  return PROVEN_SALE_BYTE2.map((withheldByte2) => {
    const allowed = new Set(PROVEN_SALE_BYTE2.filter((value) => value !== withheldByte2));
    return {
      withheldPayloadByte2: hexByte(withheldByte2),
      ...scoreClassifier(groups, (group) => isStrictSale(group, allowed)),
      failClosed: true,
    };
  });
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const fixtures = discoverFixtures(args);
  if (!fixtures.length) throw new Error(`No ${PROFILE.versionGroup} replay/API fixture pairs found.`);
  const expectedSplitFixtureIds = [...FIXTURE_SPLIT.discovery, ...FIXTURE_SPLIT.holdout].sort();
  const actualFixtureIds = fixtures.map((fixture) => fixture.replayId);
  if (actualFixtureIds.length !== expectedSplitFixtureIds.length
    || actualFixtureIds.some((replayId, index) => replayId !== expectedSplitFixtureIds[index])) {
    throw new Error("Patch 16.14 fixture corpus differs from the fixed 7/3 research split; refusing to generalize.");
  }

  const allGroups = [];
  const allUnresolvedRemovalCompanionTimingGroups = [];
  const allUnresolvedRemovalCompanionBlocks = [];
  const allApiEvents = [];
  const replayRows = [];
  for (const fixture of fixtures) {
    const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const apiEvents = collectApiItemEvents(timeline);
    allApiEvents.push(...apiEvents);
    const packetDumps = dumpPacketTypes(cliPath, fixture.replayPath, [
      PROFILE.addOrUpdatePacketType,
      PROFILE.removalPacketType,
      PROFILE.unresolvedRemovalCompanionPacketType,
    ]);
    const blocks = collectProfileBlocks(
      packetDumps.get(PROFILE.addOrUpdatePacketType),
      packetDumps.get(PROFILE.removalPacketType),
      packetDumps.get(PROFILE.unresolvedRemovalCompanionPacketType),
    );
    const grouped = buildTransactionGroups(apiEvents, blocks, args.timestampToleranceMillis);
    const unresolvedRemovalCompanionTimingGroups = buildUnresolvedRemovalCompanionTimingGroups(
      apiEvents, blocks, args.timestampToleranceMillis,
    );
    allGroups.push(...grouped.groups.map((group) => ({ ...group, replayId: fixture.replayId })));
    allUnresolvedRemovalCompanionTimingGroups.push(...unresolvedRemovalCompanionTimingGroups.map((group) => ({
      ...group,
      replayId: fixture.replayId,
      split: splitName(fixture.replayId),
    })));
    allUnresolvedRemovalCompanionBlocks.push(...blocks.unresolvedRemovalCompanions.map((block) => ({
      ...block,
      replayId: fixture.replayId,
    })));
    replayRows.push({
      replayId: fixture.replayId,
      split: splitName(fixture.replayId),
      gameVersion: match.info?.gameVersion ?? null,
      apiItemEventCount: apiEvents.length,
      apiEventTypeCounts: countBy(apiEvents, (event) => event.type),
      addOrUpdatePacketCount: blocks.addOrUpdates.length,
      removalPacketCount: blocks.removals.length,
      unresolvedRemovalCompanionPacketCount: blocks.unresolvedRemovalCompanions.length,
      ambiguousLabelAssociationCount: grouped.ambiguousLabelAssociationCount,
      unassociatedApiEventCount: grouped.unassociatedApiEventCount,
      provenance: {
        replayPacketInput: path.resolve(fixture.replayPath),
        offlineValidationInputs: [path.resolve(fixture.matchPath), path.resolve(fixture.timelinePath)],
        riotDataWasRuntimeInput: false,
      },
    });
  }

  const apiEvents = allApiEvents;
  const addOrUpdates = allGroups.flatMap((group) => group.addOrUpdates);
  const removals = allGroups.flatMap((group) => group.removals);
  const uniqueAddLabels = allGroups.flatMap((group) => {
    const purchases = group.events.filter((event) => event.type === "ITEM_PURCHASED");
    if (purchases.length !== 1 || group.addOrUpdates.length !== 1) return [];
    const decodedItemId = decodePatch169AddOrUpdateItemId(group.addOrUpdates[0].contentHex);
    return [{
      replayId: group.replayId,
      participantId: group.participantId,
      timestampMillis: group.timestampMillis,
      apiItemId: purchases[0].itemId,
      patch169DecodedItemId: decodedItemId,
      matches: decodedItemId === purchases[0].itemId,
    }];
  });
  const exactSales = allGroups.filter(isExactSaleLabel);
  const strictSaleSet = new Set(PROVEN_SALE_BYTE2);
  const strictSaleScore = scoreClassifier(allGroups, (group) => isStrictSale(group, strictSaleSet));
  const maskOnlyScore = scoreClassifier(allGroups, isSaleMaskShape);
  const lolo = leaveOneReplayOut(allGroups);
  const unseen = unseenDiscriminatorGate(allGroups);
  const apiEventTypeCounts = countBy(apiEvents, (event) => event.type);
  const destroyOnlySingleRemovalGroups = allGroups.filter((group) => group.events.length === 1
    && group.events[0].type === "ITEM_DESTROYED"
    && group.addOrUpdates.length === 0 && group.removals.length === 1);
  // These are the three false positives from the earlier byte2-only,
  // single-removal/no-add candidate. The payload[0] nibble rejects all three.
  const transformCollisions = allGroups.filter((group) => group.events.some((event) => event.type === "ITEM_DESTROYED")
    && group.events.some((event) => event.type === "ITEM_PURCHASED")
    && group.addOrUpdates.length === 0 && group.removals.length === 1
    && PROVEN_SALE_BYTE2.includes(Buffer.from(group.removals[0].contentHex, "hex")[2]));
  const companionDestroyedEventCount = (group) => group.events.filter((event) => event.type === "ITEM_DESTROYED").length;
  const companionSoldEventCount = (group) => group.events.filter((event) => event.type === "ITEM_SOLD").length;
  // This is a predeclared timing-label shape, not a 0x0146 classifier. It
  // deliberately names the profiled 0x0369/0x03F9 subfamilies by length.
  const noProfiledRemovalDestroyGroups = allUnresolvedRemovalCompanionTimingGroups.filter((group) =>
    companionDestroyedEventCount(group) === 1 && companionSoldEventCount(group) === 0
      && group.addOrUpdates.length === 0 && group.removals.length === 0);
  const noProfiledRemovalDestroyCompanionPackets = noProfiledRemovalDestroyGroups
    .flatMap((group) => group.unresolvedRemovalCompanions);
  const missingNoProfiledRemovalDestroyCompanionGroups = noProfiledRemovalDestroyGroups
    .filter((group) => group.unresolvedRemovalCompanions.length === 0);
  const ambiguousNoProfiledRemovalDestroyCompanionGroups = noProfiledRemovalDestroyGroups
    .filter((group) => group.unresolvedRemovalCompanions.length > 0 && group.companionTimestampGroupCount !== 1);
  const doubleDestroyCompanionGroups = allUnresolvedRemovalCompanionTimingGroups.filter((group) =>
    companionDestroyedEventCount(group) === 2 && companionSoldEventCount(group) === 0
      && group.addOrUpdates.length === 1 && group.removals.length === 1
      && group.unresolvedRemovalCompanions.length === 1);
  // blockIndex is local to a chunk and sourceOffset is local to a segment.
  // Use the complete framing provenance to identify a physical replay packet.
  const hasPhysicalCompanionProvenance = (block) => typeof block.segmentType === "string"
    && block.segmentType.length > 0 && Number.isInteger(block.segmentId)
    && Number.isInteger(block.segmentPayloadOffset) && Number.isInteger(block.sourceOffset);
  const invalidCompanionProvenanceCount = allUnresolvedRemovalCompanionBlocks
    .filter((block) => !hasPhysicalCompanionProvenance(block)).length;
  if (invalidCompanionProvenanceCount !== 0) {
    throw new Error("0x0146 packet lacks complete framing provenance; refusing timing-union research output.");
  }
  const companionBlockKey = (group, block) => `${group.replayId}:${block.segmentType}:${block.segmentId}:${block.segmentPayloadOffset}:${block.sourceOffset}`;
  const companionBlockIndexKey = (group, block) => `${group.replayId}:${block.blockIndex}`;
  const noProfiledRemovalDestroyCompanionRefs = noProfiledRemovalDestroyGroups.flatMap((group) =>
    group.unresolvedRemovalCompanions.map((block) => ({ group, block })));
  const doubleDestroyCompanionRefs = doubleDestroyCompanionGroups.flatMap((group) =>
    group.unresolvedRemovalCompanions.map((block) => ({ group, block })));
  const timingAssociatedCompanionRefs = [
    ...noProfiledRemovalDestroyCompanionRefs,
    ...doubleDestroyCompanionRefs,
  ];
  const uniqueTimingAssociatedCompanionKeys = new Set(timingAssociatedCompanionRefs.map(({ group, block }) =>
    companionBlockKey(group, block)));
  const duplicateTimingAssociationCount = timingAssociatedCompanionRefs.length - uniqueTimingAssociatedCompanionKeys.size;
  const timingAssociationGroupsByKey = new Map();
  const timingAssociationGroupsByBlockIndexKey = new Map();
  for (const reference of timingAssociatedCompanionRefs) {
    const key = companionBlockKey(reference.group, reference.block);
    const associated = timingAssociationGroupsByKey.get(key) ?? [];
    associated.push(reference);
    timingAssociationGroupsByKey.set(key, associated);
    const blockIndexKey = companionBlockIndexKey(reference.group, reference.block);
    const blockIndexAssociated = timingAssociationGroupsByBlockIndexKey.get(blockIndexKey) ?? [];
    blockIndexAssociated.push(reference);
    timingAssociationGroupsByBlockIndexKey.set(blockIndexKey, blockIndexAssociated);
  }
  const duplicateTimingAssociationSamples = [...timingAssociationGroupsByKey.entries()]
    .filter(([, references]) => references.length > 1)
    .map(([key, references]) => ({
      key,
      associations: references.map(({ group, block }) => ({
        timestampMillis: group.timestampMillis,
        participantId: group.participantId,
        destroyedEventCount: companionDestroyedEventCount(group),
        addOrUpdateCount: group.addOrUpdates.length,
        removalCount: group.removals.length,
        sourceOffset: block.sourceOffset,
        segmentType: block.segmentType,
        segmentPayloadOffset: block.segmentPayloadOffset,
        blockIndex: block.blockIndex,
        blockTimestampMillis: block.timestampMillis,
        segmentId: block.segmentId,
        chunkId: block.chunkId,
      })),
    }));
  const blockIndexCollisionSamples = [...timingAssociationGroupsByBlockIndexKey.entries()]
    .filter(([, references]) => new Set(references.map(({ group, block }) => companionBlockKey(group, block))).size > 1)
    .map(([key, references]) => ({
      key,
      reason: "blockIndex is chunk-local; these are distinct physical packets, not duplicate timing assignments",
      associations: references.map(({ group, block }) => ({
        participantId: group.participantId,
        timestampMillis: group.timestampMillis,
        destroyedEventCount: companionDestroyedEventCount(group),
        addOrUpdateCount: group.addOrUpdates.length,
        removalCount: group.removals.length,
        blockIndex: block.blockIndex,
        blockTimestampMillis: block.timestampMillis,
        sourceOffset: block.sourceOffset,
        segmentType: block.segmentType,
        segmentPayloadOffset: block.segmentPayloadOffset,
        segmentId: block.segmentId,
        chunkId: block.chunkId,
      })),
    }));
  const unresolvedRemovalCompanions = replayRows.reduce(
    (sum, row) => sum + row.unresolvedRemovalCompanionPacketCount, 0,
  );
  const companionSplitTotals = Object.fromEntries(["discovery", "holdout"].map((split) => {
    const rows = replayRows.filter((row) => row.split === split);
    const noRemovalGroups = noProfiledRemovalDestroyGroups.filter((group) => group.split === split);
    const doubleDestroyGroups = doubleDestroyCompanionGroups.filter((group) => group.split === split);
    const noRemovalRefs = noRemovalGroups.flatMap((group) => group.unresolvedRemovalCompanions.map((block) => ({ group, block })));
    const doubleDestroyRefs = doubleDestroyGroups.flatMap((group) => group.unresolvedRemovalCompanions.map((block) => ({ group, block })));
    const associatedRefs = [...noRemovalRefs, ...doubleDestroyRefs];
    const associatedKeys = new Set(associatedRefs.map(({ group, block }) => companionBlockKey(group, block)));
    const blockIndexKeys = new Map();
    for (const reference of associatedRefs) {
      const key = companionBlockIndexKey(reference.group, reference.block);
      const physicalKeys = blockIndexKeys.get(key) ?? new Set();
      physicalKeys.add(companionBlockKey(reference.group, reference.block));
      blockIndexKeys.set(key, physicalKeys);
    }
    const noRemovalPackets = noRemovalRefs.length;
    const associatedPackets = associatedKeys.size;
    const packetCount = rows.reduce((sum, row) => sum + row.unresolvedRemovalCompanionPacketCount, 0);
    return [split, {
      replayCount: rows.length,
      packetCount,
      noRemovalDestroyGroupCount: noRemovalGroups.length,
      noRemovalDestroyPacketCount: noRemovalPackets,
      doubleDestroyGroupCount: doubleDestroyGroups.length,
      packetCountOutsideNoRemovalDestroyGroups: packetCount - noRemovalPackets,
      timingAssociatedPacketCount: associatedPackets,
      packetCountOutsideProvenTimingShapes: packetCount - associatedPackets,
      duplicateTimingAssociationCount: associatedRefs.length - associatedKeys.size,
      blockIndexCollisionCount: [...blockIndexKeys.values()].filter((physicalKeys) => physicalKeys.size > 1).length,
    }];
  }));
  const totals = {
    replayCount: replayRows.length,
    apiItemEventCount: apiEvents.length,
    apiPurchasedEventCount: apiEventTypeCounts.ITEM_PURCHASED ?? 0,
    apiDestroyedEventCount: apiEventTypeCounts.ITEM_DESTROYED ?? 0,
    apiSoldEventCount: apiEventTypeCounts.ITEM_SOLD ?? 0,
    apiUndoEventCount: apiEventTypeCounts.ITEM_UNDO ?? 0,
    addOrUpdatePacketCount: addOrUpdates.length,
    removalPacketCount: removals.length,
    uniquelyLabeledAddOrUpdateCount: uniqueAddLabels.length,
    patch169ItemIdDirectMatchCount: uniqueAddLabels.filter((sample) => sample.matches).length,
    patch169ItemIdMismatchCount: uniqueAddLabels.filter((sample) => !sample.matches).length,
    exactSaleLabelCount: exactSales.length,
    strictSaleCandidateCount: strictSaleScore.decodedSaleCandidateCount,
    strictSaleExtraCount: strictSaleScore.extraDecodedSaleCandidateCount,
    strictSaleMissingCount: strictSaleScore.missingApiSaleCandidateCount,
    destroyOnlySingleRemovalGroupCount: destroyOnlySingleRemovalGroups.length,
    transformCollisionCount: transformCollisions.length,
    unresolvedRemovalCompanionPacketCount: unresolvedRemovalCompanions,
    unresolvedRemovalCompanionNoRemovalDestroyGroupCount: noProfiledRemovalDestroyGroups.length,
    unresolvedRemovalCompanionNoRemovalDestroyPacketCount: noProfiledRemovalDestroyCompanionPackets.length,
    unresolvedRemovalCompanionDoubleDestroyGroupCount: doubleDestroyCompanionGroups.length,
    unresolvedRemovalCompanionPacketCountOutsideNoRemovalDestroyGroups:
      unresolvedRemovalCompanions - noProfiledRemovalDestroyCompanionPackets.length,
    unresolvedRemovalCompanionTimingAssociatedPacketCount:
      uniqueTimingAssociatedCompanionKeys.size,
    unresolvedRemovalCompanionPacketCountOutsideProvenTimingShapes:
      unresolvedRemovalCompanions - uniqueTimingAssociatedCompanionKeys.size,
    unresolvedRemovalCompanionDuplicateTimingAssociationCount: duplicateTimingAssociationCount,
    unresolvedRemovalCompanionBlockIndexCollisionCount: blockIndexCollisionSamples.length,
    unresolvedRemovalCompanionInvalidFramingProvenanceCount: invalidCompanionProvenanceCount,
    unresolvedRemovalCompanionAmbiguousAssociationCount: ambiguousNoProfiledRemovalDestroyCompanionGroups.length,
    unresolvedRemovalCompanionMissingAssociationCount: missingNoProfiledRemovalDestroyCompanionGroups.length,
    ambiguousLabelAssociationCount: replayRows.reduce((sum, row) => sum + row.ambiguousLabelAssociationCount, 0),
    unassociatedApiEventCount: replayRows.reduce((sum, row) => sum + row.unassociatedApiEventCount, 0),
  };
  const loloExact = lolo.every((score) => score.extraDecodedSaleCandidateCount === 0
    && score.missingApiSaleCandidateCount === 0);
  const unseenFailClosed = unseen.every((score) => score.extraDecodedSaleCandidateCount === 0
    && score.missingApiSaleCandidateCount > 0 && score.failClosed);
  const companionSplitValidated = Object.entries(EXPECTED_COMPANION_SPLIT)
    .every(([split, expected]) => Object.entries(expected)
      .every(([key, value]) => companionSplitTotals[split]?.[key] === value));
  const researchEvidenceValidated = Object.entries(EXPECTED_CORPUS)
    .every(([key, expected]) => totals[key] === expected)
    && totals.ambiguousLabelAssociationCount === 0
    && loloExact && unseenFailClosed && companionSplitValidated
    && transformCollisions.every((group) => !isStrictSale(group, strictSaleSet));

  const output = {
    schema: "rofl-inventory-packet-research-16.14/v1",
    generatedAtUtc: new Date().toISOString(),
    status: researchEvidenceValidated ? "research-validated-not-promoted" : "research-regression",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: PROFILE,
    methodology: {
      replayInput: "Exact-framed channel-1 packet blocks from saved ROFL chunks.",
      riotFixtureRole: "Offline labels for falsification and validation only.",
      warning: "No C++/Wasm/UI inventory API is added by this research script.",
    },
    familyValidation: {
      participantIdFormula: "blockParam - 0x400000AD",
      addOrUpdate: { packetType: "0x0369", contentLengths: [14, 15] },
      removal: { packetType: "0x03F9", contentLengths: [6, 7] },
      unresolvedRemovalCompanion: { packetType: "0x0146", contentLengths: [2, 3, 4] },
    },
    patch169ItemIdFalsification: {
      formulaRole: "Negative control only; it is not a patch-16.14 decoder.",
      uniquelyLabeledAddOrUpdateCount: uniqueAddLabels.length,
      directMatchCount: totals.patch169ItemIdDirectMatchCount,
      mismatchCount: totals.patch169ItemIdMismatchCount,
      conclusion: "The patch-16.9 add/update item-ID formula is falsified for patch 16.14.",
    },
    saleClassifier: {
      packetGrouping: "same replay, participant, and exact replay timestamp",
      maskPredicate: [
        "addOrUpdateCount == 0",
        "removalCount == 1",
        "(payload[0] & 0x0F) in {0x02, 0x05}",
        "(payload[2] & 0x03) != 0x03",
      ],
      provenPayloadByte2ProfileBoundary: PROVEN_SALE_BYTE2.map(hexByte),
      strictRuntimeSafetyRule: "A byte outside the proven profile boundary is unavailable, never guessed as sale.",
      maskOnlyScore,
      strictProfileScore: strictSaleScore,
      knownTransformCollisionCount: transformCollisions.length,
      knownTransformCollisionsRejected: transformCollisions.every((group) => !isStrictSale(group, strictSaleSet)),
      destroyOnlySingleRemovalCount: destroyOnlySingleRemovalGroups.length,
      leaveOneReplayOut: lolo,
      leaveOneReplayOutExact: loloExact,
      unseenDiscriminatorFailClosed: unseen,
      unseenDiscriminatorFailClosedGatePassed: unseenFailClosed,
      conclusion: "Exact sale operation research evidence only; sold item ID, slot, instance, undo, and full inventory state remain unresolved.",
    },
    unresolvedRemovalCompanionTimingEvidence: {
      labelRole: "Saved Timeline timing labels only; this is not a packet semantic classifier.",
      targetDefinition: [
        "exactly one ITEM_DESTROYED and zero ITEM_SOLD at the Timeline owner/timestamp",
        "no profiled 0x0369 packet of length 14 or 15 within owner and ±1 ms",
        "no profiled 0x03F9 packet of length 6 or 7 within owner and ±1 ms",
      ],
      noProfiledRemovalDestroyGroupCount: noProfiledRemovalDestroyGroups.length,
      associatedPacketCount: noProfiledRemovalDestroyCompanionPackets.length,
      missingAssociationCount: missingNoProfiledRemovalDestroyCompanionGroups.length,
      ambiguousAssociationCount: ambiguousNoProfiledRemovalDestroyCompanionGroups.length,
      doubleDestroyCompanionGroupDefinition: [
        "two ITEM_DESTROYED and zero ITEM_SOLD at the Timeline owner/timestamp",
        "one profiled 0x0369(14/15), one profiled 0x03F9(6/7), and one 0x0146(2/3/4) within owner and ±1 ms",
      ],
      doubleDestroyCompanionGroupCount: doubleDestroyCompanionGroups.length,
      timingAssociatedPacketCount: totals.unresolvedRemovalCompanionTimingAssociatedPacketCount,
      duplicateTimingAssociationCount: totals.unresolvedRemovalCompanionDuplicateTimingAssociationCount,
      duplicateTimingAssociationSamples,
      timingAssociationKey: "${replayId}:${segmentType}:${segmentId}:${segmentPayloadOffset}:${sourceOffset}",
      invalidFramingProvenanceCount: totals.unresolvedRemovalCompanionInvalidFramingProvenanceCount,
      blockIndexCollisionCount: totals.unresolvedRemovalCompanionBlockIndexCollisionCount,
      blockIndexCollisionSamples,
      packetCountOutsideNoRemovalDestroyGroups: totals.unresolvedRemovalCompanionPacketCountOutsideNoRemovalDestroyGroups,
      packetCountOutsideProvenTimingShapes: totals.unresolvedRemovalCompanionPacketCountOutsideProvenTimingShapes,
      split: companionSplitTotals,
      splitGatePassed: companionSplitValidated,
      classifierAvailable: false,
      runtimeSemanticClaimCount: 0,
      runtimeFalseClaimCount: 0,
      runtimeFalseClaimDefinition: "No 0x0146 packet is emitted, classified, or treated as an inventory removal at runtime.",
      conclusion: "Timing association identifies a second removal-context family, but its payload grammar, item, slot, instance, and operation semantics remain unavailable.",
    },
    totals,
    expectedCorpus: EXPECTED_CORPUS,
    promotionBoundary: {
      passed: false,
      reason: "This script proves research evidence only; no runtime API may consume it.",
      unresolved: ["add/update item-ID grammar", "removal item/slot/instance", "0x0146 companion grammar", "undo", "complete inventory reducer"],
    },
    replayRows,
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote patch 16.14 inventory packet research to ${outputPath}`);
  console.log(`replays=${totals.replayCount}, adds=${totals.addOrUpdatePacketCount}, removals=${totals.removalPacketCount}, `
    + `itemIdNegativeControl=${totals.patch169ItemIdDirectMatchCount}/${totals.uniquelyLabeledAddOrUpdateCount}, `
    + `sales=${strictSaleScore.exactOfflineLabelMatchCount}/${totals.exactSaleLabelCount}, `
    + `researchOnly=${output.researchOnly}`);
  if (!researchEvidenceValidated) process.exitCode = 1;
}

main();
