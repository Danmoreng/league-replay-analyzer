import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIELD_MAPPINGS = Object.freeze([
  { nativeKey: "level", apiKey: "champLevel", read: (participant) => participant.level },
  { nativeKey: "experience", apiKey: "champExperience", read: (participant) => participant.experience },
  { nativeKey: "laneMinionsKilled", apiKey: "totalMinionsKilled", read: (participant) => participant.laneMinionsKilled },
  { nativeKey: "neutralMinionsKilled", apiKey: "neutralMinionsKilled", read: (participant) => participant.neutralMinionsKilled },
  ...Array.from({ length: 7 }, (_, index) => ({
    nativeKey: `items[${index}]`,
    apiKey: `item${index}`,
    read: (participant) => participant.items?.[index],
  })),
  { nativeKey: "wardsPlaced", apiKey: "wardsPlaced", read: (participant) => participant.wardsPlaced },
  { nativeKey: "wardsKilled", apiKey: "wardsKilled", read: (participant) => participant.wardsKilled },
]);

const EXPECTED_BY_VERSION = Object.freeze({
  "16.14": Object.freeze({ participantCount: 100, fieldCount: 1300 }),
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-final-player-stats-corpus-validation.json"),
    decoderProfilesPath: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--decoder-profiles" && index + 1 < argv.length) {
      args.decoderProfilesPath = argv[++index];
    }
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function discoverFixtures(args) {
  const replayDir = path.resolve(args.replayDir);
  const apiRoot = path.resolve(args.apiRoot);
  return fs.readdirSync(replayDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => {
      const replayId = path.basename(entry.name, path.extname(entry.name));
      const matchPath = path.join(apiRoot, replayId.replace("-", "_"), "match.json");
      return { replayId, replayPath: path.join(replayDir, entry.name), matchPath };
    })
    .filter((fixture) => fs.existsSync(fixture.matchPath))
    .sort((left, right) => left.replayId.localeCompare(right.replayId));
}

function extractNativeSummary(cliPath, replayPath, decoderProfilesPath) {
  const command = ["--summary", replayPath];
  if (decoderProfilesPath) command.push("--decoder-profiles", decoderProfilesPath);
  const result = spawnSync(cliPath, command, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Native summary exited with status ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function versionGroup(gameVersion) {
  return String(gameVersion).split(".").slice(0, 2).join(".");
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  if (!fs.existsSync(cliPath)) throw new Error(`Native CLI not found: ${cliPath}`);
  const decoderProfilesPath = args.decoderProfilesPath ? path.resolve(args.decoderProfilesPath) : null;
  if (decoderProfilesPath && !fs.existsSync(decoderProfilesPath)) {
    throw new Error(`Decoder profile bundle not found: ${decoderProfilesPath}`);
  }
  const fixtures = discoverFixtures(args);
  if (fixtures.length === 0) throw new Error("No replay/API fixture pairs were found.");

  const rows = fixtures.map((fixture) => {
    let summary;
    try {
      summary = extractNativeSummary(cliPath, fixture.replayPath, decoderProfilesPath);
    } catch (error) {
      return {
        replayId: fixture.replayId,
        status: "fail",
        capabilityAvailable: false,
        participantCount: 0,
        apiParticipantCount: 0,
        exactFieldCount: 0,
        expectedFieldCount: 0,
        mismatchCount: 1,
        mismatches: [{ reason: "native-summary-failed", message: error.message }],
      };
    }
    const apiParticipants =
      JSON.parse(fs.readFileSync(fixture.matchPath, "utf8")).info?.participants ?? [];
    const nativeParticipants = summary.players ?? [];
    const mismatches = [];
    let exactFieldCount = 0;
    for (let index = 0;
         index < Math.max(nativeParticipants.length, apiParticipants.length);
         index += 1) {
      const nativeParticipant = nativeParticipants[index];
      const apiParticipant = apiParticipants[index];
      if (!nativeParticipant || !apiParticipant) {
        mismatches.push({ participantId: index + 1, reason: "participant-count-mismatch" });
        continue;
      }
      for (const mapping of FIELD_MAPPINGS) {
        const nativeValue = mapping.read(nativeParticipant);
        const apiValue = apiParticipant[mapping.apiKey];
        if (Number.isInteger(nativeValue) && Number.isInteger(apiValue) && nativeValue === apiValue) {
          exactFieldCount += 1;
        } else {
          mismatches.push({
            participantId: index + 1,
            nativeKey: mapping.nativeKey,
            apiKey: mapping.apiKey,
            nativeValue: nativeValue ?? null,
            apiValue: apiValue ?? null,
          });
        }
      }
    }
    const expectedFieldCount = apiParticipants.length * FIELD_MAPPINGS.length;
    const capabilityAvailable =
      summary.capabilities?.validatedFinalPlayerStatsAvailable === true;
    const pass = capabilityAvailable && nativeParticipants.length === 10 &&
      apiParticipants.length === 10 && exactFieldCount === expectedFieldCount &&
      mismatches.length === 0;
    return {
      replayId: fixture.replayId,
      gameVersion: summary.gameVersion,
      versionGroup: versionGroup(summary.gameVersion),
      capabilityAvailable,
      participantCount: nativeParticipants.length,
      apiParticipantCount: apiParticipants.length,
      exactFieldCount,
      expectedFieldCount,
      mismatchCount: mismatches.length,
      mismatches,
      provenance: {
        runtimeCandidateInput: path.resolve(fixture.replayPath),
        nativeCli: cliPath,
        offlineValidationInput: path.resolve(fixture.matchPath),
        riotDataWasRuntimeInput: false,
      },
      status: pass ? "pass" : "fail",
    };
  });

  const totals = {
    replayCount: rows.length,
    passingReplayCount: rows.filter((row) => row.status === "pass").length,
    capabilityAvailableReplayCount: rows.filter((row) => row.capabilityAvailable).length,
    participantCount: rows.reduce((sum, row) => sum + row.participantCount, 0),
    exactFieldCount: rows.reduce((sum, row) => sum + row.exactFieldCount, 0),
    expectedFieldCount: rows.reduce((sum, row) => sum + row.expectedFieldCount, 0),
    mismatchCount: rows.reduce((sum, row) => sum + row.mismatchCount, 0),
  };
  const byVersionGroup = Object.entries(Object.groupBy(rows, (row) => row.versionGroup ?? "unknown"))
    .map(([group, groupRows]) => ({
      versionGroup: group,
      replayCount: groupRows.length,
      passingReplayCount: groupRows.filter((row) => row.status === "pass").length,
      participantCount: groupRows.reduce((sum, row) => sum + row.participantCount, 0),
      exactFieldCount: groupRows.reduce((sum, row) => sum + row.exactFieldCount, 0),
      expectedFieldCount: groupRows.reduce((sum, row) => sum + row.expectedFieldCount, 0),
      mismatchCount: groupRows.reduce((sum, row) => sum + row.mismatchCount, 0),
      expected: EXPECTED_BY_VERSION[group] ?? null,
    }))
    .sort((left, right) => left.versionGroup.localeCompare(right.versionGroup, undefined, { numeric: true }));
  const expectedTotals = decoderProfilesPath
    ? { replayCount: 57, participantCount: 570, fieldCount: 7410 }
    : { replayCount: 47, participantCount: 470, fieldCount: 6110 };
  const validated = totals.replayCount === expectedTotals.replayCount &&
    totals.passingReplayCount === expectedTotals.replayCount &&
    totals.capabilityAvailableReplayCount === expectedTotals.replayCount &&
    totals.participantCount === expectedTotals.participantCount &&
    totals.exactFieldCount === expectedTotals.fieldCount && totals.exactFieldCount === totals.expectedFieldCount &&
    totals.mismatchCount === 0;
  const versionTotalsPass = byVersionGroup.every((group) =>
    !group.expected || (
      group.participantCount === group.expected.participantCount &&
      group.exactFieldCount === group.expected.fieldCount &&
      group.expectedFieldCount === group.expected.fieldCount &&
      group.mismatchCount === 0
    )
  );
  const output = {
    schema: "rofl-replay-final-player-stats-corpus-validation/v2",
    generatedAtUtc: new Date().toISOString(),
    status: validated && versionTotalsPass ? "validated" : "failed",
    methodology: {
      runtimeCandidateInput: "Productive native --summary JSON generated from the ROFL only.",
      requiredCapability: "validatedFinalPlayerStatsAvailable=true",
      riotFixtureRole: "Offline final-field validation only; never a runtime input.",
      participantIdentity: "Native summary players array index + 1.",
      semantics: "Final match state only; no timeseries or transaction history is inferred.",
      decoderProfileBundle: decoderProfilesPath,
      fieldMappings: Object.fromEntries(
        FIELD_MAPPINGS.map(({ nativeKey, apiKey }) => [nativeKey, apiKey]),
      ),
    },
    totals,
    expectedTotals,
    versionTotalsPass,
    byVersionGroup,
    rows,
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote final player-stat corpus validation to ${outputPath}`);
  console.log(
    `replays=${totals.passingReplayCount}/${totals.replayCount}, ` +
    `capability=${totals.capabilityAvailableReplayCount}/${totals.replayCount}, ` +
    `participants=${totals.participantCount}, fields=${totals.exactFieldCount}/${totals.expectedFieldCount}`,
  );
  if (!validated || !versionTotalsPass) process.exitCode = 1;
}

main();
