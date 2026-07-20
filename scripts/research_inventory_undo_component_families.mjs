#!/usr/bin/env node

// Offline research only. This harness reads saved ROFL packet blocks. Saved
// Riot timelines are used only after extraction as labels for falsification.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CHAMPION_OWNER_BASE = 0x400000ad;
const TIMESTAMP_TOLERANCE_MS = 1;
const EXACT_BUILD_16_14 = "16.14.794.5912";
const FRESH_SALE_MAX_AGE_MS = 30_000;
const DISCOVERY_16_14 = new Set([
  "EUW1-7919517389",
  "EUW1-7919624327",
  "EUW1-7920241664",
  "EUW1-7920292147",
  "EUW1-7920341366",
  "EUW1-7920364492",
  "EUW1-7920550565",
]);
const STATIC_ITEM_SCHEMA = Object.freeze({
  version: "16.14.1",
  byteLength: 583139,
  sha256: "0094f848489371da9e86b9f210f70b6ce0a3982c9063c7c734099cd5a88ddb75",
});
const EXPECTED_SALE_UNDO_IDENTITY = Object.freeze({
  discovery: Object.freeze({ rowCount: 23, candidateCount: 6, exactCount: 6, wrongCount: 0 }),
  holdout: Object.freeze({ rowCount: 8, candidateCount: 3, exactCount: 3, wrongCount: 0 }),
  combined: Object.freeze({ rowCount: 31, candidateCount: 9, exactCount: 9, wrongCount: 0 }),
});

const PROFILES = Object.freeze({
  "16.9": Object.freeze({
    versionGroup: "16.9",
    packetType: 0x0165,
    channel: 1,
    dumpSegmentType: "all",
    candidateSegmentType: "chunk",
    expected: Object.freeze({
      replayCount: 20,
      undoLabelCount: 147,
      candidateBlockCount: 78,
      ownerMatchedBlockCount: 78,
      falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 78,
      minimumContentLength: 67,
      maximumContentLength: 245,
      keyframeOwnerBlockCount: 5720,
      allSegmentOwnerBlockCount: 5798,
    }),
  }),
  "16.14": Object.freeze({
    versionGroup: "16.14",
    packetType: 0x0081,
    channel: 1,
    dumpSegmentType: "all",
    candidateSegmentType: "chunk",
    expected: Object.freeze({
      replayCount: 10,
      undoLabelCount: 62,
      candidateBlockCount: 31,
      ownerMatchedBlockCount: 31,
      falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 31,
      minimumContentLength: 68,
      maximumContentLength: 146,
      keyframeOwnerBlockCount: 3200,
      allSegmentOwnerBlockCount: 3231,
    }),
  }),
});

function parseArgs(argv) {
  const args = {
    profile: null,
    cliPath: path.join(
      process.platform === "win32" ? "build" : "build-linux",
      "packages",
      "rofl-core",
      process.platform === "win32" ? "rofl_core_cli.exe" : "rofl_core_cli",
    ),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    decoderProfilesPath: path.join(
      "packages",
      "rofl-core",
      "profiles",
      "replay-decoder-profiles.v1.json",
    ),
    itemDataPath: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile" && index + 1 < argv.length) args.profile = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--decoder-profiles" && index + 1 < argv.length) args.decoderProfilesPath = argv[++index];
    else if (arg === "--item-data" && index + 1 < argv.length) args.itemDataPath = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/research_inventory_undo_component_families.mjs --profile 16.9|16.14 [--item-data <Data-Dragon-16.14.1-item.json>] [--decoder-profiles <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!PROFILES[args.profile]) throw new Error(`--profile must be one of: ${Object.keys(PROFILES).join(", ")}`);
  if (args.profile === "16.14" && !args.itemDataPath) {
    throw new Error("--item-data is required for the 16.14 sale-Undo identity gate; latest/network lookup is forbidden.");
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function hex(value, width = 4) {
  return `0x${value.toString(16).padStart(width, "0").toUpperCase()}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadStaticItemIds(filePath) {
  const bytes = fs.readFileSync(path.resolve(filePath));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== STATIC_ITEM_SCHEMA.byteLength || sha256 !== STATIC_ITEM_SCHEMA.sha256) {
    throw new Error(`Pinned item catalog fingerprint failed: ${bytes.length} bytes, ${sha256}`);
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.version !== STATIC_ITEM_SCHEMA.version || typeof parsed.data !== "object") {
    throw new Error("Pinned item catalog schema failed.");
  }
  return new Set(Object.keys(parsed.data).map(Number));
}

function runJson(command, arguments_, maxBuffer = 256 * 1024 * 1024) {
  const result = spawnSync(command, arguments_, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(result.stderr || `Command failed: ${arguments_.join(" ")}`);
  }
  return JSON.parse(result.stdout);
}

function collectFixtures(replayDir, apiRoot, profile) {
  return fs.readdirSync(replayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => {
      const replayId = path.basename(entry.name, ".rofl");
      const fixtureDir = path.join(apiRoot, replayId.replaceAll("-", "_"));
      const matchPath = path.join(fixtureDir, "match.json");
      const timelinePath = path.join(fixtureDir, "timeline.json");
      if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) return null;
      const match = readJson(matchPath);
      if (versionGroup(match.info?.gameVersion) !== profile.versionGroup) return null;
      return { replayId, replayPath: path.join(replayDir, entry.name), matchPath, timelinePath, gameVersion: match.info?.gameVersion ?? null };
    })
    .filter(Boolean)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function collectUndoLabels(timelinePath, replayId) {
  const timeline = readJson(timelinePath);
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_UNDO" && Number.isFinite(event.participantId) && Number.isFinite(event.timestamp))
    .map((event, index) => ({
      id: `${replayId}:${index}`,
      replayId,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      beforeId: event.beforeId ?? null,
      afterId: event.afterId ?? null,
      goldGain: event.goldGain ?? null,
    }));
}

function dumpProfileBlocks(cliPath, fixture, profile) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", fixture.replayPath,
    "--packet-type", String(profile.packetType),
    "--segment-type", profile.dumpSegmentType,
    "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? new Error(result.stderr || `Packet dump failed for ${fixture.replayId}`);
  const dump = JSON.parse(result.stdout);
  if (dump.schema !== "packet-types-dump.v1" || dump.valid !== true) throw new Error(`Unexpected packet dump for ${fixture.replayId}`);
  return (dump.packetTypeDumps ?? []).flatMap((packetDump) => packetDump.blocks ?? [])
    .filter((block) => block.packetType === profile.packetType && block.channel === profile.channel)
    .map((block) => ({
      replayId: fixture.replayId,
      packetType: block.packetType,
      channel: block.channel,
      segmentType: block.segmentType,
      segmentId: block.segmentId,
      chunkId: block.chunkId,
      timestampMillis: block.timestampMillis,
      blockParam: block.blockParam,
      participantId: block.blockParam - CHAMPION_OWNER_BASE,
      contentLength: block.contentLength,
      contentHex: block.contentHex,
    }));
}

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

function inputCode(payload, bits) {
  return bits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

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

function itemPositions(contentHex, itemId) {
  if (!Number.isInteger(itemId) || itemId <= 0) return [];
  const payload = Buffer.from(contentHex, "hex");
  const positions = [];
  for (let position = 0; position + 1 < payload.length; position += 1) {
    if (decodeItemPair(payload[position], payload[position + 1]) === itemId) positions.push(position);
  }
  return positions;
}

function shopRecordStarts(contentHex) {
  const payload = Buffer.from(contentHex, "hex");
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

function positionRecords(contentHex, positions) {
  const payloadLength = Buffer.from(contentHex, "hex").length;
  const starts = shopRecordStarts(contentHex);
  return positions.map((position) => {
    const ordinal = starts.findLastIndex((start) => start <= position);
    const start = ordinal === -1 ? null : starts[ordinal];
    const end = ordinal === -1 ? null : (starts[ordinal + 1] ?? payloadLength);
    return {
      position,
      recordOrdinal: ordinal === -1 ? null : ordinal,
      recordRelativeOffset: start === null ? null : position - start,
      recordContentLength: start === null ? null : end - start,
    };
  });
}

function decodedShopRecordItems(contentHex) {
  const payload = Buffer.from(contentHex, "hex");
  const starts = shopRecordStarts(contentHex);
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
          .map((offset) => decodeItemPair(payload[start + offset], payload[start + offset + 1]))
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0),
      ),
    ];
    return { ordinal, contentLength, itemIds: candidates };
  });
}

function multisetDifference(left, right) {
  const remaining = [...right];
  return left.filter((value) => {
    const index = remaining.indexOf(value);
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

function oneCatalogItem(record, validItemIds) {
  const candidates = [...new Set(record.itemIds.filter((itemId) => validItemIds.has(itemId)))];
  return candidates.length === 1 ? candidates[0] : null;
}

function loadProductiveSales(args, fixture) {
  const decoded = runJson(args.cliPath, [
    "--extract-replay-item-sales-json",
    fixture.replayPath,
    "--decoder-profiles",
    args.decoderProfilesPath,
  ]);
  if (
    decoded.schema !== "rofl-replay-item-sales/v1" ||
    decoded.gameVersion !== EXACT_BUILD_16_14 ||
    decoded.source?.runtimeInput !== "rofl-only" ||
    decoded.source?.riotApiInput !== false
  ) {
    throw new Error(`Productive replay-only sale stream gate failed for ${fixture.replayId}.`);
  }
  return decoded.events;
}

function freshSaleIdentityCandidates(args, fixture, keyframeBlocks, validItemIds) {
  const removalProfile = {
    packetType: 0x03f9,
    channel: 1,
    dumpSegmentType: "chunk",
  };
  const removals = dumpProfileBlocks(args.cliPath, fixture, removalProfile);
  const sales = loadProductiveSales(args, fixture);
  return sales.flatMap((sale) => {
    const matchingRemovals = removals.filter(
      (block) =>
        block.participantId === sale.participantId &&
        Math.abs(block.timestampMillis - sale.timestampMillis) <= TIMESTAMP_TOLERANCE_MS,
    );
    if (matchingRemovals.length !== 1) {
      throw new Error(`Productive sale removal association is not unique for ${fixture.replayId}.`);
    }
    const removal = matchingRemovals[0];
    const candidateSlot = decodeRemovalSlot(Buffer.from(removal.contentHex, "hex"));
    const candidateRecordOrdinal =
      candidateSlot !== null && candidateSlot >= 0 && candidateSlot <= 5
        ? 5 - candidateSlot
        : null;
    const precedingKeyframe = keyframeBlocks
      .filter(
        (block) =>
          block.replayId === fixture.replayId &&
          block.participantId === sale.participantId &&
          block.timestampMillis <= sale.timestampMillis,
      )
      .sort((left, right) => left.timestampMillis - right.timestampMillis)
      .at(-1);
    const record =
      candidateRecordOrdinal === null || !precedingKeyframe
        ? null
        : decodedShopRecordItems(precedingKeyframe.contentHex)[candidateRecordOrdinal];
    const candidateItemId = record ? oneCatalogItem(record, validItemIds) : null;
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
    return [{
      replayId: fixture.replayId,
      participantId: sale.participantId,
      timestampMillis: sale.timestampMillis,
      candidateSlot,
      candidateRecordOrdinal,
      candidateItemId,
      precedingKeyframeTimestampMillis: precedingKeyframe.timestampMillis,
      keyframeAgeMillis,
    }];
  });
}

function saleUndoIdentityResearch(itemGrammar, freshSales) {
  const rows = itemGrammar.rows.map((row) => {
    const candidates = freshSales.filter(
      (sale) =>
        sale.replayId === row.replayId &&
        sale.participantId === row.participantId &&
        sale.timestampMillis <= row.timestampMillis &&
        row.timestampMillis - sale.timestampMillis <= FRESH_SALE_MAX_AGE_MS &&
        row.chunkItems.filter((itemId) => itemId === sale.candidateItemId).length === 1,
    );
    const candidateItemIds = [...new Set(candidates.map((sale) => sale.candidateItemId))];
    const candidateItemId = candidateItemIds.length === 1 ? candidateItemIds[0] : null;
    return {
      replayId: row.replayId,
      partition: DISCOVERY_16_14.has(row.replayId) ? "D7" : "H3",
      participantId: row.participantId,
      timestampMillis: row.timestampMillis,
      candidateItemId,
      candidateSaleCount: candidates.length,
      offlineTruthAfterId: row.afterId,
      validation:
        candidateItemId === null
          ? "UNAVAILABLE"
          : candidateItemId === row.afterId
            ? "EXACT"
            : "WRONG",
    };
  });
  const summarize = (selected) => ({
    rowCount: selected.length,
    candidateCount: selected.filter((row) => row.candidateItemId !== null).length,
    exactCount: selected.filter((row) => row.validation === "EXACT").length,
    wrongCount: selected.filter((row) => row.validation === "WRONG").length,
  });
  const metrics = {
    discovery: summarize(rows.filter((row) => row.partition === "D7")),
    holdout: summarize(rows.filter((row) => row.partition === "H3")),
    combined: summarize(rows),
  };
  return {
    maxSaleToUndoAgeMillis: FRESH_SALE_MAX_AGE_MS,
    replayOnlyRule:
      "Select a productive replay-native sale whose fresh preceding-keyframe slot candidate occurs exactly once in the later same-owner 0x0081 Undo record set; require one unique item identity across candidates and otherwise fail closed.",
    oracleRole:
      "Saved Timeline ITEM_UNDO.afterId is opened only after candidate extraction to count exact, wrong, and unavailable identities.",
    expected: EXPECTED_SALE_UNDO_IDENTITY,
    metrics,
    rows,
  };
}

function undoItemGrammarResearch(blocks, labels, keyframeBlocks) {
  const rows = blocks.map((block) => {
    const matches = labels.filter((label) => isOwnerTimestampMatch(block, label));
    if (matches.length !== 1) throw new Error("Undo block label association is not unique.");
    const label = matches[0];
    const beforePositions = itemPositions(block.contentHex, label.beforeId);
    const afterPositions = itemPositions(block.contentHex, label.afterId);
    const ownerKeyframes = keyframeBlocks
      .filter(
        (candidate) =>
          candidate.replayId === block.replayId && candidate.participantId === block.participantId,
      )
      .sort((left, right) => left.timestampMillis - right.timestampMillis);
    const precedingKeyframe = ownerKeyframes.findLast(
      (candidate) => candidate.timestampMillis <= block.timestampMillis,
    );
    const followingKeyframe = ownerKeyframes.find(
      (candidate) => candidate.timestampMillis > block.timestampMillis,
    );
    const chunkRecords = decodedShopRecordItems(block.contentHex);
    const chunkItems = chunkRecords.flatMap((record) => record.itemIds);
    const precedingItems = precedingKeyframe
      ? decodedShopRecordItems(precedingKeyframe.contentHex).flatMap((record) => record.itemIds)
      : [];
    const followingItems = followingKeyframe
      ? decodedShopRecordItems(followingKeyframe.contentHex).flatMap((record) => record.itemIds)
      : [];
    return {
      replayId: block.replayId,
      participantId: block.participantId,
      timestampMillis: block.timestampMillis,
      contentLength: block.contentLength,
      beforeId: label.beforeId,
      afterId: label.afterId,
      goldGain: label.goldGain,
      recordCount: shopRecordStarts(block.contentHex).length,
      beforePositions,
      afterPositions,
      beforePositionRecords: positionRecords(block.contentHex, beforePositions),
      afterPositionRecords: positionRecords(block.contentHex, afterPositions),
      chunkRecords,
      chunkItems,
      precedingKeyframeTimestampMillis: precedingKeyframe?.timestampMillis ?? null,
      precedingItems,
      followingKeyframeTimestampMillis: followingKeyframe?.timestampMillis ?? null,
      followingItems,
      newSincePrecedingItems: multisetDifference(chunkItems, precedingItems),
      retainedIntoFollowingItems: chunkItems.filter((itemId) => followingItems.includes(itemId)),
    };
  });
  return {
    rowCount: rows.length,
    beforeAvailableCount: rows.filter((row) => row.beforePositions.length > 0).length,
    beforeUniqueCount: rows.filter((row) => row.beforePositions.length === 1).length,
    afterAvailableCount: rows.filter((row) => row.afterPositions.length > 0).length,
    afterUniqueCount: rows.filter((row) => row.afterPositions.length === 1).length,
    bothAvailableCount: rows.filter(
      (row) => row.beforePositions.length > 0 && row.afterPositions.length > 0,
    ).length,
    beforePositions: countBy(rows.flatMap((row) => row.beforePositions), (position) => position),
    afterPositions: countBy(rows.flatMap((row) => row.afterPositions), (position) => position),
    afterRecordRelativeOffsets: countBy(
      rows.flatMap((row) => row.afterPositionRecords),
      (entry) => `${entry.recordRelativeOffset}:${entry.recordContentLength}`,
    ),
    afterRecordOrdinals: countBy(
      rows.flatMap((row) => row.afterPositionRecords),
      (entry) => entry.recordOrdinal,
    ),
    restoredIdentityDelta: {
      labelledRowCount: rows.filter((row) => Number.isInteger(row.afterId) && row.afterId > 0)
        .length,
      targetInChunkRecordCount: rows.filter(
        (row) => row.afterId > 0 && row.chunkItems.includes(row.afterId),
      ).length,
      targetInNewSincePrecedingCount: rows.filter(
        (row) => row.afterId > 0 && row.newSincePrecedingItems.includes(row.afterId),
      ).length,
      uniqueNewSincePrecedingTargetCount: rows.filter(
        (row) =>
          row.afterId > 0 &&
          row.newSincePrecedingItems.length === 1 &&
          row.newSincePrecedingItems[0] === row.afterId,
      ).length,
      targetRetainedIntoFollowingCount: rows.filter(
        (row) => row.afterId > 0 && row.retainedIntoFollowingItems.includes(row.afterId),
      ).length,
    },
    rows,
  };
}

function isOwnerTimestampMatch(block, label) {
  return block.replayId === label.replayId
    && block.participantId === label.participantId
    && Math.abs(block.timestampMillis - label.timestampMillis) <= TIMESTAMP_TOLERANCE_MS;
}

function score(blocks, labels) {
  const positives = blocks.filter((block) => labels.some((label) => isOwnerTimestampMatch(block, label)));
  const matchedLabels = labels.filter((label) => blocks.some((block) => isOwnerTimestampMatch(block, label)));
  const falsePositives = blocks.length - positives.length;
  return {
    candidateBlockCount: blocks.length,
    ownerMatchedBlockCount: positives.length,
    falsePositiveBlockCount: falsePositives,
    matchedUndoLabelCount: matchedLabels.length,
    precision: blocks.length ? positives.length / blocks.length : 0,
    recall: labels.length ? matchedLabels.length / labels.length : 0,
  };
}

function leaveOneReplayOut(blocks, labels, replayIds) {
  const folds = replayIds.map((holdoutReplayId) => {
    const trainBlocks = blocks.filter((block) => block.replayId !== holdoutReplayId);
    const trainLabels = labels.filter((label) => label.replayId !== holdoutReplayId);
    const holdoutBlocks = blocks.filter((block) => block.replayId === holdoutReplayId);
    const holdoutLabels = labels.filter((label) => label.replayId === holdoutReplayId);
    const train = score(trainBlocks, trainLabels);
    // The type/channel/owner rule is profile-fixed. A fold without clean
    // training evidence fails closed instead of interpreting holdout bytes.
    const trainedExact = train.ownerMatchedBlockCount > 0 && train.falsePositiveBlockCount === 0;
    const holdout = trainedExact ? score(holdoutBlocks, holdoutLabels) : {
      candidateBlockCount: 0, ownerMatchedBlockCount: 0, falsePositiveBlockCount: 0,
      matchedUndoLabelCount: 0, precision: null, recall: 0,
    };
    return { holdoutReplayId, trainedExact, ...holdout };
  });
  const total = folds.reduce((current, fold) => ({
    candidateBlockCount: current.candidateBlockCount + fold.candidateBlockCount,
    ownerMatchedBlockCount: current.ownerMatchedBlockCount + fold.ownerMatchedBlockCount,
    falsePositiveBlockCount: current.falsePositiveBlockCount + fold.falsePositiveBlockCount,
    matchedUndoLabelCount: current.matchedUndoLabelCount + fold.matchedUndoLabelCount,
  }), { candidateBlockCount: 0, ownerMatchedBlockCount: 0, falsePositiveBlockCount: 0, matchedUndoLabelCount: 0 });
  return {
    ...total,
    precision: total.candidateBlockCount ? total.ownerMatchedBlockCount / total.candidateBlockCount : 0,
    recall: labels.length ? total.matchedUndoLabelCount / labels.length : 0,
    allTrainingFoldsExact: folds.every((fold) => fold.trainedExact),
    folds,
  };
}

function countBy(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = String(key(row));
    result.set(value, (result.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...result.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function main() {
  const args = parseArgs(process.argv);
  const profile = PROFILES[args.profile];
  const repoRoot = process.cwd();
  const cliPath = path.resolve(repoRoot, args.cliPath);
  args.cliPath = cliPath;
  const replayDir = path.resolve(repoRoot, args.replayDir);
  const apiRoot = path.resolve(repoRoot, args.apiRoot);
  args.decoderProfilesPath = path.resolve(repoRoot, args.decoderProfilesPath);
  if (args.itemDataPath) args.itemDataPath = path.resolve(repoRoot, args.itemDataPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  if (profile.versionGroup === "16.14" && !fs.existsSync(args.decoderProfilesPath)) {
    throw new Error(`Decoder profile bundle not found: ${args.decoderProfilesPath}`);
  }
  const validItemIds =
    profile.versionGroup === "16.14" ? loadStaticItemIds(args.itemDataPath) : null;
  const fixtures = collectFixtures(replayDir, apiRoot, profile);
  const labels = [];
  const blocks = [];
  const allOwnerBlocks = [];
  const keyframeOwnerBlocks = [];
  const freshSaleCandidates = [];
  const replayRows = [];
  for (const fixture of fixtures) {
    const replayLabels = collectUndoLabels(fixture.timelinePath, fixture.replayId);
    const replayDumpBlocks = dumpProfileBlocks(cliPath, fixture, profile);
    const replayOwnerBlocks = replayDumpBlocks.filter((block) => block.participantId >= 1 && block.participantId <= 10);
    const replayBlocks = replayOwnerBlocks.filter((block) => block.segmentType === profile.candidateSegmentType);
    const replayKeyframeBlocks = replayOwnerBlocks.filter((block) => block.segmentType === "keyframe");
    labels.push(...replayLabels);
    blocks.push(...replayBlocks);
    allOwnerBlocks.push(...replayOwnerBlocks);
    keyframeOwnerBlocks.push(...replayKeyframeBlocks);
    if (profile.versionGroup === "16.14") {
      freshSaleCandidates.push(
        ...freshSaleIdentityCandidates(args, fixture, replayKeyframeBlocks, validItemIds),
      );
    }
    replayRows.push({
      replayId: fixture.replayId,
      gameVersion: fixture.gameVersion,
      undoLabelCount: replayLabels.length,
      candidateBlockCount: replayBlocks.length,
      ownerMatchedBlockCount: score(replayBlocks, replayLabels).ownerMatchedBlockCount,
      falsePositiveBlockCount: score(replayBlocks, replayLabels).falsePositiveBlockCount,
      keyframeOwnerBlockCount: replayKeyframeBlocks.length,
      allSegmentOwnerBlockCount: replayOwnerBlocks.length,
    });
  }
  const total = score(blocks, labels);
  const expected = profile.expected;
  const actual = {
    replayCount: fixtures.length,
    undoLabelCount: labels.length,
    ...total,
    minimumContentLength: blocks.length ? Math.min(...blocks.map((block) => block.contentLength)) : null,
    maximumContentLength: blocks.length ? Math.max(...blocks.map((block) => block.contentLength)) : null,
    keyframeOwnerBlockCount: keyframeOwnerBlocks.length,
    allSegmentOwnerBlockCount: allOwnerBlocks.length,
  };
  const loro = leaveOneReplayOut(blocks, labels, fixtures.map((fixture) => fixture.replayId));
  const itemGrammar =
    profile.versionGroup === "16.14"
      ? undoItemGrammarResearch(blocks, labels, keyframeOwnerBlocks)
      : null;
  const saleUndoIdentity =
    profile.versionGroup === "16.14"
      ? saleUndoIdentityResearch(itemGrammar, freshSaleCandidates)
      : null;
  const saleUndoIdentityPass =
    saleUndoIdentity === null ||
    JSON.stringify(saleUndoIdentity.metrics) === JSON.stringify(EXPECTED_SALE_UNDO_IDENTITY);
  const expectedMatches = Object.entries(expected).every(([key, value]) => actual[key] === value);
  const exactnessPass = total.ownerMatchedBlockCount > 0 && total.falsePositiveBlockCount === 0 && total.precision === 1;
  const loroPass = loro.allTrainingFoldsExact && loro.falsePositiveBlockCount === 0 && loro.precision === 1;
  const passed = expectedMatches && exactnessPass && loroPass && saleUndoIdentityPass;
  const output = {
    schema: "rofl-inventory-undo-component-family-research/v1",
    generatedAtUtc: new Date().toISOString(),
    status: passed ? "research-validated-not-promoted" : "research-regression",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: {
      versionGroup: profile.versionGroup,
      packetType: hex(profile.packetType),
      channel: profile.channel,
      dumpSegmentType: profile.dumpSegmentType,
      candidateSegmentType: profile.candidateSegmentType,
      ownerFormula: `blockParam - ${hex(CHAMPION_OWNER_BASE)} == participantId`,
      timestampToleranceMillis: TIMESTAMP_TOLERANCE_MS,
    },
    methodology: {
      replayInput: "Exact-framed saved ROFL packet blocks only.",
      timelineRole: "Saved Riot Timeline ITEM_UNDO labels only, applied after replay extraction.",
      falsePositiveDefinition: "Any profile block without a same-replay, same-owner ITEM_UNDO label within +/-1 ms.",
    },
    expectedCorpus: expected,
    actualCorpus: actual,
    structuralSummary: {
      channels: countBy(blocks, (block) => block.channel),
      segmentTypes: countBy(blocks, (block) => block.segmentType),
      contentLengths: countBy(blocks, (block) => block.contentLength),
      ownerRangeBlockCount: blocks.filter((block) => block.participantId >= 1 && block.participantId <= 10).length,
      allSegmentTypes: countBy(allOwnerBlocks, (block) => block.segmentType),
      keyframeOwnerBlockCount: keyframeOwnerBlocks.length,
      allSegmentOwnerBlockCount: allOwnerBlocks.length,
    },
    leaveOneReplayOut: loro,
    replayRows,
    patchMapping: {
      priorPatch169ComponentFamily: "0x0165",
      currentPatch1614ComponentFamily: "0x0081",
      conclusion: "The profiles are exact undo-associated component families within their separate patch corpora, but are partial-coverage research evidence only.",
    },
    itemGrammarResearch: itemGrammar,
    saleUndoIdentityResearch: saleUndoIdentity,
    nonPromotionReason: "The exact sale-Undo subset restores only nine item identities; purchase Undo identity, complete slots/instances, remaining Undo labels, and full operation ordering are unresolved, so no runtime inventory API is authorized.",
    gates: { expectedMatches, exactnessPass, loroPass, saleUndoIdentityPass, passed },
  };
  const outputPath = path.resolve(repoRoot, args.outputPath ?? path.join("tmp", "research-inventory-undo-component-families", `${profile.versionGroup}.json`));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(`profile=${profile.versionGroup} packet=${hex(profile.packetType)} matches=${total.ownerMatchedBlockCount}/${labels.length} extras=${total.falsePositiveBlockCount} LORO=${loro.precision}/${loro.recall} passed=${passed}`);
  if (!passed) process.exitCode = 1;
}

main();
