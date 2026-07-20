#!/usr/bin/env node

// Freezes and validates replay-native XP lanes across every exact build in the
// saved corpus. Riot fixtures are offline labels only; candidates and runtime
// values always originate in champion-owned ROFL keyframe payloads.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PROFILE = path.join(
  "packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json",
);
const DEFAULT_CS_REPORT = path.join("tmp", "keyframe-cs-cross-patch.json");
const XP_THRESHOLDS = Object.freeze([
  0, 280, 660, 1140, 1720, 2400, 3180, 4060, 5040, 6120,
  7300, 8580, 9960, 11440, 13020, 14700, 16480, 18360, 20340, 22420,
]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    profilePath: DEFAULT_PROFILE,
    csReportPath: DEFAULT_CS_REPORT,
    outputPath: path.join("tmp", "keyframe-xp-cross-patch.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--decoder-profiles" && argv[index + 1]) args.profilePath = argv[++index];
    else if (arg === "--cs-report" && argv[index + 1]) args.csReportPath = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/research_keyframe_xp_cross_patch.mjs [--cli <path>] [--decoder-profiles <path>] [--cs-report <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) {
    throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function runJson(cliPath, cliArgs) {
  const result = spawnSync(cliPath, cliArgs, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `CLI exited with ${result.status}.`);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

function exactVersion(replayPath) {
  const bytes = fs.readFileSync(replayPath).subarray(0, 64);
  const match = /\d+\.\d+\.\d+\.\d+/.exec(bytes.toString("latin1"));
  assert(match, `Replay header contains no exact version: ${replayPath}`);
  return match[0];
}

function versionGroup(version) {
  return version.split(".").slice(0, 2).join(".");
}

function splitFixtures(fixtures) {
  if (fixtures.length === 1) return { discovery: fixtures, holdout: fixtures, participantSplit: true };
  const holdoutCount = Math.max(1, Math.ceil(fixtures.length / 3));
  return { discovery: fixtures.slice(0, -holdoutCount), holdout: fixtures.slice(-holdoutCount), participantSplit: false };
}

function fixturePartition(fixture, split, participantId) {
  if (split.participantSplit) return participantId <= 7 ? "Discovery" : "Holdout";
  return split.discovery.includes(fixture) ? "Discovery" : "Holdout";
}

function loadRows(args, fixtures, split, grammar) {
  const rows = [];
  for (const fixture of fixtures) {
    const timeline = JSON.parse(fs.readFileSync(fixture.timelinePath, "utf8"));
    const match = JSON.parse(fs.readFileSync(fixture.matchPath, "utf8"));
    const finalLevels = new Map(
      (match.info?.participants ?? []).map((participant) => [participant.participantId, participant.champLevel]),
    );
    const dump = runJson(args.cliPath, [
      "--dump-packet-type-json", fixture.replayPath,
      "--packet-type", String(grammar.packetType),
      "--segment-type", "keyframe", "--max-blocks", "0",
    ]);
    assert(dump.valid && !dump.errors?.length && dump.blocks.length % 10 === 0,
      `Keyframe dump failed for ${fixture.replayId}.`, dump.errors);
    for (let index = 0; index < dump.blocks.length; index += 1) {
      const block = dump.blocks[index];
      const participantId = block.blockParam - grammar.championNetworkIdBase;
      const frameIndex = Math.floor(index / 10);
      const frame = timeline.info?.frames?.[frameIndex];
      const nextFrame = timeline.info?.frames?.[frameIndex + 1];
      const api = frame?.participantFrames?.[participantId];
      const nextApi = nextFrame?.participantFrames?.[participantId];
      assert(
        participantId >= 1 && participantId <= 10 &&
        block.channel === 1 && block.contentLength === grammar.contentLength &&
        !block.contentHexTruncated && Number.isInteger(api?.xp) && Number.isInteger(api?.level) &&
        Number.isInteger(finalLevels.get(participantId)) &&
        Math.abs(block.timestampMillis - frame.timestamp) <= 2_000,
        `Replay/Timeline XP alignment failed for ${fixture.replayId}.`,
        { index, block, frameTimestamp: frame?.timestamp },
      );
      rows.push({
        replayId: fixture.replayId,
        participantId,
        timestampMillis: block.timestampMillis,
        partition: fixturePartition(fixture, split, participantId),
        payload: Buffer.from(block.contentHex, "hex"),
        xp: api.xp,
        level: api.level,
        nextXp: Number.isInteger(nextApi?.xp) ? nextApi.xp : null,
        nextLevel: Number.isInteger(nextApi?.level) ? nextApi.level : null,
        finalLevel: finalLevels.get(participantId),
      });
    }
  }
  return rows;
}

function deriveLevel(experience, finalLevel) {
  let level = 1;
  for (let index = 1; index < XP_THRESHOLDS.length; index += 1) {
    if (experience < XP_THRESHOLDS[index]) break;
    level = index + 1;
  }
  return Math.min(level, finalLevel > 18 ? 20 : 18);
}

function rowRawSymbols(row, offsets) {
  return offsets.map((offset) => row.payload[offset]);
}

function enumerateRow(rawSymbols, known, domains, callback, limit = 1_000_000) {
  const unknown = [...new Set(rawSymbols.filter((raw) => !known.has(raw)))];
  const assignment = new Map(known);
  const usedPlain = new Set(known.values());
  let count = 0;
  function visit(index) {
    if (count > limit) return;
    if (index === unknown.length) {
      count += 1;
      callback(Buffer.from(rawSymbols.map((raw) => assignment.get(raw))).readFloatLE(0), assignment);
      return;
    }
    const raw = unknown[index];
    for (const plain of domains.get(raw) ?? []) {
      if (usedPlain.has(plain)) continue;
      assignment.set(raw, plain);
      usedPlain.add(plain);
      visit(index + 1);
      usedPlain.delete(plain);
      assignment.delete(raw);
      if (count > limit) return;
    }
  }
  visit(0);
  return count;
}

function refineXpCipher(rows, offsets, grammar) {
  const known = new Map(
    grammar.cipherToPlain.flatMap((plain, raw) => plain === null ? [] : [[raw, plain]]),
  );
  const usedPlain = new Set(known.values());
  const unusedPlain = new Set(Array.from({ length: 256 }, (_, value) => value).filter((value) => !usedPlain.has(value)));
  const existingDomains = new Map(
    (grammar.ambiguousCipherMappings ?? []).map((entry) => [entry.cipher, new Set(entry.plain)]),
  );
  const relevant = new Set(rows.flatMap((row) => rowRawSymbols(row, offsets)).filter((raw) => !known.has(raw)));
  const domains = new Map(existingDomains);
  for (const raw of relevant) {
    if (!domains.has(raw)) domains.set(raw, new Set(unusedPlain));
  }

  let changed = true;
  let passCount = 0;
  while (changed && passCount < 64) {
    passCount += 1;
    changed = false;

    for (const [raw, domain] of [...domains]) {
      if (domain.size !== 1) continue;
      const plain = [...domain][0];
      const conflictingRaw = [...known].find(([, value]) => value === plain)?.[0];
      assert(conflictingRaw === undefined, "XP cipher singleton conflicts with a known mapping.", { raw, plain, conflictingRaw });
      known.set(raw, plain);
      domains.delete(raw);
      for (const otherDomain of domains.values()) otherDomain.delete(plain);
      changed = true;
    }

    for (const row of rows) {
      const rawSymbols = rowRawSymbols(row, offsets);
      const unknown = [...new Set(rawSymbols.filter((raw) => !known.has(raw)))];
      if (unknown.length === 0) continue;
      const allowed = new Map(unknown.map((raw) => [raw, new Set()]));
      let solutionCount = 0;
      const assignmentCount = enumerateRow(rawSymbols, known, domains, (value, assignment) => {
        if (!Number.isFinite(value) || value < 0 || Math.floor(value) !== row.xp) return;
        solutionCount += 1;
        for (const raw of unknown) allowed.get(raw).add(assignment.get(raw));
      });
      assert(assignmentCount <= 1_000_000 && solutionCount > 0,
        "XP cipher domain search has no bounded solution.",
        { replayId: row.replayId, participantId: row.participantId, timestampMillis: row.timestampMillis, rawSymbols, assignmentCount });
      for (const raw of unknown) {
        const domain = domains.get(raw);
        for (const plain of [...domain]) {
          if (!allowed.get(raw).has(plain)) {
            domain.delete(plain);
            changed = true;
          }
        }
        assert(domain.size > 0, "XP cipher refinement produced an empty domain.", { raw });
      }
    }
  }
  assert(passCount < 64, "XP cipher refinement did not converge.");

  const validation = validateRows(rows, offsets, known, domains);
  return {
    method: "Frozen XP layout plus arc-consistent Float32LE floor domains; runtime emits only an invariant projection.",
    passCount,
    initialKnownSymbolCount: grammar.cipherToPlain.filter((plain) => plain !== null).length,
    finalKnownSymbolCount: known.size,
    relevantUnknownRawSymbols: [...relevant].sort((a, b) => a - b),
    cipherToPlain: Array.from({ length: 256 }, (_, raw) => known.get(raw) ?? null),
    ambiguousCipherMappings: [...domains]
      .map(([cipher, plain]) => ({ cipher, plain: [...plain].sort((a, b) => a - b) }))
      .sort((left, right) => left.cipher - right.cipher),
    projection: domains.size === 0 ? "float32" : "floor-invariant",
    validation,
  };
}

function validateRows(rows, offsets, known, domains) {
  const partitions = {};
  for (const partition of ["Discovery", "Holdout", "Combined"]) {
    const selected = partition === "Combined" ? rows : rows.filter((row) => row.partition === partition);
    const result = {
      snapshotCount: selected.length,
      exactXpCount: 0,
      acceptedForwardOrderingCount: 0,
      exactLevelCount: 0,
      acceptedForwardLevelCount: 0,
      monotonicRegressionCount: 0,
      invariantProjectionCount: 0,
      unacceptedMismatchCount: 0,
      maximumAssignmentsPerSnapshot: 0,
      mismatches: [],
    };
    const previous = new Map();
    for (const row of selected) {
      const projections = new Set();
      const values = [];
      const count = enumerateRow(rowRawSymbols(row, offsets), known, domains, (value) => {
        if (Number.isFinite(value) && value >= 0) {
          projections.add(Math.floor(value));
          if (values.length < 4) values.push(value);
        } else projections.add(null);
      });
      result.maximumAssignmentsPerSnapshot = Math.max(result.maximumAssignmentsPerSnapshot, count);
      const invariant = projections.size === 1;
      const decodedXp = invariant ? [...projections][0] : null;
      if (invariant) result.invariantProjectionCount += 1;
      const forward = Number.isInteger(decodedXp) && Number.isInteger(row.nextXp) && decodedXp > row.xp && decodedXp <= row.nextXp;
      if (decodedXp === row.xp) result.exactXpCount += 1;
      else if (forward) result.acceptedForwardOrderingCount += 1;
      else result.unacceptedMismatchCount += 1;
      const decodedLevel = Number.isInteger(decodedXp) ? deriveLevel(decodedXp, row.finalLevel) : null;
      if (decodedLevel === row.level) result.exactLevelCount += 1;
      else if (forward && Number.isInteger(row.nextLevel) && decodedLevel > row.level && decodedLevel <= row.nextLevel) {
        result.acceptedForwardLevelCount += 1;
      } else result.unacceptedMismatchCount += 1;
      const key = `${row.replayId}:${row.participantId}`;
      if (Number.isInteger(decodedXp) && Number.isInteger(previous.get(key)) && decodedXp < previous.get(key)) {
        result.monotonicRegressionCount += 1;
      }
      if (Number.isInteger(decodedXp)) previous.set(key, decodedXp);
      if ((!invariant || (!forward && decodedXp !== row.xp) ||
          (decodedLevel !== row.level && !(forward && decodedLevel <= row.nextLevel))) && result.mismatches.length < 8) {
        result.mismatches.push({
          replayId: row.replayId, participantId: row.participantId,
          timestampMillis: row.timestampMillis, expectedXp: row.xp,
          decodedXp, nextXp: row.nextXp, expectedLevel: row.level,
          decodedLevel, nextLevel: row.nextLevel, projections: [...projections], values,
        });
      }
    }
    result.pass =
      result.invariantProjectionCount === result.snapshotCount &&
      result.exactXpCount + result.acceptedForwardOrderingCount === result.snapshotCount &&
      result.exactLevelCount + result.acceptedForwardLevelCount === result.snapshotCount &&
      result.monotonicRegressionCount === 0 && result.unacceptedMismatchCount === 0;
    partitions[partition] = result;
  }
  return partitions;
}

function main() {
  const args = parseArgs(process.argv);
  for (const key of ["cliPath", "replayDir", "apiRoot", "profilePath", "csReportPath", "outputPath"]) {
    args[key] = path.resolve(args[key]);
  }
  const registry = JSON.parse(fs.readFileSync(args.profilePath, "utf8"));
  const csReport = JSON.parse(fs.readFileSync(args.csReportPath, "utf8"));
  assert(csReport.schema === "rofl-keyframe-cs-cross-patch-research/v1", "Unexpected CS research report schema.");

  const fixturesByGroup = new Map();
  for (const name of fs.readdirSync(args.replayDir).filter((entry) => entry.endsWith(".rofl")).sort()) {
    const replayPath = path.join(args.replayDir, name);
    const version = exactVersion(replayPath);
    const group = versionGroup(version);
    const replayId = path.basename(name, ".rofl");
    const fixtureRoot = path.join(args.apiRoot, replayId.replaceAll("-", "_"));
    const timelinePath = path.join(fixtureRoot, "timeline.json");
    const matchPath = path.join(fixtureRoot, "match.json");
    if (!fs.existsSync(timelinePath) || !fs.existsSync(matchPath)) continue;
    const fixtures = fixturesByGroup.get(group) ?? [];
    fixtures.push({ replayId, replayPath, timelinePath, matchPath, exactVersion: version });
    fixturesByGroup.set(group, fixtures);
  }

  const groups = [];
  for (const result of csReport.versionGroups) {
    const profile = registry.profiles.find((entry) => entry.versionGroup === result.versionGroup);
    const grammar = profile?.keyframeParticipantStats;
    const xpOffsets = result.corpusFinalization?.calibrationFields
      ?.find((entry) => entry.field === "xp" && entry.selected)?.candidate?.offsets;
    const fixtures = fixturesByGroup.get(result.versionGroup) ?? [];
    assert(grammar && Array.isArray(xpOffsets) && xpOffsets.length === 4 && fixtures.length > 0,
      `Missing frozen XP inputs for ${result.versionGroup}.`);
    const split = splitFixtures(fixtures);
    console.error(`Validating ${result.versionGroup} XP from ${fixtures.length} replay(s)...`);
    const rows = loadRows(args, fixtures, split, grammar);
    const finalization = refineXpCipher(rows, xpOffsets, grammar);
    const promotionCandidate = Object.values(finalization.validation).every((entry) => entry.pass);
    groups.push({
      versionGroup: result.versionGroup,
      exactBuilds: [...new Set(fixtures.map((fixture) => fixture.exactVersion))].sort(),
      fixtureCount: fixtures.length,
      xpOffsets,
      finalization,
      promotionCandidate,
    });
  }
  const report = {
    schema: "rofl-keyframe-xp-cross-patch-research/v1",
    generatedAtUtc: new Date().toISOString(),
    source: {
      replayInput: "Saved ROFL champion-owned keyframe packet bytes.",
      offlineOracle: "Saved Riot Timeline XP/level and Match final level.",
      runtimeRiotInput: false,
    },
    hypothesis: "The CS keyframe grammar also retains a versioned replay-native Float32LE cumulative-XP lane; partial ciphers may emit only an invariant floored projection.",
    groups,
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(groups.map((group) => ({
    versionGroup: group.versionGroup,
    exactBuilds: group.exactBuilds,
    fixtureCount: group.fixtureCount,
    xpOffsets: group.xpOffsets,
    projection: group.finalization.projection,
    knownCipherSymbols: group.finalization.finalKnownSymbolCount,
    ambiguousCipherSymbols: group.finalization.ambiguousCipherMappings.length,
    snapshots: group.finalization.validation.Combined.snapshotCount,
    exactXp: group.finalization.validation.Combined.exactXpCount,
    acceptedForwardXp: group.finalization.validation.Combined.acceptedForwardOrderingCount,
    exactLevel: group.finalization.validation.Combined.exactLevelCount,
    acceptedForwardLevel: group.finalization.validation.Combined.acceptedForwardLevelCount,
    promotionCandidate: group.promotionCandidate,
  })), null, 2));
  if (groups.some((group) => !group.promotionCandidate)) process.exitCode = 1;
}

main();
