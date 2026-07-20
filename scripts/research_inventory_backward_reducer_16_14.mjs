#!/usr/bin/env node

// Offline research only. Final inventory anchors, item-operation packets, and
// sale classification all come from saved ROFL bytes. Saved Timeline sale
// item IDs are opened only after replay-only reduction for validation.
import { spawnSync } from "node:child_process";
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

const TRINKET_ITEM_IDS = new Set([3340, 3363, 3364]);

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    participantCount: 70,
    relevantGroupCount: 4665,
    processedSuffixGroupCount: 3026,
    barrierReasons: Object.freeze({
      BEGINNING_REACHED: 35,
      "branch-limit": 12,
      "state-contradiction": 10,
      "unresolved-family": 12,
      "unresolved-removal-operation": 1,
    }),
    maximumBranchCount: 3954,
    saleCount: 77,
    encounteredSaleCount: 47,
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
      "state-contradiction": 4,
      "unresolved-family": 4,
    }),
    maximumBranchCount: 3996,
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
    processedSuffixGroupCount: 4270,
    barrierReasons: Object.freeze({
      BEGINNING_REACHED: 49,
      "branch-limit": 20,
      "state-contradiction": 14,
      "unresolved-family": 16,
      "unresolved-removal-operation": 1,
    }),
    maximumBranchCount: 3996,
    saleCount: 116,
    encounteredSaleCount: 71,
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
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_backward_reducer_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--decoder-profiles <path>] [--output <path>]",
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

function reverseGroup(states, group, saleKeys = new Set()) {
  if (group.blocks.some((block) => block.family === "undoComponent")) {
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
          physicalKey: block.physicalKey,
        })),
      };
      break;
    }
    states = reversed.states;
    processedGroups.push(group);
  }

  const processedRemovalKeys = new Set(
    processedGroups.flatMap((group) =>
      group.blocks.filter((block) => block.family === "removal").map((block) => block.physicalKey),
    ),
  );
  const saleCandidates = replaySales
    .filter((sale) => sale.participantId === participant)
    .map((sale) => {
      const symbol = `removal:${sale.physicalKey}`;
      const assignedValues = new Set(states.map((state) => state.assignments[symbol]));
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
    saleCount: sales.length,
    encounteredSaleCount: sales.filter((row) => row.encounteredByReducer).length,
    resolvedSaleItemCount: sales.filter((row) => row.resolvedItemId !== null).length,
    exactResolvedSaleItemCount: sales.filter((row) => row.validation === "EXACT").length,
    wrongResolvedSaleItemCount: sales.filter((row) => row.validation === "WRONG").length,
    unavailableSaleItemCount: sales.filter((row) => row.validation === "UNAVAILABLE").length,
  };
}

function inspectFixture(args, fixture) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const finalSlots = loadFinalSlots(args, replayPath);
  const blocks = dumpRelevantBlocks(args, replayPath);
  const replaySales = loadReplaySales(args, replayPath);
  for (const sale of replaySales) {
    if (!blocks.some((block) => block.physicalKey === sale.physicalKey)) {
      fail("Productive sale removal is absent from the relevant packet population.", {
        replayId: fixture.replayId,
        sale,
      });
    }
  }
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
    args.replayDir,
    args.apiRoot,
  ]) {
    if (!fs.existsSync(required)) fail("Required backward-reducer input is missing.", required);
  }
  const reports = PROFILE.fixtures.map((fixture) => inspectFixture(args, fixture));
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
    schema: "rofl-inventory-backward-reducer-research-16.14/v2",
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
      failClosedBarriers: [
        "Any 0x0081 Undo-component packet in the owner/time group",
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
        ? "The expanded backward reducer reaches the beginning for 49/100 participants and traverses 4,270/6,945 relevant owner/time groups. It encounters 71/116 productive sales and uniquely links five sold-item identities, all exact under the offline oracle. It remains research-only because the conservative no-change/anonymous-removal unions leave thousands of possible slot histories, 0x0081 Undo groups remain barriers, and complete timeline inventory is not unique."
        : "The backward suffix reducer does not provide a zero-error replay-only sale identity subset. Complete inventory, sale gold, and current gold remain unavailable.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
