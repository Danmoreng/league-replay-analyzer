# ROFL2 Reverse Engineering Findings

This document summarizes the technical findings regarding the League of Legends ROFL2 replay format, specifically focusing on the "Sparse Record" families found in footer-style chunk payloads.

## 1. Timeline of Analyzed Versions

| Game Version | Record Size | Padding Byte | Header Size | Est. Element Count |
| :--- | :--- | :--- | :--- | :--- |
| **15.22** | N/A | N/A | N/A | 0 (Pattern not present) |
| **15.23** | 43,176 | `0xA8` | 8? | ~2,698 |
| **15.24** | 65,278 | `0xFE` | 14? | ~4,079 |
| **16.1** | 49,858 | `0xC2` | 2 | 3,116 |
| **16.5** | 53,970 | `0xD2` | 2 | 3,373 |

## 2. Key Technical Insights

### The "Padding" Mechanism
A major breakthrough was identifying the origin of the repeating "filler" bytes. 
*   **Finding:** The filler byte is always equal to the low byte of the record's length (`length & 0xFF`).
*   **Inference:** The game engine likely performs a `memset(buffer, length & 0xFF, length)` to initialize a fixed-size memory block before writing data into it. This explains why records appear to "start with their own length."

### Data Layout: The 16-Byte Stride
Regardless of the version-specific padding or total size, the internal data consistently aligns to a **16-byte stride**.
*   **Alignment:** Elements begin immediately after the length header (usually 2 bytes, but varies in 15.2x).
*   **Significance:** This 16-byte block likely represents a C++ struct or class instance used for game state (e.g., entity metadata, pathing nodes, or player-specific data).

### Element Activity Patterns
Analysis of the 16.5 records (53,970 bytes) revealed:
*   **Top Active Elements:** Elements at indices #0, #1, #2, #3, and #17 are active in almost every record.
*   **Signature Bytes:** Active elements frequently start with specific bytes (e.g., `0xD6` in version 16.5), which may act as a bitmask or type identifier for the element.
*   **ID Stability:** The first 4 bytes (U32) of active elements often remain constant across multiple records, suggesting they are persistent IDs or headers.

## 3. Tooling Progress

We have enhanced the `rofl_core_cli` with a new `--guess-stride` command that automates:
1.  **Padding Detection:** Automatically identifies the version-specific filler byte.
2.  **Density Analysis:** Calculates min/max/avg "active" data density per record.
3.  **Stride Validation:** Checks the distribution of non-padding bytes against common stride lengths (4, 8, 16, 32).
4.  **Stability Mapping:** Tracks the persistence of U32 values at specific element offsets.

## 4. Next Steps for Decoding

*   **Entropy Analysis:** Map which bytes within the 16-byte stride change most frequently (potential coordinates vs. stable bitmasks).
*   **Element Correlation:** Compare active element indices with player counts (10 players vs. 3,373 elements suggests these are not just player objects, but likely minions, missiles, or world nodes).
*   **Coordinate Extraction:** Search for floating-point pairs within active 16-byte blocks to identify map positions.
