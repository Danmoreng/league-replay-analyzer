#!/usr/bin/env node

// Offline research only. Candidate packet bytes come exclusively from saved
// ROFL files. The keyframe input uses saved Timeline purchases only to select
// strict labels; no API value is a runtime input or fallback.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILE = Object.freeze({
  exactReplayBuild: "16.14.794.5912",
  championOwnerBase: 0x400000ad,
  addPacketType: 0x0369,
});

const EXPECTED_ROWS = Object.freeze({ discovery: 126, holdout: 55 });
const EXPECTED_RESULTS = Object.freeze({
  familyCount: 43,
  fullDiscoveryFamilyCount: 1,
  fullDiscoveryFamilies: Object.freeze(["type:873"]),
  discoveryCandidateCount: 0,
  exactHoldoutCandidateCount: 0,
});

function parseArgs(argv) {
  const args = {
    cliPath: path.join("build-linux", "packages", "rofl-core", "rofl_core_cli"),
    replayDir: "replays",
    keyframeResearchPath: path.join("tmp", "keyframe-inventory-slots-research-16.14.json"),
    outputPath: path.join("tmp", "inventory-add-slot-companions-research-16.14.json"),
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cli" && argv[index + 1]) args.cliPath = argv[++index];
    else if (argument === "--replay-dir" && argv[index + 1]) args.replayDir = argv[++index];
    else if (argument === "--keyframe-research" && argv[index + 1]) {
      args.keyframeResearchPath = argv[++index];
    } else if (argument === "--output" && argv[index + 1]) args.outputPath = argv[++index];
    else if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: node scripts/research_inventory_add_slot_companions_16_14.mjs [--cli <path>] [--replay-dir <path>] [--keyframe-research <path>] [--output <path>]",
      );
      process.exit(0);
    } else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  return args;
}

function fail(message, detail = undefined) {
  throw new Error(
    `${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`,
  );
}

function payloadBit(payload, bit) {
  return (payload[bit >> 3] >> (bit & 7)) & 1;
}

function readBits(payload, start, length) {
  let value = 0;
  for (let index = 0; index < length; index += 1) {
    value |= payloadBit(payload, start + index) << index;
  }
  return value;
}

function dumpAddWindow(args, row) {
  const timestampMillis = row.addPacket.timestampMillis;
  const replayPath = path.join(args.replayDir, `${row.replayId}.rofl`);
  const blockParam = PROFILE.championOwnerBase + row.participantId;
  const run = spawnSync(
    args.cliPath,
    [
      "--dump-packet-window-json",
      replayPath,
      "--start-ms",
      String(timestampMillis - 1),
      "--end-ms",
      String(timestampMillis + 1),
      "--channel",
      "1",
      "--block-param",
      String(blockParam),
      "--segment-type",
      "chunk",
      "--max-blocks",
      "0",
    ],
    { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) fail("Native add packet-window dump failed.", { replayPath, run });
  const dump = JSON.parse(run.stdout);
  if (
    dump.schema !== "packet-window-dump.v1" ||
    dump.gameVersion !== PROFILE.exactReplayBuild ||
    !dump.valid ||
    dump.errors?.length ||
    dump.truncated ||
    dump.emittedBlockCount !== dump.matchingBlockCount ||
    dump.blockParam !== blockParam
  ) {
    fail("Add packet-window provenance gate failed.", dump);
  }
  const selectedAdd = dump.blocks.filter(
    (block) =>
      block.packetType === PROFILE.addPacketType &&
      block.segmentId === row.addPacket.segmentId &&
      block.sourceOffset === row.addPacket.sourceOffset,
  );
  if (selectedAdd.length !== 1) {
    fail("Strict labelled add is absent or ambiguous in its packet window.", { row, dump });
  }
  return dump.blocks.map((block) => ({
    packetType: block.packetType,
    contentLength: block.contentLength,
    payload: Buffer.from(block.contentHex, "hex"),
  }));
}

function familyKeys(block) {
  return [`type:${block.packetType}`, `typeLength:${block.packetType}:${block.contentLength}`];
}

function blockMatchesFamily(block, family) {
  const [kind, packetType, contentLength] = family
    .split(":")
    .map((value, index) => (index === 0 ? value : Number(value)));
  return (
    block.packetType === packetType &&
    (kind === "type" || (kind === "typeLength" && block.contentLength === contentLength))
  );
}

function selectFamilyBlocks(row, family, selection) {
  const matches = row.blocks.filter((block) => blockMatchesFamily(block, family));
  if (matches.length === 0) return null;
  return selection === "first" ? matches[0] : matches.at(-1);
}

function discoverCandidates(discoveryRows) {
  const families = new Set(discoveryRows.flatMap((row) => row.blocks.flatMap(familyKeys)));
  const candidates = [];
  for (const family of [...families].sort()) {
    for (const selection of ["first", "last"]) {
      const selected = discoveryRows.map((row) => selectFamilyBlocks(row, family, selection));
      if (selected.some((block) => block === null)) continue;
      const contentLength = Math.min(...selected.map((block) => block.payload.length));
      for (let bitLength = 1; bitLength <= 8; bitLength += 1) {
        for (let bitStart = 0; bitStart + bitLength <= contentLength * 8; bitStart += 1) {
          const slotByValue = new Map();
          let conflict = false;
          for (let index = 0; index < discoveryRows.length; index += 1) {
            const value = readBits(selected[index].payload, bitStart, bitLength);
            const slot = discoveryRows[index].slot;
            const previous = slotByValue.get(value);
            if (previous !== undefined && previous !== slot) {
              conflict = true;
              break;
            }
            slotByValue.set(value, slot);
          }
          if (!conflict && new Set(slotByValue.values()).size === 6) {
            candidates.push({
              family,
              selection,
              bitStart,
              bitLength,
              slotByValue: Object.fromEntries([...slotByValue].sort((a, b) => a[0] - b[0])),
            });
          }
        }
      }
    }
  }
  return candidates;
}

function evaluateCandidate(rows, candidate) {
  let available = 0;
  let exact = 0;
  for (const row of rows) {
    const block = selectFamilyBlocks(row, candidate.family, candidate.selection);
    if (block === null) continue;
    available += 1;
    const value = readBits(block.payload, candidate.bitStart, candidate.bitLength);
    if (candidate.slotByValue[String(value)] === row.slot) exact += 1;
  }
  return { rowCount: rows.length, available, exact };
}

function main() {
  const args = parseArgs(process.argv);
  const input = JSON.parse(fs.readFileSync(path.resolve(args.keyframeResearchPath), "utf8"));
  if (
    input.schema !== "rofl-keyframe-inventory-slot-research-16.14/v1" ||
    input.exactReplayBuild !== PROFILE.exactReplayBuild ||
    input.researchOnly !== true ||
    input.promotionGate !== false ||
    !Array.isArray(input.isolatedAddRecordChangeRows)
  ) {
    fail("Unexpected keyframe inventory research input.");
  }
  const labelledRows = input.isolatedAddRecordChangeRows;
  const rowMetrics = {
    discovery: labelledRows.filter((row) => row.partition === "D7").length,
    holdout: labelledRows.filter((row) => row.partition === "H3").length,
  };
  if (JSON.stringify(rowMetrics) !== JSON.stringify(EXPECTED_ROWS)) {
    fail("Frozen strict add/record label count drifted.", { expected: EXPECTED_ROWS, rowMetrics });
  }

  const rows = labelledRows.map((row) => ({ ...row, blocks: dumpAddWindow(args, row) }));
  const discoveryRows = rows.filter((row) => row.partition === "D7");
  const holdoutRows = rows.filter((row) => row.partition === "H3");
  const discoveryCandidates = discoverCandidates(discoveryRows);
  const evaluatedCandidates = discoveryCandidates.map((candidate) => ({
    ...candidate,
    discovery: evaluateCandidate(discoveryRows, candidate),
    holdout: evaluateCandidate(holdoutRows, candidate),
  }));
  const exactHoldoutCandidates = evaluatedCandidates.filter(
    (candidate) =>
      candidate.holdout.available === holdoutRows.length &&
      candidate.holdout.exact === holdoutRows.length,
  );
  const familySupport = Object.entries(
    Object.fromEntries(
      [...new Set(rows.flatMap((row) => row.blocks.flatMap(familyKeys)))].map((family) => [
        family,
        {
          discovery: discoveryRows.filter((row) =>
            row.blocks.some((block) => blockMatchesFamily(block, family)),
          ).length,
          holdout: holdoutRows.filter((row) =>
            row.blocks.some((block) => blockMatchesFamily(block, family)),
          ).length,
        },
      ]),
    ),
  )
    .map(([family, support]) => ({ family, ...support }))
    .sort(
      (left, right) =>
        right.discovery - left.discovery ||
        right.holdout - left.holdout ||
        left.family.localeCompare(right.family),
    );
  const resultMetrics = {
    familyCount: familySupport.length,
    fullDiscoveryFamilyCount: familySupport.filter(
      (family) => family.discovery === discoveryRows.length,
    ).length,
    fullDiscoveryFamilies: familySupport
      .filter((family) => family.discovery === discoveryRows.length)
      .map((family) => family.family),
    discoveryCandidateCount: evaluatedCandidates.length,
    exactHoldoutCandidateCount: exactHoldoutCandidates.length,
  };
  if (JSON.stringify(resultMetrics) !== JSON.stringify(EXPECTED_RESULTS)) {
    fail("Frozen add-slot companion search metrics drifted.", {
      expected: EXPECTED_RESULTS,
      actual: resultMetrics,
    });
  }

  const output = {
    schema: "rofl-inventory-add-slot-companion-research-16.14/v1",
    researchOnly: true,
    runtimeInput: false,
    promotionGate: false,
    exactReplayBuild: PROFILE.exactReplayBuild,
    labelledRows: rowMetrics,
    replayOnlyWindow: {
      segmentType: "chunk",
      channel: 1,
      owner: "0x400000AD + participantId",
      timestampToleranceMillis: 1,
    },
    frozenMetrics: resultMetrics,
    searchBound:
      "Every packet-type family (allowing variable content length) and packet-type/content-length family present in all Discovery windows; first and last occurrence; every contiguous one-to-eight-bit payload field; a conflict-free six-record-ordinal lookup selected on Discovery and evaluated unchanged on Holdout.",
    familySupport,
    discoveryCandidateCount: evaluatedCandidates.length,
    exactHoldoutCandidateCount: exactHoldoutCandidates.length,
    discoveryCandidates: evaluatedCandidates,
    exactHoldoutCandidates,
    nonPromotionReasons: [
      "The labelled ordinal is a proven historical 0x0081 record change, not a physical inventory slot.",
      "Only the variable-length 0x0369 add family itself is present in every Discovery window; no separate same-time companion family has complete support.",
      "Even an exact companion relation would require a complete replay-only reducer and final-inventory validation before product promotion.",
    ],
    conclusion:
      exactHoldoutCandidates.length === 0
        ? "No same-time champion-owned packet companion carries a bounded direct lookup for the strict add/historical-record ordinal labels across Discovery and Holdout. Add placement and physical inventory slots remain unavailable."
        : "At least one bounded same-time companion relation survives the frozen split, but it labels a historical record ordinal only and remains research-only pending semantic state validation.",
  };
  const outputPath = path.resolve(args.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(
    JSON.stringify({
      rowMetrics,
      ...resultMetrics,
    }),
  );
  console.log(`Wrote ${outputPath}`);
}

main();
