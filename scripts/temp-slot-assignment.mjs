import fs from "fs";

const match = JSON.parse(fs.readFileSync("./replays/api/EUW1_7779216102/match.json", "utf8"));
const timeline = JSON.parse(fs.readFileSync("./replays/api/EUW1_7779216102/timeline.json", "utf8"));
const scalars = JSON.parse(fs.readFileSync("./replays/61917_scalars.json", "utf8"));

// 1. Extract API participant timelines
const apiParticipants = match.info.participants.map(p => {
  return {
    id: p.participantId,
    champion: p.championName,
    team: p.teamId,
    frames: []
  };
});

for (const frame of timeline.info.frames) {
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

// Stats to check
const metrics = [
  { key: "level", read: f => f.level },
  { key: "currentGold", read: f => f.currentGold },
  { key: "totalGold", read: f => f.totalGold },
  { key: "xp", read: f => f.xp },
  { key: "cs", read: f => f.minionsKilled },
  { key: "jungleCs", read: f => f.jungleMinionsKilled },
  { key: "health", read: f => f.championStats?.health },
  { key: "maxHealth", read: f => f.championStats?.healthMax },
];

function pearson(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const avgX = xs.reduce((a,b)=>a+b,0)/xs.length;
  const avgY = ys.reduce((a,b)=>a+b,0)/ys.length;
  let sumXY=0, sumXX=0, sumYY=0;
  for(let i=0; i<xs.length; i++) {
    const dx = xs[i]-avgX, dy = ys[i]-avgY;
    sumXY += dx*dy; sumXX += dx*dx; sumYY += dy*dy;
  }
  if (sumXX<=0 || sumYY<=0) return 0;
  return sumXY / Math.sqrt(sumXX*sumYY);
}

// 2. Extract replay candidates
const candidates = [];
for (const slot of scalars.slots) {
  for (const lane of slot.lanes) {
    for (const decode of ["u32", "i32", "f32", "u16lo", "u16hi", "i16lo", "i16hi"]) {
      const points = [];
      for (const sample of lane.samples) {
        let val = 0;
        if (decode === "u32") val = sample.u32;
        else if (decode === "i32") val = sample.i32;
        else if (decode === "f32") val = sample.f32;
        else if (decode === "u16lo") val = sample.u32 & 0xFFFF;
        else if (decode === "u16hi") val = (sample.u32 >> 16) & 0xFFFF;
        else if (decode === "i16lo") { const v = sample.u32 & 0xFFFF; val = v >= 0x8000 ? v - 0x10000 : v; }
        else if (decode === "i16hi") { const v = (sample.u32 >> 16) & 0xFFFF; val = v >= 0x8000 ? v - 0x10000 : v; }
        
        if (Number.isFinite(val)) {
          // Assume chunk record time or roughly index
          // But wait, sample.timestampMs doesnt exist in scalar samples! Let me check what properties are available
          points.push({ sampleIndex: points.length, value: val });
        }
      }
      if (points.length > 0) {
        candidates.push({ slot: slot.slotIndex, lane: lane.laneIndex, decode, points });
      }
    }
  }
}

// 3. Instead of timestamp, just match points sequentially to timeline frames (since timeline is 1-minute interval, but chunks are 30s)
// Wait, chunks are roughly 2 per timeline frame. Let us just interpolate or downsample candidates.
// Better: just match the lengths! 
// Let us just output a simple structure.

console.log("Candidate slots: ", [...new Set(candidates.map(c=>c.slot))].join(", "));

