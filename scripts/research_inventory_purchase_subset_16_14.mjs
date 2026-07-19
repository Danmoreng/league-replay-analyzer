#!/usr/bin/env node

// Offline research only. This checkpoint freezes a narrow, fail-closed
// patch-16.14 purchase-linked subset from saved ROFL packet bytes. Timeline
// fixtures are opened after packet extraction, only for D7 selection and H3
// evaluation. The emitted artifact is not a runtime decoder/API.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  segmentType: "chunk",
  channel: 1,
  championIdBase: 0x400000ad,
  add: Object.freeze({ packetType: 0x0369, lengths: Object.freeze([14, 15]) }),
  removal: Object.freeze({ packetType: 0x03f9, lengths: Object.freeze([6, 7]) }),
  removalContext: Object.freeze({ packetType: 0x0146, lengths: Object.freeze([2, 3, 4]) }),
  undoComponent: Object.freeze({ packetType: 0x0081, lengths: null }),
});

const FIXTURES = Object.freeze([
  ["EUW1-7919517389", "D7", [195, 161, 386, 2], 616],
  ["EUW1-7919624327", "D7", [201, 158, 351, 1], 567],
  ["EUW1-7920241664", "D7", [274, 223, 503, 5], 801],
  ["EUW1-7920292147", "D7", [246, 224, 529, 7], 849],
  ["EUW1-7920341366", "D7", [183, 142, 321, 1], 524],
  ["EUW1-7920364492", "D7", [220, 168, 315, 1], 554],
  ["EUW1-7920550565", "D7", [256, 217, 442, 6], 734],
  ["EUW1-7921377760", "H3", [260, 204, 284, 0], 509],
  ["EUW1-7921482297", "H3", [444, 383, 720, 7], 1131],
  ["EUW1-7921996430", "H3", [240, 194, 363, 1], 633],
].map(([replayId, partition, [add, removal, removalContext, undoComponent], ownerTimeGroupCount]) => Object.freeze({
  replayId, partition, expected: Object.freeze({ add, removal, removalContext, undoComponent, ownerTimeGroupCount }),
})));

const EXPECTED = Object.freeze({
  D7: Object.freeze({ ownerTimeGroupCount: 4645, profileAddPacketCount: 1575, actualPurchaseLinkedAddPacketCount: 1320, actualPurchaseLinkedGroupCount: 1320, selectedAddPacketCount: 130, selectedGroupCount: 130, falsePositiveAddPacketCount: 0, falsePositiveGroupCount: 0 }),
  H3: Object.freeze({ ownerTimeGroupCount: 2273, profileAddPacketCount: 944, actualPurchaseLinkedAddPacketCount: 653, actualPurchaseLinkedGroupCount: 652, selectedAddPacketCount: 63, selectedGroupCount: 63, falsePositiveAddPacketCount: 0, falsePositiveGroupCount: 0, unseenCandidatePacketCount: 7, unseenCandidateItemIds: Object.freeze([2520, 3053, 3087, 3181, 3803, 6657]) }),
  combined: Object.freeze({ ownerTimeGroupCount: 6918, profileAddPacketCount: 2519, actualPurchaseLinkedAddPacketCount: 1973, actualPurchaseLinkedGroupCount: 1972, selectedAddPacketCount: 193, selectedGroupCount: 193, falsePositiveAddPacketCount: 0, falsePositiveGroupCount: 0, runtimeUnavailableAddPacketCount: 2326 }),
  frozenTemplateCount: 10,
  frozenTemplateContentSha256: "edadb744df01c08cd9898428ebf6a7faca4de7d285e6e78cb832180e7227e27b",
  loroCandidatePacketCounts: Object.freeze([14, 14, 20, 21, 20, 24, 17, 20, 27, 20]),
  loroUnseenCandidatePacketCounts: Object.freeze([1, 1, 0, 2, 1, 0, 1, 1, 2, 0]),
});

const FAMILIES = Object.freeze([
  Object.freeze({ name: "add", ...PROFILE.add }),
  Object.freeze({ name: "removal", ...PROFILE.removal }),
  Object.freeze({ name: "removalContext", ...PROFILE.removalContext }),
  Object.freeze({ name: "undoComponent", ...PROFILE.undoComponent }),
]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "inventory-purchase-subset-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/research_inventory_purchase_subset_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function hashContent(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function countBy(rows, selector) {
  const counts = new Map();
  for (const row of rows) { const key = selector(row); counts.set(key, (counts.get(key) ?? 0) + 1); }
  return Object.fromEntries([...counts].sort(([left], [right]) => String(left).localeCompare(String(right))));
}
function sameJson(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
function physicalKey(block) { return `${block.segmentType}:${block.segmentId}:${block.chunkId}:${block.segmentPayloadOffset}:${block.blockIndex}:${block.sourceOffset}`; }
function groupKey(group) { return `${group.replayId}:${group.participantId}:${group.timestampMillis}`; }

function payloadBit(payload, bit) { return (payload[bit >> 3] >> (bit & 7)) & 1; }
function inputCode(payload, bits) { return bits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0); }

// The current corpus cannot determine these two symbols. They deliberately
// remain unavailable even though the observed Boolean completion has a value.
function decodeItemId(payload) {
  if (inputCode(payload, [72, 73, 79]) === 0 || inputCode(payload, [73, 75, 76]) === 4) return null;
  const bit = (index) => payloadBit(payload, index);
  const values = [
    bit(71), bit(66) ^ bit(71) ^ 1, bit(65) ^ (bit(66) & bit(71)),
    1 ^ bit(65) ^ bit(68) ^ (bit(66) & bit(71)) ^ (bit(65) & bit(66) & bit(71)),
    1 ^ bit(67) ^ bit(68) ^ (bit(65) & bit(68)) ^ (bit(66) & bit(68) & bit(71)) ^ (bit(65) & bit(66) & bit(68) & bit(71)),
    bit(70) ^ 1, bit(69) ^ bit(70) ^ 1, bit(78) ^ bit(79),
    1 ^ bit(74) ^ bit(79) ^ (bit(72) & bit(79)),
    bit(73) ^ (bit(73) & bit(79)) ^ (bit(72) & bit(73) & bit(79)),
    bit(73) ^ bit(76) ^ 1, 1 ^ bit(75) ^ bit(76) ^ (bit(73) & bit(76)), bit(78) ^ 1,
  ];
  return values.reduce((value, decoded, index) => value | (decoded << index), 0);
}

function multisetEqual(left, right) {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a - b);
  const sortedRight = [...right].sort((a, b) => a - b);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function ownerOf(block) {
  const participantId = block.blockParam - PROFILE.championIdBase;
  return block.channel === PROFILE.channel && Number.isInteger(participantId) && participantId >= 1 && participantId <= 10
    ? participantId : null;
}

function dumpProfileBlocks(cliPath, replayPath) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", replayPath,
    ...FAMILIES.flatMap((family) => ["--packet-type", String(family.packetType)]),
    "--segment-type", PROFILE.segmentType, "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert(result.status === 0, result.stderr.trim() || `${path.basename(replayPath)} packet dump failed.`);
  const dump = JSON.parse(result.stdout);
  assert(dump.valid && !(dump.errors?.length) && dump.gameVersion === PROFILE.exactReplayBuild,
    `${path.basename(replayPath)} failed exact framing/build gate.`);
  assert(dump.packetTypeDumps?.length === FAMILIES.length, `${path.basename(replayPath)} did not return every requested family.`);
  const blocks = [];
  for (const family of FAMILIES) {
    const entry = dump.packetTypeDumps.find((candidate) => candidate.packetType === family.packetType);
    assert(entry && entry.emittedBlockCount === entry.matchingBlockCount && !entry.truncated,
      `${path.basename(replayPath)} omitted a 0x${family.packetType.toString(16)} block.`);
    for (const block of entry.blocks ?? []) {
      const participantId = ownerOf(block);
      if (participantId === null || (family.lengths && !family.lengths.includes(block.contentLength))) continue;
      assert(block.contentHexTruncated === false && block.contentHexBytes === block.contentLength
        && typeof block.contentHex === "string" && block.contentHex.length === block.contentLength * 2,
      `${path.basename(replayPath)} has incomplete relevant payload provenance.`);
      blocks.push({ ...block, family: family.name, participantId, payload: Buffer.from(block.contentHex, "hex") });
    }
  }
  assert(new Set(blocks.map(physicalKey)).size === blocks.length, `${path.basename(replayPath)} has duplicate relevant physical packets.`);
  return blocks;
}

function readItemEvents(timelinePath) {
  return (JSON.parse(fs.readFileSync(timelinePath, "utf8")).info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => ["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type)
      && Number.isInteger(event.participantId) && Number.isInteger(event.timestamp))
    .map((event) => ({ type: event.type, participantId: event.participantId, timestampMillis: event.timestamp,
      itemId: Number.isInteger(event.itemId) ? event.itemId : null }));
}

function inspectFixture(args, fixture) {
  const replayPath = path.join(args.replayDir, `${fixture.replayId}.rofl`);
  const fixtureRoot = path.join(args.apiRoot, fixture.replayId.replaceAll("-", "_"));
  const matchPath = path.join(fixtureRoot, "match.json");
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  assert([replayPath, matchPath, timelinePath].every(fs.existsSync), `Missing fixed input for ${fixture.replayId}.`);
  assert(JSON.parse(fs.readFileSync(matchPath, "utf8")).info?.gameVersion === PROFILE.exactReplayBuild,
    `${fixture.replayId} Match fixture fails exact-build gate.`);
  const blocks = dumpProfileBlocks(args.cliPath, replayPath);
  const byOwnerTime = new Map();
  for (const block of blocks) {
    const localKey = `${block.participantId}:${block.timestampMillis}`;
    const group = byOwnerTime.get(localKey) ?? { replayId: fixture.replayId, partition: fixture.partition, participantId: block.participantId, timestampMillis: block.timestampMillis, blocks: [], labels: [], purchases: [] };
    group.blocks.push(block); byOwnerTime.set(localKey, group);
  }
  let unassociatedPurchaseCount = 0;
  for (const event of readItemEvents(timelinePath)) {
    const matches = [...byOwnerTime.values()].filter((group) => group.participantId === event.participantId
      && Math.abs(group.timestampMillis - event.timestampMillis) <= 1);
    assert(matches.length <= 1, `${fixture.replayId} has ambiguous Timeline purchase association.`);
    if (matches.length === 1) {
      matches[0].labels.push(event);
      if (event.type === "ITEM_PURCHASED") matches[0].purchases.push(event);
    } else if (event.type === "ITEM_PURCHASED") unassociatedPurchaseCount += 1;
  }
  const groups = [...byOwnerTime.values()];
  for (const group of groups) {
    group.blocks.sort((left, right) => left.sourceOffset - right.sourceOffset || left.blockIndex - right.blockIndex);
    group.signature = group.blocks.map((block) => `${block.family}:${block.contentLength}`).join(">");
    group.addBlocks = group.blocks.filter((block) => block.family === "add");
    group.decodedItemIds = group.addBlocks.map((block) => decodeItemId(block.payload));
    group.exactPurchaseMultiset = group.addBlocks.length > 0 && group.decodedItemIds.every(Number.isInteger)
      && multisetEqual(group.decodedItemIds, group.purchases.map((purchase) => purchase.itemId));
  }
  const rawProfileBlockCounts = countBy(blocks, (block) => block.family);
  const profileBlockCounts = Object.fromEntries(FAMILIES.map((family) => [family.name, rawProfileBlockCounts[family.name] ?? 0]));
  assert(sameJson(profileBlockCounts, {
    add: fixture.expected.add, removal: fixture.expected.removal,
    removalContext: fixture.expected.removalContext, undoComponent: fixture.expected.undoComponent,
  }), `${fixture.replayId} per-family profile count drifted.`);
  assert(groups.length === fixture.expected.ownerTimeGroupCount, `${fixture.replayId} complete owner/time population drifted.`);
  return {
    groups,
    report: {
      replayId: fixture.replayId, partition: fixture.partition, exactReplayBuild: PROFILE.exactReplayBuild,
      profileBlockCounts, ownerTimeGroupCount: groups.length, unassociatedPurchaseCount,
      replayPacketInput: path.resolve(replayPath), offlineValidationInputs: [path.resolve(matchPath), path.resolve(timelinePath)],
    },
  };
}

function exactTemplates(groups) {
  const rowsBySignature = new Map();
  for (const group of groups) { const rows = rowsBySignature.get(group.signature) ?? []; rows.push(group); rowsBySignature.set(group.signature, rows); }
  return [...rowsBySignature].flatMap(([signature, rows]) => {
    const labels = new Set(rows.map((row) => row.labels.map((label) => label.type).sort().join("+") || "NO_LABEL"));
    return rows.length >= 2 && labels.size === 1 && !labels.has("NO_LABEL") && rows.every((row) => row.exactPurchaseMultiset)
      ? [{ signature, label: [...labels][0], support: rows.length, addPackets: rows.reduce((sum, row) => sum + row.addBlocks.length, 0) }] : [];
  }).sort((left, right) => right.support - left.support || left.signature.localeCompare(right.signature));
}

function score(groups, templates, knownItemIds = null) {
  const selectedSignatures = new Set(templates.map((template) => template.signature));
  const selectedGroups = groups.filter((group) => selectedSignatures.has(group.signature));
  const candidatePackets = selectedGroups.flatMap((group) => group.addBlocks.map((block, index) => ({ group, block, itemId: group.decodedItemIds[index] })));
  const truePositivePackets = candidatePackets.filter((candidate) => candidate.group.exactPurchaseMultiset);
  const falsePositivePackets = candidatePackets.filter((candidate) => !candidate.group.exactPurchaseMultiset);
  const actualPositiveGroups = groups.filter((group) => group.exactPurchaseMultiset);
  const actualPositivePackets = actualPositiveGroups.flatMap((group) => group.addBlocks);
  const truePositiveGroupKeys = new Set(truePositivePackets.map((candidate) => groupKey(candidate.group)));
  const actualPositiveGroupKeys = new Set(actualPositiveGroups.map(groupKey));
  const unseenCandidates = knownItemIds === null ? [] : truePositivePackets.filter((candidate) => !knownItemIds.has(candidate.itemId));
  const profileAddPacketCount = groups.flatMap((group) => group.addBlocks).length;
  const missingSymbolAddPacketCount = groups.flatMap((group) => group.decodedItemIds).filter((itemId) => itemId === null).length;
  return {
    ownerTimeGroupCount: groups.length,
    profileAddPacketCount,
    actualPurchaseLinkedAddPacketCount: actualPositivePackets.length,
    actualPurchaseLinkedGroupCount: actualPositiveGroups.length,
    selectedAddPacketCount: candidatePackets.length,
    selectedGroupCount: selectedGroups.length,
    truePositiveAddPacketCount: truePositivePackets.length,
    falsePositiveAddPacketCount: falsePositivePackets.length,
    falseNegativePurchaseLinkedAddPacketCount: actualPositivePackets.length - truePositivePackets.length,
    trueNegativeOrUnresolvedAddPacketCount: profileAddPacketCount - actualPositivePackets.length,
    truePositiveGroupCount: truePositiveGroupKeys.size,
    falsePositiveGroupCount: new Set(falsePositivePackets.map((candidate) => groupKey(candidate.group))).size,
    falseNegativePurchaseLinkedGroupCount: [...actualPositiveGroupKeys].filter((candidate) => !truePositiveGroupKeys.has(candidate)).length,
    decodedItemIdExactWithinCandidates: truePositivePackets.filter((candidate) => candidate.group.purchases.some((purchase) => purchase.itemId === candidate.itemId)).length,
    missingSymbolAddPacketCount,
    runtimeUnavailableAddPacketCount: profileAddPacketCount - truePositivePackets.length,
    unseenCandidatePacketCount: unseenCandidates.length,
    unseenCandidateItemIds: [...new Set(unseenCandidates.map((candidate) => candidate.itemId))].sort((left, right) => left - right),
  };
}

function assertScore(name, score, expected) {
  for (const [field, expectedValue] of Object.entries(expected)) {
    assert(JSON.stringify(score[field]) === JSON.stringify(expectedValue), `${name} ${field} drifted: ${JSON.stringify(score[field])} != ${JSON.stringify(expectedValue)}.`);
  }
  assert(score.falsePositiveAddPacketCount === 0 && score.falsePositiveGroupCount === 0,
    `${name} false-positive gate failed.`);
  assert(score.decodedItemIdExactWithinCandidates === score.truePositiveAddPacketCount,
    `${name} candidate item-ID multiset accuracy gate failed.`);
  assert(score.missingSymbolAddPacketCount === 0, `${name} unexpectedly contains a missing-symbol profile packet.`);
}

function leaveOneReplayOut(groups) {
  return FIXTURES.map((fixture) => {
    const training = groups.filter((group) => group.replayId !== fixture.replayId);
    const test = groups.filter((group) => group.replayId === fixture.replayId);
    const templates = exactTemplates(training);
    const scorecard = score(test, templates, new Set(training.flatMap((group) => group.purchases.map((purchase) => purchase.itemId))));
    assert(scorecard.falsePositiveAddPacketCount === 0 && scorecard.falsePositiveGroupCount === 0,
      `LORO ${fixture.replayId} false-positive gate failed.`);
    return {
      replayId: fixture.replayId, templateCount: templates.length, templateContentSha256: hashContent(templates),
      ...scorecard,
    };
  });
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  args.cliPath = path.resolve(args.cliPath); args.replayDir = path.resolve(args.replayDir); args.apiRoot = path.resolve(args.apiRoot);
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);

  // D7 is completely extracted and population-gated before H3 packet bytes
  // or Timeline fixtures are opened. The frozen runtime-shaped signature set
  // is selected exclusively from D7.
  const d7Fixtures = FIXTURES.filter((fixture) => fixture.partition === "D7").map((fixture) => inspectFixture(args, fixture));
  const d7Groups = d7Fixtures.flatMap((fixture) => fixture.groups);
  const frozenTemplates = exactTemplates(d7Groups);
  const frozenTemplateContentSha256 = hashContent(frozenTemplates);
  assert(frozenTemplates.length === EXPECTED.frozenTemplateCount, "D7 frozen template count drifted.");
  assert(frozenTemplateContentSha256 === EXPECTED.frozenTemplateContentSha256, "D7 frozen template content drifted.");
  const d7Score = score(d7Groups, frozenTemplates);
  assertScore("D7", d7Score, EXPECTED.D7);

  // H3 is evaluation only. Its full relevant group population cannot affect
  // templates, their content fingerprint, or profile boundaries.
  const h3Fixtures = FIXTURES.filter((fixture) => fixture.partition === "H3").map((fixture) => inspectFixture(args, fixture));
  const h3Groups = h3Fixtures.flatMap((fixture) => fixture.groups);
  const h3Score = score(h3Groups, frozenTemplates, new Set(d7Groups.flatMap((group) => group.purchases.map((purchase) => purchase.itemId))));
  assertScore("H3", h3Score, EXPECTED.H3);
  const allGroups = [...d7Groups, ...h3Groups];
  const combinedScore = score(allGroups, frozenTemplates);
  assertScore("combined", combinedScore, EXPECTED.combined);
  const loro = leaveOneReplayOut(allGroups);
  assert(loro.every((row, index) => row.truePositiveAddPacketCount === EXPECTED.loroCandidatePacketCounts[index]
    && row.unseenCandidatePacketCount === EXPECTED.loroUnseenCandidatePacketCounts[index]
    && row.falsePositiveAddPacketCount === 0 && row.falsePositiveGroupCount === 0), "LORO expected-count or zero-FP gate drifted.");

  const output = {
    schema: "rofl-inventory-purchase-subset-discriminator-16.14-research/v1",
    status: "research-validated-not-promoted",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    clientBinaryInput: false,
    replayOnly: true,
    profile: {
      exactReplayBuild: PROFILE.exactReplayBuild, segmentType: PROFILE.segmentType, channel: PROFILE.channel,
      participantIdFormula: "blockParam - 0x400000AD",
      families: Object.fromEntries(FAMILIES.map((family) => [family.name, { packetType: `0x${family.packetType.toString(16).padStart(4, "0").toUpperCase()}`, contentLengths: family.lengths ?? "any" }])),
    },
    sourceBoundary: {
      packetInput: "Saved .rofl chunk packet bytes only.",
      runtimeCandidatePredicate: "Exact champion owner and replay timestamp; complete relevant 0x0369/0x03F9/0x0146/0x0081 owner/time group, source-ordered family:length signature exactly equals a frozen template; every candidate 0x0369 must also decode under the independently fail-closed 16.14 item-ID grammar.",
      offlineTimelineRole: "Saved Timeline ITEM_PURCHASED IDs select D7 templates and evaluate D7/H3 only; never runtime input.",
      unknownSignatureBehavior: "unavailable; do not infer a purchase or an automatic state update.",
      missingItemIdSymbolBehavior: "unavailable; neither missing 13-bit item-ID input code may use a Boolean extrapolation.",
    },
    split: { discovery: "D7 is selected and frozen before H3 opens.", holdout: "H3 evaluates every relevant owner/time group against frozen D7 templates." },
    expected: EXPECTED,
    frozenTemplates,
    frozenTemplateContentSha256,
    validation: {
      D7: d7Score,
      H3: h3Score,
      combined: combinedScore,
      leaveOneReplayOut: loro,
      fixtures: [...d7Fixtures, ...h3Fixtures].map((fixture) => fixture.report),
    },
    runtimeSpecification: {
      exactBuildOnly: PROFILE.exactReplayBuild,
      availableEventCountOnCorpus: 193,
      availableEventFields: ["participantId", "timestampMillis", "structuralItemId", "source provenance", "purchaseLinked: true"],
      unavailableAddPacketCountOnCorpus: 2326,
      unavailableFields: ["general purchase classification", "automatic-state-update classification", "purchase price/gold delta", "removed item identity", "slot", "item instance", "stack/count", "undo", "inventory state"],
      semanticName: "purchase-linked resulting-item update",
      nonClaim: "The 193 events are not a complete purchase stream and do not identify the consumed/removed components; the remaining packets must remain unavailable rather than being called automatic updates.",
    },
    conclusion: "Ten frozen replay-native bundle templates identify a narrow 193/2519 zero-false-positive purchase-linked 0x0369 subset, including seven H3 packets whose six item IDs were unseen in D7. Every other profiled add/update packet remains unavailable. This checkpoint authorizes no C++, Wasm, or UI output.",
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote ${outputPath}; templates=${frozenTemplates.length}; D7=${d7Score.truePositiveAddPacketCount}/${d7Score.selectedAddPacketCount}; H3=${h3Score.truePositiveAddPacketCount}/${h3Score.selectedAddPacketCount}; combined=${combinedScore.truePositiveAddPacketCount}/${combinedScore.profileAddPacketCount}; sha256=${frozenTemplateContentSha256}.`);
}

main();
