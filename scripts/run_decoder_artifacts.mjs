#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function usage() {
  console.log(`Usage: scripts/run_decoder_artifacts.sh --replay <file.rofl> [options]

Options:
  --artifact-root <path>       Artifact root (default: artifacts)
  --analyzer <path>            Native rofl_core_cli path
  --build-dir <path>           Native build directory (default: build-linux)
  --configuration <value>      Debug or Release (default: Debug)
  --min-length <n>             Minimum family length (default: 4096)
  --min-records <n>            Minimum family records (default: 4)
  --top-families <n>           Top families (default: 8)
  --top-entity-slots <n>       Entity slots (default: 24)
  --top-scalar-slots <n>       Scalar slots (default: 18)
  --dynamic-slot-count <n>     Dynamic slots (default: 8)
  --mixed-slot-count <n>       Mixed slots (default: 2)
  --handle-slot-count <n>      Handle slots (default: 0)
  --top-windows <n>            Schema windows (default: 16)
  --top-fields <n>             Cleaned fields (default: 16)
  --record-type <value>        chunk, keyframe, startup, or all
  --skip-scalar                Skip scalar-family analysis
  --score-only                 Emit compact scorecard inputs
  --clean                      Remove this replay's artifact directory first
  --force                      Ignore a fresh run manifest and regenerate
  -h, --help                   Show this help`);
}

function parseInteger(option, value, minimum = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${option} requires an integer >= ${minimum}.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    replayPath: "",
    artifactRoot: "artifacts",
    analyzer: "",
    buildDir: "build-linux",
    configuration: "Debug",
    minLength: 4096,
    minRecords: 4,
    topFamilies: 8,
    topEntitySlots: 24,
    topScalarSlots: 18,
    dynamicSlotCount: 8,
    mixedSlotCount: 2,
    handleSlotCount: 0,
    topWindows: 16,
    topFields: 16,
    recordType: "chunk",
    skipScalar: false,
    scoreOnly: false,
    clean: false,
    force: false,
  };
  const valueOptions = new Map([
    ["--replay", "replayPath"],
    ["--replay-path", "replayPath"],
    ["--artifact-root", "artifactRoot"],
    ["--analyzer", "analyzer"],
    ["--build-dir", "buildDir"],
    ["--configuration", "configuration"],
    ["--record-type", "recordType"],
  ]);
  const integerOptions = new Map([
    ["--min-length", ["minLength", 1]],
    ["--min-records", ["minRecords", 1]],
    ["--top-families", ["topFamilies", 1]],
    ["--top-entity-slots", ["topEntitySlots", 0]],
    ["--top-scalar-slots", ["topScalarSlots", 0]],
    ["--dynamic-slot-count", ["dynamicSlotCount", 0]],
    ["--mixed-slot-count", ["mixedSlotCount", 0]],
    ["--handle-slot-count", ["handleSlotCount", 0]],
    ["--top-windows", ["topWindows", 0]],
    ["--top-fields", ["topFields", 0]],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--skip-scalar") args.skipScalar = true;
    else if (arg === "--score-only") args.scoreOnly = true;
    else if (arg === "--clean") args.clean = true;
    else if (arg === "--force") args.force = true;
    else if (valueOptions.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value.`);
      args[valueOptions.get(arg)] = argv[++index];
    } else if (integerOptions.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value.`);
      const [key, minimum] = integerOptions.get(arg);
      args[key] = parseInteger(arg, argv[++index], minimum);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.replayPath) throw new Error("--replay is required.");
  if (!["Debug", "Release"].includes(args.configuration)) {
    throw new Error("--configuration must be Debug or Release.");
  }
  if (!["chunk", "keyframe", "startup", "all"].includes(args.recordType)) {
    throw new Error("--record-type must be chunk, keyframe, startup, or all.");
  }
  return args;
}

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

function resolveAnalyzer(args) {
  if (args.analyzer) {
    const explicit = resolveFromRepo(args.analyzer);
    if (!fs.existsSync(explicit)) throw new Error(`Analyzer executable not found: ${explicit}`);
    return explicit;
  }
  const buildDir = resolveFromRepo(args.buildDir);
  const candidates = [
    path.join(buildDir, "packages", "rofl-core", "rofl_core_cli"),
    path.join(buildDir, "packages", "rofl-core", args.configuration, "rofl_core_cli"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new Error(`Could not find rofl_core_cli under ${buildDir}; build it or pass --analyzer.`);
  }
  return resolved;
}

function fingerprint(filePath) {
  const stat = fs.statSync(filePath);
  return {
    path: path.resolve(filePath),
    length: stat.isDirectory() ? null : stat.size,
    lastWriteTimeUtc: stat.mtime.toISOString(),
  };
}

function sameFingerprint(left, right) {
  return left?.path === right?.path && left?.length === right?.length &&
    left?.lastWriteTimeUtc === right?.lastWriteTimeUtc;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeReplayArtifactDirectory(artifactRoot, replayArtifactDir) {
  const relative = path.relative(artifactRoot, replayArtifactDir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe artifact cleanup: ${replayArtifactDir}`);
  }
  fs.rmSync(replayArtifactDir, { recursive: true, force: true });
}

function manifestIsFresh(manifestPath, replayArtifactDir, inputs, parameters) {
  if (!fs.existsSync(manifestPath)) return false;
  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return false;
  }
  if (!sameFingerprint(manifest.inputs?.replay, inputs.replay) ||
      !sameFingerprint(manifest.inputs?.analyzerExe, inputs.analyzerExe) ||
      !sameFingerprint(manifest.inputs?.runnerScript, inputs.runnerScript) ||
      JSON.stringify(manifest.parameters) !== JSON.stringify(parameters)) return false;
  for (const required of ["summary.json", "family-scan.json"]) {
    if (!fs.existsSync(path.join(replayArtifactDir, required))) return false;
  }
  for (const family of manifest.families ?? []) {
    const familyDir = path.join(replayArtifactDir, "families", family.familyKey);
    if (!fs.existsSync(familyDir)) return false;
    for (const relativeFile of Object.values(family.files ?? {})) {
      if (relativeFile && !fs.existsSync(path.join(familyDir, relativeFile))) return false;
    }
  }
  return true;
}

function invokeAnalyzer(executable, analyzerArgs) {
  const result = spawnSync(executable, analyzerArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() ||
      `Decoder command exited with ${result.status}.`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Decoder returned invalid JSON: ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const replayPath = resolveFromRepo(args.replayPath);
  if (!fs.existsSync(replayPath) || !fs.statSync(replayPath).isFile()) {
    throw new Error(`Replay file not found: ${replayPath}`);
  }
  const artifactRoot = resolveFromRepo(args.artifactRoot);
  const replayId = path.basename(replayPath, path.extname(replayPath));
  const replayArtifactDir = path.join(artifactRoot, replayId);
  const analyzer = resolveAnalyzer(args);
  if (args.clean && fs.existsSync(replayArtifactDir)) {
    console.log(`Cleaning existing artifact directory ${replayArtifactDir}`);
    removeReplayArtifactDirectory(artifactRoot, replayArtifactDir);
  }
  fs.mkdirSync(replayArtifactDir, { recursive: true });

  const effectiveSkipScalar = args.skipScalar || args.scoreOnly;
  const parameters = {
    configuration: args.configuration,
    minLength: args.minLength,
    minRecords: args.minRecords,
    topFamilies: args.topFamilies,
    topEntitySlots: args.topEntitySlots,
    topScalarSlots: args.topScalarSlots,
    dynamicSlotCount: args.dynamicSlotCount,
    mixedSlotCount: args.mixedSlotCount,
    handleSlotCount: args.handleSlotCount,
    topWindows: args.topWindows,
    topFields: args.topFields,
    recordType: args.recordType,
    skipScalar: effectiveSkipScalar,
    scoreOnly: args.scoreOnly,
  };
  const inputs = {
    replay: fingerprint(replayPath),
    analyzerExe: fingerprint(analyzer),
    runnerScript: fingerprint(SCRIPT_PATH),
  };
  const manifestPath = path.join(replayArtifactDir, "run-manifest.json");
  if (!args.clean && !args.force && manifestIsFresh(manifestPath, replayArtifactDir, inputs, parameters)) {
    console.log(`Reusing cached decoder artifacts for ${replayId}`);
    return;
  }

  const analyzerArgs = [
    "--analyze-artifact-bundle-json", replayPath,
    "--min-length", String(args.minLength),
    "--min-records", String(args.minRecords),
    "--top-families", String(args.topFamilies),
    "--top-entity-slots", String(args.topEntitySlots),
    "--top-scalar-slots", String(args.topScalarSlots),
    "--dynamic-slot-count", String(args.dynamicSlotCount),
    "--mixed-slot-count", String(args.mixedSlotCount),
    "--handle-slot-count", String(args.handleSlotCount),
    "--top-windows", String(args.topWindows),
    "--top-fields", String(args.topFields),
    "--record-type", args.recordType,
  ];
  if (effectiveSkipScalar) analyzerArgs.push("--skip-scalar");
  console.log(`Generating native decoder artifact bundle for ${replayId}`);
  const bundle = invokeAnalyzer(analyzer, analyzerArgs);
  if (!bundle.summary || !bundle.familyScan || !Array.isArray(bundle.families)) {
    throw new Error("Native artifact bundle is missing summary, familyScan, or families.");
  }
  writeJson(path.join(replayArtifactDir, "summary.json"), bundle.summary);
  writeJson(path.join(replayArtifactDir, "family-scan.json"), bundle.familyScan);

  const families = [];
  for (const family of bundle.families) {
    const familyDir = path.join(replayArtifactDir, "families", family.familyKey);
    fs.mkdirSync(familyDir, { recursive: true });
    if (!args.scoreOnly) writeJson(path.join(familyDir, "entity-slab.json"), family.entitySlab);
    if (!effectiveSkipScalar && family.scalar != null) writeJson(path.join(familyDir, "scalar.json"), family.scalar);
    if (!args.scoreOnly && family.schema != null) writeJson(path.join(familyDir, "schema.json"), family.schema);
    if (family.cleaned != null) writeJson(path.join(familyDir, "cleaned.json"), family.cleaned);
    const familyManifest = {
      familyKey: String(family.familyKey),
      length: Number(family.length),
      firstByte: Number(family.firstByte),
      headerSize: Number(family.headerSize),
      stride: Number(family.stride),
      recordCount: Number(family.recordCount),
      segmentCount: family.segmentCount == null ? null : Number(family.segmentCount),
      chunkCount: Number(family.chunkCount),
      selectedSlots: (family.selectedSlots ?? []).map(Number),
      dynamicSlots: (family.dynamicSlots ?? []).map(Number),
      mixedSlots: (family.mixedSlots ?? []).map(Number),
      handleSlots: (family.handleSlots ?? []).map(Number),
      files: {
        entitySlab: args.scoreOnly ? null : "entity-slab.json",
        scalar: effectiveSkipScalar || family.scalar == null ? null : "scalar.json",
        schema: args.scoreOnly || family.schema == null ? null : "schema.json",
        cleaned: family.cleaned == null ? null : "cleaned.json",
      },
    };
    if (!args.scoreOnly) writeJson(path.join(familyDir, "analysis-plan.json"), familyManifest);
    families.push(familyManifest);
  }

  writeJson(manifestPath, {
    replayId,
    replayPath,
    analyzerExe: analyzer,
    generatedAtUtc: new Date().toISOString(),
    summary: {
      gameVersion: bundle.summary.gameVersion,
      gameLengthMillis: bundle.summary.gameLengthMillis,
      playerCount: bundle.summary.playerCount,
    },
    inputs,
    parameters,
    families,
  });
  console.log(`Wrote decoder artifacts to ${replayArtifactDir} using native batch mode`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
