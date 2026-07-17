#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.9",
  championIdBase: 0x400000ad,
  addOrUpdatePacketType: 0x0132,
  addOrUpdateContentLengths: Object.freeze([14, 15]),
  removalPacketType: 0x0415,
  removalContentLengths: Object.freeze([6, 7]),
});

const KNOWN_AUTOMATIC_TRANSFORMS = new Map([
  [3003, 3040], // Archangel's Staff -> Seraph's Embrace
  [3119, 3121], // Winter's Approach -> Fimbulwinter
]);

const SALE_REMOVAL_DISCRIMINATORS = new Set([
  0x68,
  0x69,
  0xba,
  0xbe,
  0xc2,
  0xc6,
  0xdf,
]);

const EXPECTED_CORPUS = Object.freeze({
  replayCount: 20,
  apiItemEventCount: 8874,
  apiPurchasedEventCount: 4488,
  apiDestroyedEventCount: 4050,
  apiSoldEventCount: 189,
  apiUndoEventCount: 147,
  addOrUpdatePacketCount: 4454,
  removalPacketCount: 3550,
  uniquelyLabeledAddOrUpdateCount: 3716,
  directItemIdMatchCount: 3714,
  explainedAutomaticTransformCount: 2,
  unexplainedItemIdMismatchCount: 0,
  exactSaleRemovalMatchCount: 189,
  decodedSaleCandidateCount: 189,
  extraDecodedSaleCandidateCount: 0,
  missingApiSaleCandidateCount: 0,
  packetOnlyAddOrUpdateGroupCount: 174,
  packetOnlyRemovalGroupCount: 0,
  destroyOnlySingleRemovalGroupCount: 266,
  undoGroupWithCandidatePacketCount: 0,
  sameItemReplacementPairCount: 151,
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "inventory-packet-research-16.9.json"),
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
        "Usage: node ./scripts/research_inventory_packets_16_9.mjs [options]",
        "",
        "Options:",
        "  --cli <path>                    Native rofl_core_cli executable.",
        "  --replay-dir <path>             Directory containing .rofl files.",
        "  --api-root <path>               Offline Riot fixture root.",
        "  --output <path>                 Research JSON output.",
        "  --timestamp-tolerance-ms <n>    Timestamp tolerance; default 1.",
        "",
        "The packet dumps receive only ROFL paths. Riot match/timeline files are",
        "offline labels used to falsify or validate candidate semantics. This script",
        "does not provide runtime inventory extraction and never promotes a decoder.",
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

function readBitsLittleEndian(bytes, bitOffset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) {
    value |= ((bytes[(bitOffset + bit) >> 3] >> ((bitOffset + bit) & 7)) & 1) << bit;
  }
  return value >>> 0;
}

export function decodePatch169AddOrUpdateItemId(contentHex) {
  const bytes = Buffer.from(contentHex, "hex");
  if (bytes.length !== 14 && bytes.length !== 15) {
    throw new Error(`Patch 16.9 add/update payload must be 14 or 15 bytes, got ${bytes.length}.`);
  }
  const lowSymbol = readBitsLittleEndian(bytes, 34, 6);
  const highSymbol = readBitsLittleEndian(bytes, 42, 6);
  const high = (51 - highSymbol) & 63;
  const encodedHighBit = readBitsLittleEndian(bytes, 40, 1);
  const bitMask = 1 - readBitsLittleEndian(bytes, 32, 1);
  const specialHigh = high === 52 || high === 62 ? 1 : 0;
  const highBit = encodedHighBit ^ bitMask ^ specialHigh;
  const encodedLow7 = (highBit << 6) | lowSymbol;
  const low7 = (115 - encodedLow7) & 127;
  return (high << 7) | low7;
}

function dumpPacketType(cliPath, replayPath, packetType) {
  const result = spawnSync(cliPath, [
    "--dump-packet-type-json",
    replayPath,
    "--packet-type",
    String(packetType),
    "--segment-type",
    "chunk",
    "--max-blocks",
    "0",
  ], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Packet dump exited with status ${result.status}.`);
  }
  return JSON.parse(result.stdout);
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
    .filter((fixture) => {
      const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
      return versionGroup(match.info?.gameVersion) === PROFILE.versionGroup;
    })
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectApiItemEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => String(event.type ?? "").startsWith("ITEM_"))
    .filter((event) => Number.isFinite(event.participantId) && Number.isFinite(event.timestamp))
    .map((event, sourceIndex) => ({
      sourceIndex,
      type: event.type,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      itemId: Number.isFinite(event.itemId) ? event.itemId : null,
      beforeId: Number.isFinite(event.beforeId) ? event.beforeId : null,
      afterId: Number.isFinite(event.afterId) ? event.afterId : null,
      goldGain: Number.isFinite(event.goldGain) ? event.goldGain : null,
    }));
}

function normalizeBlock(block, kind) {
  return {
    kind,
    participantId: block.blockParam - PROFILE.championIdBase,
    timestampMillis: block.timestampMillis,
    packetType: block.packetType,
    contentLength: block.contentLength,
    contentHex: block.contentHex,
    marker: block.marker,
    segmentId: block.segmentId,
    chunkId: block.chunkId,
    blockIndex: block.blockIndex,
    sourceOffset: block.sourceOffset,
    headerOffset: block.headerOffset,
  };
}

function collectProfileBlocks(addDump, removalDump) {
  const addLengths = new Set(PROFILE.addOrUpdateContentLengths);
  const removalLengths = new Set(PROFILE.removalContentLengths);
  const addOrUpdates = (addDump.blocks ?? [])
    .filter((block) => block.channel === 1 && addLengths.has(block.contentLength))
    .map((block) => ({
      ...normalizeBlock(block, "add-or-update"),
      decodedItemId: decodePatch169AddOrUpdateItemId(block.contentHex),
    }));
  const removals = (removalDump.blocks ?? [])
    .filter((block) => block.channel === 1 && removalLengths.has(block.contentLength))
    .map((block) => normalizeBlock(block, "removal"));
  return { addOrUpdates, removals };
}

function buildTransactionGroups(apiEvents, blocks, toleranceMillis) {
  const apiGroups = new Map();
  for (const event of apiEvents) {
    const key = `${event.participantId}:${event.timestampMillis}`;
    const group = apiGroups.get(key) ?? {
      participantId: event.participantId,
      timestampMillis: event.timestampMillis,
      events: [],
      addOrUpdates: [],
      removals: [],
    };
    group.events.push(event);
    apiGroups.set(key, group);
  }
  const groups = [...apiGroups.values()];
  let ambiguousPacketAssignmentCount = 0;
  for (const block of [...blocks.addOrUpdates, ...blocks.removals]) {
    const matches = groups.filter((group) =>
      group.participantId === block.participantId
      && Math.abs(group.timestampMillis - block.timestampMillis) <= toleranceMillis);
    let group;
    if (matches.length === 1) {
      [group] = matches;
    } else if (matches.length === 0) {
      group = groups.find((candidate) =>
        candidate.events.length === 0
        && candidate.participantId === block.participantId
        && candidate.timestampMillis === block.timestampMillis);
      if (!group) {
        group = {
          participantId: block.participantId,
          timestampMillis: block.timestampMillis,
          events: [],
          addOrUpdates: [],
          removals: [],
        };
        groups.push(group);
      }
    } else {
      ambiguousPacketAssignmentCount += 1;
      continue;
    }
    if (block.kind === "add-or-update") group.addOrUpdates.push(block);
    else group.removals.push(block);
  }
  groups.sort((left, right) =>
    left.timestampMillis - right.timestampMillis || left.participantId - right.participantId);
  return { groups, ambiguousPacketAssignmentCount };
}

function eventSignature(group) {
  return group.events.map((event) => event.type).sort().join("+") || "NO_API_EVENT";
}

function shapeKey(group) {
  return `${eventSignature(group)}|a${group.addOrUpdates.length}r${group.removals.length}`;
}

function countBy(values, selector) {
  const counts = new Map();
  for (const value of values) {
    const key = selector(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function bidirectionalMappingScore(pairs, addOffset, removeOffset, width) {
  const byAdd = new Map();
  const byRemove = new Map();
  for (const pair of pairs) {
    const addValue = readBitsLittleEndian(Buffer.from(pair.add.contentHex, "hex"), addOffset, width);
    const removeValue = readBitsLittleEndian(Buffer.from(pair.remove.contentHex, "hex"), removeOffset, width);
    const removeCounts = byAdd.get(addValue) ?? new Map();
    removeCounts.set(removeValue, (removeCounts.get(removeValue) ?? 0) + 1);
    byAdd.set(addValue, removeCounts);
    const addCounts = byRemove.get(removeValue) ?? new Map();
    addCounts.set(addValue, (addCounts.get(addValue) ?? 0) + 1);
    byRemove.set(removeValue, addCounts);
  }
  let forwardSupport = 0;
  for (const counts of byAdd.values()) forwardSupport += Math.max(...counts.values());
  let reverseSupport = 0;
  for (const counts of byRemove.values()) reverseSupport += Math.max(...counts.values());
  return {
    width,
    addOffset,
    removeOffset,
    addValueCount: byAdd.size,
    removeValueCount: byRemove.size,
    forwardSupport,
    reverseSupport,
    bidirectionalSupport: Math.min(forwardSupport, reverseSupport),
    rate: pairs.length ? Math.min(forwardSupport, reverseSupport) / pairs.length : 0,
  };
}

function scanCandidateSlotRegions(pairs) {
  let best = null;
  let stableCandidateCount = 0;
  for (let width = 2; width <= 10; width += 1) {
    for (let addOffset = 0; addOffset <= 34 - width; addOffset += 1) {
      for (let removeOffset = 0; removeOffset <= 16 - width; removeOffset += 1) {
        const result = bidirectionalMappingScore(pairs, addOffset, removeOffset, width);
        if (
          result.addValueCount < 4
          || result.removeValueCount < 4
          || result.addValueCount > 32
          || result.removeValueCount > 32
        ) continue;
        if (!best || result.rate > best.rate || (result.rate === best.rate && result.width > best.width)) {
          best = result;
        }
        if (result.rate >= 0.8) stableCandidateCount += 1;
      }
    }
  }
  return {
    pairCount: pairs.length,
    searchedAddBitRange: [0, 33],
    searchedRemovalBitRange: [0, 15],
    searchedWidths: [2, 10],
    stableCandidateThreshold: 0.8,
    stableCandidateCount,
    bestCandidate: best,
  };
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

  const replayRows = [];
  const allGroups = [];
  for (const fixture of fixtures) {
    const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const apiEvents = collectApiItemEvents(timeline);
    const addDump = dumpPacketType(cliPath, fixture.replayPath, PROFILE.addOrUpdatePacketType);
    const removalDump = dumpPacketType(cliPath, fixture.replayPath, PROFILE.removalPacketType);
    const blocks = collectProfileBlocks(addDump, removalDump);
    const grouped = buildTransactionGroups(apiEvents, blocks, args.timestampToleranceMillis);
    for (const group of grouped.groups) allGroups.push({ ...group, replayId: fixture.replayId });
    replayRows.push({
      replayId: fixture.replayId,
      gameVersion: match.info?.gameVersion ?? null,
      apiItemEventCount: apiEvents.length,
      apiEventTypeCounts: countBy(apiEvents, (event) => event.type),
      addOrUpdatePacketCount: blocks.addOrUpdates.length,
      removalPacketCount: blocks.removals.length,
      transactionGroupCount: grouped.groups.length,
      ambiguousPacketAssignmentCount: grouped.ambiguousPacketAssignmentCount,
      provenance: {
        replayOnlyPacketInput: path.resolve(fixture.replayPath),
        offlineValidationInputs: [path.resolve(fixture.matchPath), path.resolve(fixture.timelinePath)],
        riotDataWasRuntimeInput: false,
      },
    });
  }

  const apiEvents = allGroups.flatMap((group) => group.events);
  const addOrUpdates = allGroups.flatMap((group) => group.addOrUpdates);
  const removals = allGroups.flatMap((group) => group.removals);
  const uniquelyLabeledAdds = [];
  for (const group of allGroups) {
    const purchases = group.events.filter((event) => event.type === "ITEM_PURCHASED");
    if (purchases.length !== 1 || group.addOrUpdates.length !== 1) continue;
    const apiItemId = purchases[0].itemId;
    const decodedItemId = group.addOrUpdates[0].decodedItemId;
    const expectedTransform = KNOWN_AUTOMATIC_TRANSFORMS.get(apiItemId);
    const transformSourceDestroyed = group.events.some((event) =>
      event.type === "ITEM_DESTROYED" && event.itemId === apiItemId);
    const classification = decodedItemId === apiItemId
      ? "direct-match"
      : (expectedTransform === decodedItemId && transformSourceDestroyed
        ? "explained-automatic-transform"
        : "unexplained-mismatch");
    uniquelyLabeledAdds.push({
      replayId: group.replayId,
      participantId: group.participantId,
      timestampMillis: group.timestampMillis,
      apiItemId,
      decodedItemId,
      classification,
      contentHex: group.addOrUpdates[0].contentHex,
    });
  }

  const saleGroups = allGroups.filter((group) => group.events.some((event) => event.type === "ITEM_SOLD"));
  const exactSaleGroups = saleGroups.filter((group) =>
    group.events.length === 1
    && group.events[0].type === "ITEM_SOLD"
    && group.addOrUpdates.length === 0
    && group.removals.length === 1);
  const decodedSaleGroups = allGroups.filter((group) =>
    group.addOrUpdates.length === 0
    && group.removals.length === 1
    && SALE_REMOVAL_DISCRIMINATORS.has(
      Buffer.from(group.removals[0].contentHex, "hex")[2],
    ));
  const extraDecodedSaleGroups = decodedSaleGroups.filter((group) =>
    !(group.events.length === 1 && group.events[0].type === "ITEM_SOLD"));
  const missingApiSaleGroups = saleGroups.filter((group) =>
    !decodedSaleGroups.includes(group));
  const destroyOnlySingleRemovalGroups = allGroups.filter((group) =>
    group.events.length === 1
    && group.events[0].type === "ITEM_DESTROYED"
    && group.addOrUpdates.length === 0
    && group.removals.length === 1);
  const undoGroups = allGroups.filter((group) => group.events.some((event) => event.type === "ITEM_UNDO"));
  const packetOnlyAddGroups = allGroups.filter((group) =>
    group.events.length === 0 && group.addOrUpdates.length > 0 && group.removals.length === 0);
  const packetOnlyRemovalGroups = allGroups.filter((group) =>
    group.events.length === 0 && group.removals.length > 0);
  const sameItemReplacementPairs = allGroups
    .filter((group) =>
      group.events.length === 2
      && group.events[0].type === "ITEM_DESTROYED"
      && group.events[1].type === "ITEM_PURCHASED"
      && group.events[0].itemId === 2055
      && group.events[1].itemId === 2055
      && group.addOrUpdates.length === 1
      && group.removals.length === 1)
    .map((group) => ({ add: group.addOrUpdates[0], remove: group.removals[0] }));
  const sharedTwoBitStateCount = sameItemReplacementPairs.filter((pair) =>
    readBitsLittleEndian(Buffer.from(pair.add.contentHex, "hex"), 48, 2)
    === readBitsLittleEndian(Buffer.from(pair.remove.contentHex, "hex"), 16, 2)).length;
  const slotRegionScan = scanCandidateSlotRegions(sameItemReplacementPairs);

  const apiEventTypeCounts = countBy(apiEvents, (event) => event.type);
  const directItemIdMatchCount = uniquelyLabeledAdds
    .filter((sample) => sample.classification === "direct-match").length;
  const explainedAutomaticTransformCount = uniquelyLabeledAdds
    .filter((sample) => sample.classification === "explained-automatic-transform").length;
  const unexplainedSamples = uniquelyLabeledAdds
    .filter((sample) => sample.classification === "unexplained-mismatch");
  const totals = {
    replayCount: replayRows.length,
    apiItemEventCount: apiEvents.length,
    apiPurchasedEventCount: apiEventTypeCounts.ITEM_PURCHASED ?? 0,
    apiDestroyedEventCount: apiEventTypeCounts.ITEM_DESTROYED ?? 0,
    apiSoldEventCount: apiEventTypeCounts.ITEM_SOLD ?? 0,
    apiUndoEventCount: apiEventTypeCounts.ITEM_UNDO ?? 0,
    addOrUpdatePacketCount: addOrUpdates.length,
    removalPacketCount: removals.length,
    uniquelyLabeledAddOrUpdateCount: uniquelyLabeledAdds.length,
    uniquelyLabeledApiItemIdCount: new Set(uniquelyLabeledAdds.map((sample) => sample.apiItemId)).size,
    directItemIdMatchCount,
    explainedAutomaticTransformCount,
    unexplainedItemIdMismatchCount: unexplainedSamples.length,
    exactSaleRemovalMatchCount: exactSaleGroups.length,
    decodedSaleCandidateCount: decodedSaleGroups.length,
    extraDecodedSaleCandidateCount: extraDecodedSaleGroups.length,
    missingApiSaleCandidateCount: missingApiSaleGroups.length,
    packetOnlyAddOrUpdateGroupCount: packetOnlyAddGroups.length,
    packetOnlyRemovalGroupCount: packetOnlyRemovalGroups.length,
    destroyOnlySingleRemovalGroupCount: destroyOnlySingleRemovalGroups.length,
    undoGroupWithCandidatePacketCount: undoGroups.filter((group) =>
      group.addOrUpdates.length > 0 || group.removals.length > 0).length,
    sameItemReplacementPairCount: sameItemReplacementPairs.length,
    sameItemReplacementSharedTwoBitStateCount: sharedTwoBitStateCount,
    ambiguousPacketAssignmentCount: replayRows.reduce(
      (sum, row) => sum + row.ambiguousPacketAssignmentCount, 0),
  };
  const researchEvidenceValidated = Object.entries(EXPECTED_CORPUS)
    .every(([key, expected]) => totals[key] === expected)
    && totals.ambiguousPacketAssignmentCount === 0
    && sharedTwoBitStateCount === sameItemReplacementPairs.length;
  const promotionGate = {
    passed: false,
    cxxRuntimeDecoderAdded: false,
    requirements: {
      addOrUpdateItemIdExactWithExplicitTransforms:
        totals.unexplainedItemIdMismatchCount === 0,
      removalSlotOrInstanceDecoded: false,
      removalItemIdResolvedWithoutRiotInput: false,
      saleVersusDestroyClassifiedWithoutRiotInput:
        totals.extraDecodedSaleCandidateCount === 0
        && totals.missingApiSaleCandidateCount === 0,
      undoPacketFamilyDecoded: false,
      fullInventoryStateExactReplayCount: 0,
      fullInventoryStateRequiredReplayCount: totals.replayCount,
      zeroExtraNormalizedTransactionEvents: false,
    },
    blockers: [
      `${totals.removalPacketCount} removal packets carry no decoded item ID; slot/instance remains unresolved.`,
      "Sale-vs-destroy requires the validated payload[2] discriminator; the sold item ID still cannot be recovered without slot/instance decoding.",
      `${totals.apiUndoEventCount} ITEM_UNDO labels have no packets from the two candidate families.`,
      `${totals.packetOnlyAddOrUpdateGroupCount} add/update groups have no API item-event label and include automatic state transitions.`,
      `The best contiguous candidate-slot-region mapping reaches only ${(100 * (slotRegionScan.bestCandidate?.rate ?? 0)).toFixed(2)}% on ${slotRegionScan.pairCount} same-item replacement pairs.`,
    ],
  };
  const output = {
    schema: "rofl-inventory-packet-research-16.9/v1",
    generatedAtUtc: new Date().toISOString(),
    status: researchEvidenceValidated ? "research-validated-not-promoted" : "research-regression",
    mode: "offline-validation-only",
    runtimeInput: false,
    profile: PROFILE,
    methodology: {
      replayInput: "Exact-framed channel-1 packet blocks from ROFL chunks.",
      riotFixtureRole: "Offline labels for timestamp, participant, and transaction semantics only.",
      itemIdDecoderRuntimeInputs: ["patch version", "packet content bytes"],
      warning: "Packet opcode/timestamp correlation is not a normalized transaction decoder.",
    },
    itemIdDecoder: {
      formula: {
        lowSymbol: "readBitsLE(payload, 34, 6)",
        highSymbol: "readBitsLE(payload, 42, 6)",
        high: "(51 - highSymbol) & 63",
        encodedHighBit: "readBitLE(payload, 40)",
        mask: "1 - readBitLE(payload, 32)",
        specialHigh: "high == 52 || high == 62",
        low7: "(115 - (((encodedHighBit ^ mask ^ specialHigh) << 6) | lowSymbol)) & 127",
        itemId: "(high << 7) | low7",
      },
      directItemIdMatchCount,
      explainedAutomaticTransforms: uniquelyLabeledAdds.filter((sample) =>
        sample.classification === "explained-automatic-transform"),
      unexplainedMismatches: unexplainedSamples,
    },
    transactionShapeCounts: countBy(allGroups, shapeKey),
    saleClassifier: {
      versionGroup: PROFILE.versionGroup,
      requirements: {
        addOrUpdatePacketCountAtOwnerTimestamp: 0,
        removalPacketCountAtOwnerTimestamp: 1,
        removalPayloadByte2: [...SALE_REMOVAL_DISCRIMINATORS]
          .sort((left, right) => left - right),
      },
      decodedSaleCandidateCount: decodedSaleGroups.length,
      exactOfflineLabelMatchCount:
        decodedSaleGroups.length - extraDecodedSaleGroups.length,
      extraDecodedSaleCandidateCount: extraDecodedSaleGroups.length,
      missingApiSaleCandidateCount: missingApiSaleGroups.length,
      itemIdResolved: false,
      conclusion: "Sale operation class is exact on the 16.9 corpus; sold item identity remains unresolved.",
    },
    slotAndInstanceResearch: {
      sameItemReplacementPairCount: sameItemReplacementPairs.length,
      sharedTwoBitState: {
        addBitOffset: 48,
        removalBitOffset: 16,
        width: 2,
        exactPairCount: sharedTwoBitStateCount,
        interpretation: "Likely stack/count/charge state; it is not promoted as a slot identifier.",
      },
      candidateSlotRegionScan: slotRegionScan,
      conclusion: "No exact slot or item-instance link is proven.",
    },
    inventoryStateValidation: {
      attemptedReplayCount: totals.replayCount,
      exactFullInventoryStateReplayCount: 0,
      unresolvedRemovalCount: totals.removalPacketCount,
      conclusion: "Full inventory state cannot be validated until removal slot/instance and swaps are decoded.",
    },
    totals,
    expectedCorpus: EXPECTED_CORPUS,
    promotionGate,
    replayRows,
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote patch 16.9 inventory packet research to ${outputPath}`);
  console.log(
    `replays=${totals.replayCount}, adds=${totals.addOrUpdatePacketCount}, removals=${totals.removalPacketCount}, `
    + `itemIds=${directItemIdMatchCount}+${explainedAutomaticTransformCount}/${uniquelyLabeledAdds.length}, `
    + `sales=${totals.exactSaleRemovalMatchCount}/${totals.apiSoldEventCount}, `
    + `promotionGate=${promotionGate.passed}`,
  );
  if (!researchEvidenceValidated) process.exitCode = 1;
}

main();
