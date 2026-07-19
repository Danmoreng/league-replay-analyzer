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

function dumpKeyframeInventory(args, replayPath) {
  const run = spawnSync(
    args.cliPath,
    [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      String(PROFILE.packetType),
      "--segment-type",
      "keyframe",
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
    fail("Exact keyframe inventory framing/version gate failed.", { replayPath, dump });
  }
  return dump.blocks ?? [];
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
  const timelineStateValidation = {
    snapshotCount: 0,
    exactMultisetSnapshotCount: 0,
    decodedSubsetSnapshotCount: 0,
    falseExtraItemSnapshotCount: 0,
    falseExtraSamples: [],
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
      const decodedInventory = decodeMainSlots(
        Buffer.from(block.contentHex, "hex"),
        inventoryItemIds,
      ).decodedMainSlots.filter((itemId) => itemId !== 0);
      const decodedSubset = isMultisetSubset(decodedInventory, labelledInventory);
      timelineStateValidation.snapshotCount += 1;
      if (sameMultiset(decodedInventory, labelledInventory)) {
        timelineStateValidation.exactMultisetSnapshotCount += 1;
      }
      if (decodedSubset) timelineStateValidation.decodedSubsetSnapshotCount += 1;
      else {
        timelineStateValidation.falseExtraItemSnapshotCount += 1;
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
  }
  const tracks = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const block = lastByParticipant.get(participantId);
    const participant = match.info.participants[participantId - 1];
    const slots = Array.from({ length: 7 }, (_, slot) => participant[`item${slot}`]);
    if (slots.some((itemId) => !Number.isInteger(itemId) || itemId < 0)) {
      fail("Match fixture final inventory is invalid.", { replayId, participantId, slots });
    }
    const laterEvents = events.filter(
      (event) =>
        event.participantId === participantId && event.timestamp > block.timestampMillis + 1,
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
      stableTail: laterEvents.length === 0,
      laterItemEventCount: laterEvents.length,
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
    input: {
      replayId,
      partition,
      replayPacketInput: replayPath,
      offlineValidationInputs: [matchPath, timelinePath],
      keyframeBlockCount,
      completeSixRecordBlockCount,
      timelineStateValidation,
    },
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
      },
      holdout: {
        finalStableTail: summarize(holdout),
        timelineState: summarizeTimelineState(holdoutReports),
      },
      combined: {
        finalStableTail: summarize(tracks),
        timelineState: summarizeTimelineState(reports),
      },
    },
    frozenMetrics,
    inputs: reports.map((report) => report.input),
    stableTailTracks: tracks.filter((track) => track.stableTail),
    nonPromotionReasons: [
      "The replay-only selector retains items that the offline Timeline reducer has already removed: 1,049/3,200 snapshots contain at least one false-extra candidate, including 374/1,030 frozen Holdout snapshots.",
      "The six records are therefore not champion current-inventory slots; their behavior remains consistent with a shop/undo component or another historical item state.",
      "Empty slots, duplicate-item counts, physical slot moves, and the complete record grammar remain unresolved.",
      "The independently decoded chunk operation subsets still do not provide complete between-keyframe inventory reconstruction.",
    ],
    conclusion:
      "The six trailing keyframe 0x0081 records and their reused item-ID symbols are exact replay structure, but the current-inventory interpretation is falsified on Discovery and frozen Holdout. No C++/Wasm/UI inventory state is authorized from this family.",
  };
  fs.mkdirSync(path.dirname(path.resolve(args.outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(args.outputPath), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output.partitions, null, 2));
  console.log(`Wrote ${path.resolve(args.outputPath)}`);
}

main();
