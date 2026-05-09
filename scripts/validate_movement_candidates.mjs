import fs from "fs";
import path from "path";

import {
  average,
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    candidateMatchesPath: null,
    provisionalSchemaPath: null,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--candidate-matches-path" && index + 1 < argv.length) {
      args.candidateMatchesPath = argv[++index];
    } else if (arg === "--provisional-schema-path" && index + 1 < argv.length) {
      args.provisionalSchemaPath = argv[++index];
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.candidateMatchesPath) {
    throw new Error("Missing required --candidate-matches-path <path> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/validate_movement_candidates.mjs --candidate-matches-path <path> [--provisional-schema-path <path>] [--output-path <path>]");
}

function buildParticipantBestMatches(candidateMatches, provisionalSchema) {
  const promotedRawPairKeys = new Set(
    (provisionalSchema?.promotedPatterns ?? [])
      .flatMap((pattern) => pattern.rawPairCandidates ?? [])
      .map((candidate) => candidate.rawPairKey),
  );

  const matchesByParticipant = new Map();
  for (const match of candidateMatches.topMatches ?? []) {
    const rawPairKey = [
      match.familyKey,
      match.slotIndex,
      match.leftOffset,
      match.leftDecodeLabel,
      match.rightOffset,
      match.rightDecodeLabel,
      match.mapping,
    ].join("|");
    const current = matchesByParticipant.get(match.participantId);
    const promotedBonus = promotedRawPairKeys.has(rawPairKey) ? 0.1 : 0;
    const score = match.effectiveScore + promotedBonus;
    if (!current || score > current.score) {
      matchesByParticipant.set(match.participantId, {
        participantId: match.participantId,
        champion: match.champion,
        teamId: match.teamId,
        teamPosition: match.teamPosition,
        rawPairKey,
        familyKey: match.familyKey,
        slotIndex: match.slotIndex,
        leftOffset: match.leftOffset,
        leftDecodeLabel: match.leftDecodeLabel,
        rightOffset: match.rightOffset,
        rightDecodeLabel: match.rightDecodeLabel,
        mapping: match.mapping,
        xCorrelation: match.xCorrelation,
        yCorrelation: match.yCorrelation,
        pathCorrelation: match.pathCorrelation,
        normalizedDistanceRmse: match.normalizedDistanceRmse,
        boundsRatio: match.boundsRatio,
        speedRatio: match.speedRatio,
        validatorScore: match.validatorScore,
        effectiveScore: match.effectiveScore,
        passesValidation: match.passesValidation,
        promotedPattern: promotedRawPairKeys.has(rawPairKey),
        score,
      });
    }
  }

  return [...matchesByParticipant.values()].sort((left, right) => right.score - left.score);
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const candidateMatchesPath = resolveAbsolute(repoRoot, args.candidateMatchesPath);
  const provisionalSchemaPath = args.provisionalSchemaPath
    ? resolveAbsolute(repoRoot, args.provisionalSchemaPath)
    : path.join(path.dirname(candidateMatchesPath), "movement-provisional-schema.json");
  const outputPath = args.outputPath
    ? resolveAbsolute(repoRoot, args.outputPath)
    : path.join(path.dirname(candidateMatchesPath), "movement-validation-report.json");

  if (!fs.existsSync(candidateMatchesPath)) {
    throw new Error(`Movement candidate matches not found at ${candidateMatchesPath}`);
  }

  const candidateMatches = readJson(candidateMatchesPath);
  const provisionalSchema = fs.existsSync(provisionalSchemaPath)
    ? readJson(provisionalSchemaPath)
    : { promotedPatterns: [], rankedPatterns: [] };

  const participantMatches = buildParticipantBestMatches(candidateMatches, provisionalSchema);
  const promotedPatterns = provisionalSchema.promotedPatterns ?? [];

  const validationReport = {
    replayId: candidateMatches.replayId,
    generatedAtUtc: new Date().toISOString(),
    candidateMatchesPath,
    provisionalSchemaPath: fs.existsSync(provisionalSchemaPath) ? provisionalSchemaPath : null,
    summary: {
      promotedPatternCount: promotedPatterns.length,
      participantCoverage: participantMatches.length,
      passingParticipants: participantMatches.filter((match) => match.passesValidation).length,
      averageAxisCorrelation: average(participantMatches.map((match) => (match.xCorrelation + match.yCorrelation) / 2)),
      averagePathCorrelation: average(participantMatches.map((match) => match.pathCorrelation)),
      averageNormalizedDistanceRmse: average(participantMatches.map((match) => match.normalizedDistanceRmse)),
    },
    promotedPatterns: promotedPatterns.slice(0, 32).map((pattern) => ({
      patternKey: pattern.patternKey,
      familyKey: pattern.familyKey,
      rowBand: pattern.rowBand,
      xField: pattern.xField,
      yField: pattern.yField,
      mapping: pattern.mapping,
      confidence: pattern.confidence,
      support: pattern.support,
    })),
    participants: participantMatches,
  };

  writeJson(outputPath, validationReport);
  console.log(`Wrote movement validation report to ${outputPath}`);
}

main();
