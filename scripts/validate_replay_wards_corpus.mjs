import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const STANDARD_WARD_TYPES = new Set([
  "BLUE_TRINKET",
  "CONTROL_WARD",
  "SIGHT_WARD",
  "YELLOW_TRINKET",
]);

const EXPECTED_BY_VERSION = Object.freeze({
  "15.22": Object.freeze({ placements: 344, decodedKills: 110, apiKills: 110 }),
  "15.23": Object.freeze({ placements: 216, decodedKills: 98, apiKills: 98 }),
  "15.24": Object.freeze({ placements: 95, decodedKills: 32, apiKills: 32 }),
  "16.1": Object.freeze({ placements: 329, decodedKills: 139, apiKills: 139 }),
  "16.5": Object.freeze({ placements: 125, decodedKills: 34, apiKills: 34 }),
  "16.6": Object.freeze({ placements: 1449, decodedKills: 437, apiKills: 437 }),
  "16.7": Object.freeze({ placements: 985, decodedKills: 287, apiKills: 287 }),
  "16.9": Object.freeze({ placements: 2625, decodedKills: 745, apiKills: 746 }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-wards-corpus-validation.json"),
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
        "Usage: node ./scripts/validate_replay_wards_corpus.mjs [options]",
        "",
        "The native extractor receives only a ROFL path. Riot timeline fixtures",
        "are loaded afterward and serve exclusively as offline validation labels.",
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

function normalizeReplayId(value) {
  return String(value).replace("_", "-");
}

function collectApiEvents(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) =>
      (event.type === "WARD_PLACED" || event.type === "WARD_KILL") &&
      STANDARD_WARD_TYPES.has(event.wardType)
    )
    .map((event, index) => ({
      index,
      type: event.type,
      timestampMillis: event.timestamp,
      actorParticipantId: event.type === "WARD_PLACED" ? event.creatorId : event.killerId,
      wardType: event.wardType,
    }));
}

function actorParticipantId(event) {
  return event.type === "WARD_PLACED"
    ? event.ownerParticipantId
    : event.killerParticipantId;
}

function compareEvents(decodedEvents, apiEvents, toleranceMillis) {
  const usedApiIndexes = new Set();
  const extraDecodedEvents = [];
  let exactMatchCount = 0;
  let maximumAbsoluteTimestampDeltaMillis = 0;
  for (const decoded of decodedEvents) {
    const apiIndex = apiEvents.findIndex((api, index) =>
      !usedApiIndexes.has(index) &&
      api.type === decoded.type &&
      api.actorParticipantId === actorParticipantId(decoded) &&
      Math.abs(api.timestampMillis - decoded.timestampMillis) <= toleranceMillis
    );
    if (apiIndex < 0) {
      extraDecodedEvents.push(decoded);
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
  return fs.readdirSync(apiRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const replayId = normalizeReplayId(entry.name);
      const replayPath = path.join(replayDir, `${replayId}.rofl`);
      const matchPath = path.join(apiRoot, entry.name, "match.json");
      const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
      if (!fs.existsSync(replayPath) || !fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) {
        return null;
      }
      return { replayId, replayPath, matchPath, timelinePath };
    })
    .filter(Boolean)
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function extractWards(cliPath, replayPath) {
  const result = spawnSync(cliPath, ["--extract-replay-wards-json", replayPath], {
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

function validateReplayShape(extracted) {
  const placements = extracted.events.filter((event) => event.type === "WARD_PLACED");
  const kills = extracted.events.filter((event) => event.type === "WARD_KILL");
  const placementIds = new Set(placements.map((event) => event.wardEntityNetworkId));
  const replayShapePass =
    placementIds.size === placements.length &&
    placements.every((event) =>
      event.ownerParticipantId >= 1 && event.ownerParticipantId <= 10 &&
      event.wardType === null && event.position === null &&
      event.provenance?.ownerBlock && event.provenance?.markerBlock
    ) &&
    kills.every((event) =>
      event.killerParticipantId >= 1 && event.killerParticipantId <= 10 &&
      placementIds.has(event.wardEntityNetworkId) &&
      event.wardType === null && event.position === null && event.removalReason === null &&
      event.provenance?.killerOwnerBlock && event.provenance?.removalBlock
    );
  return { placements, kills, distinctPlacementEntityIdCount: placementIds.size, replayShapePass };
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
    console.log(`Validating ${fixture.replayId}`);
    const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const group = versionGroup(match.info?.gameVersion);
    let extracted;
    try {
      extracted = extractWards(cliPath, fixture.replayPath);
    } catch (error) {
      rows.push({ replayId: fixture.replayId, versionGroup: group, status: "fail", error: error.message });
      continue;
    }
    const shape = validateReplayShape(extracted);
    const apiEvents = collectApiEvents(timeline);
    const decodedPlacements = shape.placements;
    const decodedKills = shape.kills;
    const apiPlacements = apiEvents.filter((event) => event.type === "WARD_PLACED");
    const apiKills = apiEvents.filter((event) => event.type === "WARD_KILL");
    const placementComparison = compareEvents(
      decodedPlacements,
      apiPlacements,
      args.timestampToleranceMillis,
    );
    const killComparison = compareEvents(decodedKills, apiKills, args.timestampToleranceMillis);
    const localPass =
      extracted.schema === "rofl-replay-wards/v1" &&
      extracted.versionGroup === group &&
      extracted.source?.runtimeInput === "rofl-only" &&
      extracted.source?.riotApiInput === false &&
      extracted.diagnostics?.exactPacketFraming === true &&
      extracted.diagnostics?.placementCoverage === "exact-on-validated-corpus" &&
      extracted.diagnostics?.removalCoverage === "conservative-partial" &&
      shape.replayShapePass &&
      placementComparison.exactMatchCount === apiPlacements.length &&
      placementComparison.extraDecodedEventCount === 0 &&
      placementComparison.missingApiEventCount === 0 &&
      killComparison.exactMatchCount === decodedKills.length &&
      killComparison.extraDecodedEventCount === 0 &&
      killComparison.missingApiEventCount <= (group === "16.9" ? 1 : 0);
    rows.push({
      replayId: fixture.replayId,
      versionGroup: group,
      status: localPass ? "pass" : "fail",
      decodedPlacementEventCount: decodedPlacements.length,
      apiPlacementEventCount: apiPlacements.length,
      decodedWardKillEventCount: decodedKills.length,
      apiWardKillEventCount: apiKills.length,
      distinctPlacementEntityIdCount: shape.distinctPlacementEntityIdCount,
      replayShapePass: shape.replayShapePass,
      profile: extracted.profile,
      diagnostics: extracted.diagnostics,
      placementComparison,
      killComparison,
      provenance: {
        replayOnlyExtractionInput: path.resolve(fixture.replayPath),
        offlineValidationInputs: [path.resolve(fixture.matchPath), path.resolve(fixture.timelinePath)],
        riotDataWasRuntimeInput: false,
      },
    });
  }

  const byVersionGroup = Object.entries(Object.groupBy(rows, (row) => row.versionGroup))
    .map(([group, groupRows]) => ({
      versionGroup: group,
      replayCount: groupRows.length,
      passingReplayCount: groupRows.filter((row) => row.status === "pass").length,
      decodedPlacementEventCount: groupRows.reduce((sum, row) => sum + (row.decodedPlacementEventCount ?? 0), 0),
      apiPlacementEventCount: groupRows.reduce((sum, row) => sum + (row.apiPlacementEventCount ?? 0), 0),
      decodedWardKillEventCount: groupRows.reduce((sum, row) => sum + (row.decodedWardKillEventCount ?? 0), 0),
      apiWardKillEventCount: groupRows.reduce((sum, row) => sum + (row.apiWardKillEventCount ?? 0), 0),
      expected: EXPECTED_BY_VERSION[group] ?? null,
    }))
    .sort((left, right) => left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true }));

  const totals = {
    replayCount: rows.length,
    passingReplayCount: rows.filter((row) => row.status === "pass").length,
    decodedPlacementEventCount: rows.reduce((sum, row) => sum + (row.decodedPlacementEventCount ?? 0), 0),
    apiPlacementEventCount: rows.reduce((sum, row) => sum + (row.apiPlacementEventCount ?? 0), 0),
    decodedWardKillEventCount: rows.reduce((sum, row) => sum + (row.decodedWardKillEventCount ?? 0), 0),
    apiWardKillEventCount: rows.reduce((sum, row) => sum + (row.apiWardKillEventCount ?? 0), 0),
    placementExtraDecodedEventCount: rows.reduce((sum, row) => sum + (row.placementComparison?.extraDecodedEventCount ?? 0), 0),
    placementMissingApiEventCount: rows.reduce((sum, row) => sum + (row.placementComparison?.missingApiEventCount ?? 0), 0),
    killExtraDecodedEventCount: rows.reduce((sum, row) => sum + (row.killComparison?.extraDecodedEventCount ?? 0), 0),
    killMissingApiEventCount: rows.reduce((sum, row) => sum + (row.killComparison?.missingApiEventCount ?? 0), 0),
  };
  const versionTotalsPass = byVersionGroup.every((group) =>
    group.expected &&
    group.passingReplayCount === group.replayCount &&
    group.decodedPlacementEventCount === group.expected.placements &&
    group.apiPlacementEventCount === group.expected.placements &&
    group.decodedWardKillEventCount === group.expected.decodedKills &&
    group.apiWardKillEventCount === group.expected.apiKills
  );
  const pass =
    totals.replayCount === 47 && totals.passingReplayCount === 47 &&
    totals.decodedPlacementEventCount === 6168 && totals.apiPlacementEventCount === 6168 &&
    totals.decodedWardKillEventCount === 1882 && totals.apiWardKillEventCount === 1883 &&
    totals.placementExtraDecodedEventCount === 0 && totals.placementMissingApiEventCount === 0 &&
    totals.killExtraDecodedEventCount === 0 && totals.killMissingApiEventCount === 1 &&
    versionTotalsPass;
  const report = {
    schema: "rofl-replay-wards-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    pass,
    provenance: {
      runtimeCandidateInput: "ROFL path only",
      riotApiRuntimeInput: false,
      offlineValidationLabels: ["WARD_PLACED", "WARD_KILL", "creatorId", "killerId", "wardType"],
      timestampToleranceMillis: args.timestampToleranceMillis,
    },
    totals,
    versionTotalsPass,
    byVersionGroup,
    rows,
  };
  writeJson(path.resolve(args.outputPath), report);
  console.log(JSON.stringify({ pass, totals, versionTotalsPass }, null, 2));
  if (!pass) process.exitCode = 1;
}

main();
