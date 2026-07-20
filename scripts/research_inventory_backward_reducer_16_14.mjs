#!/usr/bin/env node

// Offline research only. Final inventory anchors, item-operation packets, and
// sale classification all come from saved ROFL bytes. Saved Timeline sale
// item IDs are opened only after replay-only reduction for validation.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  families: Object.freeze([
    Object.freeze({
      name: "add",
      packetType: 0x0369,
      lengths: Object.freeze([11, 14, 15, 16, 17]),
    }),
    Object.freeze({ name: "removal", packetType: 0x03f9, lengths: Object.freeze([6, 7]) }),
    Object.freeze({
      name: "removalContext",
      packetType: 0x0146,
      lengths: Object.freeze([2, 3, 4]),
    }),
    Object.freeze({ name: "undoComponent", packetType: 0x0081, lengths: null }),
  ]),
  fixtures: Object.freeze([
    Object.freeze({ replayId: "EUW1-7919517389", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7919624327", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7920241664", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7920292147", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7920341366", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7920364492", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7920550565", partition: "D7" }),
    Object.freeze({ replayId: "EUW1-7921377760", partition: "H3" }),
    Object.freeze({ replayId: "EUW1-7921482297", partition: "H3" }),
    Object.freeze({ replayId: "EUW1-7921996430", partition: "H3" }),
  ]),
  maxBranches: 4096,
});

const STATIC_ITEM_SCHEMA = Object.freeze({
  version: "16.14.1",
  byteLength: 583139,
  sha256: "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75",
});
const FRESH_SALE_MAX_AGE_MS = 30_000;

const TRINKET_ITEM_IDS = new Set([3340, 3363, 3364]);

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    participantCount: 70,
    relevantGroupCount: 4665,
    processedSuffixGroupCount: 3036,
    barrierReasons: Object.freeze({
      BEGINNING_REACHED: 36,
      "branch-limit": 12,
      "state-contradiction": 15,
      "unresolved-family": 6,
      "unresolved-removal-operation": 1,
    }),
    maximumBranchCount: 3954,
    beginningReachedCount: 36,
    beginningWithEmptyMainCount: 36,
    totalInitialMainEmptyBranchCount: 167,
    forwardProcessedGroupCount: 1610,
    forwardBarrierReasons: Object.freeze({
      "backward-incomplete": 34,
      "branch-limit": 9,
      END_REACHED: 27,
    }),
    forwardMaximumCandidateCount: 41526,
    forwardFinalMainReachableCount: 27,
    forwardFinalSlotsReachableCount: 18,
    saleCount: 77,
    encounteredSaleCount: 48,
    resolvedSaleItemCount: 3,
    exactResolvedSaleItemCount: 3,
    wrongResolvedSaleItemCount: 0,
    unavailableSaleItemCount: 74,
  }),
  holdout: Object.freeze({
    participantCount: 30,
    relevantGroupCount: 2280,
    processedSuffixGroupCount: 1244,
    barrierReasons: Object.freeze({
      BEGINNING_REACHED: 14,
      "branch-limit": 8,
      "state-contradiction": 6,
      "unresolved-family": 2,
    }),
    maximumBranchCount: 3996,
    beginningReachedCount: 14,
    beginningWithEmptyMainCount: 14,
    totalInitialMainEmptyBranchCount: 61,
    forwardProcessedGroupCount: 385,
    forwardBarrierReasons: Object.freeze({
      "backward-incomplete": 16,
      "branch-limit": 7,
      END_REACHED: 7,
    }),
    forwardMaximumCandidateCount: 48771,
    forwardFinalMainReachableCount: 7,
    forwardFinalSlotsReachableCount: 4,
    saleCount: 39,
    encounteredSaleCount: 24,
    resolvedSaleItemCount: 2,
    exactResolvedSaleItemCount: 2,
    wrongResolvedSaleItemCount: 0,
    unavailableSaleItemCount: 37,
  }),
  combined: Object.freeze({
    participantCount: 100,
    relevantGroupCount: 6945,
    processedSuffixGroupCount: 4280,
    barrierReasons: Object.freeze({
      BEGINNING_REACHED: 50,
      "branch-limit": 20,
      "state-contradiction": 21,
      "unresolved-family": 8,
      "unresolved-removal-operation": 1,
    }),
    maximumBranchCount: 3996,
    beginningReachedCount: 50,
    beginningWithEmptyMainCount: 50,
    totalInitialMainEmptyBranchCount: 228,
    forwardProcessedGroupCount: 1995,
    forwardBarrierReasons: Object.freeze({
      "backward-incomplete": 50,
      "branch-limit": 16,
      END_REACHED: 34,
    }),
    forwardMaximumCandidateCount: 48771,
    forwardFinalMainReachableCount: 34,
    forwardFinalSlotsReachableCount: 22,
    saleCount: 116,
    encounteredSaleCount: 72,
    resolvedSaleItemCount: 5,
    exactResolvedSaleItemCount: 5,
    wrongResolvedSaleItemCount: 0,
    unavailableSaleItemCount: 111,
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    decoderProfilesPath: path.join(
      "packages",
      "rofl-core",
      "profiles",
      "replay-decoder-profiles.v1.json",
    ),
    itemDataPath: null,
    outputPath: path.join("tmp", "inventory-backward-reducer-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (argument === "--decoder-profiles" && argv[index + 1]) {
      args.decoderProfilesPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--item-data" && argv[index + 1]) {
      args.itemDataPath = argv[++index];
    } else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_backward_reducer_16_14.mjs --item-data <Data-Dragon-16.14.1-item.json> [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--decoder-profiles <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!args.itemDataPath) {
    throw new Error("--item-data is required; latest/network lookup is forbidden.");
  }
  return args;
}

function fail(message, detail = undefined) {
  throw new Error(
    `${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
  );
}

function runJson(command, arguments_, maxBuffer = 256 * 1024 * 1024) {
  const run = spawnSync(command, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) fail("Native replay command failed.", { arguments_, stderr: run.stderr });
  return JSON.parse(run.stdout);
}

function loadStaticItemIds(filePath) {
  const bytes = fs.readFileSync(path.resolve(filePath));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== STATIC_ITEM_SCHEMA.byteLength || sha256 !== STATIC_ITEM_SCHEMA.sha256) {
    fail("Pinned item catalog fingerprint failed.", { byteLength: bytes.length, sha256 });
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.version !== STATIC_ITEM_SCHEMA.version || typeof parsed.data !== "object") {
    fail("Pinned item catalog schema failed.");
  }
  return new Set(Object.keys(parsed.data).map(Number));
}

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

function inputCode(payload, bits) {
  return bits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

function decodeAddItemId(payload) {
  if (payload.length < 10) return null;
  if (inputCode(payload, [72, 73, 79]) === 0 || inputCode(payload, [73, 75, 76]) === 4) {
    return null;
  }
  const bit = (index) => payloadBit(payload, index);
  const decodedBits = [
    bit(71),
    bit(66) ^ bit(71) ^ 1,
    bit(65) ^ (bit(66) & bit(71)),
    1 ^ bit(65) ^ bit(68) ^ (bit(66) & bit(71)) ^ (bit(65) & bit(66) & bit(71)),
    1 ^
      bit(67) ^
      bit(68) ^
      (bit(65) & bit(68)) ^
      (bit(66) & bit(68) & bit(71)) ^
      (bit(65) & bit(66) & bit(68) & bit(71)),
    bit(70) ^ 1,
    bit(69) ^ bit(70) ^ 1,
    bit(78) ^ bit(79),
    1 ^ bit(74) ^ bit(79) ^ (bit(72) & bit(79)),
    bit(73) ^ (bit(73) & bit(79)) ^ (bit(72) & bit(73) & bit(79)),
    bit(73) ^ bit(76) ^ 1,
    1 ^ bit(75) ^ bit(76) ^ (bit(73) & bit(76)),
    bit(78) ^ 1,
  ];
  return decodedBits.reduce((value, decoded, index) => value | (decoded << index), 0);
}

function decodeRemovalSlot(payload) {
  if (payload.length === 6) {
    const symbol = `${payloadBit(payload, 7)}${payloadBit(payload, 8)}`;
    return { "00": 0, 11: 1, 10: 2 }[symbol] ?? null;
  }
  if (payload.length === 7) {
    const symbol = `${payloadBit(payload, 16)}${payloadBit(payload, 17)}`;
    return { 10: 3, "01": 4, "00": 5, 11: 6 }[symbol] ?? null;
  }
  return null;
}

function shopRecordStarts(payload) {
  const starts = [];
  for (let position = 0; position + 3 < payload.length; position += 1) {
    if (
      (payload[position] === 0xc0 || payload[position] === 0xc3) &&
      payload[position + 3] === 0xe6
    ) {
      starts.push(position);
    }
  }
  return starts.slice(-6);
}

function decodeShopRecords(payload, validItemIds) {
  const starts = shopRecordStarts(payload);
  if (starts.length !== 6) return [];
  return starts.map((start, ordinal) => {
    const end = starts[ordinal + 1] ?? payload.length;
    const contentLength = end - start;
    const offsets =
      contentLength >= 13 && contentLength <= 15
        ? [7]
        : contentLength === 16
          ? [7, 8]
          : contentLength >= 21 && contentLength <= 23
            ? [15]
            : [];
    const candidates = [
      ...new Set(
        offsets
          .filter((offset) => start + offset + 1 < end)
          .map((offset) => {
            const pair = Buffer.alloc(10);
            pair[8] = payload[start + offset];
            pair[9] = payload[start + offset + 1];
            return decodeAddItemId(pair);
          })
          .filter((itemId) => validItemIds.has(itemId)),
      ),
    ];
    return {
      ordinal,
      itemId: candidates.length === 1 ? candidates[0] : null,
    };
  });
}

function participantId(block) {
  const result = block.blockParam - PROFILE.championOwnerBase;
  return block.channel === 1 && Number.isInteger(result) && result >= 1 && result <= 10
    ? result
    : null;
}

function physicalKey(block) {
  return `${block.segmentId}:${block.blockIndex}:${block.headerOffset}`;
}

function familyFor(block) {
  return PROFILE.families.find(
    (family) =>
      family.packetType === block.packetType &&
      (family.lengths === null || family.lengths.includes(block.contentLength)),
  );
}

function dumpRelevantBlocks(args, replayPath) {
  const dump = runJson(args.cliPath, [
    "--dump-packet-types-json",
    replayPath,
    ...PROFILE.families.flatMap((family) => ["--packet-type", String(family.packetType)]),
    "--segment-type",
    "chunk",
    "--max-blocks",
    "0",
  ]);
  if (
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    !dump.valid ||
    dump.errors?.length ||
    dump.packetTypeDumps?.length !== PROFILE.families.length
  ) {
    fail("Relevant packet dump failed its exact-build framing gate.", { replayPath });
  }
  const blocks = [];
  for (const packetDump of dump.packetTypeDumps) {
    if (packetDump.truncated || packetDump.emittedBlockCount !== packetDump.matchingBlockCount) {
      fail("Relevant packet dump was truncated.", {
        replayPath,
        packetType: packetDump.packetType,
      });
    }
    for (const block of packetDump.blocks ?? []) {
      const family = familyFor(block);
      const owner = participantId(block);
      if (!family || owner === null) continue;
      const payload = Buffer.from(block.contentHex, "hex");
      const itemId = family.name === "add" ? decodeAddItemId(payload) : null;
      if (family.name === "add" && payload.length === 11 && !TRINKET_ITEM_IDS.has(itemId)) {
        continue;
      }
      blocks.push({
        ...block,
        family: family.name,
        participantId: owner,
        physicalKey: physicalKey(block),
        itemId,
        removalSlot: family.name === "removal" ? decodeRemovalSlot(payload) : null,
        operationNibble: family.name === "removal" ? payload[0] & 0x0f : null,
      });
    }
  }
  if (new Set(blocks.map((block) => block.physicalKey)).size !== blocks.length) {
    fail("Relevant packet physical provenance is not unique.", { replayPath });
  }
  return blocks;
}

function dumpKeyframeShopBlocks(args, replayPath, validItemIds) {
  const dump = runJson(args.cliPath, [
    "--dump-packet-type-json",
    replayPath,
    "--packet-type",
    String(0x0081),
    "--segment-type",
    "keyframe",
    "--max-blocks",
    "0",
  ]);
  if (
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount
  ) {
    fail("Keyframe shop packet dump failed its exact-build framing gate.", { replayPath });
  }
  return (dump.blocks ?? []).flatMap((block) => {
    const owner = participantId(block);
    if (owner === null) return [];
    const payload = Buffer.from(block.contentHex, "hex");
    const records = decodeShopRecords(payload, validItemIds);
    if (records.length !== 6) return [];
    return [{
      participantId: owner,
      timestampMillis: block.timestampMillis,
      records,
    }];
  });
}

function loadFinalSlots(args, replayPath) {
  const summary = runJson(args.cliPath, [
    "--summary",
    replayPath,
    "--decoder-profiles",
    args.decoderProfilesPath,
  ]);
  if (
    summary.gameVersion !== PROFILE.exactReplayBuild ||
    summary.capabilities?.validatedFinalPlayerStatsAvailable !== true ||
    !Array.isArray(summary.players) ||
    summary.players.length !== 10
  ) {
    fail("Replay-only final inventory summary gate failed.", { replayPath });
  }
  return summary.players.map((player, index) => {
    if (
      !Array.isArray(player.items) ||
      player.items.length !== 7 ||
      player.items.some((itemId) => !Number.isInteger(itemId) || itemId < 0)
    ) {
      fail("Replay-only final inventory is invalid.", { replayPath, participantId: index + 1 });
    }
    return player.items;
  });
}

function loadReplaySales(args, replayPath) {
  const sales = runJson(args.cliPath, [
    "--extract-replay-item-sales-json",
    replayPath,
    "--decoder-profiles",
    args.decoderProfilesPath,
  ]);
  if (
    sales.schema !== "rofl-replay-item-sales/v1" ||
    sales.gameVersion !== PROFILE.exactReplayBuild ||
    sales.source?.runtimeInput !== "rofl-only" ||
    sales.source?.riotApiInput !== false
  ) {
    fail("Productive replay-only sale stream gate failed.", { replayPath });
  }
  return sales.events.map((event) => {
    const provenance = event.provenance?.removalBlock?.provenance;
    return {
      participantId: event.participantId,
      timestampMillis: event.timestampMillis,
      physicalKey: `${provenance.segmentId}:${provenance.blockIndex}:${provenance.decompressedHeaderOffset}`,
    };
  });
}

function deriveFreshSaleIdentities(replaySales, blocks, keyframes) {
  return replaySales.flatMap((sale) => {
    const removal = blocks.find((block) => block.physicalKey === sale.physicalKey);
    const candidateSlot = removal?.removalSlot ?? null;
    const candidateRecordOrdinal =
      candidateSlot !== null && candidateSlot >= 0 && candidateSlot <= 5
        ? 5 - candidateSlot
        : null;
    const precedingKeyframe = keyframes
      .filter(
        (keyframe) =>
          keyframe.participantId === sale.participantId &&
          keyframe.timestampMillis <= sale.timestampMillis,
      )
      .at(-1);
    const candidateItemId =
      candidateRecordOrdinal === null
        ? null
        : (precedingKeyframe?.records[candidateRecordOrdinal]?.itemId ?? null);
    const keyframeAgeMillis = precedingKeyframe
      ? sale.timestampMillis - precedingKeyframe.timestampMillis
      : null;
    if (
      !Number.isInteger(candidateItemId) ||
      candidateItemId <= 0 ||
      keyframeAgeMillis === null ||
      keyframeAgeMillis < 0 ||
      keyframeAgeMillis > FRESH_SALE_MAX_AGE_MS
    ) {
      return [];
    }
    return [{ ...sale, candidateItemId, candidateSlot, keyframeAgeMillis }];
  });
}

function annotateSaleUndoIdentities(blocks, freshSales, validItemIds) {
  return blocks.map((block) => {
    if (block.family !== "undoComponent") return block;
    const records = decodeShopRecords(Buffer.from(block.contentHex, "hex"), validItemIds);
    const recordItems = records.flatMap((record) =>
      Number.isInteger(record.itemId) && record.itemId > 0 ? [record.itemId] : [],
    );
    const candidates = freshSales.filter(
      (sale) =>
        sale.participantId === block.participantId &&
        sale.timestampMillis <= block.timestampMillis &&
        block.timestampMillis - sale.timestampMillis <= FRESH_SALE_MAX_AGE_MS &&
        recordItems.filter((itemId) => itemId === sale.candidateItemId).length === 1,
    );
    const candidateItemIds = [...new Set(candidates.map((sale) => sale.candidateItemId))];
    return {
      ...block,
      undoRestoredItemId: candidateItemIds.length === 1 ? candidateItemIds[0] : null,
      undoCandidateSaleCount: candidates.length,
    };
  });
}

function loadTimelineSaleLabels(args, replayId) {
  const timelinePath = path.join(args.apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter(
      (event) =>
        event.type === "ITEM_SOLD" &&
        Number.isInteger(event.participantId) &&
        Number.isInteger(event.timestamp) &&
        Number.isInteger(event.itemId),
    )
    .map((event) => ({
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      itemId: event.itemId,
    }));
}

function groupParticipantBlocks(blocks, participant) {
  const groups = new Map();
  for (const block of blocks.filter((candidate) => candidate.participantId === participant)) {
    const group = groups.get(block.timestampMillis) ?? [];
    group.push(block);
    groups.set(block.timestampMillis, group);
  }
  return [...groups.entries()]
    .map(([timestampMillis, group]) => ({
      timestampMillis,
      blocks: group.sort(
        (left, right) =>
          left.segmentHeaderOffset - right.segmentHeaderOffset ||
          left.headerOffset - right.headerOffset,
      ),
    }))
    .sort((left, right) => right.timestampMillis - left.timestampMillis);
}

function cloneState(state) {
  return {
    slots: [...state.slots],
    assignments: { ...state.assignments },
  };
}

function stateKey(state) {
  return JSON.stringify([state.slots, Object.entries(state.assignments).sort()]);
}

function deduplicateStates(states) {
  return [...new Map(states.map((state) => [stateKey(state), state])).values()];
}

function reverseAdd(states, block) {
  if (!Number.isInteger(block.itemId) || block.itemId <= 0) return [];
  const next = [];
  for (const state of states) {
    if (state.slots.includes(block.itemId)) next.push(cloneState(state));
    for (let slot = 0; slot < state.slots.length; slot += 1) {
      const value = state.slots[slot];
      const compatible =
        value === block.itemId ||
        value === "unknown" ||
        (typeof value === "string" &&
          (state.assignments[value] === undefined || state.assignments[value] === block.itemId));
      if (!compatible) continue;
      const candidate = cloneState(state);
      if (typeof value === "string" && value !== "unknown") {
        candidate.assignments[value] = block.itemId;
      }
      candidate.slots[slot] = 0;
      next.push(candidate);
    }
  }
  return deduplicateStates(next);
}

function reverseRemoval(states, block, group, saleKeys) {
  if (block.removalSlot === null || ![5, 13].includes(block.operationNibble)) return [];
  const symbol = saleKeys.has(block.physicalKey) ? `removal:${block.physicalKey}` : "unknown";
  const next = [];
  for (const state of states) {
    if (!saleKeys.has(block.physicalKey)) next.push(cloneState(state));
    const hasTrinketAdd = group.blocks.some(
      (candidate) => candidate.family === "add" && TRINKET_ITEM_IDS.has(candidate.itemId),
    );
    const candidateSlots =
      block.operationNibble === 5 && saleKeys.has(block.physicalKey)
        ? [block.removalSlot]
        : hasTrinketAdd && block.removalSlot === 6
          ? [6]
          : state.slots.slice(0, 6).flatMap((value, slot) => (value === 0 ? [slot] : []));
    for (const slot of candidateSlots) {
      if (state.slots[slot] !== 0) continue;
      const candidate = cloneState(state);
      candidate.slots[slot] = symbol;
      next.push(candidate);
    }
  }
  return deduplicateStates(next);
}

function reverseRemovalContext(states) {
  const next = [];
  for (const state of states) {
    next.push(cloneState(state));
    for (let slot = 0; slot < 6; slot += 1) {
      if (state.slots[slot] !== 0) continue;
      const candidate = cloneState(state);
      candidate.slots[slot] = "unknown";
      next.push(candidate);
    }
  }
  return deduplicateStates(next);
}

function reverseSaleUndo(states, block) {
  if (!Number.isInteger(block.undoRestoredItemId) || block.undoRestoredItemId <= 0) return [];
  const next = [];
  for (const state of states) {
    for (let slot = 0; slot < 6; slot += 1) {
      if (state.slots[slot] !== block.undoRestoredItemId) continue;
      const candidate = cloneState(state);
      candidate.slots[slot] = 0;
      next.push(candidate);
    }
  }
  return deduplicateStates(next);
}

function reverseGroup(states, group, saleKeys = new Set()) {
  const undoBlocks = group.blocks.filter((block) => block.family === "undoComponent");
  if (
    undoBlocks.length > 1 ||
    undoBlocks.some((block) => !Number.isInteger(block.undoRestoredItemId))
  ) {
    return { states: [], reason: "unresolved-family" };
  }
  const removalSlots = group.blocks
    .filter((block) => block.family === "removal")
    .map((block) => block.removalSlot);
  if (removalSlots.some((slot) => slot === null)) return { states: [], reason: "unknown-slot" };
  if (
    group.blocks.some(
      (block) => block.family === "removal" && ![5, 13].includes(block.operationNibble),
    )
  ) {
    return { states: [], reason: "unresolved-removal-operation" };
  }
  const fixedRemovalSlots = group.blocks
    .filter(
      (block) =>
        block.family === "removal" &&
        block.operationNibble === 5 &&
        saleKeys.has(block.physicalKey),
    )
    .map((block) => block.removalSlot);
  if (new Set(fixedRemovalSlots).size !== fixedRemovalSlots.length) {
    return { states: [], reason: "duplicate-removal-slot" };
  }
  let next = states;
  for (const block of [...group.blocks].reverse()) {
    if (block.family === "undoComponent") {
      next = reverseSaleUndo(next, block);
      if (next.length === 0) return { states: [], reason: "state-contradiction" };
      continue;
    }
    if (block.family === "removalContext") {
      next = reverseRemovalContext(next);
      if (next.length > PROFILE.maxBranches) return { states: [], reason: "branch-limit" };
      continue;
    }
    next =
      block.family === "add"
        ? reverseAdd(next, block)
        : reverseRemoval(next, block, group, saleKeys);
    if (next.length === 0) return { states: [], reason: "state-contradiction" };
    if (next.length > PROFILE.maxBranches) return { states: [], reason: "branch-limit" };
  }
  return { states: deduplicateStates(next), reason: null };
}

function deduplicateSlotStates(states) {
  return [...new Map(states.map((slots) => [JSON.stringify(slots), slots])).values()];
}

function forwardAdd(states, block) {
  if (!Number.isInteger(block.itemId) || block.itemId <= 0) return [];
  const next = [];
  for (const slots of states) {
    if (TRINKET_ITEM_IDS.has(block.itemId)) {
      const candidate = [...slots];
      candidate[6] = block.itemId;
      next.push(candidate);
      continue;
    }
    if (slots.includes(block.itemId)) next.push([...slots]);
    for (let slot = 0; slot < 6; slot += 1) {
      if (slots[slot] !== 0) continue;
      const candidate = [...slots];
      candidate[slot] = block.itemId;
      next.push(candidate);
    }
  }
  return deduplicateSlotStates(next);
}

function forwardUnknownRemoval(states, block, group, saleKeys) {
  const next = [];
  const isSale = saleKeys.has(block.physicalKey);
  const hasTrinketAdd = group.blocks.some(
    (candidate) => candidate.family === "add" && TRINKET_ITEM_IDS.has(candidate.itemId),
  );
  for (const slots of states) {
    if (isSale) {
      if (slots[block.removalSlot] === 0) continue;
      const candidate = [...slots];
      candidate[block.removalSlot] = 0;
      next.push(candidate);
      continue;
    }
    next.push([...slots]);
    const candidateSlots =
      hasTrinketAdd && block.removalSlot === 6
        ? [6]
        : slots.slice(0, 6).flatMap((value, slot) => (value !== 0 ? [slot] : []));
    for (const slot of candidateSlots) {
      if (slots[slot] === 0) continue;
      const candidate = [...slots];
      candidate[slot] = 0;
      next.push(candidate);
    }
  }
  return deduplicateSlotStates(next);
}

function forwardRemovalContext(states) {
  const next = [];
  for (const slots of states) {
    next.push([...slots]);
    for (let slot = 0; slot < 6; slot += 1) {
      if (slots[slot] === 0) continue;
      const candidate = [...slots];
      candidate[slot] = 0;
      next.push(candidate);
    }
  }
  return deduplicateSlotStates(next);
}

function forwardSaleUndo(states, block) {
  if (!Number.isInteger(block.undoRestoredItemId) || block.undoRestoredItemId <= 0) return [];
  const next = [];
  for (const slots of states) {
    for (let slot = 0; slot < 6; slot += 1) {
      if (slots[slot] !== 0) continue;
      const candidate = [...slots];
      candidate[slot] = block.undoRestoredItemId;
      next.push(candidate);
    }
  }
  return deduplicateSlotStates(next);
}

function forwardGroup(states, group, saleKeys) {
  const undoBlocks = group.blocks.filter((block) => block.family === "undoComponent");
  if (
    undoBlocks.length > 1 ||
    undoBlocks.some((block) => !Number.isInteger(block.undoRestoredItemId))
  ) {
    return { states: [], reason: "unresolved-family" };
  }
  if (
    group.blocks.some(
      (block) =>
        block.family === "removal" &&
        (block.removalSlot === null || ![5, 13].includes(block.operationNibble)),
    )
  ) {
    return { states: [], reason: "unresolved-removal-operation" };
  }
  let next = states;
  for (const block of group.blocks) {
    if (block.family === "undoComponent") next = forwardSaleUndo(next, block);
    else if (block.family === "add") next = forwardAdd(next, block);
    else if (block.family === "removal") {
      next = forwardUnknownRemoval(next, block, group, saleKeys);
    } else if (block.family === "removalContext") next = forwardRemovalContext(next);
    if (next.length === 0) return { states: [], reason: "state-contradiction" };
    if (next.length > 100_000) return { states: [], reason: "branch-limit" };
  }
  return { states: next, reason: null };
}

function backwardPatternKey(backwardState) {
  return JSON.stringify(
    backwardState.slots.slice(0, 6).map((value) => {
      if (typeof value !== "string") return value;
      return backwardState.assignments[value] ?? "*";
    }),
  );
}

function forwardCompatibleWithPatterns(slots, backwardPatternKeys) {
  const mainSlots = slots.slice(0, 6);
  const occupiedSlots = mainSlots.flatMap((value, slot) => (value === 0 ? [] : [slot]));
  for (let mask = 0; mask < 1 << occupiedSlots.length; mask += 1) {
    const pattern = [...mainSlots];
    for (let index = 0; index < occupiedSlots.length; index += 1) {
      if ((mask & (1 << index)) !== 0) pattern[occupiedSlots[index]] = "*";
    }
    if (backwardPatternKeys.has(JSON.stringify(pattern))) return true;
  }
  return false;
}

function forwardParticipant(groups, saleKeys, finalSlots, backwardLayers, backwardBarrier) {
  if (backwardBarrier !== null) {
    return {
      processedGroupCount: 0,
      barrier: { reason: "backward-incomplete" },
      finalCandidateCount: 0,
      finalMainReachable: false,
      finalSlotsReachable: false,
    };
  }
  const beginningStates = backwardLayers.at(-1).filter((state) =>
    state.slots.slice(0, 6).every((value) => value === 0),
  );
  let states = deduplicateSlotStates(
    beginningStates.map((state) => [...state.slots.slice(0, 6), "unavailable-trinket"]),
  );
  let processedGroupCount = 0;
  let barrier = null;
  const ascendingGroups = [...groups].reverse();
  for (let index = 0; index < ascendingGroups.length; index += 1) {
    const group = ascendingGroups[index];
    const result = forwardGroup(states, group, saleKeys);
    if (result.reason !== null) {
      barrier = { timestampMillis: group.timestampMillis, reason: result.reason };
      break;
    }
    const compatibleBackwardStates = backwardLayers[groups.length - index - 1];
    const backwardPatternKeys = new Set(compatibleBackwardStates.map(backwardPatternKey));
    states = result.states.filter((slots) =>
      forwardCompatibleWithPatterns(slots, backwardPatternKeys),
    );
    if (states.length === 0) {
      barrier = { timestampMillis: group.timestampMillis, reason: "bidirectional-contradiction" };
      break;
    }
    if (states.length > 20_000) {
      barrier = { timestampMillis: group.timestampMillis, reason: "branch-limit" };
      break;
    }
    processedGroupCount += 1;
  }
  const mainKey = JSON.stringify(finalSlots.slice(0, 6));
  return {
    processedGroupCount,
    barrier,
    finalCandidateCount: states.length,
    finalMainReachable: states.some((slots) => JSON.stringify(slots.slice(0, 6)) === mainKey),
    finalSlotsReachable: states.some((slots) => JSON.stringify(slots) === JSON.stringify(finalSlots)),
  };
}

function runReducerSelfTest() {
  const removal = {
    family: "removal",
    contentLength: 6,
    removalSlot: 0,
    operationNibble: 5,
    physicalKey: "self-test-sale",
  };
  const add = {
    family: "add",
    contentLength: 14,
    itemId: 1001,
    physicalKey: "self-test-add",
  };
  const afterRemoval = reverseGroup(
    [{ slots: [0, 0, 0, 0, 0, 0, 0], assignments: {} }],
    { blocks: [removal] },
    new Set([removal.physicalKey]),
  );
  const beforeAdd = reverseGroup(afterRemoval.states, { blocks: [add] });
  if (
    afterRemoval.reason !== null ||
    beforeAdd.reason !== null ||
    beforeAdd.states.length !== 1 ||
    beforeAdd.states[0].slots.some((value) => value !== 0) ||
    beforeAdd.states[0].assignments["removal:self-test-sale"] !== 1001
  ) {
    fail("Backward reducer symbolic identity self-test failed.");
  }
  const rejectedPartial = reverseGroup(
    [{ slots: [0, 0, 0, 0, 0, 0, 0], assignments: {} }],
    { blocks: [{ ...removal, operationNibble: 2 }] },
    new Set(),
  );
  if (rejectedPartial.reason !== "unresolved-removal-operation") {
    fail("Backward reducer fail-closed removal self-test failed.");
  }
}

function reduceParticipant(
  replayId,
  partition,
  participant,
  finalSlots,
  blocks,
  replaySales,
) {
  let states = [{ slots: [...finalSlots], assignments: {} }];
  const saleKeys = new Set(replaySales.map((sale) => sale.physicalKey));
  const groups = groupParticipantBlocks(blocks, participant);
  const backwardLayers = [states];
  const processedGroups = [];
  let barrier = null;
  for (const group of groups) {
    const reversed = reverseGroup(states, group, saleKeys);
    if (reversed.reason !== null) {
      barrier = {
        timestampMillis: group.timestampMillis,
        reason: reversed.reason,
        signature: group.blocks.map((block) => `${block.family}:${block.contentLength}`).join(">"),
        operations: group.blocks.map((block) => ({
          family: block.family,
          contentLength: block.contentLength,
          itemId: block.itemId,
          removalSlot: block.removalSlot,
          operationNibble: block.operationNibble,
          undoRestoredItemId: block.undoRestoredItemId ?? null,
          physicalKey: block.physicalKey,
        })),
      };
      break;
    }
    states = reversed.states;
    processedGroups.push(group);
    backwardLayers.push(states);
  }

  const forwardDiagnostic = forwardParticipant(
    groups,
    saleKeys,
    finalSlots,
    backwardLayers,
    barrier,
  );

  const processedRemovalKeys = new Set(
    processedGroups.flatMap((group) =>
      group.blocks.filter((block) => block.family === "removal").map((block) => block.physicalKey),
    ),
  );
  const beginningReached = barrier === null;
  const initialMainEmptyStates = beginningReached
    ? states.filter((state) => state.slots.slice(0, 6).every((value) => value === 0))
    : [];
  const identityStates = initialMainEmptyStates.length > 0 ? initialMainEmptyStates : states;
  const saleCandidates = replaySales
    .filter((sale) => sale.participantId === participant)
    .map((sale) => {
      const symbol = `removal:${sale.physicalKey}`;
      const assignedValues = new Set(identityStates.map((state) => state.assignments[symbol]));
      const resolvedItemId =
        processedRemovalKeys.has(sale.physicalKey) &&
        assignedValues.size === 1 &&
        !assignedValues.has(undefined)
          ? [...assignedValues][0]
          : null;
      const removal = blocks.find((block) => block.physicalKey === sale.physicalKey);
      return {
        replayId,
        partition,
        participantId: participant,
        timestampMillis: sale.timestampMillis,
        removalPhysicalKey: sale.physicalKey,
        candidateSlot: removal?.removalSlot ?? null,
        encounteredByReducer: processedRemovalKeys.has(sale.physicalKey),
        resolvedItemId,
      };
    });
  return {
    replayId,
    partition,
    participantId: participant,
    finalSlots,
    relevantGroupCount: groups.length,
    processedSuffixGroupCount: processedGroups.length,
    oldestProcessedTimestampMillis: processedGroups.at(-1)?.timestampMillis ?? null,
    branchCount: states.length,
    beginningReached,
    initialMainEmptyBranchCount: initialMainEmptyStates.length,
    identityBranchCount: identityStates.length,
    forwardDiagnostic,
    barrier,
    saleCandidates,
  };
}

function validateSales(rows, timelineLabels) {
  return rows.map((row) => {
    const labels = timelineLabels.filter(
      (label) =>
        label.participantId === row.participantId &&
        Math.abs(label.timestampMillis - row.timestampMillis) <= 1,
    );
    if (labels.length !== 1)
      fail("Sale validation label is missing or ambiguous.", { row, labels });
    return {
      ...row,
      offlineTruthItemId: labels[0].itemId,
      validation:
        row.resolvedItemId === null
          ? "UNAVAILABLE"
          : row.resolvedItemId === labels[0].itemId
            ? "EXACT"
            : "WRONG",
    };
  });
}

function countBy(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(selector(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function summarize(participants, sales) {
  return {
    participantCount: participants.length,
    relevantGroupCount: participants.reduce((sum, row) => sum + row.relevantGroupCount, 0),
    processedSuffixGroupCount: participants.reduce(
      (sum, row) => sum + row.processedSuffixGroupCount,
      0,
    ),
    barrierReasons: countBy(participants, (row) => row.barrier?.reason ?? "BEGINNING_REACHED"),
    maximumBranchCount: Math.max(...participants.map((row) => row.branchCount)),
    beginningReachedCount: participants.filter((row) => row.beginningReached).length,
    beginningWithEmptyMainCount: participants.filter(
      (row) => row.initialMainEmptyBranchCount > 0,
    ).length,
    totalInitialMainEmptyBranchCount: participants.reduce(
      (sum, row) => sum + row.initialMainEmptyBranchCount,
      0,
    ),
    forwardProcessedGroupCount: participants.reduce(
      (sum, row) => sum + row.forwardDiagnostic.processedGroupCount,
      0,
    ),
    forwardBarrierReasons: countBy(
      participants,
      (row) => row.forwardDiagnostic.barrier?.reason ?? "END_REACHED",
    ),
    forwardMaximumCandidateCount: Math.max(
      ...participants.map((row) => row.forwardDiagnostic.finalCandidateCount),
    ),
    forwardFinalMainReachableCount: participants.filter(
      (row) => row.forwardDiagnostic.finalMainReachable,
    ).length,
    forwardFinalSlotsReachableCount: participants.filter(
      (row) => row.forwardDiagnostic.finalSlotsReachable,
    ).length,
    saleCount: sales.length,
    encounteredSaleCount: sales.filter((row) => row.encounteredByReducer).length,
    resolvedSaleItemCount: sales.filter((row) => row.resolvedItemId !== null).length,
    exactResolvedSaleItemCount: sales.filter((row) => row.validation === "EXACT").length,
    wrongResolvedSaleItemCount: sales.filter((row) => row.validation === "WRONG").length,
    unavailableSaleItemCount: sales.filter((row) => row.validation === "UNAVAILABLE").length,
  };
}

function inspectFixture(args, fixture, validItemIds) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const finalSlots = loadFinalSlots(args, replayPath);
  let blocks = dumpRelevantBlocks(args, replayPath);
  const replaySales = loadReplaySales(args, replayPath);
  for (const sale of replaySales) {
    if (!blocks.some((block) => block.physicalKey === sale.physicalKey)) {
      fail("Productive sale removal is absent from the relevant packet population.", {
        replayId: fixture.replayId,
        sale,
      });
    }
  }
  const keyframes = dumpKeyframeShopBlocks(args, replayPath, validItemIds);
  const freshSaleIdentities = deriveFreshSaleIdentities(replaySales, blocks, keyframes);
  blocks = annotateSaleUndoIdentities(blocks, freshSaleIdentities, validItemIds);
  const participants = Array.from({ length: 10 }, (_, index) =>
    reduceParticipant(
      fixture.replayId,
      fixture.partition,
      index + 1,
      finalSlots[index],
      blocks,
      replaySales,
    ),
  );
  const timelineLabels = loadTimelineSaleLabels(args, fixture.replayId);
  if (timelineLabels.length !== replaySales.length) {
    fail("Replay sale stream and offline validation label counts differ.", {
      replayId: fixture.replayId,
      replaySales: replaySales.length,
      timelineLabels: timelineLabels.length,
    });
  }
  return {
    replayId: fixture.replayId,
    partition: fixture.partition,
    participants,
    sales: validateSales(
      participants.flatMap((row) => row.saleCandidates),
      timelineLabels,
    ),
  };
}

function main() {
  const args = parseArgs(process.argv);
  runReducerSelfTest();
  for (const required of [
    args.cliPath,
    args.decoderProfilesPath,
    args.itemDataPath,
    args.replayDir,
    args.apiRoot,
  ]) {
    if (!fs.existsSync(required)) fail("Required backward-reducer input is missing.", required);
  }
  const validItemIds = loadStaticItemIds(args.itemDataPath);
  const reports = PROFILE.fixtures.map((fixture) =>
    inspectFixture(args, fixture, validItemIds),
  );
  const participants = reports.flatMap((report) => report.participants);
  const sales = reports.flatMap((report) => report.sales);
  const discoveryParticipants = participants.filter((row) => row.partition === "D7");
  const holdoutParticipants = participants.filter((row) => row.partition === "H3");
  const discoverySales = sales.filter((row) => row.partition === "D7");
  const holdoutSales = sales.filter((row) => row.partition === "H3");
  const metrics = {
    discovery: summarize(discoveryParticipants, discoverySales),
    holdout: summarize(holdoutParticipants, holdoutSales),
    combined: summarize(participants, sales),
  };
  if (JSON.stringify(metrics) !== JSON.stringify(EXPECTED)) {
    fail("Frozen backward inventory reducer metrics drifted.", {
      expected: EXPECTED,
      actual: metrics,
    });
  }
  const output = {
    schema: "rofl-inventory-backward-reducer-research-16.14/v3",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    selfTestPassed: true,
    replayOnlyInputs: [
      "Embedded validated final seven-slot inventories from each saved ROFL summary",
      "Exact-framed champion-owned 0x0369/0x03F9/0x0146/0x0081 chunk packets",
      "Productive external-profile rofl-replay-item-sales/v1 classification",
    ],
    offlineOracle:
      "Saved Timeline ITEM_SOLD.itemId labels are loaded only after replay-only reduction to measure exact/wrong/unavailable results.",
    reducer: {
      direction: "backward from replay-embedded final inventory",
      addRule:
        "Undo replay-decoded 0x0369 length-14/15/16/17 adds and length-11 trinket adds by branching over matching concrete or anonymous slots; preserve a same-item state branch because this family also contains result/state updates.",
      removalRule:
        "Undo productive replay-classified sales in the structural candidate slot with a provenance-keyed identity. For non-sale low-nibble-5/13 records, preserve both a no-unit-change branch and an anonymous removed-unit branch over empty main slots; keep a paired trinket replacement in slot 6.",
      removalContextRule:
        "Treat each unresolved 0x0146 record as the bounded union of no unit-count change or one anonymous main-slot unit removed. Anonymous non-sale units are canonicalized because only productive sale identities require provenance linkage.",
      saleUndoRule:
        "For the exact replay-native sale-Undo subset, require a productive fresh sold-item candidate to occur exactly once in the later same-owner 0x0081 record set. Reverse it by removing that restored identity from any matching main slot; do not interpret record ordinal as a physical slot.",
      failClosedBarriers: [
        "Any 0x0081 Undo-component packet without one replay-native sale-Undo restored identity",
        "Any 0x03F9 removal whose low operation nibble is not 5 or 13",
        "Duplicate productive-sale slots, absent add IDs, state contradictions, or more than 4096 branches",
      ],
    },
    metrics,
    participants,
    saleCandidates: sales,
    conclusion:
      metrics.combined.wrongResolvedSaleItemCount === 0 &&
      metrics.combined.resolvedSaleItemCount > 0
        ? "The sale-Undo-aware backward reducer reaches the beginning for 50/100 participants and traverses 4,280/6,945 relevant owner/time groups. It encounters 72/116 productive sales and uniquely links five sold-item identities, all exact under the offline oracle. Bidirectional filtering reaches an exact main-slot final state for 34 beginning-reaching tracks. It remains research-only because missing operation families produce contradictions or barriers and complete timeline inventory is not unique."
        : "The backward suffix reducer does not provide a zero-error replay-only sale identity subset. Complete inventory, sale gold, and current gold remain unavailable.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
