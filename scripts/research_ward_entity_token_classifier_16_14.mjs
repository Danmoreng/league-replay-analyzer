import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Research only. This scans saved .rofl packet framing plus the existing
// replay-only ward decoder; it is never a runtime Ward decoder.
const CLI = path.resolve("build/packages/rofl-core/rofl_core_cli.exe");
const PROFILES = path.resolve("packages/rofl-core/profiles/replay-decoder-profiles.v1.json");
const OUT = path.join("artifacts", "ward-entity-token-classifier-16.14.json");
const D7 = ["EUW1-7919517389", "EUW1-7919624327", "EUW1-7920241664", "EUW1-7920292147", "EUW1-7920341366", "EUW1-7920364492", "EUW1-7920550565"];
const H3 = ["EUW1-7921377760", "EUW1-7921482297", "EUW1-7921996430"];
const BUILD = "16.14.794.5912";
const TOKENS = ["1/0x0023/9", "1/0x021e/8", "1/0x0288/63", "1/0x0378/1", "1/0x0399/21", "1/0x0399/24", "1/0x03e8/3", "1/0x04aa/17"];
const TOKEN_BIT = new Map(TOKENS.map((token, index) => [token, 1 << index]));
const WARD_PROFILE = { origin: "external", schema: "rofl-replay-decoder-profiles/v1", registryId: "league-replay-analyzer-offline-validated", revision: "2026-07-25-cross-patch-cs", fingerprint: "fnv1a64:5cf4895f9e6d3f4c" };
const EXPECTED = Object.freeze({
  discovery: Object.freeze({ exactFramedNonzeroParamBlockCount: 7343781, globalDistinctHandleCount: 108063, provenWardHandleCount: 998 }),
  holdout: Object.freeze({ exactFramedNonzeroParamBlockCount: 3269376, globalDistinctHandleCount: 45283, provenWardHandleCount: 479 }),
  coverageOnlyNegativeControl: Object.freeze({ tp: 998, fp: 218, fn: 0 }),
  holdoutNegativeControl: Object.freeze({ tp: 479, fp: 86, fn: 0 }),
  selectedSubset: Object.freeze({ subsetMask: 65, tokens: Object.freeze(["1/0x0023/9", "1/0x03e8/3"]), tp: 998, fp: 0, fn: 0 }),
  holdoutSubset: Object.freeze({ tp: 479, fp: 0, fn: 0 }),
  temporalOrder: Object.freeze([6, 0]),
});
function fail(m, d) { throw new Error(`${m}${d ? `\n${JSON.stringify(d, null, 2)}` : ""}`); }
function assert(x, m, d) { if (!x) fail(m, d); }
function run(args) { const r = spawnSync(CLI, args, { encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 * 1024 }); if (r.error || r.status !== 0) fail("CLI failed", { args, status: r.status, stderr: r.stderr, error: r.error?.message }); return JSON.parse(r.stdout); }
function rp(id) { return path.join("replays", `${id}.rofl`); }
function loc(b) { return [b.segmentId, b.sourceOffset, b.blockIndex]; }
function cmp(a, b) { for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] - b[i]; return 0; }
function key(b) { return `${b.channel}/0x${b.packetType.toString(16).padStart(4, "0")}/${b.contentLength}`; }
function add(map, k, n = 1) { map.set(k, (map.get(k) ?? 0) + n); }
function sum(rows, f) { return rows.reduce((n, r) => n + f(r), 0); }

function wards(id) {
  const data = run(["--extract-replay-wards-json", rp(id), "--decoder-profiles", PROFILES]);
  assert(data.gameVersion === BUILD && data.source?.runtimeInput === "rofl-only" && data.source?.riotApiInput === false, "Ward input/build gate", { id, data });
  for (const [k, v] of Object.entries(WARD_PROFILE)) assert(data.profile?.[k] === v, "Ward profile provenance gate", { id, k, got: data.profile?.[k] });
  return new Set((data.events ?? []).filter((e) => e.type === "WARD_PLACED" && Number.isInteger(e.wardEntityNetworkId)).map((e) => e.wardEntityNetworkId));
}
function catalog(id) {
  const data = run(["--summarize-packet-types-json", rp(id), "--segment-type", "chunk", "--top-types", "0"]);
  assert(data.valid && data.gameVersion === BUILD && !(data.errors ?? []).length, "Catalog gate", { id, data });
  const allCounts = new Map(), selected = new Set();
  for (const e of data.packetTypes ?? []) {
    allCounts.set(e.packetType, (allCounts.get(e.packetType) ?? 0) + e.count);
    if (e.nonzeroBlockParamCount > 0) selected.add(e.packetType);
  }
  return [...selected].map((packetType) => ({ packetType, count: allCounts.get(packetType) })).sort((a, b) => a.packetType - b.packetType);
}
function scanBatch(id, packetTypes, expectedCounts, state) {
  return new Promise((resolve, reject) => {
    const child = spawn(CLI, ["--dump-packet-types-json", rp(id), ...packetTypes.flatMap((t) => ["--packet-type", String(t)]), "--segment-type", "chunk", "--max-blocks", "0"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "", stderr = "", head = "", tail = ""; const emitted = new Map(), startToken = '{"segmentType":"'; let seen = 0;
    function consume() { while (true) { const start = text.indexOf(startToken); if (start < 0) { text = text.slice(Math.max(0, text.length - startToken.length)); return; } let depth = 0, quote = false, escape = false, end = -1; for (let i = start; i < text.length; i += 1) { const c = text[i]; if (quote) { if (escape) escape = false; else if (c === "\\") escape = true; else if (c === '"') quote = false; continue; } if (c === '"') quote = true; else if (c === '{') depth += 1; else if (c === '}' && --depth === 0) { end = i; break; } } if (end < 0) { text = text.slice(start); return; } const raw = text.slice(start, end + 1); text = text.slice(end + 1); const b = JSON.parse(raw); if (!Number.isInteger(b.blockIndex) || typeof b.contentHex !== "string") continue; add(emitted, b.packetType); if (b.blockParam === 0) continue; seen += 1; let entry = state.get(b.blockParam); if (!entry) { entry = { mask: 0, first: Array(TOKENS.length).fill(null), blockCount: 0 }; state.set(b.blockParam, entry); } entry.blockCount += 1; const bit = TOKEN_BIT.get(key(b)); if (bit !== undefined) { const index = Math.log2(bit); const here = loc(b); if (!entry.first[index] || cmp(here, entry.first[index]) < 0) entry.first[index] = here; entry.mask |= bit; } } }
    child.stdout.setEncoding("utf8"); child.stdout.on("data", (chunk) => { try { if (head.length < 4096) head += chunk.slice(0, 4096 - head.length); tail = (tail + chunk).slice(-4096); text += chunk; consume(); } catch (e) { child.kill(); reject(e); } }); child.stderr.setEncoding("utf8"); child.stderr.on("data", (c) => { stderr += c; }); child.on("error", reject);
    child.on("close", (code) => { try { consume(); if (code !== 0) fail("Batch CLI failed", { id, code, stderr }); assert(head.includes('"valid":true'), "Packet-type dump validity gate failed", { id, packetTypes, head: head.slice(0, 512) }); assert(tail.includes('"errors":[]}'), "Packet-type dump error gate failed", { id, packetTypes, tail }); for (const packetType of packetTypes) assert(emitted.get(packetType) === expectedCounts.get(packetType), "Packet-type dump completeness gate failed", { id, packetType, emitted: emitted.get(packetType) ?? 0, expected: expectedCounts.get(packetType) }); resolve(seen); } catch (e) { reject(e); } });
  });
}
async function scanReplay(id) {
  const state = new Map(), entries = catalog(id), expectedCounts = new Map(entries.map((entry) => [entry.packetType, entry.count])); let batch = [], total = 0, batches = 0, seen = 0;
  async function flush() { if (!batch.length) return; seen += await scanBatch(id, batch, expectedCounts, state); batches += 1; batch = []; total = 0; }
  for (const e of entries) { if (batch.length && total + e.count > 150000) await flush(); batch.push(e.packetType); total += e.count; if (total >= 150000) await flush(); }
  await flush(); return { id, ward: wards(id), state, seen, batches };
}
function has(mask, subset) { return (mask & subset) === subset; }
function metric(replays, subset, order = null) {
  let tp = 0, fp = 0, fn = 0, handles = 0; const orderHits = new Map();
  for (const r of replays) for (const [handle, entry] of r.state) {
    const base = has(entry.mask, subset); let temporal = base;
    if (base && order) { const positions = order.map((index) => entry.first[index]); temporal = positions.every(Boolean) && positions.every((position, i) => i === 0 || cmp(positions[i - 1], position) < 0); }
    if (temporal) { handles += 1; if (r.ward.has(handle)) tp += 1; else fp += 1; } else if (r.ward.has(handle)) fn += 1;
    if (base && r.ward.has(handle)) { const observed = orderFor(entry, subset); add(orderHits, observed); }
  }
  return { subsetMask: subset, tokens: TOKENS.filter((_, i) => subset & (1 << i)), order: order ? order.map((i) => TOKENS[i]) : null, tp, fp, fn, tnUnavailable: true, predictedHandleCount: handles, orderHits: [...orderHits].sort(([a], [b]) => a.localeCompare(b)).map(([orderKey, count]) => ({ orderKey, count })) };
}
function orderFor(entry, subset) { return TOKENS.map((_, i) => i).filter((i) => subset & (1 << i)).sort((a, b) => cmp(entry.first[a], entry.first[b])).join(","); }
function selectD7(replays) {
  const target = sum(replays, (r) => r.ward.size), candidates = [];
  for (let mask = 1; mask < (1 << TOKENS.length); mask += 1) { const m = metric(replays, mask); if (m.tp === target && m.fn === 0) candidates.push(m); }
  candidates.sort((a, b) => a.tokens.length - b.tokens.length || a.fp - b.fp || a.predictedHandleCount - b.predictedHandleCount || a.subsetMask - b.subsetMask);
  const zeroFalsePositiveCandidates = candidates.filter((candidate) => candidate.fp === 0);
  return {
    targetWardCount: target,
    candidates,
    trivialMinimumCoverageCandidate: candidates[0] ?? null,
    zeroFalsePositiveCandidates,
    selected: zeroFalsePositiveCandidates[0] ?? null,
    selectionRule: "Choose the smallest all-Ward subset with zero D7 global false positives within the frozen eight-token candidate set; retain the smallest coverage-only subset separately to expose its false positives.",
  };
}
function freezeOrder(replays, selected) {
  if (!selected) return null; const patterns = new Map();
  for (const r of replays) for (const handle of r.ward) { const entry = r.state.get(handle); if (!entry || !has(entry.mask, selected.subsetMask)) continue; add(patterns, orderFor(entry, selected.subsetMask)); }
  if (patterns.size !== 1) return { exact: false, patterns: [...patterns].map(([key, count]) => ({ key, count })) };
  const key = [...patterns.keys()][0]; return { exact: true, order: key.split(",").map(Number), patterns: [{ key, count: patterns.get(key) }] };
}
function summary(replays) { return { replayCount: replays.length, exactFramedNonzeroParamBlockCount: sum(replays, (r) => r.seen), dumpBatchCount: sum(replays, (r) => r.batches), globalDistinctHandleCount: sum(replays, (r) => r.state.size), provenWardHandleCount: sum(replays, (r) => r.ward.size) }; }
assert(fs.existsSync(CLI) && fs.existsSync(PROFILES), "Missing CLI/profile");
const d7 = []; for (const id of D7) d7.push(await scanReplay(id)); const discoveryPopulation = summary(d7); const selection = selectD7(d7); assert(selection.targetWardCount === 998, "D7 ward count freeze", selection);
for (const [key, value] of Object.entries(EXPECTED.discovery)) assert(discoveryPopulation[key] === value, "D7 population count gate", { key, actual: discoveryPopulation[key], expected: value });
for (const [key, value] of Object.entries(EXPECTED.coverageOnlyNegativeControl)) assert(selection.trivialMinimumCoverageCandidate?.[key] === value, "D7 single-token negative-control gate", { key, actual: selection.trivialMinimumCoverageCandidate?.[key], expected: value });
for (const [key, value] of Object.entries(EXPECTED.selectedSubset)) assert(JSON.stringify(selection.selected?.[key]) === JSON.stringify(value), "D7 frozen-subset gate", { key, actual: selection.selected?.[key], expected: value });
const frozen = Object.freeze({ globalPopulation: "all exact-framed chunk blocks with nonzero framing blockParam", features: TOKENS, candidateSetBoundary: "The eight tokens were frozen from the preceding ward-linked pair-cohort research. This script does not claim an exhaustive search over every framed family/length token.", subset: selection.selected, temporalOrder: freezeOrder(d7, selection.selected), boundary: "D7 selection is structural packet-family membership/order only. It is not a semantic Ward decoder or an entity lifecycle operation grammar." });
assert(frozen.temporalOrder?.exact === true && JSON.stringify(frozen.temporalOrder.order) === JSON.stringify(EXPECTED.temporalOrder), "D7 temporal-order gate", { actual: frozen.temporalOrder, expected: EXPECTED.temporalOrder });
const h3 = []; for (const id of H3) h3.push(await scanReplay(id)); const holdoutPopulation = summary(h3); assert(holdoutPopulation.provenWardHandleCount === 479, "H3 ward count gate", holdoutPopulation);
const holdoutFeature = frozen.subset ? metric(h3, frozen.subset.subsetMask) : null; const holdoutTemporal = frozen.subset && frozen.temporalOrder?.exact ? metric(h3, frozen.subset.subsetMask, frozen.temporalOrder.order) : null;
for (const [key, value] of Object.entries(EXPECTED.holdout)) assert(holdoutPopulation[key] === value, "H3 population count gate", { key, actual: holdoutPopulation[key], expected: value });
for (const [key, value] of Object.entries(EXPECTED.holdoutSubset)) assert(holdoutFeature?.[key] === value && holdoutTemporal?.[key] === value, "H3 frozen-subset gate", { key, feature: holdoutFeature?.[key], temporal: holdoutTemporal?.[key], expected: value });
for (const [key, value] of Object.entries(EXPECTED.holdoutNegativeControl)) assert(metric(h3, 64)?.[key] === value, "H3 single-token negative-control gate", { key, actual: metric(h3, 64)?.[key], expected: value });
const output = { schema: "rofl-ward-entity-token-classifier-research/v1", researchOnly: true, promotionGate: false, runtimeInput: false, runtimeApiData: false, clientBinaryInput: false, sourceInput: "saved-rofl-plus-profiled-replay-only-ward-placement-oracle", sourceBoundary: "WARD_PLACED IDs come from the existing replay-only profile decoder. No Timeline, Match-V5, client binary, process, or runtime product input is read.", profile: { exactReplayBuild: BUILD, d7: D7, h3: H3, wardDecoderProfile: WARD_PROFILE }, pairCohortBoundary: "This audit expands beyond the prior 17-byte 0x0328->0x0170 pair cohort: false positives are measured over all nonzero framing blockParams in all exact-framed chunk packet families.", discoveryPopulation, selection, frozen, holdoutPopulation, holdoutFeature, holdoutTemporal, conclusion: { boundary: "This is a structural classifier checkpoint only. It does not identify a Ward spawn/remove operation, owner, payload grammar, position, vision, or any runtime field." } };
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ out: OUT, d7: { population: discoveryPopulation, selected: selection.selected, temporal: frozen.temporalOrder }, h3: { population: holdoutPopulation, feature: holdoutFeature, temporal: holdoutTemporal } }, null, 2));
