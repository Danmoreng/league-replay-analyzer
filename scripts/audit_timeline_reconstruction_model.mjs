import fs from "fs";
import path from "path";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    versionGroup: null,
    outputPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--api-root" && index + 1 < argv.length) {
      args.apiRoot = argv[++index];
    } else if (arg === "--replay-id" && index + 1 < argv.length) {
      args.replayId = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!args.replayId && !args.versionGroup) {
    throw new Error("Either --replay-id or --version-group is required.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/audit_timeline_reconstruction_model.mjs (--replay-id <id> | --version-group 16.9) [--artifact-root artifacts-keyframes] [--api-root replays/api]");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function replayIdsForVersionGroup(artifactRoot, versionGroup) {
  return fs.readdirSync(artifactRoot)
    .filter((name) => fs.existsSync(path.join(artifactRoot, name, "summary.json")))
    .filter((name) => {
      const summary = readJson(path.join(artifactRoot, name, "summary.json"));
      return String(summary.gameVersion ?? "").startsWith(`${versionGroup}.`);
    })
    .sort();
}

function countEvents(events, predicate) {
  return events.filter(predicate).length;
}

function eventCounts(events) {
  return {
    total: events.length,
    championKills: countEvents(events, (event) => event.type === "CHAMPION_KILL"),
    buildingKills: countEvents(events, (event) => event.type === "BUILDING_KILL"),
    eliteMonsterKills: countEvents(events, (event) => event.type === "ELITE_MONSTER_KILL"),
    itemEvents: countEvents(events, (event) => String(event.type ?? "").startsWith("ITEM_")),
    wardEvents: countEvents(events, (event) => String(event.type ?? "").includes("WARD")),
  };
}

function eventPriority(counts) {
  return (counts.eliteMonsterKills * 100)
    + (counts.buildingKills * 80)
    + (counts.championKills * 25)
    + (counts.itemEvents * 3)
    + counts.total;
}

function topEventfulIntervals(rows, limit = 12) {
  return rows.flatMap((row) => row.intervals.map((interval) => ({
    replayId: row.replayId,
    apiIntervalIndex: interval.apiIntervalIndex,
    startMs: interval.startMs,
    endMs: interval.endMs,
    chunkIds: interval.chunkIds,
    chunkTargets: interval.chunkTargets,
    eventCounts: interval.eventCounts,
    priority: eventPriority(interval.eventCounts),
  })))
    .filter((interval) => interval.eventCounts.total > 0)
    .sort((left, right) =>
      right.priority - left.priority ||
      right.eventCounts.total - left.eventCounts.total ||
      left.replayId.localeCompare(right.replayId) ||
      left.apiIntervalIndex - right.apiIntervalIndex,
    )
    .slice(0, limit);
}

function flattenEvents(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame, frameIndex) =>
    (frame.events ?? []).map((event) => ({ ...event, frameIndex })),
  );
}

function auditReplay(artifactRoot, apiRoot, replayId) {
  const summaryPath = path.join(artifactRoot, replayId, "summary.json");
  const fixtureId = replayId.replace("-", "_");
  const timelinePath = path.join(apiRoot, fixtureId, "timeline.json");
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`Missing summary artifact: ${summaryPath}`);
  }
  if (!fs.existsSync(timelinePath)) {
    throw new Error(`Missing offline timeline fixture: ${timelinePath}`);
  }

  const summary = readJson(summaryPath);
  const timeline = readJson(timelinePath);
  const frames = timeline.info?.frames ?? [];
  const events = flattenEvents(timeline);
  const keyframes = (summary.container?.segments ?? []).filter((segment) => segment.type === "keyframe");
  const chunks = (summary.container?.segments ?? [])
    .filter((segment) => segment.type === "chunk")
    .sort((left, right) => left.chunkId - right.chunkId);
  const gameLengthMillis = Number.isFinite(summary.gameLengthMillis) ? summary.gameLengthMillis : frames.at(-1)?.timestamp ?? null;

  const intervals = frames.slice(0, -1).map((frame, index) => {
    const nextFrame = frames[index + 1];
    const intervalEvents = events.filter((event) => event.timestamp >= frame.timestamp && event.timestamp < nextFrame.timestamp);
    const intervalChunks = chunks.filter((chunk) => {
      const chunkStartMs = Math.max(0, (chunk.chunkId - 4) * 30000);
      const chunkEndMs = Math.min(gameLengthMillis, chunkStartMs + 30000);
      return chunkEndMs > frame.timestamp && chunkStartMs < nextFrame.timestamp;
    });
    return {
      apiIntervalIndex: index,
      startMs: frame.timestamp,
      endMs: nextFrame.timestamp,
      durationMs: nextFrame.timestamp - frame.timestamp,
      startsAtKeyframeId: keyframes[index]?.id ?? null,
      endsAtKeyframeId: keyframes[index + 1]?.id ?? null,
      chunkIds: intervalChunks.map((chunk) => chunk.chunkId),
      chunkTargets: intervalChunks.map((chunk) => ({
        id: chunk.id,
        chunkId: chunk.chunkId,
        offset: chunk.offset ?? null,
        headerOffset: chunk.headerOffset ?? null,
        payloadOffset: chunk.payloadOffset ?? null,
        length: chunk.length ?? null,
        uncompressedLength: chunk.uncompressedLength ?? null,
        codec: chunk.codec ?? null,
      })),
      eventCounts: eventCounts(intervalEvents),
    };
  });

  const tailIntervalMs = frames.length > 1 ? frames.at(-1).timestamp - frames.at(-2).timestamp : null;
  const row = {
    replayId,
    gameVersion: summary.gameVersion ?? null,
    summaryPath,
    offlineTimelineFixture: timelinePath,
    mode: "offline-structure-audit",
    runtimeInput: false,
    structural: {
      gameLengthMillis,
      apiFrameCount: frames.length,
      replayKeyframeCount: summary.container?.keyframeCount ?? keyframes.length,
      replayChunkCount: summary.container?.chunkCount ?? chunks.length,
      apiFramesEqualKeyframesPlusOne: frames.length === (summary.container?.keyframeCount ?? keyframes.length) + 1,
      keyframeChunkFormulaHolds: keyframes.every((segment) => segment.chunkId === (2 * segment.id) + 1),
      chunkRecordFormulaHolds: chunks.every((segment) => segment.chunkId === segment.id + 1),
      lastTimelineFrameTimestamp: frames.at(-1)?.timestamp ?? null,
      replayMinusLastTimelineFrameMillis: gameLengthMillis != null && frames.at(-1)?.timestamp != null
        ? gameLengthMillis - frames.at(-1).timestamp
        : null,
      tailIntervalMs,
      metadataLastGameChunkId: summary.lastGameChunkId ?? null,
      actualLastChunkId: chunks.at(-1)?.chunkId ?? null,
    },
    reconstructionModel: {
      status: "planned",
      model: "keyframe-baseline-plus-chunk-deltas",
      implication: "Use keyframes as baseline snapshots and decode chunk/subrecord updates between frame boundaries before emitting API-shaped non-final participantFrames, events, positions, or inventory state.",
      validationRole: "Riot timeline fixture is used only to audit structure and validate future ROFL-only reconstruction.",
    },
    intervals,
  };
  return {
    ...row,
    topEventfulIntervals: topEventfulIntervals([row], 8),
  };
}

function summarize(rows) {
  return {
    replayCount: rows.length,
    apiFramesEqualKeyframesPlusOne: rows.filter((row) => row.structural.apiFramesEqualKeyframesPlusOne).length,
    keyframeChunkFormulaHolds: rows.filter((row) => row.structural.keyframeChunkFormulaHolds).length,
    chunkRecordFormulaHolds: rows.filter((row) => row.structural.chunkRecordFormulaHolds).length,
    totalApiIntervals: rows.reduce((sum, row) => sum + row.intervals.length, 0),
    totalChunkMappedIntervals: rows.reduce((sum, row) => sum + row.intervals.filter((interval) => interval.chunkIds.length > 0).length, 0),
    totalTimelineEvents: rows.reduce((sum, row) => sum + row.intervals.reduce((inner, interval) => inner + interval.eventCounts.total, 0), 0),
    topEventfulIntervals: topEventfulIntervals(rows, 16),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const replayIds = args.replayId ? [args.replayId] : replayIdsForVersionGroup(args.artifactRoot, args.versionGroup);
  const rows = replayIds.map((replayId) => auditReplay(args.artifactRoot, args.apiRoot, replayId));
  const output = {
    auditSchema: "rofl-timeline-reconstruction-model/v1",
    generatedAtUtc: new Date().toISOString(),
    artifactRoot: args.artifactRoot,
    apiRoot: args.apiRoot,
    versionGroup: args.versionGroup,
    replayId: args.replayId,
    mode: "offline-structure-audit",
    runtimeInput: false,
    summary: summarize(rows),
    rows,
  };
  const outputPath = args.outputPath ?? (args.replayId
    ? path.join(args.artifactRoot, args.replayId, "timeline-reconstruction-model.json")
    : path.join(args.artifactRoot, `timeline-reconstruction-model-${args.versionGroup}.json`));
  writeJson(outputPath, output);
  console.log(`Wrote timeline reconstruction model audit to ${path.resolve(outputPath)}`);
  console.log(`replays: ${rows.length}`);
  console.log(`frame/keyframe +1: ${output.summary.apiFramesEqualKeyframesPlusOne}/${rows.length}`);
  console.log(`keyframe chunk formula: ${output.summary.keyframeChunkFormulaHolds}/${rows.length}`);
  console.log(`chunk record formula: ${output.summary.chunkRecordFormulaHolds}/${rows.length}`);
}

main();
