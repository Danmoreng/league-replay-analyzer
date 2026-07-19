#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function usage() {
  console.log(`Usage: scripts/run_decoder_corpus.sh [options]

Options:
  --replay-root <path>            Replay corpus (default: replays)
  --api-root <path>               Saved API fixtures (default: replays/api)
  --artifact-root <path>          Output root (default: artifacts)
  --analyzer <path>               Native rofl_core_cli path
  --build-dir <path>              Native build directory (default: build-linux)
  --configuration <value>         Debug or Release (default: Debug)
  --top-families <n>              Top families (default: 8)
  --top-windows <n>               Schema windows (default: 16)
  --top-fields <n>                Cleaned fields (default: 16)
  --max-schema-iterations <n>      Convergence iterations (default: 3)
  --force                          Regenerate derived outputs
  --clean-replay-artifacts         Clean each selected replay directory first
  --require-empty-artifact-root    Refuse an existing non-empty output root
  --skip-schema                    Skip per-replay provisional schemas
  --skip-corpus-schema             Skip cross-replay schema generation
  --skip-extraction                Skip replay-only stat extraction
  --skip-validation                Skip stat validation
  --skip-movement                  Skip movement research/scoring stages
  --score-only                     Emit compact full-corpus scorecard inputs
  -h, --help                       Show this help`);
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
    replayRoot: "replays",
    apiRoot: "replays/api",
    artifactRoot: "artifacts",
    analyzer: "",
    buildDir: "build-linux",
    configuration: "Debug",
    topFamilies: 8,
    topWindows: 16,
    topFields: 16,
    maxSchemaIterations: 3,
    force: false,
    cleanReplayArtifacts: false,
    requireEmptyArtifactRoot: false,
    skipSchema: false,
    skipCorpusSchema: false,
    skipExtraction: false,
    skipValidation: false,
    skipMovement: false,
    scoreOnly: false,
  };
  const values = new Map([
    ["--replay-root", "replayRoot"],
    ["--api-root", "apiRoot"],
    ["--artifact-root", "artifactRoot"],
    ["--analyzer", "analyzer"],
    ["--build-dir", "buildDir"],
    ["--configuration", "configuration"],
  ]);
  const integers = new Map([
    ["--top-families", ["topFamilies", 1]],
    ["--top-windows", ["topWindows", 0]],
    ["--top-fields", ["topFields", 0]],
    ["--max-schema-iterations", ["maxSchemaIterations", 1]],
  ]);
  const flags = new Map([
    ["--force", "force"],
    ["--clean-replay-artifacts", "cleanReplayArtifacts"],
    ["--require-empty-artifact-root", "requireEmptyArtifactRoot"],
    ["--skip-schema", "skipSchema"],
    ["--skip-corpus-schema", "skipCorpusSchema"],
    ["--skip-extraction", "skipExtraction"],
    ["--skip-validation", "skipValidation"],
    ["--skip-movement", "skipMovement"],
    ["--score-only", "scoreOnly"],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || arg === "--help") {
      usage();
      process.exit(0);
    }
    if (flags.has(arg)) args[flags.get(arg)] = true;
    else if (values.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value.`);
      args[values.get(arg)] = argv[++index];
    } else if (integers.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value.`);
      const [key, minimum] = integers.get(arg);
      args[key] = parseInteger(arg, argv[++index], minimum);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["Debug", "Release"].includes(args.configuration)) {
    throw new Error("--configuration must be Debug or Release.");
  }
  return args;
}

function resolveFromRepo(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} not found: ${filePath}`);
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function latestMtime(paths) {
  let latest = 0;
  for (const candidate of paths.filter(Boolean)) {
    if (!fs.existsSync(candidate)) return null;
    latest = Math.max(latest, fs.statSync(candidate).mtimeMs);
  }
  return latest;
}

function outputsFresh(outputs, inputs, force) {
  if (force || outputs.length === 0) return false;
  const newestInput = latestMtime(inputs);
  if (newestInput == null) return false;
  return outputs.every((output) => fs.existsSync(output) && fs.statSync(output).mtimeMs >= newestInput);
}

function runNode(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(scriptPath)} exited with ${result.status}.`);
  }
}

function schemaFingerprint(schemaPath) {
  if (!fs.existsSync(schemaPath)) return null;
  const schema = readJson(schemaPath);
  if (schema.schemaFingerprint) return String(schema.schemaFingerprint);
  if (Object.hasOwn(schema, "generatedAtUtc")) schema.generatedAtUtc = null;
  return JSON.stringify(schema);
}

function extractedSchemaFingerprint(extractedPath) {
  if (!fs.existsSync(extractedPath)) return null;
  return readJson(extractedPath).schemaFingerprint ?? null;
}

function validationExtractedFingerprint(validationPath) {
  if (!fs.existsSync(validationPath)) return null;
  return readJson(validationPath).extractedStatsFingerprint ?? null;
}

function main() {
  const args = parseArgs(process.argv);
  const replayRoot = resolveFromRepo(args.replayRoot);
  const apiRoot = resolveFromRepo(args.apiRoot);
  const artifactRoot = resolveFromRepo(args.artifactRoot);
  if (!fs.existsSync(replayRoot) || !fs.statSync(replayRoot).isDirectory()) {
    throw new Error(`Replay root not found: ${replayRoot}`);
  }
  if (!fs.existsSync(apiRoot) || !fs.statSync(apiRoot).isDirectory()) {
    throw new Error(`API fixture root not found: ${apiRoot}`);
  }
  if (args.requireEmptyArtifactRoot && fs.existsSync(artifactRoot)) {
    if (!fs.statSync(artifactRoot).isDirectory()) {
      throw new Error(`Expected an artifact directory, found a file: ${artifactRoot}`);
    }
    if (fs.readdirSync(artifactRoot).length > 0) {
      throw new Error(`Refusing non-empty artifact root: ${artifactRoot}`);
    }
  }
  fs.mkdirSync(artifactRoot, { recursive: true });

  const scripts = Object.fromEntries([
    "artifact:run_decoder_artifacts.mjs",
    "provisional:build_provisional_schema.mjs",
    "corpus:build_corpus_schema.mjs",
    "extract:extract_replay_stats.mjs",
    "validate:validate_extracted_stats.mjs",
    "discoverMovement:discover_movement_candidates.mjs",
    "extractMovement:extract_replay_movement.mjs",
    "validateMovement:validate_movement_candidates.mjs",
    "movementPriors:build_movement_identity_priors.mjs",
    "assignMovement:assign_replay_movement.mjs",
    "validateAssignedMovement:validate_assigned_movement.mjs",
    "movementModel:build_movement_coordinate_model.mjs",
  ].map((entry) => {
    const [key, name] = entry.split(":");
    const scriptPath = path.join(SCRIPT_DIR, name);
    requireFile(scriptPath, `${name} script`);
    return [key, scriptPath];
  }));
  const schemaUtils = path.join(SCRIPT_DIR, "lib", "decoder-schema-utils.mjs");
  const scalarUtils = path.join(SCRIPT_DIR, "lib", "scalar-bundle-utils.mjs");
  requireFile(schemaUtils, "decoder schema utility");
  requireFile(scalarUtils, "scalar bundle utility");

  const replayFiles = fs.readdirSync(replayRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".rofl"))
    .map((entry) => path.join(replayRoot, entry.name))
    .sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  if (replayFiles.length === 0) throw new Error(`No .rofl files found under ${replayRoot}`);

  const processed = [];
  for (const replayPath of replayFiles) {
    const replayName = path.basename(replayPath);
    const replayId = path.basename(replayPath, path.extname(replayPath));
    const fixtureDir = path.join(apiRoot, replayId.replaceAll("-", "_"));
    if (!["match.json", "timeline.json"].every((name) => fs.existsSync(path.join(fixtureDir, name)))) {
      console.warn(`Skipping ${replayName}: fixture bundle missing under ${fixtureDir}`);
      continue;
    }
    console.log(`Generating decoder artifacts for ${replayName}`);
    const artifactArgs = [
      "--replay", replayPath,
      "--artifact-root", artifactRoot,
      "--build-dir", resolveFromRepo(args.buildDir),
      "--configuration", args.configuration,
      "--top-families", String(args.topFamilies),
      "--top-windows", String(args.topWindows),
      "--top-fields", String(args.topFields),
    ];
    if (args.analyzer) artifactArgs.push("--analyzer", resolveFromRepo(args.analyzer));
    if (args.scoreOnly) artifactArgs.push("--score-only");
    if (args.force) artifactArgs.push("--force");
    if (args.cleanReplayArtifacts) artifactArgs.push("--clean");
    runNode(scripts.artifact, artifactArgs);

    const artifactDir = path.join(artifactRoot, replayId);
    if (!args.skipSchema) {
      const schemaOutputs = [
        path.join(artifactDir, "provisional-schema.json"),
        path.join(artifactDir, "candidate-matches.json"),
      ];
      const schemaInputs = [
        path.join(artifactDir, "run-manifest.json"),
        path.join(fixtureDir, "match.json"),
        path.join(fixtureDir, "timeline.json"),
        scripts.provisional,
      ];
      if (outputsFresh(schemaOutputs, schemaInputs, args.force)) {
        console.log(`Reusing provisional schema for ${replayName}`);
      } else {
        console.log(`Building provisional schema for ${replayName}`);
        const provisionalArgs = ["--artifact-dir", artifactDir, "--fixture-dir", fixtureDir];
        if (args.scoreOnly) provisionalArgs.push("--score-only");
        runNode(scripts.provisional, provisionalArgs);
      }
    }
    processed.push({ replayName, replayId, artifactDir, fixtureDir });
  }
  if (processed.length === 0) throw new Error("No replays had complete saved API fixture bundles.");

  const manifestPath = path.join(artifactRoot, "corpus-manifest.json");
  const corpusSchemaPath = path.join(artifactRoot, "corpus-schema.json");
  const manifest = {
    generatedAtUtc: new Date().toISOString(),
    replayRoot,
    apiRoot,
    artifactRoot,
    scoreOnly: args.scoreOnly,
    processed,
  };
  const saveManifest = () => {
    manifest.generatedAtUtc = new Date().toISOString();
    manifest.processed = processed;
    writeJson(manifestPath, manifest);
  };
  saveManifest();

  const corpusSchemaInputs = (includeValidation = false) => {
    const inputs = [scripts.corpus, schemaUtils, scalarUtils];
    for (const entry of processed) {
      inputs.push(
        path.join(entry.artifactDir, "run-manifest.json"),
        path.join(entry.artifactDir, "provisional-schema.json"),
        path.join(entry.artifactDir, "candidate-matches.json"),
      );
      if (includeValidation) inputs.push(
        path.join(entry.artifactDir, "extracted-stats.json"),
        path.join(entry.artifactDir, "validation-report.json"),
      );
    }
    return inputs;
  };
  const buildCorpusSchema = (includeValidation = false) => {
    if (outputsFresh([corpusSchemaPath], corpusSchemaInputs(includeValidation), args.force)) {
      console.log("Reusing cross-replay corpus schema");
    } else {
      console.log(includeValidation ? "Rebuilding cross-replay corpus schema" : "Building cross-replay corpus schema");
      runNode(scripts.corpus, [
        "--artifact-root", artifactRoot,
        "--corpus-manifest", manifestPath,
        "--output-path", corpusSchemaPath,
      ]);
    }
  };

  let corpusFingerprint = null;
  if (!args.skipCorpusSchema) {
    buildCorpusSchema(false);
    manifest.corpusSchemaPath = corpusSchemaPath;
    corpusFingerprint = schemaFingerprint(corpusSchemaPath);
    saveManifest();
  }

  const extractAll = (expectedFingerprint, refreshed = false) => {
    for (const entry of processed) {
      const extractedPath = path.join(entry.artifactDir, "extracted-stats.json");
      const inputs = [
        scripts.extract, schemaUtils, scalarUtils,
        path.join(entry.artifactDir, "run-manifest.json"),
        path.join(entry.artifactDir, "provisional-schema.json"),
        path.join(entry.artifactDir, "candidate-matches.json"),
      ];
      const fresh = extractedSchemaFingerprint(extractedPath) === expectedFingerprint &&
        outputsFresh([extractedPath], inputs, args.force);
      if (fresh) console.log(`Reusing replay-only stats for ${entry.replayName}`);
      else {
        console.log(`${refreshed ? "Re-extracting" : "Extracting"} replay-only stats for ${entry.replayName}`);
        runNode(scripts.extract, [
          "--artifact-dir", entry.artifactDir,
          "--schema-path", corpusSchemaPath,
          "--output-path", extractedPath,
        ]);
      }
      entry.extractedStatsPath = extractedPath;
    }
    saveManifest();
  };

  const validateAll = (refreshed = false) => {
    for (const entry of processed) {
      const extractedPath = entry.extractedStatsPath ?? path.join(entry.artifactDir, "extracted-stats.json");
      requireFile(extractedPath, `Extracted stats for ${entry.replayName}`);
      const validationPath = path.join(entry.artifactDir, "validation-report.json");
      const expected = extractedSchemaFingerprint(extractedPath);
      const inputs = [
        scripts.validate, extractedPath,
        path.join(entry.fixtureDir, "match.json"),
        path.join(entry.fixtureDir, "timeline.json"),
      ];
      const fresh = validationExtractedFingerprint(validationPath) === expected &&
        outputsFresh([validationPath], inputs, args.force);
      if (fresh) console.log(`Reusing validation report for ${entry.replayName}`);
      else {
        console.log(`${refreshed ? "Re-validating" : "Validating"} extracted stats for ${entry.replayName}`);
        runNode(scripts.validate, [
          "--extracted-path", extractedPath,
          "--fixture-dir", entry.fixtureDir,
          "--output-path", validationPath,
        ]);
      }
      entry.validationReportPath = validationPath;
    }
    saveManifest();
  };

  if (!args.skipExtraction) {
    if (!fs.existsSync(corpusSchemaPath)) {
      throw new Error(`Replay-only extraction requires corpus schema at ${corpusSchemaPath}`);
    }
    if (!corpusFingerprint) corpusFingerprint = schemaFingerprint(corpusSchemaPath);
    extractAll(corpusFingerprint);
  }
  if (!args.skipValidation) validateAll();

  if (!args.skipCorpusSchema && !args.skipExtraction && !args.skipValidation) {
    const seen = new Set(corpusFingerprint ? [corpusFingerprint] : []);
    let converged = false;
    let cycleDetected = false;
    for (let iteration = 1; iteration <= args.maxSchemaIterations; iteration += 1) {
      buildCorpusSchema(true);
      const nextFingerprint = schemaFingerprint(corpusSchemaPath);
      if (nextFingerprint === corpusFingerprint) {
        console.log(`Corpus schema converged after ${iteration} refresh iteration(s)`);
        converged = true;
        break;
      }
      const repeated = nextFingerprint && seen.has(nextFingerprint);
      if (nextFingerprint) seen.add(nextFingerprint);
      extractAll(nextFingerprint, true);
      validateAll(true);
      corpusFingerprint = nextFingerprint;
      if (repeated) {
        console.warn(`Detected a repeating corpus schema cycle after ${iteration} refresh iteration(s)`);
        cycleDetected = true;
        break;
      }
    }
    if (!converged && !cycleDetected) {
      console.warn(`Corpus schema did not fully converge after ${args.maxSchemaIterations} refresh iteration(s)`);
    }
  }

  if (!args.skipMovement) {
    const coordinateModelPath = path.join(artifactRoot, "movement-coordinate-model.json");
    for (const entry of processed) {
      const candidatePath = path.join(entry.artifactDir, "movement-candidate-matches.json");
      const movementSchemaPath = path.join(entry.artifactDir, "movement-provisional-schema.json");
      const extractedMovementPath = path.join(entry.artifactDir, "extracted-movement.json");
      const movementValidationPath = path.join(entry.artifactDir, "movement-validation-report.json");
      const discoveryOutputs = args.scoreOnly ? [movementSchemaPath] : [candidatePath, movementSchemaPath];
      const discoveryInputs = [
        scripts.discoverMovement,
        path.join(entry.artifactDir, "run-manifest.json"),
        path.join(entry.fixtureDir, "match.json"),
        path.join(entry.fixtureDir, "timeline.json"),
      ];
      if (fs.existsSync(coordinateModelPath)) discoveryInputs.push(coordinateModelPath);
      if (outputsFresh(discoveryOutputs, discoveryInputs, args.force)) {
        console.log(`Reusing movement candidates for ${entry.replayName}`);
      } else {
        console.log(`Discovering movement candidates for ${entry.replayName}`);
        const discoveryArgs = ["--artifact-dir", entry.artifactDir, "--fixture-dir", entry.fixtureDir];
        if (fs.existsSync(coordinateModelPath)) discoveryArgs.push("--coordinate-model-path", coordinateModelPath);
        if (args.scoreOnly) discoveryArgs.push("--compact-score-only");
        runNode(scripts.discoverMovement, discoveryArgs);
      }
      const extractionInputs = [scripts.extractMovement, movementSchemaPath, path.join(entry.artifactDir, "run-manifest.json")];
      if (outputsFresh([extractedMovementPath], extractionInputs, args.force)) {
        console.log(`Reusing movement tracks for ${entry.replayName}`);
      } else {
        console.log(`Extracting movement tracks for ${entry.replayName}`);
        runNode(scripts.extractMovement, [
          "--artifact-dir", entry.artifactDir,
          "--schema-path", movementSchemaPath,
          "--output-path", extractedMovementPath,
        ]);
      }
      if (!args.scoreOnly) {
        const validationInputs = [scripts.validateMovement, candidatePath, movementSchemaPath, path.join(entry.fixtureDir, "timeline.json")];
        if (!outputsFresh([movementValidationPath], validationInputs, args.force)) {
          console.log(`Validating movement candidates for ${entry.replayName}`);
          runNode(scripts.validateMovement, [
            "--candidate-matches-path", candidatePath,
            "--provisional-schema-path", movementSchemaPath,
            "--output-path", movementValidationPath,
          ]);
        }
        entry.movementCandidatePath = candidatePath;
        entry.movementValidationPath = movementValidationPath;
      }
      entry.movementSchemaPath = movementSchemaPath;
      entry.movementExtractedPath = extractedMovementPath;
    }
    saveManifest();

    const priorsPath = path.join(artifactRoot, "movement-identity-priors.json");
    const priorsInputs = [scripts.movementPriors];
    for (const entry of processed) {
      if (args.scoreOnly) priorsInputs.push(path.join(entry.artifactDir, "summary.json"), entry.movementSchemaPath);
      else priorsInputs.push(entry.movementCandidatePath, entry.movementSchemaPath, entry.movementExtractedPath, entry.movementValidationPath);
    }
    if (!outputsFresh([priorsPath], priorsInputs, args.force)) {
      console.log("Building movement identity priors");
      runNode(scripts.movementPriors, [
        "--artifact-root", artifactRoot,
        "--corpus-manifest", manifestPath,
        "--output-path", priorsPath,
      ]);
    }
    manifest.movementIdentityPriorsPath = priorsPath;

    for (const entry of processed) {
      const participantMovementPath = path.join(entry.artifactDir, "participant-movement.json");
      const assignedValidationPath = path.join(entry.artifactDir, "assigned-movement-validation-report.json");
      const assignmentInputs = [
        scripts.assignMovement, priorsPath, entry.movementExtractedPath,
        path.join(entry.artifactDir, "extracted-stats.json"),
      ];
      if (!outputsFresh([participantMovementPath], assignmentInputs, args.force)) {
        console.log(`Assigning movement tracks to participants for ${entry.replayName}`);
        runNode(scripts.assignMovement, [
          "--artifact-dir", entry.artifactDir,
          "--priors-path", priorsPath,
          "--output-path", participantMovementPath,
        ]);
      }
      const assignedInputs = [
        scripts.validateAssignedMovement, participantMovementPath,
        path.join(entry.fixtureDir, "timeline.json"),
      ];
      if (!outputsFresh([assignedValidationPath], assignedInputs, args.force)) {
        console.log(`Validating participant-labelled movement for ${entry.replayName}`);
        runNode(scripts.validateAssignedMovement, [
          "--participant-movement-path", participantMovementPath,
          "--fixture-dir", entry.fixtureDir,
          "--output-path", assignedValidationPath,
        ]);
      }
      entry.participantMovementPath = participantMovementPath;
      entry.assignedMovementValidationPath = assignedValidationPath;
    }
    saveManifest();

    if (!args.scoreOnly) {
      const modelInputs = [scripts.movementModel];
      for (const entry of processed) modelInputs.push(entry.movementValidationPath, entry.assignedMovementValidationPath);
      if (!outputsFresh([coordinateModelPath], modelInputs, args.force)) {
        console.log("Building movement coordinate model");
        runNode(scripts.movementModel, [
          "--artifact-root", artifactRoot,
          "--corpus-manifest", manifestPath,
          "--output-path", coordinateModelPath,
        ]);
      }
      manifest.movementCoordinateModelPath = coordinateModelPath;
    } else console.log("Skipping diagnostic movement coordinate model in score-only mode");
  }

  saveManifest();
  console.log(`Wrote corpus manifest to ${manifestPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
