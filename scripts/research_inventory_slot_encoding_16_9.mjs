#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ADD_SLOT_BY_SYMBOL = new Map([
  [1, 0], [4, 1], [6, 2], [3, 3], [5, 4], [7, 5], [2, 6],
]);

function parseArgs(argv) {
  const args = {
    inputPath: path.join("artifacts", "inventory-packet-research-16.9.json"),
    outputPath: path.join("artifacts", "inventory-slot-encoding-research-16.9.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--input" && index + 1 < argv.length) args.inputPath = argv[++index];
    else if (argv[index] === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else throw new Error(`Unknown or incomplete argument: ${argv[index]}`);
  }
  return args;
}

function readBit(bytes, offset) {
  return (bytes[offset >> 3] >> (offset & 7)) & 1;
}

function readBits(bytes, offset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) value |= readBit(bytes, offset + bit) << bit;
  return value >>> 0;
}

function countBy(values, selector) {
  const counts = new Map();
  for (const value of values) {
    const key = String(selector(value));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function decodeCandidateAddSlot(contentHex) {
  const bytes = Buffer.from(contentHex, "hex");
  const symbol = (readBit(bytes, 0) << 3) | readBits(bytes, 10, 3);
  return { symbol, slot: ADD_SLOT_BY_SYMBOL.get(symbol) ?? null };
}

function buildHighConfidenceInitialAddLabels(artifact) {
  const trinketIds = new Set([3340, 3363, 3364]);
  const grouped = new Map();
  for (const group of artifact.transactionSamples ?? []) {
    if (group.participantId < 1 || group.participantId > 10) continue;
    const key = `${group.replayId}:${group.participantId}`;
    const list = grouped.get(key) ?? [];
    list.push(group);
    grouped.set(key, list);
  }

  const labels = [];
  const stoppedReasons = new Map();
  for (const [playerKey, groups] of grouped) {
    const slots = Array(7).fill(0);
    let stopped = false;
    groups.sort((left, right) => left.timestampMillis - right.timestampMillis);
    for (const group of groups) {
      if (stopped) continue;
      const packetCount = group.addOrUpdates.length + group.removals.length;
      if (packetCount === 0) continue;
      const purchases = group.apiEvents.filter((event) => event.type === "ITEM_PURCHASED");
      const isSimpleAdd = purchases.length === 1
        && group.apiEvents.length === 1
        && group.addOrUpdates.length === 1
        && group.removals.length === 0
        && purchases[0].itemId === group.addOrUpdates[0].decodedItemId;
      if (!isSimpleAdd) {
        stopped = true;
        const signature = [
          group.apiEvents.map((event) => event.type).join("+") || "NO_API_EVENT",
          `a${group.addOrUpdates.length}r${group.removals.length}`,
        ].join("|");
        stoppedReasons.set(signature, (stoppedReasons.get(signature) ?? 0) + 1);
        continue;
      }

      const itemId = group.addOrUpdates[0].decodedItemId;
      let slot = -1;
      if (trinketIds.has(itemId)) {
        if (slots[6] !== 0 && slots[6] !== itemId) {
          stopped = true;
          stoppedReasons.set("trinket-slot-conflict", (stoppedReasons.get("trinket-slot-conflict") ?? 0) + 1);
          continue;
        }
        slot = 6;
      } else {
        if (slots.includes(itemId)) {
          stopped = true;
          stoppedReasons.set("duplicate-item-ambiguous", (stoppedReasons.get("duplicate-item-ambiguous") ?? 0) + 1);
          continue;
        }
        slot = slots.slice(0, 6).findIndex((value) => value === 0);
        if (slot < 0) {
          stopped = true;
          stoppedReasons.set("no-empty-main-slot", (stoppedReasons.get("no-empty-main-slot") ?? 0) + 1);
          continue;
        }
      }
      slots[slot] = itemId;
      labels.push({
        playerKey,
        replayId: group.replayId,
        participantId: group.participantId,
        timestampMillis: group.timestampMillis,
        slot,
        itemId,
        contentHex: group.addOrUpdates[0].contentHex,
      });
    }
  }
  return {
    labels,
    playerCount: grouped.size,
    stoppedReasons: Object.fromEntries([...stoppedReasons].sort((left, right) => right[1] - left[1])),
  };
}

function buildTerminalFinalItemLabels(artifact) {
  const samplesByPlayer = new Map();
  for (const group of artifact.transactionSamples ?? []) {
    if (group.participantId < 1 || group.participantId > 10) continue;
    const key = `${group.replayId}:${group.participantId}`;
    const list = samplesByPlayer.get(key) ?? [];
    list.push(group);
    samplesByPlayer.set(key, list);
  }
  const finalByPlayer = new Map();
  for (const replay of artifact.replayRows ?? []) {
    for (const participant of replay.finalInventories ?? []) {
      finalByPlayer.set(`${replay.replayId}:${participant.participantId}`, participant.items);
    }
  }

  const labels = [];
  for (const [playerKey, groups] of samplesByPlayer) {
    const finalItems = finalByPlayer.get(playerKey);
    if (!finalItems) continue;
    const finalCounts = countBy(finalItems.filter((itemId) => itemId > 0), (itemId) => itemId);
    const allAdds = groups.flatMap((group) => group.addOrUpdates.map((block) => ({
      ...block,
      timestampMillis: group.timestampMillis,
      replayId: group.replayId,
      participantId: group.participantId,
    }))).sort((left, right) => left.timestampMillis - right.timestampMillis || left.blockIndex - right.blockIndex);
    const allRemovals = groups.flatMap((group) => group.removals.map((block) => ({
      ...block,
      timestampMillis: group.timestampMillis,
    })));
    for (let slot = 0; slot < finalItems.length; slot += 1) {
      const itemId = finalItems[slot];
      if (itemId <= 0 || Number(finalCounts[String(itemId)] ?? 0) !== 1) continue;
      const candidates = allAdds.filter((add) => add.decodedItemId === itemId);
      const candidate = candidates[candidates.length - 1];
      if (!candidate) continue;
      if (allRemovals.some((removal) => removal.timestampMillis > candidate.timestampMillis)) continue;
      labels.push({
        playerKey,
        replayId: candidate.replayId,
        participantId: candidate.participantId,
        timestampMillis: candidate.timestampMillis,
        slot,
        itemId,
        contentHex: candidate.contentHex,
      });
    }
  }
  return labels;
}

function scoreCategoricalFeature(rows, feature) {
  const training = new Map();
  for (const row of rows) {
    const value = feature(row);
    const counts = training.get(value) ?? new Map();
    counts.set(row.slot, (counts.get(row.slot) ?? 0) + 1);
    training.set(value, counts);
  }
  const mapping = new Map();
  for (const [value, counts] of training) {
    mapping.set(value, [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]);
  }
  const correct = rows.filter((row) => mapping.get(feature(row)) === row.slot).length;
  return {
    correct,
    rate: rows.length ? correct / rows.length : 0,
    valueCount: mapping.size,
    mapping: Object.fromEntries([...mapping].sort((left, right) => left[0] - right[0])),
  };
}

function scanContiguousFields(rows) {
  const candidates = [];
  for (let width = 2; width <= 12; width += 1) {
    for (let offset = 0; offset <= 32 - width; offset += 1) {
      const score = scoreCategoricalFeature(rows, (row) => readBits(row.bytes, offset, width));
      candidates.push({ offset, width, ...score });
    }
  }
  candidates.sort((left, right) =>
    right.rate - left.rate || left.valueCount - right.valueCount || left.width - right.width || left.offset - right.offset);
  return candidates.slice(0, 40);
}

function scoreSlotBit(rows, targetSlotBit, sourceBits) {
  let best = null;
  const combinationCount = 1 << sourceBits.length;
  for (let mask = 1; mask < combinationCount; mask += 1) {
    for (let constant = 0; constant <= 1; constant += 1) {
      let correct = 0;
      for (const row of rows) {
        let decoded = constant;
        for (let index = 0; index < sourceBits.length; index += 1) {
          if ((mask & (1 << index)) !== 0) decoded ^= readBit(row.bytes, sourceBits[index]);
        }
        if (decoded === ((row.slot >> targetSlotBit) & 1)) correct += 1;
      }
      const candidate = {
        targetSlotBit,
        sourceBits: sourceBits.filter((_, index) => (mask & (1 << index)) !== 0),
        constant,
        correct,
        rate: rows.length ? correct / rows.length : 0,
      };
      if (!best
        || candidate.rate > best.rate
        || (candidate.rate === best.rate && candidate.sourceBits.length < best.sourceBits.length)) best = candidate;
    }
  }
  return best;
}

function scanXorBitModels(rows) {
  const models = [];
  const bitIndices = Array.from({ length: 32 }, (_, index) => index);
  const sourceSets = [
    ...bitIndices.map((bit) => [bit]),
    ...bitIndices.flatMap((left) => bitIndices.filter((right) => right > left).map((right) => [left, right])),
    ...bitIndices.flatMap((left) => bitIndices
      .filter((middle) => middle > left)
      .flatMap((middle) => bitIndices.filter((right) => right > middle).map((right) => [left, middle, right]))),
  ];
  for (let targetSlotBit = 0; targetSlotBit < 3; targetSlotBit += 1) {
    let best = null;
    for (const sourceBits of sourceSets) {
      const candidate = scoreSlotBit(rows, targetSlotBit, sourceBits);
      if (!best
        || candidate.rate > best.rate
        || (candidate.rate === best.rate && candidate.sourceBits.length < best.sourceBits.length)) best = candidate;
    }
    models.push(best);
  }
  return models;
}

function buildSameItemReplacementPairs(artifact) {
  return (artifact.transactionSamples ?? [])
    .filter((group) =>
      group.apiEvents.length === 2
      && group.apiEvents[0].type === "ITEM_DESTROYED"
      && group.apiEvents[1].type === "ITEM_PURCHASED"
      && group.apiEvents[0].itemId === 2055
      && group.apiEvents[1].itemId === 2055
      && group.addOrUpdates.length === 1
      && group.removals.length === 1)
    .map((group) => ({
      replayId: group.replayId,
      participantId: group.participantId,
      timestampMillis: group.timestampMillis,
      add: group.addOrUpdates[0],
      removal: group.removals[0],
      addSlot: decodeCandidateAddSlot(group.addOrUpdates[0].contentHex).slot,
      removalBytes: Buffer.from(group.removals[0].contentHex, "hex"),
    }))
    .filter((pair) => pair.addSlot != null);
}

function scanRemovalContiguousFields(pairs) {
  const rows = pairs.map((pair) => ({ ...pair, slot: pair.addSlot }));
  const candidates = [];
  for (let width = 2; width <= 12; width += 1) {
    for (let offset = 0; offset <= 24 - width; offset += 1) {
      const score = scoreCategoricalFeature(rows, (row) => readBits(row.removalBytes, offset, width));
      candidates.push({ offset, width, ...score });
    }
  }
  candidates.sort((left, right) =>
    right.rate - left.rate || left.valueCount - right.valueCount || left.width - right.width || left.offset - right.offset);
  return candidates.slice(0, 40);
}

function scanRemovalBitSubsets(pairs) {
  const rows = pairs.map((pair) => ({ ...pair, slot: pair.addSlot }));
  const candidates = [];
  const bitIndices = Array.from({ length: 24 }, (_, index) => index);
  for (let width = 2; width <= 4; width += 1) {
    function visit(selected, next) {
      if (selected.length === width) {
        const score = scoreCategoricalFeature(rows, (row) => selected.reduce(
          (value, bit, index) => value | (readBit(row.removalBytes, bit) << index), 0));
        if (score.valueCount >= 2 && score.valueCount <= 8) candidates.push({ bits: [...selected], ...score });
        return;
      }
      for (let bit = next; bit <= bitIndices.length - (width - selected.length); bit += 1) {
        selected.push(bit);
        visit(selected, bit + 1);
        selected.pop();
      }
    }
    visit([], 0);
  }
  candidates.sort((left, right) =>
    right.rate - left.rate || left.valueCount - right.valueCount || left.bits.length - right.bits.length);
  return candidates.slice(0, 40);
}

function buildOfflineItemLifecyclePairs(artifact) {
  const grouped = new Map();
  for (const group of artifact.transactionSamples ?? []) {
    if (group.participantId < 1 || group.participantId > 10) continue;
    const key = `${group.replayId}:${group.participantId}`;
    const list = grouped.get(key) ?? [];
    list.push(group);
    grouped.set(key, list);
  }
  const pairs = [];
  for (const groups of grouped.values()) {
    const latestAddByItemId = new Map();
    groups.sort((left, right) => left.timestampMillis - right.timestampMillis);
    for (const group of groups) {
      const removalEvents = group.apiEvents.filter((event) =>
        event.type === "ITEM_DESTROYED" || event.type === "ITEM_SOLD");
      if (group.removals.length === 1 && removalEvents.length === 1) {
        const itemId = removalEvents[0].itemId;
        const add = latestAddByItemId.get(itemId);
        if (add) {
          pairs.push({
            replayId: group.replayId,
            participantId: group.participantId,
            itemId,
            addTimestampMillis: add.timestampMillis,
            removalTimestampMillis: group.timestampMillis,
            add: add.block,
            removal: group.removals[0],
          });
        }
        latestAddByItemId.delete(itemId);
      } else {
        for (const event of removalEvents) latestAddByItemId.delete(event.itemId);
      }
      for (const block of group.addOrUpdates) {
        latestAddByItemId.set(block.decodedItemId, {
          timestampMillis: group.timestampMillis,
          block,
        });
      }
    }
  }
  return pairs;
}

function bidirectionalFieldScore(pairs, addOffset, removalOffset, width) {
  const byAdd = new Map();
  const byRemoval = new Map();
  for (const pair of pairs) {
    const addValue = readBits(Buffer.from(pair.add.contentHex, "hex"), addOffset, width);
    const removalValue = readBits(Buffer.from(pair.removal.contentHex, "hex"), removalOffset, width);
    const removalCounts = byAdd.get(addValue) ?? new Map();
    removalCounts.set(removalValue, (removalCounts.get(removalValue) ?? 0) + 1);
    byAdd.set(addValue, removalCounts);
    const addCounts = byRemoval.get(removalValue) ?? new Map();
    addCounts.set(addValue, (addCounts.get(addValue) ?? 0) + 1);
    byRemoval.set(removalValue, addCounts);
  }
  const forward = [...byAdd.values()].reduce((sum, counts) => sum + Math.max(...counts.values()), 0);
  const reverse = [...byRemoval.values()].reduce((sum, counts) => sum + Math.max(...counts.values()), 0);
  return {
    addOffset,
    removalOffset,
    width,
    addValueCount: byAdd.size,
    removalValueCount: byRemoval.size,
    support: Math.min(forward, reverse),
    rate: pairs.length ? Math.min(forward, reverse) / pairs.length : 0,
  };
}

function scanLifecycleFieldLinkage(pairs) {
  const candidates = [];
  for (let width = 2; width <= 16; width += 1) {
    for (let addOffset = 0; addOffset <= 112 - width; addOffset += 1) {
      for (let removalOffset = 0; removalOffset <= 48 - width; removalOffset += 1) {
        const score = bidirectionalFieldScore(pairs, addOffset, removalOffset, width);
        if (score.addValueCount < 3 || score.removalValueCount < 3) continue;
        if (score.addValueCount > 128 || score.removalValueCount > 128) continue;
        candidates.push(score);
      }
    }
  }
  candidates.sort((left, right) =>
    right.rate - left.rate
    || Math.abs(left.addValueCount - left.removalValueCount) - Math.abs(right.addValueCount - right.removalValueCount)
    || left.width - right.width
    || left.addOffset - right.addOffset
    || left.removalOffset - right.removalOffset);
  return {
    topCandidates: candidates.slice(0, 60),
    slotSizedCandidates: candidates.filter((candidate) =>
      candidate.addValueCount >= 5 && candidate.removalValueCount >= 5
      && candidate.addValueCount <= 12 && candidate.removalValueCount <= 12).slice(0, 60),
    instanceSizedCandidates: candidates.filter((candidate) =>
      candidate.addValueCount >= 13 && candidate.removalValueCount >= 13).slice(0, 60),
  };
}

function buildRemovalSlotLabelsFromCandidateAddState(artifact) {
  const grouped = new Map();
  for (const group of artifact.transactionSamples ?? []) {
    if (group.participantId < 1 || group.participantId > 10) continue;
    const key = `${group.replayId}:${group.participantId}`;
    const list = grouped.get(key) ?? [];
    list.push(group);
    grouped.set(key, list);
  }
  const labels = [];
  for (const groups of grouped.values()) {
    const slots = Array(7).fill(0);
    groups.sort((left, right) => left.timestampMillis - right.timestampMillis);
    for (const group of groups) {
      const removalEvents = group.apiEvents.filter((event) =>
        event.type === "ITEM_DESTROYED" || event.type === "ITEM_SOLD");
      if (group.removals.length === 1 && removalEvents.length === 1) {
        const itemId = removalEvents[0].itemId;
        const matchingSlots = slots.flatMap((value, slot) => value === itemId ? [slot] : []);
        if (matchingSlots.length === 1) {
          labels.push({
            replayId: group.replayId,
            participantId: group.participantId,
            timestampMillis: group.timestampMillis,
            itemId,
            slot: matchingSlots[0],
            contentHex: group.removals[0].contentHex,
            bytes: Buffer.from(group.removals[0].contentHex, "hex"),
          });
        }
      }
      for (const event of removalEvents) {
        const slot = slots.findIndex((itemId) => itemId === event.itemId);
        if (slot >= 0) slots[slot] = 0;
      }
      for (const event of group.apiEvents.filter((event) => event.type === "ITEM_UNDO")) {
        const slot = slots.findIndex((itemId) => itemId === event.beforeId);
        if (slot >= 0) slots[slot] = event.afterId ?? 0;
      }
      for (const block of group.addOrUpdates) {
        const decoded = decodeCandidateAddSlot(block.contentHex);
        if (decoded.slot != null) slots[decoded.slot] = block.decodedItemId;
      }
    }
  }
  return labels;
}

function scanRemovalLabelContiguousFields(rows) {
  const candidates = [];
  for (let width = 2; width <= 12; width += 1) {
    for (let offset = 0; offset <= 48 - width; offset += 1) {
      const score = scoreCategoricalFeature(rows, (row) => readBits(row.bytes, offset, width));
      if (score.valueCount >= 2 && score.valueCount <= 32) candidates.push({ offset, width, ...score });
    }
  }
  candidates.sort((left, right) =>
    right.rate - left.rate || left.valueCount - right.valueCount || left.width - right.width || left.offset - right.offset);
  return candidates.slice(0, 60);
}

function scanRemovalLabelBitTriples(rows) {
  const candidates = [];
  for (let left = 0; left < 46; left += 1) {
    for (let middle = left + 1; middle < 47; middle += 1) {
      for (let right = middle + 1; right < 48; right += 1) {
        const bits = [left, middle, right];
        const score = scoreCategoricalFeature(rows, (row) => bits.reduce(
          (value, bit, index) => value | (readBit(row.bytes, bit) << index), 0));
        if (score.valueCount >= 3) candidates.push({ bits, ...score });
      }
    }
  }
  candidates.sort((left, right) =>
    right.rate - left.rate || left.valueCount - right.valueCount || left.bits[0] - right.bits[0]);
  return candidates.slice(0, 60);
}

function main() {
  const args = parseArgs(process.argv);
  const artifact = JSON.parse(fs.readFileSync(path.resolve(args.inputPath), "utf8"));
  const labelled = buildHighConfidenceInitialAddLabels(artifact);
  const rows = labelled.labels.map((label) => ({ ...label, bytes: Buffer.from(label.contentHex, "hex") }));
  const finalRows = buildTerminalFinalItemLabels(artifact)
    .map((label) => ({ ...label, bytes: Buffer.from(label.contentHex, "hex") }));
  const sameItemPairs = buildSameItemReplacementPairs(artifact);
  const lifecyclePairs = buildOfflineItemLifecyclePairs(artifact);
  const candidateRemovalLabels = buildRemovalSlotLabelsFromCandidateAddState(artifact);
  const candidateInitialMatches = rows.filter((row) => decodeCandidateAddSlot(row.contentHex).slot === row.slot).length;
  const candidateFinalMatches = finalRows.filter((row) => decodeCandidateAddSlot(row.contentHex).slot === row.slot).length;
  const output = {
    schema: "rofl-inventory-slot-encoding-research-16.9/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-validation-only",
    runtimeInput: false,
    methodology: {
      description: "Labels only deterministic initial simple adds before the first removal, transform, duplicate, or packet-only update for each participant.",
      caveat: "The slot labels are an offline discovery oracle and are never runtime inputs.",
      searchedPayloadPrefixBits: [0, 31],
    },
    labelSummary: {
      playerCount: labelled.playerCount,
      labelledAddCount: rows.length,
      replayCount: new Set(rows.map((row) => row.replayId)).size,
      slotCounts: countBy(rows, (row) => row.slot),
      itemCounts: countBy(rows, (row) => row.itemId),
      stoppedReasons: labelled.stoppedReasons,
      prefixCodeCountsBySlot: Object.fromEntries(Array.from({ length: 7 }, (_, slot) => [
        slot,
        countBy(rows.filter((row) => row.slot === slot), (row) =>
          (readBit(row.bytes, 0) << 3) | readBits(row.bytes, 10, 3)),
      ])),
    },
    contiguousFieldCandidates: scanContiguousFields(rows),
    xorBitModels: scanXorBitModels(rows),
    candidateAddSlotDecoder: {
      formula: "symbol = (readBit(payload, 0) << 3) | readBitsLE(payload, 10, 3)",
      slotBySymbol: Object.fromEntries(ADD_SLOT_BY_SYMBOL),
      initialOracleMatches: candidateInitialMatches,
      initialOracleSampleCount: rows.length,
      initialOracleRate: rows.length ? candidateInitialMatches / rows.length : 0,
      terminalFinalOracleMatches: candidateFinalMatches,
      terminalFinalOracleSampleCount: finalRows.length,
      terminalFinalOracleRate: finalRows.length ? candidateFinalMatches / finalRows.length : 0,
    },
    sameItemReplacementRemovalLinkage: {
      pairCount: sameItemPairs.length,
      decodedAddSlotCounts: countBy(sameItemPairs, (pair) => pair.addSlot),
      contiguousFieldCandidates: scanRemovalContiguousFields(sameItemPairs),
      bitSubsetCandidates: scanRemovalBitSubsets(sameItemPairs),
    },
    offlineItemLifecycleLinkage: {
      methodology: "Links a single labelled destroy/sale removal to the latest prior add/update of the same item for that participant. Riot labels are offline discovery input only.",
      pairCount: lifecyclePairs.length,
      replayCount: new Set(lifecyclePairs.map((pair) => pair.replayId)).size,
      itemCounts: countBy(lifecyclePairs, (pair) => pair.itemId),
      fieldCandidates: scanLifecycleFieldLinkage(lifecyclePairs),
    },
    candidateRemovalSlotDecoder: {
      methodology: "Maintains tentative slots with the candidate add symbol and labels only single removals whose offline item ID appears in exactly one tentative slot.",
      labelledRemovalCount: candidateRemovalLabels.length,
      replayCount: new Set(candidateRemovalLabels.map((row) => row.replayId)).size,
      slotCounts: countBy(candidateRemovalLabels, (row) => row.slot),
      contiguousFieldCandidates: scanRemovalLabelContiguousFields(candidateRemovalLabels),
      bitTripleCandidates: scanRemovalLabelBitTriples(candidateRemovalLabels),
    },
    terminalFinalItemOracle: {
      methodology: "Labels a unique final-slot item only when its last decoded add has no later removal packet for that participant. Item swaps remain a possible source of label noise.",
      labelledAddCount: finalRows.length,
      replayCount: new Set(finalRows.map((row) => row.replayId)).size,
      slotCounts: countBy(finalRows, (row) => row.slot),
      contiguousFieldCandidates: scanContiguousFields(finalRows),
      xorBitModels: scanXorBitModels(finalRows),
    },
    conclusion: "The initial add symbol is falsified as a general slot decoder by later/final inventory labels, and no removal field or add/removal instance link reaches the exact corpus gate. No runtime slot decoder is promoted.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote patch 16.9 inventory slot encoding research to ${outputPath}`);
  console.log(`labels=${rows.length}, replays=${output.labelSummary.replayCount}, slots=${JSON.stringify(output.labelSummary.slotCounts)}`);
  console.log(`bestField=${JSON.stringify(output.contiguousFieldCandidates[0])}`);
  console.log(`xorModels=${JSON.stringify(output.xorBitModels)}`);
}

main();
