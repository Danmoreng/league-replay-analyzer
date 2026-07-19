#!/usr/bin/env node

// Replay-only negative research. This proves that the two input codes omitted
// by the maintained patch-16.14 item-ID grammar are underdetermined by the
// saved corpus. It does not add or feed a decoder.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  packetType: 0x0369,
  channel: 1,
  championIdBase: 0x400000ad,
  minimumInputPayloadLength: 10,
});

const FIXTURES = Object.freeze([
  Object.freeze({ replayId: "EUW1-7919517389", partition: "D7", allPacketCount: 260, inputCapableCount: 254 }),
  Object.freeze({ replayId: "EUW1-7919624327", partition: "D7", allPacketCount: 272, inputCapableCount: 266 }),
  Object.freeze({ replayId: "EUW1-7920241664", partition: "D7", allPacketCount: 371, inputCapableCount: 363 }),
  Object.freeze({ replayId: "EUW1-7920292147", partition: "D7", allPacketCount: 326, inputCapableCount: 318 }),
  Object.freeze({ replayId: "EUW1-7920341366", partition: "D7", allPacketCount: 244, inputCapableCount: 236 }),
  Object.freeze({ replayId: "EUW1-7920364492", partition: "D7", allPacketCount: 283, inputCapableCount: 275 }),
  Object.freeze({ replayId: "EUW1-7920550565", partition: "D7", allPacketCount: 335, inputCapableCount: 328 }),
  Object.freeze({ replayId: "EUW1-7921377760", partition: "H3", allPacketCount: 320, inputCapableCount: 312 }),
  Object.freeze({ replayId: "EUW1-7921482297", partition: "H3", allPacketCount: 544, inputCapableCount: 536 }),
  Object.freeze({ replayId: "EUW1-7921996430", partition: "H3", allPacketCount: 311, inputCapableCount: 304 }),
]);

const EXPECTED = Object.freeze({
  D7: Object.freeze({
    allPacketCount: 2091,
    inputCapableCount: 2040,
    inputCodes: Object.freeze({
      "bit9-code0": Object.freeze([0, 235, 79, 602, 4, 1041, 21, 58]),
      "bit11-code4": Object.freeze([325, 214, 721, 139, 0, 88, 234, 319]),
    }),
  }),
  H3: Object.freeze({
    allPacketCount: 1175,
    inputCapableCount: 1152,
    inputCodes: Object.freeze({
      "bit9-code0": Object.freeze([0, 125, 65, 308, 3, 606, 16, 29]),
      "bit11-code4": Object.freeze([165, 168, 406, 54, 0, 42, 163, 154]),
    }),
  }),
  combined: Object.freeze({
    allPacketCount: 3266,
    inputCapableCount: 3192,
    inputCodes: Object.freeze({
      "bit9-code0": Object.freeze([0, 360, 144, 910, 7, 1647, 37, 87]),
      "bit11-code4": Object.freeze([490, 382, 1127, 193, 0, 130, 397, 473]),
    }),
  }),
});

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

const TARGETS = Object.freeze([
  Object.freeze({
    name: "bit9-code0",
    itemIdBit: 9,
    inputBits: Object.freeze([72, 73, 79]),
    missingCode: 0,
    maintainedFormula: "q73 XOR (q73 AND q79) XOR (q72 AND q73 AND q79)",
    alternateDeltaFormula: "(1 XOR q72) AND (1 XOR q73) AND (1 XOR q79)",
    maintained: (payload) => payloadBit(payload, 73)
      ^ (payloadBit(payload, 73) & payloadBit(payload, 79))
      ^ (payloadBit(payload, 72) & payloadBit(payload, 73) & payloadBit(payload, 79)),
  }),
  Object.freeze({
    name: "bit11-code4",
    itemIdBit: 11,
    inputBits: Object.freeze([73, 75, 76]),
    missingCode: 4,
    maintainedFormula: "1 XOR q75 XOR q76 XOR (q73 AND q76)",
    alternateDeltaFormula: "(1 XOR q73) AND (1 XOR q75) AND q76",
    maintained: (payload) => 1
      ^ payloadBit(payload, 75)
      ^ payloadBit(payload, 76)
      ^ (payloadBit(payload, 73) & payloadBit(payload, 76)),
  }),
]);

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build", "packages", "rofl-core", "rofl_core_cli.exe"),
    replayDir: "replays",
    outputPath: path.join("artifacts", "inventory-item-id-missing-symbols-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && index + 1 < argv.length) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && index + 1 < argv.length) args.replayDir = argv[++index];
    else if (argument === "--output" && index + 1 < argv.length) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: node scripts/research_inventory_item_id_missing_symbols_16_14.mjs [--cli <path>] [--replay-dir <path>] [--output <path>]");
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function inputCode(payload, inputBits) {
  return inputBits.reduce((code, bit, index) => code | (payloadBit(payload, bit) << index), 0);
}

function payloadForInputCode(inputBits, code) {
  const payload = Buffer.alloc(PROFILE.minimumInputPayloadLength);
  for (let index = 0; index < inputBits.length; index += 1) {
    if (((code >> index) & 1) !== 0) payload[inputBits[index] >> 3] |= 1 << (inputBits[index] & 7);
  }
  return payload;
}

function participantId(block) {
  const candidate = block.blockParam - PROFILE.championIdBase;
  return block.channel === PROFILE.channel && Number.isInteger(candidate)
    && candidate >= 1 && candidate <= 10 ? candidate : null;
}

function physicalPacketKey(block) {
  return `${block.segmentType}:${block.segmentId}:${block.chunkId}:${block.segmentPayloadOffset}:${block.blockIndex}:${block.sourceOffset}`;
}

function dumpPacketType(cliPath, replayPath, segmentType) {
  const result = spawnSync(cliPath, [
    "--dump-packet-types-json", replayPath,
    "--packet-type", String(PROFILE.packetType),
    "--segment-type", segmentType,
    "--max-blocks", "0",
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `${path.basename(replayPath)} packet dump failed.`);
  const output = JSON.parse(result.stdout);
  const typeDump = output.packetTypeDumps?.find((entry) => entry.packetType === PROFILE.packetType);
  if (!output.valid || output.errors?.length || !typeDump || typeDump.truncated
    || typeDump.emittedBlockCount !== typeDump.matchingBlockCount) {
    throw new Error(`${path.basename(replayPath)} failed the complete ${segmentType} packet-dump gate.`);
  }
  return { gameVersion: output.gameVersion, blocks: typeDump.blocks ?? [] };
}

function assertPhysicalUnion(replayId, scans) {
  const union = [...scans.chunk.blocks, ...scans.keyframe.blocks, ...scans.startup.blocks];
  const allKeys = new Set(scans.all.blocks.map(physicalPacketKey));
  const unionKeys = new Set(union.map(physicalPacketKey));
  assert(allKeys.size === scans.all.blocks.length, `${replayId} all-segment scan has duplicate physical keys.`);
  assert(unionKeys.size === union.length, `${replayId} per-segment union has duplicate physical keys.`);
  assert(allKeys.size === unionKeys.size && [...allKeys].every((key) => unionKeys.has(key)),
    `${replayId} all scan is not the exact chunk + keyframe + startup union.`);
}

function inspectFixture(cliPath, replayDir, fixture) {
  const replayPath = path.join(replayDir, `${fixture.replayId}.rofl`);
  assert(fs.existsSync(replayPath), `Missing fixed replay ${fixture.replayId}.`);
  const scans = Object.fromEntries(["chunk", "keyframe", "startup", "all"]
    .map((segmentType) => [segmentType, dumpPacketType(cliPath, replayPath, segmentType)]));
  assert(Object.values(scans).every((scan) => scan.gameVersion === PROFILE.exactReplayBuild),
    `${fixture.replayId} failed the exact replay-build gate.`);
  assertPhysicalUnion(fixture.replayId, scans);
  const owned = scans.all.blocks.map((block) => ({ block, participantId: participantId(block) }));
  assert(owned.every((entry) => entry.participantId !== null),
    `${fixture.replayId} contains a 0x0369 block outside the champion-owner boundary.`);
  assert(owned.length === fixture.allPacketCount,
    `${fixture.replayId} all-packet count drifted: ${owned.length}/${fixture.allPacketCount}.`);
  const rows = owned.filter(({ block }) => block.contentLength >= PROFILE.minimumInputPayloadLength)
    .map(({ block }) => {
      assert(block.contentHexTruncated === false && block.contentHexBytes === block.contentLength
        && typeof block.contentHex === "string" && /^[0-9a-f]*$/iu.test(block.contentHex),
      `${fixture.replayId} contains incomplete payload bytes.`);
      const payload = Buffer.from(block.contentHex, "hex");
      assert(payload.length === block.contentLength, `${fixture.replayId} contains invalid payload hex.`);
      return payload;
    });
  assert(rows.length === fixture.inputCapableCount,
    `${fixture.replayId} input-capable count drifted: ${rows.length}/${fixture.inputCapableCount}.`);
  return {
    report: {
      replayId: fixture.replayId,
      partition: fixture.partition,
      exactReplayBuild: scans.all.gameVersion,
      allPacketCount: owned.length,
      inputCapableCount: rows.length,
      keyframePacketCount: scans.keyframe.blocks.length,
      startupPacketCount: scans.startup.blocks.length,
      exactPhysicalPacketUnion: true,
    },
    rows,
  };
}

function codeCounts(rows, target) {
  const counts = Array(8).fill(0);
  for (const payload of rows) counts[inputCode(payload, target.inputBits)] += 1;
  return counts;
}

function assertPartition(name, fixtureResults, expected) {
  const rows = fixtureResults.flatMap((fixture) => fixture.rows);
  const allPacketCount = fixtureResults.reduce((sum, fixture) => sum + fixture.report.allPacketCount, 0);
  assert(allPacketCount === expected.allPacketCount,
    `${name} all-packet count drifted: ${allPacketCount}/${expected.allPacketCount}.`);
  assert(rows.length === expected.inputCapableCount,
    `${name} input-capable count drifted: ${rows.length}/${expected.inputCapableCount}.`);
  const counts = Object.fromEntries(TARGETS.map((target) => [target.name, codeCounts(rows, target)]));
  for (const target of TARGETS) {
    assert(JSON.stringify(counts[target.name]) === JSON.stringify(expected.inputCodes[target.name]),
      `${name} ${target.name} distribution drifted.`);
  }
  return { rows, report: { allPacketCount, inputCapableCount: rows.length, inputCodes: counts } };
}

function alternativeDecoderWitness(target, rows) {
  const alternate = (payload) => target.maintained(payload)
    ^ Number(inputCode(payload, target.inputBits) === target.missingCode);
  const observedDisagreementCount = rows.filter((payload) => target.maintained(payload) !== alternate(payload)).length;
  const missingPayload = payloadForInputCode(target.inputBits, target.missingCode);
  const maintainedMissingOutput = target.maintained(missingPayload);
  const alternateMissingOutput = alternate(missingPayload);
  assert(observedDisagreementCount === 0, `${target.name} alternate decoder changes an observed packet.`);
  assert(maintainedMissingOutput === 0 && alternateMissingOutput === 1,
    `${target.name} alternate decoder does not expose the expected 0/1 ambiguity.`);
  return {
    itemIdBit: target.itemIdBit,
    inputBits: target.inputBits,
    missingCode: target.missingCode,
    maintainedFormula: target.maintainedFormula,
    alternateFormula: `(${target.maintainedFormula}) XOR (${target.alternateDeltaFormula})`,
    alternateDeltaFormula: target.alternateDeltaFormula,
    maintainedMissingOutput,
    equallyCompatibleAlternateMissingOutput: alternateMissingOutput,
    observedPacketDisagreementCount: observedDisagreementCount,
    itemIdDifferenceAtMissingCode: 2 ** target.itemIdBit,
  };
}

function writeJson(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  const cliPath = path.resolve(args.cliPath);
  const replayDir = path.resolve(args.replayDir);
  assert(fs.existsSync(cliPath), `Native CLI not found: ${cliPath}`);

  const discoveryFixtures = FIXTURES.filter((fixture) => fixture.partition === "D7")
    .map((fixture) => inspectFixture(cliPath, replayDir, fixture));
  const discovery = assertPartition("D7", discoveryFixtures, EXPECTED.D7);
  for (const target of TARGETS) {
    assert(discovery.report.inputCodes[target.name][target.missingCode] === 0,
      `D7 unexpectedly contains ${target.name}.`);
    assert(discovery.report.inputCodes[target.name].every((count, code) => code === target.missingCode || count > 0),
      `D7 lacks a non-target near-miss code for ${target.name}.`);
  }
  const witnesses = Object.fromEntries(TARGETS.map((target) => [
    target.name,
    alternativeDecoderWitness(target, discovery.rows),
  ]));

  // H3 remains unopened until D7 has been fully loaded, evaluated,
  // distribution-gated, and used to freeze both alternate witnesses.
  const holdoutFixtures = FIXTURES.filter((fixture) => fixture.partition === "H3")
    .map((fixture) => inspectFixture(cliPath, replayDir, fixture));
  const holdout = assertPartition("H3", holdoutFixtures, EXPECTED.H3);
  const combinedRows = [...discovery.rows, ...holdout.rows];
  const combinedCounts = Object.fromEntries(TARGETS.map((target) => [target.name, codeCounts(combinedRows, target)]));
  assert(discovery.report.allPacketCount + holdout.report.allPacketCount === EXPECTED.combined.allPacketCount,
    "Combined all-packet count drifted.");
  assert(combinedRows.length === EXPECTED.combined.inputCapableCount,
    "Combined input-capable count drifted.");
  for (const target of TARGETS) {
    assert(JSON.stringify(combinedCounts[target.name]) === JSON.stringify(EXPECTED.combined.inputCodes[target.name]),
      `Combined ${target.name} distribution drifted.`);
    assert(holdout.report.inputCodes[target.name][target.missingCode] === 0,
      `H3 unexpectedly contains ${target.name}.`);
    assert(alternativeDecoderWitness(target, holdout.rows).observedPacketDisagreementCount === 0,
      `H3 distinguishes the frozen D7 witness for ${target.name}.`);
  }

  const output = {
    schema: "rofl-inventory-item-id-missing-symbols-16.14-research/v1",
    status: "research-negative-underidentified",
    researchOnly: true,
    promotionGate: false,
    runtimeInput: false,
    clientBinaryInput: false,
    replayOnly: true,
    profile: {
      exactReplayBuild: PROFILE.exactReplayBuild,
      packetType: "0x0369",
      channel: PROFILE.channel,
      participantIdFormula: "blockParam - 0x400000AD",
      minimumInputPayloadLength: PROFILE.minimumInputPayloadLength,
    },
    inputs: {
      replay: "saved .rofl packet bytes only",
      timeline: false,
      match: false,
      dataDragon: false,
      network: false,
      clientOrRiotBinaries: false,
    },
    split: {
      discovery: "D7 is completely loaded, evaluated, distribution-gated, and used to freeze both witnesses before H3 is opened.",
      holdout: "H3 validates the frozen D7 absence and alternate-decoder witnesses without selecting or changing them.",
    },
    exactCounts: {
      D7: discovery.report,
      H3: holdout.report,
      combined: {
        allPacketCount: EXPECTED.combined.allPacketCount,
        inputCapableCount: combinedRows.length,
        inputCodes: combinedCounts,
      },
    },
    fixtures: [...discoveryFixtures, ...holdoutFixtures].map((fixture) => fixture.report),
    alternativeDecoderWitnesses: witnesses,
    negativeControls: {
      allNonTargetCodesObservedInD7: true,
      exactPhysicalAllEqualsChunkPlusKeyframePlusStartup: true,
      exactReplayBuildForEverySegmentScan: true,
      targetOccurrenceCountD7: Object.fromEntries(TARGETS.map((target) => [target.name,
        discovery.report.inputCodes[target.name][target.missingCode]])),
      targetOccurrenceCountH3: Object.fromEntries(TARGETS.map((target) => [target.name,
        holdout.report.inputCodes[target.name][target.missingCode]])),
    },
    conclusion: "Neither missing input code occurs in any of the 3,266 exact-build 0x0369 packets. For each code, two Boolean decoders give opposite numeric output bits while agreeing on all 3,192 input-capable saved packets. The current replay corpus cannot determine either value; future occurrences must remain unavailable until independently anchored.",
  };
  writeJson(path.resolve(args.outputPath), output);
  console.log(`Wrote ${args.outputPath}; packets=${EXPECTED.combined.allPacketCount}; inputCapable=${combinedRows.length}; researchOnly=true.`);
}

main();
