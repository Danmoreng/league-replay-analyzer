#!/usr/bin/env node

// Offline research only. Saved Timeline participant frames are labels and are
// never runtime decoder input. Candidate bytes always come from saved ROFLs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x02eb,
  payloadLength: 1479,
  championOwnerBase: 0x400000ad,
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

const EXPECTED = Object.freeze({
  discovery: Object.freeze({
    snapshotCount: 2170,
    spentFinite: 2170,
    spentIntegral: 2170,
    firstZero: 70,
    finalExact: 55,
    derivedCurrentExact: 967,
  }),
  holdout: Object.freeze({
    snapshotCount: 1030,
    spentFinite: 1030,
    spentIntegral: 1030,
    firstZero: 30,
    finalExact: 27,
    derivedCurrentExact: 354,
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
    outputPath: path.join("tmp", "keyframe-current-gold-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--decoder-profiles" && argv[index + 1]) {
      args.decoderProfilesPath = argv[++index];
    } else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/research_keyframe_current_gold_16_14.mjs [--cli <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
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

function loadCipher(args) {
  const registry = readJson(path.resolve(args.decoderProfilesPath));
  const selected = (registry.profiles ?? []).filter(
    (entry) =>
      entry.versionGroup === "16.14" &&
      (entry.acceptedGameVersions ?? []).includes(PROFILE.exactReplayBuild),
  );
  if (selected.length !== 1) fail("Canonical profile did not select one exact-build entry.");
  const cipher = selected[0].keyframeParticipantStats?.cipherToPlain;
  if (
    !Array.isArray(cipher) ||
    cipher.length !== 256 ||
    new Set(cipher).size !== 256 ||
    cipher.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    fail("Canonical profile cipher is not a complete byte permutation.");
  }
  return cipher;
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
  if (run.status !== 0) fail("Native packet dump failed.", { replayPath, stderr: run.stderr });
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.gameVersion !== PROFILE.exactReplayBuild
  ) {
    fail("Exact keyframe framing/version gate failed.", { replayPath, dump });
  }
  return dump.blocks ?? [];
}

function collectRows(args, replayIds) {
  const rows = [];
  for (const replayId of replayIds) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    const fixturePath = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
    const matchPath = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"), "match.json");
    if (!fs.existsSync(replayPath) || !fs.existsSync(fixturePath) || !fs.existsSync(matchPath)) {
      fail("Fixed replay/API fixture is missing.", {
        replayId,
        replayPath,
        fixturePath,
        matchPath,
      });
    }
    const frames = readJson(fixturePath).info?.frames;
    const match = readJson(matchPath);
    if (!Array.isArray(frames) || frames.length === 0) fail("Timeline fixture has no frames.");
    if (
      match.info?.gameVersion !== PROFILE.exactReplayBuild ||
      !Array.isArray(match.info?.participants) ||
      match.info.participants.length !== 10
    ) {
      fail("Match fixture version/participant gate failed.", { replayId });
    }
    const ownersBySegment = new Map();
    for (const block of dumpKeyframes(args, replayPath)) {
      const participantId = block.blockParam - PROFILE.championOwnerBase;
      const frame = frames[block.segmentId - 1];
      const participant = frame?.participantFrames?.[String(participantId)];
      if (
        !Number.isInteger(participantId) ||
        participantId < 1 ||
        participantId > 10 ||
        block.contentLength !== PROFILE.payloadLength ||
        block.contentHexTruncated !== false ||
        block.contentHexBytes !== PROFILE.payloadLength ||
        typeof block.contentHex !== "string" ||
        !Number.isInteger(participant?.currentGold)
      ) {
        fail("Snapshot owner/payload/offline-label gate failed.", { replayId, block });
      }
      const owners = ownersBySegment.get(block.segmentId) ?? new Set();
      if (owners.has(participantId)) fail("Duplicate champion snapshot in one keyframe.");
      owners.add(participantId);
      ownersBySegment.set(block.segmentId, owners);
      rows.push({
        replayId,
        participantId,
        segmentId: block.segmentId,
        currentGold: participant.currentGold,
        finalGoldSpent: match.info.participants[participantId - 1].goldSpent,
        payload: Buffer.from(block.contentHex, "hex"),
      });
    }
    if ([...ownersBySegment.values()].some((owners) => owners.size !== 10)) {
      fail("Keyframe owner-completeness gate failed.", { replayId });
    }
  }
  return rows;
}

function decodeFloat32(payload, offsets, cipher) {
  const bytes = Buffer.from(offsets.map((offset) => cipher[payload[offset]]));
  return bytes.readFloatLE(0);
}

function decodeUInt32(payload, offsets, cipher) {
  const bytes = Buffer.from(offsets.map((offset) => cipher[payload[offset]]));
  return bytes.readUInt32LE(0);
}

function candidateMetrics(rows, start, cipher) {
  const offsets = [start, start + 2, start + 4, start + 6];
  let finite = 0;
  let exact = 0;
  let truncated = 0;
  let rounded = 0;
  let nonnegative = 0;
  let absoluteError = 0;
  let maximumAbsoluteError = 0;
  const values = [];
  for (const row of rows) {
    const value = decodeFloat32(row.payload, offsets, cipher);
    if (!Number.isFinite(value)) continue;
    finite += 1;
    if (value >= 0) nonnegative += 1;
    if (value === row.currentGold) exact += 1;
    if (Math.trunc(value) === row.currentGold) truncated += 1;
    if (Math.round(value) === row.currentGold) rounded += 1;
    const error = Math.abs(value - row.currentGold);
    absoluteError += error;
    maximumAbsoluteError = Math.max(maximumAbsoluteError, error);
    if (values.length < 5) values.push({ value, expected: row.currentGold });
  }
  return {
    start,
    offsets,
    snapshotCount: rows.length,
    finite,
    nonnegative,
    exact,
    truncated,
    rounded,
    meanAbsoluteError: finite ? absoluteError / finite : null,
    maximumAbsoluteError: finite ? maximumAbsoluteError : null,
    samples: values,
  };
}

function compareCandidates(left, right) {
  return (
    right.truncated - left.truncated ||
    right.exact - left.exact ||
    right.rounded - left.rounded ||
    right.finite - left.finite ||
    right.nonnegative - left.nonnegative ||
    (left.meanAbsoluteError ?? Number.POSITIVE_INFINITY) -
      (right.meanAbsoluteError ?? Number.POSITIVE_INFINITY) ||
    left.start - right.start
  );
}

function expectedBytes(value, encoding) {
  const bytes = Buffer.alloc(4);
  if (encoding === "Float32LE") bytes.writeFloatLE(value, 0);
  else bytes.writeUInt32LE(value, 0);
  return bytes;
}

function rankIndependentByteLanes(rows, cipher, encoding) {
  return Array.from({ length: 4 }, (_, byteIndex) => {
    const offsets = Array.from({ length: PROFILE.payloadLength }, (_, offset) => {
      let matches = 0;
      for (const row of rows) {
        if (cipher[row.payload[offset]] === expectedBytes(row.currentGold, encoding)[byteIndex]) {
          matches += 1;
        }
      }
      return { offset, matches };
    }).sort((left, right) => right.matches - left.matches || left.offset - right.offset);
    return {
      byteIndex,
      bestMatchCount: offsets[0].matches,
      exactOffsetCount: offsets.filter((candidate) => candidate.matches === rows.length).length,
      topOffsets: offsets.slice(0, 12),
    };
  });
}

function decodeIndependent(payload, offsets, cipher, encoding) {
  const bytes = Buffer.from(offsets.map((offset) => cipher[payload[offset]]));
  return encoding === "Float32LE" ? bytes.readFloatLE(0) : bytes.readUInt32LE(0);
}

function independentFieldMetrics(rows, offsets, cipher, encoding) {
  let finite = 0;
  let nonnegative = 0;
  let exact = 0;
  let truncated = 0;
  let absoluteError = 0;
  for (const row of rows) {
    const value = decodeIndependent(row.payload, offsets, cipher, encoding);
    if (!Number.isFinite(value)) continue;
    finite += 1;
    if (value >= 0) nonnegative += 1;
    if (value === row.currentGold) exact += 1;
    if (Math.trunc(value) === row.currentGold) truncated += 1;
    absoluteError += Math.abs(value - row.currentGold);
  }
  return {
    offsets,
    snapshotCount: rows.length,
    finite,
    nonnegative,
    exact,
    truncated,
    meanAbsoluteError: finite ? absoluteError / finite : null,
  };
}

function derivedCurrentGoldMetrics(rows, spentStart, cipher) {
  const totalGoldOffsets = [115, 117, 119, 121];
  const spentGoldOffsets = [spentStart, spentStart + 2, spentStart + 4, spentStart + 6];
  let finite = 0;
  let nonnegativeInputs = 0;
  let exact = 0;
  let truncatedDifference = 0;
  let differenceOfTruncations = 0;
  let roundedDifference = 0;
  let absoluteError = 0;
  const differences = [];
  for (const row of rows) {
    const totalGold = decodeFloat32(row.payload, totalGoldOffsets, cipher);
    const spentGold = decodeFloat32(row.payload, spentGoldOffsets, cipher);
    const currentGold = totalGold - spentGold;
    if (!Number.isFinite(totalGold) || !Number.isFinite(spentGold)) continue;
    finite += 1;
    if (totalGold >= 0 && spentGold >= 0 && currentGold >= 0) nonnegativeInputs += 1;
    if (currentGold === row.currentGold) exact += 1;
    if (Math.trunc(currentGold) === row.currentGold) truncatedDifference += 1;
    if (Math.trunc(totalGold) - Math.trunc(spentGold) === row.currentGold) {
      differenceOfTruncations += 1;
    }
    if (Math.round(currentGold) === row.currentGold) roundedDifference += 1;
    absoluteError += Math.abs(currentGold - row.currentGold);
    if (Math.trunc(currentGold) !== row.currentGold && differences.length < 12) {
      differences.push({
        replayId: row.replayId,
        participantId: row.participantId,
        segmentId: row.segmentId,
        expectedCurrentGold: row.currentGold,
        totalGold,
        spentGold,
        decodedCurrentGold: currentGold,
      });
    }
  }
  return {
    spentStart,
    totalGoldOffsets,
    spentGoldOffsets,
    snapshotCount: rows.length,
    finite,
    nonnegativeInputs,
    exact,
    truncatedDifference,
    differenceOfTruncations,
    roundedDifference,
    meanAbsoluteError: finite ? absoluteError / finite : null,
    differences,
  };
}

function compareDerivedCandidates(left, right) {
  return (
    right.truncatedDifference - left.truncatedDifference ||
    right.differenceOfTruncations - left.differenceOfTruncations ||
    right.exact - left.exact ||
    right.nonnegativeInputs - left.nonnegativeInputs ||
    (left.meanAbsoluteError ?? Number.POSITIVE_INFINITY) -
      (right.meanAbsoluteError ?? Number.POSITIVE_INFINITY) ||
    left.spentStart - right.spentStart
  );
}

function correctedCurrentGoldMetrics(rows, correctionStart, sign, cipher) {
  const totalGoldOffsets = [115, 117, 119, 121];
  const spentGoldOffsets = [107, 109, 111, 113];
  const correctionOffsets = [
    correctionStart,
    correctionStart + 2,
    correctionStart + 4,
    correctionStart + 6,
  ];
  let finite = 0;
  let nonnegative = 0;
  let exact = 0;
  let truncated = 0;
  let absoluteError = 0;
  for (const row of rows) {
    const totalGold = decodeFloat32(row.payload, totalGoldOffsets, cipher);
    const spentGold = decodeFloat32(row.payload, spentGoldOffsets, cipher);
    const correction = decodeFloat32(row.payload, correctionOffsets, cipher);
    const currentGold = totalGold - spentGold + sign * correction;
    if (!Number.isFinite(currentGold)) continue;
    finite += 1;
    if (currentGold >= 0) nonnegative += 1;
    if (currentGold === row.currentGold) exact += 1;
    if (Math.trunc(currentGold) === row.currentGold) truncated += 1;
    absoluteError += Math.abs(currentGold - row.currentGold);
  }
  return {
    correctionStart,
    correctionOffsets,
    sign,
    snapshotCount: rows.length,
    finite,
    nonnegative,
    exact,
    truncated,
    meanAbsoluteError: finite ? absoluteError / finite : null,
  };
}

function compareCorrectedCandidates(left, right) {
  return (
    right.truncated - left.truncated ||
    right.exact - left.exact ||
    right.nonnegative - left.nonnegative ||
    (left.meanAbsoluteError ?? Number.POSITIVE_INFINITY) -
      (right.meanAbsoluteError ?? Number.POSITIVE_INFINITY) ||
    left.correctionStart - right.correctionStart ||
    right.sign - left.sign
  );
}

function integerCorrectedCurrentGoldMetrics(rows, correctionStart, sign, cipher) {
  const totalGoldOffsets = [115, 117, 119, 121];
  const spentGoldOffsets = [107, 109, 111, 113];
  const correctionOffsets = [
    correctionStart,
    correctionStart + 2,
    correctionStart + 4,
    correctionStart + 6,
  ];
  let exact = 0;
  let boundedCorrection = 0;
  let absoluteError = 0;
  const differences = [];
  for (const row of rows) {
    const totalGold = decodeFloat32(row.payload, totalGoldOffsets, cipher);
    const spentGold = decodeFloat32(row.payload, spentGoldOffsets, cipher);
    const correction = decodeUInt32(row.payload, correctionOffsets, cipher);
    const currentGold = Math.trunc(totalGold) - Math.trunc(spentGold) + sign * correction;
    if (correction <= 100000) boundedCorrection += 1;
    if (currentGold === row.currentGold) exact += 1;
    absoluteError += Math.abs(currentGold - row.currentGold);
    if (currentGold !== row.currentGold && differences.length < 8) {
      differences.push({
        replayId: row.replayId,
        participantId: row.participantId,
        segmentId: row.segmentId,
        expectedCurrentGold: row.currentGold,
        totalGold,
        spentGold,
        correction,
        decodedCurrentGold: currentGold,
      });
    }
  }
  return {
    correctionStart,
    correctionOffsets,
    sign,
    snapshotCount: rows.length,
    exact,
    boundedCorrection,
    meanAbsoluteError: rows.length ? absoluteError / rows.length : null,
    differences,
  };
}

function compareIntegerCorrectedCandidates(left, right) {
  return (
    right.exact - left.exact ||
    right.boundedCorrection - left.boundedCorrection ||
    (left.meanAbsoluteError ?? Number.POSITIVE_INFINITY) -
      (right.meanAbsoluteError ?? Number.POSITIVE_INFINITY) ||
    left.correctionStart - right.correctionStart ||
    right.sign - left.sign
  );
}

function goldSpentLaneMetrics(rows, cipher) {
  const offsets = [107, 109, 111, 113];
  const tracks = new Map();
  for (const row of rows) {
    const key = `${row.replayId}:${row.participantId}`;
    const track = tracks.get(key) ?? [];
    track.push(row);
    tracks.set(key, track);
  }
  let finite = 0;
  let nonnegative = 0;
  let integral = 0;
  let firstZero = 0;
  let finalExact = 0;
  let finalTruncated = 0;
  let increasingTransitions = 0;
  let decreasingTransitions = 0;
  let unchangedTransitions = 0;
  const finalDifferences = [];
  for (const track of tracks.values()) {
    track.sort((left, right) => left.segmentId - right.segmentId);
    const values = track.map((row) => decodeFloat32(row.payload, offsets, cipher));
    for (const value of values) {
      if (Number.isFinite(value)) finite += 1;
      if (value >= 0) nonnegative += 1;
      if (Number.isInteger(value)) integral += 1;
    }
    if (values[0] === 0) firstZero += 1;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index] > values[index - 1]) increasingTransitions += 1;
      else if (values[index] < values[index - 1]) decreasingTransitions += 1;
      else unchangedTransitions += 1;
    }
    const finalValue = values.at(-1);
    const expected = track.at(-1).finalGoldSpent;
    if (finalValue === expected) finalExact += 1;
    if (Math.trunc(finalValue) === expected) finalTruncated += 1;
    if (Math.trunc(finalValue) !== expected) {
      finalDifferences.push({
        replayId: track.at(-1).replayId,
        participantId: track.at(-1).participantId,
        segmentId: track.at(-1).segmentId,
        decodedGoldSpent: finalValue,
        expectedFinalGoldSpent: expected,
      });
    }
  }
  return {
    offsets,
    snapshotCount: rows.length,
    trackCount: tracks.size,
    finite,
    nonnegative,
    integral,
    firstZero,
    finalExact,
    finalTruncated,
    increasingTransitions,
    decreasingTransitions,
    unchangedTransitions,
    finalDifferences,
  };
}

const args = parseArgs(process.argv);
const cipher = loadCipher(args);
const discoveryRows = collectRows(args, PROFILE.discovery);
const discoveryRanking = Array.from({ length: PROFILE.payloadLength - 6 }, (_, start) =>
  candidateMetrics(discoveryRows, start, cipher),
).sort(compareCandidates);
const frozenStarts = discoveryRanking.slice(0, 20).map((candidate) => candidate.start);
const holdoutRows = collectRows(args, PROFILE.holdout);
const holdoutByStart = new Map(
  frozenStarts.map((start) => [start, candidateMetrics(holdoutRows, start, cipher)]),
);
const candidates = discoveryRanking.slice(0, 20).map((discovery) => ({
  start: discovery.start,
  offsets: discovery.offsets,
  discovery,
  holdout: holdoutByStart.get(discovery.start),
}));
const winner = candidates[0];
const interleavedPromotionGate =
  winner.discovery.truncated === discoveryRows.length &&
  winner.holdout.truncated === holdoutRows.length &&
  winner.discovery.finite === discoveryRows.length &&
  winner.holdout.finite === holdoutRows.length &&
  winner.discovery.nonnegative === discoveryRows.length &&
  winner.holdout.nonnegative === holdoutRows.length;
const independentByteLanes = Object.fromEntries(
  ["Float32LE", "UInt32LE"].map((encoding) => {
    const discovery = rankIndependentByteLanes(discoveryRows, cipher, encoding);
    const selectedOffsets = discovery.map((lane) => lane.topOffsets[0].offset);
    return [
      encoding,
      {
        selection: "best offset for each expected numeric byte on Discovery only",
        discoveryByteLanes: discovery,
        selectedOffsets,
        discovery: independentFieldMetrics(discoveryRows, selectedOffsets, cipher, encoding),
        holdout: independentFieldMetrics(holdoutRows, selectedOffsets, cipher, encoding),
      },
    ];
  }),
);
const independentPromotionGate = Object.values(independentByteLanes).some(
  (candidate) =>
    candidate.discovery.truncated === discoveryRows.length &&
    candidate.holdout.truncated === holdoutRows.length &&
    candidate.discovery.finite === discoveryRows.length &&
    candidate.holdout.finite === holdoutRows.length &&
    candidate.discovery.nonnegative === discoveryRows.length &&
    candidate.holdout.nonnegative === holdoutRows.length,
);
const derivedDiscoveryRanking = Array.from({ length: PROFILE.payloadLength - 6 }, (_, start) =>
  derivedCurrentGoldMetrics(discoveryRows, start, cipher),
).sort(compareDerivedCandidates);
const derivedCandidates = derivedDiscoveryRanking.slice(0, 20).map((discovery) => ({
  spentStart: discovery.spentStart,
  discovery,
  holdout: derivedCurrentGoldMetrics(holdoutRows, discovery.spentStart, cipher),
}));
const derivedWinner = derivedCandidates[0];
const derivedPromotionGate =
  derivedWinner.discovery.truncatedDifference === discoveryRows.length &&
  derivedWinner.holdout.truncatedDifference === holdoutRows.length &&
  derivedWinner.discovery.finite === discoveryRows.length &&
  derivedWinner.holdout.finite === holdoutRows.length &&
  derivedWinner.discovery.nonnegativeInputs === discoveryRows.length &&
  derivedWinner.holdout.nonnegativeInputs === holdoutRows.length;
const correctionDiscoveryRanking = Array.from({ length: PROFILE.payloadLength - 6 }, (_, start) =>
  [1, -1].map((sign) => correctedCurrentGoldMetrics(discoveryRows, start, sign, cipher)),
)
  .flat()
  .sort(compareCorrectedCandidates);
const correctionCandidates = correctionDiscoveryRanking.slice(0, 20).map((discovery) => ({
  correctionStart: discovery.correctionStart,
  sign: discovery.sign,
  discovery,
  holdout: correctedCurrentGoldMetrics(
    holdoutRows,
    discovery.correctionStart,
    discovery.sign,
    cipher,
  ),
}));
const correctionWinner = correctionCandidates[0];
const correctionPromotionGate =
  correctionWinner.discovery.truncated === discoveryRows.length &&
  correctionWinner.holdout.truncated === holdoutRows.length &&
  correctionWinner.discovery.finite === discoveryRows.length &&
  correctionWinner.holdout.finite === holdoutRows.length &&
  correctionWinner.discovery.nonnegative === discoveryRows.length &&
  correctionWinner.holdout.nonnegative === holdoutRows.length;
const integerCorrectionDiscoveryRanking = Array.from(
  { length: PROFILE.payloadLength - 6 },
  (_, start) =>
    [1, -1].map((sign) => integerCorrectedCurrentGoldMetrics(discoveryRows, start, sign, cipher)),
)
  .flat()
  .sort(compareIntegerCorrectedCandidates);
const integerCorrectionCandidates = integerCorrectionDiscoveryRanking
  .slice(0, 20)
  .map((discovery) => ({
    correctionStart: discovery.correctionStart,
    sign: discovery.sign,
    discovery,
    holdout: integerCorrectedCurrentGoldMetrics(
      holdoutRows,
      discovery.correctionStart,
      discovery.sign,
      cipher,
    ),
  }));
const integerCorrectionWinner = integerCorrectionCandidates[0];
const integerCorrectionPromotionGate =
  integerCorrectionWinner.discovery.exact === discoveryRows.length &&
  integerCorrectionWinner.holdout.exact === holdoutRows.length &&
  integerCorrectionWinner.discovery.boundedCorrection === discoveryRows.length &&
  integerCorrectionWinner.holdout.boundedCorrection === holdoutRows.length;
const promotionGate =
  interleavedPromotionGate ||
  independentPromotionGate ||
  derivedPromotionGate ||
  correctionPromotionGate ||
  integerCorrectionPromotionGate;
const goldSpentLane = {
  semanticCandidate: "cumulative goldSpent",
  runtimeAvailable: false,
  discovery: goldSpentLaneMetrics(discoveryRows, cipher),
  holdout: goldSpentLaneMetrics(holdoutRows, cipher),
};
const frozenMetrics = {
  discovery: {
    snapshotCount: discoveryRows.length,
    spentFinite: goldSpentLane.discovery.finite,
    spentIntegral: goldSpentLane.discovery.integral,
    firstZero: goldSpentLane.discovery.firstZero,
    finalExact: goldSpentLane.discovery.finalExact,
    derivedCurrentExact: derivedWinner.discovery.truncatedDifference,
  },
  holdout: {
    snapshotCount: holdoutRows.length,
    spentFinite: goldSpentLane.holdout.finite,
    spentIntegral: goldSpentLane.holdout.integral,
    firstZero: goldSpentLane.holdout.firstZero,
    finalExact: goldSpentLane.holdout.finalExact,
    derivedCurrentExact: derivedWinner.holdout.truncatedDifference,
  },
};
if (promotionGate || JSON.stringify(frozenMetrics) !== JSON.stringify(EXPECTED)) {
  fail("Frozen current-gold research metrics drifted.", {
    expected: EXPECTED,
    actual: frozenMetrics,
    promotionGate,
  });
}
const result = {
  schema: "rofl-keyframe-current-gold-research/v1",
  researchOnly: true,
  promotionGate,
  runtimeInput: false,
  offlineOracle: "Saved Riot Timeline participantFrames.currentGold; validation only",
  replayInput: "Saved ROFL keyframe 0x02EB payload bytes",
  split: { discovery: PROFILE.discovery, holdout: PROFILE.holdout },
  candidateGrammar: {
    byteTransform: "canonical profile cipherToPlain[payload[offset]]",
    interleaved: {
      value: "Float32LE",
      offsets: "[start,start+2,start+4,start+6]",
      searchStartRange: [0, PROFILE.payloadLength - 7],
      selection: "top 20 ranked on Discovery only; Holdout opened afterwards",
    },
    independentByteLanes: {
      values: ["Float32LE", "UInt32LE"],
      offsets: "one independently selected payload offset per expected numeric byte",
      selection: "best per-byte offsets ranked on Discovery only; Holdout opened afterwards",
    },
    derivedFromTotalGold: {
      value: "decodedTotalGold - candidate interleaved Float32LE cumulativeGoldSpent",
      totalGoldOffsets: [115, 117, 119, 121],
      candidateOffsets: "[start,start+2,start+4,start+6]",
      searchStartRange: [0, PROFILE.payloadLength - 7],
      selection: "top 20 ranked on Discovery only; Holdout opened afterwards",
    },
    correctedDerivedCurrentGold: {
      value:
        "decodedTotalGold - decoded[107,109,111,113] + sign * candidate interleaved Float32LE correction",
      candidateOffsets: "[start,start+2,start+4,start+6]",
      signs: [1, -1],
      searchStartRange: [0, PROFILE.payloadLength - 7],
      selection: "top 20 ranked on Discovery only; Holdout opened afterwards",
    },
    integerCorrectedDerivedCurrentGold: {
      value:
        "trunc(decodedTotalGold) - trunc(decoded[107,109,111,113]) + sign * candidate interleaved UInt32LE correction",
      candidateOffsets: "[start,start+2,start+4,start+6]",
      signs: [1, -1],
      searchStartRange: [0, PROFILE.payloadLength - 7],
      selection: "top 20 ranked on Discovery only; Holdout opened afterwards",
    },
  },
  counts: { discoverySnapshots: discoveryRows.length, holdoutSnapshots: holdoutRows.length },
  interleavedFloat32Candidates: candidates,
  independentByteLanes,
  derivedCurrentGoldCandidates: derivedCandidates,
  correctedCurrentGoldCandidates: correctionCandidates,
  integerCorrectedCurrentGoldCandidates: integerCorrectionCandidates,
  goldSpentLane,
  frozenMetrics,
  conclusion: promotionGate
    ? "One Discovery-selected replay-byte grammar reproduces every current-gold label in Discovery and Holdout."
    : "No Discovery-selected interleaved or independent-byte numeric lane reproduces every current-gold label in both splits.",
};
const outputPath = path.resolve(args.outputPath);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      schema: result.schema,
      promotionGate,
      counts: result.counts,
      topInterleavedCandidates: candidates
        .slice(0, 5)
        .map(({ start, offsets, discovery, holdout }) => ({
          start,
          offsets,
          discovery: {
            exact: discovery.exact,
            truncated: discovery.truncated,
            finite: discovery.finite,
            nonnegative: discovery.nonnegative,
            meanAbsoluteError: discovery.meanAbsoluteError,
          },
          holdout: {
            exact: holdout.exact,
            truncated: holdout.truncated,
            finite: holdout.finite,
            nonnegative: holdout.nonnegative,
            meanAbsoluteError: holdout.meanAbsoluteError,
          },
        })),
      independentByteLanes,
      goldSpentLane,
      topDerivedCandidates: derivedCandidates
        .slice(0, 5)
        .map(({ spentStart, discovery, holdout }) => ({
          spentStart,
          spentGoldOffsets: discovery.spentGoldOffsets,
          discovery: {
            exact: discovery.exact,
            truncatedDifference: discovery.truncatedDifference,
            differenceOfTruncations: discovery.differenceOfTruncations,
            finite: discovery.finite,
            nonnegativeInputs: discovery.nonnegativeInputs,
            meanAbsoluteError: discovery.meanAbsoluteError,
            differences: discovery.differences,
          },
          holdout: {
            exact: holdout.exact,
            truncatedDifference: holdout.truncatedDifference,
            differenceOfTruncations: holdout.differenceOfTruncations,
            finite: holdout.finite,
            nonnegativeInputs: holdout.nonnegativeInputs,
            meanAbsoluteError: holdout.meanAbsoluteError,
            differences: holdout.differences,
          },
        })),
      topCorrectionCandidates: correctionCandidates
        .slice(0, 5)
        .map(({ correctionStart, sign, discovery, holdout }) => ({
          correctionStart,
          correctionOffsets: discovery.correctionOffsets,
          sign,
          discovery: {
            exact: discovery.exact,
            truncated: discovery.truncated,
            finite: discovery.finite,
            nonnegative: discovery.nonnegative,
            meanAbsoluteError: discovery.meanAbsoluteError,
          },
          holdout: {
            exact: holdout.exact,
            truncated: holdout.truncated,
            finite: holdout.finite,
            nonnegative: holdout.nonnegative,
            meanAbsoluteError: holdout.meanAbsoluteError,
          },
        })),
    },
    null,
    2,
  ),
);
