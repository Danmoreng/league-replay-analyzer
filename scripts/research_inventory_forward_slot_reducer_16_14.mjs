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
  removalNibbles: Object.freeze([2, 5, 13]),
  placement: "removedPhysical",
  discovery: Object.freeze({
    trackCount: 70,
    exactSlotTrackCount: 0,
    exactMultisetTrackCount: 0,
    unavailableAddCount: 0,
    overflowAddCount: 84,
    occupiedRemovalCount: 1071,
    emptyRemovalCount: 222,
  }),
  holdout: Object.freeze({
    trackCount: 30,
    exactSlotTrackCount: 0,
    exactMultisetTrackCount: 0,
    unavailableAddCount: 0,
    overflowAddCount: 88,
    occupiedRemovalCount: 670,
    emptyRemovalCount: 111,
  }),
});

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
      if (block.packetType === PROFILE.addPacketType && [14, 15].includes(payload.length)) {
        operations.push({
          participantId,
          timestampMillis: block.timestampMillis,
          sourceOffset: block.sourceOffset,
          blockIndex: block.blockIndex,
          family: "add",
          itemId: decodeAddItemId(payload),
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
  let unavailableAddCount = 0;
  let overflowAddCount = 0;
  let occupiedRemovalCount = 0;
  let emptyRemovalCount = 0;
  for (const group of groupOperations(operations)) {
    const removals = group.filter(
      (operation) =>
        operation.family === "remove" &&
        candidate.removalNibbles.includes(operation.operationNibble),
    );
    const adds = group.filter((operation) => operation.family === "add");
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
  return { slots, unavailableAddCount, overflowAddCount, occupiedRemovalCount, emptyRemovalCount };
}

function sameMultiset(left, right) {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
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
    unavailableAddCount: rows.reduce((sum, row) => sum + row.unavailableAddCount, 0),
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
  for (const removalNibbles of [[2, 5, 13], [5, 13], [5]]) {
    for (const placement of [
      "lowestEmpty",
      "removedPhysical",
      "removedReverse",
      "removedAscending",
    ]) {
      const candidate = { removalNibbles, placement };
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
  candidates.sort(
    (left, right) =>
      right.discovery.exactSlotTrackCount - left.discovery.exactSlotTrackCount ||
      right.discovery.exactMultisetTrackCount - left.discovery.exactMultisetTrackCount ||
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
  const output = {
    schema: "rofl-inventory-forward-slot-reducer-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayOnlyInputs: [
      "Champion-owned 0x0369 length-14/15 add packets with the frozen 13-bit item grammar",
      "Champion-owned 0x03F9 length-6/7 removal packets with the seven-value slot candidate",
      "Replay-embedded validated final seven-slot inventory for evaluation only",
    ],
    inputs,
    boundedCandidates: evaluatedCandidates,
    bestCandidate: {
      ...best,
      combinedRows: scoreTracks(tracks, best).rows,
    },
    conclusion:
      "A deterministic forward reducer over the known add identity and removal-slot candidates does not reconstruct complete final inventories. The scored variants bound the simple remove/add placement rules before a stateful operation grammar is attempted.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ best: { ...best } }, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
