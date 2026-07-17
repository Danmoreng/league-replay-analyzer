import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    replayPath: null,
    timelinePath: null,
    cliPath: path.resolve("build/packages/rofl-core/rofl_core_cli.exe"),
    outputPath: null,
    packetTypes: [],
    maximumPacketTypes: 16,
    minimumOwnerCoverage: 8,
    minimumGroupSamples: 24,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replay" && index + 1 < argv.length) {
      args.replayPath = argv[++index];
    } else if (arg === "--timeline" && index + 1 < argv.length) {
      args.timelinePath = argv[++index];
    } else if (arg === "--cli" && index + 1 < argv.length) {
      args.cliPath = argv[++index];
    } else if (arg === "--output" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--packet-types" && index + 1 < argv.length) {
      args.packetTypes = argv[++index]
        .split(",")
        .filter(Boolean)
        .map((value) => Number.parseInt(value, 0));
    } else if (arg === "--max-packet-types" && index + 1 < argv.length) {
      args.maximumPacketTypes = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-owner-coverage" && index + 1 < argv.length) {
      args.minimumOwnerCoverage = Number.parseInt(argv[++index], 10);
    } else if (arg === "--min-group-samples" && index + 1 < argv.length) {
      args.minimumGroupSamples = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.replayPath || !args.timelinePath) {
    throw new Error("Both --replay <path> and --timeline <path> are required.");
  }
  return args;
}

function printHelp() {
  console.log(
    "Usage: node ./scripts/discover_packet_movement.mjs --replay <file.rofl> --timeline <timeline.json> " +
      "[--cli <rofl_core_cli.exe>] [--output <report.json>] [--packet-types 0x123,0x456] " +
      "[--max-packet-types 16] [--min-owner-coverage 8] [--min-group-samples 24]",
  );
}

function runCli(cliPath, args) {
  const output = execFileSync(cliPath, args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output);
}

function formatPacketType(packetType) {
  return `0x${packetType.toString(16).toUpperCase().padStart(4, "0")}`;
}

function readTimelineAnchors(timelinePath) {
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const anchors = [];

  for (const frame of timeline?.info?.frames ?? []) {
    for (const [participantIdText, participantFrame] of Object.entries(
      frame.participantFrames ?? {},
    )) {
      const position = participantFrame?.position;
      if (
        !position ||
        !Number.isFinite(position.x) ||
        !Number.isFinite(position.y) ||
        !Number.isFinite(frame.timestamp)
      ) {
        continue;
      }
      anchors.push({
        participantId: Number(participantIdText),
        timestampMillis: frame.timestamp,
        x: position.x,
        y: position.y,
        source: "timeline-frame",
        toleranceMillis: 2500,
      });
    }

    for (const event of frame.events ?? []) {
      if (
        event.type !== "CHAMPION_KILL" ||
        !event.position ||
        !Number.isFinite(event.victimId) ||
        event.victimId <= 0
      ) {
        continue;
      }
      anchors.push({
        participantId: event.victimId,
        timestampMillis: event.timestamp,
        x: event.position.x,
        y: event.position.y,
        source: "kill-victim",
        toleranceMillis: 1200,
      });
    }
  }

  return anchors.filter(
    (anchor) =>
      anchor.participantId >= 1 &&
      anchor.participantId <= 10 &&
      anchor.x >= 0 &&
      anchor.x <= 15000 &&
      anchor.y >= 0 &&
      anchor.y <= 15000,
  );
}

function selectPacketTypes(catalog, championBase, args) {
  if (args.packetTypes.length > 0) {
    return args.packetTypes.map((packetType) => ({
      packetType,
      packetTypeHex: formatPacketType(packetType),
      ownerCoverage: null,
      championOwnedTopCount: null,
      catalogCount: null,
      minimumContentLength: null,
      maximumContentLength: null,
      explicit: true,
    }));
  }

  const championNetworkIds = new Set(
    Array.from({ length: 10 }, (_, index) => championBase + index + 1),
  );

  return (catalog.packetTypes ?? [])
    .map((group) => {
      const championOwners = (group.topBlockParams ?? []).filter((entry) =>
        championNetworkIds.has(entry.blockParam),
      );
      return {
        packetType: group.packetType,
        packetTypeHex: formatPacketType(group.packetType),
        ownerCoverage: championOwners.length,
        championOwnedTopCount: championOwners.reduce(
          (sum, entry) => sum + entry.count,
          0,
        ),
        catalogCount: group.count,
        minimumContentLength: group.minimumContentLength,
        maximumContentLength: group.maximumContentLength,
        explicit: false,
      };
    })
    .filter(
      (group) =>
        group.ownerCoverage >= args.minimumOwnerCoverage &&
        group.championOwnedTopCount >= 100 &&
        group.minimumContentLength >= 4 &&
        group.maximumContentLength <= 64,
    )
    .sort(
      (left, right) =>
        right.ownerCoverage - left.ownerCoverage ||
        right.championOwnedTopCount - left.championOwnedTopCount ||
        left.packetType - right.packetType,
    )
    .slice(0, args.maximumPacketTypes);
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(Math.floor(hex.length / 2));
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function groupChampionBlocks(dump, championBase) {
  const groups = new Map();
  for (const block of dump.blocks ?? []) {
    const participantId = block.blockParam - championBase;
    if (
      participantId < 1 ||
      participantId > 10 ||
      block.contentHexTruncated ||
      block.contentHexBytes !== block.contentLength
    ) {
      continue;
    }
    const key = `${block.packetType}|${block.contentLength}`;
    const group = groups.get(key) ?? {
      packetType: block.packetType,
      packetTypeHex: formatPacketType(block.packetType),
      contentLength: block.contentLength,
      blocks: [],
    };
    group.blocks.push({
      participantId,
      timestampMillis: block.timestampMillis,
      payload: hexToBytes(block.contentHex),
      provenance: {
        chunkId: block.chunkId,
        segmentId: block.segmentId,
        blockIndex: block.blockIndex,
      },
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}

function nearestBlock(blocks, timestampMillis, toleranceMillis) {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle].timestampMillis < timestampMillis) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  const candidates = [blocks[low - 1], blocks[low]].filter(Boolean);
  let best = null;
  for (const candidate of candidates) {
    const deltaMillis = Math.abs(candidate.timestampMillis - timestampMillis);
    if (deltaMillis > toleranceMillis) {
      continue;
    }
    if (!best || deltaMillis < best.deltaMillis) {
      best = { block: candidate, deltaMillis };
    }
  }
  return best;
}

function alignGroupToAnchors(group, anchors) {
  const blocksByParticipant = new Map();
  for (const block of group.blocks) {
    const list = blocksByParticipant.get(block.participantId) ?? [];
    list.push(block);
    blocksByParticipant.set(block.participantId, list);
  }
  for (const blocks of blocksByParticipant.values()) {
    blocks.sort((left, right) => left.timestampMillis - right.timestampMillis);
  }

  const samples = [];
  for (const anchor of anchors) {
    const blocks = blocksByParticipant.get(anchor.participantId);
    if (!blocks?.length) {
      continue;
    }
    const nearest = nearestBlock(
      blocks,
      anchor.timestampMillis,
      anchor.toleranceMillis,
    );
    if (!nearest) {
      continue;
    }
    samples.push({
      participantId: anchor.participantId,
      anchorTimestampMillis: anchor.timestampMillis,
      packetTimestampMillis: nearest.block.timestampMillis,
      deltaMillis: nearest.deltaMillis,
      x: anchor.x,
      y: anchor.y,
      source: anchor.source,
      payload: nearest.block.payload,
      provenance: nearest.block.provenance,
    });
  }
  return samples;
}

function readBitsLittleEndian(bytes, offset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) {
    const absoluteBit = offset + bit;
    const byte = bytes[Math.floor(absoluteBit / 8)];
    const bitValue = (byte >> (absoluteBit % 8)) & 1;
    value += bitValue * 2 ** bit;
  }
  return value;
}

function readBitsBigEndian(bytes, offset, width) {
  let value = 0;
  for (let bit = 0; bit < width; bit += 1) {
    const absoluteBit = offset + bit;
    const byte = bytes[Math.floor(absoluteBit / 8)];
    const bitValue = (byte >> (7 - (absoluteBit % 8))) & 1;
    value = value * 2 + bitValue;
  }
  return value;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function correlation(left, right) {
  if (left.length < 3 || left.length !== right.length) {
    return 0;
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSquare = 0;
  let rightSquare = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquare += leftDelta * leftDelta;
    rightSquare += rightDelta * rightDelta;
  }
  const denominator = Math.sqrt(leftSquare * rightSquare);
  return denominator > 0 ? numerator / denominator : 0;
}

function fitAffine(rawValues, targets) {
  const rawMean = mean(rawValues);
  const targetMean = mean(targets);
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < rawValues.length; index += 1) {
    const rawDelta = rawValues[index] - rawMean;
    covariance += rawDelta * (targets[index] - targetMean);
    variance += rawDelta * rawDelta;
  }
  const slope = variance > 0 ? covariance / variance : 0;
  const intercept = targetMean - slope * rawMean;
  const predictions = rawValues.map((value) => slope * value + intercept);
  const rmse = Math.sqrt(
    mean(
      predictions.map((prediction, index) => {
        const delta = prediction - targets[index];
        return delta * delta;
      }),
    ),
  );
  return {
    slope,
    intercept,
    rmse,
    normalizedRmse: rmse / 15000,
    predictions,
  };
}

function averageParticipantCorrelation(samples, rawValues, targetKey) {
  const byParticipant = new Map();
  for (let index = 0; index < samples.length; index += 1) {
    const list = byParticipant.get(samples[index].participantId) ?? [];
    list.push({
      raw: rawValues[index],
      target: samples[index][targetKey],
    });
    byParticipant.set(samples[index].participantId, list);
  }

  const correlations = [];
  for (const list of byParticipant.values()) {
    if (list.length < 4) {
      continue;
    }
    correlations.push(
      Math.abs(
        correlation(
          list.map((entry) => entry.raw),
          list.map((entry) => entry.target),
        ),
      ),
    );
  }
  return correlations.length > 0 ? mean(correlations) : 0;
}

function scoreFields(samples, targetKey) {
  const bitLength = samples[0].payload.length * 8;
  const fields = [];
  for (const bitOrder of ["little", "big"]) {
    for (let width = 10; width <= 18; width += 1) {
      for (let offset = 0; offset + width <= bitLength; offset += 1) {
        const rawValues = samples.map((sample) =>
          bitOrder === "little"
            ? readBitsLittleEndian(sample.payload, offset, width)
            : readBitsBigEndian(sample.payload, offset, width),
        );
        if (new Set(rawValues).size < 5) {
          continue;
        }
        const targets = samples.map((sample) => sample[targetKey]);
        const axisCorrelation = correlation(rawValues, targets);
        const participantCorrelation = averageParticipantCorrelation(
          samples,
          rawValues,
          targetKey,
        );
        const fit = fitAffine(rawValues, targets);
        const score =
          Math.abs(axisCorrelation) * 0.45 +
          participantCorrelation * 0.45 +
          Math.max(0, 1 - fit.normalizedRmse * 3) * 0.1;
        fields.push({
          bitOrder,
          offset,
          width,
          score,
          correlation: axisCorrelation,
          averageParticipantCorrelation: participantCorrelation,
          slope: fit.slope,
          intercept: fit.intercept,
          normalizedRmse: fit.normalizedRmse,
          rawValues,
          predictions: fit.predictions,
        });
      }
    }
  }
  return fields
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.averageParticipantCorrelation -
          left.averageParticipantCorrelation ||
        Math.abs(right.correlation) - Math.abs(left.correlation),
    )
    .slice(0, 64);
}

const directCoordinateTransforms = [
  { id: "raw", apply: (raw) => raw },
  { id: "raw-plus-4096", apply: (raw) => raw + 4096 },
  { id: "raw-times-2", apply: (raw) => raw * 2 },
  { id: "raw-times-4", apply: (raw) => raw * 4 },
  { id: "raw-times-8", apply: (raw) => raw * 8 },
  { id: "raw-times-16", apply: (raw) => raw * 16 },
  { id: "raw-times-32", apply: (raw) => raw * 32 },
  { id: "16384-minus-raw", apply: (raw) => 16384 - raw },
  { id: "16384-minus-raw-times-2", apply: (raw) => 16384 - raw * 2 },
  { id: "16384-minus-raw-times-4", apply: (raw) => 16384 - raw * 4 },
  { id: "16384-minus-raw-times-8", apply: (raw) => 16384 - raw * 8 },
  { id: "16384-minus-raw-times-16", apply: (raw) => 16384 - raw * 16 },
  { id: "16384-minus-raw-times-32", apply: (raw) => 16384 - raw * 32 },
];

function scoreDirectFields(samples, targetKey) {
  const bitLength = samples[0].payload.length * 8;
  const targets = samples.map((sample) => sample[targetKey]);
  const fields = [];
  for (const bitOrder of ["little", "big"]) {
    for (let width = 10; width <= 16; width += 1) {
      for (let offset = 0; offset + width <= bitLength; offset += 1) {
        const rawValues = samples.map((sample) =>
          bitOrder === "little"
            ? readBitsLittleEndian(sample.payload, offset, width)
            : readBitsBigEndian(sample.payload, offset, width),
        );
        if (new Set(rawValues).size < 5) {
          continue;
        }
        for (const transform of directCoordinateTransforms) {
          const decodedValues = rawValues.map(transform.apply);
          let squaredError = 0;
          let inBoundsCount = 0;
          for (let index = 0; index < decodedValues.length; index += 1) {
            const delta = decodedValues[index] - targets[index];
            squaredError += delta * delta;
            if (decodedValues[index] >= 0 && decodedValues[index] <= 15000) {
              inBoundsCount += 1;
            }
          }
          const normalizedRmse =
            Math.sqrt(squaredError / decodedValues.length) / 15000;
          const axisCorrelation = correlation(decodedValues, targets);
          const participantCorrelation = averageParticipantCorrelation(
            samples,
            decodedValues,
            targetKey,
          );
          const inBoundsRatio = inBoundsCount / decodedValues.length;
          const score =
            Math.max(0, 1 - normalizedRmse * 2.5) * 0.5 +
            Math.abs(axisCorrelation) * 0.2 +
            participantCorrelation * 0.2 +
            inBoundsRatio * 0.1;
          fields.push({
            bitOrder,
            offset,
            width,
            transform: transform.id,
            score,
            correlation: axisCorrelation,
            averageParticipantCorrelation: participantCorrelation,
            normalizedRmse,
            inBoundsRatio,
          });
        }
      }
    }
  }
  return fields
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.normalizedRmse - right.normalizedRmse ||
        right.averageParticipantCorrelation -
          left.averageParticipantCorrelation,
    )
    .slice(0, 64);
}

function rangesOverlap(left, right) {
  return (
    left.bitOrder === right.bitOrder &&
    left.offset < right.offset + right.width &&
    right.offset < left.offset + left.width
  );
}

function scorePairs(samples, xFields, yFields) {
  const pairs = [];
  for (const xField of xFields) {
    for (const yField of yFields) {
      if (rangesOverlap(xField, yField)) {
        continue;
      }
      let squaredDistance = 0;
      let inBounds = 0;
      for (let index = 0; index < samples.length; index += 1) {
        const predictedX = xField.predictions[index];
        const predictedY = yField.predictions[index];
        const dx = predictedX - samples[index].x;
        const dy = predictedY - samples[index].y;
        squaredDistance += dx * dx + dy * dy;
        if (
          predictedX >= 0 &&
          predictedX <= 15000 &&
          predictedY >= 0 &&
          predictedY <= 15000
        ) {
          inBounds += 1;
        }
      }
      const normalizedDistanceRmse =
        Math.sqrt(squaredDistance / samples.length) / 15000;
      const inBoundsRatio = inBounds / samples.length;
      const score =
        (xField.score + yField.score) * 0.4 +
        Math.max(0, 1 - normalizedDistanceRmse * 3) * 0.15 +
        inBoundsRatio * 0.05;
      pairs.push({
        score,
        normalizedDistanceRmse,
        inBoundsRatio,
        xField,
        yField,
      });
    }
  }
  return pairs
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.normalizedDistanceRmse - right.normalizedDistanceRmse,
    )
    .slice(0, 12);
}

function compactField(field) {
  return {
    bitOrder: field.bitOrder,
    offset: field.offset,
    width: field.width,
    score: field.score,
    correlation: field.correlation,
    averageParticipantCorrelation: field.averageParticipantCorrelation,
    slope: field.slope,
    intercept: field.intercept,
    normalizedRmse: field.normalizedRmse,
  };
}

function buildCandidateSet(samples) {
  const xFields = scoreFields(samples, "x");
  const yFields = scoreFields(samples, "y");
  const directXFields = scoreDirectFields(samples, "x");
  const directYFields = scoreDirectFields(samples, "y");
  const topPairs = scorePairs(samples, xFields, yFields).map((pair) => ({
    score: pair.score,
    normalizedDistanceRmse: pair.normalizedDistanceRmse,
    inBoundsRatio: pair.inBoundsRatio,
    xField: compactField(pair.xField),
    yField: compactField(pair.yField),
    samplePreview: samples.slice(0, 24).map((sample, index) => ({
      participantId: sample.participantId,
      source: sample.source,
      anchorTimestampMillis: sample.anchorTimestampMillis,
      packetTimestampMillis: sample.packetTimestampMillis,
      deltaMillis: sample.deltaMillis,
      actualX: sample.x,
      actualY: sample.y,
      rawX: pair.xField.rawValues[index],
      rawY: pair.yField.rawValues[index],
      predictedX: pair.xField.predictions[index],
      predictedY: pair.yField.predictions[index],
      payloadHex: Buffer.from(sample.payload).toString("hex"),
    })),
  }));
  return {
    topXFields: xFields.map(compactField),
    topYFields: yFields.map(compactField),
    topDirectXFields: directXFields,
    topDirectYFields: directYFields,
    topPairs,
  };
}

function probeWaypointEncoding(samples, encoding) {
  if (
    samples.length === 0 ||
    samples.some((sample) => {
      const totalBits = sample.payload.length * 8;
      return (
        encoding.xOffset(totalBits) < 0 ||
        encoding.yOffset(totalBits) < 0 ||
        encoding.xOffset(totalBits) + encoding.width > totalBits ||
        encoding.yOffset(totalBits) + encoding.width > totalBits
      );
    })
  ) {
    return null;
  }
  const decodedX = [];
  const decodedY = [];
  const actualX = [];
  const actualY = [];
  let inBoundsCount = 0;
  let squaredDistance = 0;
  const preview = [];

  for (const sample of samples) {
    const totalBits = sample.payload.length * 8;
    const rawX = readBitsLittleEndian(
      sample.payload,
      encoding.xOffset(totalBits),
      encoding.width,
    );
    const rawY = readBitsLittleEndian(
      sample.payload,
      encoding.yOffset(totalBits),
      encoding.width,
    );
    const x = (encoding.decodeX ?? encoding.decode)(rawX);
    const y = (encoding.decodeY ?? encoding.decode)(rawY);
    decodedX.push(x);
    decodedY.push(y);
    actualX.push(sample.x);
    actualY.push(sample.y);
    const dx = x - sample.x;
    const dy = y - sample.y;
    squaredDistance += dx * dx + dy * dy;
    if (x >= 0 && x <= 15000 && y >= 0 && y <= 15000) {
      inBoundsCount += 1;
    }
    if (preview.length < 24) {
      preview.push({
        participantId: sample.participantId,
        source: sample.source,
        anchorTimestampMillis: sample.anchorTimestampMillis,
        packetTimestampMillis: sample.packetTimestampMillis,
        deltaMillis: sample.deltaMillis,
        actualX: sample.x,
        actualY: sample.y,
        rawX,
        rawY,
        decodedX: x,
        decodedY: y,
        distance: Math.sqrt(dx * dx + dy * dy),
        payloadHex: Buffer.from(sample.payload).toString("hex"),
      });
    }
  }

  return {
    id: encoding.id,
    encoding: {
      bitOrder: "little",
      x: {
        offset: encoding.xOffsetDescription,
        width: encoding.width,
        transform: encoding.xTransformDescription ?? encoding.transformDescription,
      },
      y: {
        offset: encoding.yOffsetDescription,
        width: encoding.width,
        transform: encoding.yTransformDescription ?? encoding.transformDescription,
      },
    },
    sampleCount: samples.length,
    participantCount: new Set(samples.map((sample) => sample.participantId)).size,
    xCorrelation: correlation(decodedX, actualX),
    yCorrelation: correlation(decodedY, actualY),
    averageParticipantXCorrelation: averageParticipantCorrelation(
      samples,
      decodedX,
      "x",
    ),
    averageParticipantYCorrelation: averageParticipantCorrelation(
      samples,
      decodedY,
      "y",
    ),
    normalizedDistanceRmse:
      Math.sqrt(squaredDistance / samples.length) / 15000,
    inBoundsRatio: inBoundsCount / samples.length,
    samplePreview: preview,
  };
}

function signedBitField(raw, width) {
  const signBit = 2 ** (width - 1);
  return raw >= signBit ? raw - 2 ** width : raw;
}
const knownWaypointEncodings = [
  {
    id: "signed-13bit-times2-world-offset",
    width: 13,
    xOffset: () => 2,
    yOffset: () => 65,
    xOffsetDescription: "2",
    yOffsetDescription: "65",
    decodeX: (raw) => signedBitField(raw, 13) * 2 + 7358,
    decodeY: (raw) => signedBitField(raw, 13) * 2 + 7412,
    xTransformDescription: "signed13(raw) * 2 + 7358",
    yTransformDescription: "signed13(raw) * 2 + 7412",
  },
  {
    id: "tail-13bit-plus4096",
    width: 13,
    xOffset: (totalBits) => totalBits - 18,
    yOffset: (totalBits) => totalBits - 82,
    xOffsetDescription: "totalBits - 18",
    yOffsetDescription: "totalBits - 82",
    decode: (raw) => raw + 4096,
    transformDescription: "raw + 4096",
  },
  {
    id: "absolute-13bit-times4",
    width: 13,
    xOffset: () => 2,
    yOffset: () => 65,
    xOffsetDescription: "2",
    yOffsetDescription: "65",
    decode: (raw) => raw * 4,
    transformDescription: "raw * 4",
  },
];

function probeKnownWaypointEncodings(samples) {
  return knownWaypointEncodings
    .map((encoding) => probeWaypointEncoding(samples, encoding))
    .filter(Boolean);
}

function analyzeGroup(group, anchors, minimumGroupSamples) {
  const samples = alignGroupToAnchors(group, anchors);
  const participantCount = new Set(samples.map((sample) => sample.participantId)).size;
  if (samples.length < minimumGroupSamples || participantCount < 5) {
    return {
      packetType: group.packetType,
      packetTypeHex: group.packetTypeHex,
      contentLength: group.contentLength,
      blockCount: group.blocks.length,
      alignedSampleCount: samples.length,
      participantCount,
      status: "insufficient-samples",
      topPairs: [],
    };
  }

  const candidateSet = buildCandidateSet(samples);
  const killSamples = samples.filter((sample) => sample.source === "kill-victim");
  const killParticipantCount = new Set(
    killSamples.map((sample) => sample.participantId),
  ).size;
  const killCandidateSet =
    killSamples.length >= 12 && killParticipantCount >= 5
      ? buildCandidateSet(killSamples)
      : {
          topXFields: [],
          topYFields: [],
          topDirectXFields: [],
          topDirectYFields: [],
          topPairs: [],
        };

  return {
    packetType: group.packetType,
    packetTypeHex: group.packetTypeHex,
    contentLength: group.contentLength,
    blockCount: group.blocks.length,
    alignedSampleCount: samples.length,
    participantCount,
    frameAnchorCount: samples.filter((sample) => sample.source === "timeline-frame")
      .length,
    killVictimAnchorCount: samples.filter((sample) => sample.source === "kill-victim")
      .length,
    averageTimestampDeltaMillis: mean(samples.map((sample) => sample.deltaMillis)),
    status: candidateSet.topPairs.length > 0 ? "analyzed" : "no-candidate",
    topXFields: candidateSet.topXFields,
    topYFields: candidateSet.topYFields,
    topDirectXFields: candidateSet.topDirectXFields,
    topDirectYFields: candidateSet.topDirectYFields,
    topPairs: candidateSet.topPairs,
    knownEncodingProbes: probeKnownWaypointEncodings(samples),
    killVictimAnalysis: {
      sampleCount: killSamples.length,
      participantCount: killParticipantCount,
      topXFields: killCandidateSet.topXFields,
      topYFields: killCandidateSet.topYFields,
      topDirectXFields: killCandidateSet.topDirectXFields,
      topDirectYFields: killCandidateSet.topDirectYFields,
      topPairs: killCandidateSet.topPairs,
      knownEncodingProbes: probeKnownWaypointEncodings(killSamples),
    },
  };
}

function main() {
  const args = parseArgs(process.argv);
  const replayPath = path.resolve(args.replayPath);
  const timelinePath = path.resolve(args.timelinePath);
  const cliPath = path.resolve(args.cliPath);
  const anchors = readTimelineAnchors(timelinePath);

  const kills = runCli(cliPath, ["--extract-replay-kills-json", replayPath]);
  const championBase = kills.profile.championNetworkIdBase;
  const catalog = runCli(cliPath, [
    "--summarize-packet-types-json",
    replayPath,
    "--segment-type",
    "chunk",
    "--top-types",
    "0",
  ]);
  const selectedPacketTypes = selectPacketTypes(catalog, championBase, args);

  const analyses = [];
  for (const selected of selectedPacketTypes) {
    console.error(
      `Analyzing champion-owned ${selected.packetTypeHex} (${selected.catalogCount ?? "explicit"} packets)...`,
    );
    const dump = runCli(cliPath, [
      "--dump-packet-type-json",
      replayPath,
      "--packet-type",
      String(selected.packetType),
      "--segment-type",
      "chunk",
      "--max-blocks",
      "0",
    ]);
    for (const group of groupChampionBlocks(dump, championBase)) {
      analyses.push(analyzeGroup(group, anchors, args.minimumGroupSamples));
    }
  }

  analyses.sort((left, right) => {
    const leftScore = left.topPairs[0]?.score ?? -1;
    const rightScore = right.topPairs[0]?.score ?? -1;
    return (
      rightScore - leftScore ||
      right.alignedSampleCount - left.alignedSampleCount ||
      left.packetType - right.packetType
    );
  });

  const report = {
    schema: "packet-movement-discovery/v1",
    generatedAtUtc: new Date().toISOString(),
    runtimeInput: "rofl-only",
    validationInput: "offline-riot-timeline",
    semanticStatus: "research-only-no-runtime-movement-decoder",
    promotionGate: false,
    rejectedInterpretations: [
      {
        description:
          "little-endian payload u16 fields at byte offsets 0 and 8 masked with 0x3fff",
        reason:
          "Side-by-side Riot timeline validation showed that the values are neither champion positions nor plausible issued destinations.",
      },
    ],
    replayPath,
    timelinePath,
    gameVersion: kills.gameVersion,
    versionGroup: kills.versionGroup,
    championNetworkIdBase: championBase,
    championNetworkIdBaseHex: kills.profile.championNetworkIdBaseHex,
    anchorCount: anchors.length,
    frameAnchorCount: anchors.filter((anchor) => anchor.source === "timeline-frame")
      .length,
    killVictimAnchorCount: anchors.filter((anchor) => anchor.source === "kill-victim")
      .length,
    selectedPacketTypes,
    analyses,
    bestCandidates: analyses
      .filter((analysis) => analysis.topPairs.length > 0)
      .slice(0, 20)
      .map((analysis) => ({
        packetType: analysis.packetType,
        packetTypeHex: analysis.packetTypeHex,
        contentLength: analysis.contentLength,
        alignedSampleCount: analysis.alignedSampleCount,
        participantCount: analysis.participantCount,
        ...analysis.topPairs[0],
      })),
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
