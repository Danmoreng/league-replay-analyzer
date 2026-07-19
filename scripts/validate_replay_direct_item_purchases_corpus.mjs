#!/usr/bin/env node

// Productive, offline-only corpus gate for the strict patch-16.14 direct
// add-only purchase subset. The runtime extractor receives a saved ROFL and
// the canonical profile only. Timeline labels are opened afterward solely as
// validation oracles.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const MANIFEST_PATH = path.join("scripts", "manifests", "replay-direct-item-purchases-16.14.expected.json");
const PROFILE_PATH = path.join("packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json");

function assert(ok, message, detail = undefined) {
  if (!ok) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}
function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
function parseArgs(argv) {
  const result = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"), replayDir: "replays",
    apiRoot: path.join("replays", "api"), outputPath: path.join("artifacts", "replay-direct-item-purchases-corpus-validation.json"),
    manifestPath: MANIFEST_PATH, decoderProfilesPath: PROFILE_PATH,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (["--cli", "--replay-dir", "--api-root", "--output", "--manifest", "--decoder-profiles"].includes(arg) && i + 1 < argv.length) {
      result[{ "--cli": "cliPath", "--replay-dir": "replayDir", "--api-root": "apiRoot", "--output": "outputPath", "--manifest": "manifestPath", "--decoder-profiles": "decoderProfilesPath" }[arg]] = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node ./scripts/validate_replay_direct_item_purchases_corpus.mjs [--cli <path>] [--replay-dir <path>] [--api-root <path>] [--output <path>] [--manifest <path>] [--decoder-profiles <path>]\n\nThe native extractor uses only the ROFL and canonical profile. Saved API fixtures are offline validation oracles.");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return result;
}
function run(cli, replay, profiles) {
  const result = spawnSync(cli, ["--extract-replay-direct-item-purchases-json", replay, "--decoder-profiles", profiles],
    { encoding: "utf8", windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `direct-purchase extractor exited with ${result.status}`);
  return JSON.parse(result.stdout);
}
function profileConfig(bytes, manifest) {
  const profile = JSON.parse(bytes); const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  assert(profile.schema === manifest.profile.schema && profile.registryId === manifest.profile.registryId && profile.revision === manifest.profile.revision, "Canonical profile identity drifted.");
  assert(digest === manifest.profile.sha256, "Canonical profile SHA-256 drifted.", { expected: manifest.profile.sha256, actual: digest });
  assert(fnv1a64(bytes) === manifest.profile.fingerprint, "Canonical profile FNV fingerprint drifted.");
  const selected = (profile.profiles ?? []).filter((entry) => entry.versionGroup === manifest.versionGroup && (entry.acceptedGameVersions ?? []).includes(manifest.exactReplayBuild));
  assert(selected.length === 1, "Expected one exact-build profile.");
  const grammar = selected[0][manifest.grammar.profileKey];
  assert(grammar && typeof grammar === "object", `Exact-build profile lacks ${manifest.grammar.profileKey}.`);
  const expected = manifest.grammar;
  assert(grammar.segmentType === expected.segmentType && grammar.channel === expected.channel && grammar.championNetworkIdBase === expected.championNetworkIdBase, "Direct-purchase profile framing drifted.", grammar);
  assert(grammar.add?.packetType === expected.addPacketType && JSON.stringify(grammar.add?.contentLengths?.exact) === JSON.stringify(expected.addContentLengths), "Direct-purchase add family drifted.", grammar.add);
  assert(JSON.stringify(grammar.blockingPacketTypes) === JSON.stringify(expected.blockingPacketTypes) && grammar.isolationToleranceMillis === expected.isolationToleranceMillis, "Direct-purchase isolation grammar drifted.", grammar);
  const catalog = grammar.staticItemCatalog;
  assert(catalog?.provider === "Riot Data Dragon"
    && catalog.version === expected.staticItemCatalog.version
    && catalog.locale === expected.staticItemCatalog.locale
    && catalog.sourceByteLength === expected.staticItemCatalog.byteLength
    && catalog.sourceSha256 === expected.staticItemCatalog.sha256
    && catalog.entryCount === expected.staticItemCatalog.entryCount,
  "Pinned static catalog metadata drifted.", catalog);
  assert(JSON.stringify(catalog.realItemIds) === JSON.stringify(expected.realItemIds)
    && JSON.stringify(catalog.componentItemIds) === JSON.stringify(expected.componentItemIds),
  "Pinned real/component item sets drifted.");
  const enabled = (profile.profiles ?? []).filter((entry) => entry[manifest.grammar.profileKey]);
  assert(enabled.length === 1 && enabled[0] === selected[0], "Direct-purchase grammar must be exact-build unique and fail closed elsewhere.");
  return { schema: profile.schema, registryId: profile.registryId, revision: profile.revision, fingerprint: fnv1a64(bytes), bundleSha256: digest, grammar };
}
function blockKey(block) {
  const p = block?.provenance; assert(p && typeof p === "object", "Event has no framed add-block provenance.", block);
  for (const field of ["segmentType", "segmentId", "chunkId", "segmentPayloadOffset", "blockIndex", "decompressedHeaderOffset"]) assert(p[field] !== undefined && p[field] !== null, `Add-block provenance lacks ${field}.`, block);
  return [p.segmentType, p.segmentId, p.chunkId, p.segmentPayloadOffset, p.blockIndex, p.decompressedHeaderOffset].join(":");
}
function labels(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? []).filter((event) => event.type === "ITEM_PURCHASED" && Number.isInteger(event.participantId) && Number.isInteger(event.timestamp) && Number.isInteger(event.itemId));
}
function validateEvent(event, manifest) {
  assert(event.type === manifest.runtime.eventType, "Unexpected direct-purchase event type.", event);
  assert(Number.isInteger(event.timestampMillis) && event.timestampMillis >= 0, "Invalid event timestamp.", event);
  assert(Number.isInteger(event.participantId) && event.participantId >= 1 && event.participantId <= 10, "Invalid participant ID.", event);
  assert(event.participantNetworkId === manifest.grammar.championNetworkIdBase + event.participantId, "Participant network ID does not reproduce the profile base.", event);
  assert(typeof event.participantNetworkIdHex === "string" && event.participantNetworkIdHex.length > 0, "Missing participant network-ID hex provenance.", event);
  assert(Number.isInteger(event.itemId) && manifest.grammar.realItemIds.includes(event.itemId), "Direct purchase has a non-pinned/non-real item ID.", event);
  assert(typeof event.componentItem === "boolean" && event.componentItem === manifest.grammar.componentItemIds.includes(event.itemId), "Component classification does not reproduce the pinned catalog.", event);
  assert(event.provenance && typeof event.provenance === "object", "Event lacks provenance.", event);
  const add = event.provenance.addBlock; blockKey(add);
  assert(add.family === "add" && add.channel === manifest.grammar.channel && add.packetType === manifest.grammar.addPacketType && manifest.grammar.addContentLengths.includes(add.contentLength), "Add provenance escapes the strict direct-purchase family.", add);
}
function compare(events, offline, tolerance) {
  const used = new Set(); const extras = []; const wrong = []; let maximumAbsoluteTimestampDeltaMillis = 0;
  for (const event of events) {
    const index = offline.findIndex((label, i) => !used.has(i) && label.participantId === event.participantId && label.itemId === event.itemId && Math.abs(label.timestamp - event.timestampMillis) <= tolerance);
    if (index >= 0) { used.add(index); maximumAbsoluteTimestampDeltaMillis = Math.max(maximumAbsoluteTimestampDeltaMillis, Math.abs(offline[index].timestamp - event.timestampMillis)); continue; }
    const ownerTime = offline.filter((label) => label.participantId === event.participantId && Math.abs(label.timestamp - event.timestampMillis) <= tolerance);
    (ownerTime.length ? wrong : extras).push(event);
  }
  return { offlineMatchedEventCount: used.size, extraRuntimeEventCount: extras.length, wrongItemIdEventCount: wrong.length, unmatchedOfflinePurchaseLabelCount: offline.length - used.size, maximumAbsoluteTimestampDeltaMillis };
}
function validateDiagnostics(extracted, manifest) {
  const d = extracted.diagnostics; assert(d && typeof d === "object" && d.exactPacketFraming === true, "Extractor lacks exact framing diagnostics.", d);
  assert(d.coverage === manifest.runtime.coverage, "Extractor coverage boundary drifted.", d);
  assert(d.emittedEventCount === extracted.events.length, "Emitted-event diagnostic does not equal the event array.", d);
  for (const field of ["slotAvailable", "itemInstanceAvailable", "countOrChargesAvailable", "priceAvailable", "goldStateAvailable", "inventoryStateAvailable", "removedItemIdentityAvailable", "undoAvailable"]) assert(d[field] === false, `Direct-purchase subset must fail closed: ${field}.`, d);
  return d;
}
function summary(rows) {
  return {
    replayCount: rows.length,
    emittedEventCount: rows.reduce((n, row) => n + row.events.length, 0),
    componentItemEventCount: rows.reduce((n, row) => n + row.events.filter((event) => event.componentItem).length, 0),
    offlineMatchedEventCount: rows.reduce((n, row) => n + row.comparison.offlineMatchedEventCount, 0),
    extraRuntimeEventCount: rows.reduce((n, row) => n + row.comparison.extraRuntimeEventCount, 0),
    wrongItemIdEventCount: rows.reduce((n, row) => n + row.comparison.wrongItemIdEventCount, 0),
    maximumAbsoluteTimestampDeltaMillis: Math.max(0, ...rows.map((row) => row.comparison.maximumAbsoluteTimestampDeltaMillis)),
  };
}
function checkSummary(actual, expected) { for (const [field, value] of Object.entries(expected)) assert(actual[field] === value, `Corpus summary ${field} drifted.`, { expected: value, actual: actual[field] }); }
function main() {
  const args = parseArgs(process.argv); for (const key of Object.keys(args)) if (key.endsWith("Path") || key === "replayDir" || key === "apiRoot") args[key] = path.resolve(ROOT, args[key]);
  assert(fs.existsSync(args.cliPath) && fs.existsSync(args.manifestPath) && fs.existsSync(args.decoderProfilesPath), "Required CLI, manifest, or profile file is missing.");
  assert(args.decoderProfilesPath === path.resolve(ROOT, PROFILE_PATH), "Productive gate requires the canonical external profile asset.");
  const manifest = json(args.manifestPath); assert(manifest.schema === "rofl-replay-direct-item-purchases-corpus-expected/v1", "Unexpected manifest schema.");
  const provenance = profileConfig(fs.readFileSync(args.decoderProfilesPath, "utf8"), manifest); const rows = [];
  for (const fixture of manifest.fixtures) try {
    const replay = path.join(args.replayDir, `${fixture.replayId}.rofl`); const base = path.join(args.apiRoot, fixture.replayId.replaceAll("-", "_")); const match = json(path.join(base, "match.json"));
    assert(match.info?.gameVersion === manifest.exactReplayBuild, "Offline Match fixture violates exact-build gate.", { replayId: fixture.replayId, gameVersion: match.info?.gameVersion });
    const extracted = run(args.cliPath, replay, args.decoderProfilesPath);
    assert(extracted.schema === manifest.runtime.schema && extracted.gameVersion === manifest.exactReplayBuild && extracted.versionGroup === manifest.versionGroup, "Extractor schema/version boundary drifted.", extracted);
    assert(extracted.source?.runtimeInput === "rofl-only" && extracted.source?.riotApiInput === false && extracted.profile?.origin === manifest.profile.origin && extracted.profile?.fingerprint === provenance.fingerprint, "Extractor source/profile provenance drifted.", extracted);
    const events = Array.isArray(extracted.events) ? extracted.events : []; validateDiagnostics(extracted, manifest); events.forEach((event) => validateEvent(event, manifest));
    assert(new Set(events.map((event) => blockKey(event.provenance.addBlock))).size === events.length, "Extractor emitted duplicate add-block provenance.", { replayId: fixture.replayId });
    const comparison = compare(events, labels(json(path.join(base, "timeline.json"))), manifest.runtime.timestampToleranceMillis);
    rows.push({ replayId: fixture.replayId, partition: fixture.partition, status: "pass", events, comparison, diagnostics: extracted.diagnostics, provenance: { replayOnlyExtractionInput: replay, offlineValidationInputs: [path.join(base, "match.json"), path.join(base, "timeline.json")], riotDataWasRuntimeInput: false } });
  } catch (error) { rows.push({ replayId: fixture.replayId, partition: fixture.partition, status: "fail", error: error.message }); }
  let pass = rows.length === manifest.fixtures.length && rows.every((row) => row.status === "pass"); let summaries;
  try { const d7 = rows.filter((row) => row.status === "pass" && row.partition === "D7"); const h3 = rows.filter((row) => row.status === "pass" && row.partition === "H3"); assert(d7.length === 7 && h3.length === 3, "D7/H3 fixture partition drifted."); summaries = { D7: summary(d7), H3: summary(h3), combined: summary([...d7, ...h3]) }; checkSummary(summaries.D7, manifest.expected.D7); checkSummary(summaries.H3, manifest.expected.H3); checkSummary(summaries.combined, manifest.expected.combined); } catch (error) { pass = false; summaries = { error: error.message }; }
  const report = { schema: "rofl-replay-direct-item-purchases-corpus-validation/v1", generatedAtUtc: new Date().toISOString(), status: pass ? "validated" : "failed", methodology: { runtimeCandidateInput: "Native --extract-replay-direct-item-purchases-json with the saved ROFL and canonical external profile only.", offlineValidationRole: "Saved Match-V5 checks exact build; saved Timeline ITEM_PURCHASED validates participant/timestamp/item triples only.", runtimeRiotInput: false, semanticBoundary: manifest.semanticBoundary }, profileProvenance: provenance, expected: manifest.expected, summaries, rows };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true }); fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify({ status: report.status, summaries }, null, 2)); if (!pass) process.exitCode = 1;
}
main();
