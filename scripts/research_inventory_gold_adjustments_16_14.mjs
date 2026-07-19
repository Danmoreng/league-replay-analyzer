#!/usr/bin/env node

// Offline research only. Saved Timeline values and item events are validation
// labels and never runtime input. Numeric candidates always come from exact-
// build keyframe bytes; the required Data Dragon file is pinned static schema.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x02eb,
  payloadLength: 1479,
  championOwnerBase: 0x400000ad,
  totalGoldOffsets: Object.freeze([115, 117, 119, 121]),
  spentLikeOffsets: Object.freeze([107, 109, 111, 113]),
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
  discovery: Object.freeze({
    snapshotCount: 2170,
    transitionCount: 2100,
    residualZeroSnapshotCount: 967,
    saleIntervalCount: 70,
    saleResidualDeltaEqualsTransactionAdjustmentCount: 46,
    undoIntervalCount: 33,
    undoResidualDeltaEqualsSaleAdjustmentCount: 27,
    undoSpentLikeDeltaEqualsLedgerAdjustmentCount: 32,
    purchaseUndoEventCount: 28,
    purchaseUndoIntervalCount: 24,
    purchaseUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: 23,
    saleUndoEventCount: 11,
    saleUndoIntervalCount: 11,
    saleUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: 11,
    transitionSpentLikeDeltaEqualsLedgerAdjustmentCount: 2004,
    cumulativeAdjustmentExactSnapshotCount: 1085,
    cumulativeLedgerCompleteSnapshotCount: 2170,
    spentLikeEqualsCumulativeLedgerSpendSnapshotCount: 1618,
  }),
  holdout: Object.freeze({
    snapshotCount: 1030,
    transitionCount: 1000,
    residualZeroSnapshotCount: 354,
    saleIntervalCount: 36,
    saleResidualDeltaEqualsTransactionAdjustmentCount: 16,
    undoIntervalCount: 17,
    undoResidualDeltaEqualsSaleAdjustmentCount: 13,
    undoSpentLikeDeltaEqualsLedgerAdjustmentCount: 17,
    purchaseUndoEventCount: 17,
    purchaseUndoIntervalCount: 12,
    purchaseUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: 12,
    saleUndoEventCount: 5,
    saleUndoIntervalCount: 5,
    saleUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: 5,
    transitionSpentLikeDeltaEqualsLedgerAdjustmentCount: 941,
    cumulativeAdjustmentExactSnapshotCount: 374,
    cumulativeLedgerCompleteSnapshotCount: 1030,
    spentLikeEqualsCumulativeLedgerSpendSnapshotCount: 715,
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
    outputPath: path.join("tmp", "inventory-gold-adjustments-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (argument === "--decoder-profiles" && argv[index + 1]) {
      args.decoderProfilesPath = argv[++index];
    } else if (argument === "--item-data" && argv[index + 1]) {
      args.itemDataPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_gold_adjustments_16_14.mjs --item-data <Data-Dragon-16.14.1-item.json> [--cli <path>] [--output <path>]",
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
    fail("Pinned Data Dragon item catalog fingerprint failed.", {
      expected: STATIC_ITEM_SCHEMA,
      actual: { byteLength: bytes.length, sha256 },
    });
  }
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.version !== STATIC_ITEM_SCHEMA.version || typeof parsed.data !== "object") {
    fail("Pinned Data Dragon item catalog schema failed.");
  }
  return parsed.data;
}

function loadCipher(filePath) {
  const registry = readJson(path.resolve(filePath));
  const selected = (registry.profiles ?? []).filter(
    (entry) =>
      entry.versionGroup === "16.14" &&
      (entry.acceptedGameVersions ?? []).includes(PROFILE.exactReplayBuild),
  );
  const cipher = selected[0]?.keyframeParticipantStats?.cipherToPlain;
  if (
    selected.length !== 1 ||
    !Array.isArray(cipher) ||
    cipher.length !== 256 ||
    new Set(cipher).size !== 256
  ) {
    fail("Canonical exact-build cipher gate failed.");
  }
  return cipher;
}

function decodeFloat32(payload, offsets, cipher) {
  const bytes = Buffer.from(offsets.map((offset) => cipher[payload[offset]]));
  return bytes.readFloatLE(0);
}

function dumpKeyframes(args, replayPath) {
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
  if (run.status !== 0) fail("Native keyframe dump failed.", { replayPath, stderr: run.stderr });
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.gameVersion !== PROFILE.exactReplayBuild
  ) {
    fail("Exact keyframe framing/version gate failed.", { replayPath });
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
    )
    .map((event) => ({
      type: event.type,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      itemId: Number.isInteger(event.itemId) ? event.itemId : null,
      beforeId: Number.isInteger(event.beforeId) ? event.beforeId : null,
      afterId: Number.isInteger(event.afterId) ? event.afterId : null,
      goldGain: Number.isInteger(event.goldGain) ? event.goldGain : null,
    }));
}

function saleGain(items, itemId) {
  const sell = items[String(itemId)]?.gold?.sell;
  return Number.isInteger(sell) ? sell : null;
}

function itemTotalCost(items, itemId) {
  const total = items[String(itemId)]?.gold?.total;
  return Number.isInteger(total) ? total : null;
}

function ledgerSpendAdjustment(items, intervalEvents) {
  const eventsByTimestamp = new Map();
  for (const event of intervalEvents) {
    const group = eventsByTimestamp.get(event.timestampMillis) ?? [];
    group.push(event);
    eventsByTimestamp.set(event.timestampMillis, group);
  }
  let adjustment = 0;
  let complete = true;
  for (const group of eventsByTimestamp.values()) {
    const purchases = group.filter((event) => event.type === "ITEM_PURCHASED");
    const destroyed = group.filter((event) => event.type === "ITEM_DESTROYED");
    if (purchases.length > 0) {
      const purchaseCosts = purchases.map((event) => itemTotalCost(items, event.itemId));
      const componentCosts = destroyed.map((event) => itemTotalCost(items, event.itemId));
      if ([...purchaseCosts, ...componentCosts].some((value) => value === null)) {
        complete = false;
      } else {
        adjustment +=
          purchaseCosts.reduce((sum, value) => sum + value, 0) -
          componentCosts.reduce((sum, value) => sum + value, 0);
      }
    }
    for (const event of group.filter((event) => event.type === "ITEM_UNDO")) {
      if (event.goldGain === null) complete = false;
      else adjustment -= event.goldGain;
    }
  }
  return { adjustment, complete };
}

function inspectReplay(args, replayId, partition, cipher, items) {
  const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
  const fixtureRoot = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  const matchPath = path.join(fixtureRoot, "match.json");
  if (![replayPath, timelinePath, matchPath].every(fs.existsSync)) {
    fail("Fixed replay/API fixture missing.", { replayId });
  }
  const timeline = readJson(timelinePath);
  const match = readJson(matchPath);
  const frames = timeline.info?.frames;
  if (
    match.info?.gameVersion !== PROFILE.exactReplayBuild ||
    !Array.isArray(frames) ||
    frames.length === 0
  ) {
    fail("Fixture exact-build/Timeline gate failed.", { replayId });
  }
  const events = itemEvents(timeline);
  const rows = [];
  const ownersBySegment = new Map();
  for (const block of dumpKeyframes(args, replayPath)) {
    const participantId = block.blockParam - PROFILE.championOwnerBase;
    const frame = frames[block.segmentId - 1];
    const participantFrame = frame?.participantFrames?.[String(participantId)];
    if (
      block.channel !== 1 ||
      !Number.isInteger(participantId) ||
      participantId < 1 ||
      participantId > 10 ||
      block.contentLength !== PROFILE.payloadLength ||
      block.contentHexTruncated !== false ||
      block.contentHexBytes !== PROFILE.payloadLength ||
      !Number.isInteger(participantFrame?.currentGold)
    ) {
      fail("Keyframe owner/payload/oracle gate failed.", { replayId, block });
    }
    const owners = ownersBySegment.get(block.segmentId) ?? new Set();
    if (owners.has(participantId)) fail("Duplicate participant keyframe.");
    owners.add(participantId);
    ownersBySegment.set(block.segmentId, owners);
    const payload = Buffer.from(block.contentHex, "hex");
    const totalGold = decodeFloat32(payload, PROFILE.totalGoldOffsets, cipher);
    const spentLike = decodeFloat32(payload, PROFILE.spentLikeOffsets, cipher);
    const baseCurrentGold = Math.trunc(totalGold) - Math.trunc(spentLike);
    rows.push({
      replayId,
      partition,
      participantId,
      segmentId: block.segmentId,
      timestampMillis: block.timestampMillis,
      frameTimestampMillis: frame.timestamp,
      currentGold: participantFrame.currentGold,
      totalGold,
      spentLike,
      baseCurrentGold,
      residual: participantFrame.currentGold - baseCurrentGold,
    });
  }
  if ([...ownersBySegment.values()].some((owners) => owners.size !== 10)) {
    fail("Keyframe participant completeness gate failed.", { replayId });
  }

  const transitions = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const track = rows
      .filter((row) => row.participantId === participantId)
      .sort((left, right) => left.segmentId - right.segmentId);
    let cumulativeTransactionAdjustment = 0;
    let cumulativeLedgerSpend = 0;
    let cumulativeLedgerComplete = true;
    for (let index = 0; index < track.length; index += 1) {
      const row = track[index];
      const previous = track[index - 1];
      const intervalStart = previous?.frameTimestampMillis ?? -1;
      const intervalEvents = events.filter(
        (event) =>
          event.participantId === participantId &&
          event.timestampMillis > intervalStart &&
          event.timestampMillis <= row.frameTimestampMillis + 1,
      );
      let intervalTransactionAdjustment = 0;
      let intervalUndoGoldGain = 0;
      for (const event of intervalEvents) {
        if (event.type === "ITEM_SOLD") {
          const gain = saleGain(items, event.itemId);
          if (gain !== null) intervalTransactionAdjustment += gain;
        } else if (event.type === "ITEM_UNDO" && event.goldGain !== null) {
          intervalUndoGoldGain += event.goldGain;
        }
      }
      cumulativeTransactionAdjustment += intervalTransactionAdjustment;
      const ledger = ledgerSpendAdjustment(items, intervalEvents);
      cumulativeLedgerSpend += ledger.adjustment;
      cumulativeLedgerComplete &&= ledger.complete;
      transitions.push({
        ...row,
        previousResidual: previous?.residual ?? null,
        residualDelta: previous === undefined ? null : row.residual - previous.residual,
        spentLikeDelta:
          previous === undefined
            ? null
            : Math.trunc(row.spentLike) - Math.trunc(previous.spentLike),
        intervalEventSignature:
          intervalEvents
            .map((event) => event.type)
            .sort()
            .join("+") || "NO_ITEM_EVENT",
        intervalEvents,
        intervalTransactionAdjustment,
        intervalUndoGoldGain,
        cumulativeTransactionAdjustment,
        intervalLedgerSpendAdjustment: ledger.adjustment,
        intervalLedgerComplete: ledger.complete,
        cumulativeLedgerSpend,
        cumulativeLedgerComplete,
        spentLikeMinusCumulativeLedgerSpend: Math.trunc(row.spentLike) - cumulativeLedgerSpend,
        residualMinusCumulativeTransactionAdjustment:
          row.residual - cumulativeTransactionAdjustment,
      });
    }
  }
  return { rows, transitions };
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return Object.fromEntries(
    [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])),
  );
}

function summarize(transitions) {
  const withPrevious = transitions.filter((row) => row.residualDelta !== null);
  const sale = withPrevious.filter((row) =>
    row.intervalEvents.some((event) => event.type === "ITEM_SOLD"),
  );
  const undo = withPrevious.filter((row) =>
    row.intervalEvents.some((event) => event.type === "ITEM_UNDO"),
  );
  const purchaseUndo = withPrevious.filter((row) =>
    row.intervalEvents.some((event) => event.type === "ITEM_UNDO" && event.goldGain > 0),
  );
  const saleUndo = withPrevious.filter((row) =>
    row.intervalEvents.some((event) => event.type === "ITEM_UNDO" && event.goldGain < 0),
  );
  return {
    snapshotCount: transitions.length,
    transitionCount: withPrevious.length,
    residualZeroSnapshotCount: transitions.filter((row) => row.residual === 0).length,
    residualHistogram: histogram(transitions.map((row) => row.residual)),
    residualDeltaHistogram: histogram(withPrevious.map((row) => row.residualDelta)),
    eventSignatureCounts: histogram(withPrevious.map((row) => row.intervalEventSignature)),
    saleIntervalCount: sale.length,
    saleResidualDeltaEqualsTransactionAdjustmentCount: sale.filter(
      (row) => row.residualDelta === row.intervalTransactionAdjustment,
    ).length,
    undoIntervalCount: undo.length,
    undoResidualDeltaEqualsSaleAdjustmentCount: undo.filter(
      (row) => row.residualDelta === row.intervalTransactionAdjustment,
    ).length,
    undoSpentLikeDeltaEqualsLedgerAdjustmentCount: undo.filter(
      (row) => row.spentLikeDelta === row.intervalLedgerSpendAdjustment,
    ).length,
    purchaseUndoEventCount: purchaseUndo.reduce(
      (count, row) =>
        count +
        row.intervalEvents.filter((event) => event.type === "ITEM_UNDO" && event.goldGain > 0)
          .length,
      0,
    ),
    purchaseUndoIntervalCount: purchaseUndo.length,
    purchaseUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: purchaseUndo.filter(
      (row) => row.spentLikeDelta === row.intervalLedgerSpendAdjustment,
    ).length,
    saleUndoEventCount: saleUndo.reduce(
      (count, row) =>
        count +
        row.intervalEvents.filter((event) => event.type === "ITEM_UNDO" && event.goldGain < 0)
          .length,
      0,
    ),
    saleUndoIntervalCount: saleUndo.length,
    saleUndoSpentLikeDeltaEqualsLedgerAdjustmentCount: saleUndo.filter(
      (row) => row.spentLikeDelta === row.intervalLedgerSpendAdjustment,
    ).length,
    transitionSpentLikeDeltaEqualsLedgerAdjustmentCount: withPrevious.filter(
      (row) => row.spentLikeDelta === row.intervalLedgerSpendAdjustment,
    ).length,
    cumulativeAdjustmentExactSnapshotCount: transitions.filter(
      (row) => row.residual === row.cumulativeTransactionAdjustment,
    ).length,
    cumulativeLedgerCompleteSnapshotCount: transitions.filter((row) => row.cumulativeLedgerComplete)
      .length,
    spentLikeEqualsCumulativeLedgerSpendSnapshotCount: transitions.filter(
      (row) =>
        row.cumulativeLedgerComplete && Math.trunc(row.spentLike) === row.cumulativeLedgerSpend,
    ).length,
    spentLikeAfterLedgerHistogram: histogram(
      transitions
        .filter((row) => row.cumulativeLedgerComplete)
        .map((row) => row.spentLikeMinusCumulativeLedgerSpend),
    ),
    residualAfterKnownTransactionsHistogram: histogram(
      transitions.map((row) => row.residualMinusCumulativeTransactionAdjustment),
    ),
  };
}

function frozenMetrics(summary) {
  return Object.fromEntries(
    Object.keys(EXPECTED.discovery).map((field) => [field, summary[field]]),
  );
}

function main() {
  const args = parseArgs(process.argv);
  const cipher = loadCipher(args.decoderProfilesPath);
  const items = loadStaticItems(args.itemDataPath);
  const reports = [
    ...PROFILE.discovery.map((replayId) => inspectReplay(args, replayId, "D7", cipher, items)),
    ...PROFILE.holdout.map((replayId) => inspectReplay(args, replayId, "H3", cipher, items)),
  ];
  const transitions = reports.flatMap((report) => report.transitions);
  const discovery = transitions.filter((row) => row.partition === "D7");
  const holdout = transitions.filter((row) => row.partition === "H3");
  const discoverySummary = summarize(discovery);
  const holdoutSummary = summarize(holdout);
  const actual = {
    discovery: frozenMetrics(discoverySummary),
    holdout: frozenMetrics(holdoutSummary),
  };
  if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
    fail("Frozen gold-adjustment research metrics drifted.", {
      expected: EXPECTED,
      actual,
    });
  }
  const output = {
    schema: "rofl-inventory-gold-adjustment-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayInput: {
      packetType: "0x02EB",
      totalGoldOffsets: PROFILE.totalGoldOffsets,
      spentLikeOffsets: PROFILE.spentLikeOffsets,
    },
    offlineOracle:
      "Saved Timeline participantFrames.currentGold and item events; pinned Data Dragon prices; validation only",
    split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
    partitions: {
      discovery: discoverySummary,
      holdout: holdoutSummary,
      combined: summarize(transitions),
    },
    labelledSaleOrUndoTransitions: transitions.filter((row) =>
      row.intervalEvents.some((event) => event.type === "ITEM_SOLD" || event.type === "ITEM_UNDO"),
    ),
    conclusion:
      "The spent-like replay lane follows the offline static-recipe/Undo spend ledger on 2945/3100 transitions, including 49/50 Undo intervals. Sale proceeds are a separate cumulative current-gold correction and improve exact snapshots from 1321/3200 to 1459/3200. The remaining residual and sold-item identity are unresolved, so current gold remains unpromoted.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        discovery: actual.discovery,
        holdout: actual.holdout,
        combined: {
          transitionSpentLikeDeltaEqualsLedgerAdjustmentCount:
            output.partitions.combined.transitionSpentLikeDeltaEqualsLedgerAdjustmentCount,
          transitionCount: output.partitions.combined.transitionCount,
          cumulativeAdjustmentExactSnapshotCount:
            output.partitions.combined.cumulativeAdjustmentExactSnapshotCount,
          snapshotCount: output.partitions.combined.snapshotCount,
        },
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outputPath}`);
}

main();
