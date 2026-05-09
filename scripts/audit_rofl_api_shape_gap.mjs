#!/usr/bin/env node

import path from "path";

import { readJson, resolveAbsolute, writeJson } from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts-keyframes",
    apiRoot: "replays/api",
    replayId: null,
    inputPath: null,
    fixtureDir: null,
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
    } else if (arg === "--input-path" && index + 1 < argv.length) {
      args.inputPath = argv[++index];
    } else if (arg === "--fixture-dir" && index + 1 < argv.length) {
      args.fixtureDir = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.replayId && !args.inputPath) {
    throw new Error("Either --replay-id or --input-path is required.");
  }
  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/audit_rofl_api_shape_gap.mjs --replay-id <id>");
}

function normalizeFixtureReplayId(replayId) {
  const separatorIndex = replayId.indexOf("-");
  return separatorIndex < 0 ? replayId : `${replayId.slice(0, separatorIndex)}_${replayId.slice(separatorIndex + 1)}`;
}

function pathSegment(segment) {
  return /^\d+$/.test(String(segment)) ? "{}" : String(segment);
}

function collectLeafPaths(value, prefix = []) {
  if (Array.isArray(value)) {
    if (!value.length) {
      return [prefix.join(".")];
    }
    return value.flatMap((item) => collectLeafPaths(item, [...prefix, "[]"]));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) {
      return [prefix.join(".")];
    }
    return entries.flatMap(([key, child]) => collectLeafPaths(child, [...prefix, pathSegment(key)]));
  }
  return [prefix.join(".")];
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function classifyMissingPath(sectionName, missingPath) {
  if (missingPath === "info.endOfGameResult") {
    return "end-of-game-result";
  }
  if (sectionName === "match") {
    if (/^info\.(queueId|mapId|gameMode|gameType|gameName|gameCreation|gameStartTimestamp|gameEndTimestamp|tournamentCode)$/.test(missingPath)) {
      return "match-metadata";
    }
    if (missingPath.startsWith("info.teams.[].bans.")) {
      return "team-bans";
    }
    if (missingPath.startsWith("info.teams.[].objectives.") && missingPath.endsWith(".first")) {
      return "team-objective-first-flags";
    }
    if (missingPath.startsWith("info.participants.[].challenges.")) {
      return "participant-challenges";
    }
    if ([
      "info.participants.[].firstBloodAssist",
      "info.participants.[].firstBloodKill",
      "info.participants.[].firstTowerAssist",
      "info.participants.[].firstTowerKill",
    ].includes(missingPath)) {
      return "match-participant-event-flags";
    }
    if ([
      "info.participants.[].profileIcon",
      "info.participants.[].summonerLevel",
    ].includes(missingPath)) {
      return "match-participant-account-profile";
    }
    if (missingPath === "info.participants.[].championId") {
      return "match-participant-static-id-mapping";
    }
    if (missingPath === "info.participants.[].timePlayed") {
      return "match-participant-unstable-final-time";
    }
    if (missingPath === "info.participants.[].eligibleForProgression") {
      return "match-participant-no-rofl-source";
    }
    if (missingPath.startsWith("info.participants.[]")) {
      return "match-participant-fields";
    }
    if (missingPath.startsWith("info.teams.[]")) {
      return "team-fields";
    }
  }
  if (sectionName === "timeline") {
    if (missingPath.startsWith("info.frames.[].events.")) {
      return "timeline-events";
    }
    if (missingPath.startsWith("info.frames.[].participantFrames.")) {
      return "timeline-participant-frames";
    }
    if (missingPath.startsWith("info.frames.[]")) {
      return "timeline-frame-fields";
    }
  }
  return "uncategorized";
}

function summarizeMissingCategories(sectionName, missingPaths) {
  const categories = {};
  for (const missingPath of missingPaths) {
    const category = classifyMissingPath(sectionName, missingPath);
    const entry = categories[category] ?? {
      category,
      missingLeafPathCount: 0,
      sampleMissingLeafPaths: [],
    };
    entry.missingLeafPathCount += 1;
    if (entry.sampleMissingLeafPaths.length < 20) {
      entry.sampleMissingLeafPaths.push(missingPath);
    }
    categories[category] = entry;
  }
  return Object.values(categories).sort((left, right) =>
    right.missingLeafPathCount - left.missingLeafPathCount ||
    left.category.localeCompare(right.category),
  );
}

function summarizeSection(sectionName, roflSection, riotSection) {
  const roflPaths = uniqueSorted(collectLeafPaths(roflSection).filter(Boolean));
  const riotPaths = uniqueSorted(collectLeafPaths(riotSection).filter(Boolean));
  const roflSet = new Set(roflPaths);
  const riotSet = new Set(riotPaths);
  const matchedPaths = riotPaths.filter((entry) => roflSet.has(entry));
  const missingPaths = riotPaths.filter((entry) => !roflSet.has(entry));
  const extraRoflPaths = roflPaths.filter((entry) => !riotSet.has(entry));
  const missingByTopLevel = {};
  for (const missingPath of missingPaths) {
    const group = missingPath.split(".").slice(0, 3).join(".");
    missingByTopLevel[group] = (missingByTopLevel[group] ?? 0) + 1;
  }
  return {
    section: sectionName,
    riotLeafPathCount: riotPaths.length,
    roflLeafPathCount: roflPaths.length,
    matchedLeafPathCount: matchedPaths.length,
    missingLeafPathCount: missingPaths.length,
    extraRoflLeafPathCount: extraRoflPaths.length,
    matchedLeafPathRate: riotPaths.length > 0 ? matchedPaths.length / riotPaths.length : null,
    missingByTopLevel,
    missingCategories: summarizeMissingCategories(sectionName, missingPaths),
    sampleMissingLeafPaths: missingPaths.slice(0, 80),
    sampleExtraRoflLeafPaths: extraRoflPaths.slice(0, 40),
  };
}

function verifyRuntimeArtifactContract(artifact) {
  if (artifact.extractionMode !== "rofl-only-final-stats") {
    throw new Error(`Shape gap audit must target the default ROFL-only final-stats artifact, got ${artifact.extractionMode}.`);
  }
  if (artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles !== false) {
    throw new Error("Shape gap audit target must declare Riot API files disabled for runtime extraction.");
  }
  if (artifact.source?.decoderArtifactSupervised !== false) {
    throw new Error("Shape gap audit target must not depend on supervised decoder artifacts.");
  }
}

function main() {
  const root = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(root, args.artifactRoot);
  const inputPath = resolveAbsolute(
    root,
    args.inputPath ?? path.join(artifactRoot, args.replayId, "rofl-api-metrics.json"),
  );
  const artifact = readJson(inputPath);
  verifyRuntimeArtifactContract(artifact);
  const replayId = args.replayId ?? artifact.source?.replayId;
  const fixtureDir = resolveAbsolute(
    root,
    args.fixtureDir ?? path.join(args.apiRoot, normalizeFixtureReplayId(replayId)),
  );
  const match = readJson(path.join(fixtureDir, "match.json"));
  const timeline = readJson(path.join(fixtureDir, "timeline.json"));
  const outputPath = args.outputPath
    ? resolveAbsolute(root, args.outputPath)
    : path.join(path.dirname(inputPath), "rofl-api-shape-gap-report.json");

  const sections = [
    summarizeSection("match", artifact.match, match),
    summarizeSection("timeline", artifact.timeline, timeline),
  ];
  const output = {
    shapeGapSchema: "rofl-api-shape-gap-report/v1",
    generatedAtUtc: new Date().toISOString(),
    mode: "offline-validation-only",
    replayId,
    inputPath,
    fixtureDir,
    runtimeInput: false,
    validatedArtifact: {
      extractionMode: artifact.extractionMode,
      runtimeRiotApiFiles: artifact.source?.roflOnlyInputs?.runtimeRiotApiFiles ?? null,
      decoderArtifactSupervised: artifact.source?.decoderArtifactSupervised ?? null,
    },
    totals: {
      riotLeafPathCount: sections.reduce((sum, section) => sum + section.riotLeafPathCount, 0),
      roflLeafPathCount: sections.reduce((sum, section) => sum + section.roflLeafPathCount, 0),
      matchedLeafPathCount: sections.reduce((sum, section) => sum + section.matchedLeafPathCount, 0),
      missingLeafPathCount: sections.reduce((sum, section) => sum + section.missingLeafPathCount, 0),
      extraRoflLeafPathCount: sections.reduce((sum, section) => sum + section.extraRoflLeafPathCount, 0),
    },
    sections,
  };
  output.totals.matchedLeafPathRate = output.totals.riotLeafPathCount > 0
    ? output.totals.matchedLeafPathCount / output.totals.riotLeafPathCount
    : null;
  writeJson(outputPath, output);
  console.log(`Wrote ROFL API shape gap report to ${outputPath}`);
  console.log(`ROFL/API shape paths matched: ${output.totals.matchedLeafPathCount}/${output.totals.riotLeafPathCount}`);
  console.log(`ROFL/API shape paths missing: ${output.totals.missingLeafPathCount}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack ?? error);
  process.exit(1);
}
