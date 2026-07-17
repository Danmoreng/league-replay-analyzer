import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PACKET_TYPES = [0x0442, 0x0165, 0x01f0];
const DEFAULT_CLI = "build/packages/rofl-core/rofl_core_cli.exe";

const BYTE_ENCODINGS = [
  { id: "u8", widthBytes: 1, read: (bytes, offset) => bytes[offset] },
  {
    id: "i8",
    widthBytes: 1,
    read: (bytes, offset) => bytes.readInt8(offset),
  },
  {
    id: "u16le",
    widthBytes: 2,
    read: (bytes, offset) => bytes.readUInt16LE(offset),
  },
  {
    id: "u16be",
    widthBytes: 2,
    read: (bytes, offset) => bytes.readUInt16BE(offset),
  },
  {
    id: "i16le",
    widthBytes: 2,
    read: (bytes, offset) => bytes.readInt16LE(offset),
  },
  {
    id: "i16be",
    widthBytes: 2,
    read: (bytes, offset) => bytes.readInt16BE(offset),
  },
  {
    id: "u24le",
    widthBytes: 3,
    read: (bytes, offset) => bytes.readUIntLE(offset, 3),
  },
  {
    id: "u24be",
    widthBytes: 3,
    read: (bytes, offset) => bytes.readUIntBE(offset, 3),
  },
  {
    id: "i24le",
    widthBytes: 3,
    read: (bytes, offset) => bytes.readIntLE(offset, 3),
  },
  {
    id: "i24be",
    widthBytes: 3,
    read: (bytes, offset) => bytes.readIntBE(offset, 3),
  },
  {
    id: "u32le",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readUInt32LE(offset),
  },
  {
    id: "u32be",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readUInt32BE(offset),
  },
  {
    id: "i32le",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readInt32LE(offset),
  },
  {
    id: "i32be",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readInt32BE(offset),
  },
  {
    id: "f32le",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readFloatLE(offset),
  },
  {
    id: "f32be",
    widthBytes: 4,
    read: (bytes, offset) => bytes.readFloatBE(offset),
  },
  {
    id: "xor60-u8",
    widthBytes: 1,
    read: (bytes, offset) => bytes[offset] ^ 0x60,
  },
  {
    id: "xor60-u16le",
    widthBytes: 2,
    read: (bytes, offset) =>
      (bytes[offset] ^ 0x60) + (bytes[offset + 1] ^ 0x60) * 0x100,
  },
  {
    id: "xor60-u16be",
    widthBytes: 2,
    read: (bytes, offset) =>
      (bytes[offset] ^ 0x60) * 0x100 + (bytes[offset + 1] ^ 0x60),
  },
  {
    id: "xor60-u24le",
    widthBytes: 3,
    read: (bytes, offset) =>
      (bytes[offset] ^ 0x60) +
      (bytes[offset + 1] ^ 0x60) * 0x100 +
      (bytes[offset + 2] ^ 0x60) * 0x10000,
  },
];

const TARGETS = [
  target("positionX", "position", [12, 13, 14, 15, 16, 18]),
  target("positionY", "position", [12, 13, 14, 15, 16, 18]),
  target("health", "scalar", [8, 10, 11, 12, 13, 14, 16, 18]),
  target("maxHealth", "scalar", [8, 10, 11, 12, 13, 14, 16, 18]),
  target("power", "scalar", [8, 10, 11, 12, 13, 14, 16]),
  target("maxPower", "scalar", [8, 10, 11, 12, 13, 14, 16]),
  target("currentGold", "scalar", [8, 10, 11, 12, 13, 14, 16, 18]),
  target("totalGold", "scalar", [10, 12, 13, 14, 15, 16, 18, 20]),
  target("level", "smallInteger", [4, 5, 6, 7, 8]),
  target("xp", "scalar", [10, 12, 13, 14, 15, 16, 18, 20]),
  target("laneCs", "smallInteger", [6, 7, 8, 10, 11, 12, 13, 14]),
  target("jungleCs", "smallInteger", [6, 7, 8, 10, 11, 12, 13, 14]),
  target("totalCs", "smallInteger", [6, 7, 8, 10, 11, 12, 13, 14]),
  target("damageToChampions", "scalar", [12, 14, 15, 16, 18, 20, 24]),
  target("totalDamageDone", "scalar", [14, 16, 18, 20, 24]),
  target("totalDamageTaken", "scalar", [12, 14, 16, 18, 20, 24]),
  target("nativeKills", "smallInteger", [4, 5, 6, 7, 8]),
  target("nativeDeaths", "smallInteger", [4, 5, 6, 7, 8]),
  target("nativeAssists", "smallInteger", [4, 5, 6, 7, 8]),
  target("isDead", "binary", [1, 2, 4, 8]),
  target("recentDeath60s", "binary", [1, 2, 4, 8]),
  target("respawnedSincePreviousFrame", "binary", [1, 2, 4, 8]),
];

function target(key, kind, bitWidths) {
  return { key, kind, bitWidths };
}

function parseArgs(argv) {
  const args = {
    replays: [],
    timelines: [],
    cliPath: DEFAULT_CLI,
    outputPath: null,
    packetTypes: [...DEFAULT_PACKET_TYPES],
    topCandidates: 12,
    screenCandidates: 40,
    probeFramesPerParticipant: 5,
    maximumAlignmentDeltaMillis: 2000,
    skipBitScan: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replay" && index + 1 < argv.length) {
      args.replays.push(argv[++index]);
    } else if (arg === "--timeline" && index + 1 < argv.length) {
      args.timelines.push(argv[++index]);
    } else if (arg === "--cli" && index + 1 < argv.length) {
      args.cliPath = argv[++index];
    } else if (arg === "--output" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--packet-types" && index + 1 < argv.length) {
      args.packetTypes = argv[++index]
        .split(",")
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 0));
    } else if (arg === "--top" && index + 1 < argv.length) {
      args.topCandidates = Number.parseInt(argv[++index], 10);
    } else if (arg === "--screen-top" && index + 1 < argv.length) {
      args.screenCandidates = Number.parseInt(argv[++index], 10);
    } else if (arg === "--probe-frames" && index + 1 < argv.length) {
      args.probeFramesPerParticipant = Number.parseInt(argv[++index], 10);
    } else if (arg === "--max-alignment-ms" && index + 1 < argv.length) {
      args.maximumAlignmentDeltaMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--skip-bit-scan") {
      args.skipBitScan = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (args.replays.length < 1 || args.replays.length !== args.timelines.length) {
    throw new Error(
      "Pass one --timeline for every --replay. Repeat both flags to validate across replays.",
    );
  }
  if (args.packetTypes.some((value) => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
    throw new Error("Packet types must be u16 values.");
  }
  return args;
}

function printHelp() {
  console.log(
    "Usage: node ./scripts/discover_keyframe_champion_state.mjs " +
      "--replay <file.rofl> --timeline <timeline.json> " +
      "[--replay <second.rofl> --timeline <second-timeline.json>] " +
      "[--cli <rofl_core_cli.exe>] [--output <report.json>] " +
      "[--packet-types 0x0442,0x0165,0x01F0] [--top 12] " +
      "[--screen-top 40] [--probe-frames 5] [--skip-bit-scan]",
  );
}

function runCli(cliPath, cliArgs) {
  const output = execFileSync(cliPath, cliArgs, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output);
}

function packetTypeHex(value) {
  return `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function replayIdFromPath(replayPath) {
  return path.basename(replayPath, path.extname(replayPath));
}

function nearestTimelineFrame(frames, timestampMillis) {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].timestamp < timestampMillis) low = middle + 1;
    else high = middle;
  }
  const candidates = [frames[low - 1], frames[low]].filter(Boolean);
  let best = null;
  for (const frame of candidates) {
    const deltaMillis = Math.abs(frame.timestamp - timestampMillis);
    if (!best || deltaMillis < best.deltaMillis) best = { frame, deltaMillis };
  }
  return best;
}

function cumulativeCombatState(killEvents, participantId, timestampMillis) {
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let lastDeathTimestampMillis = null;
  for (const event of killEvents) {
    if (event.timestampMillis > timestampMillis) break;
    if (event.killerParticipantId === participantId) kills += 1;
    if (event.victimParticipantId === participantId) {
      deaths += 1;
      lastDeathTimestampMillis = event.timestampMillis;
    }
    if (event.assistingParticipantIds?.includes(participantId)) assists += 1;
  }
  return { kills, deaths, assists, lastDeathTimestampMillis };
}

function flattenLabels(participantFrame, previousParticipantFrame, combat, timestampMillis) {
  const stats = participantFrame.championStats ?? {};
  const damage = participantFrame.damageStats ?? {};
  const health = numberOrNull(stats.health);
  const previousHealth = numberOrNull(previousParticipantFrame?.championStats?.health);
  const isDead = health === null ? null : health <= 0 ? 1 : 0;
  const respawnedSincePreviousFrame =
    health === null ? null : previousHealth !== null && previousHealth <= 0 && health > 0 ? 1 : 0;
  const lastDeath = combat.lastDeathTimestampMillis;
  return {
    positionX: numberOrNull(participantFrame.position?.x),
    positionY: numberOrNull(participantFrame.position?.y),
    health,
    maxHealth: numberOrNull(stats.healthMax),
    power: numberOrNull(stats.power),
    maxPower: numberOrNull(stats.powerMax),
    currentGold: numberOrNull(participantFrame.currentGold),
    totalGold: numberOrNull(participantFrame.totalGold),
    level: numberOrNull(participantFrame.level),
    xp: numberOrNull(participantFrame.xp),
    laneCs: numberOrNull(participantFrame.minionsKilled),
    jungleCs: numberOrNull(participantFrame.jungleMinionsKilled),
    totalCs:
      Number.isFinite(participantFrame.minionsKilled) &&
      Number.isFinite(participantFrame.jungleMinionsKilled)
        ? participantFrame.minionsKilled + participantFrame.jungleMinionsKilled
        : null,
    damageToChampions: numberOrNull(damage.totalDamageDoneToChampions),
    totalDamageDone: numberOrNull(damage.totalDamageDone),
    totalDamageTaken: numberOrNull(damage.totalDamageTaken),
    nativeKills: combat.kills,
    nativeDeaths: combat.deaths,
    nativeAssists: combat.assists,
    isDead,
    recentDeath60s:
      lastDeath === null ? 0 : timestampMillis - lastDeath <= 60_000 ? 1 : 0,
    respawnedSincePreviousFrame,
  };
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function loadReplayCase(replayPathInput, timelinePathInput, cliPath, packetTypes, maxDelta) {
  const replayPath = path.resolve(replayPathInput);
  const timelinePath = path.resolve(timelinePathInput);
  const replayId = replayIdFromPath(replayPath);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const frames = [...(timeline.info?.frames ?? [])].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  if (frames.length === 0) throw new Error(`Timeline has no frames: ${timelinePath}`);

  const kills = runCli(cliPath, ["--extract-replay-kills-json", replayPath]);
  const championBase = kills.profile?.championNetworkIdBase;
  if (!Number.isInteger(championBase)) {
    throw new Error(`Kill decoder did not expose championNetworkIdBase for ${replayId}.`);
  }
  const killEvents = [...(kills.events ?? [])].sort(
    (left, right) => left.timestampMillis - right.timestampMillis,
  );
  const dumps = new Map();
  for (const packetType of packetTypes) {
    console.error(`Dumping exact ${packetTypeHex(packetType)} keyframe blocks from ${replayId}...`);
    const dump = runCli(cliPath, [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      String(packetType),
      "--segment-type",
      "keyframe",
      "--max-blocks",
      "0",
    ]);
    if (!dump.valid || dump.errors?.length) {
      throw new Error(`Exact packet framing failed for ${replayId} ${packetTypeHex(packetType)}.`);
    }
    dumps.set(packetType, dump);
  }

  return {
    replayId,
    replayPath,
    timelinePath,
    gameVersion: kills.gameVersion,
    versionGroup: kills.versionGroup,
    championBase,
    participants: kills.participants ?? [],
    frames,
    killEvents,
    dumps,
    maximumAlignmentDeltaMillis: maxDelta,
  };
}

function buildFamilySamples(replayCase, packetType) {
  const dump = replayCase.dumps.get(packetType);
  const championBase = replayCase.championBase;
  const samples = [];
  const rejected = {
    nonChampionOwner: 0,
    truncatedPayload: 0,
    alignmentMiss: 0,
    participantFrameMiss: 0,
  };
  const blocksBySegment = new Map();

  for (const block of dump.blocks ?? []) {
    const participantId = block.blockParam - championBase;
    if (participantId < 1 || participantId > 10) {
      rejected.nonChampionOwner += 1;
      continue;
    }
    if (block.contentHexTruncated || block.contentHexBytes !== block.contentLength) {
      rejected.truncatedPayload += 1;
      continue;
    }
    const segmentBlocks = blocksBySegment.get(block.segmentId) ?? [];
    segmentBlocks.push({ participantId, block });
    blocksBySegment.set(block.segmentId, segmentBlocks);

    const nearest = nearestTimelineFrame(replayCase.frames, block.timestampMillis);
    if (!nearest || nearest.deltaMillis > replayCase.maximumAlignmentDeltaMillis) {
      rejected.alignmentMiss += 1;
      continue;
    }
    const participantFrame = nearest.frame.participantFrames?.[String(participantId)];
    if (!participantFrame) {
      rejected.participantFrameMiss += 1;
      continue;
    }
    const frameIndex = replayCase.frames.indexOf(nearest.frame);
    const previousParticipantFrame =
      frameIndex > 0
        ? replayCase.frames[frameIndex - 1].participantFrames?.[String(participantId)]
        : null;
    const combat = cumulativeCombatState(
      replayCase.killEvents,
      participantId,
      block.timestampMillis,
    );
    samples.push({
      replayId: replayCase.replayId,
      participantId,
      participantKey: `${replayCase.replayId}|${participantId}`,
      championName:
        replayCase.participants.find((entry) => entry.participantId === participantId)
          ?.championName ?? null,
      segmentId: block.segmentId,
      chunkId: block.chunkId,
      blockIndex: block.blockIndex,
      timestampMillis: block.timestampMillis,
      timelineTimestampMillis: nearest.frame.timestamp,
      alignmentDeltaMillis: nearest.deltaMillis,
      payload: Buffer.from(block.contentHex, "hex"),
      labels: flattenLabels(
        participantFrame,
        previousParticipantFrame,
        combat,
        block.timestampMillis,
      ),
    });
  }

  const segmentCoverage = [...blocksBySegment.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([segmentId, entries]) => {
      const participantIds = entries.map((entry) => entry.participantId);
      return {
        segmentId,
        timestampMillis: entries[0]?.block.timestampMillis ?? null,
        championBlockCount: entries.length,
        distinctChampionOwnerCount: new Set(participantIds).size,
        exactOneBlockPerChampion:
          entries.length === 10 &&
          new Set(participantIds).size === 10 &&
          participantIds.every(
            (participantId) =>
              participantIds.filter((candidate) => candidate === participantId).length === 1,
          ),
      };
    });

  samples.sort(
    (left, right) =>
      left.timestampMillis - right.timestampMillis || left.participantId - right.participantId,
  );
  const trackDiagnostics = [];
  const changedBytesPerTransition = [];
  for (let participantId = 1; participantId <= 10; participantId += 1) {
    const track = samples
      .filter((sample) => sample.participantId === participantId)
      .sort((left, right) => left.timestampMillis - right.timestampMillis);
    const trackChangedBytes = [];
    for (let index = 1; index < track.length; index += 1) {
      const changedBytes = payloadChangedByteCount(
        track[index - 1].payload,
        track[index].payload,
      );
      trackChangedBytes.push(changedBytes);
      changedBytesPerTransition.push(changedBytes);
    }
    trackDiagnostics.push({
      participantId,
      sampleCount: track.length,
      distinctPayloadCount: new Set(track.map((sample) => sample.payload.toString("hex"))).size,
      distinctContentLengthCount: new Set(track.map((sample) => sample.payload.length)).size,
      changedBytesPerTransition: summarizeNumbers(trackChangedBytes),
    });
  }
  const contentLengths = countValues(samples.map((sample) => sample.payload.length));
  return {
    samples,
    exactStructure: {
      packetType,
      packetTypeHex: packetTypeHex(packetType),
      exactPacketFraming: true,
      dumpMatchingBlockCount: dump.matchingBlockCount,
      usableChampionBlockCount: samples.length,
      keyframeSegmentCount: segmentCoverage.length,
      exactTenOfTenSegmentCount: segmentCoverage.filter(
        (entry) => entry.exactOneBlockPerChampion,
      ).length,
      allSegmentsExactlyOneBlockPerChampion: segmentCoverage.every(
        (entry) => entry.exactOneBlockPerChampion,
      ),
      contentLengths,
      minimumContentLength: Math.min(...samples.map((sample) => sample.payload.length)),
      maximumContentLength: Math.max(...samples.map((sample) => sample.payload.length)),
      maximumTimelineAlignmentDeltaMillis: Math.max(
        ...samples.map((sample) => sample.alignmentDeltaMillis),
      ),
      contentEvolution: {
        everyTrackPayloadChangesAtEveryKeyframe: trackDiagnostics.every(
          (track) => track.distinctPayloadCount === track.sampleCount,
        ),
        changedBytesPerTransition: summarizeNumbers(changedBytesPerTransition),
        tracks: trackDiagnostics,
      },
      rejected,
      segmentCoverage,
    },
  };
}

function countValues(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([value, count]) => ({ value, count }));
}

function payloadChangedByteCount(left, right) {
  const sharedLength = Math.min(left.length, right.length);
  let changed = Math.abs(left.length - right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index] !== right[index]) changed += 1;
  }
  return changed;
}

function summarizeNumbers(values) {
  if (values.length === 0) {
    return { count: 0, minimum: null, maximum: null, average: null };
  }
  return {
    count: values.length,
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    average: sum(values) / values.length,
  };
}

function selectProbeSamples(samples, framesPerParticipant) {
  const groups = new Map();
  for (const sample of samples) {
    const group = groups.get(sample.participantKey) ?? [];
    group.push(sample);
    groups.set(sample.participantKey, group);
  }
  const selected = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.timestampMillis - right.timestampMillis);
    const wanted = Math.min(framesPerParticipant, group.length);
    const indices = new Set();
    for (let index = 0; index < wanted; index += 1) {
      const quantile = wanted === 1 ? 0 : index / (wanted - 1);
      indices.add(Math.round(quantile * (group.length - 1)));
    }
    for (const index of indices) selected.push(group[index]);
  }
  selected.sort(
    (left, right) =>
      left.replayId.localeCompare(right.replayId) ||
      left.participantId - right.participantId ||
      left.timestampMillis - right.timestampMillis,
  );
  return selected;
}

function prepareScreen(samples, targets) {
  const participantKeys = [...new Set(samples.map((sample) => sample.participantKey))];
  const groupIndex = new Map(participantKeys.map((key, index) => [key, index]));
  const sampleGroups = Int16Array.from(samples.map((sample) => groupIndex.get(sample.participantKey)));
  const groupCounts = new Int16Array(participantKeys.length);
  for (const group of sampleGroups) groupCounts[group] += 1;

  const profiles = new Map();
  for (const definition of targets) {
    const values = Float64Array.from(samples.map((sample) => sample.labels[definition.key]));
    if ([...values].some((value) => !Number.isFinite(value))) continue;
    const mean = sum(values) / values.length;
    const centered = Float64Array.from(values, (value) => value - mean);
    const globalSquare = dot(centered, centered);
    const groupSums = new Float64Array(participantKeys.length);
    for (let index = 0; index < values.length; index += 1) {
      groupSums[sampleGroups[index]] += values[index];
    }
    const withinCentered = new Float64Array(values.length);
    for (let index = 0; index < values.length; index += 1) {
      const group = sampleGroups[index];
      withinCentered[index] = values[index] - groupSums[group] / groupCounts[group];
    }
    const withinSquare = dot(withinCentered, withinCentered);
    if (globalSquare <= 0) continue;
    profiles.set(definition.key, {
      definition,
      values,
      centered,
      globalSquare,
      withinCentered,
      withinSquare,
    });
  }
  return { samples, sampleGroups, groupCounts, profiles };
}

function sum(values) {
  let result = 0;
  for (const value of values) result += value;
  return result;
}

function dot(left, right) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return result;
}

function decodeSpec(sample, spec) {
  if (spec.source === "contentLength") return sample.payload.length;
  if (spec.source === "byte") {
    const encoding = BYTE_ENCODINGS[spec.encodingIndex];
    const offset =
      spec.anchor === "start"
        ? spec.offsetBytes
        : sample.payload.length - spec.offsetBytes - encoding.widthBytes;
    return encoding.read(sample.payload, offset);
  }
  const absoluteBitOffset =
    spec.anchor === "start"
      ? spec.offsetBits
      : sample.payload.length * 8 - spec.offsetBits - spec.widthBits;
  return spec.bitOrder === "little"
    ? readBitsLittle(sample.payload, absoluteBitOffset, spec.widthBits)
    : readBitsBig(sample.payload, absoluteBitOffset, spec.widthBits);
}

function readBitsLittle(bytes, absoluteBitOffset, width) {
  const byteOffset = Math.floor(absoluteBitOffset / 8);
  const shift = absoluteBitOffset % 8;
  const word =
    ((bytes[byteOffset] ?? 0) +
      (bytes[byteOffset + 1] ?? 0) * 0x100 +
      (bytes[byteOffset + 2] ?? 0) * 0x10000 +
      (bytes[byteOffset + 3] ?? 0) * 0x1000000) >>>
    0;
  return Math.floor(word / 2 ** shift) % 2 ** width;
}

function readBitsBig(bytes, absoluteBitOffset, width) {
  const byteOffset = Math.floor(absoluteBitOffset / 8);
  const shift = absoluteBitOffset % 8;
  const word =
    ((bytes[byteOffset] ?? 0) * 0x1000000 +
      (bytes[byteOffset + 1] ?? 0) * 0x10000 +
      (bytes[byteOffset + 2] ?? 0) * 0x100 +
      (bytes[byteOffset + 3] ?? 0)) >>>
    0;
  return Math.floor(word / 2 ** (32 - shift - width)) % 2 ** width;
}

function screenSpec(spec, screen, applicableTargets, collectors) {
  const sampleCount = screen.samples.length;
  const values = new Float64Array(sampleCount);
  const groupSums = new Float64Array(screen.groupCounts.length);
  let valueSum = 0;
  let valueSquareSum = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = decodeSpec(screen.samples[index], spec);
    if (!Number.isFinite(value)) return;
    values[index] = value;
    valueSum += value;
    valueSquareSum += value * value;
    groupSums[screen.sampleGroups[index]] += value;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  if (minimum === maximum) return;
  const globalSquare = valueSquareSum - (valueSum * valueSum) / sampleCount;
  let withinSquare = valueSquareSum;
  for (let group = 0; group < groupSums.length; group += 1) {
    withinSquare -= (groupSums[group] * groupSums[group]) / screen.groupCounts[group];
  }
  if (globalSquare <= 1e-12) return;

  for (const definition of applicableTargets) {
    const profile = screen.profiles.get(definition.key);
    if (!profile) continue;
    const globalCorrelation =
      dot(values, profile.centered) / Math.sqrt(globalSquare * profile.globalSquare);
    const withinParticipantCorrelation =
      withinSquare > 1e-12 && profile.withinSquare > 1e-12
        ? dot(values, profile.withinCentered) /
          Math.sqrt(withinSquare * profile.withinSquare)
        : 0;
    const score =
      Math.abs(withinParticipantCorrelation) * 0.68 +
      Math.abs(globalCorrelation) * 0.32;
    pushTop(collectors.get(definition.key), {
      score,
      probeGlobalCorrelation: globalCorrelation,
      probeWithinParticipantCorrelation: withinParticipantCorrelation,
      spec,
    });
  }
}

function pushTop(collector, candidate) {
  collector.push(candidate);
  collector.sort(
    (left, right) =>
      right.score - left.score ||
      Math.abs(right.probeWithinParticipantCorrelation) -
        Math.abs(left.probeWithinParticipantCorrelation),
  );
  if (collector.length > collector.maximum) collector.length = collector.maximum;
}

function scanByteFields(samples, screen, collectors) {
  const minimumLength = Math.min(...samples.map((sample) => sample.payload.length));
  const maximumLength = Math.max(...samples.map((sample) => sample.payload.length));
  const anchors = minimumLength === maximumLength ? ["start"] : ["start", "end"];
  const definitions = TARGETS.filter((definition) => screen.profiles.has(definition.key));
  screenSpec({ source: "contentLength" }, screen, definitions, collectors);
  for (const anchor of anchors) {
    for (let encodingIndex = 0; encodingIndex < BYTE_ENCODINGS.length; encodingIndex += 1) {
      const encoding = BYTE_ENCODINGS[encodingIndex];
      for (let offsetBytes = 0; offsetBytes + encoding.widthBytes <= minimumLength; offsetBytes += 1) {
        screenSpec(
          {
            source: "byte",
            anchor,
            offsetBytes,
            widthBits: encoding.widthBytes * 8,
            encodingIndex,
          },
          screen,
          definitions,
          collectors,
        );
      }
    }
  }
}

function scanBitFields(samples, screen, collectors) {
  const minimumBits = Math.min(...samples.map((sample) => sample.payload.length * 8));
  const maximumBits = Math.max(...samples.map((sample) => sample.payload.length * 8));
  const anchors = minimumBits === maximumBits ? ["start"] : ["start", "end"];
  const widths = [...new Set(TARGETS.flatMap((definition) => definition.bitWidths))].sort(
    (left, right) => left - right,
  );
  for (const anchor of anchors) {
    for (const bitOrder of ["little", "big"]) {
      for (const widthBits of widths) {
        const definitions = TARGETS.filter(
          (definition) =>
            definition.bitWidths.includes(widthBits) && screen.profiles.has(definition.key),
        );
        if (definitions.length === 0) continue;
        console.error(
          `  bit scan ${anchor}/${bitOrder}/${widthBits} (${definitions.map((entry) => entry.key).join(",")})`,
        );
        for (let offsetBits = 0; offsetBits + widthBits <= minimumBits; offsetBits += 1) {
          if (
            offsetBits % 8 === 0 &&
            [8, 16, 24].includes(widthBits) &&
            bitOrder === "little"
          ) {
            continue;
          }
          screenSpec(
            { source: "bit", anchor, bitOrder, offsetBits, widthBits },
            screen,
            definitions,
            collectors,
          );
        }
      }
    }
  }
}

function evaluateCandidate(samples, definition, screened) {
  const rows = [];
  for (const sample of samples) {
    const targetValue = sample.labels[definition.key];
    const rawValue = decodeSpec(sample, screened.spec);
    if (!Number.isFinite(targetValue) || !Number.isFinite(rawValue)) continue;
    rows.push({ sample, rawValue, targetValue });
  }
  const raw = rows.map((row) => row.rawValue);
  const labels = rows.map((row) => row.targetValue);
  const globalCorrelation = correlation(raw, labels);
  const withinParticipantCorrelation = withinCorrelation(rows);
  const affine = affineFit(raw, labels);
  const direct = bestDirectTransform(raw, labels, definition, screened.spec);
  const firstDifferenceCorrelation = withinParticipantFirstDifferenceCorrelation(rows);
  const timestampCorrelation = correlation(
    raw,
    rows.map((row) => row.sample.timestampMillis),
  );
  const withinParticipantTimestampCorrelation = withinCorrelation(
    rows.map((row) => ({
      ...row,
      targetValue: row.sample.timestampMillis,
    })),
  );
  const perReplay = [];
  for (const replayId of [...new Set(rows.map((row) => row.sample.replayId))]) {
    const replayRows = rows.filter((row) => row.sample.replayId === replayId);
    perReplay.push({
      replayId,
      sampleCount: replayRows.length,
      globalCorrelation: correlation(
        replayRows.map((row) => row.rawValue),
        replayRows.map((row) => row.targetValue),
      ),
      withinParticipantCorrelation: withinCorrelation(replayRows),
      firstDifferenceCorrelation: withinParticipantFirstDifferenceCorrelation(replayRows),
      directRmse: transformError(replayRows, direct.scale, direct.offset).rmse,
    });
  }
  const changingParticipantCount = countChangingParticipants(rows);
  const crossReplayMinimumAbsoluteCorrelation = Math.min(
    ...perReplay.map((entry) => Math.abs(entry.globalCorrelation)),
  );
  const crossReplayMinimumAbsoluteWithinCorrelation = Math.min(
    ...perReplay.map((entry) => Math.abs(entry.withinParticipantCorrelation)),
  );
  const classification = classifyCandidate(
    direct,
    definition,
    withinParticipantCorrelation,
    firstDifferenceCorrelation,
    crossReplayMinimumAbsoluteCorrelation,
    crossReplayMinimumAbsoluteWithinCorrelation,
    changingParticipantCount,
    perReplay.length,
  );
  return {
    field: describeSpec(screened.spec),
    source: screened.spec.source,
    sampleCount: rows.length,
    replayCount: perReplay.length,
    changingParticipantCount,
    probeScore: screened.score,
    probeGlobalCorrelation: screened.probeGlobalCorrelation,
    probeWithinParticipantCorrelation: screened.probeWithinParticipantCorrelation,
    globalCorrelation,
    withinParticipantCorrelation,
    firstDifferenceCorrelation,
    timestampCorrelation,
    withinParticipantTimestampCorrelation,
    crossReplayMinimumAbsoluteCorrelation,
    crossReplayMinimumAbsoluteWithinCorrelation,
    affineFit: affine,
    bestDirectTransform: direct,
    perReplay,
    classification,
    spec: screened.spec,
  };
}

function describeSpec(spec) {
  if (spec.source === "contentLength") return "contentLength";
  if (spec.source === "byte") {
    const encoding = BYTE_ENCODINGS[spec.encodingIndex];
    return `${spec.anchor}+${spec.offsetBytes}B:${encoding.id}`;
  }
  return `${spec.anchor}+${spec.offsetBits}b:${spec.bitOrder}-u${spec.widthBits}`;
}

function correlation(left, right) {
  if (left.length < 3 || left.length !== right.length) return 0;
  const leftMean = sum(left) / left.length;
  const rightMean = sum(right) / right.length;
  let covariance = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftSquare += leftDelta * leftDelta;
    rightSquare += rightDelta * rightDelta;
  }
  return leftSquare > 0 && rightSquare > 0
    ? covariance / Math.sqrt(leftSquare * rightSquare)
    : 0;
}

function withinCorrelation(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.sample.participantKey) ?? [];
    group.push(row);
    groups.set(row.sample.participantKey, group);
  }
  const rawCentered = [];
  const targetCentered = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const rawMean = sum(group.map((row) => row.rawValue)) / group.length;
    const targetMean = sum(group.map((row) => row.targetValue)) / group.length;
    for (const row of group) {
      rawCentered.push(row.rawValue - rawMean);
      targetCentered.push(row.targetValue - targetMean);
    }
  }
  return correlation(rawCentered, targetCentered);
}

function withinParticipantFirstDifferenceCorrelation(rows) {
  const groups = new Map();
  for (const row of rows) {
    const group = groups.get(row.sample.participantKey) ?? [];
    group.push(row);
    groups.set(row.sample.participantKey, group);
  }
  const rawDifferences = [];
  const targetDifferences = [];
  for (const group of groups.values()) {
    group.sort((left, right) => left.sample.timestampMillis - right.sample.timestampMillis);
    for (let index = 1; index < group.length; index += 1) {
      rawDifferences.push(group[index].rawValue - group[index - 1].rawValue);
      targetDifferences.push(group[index].targetValue - group[index - 1].targetValue);
    }
  }
  return correlation(rawDifferences, targetDifferences);
}

function affineFit(raw, labels) {
  const rawMean = sum(raw) / raw.length;
  const labelMean = sum(labels) / labels.length;
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const delta = raw[index] - rawMean;
    covariance += delta * (labels[index] - labelMean);
    variance += delta * delta;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  const intercept = labelMean - slope * rawMean;
  const error = transformErrorFromArrays(raw, labels, slope, intercept);
  const labelRange = Math.max(...labels) - Math.min(...labels);
  return {
    slope,
    intercept,
    rmse: error.rmse,
    mae: error.mae,
    normalizedRmseByRange: labelRange > 0 ? error.rmse / labelRange : null,
  };
}

function bestDirectTransform(raw, labels, definition, spec) {
  let transforms;
  if (definition.kind === "binary") {
    transforms = [
      { id: "raw", scale: 1, offset: 0 },
      { id: "one-minus-raw", scale: -1, offset: 1 },
    ];
  } else {
    const positiveScales = [1, 2, 4, 8, 16, 32, 0.5, 0.25, 0.1, 0.01, 10, 100];
    const ordinaryOffsets =
      definition.kind === "position" ? [0, 4096, -4096, 8192, 16384] : [0];
    transforms = positiveScales.flatMap((scale) =>
      ordinaryOffsets.map((offset) => ({
        id: `${scale}*raw${offset >= 0 ? "+" : ""}${offset}`,
        scale,
        offset,
      })),
    );
    const fieldMaximum =
      Number.isInteger(spec?.widthBits) && spec.widthBits <= 24
        ? 2 ** spec.widthBits - 1
        : null;
    if (fieldMaximum !== null) {
      for (const positiveScale of positiveScales) {
        transforms.push({
          id: `${positiveScale}*(max-raw)`,
          scale: -positiveScale,
          offset: fieldMaximum * positiveScale,
        });
      }
    } else {
      transforms.push({ id: "-raw", scale: -1, offset: 0 });
    }
  }
  let best = null;
  for (const transform of transforms) {
    const error = transformErrorFromArrays(raw, labels, transform.scale, transform.offset);
    if (!best || error.rmse < best.rmse) best = { ...transform, ...error };
  }
  const tolerance = definition.kind === "position" ? 2 : definition.kind === "binary" ? 0 : 0.5;
  best.exactWithinToleranceRatio =
    raw.filter(
      (value, index) =>
        Math.abs(value * best.scale + best.offset - labels[index]) <= tolerance,
    ).length / raw.length;
  best.tolerance = tolerance;
  return best;
}

function transformError(rows, scale, offset) {
  return transformErrorFromArrays(
    rows.map((row) => row.rawValue),
    rows.map((row) => row.targetValue),
    scale,
    offset,
  );
}

function transformErrorFromArrays(raw, labels, scale, offset) {
  let square = 0;
  let absolute = 0;
  let maximum = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const error = Math.abs(raw[index] * scale + offset - labels[index]);
    square += error * error;
    absolute += error;
    if (error > maximum) maximum = error;
  }
  return {
    rmse: Math.sqrt(square / raw.length),
    mae: absolute / raw.length,
    maximumAbsoluteError: maximum,
  };
}

function countChangingParticipants(rows) {
  const values = new Map();
  for (const row of rows) {
    const set = values.get(row.sample.participantKey) ?? new Set();
    set.add(row.rawValue);
    values.set(row.sample.participantKey, set);
  }
  return [...values.values()].filter((set) => set.size > 1).length;
}

function classifyCandidate(
  direct,
  definition,
  within,
  firstDifference,
  minimumReplayCorrelation,
  minimumReplayWithin,
  changingParticipants,
  replayCount,
) {
  if (
    replayCount >= 2 &&
    direct.maximumAbsoluteError <= direct.tolerance &&
    direct.exactWithinToleranceRatio === 1
  ) {
    return "direct-exact-validation-match";
  }
  if (
    replayCount >= 2 &&
    changingParticipants >= 10 &&
    Math.abs(within) >= 0.8 &&
    Math.abs(firstDifference) >= 0.65 &&
    minimumReplayWithin >= 0.7 &&
    minimumReplayCorrelation >= 0.6
  ) {
    return "stable-strong-correlation";
  }
  if (
    replayCount >= 2 &&
    changingParticipants >= 10 &&
    Math.abs(within) >= 0.6 &&
    Math.abs(firstDifference) >= 0.45 &&
    minimumReplayWithin >= 0.45
  ) {
    return "stable-moderate-correlation";
  }
  if (minimumReplayCorrelation >= 0.75 && Math.abs(within) < 0.35) {
    return "participant-static-correlation-only";
  }
  if (Math.abs(within) >= 0.6 && Math.abs(firstDifference) < 0.35) {
    return "progression-correlation-only";
  }
  if (definition.kind === "binary" && minimumReplayCorrelation >= 0.5) {
    return "binary-correlation-candidate";
  }
  return "not-promotable";
}

function candidateRange(spec) {
  if (!spec || spec.source === "contentLength") return null;
  if (spec.source === "byte") {
    return {
      anchor: spec.anchor,
      start: spec.offsetBytes * 8,
      end: spec.offsetBytes * 8 + spec.widthBits,
    };
  }
  return {
    anchor: spec.anchor,
    start: spec.offsetBits,
    end: spec.offsetBits + spec.widthBits,
  };
}

function rangesOverlap(left, right) {
  return left.anchor === right.anchor && left.start < right.end && right.start < left.end;
}

function rangeGap(left, right) {
  if (left.anchor !== right.anchor) return Number.POSITIVE_INFINITY;
  if (rangesOverlap(left, right)) return -1;
  return Math.max(left.start, right.start) - Math.min(left.end, right.end);
}

function scoreCoordinatePairs(samples, xCandidates, yCandidates, maximumPairs) {
  const pairs = [];
  for (const xCandidate of xCandidates.slice(0, 20)) {
    for (const yCandidate of yCandidates.slice(0, 20)) {
      const xRange = candidateRange(xCandidate.spec);
      const yRange = candidateRange(yCandidate.spec);
      if (!xRange || !yRange || xRange.anchor !== yRange.anchor || rangesOverlap(xRange, yRange)) {
        continue;
      }
      const gapBits = rangeGap(xRange, yRange);
      if (gapBits > 128) continue;
      const rows = samples
        .map((sample) => ({
          sample,
          rawX: decodeSpec(sample, xCandidate.spec),
          rawY: decodeSpec(sample, yCandidate.spec),
          x: sample.labels.positionX,
          y: sample.labels.positionY,
        }))
        .filter((row) => [row.rawX, row.rawY, row.x, row.y].every(Number.isFinite));
      const xFit = affineFit(
        rows.map((row) => row.rawX),
        rows.map((row) => row.x),
      );
      const yFit = affineFit(
        rows.map((row) => row.rawY),
        rows.map((row) => row.y),
      );
      let square = 0;
      for (const row of rows) {
        const dx = row.rawX * xFit.slope + xFit.intercept - row.x;
        const dy = row.rawY * yFit.slope + yFit.intercept - row.y;
        square += dx * dx + dy * dy;
      }
      const affineDistanceRmse = Math.sqrt(square / rows.length);
      const score =
        Math.min(
          Math.abs(xCandidate.withinParticipantCorrelation),
          Math.abs(yCandidate.withinParticipantCorrelation),
        ) * 0.7 + Math.max(0, 1 - affineDistanceRmse / 15000) * 0.3;
      pairs.push({
        score,
        gapBits,
        xField: xCandidate.field,
        yField: yCandidate.field,
        xGlobalCorrelation: xCandidate.globalCorrelation,
        yGlobalCorrelation: yCandidate.globalCorrelation,
        xWithinParticipantCorrelation: xCandidate.withinParticipantCorrelation,
        yWithinParticipantCorrelation: yCandidate.withinParticipantCorrelation,
        affineDistanceRmse,
        xAffineFit: xFit,
        yAffineFit: yFit,
      });
    }
  }
  return pairs
    .sort((left, right) => right.score - left.score || left.affineDistanceRmse - right.affineDistanceRmse)
    .slice(0, maximumPairs);
}

function stripInternalCandidate(candidate) {
  const { spec, ...serializable } = candidate;
  return serializable;
}

function candidatePreview(samples, definition, candidate, maximumRows = 16) {
  if (!candidate) return [];
  const rows = samples
    .map((sample) => ({
      replayId: sample.replayId,
      participantId: sample.participantId,
      championName: sample.championName,
      timestampMillis: sample.timestampMillis,
      rawValue: decodeSpec(sample, candidate.spec),
      labelValue: sample.labels[definition.key],
    }))
    .filter((row) => Number.isFinite(row.rawValue) && Number.isFinite(row.labelValue));
  if (rows.length <= maximumRows) return rows;
  const selected = [];
  for (let index = 0; index < maximumRows; index += 1) {
    selected.push(rows[Math.round((index / (maximumRows - 1)) * (rows.length - 1))]);
  }
  return selected;
}

function analyzeFamily(allSamples, args) {
  const probeSamples = selectProbeSamples(allSamples, args.probeFramesPerParticipant);
  const screen = prepareScreen(probeSamples, TARGETS);
  const collectors = new Map(
    TARGETS.map((definition) => {
      const collector = [];
      collector.maximum = args.screenCandidates;
      return [definition.key, collector];
    }),
  );
  console.error(`  byte scan across ${probeSamples.length} stratified samples...`);
  scanByteFields(allSamples, screen, collectors);
  if (!args.skipBitScan) scanBitFields(allSamples, screen, collectors);

  const evaluated = new Map();
  for (const definition of TARGETS) {
    const seen = new Set();
    const candidates = [];
    for (const screened of collectors.get(definition.key)) {
      const id = describeSpec(screened.spec);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push(evaluateCandidate(allSamples, definition, screened));
    }
    candidates.sort(
      (left, right) =>
        Math.abs(right.withinParticipantCorrelation) -
          Math.abs(left.withinParticipantCorrelation) ||
        Math.abs(right.globalCorrelation) - Math.abs(left.globalCorrelation),
    );
    evaluated.set(definition.key, candidates.slice(0, args.topCandidates));
  }

  const xCandidates = evaluated.get("positionX") ?? [];
  const yCandidates = evaluated.get("positionY") ?? [];
  const metricResults = {};
  for (const definition of TARGETS) {
    const candidates = evaluated.get(definition.key) ?? [];
    const labelValues = allSamples
      .map((sample) => sample.labels[definition.key])
      .filter(Number.isFinite);
    metricResults[definition.key] = {
      labelSampleCount: labelValues.length,
      labelDistinctValueCount: new Set(labelValues).size,
      labelMinimum: labelValues.length ? Math.min(...labelValues) : null,
      labelMaximum: labelValues.length ? Math.max(...labelValues) : null,
      bestClassification: candidates[0]?.classification ?? "no-candidate",
      bestCandidatePreview: candidatePreview(allSamples, definition, candidates[0]),
      candidates: candidates.map(stripInternalCandidate),
    };
  }
  const directExactMetrics = Object.entries(metricResults)
    .filter(([, result]) =>
      result.candidates.some(
        (candidate) => candidate.classification === "direct-exact-validation-match",
      ),
    )
    .map(([key]) => key);
  const stableCorrelatedMetrics = Object.entries(metricResults)
    .filter(([, result]) =>
      result.candidates.some((candidate) =>
        ["stable-strong-correlation", "stable-moderate-correlation"].includes(
          candidate.classification,
        ),
      ),
    )
    .map(([key]) => key);
  return {
    sampleCount: allSamples.length,
    probeSampleCount: probeSamples.length,
    participantTrackCount: new Set(allSamples.map((sample) => sample.participantKey)).size,
    metricResults,
    adjacentCoordinatePairs: scoreCoordinatePairs(
      allSamples,
      xCandidates,
      yCandidates,
      args.topCandidates,
    ),
    promotionAssessment: {
      directExactMetrics,
      stableCorrelatedMetrics,
      note:
        "Packet framing and blockParam ownership are exact. Semantic fields are only exact when a direct transform matches every aligned label in every replay; correlations alone are not runtime promotions.",
    },
  };
}

function summarizeLabels(samples) {
  const result = {};
  for (const definition of TARGETS) {
    const values = samples
      .map((sample) => sample.labels[definition.key])
      .filter(Number.isFinite);
    result[definition.key] = {
      sampleCount: values.length,
      distinctValueCount: new Set(values).size,
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
    };
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  const replayCases = args.replays.map((replayPath, index) =>
    loadReplayCase(
      replayPath,
      args.timelines[index],
      cliPath,
      args.packetTypes,
      args.maximumAlignmentDeltaMillis,
    ),
  );

  const familyReports = [];
  for (const packetType of args.packetTypes) {
    console.error(`Analyzing ${packetTypeHex(packetType)} across ${replayCases.length} replay(s)...`);
    const perReplay = replayCases.map((replayCase) => {
      const built = buildFamilySamples(replayCase, packetType);
      return { replayCase, ...built };
    });
    const allSamples = perReplay.flatMap((entry) => entry.samples);
    familyReports.push({
      packetType,
      packetTypeHex: packetTypeHex(packetType),
      exactStructureByReplay: perReplay.map((entry) => ({
        replayId: entry.replayCase.replayId,
        ...entry.exactStructure,
      })),
      labels: summarizeLabels(allSamples),
      analysis: analyzeFamily(allSamples, args),
    });
  }

  const report = {
    schema: "keyframe-champion-state-discovery/v1",
    generatedAtUtc: new Date().toISOString(),
    runtimeInput: "rofl-exact-packet-dumps-only",
    validationInput: "offline-riot-timeline-frames",
    excludedInputs: [
      "legacy LE-length-prefix subrecords",
      "keyframe slab artifacts",
      "heuristic replay payload carving",
    ],
    cliPath,
    packetTypes: args.packetTypes.map((packetType) => ({
      packetType,
      packetTypeHex: packetTypeHex(packetType),
    })),
    replayCases: replayCases.map((replayCase) => ({
      replayId: replayCase.replayId,
      replayPath: replayCase.replayPath,
      timelinePath: replayCase.timelinePath,
      gameVersion: replayCase.gameVersion,
      versionGroup: replayCase.versionGroup,
      championNetworkIdBase: replayCase.championBase,
      championNetworkIdBaseHex: `0x${replayCase.championBase
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")}`,
      keyframeTimelineFrameCount: replayCase.frames.length,
      nativeKillAnchorCount: replayCase.killEvents.length,
    })),
    discoveryMethod: {
      participantOwnership: "exact kill-derived champion network-id base + blockParam",
      timeAlignment: `nearest offline timeline frame within ${args.maximumAlignmentDeltaMillis} ms`,
      byteEncodings: BYTE_ENCODINGS.map((encoding) => encoding.id),
      bitOrders: args.skipBitScan ? [] : ["little", "big"],
      bitWidths: args.skipBitScan
        ? []
        : [...new Set(TARGETS.flatMap((definition) => definition.bitWidths))].sort(
            (left, right) => left - right,
          ),
      variableLengthAnchors: ["start-relative", "end-relative"],
      correlation: ["global Pearson", "pooled within-participant Pearson", "per-replay"],
      error: ["affine RMSE", "common direct-transform RMSE", "maximum direct error"],
      coordinatePairs: "non-overlapping candidates within 128 adjacent bits",
    },
    families: familyReports,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.outputPath) {
    const outputPath = path.resolve(args.outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
    console.error(`Wrote ${outputPath}`);
  } else {
    process.stdout.write(json);
  }
}

main();
