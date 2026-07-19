#!/usr/bin/env node

// Productive offline corpus gate for exact-build 16.14 keyframe participant
// XP/level/gold/lane-CS snapshots. The native CLI receives only a saved ROFL and the
// canonical decoder profile. Saved Riot fixtures are opened strictly after
// extraction as validation oracles; they can never supply runtime state.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_PATH = path.join("scripts", "manifests", "replay-participant-stat-snapshots-16.14.expected.json");
const CANONICAL_PROFILE_PATH = path.join("packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json");

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "Debug", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-participant-stat-snapshots-corpus-validation.json"),
    manifestPath: MANIFEST_PATH,
    decoderProfilesPath: CANONICAL_PROFILE_PATH,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (arg === "--api-root" && argv[index + 1]) args.apiRoot = argv[++index];
    else if (arg === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (arg === "--manifest" && argv[index + 1]) args.manifestPath = argv[++index];
    else if (arg === "--decoder-profiles" && argv[index + 1]) args.decoderProfilesPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/validate_replay_participant_stat_snapshots_corpus.mjs [--cli <path>] [--decoder-profiles <canonical-profile-json>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function fnv1a64(bytes) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
function normalizeFingerprint(fingerprint) {
  const match = /^fnv1a64:([0-9a-f]+)$/i.exec(String(fingerprint));
  assert(match, "Profile provenance has an invalid FNV-1a fingerprint.", fingerprint);
  return `fnv1a64:${match[1].toLowerCase().padStart(16, "0")}`;
}
function fixedHex(value, width) { return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`; }
function sum(rows, field) { return rows.reduce((total, row) => total + (row[field] ?? 0), 0); }
function groupSnapshots(snapshots) {
  const groups = [];
  for (const snapshot of snapshots) {
    const previous = groups.at(-1);
    if (!previous || previous.timestampMillis !== snapshot.timestampMillis) {
      groups.push({ timestampMillis: snapshot.timestampMillis, snapshots: [snapshot] });
    } else previous.snapshots.push(snapshot);
  }
  return groups;
}

function canonicalProfile(profileBytes, manifest) {
  const profile = JSON.parse(profileBytes);
  const sha256 = crypto.createHash("sha256").update(profileBytes).digest("hex");
  const fingerprint = fnv1a64(profileBytes);
  for (const field of ["schema", "registryId", "revision"]) {
    assert(profile[field] === manifest.profile[field], `Canonical profile ${field} drifted.`);
  }
  assert(sha256 === manifest.profile.sha256 && fingerprint === manifest.profile.fingerprint,
    "Canonical profile SHA-256/FNV-1a fingerprint drifted.", { sha256, fingerprint });
  const selected = (profile.profiles ?? []).filter((entry) =>
    entry.versionGroup === manifest.versionGroup &&
    (entry.acceptedGameVersions ?? []).includes(manifest.exactReplayBuild));
  assert(selected.length === 1, "Canonical profile must select one exact-build 16.14 entry.");
  const grammar = selected[0].keyframeParticipantStats;
  assert(grammar && typeof grammar === "object", "Exact-build profile lacks keyframeParticipantStats.");
  const expected = manifest.profileGrammar;
  for (const field of ["segmentType", "channel", "championNetworkIdBase"]) {
    assert(grammar[field] === expected[field], `Keyframe profile ${field} drifted.`);
  }
  assert(grammar.packetType === expected.snapshotPacketType && grammar.contentLength === expected.snapshotContentLength,
    "Keyframe profile packet grammar drifted.", grammar);
  assert(JSON.stringify(grammar.experienceOffsets) === JSON.stringify(expected.experienceOffsets) &&
    JSON.stringify(grammar.totalGoldOffsets) === JSON.stringify(expected.totalGoldOffsets) &&
    JSON.stringify(grammar.laneMinionsKilledOffsets) === JSON.stringify(expected.laneMinionsKilledOffsets),
  "Keyframe profile value offsets drifted.", grammar);
  assert(Array.isArray(grammar.cipherToPlain) && grammar.cipherToPlain.length === 256 &&
    new Set(grammar.cipherToPlain).size === 256 && grammar.cipherToPlain.every((value) =>
      Number.isInteger(value) && value >= 0 && value <= 255),
  "Keyframe cipher must remain a 256-symbol byte permutation.");
  const tableSha256 = crypto.createHash("sha256").update(Buffer.from(grammar.cipherToPlain)).digest("hex");
  assert(tableSha256 === manifest.profile.cipherToPlainSha256,
    "Keyframe cipher table SHA-256 drifted.", { tableSha256 });
  return { schema: profile.schema, registryId: profile.registryId, revision: profile.revision, sha256, fingerprint, origin: manifest.profile.origin, tableSha256, ...expected };
}

function extract(cliPath, replayPath, decoderProfilesPath) {
  const result = spawnSync(cliPath, ["--extract-replay-participant-stat-snapshots-json", replayPath, "--decoder-profiles", decoderProfilesPath], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Native snapshot extractor exited with ${result.status}.`);
  return JSON.parse(result.stdout);
}

function sourceBlockKey(block) {
  const provenance = block?.provenance;
  const fields = ["segmentType", "segmentId", "chunkId", "segmentHeaderOffset", "segmentPayloadOffset", "blockIndex", "decompressedHeaderOffset", "decompressedContentOffset", "decompressedEndOffset"];
  assert(provenance && typeof provenance === "object", "Snapshot omits framed source provenance.", block);
  assert(provenance.segmentType === "keyframe", "Snapshot provenance must be keyframe-derived.", block);
  for (const field of fields.slice(1)) assert(Number.isInteger(provenance[field]) && provenance[field] >= 0, `Snapshot provenance has invalid ${field}.`, block);
  assert(provenance.decompressedHeaderOffset <= provenance.decompressedContentOffset &&
    provenance.decompressedContentOffset < provenance.decompressedEndOffset,
  "Snapshot decompressed provenance boundaries are invalid.", block);
  return fields.map((field) => String(provenance[field])).join(":");
}

function validateSnapshot(snapshot, grammar) {
  assert(Number.isInteger(snapshot.timestampMillis) && snapshot.timestampMillis >= 0, "Snapshot timestamp is invalid.", snapshot);
  assert(Number.isInteger(snapshot.participantId) && snapshot.participantId >= 1 && snapshot.participantId <= 10, "Snapshot participant ID is invalid.", snapshot);
  assert(Number.isFinite(snapshot.experience) && snapshot.experience >= 0, "Snapshot experience must be finite and non-negative.", snapshot);
  assert(Number.isInteger(snapshot.level) && snapshot.level >= 1 && snapshot.level <= 20, "Snapshot level must be an integer from 1 through 20.", snapshot);
  assert(Number.isFinite(snapshot.totalGold) && snapshot.totalGold >= 0, "Snapshot totalGold must be finite and non-negative.", snapshot);
  assert(Number.isInteger(snapshot.laneMinionsKilled) && snapshot.laneMinionsKilled >= 0, "Snapshot laneMinionsKilled must be a non-negative integer.", snapshot);
  const block = snapshot.provenance?.snapshotBlock;
  const networkId = grammar.championNetworkIdBase + snapshot.participantId;
  assert(block?.channel === grammar.channel && block.packetType === grammar.snapshotPacketType &&
    block.packetTypeHex === fixedHex(grammar.snapshotPacketType, 4) &&
    block.contentLength === grammar.snapshotContentLength && block.blockParam === networkId &&
    block.blockParamHex === fixedHex(networkId, 8), "Snapshot packet/owner provenance drifted.", snapshot);
  return sourceBlockKey(block);
}

function assertExtractorProfile(profile, expected) {
  assert(profile && typeof profile === "object", "Extractor omitted profile provenance.");
  for (const field of ["segmentType", "channel", "snapshotPacketType", "snapshotContentLength", "championNetworkIdBase", "levelDerivation", "origin", "schema", "registryId", "revision"]) {
    assert(profile[field] === expected[field], `Extractor profile provenance drifted at ${field}.`, { expected: expected[field], actual: profile[field] });
  }
  assert(normalizeFingerprint(profile.fingerprint) === expected.fingerprint,
    "Extractor profile FNV-1a provenance drifted.", profile.fingerprint);
  assert(profile.snapshotPacketTypeHex === "0x02EB" && profile.championNetworkIdBaseHex === "0x400000AD",
    "Extractor profile hex provenance drifted.", profile);
}

function exceptionKey(replayId, groupIndex, participantId) { return `${replayId}:${groupIndex}:${participantId}`; }
function validateAgainstApi(replayId, groups, timeline, match, manifest, seenExceptions) {
  assert(match.info?.gameVersion === manifest.exactReplayBuild,
    `${replayId} saved Match-V5 fixture fails the exact-build gate.`);
  const frames = timeline.info?.frames;
  const acceptedOrderingDifferences = [];
  assert(Array.isArray(frames) && frames.length === groups.length + 1,
    `${replayId} Timeline ordering must contain one terminal frame after replay keyframes.`, { frames: frames?.length, groups: groups.length });
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]; const frame = frames[groupIndex];
    assert(Math.abs(group.timestampMillis - frame.timestamp) <= 1,
      `${replayId} snapshot/API frame timestamp ordering drifted.`, { groupIndex, replay: group.timestampMillis, api: frame.timestamp });
    for (const snapshot of group.snapshots) {
      const api = frame.participantFrames?.[snapshot.participantId];
      assert(api && Number.isInteger(api.xp) && Number.isInteger(api.level) &&
        Number.isInteger(api.totalGold) && Number.isInteger(api.minionsKilled),
        `${replayId} Timeline frame omits participant ${snapshot.participantId}.`);
      const exact = Math.floor(snapshot.experience) === api.xp && snapshot.level === api.level &&
        Math.floor(snapshot.totalGold) === api.totalGold && snapshot.laneMinionsKilled === api.minionsKilled;
      const key = exceptionKey(replayId, groupIndex, snapshot.participantId);
      const expected = manifest.apiOrderingDifferences.find((entry) =>
        exceptionKey(entry.replayId, entry.snapshotGroupIndex, entry.participantId) === key);
      if (exact) {
        assert(!expected, `${replayId} expected API ordering exception is no longer present.`, expected);
      } else {
        assert(expected, `${replayId} has an unapproved API snapshot-ordering difference.`, { groupIndex, snapshot, api });
        const actualSnapshot = {
          snapshotTimestampMillis: group.timestampMillis,
          snapshotExperience: snapshot.experience,
          snapshotLevel: snapshot.level,
          snapshotTotalGold: snapshot.totalGold,
          snapshotLaneMinionsKilled: snapshot.laneMinionsKilled,
        };
        for (const [field, actual] of Object.entries(actualSnapshot)) {
          assert(actual === expected[field], `${replayId} frozen API exception ${field} drifted.`, { expected, actual });
        }
        assert(frame.timestamp === expected.apiFrameTimestampMillis && api.xp === expected.apiExperience &&
          api.level === expected.apiLevel && api.totalGold === expected.apiTotalGold &&
          api.minionsKilled === expected.apiLaneMinionsKilled,
        `${replayId} frozen API exception oracle state drifted.`, { expected, api, frameTimestamp: frame.timestamp });
        seenExceptions.add(key);
        acceptedOrderingDifferences.push(expected);
      }
    }
  }
  const first = groups[0];
  for (const snapshot of first.snapshots) {
    assert(snapshot.experience === manifest.runtime.initialState.experience &&
      snapshot.level === manifest.runtime.initialState.level &&
      snapshot.totalGold === manifest.runtime.initialState.totalGold &&
      snapshot.laneMinionsKilled === manifest.runtime.initialState.laneMinionsKilled,
      `${replayId} initial replay participant state drifted.`, snapshot);
  }
  assert(first.timestampMillis === manifest.runtime.initialState.timestampMillis,
    `${replayId} initial replay timestamp drifted.`);
  const finalGroup = groups.at(-1);
  const finalParticipants = match.info?.participants ?? [];
  assert(finalParticipants.length === 10, `${replayId} Match fixture must contain ten final participants.`);
  for (const snapshot of finalGroup.snapshots) {
    const final = finalParticipants.find((participant) => participant.participantId === snapshot.participantId);
    assert(final && Number.isInteger(final.champExperience) && Number.isInteger(final.champLevel) &&
      Number.isInteger(final.goldEarned) && Number.isInteger(final.totalMinionsKilled),
      `${replayId} Match fixture omits final participant ${snapshot.participantId}.`);
    assert(Math.floor(snapshot.experience) <= final.champExperience && snapshot.level <= final.champLevel &&
      snapshot.totalGold <= final.goldEarned && snapshot.laneMinionsKilled <= final.totalMinionsKilled,
      `${replayId} final keyframe exceeds saved final Match-V5 state.`, { snapshot, final });
  }
  return acceptedOrderingDifferences;
}

function runFixture(args, manifest, profile, fixture, seenExceptions) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const root = path.resolve(args.apiRoot, fixture.replayId.replaceAll("-", "_"));
  const matchPath = path.join(root, "match.json"); const timelinePath = path.join(root, "timeline.json");
  assert([replayPath, matchPath, timelinePath].every(fs.existsSync), `Missing fixed fixture input for ${fixture.replayId}.`);
  const extracted = extract(args.cliPath, replayPath, args.decoderProfilesPath);
  assert(extracted.schema === manifest.runtime.schema && extracted.gameVersion === manifest.exactReplayBuild && extracted.versionGroup === manifest.versionGroup,
    `${fixture.replayId} extractor schema/exact-build gate failed.`, extracted);
  assert(extracted.source?.runtimeInput === "rofl-only" && extracted.source?.riotApiInput === false,
    `${fixture.replayId} extractor source boundary drifted.`, extracted.source);
  assertExtractorProfile(extracted.profile, profile);
  const diagnostics = extracted.diagnostics;
  assert(diagnostics?.exactPacketFraming === true && diagnostics.coverage === manifest.runtime.coverage,
    `${fixture.replayId} exact packet framing/coverage gate failed.`, diagnostics);
  for (const field of ["keyframeRecordCount", "keyframeSegmentCount", "packetBlockCount", "profiledSnapshotPacketCount", "rejectedInvalidOwnerPacketCount", "rejectedInvalidValuePacketCount", "emittedSnapshotCount"]) {
    assert(Number.isInteger(diagnostics[field]) && diagnostics[field] >= 0, `${fixture.replayId} diagnostics.${field} is invalid.`, diagnostics);
  }
  const snapshots = Array.isArray(extracted.snapshots) ? extracted.snapshots : [];
  assert(snapshots.length === fixture.expectedSnapshotCount && diagnostics.emittedSnapshotCount === snapshots.length &&
    diagnostics.profiledSnapshotPacketCount === snapshots.length && diagnostics.rejectedInvalidOwnerPacketCount === 0 &&
    diagnostics.rejectedInvalidValuePacketCount === 0,
  `${fixture.replayId} snapshot count/rejection gate failed.`, diagnostics);
  const groups = groupSnapshots(snapshots);
  assert(groups.length === diagnostics.keyframeRecordCount && diagnostics.keyframeSegmentCount === groups.length,
    `${fixture.replayId} snapshot/keyframe cardinality drifted.`, diagnostics);
  const sourceKeys = new Set(); const byParticipant = Array.from({ length: 10 }, () => []);
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    assert(group.snapshots.length === manifest.runtime.participantCountPerSnapshot,
      `${fixture.replayId} snapshot group ${groupIndex} must contain ten participants.`);
    if (groupIndex > 0) assert(groups[groupIndex - 1].timestampMillis < group.timestampMillis,
      `${fixture.replayId} snapshot timestamps must be strictly group-monotonic.`);
    const participants = new Set();
    for (const snapshot of group.snapshots) {
      participants.add(snapshot.participantId); byParticipant[snapshot.participantId - 1].push(snapshot);
      const sourceKey = validateSnapshot(snapshot, profile);
      assert(!sourceKeys.has(sourceKey), `${fixture.replayId} duplicates framed snapshot provenance.`, snapshot);
      sourceKeys.add(sourceKey);
    }
    assert(participants.size === 10, `${fixture.replayId} snapshot group has duplicate participant ownership.`);
  }
  for (const participantSnapshots of byParticipant) {
    assert(participantSnapshots.length === groups.length, `${fixture.replayId} participant is missing a keyframe snapshot.`);
    for (let index = 1; index < participantSnapshots.length; index += 1) {
      const previous = participantSnapshots[index - 1]; const current = participantSnapshots[index];
      assert(current.timestampMillis > previous.timestampMillis &&
        current.experience >= previous.experience && current.level >= previous.level &&
        current.totalGold >= previous.totalGold &&
        current.laneMinionsKilled >= previous.laneMinionsKilled,
      `${fixture.replayId} participant snapshot series is not monotonic.`, { previous, current });
    }
  }
  const timeline = readJson(timelinePath); const match = readJson(matchPath);
  assert(timeline.info?.frames?.length === fixture.expectedTimelineFrameCount,
    `${fixture.replayId} frozen Timeline frame count drifted.`);
  const acceptedOrderingDifferences = validateAgainstApi(
    fixture.replayId, groups, timeline, match, manifest, seenExceptions);
  return {
    replayId: fixture.replayId, partition: fixture.partition, status: "pass", snapshotCount: snapshots.length,
    diagnostics, groupCount: groups.length, acceptedOrderingDifferences,
    hashes: {
      profileSha256: profile.sha256,
      profileFingerprint: profile.fingerprint,
      cipherToPlainSha256: profile.tableSha256,
    },
    provenance: { replayOnlyExtractionInput: replayPath, offlineValidationInputs: [matchPath, timelinePath], riotDataWasRuntimeInput: false },
  };
}

function partitionSummary(rows, expected) {
  const result = {
    replayCount: rows.length, snapshotCount: sum(rows, "snapshotCount"),
    rejectedInvalidOwnerPacketCount: rows.reduce((total, row) => total + row.diagnostics.rejectedInvalidOwnerPacketCount, 0),
    rejectedInvalidValuePacketCount: rows.reduce((total, row) => total + row.diagnostics.rejectedInvalidValuePacketCount, 0),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (field !== "acceptedApiOrderingDifferenceCount") assert(result[field] === value, `Partition ${field} drifted.`, { expected: value, actual: result[field] });
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  for (const field of ["cliPath", "replayDir", "apiRoot", "outputPath", "manifestPath", "decoderProfilesPath"]) args[field] = path.resolve(args[field]);
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);
  assert(fs.existsSync(args.manifestPath) && fs.existsSync(args.decoderProfilesPath), "Manifest or canonical profile bundle is missing.");
  assert(args.decoderProfilesPath === path.resolve(CANONICAL_PROFILE_PATH), "This validator requires the canonical external profile asset.");
  const manifest = readJson(args.manifestPath);
  assert(manifest.schema === "rofl-replay-participant-stat-snapshots-corpus-expected/v1", "Unexpected snapshot expected-manifest schema.");
  const profile = canonicalProfile(fs.readFileSync(args.decoderProfilesPath), manifest);
  const seenExceptions = new Set(); const rows = [];
  for (const fixture of manifest.fixtures) {
    try { rows.push(runFixture(args, manifest, profile, fixture, seenExceptions)); }
    catch (error) { rows.push({ replayId: fixture.replayId, partition: fixture.partition, status: "fail", error: error.message }); }
  }
  const successful = rows.filter((row) => row.status === "pass");
  let summaries; let pass = successful.length === manifest.fixtures.length;
  try {
    summaries = {
      D7: partitionSummary(successful.filter((row) => row.partition === "D7"), manifest.expected.D7),
      H3: partitionSummary(successful.filter((row) => row.partition === "H3"), manifest.expected.H3),
      combined: partitionSummary(successful, manifest.expected.combined),
    };
    summaries.combined.acceptedApiOrderingDifferenceCount = seenExceptions.size;
    assert(seenExceptions.size === manifest.expected.combined.acceptedApiOrderingDifferenceCount &&
      seenExceptions.size === manifest.apiOrderingDifferences.length,
    "Frozen API snapshot-ordering exception set drifted.", { seen: [...seenExceptions] });
  } catch (error) { pass = false; summaries = { error: error.message }; }
  const report = {
    schema: "rofl-replay-participant-stat-snapshots-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(), status: pass ? "validated" : "failed",
    methodology: {
      runtimeCandidateInput: "Native --extract-replay-participant-stat-snapshots-json with loaded ROFL and canonical external profile only.",
      offlineValidationRole: "Saved Match-V5/Timeline fixtures are opened only after extraction for exact-build, initial/final-envelope, and ordered snapshot checks.",
      runtimeRiotInput: false, expectedManifest: args.manifestPath, canonicalProfileBundle: args.decoderProfilesPath,
      acceptedApiOrderingDifferences: "Frozen manifest exceptions only; never a runtime fallback.",
    },
    profileProvenance: profile, expected: manifest.expected, summaries, rows,
  };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, summaries }, null, 2));
  if (!pass) process.exitCode = 1;
}

main();
