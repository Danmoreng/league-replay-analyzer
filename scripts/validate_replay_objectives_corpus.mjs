import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXPECTED_EVENTS_BY_VERSION = Object.freeze({
  "15.22": 22,
  "15.23": 14,
  "15.24": 8,
  "16.1": 19,
  "16.5": 9,
  "16.6": 103,
  "16.7": 74,
  "16.9": 176,
});

const KNOWN_MONSTER_TYPES = new Set([
  "ATAKHAN",
  "BARON_NASHOR",
  "DRAGON",
  "HORDE",
  "RIFTHERALD",
]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-objectives-corpus-validation.json"),
    timestampToleranceMillis: 1,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--timestamp-tolerance-ms" && index + 1 < argv.length) {
      args.timestampToleranceMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/validate_replay_objectives_corpus.mjs [options]",
        "",
        "Options:",
        "  --cli <path>                    Native rofl_core_cli executable.",
        "  --replay-dir <path>             Directory containing .rofl files.",
        "  --api-root <path>               Offline Riot fixture root.",
        "  --output <path>                 Validation JSON output.",
        "  --timestamp-tolerance-ms <n>    Timestamp tolerance; default 1.",
        "",
        "The native extractor receives only a ROFL path. Riot timeline data is read",
        "after extraction and is used exclusively as an offline validation label.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  if (!Number.isInteger(args.timestampToleranceMillis) || args.timestampToleranceMillis < 0) {
    throw new Error("--timestamp-tolerance-ms must be a non-negative integer.");
  }
  return args;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function normalizeMonsterType(monsterType) {
  if (monsterType === "RIFT_HERALD") return "RIFTHERALD";
  return monsterType ?? "UNKNOWN";
}

function countBy(values, selector) {
  const counts = {};
  for (const value of values) {
    const key = selector(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function collectApiEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ELITE_MONSTER_KILL")
    .map((event, index) => ({
      index,
      timestampMillis: event.timestamp,
      monsterType: normalizeMonsterType(event.monsterType),
      monsterSubtype: event.monsterSubType ?? null,
      killerParticipantId: event.killerId ?? null,
    }));
}

function compareEvents(decodedEvents, apiEvents, toleranceMillis) {
  const usedApiIndexes = new Set();
  const extraDecodedEvents = [];
  let exactMatchCount = 0;
  let maximumAbsoluteTimestampDeltaMillis = 0;

  for (const decoded of decodedEvents) {
    const monsterType = normalizeMonsterType(decoded.monsterType);
    const apiIndex = apiEvents.findIndex((api, index) =>
      !usedApiIndexes.has(index) &&
      api.monsterType === monsterType &&
      Math.abs(api.timestampMillis - decoded.timestampMillis) <= toleranceMillis
    );
    if (apiIndex < 0) {
      extraDecodedEvents.push({
        timestampMillis: decoded.timestampMillis,
        monsterType,
        contentLength: decoded.contentLength,
        discriminator: decoded.discriminator,
        provenance: decoded.provenance,
      });
      continue;
    }
    usedApiIndexes.add(apiIndex);
    exactMatchCount += 1;
    maximumAbsoluteTimestampDeltaMillis = Math.max(
      maximumAbsoluteTimestampDeltaMillis,
      Math.abs(apiEvents[apiIndex].timestampMillis - decoded.timestampMillis),
    );
  }

  return {
    exactMatchCount,
    extraDecodedEventCount: extraDecodedEvents.length,
    missingApiEventCount: apiEvents.length - usedApiIndexes.size,
    maximumAbsoluteTimestampDeltaMillis,
    extraDecodedEvents,
    missingApiEvents: apiEvents.filter((_, index) => !usedApiIndexes.has(index)),
  };
}

function discoverFixtures(args) {
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  return fs.readdirSync(replayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => {
      const replayId = path.basename(entry.name, path.extname(entry.name));
      const fixtureId = replayId.replace("-", "_");
      return {
        replayId,
        replayPath: path.join(replayDir, entry.name),
        matchPath: path.join(apiRoot, fixtureId, "match.json"),
        timelinePath: path.join(apiRoot, fixtureId, "timeline.json"),
      };
    })
    .filter((fixture) => fs.existsSync(fixture.matchPath) && fs.existsSync(fixture.timelinePath))
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function extractObjectives(cliPath, replayPath) {
  const result = spawnSync(cliPath, ["--extract-replay-objectives-json", replayPath], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Extractor exited with status ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No replay/API fixture pairs were found.");

  const rows = [];
  for (const fixture of fixtures) {
    const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const apiEvents = collectApiEvents(timeline);
    let extracted;
    try {
      extracted = extractObjectives(cliPath, fixture.replayPath);
    } catch (error) {
      rows.push({
        replayId: fixture.replayId,
        versionGroup: versionGroup(match.info?.gameVersion),
        status: "fail",
        error: error.message,
      });
      continue;
    }

    const comparison = compareEvents(extracted.events ?? [], apiEvents, args.timestampToleranceMillis);
    const unknownMonsterTypeCount = (extracted.events ?? [])
      .filter((event) => !KNOWN_MONSTER_TYPES.has(normalizeMonsterType(event.monsterType))).length;
    const fixtureVersionGroup = versionGroup(match.info?.gameVersion);
    const pass =
      extracted.versionGroup === fixtureVersionGroup &&
      extracted.source?.runtimeInput === "rofl-only" &&
      extracted.source?.riotApiInput === false &&
      extracted.diagnostics?.exactPacketFraming === true &&
      unknownMonsterTypeCount === 0 &&
      comparison.exactMatchCount === apiEvents.length &&
      comparison.extraDecodedEventCount === 0 &&
      comparison.missingApiEventCount === 0;
    rows.push({
      replayId: fixture.replayId,
      versionGroup: extracted.versionGroup,
      status: pass ? "pass" : "fail",
      profile: extracted.profile,
      provenance: {
        replayOnlyExtractionInput: path.resolve(fixture.replayPath),
        offlineValidationInputs: [path.resolve(fixture.matchPath), path.resolve(fixture.timelinePath)],
        riotDataWasRuntimeInput: false,
      },
      decodedObjectiveEventCount: extracted.events.length,
      apiObjectiveEventCount: apiEvents.length,
      unknownMonsterTypeCount,
      decodedMonsterCounts: countBy(extracted.events, (event) => normalizeMonsterType(event.monsterType)),
      apiMonsterCounts: countBy(apiEvents, (event) => event.monsterType),
      diagnostics: extracted.diagnostics,
      comparison,
    });
  }

  const byVersionGroup = Object.entries(Object.groupBy(rows, (row) => row.versionGroup))
    .map(([group, groupRows]) => ({
      versionGroup: group,
      replayCount: groupRows.length,
      passingReplayCount: groupRows.filter((row) => row.status === "pass").length,
      decodedObjectiveEventCount: groupRows.reduce((sum, row) => sum + (row.decodedObjectiveEventCount ?? 0), 0),
      apiObjectiveEventCount: groupRows.reduce((sum, row) => sum + (row.apiObjectiveEventCount ?? 0), 0),
      exactMatchCount: groupRows.reduce((sum, row) => sum + (row.comparison?.exactMatchCount ?? 0), 0),
      extraDecodedEventCount: groupRows.reduce((sum, row) => sum + (row.comparison?.extraDecodedEventCount ?? 0), 0),
      missingApiEventCount: groupRows.reduce((sum, row) => sum + (row.comparison?.missingApiEventCount ?? 0), 0),
      expectedCorpusEventCount: EXPECTED_EVENTS_BY_VERSION[group] ?? null,
    }))
    .sort((left, right) => left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true }));

  const totals = {
    replayCount: rows.length,
    passingReplayCount: rows.filter((row) => row.status === "pass").length,
    decodedObjectiveEventCount: rows.reduce((sum, row) => sum + (row.decodedObjectiveEventCount ?? 0), 0),
    apiObjectiveEventCount: rows.reduce((sum, row) => sum + (row.apiObjectiveEventCount ?? 0), 0),
    exactMatchCount: rows.reduce((sum, row) => sum + (row.comparison?.exactMatchCount ?? 0), 0),
    extraDecodedEventCount: rows.reduce((sum, row) => sum + (row.comparison?.extraDecodedEventCount ?? 0), 0),
    missingApiEventCount: rows.reduce((sum, row) => sum + (row.comparison?.missingApiEventCount ?? 0), 0),
    unknownMonsterTypeCount: rows.reduce((sum, row) => sum + (row.unknownMonsterTypeCount ?? 0), 0),
    maximumAbsoluteTimestampDeltaMillis: Math.max(0, ...rows.map((row) => row.comparison?.maximumAbsoluteTimestampDeltaMillis ?? 0)),
  };
  const versionTotalsPass = byVersionGroup.every((group) =>
    group.expectedCorpusEventCount === group.decodedObjectiveEventCount &&
    group.decodedObjectiveEventCount === group.apiObjectiveEventCount
  );
  const validated =
    totals.replayCount === 47 &&
    totals.passingReplayCount === totals.replayCount &&
    totals.decodedObjectiveEventCount === 425 &&
    totals.exactMatchCount === 425 &&
    totals.extraDecodedEventCount === 0 &&
    totals.missingApiEventCount === 0 &&
    totals.unknownMonsterTypeCount === 0 &&
    versionTotalsPass;
  const output = {
    schema: "rofl-replay-objectives-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    status: validated ? "validated" : "failed",
    methodology: {
      extractorInput: "ROFL file only.",
      riotFixtureRole: "Offline timestamp and monster-class validation only.",
      timestampToleranceMillis: args.timestampToleranceMillis,
      unresolvedFields: ["monsterSubtype", "killerParticipantId", "killerTeamId"],
    },
    totals,
    byVersionGroup,
    rows,
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote objective corpus validation to ${outputPath}`);
  console.log(
    `replays=${totals.passingReplayCount}/${totals.replayCount}, ` +
    `events=${totals.exactMatchCount}/${totals.apiObjectiveEventCount}, ` +
    `extras=${totals.extraDecodedEventCount}, missing=${totals.missingApiEventCount}, ` +
    `unknown=${totals.unknownMonsterTypeCount}, maxDeltaMs=${totals.maximumAbsoluteTimestampDeltaMillis}`,
  );
  if (!validated) process.exitCode = 1;
}

main();
