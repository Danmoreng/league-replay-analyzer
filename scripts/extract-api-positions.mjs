import { readFileSync, writeFileSync } from "node:fs";

const timeline = JSON.parse(readFileSync("replays/api/EUW1_7779216102/timeline.json", "utf8"));
const frames = timeline.info.frames;

const positions = [];

for (const frame of frames) {
  const timestamp = frame.timestamp;
  const participantFrames = frame.participantFrames;
  
  for (const [id, pf] of Object.entries(participantFrames)) {
    const participantId = parseInt(id);
    if (!positions[participantId]) {
      positions[participantId] = { participantId, positions: [] };
    }
    
    if (pf.position) {
      positions[participantId].positions.push({
        timestamp,
        x: pf.position.x,
        y: pf.position.y
      });
    }
  }
}

writeFileSync("apps/web/public/api-positions.json", JSON.stringify(positions.filter(Boolean), null, 2));
