#!/usr/bin/env node
// Replay-byte-only research: patch-16.14 keyframe 0x01EB physical record directory.
// This establishes only a byte-level directory invariant. It assigns no gameplay
// field, participant, inventory, or 0x02EB-cell meaning to any physical index.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = "16.14.794.5912";
const OWNER_BASE = 0x400000ad;
const RECORD_TYPE = 0x01eb;
const PARALLEL_TYPE = 0x02eb;
const BRIDGE_TYPES = [0x0233, 0x0306, 0x0452, 0x007d];
const STREAM_VALUE_TYPE = 0x0306;
const STREAM_END_TYPE = 0x0151;
const STREAM_VALUE_LENGTHS = new Set([2, 3, 6, 7, 10, 11]);
const SKELETON_AFTER_PARALLEL_TYPE = 0x027c;
const SKELETON_BEFORE_END_TYPE = 0x011a;
const SKELETON_AFTER_PARALLEL_LENGTH_DOMAINS = [[2, 3, 4], [2, 3, 4], [2, 3, 4], [3, 4, 5]];
const SKELETON_BEFORE_END_LENGTH_DOMAINS = [[1], [1], [1], [2]];
const RECORDS_PER_OWNER_RUN = 366;
const PARALLEL_PAYLOAD_LENGTH = 1479;
const D7 = [
  "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664", "EUW1-7920292147",
  "EUW1-7920341366", "EUW1-7920364492", "EUW1-7920550565",
];
const H3 = ["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"];
const EXPECTED_OWNER_SEGMENT_GROUPS = new Map([
  ["EUW1-7919517389", 270], ["EUW1-7919624327", 270], ["EUW1-7920241664", 350],
  ["EUW1-7920292147", 410], ["EUW1-7920341366", 260], ["EUW1-7920364492", 260],
  ["EUW1-7920550565", 350], ["EUW1-7921377760", 250], ["EUW1-7921482297", 480],
  ["EUW1-7921996430", 300],
]);

function usage() {
  return [
    "Usage: node scripts/research_keyframe_record_directory_16_14.mjs [options]",
    "  --cli <path>         Native rofl_core_cli executable",
    "  --replay-dir <path>  Directory containing the fixed-profile .rofl files",
    "  --output <path>      JSON report output path",
    "  --help               Show this help",
  ].join("\n");
}
function parseArgs(argv) {
  const options = {
    cli: path.join(ROOT, "build", "packages", "rofl-core", "Debug", "rofl_core_cli.exe"),
    replayDir: path.join(ROOT, "replays"),
    output: path.join(ROOT, "tmp", "research_keyframe_record_directory_16_14.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") { console.log(usage()); process.exit(0); }
    const key = argument === "--cli" ? "cli" : argument === "--replay-dir" ? "replayDir" : argument === "--output" ? "output" : null;
    if (!key || index + 1 >= argv.length) throw new Error(`Unknown or incomplete argument: ${argument}\n${usage()}`);
    options[key] = path.resolve(argv[index + 1]);
    index += 1;
  }
  return options;
}
function fail(message) { throw new Error(message); }
function increment(map, key) { map.set(key, (map.get(key) ?? 0) + 1); }
function addSet(map, key, value) { const set = map.get(key) ?? new Set(); set.add(value); map.set(key, set); }
function toHex(bytes) { return Buffer.from(bytes).toString("hex").toUpperCase(); }
function compactFailure(failures, detail) { if (failures.length < 8) failures.push(detail); }
function newRecordState() {
  return { lengths: new Set(), suffixes: new Set(), replaySuffixes: new Map(), ownerReplaySuffixes: new Map(), samples: 0 };
}
function packetTypeName(packetType) { return `0x${packetType.toString(16).padStart(4, "0")}`; }
function bridgeTypeLengthAllowed(block) {
  return (block.packetType === 0x0233 && [1, 8, 9, 14].includes(block.contentLength)) ||
    (block.packetType === 0x0306 && [3, 7, 11].includes(block.contentLength)) ||
    (block.packetType === 0x0452 && block.contentLength === 3) ||
    (block.packetType === 0x007d && [8, 9].includes(block.contentLength));
}
function streamValueLengthAllowed(contentLength) {
  return [2, 3].some((base) => {
    const repetitions = (contentLength - base) / 4;
    return Number.isInteger(repetitions) && repetitions >= 0 && repetitions <= 2;
  });
}
function ordinalLengthsAllowed(lengths, domains) {
  return lengths.length === domains.length && lengths.every((contentLength, ordinal) => domains[ordinal].includes(contentLength));
}
function sameOrdinalDomains(actual, expected) {
  return actual.length === expected.length && actual.every((lengths, ordinal) => lengths.length === expected[ordinal].length && lengths.every((contentLength, index) => contentLength === expected[ordinal][index]));
}
function analyzeBridge(group, physicalBlocks, replayId) {
  const start = group.records[0].blockIndex;
  const end = group.parallel[0];
  const bridge = [];
  let contiguous = true;
  for (let blockIndex = start + RECORDS_PER_OWNER_RUN; blockIndex < end; blockIndex += 1) {
    const block = physicalBlocks.get(`${group.segmentId}:${blockIndex}`);
    if (!block) { contiguous = false; break; }
    bridge.push(block);
  }
  const relationExact = bridge.every((block) => block.channel === 1 && block.owner === group.owner && block.segmentId === group.segmentId);
  const optional007d = bridge.at(-1)?.packetType === 0x007d;
  const without007d = optional007d ? bridge.slice(0, -1) : bridge;
  const middle = without007d.slice(1, -1);
  const grammarExact = without007d.length >= 2 && without007d[0].packetType === 0x0233 && without007d.at(-1).packetType === 0x0452 &&
    middle.length % 2 === 0 && middle.length <= 8 && middle.every((block) => block.packetType === 0x0306) && bridge.every(bridgeTypeLengthAllowed);
  return {
    replayId, segmentId: group.segmentId, owner: group.owner, start, end, bridgeLength: bridge.length,
    contiguous, relationExact, grammarExact,
    typeForm: bridge.map((block) => packetTypeName(block.packetType)).join(" -> "),
    typeLengthForm: bridge.map((block) => `${packetTypeName(block.packetType)}/${block.contentLength}`).join(" -> "),
    typeLengths: bridge.map((block) => ({ packetType: packetTypeName(block.packetType), contentLength: block.contentLength })),
  };
}
function analyzeTypedStream(group, physicalBlocks, replayId) {
  const runStart = group.records[0].blockIndex;
  const bridgeStart = runStart + RECORDS_PER_OWNER_RUN;
  const immediateBridge = physicalBlocks.get(`${group.segmentId}:${bridgeStart}`);
  const streamEnd = group.streamEnds[0];
  const immediate0233 = immediateBridge?.packetType === 0x0233 && immediateBridge.channel === 1 && immediateBridge.owner === group.owner;
  const sole0151 = group.streamEnds.length === 1;
  const ordering = immediate0233 && sole0151 && bridgeStart < group.parallel[0] && group.parallel[0] < streamEnd.blockIndex;
  const values = streamEnd === undefined ? [] : group.streamValues.filter((block) => block.blockIndex > bridgeStart && block.blockIndex < streamEnd.blockIndex);
  const valueLengthsAllowed = values.length > 0 && values.every((block) => streamValueLengthAllowed(block.contentLength));
  return {
    replayId, segmentId: group.segmentId, owner: group.owner,
    immediate0233, sole0151, ordering, valueLengthsAllowed,
    valueCount: values.length,
    valueLengths: values.map((block) => block.contentLength),
  };
}
function analyzeGroupSkeleton(group, physicalBlocks, replayId) {
  const parallelIndex = group.parallel[0];
  const afterParallel = [1, 2, 3, 4].map((offset) => physicalBlocks.get(`${group.segmentId}:${parallelIndex + offset}`));
  const afterParallelExact = afterParallel.every((block) => block?.packetType === SKELETON_AFTER_PARALLEL_TYPE && block.channel === 1 && block.owner === group.owner && block.segmentId === group.segmentId);
  const streamEnd = group.streamEnds[0];
  const beforeEnd = streamEnd === undefined ? [] : group.skeletonBeforeEnd
    .filter((block) => block.blockIndex > parallelIndex && block.blockIndex < streamEnd.blockIndex)
    .sort((left, right) => left.blockIndex - right.blockIndex);
  const beforeEndContiguous = beforeEnd.length === 4 && beforeEnd.every((block, ordinal) => ordinal === 0 || block.blockIndex === beforeEnd[ordinal - 1].blockIndex + 1);
  const afterParallelLengths = afterParallel.map((block) => block?.contentLength ?? null);
  const beforeEndLengths = beforeEnd.map((block) => block.contentLength);
  const ordinalLengthsWithinFrozenDomains = afterParallelExact && ordinalLengthsAllowed(afterParallelLengths, SKELETON_AFTER_PARALLEL_LENGTH_DOMAINS) && ordinalLengthsAllowed(beforeEndLengths, SKELETON_BEFORE_END_LENGTH_DOMAINS);
  return {
    replayId, segmentId: group.segmentId, owner: group.owner,
    afterParallelExact, beforeEndContiguous, ordinalLengthsWithinFrozenDomains,
    afterParallelLengths, beforeEndLengths,
  };
}

function runCli(options, args) {
  const processResult = spawnSync(options.cli, args, { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (processResult.error || processResult.status !== 0) fail(processResult.error?.message ?? processResult.stderr ?? "rofl_core_cli failed");
  return JSON.parse(processResult.stdout);
}
function loadReplay(options, replayId) {
  const replayPath = path.join(options.replayDir, `${replayId}.rofl`);
  const dump = runCli(options, [
    "--dump-packet-types-json", replayPath,
    "--packet-type", "0x01EB", "--packet-type", "0x0233", "--packet-type", "0x0306",
    "--packet-type", "0x0452", "--packet-type", "0x007D", "--packet-type", "0x02EB", "--packet-type", "0x0151",
    "--packet-type", "0x027C", "--packet-type", "0x011A",
    "--segment-type", "keyframe", "--max-blocks", "0",
  ]);
  if (!dump.valid || dump.gameVersion !== BUILD || dump.errors?.length || dump.segmentType !== "keyframe") fail(`${replayId}: framing/build gate`);
  const recordDump = dump.packetTypeDumps?.find((entry) => entry.packetType === RECORD_TYPE);
  const parallelDump = dump.packetTypeDumps?.find((entry) => entry.packetType === PARALLEL_TYPE);
  const bridgeDumps = BRIDGE_TYPES.map((packetType) => dump.packetTypeDumps?.find((entry) => entry.packetType === packetType));
  const streamEndDump = dump.packetTypeDumps?.find((entry) => entry.packetType === STREAM_END_TYPE);
  const skeletonAfterParallelDump = dump.packetTypeDumps?.find((entry) => entry.packetType === SKELETON_AFTER_PARALLEL_TYPE);
  const skeletonBeforeEndDump = dump.packetTypeDumps?.find((entry) => entry.packetType === SKELETON_BEFORE_END_TYPE);
  if (!recordDump || !parallelDump || !streamEndDump || !skeletonAfterParallelDump || !skeletonBeforeEndDump || bridgeDumps.some((entry) => !entry) || [recordDump, parallelDump, ...bridgeDumps, streamEndDump, skeletonAfterParallelDump, skeletonBeforeEndDump].some((entry) => entry.truncated || entry.emittedBlockCount !== entry.matchingBlockCount)) fail(`${replayId}: incomplete packet dump`);

  const groups = new Map();
  const ownerSegments = new Map();
  const physicalBlocks = new Map();
  const ensureGroup = (segmentId, owner) => {
    const key = `${segmentId}:${owner}`;
    const group = groups.get(key) ?? { replayId, segmentId, owner, records: [], parallel: [], streamValues: [], streamEnds: [], skeletonBeforeEnd: [] };
    groups.set(key, group);
    const owners = ownerSegments.get(segmentId) ?? new Set(); owners.add(owner); ownerSegments.set(segmentId, owners);
    return group;
  };
  for (const block of recordDump.blocks ?? []) {
    const owner = block.blockParam - OWNER_BASE;
    if (owner < 1 || owner > 10 || block.channel !== 1 || ![7, 8, 9].includes(block.contentLength) || block.contentHexTruncated || block.contentHexBytes !== block.contentLength) fail(`${replayId}: 0x01EB owner/payload gate`);
    const physicalKey = `${block.segmentId}:${block.blockIndex}`;
    if (physicalBlocks.has(physicalKey)) fail(`${replayId}: duplicate selected physical block ${physicalKey}`);
    physicalBlocks.set(physicalKey, { segmentId: block.segmentId, blockIndex: block.blockIndex, packetType: block.packetType, channel: block.channel, owner, contentLength: block.contentLength });
    ensureGroup(block.segmentId, owner).records.push({ blockIndex: block.blockIndex, payload: Buffer.from(block.contentHex, "hex") });
  }
  for (const block of parallelDump.blocks ?? []) {
    const owner = block.blockParam - OWNER_BASE;
    if (owner < 1 || owner > 10 || block.channel !== 1 || block.contentLength !== PARALLEL_PAYLOAD_LENGTH || block.contentHexTruncated || block.contentHexBytes !== PARALLEL_PAYLOAD_LENGTH) fail(`${replayId}: 0x02EB owner/payload gate`);
    const physicalKey = `${block.segmentId}:${block.blockIndex}`;
    if (physicalBlocks.has(physicalKey)) fail(`${replayId}: duplicate selected physical block ${physicalKey}`);
    physicalBlocks.set(physicalKey, { segmentId: block.segmentId, blockIndex: block.blockIndex, packetType: block.packetType, channel: block.channel, owner, contentLength: block.contentLength });
    ensureGroup(block.segmentId, owner).parallel.push(block.blockIndex);
  }
  for (const bridgeDump of bridgeDumps) for (const block of bridgeDump.blocks ?? []) {
    const owner = block.blockParam - OWNER_BASE;
    const physicalKey = `${block.segmentId}:${block.blockIndex}`;
    if (physicalBlocks.has(physicalKey)) fail(`${replayId}: duplicate selected physical block ${physicalKey}`);
    physicalBlocks.set(physicalKey, { segmentId: block.segmentId, blockIndex: block.blockIndex, packetType: block.packetType, channel: block.channel, owner, contentLength: block.contentLength });
    if (block.packetType === STREAM_VALUE_TYPE && owner >= 1 && owner <= 10 && block.channel === 1) {
      ensureGroup(block.segmentId, owner).streamValues.push({ blockIndex: block.blockIndex, contentLength: block.contentLength });
    }
  }
  for (const block of streamEndDump.blocks ?? []) {
    const owner = block.blockParam - OWNER_BASE;
    if (owner < 1 || owner > 10 || block.channel !== 1) continue;
    if (block.contentHexTruncated || block.contentHexBytes !== block.contentLength) fail(`${replayId}: 0x0151 payload completeness gate`);
    const physicalKey = `${block.segmentId}:${block.blockIndex}`;
    if (physicalBlocks.has(physicalKey)) fail(`${replayId}: duplicate selected physical block ${physicalKey}`);
    physicalBlocks.set(physicalKey, { segmentId: block.segmentId, blockIndex: block.blockIndex, packetType: block.packetType, channel: block.channel, owner, contentLength: block.contentLength });
    ensureGroup(block.segmentId, owner).streamEnds.push({ blockIndex: block.blockIndex, contentLength: block.contentLength });
  }
  for (const skeletonDump of [skeletonAfterParallelDump, skeletonBeforeEndDump]) for (const block of skeletonDump.blocks ?? []) {
    const owner = block.blockParam - OWNER_BASE;
    if (block.contentHexTruncated || block.contentHexBytes !== block.contentLength) fail(`${replayId}: ${packetTypeName(block.packetType)} payload completeness gate`);
    const physicalKey = `${block.segmentId}:${block.blockIndex}`;
    if (physicalBlocks.has(physicalKey)) fail(`${replayId}: duplicate selected physical block ${physicalKey}`);
    physicalBlocks.set(physicalKey, { segmentId: block.segmentId, blockIndex: block.blockIndex, packetType: block.packetType, channel: block.channel, owner, contentLength: block.contentLength });
    if (block.packetType === SKELETON_BEFORE_END_TYPE && owner >= 1 && owner <= 10 && block.channel === 1) {
      ensureGroup(block.segmentId, owner).skeletonBeforeEnd.push({ blockIndex: block.blockIndex, contentLength: block.contentLength });
    }
  }
  if (groups.size === 0 || [...ownerSegments.values()].some((owners) => owners.size !== 10)) fail(`${replayId}: exact ten-owner segment gate`);

  const tracks = new Map();
  for (const group of groups.values()) {
    group.records.sort((left, right) => left.blockIndex - right.blockIndex);
    if (group.records.length !== RECORDS_PER_OWNER_RUN || group.parallel.length !== 1 || group.streamEnds.length !== 1) fail(`${replayId}: group cardinality gate ${group.segmentId}/${group.owner}`);
    for (let index = 1; index < group.records.length; index += 1) {
      if (group.records[index].blockIndex !== group.records[index - 1].blockIndex + 1) fail(`${replayId}: non-contiguous 0x01EB physical run ${group.segmentId}/${group.owner}`);
    }
    group.bridge = analyzeBridge(group, physicalBlocks, replayId);
    if (!group.bridge.contiguous || !group.bridge.relationExact || !group.bridge.grammarExact) fail(`${replayId}: bridge grammar gate ${group.segmentId}/${group.owner}`);
    group.typedStream = analyzeTypedStream(group, physicalBlocks, replayId);
    if (!group.typedStream.immediate0233 || !group.typedStream.sole0151 || !group.typedStream.ordering || !group.typedStream.valueLengthsAllowed) fail(`${replayId}: typed stream grammar gate ${group.segmentId}/${group.owner}`);
    group.skeleton = analyzeGroupSkeleton(group, physicalBlocks, replayId);
    if (!group.skeleton.afterParallelExact || !group.skeleton.beforeEndContiguous || !group.skeleton.ordinalLengthsWithinFrozenDomains) fail(`${replayId}: group skeleton gate ${group.segmentId}/${group.owner}`);
    const track = tracks.get(group.owner) ?? []; track.push(group); tracks.set(group.owner, track);
  }
  if (tracks.size !== 10) fail(`${replayId}: exact ten-owner track gate`);
  for (const track of tracks.values()) {
    track.sort((left, right) => left.segmentId - right.segmentId);
    for (let index = 1; index < track.length; index += 1) {
      if (track[index].segmentId !== track[index - 1].segmentId + 1) fail(`${replayId}: owner segment continuity gate`);
    }
  }
  const expectedGroupCount = EXPECTED_OWNER_SEGMENT_GROUPS.get(replayId);
  if (groups.size !== expectedGroupCount) fail(`${replayId}: expected ${expectedGroupCount} owner/segment groups, got ${groups.size}`);
  return { replayId, tracks, ownerSegmentGroups: groups.size };
}
function analyze(options, replayIds) {
  const fixtures = replayIds.map((replayId) => loadReplay(options, replayId));
  const records = Array.from({ length: RECORDS_PER_OWNER_RUN }, newRecordState);
  for (const fixture of fixtures) for (const [owner, track] of fixture.tracks) {
    const ownerReplayKey = `${fixture.replayId}:${owner}`;
    for (const group of track) for (let recordIndex = 0; recordIndex < RECORDS_PER_OWNER_RUN; recordIndex += 1) {
      const payload = group.records[recordIndex].payload;
      const state = records[recordIndex];
      state.samples += 1; state.lengths.add(payload.length); state.suffixes.add(toHex(payload.subarray(3)));
      addSet(state.replaySuffixes, fixture.replayId, toHex(payload.subarray(3)));
      addSet(state.ownerReplaySuffixes, ownerReplayKey, toHex(payload.subarray(3)));
    }
  }
  const suffixIndexOwners = new Map();
  for (let index = 0; index < records.length; index += 1) for (const suffix of records[index].suffixes) addSet(suffixIndexOwners, suffix, index);
  const failures = [];
  const recordSummaries = records.map((state, index) => {
    const lengthInvariant = state.lengths.size === 1;
    const suffixInvariant = state.suffixes.size === 1;
    const replayStable = [...state.replaySuffixes.values()].every((suffixes) => suffixes.size === 1) && state.replaySuffixes.size === replayIds.length;
    const ownerReplayStable = [...state.ownerReplaySuffixes.values()].every((suffixes) => suffixes.size === 1) && state.ownerReplaySuffixes.size === replayIds.length * 10;
    const crossIndexUnique = [...state.suffixes].every((suffix) => suffixIndexOwners.get(suffix).size === 1);
    if (!lengthInvariant || !suffixInvariant || !replayStable || !ownerReplayStable || !crossIndexUnique) compactFailure(failures, { index, lengthCount: state.lengths.size, suffixCount: state.suffixes.size, replayStable, ownerReplayStable, crossIndexUnique });
    return { index, length: lengthInvariant ? [...state.lengths][0] : null, suffix: suffixInvariant ? [...state.suffixes][0] : null, lengthInvariant, suffixInvariant, replayStable, ownerReplayStable, crossIndexUnique };
  });
  const exact = recordSummaries.every((record) => record.lengthInvariant && record.suffixInvariant && record.replayStable && record.ownerReplayStable && record.crossIndexUnique);
  const directoryFingerprint = exact ? crypto.createHash("sha256").update(recordSummaries
    .map((record) => `${record.index}:${record.length}:${record.suffix}`)
    .join("\n"), "utf8").digest("hex") : null;
  const bridges = fixtures.flatMap((fixture) => [...fixture.tracks.values()].flatMap((track) => track.map((group) => group.bridge)));
  const typeForms = new Map(), typeLengthForms = new Map(), typeLengthDomains = new Map();
  for (const bridge of bridges) {
    increment(typeForms, bridge.typeForm); increment(typeLengthForms, bridge.typeLengthForm);
    for (const entry of bridge.typeLengths) addSet(typeLengthDomains, entry.packetType, entry.contentLength);
  }
  const bridgeFailures = bridges.filter((bridge) => !bridge.contiguous || !bridge.relationExact || !bridge.grammarExact);
  const bridgeCompact = {
    ownerRunCount: bridges.length,
    contiguousCount: bridges.filter((bridge) => bridge.contiguous).length,
    sameOwnerChannelSegmentCount: bridges.filter((bridge) => bridge.relationExact).length,
    grammarCount: bridges.filter((bridge) => bridge.grammarExact).length,
    bridgeLengthCounts: Object.fromEntries([...new Map(bridges.map((bridge) => [bridge.bridgeLength, 0])).keys()].sort((a, b) => a - b).map((length) => [length, bridges.filter((bridge) => bridge.bridgeLength === length).length])),
    typeForms: [...typeForms.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    typeLengthFormCount: typeLengthForms.size,
    typeLengthForms: [...typeLengthForms.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    typeLengthDomains: Object.fromEntries([...typeLengthDomains.entries()].map(([packetType, lengths]) => [packetType, [...lengths].sort((a, b) => a - b)])),
    exact: bridgeFailures.length === 0,
    firstFailures: bridgeFailures.slice(0, 8),
  };
  const typedStreams = fixtures.flatMap((fixture) => [...fixture.tracks.values()].flatMap((track) => track.map((group) => group.typedStream)));
  const valueLengthCounts = new Map();
  for (const stream of typedStreams) for (const contentLength of stream.valueLengths) increment(valueLengthCounts, contentLength);
  const distinctValueLengths = [...valueLengthCounts.keys()].sort((left, right) => left - right);
  const typedStreamFailures = typedStreams.filter((stream) => !stream.immediate0233 || !stream.sole0151 || !stream.ordering || !stream.valueLengthsAllowed);
  const typedStreamCompact = {
    ownerRunCount: typedStreams.length,
    immediate0233Count: typedStreams.filter((stream) => stream.immediate0233).length,
    sole0151Count: typedStreams.filter((stream) => stream.sole0151).length,
    orderingCount: typedStreams.filter((stream) => stream.ordering).length,
    valueRecordCount: typedStreams.reduce((sum, stream) => sum + stream.valueCount, 0),
    distinctValueLengths,
    valueLengthCounts: Object.fromEntries(distinctValueLengths.map((contentLength) => [contentLength, valueLengthCounts.get(contentLength)])),
    frozenDomainComplete: STREAM_VALUE_LENGTHS.size === distinctValueLengths.length && distinctValueLengths.every((contentLength) => STREAM_VALUE_LENGTHS.has(contentLength)),
    exact: typedStreamFailures.length === 0,
    firstFailures: typedStreamFailures.slice(0, 8),
  };
  const skeletons = fixtures.flatMap((fixture) => [...fixture.tracks.values()].flatMap((track) => track.map((group) => group.skeleton)));
  const observedOrdinalDomains = (property) => [0, 1, 2, 3].map((ordinal) => [...new Set(skeletons.map((skeleton) => skeleton[property][ordinal]).filter((contentLength) => contentLength !== null && contentLength !== undefined))].sort((left, right) => left - right));
  const afterParallelOrdinalLengthDomains = observedOrdinalDomains("afterParallelLengths");
  const beforeEndOrdinalLengthDomains = observedOrdinalDomains("beforeEndLengths");
  const skeletonFailures = skeletons.filter((skeleton) => !skeleton.afterParallelExact || !skeleton.beforeEndContiguous || !skeleton.ordinalLengthsWithinFrozenDomains);
  const skeletonCompact = {
    ownerRunCount: skeletons.length,
    immediate027cRunCount: skeletons.filter((skeleton) => skeleton.afterParallelExact).length,
    pre0151Contiguous011aRunCount: skeletons.filter((skeleton) => skeleton.beforeEndContiguous).length,
    ordinalLengthsWithinFrozenDomainsCount: skeletons.filter((skeleton) => skeleton.ordinalLengthsWithinFrozenDomains).length,
    after02eb027cOrdinalLengthDomains: afterParallelOrdinalLengthDomains,
    before0151_011aOrdinalLengthDomains: beforeEndOrdinalLengthDomains,
    frozenDomainsComplete: sameOrdinalDomains(afterParallelOrdinalLengthDomains, SKELETON_AFTER_PARALLEL_LENGTH_DOMAINS) && sameOrdinalDomains(beforeEndOrdinalLengthDomains, SKELETON_BEFORE_END_LENGTH_DOMAINS),
    exact: skeletonFailures.length === 0,
    firstFailures: skeletonFailures.slice(0, 8),
  };
  return {
    fixtures,
    recordSummaries,
    exact,
    firstFailures: failures,
    compact: {
      recordCount: recordSummaries.length,
      directoryFingerprint,
      samplesPerRecord: recordSummaries[0]?.index === 0 ? records[0].samples : 0,
      payloadLengthCounts: Object.fromEntries([7, 8, 9].map((length) => [length, recordSummaries.filter((record) => record.length === length).length])),
      lengthInvariantRecordCount: recordSummaries.filter((record) => record.lengthInvariant).length,
      suffixInvariantRecordCount: recordSummaries.filter((record) => record.suffixInvariant).length,
      replayStableRecordCount: recordSummaries.filter((record) => record.replayStable).length,
      ownerReplayStableRecordCount: recordSummaries.filter((record) => record.ownerReplayStable).length,
      crossIndexUniqueRecordCount: recordSummaries.filter((record) => record.crossIndexUnique).length,
    },
    bridge: bridgeCompact,
    typedStream: typedStreamCompact,
    skeleton: skeletonCompact,
  };
}
function frozenHoldoutCheck(discovery, holdout) {
  const failures = [];
  for (const actual of holdout.recordSummaries) {
    const expected = discovery.recordSummaries[actual.index];
    if (actual.length !== expected.length || actual.suffix !== expected.suffix || !actual.crossIndexUnique) compactFailure(failures, { index: actual.index, expectedLength: expected.length, actualLength: actual.length, suffixMatchesD7: actual.suffix === expected.suffix, crossIndexUnique: actual.crossIndexUnique });
  }
  return {
    passed: holdout.exact && failures.length === 0 && holdout.compact.directoryFingerprint === discovery.compact.directoryFingerprint,
    directorySha256MatchesD7: holdout.compact.directoryFingerprint === discovery.compact.directoryFingerprint,
    firstFailures: failures,
  };
}
function frozenBridgeHoldoutCheck(discovery, holdout) {
  const failures = [];
  for (const [packetType, lengths] of Object.entries(holdout.bridge.typeLengthDomains)) {
    const frozen = new Set(discovery.bridge.typeLengthDomains[packetType] ?? []);
    for (const length of lengths) if (!frozen.has(length)) compactFailure(failures, { packetType, length, reason: "unseen-D7-length" });
  }
  const exactObservedTypeLengthFormSubset = holdout.bridge.typeLengthForms.every((entry) =>
    discovery.bridge.typeLengthForms.some((frozen) => frozen.value === entry.value));
  const unseenCompleteTypeLengthForms = holdout.bridge.typeLengthForms
    .filter((entry) => !discovery.bridge.typeLengthForms.some((frozen) => frozen.value === entry.value));
  return {
    passed: holdout.bridge.exact && failures.length === 0,
    grammar: "0x0233 · (0x0306 0x0306)^k · 0x0452 · 0x007D?, k=0..4; every bridge block is contiguous and same owner/channel/segment. Per-packet type-length domains are D7-frozen; complete type-length layout strings are intentionally not frozen.",
    completeTypeLengthFormsFrozen: false,
    exactObservedTypeLengthFormSubset,
    unseenCompleteTypeLengthFormCount: unseenCompleteTypeLengthForms.length,
    firstUnseenCompleteTypeLengthForms: unseenCompleteTypeLengthForms.slice(0, 8),
    firstFailures: failures,
  };
}
function frozenTypedStreamHoldoutCheck(discovery, holdout) {
  const newLengths = holdout.typedStream.distinctValueLengths.filter((contentLength) => !discovery.typedStream.distinctValueLengths.includes(contentLength));
  return {
    passed: holdout.typedStream.exact && newLengths.length === 0,
    grammar: "After the immediate 0x0233 following the 366-run, all same-owner 0x0306 blocks before the unique 0x0151 have contentLength base + 4*k, base in {2,3}, k=0..2. No complete layout string is asserted or frozen.",
    frozenD7ValueLengths: discovery.typedStream.distinctValueLengths,
    h3ValueLengths: holdout.typedStream.distinctValueLengths,
    newLengths,
    firstFailures: holdout.typedStream.firstFailures,
  };
}
function frozenSkeletonHoldoutCheck(discovery, holdout) {
  const failures = [];
  const check = (label, actual, frozen) => actual.forEach((lengths, ordinal) => lengths.forEach((contentLength) => {
    if (!(frozen[ordinal] ?? []).includes(contentLength)) compactFailure(failures, { label, ordinal, contentLength, reason: "unseen-D7-ordinal-length" });
  }));
  check("after02eb027c", holdout.skeleton.after02eb027cOrdinalLengthDomains, discovery.skeleton.after02eb027cOrdinalLengthDomains);
  check("before0151_011a", holdout.skeleton.before0151_011aOrdinalLengthDomains, discovery.skeleton.before0151_011aOrdinalLengthDomains);
  return {
    passed: holdout.skeleton.exact && failures.length === 0,
    grammar: "Immediately after same-owner 0x02EB: four contiguous 0x027C. Between that 0x02EB and the unique same-owner 0x0151: exactly four contiguous 0x011A; direct 0x011A→0x0151 adjacency is intentionally not required. H3 ordinal payload-length domains must be D7 subsets.",
    frozenD7After02eb027cOrdinalLengthDomains: discovery.skeleton.after02eb027cOrdinalLengthDomains,
    h3After02eb027cOrdinalLengthDomains: holdout.skeleton.after02eb027cOrdinalLengthDomains,
    frozenD7Before0151_011aOrdinalLengthDomains: discovery.skeleton.before0151_011aOrdinalLengthDomains,
    h3Before0151_011aOrdinalLengthDomains: holdout.skeleton.before0151_011aOrdinalLengthDomains,
    firstFailures: failures,
  };
}

const options = parseArgs(process.argv.slice(2));
if (!fs.existsSync(options.cli)) fail(`Missing CLI: ${options.cli}`);
const discovery = analyze(options, D7);
const holdout = discovery.exact && discovery.bridge.exact && discovery.typedStream.exact && discovery.typedStream.frozenDomainComplete && discovery.skeleton.exact && discovery.skeleton.frozenDomainsComplete ? analyze(options, H3) : null;
const holdoutCheck = holdout === null ? null : frozenHoldoutCheck(discovery, holdout);
const bridgeHoldoutCheck = holdout === null ? null : frozenBridgeHoldoutCheck(discovery, holdout);
const typedStreamHoldoutCheck = holdout === null ? null : frozenTypedStreamHoldoutCheck(discovery, holdout);
const skeletonHoldoutCheck = holdout === null ? null : frozenSkeletonHoldoutCheck(discovery, holdout);
const allHoldoutChecksPassed = holdout !== null && holdoutCheck.passed && bridgeHoldoutCheck.passed && typedStreamHoldoutCheck.passed && skeletonHoldoutCheck.passed;
const report = {
  schema: "rofl-keyframe-record-directory-research/v1",
  researchOnly: true,
  promotionGate: false,
  runtimeInput: false,
  inputBoundary: "saved .rofl keyframe packet bytes only; no API, Timeline, installed Riot binaries, game/client process, or Vanguard input",
  profile: {
    exactReplayBuild: BUILD,
    discoveryD7: D7,
    holdoutH3: H3,
    recordPacketType: "0x01EB",
    recordIndex: "physical zero-based position in its contiguous same-owner/keyframe-segment 366-record run",
    recordPayloadLengths: [7, 8, 9],
    invariantBytes: "payload[3..end]",
    parallelPacketType: "0x02EB",
    parallelPayloadLength: PARALLEL_PAYLOAD_LENGTH,
    parallelArithmeticOnly: "1479 = 15 + 366 * 4 (reported only; no record-index to 0x02EB-cell mapping is asserted)",
    bridgeGrammar: "0x0233 · (0x0306 0x0306)^k · 0x0452 · 0x007D?, k=0..4; physical bridge from the 366-run end to its same-owner 0x02EB. Per-packet type-length domains are frozen, but complete type-length layout strings are not.",
    bridgePacketTypes: BRIDGE_TYPES.map(packetTypeName),
    typedStreamPartialGrammar: "The immediate post-run 0x0233 precedes the unique same-owner 0x0151; 0x02EB lies between them. Every same-owner 0x0306 in that interval has contentLength base + 4*k, base in {2,3}, k=0..2. This is a typed-stream length gate only, not a complete layout.",
    typedStreamPacketTypes: [packetTypeName(STREAM_VALUE_TYPE), packetTypeName(STREAM_END_TYPE)],
    groupSkeleton: "Immediately after same-owner 0x02EB are four same-owner/channel/segment 0x027C at blockIndex+1..+4. Between that 0x02EB and the unique 0x0151 are exactly four same-owner/channel/segment 0x011A in a contiguous run; no direct 0x011A→0x0151 adjacency is claimed.",
    groupSkeletonPacketTypes: [packetTypeName(SKELETON_AFTER_PARALLEL_TYPE), packetTypeName(SKELETON_BEFORE_END_TYPE)],
  },
  framingGates: [
    "exact replay build", "complete keyframe packet dumps", "exactly ten owners per keyframe segment",
    "one contiguous 366-record 0x01EB run per owner/segment", "each 0x01EB record is channel 1, owner 1..10, and 7..9 bytes",
    "one same-owner/segment channel-1 0x02EB block of exactly 1479 bytes", "owner segment continuity",
    "complete selected bridge-type dumps", "bridge is physically contiguous and same owner/channel/segment",
    "bridge matches 0x0233 · (0x0306 0x0306)^k · 0x0452 · 0x007D?, k=0..4, within D7-frozen per-type payload-length domains",
    "one same-owner 0x0151 end per 366-run and immediate 0x0233 post-run boundary", "same-owner 0x02EB lies before 0x0151",
    "every same-owner 0x0306 between that 0x0233 and 0x0151 has contentLength base + 4*k, base in {2,3}, k=0..2; complete layouts stay unfrozen",
    "immediately after same-owner 0x02EB, blockIndex+1..+4 are same-owner/channel/segment 0x027C", "between that 0x02EB and the unique same-owner 0x0151, exactly four same-owner/channel/segment 0x011A are contiguous; direct adjacency is not required",
    "D7 ordinal length domains are frozen for 0x027C and 0x011A; H3 accepts an ordinal-wise subset only",
  ],
  D7: {
    groupsByReplay: Object.fromEntries(discovery.fixtures.map((fixture) => [fixture.replayId, fixture.ownerSegmentGroups])),
    ownerSegmentGroupCount: discovery.fixtures.reduce((sum, fixture) => sum + fixture.ownerSegmentGroups, 0),
    directoryGate: "For every physical index: payload length invariant; payload[3..end] invariant across time, owners, and D7 replays; its complete observed suffix domain is disjoint from every other index.",
    directoryGatePassed: discovery.exact,
    counts: discovery.compact,
    firstFailures: discovery.firstFailures,
    bridge: discovery.bridge,
    typedStream: discovery.typedStream,
    skeleton: discovery.skeleton,
  },
  H3: holdout === null ? { evaluated: false, reason: "D7 directory, bridge-grammar, typed-stream-length, or group-skeleton gate failed; H3 replay bytes were not read." } : {
    evaluated: true,
    groupsByReplay: Object.fromEntries(holdout.fixtures.map((fixture) => [fixture.replayId, fixture.ownerSegmentGroups])),
    ownerSegmentGroupCount: holdout.fixtures.reduce((sum, fixture) => sum + fixture.ownerSegmentGroups, 0),
    counts: holdout.compact,
    frozenD7DirectoryCheck: "Each physical index preserves its D7 payload length and exact payload[3..end] suffix; H3 suffix domains remain cross-index-disjoint and the canonical index:suffix SHA-256 matches D7.",
    passed: allHoldoutChecksPassed,
    directoryPassed: holdoutCheck.passed,
    firstDirectoryFailures: holdoutCheck.firstFailures,
    bridge: holdout.bridge,
    frozenD7BridgeCheck: bridgeHoldoutCheck,
    typedStream: holdout.typedStream,
    frozenD7TypedStreamCheck: typedStreamHoldoutCheck,
    skeleton: holdout.skeleton,
    frozenD7GroupSkeletonCheck: skeletonHoldoutCheck,
  },
  conclusion: holdout === null ? "The D7 physical record-directory, bridge-language, typed-stream-length, or group-skeleton gate failed; H3 stayed closed. No semantic decoder is asserted." : (allHoldoutChecksPassed ? "The D7 physical record-directory, bridge-language, typed-stream length, and group-skeleton invariants reproduced on H3. They are non-semantic byte structure only; they do not identify a field, entity, inventory slot, item, or 0x02EB cell." : "The D7 physical record-directory, bridge-language, typed-stream length, or group-skeleton invariant did not reproduce on H3. No semantic decoder is asserted."),
};
fs.mkdirSync(path.dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output: options.output, d7Passed: report.D7.directoryGatePassed, h3Evaluated: report.H3.evaluated, h3Passed: report.H3.passed ?? null, d7Counts: report.D7.counts, h3Counts: report.H3.counts ?? null }, null, 2));
