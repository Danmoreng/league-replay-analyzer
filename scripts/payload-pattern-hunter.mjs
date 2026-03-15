#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

/**
 * PAYLOAD PATTERN HUNTER
 * 
 * This script compares chunks that contain specific Riot API events (e.g. kills)
 * against "quiet" chunks to find unique subrecord signatures.
 */

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {
    replay: "",
    event: "CHAMPION_KILL",
    quietChunk: 5, // Default quiet laning chunk
    cliPath: "./build/packages/rofl-core/Debug/rofl_core_cli.exe"
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--replay" && i + 1 < args.length) params.replay = args[++i];
    if (args[i] === "--event" && i + 1 < args.length) params.event = args[++i];
    if (args[i] === "--quiet" && i + 1 < args.length) params.quietChunk = parseInt(args[++i], 10);
  }

  return params;
}

function getSubrecords(cliPath, replayPath, chunkId) {
  try {
    const output = execFileSync(cliPath, ["--dump-chunk-subrecords", replayPath, "--chunk-id", chunkId.toString()], { encoding: "utf8" });
    const records = [];
    const blocks = output.split(/Subrecord #\d+/);
    
    for (const block of blocks) {
      const match = block.match(/Hex: ([0-9A-F ]+)/);
      if (match) {
        const hex = match[1].trim();
        const bytes = hex.split(" ");
        records.push({
          sig: bytes[0],
          size: bytes.length,
          hex: hex
        });
      }
    }
    return records;
  } catch (e) {
    console.error(`Error dumping chunk ${chunkId}:`, e.message);
    return [];
  }
}

function main() {
  const params = parseArgs();
  if (!params.replay) {
    console.error("Usage: node payload-pattern-hunter.mjs --replay <path-to-rofl> [--event CHAMPION_KILL] [--quiet <chunk-id>]");
    process.exit(1);
  }

  const replayPath = resolve(params.replay);
  const matchIdMatch = params.replay.match(/(?:EUW1|NA1|KR|BR1|EUN1|LA1|LA2|OC1|TR1|PH2|SG2|TH2|TW2|VN2)-(\d+)/);
  if (!matchIdMatch) {
    console.error("Could not derive Match ID from replay filename.");
    process.exit(1);
  }
  const matchId = matchIdMatch[0].replace("-", "_");
  const timelinePath = resolve(`./replays/api/${matchId}/timeline.json`);

  if (!existsSync(timelinePath)) {
    console.error(`Riot Timeline not found at ${timelinePath}`);
    process.exit(1);
  }

  const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
  
  // 1. Find chunks containing the target event
  const eventChunks = new Set();
  const eventDetails = [];

  timeline.info.frames.forEach((frame, frameIdx) => {
    frame.events.forEach(event => {
      if (event.type === params.event) {
        // Chunks are 30s long.
        const chunkId = Math.floor(event.timestamp / 30000) + 1;
        eventChunks.add(chunkId);
        eventDetails.push({ chunkId, timestamp: event.timestamp, event });
      }
    });
  });

  console.log(`\nTarget Event: ${params.event}`);
  console.log(`Found ${eventDetails.length} events in chunks: ${Array.from(eventChunks).join(", ")}`);

  // 2. Get "Quiet" baseline
  console.log(`\nAnalyzing Quiet Baseline (Chunk ${params.quietChunk})...`);
  const quietRecords = getSubrecords(params.cliPath, replayPath, params.quietChunk);
  const quietSignatures = new Set(quietRecords.map(r => `${r.sig}:${r.size}`));
  
  console.log(`Quiet baseline has ${quietRecords.length} subrecords with ${quietSignatures.size} unique (sig:size) pairs.`);

  // 3. Analyze eventful chunks for UNIQUE signatures
  console.log(`\nHunting for unique signatures in eventful chunks...\n`);

  const globalCandidates = new Map(); // key -> { chunkIds: Set, totalCount: 0 }

  for (const chunkId of eventChunks) {
    const chunkRecords = getSubrecords(params.cliPath, replayPath, chunkId);
    const uniqueToChunk = chunkRecords.filter(r => !quietSignatures.has(`${r.sig}:${r.size}`));
    
    // Group by signature and size
    const candidates = new Map();
    uniqueToChunk.forEach(r => {
      const key = `${r.sig}:${r.size}`;
      if (!candidates.has(key)) candidates.set(key, { count: 0, examples: [] });
      const entry = candidates.get(key);
      entry.count++;
      if (entry.examples.length < 1) entry.examples.push(r.hex);

      // Global tracking
      if (!globalCandidates.has(key)) globalCandidates.set(key, { chunkIds: new Set(), totalCount: 0, sig: r.sig, size: r.size });
      const g = globalCandidates.get(key);
      g.chunkIds.add(chunkId);
      g.totalCount++;
    });

    const relevantEvents = eventDetails.filter(d => d.chunkId === chunkId);
    console.log(`--- Chunk ${chunkId} (${relevantEvents.length} events) ---`);
    console.log(`Candidate signatures (not in quiet chunk): ${candidates.size}`);

    const sorted = Array.from(candidates.entries()).sort((a, b) => a[1].count - b[1].count);
    sorted.slice(0, 10).forEach(([key, data]) => {
      const [sig, size] = key.split(":");
      const isHot = data.count === relevantEvents.length;
      const marker = isHot ? " [🔥 HOT CANDIDATE]" : "";
      console.log(`  - Sig 0x${sig}, Size ${size}: count=${data.count}${marker}`);
    });
    console.log("");
  }

  console.log("\n=== UNIVERSAL EVENT CANDIDATES ===");
  console.log("Signatures appearing in MANY eventful chunks but ZERO quiet chunks:");
  
  const universal = Array.from(globalCandidates.values())
    .filter(g => g.chunkIds.size > 1)
    .sort((a, b) => b.chunkIds.size - a.chunkIds.size);

  const totalEventCount = eventDetails.length;
  console.log(`Total match-wide ${params.event} count: ${totalEventCount}`);

  universal.forEach(g => {
    const presence = Math.round((g.chunkIds.size / eventChunks.size) * 100);
    const countMatch = g.totalCount === totalEventCount;
    const countNearMatch = Math.abs(g.totalCount - totalEventCount) < (totalEventCount * 0.1);
    const marker = countMatch ? " [🔥🔥 TOTAL MATCH]" : (countNearMatch ? " [🔥 NEAR TOTAL MATCH]" : "");
    
    console.log(`- Sig 0x${g.sig}, Size ${g.size}: Present in ${g.chunkIds.size}/${eventChunks.size} chunks (${presence}%) | Total: ${g.totalCount}${marker}`);
  });
}

main();
