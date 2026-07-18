#!/usr/bin/env node

// Offline research only. This harness establishes seven individual item-ID
// bit positions from saved 16.14 ROFL packet bytes. The formulas were selected
// during corpus exploration, so the per-replay results below are cross-checks,
// not leak-free formula-discovery holdouts. It does not decode a complete item
// ID and it must never be consumed by a runtime inventory API.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.14",
  championIdBase: 0x400000ad,
  packetType: 0x0369,
  payloadLengths: new Set([14, 15]),
  labelToleranceMillis: 1,
});

const FIXTURES = Object.freeze([
  ["EUW1-7919517389", 168], ["EUW1-7919624327", 158],
  ["EUW1-7920241664", 223], ["EUW1-7920292147", 218],
  ["EUW1-7920341366", 152], ["EUW1-7920364492", 185],
  ["EUW1-7920550565", 216], ["EUW1-7921377760", 168],
  ["EUW1-7921482297", 283], ["EUW1-7921996430", 200],
].map(([replayId, expectedLabelCount]) => Object.freeze({ replayId, expectedLabelCount })));

const EXPECTED = Object.freeze({
  fixtureCount: 10,
  labelCount: 1971,
  unmatchedTimelinePurchaseCount: 236,
  unseenItemIdSampleCount: 30,
  itemIdBitWidth: 13,
  maximumItemId: 8191,
  exactBits: Object.freeze([0, 1, 5, 6, 7, 10, 12]),
  unavailableBits: Object.freeze([2, 3, 4, 8, 9, 11]),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "inventory-item-id-bits-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (argument === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (argument === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/research_inventory_item_id_bits_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function versionGroup(value) { return String(value ?? "").split(".").slice(0, 2).join("."); }
function payloadBit(bytes, index) { return (bytes[index >> 3] >> (index & 7)) & 1; }

// These are seven independently validated bits, not a partial lookup table.
// Every other item-ID bit is deliberately unavailable below.
const BIT_FORMULAS = Object.freeze({
  0: (p) => payloadBit(p, 71),
  1: (p) => payloadBit(p, 66) ^ payloadBit(p, 71) ^ 1,
  5: (p) => payloadBit(p, 70) ^ 1,
  6: (p) => payloadBit(p, 69) ^ payloadBit(p, 70) ^ 1,
  7: (p) => payloadBit(p, 78) ^ payloadBit(p, 79),
  10: (p) => payloadBit(p, 73) ^ payloadBit(p, 76) ^ 1,
  12: (p) => payloadBit(p, 78) ^ 1,
});
const FORMULA_TEXT = Object.freeze({
  0: "payloadBit(71)", 1: "payloadBit(66) XOR payloadBit(71) XOR 1",
  5: "payloadBit(70) XOR 1", 6: "payloadBit(69) XOR payloadBit(70) XOR 1",
  7: "payloadBit(78) XOR payloadBit(79)", 10: "payloadBit(73) XOR payloadBit(76) XOR 1",
  12: "payloadBit(78) XOR 1",
});

function dumpBlocks(cliPath, replayPath) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", replayPath, "--packet-type", String(PROFILE.packetType),
    "--segment-type", "chunk", "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${path.basename(replayPath)} packet dump failed.`);
  const payload = JSON.parse(result.stdout);
  const typeDump = payload.packetTypeDumps?.find((entry) => entry.packetType === PROFILE.packetType);
  if (!payload.valid || payload.errors?.length || !typeDump || typeDump.truncated || typeDump.emittedBlockCount !== typeDump.matchingBlockCount) {
    throw new Error(`${path.basename(replayPath)} failed the complete packet-dump gate.`);
  }
  const relevantBlocks = (typeDump.blocks ?? []).filter((block) => block.channel === 1 && PROFILE.payloadLengths.has(block.contentLength));
  for (const block of relevantBlocks) {
    if (block.contentHexTruncated !== false || block.contentHexBytes !== block.contentLength
      || typeof block.contentHex !== "string" || block.contentHex.length !== block.contentLength * 2
      || !/^[0-9a-f]*$/iu.test(block.contentHex)) {
      throw new Error(`${path.basename(replayPath)} contains an incomplete or invalid packet payload.`);
    }
  }
  return relevantBlocks
    .map((block) => ({
      participantId: block.blockParam - PROFILE.championIdBase,
      timestampMillis: block.timestampMillis,
      contentHex: block.contentHex,
    }))
    .filter((block) => Number.isInteger(block.participantId) && block.participantId >= 1 && block.participantId <= 10);
}

function purchasesFromTimeline(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_PURCHASED" && Number.isInteger(event.participantId)
      && Number.isInteger(event.timestamp) && Number.isInteger(event.itemId))
    .map((event) => ({ participantId: event.participantId, timestampMillis: event.timestamp, itemId: event.itemId }));
}

// Packet groups are exact (replay, owner, packet timestamp). The one ms
// tolerance exists only to associate the saved Timeline oracle timestamp; it
// is an offline validation detail and never forms a runtime decode rule.
function labelsForFixture(replayId, purchases, blocks) {
  const groups = new Map();
  for (const block of blocks) {
    const key = `${block.participantId}:${block.timestampMillis}`;
    const group = groups.get(key) ?? { participantId: block.participantId, timestampMillis: block.timestampMillis, blocks: [], purchases: [] };
    group.blocks.push(block);
    groups.set(key, group);
  }
  let unmatchedPurchases = 0;
  let ambiguousPurchases = 0;
  for (const purchase of purchases) {
    const matches = [...groups.values()].filter((group) => group.participantId === purchase.participantId
      && Math.abs(group.timestampMillis - purchase.timestampMillis) <= PROFILE.labelToleranceMillis);
    if (matches.length === 0) { unmatchedPurchases += 1; continue; }
    if (matches.length !== 1) { ambiguousPurchases += 1; continue; }
    matches[0].purchases.push(purchase);
  }
  const labels = [...groups.values()].flatMap((group) => {
    if (group.blocks.length !== 1 || group.purchases.length !== 1) return [];
    const payload = Buffer.from(group.blocks[0].contentHex, "hex");
    if (payload.length !== group.blocks[0].contentHex.length / 2) throw new Error(`${replayId} contains an invalid hex payload.`);
    return [{ replayId, participantId: group.participantId, timestampMillis: group.timestampMillis, itemId: group.purchases[0].itemId, payload }];
  });
  return { labels, unmatchedPurchases, ambiguousPurchases };
}

function evaluateBit(rows, bit) {
  const formula = BIT_FORMULAS[bit];
  let exact = 0;
  for (const row of rows) if (formula(row.payload) === ((row.itemId >>> bit) & 1)) exact += 1;
  return { exact, sampleCount: rows.length };
}

function preselectedFormulaCrossReplay(rows, bit) {
  let exact = 0, unseenExact = 0, unseenSampleCount = 0;
  const folds = [];
  for (const fixture of FIXTURES) {
    const test = rows.filter((row) => row.replayId === fixture.replayId);
    const trainIds = new Set(rows.filter((row) => row.replayId !== fixture.replayId).map((row) => row.itemId));
    let foldExact = 0, foldUnseenExact = 0, foldUnseenSampleCount = 0;
    for (const row of test) {
      const hit = BIT_FORMULAS[bit](row.payload) === ((row.itemId >>> bit) & 1);
      if (hit) foldExact += 1;
      if (!trainIds.has(row.itemId)) {
        foldUnseenSampleCount += 1;
        if (hit) foldUnseenExact += 1;
      }
    }
    exact += foldExact; unseenExact += foldUnseenExact; unseenSampleCount += foldUnseenSampleCount;
    folds.push({ replayId: fixture.replayId, exact: foldExact, sampleCount: test.length, unseenItemIdExact: foldUnseenExact, unseenItemIdSampleCount: foldUnseenSampleCount });
  }
  return {
    interpretation: "Preselected formula checked per replay; no formula is trained or selected inside a fold.",
    exact,
    sampleCount: rows.length,
    unseenItemIdExact: unseenExact,
    unseenItemIdSampleCount: unseenSampleCount,
    replayChecks: folds,
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
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  const rows = [];
  const fixtures = [];
  let unmatchedPurchases = 0, ambiguousPurchases = 0;
  for (const fixture of FIXTURES) {
    const replayPath = path.join(replayDir, `${fixture.replayId}.rofl`);
    const fixtureRoot = path.join(apiRoot, fixture.replayId.replaceAll("-", "_"));
    const matchPath = path.join(fixtureRoot, "match.json");
    const timelinePath = path.join(fixtureRoot, "timeline.json");
    if (![replayPath, matchPath, timelinePath].every(fs.existsSync)) throw new Error(`Missing fixed 16.14 fixture input for ${fixture.replayId}.`);
    const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
    if (versionGroup(match.info?.gameVersion) !== PROFILE.versionGroup) throw new Error(`${fixture.replayId} is not a ${PROFILE.versionGroup} fixture.`);
    const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
    const joined = labelsForFixture(fixture.replayId, purchasesFromTimeline(timeline), dumpBlocks(cliPath, replayPath));
    if (joined.labels.length !== fixture.expectedLabelCount || joined.ambiguousPurchases !== 0) throw new Error(`${fixture.replayId} label gate drifted: labels=${joined.labels.length}, expected=${fixture.expectedLabelCount}, ambiguous=${joined.ambiguousPurchases}.`);
    rows.push(...joined.labels);
    unmatchedPurchases += joined.unmatchedPurchases; ambiguousPurchases += joined.ambiguousPurchases;
    fixtures.push({ replayId: fixture.replayId, gameVersion: match.info?.gameVersion ?? null, labelCount: joined.labels.length });
  }
  if (!rows.every((row) => Number.isInteger(row.itemId) && row.itemId >= 0 && row.itemId <= EXPECTED.maximumItemId)) {
    throw new Error(`A labelled item ID lies outside the gated ${EXPECTED.itemIdBitWidth}-bit range.`);
  }
  const modeledBitSet = new Set([...EXPECTED.exactBits, ...EXPECTED.unavailableBits]);
  if (modeledBitSet.size !== EXPECTED.itemIdBitWidth
    || [...Array(EXPECTED.itemIdBitWidth).keys()].some((bit) => !modeledBitSet.has(bit))) {
    throw new Error("The modeled and unavailable bit positions do not partition the gated item-ID width.");
  }
  const direct = Object.fromEntries(EXPECTED.exactBits.map((bit) => [bit, evaluateBit(rows, bit)]));
  const crossReplay = Object.fromEntries(EXPECTED.exactBits.map((bit) => [bit, preselectedFormulaCrossReplay(rows, bit)]));
  const passed = rows.length === EXPECTED.labelCount && fixtures.length === EXPECTED.fixtureCount
    && unmatchedPurchases === EXPECTED.unmatchedTimelinePurchaseCount && ambiguousPurchases === 0
    && EXPECTED.exactBits.every((bit) => direct[bit].exact === EXPECTED.labelCount
      && crossReplay[bit].exact === EXPECTED.labelCount
      && crossReplay[bit].unseenItemIdExact === EXPECTED.unseenItemIdSampleCount
      && crossReplay[bit].unseenItemIdSampleCount === EXPECTED.unseenItemIdSampleCount);
  const output = {
    schema: "rofl-inventory-item-id-bits-16.14-research/v1",
    status: passed ? "research-validated-not-promoted" : "research-regression",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: { versionGroup: PROFILE.versionGroup, packetType: "0x0369", channel: 1, payloadLengths: [...PROFILE.payloadLengths], participantIdFormula: "blockParam - 0x400000AD" },
    offlineOracle: { input: "Saved Riot Timeline ITEM_PURCHASED labels only", packetGroup: "exact replay + participant + ROFL packet timestamp", timelineAssociationToleranceMillis: PROFILE.labelToleranceMillis, runtimeUse: false },
    fixedFixtures: fixtures,
    expected: EXPECTED,
    evidenceBoundary: "The formulas were preselected during full-corpus exploration. Per-replay and unseen-item-ID results are cross-checks, not formula-discovery holdouts.",
    validatedBits: EXPECTED.exactBits.map((bit) => ({ bit, formula: FORMULA_TEXT[bit], direct: direct[bit], preselectedFormulaCrossReplay: crossReplay[bit] })),
    unavailableBits: EXPECTED.unavailableBits.map((bit) => ({ bit, available: false, reason: "This harness does not provide a validated formula for this bit position." })),
    counts: { labelCount: rows.length, unmatchedTimelinePurchases: unmatchedPurchases, ambiguousTimelinePurchases: ambiguousPurchases },
    promotionBoundary: { passed: false, reason: "Seven validated bit positions do not identify an item. The six unmodeled positions, slot, instance, removals, undo, and inventory state are unavailable." },
  };
  writeJson(path.resolve(args.outputPath), output);
  console.log(`Wrote ${path.resolve(args.outputPath)}; labels=${rows.length}; exactBits=${EXPECTED.exactBits.length}; researchOnly=true.`);
  if (!passed) process.exitCode = 1;
}

main();
