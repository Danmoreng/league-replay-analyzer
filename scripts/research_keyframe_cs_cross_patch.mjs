#!/usr/bin/env node

// Discovers and gates versioned keyframe lane/jungle-CS layouts and byte
// substitutions across the saved replay corpus. Riot Timeline values are
// offline labels only; candidate payload bytes always come from the ROFL.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PROFILE_PATH = path.join(
  "packages",
  "rofl-core",
  "profiles",
  "replay-decoder-profiles.v1.json",
);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    profilePath: DEFAULT_PROFILE_PATH,
    outputPath: path.join("tmp", "keyframe-cs-cross-patch.json"),
    buildFilter: null,
    versionGroupFilter: null,
    replayIdFilter: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--decoder-profiles" && argv[index + 1]) args.profilePath = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--build" && argv[index + 1]) args.buildFilter = argv[++index];
    else if (arg === "--version-group" && argv[index + 1]) {
      args.versionGroupFilter = argv[++index];
    }
    else if (arg === "--replay-id" && argv[index + 1]) {
      args.replayIdFilter = argv[++index].replaceAll("_", "-");
    }
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/research_keyframe_cs_cross_patch.mjs " +
          "[--build <exact-version>] [--cli <path>] [--replay-dir <path>] " +
          "[--api-root <path>] [--decoder-profiles <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) {
    throw new Error(
      `${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
    );
  }
}

function runJson(cliPath, cliArgs) {
  const result = spawnSync(cliPath, cliArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `CLI exited with ${result.status}.`);
  }
  const jsonStart = result.stdout.indexOf("{");
  assert(jsonStart >= 0, "CLI returned no JSON object.", result.stdout.slice(0, 500));
  return JSON.parse(result.stdout.slice(jsonStart));
}

function readExactVersion(replayPath) {
  const file = fs.openSync(replayPath, "r");
  try {
    const bytes = Buffer.alloc(64);
    fs.readSync(file, bytes, 0, bytes.length, 0);
    const match = /\d+\.\d+\.\d+\.\d+/.exec(bytes.toString("latin1"));
    assert(match, `Replay header contains no exact version: ${replayPath}`);
    return match[0];
  } finally {
    fs.closeSync(file);
  }
}

function versionGroup(exactVersion) {
  const match = /^(\d+)\.(\d+)\./.exec(exactVersion);
  assert(match, `Unsupported replay version string: ${exactVersion}`);
  return `${match[1]}.${match[2]}`;
}

function loadCipher(registry) {
  const profiles = registry.profiles.filter(
    (entry) =>
      entry.versionGroup === "16.14" &&
      entry.acceptedGameVersions?.includes("16.14.794.5912"),
  );
  assert(profiles.length === 1, "Canonical 16.14 profile selection is not unique.");
  const cipher = profiles[0].keyframeParticipantStats?.cipherToPlain;
  assert(
    Array.isArray(cipher) && cipher.length === 256 && new Set(cipher).size === 256,
    "Canonical 16.14 byte substitution is unavailable.",
  );
  return cipher;
}

function discoverFamily(cliPath, replayPath, championBase) {
  const catalog = runJson(cliPath, [
    "--summarize-packet-types-json",
    replayPath,
    "--segment-type",
    "keyframe",
    "--top-types",
    "0",
  ]);
  assert(catalog.valid, "Keyframe packet catalog is invalid.", catalog.errors);
  const expectedOwners = Array.from({ length: 10 }, (_, index) => championBase + index + 1);
  const candidates = catalog.packetTypes.filter((entry) => {
    const owners = (entry.topBlockParams ?? []).map((item) => item.blockParam).sort((a, b) => a - b);
    return (
      entry.channel === 1 &&
      entry.count === catalog.selectedSegmentCount * 10 &&
      entry.contentLengths?.length === 1 &&
      entry.contentLengths[0].contentLength >= 1_000 &&
      owners.length === 10 &&
      owners.every((owner, index) => owner === expectedOwners[index])
    );
  });
  assert(candidates.length === 1, "Expected one substantial champion/keyframe family.", {
    replayPath,
    championBase,
    candidates,
  });
  return {
    packetType: candidates[0].packetType,
    contentLength: candidates[0].contentLengths[0].contentLength,
    keyframeCount: catalog.selectedSegmentCount,
  };
}

function timelinePath(apiRoot, replayId) {
  return path.join(apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
}

function dumpRows(args, fixture, grammar, championBase, partition) {
  const dump = runJson(args.cliPath, [
    "--dump-packet-type-json",
    fixture.replayPath,
    "--packet-type",
    String(grammar.packetType),
    "--segment-type",
    "keyframe",
    "--max-blocks",
    "0",
  ]);
  const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
  const frames = timeline.info?.frames ?? [];
  assert(dump.valid && !dump.errors?.length, "Packet dump failed framing.", dump.errors);
  assert(
    dump.blocks.length > 0 && dump.blocks.length % 10 === 0,
    "Champion/keyframe block count drifted.",
    { replayId: fixture.replayId, actual: dump.blocks.length, grammar },
  );
  return dump.blocks.map((block, index) => {
    const participantId = block.blockParam - championBase;
    const frameIndex = Math.floor(index / 10);
    const frame = frames[frameIndex];
    const participantFrame = frame?.participantFrames?.[participantId];
    const nextParticipantFrame = frames[frameIndex + 1]?.participantFrames?.[participantId];
    assert(
      participantId >= 1 &&
        participantId <= 10 &&
        block.channel === 1 &&
        block.packetType === grammar.packetType &&
        block.contentLength === grammar.contentLength &&
        !block.contentHexTruncated &&
        Math.abs((frame?.timestamp ?? -100_000) - block.timestampMillis) <= 2_000 &&
        Number.isInteger(participantFrame?.minionsKilled) &&
        Number.isInteger(participantFrame?.jungleMinionsKilled) &&
        Number.isFinite(participantFrame?.xp) &&
        Number.isFinite(participantFrame?.totalGold),
      "Replay/Timeline champion snapshot alignment failed.",
      { replayId: fixture.replayId, index, block, frameTimestamp: frame?.timestamp },
    );
    return {
      replayId: fixture.replayId,
      partition,
      participantId,
      timestampMillis: block.timestampMillis,
      payload: Buffer.from(block.contentHex, "hex"),
      laneCs: participantFrame.minionsKilled,
      nextLaneCs: Number.isInteger(nextParticipantFrame?.minionsKilled)
        ? nextParticipantFrame.minionsKilled
        : null,
      jungleCs: participantFrame.jungleMinionsKilled,
      xp: participantFrame.xp,
      totalGold: participantFrame.totalGold,
    };
  });
}

function transformedFloat(row, start, stride, transform, cipher) {
  const bytes = Buffer.allocUnsafe(4);
  for (let index = 0; index < 4; index += 1) {
    const raw = row.payload[start + index * stride];
    bytes[index] = transform === "cipher16.14" ? cipher[raw] : raw;
  }
  return bytes.readFloatLE(0);
}

function projected(value, field, epsilon = 1e-5) {
  if (!Number.isFinite(value) || value < 0) return null;
  return field === "laneCs" ? (Number.isInteger(value) ? value : null) : Math.floor(value + epsilon);
}

function selectCandidates(rows, contentLength, field, transform, cipher) {
  const candidates = [];
  for (let stride = -8; stride <= 8; stride += 1) {
    if (stride === 0) continue;
    for (let start = 0; start < contentLength; start += 1) {
      if (start + 3 * stride < 0 || start + 3 * stride >= contentLength) continue;
      let exact = true;
      for (const row of rows) {
        const value = transformedFloat(row, start, stride, transform, cipher);
        if (projected(value, field) !== row[field]) {
          exact = false;
          break;
        }
      }
      if (exact) candidates.push({ start, stride, offsets: [0, 1, 2, 3].map((i) => start + i * stride) });
    }
  }
  return candidates;
}

function validateCandidates(rows, candidates, field, transform, cipher) {
  return candidates.map((candidate) => {
    let exactCount = 0;
    const mismatches = [];
    for (const row of rows) {
      const value = transformedFloat(row, candidate.start, candidate.stride, transform, cipher);
      const actual = projected(value, field);
      if (actual === row[field]) exactCount += 1;
      else if (mismatches.length < 5) {
        mismatches.push({
          replayId: row.replayId,
          participantId: row.participantId,
          timestampMillis: row.timestampMillis,
          expected: row[field],
          actual,
          value: Number.isFinite(value) ? value : String(value),
        });
      }
    }
    return { ...candidate, exactCount, snapshotCount: rows.length, mismatches };
  });
}

function floatBytes(value) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeFloatLE(value, 0);
  return bytes;
}

function learnSubstitution(rows, start, stride, field) {
  const rawToPlain = new Map();
  const plainToRaw = new Map();
  for (const row of rows) {
    const expected = floatBytes(row[field]);
    for (let index = 0; index < 4; index += 1) {
      const raw = row.payload[start + index * stride];
      const plain = expected[index];
      if (
        (rawToPlain.has(raw) && rawToPlain.get(raw) !== plain) ||
        (plainToRaw.has(plain) && plainToRaw.get(plain) !== raw)
      ) {
        return null;
      }
      rawToPlain.set(raw, plain);
      plainToRaw.set(plain, raw);
    }
  }
  return rawToPlain;
}

function validateLearnedSubstitution(rows, start, stride, field, substitution) {
  let exactCount = 0;
  let unknownSymbolCount = 0;
  let unknownSnapshotCount = 0;
  let orderingBoundaryCount = 0;
  let unacceptedMismatchCount = 0;
  let monotonicRegressionCount = 0;
  const mismatches = [];
  const previousByParticipant = new Map();
  for (const row of rows) {
    const bytes = Buffer.allocUnsafe(4);
    let unknown = false;
    for (let index = 0; index < 4; index += 1) {
      const raw = row.payload[start + index * stride];
      const plain = substitution.get(raw);
      if (plain === undefined) {
        unknown = true;
        unknownSymbolCount += 1;
      } else bytes[index] = plain;
    }
    const actual = unknown ? null : bytes.readFloatLE(0);
    if (unknown) unknownSnapshotCount += 1;
    const participantKey = `${row.replayId}:${row.participantId}`;
    const previous = previousByParticipant.get(participantKey);
    if (Number.isFinite(actual)) {
      if (Number.isFinite(previous) && actual < previous) monotonicRegressionCount += 1;
      previousByParticipant.set(participantKey, actual);
    }
    const orderingBoundary =
      field === "laneCs" &&
      Number.isFinite(actual) &&
      Number.isInteger(row.nextLaneCs) &&
      actual > row.laneCs &&
      actual <= row.nextLaneCs;
    if (actual === row[field]) exactCount += 1;
    else {
      if (orderingBoundary) orderingBoundaryCount += 1;
      else if (!unknown) unacceptedMismatchCount += 1;
    }
    if (actual !== row[field] && mismatches.length < 5) {
      mismatches.push({
        replayId: row.replayId,
        participantId: row.participantId,
        timestampMillis: row.timestampMillis,
        expected: row[field],
        actual,
        unknown,
        nextExpected: field === "laneCs" ? row.nextLaneCs : null,
        acceptedOrderingBoundary: orderingBoundary,
      });
    }
  }
  return {
    exactCount,
    snapshotCount: rows.length,
    unknownSymbolCount,
    unknownSnapshotCount,
    orderingBoundaryCount,
    unacceptedMismatchCount,
    monotonicRegressionCount,
    mismatches,
  };
}

function discoverLearnedSubstitutions(discoveryRows, holdoutRows, contentLength, field) {
  const candidates = [];
  for (let stride = -8; stride <= 8; stride += 1) {
    if (stride === 0) continue;
    for (let start = 0; start < contentLength; start += 1) {
      if (start + 3 * stride < 0 || start + 3 * stride >= contentLength) continue;
      const substitution = learnSubstitution(discoveryRows, start, stride, field);
      if (!substitution) continue;
      const holdout = validateLearnedSubstitution(
        holdoutRows,
        start,
        stride,
        field,
        substitution,
      );
      candidates.push({
        start,
        stride,
        offsets: [0, 1, 2, 3].map((index) => start + index * stride),
        learnedSymbolCount: substitution.size,
        substitution: Object.fromEntries(
          [...substitution].sort((left, right) => left[0] - right[0]),
        ),
        holdout,
      });
    }
  }
  candidates.sort(
    (left, right) =>
      right.holdout.exactCount - left.holdout.exactCount ||
      left.holdout.unknownSymbolCount - right.holdout.unknownSymbolCount ||
      right.learnedSymbolCount - left.learnedSymbolCount ||
      left.stride - right.stride ||
      left.start - right.start,
  );
  return {
    discoveryCandidateCount: candidates.length,
    exactHoldoutCandidateCount: candidates.filter(
      (candidate) => candidate.holdout.exactCount === candidate.holdout.snapshotCount,
    ).length,
    topCandidates: candidates.slice(0, 16),
  };
}

function learnNoisySubstitution(rows, start, stride, field) {
  const counts = new Map();
  let observationCount = 0;
  for (const row of rows) {
    const expected = floatBytes(row[field]);
    for (let index = 0; index < 4; index += 1) {
      const raw = row.payload[start + index * stride];
      const plain = expected[index];
      const byPlain = counts.get(raw) ?? new Map();
      byPlain.set(plain, (byPlain.get(plain) ?? 0) + 1);
      counts.set(raw, byPlain);
      observationCount += 1;
    }
  }
  const substitution = new Map();
  let matchedObservationCount = 0;
  const selectedPlainCounts = new Map();
  for (const [raw, byPlain] of counts) {
    const selected = [...byPlain].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0];
    substitution.set(raw, selected[0]);
    matchedObservationCount += selected[1];
    selectedPlainCounts.set(
      selected[0],
      (selectedPlainCounts.get(selected[0]) ?? 0) + 1,
    );
  }
  const collisionCount = [...selectedPlainCounts.values()].filter((count) => count > 1).length;
  return {
    substitution,
    observationCount,
    conflictCount: observationCount - matchedObservationCount,
    collisionCount,
  };
}

function scoreIndividualByteLane(rows, offset, field, byteIndex) {
  const counts = new Map();
  let observationCount = 0;
  for (const row of rows) {
    const raw = row.payload[offset];
    const plain = floatBytes(row[field])[byteIndex];
    const byPlain = counts.get(raw) ?? new Map();
    byPlain.set(plain, (byPlain.get(plain) ?? 0) + 1);
    counts.set(raw, byPlain);
    observationCount += 1;
  }
  let matchedObservationCount = 0;
  const selectedPlainCounts = new Map();
  const substitution = {};
  for (const [raw, byPlain] of counts) {
    const selected = [...byPlain].sort(
      (left, right) => right[1] - left[1] || left[0] - right[0],
    )[0];
    substitution[raw] = selected[0];
    matchedObservationCount += selected[1];
    selectedPlainCounts.set(selected[0], (selectedPlainCounts.get(selected[0]) ?? 0) + 1);
  }
  return {
    offset,
    byteIndex,
    observedSymbolCount: counts.size,
    observationCount,
    conflictCount: observationCount - matchedObservationCount,
    conflictRate: (observationCount - matchedObservationCount) / observationCount,
    collisionCount: [...selectedPlainCounts.values()].filter((count) => count > 1).length,
    substitution,
  };
}

function rankIndividualByteLanes(rows, contentLength, field) {
  return [0, 1, 2, 3].map((byteIndex) => {
    const ranked = [];
    for (let offset = 0; offset < contentLength; offset += 1) {
      ranked.push(scoreIndividualByteLane(rows, offset, field, byteIndex));
    }
    ranked.sort(
      (left, right) =>
        left.conflictCount - right.conflictCount ||
        left.collisionCount - right.collisionCount ||
        right.observedSymbolCount - left.observedSymbolCount ||
        left.offset - right.offset,
    );
    return { byteIndex, topCandidates: ranked.slice(0, 16) };
  });
}

function discoverNoisySubstitutions(discoveryRows, holdoutRows, contentLength, field) {
  const ranked = [];
  for (let stride = -8; stride <= 8; stride += 1) {
    if (stride === 0) continue;
    for (let start = 0; start < contentLength; start += 1) {
      if (start + 3 * stride < 0 || start + 3 * stride >= contentLength) continue;
      const learned = learnNoisySubstitution(discoveryRows, start, stride, field);
      ranked.push({
        start,
        stride,
        offsets: [0, 1, 2, 3].map((index) => start + index * stride),
        learnedSymbolCount: learned.substitution.size,
        observationCount: learned.observationCount,
        conflictCount: learned.conflictCount,
        conflictRate: learned.conflictCount / learned.observationCount,
        collisionCount: learned.collisionCount,
      });
    }
  }
  ranked.sort(
    (left, right) =>
      left.conflictCount - right.conflictCount ||
      left.collisionCount - right.collisionCount ||
      right.learnedSymbolCount - left.learnedSymbolCount ||
      left.stride - right.stride ||
      left.start - right.start,
  );
  const topCandidates = ranked.slice(0, 32).map((candidate) => {
    const learned = learnNoisySubstitution(
      discoveryRows,
      candidate.start,
      candidate.stride,
      field,
    );
    return {
      ...candidate,
      substitution: Object.fromEntries(
        [...learned.substitution].sort((left, right) => left[0] - right[0]),
      ),
      holdout: validateLearnedSubstitution(
        holdoutRows,
        candidate.start,
        candidate.stride,
        field,
        learned.substitution,
      ),
    };
  });
  return { searchedCandidateCount: ranked.length, topCandidates };
}

function decodePartialFloat(row, start, stride, substitution) {
  const bytes = Buffer.allocUnsafe(4);
  for (let index = 0; index < 4; index += 1) {
    const plain = substitution.get(row.payload[start + index * stride]);
    if (plain === undefined) return null;
    bytes[index] = plain;
  }
  return bytes.readFloatLE(0);
}

function scanWithPartialSubstitution(rows, contentLength, field, substitution) {
  const candidates = [];
  for (let stride = -8; stride <= 8; stride += 1) {
    if (stride === 0) continue;
    for (let start = 0; start < contentLength; start += 1) {
      if (start + 3 * stride < 0 || start + 3 * stride >= contentLength) continue;
      let exact = true;
      for (const row of rows) {
        const value = decodePartialFloat(row, start, stride, substitution);
        if (value === null || projected(value, field) !== row[field]) {
          exact = false;
          break;
        }
      }
      if (exact) {
        candidates.push({
          start,
          stride,
          offsets: [0, 1, 2, 3].map((index) => start + index * stride),
        });
      }
    }
  }
  return candidates;
}

function validatePartialCandidates(rows, candidates, field, substitution) {
  return candidates.map((candidate) => {
    let exactCount = 0;
    let unknownSymbolCount = 0;
    const mismatches = [];
    for (const row of rows) {
      const value = decodePartialFloat(
        row,
        candidate.start,
        candidate.stride,
        substitution,
      );
      const actual = value === null ? null : projected(value, field);
      if (value === null) unknownSymbolCount += 1;
      if (actual === row[field]) exactCount += 1;
      else if (mismatches.length < 5) {
        mismatches.push({
          replayId: row.replayId,
          participantId: row.participantId,
          timestampMillis: row.timestampMillis,
          expected: row[field],
          actual,
          value,
        });
      }
    }
    return {
      ...candidate,
      exactCount,
      snapshotCount: rows.length,
      unknownSymbolCount,
      mismatches,
    };
  });
}

function deriveProjectionEpsilon(rows, candidate, field, substitution) {
  let minimumInclusive = 0;
  let maximumExclusive = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const value = decodePartialFloat(
      row,
      candidate.start,
      candidate.stride,
      substitution,
    );
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    minimumInclusive = Math.max(minimumInclusive, row[field] - value);
    maximumExclusive = Math.min(maximumExclusive, row[field] + 1 - value);
  }
  if (!(minimumInclusive < maximumExclusive)) return null;
  const selected = Math.ceil(minimumInclusive * 100_000) / 100_000;
  if (!(selected < maximumExclusive)) return null;
  return { minimumInclusive, maximumExclusive, selected };
}

function validatePartialCandidateWithEpsilon(rows, candidate, field, substitution, epsilon) {
  let exactCount = 0;
  let unknownSymbolCount = 0;
  const mismatches = [];
  for (const row of rows) {
    const value = decodePartialFloat(
      row,
      candidate.start,
      candidate.stride,
      substitution,
    );
    const actual = value === null ? null : projected(value, field, epsilon);
    if (value === null) unknownSymbolCount += 1;
    if (actual === row[field]) exactCount += 1;
    else if (mismatches.length < 5) {
      mismatches.push({
        replayId: row.replayId,
        participantId: row.participantId,
        timestampMillis: row.timestampMillis,
        expected: row[field],
        actual,
        value,
      });
    }
  }
  return {
    ...candidate,
    epsilon,
    exactCount,
    snapshotCount: rows.length,
    unknownSymbolCount,
    mismatches,
  };
}

function rankPartialCandidates(rows, contentLength, field, substitution) {
  const ranked = [];
  for (let stride = -8; stride <= 8; stride += 1) {
    if (stride === 0) continue;
    for (let start = 0; start < contentLength; start += 1) {
      if (start + 3 * stride < 0 || start + 3 * stride >= contentLength) continue;
      let knownCount = 0;
      let exactCount = 0;
      for (const row of rows) {
        const value = decodePartialFloat(row, start, stride, substitution);
        if (value === null) continue;
        knownCount += 1;
        if (projected(value, field) === row[field]) exactCount += 1;
      }
      ranked.push({
        start,
        stride,
        offsets: [0, 1, 2, 3].map((index) => start + index * stride),
        knownCount,
        exactCount,
        mismatchCount: knownCount - exactCount,
      });
    }
  }
  ranked.sort(
    (left, right) =>
      left.mismatchCount - right.mismatchCount ||
      right.knownCount - left.knownCount ||
      left.stride - right.stride ||
      left.start - right.start,
  );
  return ranked.slice(0, 32);
}

function propagateProjectedSubstitution(rows, start, stride, field, initial) {
  const substitution = new Map(initial);
  const inverse = new Map([...substitution].map(([raw, plain]) => [plain, raw]));
  const additions = [];
  let changed = true;
  while (changed) {
    changed = false;
    const domains = new Map();
    for (const row of rows) {
      const rawSymbols = [0, 1, 2, 3].map(
        (index) => row.payload[start + index * stride],
      );
      const unknownSymbols = [...new Set(rawSymbols.filter((raw) => !substitution.has(raw)))];
      if (unknownSymbols.length !== 1) continue;
      const unknownRaw = unknownSymbols[0];
      const candidates = new Set();
      for (let plain = 0; plain <= 255; plain += 1) {
        if (inverse.has(plain)) continue;
        const bytes = Buffer.from(
          rawSymbols.map((raw) => (raw === unknownRaw ? plain : substitution.get(raw))),
        );
        if (bytes.some((value) => value === undefined)) continue;
        const value = bytes.readFloatLE(0);
        if (projected(value, field) === row[field]) candidates.add(plain);
      }
      const previous = domains.get(unknownRaw);
      domains.set(
        unknownRaw,
        previous === undefined
          ? candidates
          : new Set([...previous].filter((plain) => candidates.has(plain))),
      );
    }
    for (const [unknownRaw, candidates] of domains) {
      if (candidates.size === 1) {
        const [plain] = candidates;
        substitution.set(unknownRaw, plain);
        inverse.set(plain, unknownRaw);
        additions.push({ raw: unknownRaw, plain });
        changed = true;
      }
    }
  }
  return { substitution, additions };
}

function mergeSelectedSubstitutions(selected) {
  const merged = new Map();
  const inverse = new Map();
  const conflicts = [];
  for (const entry of selected) {
    for (const [rawText, plain] of Object.entries(entry.candidate.substitution)) {
      const raw = Number(rawText);
      if (
        (merged.has(raw) && merged.get(raw) !== plain) ||
        (inverse.has(plain) && inverse.get(plain) !== raw)
      ) {
        conflicts.push({ field: entry.field, raw, plain });
        continue;
      }
      merged.set(raw, plain);
      inverse.set(plain, raw);
    }
  }
  return { substitution: merged, conflicts };
}

function unknownSymbolsAtCandidate(rows, candidate, substitution) {
  const symbols = new Set();
  if (!candidate) return [];
  for (const row of rows) {
    for (let index = 0; index < 4; index += 1) {
      const raw = row.payload[candidate.start + index * candidate.stride];
      if (!substitution.has(raw)) symbols.add(raw);
    }
  }
  return [...symbols].sort((left, right) => left - right);
}

function solveProjectedSubstitution(rows, candidate, field, initial, epsilon = 1e-5) {
  const substitution = new Map(initial);
  const inverse = new Map([...substitution].map(([raw, plain]) => [plain, raw]));
  const unknownSymbols = unknownSymbolsAtCandidate(rows, candidate, substitution);
  const unusedPlainSymbols = Array.from({ length: 256 }, (_, value) => value).filter(
    (value) => !inverse.has(value),
  );
  if (unknownSymbols.length > 8) {
    return {
      attempted: false,
      reason: "More than eight relevant raw symbols remain; bounded search refused.",
      unknownSymbols,
      unusedPlainSymbols,
    };
  }
  const occurrences = new Map(unknownSymbols.map((raw) => [raw, 0]));
  for (const row of rows) {
    for (let index = 0; index < 4; index += 1) {
      const raw = row.payload[candidate.start + index * candidate.stride];
      if (occurrences.has(raw)) occurrences.set(raw, occurrences.get(raw) + 1);
    }
  }
  const orderedUnknowns = [...unknownSymbols].sort(
    (left, right) => occurrences.get(right) - occurrences.get(left) || left - right,
  );
  const relevantRows = rows.map((row) => ({
    row,
    rawSymbols: [0, 1, 2, 3].map(
      (index) => row.payload[candidate.start + index * candidate.stride],
    ),
  }));
  const solutions = [];
  const maximumSolutions = 1_000_000;
  let truncated = false;
  let visitedAssignments = 0;
  function compatible({ row, rawSymbols }) {
    const bytes = Buffer.allocUnsafe(4);
    for (let index = 0; index < 4; index += 1) {
      const plain = substitution.get(rawSymbols[index]);
      if (plain === undefined) return true;
      bytes[index] = plain;
    }
    return projected(bytes.readFloatLE(0), field, epsilon) === row[field];
  }
  function visit(index) {
    if (solutions.length >= maximumSolutions) {
      truncated = true;
      return;
    }
    if (index === orderedUnknowns.length) {
      solutions.push(Object.fromEntries(orderedUnknowns.map((raw) => [raw, substitution.get(raw)])));
      return;
    }
    const raw = orderedUnknowns[index];
    for (const plain of unusedPlainSymbols) {
      if (inverse.has(plain)) continue;
      substitution.set(raw, plain);
      inverse.set(plain, raw);
      visitedAssignments += 1;
      if (relevantRows.every(compatible)) visit(index + 1);
      inverse.delete(plain);
      substitution.delete(raw);
      if (truncated) return;
    }
  }
  visit(0);
  const domains = Object.fromEntries(
    unknownSymbols.map((raw) => [
      raw,
      [...new Set(solutions.map((solution) => solution[raw]))].sort(
        (left, right) => left - right,
      ),
    ]),
  );
  const uniqueAssignments = Object.fromEntries(
    Object.entries(domains)
      .filter(([, values]) => values.length === 1)
      .map(([raw, values]) => [raw, values[0]]),
  );
  let domainProjectionExactCount = 0;
  const domainProjectionMismatches = [];
  for (const { row, rawSymbols } of relevantRows) {
    const rowUnknowns = [...new Set(rawSymbols.filter((raw) => !initial.has(raw)))];
    const assignment = new Map(initial);
    const assignedPlain = new Set(initial.values());
    const projections = new Set();
    function visitRow(index) {
      if (projections.size > 1) return;
      if (index === rowUnknowns.length) {
        const bytes = Buffer.from(rawSymbols.map((raw) => assignment.get(raw)));
        projections.add(projected(bytes.readFloatLE(0), field, epsilon));
        return;
      }
      const raw = rowUnknowns[index];
      for (const plain of domains[raw] ?? []) {
        if (assignedPlain.has(plain)) continue;
        assignment.set(raw, plain);
        assignedPlain.add(plain);
        visitRow(index + 1);
        assignedPlain.delete(plain);
        assignment.delete(raw);
      }
    }
    visitRow(0);
    if (projections.size === 1 && projections.has(row[field])) {
      domainProjectionExactCount += 1;
    } else if (domainProjectionMismatches.length < 8) {
      domainProjectionMismatches.push({
        replayId: row.replayId,
        participantId: row.participantId,
        timestampMillis: row.timestampMillis,
        expected: row[field],
        projections: [...projections],
        rawSymbols,
      });
    }
  }
  return {
    attempted: true,
    unknownSymbols,
    unusedPlainSymbols,
    variableOrder: orderedUnknowns,
    visitedAssignments,
    solutionCount: solutions.length,
    truncated,
    domains,
    uniqueAssignments,
    domainProjectionExactCount,
    domainProjectionSnapshotCount: relevantRows.length,
    domainProjectionMismatches,
  };
}

function splitFixtures(fixtures) {
  if (fixtures.length === 1) {
    return { discovery: fixtures, holdout: fixtures, participantSplit: true };
  }
  const holdoutCount = Math.max(1, Math.ceil(fixtures.length / 3));
  return {
    discovery: fixtures.slice(0, -holdoutCount),
    holdout: fixtures.slice(-holdoutCount),
    participantSplit: false,
  };
}

function main() {
  const args = parseArgs(process.argv);
  for (const key of ["cliPath", "replayDir", "apiRoot", "profilePath", "outputPath"]) {
    args[key] = path.resolve(args[key]);
  }
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);
  const registry = JSON.parse(fs.readFileSync(args.profilePath, "utf8"));
  const cipher = loadCipher(registry);
  const championBases = new Map(
    registry.profiles.map((entry) => [entry.versionGroup, entry.kill?.championNetworkIdBase]),
  );

  const fixturesByBuild = new Map();
  for (const name of fs.readdirSync(args.replayDir).filter((item) => item.endsWith(".rofl")).sort()) {
    const replayPath = path.join(args.replayDir, name);
    const exactVersion = readExactVersion(replayPath);
    if (args.buildFilter && exactVersion !== args.buildFilter) continue;
    if (args.versionGroupFilter && versionGroup(exactVersion) !== args.versionGroupFilter) {
      continue;
    }
    const replayId = path.basename(name, ".rofl");
    if (args.replayIdFilter && replayId !== args.replayIdFilter) continue;
    const fixtureTimelinePath = timelinePath(args.apiRoot, replayId);
    if (!fs.existsSync(fixtureTimelinePath)) continue;
    const fixtures = fixturesByBuild.get(exactVersion) ?? [];
    fixtures.push({ replayId, replayPath, timelinePath: fixtureTimelinePath });
    fixturesByBuild.set(exactVersion, fixtures);
  }
  assert(fixturesByBuild.size > 0, "No replay/Timeline fixture pairs selected.");

  const builds = [];
  const rowsByVersionGroup = new Map();
  for (const [exactVersion, fixtures] of [...fixturesByBuild].sort()) {
    const group = versionGroup(exactVersion);
    const championBase = championBases.get(group);
    assert(Number.isInteger(championBase), `No champion base for ${group}.`);
    console.error(`Discovering ${exactVersion} from ${fixtures.length} replay(s)...`);
    const grammar = discoverFamily(args.cliPath, fixtures[0].replayPath, championBase);
    const split = splitFixtures(fixtures);
    let discoveryRows = split.discovery.flatMap((fixture) =>
      dumpRows(args, fixture, grammar, championBase, "discovery"),
    );
    let holdoutRows = split.holdout.flatMap((fixture) =>
      dumpRows(args, fixture, grammar, championBase, "holdout"),
    );
    if (split.participantSplit) {
      discoveryRows = discoveryRows.filter((row) => row.participantId <= 7);
      holdoutRows = holdoutRows.filter((row) => row.participantId >= 8);
    }

    const transforms = {};
    for (const transform of ["cipher16.14", "raw"]) {
      const fields = {};
      for (const field of ["laneCs", "jungleCs"]) {
        const selected = selectCandidates(
          discoveryRows,
          grammar.contentLength,
          field,
          transform,
          cipher,
        );
        fields[field] = {
          discoverySnapshotCount: discoveryRows.length,
          holdoutSnapshotCount: holdoutRows.length,
          selectedCandidates: selected,
          holdout: validateCandidates(holdoutRows, selected, field, transform, cipher),
          exactHoldoutCandidateCount: validateCandidates(
            holdoutRows,
            selected,
            field,
            transform,
            cipher,
          ).filter((candidate) => candidate.exactCount === candidate.snapshotCount).length,
        };
      }
      transforms[transform] = fields;
    }
    const learnedLaneSubstitution = discoverLearnedSubstitutions(
      discoveryRows,
      holdoutRows,
      grammar.contentLength,
      "laneCs",
    );
    const noisyLaneSubstitution = discoverNoisySubstitutions(
      discoveryRows,
      holdoutRows,
      grammar.contentLength,
      "laneCs",
    );
    const individualLaneByteCandidates = rankIndividualByteLanes(
      discoveryRows,
      grammar.contentLength,
      "laneCs",
    );
    const noisyJungleSubstitution = discoverNoisySubstitutions(
      discoveryRows,
      holdoutRows,
      grammar.contentLength,
      "jungleCs",
    );
    const bestLane = noisyLaneSubstitution.topCandidates[0];
    let jungleFromLaneSubstitution = {
      available: false,
      reason: "No low-conflict injective lane-CS substitution was selected.",
    };
    if (bestLane && bestLane.collisionCount === 0 && bestLane.conflictRate <= 0.001) {
      const substitution = new Map(
        Object.entries(bestLane.substitution).map(([raw, plain]) => [Number(raw), plain]),
      );
      const candidates = scanWithPartialSubstitution(
        discoveryRows,
        grammar.contentLength,
        "jungleCs",
        substitution,
      );
      const rankedPartialCandidates = rankPartialCandidates(
        discoveryRows,
        grammar.contentLength,
        "jungleCs",
        substitution,
      );
      const additionalScalarCandidates = {};
      for (const field of ["xp", "totalGold"]) {
        const ranked = rankPartialCandidates(
          discoveryRows,
          grammar.contentLength,
          field,
          substitution,
        );
        additionalScalarCandidates[field] = {
          discovery: ranked.slice(0, 16),
          holdout: ranked.slice(0, 16).map((candidate) =>
            validatePartialCandidates(
              holdoutRows,
              [candidate],
              field,
              substitution,
            )[0],
          ),
        };
      }
      const partialHoldout = rankedPartialCandidates.slice(0, 16).map((candidate) =>
        validatePartialCandidates(
          holdoutRows,
          [candidate],
          "jungleCs",
          substitution,
        )[0],
      );
      let propagation = null;
      if (
        rankedPartialCandidates[0]?.mismatchCount === 0 &&
        rankedPartialCandidates[0].knownCount >= discoveryRows.length * 0.5 &&
        rankedPartialCandidates[1]?.mismatchCount > 0
      ) {
        const selected = rankedPartialCandidates[0];
        const propagated = propagateProjectedSubstitution(
          discoveryRows,
          selected.start,
          selected.stride,
          "jungleCs",
          substitution,
        );
        propagation = {
          selectedCandidate: selected,
          initialSymbolCount: substitution.size,
          addedSymbolCount: propagated.additions.length,
          additions: propagated.additions,
          finalSymbolCount: propagated.substitution.size,
          discovery: validatePartialCandidates(
            discoveryRows,
            [selected],
            "jungleCs",
            propagated.substitution,
          )[0],
          holdout: validatePartialCandidates(
            holdoutRows,
            [selected],
            "jungleCs",
            propagated.substitution,
          )[0],
          substitution: Object.fromEntries(
            [...propagated.substitution].sort((left, right) => left[0] - right[0]),
          ),
        };
      }
      jungleFromLaneSubstitution = {
        available: true,
        laneOffsets: bestLane.offsets,
        laneConflictCount: bestLane.conflictCount,
        learnedSymbolCount: substitution.size,
        selectedCandidates: candidates,
        rankedPartialCandidates,
        rankedPartialHoldout: partialHoldout,
        additionalScalarCandidates,
        propagation,
        holdout: validatePartialCandidates(
          holdoutRows,
          candidates,
          "jungleCs",
          substitution,
        ),
      };
    }
    const selectedScalarCandidates = [
      ["laneCs", noisyLaneSubstitution.topCandidates[0]],
    ]
      .filter(([, candidate]) =>
        candidate && candidate.collisionCount === 0 && candidate.conflictRate <= 0.005,
      )
      .map(([field, candidate]) => ({ field, candidate }));
    const merged = mergeSelectedSubstitutions(selectedScalarCandidates);
    const mergedJungleCandidates =
      merged.conflicts.length === 0
        ? scanWithPartialSubstitution(
            discoveryRows,
            grammar.contentLength,
            "jungleCs",
            merged.substitution,
          )
        : [];
    const jungleFromMergedSubstitution = {
      selectedScalarCandidates: selectedScalarCandidates.map((entry) => ({
        field: entry.field,
        offsets: entry.candidate.offsets,
        conflictCount: entry.candidate.conflictCount,
        conflictRate: entry.candidate.conflictRate,
        learnedSymbolCount: entry.candidate.learnedSymbolCount,
      })),
      mergeConflictCount: merged.conflicts.length,
      mergeConflicts: merged.conflicts.slice(0, 16),
      learnedSymbolCount: merged.substitution.size,
      selectedCandidates: mergedJungleCandidates,
      rankedPartialCandidates: rankPartialCandidates(
        discoveryRows,
        grammar.contentLength,
        "jungleCs",
        merged.substitution,
      ),
      holdout: validatePartialCandidates(
        holdoutRows,
        mergedJungleCandidates,
        "jungleCs",
        merged.substitution,
      ),
    };
    const groupRows = rowsByVersionGroup.get(group) ?? [];
    groupRows.push({
      exactVersion,
      grammar,
      discoveryRows,
      holdoutRows,
      laneCandidate: noisyLaneSubstitution.topCandidates[0],
    });
    rowsByVersionGroup.set(group, groupRows);
    builds.push({
      exactVersion,
      versionGroup: group,
      fixtureCount: fixtures.length,
      championBase,
      grammar,
      split,
      transforms,
      learnedLaneSubstitution,
      noisyLaneSubstitution,
      individualLaneByteCandidates,
      noisyJungleSubstitution,
      jungleFromLaneSubstitution,
      jungleFromMergedSubstitution,
    });
  }

  const versionGroups = [];
  for (const [group, groupBuilds] of rowsByVersionGroup) {
    const selected = groupBuilds
      .filter(
        (entry) =>
          entry.laneCandidate?.conflictRate <= 0.005,
      )
      .map((entry) => ({
        field: `${entry.exactVersion}:laneCs`,
        candidate: entry.laneCandidate,
      }));
    const discoveryRows = groupBuilds.flatMap((entry) => entry.discoveryRows);
    const holdoutRows = groupBuilds.flatMap((entry) => entry.holdoutRows);
    const laneLayouts = [
      ...new Set(selected.map((entry) => JSON.stringify(entry.candidate.offsets))),
    ].map((value) => JSON.parse(value));
    const contentLengths = [...new Set(groupBuilds.map((entry) => entry.grammar.contentLength))];
    let result = {
      versionGroup: group,
      exactBuilds: groupBuilds.map((entry) => entry.exactVersion),
      discoverySnapshotCount: discoveryRows.length,
      holdoutSnapshotCount: holdoutRows.length,
      laneLayouts,
      contentLengths,
      selectedBuildCandidateCount: selected.length,
      mergeConflictCount: null,
      learnedSymbolCount: 0,
      promotionCandidate: false,
      reason: "Build candidates do not share one conflict-free layout and substitution.",
    };
    if (
      selected.length === groupBuilds.length &&
      laneLayouts.length === 1 &&
      contentLengths.length === 1
    ) {
      const laneCandidate = {
        start: laneLayouts[0][0],
        stride: laneLayouts[0][1] - laneLayouts[0][0],
        offsets: laneLayouts[0],
      };
      const groupLearned = learnNoisySubstitution(
        discoveryRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
      );
      const laneDiscovery = validateLearnedSubstitution(
        discoveryRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        groupLearned.substitution,
      );
      const laneHoldout = validateLearnedSubstitution(
        holdoutRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        groupLearned.substitution,
      );
      let calibratedSubstitution = new Map(groupLearned.substitution);
      const calibrationFields = [];
      for (const field of ["xp", "totalGold"]) {
        const ranked = rankPartialCandidates(
          discoveryRows,
          contentLengths[0],
          field,
          calibratedSubstitution,
        );
        const candidate = ranked[0];
        const runnerUp = ranked[1] ?? null;
        const uniquelySelected =
          candidate &&
          candidate.knownCount >= Math.max(20, discoveryRows.length * 0.05) &&
          candidate.mismatchCount <= 10 &&
          (runnerUp === null ||
            runnerUp.mismatchCount > candidate.mismatchCount ||
            runnerUp.knownCount < candidate.knownCount * 0.5);
        let calibration = {
          field,
          selected: false,
          candidate,
          runnerUp,
          initialSymbolCount: calibratedSubstitution.size,
        };
        if (uniquelySelected) {
          const propagated = propagateProjectedSubstitution(
            discoveryRows,
            candidate.start,
            candidate.stride,
            field,
            calibratedSubstitution,
          );
          calibratedSubstitution = propagated.substitution;
          calibration = {
            ...calibration,
            selected: true,
            addedSymbolCount: propagated.additions.length,
            additions: propagated.additions,
            finalSymbolCount: calibratedSubstitution.size,
            discovery: validatePartialCandidates(
              discoveryRows,
              [candidate],
              field,
              calibratedSubstitution,
            )[0],
            holdout: validatePartialCandidates(
              holdoutRows,
              [candidate],
              field,
              calibratedSubstitution,
            )[0],
          };
        }
        calibrationFields.push(calibration);
      }
      const rankedJungle = rankPartialCandidates(
        discoveryRows,
        contentLengths[0],
        "jungleCs",
        calibratedSubstitution,
      );
      const jungleCandidate = rankedJungle[0];
      let jungle = null;
      if (
        jungleCandidate?.mismatchCount <= 10 &&
        jungleCandidate.knownCount >= discoveryRows.length * 0.5 &&
        (rankedJungle[1]?.mismatchCount > jungleCandidate.mismatchCount ||
          rankedJungle[1]?.knownCount < jungleCandidate.knownCount * 0.5)
      ) {
        const propagated = propagateProjectedSubstitution(
          discoveryRows,
          jungleCandidate.start,
          jungleCandidate.stride,
          "jungleCs",
          calibratedSubstitution,
        );
        const epsilon = deriveProjectionEpsilon(
          discoveryRows,
          jungleCandidate,
          "jungleCs",
          propagated.substitution,
        );
        jungle = {
          selectedCandidate: jungleCandidate,
          runnerUp: rankedJungle[1] ?? null,
          addedSymbolCount: propagated.additions.length,
          learnedSymbolCount: propagated.substitution.size,
          additions: propagated.additions,
          projectionEpsilon: epsilon,
          discovery: epsilon
            ? validatePartialCandidateWithEpsilon(
                discoveryRows,
                jungleCandidate,
                "jungleCs",
                propagated.substitution,
                epsilon.selected,
              )
            : null,
          holdout: epsilon
            ? validatePartialCandidateWithEpsilon(
                holdoutRows,
                jungleCandidate,
                "jungleCs",
                propagated.substitution,
                epsilon.selected,
              )
            : null,
          substitution: Object.fromEntries(
            [...propagated.substitution].sort((left, right) => left[0] - right[0]),
          ),
        };
      }
      const allRows = [...discoveryRows, ...holdoutRows];
      const allLaneLearned = learnNoisySubstitution(
        allRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
      );
      let finalSubstitution = new Map(allLaneLearned.substitution);
      const fullCorpusCalibrationFields = [];
      for (const field of ["xp", "totalGold"]) {
        const ranked = rankPartialCandidates(
          allRows,
          contentLengths[0],
          field,
          finalSubstitution,
        );
        const minimumKnownCount = Math.max(20, allRows.length * 0.05);
        const viable = ranked
          .filter((candidate) => candidate.knownCount >= minimumKnownCount)
          .sort(
            (left, right) =>
              left.mismatchCount - right.mismatchCount ||
              right.knownCount - left.knownCount,
          );
        const candidate = viable[0] ?? null;
        const runnerUp = viable[1] ?? null;
        const selectedCalibration =
          candidate !== null &&
          candidate.mismatchCount <= Math.max(10, allRows.length * 0.005) &&
          (runnerUp === null ||
            runnerUp.mismatchCount > candidate.mismatchCount ||
            runnerUp.knownCount < candidate.knownCount * 0.5);
        let calibration = {
          field,
          selected: selectedCalibration,
          candidate,
          runnerUp,
        };
        if (selectedCalibration) {
          const propagated = propagateProjectedSubstitution(
            allRows,
            candidate.start,
            candidate.stride,
            field,
            finalSubstitution,
          );
          finalSubstitution = propagated.substitution;
          calibration = {
            ...calibration,
            addedSymbolCount: propagated.additions.length,
            additions: propagated.additions,
            finalSymbolCount: finalSubstitution.size,
            corpus: validatePartialCandidates(
              allRows,
              [candidate],
              field,
              finalSubstitution,
            )[0],
          };
        }
        fullCorpusCalibrationFields.push(calibration);
      }
      let jungleCipherCompletion = null;
      if (jungleCandidate && finalSubstitution.size < 256) {
        const propagated = propagateProjectedSubstitution(
          allRows,
          jungleCandidate.start,
          jungleCandidate.stride,
          "jungleCs",
          finalSubstitution,
        );
        finalSubstitution = propagated.substitution;
        jungleCipherCompletion = {
          initialSymbolCount:
            finalSubstitution.size - propagated.additions.length,
          addedSymbolCount: propagated.additions.length,
          additions: propagated.additions,
          finalSymbolCount: finalSubstitution.size,
        };
      }
      const jungleJointSolution = jungleCandidate
        ? solveProjectedSubstitution(
            allRows,
            jungleCandidate,
            "jungleCs",
            finalSubstitution,
          )
        : null;
      if (jungleJointSolution?.attempted && !jungleJointSolution.truncated) {
        for (const [rawText, plain] of Object.entries(
          jungleJointSolution.uniqueAssignments,
        )) {
          finalSubstitution.set(Number(rawText), plain);
        }
      }
      const finalPlainSymbols = new Set(finalSubstitution.values());
      const jungleUnknownRawSymbols = unknownSymbolsAtCandidate(
        allRows,
        jungleCandidate,
        finalSubstitution,
      );
      const unusedPlainSymbols = Array.from({ length: 256 }, (_, value) => value).filter(
        (value) => !finalPlainSymbols.has(value),
      );
      const cipherComplete =
        finalSubstitution.size === 256 && finalPlainSymbols.size === 256;
      const finalLaneDiscovery = validateLearnedSubstitution(
        discoveryRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        finalSubstitution,
      );
      const finalLaneHoldout = validateLearnedSubstitution(
        holdoutRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        finalSubstitution,
      );
      const finalJungleEpsilon = jungleCandidate
        ? deriveProjectionEpsilon(
            discoveryRows,
            jungleCandidate,
            "jungleCs",
            finalSubstitution,
          )
        : null;
      const finalJungleDiscovery =
        jungleCandidate && finalJungleEpsilon
          ? validatePartialCandidateWithEpsilon(
              discoveryRows,
              jungleCandidate,
              "jungleCs",
              finalSubstitution,
              finalJungleEpsilon.selected,
            )
          : null;
      const finalJungleHoldout =
        jungleCandidate && finalJungleEpsilon
          ? validatePartialCandidateWithEpsilon(
              holdoutRows,
              jungleCandidate,
              "jungleCs",
              finalSubstitution,
              finalJungleEpsilon.selected,
            )
          : null;
      const corpusFinalization = {
        method:
          jungleCipherCompletion?.addedSymbolCount > 0
            ? "Freeze layouts on Discovery and validate known symbols on Holdout; complete the patch cipher from lane-CS/XP/total-gold plus only uniquely constrained jungle-CS projection symbols across the saved corpus."
            : "Freeze layouts on Discovery, validate known symbols on Holdout, then complete the patch cipher from lane-CS/XP/total-gold labels across the saved corpus; jungle CS remains an independent field holdout.",
        runtimeRiotInput: false,
        allLaneConflictCount: allLaneLearned.conflictCount,
        allLaneInverseCollisionCount: allLaneLearned.collisionCount,
        initialSymbolCount: allLaneLearned.substitution.size,
        calibrationFields: fullCorpusCalibrationFields,
        jungleCipherCompletion,
        jungleJointSolution,
        finalSymbolCount: finalSubstitution.size,
        cipherComplete,
        jungleUnknownRawSymbols,
        unusedPlainSymbols,
        finalLaneDiscovery,
        finalLaneHoldout,
        jungleCandidate,
        jungleProjectionEpsilon: finalJungleEpsilon,
        finalJungleDiscovery,
        finalJungleHoldout,
        substitution: Object.fromEntries(
          [...finalSubstitution].sort((left, right) => left[0] - right[0]),
        ),
      };
      const calibratedLaneDiscovery = validateLearnedSubstitution(
        discoveryRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        calibratedSubstitution,
      );
      const calibratedLaneHoldout = validateLearnedSubstitution(
        holdoutRows,
        laneCandidate.start,
        laneCandidate.stride,
        "laneCs",
        calibratedSubstitution,
      );
      const exactLaneHoldout =
        calibratedLaneHoldout.exactCount === calibratedLaneHoldout.snapshotCount &&
        calibratedLaneHoldout.unknownSymbolCount === 0;
      const exactJungleHoldout =
        jungle?.holdout?.exactCount === jungle?.holdout?.snapshotCount &&
        jungle?.holdout?.unknownSymbolCount === 0;
      const finalizedLaneSafe =
        finalLaneDiscovery.unknownSnapshotCount === 0 &&
        finalLaneDiscovery.unacceptedMismatchCount === 0 &&
        finalLaneDiscovery.monotonicRegressionCount === 0 &&
        finalLaneHoldout.unknownSnapshotCount === 0 &&
        finalLaneHoldout.unacceptedMismatchCount === 0 &&
        finalLaneHoldout.monotonicRegressionCount === 0;
      const finalizedJungleSafe =
        (finalJungleDiscovery?.exactCount === finalJungleDiscovery?.snapshotCount &&
          finalJungleDiscovery?.unknownSymbolCount === 0 &&
          finalJungleHoldout?.exactCount === finalJungleHoldout?.snapshotCount &&
          finalJungleHoldout?.unknownSymbolCount === 0) ||
        (jungleJointSolution?.attempted === true &&
          jungleJointSolution.truncated === false &&
          jungleJointSolution.solutionCount > 0 &&
          jungleJointSolution.domainProjectionExactCount ===
            jungleJointSolution.domainProjectionSnapshotCount);
      result = {
        ...result,
        mergeConflictCount: groupLearned.conflictCount,
        learnedSymbolCount: groupLearned.substitution.size,
        inverseCollisionCount: groupLearned.collisionCount,
        calibrationFields,
        calibratedSymbolCount: calibratedSubstitution.size,
        laneCandidate,
        laneDiscovery,
        laneHoldout,
        calibratedLaneDiscovery,
        calibratedLaneHoldout,
        corpusFinalization,
        rankedJungleCandidates: rankedJungle.slice(0, 8),
        jungle,
        promotionCandidate: finalizedLaneSafe && finalizedJungleSafe,
        reason:
          finalizedLaneSafe && finalizedJungleSafe
            ? cipherComplete
              ? "The frozen layout, complete patch cipher, monotonic lane-CS gate, accepted same-keyframe ordering boundaries, and independent jungle-CS field holdout all pass."
              : "The frozen layout and monotonic lane-CS gate pass; every saved jungle-CS snapshot has one invariant integer projection across the bounded remaining cipher domains, so unresolved symbols can fail closed without guessing."
            : exactLaneHoldout && exactJungleHoldout
              ? "The Discovery-only gate passes, but full-corpus cipher finalization remains incomplete."
              : "The layout is exact where decoded, but the patch cipher or final semantic holdout remains incomplete.",
      };
    }
    versionGroups.push(result);
  }

  const report = {
    schema: "rofl-keyframe-cs-cross-patch-research/v1",
    generatedAtUtc: new Date().toISOString(),
    source: {
      replayInput: "Saved ROFL packet bytes.",
      offlineOracle: "Saved Riot Timeline minionsKilled and jungleMinionsKilled.",
      runtimeRiotInput: false,
    },
    hypothesis: "Champion-owned keyframe payloads retain replay-native Float32LE lane/jungle-CS stripes across known patches, with patch-specific cipher permutations and versioned packet/layout parameters.",
    candidateGrammar: {
      transforms: ["canonical 16.14 cipherToPlain", "raw bytes negative control"],
      encoding: "Float32LE",
      strides: [[-8, -1], [1, 8]],
      laneProjection: "exact finite nonnegative integer",
      jungleProjection: "floor(value + 1e-5)",
      selection: "Discovery replays only, or participants 1-7 when only one replay exists; frozen candidates evaluated on replay or participant holdout.",
    },
    builds,
    versionGroups,
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(versionGroups.map((group) => ({
    versionGroup: group.versionGroup,
    exactBuilds: group.exactBuilds,
    promotionCandidate: group.promotionCandidate,
    laneOffsets: group.laneCandidate?.offsets ?? null,
    jungleOffsets: group.corpusFinalization?.jungleCandidate?.offsets ?? null,
    cipherSymbolCount: group.corpusFinalization?.finalSymbolCount ?? 0,
    ambiguousCipherSymbols:
      group.corpusFinalization?.jungleJointSolution?.unknownSymbols ?? [],
    reason: group.reason,
  })), null, 2));
}

main();
