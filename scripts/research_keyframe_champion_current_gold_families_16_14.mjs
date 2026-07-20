#!/usr/bin/env node

// Offline research only. Saved Timeline currentGold values are validation
// labels and are never runtime decoder input. Candidate bytes always come
// from exact-framed, champion-owned keyframe packets in saved ROFL files.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  packetTypes: Object.freeze([0x0081, 0x0151, 0x0196, 0x0233, 0x02eb, 0x038d, 0x0452, 0x047a]),
  separatelyMaintainedPacketType: 0x02eb,
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

const EXPECTED_FAMILY_METRICS = Object.freeze({
  discovery: Object.freeze({
    "0x0081": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 79,
      maximumContentLength: 160,
    }),
    "0x0151": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 1,
      maximumContentLength: 1,
    }),
    "0x0196": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 1,
      maximumContentLength: 1,
    }),
    "0x0233": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 1,
      maximumContentLength: 14,
    }),
    "0x02eb": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 1479,
      maximumContentLength: 1479,
    }),
    "0x038d": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 1,
      maximumContentLength: 1,
    }),
    "0x0452": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 3,
      maximumContentLength: 3,
    }),
    "0x047a": Object.freeze({
      rowCount: 2170,
      trackCount: 70,
      minimumContentLength: 64,
      maximumContentLength: 93,
    }),
  }),
  holdout: Object.freeze({
    "0x0081": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 79,
      maximumContentLength: 167,
    }),
    "0x0151": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 1,
      maximumContentLength: 1,
    }),
    "0x0196": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 1,
      maximumContentLength: 1,
    }),
    "0x0233": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 1,
      maximumContentLength: 14,
    }),
    "0x02eb": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 1479,
      maximumContentLength: 1479,
    }),
    "0x038d": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 1,
      maximumContentLength: 152,
    }),
    "0x0452": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 3,
      maximumContentLength: 3,
    }),
    "0x047a": Object.freeze({
      rowCount: 1030,
      trackCount: 30,
      minimumContentLength: 68,
      maximumContentLength: 91,
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
    outputPath: path.join("tmp", "keyframe-champion-current-gold-families-research-16.14.json"),
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
        "Usage: node scripts/research_keyframe_champion_current_gold_families_16_14.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--decoder-profiles <path>] [--output <path>]",
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
  const commandArgs = [
    "--dump-packet-types-json",
    replayPath,
    ...PROFILE.packetTypes.flatMap((packetType) => ["--packet-type", String(packetType)]),
    "--segment-type",
    "keyframe",
    "--max-blocks",
    "0",
  ];
  const run = spawnSync(args.cliPath, commandArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    fail("Native multi-family keyframe dump failed.", { replayPath, stderr: run.stderr });
  }
  const dump = JSON.parse(run.stdout);
  if (
    !dump.valid ||
    dump.errors?.length ||
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    dump.packetTypeDumps?.length !== PROFILE.packetTypes.length
  ) {
    fail("Exact-build multi-family framing gate failed.", { replayPath });
  }
  return dump.packetTypeDumps;
}

function collectRows(args, replayIds, partition) {
  const rows = [];
  for (const replayId of replayIds) {
    const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
    const fixtureRoot = path.resolve(args.apiRoot, replayId.replaceAll("-", "_"));
    const timelinePath = path.join(fixtureRoot, "timeline.json");
    const matchPath = path.join(fixtureRoot, "match.json");
    if (![replayPath, timelinePath, matchPath].every(fs.existsSync)) {
      fail("Fixed replay/API fixture is missing.", { replayId });
    }
    const frames = readJson(timelinePath).info?.frames;
    const match = readJson(matchPath);
    if (
      match.info?.gameVersion !== PROFILE.exactReplayBuild ||
      !Array.isArray(frames) ||
      frames.length === 0
    ) {
      fail("Exact-build fixture gate failed.", { replayId });
    }
    for (const family of dumpFamilies(args, replayPath)) {
      if (
        family.truncated ||
        family.emittedBlockCount !== family.matchingBlockCount ||
        !PROFILE.packetTypes.includes(family.packetType)
      ) {
        fail("Complete packet-family emission gate failed.", { replayId, family });
      }
      const ownersBySegment = new Map();
      for (const block of family.blocks ?? []) {
        const participantId = block.blockParam - PROFILE.championOwnerBase;
        const participantFrame =
          frames[block.segmentId - 1]?.participantFrames?.[String(participantId)];
        if (
          block.channel !== 1 ||
          !Number.isInteger(participantId) ||
          participantId < 1 ||
          participantId > 10 ||
          block.contentHexTruncated !== false ||
          block.contentHexBytes !== block.contentLength ||
          typeof block.contentHex !== "string" ||
          !Number.isInteger(participantFrame?.currentGold)
        ) {
          fail("Champion owner/payload/current-gold oracle gate failed.", {
            replayId,
            packetType: family.packetType,
            block,
          });
        }
        const owners = ownersBySegment.get(block.segmentId) ?? new Set();
        if (owners.has(participantId)) {
          fail("Duplicate champion family block in one keyframe.", {
            replayId,
            packetType: family.packetType,
            segmentId: block.segmentId,
            participantId,
          });
        }
        owners.add(participantId);
        ownersBySegment.set(block.segmentId, owners);
        rows.push({
          replayId,
          partition,
          packetType: family.packetType,
          participantId,
          segmentId: block.segmentId,
          currentGold: participantFrame.currentGold,
          payload: Buffer.from(block.contentHex, "hex"),
        });
      }
      if (
        Math.max(...ownersBySegment.keys()) !== ownersBySegment.size ||
        [...ownersBySegment.values()].some((owners) => owners.size !== 10)
      ) {
        fail("One champion family block per participant/keyframe gate failed.", {
          replayId,
          packetType: family.packetType,
          frameCount: frames.length,
          segmentCount: ownersBySegment.size,
        });
      }
    }
  }
  return rows;
}

function familyMetrics(rows) {
  return Object.fromEntries(
    PROFILE.packetTypes.map((packetType) => {
      const selected = rows.filter((row) => row.packetType === packetType);
      const lengths = selected.map((row) => row.payload.length);
      return [
        `0x${packetType.toString(16).padStart(4, "0")}`,
        {
          rowCount: selected.length,
          trackCount: new Set(selected.map((row) => `${row.replayId}:${row.participantId}`)).size,
          minimumContentLength: Math.min(...lengths),
          maximumContentLength: Math.max(...lengths),
        },
      ];
    }),
  );
}

function transformedByte(payload, offset, transform, cipher) {
  return transform === "cipherToPlain" ? cipher[payload[offset]] : payload[offset];
}

function decodeCandidate(row, candidate, cipher) {
  const bytes = Buffer.alloc(candidate.width);
  for (let index = 0; index < candidate.width; index += 1) {
    const sourceIndex = candidate.endian === "LE" ? index : candidate.width - 1 - index;
    bytes[index] = transformedByte(
      row.payload,
      candidate.start + sourceIndex * candidate.stride,
      candidate.transform,
      cipher,
    );
  }
  if (candidate.encoding === "Float32") return bytes.readFloatLE(0);
  return bytes.readUIntLE(0, candidate.width);
}

function candidateMetrics(rows, candidate, cipher) {
  let finite = 0;
  let nonnegative = 0;
  let exact = 0;
  let truncated = 0;
  let rounded = 0;
  let absoluteError = 0;
  for (const row of rows) {
    const value = decodeCandidate(row, candidate, cipher);
    if (!Number.isFinite(value)) continue;
    finite += 1;
    if (value >= 0) nonnegative += 1;
    if (value === row.currentGold) exact += 1;
    if (Math.trunc(value) === row.currentGold) truncated += 1;
    if (Math.round(value) === row.currentGold) rounded += 1;
    absoluteError += Math.abs(value - row.currentGold);
  }
  return {
    snapshotCount: rows.length,
    finite,
    nonnegative,
    exact,
    truncated,
    rounded,
    meanAbsoluteError: finite === 0 ? null : absoluteError / finite,
  };
}

function compareCandidates(left, right) {
  return (
    right.metrics.truncated - left.metrics.truncated ||
    right.metrics.exact - left.metrics.exact ||
    right.metrics.rounded - left.metrics.rounded ||
    right.metrics.finite - left.metrics.finite ||
    right.metrics.nonnegative - left.metrics.nonnegative ||
    (left.metrics.meanAbsoluteError ?? Number.POSITIVE_INFINITY) -
      (right.metrics.meanAbsoluteError ?? Number.POSITIVE_INFINITY) ||
    left.packetType - right.packetType ||
    left.start - right.start ||
    left.stride - right.stride
  );
}

function searchCandidates(rows, cipher) {
  const candidates = [];
  for (const packetType of PROFILE.packetTypes) {
    if (packetType === PROFILE.separatelyMaintainedPacketType) continue;
    const familyRows = rows.filter((row) => row.packetType === packetType);
    const minimumContentLength = Math.min(...familyRows.map((row) => row.payload.length));
    for (const transform of ["raw", "cipherToPlain"]) {
      for (const encoding of ["UInt", "Float32"]) {
        const width = encoding === "Float32" ? 4 : null;
        const widths = width === null ? [1, 2, 3, 4] : [width];
        for (const candidateWidth of widths) {
          for (const endian of candidateWidth === 1 ? ["LE"] : ["LE", "BE"]) {
            for (let stride = 1; stride <= 8; stride += 1) {
              for (
                let start = 0;
                start + (candidateWidth - 1) * stride < minimumContentLength;
                start += 1
              ) {
                const candidate = {
                  packetType,
                  transform,
                  encoding,
                  width: candidateWidth,
                  endian,
                  stride,
                  start,
                };
                candidates.push({
                  ...candidate,
                  metrics: candidateMetrics(familyRows, candidate, cipher),
                });
              }
            }
          }
        }
      }
    }
  }
  return candidates.sort(compareCandidates);
}

function compactCandidate(candidate) {
  return {
    packetType: `0x${candidate.packetType.toString(16).padStart(4, "0")}`,
    transform: candidate.transform,
    encoding: candidate.encoding,
    width: candidate.width,
    endian: candidate.endian,
    stride: candidate.stride,
    start: candidate.start,
    metrics: candidate.metrics,
  };
}

function main() {
  const args = parseArgs(process.argv);
  const cipher = loadCipher(args);
  const discoveryRows = collectRows(args, PROFILE.discovery, "D7");
  const discoveryFamilyMetrics = familyMetrics(discoveryRows);
  const discoveryRanking = searchCandidates(discoveryRows, cipher);
  const selected = discoveryRanking.slice(0, 64);
  const holdoutRows = collectRows(args, PROFILE.holdout, "H3");
  const holdoutFamilyMetrics = familyMetrics(holdoutRows);
  const familyGate = {
    discovery: discoveryFamilyMetrics,
    holdout: holdoutFamilyMetrics,
  };
  if (JSON.stringify(familyGate) !== JSON.stringify(EXPECTED_FAMILY_METRICS)) {
    fail("Frozen champion keyframe family metrics drifted.", {
      expected: EXPECTED_FAMILY_METRICS,
      actual: familyGate,
    });
  }
  const candidates = selected.map((discovery) => {
    const holdoutFamilyRows = holdoutRows.filter((row) => row.packetType === discovery.packetType);
    const candidate = {
      packetType: discovery.packetType,
      transform: discovery.transform,
      encoding: discovery.encoding,
      width: discovery.width,
      endian: discovery.endian,
      stride: discovery.stride,
      start: discovery.start,
    };
    return {
      candidate,
      discovery: discovery.metrics,
      holdout: candidateMetrics(holdoutFamilyRows, candidate, cipher),
    };
  });
  const promotionGate = candidates.some(
    ({ discovery, holdout }) =>
      discovery.finite === discovery.snapshotCount &&
      holdout.finite === holdout.snapshotCount &&
      discovery.nonnegative === discovery.snapshotCount &&
      holdout.nonnegative === holdout.snapshotCount &&
      discovery.truncated === discovery.snapshotCount &&
      holdout.truncated === holdout.snapshotCount,
  );
  if (promotionGate) {
    fail("A champion keyframe family current-gold candidate passed; review for promotion.", {
      candidate: candidates.find(
        ({ discovery, holdout }) =>
          discovery.finite === discovery.snapshotCount &&
          holdout.finite === holdout.snapshotCount &&
          discovery.nonnegative === discovery.snapshotCount &&
          holdout.nonnegative === holdout.snapshotCount &&
          discovery.truncated === discovery.snapshotCount &&
          holdout.truncated === holdout.snapshotCount,
      ),
    });
  }
  const output = {
    schema: "rofl-keyframe-champion-current-gold-families-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate,
    exactReplayBuild: PROFILE.exactReplayBuild,
    replayInput: {
      segmentType: "keyframe",
      channel: 1,
      championOwnerBase: `0x${PROFILE.championOwnerBase.toString(16)}`,
      packetTypes: PROFILE.packetTypes.map(
        (packetType) => `0x${packetType.toString(16).padStart(4, "0")}`,
      ),
    },
    offlineOracle: "Saved Riot Timeline participantFrames.currentGold; validation only",
    familyGate,
    candidateGrammar: {
      searchedPacketTypes: PROFILE.packetTypes
        .filter((packetType) => packetType !== PROFILE.separatelyMaintainedPacketType)
        .map((packetType) => `0x${packetType.toString(16).padStart(4, "0")}`),
      excludedPacketType:
        "0x02EB is exhaustively covered by research_keyframe_current_gold_16_14.mjs and is retained here only in the corrected cross-replay family-completeness gate.",
      transforms: ["raw payload byte", "profile cipherToPlain[payload byte]"],
      encodings: ["UIntLE/BE widths 1..4", "Float32LE/BE"],
      strides: [1, 8],
      selection: "Top 64 candidates selected on D7 only; H3 opened afterwards.",
    },
    candidates: candidates.map(({ candidate, discovery, holdout }) => ({
      ...compactCandidate({ ...candidate, metrics: discovery }),
      discovery,
      holdout,
    })),
    conclusion: promotionGate
      ? "A D7-selected champion-owned keyframe family scalar reproduces all current-gold labels in D7 and H3."
      : "No tested scalar in the remaining exact one-per-champion keyframe families reproduces current gold; current gold remains unavailable.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        schema: output.schema,
        promotionGate,
        familyGate,
        topCandidates: output.candidates.slice(0, 12),
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${outputPath}`);
}

main();
