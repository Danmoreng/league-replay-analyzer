#!/usr/bin/env node

// Offline research only. The saved Riot Timeline is a validation oracle and
// never a runtime input. This script does not emit a decoder or runtime API.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  versionGroup: "16.14",
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x02eb,
  payloadLength: 1479,
  championOwnerBase: 0x400000ad,
  fixtures: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664",
    "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492",
    "EUW1-7920550565", "EUW1-7921377760", "EUW1-7921482297",
    "EUW1-7921996430",
  ]),
  discovery: Object.freeze([
    "EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664",
    "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492",
    "EUW1-7920550565",
  ]),
  holdout: Object.freeze([
    "EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430",
  ]),
  // These are observed change correlations, not a decoded total-gold field.
  // [109, 119] was identified after inspecting the corpus, so it is explicitly
  // post-hoc. The bounded search below selects from Discovery only before H3.
  totalGoldPostHocOffsets: Object.freeze([109, 119]),
  totalGoldPriorCorrelationOffsets: Object.freeze([115, 117, 119]),
  totalGoldCandidateOffsets: Object.freeze(Array.from({ length: 33 }, (_, index) => 96 + index)),
  // Minimal change envelope. It establishes only whether lane CS changed,
  // never its value; p128 is retained only as an inert diagnostic.
  laneCsOffsets: Object.freeze([125, 127, 129]),
  laneCsLoroCandidateOffsets: Object.freeze(Array.from({ length: 21 }, (_, index) => 120 + index)),
  jungleCsOffsets: Object.freeze([134, 135, 136, 137]),
  // Structural-only diagnostics. Discovery selects exact, non-constant
  // mirrored windows from this bounded rule before H3 is inspected; the
  // expected output below is the freeze gate, not the selector input.
  // They do not locate a semantic field or authorize an offset envelope.
  structuralDefaultByte: 0x0e,
  structuralMirrorSelector: Object.freeze({ minimumWindowLength: 8 }),
  structuralMirrorExpectedRanges: Object.freeze([
    Object.freeze({ id: "mirror-154-162-to-1289-1297", leftStart: 154, rightStart: 1289, length: 9 }),
    Object.freeze({ id: "mirror-1066-1073-to-1074-1081", leftStart: 1066, rightStart: 1074, length: 8 }),
  ]),
});

// Fixed-corpus drift gates. The all-corpus LORO rows intentionally retain the
// selected lane and exact confusion counts. They are a separate cross-validation
// view and do not extend the declared 7/3 discovery/holdout evidence boundary.
// Direct/delta negative gates are kept for that primary split.
function expectedMetric(tp, tn, directMisses, deltaMatches) {
  return { tp, fp: 0, fn: 0, tn, directMatches: 0, directMisses, deltaMatches, deltaMisses: directMisses - deltaMatches, exactChangeAnchor: true };
}
function expectedGoldLoro() {
  const heldout = [
    ["EUW1-7919517389", 250, 10], ["EUW1-7919624327", 252, 8], ["EUW1-7920241664", 332, 8], ["EUW1-7920292147", 392, 8], ["EUW1-7920341366", 245, 5],
    ["EUW1-7920364492", 242, 8], ["EUW1-7920550565", 330, 10], ["EUW1-7921377760", 234, 6], ["EUW1-7921482297", 463, 7], ["EUW1-7921996430", 284, 6],
  ];
  return Object.fromEntries(heldout.map(([replayId, tp, tn]) => [replayId, {
    minimumUnionSize: 2,
    exactTrainingUnions: [[109, 119], [115, 119], [117, 119]].map((offsets) => ({ offsets, heldout: { tp, fp: 0, fn: 0, tn, exactChangeAnchor: true } })),
  }]));
}
const EXPECTED = Object.freeze({
  schema: "rofl-keyframe-economy-anchors-research/v4",
  counts: { snapshots: 3200, transitions: 3100, discoveryTransitions: 2100, holdoutTransitions: 1000 },
  totalGold: {
    fieldBoundaryAvailable: false, nonUnique: true, postHoc: true,
    postHocCorrelations: [
      { id: "post-hoc-109-119", offsets: [109, 119], discovery: expectedMetric(2043, 57, 2100, 58), holdout: expectedMetric(981, 19, 1000, 19) },
      { id: "prior-115-117-119", offsets: [115, 117, 119], discovery: expectedMetric(2043, 57, 2100, 57), holdout: expectedMetric(981, 19, 1000, 19) },
    ],
    boundedDiscoverySearch: {
      candidateOffsets: Array.from({ length: 33 }, (_, index) => 96 + index),
      maximumUnionSize: 3,
      minimumUnionSize: 2,
      exactDiscoveryUnions: [
        { offsets: [109, 119], discovery: expectedMetric(2043, 57, 2100, 58), holdout: expectedMetric(981, 19, 1000, 19) },
        { offsets: [115, 119], discovery: expectedMetric(2043, 57, 2100, 57), holdout: expectedMetric(981, 19, 1000, 19) },
        { offsets: [117, 119], discovery: expectedMetric(2043, 57, 2100, 57), holdout: expectedMetric(981, 19, 1000, 19) },
      ],
    },
    allCorpusLoro: expectedGoldLoro(),
  },
  laneCs: {
    discovery: { tp: 1458, fp: 0, fn: 0, tn: 642, directMatches: 0, directMisses: 2100, deltaMatches: 642, deltaMisses: 1458, exactChangeAnchor: true },
    holdout: { tp: 697, fp: 0, fn: 0, tn: 303, directMatches: 0, directMisses: 1000, deltaMatches: 303, deltaMisses: 697, exactChangeAnchor: true },
    p125AlternativeComponent: {
      discovery: { positiveChangeCount: 24, negativeChangeCount: 0, p125OnlyPositiveChangeCount: 1, p125OnlyWitnesses: [{ replayId: "EUW1-7920292147", participantId: 3, previousSegmentId: 38, nextSegmentId: 39, previousLaneCs: 280, nextLaneCs: 281, p125TransitionHex: "0e->e8" }] },
      holdout: { positiveChangeCount: 32, negativeChangeCount: 0, p125OnlyPositiveChangeCount: 2, p125OnlyWitnesses: [{ replayId: "EUW1-7921482297", participantId: 3, previousSegmentId: 46, nextSegmentId: 47, previousLaneCs: 360, nextLaneCs: 361, p125TransitionHex: "0e->e8" }, { replayId: "EUW1-7921482297", participantId: 8, previousSegmentId: 46, nextSegmentId: 47, previousLaneCs: 268, nextLaneCs: 269, p125TransitionHex: "0e->e8" }] },
    },
    inertOffset128: { discoveryChangedTransitionCount: 0, holdoutChangedTransitionCount: 0 },
    discoverySelector: { selectedOffsets: [127, 129, 125], discovery: { tp: 1458, fp: 0, fn: 0, tn: 642, exactChangeAnchor: true }, holdout: { tp: 697, fp: 0, fn: 0, tn: 303, exactChangeAnchor: true } },
    boundedDiscoverySearch: {
      candidateOffsets: Array.from({ length: 21 }, (_, index) => 120 + index),
      maximumUnionSize: 3,
      minimumUnionSize: 3,
      exactDiscoveryUnions: [{ offsets: [125, 127, 129], discovery: expectedMetric(1458, 642, 2100, 642), holdout: expectedMetric(697, 303, 1000, 303) }],
    },
    allCorpusLoro: {
      "EUW1-7919517389": { selectedOffsets: [127, 129, 125], heldout: { tp: 180, fp: 0, fn: 0, tn: 80, exactChangeAnchor: true } },
      "EUW1-7919624327": { selectedOffsets: [127, 129, 125], heldout: { tp: 184, fp: 0, fn: 0, tn: 76, exactChangeAnchor: true } },
      "EUW1-7920241664": { selectedOffsets: [127, 129, 125], heldout: { tp: 247, fp: 0, fn: 0, tn: 93, exactChangeAnchor: true } },
      "EUW1-7920292147": { selectedOffsets: [127, 129, 125], heldout: { tp: 266, fp: 0, fn: 0, tn: 134, exactChangeAnchor: true } },
      "EUW1-7920341366": { selectedOffsets: [127, 129, 125], heldout: { tp: 185, fp: 0, fn: 0, tn: 65, exactChangeAnchor: true } },
      "EUW1-7920364492": { selectedOffsets: [127, 129, 125], heldout: { tp: 172, fp: 0, fn: 0, tn: 78, exactChangeAnchor: true } },
      "EUW1-7920550565": { selectedOffsets: [127, 129, 125], heldout: { tp: 224, fp: 0, fn: 0, tn: 116, exactChangeAnchor: true } },
      "EUW1-7921377760": { selectedOffsets: [127, 129, 125], heldout: { tp: 175, fp: 0, fn: 0, tn: 65, exactChangeAnchor: true } },
      "EUW1-7921482297": { selectedOffsets: [127, 129, 125], heldout: { tp: 322, fp: 0, fn: 0, tn: 148, exactChangeAnchor: true } },
      "EUW1-7921996430": { selectedOffsets: [127, 129, 125], heldout: { tp: 200, fp: 0, fn: 0, tn: 90, exactChangeAnchor: true } },
    },
  },
  jungleCs: {
    discovery: { tp: 367, fp: 8, fn: 0, tn: 1725, directMatches: 0, directMisses: 2100, deltaMatches: 1725, deltaMisses: 375, exactChangeAnchor: false },
    holdout: { tp: 183, fp: 2, fn: 0, tn: 815, directMatches: 0, directMisses: 1000, deltaMatches: 815, deltaMisses: 185, exactChangeAnchor: false },
  },
  structureDiagnostics: {
    structuralOnly: true,
    semanticFieldAvailable: false,
    runtimeUse: false,
    payloadForm: {
      discovery: { payloadLength: 1479, snapshotCount: 2170, exactPayloadCount: 2170, nonConformingPayloadCount: 0, exact: true },
      holdout: { payloadLength: 1479, snapshotCount: 1030, exactPayloadCount: 1030, nonConformingPayloadCount: 0, exact: true },
    },
    activeOffsets: {
      defaultByte: "0x0e",
      discoveryEverNonDefaultCount: 229,
      discoveryAlwaysDefaultCount: 1250,
      holdoutEverNonDefaultCount: 221,
      holdoutAlwaysDefaultCount: 1258,
      holdoutSubsetOfDiscovery: true,
      holdoutOutsideDiscoveryCount: 0,
    },
    mirrorSelection: {
      sourceSplit: "D7",
      minimumWindowLength: 8,
      selectedMaximalRangeCount: 2,
      exactFrozenExpectedRangeMatch: true,
      selectedRanges: [
        { leftStart: 154, rightStart: 1289, length: 9 },
        { leftStart: 1066, rightStart: 1074, length: 8 },
      ],
    },
    exactMirrorRanges: [
      {
        discovery: { id: "mirror-154-162-to-1289-1297", left: { start: 154, end: 162 }, right: { start: 1289, end: 1297 }, length: 9, snapshotCount: 2170, exactSnapshotEqualityCount: 2170, equalDirtyBytePredicateCount: 18900, totalDirtyBytePredicates: 18900, exactDirtyBytePredicateEquality: true, canExtendLeft: false, canExtendRight: false, maximalExactRange: true },
        holdout: { id: "mirror-154-162-to-1289-1297", left: { start: 154, end: 162 }, right: { start: 1289, end: 1297 }, length: 9, snapshotCount: 1030, exactSnapshotEqualityCount: 1030, equalDirtyBytePredicateCount: 9000, totalDirtyBytePredicates: 9000, exactDirtyBytePredicateEquality: true, canExtendLeft: false, canExtendRight: false, maximalExactRange: true },
      },
      {
        discovery: { id: "mirror-1066-1073-to-1074-1081", left: { start: 1066, end: 1073 }, right: { start: 1074, end: 1081 }, length: 8, snapshotCount: 2170, exactSnapshotEqualityCount: 2170, equalDirtyBytePredicateCount: 16800, totalDirtyBytePredicates: 16800, exactDirtyBytePredicateEquality: true, canExtendLeft: false, canExtendRight: false, maximalExactRange: true },
        holdout: { id: "mirror-1066-1073-to-1074-1081", left: { start: 1066, end: 1073 }, right: { start: 1074, end: 1081 }, length: 8, snapshotCount: 1030, exactSnapshotEqualityCount: 1030, equalDirtyBytePredicateCount: 8000, totalDirtyBytePredicates: 8000, exactDirtyBytePredicateEquality: true, canExtendLeft: false, canExtendRight: false, maximalExactRange: true },
      },
    ],
    simpleTwoByteCellFalsification: {
      discovery: {
        observations: 1603630,
        valueThenDefault: { requiredDefaultSecondByteCount: 1603630, observedDefaultSecondByteCount: 1332039, violations: 271591, exact: false },
        defaultThenValue: { requiredDefaultFirstByteCount: 1603630, observedDefaultFirstByteCount: 1570693, violations: 32937, exact: false },
        adjacentMaskHeaderChecks: [
          { headerByteIndex: 0, valueByteIndex: 1, candidatesExamined: 16, exactCandidateCount: 0, bestCandidate: { bit: 5, inverted: false, matches: 1331341, mismatches: 272289 } },
          { headerByteIndex: 1, valueByteIndex: 0, candidatesExamined: 16, exactCandidateCount: 0, bestCandidate: { bit: 5, inverted: false, matches: 1474242, mismatches: 129388 } },
        ],
      },
      holdout: {
        observations: 761170,
        valueThenDefault: { requiredDefaultSecondByteCount: 761170, observedDefaultSecondByteCount: 629266, violations: 131904, exact: false },
        defaultThenValue: { requiredDefaultFirstByteCount: 761170, observedDefaultFirstByteCount: 744878, violations: 16292, exact: false },
        adjacentMaskHeaderChecks: [
          { headerByteIndex: 0, valueByteIndex: 1, candidatesExamined: 16, exactCandidateCount: 0, bestCandidate: { bit: 5, inverted: false, matches: 628903, mismatches: 132267 } },
          { headerByteIndex: 1, valueByteIndex: 0, candidatesExamined: 16, exactCandidateCount: 0, bestCandidate: { bit: 5, inverted: false, matches: 698596, mismatches: 62574 } },
        ],
      },
    },
  },
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "keyframe-economy-anchors-16.14.json"),
    printObserved: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--cli" && i + 1 < argv.length) args.cliPath = argv[++i];
    else if (arg === "--replay-dir" && i + 1 < argv.length) args.replayDir = argv[++i];
    else if (arg === "--api-root" && i + 1 < argv.length) args.apiRoot = argv[++i];
    else if (arg === "--output" && i + 1 < argv.length) args.outputPath = argv[++i];
    else if (arg === "--print-observed") args.printObserved = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/research_keyframe_economy_anchors_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function fail(message, detail = undefined) {
  const suffix = detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`;
  throw new Error(`${message}${suffix}`);
}

function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }

function dumpKeyframes(args, replayPath) {
  const run = spawnSync(args.cliPath, [
    "--dump-packet-type-json", replayPath, "--packet-type", String(PROFILE.packetType),
    "--segment-type", "keyframe", "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) fail("Native packet dump failed.", { replayPath, stderr: run.stderr.trim() });
  const dump = JSON.parse(run.stdout);
  if (!dump.valid || dump.errors?.length || dump.truncated || dump.emittedBlockCount !== dump.matchingBlockCount) {
    fail("Exact keyframe packet framing gate failed.", { replayPath, dump });
  }
  if (dump.packetType !== PROFILE.packetType || dump.segmentType !== "keyframe" || dump.gameVersion !== PROFILE.exactReplayBuild) {
    fail("Packet profile/version gate failed.", { replayPath, packetType: dump.packetType, segmentType: dump.segmentType, gameVersion: dump.gameVersion });
  }
  return dump.blocks ?? [];
}

function collectRows(args, replayIds) {
  const rows = [];
  for (const replayId of replayIds) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    const fixtureDir = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
    const matchPath = path.join(fixtureDir, "match.json");
    const timelinePath = path.join(fixtureDir, "timeline.json");
    if (!fs.existsSync(replayPath) || !fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) fail("Fixed fixture is missing.", { replayId, replayPath, matchPath, timelinePath });
    if (readJson(matchPath).info?.gameVersion !== PROFILE.exactReplayBuild) fail("Offline fixture version drift.", { replayId });
    const frames = readJson(timelinePath).info?.frames;
    if (!Array.isArray(frames) || frames.length === 0) fail("Timeline has no frames.", { replayId });
    const blocks = dumpKeyframes(args, replayPath);
    const perSegment = new Map();
    for (const block of blocks) {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      if (!Number.isInteger(participantId) || participantId < 1 || participantId > 10) fail("Non-champion owner in profiled keyframe family.", { replayId, block });
      if (block.contentLength !== PROFILE.payloadLength || block.contentHexTruncated !== false
        || block.contentHexBytes !== PROFILE.payloadLength || typeof block.contentHex !== "string"
        || block.contentHex.length !== PROFILE.payloadLength * 2 || !/^[0-9a-f]*$/iu.test(block.contentHex)) {
        fail("Payload-length/full-content gate failed.", { replayId, block });
      }
      const frame = frames[block.segmentId - 1];
      const participant = frame?.participantFrames?.[String(participantId)];
      if (!participant || !Number.isInteger(participant.totalGold) || !Number.isInteger(participant.minionsKilled) || !Number.isInteger(participant.jungleMinionsKilled)) fail("Offline label/keyframe alignment gate failed.", { replayId, segmentId: block.segmentId, participantId });
      const owners = perSegment.get(block.segmentId) ?? new Set();
      if (owners.has(participantId)) fail("Duplicate champion snapshot in keyframe.", { replayId, segmentId: block.segmentId, participantId });
      owners.add(participantId); perSegment.set(block.segmentId, owners);
      rows.push({ replayId, participantId, segmentId: block.segmentId, payload: Buffer.from(block.contentHex, "hex"), totalGold: participant.totalGold, laneCs: participant.minionsKilled, jungleCs: participant.jungleMinionsKilled });
    }
    if ([...perSegment.values()].some((owners) => owners.size !== 10)) fail("Keyframe owner-completeness gate failed.", { replayId, perSegment: [...perSegment.entries()].map(([segmentId, owners]) => ({ segmentId, owners: owners.size })) });
  }
  return rows;
}

function transitions(rows) {
  const byOwner = new Map();
  for (const row of rows) (byOwner.get(`${row.replayId}|${row.participantId}`) ?? byOwner.set(`${row.replayId}|${row.participantId}`, []).get(`${row.replayId}|${row.participantId}`)).push(row);
  const out = [];
  for (const ownerRows of byOwner.values()) {
    ownerRows.sort((a, b) => a.segmentId - b.segmentId);
    for (let i = 1; i < ownerRows.length; i += 1) {
      if (ownerRows[i].segmentId !== ownerRows[i - 1].segmentId + 1) fail("Non-consecutive keyframe sequence.", { previous: ownerRows[i - 1], next: ownerRows[i] });
      out.push({ previous: ownerRows[i - 1], next: ownerRows[i] });
    }
  }
  return out;
}

function changed(row, previous, offsets) { return offsets.some((offset) => row.payload[offset] !== previous.payload[offset]); }
function packed(payload, offsets) { return offsets.reduce((value, offset) => value * 256 + payload[offset], 0); }

function metrics(rows, labelKey, offsets) {
  const result = { tp: 0, fp: 0, fn: 0, tn: 0, directMatches: 0, directMisses: 0, deltaMatches: 0, deltaMisses: 0 };
  for (const transition of transitions(rows)) {
    const actualChange = transition.next[labelKey] !== transition.previous[labelKey];
    const candidateChange = changed(transition.next, transition.previous, offsets);
    if (candidateChange && actualChange) result.tp += 1;
    else if (candidateChange) result.fp += 1;
    else if (actualChange) result.fn += 1;
    else result.tn += 1;
    if (packed(transition.next.payload, offsets) === transition.next[labelKey]) result.directMatches += 1;
    else result.directMisses += 1;
    if (packed(transition.next.payload, offsets) - packed(transition.previous.payload, offsets) === transition.next[labelKey] - transition.previous[labelKey]) result.deltaMatches += 1;
    else result.deltaMisses += 1;
  }
  result.exactChangeAnchor = result.fp === 0 && result.fn === 0;
  return result;
}

function laneCsAlternativeComponentMetrics(rows) {
  const result = { positiveChangeCount: 0, negativeChangeCount: 0, p125OnlyPositiveChangeCount: 0, p125OnlyWitnesses: [] };
  for (const transition of transitions(rows)) {
    const p125Changed = changed(transition.next, transition.previous, [125]);
    if (!p125Changed) continue;
    const laneCsChanged = transition.next.laneCs !== transition.previous.laneCs;
    if (laneCsChanged) result.positiveChangeCount += 1;
    else result.negativeChangeCount += 1;
    if (laneCsChanged && !changed(transition.next, transition.previous, [127, 129])) {
      result.p125OnlyPositiveChangeCount += 1;
      result.p125OnlyWitnesses.push({
        replayId: transition.next.replayId,
        participantId: transition.next.participantId,
        previousSegmentId: transition.previous.segmentId,
        nextSegmentId: transition.next.segmentId,
        previousLaneCs: transition.previous.laneCs,
        nextLaneCs: transition.next.laneCs,
        p125TransitionHex: `${transition.previous.payload[125].toString(16).padStart(2, "0")}->${transition.next.payload[125].toString(16).padStart(2, "0")}`,
      });
    }
  }
  return result;
}

function inertOffsetChangedTransitionCount(rows, offset) {
  return transitions(rows).filter((transition) => changed(transition.next, transition.previous, [offset])).length;
}

function activeOffsetSet(rows, defaultByte) {
  const active = new Set();
  for (const row of rows) for (let offset = 0; offset < row.payload.length; offset += 1) {
    if (row.payload[offset] !== defaultByte) active.add(offset);
  }
  return active;
}

function payloadFormDiagnostics(rows) {
  const exactPayloadCount = rows.filter((row) => row.payload.length === PROFILE.payloadLength).length;
  return {
    payloadLength: PROFILE.payloadLength,
    snapshotCount: rows.length,
    exactPayloadCount,
    nonConformingPayloadCount: rows.length - exactPayloadCount,
    exact: exactPayloadCount === rows.length,
  };
}

// Discovery-only structural selector. It groups fixed-width windows by their
// complete snapshot signature, excludes windows that are entirely constant,
// and coalesces adjacent equal-signature pairs into maximal fixed-distance
// ranges. The frozen expected ranges are compared after selection; H3 never
// participates. Window-level non-constancy deliberately permits a mixed
// constant/dynamic mirror such as [0x0e, dynamic, 0x0e, ...].
function selectExactMirrorRanges(rows, minimumWindowLength) {
  const windowStartsBySignature = new Map();
  for (let start = 0; start <= PROFILE.payloadLength - minimumWindowLength; start += 1) {
    const signature = Buffer.allocUnsafe(rows.length * minimumWindowLength);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      rows[rowIndex].payload.copy(signature, rowIndex * minimumWindowLength, start, start + minimumWindowLength);
    }
    const firstWindow = signature.subarray(0, minimumWindowLength);
    const nonConstant = rows.slice(1).some((_, rowIndex) => !signature.subarray((rowIndex + 1) * minimumWindowLength, (rowIndex + 2) * minimumWindowLength).equals(firstWindow));
    if (!nonConstant) continue;
    const key = signature.toString("base64");
    const starts = windowStartsBySignature.get(key) ?? [];
    starts.push(start);
    windowStartsBySignature.set(key, starts);
  }
  const leftOffsetsByDistance = new Map();
  for (const starts of windowStartsBySignature.values()) for (let leftIndex = 0; leftIndex < starts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < starts.length; rightIndex += 1) {
      const leftStart = starts[leftIndex];
      const distance = starts[rightIndex] - leftStart;
      const leftOffsets = leftOffsetsByDistance.get(distance) ?? [];
      leftOffsets.push(leftStart);
      leftOffsetsByDistance.set(distance, leftOffsets);
    }
  }
  const selected = [];
  for (const [distance, leftOffsets] of leftOffsetsByDistance) {
    leftOffsets.sort((left, right) => left - right);
    let runStart = leftOffsets[0];
    let previous = leftOffsets[0];
    const keepRun = () => {
      const length = previous - runStart + minimumWindowLength;
      if (length >= minimumWindowLength) selected.push({ leftStart: runStart, rightStart: runStart + distance, length });
    };
    for (let index = 1; index < leftOffsets.length; index += 1) {
      if (leftOffsets[index] === previous + 1) previous = leftOffsets[index];
      else { keepRun(); runStart = leftOffsets[index]; previous = leftOffsets[index]; }
    }
    keepRun();
  }
  return selected.sort((left, right) => left.leftStart - right.leftStart || left.rightStart - right.rightStart || left.length - right.length);
}

function freezeMirrorSelection(discoveryRows) {
  const selected = selectExactMirrorRanges(discoveryRows, PROFILE.structuralMirrorSelector.minimumWindowLength);
  const expected = PROFILE.structuralMirrorExpectedRanges.map(({ leftStart, rightStart, length }) => ({ leftStart, rightStart, length }));
  if (JSON.stringify(selected) !== JSON.stringify(expected)) fail("Discovery-only structural mirror selector drifted.", { expected, selected });
  return {
    sourceSplit: "D7",
    minimumWindowLength: PROFILE.structuralMirrorSelector.minimumWindowLength,
    selectedMaximalRangeCount: selected.length,
    exactFrozenExpectedRangeMatch: true,
    selectedRanges: selected,
    ranges: PROFILE.structuralMirrorExpectedRanges,
  };
}

function mirrorRangeDiagnostics(rows, range) {
  const transitionsForRows = transitions(rows);
  const equalInEverySnapshot = rows.every((row) => row.payload.subarray(range.leftStart, range.leftStart + range.length)
    .equals(row.payload.subarray(range.rightStart, range.rightStart + range.length)));
  const equalDirtyBytePredicates = transitionsForRows.reduce((count, transition) => count + Array.from({ length: range.length }, (_, index) =>
    Number((transition.previous.payload[range.leftStart + index] !== transition.next.payload[range.leftStart + index])
      === (transition.previous.payload[range.rightStart + index] !== transition.next.payload[range.rightStart + index])))
      .reduce((sum, value) => sum + value, 0), 0);
  const canExtendLeft = range.leftStart > 0 && range.rightStart > 0 && rows.every((row) =>
    row.payload[range.leftStart - 1] === row.payload[range.rightStart - 1]);
  const canExtendRight = range.leftStart + range.length < PROFILE.payloadLength
    && range.rightStart + range.length < PROFILE.payloadLength && rows.every((row) =>
      row.payload[range.leftStart + range.length] === row.payload[range.rightStart + range.length]);
  return {
    id: range.id,
    left: { start: range.leftStart, end: range.leftStart + range.length - 1 },
    right: { start: range.rightStart, end: range.rightStart + range.length - 1 },
    length: range.length,
    snapshotCount: rows.length,
    exactSnapshotEqualityCount: rows.filter((row) => row.payload.subarray(range.leftStart, range.leftStart + range.length)
      .equals(row.payload.subarray(range.rightStart, range.rightStart + range.length))).length,
    equalDirtyBytePredicateCount: equalDirtyBytePredicates,
    totalDirtyBytePredicates: transitionsForRows.length * range.length,
    exactDirtyBytePredicateEquality: equalDirtyBytePredicates === transitionsForRows.length * range.length,
    canExtendLeft,
    canExtendRight,
    maximalExactRange: equalInEverySnapshot && !canExtendLeft && !canExtendRight,
  };
}

function twoByteCellDiagnostics(rows, defaultByte) {
  const cellCount = Math.floor(PROFILE.payloadLength / 2);
  const observations = rows.length * cellCount;
  const defaultSecondByteCount = rows.reduce((count, row) => count + Array.from({ length: cellCount }, (_, index) =>
    Number(row.payload[index * 2 + 1] === defaultByte)).reduce((sum, value) => sum + value, 0), 0);
  const defaultFirstByteCount = rows.reduce((count, row) => count + Array.from({ length: cellCount }, (_, index) =>
    Number(row.payload[index * 2] === defaultByte)).reduce((sum, value) => sum + value, 0), 0);
  const maskHeaderCheck = (headerIndex, valueIndex) => {
    const candidates = [];
    for (let bit = 0; bit < 8; bit += 1) for (const inverted of [false, true]) {
      let matches = 0;
      for (const row of rows) for (let cell = 0; cell < cellCount; cell += 1) {
        const headerBit = (row.payload[cell * 2 + headerIndex] & (1 << bit)) !== 0;
        const predictedActive = inverted ? !headerBit : headerBit;
        if (predictedActive === (row.payload[cell * 2 + valueIndex] !== defaultByte)) matches += 1;
      }
      candidates.push({ bit, inverted, matches, mismatches: observations - matches });
    }
    candidates.sort((left, right) => right.matches - left.matches || left.bit - right.bit || Number(left.inverted) - Number(right.inverted));
    return {
      headerByteIndex: headerIndex,
      valueByteIndex: valueIndex,
      candidatesExamined: candidates.length,
      exactCandidateCount: candidates.filter((candidate) => candidate.mismatches === 0).length,
      bestCandidate: candidates[0],
    };
  };
  return {
    defaultByte: `0x${defaultByte.toString(16).padStart(2, "0")}`,
    cellWidthBytes: 2,
    cellsPerPayload: cellCount,
    trailingBytesOutsideCells: PROFILE.payloadLength - cellCount * 2,
    observations,
    valueThenDefault: {
      requiredDefaultSecondByteCount: observations,
      observedDefaultSecondByteCount: defaultSecondByteCount,
      violations: observations - defaultSecondByteCount,
      exact: defaultSecondByteCount === observations,
    },
    defaultThenValue: {
      requiredDefaultFirstByteCount: observations,
      observedDefaultFirstByteCount: defaultFirstByteCount,
      violations: observations - defaultFirstByteCount,
      exact: defaultFirstByteCount === observations,
    },
    adjacentMaskHeaderChecks: [maskHeaderCheck(0, 1), maskHeaderCheck(1, 0)],
  };
}

function structureDiagnostics(discoveryRows, holdoutRows) {
  const defaultByte = PROFILE.structuralDefaultByte;
  const discoveryActive = activeOffsetSet(discoveryRows, defaultByte);
  const holdoutActive = activeOffsetSet(holdoutRows, defaultByte);
  const holdoutOutsideDiscoveryCount = [...holdoutActive].filter((offset) => !discoveryActive.has(offset)).length;
  const mirrorSelection = freezeMirrorSelection(discoveryRows);
  return {
    structuralOnly: true,
    semanticFieldAvailable: false,
    runtimeUse: false,
    methodology: "D7 selects non-constant, exact fixed-distance mirror windows of at least eight bytes, freezes the expected maximal ranges, then evaluates only those selected ranges on H3. D7 also freezes fixed payload-form, active-count, and simple two-byte-cell falsification checks. Active offsets are counts only; no decoder offset envelope is emitted.",
    payloadForm: { discovery: payloadFormDiagnostics(discoveryRows), holdout: payloadFormDiagnostics(holdoutRows) },
    activeOffsets: {
      defaultByte: `0x${defaultByte.toString(16).padStart(2, "0")}`,
      discoveryEverNonDefaultCount: discoveryActive.size,
      discoveryAlwaysDefaultCount: PROFILE.payloadLength - discoveryActive.size,
      holdoutEverNonDefaultCount: holdoutActive.size,
      holdoutAlwaysDefaultCount: PROFILE.payloadLength - holdoutActive.size,
      holdoutSubsetOfDiscovery: holdoutOutsideDiscoveryCount === 0,
      holdoutOutsideDiscoveryCount,
    },
    mirrorSelection: {
      sourceSplit: mirrorSelection.sourceSplit,
      minimumWindowLength: mirrorSelection.minimumWindowLength,
      selectedMaximalRangeCount: mirrorSelection.selectedMaximalRangeCount,
      exactFrozenExpectedRangeMatch: mirrorSelection.exactFrozenExpectedRangeMatch,
      selectedRanges: mirrorSelection.selectedRanges,
    },
    exactMirrorRanges: mirrorSelection.ranges.map((range) => ({
      discovery: mirrorRangeDiagnostics(discoveryRows, range),
      holdout: mirrorRangeDiagnostics(holdoutRows, range),
    })),
    simpleTwoByteCellFalsification: {
      conclusion: "Neither alternating [value, 0x0E] / [0x0E, value] cells nor a one-byte adjacent presence-mask header is exact; this rejects only those simple layouts, not a broader replication grammar.",
      discovery: twoByteCellDiagnostics(discoveryRows, defaultByte),
      holdout: twoByteCellDiagnostics(holdoutRows, defaultByte),
    },
  };
}

function combinations(values, count, start = 0, prefix = [], output = []) {
  if (prefix.length === count) { output.push(prefix); return output; }
  for (let index = start; index <= values.length - (count - prefix.length); index += 1) {
    combinations(values, count, index + 1, [...prefix, values[index]], output);
  }
  return output;
}

// The candidate window and maximum union size are fixed in the profile. This
// selector uses Discovery only; H3 is evaluated only after its results freeze.
function selectMinimumExactTotalGoldUnions(rows) {
  for (let size = 1; size <= 3; size += 1) {
    const exactUnions = combinations(PROFILE.totalGoldCandidateOffsets, size)
      .map((offsets) => ({ offsets, metrics: metrics(rows, "totalGold", offsets) }))
      .filter((candidate) => candidate.metrics.fp === 0 && candidate.metrics.fn === 0);
    if (exactUnions.length) return { candidateOffsets: PROFILE.totalGoldCandidateOffsets, minimumUnionSize: size, exactDiscoveryUnions: exactUnions };
  }
  fail("Bounded totalGold search found no exact union through three offsets.", { candidateOffsets: PROFILE.totalGoldCandidateOffsets });
}

// The bounded 120..140 locality was fixed before this leave-one-replay-out
// diagnostic. Each fold considers only single-byte, zero-false-positive
// change markers and greedily chooses the smallest deterministic set that
// covers every training lane-CS change. It is cross-validation only, not an
// additional independent holdout nor a runtime selection rule.
function selectLaneCsOffsets(rows) {
  const transitionsForRows = transitions(rows);
  const positiveIndices = transitionsForRows.flatMap((transition, index) =>
    transition.next.laneCs !== transition.previous.laneCs ? [index] : []);
  const candidates = PROFILE.laneCsLoroCandidateOffsets.map((offset) => {
    const covered = new Set();
    let falsePositiveCount = 0;
    for (let index = 0; index < transitionsForRows.length; index += 1) {
      const transition = transitionsForRows[index];
      if (!changed(transition.next, transition.previous, [offset])) continue;
      if (transition.next.laneCs !== transition.previous.laneCs) covered.add(index);
      else falsePositiveCount += 1;
    }
    return { offset, covered, falsePositiveCount };
  }).filter((candidate) => candidate.falsePositiveCount === 0 && candidate.covered.size > 0);
  const selectedOffsets = [], uncovered = new Set(positiveIndices);
  while (uncovered.size > 0) {
    const ranked = candidates.map((candidate) => ({ candidate, newCoverage: [...candidate.covered].filter((index) => uncovered.has(index)).length }))
      .filter((entry) => entry.newCoverage > 0)
      .sort((left, right) => right.newCoverage - left.newCoverage || left.candidate.offset - right.candidate.offset);
    if (!ranked.length) fail("Bounded lane-CS LORO selector cannot cover every training change.", { selectedOffsets, uncoveredCount: uncovered.size });
    const next = ranked[0].candidate;
    selectedOffsets.push(next.offset);
    for (const index of next.covered) uncovered.delete(index);
  }
  return selectedOffsets;
}

// This enumerates the same predeclared locality as the greedy lane-CS
// diagnostic, rather than using the Holdout to break ties between unions.
function selectMinimumExactLaneCsUnions(rows) {
  for (let size = 1; size <= 3; size += 1) {
    const exactUnions = combinations(PROFILE.laneCsLoroCandidateOffsets, size)
      .map((offsets) => ({ offsets, metrics: metrics(rows, "laneCs", offsets) }))
      .filter((candidate) => candidate.metrics.fp === 0 && candidate.metrics.fn === 0);
    if (exactUnions.length) return { candidateOffsets: PROFILE.laneCsLoroCandidateOffsets, minimumUnionSize: size, exactDiscoveryUnions: exactUnions };
  }
  fail("Bounded lane-CS search found no exact union through three offsets.", { candidateOffsets: PROFILE.laneCsLoroCandidateOffsets });
}

function evaluate(rows) {
  const discoveryRows = rows.filter((row) => PROFILE.discovery.includes(row.replayId));
  const holdoutRows = rows.filter((row) => PROFILE.holdout.includes(row.replayId));
  const structure = structureDiagnostics(discoveryRows, holdoutRows);
  const boundedDiscoverySearch = selectMinimumExactTotalGoldUnions(discoveryRows);
  // Freeze the Discovery-selected alternatives before measuring the Holdout.
  const totalGold = {
    fieldBoundaryAvailable: false,
    nonUnique: true,
    postHoc: true,
    postHocCorrelations: [
      { id: "post-hoc-109-119", offsets: PROFILE.totalGoldPostHocOffsets, discovery: metrics(discoveryRows, "totalGold", PROFILE.totalGoldPostHocOffsets), holdout: metrics(holdoutRows, "totalGold", PROFILE.totalGoldPostHocOffsets) },
      { id: "prior-115-117-119", offsets: PROFILE.totalGoldPriorCorrelationOffsets, discovery: metrics(discoveryRows, "totalGold", PROFILE.totalGoldPriorCorrelationOffsets), holdout: metrics(holdoutRows, "totalGold", PROFILE.totalGoldPriorCorrelationOffsets) },
    ],
    boundedDiscoverySearch: {
      candidateOffsets: boundedDiscoverySearch.candidateOffsets,
      maximumUnionSize: 3,
      minimumUnionSize: boundedDiscoverySearch.minimumUnionSize,
      exactDiscoveryUnions: boundedDiscoverySearch.exactDiscoveryUnions.map(({ offsets, metrics: discovery }) => ({ offsets, discovery, holdout: metrics(holdoutRows, "totalGold", offsets) })),
    },
    allCorpusLoro: {},
  };
  const boundedLaneCsDiscoverySearch = selectMinimumExactLaneCsUnions(discoveryRows);
  const laneCs = {
    changeEnvelopeOnly: true,
    numericStateAvailable: false,
    numericDeltaAvailable: false,
    lastHitEventAvailable: false,
    runtimeUse: false,
    offsets: PROFILE.laneCsOffsets,
    discovery: metrics(discoveryRows, "laneCs", PROFILE.laneCsOffsets),
    holdout: metrics(holdoutRows, "laneCs", PROFILE.laneCsOffsets),
    p125AlternativeComponent: {
      discovery: laneCsAlternativeComponentMetrics(discoveryRows),
      holdout: laneCsAlternativeComponentMetrics(holdoutRows),
    },
    inertOffset128: {
      discoveryChangedTransitionCount: inertOffsetChangedTransitionCount(discoveryRows, 128),
      holdoutChangedTransitionCount: inertOffsetChangedTransitionCount(holdoutRows, 128),
    },
    discoverySelector: {},
    boundedDiscoverySearch: {
      candidateOffsets: boundedLaneCsDiscoverySearch.candidateOffsets,
      maximumUnionSize: 3,
      minimumUnionSize: boundedLaneCsDiscoverySearch.minimumUnionSize,
      exactDiscoveryUnions: boundedLaneCsDiscoverySearch.exactDiscoveryUnions.map(({ offsets, metrics: discovery }) => ({ offsets, discovery, holdout: metrics(holdoutRows, "laneCs", offsets) })),
    },
    allCorpusLoro: {},
  };
  const discoverySelectedLaneCsOffsets = selectLaneCsOffsets(discoveryRows);
  laneCs.discoverySelector = {
    selectedOffsets: discoverySelectedLaneCsOffsets,
    discovery: metrics(discoveryRows, "laneCs", discoverySelectedLaneCsOffsets),
    holdout: metrics(holdoutRows, "laneCs", discoverySelectedLaneCsOffsets),
  };
  for (const replayId of PROFILE.fixtures) {
    const train = rows.filter((row) => row.replayId !== replayId);
    const held = rows.filter((row) => row.replayId === replayId);
    const selectedTotalGold = selectMinimumExactTotalGoldUnions(train);
    totalGold.allCorpusLoro[replayId] = {
      minimumUnionSize: selectedTotalGold.minimumUnionSize,
      exactTrainingUnions: selectedTotalGold.exactDiscoveryUnions.map(({ offsets }) => ({ offsets, heldout: metrics(held, "totalGold", offsets) })),
    };
    const selectedLaneCsOffsets = selectLaneCsOffsets(train);
    laneCs.allCorpusLoro[replayId] = { selectedOffsets: selectedLaneCsOffsets, heldout: metrics(held, "laneCs", selectedLaneCsOffsets) };
  }
  return {
    schema: "rofl-keyframe-economy-anchors-research/v4",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    profile: { versionGroup: PROFILE.versionGroup, exactReplayBuild: PROFILE.exactReplayBuild, packetType: "0x02EB", payloadLength: PROFILE.payloadLength, championOwnerBase: "0x400000AD" },
    offlineOracle: { input: "Saved Riot Timeline participantFrames labels only", alignment: "ROFL keyframe segmentId - 1", runtimeUse: false },
    evidenceBoundary: "The totalGold [109,119] correlation was identified post-hoc, so its frozen 7/3 Holdout result is not historical unseen-selection evidence. The seven Discovery fixtures are loaded, all D7 structural/anchor gates are selected and asserted, and only then are the three H3 fixtures loaded. The totalGold minimum-union search is bounded to offsets 96..128, permits at most three offsets, and selects exact unions from Discovery only. The lane selector is bounded to 120..140 and likewise selects from Discovery only, but p125 was originally identified by a full-corpus mismatch audit. All leave-one-replay-out views select bounded candidate offsets on nine replays and check the tenth; they run after the fixed-split evaluation as stability diagnostics, not additional independent holdouts.",
    split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
    counts: { snapshots: rows.length, transitions: transitions(rows).length, discoveryTransitions: transitions(discoveryRows).length, holdoutTransitions: transitions(holdoutRows).length },
    structureDiagnostics: structure,
    totalGoldChangeCorrelations: totalGold,
    laneCsChangeEnvelope: laneCs,
    negativeControls: {
      jungleCs: { offsets: PROFILE.jungleCsOffsets, discovery: metrics(discoveryRows, "jungleCs", PROFILE.jungleCsOffsets), holdout: metrics(holdoutRows, "jungleCs", PROFILE.jungleCsOffsets) },
    },
    nonPromotionReason: "The post-hoc, non-unique totalGold byte-change correlations and lane-CS byte ranges reveal when their saved oracle values change, but neither direct packed values nor packed deltas decode a numeric state. The structural diagnostics only establish fixed payload form, active-count containment, exact mirrored bytes, and falsification of simple two-byte layouts. Jungle-CS remains an imperfect negative control. No numeric economy value, delta, event, record, field boundary, or runtime schema is available.",
  };
}

function assertFrozenDiscovery(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`Discovery freeze drifted: ${label}`, { expected, actual });
}

// This runs while only the seven Discovery fixtures are resident. It freezes
// every D7-selected structural/anchor result that the later H3 evaluation may
// consume; LORO remains a post-H3 stability diagnostic, not a selector.
function assertDiscoveryFreeze(discoveryRows) {
  const selectAnchorConfusion = (value) => ({ tp: value.tp, fp: value.fp, fn: value.fn, tn: value.tn, exactChangeAnchor: value.exactChangeAnchor });
  const structure = structureDiagnostics(discoveryRows, []);
  assertFrozenDiscovery("counts", { snapshots: discoveryRows.length, transitions: transitions(discoveryRows).length }, { snapshots: 2170, transitions: EXPECTED.counts.discoveryTransitions });
  assertFrozenDiscovery("structure payload form", structure.payloadForm.discovery, EXPECTED.structureDiagnostics.payloadForm.discovery);
  assertFrozenDiscovery("structure active offsets", {
    defaultByte: structure.activeOffsets.defaultByte,
    discoveryEverNonDefaultCount: structure.activeOffsets.discoveryEverNonDefaultCount,
    discoveryAlwaysDefaultCount: structure.activeOffsets.discoveryAlwaysDefaultCount,
  }, {
    defaultByte: EXPECTED.structureDiagnostics.activeOffsets.defaultByte,
    discoveryEverNonDefaultCount: EXPECTED.structureDiagnostics.activeOffsets.discoveryEverNonDefaultCount,
    discoveryAlwaysDefaultCount: EXPECTED.structureDiagnostics.activeOffsets.discoveryAlwaysDefaultCount,
  });
  assertFrozenDiscovery("structure mirror selection", structure.mirrorSelection, EXPECTED.structureDiagnostics.mirrorSelection);
  assertFrozenDiscovery("structure mirror ranges", structure.exactMirrorRanges.map((entry) => entry.discovery), EXPECTED.structureDiagnostics.exactMirrorRanges.map((entry) => entry.discovery));
  assertFrozenDiscovery("structure two-byte falsification", {
    observations: structure.simpleTwoByteCellFalsification.discovery.observations,
    valueThenDefault: structure.simpleTwoByteCellFalsification.discovery.valueThenDefault,
    defaultThenValue: structure.simpleTwoByteCellFalsification.discovery.defaultThenValue,
    adjacentMaskHeaderChecks: structure.simpleTwoByteCellFalsification.discovery.adjacentMaskHeaderChecks,
  }, EXPECTED.structureDiagnostics.simpleTwoByteCellFalsification.discovery);

  const totalGoldSearch = selectMinimumExactTotalGoldUnions(discoveryRows);
  assertFrozenDiscovery("totalGold post-hoc correlations", [
    { id: "post-hoc-109-119", offsets: PROFILE.totalGoldPostHocOffsets, discovery: metrics(discoveryRows, "totalGold", PROFILE.totalGoldPostHocOffsets) },
    { id: "prior-115-117-119", offsets: PROFILE.totalGoldPriorCorrelationOffsets, discovery: metrics(discoveryRows, "totalGold", PROFILE.totalGoldPriorCorrelationOffsets) },
  ], EXPECTED.totalGold.postHocCorrelations.map(({ id, offsets, discovery }) => ({ id, offsets, discovery })));
  assertFrozenDiscovery("totalGold bounded selector", {
    candidateOffsets: totalGoldSearch.candidateOffsets,
    maximumUnionSize: 3,
    minimumUnionSize: totalGoldSearch.minimumUnionSize,
    exactDiscoveryUnions: totalGoldSearch.exactDiscoveryUnions.map(({ offsets, metrics: discovery }) => ({ offsets, discovery })),
  }, {
    candidateOffsets: EXPECTED.totalGold.boundedDiscoverySearch.candidateOffsets,
    maximumUnionSize: EXPECTED.totalGold.boundedDiscoverySearch.maximumUnionSize,
    minimumUnionSize: EXPECTED.totalGold.boundedDiscoverySearch.minimumUnionSize,
    exactDiscoveryUnions: EXPECTED.totalGold.boundedDiscoverySearch.exactDiscoveryUnions.map(({ offsets, discovery }) => ({ offsets, discovery })),
  });

  const laneCsSearch = selectMinimumExactLaneCsUnions(discoveryRows);
  const selectedLaneCsOffsets = selectLaneCsOffsets(discoveryRows);
  assertFrozenDiscovery("lane-CS anchors", {
    discovery: metrics(discoveryRows, "laneCs", PROFILE.laneCsOffsets),
    p125AlternativeComponent: laneCsAlternativeComponentMetrics(discoveryRows),
    inertOffset128: inertOffsetChangedTransitionCount(discoveryRows, 128),
    discoverySelector: { selectedOffsets: selectedLaneCsOffsets, discovery: selectAnchorConfusion(metrics(discoveryRows, "laneCs", selectedLaneCsOffsets)) },
    boundedDiscoverySearch: {
      candidateOffsets: laneCsSearch.candidateOffsets,
      maximumUnionSize: 3,
      minimumUnionSize: laneCsSearch.minimumUnionSize,
      exactDiscoveryUnions: laneCsSearch.exactDiscoveryUnions.map(({ offsets, metrics: discovery }) => ({ offsets, discovery })),
    },
  }, {
    discovery: EXPECTED.laneCs.discovery,
    p125AlternativeComponent: EXPECTED.laneCs.p125AlternativeComponent.discovery,
    inertOffset128: EXPECTED.laneCs.inertOffset128.discoveryChangedTransitionCount,
    discoverySelector: { selectedOffsets: EXPECTED.laneCs.discoverySelector.selectedOffsets, discovery: EXPECTED.laneCs.discoverySelector.discovery },
    boundedDiscoverySearch: {
      candidateOffsets: EXPECTED.laneCs.boundedDiscoverySearch.candidateOffsets,
      maximumUnionSize: EXPECTED.laneCs.boundedDiscoverySearch.maximumUnionSize,
      minimumUnionSize: EXPECTED.laneCs.boundedDiscoverySearch.minimumUnionSize,
      exactDiscoveryUnions: EXPECTED.laneCs.boundedDiscoverySearch.exactDiscoveryUnions.map(({ offsets, discovery }) => ({ offsets, discovery })),
    },
  });
  assertFrozenDiscovery("jungle-CS negative control", metrics(discoveryRows, "jungleCs", PROFILE.jungleCsOffsets), EXPECTED.jungleCs.discovery);
}

function assertionShape(result) {
  const select = (value) => ({ tp: value.tp, fp: value.fp, fn: value.fn, tn: value.tn, directMatches: value.directMatches, directMisses: value.directMisses, deltaMatches: value.deltaMatches, deltaMisses: value.deltaMisses, exactChangeAnchor: value.exactChangeAnchor });
  const structure = result.structureDiagnostics;
  const selectPayloadForm = (value) => ({ payloadLength: value.payloadLength, snapshotCount: value.snapshotCount, exactPayloadCount: value.exactPayloadCount, nonConformingPayloadCount: value.nonConformingPayloadCount, exact: value.exact });
  const selectMirror = (value) => ({ id: value.id, left: value.left, right: value.right, length: value.length, snapshotCount: value.snapshotCount, exactSnapshotEqualityCount: value.exactSnapshotEqualityCount, equalDirtyBytePredicateCount: value.equalDirtyBytePredicateCount, totalDirtyBytePredicates: value.totalDirtyBytePredicates, exactDirtyBytePredicateEquality: value.exactDirtyBytePredicateEquality, canExtendLeft: value.canExtendLeft, canExtendRight: value.canExtendRight, maximalExactRange: value.maximalExactRange });
  const selectCell = (value) => ({
    observations: value.observations,
    valueThenDefault: value.valueThenDefault,
    defaultThenValue: value.defaultThenValue,
    adjacentMaskHeaderChecks: value.adjacentMaskHeaderChecks,
  });
  return {
    schema: result.schema,
    counts: result.counts,
    totalGold: {
      fieldBoundaryAvailable: result.totalGoldChangeCorrelations.fieldBoundaryAvailable,
      nonUnique: result.totalGoldChangeCorrelations.nonUnique,
      postHoc: result.totalGoldChangeCorrelations.postHoc,
      postHocCorrelations: result.totalGoldChangeCorrelations.postHocCorrelations.map((value) => ({ id: value.id, offsets: value.offsets, discovery: select(value.discovery), holdout: select(value.holdout) })),
      boundedDiscoverySearch: {
        candidateOffsets: result.totalGoldChangeCorrelations.boundedDiscoverySearch.candidateOffsets,
        maximumUnionSize: result.totalGoldChangeCorrelations.boundedDiscoverySearch.maximumUnionSize,
        minimumUnionSize: result.totalGoldChangeCorrelations.boundedDiscoverySearch.minimumUnionSize,
        exactDiscoveryUnions: result.totalGoldChangeCorrelations.boundedDiscoverySearch.exactDiscoveryUnions.map((value) => ({ offsets: value.offsets, discovery: select(value.discovery), holdout: select(value.holdout) })),
      },
      allCorpusLoro: Object.fromEntries(Object.entries(result.totalGoldChangeCorrelations.allCorpusLoro).map(([id, value]) => [id, {
        minimumUnionSize: value.minimumUnionSize,
        exactTrainingUnions: value.exactTrainingUnions.map((entry) => ({ offsets: entry.offsets, heldout: { tp: entry.heldout.tp, fp: entry.heldout.fp, fn: entry.heldout.fn, tn: entry.heldout.tn, exactChangeAnchor: entry.heldout.exactChangeAnchor } })),
      }])),
    },
    laneCs: {
      discovery: select(result.laneCsChangeEnvelope.discovery),
      holdout: select(result.laneCsChangeEnvelope.holdout),
      p125AlternativeComponent: result.laneCsChangeEnvelope.p125AlternativeComponent,
      inertOffset128: result.laneCsChangeEnvelope.inertOffset128,
      discoverySelector: {
        selectedOffsets: result.laneCsChangeEnvelope.discoverySelector.selectedOffsets,
        discovery: { tp: result.laneCsChangeEnvelope.discoverySelector.discovery.tp, fp: result.laneCsChangeEnvelope.discoverySelector.discovery.fp, fn: result.laneCsChangeEnvelope.discoverySelector.discovery.fn, tn: result.laneCsChangeEnvelope.discoverySelector.discovery.tn, exactChangeAnchor: result.laneCsChangeEnvelope.discoverySelector.discovery.exactChangeAnchor },
        holdout: { tp: result.laneCsChangeEnvelope.discoverySelector.holdout.tp, fp: result.laneCsChangeEnvelope.discoverySelector.holdout.fp, fn: result.laneCsChangeEnvelope.discoverySelector.holdout.fn, tn: result.laneCsChangeEnvelope.discoverySelector.holdout.tn, exactChangeAnchor: result.laneCsChangeEnvelope.discoverySelector.holdout.exactChangeAnchor },
      },
      boundedDiscoverySearch: {
        candidateOffsets: result.laneCsChangeEnvelope.boundedDiscoverySearch.candidateOffsets,
        maximumUnionSize: result.laneCsChangeEnvelope.boundedDiscoverySearch.maximumUnionSize,
        minimumUnionSize: result.laneCsChangeEnvelope.boundedDiscoverySearch.minimumUnionSize,
        exactDiscoveryUnions: result.laneCsChangeEnvelope.boundedDiscoverySearch.exactDiscoveryUnions.map((value) => ({ offsets: value.offsets, discovery: select(value.discovery), holdout: select(value.holdout) })),
      },
      allCorpusLoro: Object.fromEntries(Object.entries(result.laneCsChangeEnvelope.allCorpusLoro).map(([id, value]) => [id, { selectedOffsets: value.selectedOffsets, heldout: { tp: value.heldout.tp, fp: value.heldout.fp, fn: value.heldout.fn, tn: value.heldout.tn, exactChangeAnchor: value.heldout.exactChangeAnchor } }])),
    },
    jungleCs: { discovery: select(result.negativeControls.jungleCs.discovery), holdout: select(result.negativeControls.jungleCs.holdout) },
    structureDiagnostics: {
      structuralOnly: structure.structuralOnly,
      semanticFieldAvailable: structure.semanticFieldAvailable,
      runtimeUse: structure.runtimeUse,
      payloadForm: { discovery: selectPayloadForm(structure.payloadForm.discovery), holdout: selectPayloadForm(structure.payloadForm.holdout) },
      activeOffsets: structure.activeOffsets,
      mirrorSelection: structure.mirrorSelection,
      exactMirrorRanges: structure.exactMirrorRanges.map((value) => ({ discovery: selectMirror(value.discovery), holdout: selectMirror(value.holdout) })),
      simpleTwoByteCellFalsification: { discovery: selectCell(structure.simpleTwoByteCellFalsification.discovery), holdout: selectCell(structure.simpleTwoByteCellFalsification.holdout) },
    },
  };
}

const args = parseArgs(process.argv);
const discoveryRows = collectRows(args, PROFILE.discovery);
assertDiscoveryFreeze(discoveryRows);
const holdoutRows = collectRows(args, PROFILE.holdout);
const result = evaluate([...discoveryRows, ...holdoutRows]);
const observed = assertionShape(result);
if (args.printObserved) { console.log(JSON.stringify(observed, null, 2)); process.exit(0); }
if (JSON.stringify(observed) !== JSON.stringify(EXPECTED)) fail("Keyframe economy research corpus drifted.", { expected: EXPECTED, observed });
const outputPath = path.resolve(args.outputPath);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ valid: true, schema: result.schema, snapshots: result.counts.snapshots, transitions: result.counts.transitions, totalGold: result.totalGoldChangeCorrelations, laneCsChangeEnvelope: result.laneCsChangeEnvelope, negativeControls: result.negativeControls }, null, 2));
