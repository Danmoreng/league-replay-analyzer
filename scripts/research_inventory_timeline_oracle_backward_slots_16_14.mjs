#!/usr/bin/env node

// Offline research only. The seven-slot final anchor and every candidate slot
// come from saved ROFL bytes. Saved Timeline item identities are an oracle used
// to diagnose the missing replay grammar; they are never a runtime input.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  removalPacketType: 0x03f9,
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
  timelineToleranceMillis: 1,
  maxBranches: 64,
});

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    strict: Object.freeze({
      participantCount: 70,
      timelineGroupCount: 2135,
      processedSuffixGroupCount: 268,
      reachedTimelineBeginningCount: 0,
      barrierReasons: Object.freeze({ "state-contradiction": 70 }),
      slotConstrainedGroupCount: 128,
      saleSlotConstrainedGroupCount: 21,
    }),
    balance: Object.freeze({
      participantCount: 70,
      eventCount: 3215,
      negativeUnitCount: 10,
      positiveUnitCount: 471,
      participantWithNegativeBalanceCount: 10,
      participantOverSevenPositiveUnitsCount: 24,
      maximumParticipantPositiveUnitCount: 25,
      viegoParticipantCount: 0,
      viegoPositiveUnitCount: 0,
      nonViegoPositiveUnitCount: 471,
      exactZeroBalanceParticipantCount: 0,
    }),
    relaxed: Object.freeze({
      participantCount: 70,
      bestObservedSkippedEventCount: 531,
      participantsRequiringSkippedEvents: 68,
      emptyBeginningStateAvailableCount: 3,
      residualBeginningItemCount: 188,
      maximumBranchCount: 64,
      skippedEventTypes: Object.freeze({
        ITEM_DESTROYED: 392,
        ITEM_PURCHASED: 129,
        ITEM_SOLD: 10,
      }),
    }),
  }),
  holdout: Object.freeze({
    strict: Object.freeze({
      participantCount: 30,
      timelineGroupCount: 1095,
      processedSuffixGroupCount: 98,
      reachedTimelineBeginningCount: 0,
      barrierReasons: Object.freeze({ "state-contradiction": 30 }),
      slotConstrainedGroupCount: 41,
      saleSlotConstrainedGroupCount: 8,
    }),
    balance: Object.freeze({
      participantCount: 30,
      eventCount: 1762,
      negativeUnitCount: 3,
      positiveUnitCount: 387,
      participantWithNegativeBalanceCount: 3,
      participantOverSevenPositiveUnitsCount: 12,
      maximumParticipantPositiveUnitCount: 131,
      viegoParticipantCount: 2,
      viegoPositiveUnitCount: 198,
      nonViegoPositiveUnitCount: 189,
      exactZeroBalanceParticipantCount: 0,
    }),
    relaxed: Object.freeze({
      participantCount: 30,
      bestObservedSkippedEventCount: 491,
      participantsRequiringSkippedEvents: 27,
      emptyBeginningStateAvailableCount: 2,
      residualBeginningItemCount: 91,
      maximumBranchCount: 64,
      skippedEventTypes: Object.freeze({
        ITEM_DESTROYED: 383,
        ITEM_PURCHASED: 99,
        ITEM_SOLD: 4,
        ITEM_UNDO: 5,
      }),
    }),
  }),
  combined: Object.freeze({
    strict: Object.freeze({
      participantCount: 100,
      timelineGroupCount: 3230,
      processedSuffixGroupCount: 366,
      reachedTimelineBeginningCount: 0,
      barrierReasons: Object.freeze({ "state-contradiction": 100 }),
      slotConstrainedGroupCount: 169,
      saleSlotConstrainedGroupCount: 29,
    }),
    balance: Object.freeze({
      participantCount: 100,
      eventCount: 4977,
      negativeUnitCount: 13,
      positiveUnitCount: 858,
      participantWithNegativeBalanceCount: 13,
      participantOverSevenPositiveUnitsCount: 36,
      maximumParticipantPositiveUnitCount: 131,
      viegoParticipantCount: 2,
      viegoPositiveUnitCount: 198,
      nonViegoPositiveUnitCount: 660,
      exactZeroBalanceParticipantCount: 0,
    }),
    relaxed: Object.freeze({
      participantCount: 100,
      bestObservedSkippedEventCount: 1022,
      participantsRequiringSkippedEvents: 95,
      emptyBeginningStateAvailableCount: 5,
      residualBeginningItemCount: 279,
      maximumBranchCount: 64,
      skippedEventTypes: Object.freeze({
        ITEM_DESTROYED: 775,
        ITEM_PURCHASED: 228,
        ITEM_SOLD: 14,
        ITEM_UNDO: 5,
      }),
    }),
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
    outputPath: path.join("tmp", "inventory-timeline-oracle-backward-slots-16.14.json"),
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
        "Usage: node scripts/research_inventory_timeline_oracle_backward_slots_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--decoder-profiles <path>] [--output <path>]",
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

function physicalKey(block) {
  return `${block.segmentId}:${block.blockIndex}:${block.headerOffset}`;
}

function loadFinalPlayers(args, replayPath) {
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
    return { champion: player.champion, slots: player.items };
  });
}

function loadRemovalCandidates(args, replayPath) {
  const dump = runJson(args.cliPath, [
    "--dump-packet-type-json",
    replayPath,
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
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount
  ) {
    fail("Exact removal packet framing gate failed.", { replayPath });
  }
  return (dump.blocks ?? [])
    .filter((block) => block.channel === 1 && [6, 7].includes(block.contentLength))
    .map((block) => {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      if (!Number.isInteger(participantId) || participantId < 1 || participantId > 10) return null;
      const payload = Buffer.from(block.contentHex, "hex");
      return {
        participantId,
        timestampMillis: block.timestampMillis,
        slot: decodeRemovalSlot(payload),
        operationNibble: payload[0] & 0x0f,
        physicalKey: physicalKey(block),
      };
    })
    .filter(Boolean);
}

function loadReplaySaleKeys(args, replayPath) {
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
  return new Set(
    sales.events.map((event) => {
      const provenance = event.provenance?.removalBlock?.provenance;
      return `${provenance.segmentId}:${provenance.blockIndex}:${provenance.decompressedHeaderOffset}`;
    }),
  );
}

function timelineItemGroups(timeline, participantId) {
  const groups = new Map();
  for (const event of (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])) {
    if (
      !["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type) ||
      event.participantId !== participantId ||
      !Number.isInteger(event.timestamp)
    ) {
      continue;
    }
    const events = groups.get(event.timestamp) ?? [];
    events.push(event);
    groups.set(event.timestamp, events);
  }
  return [...groups.entries()]
    .map(([timestampMillis, events]) => ({ timestampMillis, events }))
    .sort((left, right) => right.timestampMillis - left.timestampMillis);
}

function stateKey(slots) {
  return slots.join(",");
}

function deduplicate(states) {
  return [...new Map(states.map((slots) => [stateKey(slots), slots])).values()];
}

function removeItem(states, itemId) {
  const next = [];
  for (const slots of states) {
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (slots[slot] !== itemId) continue;
      const candidate = [...slots];
      candidate[slot] = 0;
      next.push(candidate);
    }
  }
  return deduplicate(next);
}

function restoreItem(states, itemId, allowedSlots = null) {
  const next = [];
  for (const slots of states) {
    const candidates = allowedSlots ?? slots.map((_, slot) => slot);
    for (const slot of candidates) {
      if (slots[slot] !== 0) continue;
      const candidate = [...slots];
      candidate[slot] = itemId;
      next.push(candidate);
    }
  }
  return deduplicate(next);
}

function reverseUndo(states, event) {
  const beforeId = Number.isInteger(event.beforeId) ? event.beforeId : 0;
  const afterId = Number.isInteger(event.afterId) ? event.afterId : 0;
  if (beforeId === 0 && afterId === 0) return [];
  if (afterId === 0) return restoreItem(states, beforeId);
  const next = [];
  for (const slots of states) {
    for (let slot = 0; slot < slots.length; slot += 1) {
      if (slots[slot] !== afterId) continue;
      const candidate = [...slots];
      candidate[slot] = beforeId;
      next.push(candidate);
    }
  }
  return deduplicate(next);
}

function permutations(values) {
  if (values.length <= 1) return [values];
  const result = [];
  for (let index = 0; index < values.length; index += 1) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const suffix of permutations(rest)) result.push([values[index], ...suffix]);
  }
  return result;
}

function removalAssignments(events, removals) {
  const removalEventIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => ["ITEM_DESTROYED", "ITEM_SOLD"].includes(event.type));
  const usable = removals.filter((removal) => removal.slot !== null);
  if (
    removalEventIndexes.length === 0 ||
    usable.length !== removalEventIndexes.length ||
    new Set(usable.map((removal) => removal.slot)).size !== usable.length
  ) {
    return [{ byEventIndex: new Map(), slotConstrained: false, saleSlotConstrained: false }];
  }
  return permutations(usable).map((ordered) => {
    const byEventIndex = new Map();
    for (let index = 0; index < ordered.length; index += 1) {
      byEventIndex.set(removalEventIndexes[index].index, ordered[index].slot);
    }
    const saleEventIndexes = removalEventIndexes.filter(({ event }) => event.type === "ITEM_SOLD");
    const saleSlotConstrained =
      saleEventIndexes.length > 0 && saleEventIndexes.every(({ index }) => byEventIndex.has(index));
    return { byEventIndex, slotConstrained: true, saleSlotConstrained };
  });
}

function reverseEvent(states, event, allowedSlot) {
  if (event.type === "ITEM_PURCHASED" && Number.isInteger(event.itemId)) {
    return removeItem(states, event.itemId);
  }
  if (["ITEM_DESTROYED", "ITEM_SOLD"].includes(event.type) && Number.isInteger(event.itemId)) {
    return restoreItem(states, event.itemId, allowedSlot === undefined ? null : [allowedSlot]);
  }
  if (event.type === "ITEM_UNDO") return reverseUndo(states, event);
  return [];
}

function reverseGroup(states, group, removals) {
  const assignments = removalAssignments(group.events, removals);
  const eventOrders = permutations(group.events.map((_, index) => index));
  let next = [];
  let slotConstrained = false;
  let saleSlotConstrained = false;
  for (const assignment of assignments) {
    for (const eventOrder of eventOrders) {
      let candidates = states;
      for (const eventIndex of [...eventOrder].reverse()) {
        candidates = reverseEvent(
          candidates,
          group.events[eventIndex],
          assignment.byEventIndex.get(eventIndex),
        );
        if (candidates.length === 0) break;
        if (candidates.length > PROFILE.maxBranches) {
          return { states: [], reason: "branch-limit", slotConstrained, saleSlotConstrained };
        }
      }
      if (candidates.length > 0) {
        slotConstrained ||= assignment.slotConstrained;
        saleSlotConstrained ||= assignment.saleSlotConstrained;
        next.push(...candidates);
      }
    }
  }
  next = deduplicate(next);
  if (next.length > PROFILE.maxBranches) {
    return { states: [], reason: "branch-limit", slotConstrained, saleSlotConstrained };
  }
  return {
    states: next,
    reason: next.length === 0 ? "state-contradiction" : null,
    slotConstrained,
    saleSlotConstrained,
  };
}

function relaxedStateKey(state) {
  return stateKey(state.slots);
}

function skippedSignature(state) {
  return state.skipped.join(",");
}

function deduplicateRelaxed(states) {
  const selected = new Map();
  for (const state of states) {
    const key = relaxedStateKey(state);
    const previous = selected.get(key);
    if (
      previous === undefined ||
      state.skipped.length < previous.skipped.length ||
      (state.skipped.length === previous.skipped.length &&
        skippedSignature(state) < skippedSignature(previous))
    ) {
      selected.set(key, state);
    }
  }
  const deduplicated = [...selected.values()];
  if (deduplicated.length <= PROFILE.maxBranches) return deduplicated;
  return deduplicated
    .sort(
      (left, right) =>
        left.skipped.length - right.skipped.length ||
        skippedSignature(left).localeCompare(skippedSignature(right)) ||
        relaxedStateKey(left).localeCompare(relaxedStateKey(right)),
    )
    .slice(0, PROFILE.maxBranches);
}

function eventIdentity(event) {
  if (event.type === "ITEM_UNDO") return `${event.beforeId ?? 0}:${event.afterId ?? 0}`;
  return String(event.itemId ?? 0);
}

function relaxedReverseEvent(states, event, allowedSlot) {
  const next = [];
  for (const state of states) {
    next.push({
      slots: state.slots,
      skipped: [...state.skipped, `${event.type}:${eventIdentity(event)}`],
    });
    for (const slots of reverseEvent([state.slots], event, allowedSlot)) {
      next.push({ slots, skipped: state.skipped });
    }
  }
  return deduplicateRelaxed(next);
}

function reverseGroupRelaxed(states, group, removals) {
  const assignments = removalAssignments(group.events, removals);
  const sourceOrder = group.events.map((_, index) => index);
  const eventOrders = [sourceOrder, [...sourceOrder].reverse()];
  let next = [];
  for (const assignment of assignments) {
    for (const eventOrder of eventOrders) {
      let candidates = states;
      for (const eventIndex of [...eventOrder].reverse()) {
        candidates = relaxedReverseEvent(
          candidates,
          group.events[eventIndex],
          assignment.byEventIndex.get(eventIndex),
        );
      }
      next.push(...candidates);
      next = deduplicateRelaxed(next);
    }
  }
  return deduplicateRelaxed(next);
}

function matchingRemovals(allRemovals, participantId, timestampMillis) {
  return allRemovals.filter(
    (removal) =>
      removal.participantId === participantId &&
      Math.abs(removal.timestampMillis - timestampMillis) <= PROFILE.timelineToleranceMillis,
  );
}

function reduceParticipant(fixture, participantId, finalSlots, timeline, removals) {
  const groups = timelineItemGroups(timeline, participantId);
  let states = [[...finalSlots]];
  let maximumBranchCount = 1;
  let slotConstrainedGroupCount = 0;
  let saleSlotConstrainedGroupCount = 0;
  let unconstrainedRemovalGroupCount = 0;
  let processedGroupCount = 0;
  let barrier = null;
  for (const group of groups) {
    const packetRemovals = matchingRemovals(removals, participantId, group.timestampMillis);
    const removalEventCount = group.events.filter((event) =>
      ["ITEM_DESTROYED", "ITEM_SOLD"].includes(event.type),
    ).length;
    const reversed = reverseGroup(states, group, packetRemovals);
    if (reversed.reason !== null) {
      barrier = {
        timestampMillis: group.timestampMillis,
        reason: reversed.reason,
        eventSignature: group.events.map((event) => event.type).join(">"),
        itemSignature: group.events
          .map((event) => `${event.itemId ?? event.beforeId ?? 0}:${event.afterId ?? 0}`)
          .join(">"),
        candidateRemovalSlots: packetRemovals.map((removal) => removal.slot),
        branchCountBefore: states.length,
      };
      break;
    }
    states = reversed.states;
    processedGroupCount += 1;
    maximumBranchCount = Math.max(maximumBranchCount, states.length);
    if (reversed.slotConstrained) slotConstrainedGroupCount += 1;
    if (reversed.saleSlotConstrained) saleSlotConstrainedGroupCount += 1;
    if (removalEventCount > 0 && !reversed.slotConstrained) unconstrainedRemovalGroupCount += 1;
  }
  return {
    replayId: fixture.replayId,
    partition: fixture.partition,
    participantId,
    finalSlots,
    timelineGroupCount: groups.length,
    processedSuffixGroupCount: processedGroupCount,
    reachedTimelineBeginning: processedGroupCount === groups.length,
    maximumBranchCount,
    survivingStateCount: states.length,
    slotConstrainedGroupCount,
    saleSlotConstrainedGroupCount,
    unconstrainedRemovalGroupCount,
    emptyBeginningStateAvailable:
      processedGroupCount === groups.length &&
      states.some((slots) => slots.every((itemId) => itemId === 0)),
    minimumBeginningItemCount:
      processedGroupCount === groups.length
        ? Math.min(...states.map((slots) => slots.filter((itemId) => itemId !== 0).length))
        : null,
    beginningStateSamples: processedGroupCount === groups.length ? states.slice(0, 10) : [],
    barrier,
  };
}

function reduceParticipantRelaxed(participantId, finalSlots, timeline) {
  const groups = timelineItemGroups(timeline, participantId);
  let states = [{ slots: [...finalSlots], skipped: [] }];
  let maximumBranchCount = 1;
  for (const group of groups) {
    // This diagnostic isolates Timeline completeness from the independent
    // 0x03F9 candidate-slot hypothesis tested by the strict suffix reducer.
    states = reverseGroupRelaxed(states, group, []);
    maximumBranchCount = Math.max(maximumBranchCount, states.length);
  }
  const bestObservedSkippedEventCount = Math.min(...states.map((state) => state.skipped.length));
  const best = states
    .filter((state) => state.skipped.length === bestObservedSkippedEventCount)
    .sort(
      (left, right) =>
        left.slots.filter(Boolean).length - right.slots.filter(Boolean).length ||
        skippedSignature(left).localeCompare(skippedSignature(right)) ||
        relaxedStateKey(left).localeCompare(relaxedStateKey(right)),
    )[0];
  return {
    bestObservedSkippedEventCount,
    residualBeginningItemCount: best.slots.filter(Boolean).length,
    emptyBeginningStateAvailable: states.some(
      (state) =>
        state.skipped.length === bestObservedSkippedEventCount &&
        state.slots.every((itemId) => itemId === 0),
    ),
    maximumBranchCount,
    survivingStateCount: states.length,
    skippedEvents: best.skipped,
    beginningSlots: best.slots,
  };
}

function timelineBalanceDiagnostic(participantId, finalSlots, timeline) {
  const balances = new Map();
  const adjust = (itemId, delta) => {
    if (!Number.isInteger(itemId) || itemId === 0) return;
    balances.set(itemId, (balances.get(itemId) ?? 0) + delta);
  };
  for (const itemId of finalSlots) adjust(itemId, 1);
  const events = timelineItemGroups(timeline, participantId).flatMap((group) => group.events);
  for (const event of events) {
    if (event.type === "ITEM_PURCHASED") adjust(event.itemId, -1);
    else if (["ITEM_DESTROYED", "ITEM_SOLD"].includes(event.type)) adjust(event.itemId, 1);
    else if (event.type === "ITEM_UNDO") {
      adjust(event.beforeId, 1);
      adjust(event.afterId, -1);
    }
  }
  const nonzero = [...balances.entries()].filter(([, count]) => count !== 0);
  return {
    eventCount: events.length,
    negativeUnitCount: nonzero.reduce((sum, [, count]) => sum + Math.max(0, -count), 0),
    positiveUnitCount: nonzero.reduce((sum, [, count]) => sum + Math.max(0, count), 0),
    negativeBalances: Object.fromEntries(nonzero.filter(([, count]) => count < 0)),
    positiveBalances: Object.fromEntries(nonzero.filter(([, count]) => count > 0)),
  };
}

function countBy(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = String(selector(row));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function topCounts(counts, limit) {
  return Object.fromEntries(
    Object.entries(counts)
      .sort(
        ([leftKey, leftCount], [rightKey, rightCount]) =>
          rightCount - leftCount || leftKey.localeCompare(rightKey),
      )
      .slice(0, limit),
  );
}

function summarize(rows) {
  const beginningRows = rows.filter((row) => row.reachedTimelineBeginning);
  return {
    participantCount: rows.length,
    timelineGroupCount: rows.reduce((sum, row) => sum + row.timelineGroupCount, 0),
    processedSuffixGroupCount: rows.reduce((sum, row) => sum + row.processedSuffixGroupCount, 0),
    reachedTimelineBeginningCount: beginningRows.length,
    emptyBeginningStateAvailableCount: beginningRows.filter(
      (row) => row.emptyBeginningStateAvailable,
    ).length,
    minimumResidualBeginningItemCount: beginningRows.length
      ? Math.min(...beginningRows.map((row) => row.minimumBeginningItemCount))
      : null,
    maximumResidualBeginningItemCount: beginningRows.length
      ? Math.max(...beginningRows.map((row) => row.minimumBeginningItemCount))
      : null,
    barrierReasons: countBy(rows, (row) => row.barrier?.reason ?? "BEGINNING_REACHED"),
    barrierEventSignatures: countBy(
      rows.filter((row) => row.barrier),
      (row) => row.barrier.eventSignature,
    ),
    maximumBranchCount: Math.max(...rows.map((row) => row.maximumBranchCount)),
    slotConstrainedGroupCount: rows.reduce((sum, row) => sum + row.slotConstrainedGroupCount, 0),
    saleSlotConstrainedGroupCount: rows.reduce(
      (sum, row) => sum + row.saleSlotConstrainedGroupCount,
      0,
    ),
    unconstrainedRemovalGroupCount: rows.reduce(
      (sum, row) => sum + row.unconstrainedRemovalGroupCount,
      0,
    ),
  };
}

function summarizeRelaxed(rows) {
  const skippedEvents = rows.flatMap((row) => row.relaxed.skippedEvents);
  const residualItems = rows.flatMap((row) => row.relaxed.beginningSlots.filter(Boolean));
  return {
    participantCount: rows.length,
    bestObservedSkippedEventCount: rows.reduce(
      (sum, row) => sum + row.relaxed.bestObservedSkippedEventCount,
      0,
    ),
    participantsRequiringSkippedEvents: rows.filter(
      (row) => row.relaxed.bestObservedSkippedEventCount > 0,
    ).length,
    emptyBeginningStateAvailableCount: rows.filter(
      (row) => row.relaxed.emptyBeginningStateAvailable,
    ).length,
    residualBeginningItemCount: rows.reduce(
      (sum, row) => sum + row.relaxed.residualBeginningItemCount,
      0,
    ),
    maximumBranchCount: Math.max(...rows.map((row) => row.relaxed.maximumBranchCount)),
    skippedEventTypes: countBy(skippedEvents, (event) => event.split(":")[0]),
    topSkippedEvents: topCounts(
      countBy(skippedEvents, (event) => event),
      20,
    ),
    topResidualBeginningItems: topCounts(
      countBy(residualItems, (itemId) => itemId),
      20,
    ),
  };
}

function summarizeBalance(rows) {
  const negative = rows.flatMap((row) =>
    Object.entries(row.timelineBalance.negativeBalances).flatMap(([itemId, count]) =>
      Array.from({ length: -count }, () => itemId),
    ),
  );
  const positive = rows.flatMap((row) =>
    Object.entries(row.timelineBalance.positiveBalances).flatMap(([itemId, count]) =>
      Array.from({ length: count }, () => itemId),
    ),
  );
  return {
    participantCount: rows.length,
    eventCount: rows.reduce((sum, row) => sum + row.timelineBalance.eventCount, 0),
    negativeUnitCount: negative.length,
    positiveUnitCount: positive.length,
    participantWithNegativeBalanceCount: rows.filter(
      (row) => row.timelineBalance.negativeUnitCount > 0,
    ).length,
    participantOverSevenPositiveUnitsCount: rows.filter(
      (row) => row.timelineBalance.positiveUnitCount > 7,
    ).length,
    maximumParticipantPositiveUnitCount: Math.max(
      ...rows.map((row) => row.timelineBalance.positiveUnitCount),
    ),
    viegoParticipantCount: rows.filter((row) => row.champion === "Viego").length,
    viegoPositiveUnitCount: rows
      .filter((row) => row.champion === "Viego")
      .reduce((sum, row) => sum + row.timelineBalance.positiveUnitCount, 0),
    nonViegoPositiveUnitCount: rows
      .filter((row) => row.champion !== "Viego")
      .reduce((sum, row) => sum + row.timelineBalance.positiveUnitCount, 0),
    exactZeroBalanceParticipantCount: rows.filter(
      (row) =>
        row.timelineBalance.negativeUnitCount === 0 && row.timelineBalance.positiveUnitCount === 0,
    ).length,
    topNegativeItemIds: topCounts(
      countBy(negative, (itemId) => itemId),
      20,
    ),
    topPositiveItemIds: topCounts(
      countBy(positive, (itemId) => itemId),
      20,
    ),
  };
}

function frozenMetrics(metrics) {
  return Object.fromEntries(
    Object.entries(metrics).map(([partition, values]) => [
      partition,
      {
        strict: {
          participantCount: values.strict.participantCount,
          timelineGroupCount: values.strict.timelineGroupCount,
          processedSuffixGroupCount: values.strict.processedSuffixGroupCount,
          reachedTimelineBeginningCount: values.strict.reachedTimelineBeginningCount,
          barrierReasons: values.strict.barrierReasons,
          slotConstrainedGroupCount: values.strict.slotConstrainedGroupCount,
          saleSlotConstrainedGroupCount: values.strict.saleSlotConstrainedGroupCount,
        },
        balance: {
          participantCount: values.balance.participantCount,
          eventCount: values.balance.eventCount,
          negativeUnitCount: values.balance.negativeUnitCount,
          positiveUnitCount: values.balance.positiveUnitCount,
          participantWithNegativeBalanceCount:
            values.balance.participantWithNegativeBalanceCount,
          participantOverSevenPositiveUnitsCount:
            values.balance.participantOverSevenPositiveUnitsCount,
          maximumParticipantPositiveUnitCount:
            values.balance.maximumParticipantPositiveUnitCount,
          viegoParticipantCount: values.balance.viegoParticipantCount,
          viegoPositiveUnitCount: values.balance.viegoPositiveUnitCount,
          nonViegoPositiveUnitCount: values.balance.nonViegoPositiveUnitCount,
          exactZeroBalanceParticipantCount: values.balance.exactZeroBalanceParticipantCount,
        },
        relaxed: {
          participantCount: values.relaxed.participantCount,
          bestObservedSkippedEventCount: values.relaxed.bestObservedSkippedEventCount,
          participantsRequiringSkippedEvents: values.relaxed.participantsRequiringSkippedEvents,
          emptyBeginningStateAvailableCount:
            values.relaxed.emptyBeginningStateAvailableCount,
          residualBeginningItemCount: values.relaxed.residualBeginningItemCount,
          maximumBranchCount: values.relaxed.maximumBranchCount,
          skippedEventTypes: values.relaxed.skippedEventTypes,
        },
      },
    ]),
  );
}

function runSelfTest() {
  const afterRecipe = [[3000, 0, 0, 0, 0, 0, 0]];
  const recipe = {
    events: [
      { type: "ITEM_DESTROYED", itemId: 1001 },
      { type: "ITEM_DESTROYED", itemId: 1002 },
      { type: "ITEM_PURCHASED", itemId: 3000 },
    ],
  };
  const reversed = reverseGroup(afterRecipe, recipe, [{ slot: 0 }, { slot: 1 }]);
  if (
    reversed.reason !== null ||
    !reversed.states.some(
      (slots) =>
        slots[0] === 1001 && slots[1] === 1002 && slots.slice(2).every((item) => item === 0),
    )
  ) {
    fail("Timeline-oracle backward recipe self-test failed.");
  }
  const undoSale = reverseUndo([[1001, 0, 0, 0, 0, 0, 0]], {
    type: "ITEM_UNDO",
    beforeId: 0,
    afterId: 1001,
  });
  if (undoSale.length !== 1 || undoSale[0].some((item) => item !== 0)) {
    fail("Timeline-oracle backward Undo self-test failed.");
  }
}

function inspectFixture(args, fixture) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const timelinePath = path.resolve(
    args.apiRoot,
    fixture.replayId.replaceAll("-", "_"),
    "timeline.json",
  );
  if (!fs.existsSync(replayPath) || !fs.existsSync(timelinePath)) {
    fail("Fixed replay/Timeline fixture is missing.", { replayPath, timelinePath });
  }
  const finalPlayers = loadFinalPlayers(args, replayPath);
  const timeline = readJson(timelinePath);
  const removals = loadRemovalCandidates(args, replayPath);
  const saleKeys = loadReplaySaleKeys(args, replayPath);
  for (const saleKey of saleKeys) {
    if (!removals.some((removal) => removal.physicalKey === saleKey)) {
      fail("Productive sale removal is absent from the candidate population.", {
        replayId: fixture.replayId,
        saleKey,
      });
    }
  }
  return Array.from({ length: 10 }, (_, index) => {
    const participantId = index + 1;
    const finalPlayer = finalPlayers[index];
    return {
      ...reduceParticipant(fixture, participantId, finalPlayer.slots, timeline, removals),
      champion: finalPlayer.champion,
      relaxed: reduceParticipantRelaxed(participantId, finalPlayer.slots, timeline),
      timelineBalance: timelineBalanceDiagnostic(participantId, finalPlayer.slots, timeline),
    };
  });
}

function main() {
  const args = parseArgs(process.argv);
  runSelfTest();
  for (const required of [args.cliPath, args.decoderProfilesPath, args.replayDir, args.apiRoot]) {
    if (!fs.existsSync(required)) fail("Required Timeline-oracle input is missing.", required);
  }
  const participants = PROFILE.fixtures.flatMap((fixture) => inspectFixture(args, fixture));
  const discovery = participants.filter((row) => row.partition === "D7");
  const holdout = participants.filter((row) => row.partition === "H3");
  const metrics = {
    discovery: {
      strict: summarize(discovery),
      balance: summarizeBalance(discovery),
      relaxed: summarizeRelaxed(discovery),
    },
    holdout: {
      strict: summarize(holdout),
      balance: summarizeBalance(holdout),
      relaxed: summarizeRelaxed(holdout),
    },
    combined: {
      strict: summarize(participants),
      balance: summarizeBalance(participants),
      relaxed: summarizeRelaxed(participants),
    },
  };
  const actualFrozenMetrics = frozenMetrics(metrics);
  if (JSON.stringify(actualFrozenMetrics) !== JSON.stringify(EXPECTED)) {
    fail("Frozen Timeline-oracle backward-slot metrics drifted.", {
      expected: EXPECTED,
      actual: actualFrozenMetrics,
    });
  }
  const output = {
    schema: "rofl-inventory-timeline-oracle-backward-slots-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayInputs: [
      "Embedded validated final seven-slot inventory from each saved ROFL summary",
      "Exact-framed champion-owned 0x03F9 removal candidate slots",
      "Productive replay-only item-sale provenance used as a completeness assertion",
    ],
    offlineOracle:
      "Saved Timeline ITEM_PURCHASED/ITEM_DESTROYED/ITEM_SOLD/ITEM_UNDO identities and ordering drive the backward experiment only; they cannot reach runtime or a product schema.",
    algorithm: {
      direction: "Backward from the replay-embedded final seven-slot tuple",
      itemIdentityRule:
        "Timeline does not promise causal order inside one timestamp. Enumerate same-timestamp event orders while branching over duplicate matching items and empty slots.",
      slotRule:
        "When one owner/time group has the same number of Timeline destroyed/sold events and replay 0x03F9 removals with distinct decoded candidate slots, enumerate the identity-to-slot permutations; otherwise leave restoration slots unconstrained.",
      undoRule:
        "Reverse ITEM_UNDO by replacing afterId with beforeId in the same slot, or branching over empty slots when afterId is zero.",
      relaxedDiagnostic:
        "A bounded 64-state dynamic program may skip a Timeline event at unit cost and retains the best observed history per seven-slot tuple. This is a diagnostic upper bound, not a proof of the global minimum; skipped events are never treated as decoded replay facts.",
      branchLimit: PROFILE.maxBranches,
    },
    metrics,
    participants,
    conclusion:
      metrics.combined.strict.reachedTimelineBeginningCount ===
        metrics.combined.strict.participantCount &&
      metrics.combined.strict.emptyBeginningStateAvailableCount ===
        metrics.combined.strict.participantCount
        ? "The offline Timeline oracle closes every backward inventory history. Replay-only promotion still requires decoding those identities and operations from ROFL bytes."
        : "The saved Timeline item stream does not close every seven-slot history from the replay final anchor. Its identities still localize contradictions and validate replay slot candidates, but omitted grants, transformations, or operation semantics remain to be decoded from ROFL bytes.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`Wrote ${outputPath}`);
}

main();
