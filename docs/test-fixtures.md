# Synthetic Test Fixtures

These hex patterns can be used to verify the `rofl-core` container parser without needing massive replay files.

## 1. Classic ROFL Mock (Binary Header)

A minimal file that satisfies the `parse_known_binary_header` check.

```hex
# Offset 0: Magic
52 49 4F 54  # "RIOT"
02 00        # Signature Type

# [256 bytes of signature noise] ...

# Offset 262: Header Length (288 = 0x0120)
20 01

# Offset 264: File Size (e.g., 1024 bytes)
00 04 00 00

# Offset 268: Metadata Offset (e.g., 288)
20 01 00 00

# Offset 272: Metadata Length (e.g., 50 bytes)
32 00 00 00

# Offset 276: Payload Header Offset (e.g., 338)
52 01 00 00

# Offset 280: Payload Header Length (e.g., 66 bytes)
42 00 00 00

# Offset 284: Payload Offset (Segment Table Start - e.g., 404)
94 01 00 00
```

## 2. ROFL2 / Footer Mock

A file that fails the header check but has a valid footer.

```hex
# Offset 0: Magic
52 49 4F 54

# [Arbitrary data] ...

# Footer (Last 4 bytes): Length of JSON Metadata
# If JSON is {"gameVersion":"14.11"}, length is 25 (0x19)
19 00 00 00
```

## 3. Segment Table Entry Mock (17 bytes)

```hex
# Offset 0: ID (1)
01 00 00 00

# Offset 4: Type (1 = Chunk)
01

# Offset 5: Data Length (100 bytes)
64 00 00 00

# Offset 9: Chunk ID (0 for chunks)
00 00 00 00

# Offset 13: Data Offset (0 relative)
00 00 00 00
```

## 4. Parser Stress Tests

- **Corrupt Metadata Length:** Set Metadata Length to a value larger than the file size.
- **Missing RIOT Magic:** Change first 4 bytes to `00 00 00 00`.
- **Zero Segments:** Set `chunk_count` and `keyframe_count` to 0 in Payload Header.
