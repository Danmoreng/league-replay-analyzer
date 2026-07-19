#!/usr/bin/env node

// Offline research only. Slot candidates come exclusively from saved ROFL
// packet bytes. Saved Timeline events are used only as validation labels and
// are never runtime input.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  removalPacketType: 0x03f9,
  championOwnerBase: 0x400000ad,
  trinketItemIds: Object.freeze([3340, 3363, 3364]),
  discovery: Object.freeze([
    "EUW1-7919517389",
    "EUW1-7919624327",
    "EUW1-7920241664",
    "EUW1-7920292147",
    "EUW1-7920341366",
    "EUW1-7920364492",
    "EUW1-7920550565",
  ]),
  holdout: Object.freeze(["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"]),
});

// Filled from the fixed D7/H3 corpus after the candidate was selected on D7.
// Any corpus, framing, or semantic-oracle drift must fail closed.
const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    replayCount: 7,
    removalCount: 1293,
    unavailableSlotCount: 0,
    contentLengths: Object.freeze({ 6: 389, 7: 904 }),
    slotCounts: Object.freeze({ 0: 99, 1: 125, 2: 165, 3: 186, 4: 323, 5: 193, 6: 202 }),
    symbols: Object.freeze({
      "6:00": 99,
      "6:10": 165,
      "6:11": 125,
      "7:00": 193,
      "7:01": 323,
      "7:10": 186,
      "7:11": 202,
    }),
    operationNibbles: Object.freeze({ 2: 3, 5: 268, 13: 1022 }),
    multiRemovalGroupCount: 337,
    multiRemovalUniqueSlotGroupCount: 318,
    multiRemovalDuplicateSlotGroupCount: 19,
    strictTrinketReplacementCount: 50,
    strictTrinketSlot6Count: 50,
    strictTrinketWrongSlotCount: 0,
    strictSaleCount: 77,
    strictSaleSlots: Object.freeze({ 0: 18, 1: 17, 2: 11, 3: 7, 4: 12, 5: 12 }),
    strictSaleOperationNibbles: Object.freeze({ 2: 3, 5: 74 }),
    strictSaleUniqueFinalEmptySlotCount: 1,
    strictSaleUniqueFinalEmptySlotExactCount: 1,
    strictSaleUniqueFinalEmptySlotWrongCount: 0,
  }),
  holdout: Object.freeze({
    replayCount: 3,
    removalCount: 781,
    unavailableSlotCount: 0,
    contentLengths: Object.freeze({ 6: 277, 7: 504 }),
    slotCounts: Object.freeze({ 0: 81, 1: 83, 2: 113, 3: 135, 4: 168, 5: 91, 6: 110 }),
    symbols: Object.freeze({
      "6:00": 81,
      "6:10": 113,
      "6:11": 83,
      "7:00": 91,
      "7:01": 168,
      "7:10": 135,
      "7:11": 110,
    }),
    operationNibbles: Object.freeze({ 2: 1, 5: 308, 13: 472 }),
    multiRemovalGroupCount: 198,
    multiRemovalUniqueSlotGroupCount: 188,
    multiRemovalDuplicateSlotGroupCount: 10,
    strictTrinketReplacementCount: 22,
    strictTrinketSlot6Count: 22,
    strictTrinketWrongSlotCount: 0,
    strictSaleCount: 39,
    strictSaleSlots: Object.freeze({ 0: 11, 1: 7, 2: 7, 3: 5, 4: 5, 5: 4 }),
    strictSaleOperationNibbles: Object.freeze({ 2: 1, 5: 38 }),
    strictSaleUniqueFinalEmptySlotCount: 0,
    strictSaleUniqueFinalEmptySlotExactCount: 0,
    strictSaleUniqueFinalEmptySlotWrongCount: 0,
  }),
  combined: Object.freeze({
    replayCount: 10,
    removalCount: 2074,
    unavailableSlotCount: 0,
    contentLengths: Object.freeze({ 6: 666, 7: 1408 }),
    slotCounts: Object.freeze({
      0: 180,
      1: 208,
      2: 278,
      3: 321,
      4: 491,
      5: 284,
      6: 312,
    }),
    symbols: Object.freeze({
      "6:00": 180,
      "6:10": 278,
      "6:11": 208,
      "7:00": 284,
      "7:01": 491,
      "7:10": 321,
      "7:11": 312,
    }),
    operationNibbles: Object.freeze({ 2: 4, 5: 576, 13: 1494 }),
    multiRemovalGroupCount: 535,
    multiRemovalUniqueSlotGroupCount: 506,
    multiRemovalDuplicateSlotGroupCount: 29,
    strictTrinketReplacementCount: 72,
    strictTrinketSlot6Count: 72,
    strictTrinketWrongSlotCount: 0,
    strictSaleCount: 116,
    strictSaleSlots: Object.freeze({ 0: 29, 1: 24, 2: 18, 3: 12, 4: 17, 5: 16 }),
    strictSaleOperationNibbles: Object.freeze({ 2: 4, 5: 112 }),
    strictSaleUniqueFinalEmptySlotCount: 1,
    strictSaleUniqueFinalEmptySlotExactCount: 1,
    strictSaleUniqueFinalEmptySlotWrongCount: 0,
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("tmp", "inventory-removal-slots-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_removal_slots_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function fail(message, detail = undefined) {
  throw new Error(
    `${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

function slotSymbol(payload) {
  const length = payload.length;
  if (length === 6) return `${payloadBit(payload, 7)}${payloadBit(payload, 8)}`;
  if (length === 7) return `${payloadBit(payload, 16)}${payloadBit(payload, 17)}`;
  return null;
}

function decodeRemovalSlot(payload) {
  const symbol = slotSymbol(payload);
  if (payload.length === 6) {
    return { "00": 0, 11: 1, 10: 2 }[symbol] ?? null;
  }
  if (payload.length === 7) {
    return { 10: 3, "01": 4, "00": 5, 11: 6 }[symbol] ?? null;
  }
  return null;
}

function dumpRemovals(args, replayPath) {
  const run = spawnSync(
    args.cliPath,
    [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      String(PROFILE.removalPacketType),
      "--segment-type",
      "chunk",
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) fail("Native removal dump failed.", { replayPath, stderr: run.stderr });
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.gameVersion !== PROFILE.exactReplayBuild
  ) {
    fail("Exact removal framing/version gate failed.", { replayPath });
  }
  return dump.blocks ?? [];
}

function timelineItemEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter(
      (event) =>
        ["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type) &&
        Number.isInteger(event.participantId) &&
        Number.isInteger(event.timestamp),
    );
}

function groupBy(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return groups;
}

function countBy(rows, keyFor) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(keyFor(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function inspectReplay(args, replayId, partition) {
  const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
  const fixtureRoot = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  const matchPath = path.join(fixtureRoot, "match.json");
  if (![replayPath, timelinePath, matchPath].every(fs.existsSync)) {
    fail("Fixed replay/API fixture missing.", { replayId });
  }
  const match = readJson(matchPath);
  const timeline = readJson(timelinePath);
  if (match.info?.gameVersion !== PROFILE.exactReplayBuild) {
    fail("Fixture exact-build gate failed.", { replayId });
  }
  const removals = dumpRemovals(args, replayPath)
    .filter((block) => block.channel === 1 && [6, 7].includes(block.contentLength))
    .map((block) => {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      const payload = Buffer.from(block.contentHex, "hex");
      if (participantId < 1 || participantId > 10) return null;
      return {
        replayId,
        partition,
        participantId,
        timestampMillis: block.timestampMillis,
        segmentId: block.segmentId,
        sourceOffset: block.sourceOffset,
        contentLength: payload.length,
        payloadHex: block.contentHex,
        symbol: slotSymbol(payload),
        slot: decodeRemovalSlot(payload),
        operationNibble: payload[0] & 0x0f,
        suffixHex: payload.subarray(payload.length - 4).toString("hex"),
      };
    })
    .filter(Boolean);
  const events = timelineItemEvents(timeline);
  const eventGroups = groupBy(events, (event) => `${event.participantId}:${event.timestamp}`);
  const removalGroups = [
    ...groupBy(
      removals,
      (removal) => `${removal.participantId}:${removal.timestampMillis}`,
    ).values(),
  ];
  const strictTrinketReplacements = [];
  const strictSales = [];
  for (const eventsAtTime of eventGroups.values()) {
    const participantId = eventsAtTime[0].participantId;
    const timestampMillis = eventsAtTime[0].timestamp;
    const matchingRemovals = removals.filter(
      (removal) =>
        removal.participantId === participantId &&
        Math.abs(removal.timestampMillis - timestampMillis) <= 1,
    );
    const destroyedTrinkets = eventsAtTime.filter(
      (event) => event.type === "ITEM_DESTROYED" && PROFILE.trinketItemIds.includes(event.itemId),
    );
    const purchasedTrinkets = eventsAtTime.filter(
      (event) => event.type === "ITEM_PURCHASED" && PROFILE.trinketItemIds.includes(event.itemId),
    );
    if (
      eventsAtTime.length === 2 &&
      destroyedTrinkets.length === 1 &&
      purchasedTrinkets.length === 1 &&
      matchingRemovals.length === 1
    ) {
      strictTrinketReplacements.push({
        replayId,
        partition,
        participantId,
        timestampMillis,
        destroyedItemId: destroyedTrinkets[0].itemId,
        purchasedItemId: purchasedTrinkets[0].itemId,
        removal: matchingRemovals[0],
      });
    }
    const sales = eventsAtTime.filter((event) => event.type === "ITEM_SOLD");
    if (eventsAtTime.length === 1 && sales.length === 1 && matchingRemovals.length === 1) {
      const participant = match.info?.participants?.[participantId - 1];
      const finalMainSlots = Array.from({ length: 6 }, (_, slot) => participant?.[`item${slot}`]);
      const laterItemEvents = events.filter(
        (event) => event.participantId === participantId && event.timestamp > timestampMillis + 1,
      );
      const emptyFinalSlots = finalMainSlots
        .map((itemId, slot) => ({ itemId, slot }))
        .filter((entry) => entry.itemId === 0)
        .map((entry) => entry.slot);
      strictSales.push({
        replayId,
        partition,
        participantId,
        timestampMillis,
        itemId: sales[0].itemId,
        removal: matchingRemovals[0],
        finalMainSlots,
        uniqueFinalEmptySlot:
          laterItemEvents.length === 0 && emptyFinalSlots.length === 1 ? emptyFinalSlots[0] : null,
      });
    }
  }
  return { partition, removals, removalGroups, strictTrinketReplacements, strictSales };
}

function summarizePartition(rows) {
  const removals = rows.flatMap((row) => row.removals);
  const removalGroups = rows.flatMap((row) => row.removalGroups);
  const trinkets = rows.flatMap((row) => row.strictTrinketReplacements);
  const sales = rows.flatMap((row) => row.strictSales);
  const finalEmptySlotSales = sales.filter((row) => row.uniqueFinalEmptySlot !== null);
  return {
    replayCount: rows.length,
    removalCount: removals.length,
    unavailableSlotCount: removals.filter((row) => row.slot === null).length,
    contentLengths: countBy(removals, (row) => row.contentLength),
    slotCounts: countBy(removals, (row) => row.slot),
    symbols: countBy(removals, (row) => `${row.contentLength}:${row.symbol}`),
    operationNibbles: countBy(removals, (row) => row.operationNibble),
    multiRemovalGroupCount: removalGroups.filter((group) => group.length > 1).length,
    multiRemovalUniqueSlotGroupCount: removalGroups.filter(
      (group) => group.length > 1 && new Set(group.map((row) => row.slot)).size === group.length,
    ).length,
    multiRemovalDuplicateSlotGroupCount: removalGroups.filter(
      (group) => group.length > 1 && new Set(group.map((row) => row.slot)).size !== group.length,
    ).length,
    strictTrinketReplacementCount: trinkets.length,
    strictTrinketSlot6Count: trinkets.filter((row) => row.removal.slot === 6).length,
    strictTrinketWrongSlotCount: trinkets.filter((row) => row.removal.slot !== 6).length,
    strictSaleCount: sales.length,
    strictSaleSlots: countBy(sales, (row) => row.removal.slot),
    strictSaleOperationNibbles: countBy(sales, (row) => row.removal.operationNibble),
    strictSaleUniqueFinalEmptySlotCount: finalEmptySlotSales.length,
    strictSaleUniqueFinalEmptySlotExactCount: finalEmptySlotSales.filter(
      (row) => row.removal.slot === row.uniqueFinalEmptySlot,
    ).length,
    strictSaleUniqueFinalEmptySlotWrongCount: finalEmptySlotSales.filter(
      (row) => row.removal.slot !== row.uniqueFinalEmptySlot,
    ).length,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const rows = [
    ...PROFILE.discovery.map((replayId) => inspectReplay(args, replayId, "D7")),
    ...PROFILE.holdout.map((replayId) => inspectReplay(args, replayId, "H3")),
  ];
  const discoveryRows = rows.filter((row) => row.partition === "D7");
  const holdoutRows = rows.filter((row) => row.partition === "H3");
  const actual = {
    discovery: summarizePartition(discoveryRows),
    holdout: summarizePartition(holdoutRows),
    combined: summarizePartition(rows),
  };
  if (Object.keys(EXPECTED).length > 0 && JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
    fail("Frozen removal-slot research metrics drifted.", { expected: EXPECTED, actual });
  }
  const output = {
    schema: "rofl-inventory-removal-slot-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
    candidateGrammar: {
      sixByte: { "bit7=0,bit8=0": 0, "bit7=1,bit8=1": 1, "bit7=1,bit8=0": 2 },
      sixByteUnavailableSymbol: "bit7=0,bit8=1 (unseen in the fixed corpus)",
      sevenByte: {
        "bit16=1,bit17=0": 3,
        "bit16=0,bit17=1": 4,
        "bit16=0,bit17=0": 5,
        "bit16=1,bit17=1": 6,
      },
    },
    metrics: actual,
    strictTrinketReplacementRows: rows.flatMap((row) => row.strictTrinketReplacements),
    strictSaleUniqueFinalEmptySlotRows: rows
      .flatMap((row) => row.strictSales)
      .filter((row) => row.uniqueFinalEmptySlot !== null),
    duplicateSlotGroupSamples: rows
      .flatMap((row) => row.removalGroups)
      .filter(
        (group) =>
          group.length > 1 && new Set(group.map((removal) => removal.slot)).size !== group.length,
      )
      .slice(0, 40),
    conclusion:
      "The exact-build removal family carries a total seven-value structural slot candidate. Strict saved-Timeline trinket replacements independently validate candidate slot 6. Slots 0-5 still lack a zero-error semantic oracle, and add placement, swaps, counts, instances, item identity, Undo, gold, and full inventory state remain unavailable.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(actual, null, 2));
  console.log(`Wrote removal-slot research to ${outputPath}`);
}

main();
