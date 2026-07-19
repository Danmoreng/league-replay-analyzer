#!/usr/bin/env node

// Offline, saved-ROFL-only structural falsification. This script deliberately
// does not use a Timeline/API fixture and does not emit a decoder or runtime
// schema. It tests only the predeclared whole-payload layout families below.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x02eb,
  payloadLength: 1479,
  championOwnerBase: 0x400000ad,
  discovery: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664",
    "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492",
    "EUW1-7920550565",
  ]),
  holdout: Object.freeze(["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"]),
  bitmapByteLengths: Object.freeze([165, 176, 184, 192, 200, 208, 224, 240, 256]),
  defaultByte: 0x0e,
  mirrorRanges: Object.freeze([
    Object.freeze({ id: "mirror-154-162-to-1289-1297", leftStart: 154, rightStart: 1289, length: 9 }),
    Object.freeze({ id: "mirror-1066-1073-to-1074-1081", leftStart: 1066, rightStart: 1074, length: 8 }),
  ]),
});

const TLV_FORMS = Object.freeze([
  Object.freeze({ id: "uleb-tag_uleb-length", tag: "uleb", length: "uleb" }),
  Object.freeze({ id: "u8-tag_uleb-length", tag: "u8", length: "uleb" }),
  Object.freeze({ id: "u8-tag_u8-length", tag: "u8", length: "u8" }),
]);

const EXPECTED_D7 = Object.freeze({
  snapshotCount: 2170,
  ownerSequenceCount: 70,
  bitmap: {
    candidateCount: 72,
    nonDefault: { exactCandidateCount: 0, best: { boundary: 256, order: "values-bitset", bitOrder: "lsb", inverted: false, target: "nonDefault", observations: 2653910, tp: 165767, fp: 832644, fn: 120059, tn: 1535440, mismatchCount: 952703 } },
    changed: { exactCandidateCount: 0, best: { boundary: 256, order: "values-bitset", bitOrder: "lsb", inverted: false, target: "changed", observations: 2568300, tp: 55439, fp: 910842, fn: 71435, tn: 1530584, mismatchCount: 982277 } },
  },
  tlv: [
    { id: "uleb-tag_uleb-length", exact: false, stage: "parse", parsedCount: 0, firstFailure: { replayId: "EUW1-7919517389", participantId: 1, segmentId: 1, recordIndex: 4, recordStart: 66, failureOffset: 69, reason: "body-overflow", tag: 14, length: 1837, bodyStart: 69, payloadLength: 1479 } },
    { id: "u8-tag_uleb-length", exact: false, stage: "parse", parsedCount: 0, firstFailure: { replayId: "EUW1-7919517389", participantId: 1, segmentId: 1, recordIndex: 3, recordStart: 1467, failureOffset: 1469, reason: "body-overflow", tag: 14, length: 14, bodyStart: 1469, payloadLength: 1479 } },
    { id: "u8-tag_u8-length", exact: false, stage: "parse", parsedCount: 0, firstFailure: { replayId: "EUW1-7919517389", participantId: 1, segmentId: 1, recordIndex: 83, recordStart: 1466, failureOffset: 1468, reason: "body-overflow", tag: 14, length: 14, bodyStart: 1468, payloadLength: 1479 } },
  ],
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    outputPath: path.join("artifacts", "keyframe-layout-falsifications-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (argument === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/research_keyframe_layout_falsifications_16_14.mjs [--cli <path>] [--replay-dir <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function fail(message, detail = undefined) {
  throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function assertEqual(name, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${name} drifted.`, { expected, actual });
}

function dumpRows(args, replayIds) {
  const rows = [];
  for (const replayId of replayIds) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    if (!fs.existsSync(replayPath)) fail("Fixed saved replay fixture is missing.", { replayId });
    const run = spawnSync(args.cliPath, [
      "--dump-packet-type-json", replayPath, "--packet-type", String(PROFILE.packetType),
      "--segment-type", "keyframe", "--max-blocks", "0",
    ], { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
    if (run.error) throw run.error;
    if (run.status !== 0) fail("Native packet dump failed.", { replayId, stderr: run.stderr.trim() });
    const dump = JSON.parse(run.stdout);
    if (!dump.valid || dump.errors?.length || dump.truncated || dump.emittedBlockCount !== dump.matchingBlockCount
      || dump.packetType !== PROFILE.packetType || dump.segmentType !== "keyframe" || dump.gameVersion !== PROFILE.exactReplayBuild) {
      fail("Exact packet framing/profile gate failed.", { replayId });
    }
    for (const block of dump.blocks ?? []) {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      if (!Number.isInteger(participantId) || participantId < 1 || participantId > 10
        || block.contentLength !== PROFILE.payloadLength || block.contentHexTruncated !== false
        || block.contentHexBytes !== PROFILE.payloadLength || typeof block.contentHex !== "string"
        || block.contentHex.length !== PROFILE.payloadLength * 2 || !/^[0-9a-f]+$/iu.test(block.contentHex)) {
        fail("Exact champion payload gate failed.", { replayId });
      }
      rows.push({ replayId, participantId, segmentId: block.segmentId, payload: Buffer.from(block.contentHex, "hex") });
    }
  }
  return rows;
}

function organizeRows(rows) {
  const bySegment = new Map();
  const byOwner = new Map();
  for (const row of rows) {
    const segmentKey = `${row.replayId}|${row.segmentId}`;
    const segment = bySegment.get(segmentKey) ?? [];
    segment.push(row); bySegment.set(segmentKey, segment);
    const ownerKey = `${row.replayId}|${row.participantId}`;
    const owner = byOwner.get(ownerKey) ?? [];
    owner.push(row); byOwner.set(ownerKey, owner);
  }
  for (const segment of bySegment.values()) {
    if (segment.length !== 10 || new Set(segment.map((row) => row.participantId)).size !== 10) fail("Keyframe champion-owner completeness gate failed.");
  }
  for (const owner of byOwner.values()) {
    owner.sort((left, right) => left.segmentId - right.segmentId);
    for (let index = 1; index < owner.length; index += 1) {
      if (owner[index].segmentId !== owner[index - 1].segmentId + 1) fail("Nonconsecutive champion keyframe sequence.");
    }
  }
  return { rows, ownerSequences: [...byOwner.values()] };
}

function bitmapBit(payload, index, lsb, inverted) {
  const byte = payload[Math.floor(index / 8)];
  const isSet = (byte & (1 << (lsb ? index % 8 : 7 - (index % 8)))) !== 0;
  return inverted ? !isSet : isSet;
}

function bitmapCandidate(boundary, order, lsb, inverted, target) {
  const bitsetFirst = order === "bitset-values";
  const valueLength = PROFILE.payloadLength - boundary;
  return {
    boundary, order, bitOrder: lsb ? "lsb" : "msb", inverted, target,
    bitsetStart: bitsetFirst ? 0 : valueLength,
    valueStart: bitsetFirst ? boundary : 0,
    valueLength,
    unmappedBitCount: boundary * 8 - valueLength,
  };
}

function bitmapCandidates(target) {
  const candidates = [];
  for (const boundary of PROFILE.bitmapByteLengths) {
    const valueLength = PROFILE.payloadLength - boundary;
    if (boundary * 8 < valueLength) fail("Predeclared bitmap is too short.", { boundary, valueLength });
    for (const order of ["bitset-values", "values-bitset"]) for (const lsb of [true, false]) for (const inverted of [false, true]) {
      candidates.push(bitmapCandidate(boundary, order, lsb, inverted, target));
    }
  }
  return candidates;
}

function assessBitmap(candidate, data) {
  let tp = 0; let fp = 0; let fn = 0; let tn = 0; let firstMismatch;
  for (const owner of data.ownerSequences) {
    const start = candidate.target === "changed" ? 1 : 0;
    for (let rowIndex = start; rowIndex < owner.length; rowIndex += 1) {
      const row = owner[rowIndex];
      const previous = owner[rowIndex - 1];
      for (let slot = 0; slot < candidate.valueLength; slot += 1) {
        const predicted = bitmapBit(row.payload.subarray(candidate.bitsetStart, candidate.bitsetStart + candidate.boundary), slot, candidate.bitOrder === "lsb", candidate.inverted);
        const valueOffset = candidate.valueStart + slot;
        const actual = candidate.target === "nonDefault"
          ? row.payload[valueOffset] !== PROFILE.defaultByte
          : row.payload[valueOffset] !== previous.payload[valueOffset];
        if (predicted && actual) tp += 1;
        else if (predicted) fp += 1;
        else if (actual) fn += 1;
        else tn += 1;
        if (!firstMismatch && predicted !== actual) firstMismatch = {
          replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId,
          previousSegmentId: previous?.segmentId ?? null, slot,
          bitmapByteOffset: candidate.bitsetStart + Math.floor(slot / 8), valueOffset,
          bit: predicted, actual,
          bitmapByteHex: row.payload[candidate.bitsetStart + Math.floor(slot / 8)].toString(16).padStart(2, "0"),
          valueHex: row.payload[valueOffset].toString(16).padStart(2, "0"),
          previousValueHex: previous ? previous.payload[valueOffset].toString(16).padStart(2, "0") : null,
        };
      }
    }
  }
  return { ...candidate, observations: tp + fp + fn + tn, tp, fp, fn, tn, exact: fp === 0 && fn === 0, firstMismatch };
}

function evaluateBitmap(data, target) {
  const candidates = bitmapCandidates(target).map((candidate) => assessBitmap(candidate, data));
  const exactCandidates = candidates.filter((candidate) => candidate.exact);
  const best = [...candidates].sort((left, right) => (left.fp + left.fn) - (right.fp + right.fn)
    || left.boundary - right.boundary || left.order.localeCompare(right.order)
    || left.bitOrder.localeCompare(right.bitOrder) || Number(left.inverted) - Number(right.inverted))[0];
  return {
    candidateCount: candidates.length,
    exactCandidateCount: exactCandidates.length,
    exactCandidates: exactCandidates.map(({ firstMismatch, ...candidate }) => candidate),
    best: { ...best, mismatchCount: best.fp + best.fn },
  };
}

function readU8(payload, offset) {
  return offset >= payload.length ? { ok: false, reason: "truncated-u8", offset } : { ok: true, value: payload[offset], width: 1, next: offset + 1 };
}

function readUleb(payload, offset) {
  let value = 0; let shift = 0;
  for (let count = 0; count < 5; count += 1) {
    const at = offset + count;
    if (at >= payload.length) return { ok: false, reason: "truncated-uleb", offset: at };
    const byte = payload[at];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { ok: true, value, width: count + 1, next: at + 1 };
    shift += 7;
  }
  return { ok: false, reason: "uleb-overflow-or-too-wide", offset: offset + 4 };
}

function parseTlv(payload, form) {
  const records = [];
  let offset = 0;
  const read = formEncoding => formEncoding === "u8" ? readU8(payload, offset) : readUleb(payload, offset);
  while (offset < payload.length) {
    const recordStart = offset;
    const tag = read(form.tag);
    if (!tag.ok) return { ok: false, recordIndex: records.length, recordStart, failureOffset: tag.offset, reason: tag.reason };
    offset = tag.next;
    const length = read(form.length);
    if (!length.ok) return { ok: false, recordIndex: records.length, recordStart, failureOffset: length.offset, reason: length.reason };
    offset = length.next;
    const bodyStart = offset;
    const bodyEnd = bodyStart + length.value;
    if (!Number.isSafeInteger(bodyEnd) || bodyEnd > payload.length) {
      return { ok: false, recordIndex: records.length, recordStart, failureOffset: bodyStart, reason: "body-overflow", tag: tag.value, length: length.value, bodyStart, payloadLength: payload.length };
    }
    records.push({ start: recordStart, tag: tag.value, tagWidth: tag.width, length: length.value, lengthWidth: length.width, bodyStart, bodyEnd });
    offset = bodyEnd;
  }
  return { ok: true, records };
}

function mirrorRecordPlacement(records) {
  const placement = [];
  for (const range of PROFILE.mirrorRanges) {
    const end = range.leftStart + range.length;
    const leftIndex = records.findIndex((record) => record.bodyStart <= range.leftStart && end <= record.bodyEnd);
    const rightEnd = range.rightStart + range.length;
    const rightIndex = records.findIndex((record) => record.bodyStart <= range.rightStart && rightEnd <= record.bodyEnd);
    if (leftIndex < 0 || rightIndex < 0) return { ok: false, reason: "mirror-not-wholly-in-record-body", range: range.id, leftIndex, rightIndex };
    const left = records[leftIndex]; const right = records[rightIndex];
    if (left.tag !== right.tag || left.tagWidth !== right.tagWidth || left.lengthWidth !== right.lengthWidth
      || range.leftStart - left.bodyStart !== range.rightStart - right.bodyStart) {
      return { ok: false, reason: "mirror-record-position-mismatch", range: range.id, leftIndex, rightIndex };
    }
    placement.push({ id: range.id, leftIndex, rightIndex, tag: left.tag, tagWidth: left.tagWidth, lengthWidth: left.lengthWidth, bodyOffset: range.leftStart - left.bodyStart });
  }
  return { ok: true, placement };
}

function evaluateTlv(data, form) {
  let baselineLayout; let baselineMirrors; let parsedCount = 0;
  for (const row of data.rows) {
    const parsed = parseTlv(row.payload, form);
    if (!parsed.ok) return {
      id: form.id, exact: false, stage: "parse", parsedCount,
      firstFailure: (() => {
        const { ok, ...failure } = parsed;
        return { replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId, ...failure };
      })(),
    };
    if (parsed.records.length < 2 || !parsed.records.some((record) => record.length > 0)) {
      return { id: form.id, exact: false, stage: "nontrivial-records", parsedCount, firstFailure: { replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId, recordCount: parsed.records.length } };
    }
    const layout = JSON.stringify(parsed.records);
    if (baselineLayout === undefined) baselineLayout = layout;
    else if (layout !== baselineLayout) {
      return { id: form.id, exact: false, stage: "stable-record-boundary-grammar", parsedCount, firstFailure: { replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId, baselineLayout, observedLayout: layout } };
    }
    const mirrors = mirrorRecordPlacement(parsed.records);
    if (!mirrors.ok) return { id: form.id, exact: false, stage: "mirror-record-positions", parsedCount, firstFailure: { replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId, ...mirrors } };
    const mirrorLayout = JSON.stringify(mirrors.placement);
    if (baselineMirrors === undefined) baselineMirrors = mirrorLayout;
    else if (mirrorLayout !== baselineMirrors) {
      return { id: form.id, exact: false, stage: "stable-mirror-record-positions", parsedCount, firstFailure: { replayId: row.replayId, participantId: row.participantId, segmentId: row.segmentId, baselineMirrors, observedMirrors: mirrorLayout } };
    }
    parsedCount += 1;
  }
  return { id: form.id, exact: true, stage: "discovery-exact", parsedCount, layout: baselineLayout, mirrorPlacement: baselineMirrors };
}

function bitmapAssertion(value) {
  const compact = candidate => ({ boundary: candidate.boundary, order: candidate.order, bitOrder: candidate.bitOrder, inverted: candidate.inverted, target: candidate.target, observations: candidate.observations, tp: candidate.tp, fp: candidate.fp, fn: candidate.fn, tn: candidate.tn, mismatchCount: candidate.mismatchCount });
  return { candidateCount: value.candidateCount, nonDefault: { exactCandidateCount: value.nonDefault.exactCandidateCount, best: compact(value.nonDefault.best) }, changed: { exactCandidateCount: value.changed.exactCandidateCount, best: compact(value.changed.best) } };
}

const args = parseArgs(process.argv);
// This fully opens, validates, and evaluates D7 before there is any path to H3.
const discoveryData = organizeRows(dumpRows(args, PROFILE.discovery));
const bitmap = { nonDefault: evaluateBitmap(discoveryData, "nonDefault"), changed: evaluateBitmap(discoveryData, "changed") };
const tlv = TLV_FORMS.map((form) => evaluateTlv(discoveryData, form));
const discoveryAssertion = { snapshotCount: discoveryData.rows.length, ownerSequenceCount: discoveryData.ownerSequences.length, bitmap: bitmapAssertion({ candidateCount: bitmap.nonDefault.candidateCount, ...bitmap }), tlv };
assertEqual("D7 exact-build layout falsification gate", discoveryAssertion, EXPECTED_D7);

const exactBitmapCandidates = [...bitmap.nonDefault.exactCandidates, ...bitmap.changed.exactCandidates];
const exactTlvCandidates = tlv.filter((candidate) => candidate.exact);
let holdout = { opened: false, reason: "D7 found zero exact flat-bitmap and zero exact predeclared TLV candidates; H3 was intentionally not opened." };
if (exactBitmapCandidates.length || exactTlvCandidates.length) {
  const holdoutData = organizeRows(dumpRows(args, PROFILE.holdout));
  holdout = {
    opened: true,
    snapshotCount: holdoutData.rows.length,
    bitmap: exactBitmapCandidates.map((candidate) => assessBitmap(candidate, holdoutData)),
    tlv: exactTlvCandidates.map((candidate) => evaluateTlv(holdoutData, TLV_FORMS.find((form) => form.id === candidate.id))),
  };
}

const result = {
  schema: "rofl-keyframe-layout-falsifications-research/v1",
  researchOnly: true,
  promotionGate: false,
  runtimeInput: false,
  profile: { exactReplayBuild: PROFILE.exactReplayBuild, packetType: "0x02EB", payloadLength: PROFILE.payloadLength, championOwnerBase: "0x400000AD" },
  inputBoundary: "Saved .rofl packet bytes only. No Riot API, Timeline, installed-client, process, or runtime input is read.",
  split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
  flatBitmapAudit: {
    predeclaredLayouts: { forms: ["[bitset][byte-values]", "[byte-values][bitset]"], bitmapByteLengths: PROFILE.bitmapByteLengths, bitOrders: ["lsb", "msb"], presencePolarities: ["direct", "inverted"], targets: ["value != 0x0E", "value changed from previous champion snapshot"], byteLosslessConstraint: "Every payload byte belongs to exactly one contiguous bitmap or value region; each value byte maps to exactly one bitmap bit. Trailing bitmap bits are reported but never treated as value bytes." },
    discovery: { snapshotCount: discoveryData.rows.length, ownerSequenceCount: discoveryData.ownerSequences.length, nonDefault: bitmap.nonDefault, changed: bitmap.changed },
  },
  wholePayloadTlvAudit: {
    predeclaredForms: TLV_FORMS.map((form) => form.id),
    gate: "Each named form must consume every byte, produce at least two records including one nonempty body, keep an identical tag/header-width/length record-boundary layout across every D7 snapshot, and place both frozen exact mirror ranges in corresponding repeated record positions.",
    discovery: tlv,
  },
  holdout,
  conclusion: "D7 falsifies all 144 predeclared flat bitmap/value layouts and all three named whole-payload TLV forms. Because no D7 candidate is exact, H3 remains unopened. This bounded result does not rule out other masks, nested/stateful records, replication grammar, or any semantic field; it supplies no decoder or runtime field.",
};

const outputPath = path.resolve(args.outputPath);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ valid: true, schema: result.schema, discoverySnapshots: discoveryData.rows.length, flatBitmapExactCandidates: exactBitmapCandidates.length, wholePayloadTlvExactCandidates: exactTlvCandidates.length, holdoutOpened: holdout.opened }, null, 2));
