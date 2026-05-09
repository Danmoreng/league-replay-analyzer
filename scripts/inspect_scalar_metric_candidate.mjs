import path from "path";

import {
  readJson,
  resolveAbsolute,
  writeJson,
} from "./lib/decoder-schema-utils.mjs";

function parseArgs(argv) {
  const args = {
    artifactRoot: "artifacts",
    versionGroup: null,
    metric: null,
    groupKey: null,
    familyBand: false,
    outputPath: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--artifact-root" && index + 1 < argv.length) {
      args.artifactRoot = argv[++index];
    } else if (arg === "--version-group" && index + 1 < argv.length) {
      args.versionGroup = argv[++index];
    } else if (arg === "--metric" && index + 1 < argv.length) {
      args.metric = argv[++index];
    } else if (arg === "--group-key" && index + 1 < argv.length) {
      args.groupKey = argv[++index];
    } else if (arg === "--family-band") {
      args.familyBand = true;
    } else if (arg === "--output-path" && index + 1 < argv.length) {
      args.outputPath = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (!args.versionGroup) {
    throw new Error("Missing required --version-group <value> argument.");
  }
  if (!args.metric) {
    throw new Error("Missing required --metric <key> argument.");
  }
  if (!args.groupKey) {
    throw new Error("Missing required --group-key <value> argument.");
  }

  return args;
}

function printHelp() {
  console.log("Usage: node ./scripts/inspect_scalar_metric_candidate.mjs --version-group <value> --metric <key> --group-key <key> [--family-band] [--artifact-root <path>] [--output-path <path>]");
}

function buildOutputPath(artifactRoot, versionGroup, metric, groupKey, familyBand, explicitOutputPath) {
  if (explicitOutputPath) {
    return explicitOutputPath;
  }

  const safeGroupKey = groupKey.replace(/[^A-Za-z0-9._-]+/g, "_");
  const suffix = familyBand ? "family-band" : "exact";
  return path.join(
    artifactRoot,
    "scalar-metric-discovery",
    versionGroup,
    `${metric}-${suffix}-inspect-${safeGroupKey}.json`,
  );
}

function main() {
  const repoRoot = process.cwd();
  const args = parseArgs(process.argv);
  const artifactRoot = resolveAbsolute(repoRoot, args.artifactRoot);
  const reportPath = path.join(artifactRoot, "scalar-metric-discovery", args.versionGroup, `${args.metric}.json`);
  const report = readJson(reportPath);
  const supportList = args.familyBand ? (report.familyBandSupport ?? []) : (report.exactSupport ?? []);
  const match = supportList.find((entry) => entry.groupKey === args.groupKey);
  if (!match) {
    throw new Error(`Could not find ${args.familyBand ? "family-band" : "exact"} group ${args.groupKey} in ${reportPath}`);
  }

  const outputPath = buildOutputPath(
    artifactRoot,
    args.versionGroup,
    args.metric,
    args.groupKey,
    args.familyBand,
    args.outputPath ? resolveAbsolute(repoRoot, args.outputPath) : null,
  );

  const inspection = {
    generatedAtUtc: new Date().toISOString(),
    artifactRoot,
    reportPath,
    versionGroup: args.versionGroup,
    metric: args.metric,
    groupType: args.familyBand ? "familyBand" : "exact",
    groupKey: args.groupKey,
    candidate: match,
  };

  writeJson(outputPath, inspection);
  console.log(`Wrote scalar candidate inspection to ${outputPath}`);
}

main();
