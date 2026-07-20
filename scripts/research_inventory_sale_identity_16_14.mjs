#!/usr/bin/env node

// Offline research only. Saved Timeline sale item IDs are validation labels;
// runtime candidates are restricted to exact-build saved ROFL removal bytes.
// The required Data Dragon file is pinned static item schema, not match state.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  removalPacketType: 0x03f9,
  removalContextPacketType: 0x0146,
  addPacketType: 0x0369,
  keyframeShopPacketType: 0x0081,
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
});

const STATIC_ITEM_SCHEMA = Object.freeze({
  version: "16.14.1",
  byteLength: 583139,
  sha256: "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75",
});

const EXPECTED = Object.freeze({
  discoverySaleCount: 77,
  holdoutSaleCount: 39,
  discoveryUniquePriorAddPairs: 67,
  holdoutUniquePriorAddPairs: 28,
  discoveryPrecedingContainsTruth: 74,
  holdoutPrecedingContainsTruth: 38,
  discoveryUniqueTruthOrdinalRows: 74,
  holdoutUniqueTruthOrdinalRows: 37,
  discoveryLengthSelectsOrdinalHalf: 74,
  holdoutLengthSelectsOrdinalHalf: 37,
  discoveryDisappearedContainsTruth: 3,
  holdoutDisappearedContainsTruth: 0,
  discoveryFreshCandidateCount: 36,
  discoveryFreshExactCount: 36,
  discoveryFreshWrongCount: 0,
  holdoutFreshCandidateCount: 13,
  holdoutFreshExactCount: 13,
  holdoutFreshWrongCount: 0,
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    itemDataPath: null,
    outputPath: path.join("tmp", "inventory-sale-identity-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (argument === "--item-data" && argv[index + 1]) {
      args.itemDataPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_sale_identity_16_14.mjs --item-data <Data-Dragon-16.14.1-item.json> [--cli <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!args.itemDataPath)
    throw new Error("--item-data is required; latest/network lookup is forbidden.");
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

function loadStaticItems(filePath) {
  const bytes = fs.readFileSync(path.resolve(filePath));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== STATIC_ITEM_SCHEMA.byteLength || sha256 !== STATIC_ITEM_SCHEMA.sha256) {
    fail("Pinned item catalog fingerprint failed.", { byteLength: bytes.length, sha256 });
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.version !== STATIC_ITEM_SCHEMA.version || typeof parsed.data !== "object") {
    fail("Pinned item catalog schema failed.");
  }
  return parsed.data;
}

function dumpPacketType(args, replayPath, packetType, segmentType = "chunk") {
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
    { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) fail("Native removal dump failed.", { replayPath, stderr: run.stderr });
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.gameVersion !== PROFILE.exactReplayBuild
  ) {
    fail("Exact removal framing/version gate failed.", { replayPath });
  }
  return dump.blocks ?? [];
}

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

function inputCode(payload, bits) {
  return bits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

function decodeAddItemId(payload) {
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
  return decodedBits.reduce((itemId, value, index) => itemId | (value << index), 0);
}

function keyframeRecordStarts(payload) {
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

function decodeKeyframeShopRecords(payload, validItemIds) {
  const starts = keyframeRecordStarts(payload);
  if (starts.length !== 6) return [];
  const records = [];
  for (let ordinal = 0; ordinal < starts.length; ordinal += 1) {
    const start = starts[ordinal];
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
    // Preserve the physical record ordinal even when one record is unavailable.
    // Compacting this array would turn a history-record index into a false slot.
    records.push({
      ordinal,
      itemId: candidates.length === 1 ? candidates[0] : null,
      payload: payload.subarray(start, end),
      payloadHex: payload.subarray(start, end).toString("hex"),
    });
  }
  return records;
}

function saleLabels(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter(
      (event) =>
        event.type === "ITEM_SOLD" &&
        Number.isInteger(event.participantId) &&
        Number.isInteger(event.timestamp) &&
        Number.isInteger(event.itemId),
    );
}

function timelineItemEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter(
      (event) =>
        ["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type) &&
        Number.isInteger(event.participantId) &&
        Number.isInteger(event.timestamp),
    );
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

function inspectReplay(args, replayId, partition, items) {
  const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
  const fixtureRoot = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  const matchPath = path.join(fixtureRoot, "match.json");
  if (![replayPath, timelinePath, matchPath].every(fs.existsSync)) {
    fail("Fixed replay/API fixture missing.", { replayId });
  }
  if (readJson(matchPath).info?.gameVersion !== PROFILE.exactReplayBuild) {
    fail("Match fixture exact-build gate failed.", { replayId });
  }
  const timeline = readJson(timelinePath);
  const allItemEvents = timelineItemEvents(timeline);
  const removals = dumpPacketType(args, replayPath, PROFILE.removalPacketType);
  const removalContexts = dumpPacketType(args, replayPath, PROFILE.removalContextPacketType);
  const undoComponents = dumpPacketType(args, replayPath, PROFILE.keyframeShopPacketType);
  const adds = dumpPacketType(args, replayPath, PROFILE.addPacketType)
    .filter((block) => {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      return (
        block.channel === 1 &&
        participantId >= 1 &&
        participantId <= 10 &&
        [14, 15].includes(block.contentLength) &&
        block.contentHexTruncated === false &&
        block.contentHexBytes === block.contentLength
      );
    })
    .map((block) => {
      const payload = Buffer.from(block.contentHex, "hex");
      return {
        participantId: block.blockParam - PROFILE.championOwnerBase,
        timestampMillis: block.timestampMillis,
        itemId: decodeAddItemId(payload),
        payload,
        payloadHex: block.contentHex,
      };
    });
  const validItemIds = new Set(Object.keys(items).map(Number));
  const keyframeStates = dumpPacketType(
    args,
    replayPath,
    PROFILE.keyframeShopPacketType,
    "keyframe",
  )
    .filter((block) => {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      return (
        block.channel === 1 &&
        participantId >= 1 &&
        participantId <= 10 &&
        block.contentHexTruncated === false &&
        block.contentHexBytes === block.contentLength
      );
    })
    .map((block) => {
      const records = decodeKeyframeShopRecords(Buffer.from(block.contentHex, "hex"), validItemIds);
      return {
        participantId: block.blockParam - PROFILE.championOwnerBase,
        timestampMillis: block.timestampMillis,
        items: records.map((record) => record.itemId),
        records,
      };
    });
  const rows = [];
  for (const label of saleLabels(timeline)) {
    const matches = removals.filter(
      (block) =>
        block.channel === 1 &&
        block.blockParam - PROFILE.championOwnerBase === label.participantId &&
        Math.abs(block.timestampMillis - label.timestamp) <= 1,
    );
    if (matches.length !== 1) {
      fail("Sale label did not select one exact-owner removal.", {
        replayId,
        label,
        matchCount: matches.length,
      });
    }
    const block = matches[0];
    if (
      ![6, 7].includes(block.contentLength) ||
      block.contentHexTruncated !== false ||
      block.contentHexBytes !== block.contentLength
    ) {
      fail("Sale removal payload provenance failed.", { replayId, block });
    }
    const sellGain = items[String(label.itemId)]?.gold?.sell;
    if (!Number.isInteger(sellGain)) fail("Sale item lacks a pinned static sell price.", label);
    const priorMatchingAdds = adds.filter(
      (add) =>
        add.participantId === label.participantId &&
        add.timestampMillis < label.timestamp &&
        add.itemId === label.itemId,
    );
    const participantKeyframes = keyframeStates.filter(
      (state) => state.participantId === label.participantId,
    );
    const precedingKeyframe = participantKeyframes
      .filter((state) => state.timestampMillis <= label.timestamp)
      .at(-1);
    const followingKeyframe = participantKeyframes.find(
      (state) => state.timestampMillis > label.timestamp,
    );
    const disappearedKeyframeItems = multisetDifference(
      precedingKeyframe?.items ?? [],
      followingKeyframe?.items ?? [],
    );
    const precedingTruthOrdinals = (precedingKeyframe?.items ?? [])
      .map((itemId, ordinal) => ({ itemId, ordinal }))
      .filter((entry) => entry.itemId === label.itemId)
      .map((entry) => entry.ordinal);
    const interveningItemEvents = allItemEvents.filter(
      (event) =>
        event.participantId === label.participantId &&
        event.timestamp > (precedingKeyframe?.timestampMillis ?? Number.NEGATIVE_INFINITY) + 1 &&
        event.timestamp < label.timestamp - 1,
    );
    const interveningRemovalContexts = removalContexts.filter(
      (context) =>
        context.channel === 1 &&
        context.blockParam - PROFILE.championOwnerBase === label.participantId &&
        context.timestampMillis >
          (precedingKeyframe?.timestampMillis ?? Number.NEGATIVE_INFINITY) + 1 &&
        context.timestampMillis < label.timestamp - 1,
    );
    const interveningAdds = adds.filter(
      (add) =>
        add.participantId === label.participantId &&
        add.timestampMillis >
          (precedingKeyframe?.timestampMillis ?? Number.NEGATIVE_INFINITY) + 1 &&
        add.timestampMillis < label.timestamp - 1,
    );
    const interveningRemovals = removals.filter(
      (removal) =>
        removal.channel === 1 &&
        removal.blockParam - PROFILE.championOwnerBase === label.participantId &&
        removal.timestampMillis >
          (precedingKeyframe?.timestampMillis ?? Number.NEGATIVE_INFINITY) + 1 &&
        removal.timestampMillis < label.timestamp - 1,
    );
    const interveningUndoComponents = undoComponents.filter(
      (component) =>
        component.channel === 1 &&
        component.blockParam - PROFILE.championOwnerBase === label.participantId &&
        component.timestampMillis >
          (precedingKeyframe?.timestampMillis ?? Number.NEGATIVE_INFINITY) + 1 &&
        component.timestampMillis < label.timestamp - 1,
    );
    const removalPayload = Buffer.from(block.contentHex, "hex");
    const candidateSlot = decodeRemovalSlot(removalPayload);
    const candidateRecordOrdinal =
      candidateSlot !== null && candidateSlot >= 0 && candidateSlot <= 5
        ? 5 - candidateSlot
        : null;
    const candidateItemId =
      candidateRecordOrdinal === null
        ? null
        : (precedingKeyframe?.records[candidateRecordOrdinal]?.itemId ?? null);
    rows.push({
      replayId,
      partition,
      participantId: label.participantId,
      timestampMillis: label.timestamp,
      itemId: label.itemId,
      sellGain,
      contentLength: block.contentLength,
      payloadHex: block.contentHex,
      payload: removalPayload,
      priorMatchingAddCount: priorMatchingAdds.length,
      pairedAddPayload: priorMatchingAdds.length === 1 ? priorMatchingAdds[0].payload : null,
      pairedAddPayloadHex: priorMatchingAdds.length === 1 ? priorMatchingAdds[0].payloadHex : null,
      precedingKeyframeItems: precedingKeyframe?.items ?? [],
      precedingKeyframeTimestampMillis: precedingKeyframe?.timestampMillis ?? null,
      interveningItemEventCount: interveningItemEvents.length,
      interveningItemEventTypes: interveningItemEvents.map((event) => event.type),
      interveningRemovalContextCount: interveningRemovalContexts.length,
      interveningAddCount: interveningAdds.length,
      interveningRemovalCount: interveningRemovals.length,
      interveningUndoComponentCount: interveningUndoComponents.length,
      interveningRelevantOperationCount:
        interveningAdds.length +
        interveningRemovals.length +
        interveningRemovalContexts.length +
        interveningUndoComponents.length,
      candidateSlot,
      candidateRecordOrdinal,
      candidateItemId,
      precedingTruthOrdinals,
      keyframeTruthOrdinal: precedingTruthOrdinals.length === 1 ? precedingTruthOrdinals[0] : null,
      precedingKeyframeRecords: precedingKeyframe?.records ?? [],
      followingKeyframeItems: followingKeyframe?.items ?? [],
      disappearedKeyframeItems,
    });
  }
  return rows;
}

function bitValue(payload, start, width, reversed) {
  let value = 0;
  for (let ordinal = 0; ordinal < width; ordinal += 1) {
    const bitIndex = start + ordinal;
    const bit = (payload[bitIndex >> 3] >> (bitIndex & 7)) & 1;
    const outputBit = reversed ? width - 1 - ordinal : ordinal;
    value |= bit << outputBit;
  }
  return value;
}

function featureKey(row, candidate) {
  if (candidate.start + candidate.width > row.payload.length * 8) return null;
  return `${row.contentLength}:${bitValue(
    row.payload,
    candidate.start,
    candidate.width,
    candidate.reversed,
  )}`;
}

function trainLookup(rows, candidate, labelField) {
  const labelsByKey = new Map();
  for (const row of rows) {
    const key = featureKey(row, candidate);
    if (key === null) continue;
    const labels = labelsByKey.get(key) ?? new Set();
    labels.add(row[labelField]);
    labelsByKey.set(key, labels);
  }
  const lookup = new Map(
    [...labelsByKey]
      .filter(([, labels]) => labels.size === 1)
      .map(([key, labels]) => [key, [...labels][0]]),
  );
  return { labelsByKey, lookup };
}

function scoreLookup(rows, candidate, labelField, lookup) {
  let exact = 0;
  let wrong = 0;
  let unavailable = 0;
  const wrongSamples = [];
  for (const row of rows) {
    const key = featureKey(row, candidate);
    const decoded = key === null ? undefined : lookup.get(key);
    if (decoded === undefined) unavailable += 1;
    else if (decoded === row[labelField]) exact += 1;
    else {
      wrong += 1;
      if (wrongSamples.length < 5) {
        wrongSamples.push({
          replayId: row.replayId,
          itemId: row.itemId,
          sellGain: row.sellGain,
          key,
          decoded,
        });
      }
    }
  }
  return { total: rows.length, exact, wrong, unavailable, wrongSamples };
}

function candidateSearch(
  discoveryRows,
  holdoutRows,
  labelField,
  { maxWidth = 8, maxInputBits = 56, resultLimit = 20 } = {},
) {
  const candidates = [];
  for (let width = 1; width <= maxWidth; width += 1) {
    for (let start = 0; start + width <= maxInputBits; start += 1) {
      for (const reversed of [false, true]) {
        const candidate = { start, width, reversed };
        const trained = trainLookup(discoveryRows, candidate, labelField);
        const discovery = scoreLookup(discoveryRows, candidate, labelField, trained.lookup);
        const domainCount = trained.labelsByKey.size;
        const conflictKeyCount = [...trained.labelsByKey.values()].filter(
          (labels) => labels.size > 1,
        ).length;
        candidates.push({
          ...candidate,
          domainCount,
          conflictKeyCount,
          lookup: Object.fromEntries([...trained.lookup].sort()),
          discovery,
        });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.discovery.exact - left.discovery.exact ||
      left.discovery.wrong - right.discovery.wrong ||
      left.conflictKeyCount - right.conflictKeyCount ||
      left.domainCount - right.domainCount ||
      left.width - right.width ||
      left.start - right.start ||
      Number(left.reversed) - Number(right.reversed),
  );
  return candidates.slice(0, resultLimit).map((candidate) => ({
    ...candidate,
    holdout: scoreLookup(
      holdoutRows,
      candidate,
      labelField,
      new Map(Object.entries(candidate.lookup)),
    ),
  }));
}

function scoreLinkage(rows, candidate) {
  let exact = 0;
  let wrong = 0;
  for (const row of rows) {
    const addValue = bitValue(row.pairedAddPayload, candidate.addStart, candidate.width, false);
    const removalValue = bitValue(row.payload, candidate.removalStart, candidate.width, false);
    if ((addValue ^ removalValue) === candidate.xorConstant) exact += 1;
    else wrong += 1;
  }
  return { total: rows.length, exact, wrong };
}

function linkageSearch(discoveryRows, holdoutRows) {
  const candidates = [];
  for (let width = 1; width <= 8; width += 1) {
    for (let addStart = 0; addStart + width <= 112; addStart += 1) {
      for (let removalStart = 0; removalStart + width <= 48; removalStart += 1) {
        const xorCounts = new Map();
        const addValues = new Set();
        const removalValues = new Set();
        for (const row of discoveryRows) {
          const addValue = bitValue(row.pairedAddPayload, addStart, width, false);
          const removalValue = bitValue(row.payload, removalStart, width, false);
          const xorValue = addValue ^ removalValue;
          xorCounts.set(xorValue, (xorCounts.get(xorValue) ?? 0) + 1);
          addValues.add(addValue);
          removalValues.add(removalValue);
        }
        const bestXor = [...xorCounts].sort(
          (left, right) => right[1] - left[1] || left[0] - right[0],
        )[0];
        const candidate = {
          width,
          addStart,
          removalStart,
          bestXorConstant: bestXor[0],
          xorConstant: xorCounts.size === 1 ? bestXor[0] : null,
          discoveryXorDomainCount: xorCounts.size,
          addValueDomainCount: addValues.size,
          removalValueDomainCount: removalValues.size,
        };
        candidates.push({ ...candidate, discoveryBestConstantExact: bestXor[1] });
      }
    }
  }
  const nonconstant = candidates.filter(
    (candidate) => candidate.addValueDomainCount > 1 && candidate.removalValueDomainCount > 1,
  );
  nonconstant.sort(
    (left, right) =>
      right.discoveryBestConstantExact - left.discoveryBestConstantExact ||
      right.width - left.width ||
      right.addValueDomainCount - left.addValueDomainCount ||
      right.removalValueDomainCount - left.removalValueDomainCount ||
      left.addStart - right.addStart ||
      left.removalStart - right.removalStart,
  );
  return nonconstant.slice(0, 30).map((candidate) => ({
    ...candidate,
    discovery: scoreLinkage(discoveryRows, {
      ...candidate,
      xorConstant: candidate.bestXorConstant,
    }),
    holdout: scoreLinkage(holdoutRows, {
      ...candidate,
      xorConstant: candidate.bestXorConstant,
    }),
  }));
}

function scoreRecordLinkage(rows, candidate) {
  let exact = 0;
  let wrong = 0;
  let unavailable = 0;
  const wrongSamples = [];
  for (const row of rows) {
    if (candidate.removalStart + candidate.width > row.payload.length * 8) {
      unavailable += 1;
      continue;
    }
    const removalValue = bitValue(row.payload, candidate.removalStart, candidate.width, false);
    const matchingOrdinals = row.precedingKeyframeRecords
      .filter((record) => candidate.recordStart + candidate.width <= record.payload.length * 8)
      .filter(
        (record) =>
          (bitValue(
            record.payload,
            candidate.recordStart,
            candidate.width,
            candidate.recordReversed,
          ) ^
            removalValue) ===
          candidate.xorConstant,
      )
      .map((record) => record.ordinal);
    if (matchingOrdinals.length === 1 && matchingOrdinals[0] === row.keyframeTruthOrdinal) {
      exact += 1;
    } else if (matchingOrdinals.length === 1) {
      wrong += 1;
      if (wrongSamples.length < 5) {
        wrongSamples.push({
          replayId: row.replayId,
          itemId: row.itemId,
          truthOrdinal: row.keyframeTruthOrdinal,
          selectedOrdinal: matchingOrdinals[0],
        });
      }
    } else unavailable += 1;
  }
  return { total: rows.length, exact, wrong, unavailable, wrongSamples };
}

function recordLinkageSearch(discoveryRows, holdoutRows) {
  const candidates = [];
  for (let width = 1; width <= 16; width += 1) {
    for (let removalStart = 0; removalStart + width <= 48; removalStart += 1) {
      for (let recordStart = 0; recordStart + width <= 104; recordStart += 1) {
        for (const recordReversed of [false, true]) {
          const xorValues = new Set(
            discoveryRows.map((row) => {
              const truthRecord = row.precedingKeyframeRecords[row.keyframeTruthOrdinal];
              return (
                bitValue(truthRecord.payload, recordStart, width, recordReversed) ^
                bitValue(row.payload, removalStart, width, false)
              );
            }),
          );
          if (xorValues.size !== 1) continue;
          const candidate = {
            width,
            removalStart,
            recordStart,
            recordReversed,
            xorConstant: [...xorValues][0],
          };
          candidates.push({
            ...candidate,
            discovery: scoreRecordLinkage(discoveryRows, candidate),
          });
        }
      }
    }
  }
  candidates.sort(
    (left, right) =>
      right.discovery.exact - left.discovery.exact ||
      left.discovery.wrong - right.discovery.wrong ||
      left.discovery.unavailable - right.discovery.unavailable ||
      right.width - left.width ||
      left.removalStart - right.removalStart ||
      left.recordStart - right.recordStart,
  );
  return candidates.slice(0, 40).map((candidate) => ({
    ...candidate,
    holdout: scoreRecordLinkage(holdoutRows, candidate),
  }));
}

function countsBy(rows, field) {
  const counts = new Map();
  for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
  return Object.fromEntries([...counts].sort((left, right) => left[0] - right[0]));
}

function isFreshSaleIdentityCandidate(row) {
  const ageMillis = row.timestampMillis - row.precedingKeyframeTimestampMillis;
  return (
    Number.isInteger(row.candidateItemId) &&
    row.candidateItemId > 0 &&
    ageMillis >= 0 &&
    ageMillis <= 30_000
  );
}

function scoreFreshSaleIdentity(rows) {
  const selected = rows.filter(isFreshSaleIdentityCandidate);
  return {
    candidateCount: selected.length,
    exactCount: selected.filter((row) => row.candidateItemId === row.itemId).length,
    wrongCount: selected.filter((row) => row.candidateItemId !== row.itemId).length,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const items = loadStaticItems(args.itemDataPath);
  const rows = [
    ...PROFILE.discovery.flatMap((replayId) => inspectReplay(args, replayId, "D7", items)),
    ...PROFILE.holdout.flatMap((replayId) => inspectReplay(args, replayId, "H3", items)),
  ];
  const discovery = rows.filter((row) => row.partition === "D7");
  const holdout = rows.filter((row) => row.partition === "H3");
  if (discovery.length !== 77 || holdout.length !== 39) {
    fail("Fixed sale label counts drifted.", {
      discovery: discovery.length,
      holdout: holdout.length,
    });
  }
  const sellGainCandidates = candidateSearch(discovery, holdout, "sellGain");
  const itemIdCandidates = candidateSearch(discovery, holdout, "itemId");
  const discoveryOrdinalRows = discovery.filter((row) => row.keyframeTruthOrdinal !== null);
  const holdoutOrdinalRows = holdout.filter((row) => row.keyframeTruthOrdinal !== null);
  const keyframeOrdinalCandidates = candidateSearch(
    discoveryOrdinalRows,
    holdoutOrdinalRows,
    "keyframeTruthOrdinal",
    { maxWidth: 4, resultLimit: 40 },
  );
  const discoveryPairs = discovery.filter((row) => row.pairedAddPayload !== null);
  const holdoutPairs = holdout.filter((row) => row.pairedAddPayload !== null);
  const addRemovalLinkageCandidates = linkageSearch(discoveryPairs, holdoutPairs);
  const keyframeRecordLinkageCandidates = recordLinkageSearch(
    discoveryOrdinalRows,
    holdoutOrdinalRows,
  );
  const lengthSelectsOrdinalHalf = (row) =>
    (row.contentLength === 7 && row.keyframeTruthOrdinal < 3) ||
    (row.contentLength === 6 && row.keyframeTruthOrdinal >= 3);
  const discoveryFresh = scoreFreshSaleIdentity(discovery);
  const holdoutFresh = scoreFreshSaleIdentity(holdout);
  const actual = {
    discoverySaleCount: discovery.length,
    holdoutSaleCount: holdout.length,
    discoveryUniquePriorAddPairs: discoveryPairs.length,
    holdoutUniquePriorAddPairs: holdoutPairs.length,
    discoveryPrecedingContainsTruth: discovery.filter((row) =>
      row.precedingKeyframeItems.includes(row.itemId),
    ).length,
    holdoutPrecedingContainsTruth: holdout.filter((row) =>
      row.precedingKeyframeItems.includes(row.itemId),
    ).length,
    discoveryUniqueTruthOrdinalRows: discoveryOrdinalRows.length,
    holdoutUniqueTruthOrdinalRows: holdoutOrdinalRows.length,
    discoveryLengthSelectsOrdinalHalf: discoveryOrdinalRows.filter(lengthSelectsOrdinalHalf).length,
    holdoutLengthSelectsOrdinalHalf: holdoutOrdinalRows.filter(lengthSelectsOrdinalHalf).length,
    discoveryDisappearedContainsTruth: discovery.filter((row) =>
      row.disappearedKeyframeItems.includes(row.itemId),
    ).length,
    holdoutDisappearedContainsTruth: holdout.filter((row) =>
      row.disappearedKeyframeItems.includes(row.itemId),
    ).length,
    discoveryFreshCandidateCount: discoveryFresh.candidateCount,
    discoveryFreshExactCount: discoveryFresh.exactCount,
    discoveryFreshWrongCount: discoveryFresh.wrongCount,
    holdoutFreshCandidateCount: holdoutFresh.candidateCount,
    holdoutFreshExactCount: holdoutFresh.exactCount,
    holdoutFreshWrongCount: holdoutFresh.wrongCount,
  };
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
    fail("Frozen sale identity research metrics drifted.", {
      expected: EXPECTED,
      actual,
    });
  }
  const output = {
    schema: "rofl-inventory-sale-identity-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
    counts: {
      discovery: discovery.length,
      holdout: holdout.length,
      itemIds: countsBy(rows, "itemId"),
      sellGains: countsBy(rows, "sellGain"),
      uniquePriorAddPairs: {
        discovery: discoveryPairs.length,
        holdout: holdoutPairs.length,
      },
      keyframeShopCandidateCoverage: {
        discoveryPrecedingContainsTruth: discovery.filter((row) =>
          row.precedingKeyframeItems.includes(row.itemId),
        ).length,
        discoveryDisappearedContainsTruth: discovery.filter((row) =>
          row.disappearedKeyframeItems.includes(row.itemId),
        ).length,
        holdoutPrecedingContainsTruth: holdout.filter((row) =>
          row.precedingKeyframeItems.includes(row.itemId),
        ).length,
        holdoutDisappearedContainsTruth: holdout.filter((row) =>
          row.disappearedKeyframeItems.includes(row.itemId),
        ).length,
        uniqueTruthOrdinalRows: {
          discovery: discoveryOrdinalRows.length,
          holdout: holdoutOrdinalRows.length,
        },
        lengthSelectsOrdinalHalf: {
          discovery: actual.discoveryLengthSelectsOrdinalHalf,
          holdout: actual.holdoutLengthSelectsOrdinalHalf,
        },
        truthOrdinals: {
          discovery: countsBy(discoveryOrdinalRows, "keyframeTruthOrdinal"),
          holdout: countsBy(holdoutOrdinalRows, "keyframeTruthOrdinal"),
        },
      },
    },
    boundedSearch:
      "One raw contiguous removal-payload bit window, width 1..8, both bit orders, keyed with content length. Lookup is selected and frozen on D7; H3 is evaluation only. Unseen or D7-conflicting symbols are unavailable.",
    sellGainCandidates,
    itemIdCandidates,
    keyframeOrdinalCandidates,
    addRemovalLinkageCandidates,
    keyframeRecordLinkageCandidates,
    freshSaleIdentityCandidate: {
      maxPrecedingKeyframeAgeMillis: 30_000,
      replayOnlyRule:
        "Decode the 0x03F9 candidate slot, select reverse 0x0081 record ordinal 5-slot from the preceding same-owner keyframe component, require one catalog-valid item ID, and fail closed when the sale is more than 30 seconds after that component timestamp.",
      discovery: discoveryFresh,
      holdout: holdoutFresh,
      slotCounts: {
        discovery: countsBy(discovery.filter(isFreshSaleIdentityCandidate), "candidateSlot"),
        holdout: countsBy(holdout.filter(isFreshSaleIdentityCandidate), "candidateSlot"),
      },
      rows: rows.filter(isFreshSaleIdentityCandidate).map(
        ({ payload: _payload, pairedAddPayload: _pairedAddPayload, ...row }) => row,
      ),
    },
    labelledRows: rows.map(
      ({ payload: _payload, pairedAddPayload: _pairedAddPayload, ...row }) => ({
        ...row,
        precedingKeyframeRecords: row.precedingKeyframeRecords.map(
          ({ payload: _recordPayload, ...record }) => record,
        ),
      }),
    ),
    conclusion:
      "The preceding six-record shop-history component contains the sold item for 112/116 sales, and removal length partitions all 111 unique truth ordinals into record halves on D7 and H3. A replay-only 30-second freshness gate over the candidate removal slot and reverse record ordinal yields 36/36 exact D7 and 13/13 exact frozen-H3 sold identities with all six main slots represented in Discovery. It remains research-only pending a profile-backed C++ implementation and full-corpus promotion; older candidates, raw item/gain/ordinal lookups, add/removal XOR, and direct record/removal XOR still fail closed.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        frozenMetrics: actual,
        holdoutFailures: {
          rawSellGainWrong: sellGainCandidates[0]?.holdout.wrong ?? null,
          rawItemIdWrong: itemIdCandidates[0]?.holdout.wrong ?? null,
          rawKeyframeOrdinalWrong: keyframeOrdinalCandidates[0]?.holdout.wrong ?? null,
          recordLinkageExact: keyframeRecordLinkageCandidates[0]?.holdout.exact ?? null,
        },
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outputPath}`);
}

main();
