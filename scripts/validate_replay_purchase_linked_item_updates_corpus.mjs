#!/usr/bin/env node

// Productive, offline-only corpus gate for the narrow patch-16.14
// purchase-linked resulting-item-update decoder. The CLI receives only ROFL
// bytes plus the canonical local profile bundle; Match-V5 and Timeline files
// are opened only after extraction as validation oracles.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MANIFEST_PATH = path.join(
  "scripts", "manifests", "replay-purchase-linked-item-updates-16.14.expected.json",
);
const CANONICAL_PROFILE_PATH = path.join(
  "packages", "rofl-core", "profiles", "replay-decoder-profiles.v1.json",
);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    apiRoot: path.join("replays", "api"),
    outputPath: path.join("artifacts", "replay-purchase-linked-item-updates-corpus-validation.json"),
    manifestPath: MANIFEST_PATH,
    decoderProfilesPath: CANONICAL_PROFILE_PATH,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (arg === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (arg === "--api-root" && index + 1 < argv.length) args.apiRoot = argv[++index];
    else if (arg === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (arg === "--manifest" && index + 1 < argv.length) args.manifestPath = argv[++index];
    else if (arg === "--decoder-profiles" && index + 1 < argv.length) args.decoderProfilesPath = argv[++index];
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: node ./scripts/validate_replay_purchase_linked_item_updates_corpus.mjs [options]",
        "",
        "The native extractor receives only a ROFL path and the canonical external",
        "decoder profile bundle. Saved Match-V5 and Timeline fixtures are opened only",
        "afterward as offline validation oracles.",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return args;
}

function assert(condition, message, detail = null) {
  if (!condition) {
    const suffix = detail === null ? "" : `\n${JSON.stringify(detail, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fnv1a64(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function versionGroup(gameVersion) {
  return String(gameVersion ?? "").split(".").slice(0, 2).join(".");
}

function extract(cliPath, replayPath, decoderProfilesPath) {
  const result = spawnSync(cliPath, [
    "--extract-replay-purchase-linked-item-updates-json", replayPath,
    "--decoder-profiles", decoderProfilesPath,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `Native purchase-linked extractor exited with ${result.status}.`);
  }
  return JSON.parse(result.stdout);
}

function collectPurchaseLabels(timeline) {
  return (timeline.info?.frames ?? []).flatMap((frame) => frame.events ?? [])
    .filter((event) => event.type === "ITEM_PURCHASED")
    .filter((event) => Number.isInteger(event.participantId) && Number.isInteger(event.timestamp) && Number.isInteger(event.itemId))
    .map((event, index) => ({
      index,
      participantId: event.participantId,
      timestampMillis: event.timestamp,
      resultingItemId: event.itemId,
    }));
}

function sourceBlockKey(block) {
  assert(block && typeof block === "object", "Event is missing add-block provenance.");
  const provenance = block.provenance;
  assert(provenance && typeof provenance === "object", "Event block is missing framed provenance.", block);
  const fields = ["segmentType", "segmentId", "chunkId", "segmentPayloadOffset", "blockIndex", "decompressedHeaderOffset"];
  for (const field of fields) assert(provenance[field] !== undefined && provenance[field] !== null, `Add-block provenance is missing ${field}.`, block);
  return fields.map((field) => String(provenance[field])).join(":");
}

function sourceOrder(block) {
  const provenance = block.provenance;
  const fields = ["segmentPayloadOffset", "decompressedHeaderOffset", "blockIndex"];
  for (const field of fields) {
    assert(Number.isInteger(provenance[field]) && provenance[field] >= 0,
      `Event block has invalid physical-order field ${field}.`, block);
  }
  return fields.map((field) => provenance[field]);
}

function compareSourceOrder(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function eventGroupKey(event) {
  return `${event.participantId}:${event.timestampMillis}`;
}

function validateEventShape(event, manifest) {
  const expectedNetworkId = 0x400000ad + event.participantId;
  assert(event.type === manifest.runtime.eventType, "Runtime event type drifted.", event);
  assert(Number.isInteger(event.timestampMillis) && event.timestampMillis >= 0, "Runtime event timestamp is invalid.", event);
  assert(Number.isInteger(event.participantId) && event.participantId >= 1 && event.participantId <= 10,
    "Runtime event participant ID is invalid.", event);
  assert(event.participantNetworkId === expectedNetworkId, "Runtime event participant network ID drifted.", event);
  assert(typeof event.participantNetworkIdHex === "string" && event.participantNetworkIdHex.length > 0,
    "Runtime event participant network-ID hex provenance is unavailable.", event);
  assert(Number.isInteger(event.resultingItemId) && event.resultingItemId >= 0 && event.resultingItemId <= 8191,
    "Runtime event resulting item ID is invalid.", event);
  assert(event.purchaseLinked === true, "Runtime event does not declare purchaseLinked=true.", event);
  assert(Number.isInteger(event.matchedTemplateIndex) && event.matchedTemplateIndex >= 0 &&
    event.matchedTemplateIndex < manifest.frozenResearchEvidence.templateCount,
  "Runtime event template index is invalid.", event);
  assert(typeof event.matchedTemplateSignature === "string" && event.matchedTemplateSignature.length > 0,
    "Runtime event template signature is unavailable.", event);
  const expectedSignature = manifest.frozenResearchEvidence
    .runtimeTemplateSignatures[event.matchedTemplateIndex];
  assert(event.matchedTemplateSignature === expectedSignature,
    "Runtime event template signature does not match its frozen template index.", event);
  assert(event.provenance && typeof event.provenance === "object", "Runtime event is missing provenance.", event);
  const addBlockKey = sourceBlockKey(event.provenance.addBlock);
  assert(Array.isArray(event.provenance.groupBlocks) && event.provenance.groupBlocks.length > 0,
    "Runtime event is missing complete owner/time-group provenance.", event);
  const groupBlocks = event.provenance.groupBlocks;
  const groupSignature = groupBlocks.map((block) => {
    assert(["add", "removal", "removalContext", "undoComponent"].includes(block.family),
      "Runtime event contains an unknown purchase bundle family.", block);
    assert(Number.isInteger(block.contentLength) && block.contentLength >= 0,
      "Runtime event contains an invalid bundle content length.", block);
    return `${block.family}:${block.contentLength}`;
  }).join(">");
  assert(groupSignature === event.matchedTemplateSignature,
    "Runtime event group provenance does not reproduce the matched template signature.", event);
  const addBlocks = groupBlocks.filter((block) => block.family === "add");
  assert(addBlocks.length === 1 && groupBlocks.at(-1)?.family === "add",
    "Runtime event template must contain exactly one final add block.", event);
  assert(sourceBlockKey(addBlocks[0]) === addBlockKey,
    "Runtime event add-block provenance is not the add member of its owner/time group.", event);
  const groupBlockKeys = groupBlocks.map(sourceBlockKey);
  assert(new Set(groupBlockKeys).size === groupBlockKeys.length,
    "Runtime event owner/time group contains duplicate packet provenance.", event);
  const sourceOrders = groupBlocks.map(sourceOrder);
  for (let index = 1; index < sourceOrders.length; index += 1) {
    assert(compareSourceOrder(sourceOrders[index - 1], sourceOrders[index]) < 0,
      "Runtime event owner/time group is not in strict physical source order.", event);
  }
}

function compareEventsToOfflinePurchases(events, labels, toleranceMillis) {
  const used = new Set();
  const extras = [];
  const wrongItemIds = [];
  let maximumAbsoluteTimestampDeltaMillis = 0;
  for (const event of events) {
    const matchingLabelIndex = labels.findIndex((label, index) => !used.has(index) &&
      label.participantId === event.participantId && label.resultingItemId === event.resultingItemId &&
      Math.abs(label.timestampMillis - event.timestampMillis) <= toleranceMillis);
    if (matchingLabelIndex >= 0) {
      used.add(matchingLabelIndex);
      maximumAbsoluteTimestampDeltaMillis = Math.max(maximumAbsoluteTimestampDeltaMillis,
        Math.abs(labels[matchingLabelIndex].timestampMillis - event.timestampMillis));
      continue;
    }
    const sameOwnerAndTime = labels.filter((label) => label.participantId === event.participantId &&
      Math.abs(label.timestampMillis - event.timestampMillis) <= toleranceMillis);
    if (sameOwnerAndTime.length > 0) wrongItemIds.push({ event, expectedResultingItemIds: sameOwnerAndTime.map((label) => label.resultingItemId) });
    else extras.push(event);
  }
  return {
    offlineMatchedEventCount: used.size,
    extraRuntimeEventCount: extras.length,
    wrongItemIdEventCount: wrongItemIds.length,
    unmatchedOfflinePurchaseLabelCount: labels.length - used.size,
    maximumAbsoluteTimestampDeltaMillis,
    extras,
    wrongItemIds,
  };
}

function profileConfig(profileBytes, manifest) {
  const profile = JSON.parse(profileBytes);
  assert(profile.schema === manifest.profile.schema, "Canonical profile schema drifted.");
  assert(profile.registryId === manifest.profile.registryId, "Canonical profile registry ID drifted.");
  assert(profile.revision === manifest.profile.revision, "Canonical profile revision drifted.");
  const profileSha256 = crypto.createHash("sha256").update(profileBytes).digest("hex");
  const profileFingerprint = fnv1a64(profileBytes);
  assert(profileSha256 === manifest.profile.sha256, "Canonical profile SHA-256 drifted.", {
    expected: manifest.profile.sha256, actual: profileSha256,
  });
  assert(profileFingerprint === manifest.profile.fingerprint, "Canonical profile FNV-1a provenance fingerprint drifted.", {
    expected: manifest.profile.fingerprint, actual: profileFingerprint,
  });
  const selected = (profile.profiles ?? []).filter((entry) => entry.versionGroup === manifest.versionGroup &&
    (entry.acceptedGameVersions ?? []).includes(manifest.exactReplayBuild));
  assert(selected.length === 1, "Canonical profile does not select exactly one exact-build 16.14 profile.");
  assert(selected[0].inventoryPurchaseSubset, "Canonical 16.14 profile lacks the productive purchase-linked subset grammar.");
  const inventorySubsetProfiles = (profile.profiles ?? []).filter((entry) => entry.inventoryPurchaseSubset);
  assert(inventorySubsetProfiles.length === 1 && inventorySubsetProfiles[0] === selected[0],
    "Inventory purchase subset profile must be exact-build unique and fail closed for every other profile.");
  const inventory = selected[0].inventoryPurchaseSubset;
  const runtimeTemplateSignatures = inventory.templates.map((template) => template
    .map((token) => `${token.family}:${token.contentLength}`).join(">"));
  const runtimeTemplateSignatureSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(runtimeTemplateSignatures)).digest("hex");
  assert(JSON.stringify(runtimeTemplateSignatures) === JSON.stringify(manifest.frozenResearchEvidence.runtimeTemplateSignatures),
    "Canonical purchase runtime template signatures drifted.", {
      expected: manifest.frozenResearchEvidence.runtimeTemplateSignatures,
      actual: runtimeTemplateSignatures,
    });
  assert(runtimeTemplateSignatureSha256 === manifest.frozenResearchEvidence.runtimeTemplateSignatureSha256,
    "Canonical purchase runtime template signature SHA-256 drifted.", {
      expected: manifest.frozenResearchEvidence.runtimeTemplateSignatureSha256,
      actual: runtimeTemplateSignatureSha256,
    });
  assert(runtimeTemplateSignatures.length === manifest.frozenResearchEvidence.templateCount,
    "Canonical purchase runtime template count drifted.");
  return {
    reported: {
      schema: profile.schema,
      registryId: profile.registryId,
      revision: profile.revision,
      fingerprint: profileFingerprint,
    },
    bundleSha256: profileSha256,
    runtimeTemplateSignatures,
    runtimeTemplateSignatureSha256,
    grammar: {
      segmentType: inventory.segmentType,
      channel: inventory.channel,
      championNetworkIdBase: inventory.championNetworkIdBase,
      addUpdatePacketType: inventory.add.packetType,
      contentLengths: inventory.add.contentLengths.exact,
      removalPacketType: inventory.removal.packetType,
      removalContentLengths: inventory.removal.contentLengths.exact,
      removalContextPacketType: inventory.removalContext.packetType,
      removalContextContentLengths: inventory.removalContext.contentLengths.exact,
      undoComponentPacketType: inventory.undoComponent.packetType,
      templateCount: inventory.templates.length,
    },
  };
}

function assertProfileProvenance(extractedProfile, expected, manifest) {
  assert(extractedProfile && typeof extractedProfile === "object", "Extractor omitted profile provenance.");
  for (const [field, value] of Object.entries(expected.reported)) {
    assert(extractedProfile[field] === value, `Extractor profile provenance drifted at ${field}.`, {
      expected: value,
      actual: extractedProfile[field],
    });
  }
  assert(extractedProfile.origin === manifest.profile.origin, "Extractor did not use the external profile.", extractedProfile);
  for (const [field, value] of Object.entries(expected.grammar)) {
    assert(JSON.stringify(extractedProfile[field]) === JSON.stringify(value),
      `Extractor purchase profile grammar drifted at ${field}.`, { expected: value, actual: extractedProfile[field] });
  }
  assert(extractedProfile.championNetworkIdBaseHex === "0x400000AD", "Extractor champion network-ID base hex drifted.", extractedProfile);
  assert(extractedProfile.addUpdatePacketTypeHex === "0x0369" && extractedProfile.removalPacketTypeHex === "0x03F9" &&
    extractedProfile.removalContextPacketTypeHex === "0x0146" && extractedProfile.undoComponentPacketTypeHex === "0x0081",
  "Extractor inventory packet profile hex provenance drifted.", extractedProfile);
}

function diagnosticsFor(extracted, manifest) {
  const diagnostics = extracted.diagnostics;
  assert(diagnostics && typeof diagnostics === "object", "Extractor omitted diagnostics.");
  assert(diagnostics.exactPacketFraming === true, "Extractor did not establish exact packet framing.", diagnostics);
  assert(diagnostics.coverage === manifest.runtime.coverage, "Extractor coverage declaration drifted.", diagnostics);
  const fields = [
    "profiledAddUpdatePacketCount",
    "profiledOwnerTimeGroupCount",
    "matchedTemplateGroupCount",
    "emittedEventCount",
    "rejectedNonmatchingGroupCount",
    "rejectedUnavailableItemIdGroupCount",
    "unavailableAddUpdatePacketCount",
  ];
  for (const field of fields) assert(Number.isInteger(diagnostics[field]) && diagnostics[field] >= 0,
    `Extractor diagnostic ${field} is invalid.`, { actual: diagnostics[field] });
  assert(diagnostics.emittedEventCount === extracted.events.length,
    "Extractor emitted-event diagnostic does not equal event array length.", diagnostics);
  assert(diagnostics.matchedTemplateGroupCount === diagnostics.emittedEventCount + diagnostics.rejectedUnavailableItemIdGroupCount,
    "Matched template group accounting is not exhaustive.", diagnostics);
  assert(diagnostics.profiledAddUpdatePacketCount === diagnostics.emittedEventCount + diagnostics.unavailableAddUpdatePacketCount,
    "Unavailable add/update accounting is not exhaustive.", diagnostics);
  assert(diagnostics.profiledOwnerTimeGroupCount === diagnostics.matchedTemplateGroupCount +
    diagnostics.rejectedNonmatchingGroupCount,
  "Owner/time group accounting is not exhaustive.", diagnostics);
  const prohibitedCompleteClaims = [
    "completePurchaseTimelineAvailable",
    "inventoryTimelineAvailable",
    "currentInventoryAvailable",
    "generalPurchaseClassificationAvailable",
    "automaticStateUpdateClassificationAvailable",
    "consumedComponentIdentityAvailable",
    "removedItemIdentityAvailable",
    "slotAvailable",
    "itemInstanceAvailable",
    "countOrChargesAvailable",
    "priceAvailable",
    "goldStateAvailable",
    "undoAvailable",
    "inventoryStateAvailable",
  ];
  for (const field of prohibitedCompleteClaims) assert(diagnostics[field] === false,
    `Extractor must fail closed: ${field} must be false.`, diagnostics);
  return diagnostics;
}

function runFixture(args, manifest, profileProvenance, fixture) {
  const replayPath = path.resolve(args.replayDir, `${fixture.replayId}.rofl`);
  const fixtureRoot = path.resolve(args.apiRoot, fixture.replayId.replaceAll("-", "_"));
  const matchPath = path.join(fixtureRoot, "match.json");
  const timelinePath = path.join(fixtureRoot, "timeline.json");
  assert([replayPath, matchPath, timelinePath].every(fs.existsSync), `Missing fixed input for ${fixture.replayId}.`);
  const match = readJson(matchPath);
  assert(match.info?.gameVersion === manifest.exactReplayBuild,
    `${fixture.replayId} Match fixture fails exact-build gate.`, { gameVersion: match.info?.gameVersion });
  const extracted = extract(args.cliPath, replayPath, args.decoderProfilesPath);
  assert(extracted.schema === manifest.runtime.schema, `${fixture.replayId} extractor schema drifted.`, extracted);
  assert(extracted.gameVersion === manifest.exactReplayBuild && extracted.versionGroup === manifest.versionGroup,
    `${fixture.replayId} extractor did not fail closed to the exact build.`, extracted);
  assert(extracted.source?.runtimeInput === manifest.runtime.source.runtimeInput &&
    extracted.source?.riotApiInput === manifest.runtime.source.riotApiInput,
  `${fixture.replayId} extractor source boundary drifted.`, extracted.source);
  assertProfileProvenance(extracted.profile, profileProvenance, manifest);
  const diagnostics = diagnosticsFor(extracted, manifest);
  const events = Array.isArray(extracted.events) ? extracted.events : [];
  for (const event of events) validateEventShape(event, manifest);
  const addBlockKeys = events.map((event) => sourceBlockKey(event.provenance.addBlock));
  assert(new Set(addBlockKeys).size === addBlockKeys.length, `${fixture.replayId} emitted duplicate add-block provenance.`);
  const groupKeys = events.map(eventGroupKey);
  assert(new Set(groupKeys).size === groupKeys.length, `${fixture.replayId} emitted multiple events for one owner/time group.`);
  const offlinePurchaseLabels = collectPurchaseLabels(readJson(timelinePath));
  const comparison = compareEventsToOfflinePurchases(events, offlinePurchaseLabels,
    manifest.runtime.timestampToleranceMillis);
  return {
    replayId: fixture.replayId,
    partition: fixture.partition,
    status: "pass",
    emittedEventCount: events.length,
    emittedResultingItemIds: events.map((event) => event.resultingItemId),
    offlinePurchaseResultingItemIds: offlinePurchaseLabels.map((event) => event.resultingItemId),
    diagnostics,
    comparison,
    profile: extracted.profile,
    provenance: {
      replayOnlyExtractionInput: replayPath,
      offlineValidationInputs: [matchPath, timelinePath],
      riotDataWasRuntimeInput: false,
    },
  };
}

function sum(rows, key) {
  return rows.reduce((value, row) => value + (row[key] ?? 0), 0);
}

function partitionSummary(rows, expected) {
  const diagnostics = rows.map((row) => row.diagnostics);
  const result = {
    replayCount: rows.length,
    profiledAddUpdatePacketCount: diagnostics.reduce((total, value) => total + value.profiledAddUpdatePacketCount, 0),
    profiledOwnerTimeGroupCount: diagnostics.reduce((total, value) => total + value.profiledOwnerTimeGroupCount, 0),
    matchedTemplateGroupCount: diagnostics.reduce((total, value) => total + value.matchedTemplateGroupCount, 0),
    emittedEventCount: sum(rows, "emittedEventCount"),
    rejectedNonmatchingGroupCount: diagnostics.reduce((total, value) => total + value.rejectedNonmatchingGroupCount, 0),
    rejectedUnavailableItemIdGroupCount: diagnostics.reduce((total, value) => total + value.rejectedUnavailableItemIdGroupCount, 0),
    unavailableAddUpdatePacketCount: diagnostics.reduce((total, value) => total + value.unavailableAddUpdatePacketCount, 0),
    offlineMatchedEventCount: rows.reduce((total, row) => total + row.comparison.offlineMatchedEventCount, 0),
    extraRuntimeEventCount: rows.reduce((total, row) => total + row.comparison.extraRuntimeEventCount, 0),
    wrongItemIdEventCount: rows.reduce((total, row) => total + row.comparison.wrongItemIdEventCount, 0),
    unmatchedOfflinePurchaseLabelCount: rows.reduce((total, row) => total + row.comparison.unmatchedOfflinePurchaseLabelCount, 0),
    maximumAbsoluteTimestampDeltaMillis: Math.max(0, ...rows.map((row) => row.comparison.maximumAbsoluteTimestampDeltaMillis)),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (field === "unseenResultingItemIds" || field === "unseenResultingItemEventCount") continue;
    assert(result[field] === value, `Partition total ${field} drifted.`, { expected: value, actual: result[field] });
  }
  return result;
}

function main() {
  const args = parseArgs(process.argv);
  args.cliPath = path.resolve(args.cliPath);
  args.replayDir = path.resolve(args.replayDir);
  args.apiRoot = path.resolve(args.apiRoot);
  args.manifestPath = path.resolve(args.manifestPath);
  args.decoderProfilesPath = path.resolve(args.decoderProfilesPath);
  assert(fs.existsSync(args.cliPath), `Native CLI not found: ${args.cliPath}`);
  assert(fs.existsSync(args.manifestPath), `Expected manifest not found: ${args.manifestPath}`);
  assert(fs.existsSync(args.decoderProfilesPath), `Canonical decoder profile bundle not found: ${args.decoderProfilesPath}`);
  assert(args.decoderProfilesPath === path.resolve(CANONICAL_PROFILE_PATH),
    "This productive gate requires the canonical external profile asset.", { canonical: path.resolve(CANONICAL_PROFILE_PATH), actual: args.decoderProfilesPath });

  const manifest = readJson(args.manifestPath);
  assert(manifest.schema === "rofl-replay-purchase-linked-item-updates-corpus-expected/v1", "Unexpected expected-manifest schema.");
  const profileProvenance = profileConfig(fs.readFileSync(args.decoderProfilesPath, "utf8"), manifest);
  const rows = [];
  for (const fixture of manifest.fixtures) {
    try {
      rows.push(runFixture(args, manifest, profileProvenance, fixture));
    } catch (error) {
      rows.push({ replayId: fixture.replayId, partition: fixture.partition, status: "fail", error: error.message });
    }
  }
  const d7Rows = rows.filter((row) => row.partition === "D7" && row.status === "pass");
  const h3Rows = rows.filter((row) => row.partition === "H3" && row.status === "pass");
  let summaries = null;
  let pass = rows.length === manifest.fixtures.length && rows.every((row) => row.status === "pass");
  try {
    assert(d7Rows.length === 7 && h3Rows.length === 3, "D7/H3 fixture partition drifted.");
    const D7 = partitionSummary(d7Rows, manifest.expected.D7);
    const H3 = partitionSummary(h3Rows, manifest.expected.H3);
    const combined = partitionSummary([...d7Rows, ...h3Rows], manifest.expected.combined);
    const d7KnownItemIds = new Set(d7Rows.flatMap((row) => row.offlinePurchaseResultingItemIds));
    const h3UnseenItems = h3Rows.flatMap((row) => row.emittedResultingItemIds)
      .filter((itemId) => !d7KnownItemIds.has(itemId));
    assert(h3UnseenItems.length === manifest.expected.H3.unseenResultingItemEventCount,
      "H3 unseen resulting-item event count drifted.", { expected: manifest.expected.H3.unseenResultingItemEventCount, actual: h3UnseenItems.length });
    assert(JSON.stringify([...new Set(h3UnseenItems)].sort((left, right) => left - right)) ===
      JSON.stringify(manifest.expected.H3.unseenResultingItemIds),
    "H3 unseen resulting-item IDs drifted.", { expected: manifest.expected.H3.unseenResultingItemIds, actual: [...new Set(h3UnseenItems)].sort((left, right) => left - right) });
    summaries = { D7, H3, combined };
  } catch (error) {
    pass = false;
    summaries = { error: error.message };
  }
  const report = {
    schema: "rofl-replay-purchase-linked-item-updates-corpus-validation/v1",
    generatedAtUtc: new Date().toISOString(),
    status: pass ? "validated" : "failed",
    methodology: {
      runtimeCandidateInput: "Productive native --extract-replay-purchase-linked-item-updates-json with the loaded ROFL and canonical external profile only.",
      offlineValidationRole: "Saved Match-V5 verifies the exact build; saved Timeline ITEM_PURCHASED events validate emitted participant/timestamp/resulting-item triples only.",
      runtimeRiotInput: false,
      strictSubsetBoundary: manifest.frozenResearchEvidence.semanticBoundary,
      expectedManifest: args.manifestPath,
      canonicalProfileBundle: args.decoderProfilesPath,
    },
    profileProvenance,
    expected: manifest.expected,
    summaries,
    rows,
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, summaries }, null, 2));
  if (!pass) process.exitCode = 1;
}

main();
