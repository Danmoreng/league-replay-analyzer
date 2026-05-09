import fs from "fs";

const matchFile = "./replays/api/EUW1_7779216102/match.json";
const timelineFile = "./replays/api/EUW1_7779216102/timeline.json";
const matchData = JSON.parse(fs.readFileSync(matchFile, "utf8"));
const timelineData = JSON.parse(fs.readFileSync(timelineFile, "utf8"));

const apiParticipants = matchData.info.participants.map(p => ({
    id: p.participantId,
    champion: p.championName,
    frames: []
}));

for (const frame of timelineData.info.frames) {
    for (const [idStr, pFrame] of Object.entries(frame.participantFrames)) {
        const pId = parseInt(idStr, 10);
        const apiP = apiParticipants.find(p => p.id === pId);
        if (apiP) {
            apiP.frames.push({
                timestamp: frame.timestamp,
                ...pFrame
            });
        }
    }
}

const metrics = [
    { key: "health", read: f => f.championStats ? f.championStats.health : 0 },
    { key: "healthMax", read: f => f.championStats ? f.championStats.healthMax : 0 },
    { key: "cs", read: f => f.minionsKilled + f.jungleMinionsKilled }
];

function pearson(xs, ys) {
    if (xs.length !== ys.length || xs.length < 2) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
    const n = xs.length;
    for (let i = 0; i < n; i++) {
        sumX += xs[i];
        sumY += ys[i];
        sumXY += xs[i] * ys[i];
        sumX2 += xs[i] * xs[i];
        sumY2 += ys[i] * ys[i];
    }
    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    return den === 0 ? 0 : num / den;
}

const replayFile = "./replays/61917_scalars.json";
const txt = fs.readFileSync(replayFile, "utf8");
const data = JSON.parse(txt.charCodeAt(0) === 0xFEFF ? txt.slice(1) : txt);

const signatures = new Set([
    0x0200F14B, 0x00F14B71, 0xF14B7100, 0x71000200, 
    0xF1DD7100, 0xDD710002, 0x00F1DD71, 0x000200F1,
    0x98985BDB, 0x9898D8F1, 0x9C98D898, 0x98989898, 0x4D9898D8,
    0xDD714000, 0x0400914B, 0x0300B14B, 0x4B710002
]);

function isSignature(u32) {
    return signatures.has(u32);
}

const topMatches = [];

for (const slot of data.slots || []) {
    if (slot.slotIndex < 11) continue;

    for (const lane of slot.lanes || []) {
        const validSamples = [];
        let dropped = 0;

        for (const sample of lane.samples || []) {
            const u32 = sample.rawU32 !== undefined ? sample.rawU32 : sample.u32;
            if (u32 === undefined || u32 === 0) {
                 validSamples.push(null);
                 continue;
            }
            if (isSignature(u32)) {
                dropped++;
                validSamples.push(null);
            } else {
                validSamples.push(sample);
            }
        }

        if (dropped > validSamples.length * 0.5) continue;

        const decodings = ["u32", "f32", "u16lo", "u16hi", "u8_0", "u8_1", "u8_2", "u8_3"];
        for (const dec of decodings) {
            const series = [];
            for (const s of validSamples) {
                if (!s) { series.push(0); continue; }
                const u32 = s.rawU32 !== undefined ? s.rawU32 : s.u32;
                if (dec === "u32") series.push(u32);
                else if (dec === "f32") {
                    const buf = new ArrayBuffer(4);
                    new DataView(buf).setUint32(0, u32, true);
                    const f = new DataView(buf).getFloat32(0, true);
                    series.push(Number.isFinite(f) ? f : 0);
                }
                else if (dec === "u16lo") series.push(u32 & 0xFFFF);
                else if (dec === "u16hi") series.push((u32 >>> 16) & 0xFFFF);
                else if (dec === "u8_0") series.push(u32 & 0xFF);
                else if (dec === "u8_1") series.push((u32 >>> 8) & 0xFF);
                else if (dec === "u8_2") series.push((u32 >>> 16) & 0xFF);
                else if (dec === "u8_3") series.push((u32 >>> 24) & 0xFF);
            }

            for (const p of apiParticipants) {
                const targetLen = p.frames.length;
                if (targetLen < 5 || series.length < 5) continue;
                
                const downsampled = [];
                for (let i=0; i<targetLen; i++) {
                    const idx = Math.floor((i / targetLen) * series.length);
                    downsampled.push(series[idx] || 0);
                }

                for (const m of metrics) {
                    const apiSeries = p.frames.map(m.read);
                    const corr = pearson(downsampled, apiSeries);
                    
                    if (Math.abs(corr) > 0.6) {
                        topMatches.push({
                            slot: slot.slotIndex,
                            lane: lane.laneIndex,
                            decode: dec,
                            champion: p.champion,
                            metric: m.key,
                            corr: corr
                        });
                    }
                }
            }
        }
    }
}

topMatches.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
console.log("=== Top Cleaned Offset Correlations ===");
console.table(topMatches.slice(0, 25));

