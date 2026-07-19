#!/usr/bin/env node

// Offline research only. This checkpoint discovers conservative operation
// bundles from exact-framed saved ROFL chunk packets. Timeline labels are read
// strictly after packet extraction, exclusively for D7 selection and H3
// falsification; the output is never a decoder or runtime input.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  channel: 1,
  championIdBase: 0x400000ad,
  families: Object.freeze([
    Object.freeze({ name: "add", packetType: 0x0369, lengths: Object.freeze([14, 15]) }),
    Object.freeze({ name: "removal", packetType: 0x03f9, lengths: Object.freeze([6, 7]) }),
    Object.freeze({ name: "removalContext", packetType: 0x0146, lengths: Object.freeze([2, 3, 4]) }),
    Object.freeze({ name: "undoComponent", packetType: 0x0081, lengths: null }),
  ]),
});

const FIXTURES = Object.freeze([
  Object.freeze({ replayId: "EUW1-7919517389", partition: "D7", profileBlockCounts: { add: 195, removal: 161, removalContext: 386, undoComponent: 2 }, ownerTimeGroupCount: 616, unassociatedTimelineLabelCount: 16 }),
  Object.freeze({ replayId: "EUW1-7919624327", partition: "D7", profileBlockCounts: { add: 201, removal: 158, removalContext: 351, undoComponent: 1 }, ownerTimeGroupCount: 567, unassociatedTimelineLabelCount: 13 }),
  Object.freeze({ replayId: "EUW1-7920241664", partition: "D7", profileBlockCounts: { add: 274, removal: 223, removalContext: 503, undoComponent: 5 }, ownerTimeGroupCount: 801, unassociatedTimelineLabelCount: 15 }),
  Object.freeze({ replayId: "EUW1-7920292147", partition: "D7", profileBlockCounts: { add: 246, removal: 224, removalContext: 529, undoComponent: 7 }, ownerTimeGroupCount: 849, unassociatedTimelineLabelCount: 19 }),
  Object.freeze({ replayId: "EUW1-7920341366", partition: "D7", profileBlockCounts: { add: 183, removal: 142, removalContext: 321, undoComponent: 1 }, ownerTimeGroupCount: 524, unassociatedTimelineLabelCount: 14 }),
  Object.freeze({ replayId: "EUW1-7920364492", partition: "D7", profileBlockCounts: { add: 220, removal: 168, removalContext: 315, undoComponent: 1 }, ownerTimeGroupCount: 554, unassociatedTimelineLabelCount: 15 }),
  Object.freeze({ replayId: "EUW1-7920550565", partition: "D7", profileBlockCounts: { add: 256, removal: 217, removalContext: 442, undoComponent: 6 }, ownerTimeGroupCount: 734, unassociatedTimelineLabelCount: 15 }),
  Object.freeze({ replayId: "EUW1-7921377760", partition: "H3", profileBlockCounts: { add: 260, removal: 204, removalContext: 284, undoComponent: 0 }, ownerTimeGroupCount: 509, unassociatedTimelineLabelCount: 10 }),
  Object.freeze({ replayId: "EUW1-7921482297", partition: "H3", profileBlockCounts: { add: 444, removal: 383, removalContext: 720, undoComponent: 7 }, ownerTimeGroupCount: 1131, unassociatedTimelineLabelCount: 18 }),
  Object.freeze({ replayId: "EUW1-7921996430", partition: "H3", profileBlockCounts: { add: 240, removal: 194, removalContext: 363, undoComponent: 1 }, ownerTimeGroupCount: 633, unassociatedTimelineLabelCount: 16 }),
]);

const EXPECTED = Object.freeze({
  D7: Object.freeze({
    profileBlockCounts: Object.freeze({ add: 1575, removal: 1293, removalContext: 2847, undoComponent: 23 }),
    ownerTimeGroupCount: 4645,
    selectedTemplateCount: 27,
    selectedTemplateContentSha256: "fd1586bc5eb6a2d4151243773e16d37e38f1c3cac94c7dde93becd1c1f735344",
    templateGeneralizationContentSha256: "b65a6eeb4f351158600bcbb4b71f1cbdd116c8a429d8c319ec972ce99c27e7be",
    evaluation: Object.freeze({
      candidateGroupCount: 289, exactGroupCount: 289, falsePositiveGroupCount: 0, unselectedGroupCount: 4356,
      byPredictedLabel: Object.freeze({
        ITEM_DESTROYED: 6, "ITEM_DESTROYED+ITEM_DESTROYED": 27, "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED": 7,
        "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED+ITEM_PURCHASED": 2,
        "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED+ITEM_PURCHASED": 47,
        "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_PURCHASED": 102, "ITEM_DESTROYED+ITEM_PURCHASED": 20,
        "ITEM_PURCHASED+ITEM_PURCHASED+ITEM_PURCHASED": 22, ITEM_SOLD: 46, ITEM_UNDO: 10,
      }),
    }),
  }),
  H3: Object.freeze({
    profileBlockCounts: Object.freeze({ add: 944, removal: 781, removalContext: 1367, undoComponent: 8 }),
    ownerTimeGroupCount: 2273,
    evaluation: Object.freeze({
      candidateGroupCount: 136, exactGroupCount: 136, falsePositiveGroupCount: 0, unselectedGroupCount: 2137,
      byPredictedLabel: Object.freeze({
        ITEM_DESTROYED: 2, "ITEM_DESTROYED+ITEM_DESTROYED": 11, "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED": 4,
        "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_DESTROYED+ITEM_PURCHASED": 23,
        "ITEM_DESTROYED+ITEM_DESTROYED+ITEM_PURCHASED": 50, "ITEM_DESTROYED+ITEM_PURCHASED": 9,
        "ITEM_PURCHASED+ITEM_PURCHASED+ITEM_PURCHASED": 12, ITEM_SOLD: 25,
      }),
    }),
  }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "inventory-operation-sequences-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/research_inventory_operation_sequences_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function versionGroup(value) {
  return String(value ?? "").split(".").slice(0, 2).join(".");
}

function participantId(block) {
  const result = block.blockParam - PROFILE.championIdBase;
  return block.channel === PROFILE.channel && Number.isInteger(result) && result >= 1 && result <= 10 ? result : null;
}

function familyFor(block) {
  if (block.segmentType !== "chunk" || participantId(block) === null) return null;
  return PROFILE.families.find((family) => family.packetType === block.packetType
    && (family.lengths === null || family.lengths.includes(block.contentLength))) ?? null;
}

function physicalKey(block) {
  return `${block.segmentType}:${block.segmentId}:${block.chunkId}:${block.segmentPayloadOffset}:${block.blockIndex}:${block.sourceOffset}`;
}

function dumpProfileBlocks(cliPath, replayPath) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", replayPath,
    ...PROFILE.families.flatMap((family) => ["--packet-type", String(family.packetType)]),
    "--segment-type", "chunk",
    "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Packet dump failed: ${path.basename(replayPath)}.`);
  const dump = JSON.parse(result.stdout);
  assert(dump.valid && !(dump.errors?.length), `${path.basename(replayPath)} failed packet framing.`);
  assert(dump.gameVersion === PROFILE.exactReplayBuild,
    `${path.basename(replayPath)} has unsupported build ${dump.gameVersion}.`);
  assert(dump.packetTypeDumps?.length === PROFILE.families.length, `${path.basename(replayPath)} lacks a requested family.`);
  const blocks = [];
  for (const family of PROFILE.families) {
    const entry = dump.packetTypeDumps.find((candidate) => candidate.packetType === family.packetType);
    assert(entry && entry.emittedBlockCount === entry.matchingBlockCount && !entry.truncated,
      `${path.basename(replayPath)} has an incomplete 0x${family.packetType.toString(16)} chunk dump.`);
    for (const block of entry.blocks ?? []) {
      const matchedFamily = familyFor(block);
      if (!matchedFamily) continue;
      assert(matchedFamily.name === family.name, "Packet family selection became ambiguous.");
      blocks.push({ ...block, family: family.name, participantId: participantId(block) });
    }
  }
  const physicalKeys = new Set(blocks.map(physicalKey));
  assert(physicalKeys.size === blocks.length, `${path.basename(replayPath)} has duplicate relevant physical packets.`);
  return { gameVersion: dump.gameVersion, blocks };
}

function collectTimelineLabels(timelinePath) {
  return (readJson(timelinePath).info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => ["ITEM_PURCHASED", "ITEM_DESTROYED", "ITEM_SOLD", "ITEM_UNDO"].includes(event.type))
    .filter((event) => Number.isFinite(event.participantId) && Number.isFinite(event.timestamp))
    .map((event) => ({ type: event.type, participantId: event.participantId, timestampMillis: event.timestamp }));
}

function groupBlocks(replayId, blocks, labels) {
  const byOwnerTime = new Map();
  for (const block of blocks) {
    const key = `${block.participantId}:${block.timestampMillis}`;
    const group = byOwnerTime.get(key) ?? { replayId, participantId: block.participantId, timestampMillis: block.timestampMillis, blocks: [], labels: [] };
    group.blocks.push(block);
    byOwnerTime.set(key, group);
  }
  const groups = [...byOwnerTime.values()];
  let unassociatedLabelCount = 0;
  let ambiguousLabelCount = 0;
  for (const label of labels) {
    const matches = groups.filter((group) => group.participantId === label.participantId
      && Math.abs(group.timestampMillis - label.timestampMillis) <= 1);
    if (matches.length === 1) matches[0].labels.push(label);
    else if (matches.length === 0) unassociatedLabelCount += 1;
    else ambiguousLabelCount += 1;
  }
  assert(ambiguousLabelCount === 0, `${replayId} has an ambiguous Timeline-to-owner/time association.`);
  for (const group of groups) {
    group.blocks.sort((left, right) => left.sourceOffset - right.sourceOffset || left.blockIndex - right.blockIndex);
    group.signature = group.blocks.map((block) => `${block.family}:${block.contentLength}`).join(">");
    group.label = group.labels.map((label) => label.type).sort().join("+") || "NO_LABEL";
  }
  return { groups, unassociatedLabelCount };
}

function countBy(rows, selector) {
  const counts = new Map();
  for (const row of rows) {
    const key = selector(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => String(left).localeCompare(String(right))));
}

function profileBlockCounts(blocks) {
  const counts = countBy(blocks, (block) => block.family);
  for (const family of PROFILE.families) counts[family.name] ??= 0;
  return counts;
}

function exactTemplates(groups) {
  const rowsBySignature = new Map();
  for (const group of groups) {
    const rows = rowsBySignature.get(group.signature) ?? [];
    rows.push(group);
    rowsBySignature.set(group.signature, rows);
  }
  return [...rowsBySignature.entries()]
    .flatMap(([signature, rows]) => {
      const labels = new Set(rows.map((row) => row.label));
      return rows.length >= 2 && labels.size === 1 && !labels.has("NO_LABEL")
        ? [{ signature, label: rows[0].label, discoverySupport: rows.length }]
        : [];
    })
    .sort((left, right) => right.discoverySupport - left.discoverySupport
      || left.signature.localeCompare(right.signature) || left.label.localeCompare(right.label));
}

function evaluate(groups, templates) {
  const labelBySignature = new Map(templates.map((template) => [template.signature, template.label]));
  const candidates = groups.filter((group) => labelBySignature.has(group.signature));
  const exact = candidates.filter((group) => labelBySignature.get(group.signature) === group.label);
  return {
    candidateGroupCount: candidates.length,
    exactGroupCount: exact.length,
    falsePositiveGroupCount: candidates.length - exact.length,
    unselectedGroupCount: groups.length - candidates.length,
    byPredictedLabel: countBy(candidates, (group) => labelBySignature.get(group.signature)),
  };
}

function perTemplateEvaluation(groups, templates) {
  return templates.map((template) => {
    const matching = groups.filter((group) => group.signature === template.signature);
    const exact = matching.filter((group) => group.label === template.label);
    return {
      signature: template.signature,
      label: template.label,
      discoverySupport: template.discoverySupport,
      support: matching.length,
      correct: exact.length,
      extras: matching.length - exact.length,
    };
  });
}

function templateLeaveOneReplayOut(d7Fixtures, templates) {
  return templates.map((template) => ({
    signature: template.signature,
    label: template.label,
    discoverySupport: template.discoverySupport,
    folds: d7Fixtures.map((heldout) => {
      const trained = exactTemplates(d7Fixtures
        .filter((fixture) => fixture.report.replayId !== heldout.report.replayId)
        .flatMap((fixture) => fixture.groups));
      const selected = trained.find((candidate) => candidate.signature === template.signature && candidate.label === template.label);
      const heldoutGroups = heldout.groups.filter((group) => group.signature === template.signature);
      const exact = selected ? heldoutGroups.filter((group) => group.label === template.label).length : 0;
      return {
        heldoutReplayId: heldout.report.replayId,
        trainedTemplateAvailable: Boolean(selected),
        heldoutSupport: heldoutGroups.length,
        correct: exact,
        extras: selected ? heldoutGroups.length - exact : 0,
        failClosedUnseenGroupCount: selected ? 0 : heldoutGroups.length,
      };
    }),
  }));
}

function summarizeTemplateGeneralization(h3Rows, loroRows) {
  const h3 = perTemplateEvaluation(h3Rows, loroRows.map((row) => ({
    signature: row.signature, label: row.label, discoverySupport: row.discoverySupport,
  })));
  const h3SeenTemplateCount = h3.filter((row) => row.support > 0).length;
  const h3Extras = h3.reduce((sum, row) => sum + row.extras, 0);
  const loroFolds = loroRows.flatMap((row) => row.folds);
  return {
    h3ByTemplate: h3,
    h3SeenTemplateCount,
    h3UnseenTemplateCount: h3.length - h3SeenTemplateCount,
    h3Support: h3.reduce((sum, row) => sum + row.support, 0),
    h3Correct: h3.reduce((sum, row) => sum + row.correct, 0),
    h3Extras,
    d7LeaveOneReplayOut: loroRows,
    d7LoroAvailableCandidateCount: loroFolds.filter((fold) => fold.trainedTemplateAvailable).reduce((sum, fold) => sum + fold.heldoutSupport, 0),
    d7LoroCorrect: loroFolds.reduce((sum, fold) => sum + fold.correct, 0),
    d7LoroExtras: loroFolds.reduce((sum, fold) => sum + fold.extras, 0),
    d7LoroFailClosedUnseenGroupCount: loroFolds.reduce((sum, fold) => sum + fold.failClosedUnseenGroupCount, 0),
  };
}

function hashContent(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function inspectFixture(args, fixture) {
  const replayPath = path.join(args.replayDir, `${fixture.replayId}.rofl`);
  const fixtureDir = path.join(args.apiRoot, fixture.replayId.replaceAll("-", "_"));
  const matchPath = path.join(fixtureDir, "match.json");
  const timelinePath = path.join(fixtureDir, "timeline.json");
  assert(fs.existsSync(replayPath) && fs.existsSync(matchPath) && fs.existsSync(timelinePath),
    `Missing fixed replay/fixture inputs for ${fixture.replayId}.`);
  const match = readJson(matchPath);
  assert(match.info?.gameVersion === PROFILE.exactReplayBuild && versionGroup(match.info?.gameVersion) === "16.14",
    `${fixture.replayId} Match fixture fails exact-build gate.`);
  const dump = dumpProfileBlocks(args.cliPath, replayPath);
  const grouped = groupBlocks(fixture.replayId, dump.blocks, collectTimelineLabels(timelinePath));
  const counts = profileBlockCounts(dump.blocks);
  assert(sameJson(counts, fixture.profileBlockCounts), `${fixture.replayId} profile block count drifted.`);
  assert(grouped.groups.length === fixture.ownerTimeGroupCount, `${fixture.replayId} owner/time group count drifted.`);
  assert(grouped.unassociatedLabelCount === fixture.unassociatedTimelineLabelCount,
    `${fixture.replayId} unassociated Timeline label count drifted.`);
  return {
    groups: grouped.groups,
    report: {
      replayId: fixture.replayId,
      partition: fixture.partition,
      exactReplayBuild: dump.gameVersion,
      profileBlockCounts: counts,
      ownerTimeGroupCount: grouped.groups.length,
      unassociatedTimelineLabelCount: grouped.unassociatedLabelCount,
      replayPacketInput: path.resolve(replayPath),
      offlineValidationInputs: [path.resolve(matchPath), path.resolve(timelinePath)],
    },
  };
}

function assertPartition(name, inspected, expected, templates = null) {
  const groups = inspected.flatMap((fixture) => fixture.groups);
  const counts = profileBlockCounts(groups.flatMap((group) => group.blocks));
  assert(sameJson(counts, expected.profileBlockCounts), `${name} profile block counts drifted.`);
  assert(groups.length === expected.ownerTimeGroupCount, `${name} owner/time group count drifted.`);
  const result = { groups, profileBlockCounts: counts, ownerTimeGroupCount: groups.length };
  if (templates !== null) {
    const evaluation = evaluate(groups, templates);
    assert(sameJson(evaluation, expected.evaluation), `${name} evaluation count drifted.`);
    result.evaluation = evaluation;
  }
  return result;
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  args.cliPath = path.resolve(args.cliPath);
  args.replayDir = path.resolve(args.replayDir);
  args.apiRoot = path.resolve(args.apiRoot);
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);

  // D7 is fully framed, population-gated, and used to select template keys
  // before any H3 ROFL or Timeline fixture is opened.
  const d7Fixtures = FIXTURES.filter((fixture) => fixture.partition === "D7")
    .map((fixture) => inspectFixture(args, fixture));
  const d7PreSelection = assertPartition("D7", d7Fixtures, EXPECTED.D7);
  const templates = exactTemplates(d7PreSelection.groups);
  const templateContentSha256 = hashContent(templates);
  assert(templates.length === EXPECTED.D7.selectedTemplateCount, "D7 template count drifted.");
  assert(templateContentSha256 === EXPECTED.D7.selectedTemplateContentSha256, `D7 frozen template content drifted: ${templateContentSha256}.`);
  const d7 = assertPartition("D7", d7Fixtures, EXPECTED.D7, templates);
  assert(d7.evaluation.falsePositiveGroupCount === 0, "D7 template selection has a false positive.");

  // H3 is evaluation only: templates, labels, and profile boundaries are frozen.
  const h3Fixtures = FIXTURES.filter((fixture) => fixture.partition === "H3")
    .map((fixture) => inspectFixture(args, fixture));
  const h3 = assertPartition("H3", h3Fixtures, EXPECTED.H3, templates);
  assert(h3.evaluation.falsePositiveGroupCount === 0, "H3 template evaluation has a false positive.");
  const d7Loro = templateLeaveOneReplayOut(d7Fixtures, templates);
  const templateGeneralization = summarizeTemplateGeneralization(h3.groups, d7Loro);
  assert(templateGeneralization.h3Extras === 0 && templateGeneralization.h3Correct === templateGeneralization.h3Support,
    "Per-template H3 evaluation has an extra or a mismatch.");
  assert(templateGeneralization.d7LoroExtras === 0
    && templateGeneralization.d7LoroCorrect === templateGeneralization.d7LoroAvailableCandidateCount,
  "Per-template D7 LORO evaluation has an extra or a mismatch.");
  const templateGeneralizationContentSha256 = hashContent(templateGeneralization);
  if (EXPECTED.D7.templateGeneralizationContentSha256 !== null) {
    assert(templateGeneralizationContentSha256 === EXPECTED.D7.templateGeneralizationContentSha256,
      `Template generalization content drifted: ${templateGeneralizationContentSha256}.`);
  }

  const output = {
    schema: "rofl-inventory-operation-sequences-research/v1",
    generatedAtUtc: new Date().toISOString(),
    status: "research-validated-not-promoted",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    clientBinaryInput: false,
    replayOnly: true,
    profile: {
      exactReplayBuild: PROFILE.exactReplayBuild,
      segmentType: "chunk",
      channel: PROFILE.channel,
      participantIdFormula: "blockParam - 0x400000AD",
      familyLengths: Object.fromEntries(PROFILE.families.map((family) => [family.name, {
        packetType: `0x${family.packetType.toString(16).padStart(4, "0").toUpperCase()}`,
        contentLengths: family.lengths ?? "any",
      }])),
    },
    sourceBoundary: {
      packetInput: "Saved .rofl chunk packet bytes only.",
      selectionFeatures: "Exact champion owner, exact replay timestamp, packet family, content length, and physical source order within one owner/time group only. No payload bytes, Match data, Timeline data, Data Dragon, client binary, process, or network data are template features.",
      timelineRole: "Saved Timeline item events are read only after packet extraction as D7 selection and H3 false-positive labels; never runtime input.",
      matchRole: "Saved Match fixture is used only to enforce the fixed exact replay build.",
    },
    split: {
      discovery: "D7 is completely loaded, framed, owner/time-population-gated, and used to freeze template keys before H3 is opened.",
      holdout: "H3 evaluates frozen D7 templates over every relevant owner/time group. Unknown signatures are rejected rather than mapped.",
    },
    expected: EXPECTED,
    frozenTemplates: templates,
    frozenTemplateContentSha256: templateContentSha256,
    templateGeneralizationContentSha256,
    validation: {
      D7: { profileBlockCounts: d7.profileBlockCounts, ownerTimeGroupCount: d7.ownerTimeGroupCount, ...d7.evaluation },
      H3: { profileBlockCounts: h3.profileBlockCounts, ownerTimeGroupCount: h3.ownerTimeGroupCount, ...h3.evaluation },
      combined: {
        profileBlockCounts: profileBlockCounts([...d7.groups, ...h3.groups].flatMap((group) => group.blocks)),
        ownerTimeGroupCount: d7.groups.length + h3.groups.length,
        candidateGroupCount: d7.evaluation.candidateGroupCount + h3.evaluation.candidateGroupCount,
        exactGroupCount: d7.evaluation.exactGroupCount + h3.evaluation.exactGroupCount,
        falsePositiveGroupCount: d7.evaluation.falsePositiveGroupCount + h3.evaluation.falsePositiveGroupCount,
      },
      fixtures: [...d7Fixtures, ...h3Fixtures].map((fixture) => fixture.report),
      templateGeneralization,
    },
    failClosedBoundary: {
      unknownTemplateBehavior: "unavailable; no semantic operation is inferred",
      emittedRuntimeEvents: 0,
      availableFields: [],
      unavailableFields: ["purchase item identity", "sale item identity", "removed item identity", "slot", "item instance", "count/charges", "undo before/after", "inventory state", "gold delta"],
    },
    conclusion: "Twenty-seven replay-native same-owner/time structural bundle templates reproduce 289/289 D7 and 136/136 frozen H3 labelled groups with zero false-positive groups over the complete relevant chunk owner/time population. Per-template H3 and D7 leave-one-replay-out checks never infer an unavailable template: heldout signatures not re-selected from training remain fail-closed. This is a narrow research operation-shape result only: labels prove neither individual packet semantics nor item/slot/instance linkage, so no C++/Wasm/UI inventory output is authorized.",
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote ${outputPath}; D7=${d7.evaluation.exactGroupCount}/${d7.evaluation.candidateGroupCount}; H3=${h3.evaluation.exactGroupCount}/${h3.evaluation.candidateGroupCount}; templates=${templates.length}; contentSha256=${templateContentSha256}.`);
}

main();
