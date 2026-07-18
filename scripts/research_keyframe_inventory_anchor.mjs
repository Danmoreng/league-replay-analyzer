import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Research-only. These fixed anchors identify an inventory-component change
// boundary; neither profile decodes an item, slot, count, or inventory state.
const REPO_ROOT = process.cwd();
const DEFAULT_CLI = "build/packages/rofl-core/rofl_core_cli.exe";
const ITEM_TYPES = new Set(["ITEM_PURCHASED", "ITEM_UNDO", "ITEM_SOLD", "ITEM_DESTROYED"]);

const PROFILES = Object.freeze({
  "16.9": Object.freeze({
    packetType: 0x0442,
    payloadLength: 1451,
    anchorOffset: 259,
    championNetworkIdBase: 1073741997,
    acceptedGameVersions: ["16.9.772.1032"],
    expectedSummaryCounts: Object.freeze({
      discovery: Object.freeze({ transitionCount: 590, positiveTransitions: 264, negativeTransitions: 326 }),
      holdout: Object.freeze({ transitionCount: 280, positiveTransitions: 118, negativeTransitions: 162 }),
    }),
    lane: Object.freeze({ start: 256, length: 8, positiveMasks: new Set(["0x08", "0x88"]), negativeMask: "0x00" }),
    cases: Object.freeze([
      { role: "discovery", replay: "replays/EUW1-7840220945.rofl", timeline: "replays/api/EUW1_7840220945/timeline.json" },
      { role: "discovery", replay: "replays/EUW1-7840267452.rofl", timeline: "replays/api/EUW1_7840267452/timeline.json" },
      { role: "holdout", replay: "replays/EUW1-7840327293.rofl", timeline: "replays/api/EUW1_7840327293/timeline.json" },
    ]),
  }),
  "16.14": Object.freeze({
    packetType: 0x02eb,
    payloadLength: 1479,
    anchorOffset: 111,
    championNetworkIdBase: 1073741997,
    acceptedGameVersions: ["16.14.794.5912"],
    expectedSummaryCounts: Object.freeze({
      discovery: Object.freeze({ transitionCount: 520, positiveTransitions: 229, negativeTransitions: 291 }),
      holdout: Object.freeze({ transitionCount: 290, positiveTransitions: 132, negativeTransitions: 158 }),
    }),
    lane: null,
    cases: Object.freeze([
      { role: "discovery", replay: "replays/EUW1-7919517389.rofl", timeline: "replays/api/EUW1_7919517389/timeline.json" },
      { role: "discovery", replay: "replays/EUW1-7919624327.rofl", timeline: "replays/api/EUW1_7919624327/timeline.json" },
      // Predetermined before any 16.14 offset selection.
      { role: "holdout", replay: "replays/EUW1-7921996430.rofl", timeline: "replays/api/EUW1_7921996430/timeline.json" },
    ]),
  }),
});

function parseArgs(argv) {
  const args = { profile: null, cliPath: DEFAULT_CLI, outputPath: null };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile" && index + 1 < argv.length) args.profile = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/research_keyframe_inventory_anchor.mjs --profile 16.9|16.14 [--cli <rofl_core_cli.exe>] [--output <report.json>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  if (!PROFILES[args.profile]) throw new Error("--profile must be one of: 16.9, 16.14.");
  return args;
}

function runCli(cliPath, args) {
  return JSON.parse(execFileSync(cliPath, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, windowsHide: true }));
}

function idFromReplayPath(replayPath) {
  return path.basename(replayPath, path.extname(replayPath));
}

function itemEventsForOwner(events, participantId, fromTimestamp, toTimestamp) {
  return events.filter((event) =>
    event.timestamp > fromTimestamp && event.timestamp <= toTimestamp &&
    event.participantId === participantId && ITEM_TYPES.has(event.type)
  );
}

function classify(events) {
  const has = (type) => events.some((event) => event.type === type);
  const purchased = has("ITEM_PURCHASED");
  const undo = has("ITEM_UNDO");
  const sold = has("ITEM_SOLD");
  const destroyed = has("ITEM_DESTROYED");
  return {
    purchaseOrUndo: purchased || undo,
    soldOrDestroyedWithoutPurchaseUndo: (sold || destroyed) && !purchased && !undo,
    purchased,
    undo,
    sold,
    destroyed,
  };
}

function hexMask(value) {
  return `0x${value.toString(16).padStart(2, "0")}`;
}

function laneMask(before, after, lane) {
  if (!lane) return null;
  let mask = 0;
  for (let index = 0; index < lane.length; index += 1) {
    if (before[lane.start + index] !== after[lane.start + index]) mask |= 1 << index;
  }
  return hexMask(mask);
}

function histogram(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .map(([value, count]) => ({ value, count }));
}

function loadCase(input, profile, cliPath) {
  const replayPath = path.resolve(REPO_ROOT, input.replay);
  const timelinePath = path.resolve(REPO_ROOT, input.timeline);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const timelineEvents = (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? []);
  const dump = runCli(cliPath, ["--dump-packet-type-json", replayPath, "--packet-type", `0x${profile.packetType.toString(16)}`, "--segment-type", "keyframe", "--max-blocks", "0"]);
  if (!dump.valid || dump.errors?.length || dump.packetType !== profile.packetType || dump.emittedBlockCount !== dump.matchingBlockCount || !profile.acceptedGameVersions.includes(dump.gameVersion)) {
    throw new Error(`${idFromReplayPath(replayPath)} failed the fixed profile/version/exact-dump gate.`);
  }
  const byOwner = new Map();
  const bySegment = new Map();
  for (const block of dump.blocks ?? []) {
    const participantId = block.blockParam - profile.championNetworkIdBase;
    if (participantId < 1 || participantId > 10 || block.contentHexTruncated || block.contentHexBytes !== block.contentLength || block.contentLength !== profile.payloadLength) {
      throw new Error(`${idFromReplayPath(replayPath)} failed the exact owner/payload gate.`);
    }
    const snapshot = { participantId, segmentId: block.segmentId, timestamp: block.timestampMillis, payload: Buffer.from(block.contentHex, "hex") };
    const ownerTrack = byOwner.get(participantId) ?? [];
    ownerTrack.push(snapshot);
    byOwner.set(participantId, ownerTrack);
    const segment = bySegment.get(block.segmentId) ?? [];
    segment.push(snapshot);
    bySegment.set(block.segmentId, segment);
  }
  if (byOwner.size !== 10 || [...bySegment.values()].some((snapshots) => snapshots.length !== 10 || new Set(snapshots.map((entry) => entry.participantId)).size !== 10)) {
    throw new Error(`${idFromReplayPath(replayPath)} failed the exactly-ten-champions-per-keyframe gate.`);
  }
  const transitions = [];
  for (const [participantId, track] of byOwner) {
    track.sort((left, right) => left.timestamp - right.timestamp);
    for (let index = 1; index < track.length; index += 1) {
      const before = track[index - 1];
      const after = track[index];
      const itemEvents = itemEventsForOwner(timelineEvents, participantId, before.timestamp, after.timestamp);
      transitions.push({
        participantId,
        fromTimestamp: before.timestamp,
        toTimestamp: after.timestamp,
        classes: classify(itemEvents),
        eventTypes: itemEvents.map((event) => event.type),
        anchorChanged: before.payload[profile.anchorOffset] !== after.payload[profile.anchorOffset],
        anchorXorMask: hexMask(before.payload[profile.anchorOffset] ^ after.payload[profile.anchorOffset]),
        laneMask: laneMask(before.payload, after.payload, profile.lane),
      });
    }
  }
  return {
    role: input.role,
    replayId: idFromReplayPath(replayPath),
    gameVersion: dump.gameVersion,
    exactFraming: { matchingBlockCount: dump.matchingBlockCount, payloadLength: profile.payloadLength, keyframeSegmentCount: bySegment.size, exactTenChampionSegments: bySegment.size },
    transitions,
  };
}

function summarize(rows, profile) {
  const positives = rows.filter((row) => row.classes.purchaseOrUndo);
  const negatives = rows.filter((row) => !row.classes.purchaseOrUndo);
  const purePurchases = rows.filter((row) => row.classes.purchased
    && !row.classes.undo && !row.classes.sold && !row.classes.destroyed);
  const tp = positives.filter((row) => row.anchorChanged).length;
  const fn = positives.length - tp;
  const fp = negatives.filter((row) => row.anchorChanged).length;
  const tn = negatives.length - fp;
  const saleOnly = rows.filter((row) => row.classes.soldOrDestroyedWithoutPurchaseUndo);
  const lane = profile.lane ? {
    positiveMasks: histogram(positives.map((row) => row.laneMask)),
    negativeMasks: histogram(negatives.map((row) => row.laneMask)),
    positiveMaskGate: positives.every((row) => profile.lane.positiveMasks.has(row.laneMask)),
    negativeMaskGate: negatives.every((row) => row.laneMask === profile.lane.negativeMask),
  } : null;
  return {
    transitionCount: rows.length,
    positiveTransitions: positives.length,
    negativeTransitions: negatives.length,
    confusion: { tp, fp, fn, tn, precision: tp / Math.max(tp + fp, 1), recall: tp / Math.max(tp + fn, 1) },
    purchaseUndoGate: tp === positives.length && fp === 0,
    purePurchase: {
      transitions: purePurchases.length,
      anchorChanged: purePurchases.filter((row) => row.anchorChanged).length,
      allChanged: purePurchases.length > 0 && purePurchases.every((row) => row.anchorChanged),
    },
    saleDestroyOnly: { transitions: saleOnly.length, anchorChanged: saleOnly.filter((row) => row.anchorChanged).length },
    anchorXorMasksOnPositiveWindows: histogram(positives.filter((row) => row.anchorChanged).map((row) => row.anchorXorMask)).slice(0, 24),
    lane,
  };
}

function matchesExpectedCounts(summary, expected) {
  return Object.entries(expected).every(([key, value]) => summary[key] === value);
}

function main() {
  const args = parseArgs(process.argv);
  const profile = PROFILES[args.profile];
  const cliPath = path.resolve(REPO_ROOT, args.cliPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const cases = profile.cases.map((input) => loadCase(input, profile, cliPath));
  const discovery = cases.filter((entry) => entry.role === "discovery");
  const holdout = cases.find((entry) => entry.role === "holdout");
  const discoverySummary = summarize(discovery.flatMap((entry) => entry.transitions), profile);
  const holdoutSummary = summarize(holdout.transitions, profile);
  const gates = {
    discoveryPassed: discoverySummary.purchaseUndoGate
      && discoverySummary.purePurchase.allChanged
      && matchesExpectedCounts(discoverySummary, profile.expectedSummaryCounts.discovery)
      && (discoverySummary.lane?.positiveMaskGate ?? true)
      && (discoverySummary.lane?.negativeMaskGate ?? true),
    holdoutPassed: holdoutSummary.purchaseUndoGate
      && holdoutSummary.purePurchase.allChanged
      && matchesExpectedCounts(holdoutSummary, profile.expectedSummaryCounts.holdout)
      && (holdoutSummary.lane?.positiveMaskGate ?? true)
      && (holdoutSummary.lane?.negativeMaskGate ?? true),
    nonPromotion: true,
  };
  const report = {
    schema: "keyframe-inventory-anchor-research/v2",
    profile: args.profile,
    runtimeInput: "exact saved-ROFL keyframe packet bytes only",
    validationInput: "saved Riot Timeline ITEM_PURCHASED/ITEM_UNDO labels only",
    excludedInputs: ["installed League/Riot binaries", "running game/client processes", "Vanguard", "runtime Riot API fallback"],
    packetProfile: { packetType: `0x${profile.packetType.toString(16).toUpperCase().padStart(4, "0")}`, payloadLength: profile.payloadLength, anchorOffset: profile.anchorOffset, championNetworkIdBase: profile.championNetworkIdBase, acceptedGameVersions: profile.acceptedGameVersions, lane: profile.lane ? { start: profile.lane.start, length: profile.lane.length } : null },
    expectedSummaryCounts: profile.expectedSummaryCounts,
    timingOwnerGate: "same replay-native champion owner; half-open consecutive keyframe interval (previousSnapshotTimestamp, currentSnapshotTimestamp]",
    cases: cases.map(({ transitions, ...entry }) => ({ ...entry, summary: summarize(transitions, profile) })),
    discovery: discoverySummary,
    predeterminedHoldout: holdoutSummary,
    gates,
    nonPromotionReason: "A profile-bound anchor only identifies that a keyframe snapshot window contains at least one purchase or undo. It does not decode item ID, slot, count, operation ordering, sales, destroys, or inventory state, so no C++/Wasm/UI runtime field is authorized.",
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    const outputPath = path.resolve(REPO_ROOT, args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output);
    console.error(`Wrote ${outputPath}`);
  } else process.stdout.write(output);
  if (!gates.discoveryPassed || !gates.holdoutPassed) process.exitCode = 1;
}

main();
