> Note: this is a historical investigation document. For the current decoder state, start with `docs/decoder-status.md` and `docs/reverse-engineering-index.md`.

# Layout Hypothesis: EUW1-7779216102.rofl

## Conclusion

The local replay sample does **not** currently validate as a classic 288-byte-header ROFL file in `rofl-core`.

The parser successfully recovers its metadata through a footer-size layout:

- file size: `15,013,275`
- metadata size from final 4 bytes: `109,584`
- metadata offset: `14,903,687`
- metadata source: `footer-size`
- reported format label: `rofl2-like-footer`

## Evidence

The final four bytes of the file are:

```text
10 AC 01 00
```

Interpreted as little-endian `u32`, that is `109,584`.

Using:

```text
metadata_offset = file_size - 4 - metadata_size
```

we get:

```text
14,903,687 = 15,013,275 - 4 - 109,584
```

At that offset, the file contains the embedded JSON metadata block beginning with:

```json
{"gameLength":1895012,...}
```

## Additional Observation

The file still contains a clear version string near the start of the file:

- offset `16`
- ASCII: `16.5.752.7101`

That makes the existing `scan_game_version()` heuristic valid for this sample, but it does **not** imply that the full classic ROFL header layout is present or trustworthy.

## Implication for Parser Work

The parser should:

1. attempt classic header parsing first
2. fall back to footer-size metadata parsing if the classic header layout does not validate
3. treat payload parsing for this sample as unresolved until we identify an equivalent payload index/header structure for this newer container style
