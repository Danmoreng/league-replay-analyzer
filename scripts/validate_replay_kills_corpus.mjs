import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { extractReplayKills } from "./extract_replay_kills.mjs";

const EXPECTED_BY_VERSION = Object.freeze({
  "16.14": Object.freeze({ killEventCount: 684, participantCount: 100 }),
});

function parseArgs(argv) {
  const args = {
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    replayId: null,
    versionGroup: null,
    outputPath: path.join("artifacts", "replay-kills-corpus-validation.json"),
    timestampToleranceMillis: 1,
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    decoderProfilesPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--replay-id" && index + 1 < argv.length) args.replayId = argv[++index];
    else if (arg === "--version-group" && index + 1 < argv.length) args.versionGroup = argv[++index];
    else if (arg === "--output-path" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--decoder-profiles" && index + 1 < argv.length) {
      args.decoderProfilesPath = argv[++index];
    }
    else if (arg === "--timestamp-tolerance-ms" && index + 1 < argv.length) {
      args.timestampToleranceMillis = Number.parseInt(argv[++index], 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/validate_replay_kills_corpus.mjs [options]",
        "",
        "Riot timeline files are offline validation labels only. The extractor itself",
        "receives only each ROFL path.",
        "",
        "--decoder-profiles selects the native profile-aware extractor; without it the",
        "historical JavaScript decoder remains the backward-compatible default.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }
  return args;
}

function extractNativeKills(cliPath, replayPath, decoderProfilesPath) {
  const command = ["--extract-replay-kills-json", replayPath];
  if (decoderProfilesPath) command.push("--decoder-profiles", decoderProfilesPath);
  const result = spawnSync(cliPath, command, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Native kill extractor exited with status ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function normalizeReplayId(value) {
  return String(value).replace("_", "-");
}

function versionGroupFromGameVersion(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function collectApiKills(timeline) {
  return (timeline.info?.frames ?? [])
    .flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "CHAMPION_KILL")
    .map((event, index) => ({
      index,
      timestampMillis: event.timestamp,
      victimParticipantId: event.victimId,
      killerParticipantId: event.killerId ?? 0,
      assistingParticipantIds: [...(event.assistingParticipantIds ?? [])],
    }));
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareEvents(decoded, api, toleranceMillis) {
  const usedApiIndexes = new Set();
  const mismatches = [];
  let exactMatchCount = 0;
  let maximumAbsoluteTimestampDeltaMillis = 0;

  for (const event of decoded) {
    const apiIndex = api.findIndex((candidate, index) =>
      !usedApiIndexes.has(index) &&
      Math.abs(candidate.timestampMillis - event.timestampMillis) <= toleranceMillis &&
      candidate.victimParticipantId === event.victimParticipantId &&
      candidate.killerParticipantId === event.killerParticipantId &&
      arraysEqual(candidate.assistingParticipantIds, event.assistingParticipantIds)
    );
    if (apiIndex < 0) {
      mismatches.push(event);
      continue;
    }
    usedApiIndexes.add(apiIndex);
    exactMatchCount += 1;
    maximumAbsoluteTimestampDeltaMillis = Math.max(
      maximumAbsoluteTimestampDeltaMillis,
      Math.abs(api[apiIndex].timestampMillis - event.timestampMillis),
    );
  }

  return {
    exactMatchCount,
    decodedMismatchCount: mismatches.length,
    missingApiEventCount: api.length - usedApiIndexes.size,
    maximumAbsoluteTimestampDeltaMillis,
    mismatches,
    missingApiEvents: api.filter((_, index) => !usedApiIndexes.has(index)),
  };
}

function discoverFixtures(args) {
  const apiRoot = path.resolve(args.apiRoot);
  const replayDir = path.resolve(args.replayDir);
  const requestedReplayId = args.replayId ? normalizeReplayId(args.replayId) : null;
  const rows = [];
  for (const entry of fs.readdirSync(apiRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const matchPath = path.join(apiRoot, entry.name, "match.json");
    const timelinePath = path.join(apiRoot, entry.name, "timeline.json");
    if (!fs.existsSync(matchPath) || !fs.existsSync(timelinePath)) continue;
    const match = JSON.parse(fs.readFileSync(matchPath, "utf8"));
    const replayId = normalizeReplayId(match.metadata?.matchId ?? entry.name);
    const versionGroup = versionGroupFromGameVersion(match.info?.gameVersion);
    if (requestedReplayId && replayId !== requestedReplayId) continue;
    if (args.versionGroup && versionGroup !== args.versionGroup) continue;
    const replayPath = path.join(replayDir, `${replayId}.rofl`);
    if (!fs.existsSync(replayPath)) continue;
    rows.push({
      replayId,
      versionGroup,
      replayPath,
      matchPath,
      timelinePath,
    });
  }
  rows.sort((left, right) =>
    left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true }) ||
    left.replayId.localeCompare(right.replayId)
  );
  return rows;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No replay/API fixture pairs matched.");
  const decoderProfilesPath = args.decoderProfilesPath ? path.resolve(args.decoderProfilesPath) : null;
  const cliPath = path.resolve(args.cliPath);
  if (decoderProfilesPath && !fs.existsSync(decoderProfilesPath)) {
    throw new Error(`Decoder profile bundle not found: ${decoderProfilesPath}`);
  }
  if (decoderProfilesPath && !fs.existsSync(cliPath)) {
    throw new Error(`Native CLI not found: ${cliPath}`);
  }
  const rows = [];

  for (const fixture of fixtures) {
    console.log(`Validating ${fixture.replayId} (${fixture.versionGroup})`);
    const extracted = decoderProfilesPath
      ? extractNativeKills(cliPath, fixture.replayPath, decoderProfilesPath)
      : extractReplayKills(fixture.replayPath);
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const apiEvents = collectApiKills(timeline);
    const comparison = compareEvents(
      extracted.events,
      apiEvents,
      args.timestampToleranceMillis,
    );
    const pass =
      comparison.exactMatchCount === apiEvents.length &&
      comparison.decodedMismatchCount === 0 &&
      comparison.missingApiEventCount === 0 &&
      extracted.diagnostics.finalKdaValidation.pass;
    rows.push({
      replayId: fixture.replayId,
      versionGroup: fixture.versionGroup,
      status: pass ? "pass" : "fail",
      provenance: {
        replayOnlyExtractionInput: path.resolve(fixture.replayPath),
        offlineValidationInputs: [
          path.resolve(fixture.matchPath),
          path.resolve(fixture.timelinePath),
        ],
        runtimeInput: false,
        decoderProfileBundle: decoderProfilesPath,
      },
      decodedKillEventCount: extracted.events.length,
      apiKillEventCount: apiEvents.length,
      ignoredDeathMarkerBlockCount: extracted.diagnostics.ignoredDeathMarkerBlockCount,
      replayOnlyFinalKdaValidation: extracted.diagnostics.finalKdaValidation,
      comparison,
    });
  }

  const byVersionGroup = Object.entries(Object.groupBy(rows, (row) => row.versionGroup))
    .map(([versionGroup, groupRows]) => ({
      versionGroup,
      replayCount: groupRows.length,
      passingReplayCount: groupRows.filter((row) => row.status === "pass").length,
      decodedKillEventCount: groupRows.reduce(
        (sum, row) => sum + row.decodedKillEventCount,
        0,
      ),
      exactMatchCount: groupRows.reduce(
        (sum, row) => sum + row.comparison.exactMatchCount,
        0,
      ),
      apiKillEventCount: groupRows.reduce(
        (sum, row) => sum + row.apiKillEventCount,
        0,
      ),
      ignoredDeathMarkerBlockCount: groupRows.reduce(
        (sum, row) => sum + row.ignoredDeathMarkerBlockCount,
        0,
      ),
      replayOnlyKdaParticipantCount: groupRows.reduce(
        (sum, row) => sum + row.replayOnlyFinalKdaValidation.participantCount,
        0,
      ),
      replayOnlyKdaPassingParticipantCount: groupRows.reduce(
        (sum, row) => sum + row.replayOnlyFinalKdaValidation.passingParticipantCount,
        0,
      ),
      expected: EXPECTED_BY_VERSION[versionGroup] ?? null,
    }))
    .sort((left, right) =>
      left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true })
    );
  const totals = {
    replayCount: rows.length,
    passingReplayCount: rows.filter((row) => row.status === "pass").length,
    decodedKillEventCount: rows.reduce((sum, row) => sum + row.decodedKillEventCount, 0),
    exactMatchCount: rows.reduce((sum, row) => sum + row.comparison.exactMatchCount, 0),
    apiKillEventCount: rows.reduce((sum, row) => sum + row.apiKillEventCount, 0),
    ignoredDeathMarkerBlockCount: rows.reduce(
      (sum, row) => sum + row.ignoredDeathMarkerBlockCount,
      0,
    ),
    replayOnlyKdaParticipantCount: rows.reduce(
      (sum, row) => sum + row.replayOnlyFinalKdaValidation.participantCount,
      0,
    ),
    replayOnlyKdaPassingParticipantCount: rows.reduce(
      (sum, row) => sum + row.replayOnlyFinalKdaValidation.passingParticipantCount,
      0,
    ),
  };
  const expectedTotals = decoderProfilesPath
    ? { replayCount: 57, killEventCount: 3480, participantCount: 570 }
    : { replayCount: 47, killEventCount: 2796, participantCount: 470 };
  const frozenTotalsPass =
    totals.replayCount === expectedTotals.replayCount &&
    totals.passingReplayCount === expectedTotals.replayCount &&
    totals.decodedKillEventCount === expectedTotals.killEventCount &&
    totals.exactMatchCount === expectedTotals.killEventCount &&
    totals.apiKillEventCount === expectedTotals.killEventCount &&
    totals.replayOnlyKdaParticipantCount === expectedTotals.participantCount &&
    totals.replayOnlyKdaPassingParticipantCount === expectedTotals.participantCount;
  const versionTotalsPass = byVersionGroup.every((group) =>
    !group.expected || (
      group.decodedKillEventCount === group.expected.killEventCount &&
      group.exactMatchCount === group.expected.killEventCount &&
      group.apiKillEventCount === group.expected.killEventCount &&
      group.replayOnlyKdaParticipantCount === group.expected.participantCount &&
      group.replayOnlyKdaPassingParticipantCount === group.expected.participantCount
    )
  );
  const output = {
    schema: "rofl-replay-kills-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-validation-only",
    runtimeInput: false,
    status: frozenTotalsPass && versionTotalsPass ? "validated" : "failed",
    methodology: {
      extractorInput: "ROFL file only.",
      riotFixtureRole: "Offline event-label validation only.",
      timestampToleranceMillis: args.timestampToleranceMillis,
      decoderProfileBundle: decoderProfilesPath,
      participantIdentity:
        "Replay statsJson array index+1; independently checked against fixture champion/team/Riot ID identity.",
    },
    totals,
    expectedTotals,
    frozenTotalsPass,
    versionTotalsPass,
    byVersionGroup,
    rows,
  };
  const outputPath = path.resolve(args.outputPath);
  writeJson(outputPath, output);
  console.log(`Wrote replay kill corpus validation to ${outputPath}`);
  console.log(
    `replays=${totals.passingReplayCount}/${totals.replayCount}, ` +
    `kills=${totals.exactMatchCount}/${totals.apiKillEventCount}, ` +
    `replayKda=${totals.replayOnlyKdaPassingParticipantCount}/` +
    `${totals.replayOnlyKdaParticipantCount}`,
  );
  if (output.status !== "validated") process.exitCode = 1;
}

main();
