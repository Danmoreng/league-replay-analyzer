#!/usr/bin/env node

// Offline research only. This harness establishes a compact 13-bit item-ID
// grammar from saved 16.14 ROFL packet bytes. The six formulas added in the
// current research step were selected on the seven fixed Discovery replays;
// seven earlier formulas predate that split. The three fixed Holdouts validate
// the six new formulas after selection. This must not feed a runtime API.
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
  ["EUW1-7919517389", 168, 195], ["EUW1-7919624327", 158, 201],
  ["EUW1-7920241664", 223, 274], ["EUW1-7920292147", 218, 246],
  ["EUW1-7920341366", 152, 183], ["EUW1-7920364492", 185, 220],
  ["EUW1-7920550565", 216, 256], ["EUW1-7921377760", 168, 260],
  ["EUW1-7921482297", 283, 444], ["EUW1-7921996430", 200, 240],
].map(([replayId, expectedLabelCount, expectedProfilePacketCount]) => Object.freeze({ replayId, expectedLabelCount, expectedProfilePacketCount })));

const EXPECTED = Object.freeze({
  fixtureCount: 10,
  labelCount: 1971,
  profilePacketCount: 2519,
  structurallyDecodableProfilePacketCount: 2519,
  unknownProfileSymbolCount: 0,
  exactPurchaseLinkedPacketCount: 1973,
  exactPurchaseLinkedGroupCount: 1972,
  transactionUnresolvedPacketCount: 546,
  discoveryProfilePacketCount: 1575,
  holdoutProfilePacketCount: 944,
  discoveryExactPurchaseLinkedPacketCount: 1320,
  holdoutExactPurchaseLinkedPacketCount: 653,
  discoveryTransactionUnresolvedPacketCount: 255,
  holdoutTransactionUnresolvedPacketCount: 291,
  unmatchedTimelinePurchaseCount: 236,
  unseenItemIdSampleCount: 30,
  itemIdBitWidth: 13,
  maximumItemId: 8191,
  exactBits: Object.freeze(Array.from({ length: 13 }, (_, bit) => bit)),
  discoveryReplayIds: Object.freeze(["EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664", "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492", "EUW1-7920550565"]),
  holdoutReplayIds: Object.freeze(["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"]),
  discoverySampleCount: 1320,
  holdoutSampleCount: 651,
  holdoutUnseenItemIdSampleCount: 19,
  truthTableCoverage: Object.freeze({
    0: Object.freeze({ observedCodeCount: 2, missingCodes: Object.freeze([]) }),
    1: Object.freeze({ observedCodeCount: 4, missingCodes: Object.freeze([]) }),
    2: Object.freeze({ observedCodeCount: 8, missingCodes: Object.freeze([]) }),
    3: Object.freeze({ observedCodeCount: 16, missingCodes: Object.freeze([]) }),
    4: Object.freeze({ observedCodeCount: 32, missingCodes: Object.freeze([]) }),
    5: Object.freeze({ observedCodeCount: 2, missingCodes: Object.freeze([]) }),
    6: Object.freeze({ observedCodeCount: 4, missingCodes: Object.freeze([]) }),
    7: Object.freeze({ observedCodeCount: 4, missingCodes: Object.freeze([]) }),
    8: Object.freeze({ observedCodeCount: 8, missingCodes: Object.freeze([]) }),
    9: Object.freeze({ observedCodeCount: 7, missingCodes: Object.freeze([0]) }),
    10: Object.freeze({ observedCodeCount: 4, missingCodes: Object.freeze([]) }),
    11: Object.freeze({ observedCodeCount: 7, missingCodes: Object.freeze([4]) }),
    12: Object.freeze({ observedCodeCount: 2, missingCodes: Object.freeze([]) }),
  }),
  extendedLengthNegativeControl: Object.freeze({
    payloadLengths: Object.freeze([16, 17]),
    packetCount: 9,
    structurallyDecodablePacketCount: 9,
    exactPurchaseLinkedPacketCount: 8,
    extraPacketCount: 1,
    excludedCoResidentExactCandidateCount: 0,
    coResidentExcludedCandidatePacketCount: 1,
    newExactPurchaseLinkedGroupCount: 8,
    previousUnmatchedExactPacketCount: 8,
    discovery: Object.freeze({ packetCount: 6, structurallyDecodablePacketCount: 6, exactPurchaseLinkedPacketCount: 6, extraPacketCount: 0, excludedCoResidentExactCandidateCount: 0, coResidentExcludedCandidatePacketCount: 0, newExactPurchaseLinkedGroupCount: 6, previousUnmatchedExactPacketCount: 6 }),
    holdout: Object.freeze({ packetCount: 3, structurallyDecodablePacketCount: 3, exactPurchaseLinkedPacketCount: 2, extraPacketCount: 1, excludedCoResidentExactCandidateCount: 0, coResidentExcludedCandidatePacketCount: 1, newExactPurchaseLinkedGroupCount: 2, previousUnmatchedExactPacketCount: 2 }),
    hypotheticalExtendedProfile: Object.freeze({
      packetCount: 2528,
      structurallyDecodablePacketCount: 2528,
      unknownSymbolPacketCount: 0,
      exactPurchaseLinkedPacketCount: 1981,
      exactPurchaseLinkedGroupCount: 1980,
      transactionUnresolvedPacketCount: 547,
      unmatchedTimelinePurchaseCount: 228,
    }),
  }),
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

// Fixed compact Boolean grammar, not an item-ID lookup. p[8..9] are the
// relevant payload bytes; index is the little-endian bit offset in payload.
const BIT_FORMULAS = Object.freeze({
  0: (p) => payloadBit(p, 71),
  1: (p) => payloadBit(p, 66) ^ payloadBit(p, 71) ^ 1,
  2: (p) => payloadBit(p, 65) ^ (payloadBit(p, 66) & payloadBit(p, 71)),
  3: (p) => 1 ^ payloadBit(p, 65) ^ payloadBit(p, 68) ^ (payloadBit(p, 66) & payloadBit(p, 71)) ^ (payloadBit(p, 65) & payloadBit(p, 66) & payloadBit(p, 71)),
  4: (p) => 1 ^ payloadBit(p, 67) ^ payloadBit(p, 68) ^ (payloadBit(p, 65) & payloadBit(p, 68)) ^ (payloadBit(p, 66) & payloadBit(p, 68) & payloadBit(p, 71)) ^ (payloadBit(p, 65) & payloadBit(p, 66) & payloadBit(p, 68) & payloadBit(p, 71)),
  5: (p) => payloadBit(p, 70) ^ 1,
  6: (p) => payloadBit(p, 69) ^ payloadBit(p, 70) ^ 1,
  7: (p) => payloadBit(p, 78) ^ payloadBit(p, 79),
  8: (p) => 1 ^ payloadBit(p, 74) ^ payloadBit(p, 79) ^ (payloadBit(p, 72) & payloadBit(p, 79)),
  9: (p) => payloadBit(p, 73) ^ (payloadBit(p, 73) & payloadBit(p, 79)) ^ (payloadBit(p, 72) & payloadBit(p, 73) & payloadBit(p, 79)),
  10: (p) => payloadBit(p, 73) ^ payloadBit(p, 76) ^ 1,
  11: (p) => 1 ^ payloadBit(p, 75) ^ payloadBit(p, 76) ^ (payloadBit(p, 73) & payloadBit(p, 76)),
  12: (p) => payloadBit(p, 78) ^ 1,
});
const FORMULA_TEXT = Object.freeze({
  0: "payloadBit(71)", 1: "payloadBit(66) XOR payloadBit(71) XOR 1",
  2: "payloadBit(65) XOR (payloadBit(66) AND payloadBit(71))",
  3: "1 XOR payloadBit(65) XOR payloadBit(68) XOR (payloadBit(66) AND payloadBit(71)) XOR (payloadBit(65) AND payloadBit(66) AND payloadBit(71))",
  4: "1 XOR payloadBit(67) XOR payloadBit(68) XOR (payloadBit(65) AND payloadBit(68)) XOR (payloadBit(66) AND payloadBit(68) AND payloadBit(71)) XOR (payloadBit(65) AND payloadBit(66) AND payloadBit(68) AND payloadBit(71))",
  5: "payloadBit(70) XOR 1", 6: "payloadBit(69) XOR payloadBit(70) XOR 1",
  7: "payloadBit(78) XOR payloadBit(79)",
  8: "1 XOR payloadBit(74) XOR payloadBit(79) XOR (payloadBit(72) AND payloadBit(79))",
  9: "payloadBit(73) XOR (payloadBit(73) AND payloadBit(79)) XOR (payloadBit(72) AND payloadBit(73) AND payloadBit(79))",
  10: "payloadBit(73) XOR payloadBit(76) XOR 1",
  11: "1 XOR payloadBit(75) XOR payloadBit(76) XOR (payloadBit(73) AND payloadBit(76))",
  12: "payloadBit(78) XOR 1",
});
const FORMULA_INPUT_BITS = Object.freeze({
  0: Object.freeze([71]),
  1: Object.freeze([66, 71]),
  2: Object.freeze([65, 66, 71]),
  3: Object.freeze([65, 66, 68, 71]),
  4: Object.freeze([65, 66, 67, 68, 71]),
  5: Object.freeze([70]),
  6: Object.freeze([69, 70]),
  7: Object.freeze([78, 79]),
  8: Object.freeze([72, 74, 79]),
  9: Object.freeze([72, 73, 79]),
  10: Object.freeze([73, 76]),
  11: Object.freeze([73, 75, 76]),
  12: Object.freeze([78]),
});

function inputCode(payload, inputBits) {
  return inputBits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

function payloadForInputCode(inputBits, code) {
  const payload = Buffer.alloc(10);
  for (let index = 0; index < inputBits.length; index += 1) {
    if (((code >>> index) & 1) === 0) continue;
    const bit = inputBits[index];
    payload[bit >> 3] |= 1 << (bit & 7);
  }
  return payload;
}

// Discovery and holdout both lack one input symbol for bits 9 and 11. The ANF
// completion is retained as a compact description of observed rows, but those
// two unseen symbols are never decoded: a future packet must fail closed.
function validatedBit(payload, bit) {
  const coverage = EXPECTED.truthTableCoverage[bit];
  const inputBits = FORMULA_INPUT_BITS[bit];
  if (coverage && inputBits && coverage.missingCodes.includes(inputCode(payload, inputBits))) return null;
  return BIT_FORMULAS[bit](payload);
}

function dumpChampionOwnedBlocks(cliPath, replayPath) {
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
  const championOwnedBlocks = (typeDump.blocks ?? []).filter((block) => block.channel === 1
    && Number.isInteger(block.blockParam - PROFILE.championIdBase)
    && block.blockParam - PROFILE.championIdBase >= 1 && block.blockParam - PROFILE.championIdBase <= 10);
  for (const block of championOwnedBlocks) {
    if (block.contentHexTruncated !== false || block.contentHexBytes !== block.contentLength
      || typeof block.contentHex !== "string" || block.contentHex.length !== block.contentLength * 2
      || !/^[0-9a-f]*$/iu.test(block.contentHex)) {
      throw new Error(`${path.basename(replayPath)} contains an incomplete or invalid packet payload.`);
    }
  }
  return championOwnedBlocks
    .map((block) => ({
      participantId: block.blockParam - PROFILE.championIdBase,
      timestampMillis: block.timestampMillis,
      contentHex: block.contentHex,
      contentLength: block.contentLength,
      blockIndex: block.blockIndex,
      segmentType: block.segmentType,
      segmentId: block.segmentId,
      chunkId: block.chunkId,
      segmentPayloadOffset: block.segmentPayloadOffset,
      sourceOffset: block.sourceOffset,
    }));
}

function dumpBlocks(cliPath, replayPath) {
  return dumpChampionOwnedBlocks(cliPath, replayPath)
    .filter((block) => PROFILE.payloadLengths.has(block.contentLength));
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
  return {
    labels,
    groups: [...groups.values()].map((group) => ({ ...group, replayId })),
    unmatchedPurchases,
    ambiguousPurchases,
  };
}

function packetGroupsForFixture(replayId, purchases, blocks) {
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
  return { groups: [...groups.values()].map((group) => ({ ...group, replayId })), unmatchedPurchases, ambiguousPurchases };
}

function extendedLengthNegativeControl(replayId, purchases, allChampionOwnedBlocks, oldGroups) {
  const candidateLengths = new Set(EXPECTED.extendedLengthNegativeControl.payloadLengths);
  const extendedBlocks = allChampionOwnedBlocks.filter((block) => PROFILE.payloadLengths.has(block.contentLength)
    || candidateLengths.has(block.contentLength));
  const extended = packetGroupsForFixture(replayId, purchases, extendedBlocks);
  const complete = packetGroupsForFixture(replayId, purchases, allChampionOwnedBlocks);
  const exactGroups = extended.groups.filter((group) => {
    const decodedItemIds = group.blocks.map((block) => decodeItemId(Buffer.from(block.contentHex, "hex")));
    return decodedItemIds.every((itemId) => itemId !== null)
      && multisetEqual(decodedItemIds, group.purchases.map((purchase) => purchase.itemId));
  });
  const exactKeys = new Set(exactGroups.map((group) => `${group.participantId}:${group.timestampMillis}`));
  const candidates = extendedBlocks.filter((block) => candidateLengths.has(block.contentLength));
  const completeGroupFor = (block) => complete.groups.find((group) => group.participantId === block.participantId
    && group.timestampMillis === block.timestampMillis) ?? null;
  const hasExcludedCoResident = (block) => (completeGroupFor(block)?.blocks ?? [])
    .some((coResident) => !PROFILE.payloadLengths.has(coResident.contentLength)
      && !candidateLengths.has(coResident.contentLength));
  const exactCandidatesBeforeEligibility = candidates.filter((block) => exactKeys.has(`${block.participantId}:${block.timestampMillis}`));
  const exactCandidates = exactCandidatesBeforeEligibility.filter((block) => !hasExcludedCoResident(block));
  const exactCandidateKeys = new Set(exactCandidates.map((block) => `${block.participantId}:${block.timestampMillis}`));
  const oldGroupAt = (block) => oldGroups.some((group) => group.participantId === block.participantId
    && Math.abs(group.timestampMillis - block.timestampMillis) <= PROFILE.labelToleranceMillis);
  const groupFor = (block) => extended.groups.find((group) => group.participantId === block.participantId
    && group.timestampMillis === block.timestampMillis) ?? null;
  return {
    replayId,
    packetCount: candidates.length,
    structurallyDecodablePacketCount: candidates.filter((block) => decodeItemId(Buffer.from(block.contentHex, "hex")) !== null).length,
    exactPurchaseLinkedPacketCount: exactCandidates.length,
    extraPacketCount: candidates.length - exactCandidates.length,
    excludedCoResidentExactCandidateCount: exactCandidatesBeforeEligibility.filter(hasExcludedCoResident).length,
    coResidentExcludedCandidatePacketCount: candidates.filter(hasExcludedCoResident).length,
    newExactPurchaseLinkedGroupCount: exactCandidateKeys.size,
    previousUnmatchedExactPacketCount: exactCandidates.filter((block) => !oldGroupAt(block)).length,
    extendedPacketCount: extendedBlocks.length,
    extendedExactPurchaseLinkedPacketCount: exactGroups.flatMap((group) => group.blocks).length,
    extendedExactPurchaseLinkedGroupCount: exactGroups.length,
    extendedTransactionUnresolvedPacketCount: extendedBlocks.length - exactGroups.flatMap((group) => group.blocks).length,
    extendedUnmatchedPurchases: extended.unmatchedPurchases,
    extendedAmbiguousPurchases: extended.ambiguousPurchases,
    packets: candidates.map((block) => {
      const group = groupFor(block);
      const completeGroup = completeGroupFor(block);
      const excludedCoResident = hasExcludedCoResident(block);
      return {
        participantId: block.participantId,
        timestampMillis: block.timestampMillis,
        contentLength: block.contentLength,
        decodedItemId: decodeItemId(Buffer.from(block.contentHex, "hex")),
        apiItemIds: (group?.purchases ?? []).map((purchase) => purchase.itemId).sort((left, right) => left - right),
        exactPurchaseLinked: exactCandidates.includes(block),
        completeGroupEligible: !excludedCoResident,
        excludedCoResidentContentLengths: (completeGroup?.blocks ?? [])
          .filter((coResident) => !PROFILE.payloadLengths.has(coResident.contentLength)
            && !candidateLengths.has(coResident.contentLength))
          .map((coResident) => coResident.contentLength).sort((left, right) => left - right),
        completeGroupContentLengths: (completeGroup?.blocks ?? [])
          .map((coResident) => coResident.contentLength).sort((left, right) => left - right),
        segmentType: block.segmentType,
        segmentId: block.segmentId,
        chunkId: block.chunkId,
        segmentPayloadOffset: block.segmentPayloadOffset,
        sourceOffset: block.sourceOffset,
        blockIndex: block.blockIndex,
        contentHex: block.contentHex,
      };
    }),
  };
}

function evaluateBit(rows, bit) {
  let exact = 0, unavailable = 0;
  for (const row of rows) {
    const decoded = validatedBit(row.payload, bit);
    if (decoded === null) unavailable += 1;
    else if (decoded === ((row.itemId >>> bit) & 1)) exact += 1;
  }
  return { exact, unavailable, sampleCount: rows.length };
}

function preselectedFormulaCrossReplay(rows, bit) {
  let exact = 0, unavailable = 0, unseenExact = 0, unseenUnavailable = 0, unseenSampleCount = 0;
  const folds = [];
  for (const fixture of FIXTURES) {
    const test = rows.filter((row) => row.replayId === fixture.replayId);
    const trainIds = new Set(rows.filter((row) => row.replayId !== fixture.replayId).map((row) => row.itemId));
    let foldExact = 0, foldUnavailable = 0, foldUnseenExact = 0, foldUnseenUnavailable = 0, foldUnseenSampleCount = 0;
    for (const row of test) {
      const decoded = validatedBit(row.payload, bit);
      const hit = decoded !== null && decoded === ((row.itemId >>> bit) & 1);
      if (hit) foldExact += 1;
      if (decoded === null) foldUnavailable += 1;
      if (!trainIds.has(row.itemId)) {
        foldUnseenSampleCount += 1;
        if (hit) foldUnseenExact += 1;
        if (decoded === null) foldUnseenUnavailable += 1;
      }
    }
    exact += foldExact; unavailable += foldUnavailable; unseenExact += foldUnseenExact;
    unseenUnavailable += foldUnseenUnavailable; unseenSampleCount += foldUnseenSampleCount;
    folds.push({ replayId: fixture.replayId, exact: foldExact, unavailable: foldUnavailable, sampleCount: test.length, unseenItemIdExact: foldUnseenExact, unseenItemIdUnavailable: foldUnseenUnavailable, unseenItemIdSampleCount: foldUnseenSampleCount });
  }
  return {
    interpretation: "Preselected formula checked per replay; no formula is trained or selected inside a fold.",
    exact,
    unavailable,
    sampleCount: rows.length,
    unseenItemIdExact: unseenExact,
    unseenItemIdUnavailable: unseenUnavailable,
    unseenItemIdSampleCount: unseenSampleCount,
    replayChecks: folds,
  };
}

function decodeItemId(payload) {
  let value = 0;
  for (const bit of EXPECTED.exactBits) {
    const decoded = validatedBit(payload, bit);
    if (decoded === null) return null;
    value |= decoded << bit;
  }
  return value;
}

function evaluateItemIdRows(rows) {
  let exact = 0, unavailable = 0;
  for (const row of rows) {
    const decoded = decodeItemId(row.payload);
    if (decoded === null) unavailable += 1;
    else if (decoded === row.itemId) exact += 1;
  }
  return { exact, unavailable, sampleCount: rows.length };
}

function multisetEqual(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function allProfilePacketEvidence(groups, discoveryIds, holdoutIds) {
  const packets = groups.flatMap((group) => group.blocks.map((block) => ({
    replayId: group.replayId,
    decodedItemId: decodeItemId(Buffer.from(block.contentHex, "hex")),
  })));
  const exactPurchaseGroups = groups.filter((group) => {
    const decoded = group.blocks.map((block) => decodeItemId(Buffer.from(block.contentHex, "hex")));
    const purchaseIds = group.purchases.map((purchase) => purchase.itemId);
    return decoded.every((itemId) => itemId !== null) && multisetEqual(decoded, purchaseIds);
  });
  const exactPackets = exactPurchaseGroups.flatMap((group) => group.blocks.map((block) => ({ replayId: group.replayId, block })));
  const split = (rows) => ({
    profilePacketCount: rows.length,
    structurallyDecodablePacketCount: rows.filter((row) => row.decodedItemId !== null).length,
    unknownSymbolPacketCount: rows.filter((row) => row.decodedItemId === null).length,
  });
  const discoveryPackets = packets.filter((row) => discoveryIds.has(row.replayId));
  const holdoutPackets = packets.filter((row) => holdoutIds.has(row.replayId));
  if (discoveryPackets.length + holdoutPackets.length !== packets.length) throw new Error("A profiled packet lies outside the fixed Discovery/Holdout split.");
  const discoveryExactPackets = exactPackets.filter((row) => discoveryIds.has(row.replayId));
  const holdoutExactPackets = exactPackets.filter((row) => holdoutIds.has(row.replayId));
  return {
    profilePacketCount: packets.length,
    structurallyDecodablePacketCount: packets.filter((row) => row.decodedItemId !== null).length,
    unknownSymbolPacketCount: packets.filter((row) => row.decodedItemId === null).length,
    exactPurchaseLinkedPacketCount: exactPackets.length,
    transactionUnresolvedPacketCount: packets.length - exactPackets.length,
    exactPurchaseLinkedGroupCount: exactPurchaseGroups.length,
    additionalMultiPurchasePacketCount: exactPackets.length - EXPECTED.labelCount,
    discovery: { ...split(discoveryPackets), exactPurchaseLinkedPacketCount: discoveryExactPackets.length, transactionUnresolvedPacketCount: discoveryPackets.length - discoveryExactPackets.length },
    holdout: { ...split(holdoutPackets), exactPurchaseLinkedPacketCount: holdoutExactPackets.length, transactionUnresolvedPacketCount: holdoutPackets.length - holdoutExactPackets.length },
  };
}

function aggregateExtendedLengthNegativeControl(rows, fixtureIds) {
  const sum = (selector) => rows.filter((row) => fixtureIds.has(row.replayId))
    .reduce((total, row) => total + selector(row), 0);
  return {
    packetCount: sum((row) => row.packetCount),
    structurallyDecodablePacketCount: sum((row) => row.structurallyDecodablePacketCount),
    exactPurchaseLinkedPacketCount: sum((row) => row.exactPurchaseLinkedPacketCount),
    extraPacketCount: sum((row) => row.extraPacketCount),
    excludedCoResidentExactCandidateCount: sum((row) => row.excludedCoResidentExactCandidateCount),
    coResidentExcludedCandidatePacketCount: sum((row) => row.coResidentExcludedCandidatePacketCount),
    newExactPurchaseLinkedGroupCount: sum((row) => row.newExactPurchaseLinkedGroupCount),
    previousUnmatchedExactPacketCount: sum((row) => row.previousUnmatchedExactPacketCount),
    extendedPacketCount: sum((row) => row.extendedPacketCount),
    extendedExactPurchaseLinkedPacketCount: sum((row) => row.extendedExactPurchaseLinkedPacketCount),
    extendedExactPurchaseLinkedGroupCount: sum((row) => row.extendedExactPurchaseLinkedGroupCount),
    extendedTransactionUnresolvedPacketCount: sum((row) => row.extendedTransactionUnresolvedPacketCount),
    extendedUnmatchedPurchases: sum((row) => row.extendedUnmatchedPurchases),
    extendedAmbiguousPurchases: sum((row) => row.extendedAmbiguousPurchases),
  };
}

function truthTableEvidence(rows, bit) {
  const inputBits = FORMULA_INPUT_BITS[bit];
  const outputsByCode = new Map();
  for (const row of rows) {
    const code = inputCode(row.payload, inputBits);
    const outputs = outputsByCode.get(code) ?? new Set();
    outputs.add((row.itemId >>> bit) & 1);
    outputsByCode.set(code, outputs);
  }
  const possibleCodeCount = 2 ** inputBits.length;
  const observedCodes = [...outputsByCode.keys()].sort((left, right) => left - right);
  return {
    inputBits,
    possibleCodeCount,
    observedCodeCount: observedCodes.length,
    observedCodes,
    missingCodes: [...Array(possibleCodeCount).keys()].filter((code) => !outputsByCode.has(code)),
    conflictingCodes: observedCodes.filter((code) => outputsByCode.get(code).size !== 1),
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
  const fixtureIds = new Set(FIXTURES.map((fixture) => fixture.replayId));
  const discoveryIds = new Set(EXPECTED.discoveryReplayIds);
  const holdoutIds = new Set(EXPECTED.holdoutReplayIds);
  if (fixtureIds.size !== EXPECTED.fixtureCount || discoveryIds.size + holdoutIds.size !== fixtureIds.size
    || [...discoveryIds].some((replayId) => holdoutIds.has(replayId) || !fixtureIds.has(replayId))
    || [...holdoutIds].some((replayId) => !fixtureIds.has(replayId))) {
    throw new Error("Discovery and holdout replay IDs do not form an exact disjoint partition of the fixed fixtures.");
  }
  const rows = [];
  const profileGroups = [];
  const extendedLengthRows = [];
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
    const purchases = purchasesFromTimeline(timeline);
    const championOwnedBlocks = dumpChampionOwnedBlocks(cliPath, replayPath);
    const joined = labelsForFixture(fixture.replayId, purchases, championOwnedBlocks
      .filter((block) => PROFILE.payloadLengths.has(block.contentLength)));
    const profilePacketCount = joined.groups.reduce((sum, group) => sum + group.blocks.length, 0);
    if (joined.labels.length !== fixture.expectedLabelCount || profilePacketCount !== fixture.expectedProfilePacketCount || joined.ambiguousPurchases !== 0) {
      throw new Error(`${fixture.replayId} profile gate drifted: labels=${joined.labels.length}/${fixture.expectedLabelCount}, packets=${profilePacketCount}/${fixture.expectedProfilePacketCount}, ambiguous=${joined.ambiguousPurchases}.`);
    }
    rows.push(...joined.labels);
    profileGroups.push(...joined.groups);
    extendedLengthRows.push(extendedLengthNegativeControl(fixture.replayId, purchases, championOwnedBlocks, joined.groups));
    unmatchedPurchases += joined.unmatchedPurchases; ambiguousPurchases += joined.ambiguousPurchases;
    fixtures.push({ replayId: fixture.replayId, gameVersion: match.info?.gameVersion ?? null, labelCount: joined.labels.length, profilePacketCount });
  }
  if (!rows.every((row) => Number.isInteger(row.itemId) && row.itemId >= 0 && row.itemId <= EXPECTED.maximumItemId)) {
    throw new Error(`A labelled item ID lies outside the gated ${EXPECTED.itemIdBitWidth}-bit range.`);
  }
  const modeledBitSet = new Set(EXPECTED.exactBits);
  if (modeledBitSet.size !== EXPECTED.itemIdBitWidth
    || [...Array(EXPECTED.itemIdBitWidth).keys()].some((bit) => !modeledBitSet.has(bit))) {
    throw new Error("The validated bit positions do not cover the gated item-ID width.");
  }
  const direct = Object.fromEntries(EXPECTED.exactBits.map((bit) => [bit, evaluateBit(rows, bit)]));
  const crossReplay = Object.fromEntries(EXPECTED.exactBits.map((bit) => [bit, preselectedFormulaCrossReplay(rows, bit)]));
  const discoveryRows = rows.filter((row) => EXPECTED.discoveryReplayIds.includes(row.replayId));
  const holdoutRows = rows.filter((row) => EXPECTED.holdoutReplayIds.includes(row.replayId));
  const truthTables = Object.fromEntries(Object.keys(FORMULA_INPUT_BITS).map((bit) => [bit, truthTableEvidence(discoveryRows, Number(bit))]));
  const failClosedInputGate = Object.entries(EXPECTED.truthTableCoverage).every(([bit, coverage]) => coverage.missingCodes
    .every((code) => validatedBit(payloadForInputCode(FORMULA_INPUT_BITS[bit], code), Number(bit)) === null));
  const discovery = evaluateItemIdRows(discoveryRows);
  const holdout = evaluateItemIdRows(holdoutRows);
  const profilePackets = allProfilePacketEvidence(profileGroups, discoveryIds, holdoutIds);
  const extendedLengthControl = {
    all: aggregateExtendedLengthNegativeControl(extendedLengthRows, fixtureIds),
    discovery: aggregateExtendedLengthNegativeControl(extendedLengthRows, discoveryIds),
    holdout: aggregateExtendedLengthNegativeControl(extendedLengthRows, holdoutIds),
  };
  const hypotheticalExtendedProfile = {
    packetCount: profilePackets.profilePacketCount + extendedLengthControl.all.packetCount,
    structurallyDecodablePacketCount: profilePackets.structurallyDecodablePacketCount + extendedLengthControl.all.structurallyDecodablePacketCount,
    unknownSymbolPacketCount: profilePackets.unknownSymbolPacketCount,
    exactPurchaseLinkedPacketCount: profilePackets.exactPurchaseLinkedPacketCount + extendedLengthControl.all.exactPurchaseLinkedPacketCount,
    exactPurchaseLinkedGroupCount: profilePackets.exactPurchaseLinkedGroupCount + extendedLengthControl.all.newExactPurchaseLinkedGroupCount,
    transactionUnresolvedPacketCount: profilePackets.transactionUnresolvedPacketCount + extendedLengthControl.all.extraPacketCount,
    unmatchedTimelinePurchaseCount: unmatchedPurchases - extendedLengthControl.all.previousUnmatchedExactPacketCount,
  };
  const directlyRegroupedExtendedProfile = {
    packetCount: extendedLengthControl.all.extendedPacketCount,
    structurallyDecodablePacketCount: profilePackets.structurallyDecodablePacketCount + extendedLengthControl.all.structurallyDecodablePacketCount,
    unknownSymbolPacketCount: profilePackets.unknownSymbolPacketCount,
    exactPurchaseLinkedPacketCount: extendedLengthControl.all.extendedExactPurchaseLinkedPacketCount,
    exactPurchaseLinkedGroupCount: extendedLengthControl.all.extendedExactPurchaseLinkedGroupCount,
    transactionUnresolvedPacketCount: extendedLengthControl.all.extendedTransactionUnresolvedPacketCount,
    unmatchedTimelinePurchaseCount: extendedLengthControl.all.extendedUnmatchedPurchases,
  };
  const extendedLengthNegativeControlPassed = extendedLengthControl.all.packetCount === EXPECTED.extendedLengthNegativeControl.packetCount
    && extendedLengthControl.all.structurallyDecodablePacketCount === EXPECTED.extendedLengthNegativeControl.structurallyDecodablePacketCount
    && extendedLengthControl.all.exactPurchaseLinkedPacketCount === EXPECTED.extendedLengthNegativeControl.exactPurchaseLinkedPacketCount
    && extendedLengthControl.all.extraPacketCount === EXPECTED.extendedLengthNegativeControl.extraPacketCount
    && extendedLengthControl.all.excludedCoResidentExactCandidateCount === EXPECTED.extendedLengthNegativeControl.excludedCoResidentExactCandidateCount
    && extendedLengthControl.all.coResidentExcludedCandidatePacketCount === EXPECTED.extendedLengthNegativeControl.coResidentExcludedCandidatePacketCount
    && extendedLengthControl.all.newExactPurchaseLinkedGroupCount === EXPECTED.extendedLengthNegativeControl.newExactPurchaseLinkedGroupCount
    && extendedLengthControl.all.previousUnmatchedExactPacketCount === EXPECTED.extendedLengthNegativeControl.previousUnmatchedExactPacketCount
    && ["packetCount", "structurallyDecodablePacketCount", "exactPurchaseLinkedPacketCount", "extraPacketCount", "excludedCoResidentExactCandidateCount", "coResidentExcludedCandidatePacketCount", "newExactPurchaseLinkedGroupCount", "previousUnmatchedExactPacketCount"].every((key) => extendedLengthControl.discovery[key] === EXPECTED.extendedLengthNegativeControl.discovery[key]
      && extendedLengthControl.holdout[key] === EXPECTED.extendedLengthNegativeControl.holdout[key])
    && Object.entries(EXPECTED.extendedLengthNegativeControl.hypotheticalExtendedProfile)
      .every(([key, expected]) => hypotheticalExtendedProfile[key] === expected
        && directlyRegroupedExtendedProfile[key] === expected)
    && Object.entries(hypotheticalExtendedProfile)
      .every(([key, value]) => directlyRegroupedExtendedProfile[key] === value)
    && extendedLengthControl.all.extendedAmbiguousPurchases === 0;
  const discoveryItemIds = new Set(discoveryRows.map((row) => row.itemId));
  const unseenHoldoutRows = holdoutRows.filter((row) => !discoveryItemIds.has(row.itemId));
  const unseenHoldout = evaluateItemIdRows(unseenHoldoutRows);
  const passed = rows.length === EXPECTED.labelCount && fixtures.length === EXPECTED.fixtureCount
    && unmatchedPurchases === EXPECTED.unmatchedTimelinePurchaseCount && ambiguousPurchases === 0
    && EXPECTED.exactBits.every((bit) => direct[bit].exact === EXPECTED.labelCount
      && direct[bit].unavailable === 0
      && crossReplay[bit].exact === EXPECTED.labelCount
      && crossReplay[bit].unavailable === 0
      && crossReplay[bit].unseenItemIdExact === EXPECTED.unseenItemIdSampleCount
      && crossReplay[bit].unseenItemIdUnavailable === 0
      && crossReplay[bit].unseenItemIdSampleCount === EXPECTED.unseenItemIdSampleCount)
    && Object.entries(EXPECTED.truthTableCoverage).every(([bit, expected]) => {
      const observed = truthTables[bit];
      return observed.observedCodeCount === expected.observedCodeCount
        && JSON.stringify(observed.missingCodes) === JSON.stringify(expected.missingCodes)
        && observed.conflictingCodes.length === 0;
    })
    && failClosedInputGate
    && profilePackets.profilePacketCount === EXPECTED.profilePacketCount
    && profilePackets.structurallyDecodablePacketCount === EXPECTED.structurallyDecodableProfilePacketCount
    && profilePackets.unknownSymbolPacketCount === EXPECTED.unknownProfileSymbolCount
    && profilePackets.exactPurchaseLinkedPacketCount === EXPECTED.exactPurchaseLinkedPacketCount
    && profilePackets.exactPurchaseLinkedGroupCount === EXPECTED.exactPurchaseLinkedGroupCount
    && profilePackets.transactionUnresolvedPacketCount === EXPECTED.transactionUnresolvedPacketCount
    && profilePackets.additionalMultiPurchasePacketCount === 2
    && profilePackets.discovery.profilePacketCount === EXPECTED.discoveryProfilePacketCount
    && profilePackets.holdout.profilePacketCount === EXPECTED.holdoutProfilePacketCount
    && profilePackets.discovery.exactPurchaseLinkedPacketCount === EXPECTED.discoveryExactPurchaseLinkedPacketCount
    && profilePackets.holdout.exactPurchaseLinkedPacketCount === EXPECTED.holdoutExactPurchaseLinkedPacketCount
    && profilePackets.discovery.transactionUnresolvedPacketCount === EXPECTED.discoveryTransactionUnresolvedPacketCount
    && profilePackets.holdout.transactionUnresolvedPacketCount === EXPECTED.holdoutTransactionUnresolvedPacketCount
    && profilePackets.discovery.unknownSymbolPacketCount === 0 && profilePackets.holdout.unknownSymbolPacketCount === 0
    && extendedLengthNegativeControlPassed
    && discovery.exact === EXPECTED.discoverySampleCount && discovery.unavailable === 0 && discovery.sampleCount === EXPECTED.discoverySampleCount
    && holdout.exact === EXPECTED.holdoutSampleCount && holdout.unavailable === 0 && holdout.sampleCount === EXPECTED.holdoutSampleCount
    && unseenHoldout.exact === EXPECTED.holdoutUnseenItemIdSampleCount && unseenHoldout.unavailable === 0
    && unseenHoldout.sampleCount === EXPECTED.holdoutUnseenItemIdSampleCount;
  const output = {
    schema: "rofl-inventory-item-id-grammar-16.14-research/v1",
    status: passed ? "research-validated-not-promoted" : "research-regression",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: { versionGroup: PROFILE.versionGroup, packetType: "0x0369", channel: 1, payloadLengths: [...PROFILE.payloadLengths], participantIdFormula: "blockParam - 0x400000AD" },
    offlineOracle: { input: "Saved Riot Timeline ITEM_PURCHASED labels only", packetGroup: "exact replay + participant + ROFL packet timestamp", timelineAssociationToleranceMillis: PROFILE.labelToleranceMillis, runtimeUse: false },
    fixedFixtures: fixtures,
    expected: EXPECTED,
    evidenceBoundary: "Bits 2, 3, 4, 8, 9, and 11 were selected only on the seven Discovery fixtures; the other seven formulas predate this split and were selected during full-corpus exploration. The three fixed Holdouts independently validate the six new formulas and reproduce the combined item ID, but are not a leak-free discovery holdout for all 13 formulas. Per-replay cross-checks are supplementary.",
    validatedBits: EXPECTED.exactBits.map((bit) => ({ bit, formula: FORMULA_TEXT[bit], direct: direct[bit], preselectedFormulaCrossReplay: crossReplay[bit] })),
    truthTableEvidence: truthTables,
    failClosedInputCodes: Object.entries(EXPECTED.truthTableCoverage)
      .filter(([, coverage]) => coverage.missingCodes.length > 0)
      .map(([bit, coverage]) => ({ bit: Number(bit), inputBits: FORMULA_INPUT_BITS[bit], unsupportedCodes: coverage.missingCodes })),
    failClosedInputGate,
    discoveryHoldoutValidation: { discovery, holdout, unseenHoldout },
    allProfilePacketValidation: {
      ...profilePackets,
      semanticBoundary: "Only exact owner/timestamp purchase-ID multiset matches are purchase-linked. Every other packet remains transaction-unresolved even when its structural item ID is available.",
    },
    extendedLengthNegativeControl: {
      status: extendedLengthNegativeControlPassed ? "negative-control-passed-not-promoted" : "negative-control-regression",
      profileExtensionGate: false,
      maintainedProfilePayloadLengths: [...PROFILE.payloadLengths],
      candidatePayloadLengths: EXPECTED.extendedLengthNegativeControl.payloadLengths,
      failClosedSymbolCodesRetained: true,
      all: extendedLengthControl.all,
      discovery: extendedLengthControl.discovery,
      holdout: extendedLengthControl.holdout,
      hypotheticalExtendedProfile,
      directlyRegroupedExtendedProfile,
      fixtures: extendedLengthRows,
      reason: "The 16/17-byte candidates are structurally decodable under the observed 13-bit grammar, but the fixed Holdout contains one unlabelled candidate packet. The required zero-extra profile-extension gate therefore fails; [14,15] remains the only maintained profiled payload lengths.",
    },
    counts: { labelCount: rows.length, unmatchedTimelinePurchases: unmatchedPurchases, ambiguousTimelinePurchases: ambiguousPurchases },
    promotionBoundary: { passed: false, reason: "This proves an offline research item-ID grammar only. Slot, instance, removals, undo, transaction linkage, and complete inventory state remain unresolved; no runtime API is emitted." },
  };
  writeJson(path.resolve(args.outputPath), output);
  console.log(`Wrote ${path.resolve(args.outputPath)}; labels=${rows.length}; exactBits=${EXPECTED.exactBits.length}; researchOnly=true.`);
  if (!passed) process.exitCode = 1;
}

main();
