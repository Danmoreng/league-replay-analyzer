#!/usr/bin/env node

// Offline research only. The input candidates and every packet in each window
// come from saved ROFL files. Saved API fixtures are used only by the upstream
// keyframe research script that labels intervals without Timeline item events.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  operationPacketTypes: Object.freeze({
    add: 0x0369,
    removal: 0x03f9,
    removalContext: 0x0146,
    undoComponent: 0x0081,
  }),
});

const EXPECTED = Object.freeze({
  candidateCount: 21,
  discoveryCount: 12,
  holdoutCount: 9,
  addWindowCount: 4,
  removalWindowCount: 0,
  removalContextWindowCount: 14,
  undoComponentWindowCount: 0,
  anyProfiledOperationWindowCount: 16,
  noProfiledOperationWindowCount: 5,
  addPacketCount: 4,
  removalPacketCount: 0,
  removalContextPacketCount: 21,
  undoComponentPacketCount: 0,
  exactOnceAllWindowSignatureCount: 0,
  repeatedRemovalContextPayloadCount: 6,
  repeatedRemovalContextEntryCount: 15,
  contradictoryRemovalContextPayloadCount: 6,
  c550cbContainsOppositeRecordMoves: true,
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    keyframeResearchPath: path.join("tmp", "keyframe-inventory-slots-research-16.14.json"),
    outputPath: path.join("tmp", "inventory-rearrangement-windows-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--keyframe-research" && argv[index + 1]) {
      args.keyframeResearchPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_rearrangement_windows_16_14.mjs [--cli <path>] [--replay-dir <path>] [--keyframe-research <path>] [--output <path>]",
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

function dumpWindow(args, candidate) {
  const replayPath = path.join(args.replayDir, `${candidate.replayId}.rofl`);
  const startTimestampMillis = candidate.intervalStartMillis + 2;
  const endTimestampMillis = candidate.intervalEndMillis + 1;
  const blockParam = PROFILE.championOwnerBase + candidate.participantId;
  const run = spawnSync(
    args.cliPath,
    [
      "--dump-packet-window-json",
      replayPath,
      "--start-ms",
      String(startTimestampMillis),
      "--end-ms",
      String(endTimestampMillis),
      "--channel",
      "1",
      "--block-param",
      String(blockParam),
      "--segment-type",
      "chunk",
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) {
    fail("Native packet-window dump failed.", { replayPath, stderr: run.stderr });
  }
  const dump = JSON.parse(run.stdout);
  if (
    dump.schema !== "packet-window-dump.v1" ||
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.blockParam !== blockParam
  ) {
    fail("Packet-window dump failed its replay-only provenance gate.", dump);
  }
  return dump;
}

function packetSignature(block) {
  return `${block.packetType}:${block.contentLength}:${block.contentHex.slice(0, 8)}`;
}

function inferredRecordMoves(candidate) {
  const moves = [];
  for (const change of candidate.changedSlots) {
    if (change.beforeItemId === 0 || change.beforeItemId === change.itemId) continue;
    const destinations = candidate.changedSlots.filter(
      (destination) =>
        destination.slot !== change.slot &&
        destination.itemId === change.beforeItemId &&
        destination.beforeItemId !== change.beforeItemId,
    );
    if (destinations.length === 1) {
      moves.push({
        itemId: change.beforeItemId,
        fromRecord: change.slot,
        toRecord: destinations[0].slot,
      });
    }
  }
  return moves;
}

function main() {
  const args = parseArgs(process.argv);
  const input = JSON.parse(fs.readFileSync(path.resolve(args.keyframeResearchPath), "utf8"));
  if (
    input.schema !== "rofl-keyframe-inventory-slot-research-16.14/v1" ||
    input.exactReplayBuild !== PROFILE.exactReplayBuild ||
    input.researchOnly !== true ||
    input.promotionGate !== false ||
    !Array.isArray(input.rearrangementCandidateRows)
  ) {
    fail("Unexpected keyframe inventory research input.");
  }

  const candidates = input.rearrangementCandidateRows;
  const candidateMetrics = {
    candidateCount: candidates.length,
    discoveryCount: candidates.filter((candidate) => candidate.partition === "D7").length,
    holdoutCount: candidates.filter((candidate) => candidate.partition === "H3").length,
  };
  if (
    candidateMetrics.candidateCount !== EXPECTED.candidateCount ||
    candidateMetrics.discoveryCount !== EXPECTED.discoveryCount ||
    candidateMetrics.holdoutCount !== EXPECTED.holdoutCount
  ) {
    fail("Frozen rearrangement candidate gate changed.", { expected: EXPECTED, candidateMetrics });
  }

  const operationTypes = Object.values(PROFILE.operationPacketTypes);
  const rows = candidates.map((candidate) => {
    const dump = dumpWindow(args, candidate);
    const operationBlocks = dump.blocks.filter((block) =>
      operationTypes.includes(block.packetType),
    );
    return {
      ...candidate,
      windowStartMillis: dump.startTimestampMillis,
      windowEndMillis: dump.endTimestampMillis,
      matchingPacketCount: dump.matchingBlockCount,
      operationPacketCounts: Object.fromEntries(
        Object.entries(PROFILE.operationPacketTypes).map(([family, packetType]) => [
          family,
          operationBlocks.filter((block) => block.packetType === packetType).length,
        ]),
      ),
      operationBlocks: operationBlocks.map((block) => ({
        timestampMillis: block.timestampMillis,
        packetType: block.packetType,
        packetTypeHex: `0x${block.packetType.toString(16).toUpperCase().padStart(4, "0")}`,
        contentLength: block.contentLength,
        contentHex: block.contentHex,
      })),
      inferredRecordMoves: inferredRecordMoves(candidate),
      packetSignatures: dump.blocks.map(packetSignature),
    };
  });

  const presenceMetrics = Object.fromEntries(
    Object.keys(PROFILE.operationPacketTypes).map((family) => [
      `${family}WindowCount`,
      rows.filter((row) => row.operationPacketCounts[family] > 0).length,
    ]),
  );
  presenceMetrics.anyProfiledOperationWindowCount = rows.filter((row) =>
    Object.values(row.operationPacketCounts).some((count) => count > 0),
  ).length;
  presenceMetrics.noProfiledOperationWindowCount =
    rows.length - presenceMetrics.anyProfiledOperationWindowCount;

  const signatureSupport = new Map();
  for (const row of rows) {
    const counts = new Map();
    for (const signature of row.packetSignatures) {
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
    for (const [signature, count] of counts) {
      const support = signatureSupport.get(signature) ?? {
        windowCount: 0,
        exactOnceWindowCount: 0,
      };
      support.windowCount += 1;
      if (count === 1) support.exactOnceWindowCount += 1;
      signatureSupport.set(signature, support);
    }
  }
  const exactOnceAllWindowSignatures = [...signatureSupport.entries()]
    .filter(([, support]) => support.exactOnceWindowCount === rows.length)
    .map(([signature]) => signature)
    .sort();

  const repeatedContextPayloads = new Map();
  for (const row of rows) {
    for (const block of row.operationBlocks) {
      if (block.packetType !== PROFILE.operationPacketTypes.removalContext) continue;
      const entries = repeatedContextPayloads.get(block.contentHex) ?? [];
      entries.push({
        replayId: row.replayId,
        participantId: row.participantId,
        timestampMillis: block.timestampMillis,
        inferredRecordMoves: row.inferredRecordMoves,
      });
      repeatedContextPayloads.set(block.contentHex, entries);
    }
  }
  const repeatedRemovalContextPayloads = [...repeatedContextPayloads.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([contentHex, entries]) => ({ contentHex, entries }))
    .sort((left, right) => left.contentHex.localeCompare(right.contentHex));
  const contradictoryRemovalContextPayloads = repeatedRemovalContextPayloads.filter((payload) => {
    const moveSignatures = new Set(
      payload.entries.map((entry) => JSON.stringify(entry.inferredRecordMoves)),
    );
    return moveSignatures.size > 1;
  });
  const c550cbMoves = repeatedRemovalContextPayloads
    .find((payload) => payload.contentHex === "c550cb")
    ?.entries.flatMap((entry) => entry.inferredRecordMoves);
  const frozenMetrics = {
    ...candidateMetrics,
    ...presenceMetrics,
    addPacketCount: rows.reduce((count, row) => count + row.operationPacketCounts.add, 0),
    removalPacketCount: rows.reduce((count, row) => count + row.operationPacketCounts.removal, 0),
    removalContextPacketCount: rows.reduce(
      (count, row) => count + row.operationPacketCounts.removalContext,
      0,
    ),
    undoComponentPacketCount: rows.reduce(
      (count, row) => count + row.operationPacketCounts.undoComponent,
      0,
    ),
    exactOnceAllWindowSignatureCount: exactOnceAllWindowSignatures.length,
    repeatedRemovalContextPayloadCount: repeatedRemovalContextPayloads.length,
    repeatedRemovalContextEntryCount: repeatedRemovalContextPayloads.reduce(
      (count, payload) => count + payload.entries.length,
      0,
    ),
    contradictoryRemovalContextPayloadCount: contradictoryRemovalContextPayloads.length,
    c550cbContainsOppositeRecordMoves:
      (c550cbMoves ?? []).some((move) => move.fromRecord === 5 && move.toRecord === 4) &&
      (c550cbMoves ?? []).some((move) => move.fromRecord === 4 && move.toRecord === 5),
  };
  if (JSON.stringify(frozenMetrics) !== JSON.stringify(EXPECTED)) {
    fail("Frozen packet-window rearrangement metrics drifted.", {
      expected: EXPECTED,
      actual: frozenMetrics,
    });
  }

  const output = {
    schema: "rofl-inventory-rearrangement-window-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    input: {
      keyframeResearchPath: path.resolve(args.keyframeResearchPath),
      candidateMetrics,
    },
    frozenMetrics,
    replayOnlyWindow: {
      segmentType: "chunk",
      channel: 1,
      participantNetworkId: "0x400000AD + participantId",
      interval: "(previous keyframe + 1 ms, current keyframe + 1 ms]",
    },
    presenceMetrics,
    exactOnceAllWindowSignatureCount: exactOnceAllWindowSignatures.length,
    exactOnceAllWindowSignatures,
    repeatedRemovalContextPayloads,
    rows: rows.map(({ packetSignatures: _packetSignatures, ...row }) => row),
    nonPromotionReasons: [
      "Some same-multiset record reorderings have no profiled add, removal, removal-context, or Undo-component packet in their replay-only interval.",
      "An identical removal-context payload can accompany different historical-record movements, so it is not a direct source/destination slot label under this candidate model.",
      "No packet type/length/four-byte-prefix signature occurs exactly once in every candidate window.",
      "The keyframe records remain historical item-state records and are not current inventory slots.",
    ],
    conclusion:
      "The bounded packet-window scan rejects direct promotion of same-multiset 0x0081 record reorderings as physical inventory swaps. It supplies negative anchors for future stateful slot/instance grammar research only.",
  };

  fs.mkdirSync(path.dirname(path.resolve(args.outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(args.outputPath), `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify({ frozenMetrics, exactOnceAllWindowSignatures }));
  console.log(`Wrote ${path.resolve(args.outputPath)}`);
}

main();
