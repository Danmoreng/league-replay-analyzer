#!/usr/bin/env node

// Offline research only. This harness validates a bounded patch-16.14
// component-consumption constraint. Saved ROFL packet bytes are the candidate
// input. Saved Timeline fixtures are read only after packet extraction as D7/H3
// labels. The required Data Dragon file is version-pinned static item-schema
// metadata; it is not match state, a network dependency, or a runtime fallback.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.14",
  exactReplayBuild: "16.14.794.5912",
  championIdBase: 0x400000ad,
  labelToleranceMillis: 1,
  addOrUpdate: Object.freeze({ packetType: 0x0369, contentLengths: Object.freeze([14, 15]) }),
  removal: Object.freeze({ packetType: 0x03f9, contentLengths: Object.freeze([6, 7]) }),
  removalContext: Object.freeze({ packetType: 0x0146, contentLengths: Object.freeze([2, 3, 4]) }),
});

const STATIC_ITEM_SCHEMA = Object.freeze({
  version: "16.14.1",
  type: "item",
  entryCount: 706,
  byteLength: 583139,
  sha256: "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75",
  sourceUrl: "https://ddragon.leagueoflegends.com/cdn/16.14.1/data/en_US/item.json",
});

const FIXTURES = Object.freeze({
  discovery: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664",
    "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492",
    "EUW1-7920550565",
  ]),
  holdout: Object.freeze([
    "EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430",
  ]),
});

// Historical research designed the classifier and recipe rule on D7. This
// maintained harness reproduces that rule and gates D7 before opening H3; it
// does not reproduce or claim to enforce the original selection process.
const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    replayCount: 7,
    destroyedClasses: Object.freeze({
      "real-inventory": 1118,
      "non-purchasable": 140,
      "zero-gold-system": 56,
      "map11-invalid": 184,
    }),
    eligibleRemovalCount: 232,
    uniquelyLabeledRealRemovalCount: 209,
    ignoredSystemLabelCountAtEligibleRemovals: 23,
    staticRecipeTruthHitCount: 209,
    staticRecipeTruthMissCount: 0,
    truthHistoricallyObservedAddItemIdCount: 209,
    truthNotHistoricallyObservedAddItemIdCount: 0,
    before: Object.freeze({ candidateCount: 209, totalCandidateCount: 2147, maximumCandidateCount: 21, singletonCorrectCount: 0, singletonWrongCount: 0, ambiguousCount: 209, impossibleTruthCount: 0 }),
    after: Object.freeze({ candidateCount: 209, totalCandidateCount: 313, maximumCandidateCount: 4, singletonCorrectCount: 138, singletonWrongCount: 0, ambiguousCount: 71, impossibleTruthCount: 0 }),
  }),
  holdoutEvaluation: Object.freeze({
    replayCount: 3,
    destroyedClasses: Object.freeze({
      "real-inventory": 724,
      "non-purchasable": 68,
      "zero-gold-system": 25,
      "map11-invalid": 100,
    }),
    eligibleRemovalCount: 93,
    uniquelyLabeledRealRemovalCount: 83,
    ignoredSystemLabelCountAtEligibleRemovals: 10,
    staticRecipeTruthHitCount: 83,
    staticRecipeTruthMissCount: 0,
    truthHistoricallyObservedAddItemIdCount: 83,
    truthNotHistoricallyObservedAddItemIdCount: 0,
    before: Object.freeze({ candidateCount: 83, totalCandidateCount: 964, maximumCandidateCount: 39, singletonCorrectCount: 0, singletonWrongCount: 0, ambiguousCount: 83, impossibleTruthCount: 0 }),
    after: Object.freeze({ candidateCount: 83, totalCandidateCount: 133, maximumCandidateCount: 5, singletonCorrectCount: 56, singletonWrongCount: 0, ambiguousCount: 27, impossibleTruthCount: 0 }),
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    itemDataPath: null,
    outputPath: path.join("artifacts", "inventory-recipe-constraints-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (argument === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (argument === "--item-data" && index + 1 < argv.length) args.itemDataPath = argv[++index];
    else if (argument === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/research_inventory_recipe_constraints_16_14.mjs --item-data <Data-Dragon-16.14.1-item.json> [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!args.itemDataPath) throw new Error("--item-data is required; network and latest-version lookup are intentionally unsupported.");
  return args;
}

function assert(condition, message, details = null) {
  if (condition) return;
  throw new Error(details === null ? message : `${message}: ${JSON.stringify(details)}`);
}

function sortedObject(object) {
  return Object.fromEntries(Object.entries(object).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function loadStaticItemSchema(itemDataPath) {
  const bytes = fs.readFileSync(itemDataPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert(bytes.length === STATIC_ITEM_SCHEMA.byteLength, "Data Dragon item fixture byte length mismatch", { expected: STATIC_ITEM_SCHEMA.byteLength, actual: bytes.length });
  assert(sha256 === STATIC_ITEM_SCHEMA.sha256, "Data Dragon item fixture SHA-256 mismatch", { expected: STATIC_ITEM_SCHEMA.sha256, actual: sha256 });
  const parsed = JSON.parse(bytes.toString("utf8"));
  assert(parsed.type === STATIC_ITEM_SCHEMA.type, "Data Dragon item fixture type mismatch", { expected: STATIC_ITEM_SCHEMA.type, actual: parsed.type });
  assert(parsed.version === STATIC_ITEM_SCHEMA.version, "Data Dragon item fixture version mismatch", { expected: STATIC_ITEM_SCHEMA.version, actual: parsed.version });
  assert(parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data), "Data Dragon item fixture has no item data object");
  assert(Object.keys(parsed.data).length === STATIC_ITEM_SCHEMA.entryCount, "Data Dragon item fixture entry count mismatch", { expected: STATIC_ITEM_SCHEMA.entryCount, actual: Object.keys(parsed.data).length });
  return { catalog: parsed.data, sha256, byteLength: bytes.length };
}

function classifyItem(catalog, itemId) {
  const item = catalog[String(itemId)];
  if (!item) return "catalog-missing";
  if (item.maps?.["11"] !== true) return "map11-invalid";
  if (item.gold?.purchasable !== true) return "non-purchasable";
  if (Number(item.gold?.total ?? 0) <= 0) return "zero-gold-system";
  return "real-inventory";
}

function recipeSignature(catalog, itemId) {
  const item = catalog[String(itemId)];
  const from = (item?.from ?? []).map(Number).sort((left, right) => left - right);
  const into = (item?.into ?? []).map(Number).sort((left, right) => left - right);
  return from.length === 0 ? null : `${from.join(",")}|${into.join(",")}`;
}

function buildRecipeTools(catalog) {
  const equivalentItemsBySignature = new Map();
  for (const itemIdText of Object.keys(catalog)) {
    const itemId = Number(itemIdText);
    const signature = recipeSignature(catalog, itemId);
    if (signature === null) continue;
    const values = equivalentItemsBySignature.get(signature) ?? [];
    values.push(itemId);
    equivalentItemsBySignature.set(signature, values);
  }
  function closure(itemId, seen = new Set()) {
    if (seen.has(itemId)) return seen;
    seen.add(itemId);
    for (const componentIdText of catalog[String(itemId)]?.from ?? []) closure(Number(componentIdText), seen);
    return seen;
  }
  function expandedRecipe(resultItemId) {
    const allowed = new Set();
    for (const componentIdText of catalog[String(resultItemId)]?.from ?? []) {
      const componentId = Number(componentIdText);
      for (const itemId of closure(componentId, new Set())) allowed.add(itemId);
      const signature = recipeSignature(catalog, componentId);
      for (const equivalentId of equivalentItemsBySignature.get(signature) ?? []) allowed.add(equivalentId);
    }
    return allowed;
  }
  return { expandedRecipe };
}

function payloadBit(payload, bit) { return (payload[bit >> 3] >> (bit & 7)) & 1; }
function inputCode(payload, inputBits) { return inputBits.reduce((value, bit, index) => value | (payloadBit(payload, bit) << index), 0); }

function decodeItemId(payload) {
  if (inputCode(payload, [72, 73, 79]) === 0 || inputCode(payload, [73, 75, 76]) === 4) return null;
  const bit = (index) => payloadBit(payload, index);
  const values = [
    bit(71),
    bit(66) ^ bit(71) ^ 1,
    bit(65) ^ (bit(66) & bit(71)),
    1 ^ bit(65) ^ bit(68) ^ (bit(66) & bit(71)) ^ (bit(65) & bit(66) & bit(71)),
    1 ^ bit(67) ^ bit(68) ^ (bit(65) & bit(68)) ^ (bit(66) & bit(68) & bit(71)) ^ (bit(65) & bit(66) & bit(68) & bit(71)),
    bit(70) ^ 1,
    bit(69) ^ bit(70) ^ 1,
    bit(78) ^ bit(79),
    1 ^ bit(74) ^ bit(79) ^ (bit(72) & bit(79)),
    bit(73) ^ (bit(73) & bit(79)) ^ (bit(72) & bit(73) & bit(79)),
    bit(73) ^ bit(76) ^ 1,
    1 ^ bit(75) ^ bit(76) ^ (bit(73) & bit(76)),
    bit(78) ^ 1,
  ];
  return values.reduce((itemId, value, index) => itemId | (value << index), 0);
}

function runCli(cliPath, cliArgs) {
  const result = spawnSync(cliPath, cliArgs, { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Native CLI failed with status ${result.status}.`);
  return JSON.parse(result.stdout);
}

function dumpPacketFamilies(cliPath, replayPath) {
  const result = runCli(cliPath, [
    "--dump-packet-types-json", replayPath,
    "--packet-type", String(PROFILE.addOrUpdate.packetType),
    "--packet-type", String(PROFILE.removal.packetType),
    "--packet-type", String(PROFILE.removalContext.packetType),
    "--segment-type", "chunk", "--max-blocks", "0",
  ]);
  assert(result.valid && !(result.errors?.length), `${path.basename(replayPath)} failed packet framing`, result.errors);
  const blocksFor = (family, kind) => {
    const typeDump = result.packetTypeDumps?.find((entry) => entry.packetType === family.packetType);
    assert(typeDump && !typeDump.truncated && typeDump.emittedBlockCount === typeDump.matchingBlockCount,
      `${path.basename(replayPath)} has an incomplete ${kind} packet dump`);
    const lengths = new Set(family.contentLengths);
    return (typeDump.blocks ?? []).filter((block) => block.channel === 1 && lengths.has(block.contentLength))
      .map((block) => {
        assert(block.contentHexTruncated === false && block.contentHexBytes === block.contentLength
          && typeof block.contentHex === "string" && block.contentHex.length === block.contentLength * 2,
        `${path.basename(replayPath)} contains an incomplete ${kind} payload`);
        return {
          kind,
          participantId: block.blockParam - PROFILE.championIdBase,
          timestampMillis: block.timestampMillis,
          payload: Buffer.from(block.contentHex, "hex"),
          provenance: {
            segmentType: block.segmentType,
            segmentId: block.segmentId,
            chunkId: block.chunkId,
            segmentPayloadOffset: block.segmentPayloadOffset,
            sourceOffset: block.sourceOffset,
            blockIndex: block.blockIndex,
          },
        };
      }).filter((block) => block.participantId >= 1 && block.participantId <= 10);
  };
  const additions = blocksFor(PROFILE.addOrUpdate, "add-or-update").map((block) => ({ ...block, itemId: decodeItemId(block.payload) }));
  assert(additions.every((block) => block.itemId !== null), `${path.basename(replayPath)} contains an unavailable profiled 0x0369 item symbol`);
  return {
    additions,
    removals: blocksFor(PROFILE.removal, "removal"),
    removalContexts: blocksFor(PROFILE.removalContext, "removal-context"),
  };
}

function loadFixture(args, replayId, split) {
  const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
  const timelinePath = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
  const summary = runCli(args.cliPath, ["--summary", replayPath]);
  assert(summary.gameVersion === PROFILE.exactReplayBuild, `${replayId} replay build mismatch`, { expected: PROFILE.exactReplayBuild, actual: summary.gameVersion });
  const packets = dumpPacketFamilies(args.cliPath, replayPath);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const destroyedLabels = (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_DESTROYED" && Number.isInteger(event.participantId)
      && Number.isInteger(event.timestamp) && Number.isInteger(event.itemId));
  return { replayId, split, replayPath, timelinePath, destroyedLabels, ...packets };
}

function candidateScore() {
  return { candidateCount: 0, totalCandidateCount: 0, maximumCandidateCount: 0, singletonCorrectCount: 0, singletonWrongCount: 0, ambiguousCount: 0, impossibleTruthCount: 0 };
}

function scoreCandidateSet(score, candidates, truth) {
  score.candidateCount += 1;
  score.totalCandidateCount += candidates.length;
  score.maximumCandidateCount = Math.max(score.maximumCandidateCount, candidates.length);
  if (candidates.length === 1 && candidates[0] !== truth) {
    score.singletonWrongCount += 1;
    score.impossibleTruthCount += 1;
  } else if (candidates.length === 1) score.singletonCorrectCount += 1;
  else if (!candidates.includes(truth)) score.impossibleTruthCount += 1;
  else score.ambiguousCount += 1;
}

function near(block, participantId, timestampMillis) {
  return block.participantId === participantId
    && Math.abs(block.timestampMillis - timestampMillis) <= PROFILE.labelToleranceMillis;
}

// This establishes only physical/historical observation order. It does not
// prove that an item is currently owned, that two packets share an instance,
// or that an earlier item survived intervening operations.
function historicallyBeforeRemoval(addition, removal) {
  if (addition.timestampMillis < removal.timestampMillis) return true;
  if (addition.timestampMillis !== removal.timestampMillis) return false;
  return addition.provenance.segmentType === removal.provenance.segmentType
    && addition.provenance.segmentId === removal.provenance.segmentId
    && Number.isInteger(addition.provenance.sourceOffset)
    && Number.isInteger(removal.provenance.sourceOffset)
    && addition.provenance.sourceOffset < removal.provenance.sourceOffset;
}

function auditSplit(fixtures, catalog, expandedRecipe) {
  const result = {
    replayCount: fixtures.length,
    destroyedClasses: {},
    destroyedIdCounts: {},
    eligibleRemovalCount: 0,
    uniquelyLabeledRealRemovalCount: 0,
    ignoredSystemLabelCountAtEligibleRemovals: 0,
    staticRecipeTruthHitCount: 0,
    staticRecipeTruthMissCount: 0,
    truthHistoricallyObservedAddItemIdCount: 0,
    truthNotHistoricallyObservedAddItemIdCount: 0,
    before: candidateScore(),
    after: candidateScore(),
    replayRows: [],
  };
  for (const fixture of fixtures) {
    const row = { replayId: fixture.replayId, eligibleRemovalCount: 0, uniquelyLabeledRealRemovalCount: 0, singletonCorrectCount: 0, ambiguousCount: 0 };
    for (const label of fixture.destroyedLabels) {
      const itemClass = classifyItem(catalog, label.itemId);
      result.destroyedClasses[itemClass] = (result.destroyedClasses[itemClass] ?? 0) + 1;
      const idKey = `${itemClass}:${label.itemId}`;
      result.destroyedIdCounts[idKey] = (result.destroyedIdCounts[idKey] ?? 0) + 1;
    }
    for (const removal of fixture.removals) {
      const additions = fixture.additions.filter((block) => near(block, removal.participantId, removal.timestampMillis));
      const removals = fixture.removals.filter((block) => near(block, removal.participantId, removal.timestampMillis));
      const contexts = fixture.removalContexts.filter((block) => near(block, removal.participantId, removal.timestampMillis));
      if (additions.length !== 1 || removals.length !== 1 || contexts.length !== 0) continue;
      const directComponents = (catalog[String(additions[0].itemId)]?.from ?? []).map(Number);
      if (directComponents.length === 0) continue;
      result.eligibleRemovalCount += 1;
      row.eligibleRemovalCount += 1;
      const labels = fixture.destroyedLabels.filter((label) => near({ participantId: label.participantId, timestampMillis: label.timestamp }, removal.participantId, removal.timestampMillis));
      const realLabels = labels.filter((label) => classifyItem(catalog, label.itemId) === "real-inventory");
      result.ignoredSystemLabelCountAtEligibleRemovals += labels.length - realLabels.length;
      if (realLabels.length !== 1) continue;
      result.uniquelyLabeledRealRemovalCount += 1;
      row.uniquelyLabeledRealRemovalCount += 1;
      const truth = realLabels[0].itemId;
      const allowed = expandedRecipe(additions[0].itemId);
      if (allowed.has(truth)) result.staticRecipeTruthHitCount += 1;
      else result.staticRecipeTruthMissCount += 1;
      const historicalObservedAddItemIds = [...new Set(fixture.additions
        .filter((block) => block.participantId === removal.participantId && historicallyBeforeRemoval(block, removal)
          && classifyItem(catalog, block.itemId) === "real-inventory")
        .map((block) => block.itemId))];
      if (historicalObservedAddItemIds.includes(truth)) result.truthHistoricallyObservedAddItemIdCount += 1;
      else result.truthNotHistoricallyObservedAddItemIdCount += 1;
      const constrained = historicalObservedAddItemIds.filter((itemId) => allowed.has(itemId));
      scoreCandidateSet(result.before, historicalObservedAddItemIds, truth);
      scoreCandidateSet(result.after, constrained, truth);
      if (constrained.length === 1 && constrained[0] === truth) row.singletonCorrectCount += 1;
      else if (constrained.includes(truth)) row.ambiguousCount += 1;
    }
    result.replayRows.push(row);
  }
  result.destroyedClasses = sortedObject(result.destroyedClasses);
  result.destroyedIdCounts = sortedObject(result.destroyedIdCounts);
  result.before.meanCandidateCount = result.before.totalCandidateCount / result.before.candidateCount;
  result.after.meanCandidateCount = result.after.totalCandidateCount / result.after.candidateCount;
  return result;
}

function exactSubset(actual, expected) {
  if (expected === null || typeof expected !== "object") return actual === expected;
  return Object.entries(expected).every(([key, value]) => exactSubset(actual?.[key], value));
}

function exactCountMap(actual, expected) {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = Object.keys(expected ?? {}).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every((key) => actual[key] === expected[key]);
}

function main() {
  const args = parseArgs(process.argv);
  args.cliPath = path.resolve(args.cliPath);
  args.replayDir = path.resolve(args.replayDir);
  args.apiRoot = path.resolve(args.apiRoot);
  args.itemDataPath = path.resolve(args.itemDataPath);
  args.outputPath = path.resolve(args.outputPath);

  const staticData = loadStaticItemSchema(args.itemDataPath);
  const recipeTools = buildRecipeTools(staticData.catalog);
  // Discovery is fully loaded and audited before Holdout is opened.
  const discoveryFixtures = FIXTURES.discovery.map((replayId) => loadFixture(args, replayId, "discovery"));
  const discovery = auditSplit(discoveryFixtures, staticData.catalog, recipeTools.expandedRecipe);
  const discoveryDestroyedClassMapExact = exactCountMap(discovery.destroyedClasses, EXPECTED.discovery.destroyedClasses);
  const discoveryGatePassed = exactSubset(discovery, EXPECTED.discovery) && discoveryDestroyedClassMapExact;
  assert(discoveryGatePassed, "D7 recipe-constraint discovery gate regressed", { expected: EXPECTED.discovery, actual: discovery });

  const holdoutFixtures = FIXTURES.holdout.map((replayId) => loadFixture(args, replayId, "holdout"));
  const holdout = auditSplit(holdoutFixtures, staticData.catalog, recipeTools.expandedRecipe);
  const holdoutDestroyedClassMapExact = exactCountMap(holdout.destroyedClasses, EXPECTED.holdoutEvaluation.destroyedClasses);
  const holdoutEvaluationReproduced = exactSubset(holdout, EXPECTED.holdoutEvaluation) && holdoutDestroyedClassMapExact;
  assert(holdoutEvaluationReproduced, "H3 frozen-rule evaluation regressed", { expected: EXPECTED.holdoutEvaluation, actual: holdout });

  const output = {
    schema: "rofl-inventory-static-recipe-constraints-research/v2",
    status: "research-validated-not-promoted",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: PROFILE,
    staticItemSchema: {
      ...STATIC_ITEM_SCHEMA,
      actualSha256: staticData.sha256,
      actualByteLength: staticData.byteLength,
      role: "Version-pinned static item validity and recipe graph only; supplies no match state.",
      networkAccess: false,
      latestLookup: false,
      runtimeDependency: false,
    },
    selectionHistory: {
      historicalDesign: "The classifier and recipe rule were designed in earlier D7 research; this harness reproduces the frozen result and does not replay the original selection process.",
      enforcedRunOrder: "The maintained D7 expected-count gate must pass before this process opens H3 files.",
      holdoutRole: "H3 evaluates the unchanged historical rule; it does not select or modify it.",
    },
    methodology: {
      replayInput: "Exact-framed 0x0369/0x03F9/0x0146 channel-1 blocks from saved ROFL chunks.",
      riotTimelineRole: "Saved Timeline ITEM_DESTROYED events are offline D7/H3 labels loaded after replay packet extraction; never runtime input.",
      classifier: "real-inventory iff catalog entry exists, maps[11] is true, gold.purchasable is true, and gold.total is greater than zero",
      frozenRule: [
        "same owner within one millisecond: exactly one profiled 0x0369, exactly one profiled 0x03F9, and zero profiled 0x0146",
        "0x0369 result item has a non-empty Data Dragon `from` recipe",
        "candidate target is a historically observed earlier same-owner 0x0369 real-item ID in the result item's transitive `from` closure",
        "historical order requires an earlier timestamp, or the same timestamp plus the same segment and a lower sourceOffset than the 0x03F9 removal",
        "historical item-ID observation is not current inventory, instance continuity, ownership-at-removal, or state reconstruction",
        "static sibling aliases are allowed only when sorted `from` and sorted `into` lists are identical (the 2420/2421 boundary)",
        "0x0146, multi-operation, missing-recipe, and transform shapes fail closed",
      ],
      splitOrder: "The historical D7-designed rule and expected counts are gated before H3 files are opened; H3 evaluates the unchanged rule.",
    },
    expected: EXPECTED,
    gates: {
      discoveryGatePassed,
      discoveryDestroyedClassMapExact,
      holdoutEvaluationReproduced,
      holdoutDestroyedClassMapExact,
    },
    discovery,
    holdout,
    combined: {
      uniquelyLabeledRealRemovalCount: discovery.uniquelyLabeledRealRemovalCount + holdout.uniquelyLabeledRealRemovalCount,
      singletonCorrectCount: discovery.after.singletonCorrectCount + holdout.after.singletonCorrectCount,
      remainingAmbiguousCount: discovery.after.ambiguousCount + holdout.after.ambiguousCount,
      impossibleTruthCount: discovery.after.impossibleTruthCount + holdout.after.impossibleTruthCount,
    },
    completeInventoryBoundary: {
      completeInventoryReconstructionAttempted: false,
      completeInventoryAvailable: false,
      reason: "This harness evaluates only a bounded historical-item-ID recipe constraint; it does not run a complete inventory reconstruction algorithm.",
    },
    promotionBoundary: {
      passed: false,
      reason: "This is an offline bounded component-consumption constraint, not a complete inventory reducer.",
      unresolved: ["sales target", "0x0146 item/slot/instance", "slot permutation", "undo", "complete inventory state"],
      cxxWasmUiChanges: false,
    },
  };
  writeJson(args.outputPath, output);
  console.log(`Wrote patch 16.14 inventory recipe constraints to ${args.outputPath}`);
  console.log(`D7 singleton=${discovery.after.singletonCorrectCount}/${discovery.after.candidateCount}, ambiguous=${discovery.after.ambiguousCount}; `
    + `H3 singleton=${holdout.after.singletonCorrectCount}/${holdout.after.candidateCount}, ambiguous=${holdout.after.ambiguousCount}; `
    + `completeInventoryAvailable=${output.completeInventoryBoundary.completeInventoryAvailable}`);
}

main();
