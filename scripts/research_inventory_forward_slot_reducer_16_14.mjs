#!/usr/bin/env node

// Offline research only. Candidate inventory mutations come exclusively from
// exact-framed saved ROFL chunk packets. Replay-embedded final item slots are
// the validation oracle; Riot API Timeline data is never loaded.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  addPacketType: 0x0369,
  removalPacketType: 0x03f9,
  fixtures: Object.freeze([
    ["EUW1-7919517389", "D7"],
    ["EUW1-7919624327", "D7"],
    ["EUW1-7920241664", "D7"],
    ["EUW1-7920292147", "D7"],
    ["EUW1-7920341366", "D7"],
    ["EUW1-7920364492", "D7"],
    ["EUW1-7920550565", "D7"],
    ["EUW1-7921377760", "H3"],
    ["EUW1-7921482297", "H3"],
    ["EUW1-7921996430", "H3"],
  ]),
});

const EXPECTED_BEST = Object.freeze({
  addLengths: Object.freeze([11, 14, 15, 16, 17]),
  initialTrinketItemId: 3340,
  removalNibbles: Object.freeze([5, 13]),
  placement: "lowestEmpty",
  ignoreExisting: false,
  protectTrinketSlot: true,
  discovery: Object.freeze({
    trackCount: 70,
    exactSlotTrackCount: 10,
    exactMultisetTrackCount: 14,
    exactSlotCellCount: 353,
    exactMainSlotCellCount: 284,
    exactTrinketSlotCount: 69,
    unavailableAddCount: 0,
    ignoredExistingAddCount: 0,
    overflowAddCount: 218,
    occupiedRemovalCount: 1043,
    emptyRemovalCount: 101,
  }),
  holdout: Object.freeze({
    trackCount: 30,
    exactSlotTrackCount: 6,
    exactMultisetTrackCount: 6,
    exactSlotCellCount: 149,
    exactMainSlotCellCount: 119,
    exactTrinketSlotCount: 30,
    unavailableAddCount: 0,
    ignoredExistingAddCount: 0,
    overflowAddCount: 169,
    occupiedRemovalCount: 638,
    emptyRemovalCount: 57,
  }),
});

const EXPECTED_REPLAY_ONLY = Object.freeze({
  addLengths: Object.freeze([11, 14, 15, 16, 17]),
  initialTrinketItemId: 0,
  removalNibbles: Object.freeze([5, 13]),
  placement: "lowestEmpty",
  ignoreExisting: false,
  protectTrinketSlot: true,
  discovery: Object.freeze({
    trackCount: 70,
    exactSlotTrackCount: 9,
    exactMultisetTrackCount: 12,
    exactSlotCellCount: 337,
    exactMainSlotCellCount: 284,
    exactTrinketSlotCount: 53,
    unavailableAddCount: 0,
    ignoredExistingAddCount: 0,
    overflowAddCount: 186,
    occupiedRemovalCount: 1031,
    emptyRemovalCount: 113,
  }),
  holdout: Object.freeze({
    trackCount: 30,
    exactSlotTrackCount: 5,
    exactMultisetTrackCount: 5,
    exactSlotCellCount: 143,
    exactMainSlotCellCount: 119,
    exactTrinketSlotCount: 24,
    unavailableAddCount: 0,
    ignoredExistingAddCount: 0,
    overflowAddCount: 151,
    occupiedRemovalCount: 633,
    emptyRemovalCount: 62,
  }),
});

const EXPECTED_SYMBOLIC = Object.freeze({
  discovery: Object.freeze({
    trackCount: 70,
    exactTrackCount: 23,
    overflowedTrackCount: 1,
    maxPeakStateCount: 50002,
  }),
  holdout: Object.freeze({
    trackCount: 30,
    exactTrackCount: 13,
    overflowedTrackCount: 0,
    maxPeakStateCount: 19032,
  }),
});

const TRINKET_ITEM_IDS = new Set([3340, 3363, 3364]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    decoderProfilesPath: path.join(
      "packages",
      "rofl-core",
      "profiles",
      "replay-decoder-profiles.v1.json",
    ),
    outputPath: path.join("tmp", "inventory-forward-slot-reducer-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--decoder-profiles" && argv[index + 1]) {
      args.decoderProfilesPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_forward_slot_reducer_16_14.mjs [--cli <path>] [--replay-dir <path>] [--decoder-profiles <path>] [--output <path>]",
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

function dumpOperations(args, replayPath) {
  const dump = runJson(args.cliPath, [
    "--dump-packet-types-json",
    replayPath,
    "--packet-type",
    String(PROFILE.addPacketType),
    "--packet-type",
    String(PROFILE.removalPacketType),
    "--segment-type",
    "chunk",
    "--max-blocks",
    "0",
  ]);
  if (
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    !dump.valid ||
    dump.errors?.length ||
    dump.packetTypeDumps?.length !== 2
  ) {
    fail("Inventory operation framing gate failed.", { replayPath });
  }
  const operations = [];
  for (const packetDump of dump.packetTypeDumps) {
    if (packetDump.truncated || packetDump.emittedBlockCount !== packetDump.matchingBlockCount) {
      fail("Inventory operation dump was truncated.", { replayPath });
    }
    for (const block of packetDump.blocks ?? []) {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      if (block.channel !== 1 || participantId < 1 || participantId > 10) continue;
      const payload = Buffer.from(block.contentHex, "hex");
      const decodedItemId =
        block.packetType === PROFILE.addPacketType ? decodeAddItemId(payload) : null;
      const isInventoryAdd =
        [14, 15, 16, 17].includes(payload.length) ||
        (payload.length === 11 && TRINKET_ITEM_IDS.has(decodedItemId));
      if (block.packetType === PROFILE.addPacketType && isInventoryAdd) {
        operations.push({
          participantId,
          timestampMillis: block.timestampMillis,
          sourceOffset: block.sourceOffset,
          blockIndex: block.blockIndex,
          family: "add",
          itemId: decodedItemId,
          contentLength: payload.length,
          slot: null,
          operationNibble: null,
        });
      } else if (
        block.packetType === PROFILE.removalPacketType &&
        [6, 7].includes(payload.length)
      ) {
        operations.push({
          participantId,
          timestampMillis: block.timestampMillis,
          sourceOffset: block.sourceOffset,
          blockIndex: block.blockIndex,
          family: "remove",
          itemId: null,
          slot: decodeRemovalSlot(payload),
          operationNibble: payload[0] & 0x0f,
        });
      }
    }
  }
  return operations.sort(
    (left, right) =>
      left.timestampMillis - right.timestampMillis ||
      left.sourceOffset - right.sourceOffset ||
      left.blockIndex - right.blockIndex,
  );
}

function groupOperations(operations) {
  const groups = new Map();
  for (const operation of operations) {
    const key = `${operation.participantId}:${operation.timestampMillis}`;
    const group = groups.get(key) ?? [];
    group.push(operation);
    groups.set(key, group);
  }
  return [...groups.values()].sort(
    (left, right) =>
      left[0].timestampMillis - right[0].timestampMillis ||
      left[0].participantId - right[0].participantId,
  );
}

function nextAddSlot(slots, removedSlots, placement) {
  const availableRemoved = removedSlots.filter((slot) => slots[slot] === 0);
  if (placement === "removedPhysical" && availableRemoved.length > 0) return availableRemoved[0];
  if (placement === "removedReverse" && availableRemoved.length > 0) {
    return availableRemoved.at(-1);
  }
  if (placement === "removedAscending" && availableRemoved.length > 0) {
    return Math.min(...availableRemoved);
  }
  return slots.findIndex((itemId) => itemId === 0);
}

function reduceTrack(operations, candidate) {
  const slots = Array(7).fill(0);
  slots[6] = candidate.initialTrinketItemId;
  let unavailableAddCount = 0;
  let ignoredExistingAddCount = 0;
  let overflowAddCount = 0;
  let occupiedRemovalCount = 0;
  let emptyRemovalCount = 0;
  for (const group of groupOperations(operations)) {
    const adds = group.filter(
      (operation) =>
        operation.family === "add" && candidate.addLengths.includes(operation.contentLength),
    );
    const hasTrinketAdd = adds.some((operation) => TRINKET_ITEM_IDS.has(operation.itemId));
    const removals = group.filter(
      (operation) =>
        operation.family === "remove" &&
        candidate.removalNibbles.includes(operation.operationNibble) &&
        (!candidate.protectTrinketSlot || operation.slot !== 6 || hasTrinketAdd),
    );
    const removedSlots = [];
    for (const removal of removals) {
      if (removal.slot === null) continue;
      if (slots[removal.slot] === 0) emptyRemovalCount += 1;
      else occupiedRemovalCount += 1;
      slots[removal.slot] = 0;
      removedSlots.push(removal.slot);
    }
    for (const add of adds) {
      if (!Number.isInteger(add.itemId) || add.itemId <= 0) {
        unavailableAddCount += 1;
        continue;
      }
      if (candidate.ignoreExisting && slots.includes(add.itemId)) {
        ignoredExistingAddCount += 1;
        continue;
      }
      if (candidate.protectTrinketSlot && TRINKET_ITEM_IDS.has(add.itemId)) {
        slots[6] = add.itemId;
        continue;
      }
      const slot = nextAddSlot(slots, removedSlots, candidate.placement);
      if (slot === -1) {
        overflowAddCount += 1;
        continue;
      }
      slots[slot] = add.itemId;
      const removedIndex = removedSlots.indexOf(slot);
      if (removedIndex !== -1) removedSlots.splice(removedIndex, 1);
    }
  }
  return {
    slots,
    unavailableAddCount,
    ignoredExistingAddCount,
    overflowAddCount,
    occupiedRemovalCount,
    emptyRemovalCount,
  };
}

function sameMultiset(left, right) {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

function symbolicTrack(track, candidate, stateLimit = 50_000) {
  let states = new Map();
  const initial = Array(7).fill(0);
  initial[6] = candidate.initialTrinketItemId;
  states.set(initial.join(","), initial);
  let peakStateCount = 1;
  for (const group of groupOperations(track.operations)) {
    const groupAdds = group.filter(
      (operation) =>
        operation.family === "add" && candidate.addLengths.includes(operation.contentLength),
    );
    const hasTrinketAdd = groupAdds.some((operation) => TRINKET_ITEM_IDS.has(operation.itemId));
    const removals = group.filter(
      (operation) =>
        operation.family === "remove" &&
        candidate.removalNibbles.includes(operation.operationNibble) &&
        (!candidate.protectTrinketSlot || operation.slot !== 6 || hasTrinketAdd),
    );
    const adds = groupAdds;
    const nextStates = new Map();
    for (const slots of states.values()) {
      let groupStates = [[...slots]];
      for (const removal of removals) {
        if (removal.slot === null) continue;
        const removed = new Map();
        for (const state of groupStates) {
          const candidateSlots =
            candidate.branchMainRemovals && removal.slot < 6
              ? [removal.slot, ...state.slice(0, 6).flatMap((itemId, slot) => (itemId ? [slot] : []))]
              : [removal.slot];
          for (const slot of new Set(candidateSlots)) {
            const next = [...state];
            next[slot] = 0;
            removed.set(next.join(","), next);
          }
        }
        groupStates = [...removed.values()];
      }
      for (const add of adds) {
        if (!Number.isInteger(add.itemId) || add.itemId <= 0) continue;
        const expanded = [];
        for (const state of groupStates) {
          if (TRINKET_ITEM_IDS.has(add.itemId)) {
            const next = [...state];
            next[6] = add.itemId;
            expanded.push(next);
            continue;
          }
          for (let slot = 0; slot < 6; slot += 1) {
            if (state[slot] !== 0) continue;
            const next = [...state];
            next[slot] = add.itemId;
            expanded.push(next);
          }
          if (candidate.allowExistingUpdate && state.includes(add.itemId)) {
            expanded.push(state);
          }
          if (candidate.allowFullInventoryUpdate && state.slice(0, 6).every(Boolean)) {
            expanded.push(state);
          }
        }
        groupStates = expanded;
        if (groupStates.length === 0) break;
      }
      for (const state of groupStates) nextStates.set(state.join(","), state);
      if (nextStates.size > stateLimit) {
        return { exact: false, overflowed: true, peakStateCount: nextStates.size };
      }
    }
    if (nextStates.size === 0) {
      return { exact: false, overflowed: false, peakStateCount };
    }
    states = nextStates;
    peakStateCount = Math.max(peakStateCount, states.size);
  }
  return {
    exact: states.has(track.finalSlots.join(",")),
    overflowed: false,
    peakStateCount,
    finalCandidateCount: states.size,
  };
}

function scoreSymbolicTracks(tracks, candidate) {
  const rows = tracks.map((track) => ({
    replayId: track.replayId,
    participantId: track.participantId,
    ...symbolicTrack(track, candidate),
  }));
  return {
    trackCount: rows.length,
    exactTrackCount: rows.filter((row) => row.exact).length,
    overflowedTrackCount: rows.filter((row) => row.overflowed).length,
    maxPeakStateCount: Math.max(...rows.map((row) => row.peakStateCount)),
    rows,
  };
}

function symbolicSummary(score) {
  return {
    trackCount: score.trackCount,
    exactTrackCount: score.exactTrackCount,
    overflowedTrackCount: score.overflowedTrackCount,
    maxPeakStateCount: score.maxPeakStateCount,
  };
}

function scoreTracks(tracks, candidate) {
  const rows = tracks.map((track) => {
    const reduced = reduceTrack(track.operations, candidate);
    return {
      replayId: track.replayId,
      participantId: track.participantId,
      expected: track.finalSlots,
      ...reduced,
      exactSlots: JSON.stringify(reduced.slots) === JSON.stringify(track.finalSlots),
      exactMultiset: sameMultiset(reduced.slots, track.finalSlots),
    };
  });
  return {
    trackCount: rows.length,
    exactSlotTrackCount: rows.filter((row) => row.exactSlots).length,
    exactMultisetTrackCount: rows.filter((row) => row.exactMultiset).length,
    exactSlotCellCount: rows.reduce(
      (sum, row) =>
        sum + row.slots.filter((itemId, slot) => itemId === row.expected[slot]).length,
      0,
    ),
    exactMainSlotCellCount: rows.reduce(
      (sum, row) =>
        sum + row.slots.slice(0, 6).filter((itemId, slot) => itemId === row.expected[slot]).length,
      0,
    ),
    exactTrinketSlotCount: rows.filter((row) => row.slots[6] === row.expected[6]).length,
    unavailableAddCount: rows.reduce((sum, row) => sum + row.unavailableAddCount, 0),
    ignoredExistingAddCount: rows.reduce((sum, row) => sum + row.ignoredExistingAddCount, 0),
    overflowAddCount: rows.reduce((sum, row) => sum + row.overflowAddCount, 0),
    occupiedRemovalCount: rows.reduce((sum, row) => sum + row.occupiedRemovalCount, 0),
    emptyRemovalCount: rows.reduce((sum, row) => sum + row.emptyRemovalCount, 0),
    rows,
  };
}

function main() {
  const args = parseArgs(process.argv);
  for (const required of [args.cliPath, args.replayDir, args.decoderProfilesPath]) {
    if (!fs.existsSync(required)) fail("Required input is missing.", required);
  }
  const tracks = [];
  const inputs = [];
  for (const [replayId, partition] of PROFILE.fixtures) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    const finalSlots = loadFinalSlots(args, replayPath);
    const operations = dumpOperations(args, replayPath);
    inputs.push({ replayId, partition, operationCount: operations.length });
    for (let participantId = 1; participantId <= 10; participantId += 1) {
      tracks.push({
        replayId,
        partition,
        participantId,
        finalSlots: finalSlots[participantId - 1],
        operations: operations.filter((operation) => operation.participantId === participantId),
      });
    }
  }
  const candidates = [];
  for (const addLengths of [[14, 15], [11, 14, 15], [11, 14, 15, 16, 17]]) {
    for (const initialTrinketItemId of [0, 3340]) {
      for (const removalNibbles of [[2, 5, 13], [5, 13], [2, 5], [5]]) {
        for (const ignoreExisting of [false, true]) {
          for (const protectTrinketSlot of [false, true]) {
            for (const placement of [
              "lowestEmpty",
              "removedPhysical",
              "removedReverse",
              "removedAscending",
            ]) {
              const candidate = {
                addLengths,
                initialTrinketItemId,
                removalNibbles,
                placement,
                ignoreExisting,
                protectTrinketSlot,
              };
              const discovery = scoreTracks(
                tracks.filter((track) => track.partition === "D7"),
                candidate,
              );
              candidates.push({
                ...candidate,
                discovery: { ...discovery, rows: undefined },
              });
            }
          }
        }
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.discovery.exactSlotTrackCount - left.discovery.exactSlotTrackCount ||
      right.discovery.exactMultisetTrackCount - left.discovery.exactMultisetTrackCount ||
      right.discovery.exactSlotCellCount - left.discovery.exactSlotCellCount ||
      left.discovery.overflowAddCount - right.discovery.overflowAddCount ||
      left.placement.localeCompare(right.placement),
  );
  const evaluatedCandidates = candidates.map((candidate) => ({
    ...candidate,
    holdout: {
      ...scoreTracks(
        tracks.filter((track) => track.partition === "H3"),
        candidate,
      ),
      rows: undefined,
    },
  }));
  const best = evaluatedCandidates[0];
  if (JSON.stringify(best) !== JSON.stringify(EXPECTED_BEST)) {
    fail("Frozen forward reducer metrics drifted.", { expected: EXPECTED_BEST, actual: best });
  }
  const replayOnlyCandidate = evaluatedCandidates.find(
    (candidate) =>
      candidate.initialTrinketItemId === 0 &&
      candidate.addLengths.join(",") === "11,14,15,16,17" &&
      candidate.removalNibbles.join(",") === "5,13" &&
      candidate.placement === "lowestEmpty" &&
      candidate.ignoreExisting === false &&
      candidate.protectTrinketSlot === true,
  );
  if (JSON.stringify(replayOnlyCandidate) !== JSON.stringify(EXPECTED_REPLAY_ONLY)) {
    fail("Frozen replay-only forward reducer metrics drifted.", {
      expected: EXPECTED_REPLAY_ONLY,
      actual: replayOnlyCandidate,
    });
  }
  const symbolicCandidate = {
    ...best,
    allowExistingUpdate: true,
    allowFullInventoryUpdate: true,
    branchMainRemovals: false,
  };
  const symbolicFinalAnchor = {
    discovery: scoreSymbolicTracks(
      tracks.filter((track) => track.partition === "D7"),
      symbolicCandidate,
    ),
    holdout: scoreSymbolicTracks(
      tracks.filter((track) => track.partition === "H3"),
      symbolicCandidate,
    ),
  };
  const symbolicMetrics = {
    discovery: symbolicSummary(symbolicFinalAnchor.discovery),
    holdout: symbolicSummary(symbolicFinalAnchor.holdout),
  };
  if (JSON.stringify(symbolicMetrics) !== JSON.stringify(EXPECTED_SYMBOLIC)) {
    fail("Frozen symbolic final-anchor metrics drifted.", {
      expected: EXPECTED_SYMBOLIC,
      actual: symbolicMetrics,
    });
  }
  const output = {
    schema: "rofl-inventory-forward-slot-reducer-research-16.14/v2",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayOnlyInputs: [
      "Champion-owned 0x0369 length-14/15/16/17 add packets plus length-11 packets restricted to decoded trinket identities, all using the frozen 13-bit item grammar",
      "Champion-owned 0x03F9 length-6/7 removal packets with the seven-value slot candidate",
      "Replay-embedded validated final seven-slot inventory for evaluation only",
    ],
    inputs,
    boundedCandidates: evaluatedCandidates,
    bestCandidate: {
      ...best,
      combinedRows: scoreTracks(tracks, best).rows,
    },
    provisionalInitialTrinketAssumption:
      "The overall best candidate seeds item 3340 in slot 6. This is a static gameplay assumption, not replay-native state, and cannot be promoted.",
    replayOnlyCandidate,
    symbolicFinalAnchor,
    conclusion:
      "Expanded 0x0369 coverage and trinket handling materially improve final-state reconstruction but do not close the inventory grammar. Without a fabricated initial trinket, the deterministic replay-only candidate exactly reconstructs 9/70 D7 and 5/30 H3 slot tracks. A symbolic add-placement solver reaches 23/70 D7 and 13/30 H3 final anchors, but one D7 track exceeds 50,000 states and no replay-native initial trinket or unique timeline slot history is available.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ best: { ...best } }, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
