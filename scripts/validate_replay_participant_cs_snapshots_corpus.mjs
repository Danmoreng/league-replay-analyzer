#!/usr/bin/env node

// Full saved-corpus promotion gate for the productive replay-native XP/level
// and CS ABI.
// Riot Timeline files are offline labels only and are never runtime inputs.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const cli = process.argv[2] ?? "build-linux/packages/rofl-core/rofl_core_cli";
const profiles = process.argv[3] ??
  "packages/rofl-core/profiles/replay-decoder-profiles.v1.json";
const replayDir = process.argv[4] ?? "replays";
const apiRoot = process.argv[5] ?? path.join(replayDir, "api");

function fail(message, detail = null) {
  throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

function run(replayPath) {
  const result = spawnSync(
    cli,
    [
      "--extract-replay-participant-stat-snapshots-json",
      replayPath,
      "--decoder-profiles",
      profiles,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) fail(`Decoder failed for ${replayPath}.`, result.stderr);
  return JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
}

const totals = {
  replayCount: 0,
  snapshotCount: 0,
  laneExactCount: 0,
  laneOrderingBoundaryCount: 0,
  jungleExactCount: 0,
  xpExactCount: 0,
  xpOrderingBoundaryCount: 0,
  levelExactCount: 0,
  levelOrderingBoundaryCount: 0,
};
const byVersionGroup = {};
for (const name of fs.readdirSync(replayDir).filter((entry) => entry.endsWith(".rofl")).sort()) {
  const replayId = path.basename(name, ".rofl");
  const timelinePath = path.join(apiRoot, replayId.replaceAll("-", "_"), "timeline.json");
  if (!fs.existsSync(timelinePath)) fail(`Missing Timeline fixture for ${replayId}.`);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  const frames = timeline.info?.frames ?? [];
  const decoded = run(path.join(replayDir, name));
  if (
    decoded.schema !== "rofl-replay-participant-stat-snapshots/v4" ||
    decoded.snapshots.length % 10 !== 0 ||
    decoded.snapshots.length > frames.length * 10
  ) {
    fail(`Snapshot/frame cardinality drifted for ${replayId}.`, {
      schema: decoded.schema,
      snapshots: decoded.snapshots.length,
      frames: frames.length,
    });
  }
  const group = decoded.versionGroup;
  const groupTotals = byVersionGroup[group] ??= {
    replayCount: 0,
    snapshotCount: 0,
    laneExactCount: 0,
    laneOrderingBoundaryCount: 0,
    jungleExactCount: 0,
    xpExactCount: 0,
    xpOrderingBoundaryCount: 0,
    levelExactCount: 0,
    levelOrderingBoundaryCount: 0,
  };
  if (decoded.profile?.experienceAvailable !== true ||
      !["float32", "floor-invariant"].includes(decoded.profile?.experienceProjection) ||
      decoded.profile?.levelDerivation !== "xp-thresholds-with-replay-final-level-cap") {
    fail(`XP/level capability is unavailable for ${replayId}.`, decoded.profile);
  }
  totals.replayCount += 1;
  groupTotals.replayCount += 1;
  for (let index = 0; index < decoded.snapshots.length; index += 1) {
    const snapshot = decoded.snapshots[index];
    const frameIndex = Math.floor(index / 10);
    const frame = frames[frameIndex];
    const expected = frame?.participantFrames?.[snapshot.participantId];
    const next = frames[frameIndex + 1]?.participantFrames?.[snapshot.participantId];
    if (!expected || Math.abs(frame.timestamp - snapshot.timestampMillis) > 2_000) {
      fail(`Replay/Timeline alignment drifted for ${replayId}.`, { index, snapshot, frame });
    }
    const laneExact = snapshot.laneMinionsKilled === expected.minionsKilled;
    const laneOrderingBoundary =
      !laneExact &&
      Number.isInteger(next?.minionsKilled) &&
      snapshot.laneMinionsKilled > expected.minionsKilled &&
      snapshot.laneMinionsKilled <= next.minionsKilled;
    if (!laneExact && !laneOrderingBoundary) {
      fail(`Lane CS mismatch for ${replayId}.`, { index, snapshot, expected, next });
    }
    if (snapshot.neutralMinionsKilled !== expected.jungleMinionsKilled) {
      fail(`Jungle CS mismatch for ${replayId}.`, { index, snapshot, expected });
    }
    const decodedXp = Math.floor(snapshot.experience);
    const xpExact = decodedXp === expected.xp;
    const xpOrderingBoundary =
      !xpExact && Number.isInteger(next?.xp) && decodedXp > expected.xp && decodedXp <= next.xp;
    if (!xpExact && !xpOrderingBoundary) {
      fail(`XP mismatch for ${replayId}.`, { index, snapshot, expected, next });
    }
    const levelExact = snapshot.level === expected.level;
    const levelOrderingBoundary =
      !levelExact && xpOrderingBoundary && Number.isInteger(next?.level) &&
      snapshot.level > expected.level && snapshot.level <= next.level;
    if (!levelExact && !levelOrderingBoundary) {
      fail(`Level mismatch for ${replayId}.`, { index, snapshot, expected, next });
    }
    totals.snapshotCount += 1;
    groupTotals.snapshotCount += 1;
    if (laneExact) {
      totals.laneExactCount += 1;
      groupTotals.laneExactCount += 1;
    } else {
      totals.laneOrderingBoundaryCount += 1;
      groupTotals.laneOrderingBoundaryCount += 1;
    }
    totals.jungleExactCount += 1;
    groupTotals.jungleExactCount += 1;
    if (xpExact) {
      totals.xpExactCount += 1;
      groupTotals.xpExactCount += 1;
    } else {
      totals.xpOrderingBoundaryCount += 1;
      groupTotals.xpOrderingBoundaryCount += 1;
    }
    if (levelExact) {
      totals.levelExactCount += 1;
      groupTotals.levelExactCount += 1;
    } else {
      totals.levelOrderingBoundaryCount += 1;
      groupTotals.levelOrderingBoundaryCount += 1;
    }
  }
}

if (totals.replayCount !== 57) fail("Full corpus gate did not cover all 57 replays.", totals);
console.log(JSON.stringify({ schema: "rofl-replay-participant-stat-corpus-gate/v2", totals, byVersionGroup }, null, 2));
