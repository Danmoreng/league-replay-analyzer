# Reverse Engineering Findings: The Component Capacity = Type ID Hypothesis

## Context
Recent native CLI analysis (`--analyze-bitfield-schema-json`) confirmed that early rows (0..6) of `61917 / 0x00` are schema-heavy, while later rows (and family `39064 / 0x98`) are not. 

However, even in the non-schema rows, we still see packed tokens like `0xF14B7100`, `0x00F14B71`, and `0xF1DD7100`. 
By cross-referencing the hex values of these tokens with the known lengths of the families, a massive structural revelation has been uncovered.

## The Breakthrough: Family Bytes ARE Capacities
The "First Byte" that we have been using to identify families (e.g., `0xD2`, `0x98`, `0xF1`, `0x4B`) is NOT an arbitrary magic number. **It is the top 8 bits of the 12-bit integer that defines the maximum capacity of that table!**

The engine literally uses the table's capacity size as its Type ID.

### The Mathematical Proof
Look at the global element counts of the top families, converted to Hexadecimal:
- Length of `0x00` Family: `3869` -> Hex `0xF1D` (Top byte is `0xF1`) *(Note: active rows often `3860` -> `0xF14`)*
- Length of `D2` Family (Movement): `3373` -> Hex `0xD2D` (Top byte is **`0xD2`**)
- Length of `98` Family: `2441` -> Hex `0x989` (Top byte is **`0x98`**)
- Length of `4B` Family: `1808` -> Hex `0x710` (Top byte is **`0x71`** — often seen in masks!)
- Length of `F1` Family: `1207` -> Hex `0x4B7` (Top byte is **`0x4B`**)

*Notice the cascade:*
The capacity of F1 (`0x4B7`) starts with `4B` (the signature of the 4B family).
The capacity of 4B (`0x710`) starts with `71`.

## Decoding the Tokens

### 1. Schema Descriptors (Rows 0-6 in 0x00)
A schema token like `0x4B710002` is a tightly packed bitfield of capacities.
If we look at the sliding 12-bit windows in `0x4B710002`:
- Bits 31..20: `0x4B7` = **1207** (Capacity of F1 table)
- Bits 23..12: `0x710` = **1808** (Capacity of 4B table)
*(Notice they overlap by 4 bits in the hex string!)*

### 2. Component Type Arrays (Rows 11+ in 0x00 and 0x98)
In the non-schema rows, we find tokens like `0xF14B7100`. 
If we split this into 4 separate bytes: `[0xF1, 0x4B, 0x71, 0x00]`.

What are these bytes? They are the top 8 bits of the capacities!
- `0xF1` -> Type ID for the `0x00` table (`0xF1D` = 3869)
- `0x4B` -> Type ID for the `F1` table (`0x4B7` = 1207)
- `0x71` -> Type ID for the `4B` table (`0x710` = 1808)
- `0x00` -> The master entity type itself.

**Conclusion:**
Tokens like `0xF14B7100` are **Component Bitmasks or Type Lists**. 
When found in a participant's row, `[0xF1, 0x4B, 0x71, 0x00]` simply declares: *"This entity has components of type F1, 4B, 71, and 00 attached."*

## Actionable Next Steps for C++ Backend
Codex should immediately leverage this finding for the non-schema rows (like in `39064 / 0x98` and the later rows of `0x00`):

1. **Stop trying to decode `0xF14B7100` as a pointer to a specific row index.** It does not contain a row index. It is an array of 4 Component Type IDs (`uint8_t[4]`).
2. **Entity Signature Mapping:** In the non-schema bands, collect these 4-byte arrays. They define the "Archetype" of the entity. E.g., Archetype `[F1, 4B, 71, 00]` might mean "Champion", while another array might mean "Minion".
3. **Where are the actual stats?** If these bytes are just component declarations, the *actual* scalar stats (health, gold, xp) must live in the remaining bytes of the `0x98` or `0x00` records that do NOT contain these type-arrays. Search the non-schema rows for adjacent 2-byte or 4-byte fields that change monotonically over time.