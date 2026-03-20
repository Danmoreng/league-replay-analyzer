export interface RawToken {
  tokenHex: string;
  tokenU32: number;
  sourceFamilyLength?: number;
  sourceFirstByte?: number;
  slot?: number;
  offset?: number;
}

export interface BitSlice {
  label: string;
  startBit: number; // 0-indexed from right
  endBit: number;   // inclusive
  value: number;
  hex: string;
  matchType?: string;
  matchDesc?: string;
}

export const KNOWN_FAMILIES: Record<number, { count: number; name: string }> = {
  0x00: { count: 3869, name: "Entity/Stats (0x00)" },
  0x4B: { count: 1808, name: "Component 4B" },
  0xF1: { count: 1207, name: "Component F1" },
  0x98: { count: 2441, name: "Component 98" },
  0xD2: { count: 3373, name: "Movement (0xD2)" },
  0xDD: { count: 1808, name: "Component DD" },
};

export const KNOWN_COUNTS: Record<number, number[]> = {
  1207: [0xF1],
  1808: [0x4B, 0xDD],
  2441: [0x98],
  3373: [0xD2],
  3869: [0x00],
  3860: [0x00], // Sometimes slightly less active rows
};

export function extractSlice(u32: number, startBit: number, numBits: number): number {
  return (u32 >>> startBit) & ((1 << numBits) - 1);
}

export function analyzeToken(token: RawToken): BitSlice[] {
  const slices: BitSlice[] = [];
  const u32 = token.tokenU32;

  // 1. Bytes
  for (let i = 0; i < 4; i++) {
    const val = extractSlice(u32, i * 8, 8);
    const hex = `0x${val.toString(16).toUpperCase().padStart(2, "0")}`;
    let matchDesc;
    if (KNOWN_FAMILIES[val]) {
      matchDesc = `Known Family: ${KNOWN_FAMILIES[val].name}`;
    }
    slices.push({
      label: `Byte ${i}`,
      startBit: i * 8,
      endBit: i * 8 + 7,
      value: val,
      hex,
      matchType: matchDesc ? "family" : undefined,
      matchDesc,
    });
  }

  // 2. 16-bit halves
  for (let i = 0; i < 2; i++) {
    const val = extractSlice(u32, i * 16, 16);
    const hex = `0x${val.toString(16).toUpperCase().padStart(4, "0")}`;
    slices.push({
      label: i === 0 ? "Lower 16-bit" : "Upper 16-bit",
      startBit: i * 16,
      endBit: i * 16 + 15,
      value: val,
      hex,
    });
  }

  // 3. Overlapping 12-bit windows
  // shifts: 20 (bits 31..20), 16 (27..16), 12 (23..12), 8 (19..8), 4 (15..4), 0 (11..0)
  const shifts = [20, 16, 12, 8, 4, 0];
  for (const shift of shifts) {
    const val = extractSlice(u32, shift, 12);
    const hex = `0x${val.toString(16).toUpperCase().padStart(3, "0")}`;
    let matchDesc;
    if (KNOWN_COUNTS[val]) {
      const fams = KNOWN_COUNTS[val].map(f => `0x${f.toString(16).toUpperCase()}`).join(" or ");
      matchDesc = `Capacity Hit: ${val} (matches ${fams})`;
    }

    slices.push({
      label: `12-bit [${shift + 11}..${shift}]`,
      startBit: shift,
      endBit: shift + 11,
      value: val,
      hex,
      matchType: matchDesc ? "capacity" : undefined,
      matchDesc,
    });
  }

  return slices;
}

