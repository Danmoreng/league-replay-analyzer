import fs from "fs";

function clusterSignatures(filePath, familyDesc, startRow) {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return;
    }

    const txt = fs.readFileSync(filePath, "utf8");
    // Handle potential BOM
    const data = JSON.parse(txt.charCodeAt(0) === 0xFEFF ? txt.slice(1) : txt);

    console.log(`\n=== Clustering Signatures for ${familyDesc} ===`);

    const knownFamilies = new Set([0x00, 0x4B, 0xF1, 0xDD, 0x98, 0xD2, 0xD6, 0x71]);

    // Map: Row -> Offset(Lane) -> Set of Signature Tokens
    const rowOffsetSignatures = new Map();

    for (const slot of data.slots || []) {
        const rowId = slot.slotIndex;
        if (rowId < startRow) continue; // Skip schema rows

        for (const lane of slot.lanes || []) {
            const laneId = lane.laneIndex;
            
            for (const sample of lane.samples || []) {
                const u32 = sample.rawU32 !== undefined ? sample.rawU32 : sample.u32;
                if (!u32) continue;

                const hex = "0x" + u32.toString(16).toUpperCase().padStart(8, "0");
                const b0 = u32 & 0xFF;
                const b1 = (u32 >>> 8) & 0xFF;
                const b2 = (u32 >>> 16) & 0xFF;
                const b3 = (u32 >>> 24) & 0xFF;

                let knownCount = 0;
                if (knownFamilies.has(b0)) knownCount++;
                if (knownFamilies.has(b1)) knownCount++;
                if (knownFamilies.has(b2)) knownCount++;
                if (knownFamilies.has(b3)) knownCount++;

                // A signature token is one that is largely composed of known family motif bytes
                if (knownCount >= 2) {
                    if (!rowOffsetSignatures.has(rowId)) {
                        rowOffsetSignatures.set(rowId, new Map());
                    }
                    if (!rowOffsetSignatures.get(rowId).has(laneId)) {
                        rowOffsetSignatures.get(rowId).set(laneId, new Map());
                    }
                    
                    const tokenMap = rowOffsetSignatures.get(rowId).get(laneId);
                    tokenMap.set(hex, (tokenMap.get(hex) || 0) + 1);
                }
            }
        }
    }

    let totalSignaturesFound = 0;

    // Print the clusters
    for (const [rowId, offsets] of Array.from(rowOffsetSignatures.entries()).sort((a, b) => a[0] - b[0])) {
        console.log(`\nRow ${rowId}:`);
        for (const [laneId, tokens] of Array.from(offsets.entries()).sort((a, b) => a[0] - b[0])) {
            const sortedTokens = Array.from(tokens.entries()).sort((a, b) => b[1] - a[1]);
            const displayTokens = sortedTokens.map(t => `${t[0]} (${t[1]}x)`).join(", ");
            console.log(`  Lane/Offset ${laneId} -> Signatures: ${displayTokens}`);
            totalSignaturesFound += sortedTokens.length;
        }
    }

    if (totalSignaturesFound === 0) {
        console.log("No signature-like tokens found in the target rows.");
    }
}

// We run it on the existing scalar dumps to prototype the clustering 
// before Codex finishes the new dedicated probe.
clusterSignatures("./replays/61917_scalars.json", "61917 / 0x00 (Rows 11+)", 11);

// Note: If you want to run it on 0x98, you would generate a 39064_scalars.json dump first.

