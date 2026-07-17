import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Research-only ward marker hypotheses. The generated coordinates are deliberately
// kept outside the productive decoder contract. Riot participant frames are used
// only to rank/falsify replay-derived byte transforms.

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SPAWN_PROFILES = Object.freeze({
  "15.22": { high: 0x00dc, companion: 0x00bc },
  "15.23": { high: 0x0393, companion: 0x0060 },
  "15.24": { high: 0x0342, companion: 0x0218 },
  "16.1": { high: 0x02cc, companion: 0x0428 },
  "16.5": { high: 0x0427, companion: 0x01ee },
  "16.6": { high: 0x03d1, companion: 0x034b },
  "16.7": { high: 0x0449, companion: 0x0219 },
  "16.9": { high: 0x00d6, companion: 0x01ad },
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    versionGroup: "16.9",
    replayId: null,
    outputPath: path.join("artifacts", "ward-position-hypotheses-16.9.json"),
    oracleWindowMillis: 5000,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli") args.cliPath = argv[++index];
    else if (arg === "--replay-dir") args.replayDir = argv[++index];
    else if (arg === "--api-root") args.apiRoot = argv[++index];
    else if (arg === "--version-group") args.versionGroup = argv[++index];
    else if (arg === "--replay-id") args.replayId = argv[++index].replace("_", "-");
    else if (arg === "--output") args.outputPath = argv[++index];
    else if (arg === "--oracle-window-ms") args.oracleWindowMillis = Number(argv[++index]);
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function discoverFixtures(args) {
  return fs.readdirSync(path.resolve(args.apiRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const replayId = entry.name.replace("_", "-");
      const replayPath = path.resolve(args.replayDir, `${replayId}.rofl`);
      const matchPath = path.resolve(args.apiRoot, entry.name, "match.json");
      const timelinePath = path.resolve(args.apiRoot, entry.name, "timeline.json");
      if (![replayPath, matchPath, timelinePath].every(fs.existsSync)) return null;
      const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
      return { replayId, replayPath, timelinePath, versionGroup: versionGroup(match.info?.gameVersion) };
    })
    .filter(Boolean)
    .filter((fixture) => fixture.versionGroup === args.versionGroup)
    .filter((fixture) => !args.replayId || fixture.replayId === args.replayId)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function findFooterRecords(bytes, metadataOffset) {
  const records = [];
  let cursor = 0;
  while (cursor < metadataOffset) {
    const payloadOffset = bytes.indexOf(ZSTD_MAGIC, cursor);
    if (payloadOffset < 0 || payloadOffset >= metadataOffset) break;
    cursor = payloadOffset + 1;
    const headerOffset = payloadOffset - 17;
    if (headerOffset < 0) continue;
    const kind = bytes[headerOffset + 8];
    const uncompressedLength = bytes.readUInt32LE(headerOffset + 9);
    const compressedLength = bytes.readUInt32LE(headerOffset + 13);
    if (kind < 1 || kind > 3 || compressedLength < 4 || uncompressedLength === 0) continue;
    if (payloadOffset + compressedLength > metadataOffset) continue;
    if ([1, 2, 3, 5, 6, 7].some((offset) => bytes[headerOffset + offset] !== 0)) continue;
    records.push({
      segmentId: bytes[headerOffset], chunkId: bytes[headerOffset + 4], kind,
      payloadOffset, compressedLength,
    });
  }
  return records.sort((left, right) => left.payloadOffset - right.payloadOffset);
}

function parsePacketStream(payload, record) {
  const blocks = [];
  let cursor = 0;
  let timestampSeconds = 0;
  let previousPacketType = 0;
  let previousBlockParam = 0;
  let blockIndex = 0;
  while (cursor < payload.length) {
    const marker = payload[cursor++];
    if (marker & 0x80) timestampSeconds += payload[cursor++] * 0.001;
    else { timestampSeconds = payload.readFloatLE(cursor); cursor += 4; }
    const contentLength = marker & 0x10 ? payload[cursor++] : payload.readUInt32LE(cursor);
    if (!(marker & 0x10)) cursor += 4;
    const packetType = marker & 0x40 ? previousPacketType : payload.readUInt16LE(cursor);
    if (!(marker & 0x40)) cursor += 2;
    const blockParam = marker & 0x20
      ? (previousBlockParam + payload.readInt8(cursor++)) >>> 0
      : payload.readUInt32LE(cursor);
    if (!(marker & 0x20)) cursor += 4;
    const endOffset = cursor + contentLength;
    if (endOffset > payload.length) throw new Error(`Packet overrun in segment ${record.segmentId}.`);
    blocks.push({
      packetType, blockParam, contentLength, blockIndex,
      timestampMillis: Math.round(timestampSeconds * 1000),
      payload: Buffer.from(payload.subarray(cursor, endOffset)),
    });
    previousPacketType = packetType;
    previousBlockParam = blockParam;
    cursor = endOffset;
    blockIndex += 1;
  }
  return blocks;
}

function extractWards(cliPath, replayPath) {
  const result = spawnSync(cliPath, ["--extract-replay-wards-json", replayPath], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim());
  return JSON.parse(result.stdout);
}

function nearestFrameOracle(timeline, participantId, timestampMillis, windowMillis) {
  let best = null;
  for (const frame of timeline.info?.frames ?? []) {
    const position = frame.participantFrames?.[String(participantId)]?.position;
    if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) continue;
    const deltaMillis = Math.abs((frame.timestamp ?? 0) - timestampMillis);
    if (deltaMillis > windowMillis || (best && best.deltaMillis <= deltaMillis)) continue;
    best = { x: position.x, y: position.y, deltaMillis };
  }
  return best;
}

function collectRows(args, fixtures) {
  const profile = SPAWN_PROFILES[args.versionGroup];
  if (!profile) throw new Error(`No spawn profile for ${args.versionGroup}.`);
  const rows = [];
  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    console.log(`[${fixtureIndex + 1}/${fixtures.length}] ${fixture.replayId}`);
    const wardResult = extractWards(path.resolve(args.cliPath), fixture.replayPath);
    const placements = wardResult.events.filter((event) => event.type === "WARD_PLACED");
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const bytes = fs.readFileSync(fixture.replayPath);
    const metadataLength = bytes.readUInt32LE(bytes.length - 4);
    const records = findFooterRecords(bytes, bytes.length - 4 - metadataLength);
    const segments = new Map();
    for (const record of records.filter((entry) => entry.kind === 1)) {
      const decompressed = zlib.zstdDecompressSync(bytes.subarray(
        record.payloadOffset, record.payloadOffset + record.compressedLength,
      ));
      segments.set(`${record.segmentId}:${record.chunkId}`, parsePacketStream(decompressed, record));
    }
    for (const placement of placements) {
      const marker = placement.provenance.markerBlock;
      const blocks = segments.get(`${marker.segmentId}:${marker.chunkId}`) ?? [];
      const before = blocks.slice(Math.max(0, marker.blockIndex - 48), marker.blockIndex)
        .filter((block) => block.blockParam === placement.wardEntityNetworkId)
        .filter((block) => Math.abs(block.timestampMillis - placement.timestampMillis) <= 1);
      const high = before.filter((block) => block.packetType === profile.high).at(-1);
      const companion = before.filter((block) => block.packetType === profile.companion).at(-1);
      if (!high || !companion) continue;
      rows.push({
        replayId: fixture.replayId,
        versionGroup: fixture.versionGroup,
        wardEntityNetworkId: placement.wardEntityNetworkId,
        ownerParticipantId: placement.ownerParticipantId,
        timestampMillis: placement.timestampMillis,
        oracle: nearestFrameOracle(
          timeline, placement.ownerParticipantId, placement.timestampMillis,
          args.oracleWindowMillis,
        ),
        high: high.payload,
        companion: companion.payload,
      });
    }
  }
  return rows;
}

function reverseBits(byte) {
  let value = byte;
  value = ((value & 0xf0) >>> 4) | ((value & 0x0f) << 4);
  value = ((value & 0xcc) >>> 2) | ((value & 0x33) << 2);
  return ((value & 0xaa) >>> 1) | ((value & 0x55) << 1);
}

function featureDefinitions(role, maximumLength) {
  const features = [];
  const add = (name, read) => features.push({ name: `${role}.${name}`, role, read });
  for (let offset = 0; offset < maximumLength; offset += 1) {
    add(`u8@${offset}`, (payload) => payload[offset]);
    add(`xor-d5-u8@${offset}`, (payload) => payload[offset] ^ 0xd5);
    add(`bitrev-u8@${offset}`, (payload) => reverseBits(payload[offset]));
  }
  for (let offset = 0; offset + 2 <= maximumLength; offset += 1) {
    add(`u16le@${offset}`, (payload) => payload.readUInt16LE(offset));
    add(`u16be@${offset}`, (payload) => payload.readUInt16BE(offset));
    add(`xor-d5-u16le@${offset}`, (payload) =>
      ((payload[offset] ^ 0xd5) | ((payload[offset + 1] ^ 0xd5) << 8)) >>> 0);
    add(`delta-u8@${offset}`, (payload) => payload[offset + 1] - payload[offset]);
  }
  for (let offset = 0; offset + 3 <= maximumLength; offset += 1) {
    add(`u24le@${offset}`, (payload) => payload.readUIntLE(offset, 3));
    add(`u24be@${offset}`, (payload) => payload.readUIntBE(offset, 3));
  }
  for (let offset = 0; offset + 5 <= maximumLength; offset += 1) {
    add(`stride2-u24le@${offset}`, (payload) =>
      payload[offset] | (payload[offset + 2] << 8) | (payload[offset + 4] << 16));
    add(`stride2-u24be@${offset}`, (payload) =>
      (payload[offset] << 16) | (payload[offset + 2] << 8) | payload[offset + 4]);
    add(`xor-d5-stride2-u24le@${offset}`, (payload) =>
      (payload[offset] ^ 0xd5) |
      ((payload[offset + 2] ^ 0xd5) << 8) |
      ((payload[offset + 4] ^ 0xd5) << 16));
  }
  return features;
}

function fitLinear(samples, feature, axis, excludedReplayId = null) {
  const data = samples.filter((row) => row.oracle && row.replayId !== excludedReplayId)
    .map((row) => ({ value: feature.read(row[feature.role]), target: row.oracle[axis] }))
    .filter((entry) => Number.isFinite(entry.value) && Number.isFinite(entry.target));
  const meanValue = data.reduce((sum, row) => sum + row.value, 0) / data.length;
  const meanTarget = data.reduce((sum, row) => sum + row.target, 0) / data.length;
  let covariance = 0;
  let variance = 0;
  for (const row of data) {
    covariance += (row.value - meanValue) * (row.target - meanTarget);
    variance += (row.value - meanValue) ** 2;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  return { slope, intercept: meanTarget - (slope * meanValue), support: data.length };
}

function predict(model, feature, row) {
  return model.intercept + (model.slope * feature.read(row[feature.role]));
}

function scoreFeature(rows, feature, axis) {
  const model = fitLinear(rows, feature, axis);
  let squaredError = 0;
  let absoluteError = 0;
  let support = 0;
  for (const replayId of new Set(rows.map((row) => row.replayId))) {
    const foldModel = fitLinear(rows, feature, axis, replayId);
    for (const row of rows.filter((entry) => entry.replayId === replayId && entry.oracle)) {
      const value = predict(foldModel, feature, row);
      const error = value - row.oracle[axis];
      squaredError += error ** 2;
      absoluteError += Math.abs(error);
      support += 1;
    }
  }
  return {
    feature: feature.name,
    role: feature.role,
    axis,
    slope: model.slope,
    intercept: model.intercept,
    support: model.support,
    crossReplayRmse: Math.sqrt(squaredError / support),
    crossReplayMae: absoluteError / support,
  };
}

function createHypotheses(rows, featureMap, rankedX, rankedY) {
  const selected = [];
  const seen = new Set();
  for (const x of rankedX.slice(0, 30)) {
    for (const y of rankedY.slice(0, 30)) {
      if (x.feature === y.feature) continue;
      const familyKey = `${x.role}:${x.feature.split("@")[0]}|${y.role}:${y.feature.split("@")[0]}`;
      if (seen.has(familyKey)) continue;
      seen.add(familyKey);
      const xFeature = featureMap.get(x.feature);
      const yFeature = featureMap.get(y.feature);
      let squaredDistance = 0;
      let absoluteDistance = 0;
      let inBounds = 0;
      let support = 0;
      for (const replayId of new Set(rows.map((row) => row.replayId))) {
        const xModel = fitLinear(rows, xFeature, "x", replayId);
        const yModel = fitLinear(rows, yFeature, "y", replayId);
        for (const row of rows.filter((entry) => entry.replayId === replayId && entry.oracle)) {
          const predictedX = predict(xModel, xFeature, row);
          const predictedY = predict(yModel, yFeature, row);
          const distance = Math.hypot(predictedX - row.oracle.x, predictedY - row.oracle.y);
          squaredDistance += distance ** 2;
          absoluteDistance += distance;
          if (predictedX >= 0 && predictedX <= 15000 && predictedY >= 0 && predictedY <= 15000) {
            inBounds += 1;
          }
          support += 1;
        }
      }
      selected.push({
        x, y, crossReplayRmseDistance: Math.sqrt(squaredDistance / support),
        crossReplayMeanDistance: absoluteDistance / support,
        crossReplayInBoundsRate: inBounds / support,
      });
    }
  }
  return selected.sort((left, right) =>
    left.crossReplayMeanDistance - right.crossReplayMeanDistance
  ).slice(0, 8).map((entry, index) => ({ id: `H${index + 1}`, ...entry }));
}

function main() {
  const args = parseArgs(process.argv);
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No matching fixtures found.");
  const rows = collectRows(args, fixtures);
  const oracleRows = rows.filter((row) => row.oracle);
  const maximumHighLength = Math.min(...oracleRows.map((row) => row.high.length));
  const maximumCompanionLength = Math.min(...oracleRows.map((row) => row.companion.length));
  const features = [
    ...featureDefinitions("high", maximumHighLength),
    ...featureDefinitions("companion", maximumCompanionLength),
  ];
  const featureMap = new Map(features.map((feature) => [feature.name, feature]));
  const rankedX = features.map((feature) => scoreFeature(rows, feature, "x"))
    .sort((left, right) => left.crossReplayMae - right.crossReplayMae);
  const rankedY = features.map((feature) => scoreFeature(rows, feature, "y"))
    .sort((left, right) => left.crossReplayMae - right.crossReplayMae);
  const hypotheses = createHypotheses(rows, featureMap, rankedX, rankedY);
  const markersByReplay = Object.fromEntries(fixtures.map((fixture) => [
    fixture.replayId,
    rows.filter((row) => row.replayId === fixture.replayId).map((row) => ({
      wardEntityNetworkId: row.wardEntityNetworkId,
      ownerParticipantId: row.ownerParticipantId,
      timestampMillis: row.timestampMillis,
      candidates: Object.fromEntries(hypotheses.map((hypothesis) => {
        const xFeature = featureMap.get(hypothesis.x.feature);
        const yFeature = featureMap.get(hypothesis.y.feature);
        const x = predict(hypothesis.x, xFeature, row);
        const y = predict(hypothesis.y, yFeature, row);
        return [hypothesis.id, {
          x: Math.round(x), y: Math.round(y),
          inBounds: x >= 0 && x <= 15000 && y >= 0 && y <= 15000,
        }];
      })),
    })),
  ]));
  const report = {
    schema: "rofl-ward-position-marker-hypotheses/v1",
    generatedAtUtc: new Date().toISOString(),
    promotionGate: false,
    runtimeInput: "ROFL packet payloads only",
    offlineRankingOracle: "Riot participant-frame position nearest placement (not ward position)",
    warning: "All coordinates are research hypotheses; visual plausibility cannot promote them.",
    parameters: args,
    totals: { replayCount: fixtures.length, placementCount: rows.length, oracleCount: oracleRows.length },
    hypotheses,
    topAxisFeatures: { x: rankedX.slice(0, 20), y: rankedY.slice(0, 20) },
    markersByReplay,
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
  console.log(JSON.stringify({ totals: report.totals, hypotheses }, null, 2));
}

main();
