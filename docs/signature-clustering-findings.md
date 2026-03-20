> Note: this is a historical investigation document. For the current decoder state, start with `docs/decoder-status.md` and `docs/reverse-engineering-index.md`.

# Recurring Signature Window Clusters

As a sidecar task, we clustered the recurring signature windows in the non-schema rows (Rows 11+) of `61917 / 0x00`. 
This is a precursor to the native "cleaned-offset probe" that will automatically mask out these windows.

By isolating the 32-bit tokens that consist largely of known family motif bytes (`0xF1`, `0x4B`, `0xDD`, `0xD2`, `0x98`, `0x71`), we can see exactly which offsets in which rows are acting as "noise" (signature-like fields) instead of clean scalar stats.

## Findings from 61917 / 0x00 (Rows 11+)

The clustering script revealed that signature tokens are heavily interspersed throughout the lanes, but they form recurring patterns:

### Motif `F1 4B 71 00` Variants
These tokens appear to be heavily related to the `F1`, `4B`, and `71` archetypes.
*   `0x0200F14B` (Found in Rows 11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35)
*   `0x00F14B71` (Found in Rows 11, 12, 13, 14, 15, 37, 38, 39)
*   `0xF14B7100` (Found in Rows 30, 31, 32, 33, 34, 35, 36, 37, 38)
*   `0x71000200` (Found in almost all rows from 11 to 38)

### Motif `F1 DD 71 00` Variants
These tokens feature `DD` instead of `4B`. (Recall that family `4B` and `DD` both have a capacity of 1808 / `0x710`).
*   `0xF1DD7100` (Found in Rows 11, 12, 13, 14, 15, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35)
*   `0xDD710002` (Found in Rows 11, 12, 13, 14, 15, 38, 39)
*   `0x00F1DD71` (Found in Row 22)

### Motif `98` Variants
Family `39064 / 0x98` heavily cross-references itself in these later rows of `0x00`, confirming its role as a key state table.
*   `0x98985BDB` (Row 11)
*   `0x9898D8F1` (Row 12)
*   `0x9C98D898` (Row 12, 19, 20)
*   `0x98989898` (Rows 24, 29, 30, 31, 32)
*   `0x4D9898D8` (Row 28)

## Conclusion for Native Probing

The clustering proves that the non-schema rows are **not uniform plain structs**. They are heavily salted with these 4-byte signature motifs. 

1.  **Masking is Mandatory:** The native cleaned-offset probe MUST mask out any 4-byte window that exactly matches these high-frequency signatures (`0x0200F14B`, `0xF1DD7100`, `0x71000200`, `0x98989898`, etc.).
2.  **Row Alignment:** The signature distribution is not perfectly aligned by lane across all rows. For example, `0x0200F14B` might be in Lane 0 on Row 11, but Lane 2 on Row 12. This means the engine is packing these arrays dynamically.
3.  **Search the Gaps:** Once these specific 32-bit windows are zeroed out or masked, the remaining unmasked bytes in these rows are our prime candidates for raw `i16`, `u16`, or `f32` scalar stats (like `health`, `xp`, `gold`).
