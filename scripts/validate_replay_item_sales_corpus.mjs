#!/usr/bin/env node

// Productive offline corpus gate for the exact patch-16.14 replay-only
// ITEM_SOLD operation stream. The native CLI receives only the saved ROFL and
// canonical external decoder profile. Match-V5 and Timeline fixtures open only
// after extraction as offline validation oracles.
//
// Expected native contract (intentionally checked before this command exists):
//   --extract-replay-item-sales-json <replay.rofl> --decoder-profiles <profiles.json>
//   {
//     schema: "rofl-replay-item-sales/v1",
//     gameVersion: "16.14.794.5912", versionGroup: "16.14",
//     source: { runtimeInput: "rofl-only", riotApiInput: false },
//     profile: { ...canonical external profile provenance, origin: "external",
//       segmentType: "chunk", channel: 1, championNetworkIdBase: 1073741997,
//       removalPacketType: 1017, removalContentLengths: [6,7] },
//     diagnostics: { exactPacketFraming: true, coverage: "exact-sale-operation-only",
//       emittedEventCount, soldItemIdAvailable: false, slotAvailable: false,
//       itemInstanceAvailable: false, countOrChargesAvailable: false,
//       priceAvailable: false, goldGainAvailable: false,
//       inventoryStateAvailable: false, undoAvailable: false },
//     events: [{ type: "ITEM_SOLD_OPERATION", timestampMillis, participantId,
//       participantNetworkId, participantNetworkIdHex,
//       availability: { soldItemId:false, slot:false, itemInstance:false,
//         countOrCharges:false, price:false, goldGain:false,
//         inventoryState:false, undo:false },
//       provenance: { removalBlock: { family:"removal", channel:1,
//         packetType:1017, packetTypeHex:"0x03F9", contentLength:6|7,
//         blockParam, provenance:{ segmentType, segmentId, chunkId,
//         segmentPayloadOffset, blockIndex, decompressedHeaderOffset } } } }]
//   }
// The stream is deliberately operation-only: it must not emit a sold item ID,
// slot, instance, count, price, gold, undo, or inventory state.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_PATH = path.join("scripts", "manifests", "replay-item-sales-16.14.expected.json");
const CANONICAL_PROFILE_PATH = path.join("packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json");

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-item-sales-corpus-validation.json"),
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
      console.log("Usage: node scripts/validate_replay_item_sales_corpus.mjs [--cli <path>] [--decoder-profiles <canonical-profile-json>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) throw new Error(`${message}${detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
}
function readJson(filePath) { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, "utf8")) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}
function fixedHex(value, width) {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}
function sourceBlockKey(block) {
  const provenance = block?.provenance;
  const fields = [
    "segmentType", "segmentId", "chunkId", "segmentHeaderOffset",
    "segmentPayloadOffset", "blockIndex", "decompressedHeaderOffset",
    "decompressedContentOffset", "decompressedEndOffset",
  ];
  assert(provenance && typeof provenance === "object", "Sale event is missing removal framed provenance.", block);
  for (const field of fields) assert(provenance[field] !== undefined && provenance[field] !== null, `Removal provenance misses ${field}.`, block);
  assert(provenance.segmentType === "chunk", "Sale removal provenance must remain chunk-derived.", block);
  for (const field of fields.slice(1)) {
    assert(Number.isInteger(provenance[field]) && provenance[field] >= 0, `Removal provenance has invalid ${field}.`, block);
  }
  assert(
    provenance.decompressedHeaderOffset <= provenance.decompressedContentOffset
      && provenance.decompressedContentOffset < provenance.decompressedEndOffset,
    "Sale removal decompressed provenance boundaries are invalid.",
    block,
  );
  return fields.map((field) => String(provenance[field])).join(":");
}
function physicalOrder(block) {
  const p = block.provenance;
  for (const field of ["segmentPayloadOffset", "decompressedHeaderOffset", "blockIndex"]) assert(Number.isInteger(p[field]) && p[field] >= 0, `Invalid removal source order ${field}.`, block);
  return [p.segmentPayloadOffset, p.decompressedHeaderOffset, p.blockIndex];
}
function compareOrder(left, right) { for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i]; return 0; }
function collectSaleLabels(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_SOLD" && Number.isInteger(event.participantId) && Number.isInteger(event.timestamp))
    .map((event, index) => ({ index, participantId: event.participantId, timestampMillis: event.timestamp }));
}
function extract(cliPath, replayPath, decoderProfilesPath) {
  const result = spawnSync(cliPath, ["--extract-replay-item-sales-json", replayPath, "--decoder-profiles", decoderProfilesPath], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `Native item-sales extractor exited with ${result.status}.`);
  return JSON.parse(result.stdout);
}
function canonicalProfile(profileBytes, manifest) {
  const profile = JSON.parse(profileBytes);
  const sha256 = crypto.createHash("sha256").update(profileBytes).digest("hex");
  const fingerprint = fnv1a64(profileBytes);
  for (const field of ["schema", "registryId", "revision"]) assert(profile[field] === manifest.profile[field], `Canonical profile ${field} drifted.`);
  assert(sha256 === manifest.profile.sha256 && fingerprint === manifest.profile.fingerprint, "Canonical profile fingerprint drifted.", { sha256, fingerprint });
  const selected = (profile.profiles ?? []).filter((entry) => entry.versionGroup === manifest.versionGroup && (entry.acceptedGameVersions ?? []).includes(manifest.exactReplayBuild));
  assert(selected.length === 1, "Canonical external profile must select exactly one 16.14 build profile.");
  const inventory = selected[0].inventorySaleSubset;
  assert(inventory, "Current exact-build profile lacks the strict inventory sale grammar.");
  const grammar = manifest.profileGrammar;
  assert(
    inventory.segmentType === grammar.segmentType
      && inventory.channel === grammar.channel
      && inventory.championNetworkIdBase === grammar.championNetworkIdBase
      && inventory.add?.packetType === grammar.addUpdatePacketType
      && JSON.stringify(inventory.add?.contentLengths?.exact) === JSON.stringify(grammar.addUpdateContentLengths)
      && inventory.removal?.packetType === grammar.removalPacketType
      && JSON.stringify(inventory.removal?.contentLengths?.exact) === JSON.stringify(grammar.removalContentLengths)
      && inventory.exactGroup?.timestampToleranceMillis === grammar.groupTimestampToleranceMillis
      && inventory.exactGroup?.addCount === grammar.requiredAddUpdateCount
      && inventory.exactGroup?.removalCount === grammar.requiredRemovalCount
      && JSON.stringify(inventory.removalPayload?.payload0LowNibbleAllow) === JSON.stringify(grammar.payload0LowNibbleValues)
      && inventory.removalPayload?.payload2LowTwoBitReject === grammar.payload2RejectedLowBitsValue
      && grammar.payload2LowBitsMask === 3
      && JSON.stringify(inventory.removalPayload?.payload2Allow) === JSON.stringify(grammar.salePayloadByte2Values),
    "Canonical inventory sale grammar drifted.",
    { inventory, grammar },
  );
  return { schema: profile.schema, registryId: profile.registryId, revision: profile.revision, fingerprint, origin: manifest.profile.origin, ...grammar };
}
function assertProfile(extracted, expected) {
  assert(extracted && typeof extracted === "object", "Extractor omitted external-profile provenance.");
  for (const [field, value] of Object.entries(expected)) assert(JSON.stringify(extracted[field]) === JSON.stringify(value), `Extractor profile provenance drifted at ${field}.`, { expected: value, actual: extracted[field] });
  assert(extracted.championNetworkIdBaseHex === "0x400000AD" && extracted.removalPacketTypeHex === "0x03F9", "Extractor profile hex provenance drifted.", extracted);
}
function assertUnavailable(value, manifest, subject, diagnosticNames = false) {
  assert(value && typeof value === "object", `${subject} omits explicit availability.`);
  for (const field of manifest.runtime.unavailableFields) {
    const availabilityField = diagnosticNames ? `${field}Available` : field;
    assert(value[availabilityField] === false, `${subject} must fail closed: ${availabilityField} must be false.`, value);
  }
}
function validateEvent(event, manifest) {
  assert(event.type === manifest.runtime.eventType, "Sale event type drifted.", event);
  assert(Number.isInteger(event.timestampMillis) && event.timestampMillis >= 0, "Sale event timestamp invalid.", event);
  assert(Number.isInteger(event.participantId) && event.participantId >= 1 && event.participantId <= 10, "Sale event participant invalid.", event);
  const expectedNetworkId = manifest.profileGrammar.championNetworkIdBase + event.participantId;
  assert(
    event.participantNetworkId === expectedNetworkId
      && event.participantNetworkIdHex === fixedHex(expectedNetworkId, 8),
    "Sale event owner provenance drifted.",
    event,
  );
  assertUnavailable(event.availability, manifest, "Sale event");
  for (const field of manifest.runtime.unavailableFields) assert(!Object.hasOwn(event, field), `Sale event must not expose unavailable ${field}.`, event);
  const removal = event.provenance?.removalBlock;
  assert(removal?.family === "removal" && removal.channel === manifest.profileGrammar.channel && removal.packetType === manifest.profileGrammar.removalPacketType && removal.packetTypeHex === "0x03F9", "Sale event removal family provenance drifted.", event);
  assert(manifest.profileGrammar.removalContentLengths.includes(removal.contentLength), "Sale event removal length is outside the profile.", event);
  assert(
    removal.blockParam === expectedNetworkId
      && removal.blockParamHex === fixedHex(expectedNetworkId, 8),
    "Sale event removal owner handle does not equal participant network ID.",
    event,
  );
  sourceBlockKey(removal);
  return removal;
}
function compareToLabels(events, labels, toleranceMillis) {
  const participantIds = [...new Set([
    ...events.map((event) => event.participantId),
    ...labels.map((label) => label.participantId),
  ])].sort((left, right) => left - right);
  const matchedEvents = new Set();
  const matchedLabels = new Set();
  let maximumAbsoluteTimestampDeltaMillis = 0;

  // Monotone dynamic matching avoids greedy label consumption when two events
  // are close. It maximizes one-to-one matches, then minimizes total delta.
  for (const participantId of participantIds) {
    const participantEvents = events
      .map((event, index) => ({ event, index }))
      .filter((entry) => entry.event.participantId === participantId)
      .sort((left, right) => left.event.timestampMillis - right.event.timestampMillis || left.index - right.index);
    const participantLabels = labels
      .map((label, index) => ({ label, index }))
      .filter((entry) => entry.label.participantId === participantId)
      .sort((left, right) => left.label.timestampMillis - right.label.timestampMillis || left.index - right.index);
    const rows = participantEvents.length + 1;
    const columns = participantLabels.length + 1;
    const table = Array.from({ length: rows }, () => Array.from(
      { length: columns }, () => ({ matches: Number.NEGATIVE_INFINITY, cost: Number.POSITIVE_INFINITY, previous: null }),
    ));
    table[0][0] = { matches: 0, cost: 0, previous: null };
    const better = (candidate, current) => candidate.matches > current.matches
      || (candidate.matches === current.matches && candidate.cost < current.cost);
    for (let i = 0; i < rows; i += 1) {
      for (let j = 0; j < columns; j += 1) {
        const current = table[i][j];
        if (!Number.isFinite(current.matches)) continue;
        if (i < participantEvents.length) {
          const candidate = { matches: current.matches, cost: current.cost, previous: [i, j, "skip-event"] };
          if (better(candidate, table[i + 1][j])) table[i + 1][j] = candidate;
        }
        if (j < participantLabels.length) {
          const candidate = { matches: current.matches, cost: current.cost, previous: [i, j, "skip-label"] };
          if (better(candidate, table[i][j + 1])) table[i][j + 1] = candidate;
        }
        if (i < participantEvents.length && j < participantLabels.length) {
          const delta = Math.abs(
            participantEvents[i].event.timestampMillis
              - participantLabels[j].label.timestampMillis,
          );
          if (delta <= toleranceMillis) {
            const candidate = {
              matches: current.matches + 1,
              cost: current.cost + delta,
              previous: [i, j, "match"],
            };
            if (better(candidate, table[i + 1][j + 1])) table[i + 1][j + 1] = candidate;
          }
        }
      }
    }
    let i = participantEvents.length;
    let j = participantLabels.length;
    while (i > 0 || j > 0) {
      const previous = table[i][j].previous;
      assert(previous, "Sale oracle matcher encountered an incomplete path.", { participantId, i, j });
      const [previousI, previousJ, operation] = previous;
      if (operation === "match") {
        matchedEvents.add(participantEvents[previousI].index);
        matchedLabels.add(participantLabels[previousJ].index);
        maximumAbsoluteTimestampDeltaMillis = Math.max(
          maximumAbsoluteTimestampDeltaMillis,
          Math.abs(
            participantEvents[previousI].event.timestampMillis
              - participantLabels[previousJ].label.timestampMillis,
          ),
        );
      }
      i = previousI;
      j = previousJ;
    }
  }
  const extras = events.filter((_, index) => !matchedEvents.has(index));
  return {
    offlineMatchedEventCount: matchedEvents.size,
    extraRuntimeEventCount: extras.length,
    unmatchedOfflineSaleLabelCount: labels.length - matchedLabels.size,
    maximumAbsoluteTimestampDeltaMillis,
    extras,
  };
}
function runFixture(args, manifest, profile, fixture) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const root = path.resolve(args.apiRoot, fixture.replayId.replaceAll("-", "_"));
  const matchPath = path.join(root, "match.json"); const timelinePath = path.join(root, "timeline.json");
  assert([replayPath, matchPath, timelinePath].every(fs.existsSync), `Missing fixed fixture input for ${fixture.replayId}.`);
  assert(readJson(matchPath).info?.gameVersion === manifest.exactReplayBuild, `${fixture.replayId} Match fixture fails exact-build gate.`);
  const extracted = extract(args.cliPath, replayPath, args.decoderProfilesPath);
  assert(extracted.schema === manifest.runtime.schema && extracted.gameVersion === manifest.exactReplayBuild && extracted.versionGroup === manifest.versionGroup, `${fixture.replayId} extractor exact-build/schema gate failed.`, extracted);
  assert(extracted.source?.runtimeInput === "rofl-only" && extracted.source?.riotApiInput === false, `${fixture.replayId} extractor source boundary drifted.`, extracted.source);
  assertProfile(extracted.profile, profile);
  const diagnostics = extracted.diagnostics;
  assert(diagnostics?.exactPacketFraming === true && diagnostics.coverage === manifest.runtime.coverage && Number.isInteger(diagnostics.emittedEventCount), `${fixture.replayId} sale diagnostics drifted.`, diagnostics);
  assertUnavailable(diagnostics, manifest, "Sale diagnostics", true);
  const events = Array.isArray(extracted.events) ? extracted.events : [];
  assert(diagnostics.emittedEventCount === events.length, `${fixture.replayId} emitted-count diagnostic mismatch.`, diagnostics);
  const removals = events.map((event) => validateEvent(event, manifest));
  const keys = removals.map(sourceBlockKey); assert(new Set(keys).size === keys.length, `${fixture.replayId} duplicated removal provenance.`);
  for (let i = 1; i < removals.length; i += 1) assert(compareOrder(physicalOrder(removals[i - 1]), physicalOrder(removals[i])) < 0, `${fixture.replayId} events are not strict physical source order.`);
  const comparison = compareToLabels(events, collectSaleLabels(readJson(timelinePath)), manifest.runtime.timestampToleranceMillis);
  assert(events.length === fixture.expectedSaleCount && comparison.offlineMatchedEventCount === fixture.expectedSaleCount && comparison.extraRuntimeEventCount === 0 && comparison.unmatchedOfflineSaleLabelCount === 0, `${fixture.replayId} sale count/oracle gate failed.`, { expected: fixture.expectedSaleCount, events: events.length, comparison });
  return { replayId: fixture.replayId, partition: fixture.partition, status: "pass", emittedEventCount: events.length, diagnostics, comparison, profile: extracted.profile, provenance: { replayOnlyExtractionInput: replayPath, offlineValidationInputs: [matchPath, timelinePath], riotDataWasRuntimeInput: false } };
}
function summary(rows, expected) {
  const result = { replayCount: rows.length, emittedEventCount: rows.reduce((n, row) => n + row.emittedEventCount, 0), offlineMatchedEventCount: rows.reduce((n, row) => n + row.comparison.offlineMatchedEventCount, 0), extraRuntimeEventCount: rows.reduce((n, row) => n + row.comparison.extraRuntimeEventCount, 0), unmatchedOfflineSaleLabelCount: rows.reduce((n, row) => n + row.comparison.unmatchedOfflineSaleLabelCount, 0), maximumAbsoluteTimestampDeltaMillis: Math.max(0, ...rows.map((row) => row.comparison.maximumAbsoluteTimestampDeltaMillis)) };
  for (const [field, value] of Object.entries(expected)) assert(result[field] === value, `Partition ${field} drifted.`, { expected: value, actual: result[field] });
  return result;
}
function main() {
  const args = parseArgs(process.argv);
  for (const field of ["cliPath", "replayDir", "apiRoot", "outputPath", "manifestPath", "decoderProfilesPath"]) args[field] = path.resolve(args[field]);
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);
  assert(fs.existsSync(args.manifestPath) && fs.existsSync(args.decoderProfilesPath), "Manifest or canonical decoder profile bundle is missing.");
  assert(args.decoderProfilesPath === path.resolve(CANONICAL_PROFILE_PATH), "This gate requires the canonical external profile asset.");
  const manifest = readJson(args.manifestPath);
  assert(manifest.schema === "rofl-replay-item-sales-corpus-expected/v1", "Unexpected item-sales expected-manifest schema.");
  const profile = canonicalProfile(fs.readFileSync(args.decoderProfilesPath, "utf8"), manifest);
  const rows = [];
  for (const fixture of manifest.fixtures) try { rows.push(runFixture(args, manifest, profile, fixture)); } catch (error) { rows.push({ replayId: fixture.replayId, partition: fixture.partition, status: "fail", error: error.message }); }
  const d7 = rows.filter((row) => row.status === "pass" && row.partition === "D7"); const h3 = rows.filter((row) => row.status === "pass" && row.partition === "H3");
  let summaries; let pass = rows.length === manifest.fixtures.length && rows.every((row) => row.status === "pass");
  try { summaries = { D7: summary(d7, manifest.expected.D7), H3: summary(h3, manifest.expected.H3), combined: summary([...d7, ...h3], manifest.expected.combined) }; } catch (error) { pass = false; summaries = { error: error.message }; }
  const report = { schema: "rofl-replay-item-sales-corpus-validation/v1", generatedAtUtc: new Date().toISOString(), status: pass ? "validated" : "failed", methodology: { runtimeCandidateInput: "Native --extract-replay-item-sales-json with loaded ROFL and canonical external profile only.", offlineValidationRole: "Saved Match-V5 checks exact build; saved Timeline ITEM_SOLD validates participant/timestamp only after extraction.", runtimeRiotInput: false, expectedManifest: args.manifestPath, canonicalProfileBundle: args.decoderProfilesPath, unavailableBoundary: manifest.contract.unavailableBoundary }, profileProvenance: profile, expected: manifest.expected, summaries, rows };
  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true }); fs.writeFileSync(args.outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, summaries }, null, 2));
  if (!pass) process.exitCode = 1;
}
main();
