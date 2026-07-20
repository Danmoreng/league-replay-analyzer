#!/usr/bin/env node

// Materializes a fully gated cross-patch CS research report into the canonical
// external decoder registry. This is a deterministic profile-data rewrite;
// it does not inspect replay bytes or call Riot services.

import fs from "node:fs";

const reportPath = process.argv[2] ?? "tmp/keyframe-cs-cross-patch.json";
const profilePath = process.argv[3] ??
  "packages/rofl-core/profiles/replay-decoder-profiles.v1.json";

function fail(message, detail = null) {
  throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const registry = JSON.parse(fs.readFileSync(profilePath, "utf8"));
if (report.schema !== "rofl-keyframe-cs-cross-patch-research/v1") {
  fail("Unexpected research report schema.");
}
if (registry.schema !== "rofl-replay-decoder-profiles/v1") {
  fail("Unexpected decoder registry schema.");
}

for (const result of report.versionGroups) {
  if (!result.promotionCandidate) {
    fail(`Cross-patch CS gate did not pass for ${result.versionGroup}.`, result.reason);
  }
  const profile = registry.profiles.find(
    (entry) => entry.versionGroup === result.versionGroup,
  );
  if (!profile) fail(`Canonical registry has no ${result.versionGroup} profile.`);
  const builds = report.builds.filter(
    (entry) => entry.versionGroup === result.versionGroup,
  );
  const packetTypes = [...new Set(builds.map((entry) => entry.grammar.packetType))];
  const contentLengths = [...new Set(builds.map((entry) => entry.grammar.contentLength))];
  const championBases = [...new Set(builds.map((entry) => entry.championBase))];
  if (packetTypes.length !== 1 || contentLengths.length !== 1 || championBases.length !== 1) {
    fail(`Keyframe grammar is not stable within ${result.versionGroup}.`, {
      packetTypes,
      contentLengths,
      championBases,
    });
  }
  const finalized = result.corpusFinalization;
  const substitution = new Map(
    Object.entries(finalized.substitution).map(([raw, plain]) => [Number(raw), plain]),
  );
  const cipherToPlain = Array.from(
    { length: 256 },
    (_, raw) => substitution.get(raw) ?? null,
  );
  const joint = finalized.jungleJointSolution;
  const ambiguousCipherMappings = joint?.unknownSymbols?.length
    ? joint.unknownSymbols.map((cipher) => ({
        cipher,
        plain: joint.domains[cipher],
      }))
    : [];
  if (
    ambiguousCipherMappings.length > 0 &&
    (joint.truncated || joint.solutionCount < 1 ||
      joint.domainProjectionExactCount !== joint.domainProjectionSnapshotCount)
  ) {
    fail(`Ambiguous cipher projection gate failed for ${result.versionGroup}.`, joint);
  }
  for (const offset of result.laneCandidate.offsets) {
    const rawValues = new Set();
    // The research report already records zero unknown lane snapshots; retain
    // this explicit gate so a malformed report cannot create a profile.
    if (offset < 0 || offset >= contentLengths[0]) rawValues.add(offset);
    if (rawValues.size > 0) fail(`Lane-CS offsets are invalid for ${result.versionGroup}.`);
  }
  const epsilon = finalized.jungleProjectionEpsilon?.selected ?? 0.00001;
  const existing = profile.keyframeParticipantStats;
  profile.keyframeParticipantStats = {
    acceptedGameVersions: result.exactBuilds,
    segmentType: "keyframe",
    channel: 1,
    packetType: packetTypes[0],
    contentLength: contentLengths[0],
    championNetworkIdBase: championBases[0],
    cipherToPlain,
    ...(ambiguousCipherMappings.length > 0 ? { ambiguousCipherMappings } : {}),
    ...(result.versionGroup === "16.14" && existing?.experienceOffsets
      ? { experienceOffsets: existing.experienceOffsets }
      : {}),
    ...(result.versionGroup === "16.14" && existing?.totalGoldOffsets
      ? { totalGoldOffsets: existing.totalGoldOffsets }
      : {}),
    laneMinionsKilledOffsets: result.laneCandidate.offsets,
    neutralMinionsKilledOffsets: finalized.jungleCandidate.offsets,
    neutralMinionsKilledProjection:
      epsilon >= 0.000015 ? "floor-plus-2e-5" : "floor-plus-1e-5",
  };
}

registry.revision = "2026-07-25-cross-patch-cs";
fs.writeFileSync(profilePath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Updated ${profilePath} from ${reportPath}.`);
