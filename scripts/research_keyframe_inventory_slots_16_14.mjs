#!/usr/bin/env node

// Offline research only. Saved Match and Timeline fixtures are validation
// labels and are never runtime inputs. Candidate bytes and ordering always come
// from exact-build keyframe 0x0081 payloads in the saved ROFL corpus.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x0081,
  addPacketType: 0x0369,
  inventoryOperationPacketTypes: Object.freeze([0x0369, 0x03f9, 0x0146, 0x0081]),
  championOwnerBase: 0x400000ad,
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
  additionalInventoryItemIds: Object.freeze([2422, 3040, 3042, 3121]),
});

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    keyframeBlockCount: 2170,
    completeSixRecordBlockCount: 2170,
    exactMultisetSnapshotCount: 1219,
    decodedSubsetSnapshotCount: 1495,
    falseExtraItemSnapshotCount: 675,
  }),
  holdout: Object.freeze({
    keyframeBlockCount: 1030,
    completeSixRecordBlockCount: 1030,
    exactMultisetSnapshotCount: 513,
    decodedSubsetSnapshotCount: 656,
    falseExtraItemSnapshotCount: 374,
  }),
});

const EXPECTED_ADD_SLOT_CANDIDATES = Object.freeze({
  discoveryCount: 126,
  holdoutCount: 55,
  discoverySlots: Object.freeze({ 0: 3, 1: 15, 2: 18, 3: 21, 4: 31, 5: 38 }),
  holdoutSlots: Object.freeze({ 0: 2, 1: 5, 2: 14, 3: 10, 4: 12, 5: 12 }),
  discoveryContiguousLookupCandidateCount: 0,
});

const EXPECTED_REARRANGEMENT_CANDIDATES = Object.freeze({
  discoveryCount: 12,
  holdoutCount: 9,
});

const EXPECTED_TIMELINE_ALIGNMENT_METRICS = Object.freeze({
  discovery: Object.freeze({
    "-2": Object.freeze({ exact: 789, subset: 1031 }),
    "-1": Object.freeze({ exact: 1219, subset: 1495 }),
    0: Object.freeze({ exact: 642, subset: 1121 }),
    1: Object.freeze({ exact: 226, subset: 849 }),
    2: Object.freeze({ exact: 89, subset: 678 }),
  }),
  holdout: Object.freeze({
    "-2": Object.freeze({ exact: 322, subset: 438 }),
    "-1": Object.freeze({ exact: 513, subset: 656 }),
    0: Object.freeze({ exact: 276, subset: 493 }),
    1: Object.freeze({ exact: 104, subset: 369 }),
    2: Object.freeze({ exact: 46, subset: 283 }),
  }),
});

const EXPECTED_FALSE_EXTRA_METRICS = Object.freeze({
  discovery: Object.freeze({ occurrences: 804, removed: 160, acquired: 1, absent: 643 }),
  holdout: Object.freeze({ occurrences: 532, removed: 218, acquired: 0, absent: 314 }),
});

const EXPECTED_FINAL_SUFFIX_METRICS = Object.freeze({
  discovery: Object.freeze({ mismatchWithReplayOperations: 23, mismatchWithout: 1 }),
  holdout: Object.freeze({ mismatchWithReplayOperations: 11, mismatchWithout: 1 }),
});

const EXPECTED_RECORD_ACTIVITY_METRICS = Object.freeze({
  discovery: Object.freeze({ rowCount: 8137, activeCount: 7978, inactiveCount: 159 }),
  holdout: Object.freeze({ rowCount: 4014, activeCount: 3796, inactiveCount: 218 }),
  affineBitSearch: Object.freeze({
    minimumBitCount: 104,
    candidateCount: 0,
    zeroWrongHoldoutCandidateCount: 0,
  }),
  contiguousLookupSearch: Object.freeze({
    candidateCount: 0,
    zeroWrongHoldoutCandidateCount: 0,
  }),
});

const EXPECTED_RECORD_ACTIVITY_CONTEXT_METRICS = Object.freeze({
  discovery: Object.freeze({ conflictedKeyCount: 49, minorityErrorFloor: 51 }),
  holdout: Object.freeze({ conflictedKeyCount: 28, minorityErrorFloor: 30 }),
  combined: Object.freeze({ conflictedKeyCount: 115, minorityErrorFloor: 135 }),
  transitions: Object.freeze({
    count: 34,
    activeToInactiveCount: 33,
    inactiveToActiveCount: 1,
    prefixChangedCount: 34,
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
    outputPath: path.join("tmp", "keyframe-inventory-slots-research-16.14.json"),
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
        "Usage: node scripts/research_keyframe_inventory_slots_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]",
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

function inputCode(payload, bits) {
  return bits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

// This is the independently validated 16.14 0x0369 item-ID grammar. Applying
// it to adjacent bytes here tests whether the keyframe family reuses the same
// structural item symbol. The two unseen input symbols remain fail-closed.
function decodeItemPair(first, second) {
  const payload = Buffer.alloc(10);
  payload[8] = first;
  payload[9] = second;
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

function dumpPacketType(args, replayPath, packetType, segmentType) {
  const run = spawnSync(
    args.cliPath,
    [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      String(packetType),
      "--segment-type",
      segmentType,
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    fail("Native packet dump failed.", { replayPath, stderr: run.stderr });
  }
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.gameVersion !== PROFILE.exactReplayBuild
  ) {
    fail("Exact packet framing/version gate failed.", { replayPath, packetType, segmentType });
  }
  return dump.blocks ?? [];
}

function dumpKeyframeInventory(args, replayPath) {
  return dumpPacketType(args, replayPath, PROFILE.packetType, "keyframe");
}

function itemEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter(
      (event) =>
        ["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type) &&
        Number.isInteger(event.participantId) &&
        Number.isInteger(event.timestamp),
    );
}

function positionsFor(payload, itemId) {
  const positions = [];
  for (let position = 0; position + 1 < payload.length; position += 1) {
    if (decodeItemPair(payload[position], payload[position + 1]) === itemId) {
      positions.push(position);
    }
  }
  return positions;
}

function mainInventoryRecordStarts(payload) {
  const candidates = [];
  for (let position = 0; position + 3 < payload.length; position += 1) {
    if (
      (payload[position] === 0xc0 || payload[position] === 0xc3) &&
      payload[position + 3] === 0xe6
    ) {
      candidates.push(position);
    }
  }
  return candidates.slice(-6);
}

function loadInventoryItemIds(args) {
  const registry = readJson(path.resolve(args.decoderProfilesPath));
  const selected = (registry.profiles ?? []).filter(
    (entry) =>
      entry.versionGroup === "16.14" &&
      (entry.acceptedGameVersions ?? []).includes(PROFILE.exactReplayBuild),
  );
  const itemIds = selected[0]?.inventoryDirectPurchaseSubset?.staticItemCatalog?.realItemIds;
  if (
    selected.length !== 1 ||
    !Array.isArray(itemIds) ||
    itemIds.some((itemId) => !Number.isInteger(itemId) || itemId <= 0)
  ) {
    fail("Canonical exact-build static item catalog gate failed.");
  }
  return new Set([...itemIds, ...PROFILE.additionalInventoryItemIds]);
}

function decodeMainInventoryRecord(payload, record, inventoryItemIds) {
  const offsets =
    record.contentLength >= 13 && record.contentLength <= 15
      ? [7]
      : record.contentLength === 16
        ? [7, 8]
        : record.contentLength >= 21 && record.contentLength <= 23
          ? [15]
          : [];
  const candidates = [
    ...new Set(
      offsets
        .filter((offset) => record.start + offset + 1 < record.end)
        .map((offset) =>
          decodeItemPair(payload[record.start + offset], payload[record.start + offset + 1]),
        )
        .filter((itemId) => inventoryItemIds.has(itemId)),
    ),
  ];
  return candidates.length === 1 ? candidates[0] : null;
}

function decodeMainSlots(payload, inventoryItemIds) {
  const recordStarts = mainInventoryRecordStarts(payload);
  const records = recordStarts.map((start, ordinal) => {
    const end = recordStarts[ordinal + 1] ?? payload.length;
    return {
      start,
      end,
      slot: 5 - ordinal,
      contentLength: end - start,
      prefixHex: payload.subarray(start, Math.min(end, start + 8)).toString("hex"),
      payloadHex: payload.subarray(start, end).toString("hex"),
    };
  });
  const decodedMainSlots = Array(6).fill(0);
  for (const record of records) {
    decodedMainSlots[record.slot] =
      decodeMainInventoryRecord(payload, record, inventoryItemIds) ?? 0;
  }
  return { recordStarts, records, decodedMainSlots };
}

function removeOne(items, itemId) {
  const index = items.indexOf(itemId);
  if (index !== -1) items.splice(index, 1);
}

function applyItemEvent(items, event) {
  if (event.type === "ITEM_PURCHASED" && Number.isInteger(event.itemId)) {
    items.push(event.itemId);
  } else if (
    (event.type === "ITEM_DESTROYED" || event.type === "ITEM_SOLD") &&
    Number.isInteger(event.itemId)
  ) {
    removeOne(items, event.itemId);
  } else if (event.type === "ITEM_UNDO") {
    if (Number.isInteger(event.beforeId) && event.beforeId !== 0) removeOne(items, event.beforeId);
    if (Number.isInteger(event.afterId) && event.afterId !== 0) items.push(event.afterId);
  }
}

function isMultisetSubset(subset, superset) {
  const remaining = [...superset];
  for (const itemId of subset) {
    const index = remaining.indexOf(itemId);
    if (index === -1) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function sameMultiset(left, right) {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

function multisetDifference(left, right) {
  const remaining = [...right];
  return left.filter((itemId) => {
    const index = remaining.indexOf(itemId);
    if (index === -1) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function latestLabelledItemAction(events, itemId, cutoffTimestampMillis) {
  let latest = null;
  for (const event of events) {
    if (event.timestamp > cutoffTimestampMillis + 1) break;
    let action = null;
    if (event.type === "ITEM_PURCHASED" && event.itemId === itemId) action = "acquire";
    else if (
      (event.type === "ITEM_DESTROYED" || event.type === "ITEM_SOLD") &&
      event.itemId === itemId
    ) {
      action = "remove";
    } else if (event.type === "ITEM_UNDO" && event.afterId === itemId) action = "acquire";
    else if (event.type === "ITEM_UNDO" && event.beforeId === itemId) action = "remove";
    if (action !== null) latest = { action, timestampMillis: event.timestamp };
  }
  return latest;
}

function emptyTimelineStateValidation() {
  return {
    snapshotCount: 0,
    exactMultisetSnapshotCount: 0,
    decodedSubsetSnapshotCount: 0,
    falseExtraItemSnapshotCount: 0,
  };
}

function validateDecodedInventory(decodedMainSlots, labelledInventory, validation) {
  const decodedInventory = decodedMainSlots.filter((itemId) => itemId !== 0);
  validation.snapshotCount += 1;
  if (sameMultiset(decodedInventory, labelledInventory)) {
    validation.exactMultisetSnapshotCount += 1;
  }
  if (isMultisetSubset(decodedInventory, labelledInventory)) {
    validation.decodedSubsetSnapshotCount += 1;
  } else {
    validation.falseExtraItemSnapshotCount += 1;
  }
}

function countOrderedEmbeddings(positionDomains, limit = 2) {
  let states = new Map([[-1, 1]]);
  for (const positions of positionDomains) {
    const next = new Map();
    for (const [previous, count] of states) {
      for (const position of positions) {
        if (position <= previous) continue;
        next.set(position, Math.min(limit, (next.get(position) ?? 0) + count));
      }
    }
    states = next;
  }
  return Math.min(
    limit,
    [...states.values()].reduce((sum, count) => sum + count, 0),
  );
}

function countsBySlot(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.slot, (counts.get(row.slot) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left - right));
}

function contiguousSlotLookupCandidateCount(rows) {
  let candidateCount = 0;
  for (let width = 1; width <= 8; width += 1) {
    for (let start = 0; start + width <= 112; start += 1) {
      for (const reversed of [false, true]) {
        const slotsByValue = new Map();
        let conflict = false;
        for (const row of rows) {
          const payload = Buffer.from(row.addPacket.payloadHex, "hex");
          let value = 0;
          for (let index = 0; index < width; index += 1) {
            const outputBit = reversed ? width - 1 - index : index;
            value |= payloadBit(payload, start + index) << outputBit;
          }
          const previous = slotsByValue.get(value);
          if (previous !== undefined && previous !== row.slot) {
            conflict = true;
            break;
          }
          slotsByValue.set(value, row.slot);
        }
        if (!conflict) candidateCount += 1;
      }
    }
  }
  return candidateCount;
}

function earliestOrderedEmbedding(positionDomains) {
  const selected = [];
  let previous = -1;
  for (const positions of positionDomains) {
    const position = positions.find((candidate) => candidate > previous);
    if (position === undefined) return null;
    selected.push(position);
    previous = position;
  }
  return selected;
}

function inspectReplay(args, replayId, partition, inventoryItemIds) {
  const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
  const fixtureRoot = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
  const matchPath = path.join(fixtureRoot, "match.json");
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  if (![replayPath, matchPath, timelinePath].every(fs.existsSync)) {
    fail("Fixed replay/API fixture is missing.", { replayId, replayPath, matchPath, timelinePath });
  }
  const match = readJson(matchPath);
  const timeline = readJson(timelinePath);
  if (
    match.info?.gameVersion !== PROFILE.exactReplayBuild ||
    !Array.isArray(match.info?.participants) ||
    match.info.participants.length !== 10
  ) {
    fail("Match fixture exact-build/participant gate failed.", { replayId });
  }

  const lastByParticipant = new Map();
  const blocksByParticipant = new Map();
  const ownersBySegment = new Map();
  let keyframeBlockCount = 0;
  let completeSixRecordBlockCount = 0;
  for (const block of dumpKeyframeInventory(args, replayPath)) {
    const participantId = block.blockParam - PROFILE.championOwnerBase;
    if (
      block.channel !== 1 ||
      !Number.isInteger(participantId) ||
      participantId < 1 ||
      participantId > 10 ||
      block.contentHexTruncated !== false ||
      block.contentHexBytes !== block.contentLength ||
      typeof block.contentHex !== "string"
    ) {
      fail("Keyframe inventory owner/payload provenance gate failed.", { replayId, block });
    }
    const owners = ownersBySegment.get(block.segmentId) ?? new Set();
    if (owners.has(participantId)) fail("Duplicate participant 0x0081 block in a keyframe.");
    owners.add(participantId);
    ownersBySegment.set(block.segmentId, owners);
    keyframeBlockCount += 1;
    if (mainInventoryRecordStarts(Buffer.from(block.contentHex, "hex")).length === 6) {
      completeSixRecordBlockCount += 1;
    }
    const participantBlocks = blocksByParticipant.get(participantId) ?? [];
    participantBlocks.push(block);
    blocksByParticipant.set(participantId, participantBlocks);
    const previous = lastByParticipant.get(participantId);
    if (
      previous === undefined ||
      block.segmentId > previous.segmentId ||
      (block.segmentId === previous.segmentId && block.blockIndex > previous.blockIndex)
    ) {
      lastByParticipant.set(participantId, block);
    }
  }
  if (
    lastByParticipant.size !== 10 ||
    [...ownersBySegment.values()].some((owners) => owners.size !== 10)
  ) {
    fail("Keyframe inventory participant completeness gate failed.", { replayId });
  }

  const events = itemEvents(timeline);
  const addPackets = dumpPacketType(args, replayPath, PROFILE.addPacketType, "chunk")
    .filter((block) => block.channel === 1 && [14, 15].includes(block.contentLength))
    .map((block) => {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      const payload = Buffer.from(block.contentHex, "hex");
      return {
        participantId,
        timestampMillis: block.timestampMillis,
        segmentId: block.segmentId,
        sourceOffset: block.sourceOffset,
        contentLength: block.contentLength,
        payloadHex: block.contentHex,
        itemId: decodeItemPair(payload[8], payload[9]),
      };
    })
    .filter((row) => row.participantId >= 1 && row.participantId <= 10);
  const inventoryOperationPackets = PROFILE.inventoryOperationPacketTypes.flatMap((packetType) =>
    dumpPacketType(args, replayPath, packetType, "chunk")
      .map((block) => ({
        participantId: block.blockParam - PROFILE.championOwnerBase,
        timestampMillis: block.timestampMillis,
        packetType,
        contentLength: block.contentLength,
      }))
      .filter((row) => row.participantId >= 1 && row.participantId <= 10),
  );
  const strictAddSlotRows = [];
  const rearrangementCandidateRows = [];
  const recordActivityRows = [];
  const timelineStateValidation = {
    ...emptyTimelineStateValidation(),
    falseExtraSamples: [],
  };
  const timelineAlignmentValidation = Object.fromEntries(
    [-2, -1, 0, 1, 2].map((blockOffset) => [String(blockOffset), emptyTimelineStateValidation()]),
  );
  const falseExtraDiagnostics = {
    occurrenceCount: 0,
    latestLabelledActionRemovedCount: 0,
    latestLabelledActionAcquiredCount: 0,
    noPriorLabelledIdentityActionCount: 0,
    byItemId: {},
    byChampionName: {},
    samples: [],
  };
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const participantEvents = events
      .filter((event) => event.participantId === participantId)
      .sort((left, right) => left.timestamp - right.timestamp);
    const inventory = [];
    let eventIndex = 0;
    const participantBlocks = blocksByParticipant
      .get(participantId)
      .sort(
        (left, right) => left.segmentId - right.segmentId || left.blockIndex - right.blockIndex,
      );
    const participantSnapshots = [];
    for (let blockIndex = 0; blockIndex < participantBlocks.length; blockIndex += 1) {
      const block = participantBlocks[blockIndex];
      const stateTimestampMillis =
        participantBlocks[blockIndex - 1]?.timestampMillis ?? block.timestampMillis;
      while (
        eventIndex < participantEvents.length &&
        participantEvents[eventIndex].timestamp <= stateTimestampMillis + 1
      ) {
        applyItemEvent(inventory, participantEvents[eventIndex]);
        eventIndex += 1;
      }
      const labelledInventory = inventory.filter((itemId) => inventoryItemIds.has(itemId));
      const decoded = decodeMainSlots(Buffer.from(block.contentHex, "hex"), inventoryItemIds);
      const decodedMainSlots = decoded.decodedMainSlots;
      const decodedInventory = decodedMainSlots.filter((itemId) => itemId !== 0);
      for (const record of decoded.records) {
        const itemId = decodedMainSlots[record.slot];
        if (itemId === 0) continue;
        const decodedCount = decodedInventory.filter((candidate) => candidate === itemId).length;
        const labelledCount = labelledInventory.filter((candidate) => candidate === itemId).length;
        const latestAction = latestLabelledItemAction(
          participantEvents,
          itemId,
          stateTimestampMillis,
        );
        const active = labelledCount >= decodedCount ? true : null;
        const labelledActive =
          active === true
            ? true
            : labelledCount === 0 && latestAction?.action === "remove"
              ? false
              : null;
        if (labelledActive === null) continue;
        recordActivityRows.push({
          replayId,
          partition,
          participantId,
          segmentId: block.segmentId,
          blockTimestampMillis: block.timestampMillis,
          stateTimestampMillis,
          recordOrdinal: 5 - record.slot,
          itemId,
          contentLength: record.contentLength,
          payloadHex: record.payloadHex,
          componentPrefixHex: Buffer.from(block.contentHex, "hex")
            .subarray(0, decoded.recordStarts[0])
            .toString("hex"),
          siblingPayloadHexes: decoded.records.map((candidate) => candidate.payloadHex),
          componentPayloadHex: block.contentHex,
          active: labelledActive,
        });
      }
      participantSnapshots.push({
        stateTimestampMillis,
        blockTimestampMillis: block.timestampMillis,
        decodedMainSlots,
      });
      const decodedSubset = isMultisetSubset(decodedInventory, labelledInventory);
      timelineStateValidation.snapshotCount += 1;
      if (sameMultiset(decodedInventory, labelledInventory)) {
        timelineStateValidation.exactMultisetSnapshotCount += 1;
      }
      if (decodedSubset) timelineStateValidation.decodedSubsetSnapshotCount += 1;
      else {
        timelineStateValidation.falseExtraItemSnapshotCount += 1;
        const extraItems = multisetDifference(decodedInventory, labelledInventory);
        const championName = match.info.participants[participantId - 1].championName;
        for (const itemId of extraItems) {
          falseExtraDiagnostics.occurrenceCount += 1;
          falseExtraDiagnostics.byItemId[itemId] =
            (falseExtraDiagnostics.byItemId[itemId] ?? 0) + 1;
          falseExtraDiagnostics.byChampionName[championName] =
            (falseExtraDiagnostics.byChampionName[championName] ?? 0) + 1;
          const latestAction = latestLabelledItemAction(
            participantEvents,
            itemId,
            stateTimestampMillis,
          );
          if (latestAction?.action === "remove") {
            falseExtraDiagnostics.latestLabelledActionRemovedCount += 1;
          } else if (latestAction?.action === "acquire") {
            falseExtraDiagnostics.latestLabelledActionAcquiredCount += 1;
          } else {
            falseExtraDiagnostics.noPriorLabelledIdentityActionCount += 1;
          }
          if (falseExtraDiagnostics.samples.length < 12) {
            falseExtraDiagnostics.samples.push({
              participantId,
              championName,
              timestampMillis: block.timestampMillis,
              stateTimestampMillis,
              itemId,
              latestLabelledAction: latestAction,
            });
          }
        }
        if (timelineStateValidation.falseExtraSamples.length < 8) {
          timelineStateValidation.falseExtraSamples.push({
            participantId,
            timestampMillis: block.timestampMillis,
            stateTimestampMillis,
            labelledInventory,
            decodedInventory,
          });
        }
      }
    }
    for (const [blockOffsetText, validation] of Object.entries(timelineAlignmentValidation)) {
      const blockOffset = Number(blockOffsetText);
      const alignedInventory = [];
      let alignedEventIndex = 0;
      for (let snapshotIndex = 0; snapshotIndex < participantSnapshots.length; snapshotIndex += 1) {
        const alignedBlockIndex = Math.max(
          0,
          Math.min(participantBlocks.length - 1, snapshotIndex + blockOffset),
        );
        const cutoffTimestampMillis = participantBlocks[alignedBlockIndex].timestampMillis;
        while (
          alignedEventIndex < participantEvents.length &&
          participantEvents[alignedEventIndex].timestamp <= cutoffTimestampMillis + 1
        ) {
          applyItemEvent(alignedInventory, participantEvents[alignedEventIndex]);
          alignedEventIndex += 1;
        }
        validateDecodedInventory(
          participantSnapshots[snapshotIndex].decodedMainSlots,
          alignedInventory.filter((itemId) => inventoryItemIds.has(itemId)),
          validation,
        );
      }
    }
    for (let index = 1; index < participantSnapshots.length; index += 1) {
      const previous = participantSnapshots[index - 1];
      const current = participantSnapshots[index];
      if (current.stateTimestampMillis <= previous.stateTimestampMillis) continue;
      const changedSlots = current.decodedMainSlots
        .map((itemId, slot) => ({ slot, beforeItemId: previous.decodedMainSlots[slot], itemId }))
        .filter((entry) => entry.itemId !== entry.beforeItemId);
      const intervalAdds = addPackets.filter(
        (packet) =>
          packet.participantId === participantId &&
          packet.timestampMillis > previous.stateTimestampMillis + 1 &&
          packet.timestampMillis <= current.stateTimestampMillis + 1,
      );
      const intervalEvents = participantEvents.filter(
        (event) =>
          event.timestamp > previous.stateTimestampMillis + 1 &&
          event.timestamp <= current.stateTimestampMillis + 1,
      );
      const previousMultiset = [...previous.decodedMainSlots].sort((left, right) => left - right);
      const currentMultiset = [...current.decodedMainSlots].sort((left, right) => left - right);
      if (
        intervalEvents.length === 0 &&
        changedSlots.length >= 2 &&
        previousMultiset.some((itemId) => itemId !== 0) &&
        previousMultiset.every((itemId, itemIndex) => itemId === currentMultiset[itemIndex])
      ) {
        rearrangementCandidateRows.push({
          replayId,
          partition,
          participantId,
          intervalStartMillis: previous.stateTimestampMillis,
          intervalEndMillis: current.stateTimestampMillis,
          beforeSlots: previous.decodedMainSlots,
          afterSlots: current.decodedMainSlots,
          changedSlots,
        });
      }
      if (
        changedSlots.length === 1 &&
        changedSlots[0].itemId !== 0 &&
        intervalAdds.length === 1 &&
        intervalAdds[0].itemId === changedSlots[0].itemId &&
        intervalEvents.length === 1 &&
        intervalEvents[0].type === "ITEM_PURCHASED" &&
        intervalEvents[0].itemId === changedSlots[0].itemId
      ) {
        strictAddSlotRows.push({
          replayId,
          partition,
          participantId,
          intervalStartMillis: previous.stateTimestampMillis,
          intervalEndMillis: current.stateTimestampMillis,
          ...changedSlots[0],
          addPacket: intervalAdds[0],
        });
      }
    }
  }
  const tracks = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const block = lastByParticipant.get(participantId);
    const participantBlocks = blocksByParticipant
      .get(participantId)
      .sort(
        (left, right) => left.segmentId - right.segmentId || left.blockIndex - right.blockIndex,
      );
    const lastStateTimestampMillis =
      participantBlocks.at(-2)?.timestampMillis ?? participantBlocks.at(-1).timestampMillis;
    const participant = match.info.participants[participantId - 1];
    const slots = Array.from({ length: 7 }, (_, slot) => participant[`item${slot}`]);
    if (slots.some((itemId) => !Number.isInteger(itemId) || itemId < 0)) {
      fail("Match fixture final inventory is invalid.", { replayId, participantId, slots });
    }
    const laterEvents = events.filter(
      (event) =>
        event.participantId === participantId && event.timestamp > block.timestampMillis + 1,
    );
    const replayOperationsAfterLastState = inventoryOperationPackets.filter(
      (operation) =>
        operation.participantId === participantId &&
        operation.timestampMillis > lastStateTimestampMillis + 1,
    );
    const payload = Buffer.from(block.contentHex, "hex");
    const { recordStarts, records, decodedMainSlots } = decodeMainSlots(payload, inventoryItemIds);
    const reversedOccupiedMainSlots = [5, 4, 3, 2, 1, 0]
      .filter((slot) => slots[slot] !== 0)
      .map((slot) => {
        const positions = positionsFor(payload, slots[slot]);
        const record = records.find((candidate) => candidate.slot === slot);
        return {
          slot,
          itemId: slots[slot],
          positions,
          positionsInExpectedRecord:
            record === undefined
              ? []
              : positions.filter((position) => position >= record.start && position < record.end),
        };
      });
    const positionDomains = reversedOccupiedMainSlots.map((entry) => entry.positions);
    const orderedEmbeddingCount = countOrderedEmbeddings(positionDomains);
    const earliestEmbedding = earliestOrderedEmbedding(positionDomains);
    const firstMainPosition = earliestEmbedding?.[0] ?? null;
    const trinketPositions = slots[6] === 0 ? [] : positionsFor(payload, slots[6]);
    tracks.push({
      replayId,
      partition,
      participantId,
      lastKeyframeTimestampMillis: block.timestampMillis,
      lastStateTimestampMillis,
      stableTail: laterEvents.length === 0,
      laterItemEventCount: laterEvents.length,
      replayOperationAfterLastStateCount: replayOperationsAfterLastState.length,
      replayOperationAfterLastStateSignature:
        replayOperationsAfterLastState
          .map(
            (operation) =>
              `0x${operation.packetType.toString(16).padStart(4, "0")}:${operation.contentLength}`,
          )
          .join(">") || "NONE",
      finalSlots: slots,
      occupiedMainSlotCount: reversedOccupiedMainSlots.length,
      expectedPairOccurrenceCount: reversedOccupiedMainSlots.filter(
        (entry) => entry.positions.length > 0,
      ).length,
      orderedEmbeddingCount,
      orderedEmbeddingAvailable: orderedEmbeddingCount > 0,
      orderedEmbeddingUnique: orderedEmbeddingCount === 1,
      earliestEmbedding,
      recordStarts,
      records,
      decodedMainSlots,
      exactFinalMainSlots: decodedMainSlots.every((itemId, slot) => itemId === slots[slot]),
      exactFinalMainMultiset:
        [...decodedMainSlots].sort((left, right) => left - right).join(",") ===
        slots
          .slice(0, 6)
          .sort((left, right) => left - right)
          .join(","),
      completeSixRecordBoundary: recordStarts.length === 6,
      expectedRecordMatchCount: reversedOccupiedMainSlots.filter(
        (entry) => entry.positionsInExpectedRecord.length > 0,
      ).length,
      trinketItemId: slots[6],
      trinketPositions,
      trinketBeforeMain:
        slots[6] !== 0 &&
        firstMainPosition !== null &&
        trinketPositions.some((position) => position < firstMainPosition),
      expectedEntries: reversedOccupiedMainSlots,
      payloadLength: payload.length,
    });
  }
  return {
    tracks,
    strictAddSlotRows,
    rearrangementCandidateRows,
    recordActivityRows,
    input: {
      replayId,
      partition,
      replayPacketInput: replayPath,
      offlineValidationInputs: [matchPath, timelinePath],
      keyframeBlockCount,
      completeSixRecordBlockCount,
      timelineStateValidation,
      timelineAlignmentValidation,
      falseExtraDiagnostics,
    },
  };
}

function activityMetrics(rows) {
  return {
    rowCount: rows.length,
    activeCount: rows.filter((row) => row.active).length,
    inactiveCount: rows.filter((row) => !row.active).length,
  };
}

function activityConflictMetrics(rows, keySelector) {
  const labelsByKey = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    const labels = labelsByKey.get(key) ?? { active: 0, inactive: 0 };
    if (row.active) labels.active += 1;
    else labels.inactive += 1;
    labelsByKey.set(key, labels);
  }
  const conflicted = [...labelsByKey.values()].filter(
    (labels) => labels.active > 0 && labels.inactive > 0,
  );
  return {
    distinctKeyCount: labelsByKey.size,
    conflictedKeyCount: conflicted.length,
    conflictedRowCount: conflicted.reduce(
      (sum, labels) => sum + labels.active + labels.inactive,
      0,
    ),
    minorityErrorFloor: conflicted.reduce(
      (sum, labels) => sum + Math.min(labels.active, labels.inactive),
      0,
    ),
  };
}

function recordLocalActivityConflicts(rows) {
  return {
    payload: activityConflictMetrics(rows, (row) => row.payloadHex),
    ordinalAndPayload: activityConflictMetrics(
      rows,
      (row) => `${row.recordOrdinal}:${row.payloadHex}`,
    ),
    itemAndPayload: activityConflictMetrics(rows, (row) => `${row.itemId}:${row.payloadHex}`),
    ordinalItemAndPayload: activityConflictMetrics(
      rows,
      (row) => `${row.recordOrdinal}:${row.itemId}:${row.payloadHex}`,
    ),
  };
}

function recordActivityConflictSamples(rows, limit = 16) {
  const rowsByKey = new Map();
  for (const row of rows) {
    const key = `${row.recordOrdinal}:${row.itemId}:${row.payloadHex}`;
    const grouped = rowsByKey.get(key) ?? [];
    grouped.push(row);
    rowsByKey.set(key, grouped);
  }
  const samples = [];
  for (const [key, grouped] of rowsByKey) {
    const active = grouped.find((row) => row.active);
    const inactive = grouped.find((row) => !row.active);
    if (active === undefined || inactive === undefined) continue;
    const compact = (row) => ({
      replayId: row.replayId,
      participantId: row.participantId,
      segmentId: row.segmentId,
      blockTimestampMillis: row.blockTimestampMillis,
      stateTimestampMillis: row.stateTimestampMillis,
      componentPrefixHex: row.componentPrefixHex,
      siblingPayloadHexes: row.siblingPayloadHexes,
      componentPayloadHex: row.componentPayloadHex,
    });
    samples.push({ key, active: compact(active), inactive: compact(inactive) });
    if (samples.length >= limit) break;
  }
  return samples;
}

function recordActivityTransitions(rows, limit = 32) {
  const rowsByTrackRecord = new Map();
  for (const row of rows) {
    const key = `${row.replayId}:${row.participantId}:${row.recordOrdinal}:${row.itemId}:${row.payloadHex}`;
    const grouped = rowsByTrackRecord.get(key) ?? [];
    grouped.push(row);
    rowsByTrackRecord.set(key, grouped);
  }
  const transitions = [];
  for (const [key, grouped] of rowsByTrackRecord) {
    grouped.sort(
      (left, right) =>
        left.segmentId - right.segmentId || left.blockTimestampMillis - right.blockTimestampMillis,
    );
    for (let index = 1; index < grouped.length; index += 1) {
      const before = grouped[index - 1];
      const after = grouped[index];
      if (before.active === after.active) continue;
      transitions.push({
        key,
        direction: before.active ? "active-to-inactive" : "inactive-to-active",
        segmentDelta: after.segmentId - before.segmentId,
        timestampDeltaMillis: after.stateTimestampMillis - before.stateTimestampMillis,
        componentPrefixChanged: before.componentPrefixHex !== after.componentPrefixHex,
        changedSiblingOrdinals: before.siblingPayloadHexes.flatMap((payloadHex, ordinal) =>
          payloadHex === after.siblingPayloadHexes[ordinal] ? [] : [ordinal],
        ),
        before: {
          segmentId: before.segmentId,
          stateTimestampMillis: before.stateTimestampMillis,
          componentPrefixHex: before.componentPrefixHex,
          siblingPayloadHexes: before.siblingPayloadHexes,
          componentPayloadHex: before.componentPayloadHex,
        },
        after: {
          segmentId: after.segmentId,
          stateTimestampMillis: after.stateTimestampMillis,
          componentPrefixHex: after.componentPrefixHex,
          siblingPayloadHexes: after.siblingPayloadHexes,
          componentPayloadHex: after.componentPayloadHex,
        },
      });
    }
  }
  const compact = transitions.map(({ before, after, ...transition }) => transition);
  const countByChangedSiblingSet = {};
  for (const transition of compact) {
    const key = transition.changedSiblingOrdinals.join(",");
    countByChangedSiblingSet[key] = (countByChangedSiblingSet[key] ?? 0) + 1;
  }
  return {
    count: transitions.length,
    activeToInactiveCount: transitions.filter(
      (transition) => transition.direction === "active-to-inactive",
    ).length,
    inactiveToActiveCount: transitions.filter(
      (transition) => transition.direction === "inactive-to-active",
    ).length,
    prefixChangedCount: transitions.filter((transition) => transition.componentPrefixChanged)
      .length,
    countByChangedSiblingSet,
    samples: transitions.slice(0, limit),
  };
}

function evaluateActivityCandidate(rows, candidate) {
  let exact = 0;
  let wrong = 0;
  for (const row of rows) {
    const payload = Buffer.from(row.payloadHex, "hex");
    if (candidate.bits.some((bit) => bit >= payload.length * 8)) continue;
    const value = candidate.bits.reduce((result, bit) => result ^ payloadBit(payload, bit), 0);
    const predicted = Boolean(value ^ candidate.inverse);
    if (predicted === row.active) exact += 1;
    else wrong += 1;
  }
  return { exact, wrong, unavailable: rows.length - exact - wrong };
}

function searchRecordActivityBits(discoveryRows, holdoutRows) {
  const minimumBitCount = Math.min(
    ...discoveryRows.map((row) => Buffer.from(row.payloadHex, "hex").length * 8),
  );
  const candidates = [];
  for (let left = 0; left < minimumBitCount; left += 1) {
    for (let right = left; right < minimumBitCount; right += 1) {
      const bits = left === right ? [left] : [left, right];
      for (const inverse of [0, 1]) {
        const candidate = { bits, inverse };
        const discovery = evaluateActivityCandidate(discoveryRows, candidate);
        if (discovery.wrong !== 0 || discovery.unavailable !== 0) continue;
        candidates.push({
          ...candidate,
          discovery,
          holdout: evaluateActivityCandidate(holdoutRows, candidate),
        });
      }
    }
  }
  return {
    minimumBitCount,
    candidateCount: candidates.length,
    zeroWrongHoldoutCandidateCount: candidates.filter((candidate) => candidate.holdout.wrong === 0)
      .length,
    candidates: candidates.slice(0, 32),
  };
}

function recordBitValue(payload, start, width, reversed) {
  let value = 0;
  for (let index = 0; index < width; index += 1) {
    const outputBit = reversed ? width - 1 - index : index;
    value |= payloadBit(payload, start + index) << outputBit;
  }
  return value;
}

function searchRecordActivityLookups(discoveryRows, holdoutRows) {
  const minimumBitCount = Math.min(
    ...discoveryRows.map((row) => Buffer.from(row.payloadHex, "hex").length * 8),
  );
  const candidates = [];
  for (let width = 1; width <= 8; width += 1) {
    for (let start = 0; start + width <= minimumBitCount; start += 1) {
      for (const reversed of [false, true]) {
        const labels = new Map();
        let conflict = false;
        for (const row of discoveryRows) {
          const value = recordBitValue(Buffer.from(row.payloadHex, "hex"), start, width, reversed);
          const previous = labels.get(value);
          if (previous !== undefined && previous !== row.active) {
            conflict = true;
            break;
          }
          labels.set(value, row.active);
        }
        if (conflict) continue;
        let exact = 0;
        let wrong = 0;
        let unavailable = 0;
        for (const row of holdoutRows) {
          const value = recordBitValue(Buffer.from(row.payloadHex, "hex"), start, width, reversed);
          const predicted = labels.get(value);
          if (predicted === undefined) unavailable += 1;
          else if (predicted === row.active) exact += 1;
          else wrong += 1;
        }
        candidates.push({
          start,
          width,
          reversed,
          symbolCount: labels.size,
          holdout: { exact, wrong, unavailable },
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      left.holdout.wrong - right.holdout.wrong ||
      right.holdout.exact - left.holdout.exact ||
      left.width - right.width ||
      left.start - right.start,
  );
  return {
    candidateCount: candidates.length,
    zeroWrongHoldoutCandidateCount: candidates.filter((candidate) => candidate.holdout.wrong === 0)
      .length,
    bestCandidates: candidates.slice(0, 32),
  };
}

function summarize(tracks) {
  const stable = tracks.filter((track) => track.stableTail);
  const labelledMainEntries = stable.flatMap((track) => track.expectedEntries);
  const distinctMainTracks = stable.filter((track) => {
    const itemIds = track.expectedEntries.map((entry) => entry.itemId);
    return new Set(itemIds).size === itemIds.length;
  });
  return {
    participantTrackCount: tracks.length,
    stableTailTrackCount: stable.length,
    stableTailOccupiedMainSlotCount: labelledMainEntries.length,
    stableTailExpectedPairOccurrenceCount: labelledMainEntries.filter(
      (entry) => entry.positions.length > 0,
    ).length,
    stableTailExpectedRecordMatchCount: labelledMainEntries.filter(
      (entry) => entry.positionsInExpectedRecord.length > 0,
    ).length,
    stableTailCompleteSixRecordTrackCount: stable.filter((track) => track.completeSixRecordBoundary)
      .length,
    stableTailExactFinalMainSlotTrackCount: stable.filter((track) => track.exactFinalMainSlots)
      .length,
    stableTailExactFinalMainMultisetTrackCount: stable.filter(
      (track) => track.exactFinalMainMultiset,
    ).length,
    stableTailMismatchWithReplayOperationAfterStateCount: stable.filter(
      (track) => !track.exactFinalMainSlots && track.replayOperationAfterLastStateCount > 0,
    ).length,
    stableTailMismatchWithoutReplayOperationAfterStateCount: stable.filter(
      (track) => !track.exactFinalMainSlots && track.replayOperationAfterLastStateCount === 0,
    ).length,
    stableTailOrderedEmbeddingTrackCount: stable.filter((track) => track.orderedEmbeddingAvailable)
      .length,
    stableTailUniqueOrderedEmbeddingTrackCount: stable.filter(
      (track) => track.orderedEmbeddingUnique,
    ).length,
    stableTailDistinctItemTrackCount: distinctMainTracks.length,
    stableTailDistinctItemOrderedEmbeddingTrackCount: distinctMainTracks.filter(
      (track) => track.orderedEmbeddingAvailable,
    ).length,
    stableTailTrinketTrackCount: stable.filter((track) => track.trinketItemId !== 0).length,
    stableTailTrinketOccurrenceTrackCount: stable.filter(
      (track) => track.trinketPositions.length > 0,
    ).length,
    stableTailTrinketBeforeMainTrackCount: stable.filter((track) => track.trinketBeforeMain).length,
  };
}

function summarizeTimelineState(reports) {
  return reports.reduce(
    (summary, report) => {
      const validation = report.input.timelineStateValidation;
      summary.snapshotCount += validation.snapshotCount;
      summary.exactMultisetSnapshotCount += validation.exactMultisetSnapshotCount;
      summary.decodedSubsetSnapshotCount += validation.decodedSubsetSnapshotCount;
      summary.falseExtraItemSnapshotCount += validation.falseExtraItemSnapshotCount;
      return summary;
    },
    {
      snapshotCount: 0,
      exactMultisetSnapshotCount: 0,
      decodedSubsetSnapshotCount: 0,
      falseExtraItemSnapshotCount: 0,
    },
  );
}

function summarizeTimelineAlignments(reports) {
  const summary = Object.fromEntries(
    [-2, -1, 0, 1, 2].map((blockOffset) => [String(blockOffset), emptyTimelineStateValidation()]),
  );
  for (const report of reports) {
    for (const [blockOffset, validation] of Object.entries(
      report.input.timelineAlignmentValidation,
    )) {
      for (const field of Object.keys(summary[blockOffset])) {
        summary[blockOffset][field] += validation[field];
      }
    }
  }
  return summary;
}

function summarizeFalseExtraDiagnostics(reports) {
  const summary = {
    occurrenceCount: 0,
    latestLabelledActionRemovedCount: 0,
    latestLabelledActionAcquiredCount: 0,
    noPriorLabelledIdentityActionCount: 0,
    byItemId: {},
    byChampionName: {},
  };
  for (const report of reports) {
    const diagnostics = report.input.falseExtraDiagnostics;
    for (const field of [
      "occurrenceCount",
      "latestLabelledActionRemovedCount",
      "latestLabelledActionAcquiredCount",
      "noPriorLabelledIdentityActionCount",
    ]) {
      summary[field] += diagnostics[field];
    }
    for (const histogramField of ["byItemId", "byChampionName"]) {
      for (const [key, count] of Object.entries(diagnostics[histogramField])) {
        summary[histogramField][key] = (summary[histogramField][key] ?? 0) + count;
      }
      summary[histogramField] = Object.fromEntries(
        Object.entries(summary[histogramField]).sort(
          (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
        ),
      );
    }
  }
  return summary;
}

function compactAlignmentMetrics(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([offset, metrics]) => [
      offset,
      {
        exact: metrics.exactMultisetSnapshotCount,
        subset: metrics.decodedSubsetSnapshotCount,
      },
    ]),
  );
}

function compactFalseExtraMetrics(summary) {
  return {
    occurrences: summary.occurrenceCount,
    removed: summary.latestLabelledActionRemovedCount,
    acquired: summary.latestLabelledActionAcquiredCount,
    absent: summary.noPriorLabelledIdentityActionCount,
  };
}

function compactFinalSuffixMetrics(summary) {
  return {
    mismatchWithReplayOperations: summary.stableTailMismatchWithReplayOperationAfterStateCount,
    mismatchWithout: summary.stableTailMismatchWithoutReplayOperationAfterStateCount,
  };
}

function frozenPartitionMetrics(reports) {
  const timeline = summarizeTimelineState(reports);
  return {
    keyframeBlockCount: reports.reduce((sum, report) => sum + report.input.keyframeBlockCount, 0),
    completeSixRecordBlockCount: reports.reduce(
      (sum, report) => sum + report.input.completeSixRecordBlockCount,
      0,
    ),
    exactMultisetSnapshotCount: timeline.exactMultisetSnapshotCount,
    decodedSubsetSnapshotCount: timeline.decodedSubsetSnapshotCount,
    falseExtraItemSnapshotCount: timeline.falseExtraItemSnapshotCount,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const inventoryItemIds = loadInventoryItemIds(args);
  const reports = [
    ...PROFILE.discovery.map((replayId) => inspectReplay(args, replayId, "D7", inventoryItemIds)),
    ...PROFILE.holdout.map((replayId) => inspectReplay(args, replayId, "H3", inventoryItemIds)),
  ];
  const tracks = reports.flatMap((report) => report.tracks);
  const strictAddSlotRows = reports.flatMap((report) => report.strictAddSlotRows);
  const rearrangementCandidateRows = reports.flatMap((report) => report.rearrangementCandidateRows);
  const recordActivityRows = reports.flatMap((report) => report.recordActivityRows);
  const discoveryReports = reports.filter((report) => report.input.partition === "D7");
  const holdoutReports = reports.filter((report) => report.input.partition === "H3");
  const frozenMetrics = {
    discovery: frozenPartitionMetrics(discoveryReports),
    holdout: frozenPartitionMetrics(holdoutReports),
  };
  if (JSON.stringify(frozenMetrics) !== JSON.stringify(EXPECTED)) {
    fail("Frozen keyframe inventory falsification metrics drifted.", {
      expected: EXPECTED,
      actual: frozenMetrics,
    });
  }
  const discovery = tracks.filter((track) => track.partition === "D7");
  const holdout = tracks.filter((track) => track.partition === "H3");
  const discoveryAddSlotRows = strictAddSlotRows.filter((row) => row.partition === "D7");
  const holdoutAddSlotRows = strictAddSlotRows.filter((row) => row.partition === "H3");
  const addSlotCandidateMetrics = {
    discoveryCount: discoveryAddSlotRows.length,
    holdoutCount: holdoutAddSlotRows.length,
    discoverySlots: countsBySlot(discoveryAddSlotRows),
    holdoutSlots: countsBySlot(holdoutAddSlotRows),
    discoveryContiguousLookupCandidateCount:
      contiguousSlotLookupCandidateCount(discoveryAddSlotRows),
  };
  if (JSON.stringify(addSlotCandidateMetrics) !== JSON.stringify(EXPECTED_ADD_SLOT_CANDIDATES)) {
    fail("Frozen add-slot candidate metrics drifted.", {
      expected: EXPECTED_ADD_SLOT_CANDIDATES,
      actual: addSlotCandidateMetrics,
    });
  }
  const rearrangementCandidateMetrics = {
    discoveryCount: rearrangementCandidateRows.filter((row) => row.partition === "D7").length,
    holdoutCount: rearrangementCandidateRows.filter((row) => row.partition === "H3").length,
  };
  if (
    JSON.stringify(rearrangementCandidateMetrics) !==
    JSON.stringify(EXPECTED_REARRANGEMENT_CANDIDATES)
  ) {
    fail("Frozen same-multiset rearrangement candidate metrics drifted.", {
      expected: EXPECTED_REARRANGEMENT_CANDIDATES,
      actual: rearrangementCandidateMetrics,
    });
  }
  const timelineAlignmentMetrics = {
    discovery: compactAlignmentMetrics(summarizeTimelineAlignments(discoveryReports)),
    holdout: compactAlignmentMetrics(summarizeTimelineAlignments(holdoutReports)),
  };
  if (
    JSON.stringify(timelineAlignmentMetrics) !== JSON.stringify(EXPECTED_TIMELINE_ALIGNMENT_METRICS)
  ) {
    fail("Frozen Timeline alignment metrics drifted.", {
      expected: EXPECTED_TIMELINE_ALIGNMENT_METRICS,
      actual: timelineAlignmentMetrics,
    });
  }
  const falseExtraMetrics = {
    discovery: compactFalseExtraMetrics(summarizeFalseExtraDiagnostics(discoveryReports)),
    holdout: compactFalseExtraMetrics(summarizeFalseExtraDiagnostics(holdoutReports)),
  };
  if (JSON.stringify(falseExtraMetrics) !== JSON.stringify(EXPECTED_FALSE_EXTRA_METRICS)) {
    fail("Frozen missing-Timeline-identity metrics drifted.", {
      expected: EXPECTED_FALSE_EXTRA_METRICS,
      actual: falseExtraMetrics,
    });
  }
  const finalSuffixMetrics = {
    discovery: compactFinalSuffixMetrics(summarize(discovery)),
    holdout: compactFinalSuffixMetrics(summarize(holdout)),
  };
  const recordActivityResearch = {
    discovery: activityMetrics(recordActivityRows.filter((row) => row.partition === "D7")),
    holdout: activityMetrics(recordActivityRows.filter((row) => row.partition === "H3")),
    affineBitSearch: searchRecordActivityBits(
      recordActivityRows.filter((row) => row.partition === "D7"),
      recordActivityRows.filter((row) => row.partition === "H3"),
    ),
    contiguousLookupSearch: searchRecordActivityLookups(
      recordActivityRows.filter((row) => row.partition === "D7"),
      recordActivityRows.filter((row) => row.partition === "H3"),
    ),
    recordLocalConflicts: {
      discovery: recordLocalActivityConflicts(
        recordActivityRows.filter((row) => row.partition === "D7"),
      ),
      holdout: recordLocalActivityConflicts(
        recordActivityRows.filter((row) => row.partition === "H3"),
      ),
      combined: recordLocalActivityConflicts(recordActivityRows),
    },
    recordLocalConflictSamples: recordActivityConflictSamples(recordActivityRows),
    unchangedRecordActivityTransitions: recordActivityTransitions(recordActivityRows),
  };
  const compactRecordActivityMetrics = {
    discovery: recordActivityResearch.discovery,
    holdout: recordActivityResearch.holdout,
    affineBitSearch: {
      minimumBitCount: recordActivityResearch.affineBitSearch.minimumBitCount,
      candidateCount: recordActivityResearch.affineBitSearch.candidateCount,
      zeroWrongHoldoutCandidateCount:
        recordActivityResearch.affineBitSearch.zeroWrongHoldoutCandidateCount,
    },
    contiguousLookupSearch: {
      candidateCount: recordActivityResearch.contiguousLookupSearch.candidateCount,
      zeroWrongHoldoutCandidateCount:
        recordActivityResearch.contiguousLookupSearch.zeroWrongHoldoutCandidateCount,
    },
  };
  if (
    JSON.stringify(compactRecordActivityMetrics) !==
    JSON.stringify(EXPECTED_RECORD_ACTIVITY_METRICS)
  ) {
    fail("Frozen keyframe record-activity metrics drifted.", {
      expected: EXPECTED_RECORD_ACTIVITY_METRICS,
      actual: compactRecordActivityMetrics,
    });
  }
  const compactRecordActivityContextMetrics = {
    discovery: {
      conflictedKeyCount:
        recordActivityResearch.recordLocalConflicts.discovery.ordinalItemAndPayload
          .conflictedKeyCount,
      minorityErrorFloor:
        recordActivityResearch.recordLocalConflicts.discovery.ordinalItemAndPayload
          .minorityErrorFloor,
    },
    holdout: {
      conflictedKeyCount:
        recordActivityResearch.recordLocalConflicts.holdout.ordinalItemAndPayload
          .conflictedKeyCount,
      minorityErrorFloor:
        recordActivityResearch.recordLocalConflicts.holdout.ordinalItemAndPayload
          .minorityErrorFloor,
    },
    combined: {
      conflictedKeyCount:
        recordActivityResearch.recordLocalConflicts.combined.ordinalItemAndPayload
          .conflictedKeyCount,
      minorityErrorFloor:
        recordActivityResearch.recordLocalConflicts.combined.ordinalItemAndPayload
          .minorityErrorFloor,
    },
    transitions: {
      count: recordActivityResearch.unchangedRecordActivityTransitions.count,
      activeToInactiveCount:
        recordActivityResearch.unchangedRecordActivityTransitions.activeToInactiveCount,
      inactiveToActiveCount:
        recordActivityResearch.unchangedRecordActivityTransitions.inactiveToActiveCount,
      prefixChangedCount:
        recordActivityResearch.unchangedRecordActivityTransitions.prefixChangedCount,
    },
  };
  if (
    JSON.stringify(compactRecordActivityContextMetrics) !==
    JSON.stringify(EXPECTED_RECORD_ACTIVITY_CONTEXT_METRICS)
  ) {
    fail("Frozen keyframe record-activity context metrics drifted.", {
      expected: EXPECTED_RECORD_ACTIVITY_CONTEXT_METRICS,
      actual: compactRecordActivityContextMetrics,
    });
  }
  if (JSON.stringify(finalSuffixMetrics) !== JSON.stringify(EXPECTED_FINAL_SUFFIX_METRICS)) {
    fail("Frozen final-suffix replay-operation metrics drifted.", {
      expected: EXPECTED_FINAL_SUFFIX_METRICS,
      actual: finalSuffixMetrics,
    });
  }
  const output = {
    schema: "rofl-keyframe-inventory-slot-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayPacketFamily: {
      segmentType: "keyframe",
      channel: 1,
      packetType: "0x0081",
      championOwnerBase: PROFILE.championOwnerBase,
    },
    candidate: {
      itemIdGrammar:
        "The exact external-profile 16.14 0x0369 13-bit item-ID Boolean grammar, applied to adjacent 0x0081 payload bytes with both unseen input symbols still fail-closed.",
      mainSlotOrdering:
        "Expected occupied main slots are tested in descending slot order 5..0 against strictly increasing replay-payload positions.",
      replayOnlyFieldSelector:
        "Select the final six (0xC0|0xC3) .. .. 0xE6 records; map their ordinals to slots 5..0; for record lengths 13..15 decode pair offset 7, for length 16 require exactly one catalog-valid decode at offset 7 or 8, and for lengths 21..23 decode pair offset 15. Other lengths yield empty/unavailable.",
      trinketRelation:
        "Final slot 6 is tested for a decoded pair before the first selected main-slot pair.",
    },
    partitions: {
      discovery: {
        finalStableTail: summarize(discovery),
        timelineState: summarizeTimelineState(discoveryReports),
        timelineAlignments: summarizeTimelineAlignments(discoveryReports),
        falseExtraDiagnostics: summarizeFalseExtraDiagnostics(discoveryReports),
      },
      holdout: {
        finalStableTail: summarize(holdout),
        timelineState: summarizeTimelineState(holdoutReports),
        timelineAlignments: summarizeTimelineAlignments(holdoutReports),
        falseExtraDiagnostics: summarizeFalseExtraDiagnostics(holdoutReports),
      },
      combined: {
        finalStableTail: summarize(tracks),
        timelineState: summarizeTimelineState(reports),
        timelineAlignments: summarizeTimelineAlignments(reports),
        falseExtraDiagnostics: summarizeFalseExtraDiagnostics(reports),
      },
    },
    frozenMetrics,
    timelineAlignmentMetrics,
    falseExtraMetrics,
    finalSuffixMetrics,
    addSlotCandidateMetrics,
    rearrangementCandidateMetrics,
    recordActivityResearch,
    inputs: reports.map((report) => report.input),
    stableTailTracks: tracks.filter((track) => track.stableTail),
    isolatedAddRecordChangeRows: strictAddSlotRows,
    rearrangementCandidateRows,
    nonPromotionReasons: [
      "The replay-only selector retains items that the offline Timeline reducer has already removed: 1,049/3,200 snapshots contain at least one false-extra candidate, including 374/1,030 frozen Holdout snapshots.",
      "The six records are therefore not champion current-inventory slots; their behavior remains consistent with a shop/undo component or another historical item state.",
      "Empty slots, duplicate-item counts, physical slot moves, and the complete record grammar remain unresolved.",
      "The 181 isolated add/record-change anchors cover all six main record ordinals, but no contiguous one-to-eight-bit add-payload lookup is even conflict-free on Discovery.",
      "The independently decoded chunk operation subsets still do not provide complete between-keyframe inventory reconstruction.",
      "A bounded -2..+2 keyframe/Timeline alignment audit confirms the existing -1 block alignment is uniquely strongest; simple missing-minute alignment does not explain the remaining mismatches.",
      "Of 1,336 false-extra item occurrences, 957 have no prior Timeline identity action, proving that Timeline item events are incomplete as a state oracle; 378 have a latest labelled removal, so missing labels do not make the six records current slots.",
      "Replay operation packets absent from the Timeline follow 34/36 stable-Timeline final mismatches, but two mismatches remain even without a later packet from the four known families.",
      "A whole-record activity falsification finds opposite active/inactive labels for 49 byte-identical same-ordinal item records in D7 and 28 in H3; record-local bytes therefore cannot determine whether a historical item identity is currently active.",
    ],
    conclusion:
      "The six trailing keyframe 0x0081 records and their reused item-ID symbols are exact replay structure. Timeline omissions explain much of the prior apparent mismatch, but known removed identities, byte-identical records with opposite activity labels, and two replay-operation-free final mismatches reject a direct current-slot interpretation. Activity requires component-level or temporal state, and a replay-native operation reducer remains necessary before C++/Wasm/UI promotion.",
  };
  fs.mkdirSync(path.dirname(path.resolve(args.outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(args.outputPath), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.partitions, null, 2));
  console.log(`Wrote ${path.resolve(args.outputPath)}`);
}

main();
