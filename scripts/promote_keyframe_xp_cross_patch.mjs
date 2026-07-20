#!/usr/bin/env node

// Applies a fully passing cross-patch XP research report to the canonical
// external decoder registry. This rewrite never opens replay or Riot data.

import fs from "node:fs";

const reportPath = process.argv[2] ?? "tmp/keyframe-xp-cross-patch.json";
const profilePath = process.argv[3] ??
  "packages/rofl-core/profiles/replay-decoder-profiles.v1.json";

const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const registry = JSON.parse(fs.readFileSync(profilePath, "utf8"));
if (report.schema !== "rofl-keyframe-xp-cross-patch-research/v1") {
  throw new Error("Unexpected XP research report schema.");
}
for (const result of report.groups) {
  if (!result.promotionCandidate) throw new Error(`XP promotion gate failed for ${result.versionGroup}.`);
  const profile = registry.profiles.find((entry) => entry.versionGroup === result.versionGroup);
  if (!profile?.keyframeParticipantStats) throw new Error(`Missing keyframe profile for ${result.versionGroup}.`);
  const grammar = profile.keyframeParticipantStats;
  grammar.cipherToPlain = result.finalization.cipherToPlain;
  if (result.finalization.ambiguousCipherMappings.length > 0) {
    grammar.ambiguousCipherMappings = result.finalization.ambiguousCipherMappings;
  } else delete grammar.ambiguousCipherMappings;
  grammar.experienceOffsets = result.xpOffsets;
  grammar.experienceProjection = result.finalization.projection;
}
registry.revision = "2026-07-26-cross-patch-xp";
fs.writeFileSync(profilePath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Updated ${profilePath} from ${reportPath}.`);
