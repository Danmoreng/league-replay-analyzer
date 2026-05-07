import fs from "fs";

const filepath = "./replays/61917_scalars.json";
const txt = fs.readFileSync(filepath, "utf8");
const data = JSON.parse(txt);

const knownFamilies = new Set([0x4b, 0xf1, 0xdd, 0x98, 0xd2, 0xd6, 0x00]);

const u32Tokens = new Set();
for (const slot of data.slots) {
  for (const lane of slot.lanes) {
    for (const sample of lane.samples) {
      if (sample.rawU32 !== undefined && sample.rawU32 !== 0) {
        u32Tokens.add(sample.rawU32);
      }
    }
  }
}

console.log(`Found ${u32Tokens.size} unique non-zero u32 tokens.`);

const byteStats = [new Map(), new Map(), new Map(), new Map()];

for (const val of u32Tokens) {
  const b0 = val & 0xff;
  const b1 = (val >> 8) & 0xff;
  const b2 = (val >> 16) & 0xff;
  const b3 = (val >>> 24) & 0xff;

  byteStats[0].set(b0, (byteStats[0].get(b0) || 0) + 1);
  byteStats[1].set(b1, (byteStats[1].get(b1) || 0) + 1);
  byteStats[2].set(b2, (byteStats[2].get(b2) || 0) + 1);
  byteStats[3].set(b3, (byteStats[3].get(b3) || 0) + 1);
}

function printStats(name, stats) {
  console.log(`\n--- ${name} ---`);
  const sorted = [...stats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [byte, count] of sorted) {
    const hex = byte.toString(16).toUpperCase().padStart(2, "0");
    const isFamily = knownFamilies.has(byte) ? " <-- KNOWN FAMILY" : "";
    console.log(`0x${hex} (${byte}): ${count} occurrences ${isFamily}`);
  }
}

printStats("Byte 0 (Lowest, mask 0x000000FF)", byteStats[0]);
printStats("Byte 1 (mask 0x0000FF00)", byteStats[1]);
printStats("Byte 2 (mask 0x00FF0000)", byteStats[2]);
printStats("Byte 3 (Highest, mask 0xFF000000)", byteStats[3]);

console.log("\n--- Example Tokens ---");
let examplesPrinted = 0;
for (const val of u32Tokens) {
  const b0 = val & 0xff;
  const b1 = (val >> 8) & 0xff;
  const b2 = (val >> 16) & 0xff;
  const b3 = (val >>> 24) & 0xff;
  
  if (b1 === 0xf1 || b1 === 0x4b || b1 === 0xdd || b2 === 0xf1 || b2 === 0x4b || b2 === 0xdd || b3 === 0xf1 || b3 === 0x4b || b3 === 0xdd) {
    console.log(`0x${val.toString(16).toUpperCase().padStart(8, "0")} -> [0x${b3.toString(16).toUpperCase().padStart(2,"0")}, 0x${b2.toString(16).toUpperCase().padStart(2,"0")}, 0x${b1.toString(16).toUpperCase().padStart(2,"0")}, 0x${b0.toString(16).toUpperCase().padStart(2,"0")}]`);
    examplesPrinted++;
    if (examplesPrinted >= 20) break;
  }
}

