# Reverse Engineering Findings: The Bitfield Packing and Archetype Signature Hypothesis

## Context
Recent native CLI analysis (`--analyze-bitfield-schema-json`) confirmed that early rows (0..6) of `61917 / 0x00`, `28928 / 0x4B`, and `19313 / 0xF1` are schema-heavy, while later rows (and family `39064 / 0x98` entirely) are not. 

However, even in the non-schema rows, we still see packed tokens like `0xF14B7100`, `0x00F14B71`, and `0xF1DD7100`. 
By cross-referencing the hex values of these tokens with the known lengths of the families, a structural correlation has been uncovered.

## The Correlation Between Motifs and Capacities
There is a strong correlation between recurring byte motifs (the "First Byte" we use to identify families like `0xD2`, `0x98`, `0xF1`, `0x4B`) and the high 8 bits of the 12-bit capacities of those tables.

### The Mathematical Evidence
Look at the global element counts of the top families, converted to Hexadecimal:
- Length of `0x00` Family: `3869` -> Hex `0xF1D` (Top byte is `0xF1`) *(Note: active rows often `3860` -> `0xF14`)*
- Length of `D2` Family (Movement): `3373` -> Hex `0xD2D` (Top byte is `0xD2`)
- Length of `98` Family: `2441` -> Hex `0x989` (Top byte is `0x98`)
- Length of `4B` Family: `1808` -> Hex `0x710` (Top byte is `0x71` — often seen in masks!)
- Length of `F1` Family: `1207` -> Hex `0x4B7` (Top byte is `0x4B`)

## Decoding the Tokens

### 1. Schema Descriptors (Early Rows in 0x00, 0x4B, 0xF1)
A schema token like `0x4B710002` acts as a packed descriptor that aligns exactly with these 12-bit capacities.
If we look at the sliding 12-bit windows in `0x4B710002`:
- Bits 31..20: `0x4B7` = **1207** (Capacity of F1 table)
- Bits 23..12: `0x710` = **1808** (Capacity of 4B table)
*(Notice they overlap by 4 bits in the hex string)*

### 2. Archetype Tags / Signature-Like Fields (Non-Schema Rows, e.g., 0x98)
In the non-schema rows, we find tokens like `0xF14B7100`. 
If we split this into 4 separate bytes: `[0xF1, 0x4B, 0x71, 0x00]`.

These bytes map to the top 8 bits of the known capacities. While it is tempting to declare these as explicit "Component Bitmasks", the more defensible hypothesis right now is that these are **opaque signature-like fields or archetype tags**. 

**Conclusion:**
Tokens like `0xF14B7100`, `0x00F1DD71`, and `0x000200F1` **are not simple row pointers**. They are signature or schema descriptors.

## Actionable Next Steps for C++ Backend
The backend strategy should align around these non-pointer motifs:

1. **Stop treating `0xF14B7100`-style values as direct row handles.**
2. **Treat recurring 4-byte motifs as signature-like fields:** We should not yet hard-code them as semantic component lists, but we can safely cluster rows based on these signature patterns.
3. **Exclude from Scalar Probing:** Exclude these specific 32-bit windows from any scalar analysis since we know they are not stats.
4. **Probe Remaining Offsets:** Now that we can partition rows and exclude the signature bytes, probe the *remaining* offsets in non-schema rows (especially the `39064 / 0x98` slab) for the actual plain scalar fields (gold, health, xp) using packed subfield decoding (nibbles, masked bytes).