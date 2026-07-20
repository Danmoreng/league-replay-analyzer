#!/usr/bin/env node

// Bounded replay-only search for direct champion-position scalars in the three
// substantial exact one-per-champion/keyframe packet families. Saved Timeline
// positions are opened only after extraction as D7/H3 validation labels.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  packetTypes: Object.freeze([0x0081, 0x02eb, 0x047a]),
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
    outputPath: path.join("tmp", "keyframe-champion-positions-research-16.14.json"),
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
        "Usage: node scripts/research_keyframe_champion_positions_16_14.mjs " +
          "[--cli <path>] [--replay-dir <path>] [--api-root <path>] " +
          "[--decoder-profiles <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function fail(message, detail = null) {
  throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
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

function dumpFamilies(args, replayPath) {
  const result = spawnSync(
    args.cliPath,
    [
      "--dump-packet-types-json",
      replayPath,
      ...PROFILE.packetTypes.flatMap((packetType) => ["--packet-type", String(packetType)]),
      "--segment-type",
      "keyframe",
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) fail("Native keyframe-family dump failed.", result.stderr);
  const dump = JSON.parse(result.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    dump.packetTypeDumps?.length !== PROFILE.packetTypes.length
  ) {
    fail("Exact-build keyframe-family framing gate failed.", { replayPath });
  }
  return dump.packetTypeDumps;
}

function collectRows(args, replayIds, partition) {
  const rowsByFamily = new Map(PROFILE.packetTypes.map((packetType) => [packetType, []]));
  for (const replayId of replayIds) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    const timelinePath = path.resolve(
      args.apiRoot,
      replayId.replaceAll("-", "_"),
      "timeline.json",
    );
    if (!fs.existsSync(replayPath) || !fs.existsSync(timelinePath)) {
      fail("Fixed replay/Timeline fixture is missing.", { replayId });
    }
    const frames = readJson(timelinePath).info?.frames;
    if (!Array.isArray(frames) || frames.length < 2) fail("Timeline frame gate failed.", { replayId });
    for (const family of dumpFamilies(args, replayPath)) {
      if (family.truncated || family.emittedBlockCount !== family.matchingBlockCount) {
        fail("Complete family emission gate failed.", { replayId, packetType: family.packetType });
      }
      const ownersBySegment = new Map();
      for (const block of family.blocks ?? []) {
        const participantId = block.blockParam - PROFILE.championOwnerBase;
        const frame = frames[block.segmentId - 1];
        const participantFrame = frame?.participantFrames?.[participantId];
        if (
          block.channel !== 1 ||
          participantId < 1 ||
          participantId > 10 ||
          block.contentHexTruncated !== false ||
          !Number.isInteger(participantFrame?.position?.x) ||
          !Number.isInteger(participantFrame?.position?.y) ||
          Math.abs(frame.timestamp - block.timestampMillis) > 1
        ) {
          fail("Champion ownership/payload/position ordering gate failed.", {
            replayId,
            packetType: family.packetType,
            block,
          });
        }
        const owners = ownersBySegment.get(block.segmentId) ?? new Set();
        if (owners.has(participantId)) {
          fail("Duplicate family owner in one keyframe.", {
            replayId,
            packetType: family.packetType,
            segmentId: block.segmentId,
            participantId,
          });
        }
        owners.add(participantId);
        ownersBySegment.set(block.segmentId, owners);
        rowsByFamily.get(family.packetType).push({
          replayId,
          partition,
          segmentId: block.segmentId,
          participantId,
          x: participantFrame.position.x,
          y: participantFrame.position.y,
          payload: Buffer.from(block.contentHex, "hex"),
        });
      }
      if ([...ownersBySegment.values()].some((owners) => owners.size !== 10)) {
        fail("Family does not contain one block per champion/keyframe.", {
          replayId,
          packetType: family.packetType,
        });
      }
    }
  }
  for (const rows of rowsByFamily.values()) {
    rows.sort(
      (left, right) =>
        left.replayId.localeCompare(right.replayId) ||
        left.segmentId - right.segmentId ||
        left.participantId - right.participantId,
    );
    const previousByTrack = new Map();
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const key = `${row.replayId}:${row.participantId}`;
      row.previousIndex = previousByTrack.get(key) ?? -1;
      previousByTrack.set(key, index);
    }
  }
  return rowsByFamily;
}

function transformedByte(payload, offset, transform, cipher) {
  return transform === "cipherToPlain" ? cipher[payload[offset]] : payload[offset];
}

function decodeCandidate(row, candidate, cipher) {
  const bytes = Buffer.alloc(candidate.width);
  for (let index = 0; index < candidate.width; index += 1) {
    const source = candidate.endian === "LE" ? index : candidate.width - 1 - index;
    bytes[index] = transformedByte(
      row.payload,
      candidate.start + source * candidate.stride,
      candidate.transform,
      cipher,
    );
  }
  if (candidate.encoding === "Float32") return bytes.readFloatLE(0);
  return bytes.readInt16LE(0);
}

function newSums() {
  return { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 };
}

function add(sums, x, y) {
  sums.n += 1;
  sums.sx += x;
  sums.sy += y;
  sums.sxx += x * x;
  sums.syy += y * y;
  sums.sxy += x * y;
}

function summarizeSums(sums) {
  if (sums.n < 2) return { correlation: 0, affineRmse: null, slope: null, intercept: null };
  const centeredX = sums.sxx - (sums.sx * sums.sx) / sums.n;
  const centeredY = sums.syy - (sums.sy * sums.sy) / sums.n;
  const centeredXY = sums.sxy - (sums.sx * sums.sy) / sums.n;
  if (centeredX <= 0 || centeredY <= 0) {
    return { correlation: 0, affineRmse: null, slope: null, intercept: null };
  }
  const correlation = centeredXY / Math.sqrt(centeredX * centeredY);
  const slope = centeredXY / centeredX;
  const intercept = sums.sy / sums.n - slope * (sums.sx / sums.n);
  const residual = Math.max(0, centeredY - (centeredXY * centeredXY) / centeredX);
  return { correlation, affineRmse: Math.sqrt(residual / sums.n), slope, intercept };
}

function candidateMetrics(rows, candidate, cipher) {
  const x = newSums();
  const y = newSums();
  const dx = newSums();
  const dy = newSums();
  let finiteCount = 0;
  const values = new Float64Array(rows.length);
  values.fill(Number.NaN);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const value = decodeCandidate(row, candidate, cipher);
    if (Number.isFinite(value)) {
      values[index] = value;
      finiteCount += 1;
      add(x, value, row.x);
      add(y, value, row.y);
    }
  }
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.previousIndex < 0 || !Number.isFinite(values[index])) continue;
    const previousValue = values[row.previousIndex];
    if (!Number.isFinite(previousValue)) continue;
    const previous = rows[row.previousIndex];
    add(dx, values[index] - previousValue, row.x - previous.x);
    add(dy, values[index] - previousValue, row.y - previous.y);
  }
  return {
    sampleCount: rows.length,
    finiteCount,
    x: summarizeSums(x),
    y: summarizeSums(y),
    deltaX: summarizeSums(dx),
    deltaY: summarizeSums(dy),
  };
}

function axisScore(metrics, axis) {
  const direct = metrics[axis];
  const delta = metrics[axis === "x" ? "deltaX" : "deltaY"];
  if (metrics.finiteCount !== metrics.sampleCount || direct.affineRmse === null) return -1;
  return Math.max(Math.abs(delta.correlation), Math.abs(direct.correlation) * 0.5);
}

function retain(best, row, axis, limit = 48) {
  best.push(row);
  best.sort(
    (left, right) =>
      axisScore(right.discovery, axis) - axisScore(left.discovery, axis) ||
      (left.discovery[axis].affineRmse ?? Number.POSITIVE_INFINITY) -
        (right.discovery[axis].affineRmse ?? Number.POSITIVE_INFINITY),
  );
  if (best.length > limit) best.length = limit;
}

function search(discoveryByFamily, cipher) {
  const bestX = [];
  const bestY = [];
  for (const packetType of PROFILE.packetTypes) {
    const rows = discoveryByFamily.get(packetType);
    const minimumLength = Math.min(...rows.map((row) => row.payload.length));
    for (const transform of ["raw", "cipherToPlain"]) {
      for (const encoding of ["Int16", "Float32"]) {
        const width = encoding === "Int16" ? 2 : 4;
        for (const endian of ["LE", "BE"]) {
          for (let stride = 1; stride <= 8; stride += 1) {
            for (let start = 0; start + (width - 1) * stride < minimumLength; start += 1) {
              const candidate = { packetType, transform, encoding, width, endian, stride, start };
              const discovery = candidateMetrics(rows, candidate, cipher);
              const result = { candidate, discovery };
              retain(bestX, result, "x");
              retain(bestY, result, "y");
            }
          }
        }
      }
    }
  }
  const selected = new Map();
  for (const result of [...bestX, ...bestY]) {
    selected.set(JSON.stringify(result.candidate), result);
  }
  return [...selected.values()];
}

function compactCandidate(candidate) {
  return {
    ...candidate,
    packetType: `0x${candidate.packetType.toString(16).padStart(4, "0")}`,
  };
}

function hasLead(rows, axis) {
  return rows.some(({ discovery, holdout }) => {
    const discoveryDelta = Math.abs(discovery[axis === "x" ? "deltaX" : "deltaY"].correlation);
    const holdoutDelta = Math.abs(holdout[axis === "x" ? "deltaX" : "deltaY"].correlation);
    return (
      discovery.finiteCount === discovery.sampleCount &&
      holdout.finiteCount === holdout.sampleCount &&
      discoveryDelta >= 0.9 &&
      holdoutDelta >= 0.9 &&
      discovery[axis].affineRmse <= 500 &&
      holdout[axis].affineRmse <= 500
    );
  });
}

function bestAxisEvidence(rows, axis) {
  const deltaKey = axis === "x" ? "deltaX" : "deltaY";
  const bestDelta = [...rows].sort(
    (left, right) =>
      Math.abs(right.discovery[deltaKey].correlation) -
      Math.abs(left.discovery[deltaKey].correlation),
  )[0];
  const bestAffine = [...rows]
    .filter((row) => row.discovery[axis].affineRmse !== null)
    .sort((left, right) => left.discovery[axis].affineRmse - right.discovery[axis].affineRmse)[0];
  return {
    bestFirstDifference: bestDelta
      ? {
          candidate: bestDelta.candidate,
          discoveryCorrelation: bestDelta.discovery[deltaKey].correlation,
          holdoutCorrelation: bestDelta.holdout[deltaKey].correlation,
        }
      : null,
    bestAffine: bestAffine
      ? {
          candidate: bestAffine.candidate,
          discoveryRmse: bestAffine.discovery[axis].affineRmse,
          holdoutRmse: bestAffine.holdout[axis].affineRmse,
        }
      : null,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const cipher = loadCipher(args);
  const discoveryByFamily = collectRows(args, PROFILE.discovery, "D7");
  const selected = search(discoveryByFamily, cipher);
  const holdoutByFamily = collectRows(args, PROFILE.holdout, "H3");
  const candidates = selected.map(({ candidate, discovery }) => ({
    candidate: compactCandidate(candidate),
    discovery,
    holdout: candidateMetrics(holdoutByFamily.get(candidate.packetType), candidate, cipher),
  }));
  const xLead = hasLead(candidates, "x");
  const yLead = hasLead(candidates, "y");
  const output = {
    schema: "rofl-keyframe-champion-positions-research-16.14/v1",
    generatedAtUtc: new Date().toISOString(),
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayInput: {
      segmentType: "keyframe",
      channel: 1,
      championOwnerBase: `0x${PROFILE.championOwnerBase.toString(16)}`,
      packetTypes: PROFILE.packetTypes.map((value) =>
        `0x${value.toString(16).padStart(4, "0")}`),
    },
    offlineOracle: "Saved Riot Timeline participantFrames.position; D7 selection and H3 validation only.",
    candidateGrammar: {
      transforms: ["raw payload", "profile cipherToPlain"],
      encodings: ["signed Int16 LE/BE", "Float32 LE/BE"],
      strides: [1, 8],
      selection: "Top 48 candidates per axis selected on D7; only that union is evaluated on H3.",
      leadThreshold: "abs(first-difference correlation) >= 0.9 and affine RMSE <= 500 in both D7 and H3",
    },
    familyCounts: Object.fromEntries(
      PROFILE.packetTypes.map((packetType) => [
        `0x${packetType.toString(16).padStart(4, "0")}`,
        {
          discovery: discoveryByFamily.get(packetType).length,
          holdout: holdoutByFamily.get(packetType).length,
        },
      ]),
    ),
    directScalarLead: { x: xLead, y: yLead, completePair: xLead && yLead },
    bestEvidence: {
      x: bestAxisEvidence(candidates, "x"),
      y: bestAxisEvidence(candidates, "y"),
    },
    candidates: candidates
      .sort(
        (left, right) =>
          Math.max(axisScore(right.discovery, "x"), axisScore(right.discovery, "y")) -
          Math.max(axisScore(left.discovery, "x"), axisScore(left.discovery, "y")),
      )
      .slice(0, 64),
    conclusion:
      xLead && yLead
        ? "A D7-selected direct scalar pair survives H3; message grammar and independent promotion evidence are still required."
        : "No tested champion-owned keyframe Int16/Float32 scalar pair survives the D7/H3 position lead gate; position remains unavailable and requires component/message grammar rather than direct scalar labeling.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        schema: output.schema,
        familyCounts: output.familyCounts,
        directScalarLead: output.directScalarLead,
        bestEvidence: output.bestEvidence,
        topCandidates: output.candidates.slice(0, 8),
        conclusion: output.conclusion,
      },
      null,
      2,
    ),
  );
}

main();
