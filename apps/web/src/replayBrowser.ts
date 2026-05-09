import type { ReplaySegmentSummary, ReplaySummary } from "./replayParser";

export interface ReplayBrowserStat {
  label: string;
  value: string;
}

export interface ReplayBrowserRegion {
  id: string;
  label: string;
  detail: string;
  start: number;
  length: number;
  end: number;
  kind: "payload" | "segment-header" | "metadata" | "footer" | "gap";
}

export interface ReplayBrowserHeaderField {
  label: string;
  value: string;
}

export interface ReplayBrowserSegment {
  key: string;
  order: number;
  id: number;
  type: string;
  chunkId: number;
  codec: string;
  compressedLength: number;
  uncompressedLength: number;
  compressionRatio: number | null;
  headerOffset: number;
  payloadOffset: number;
  endOffset: number;
  gapToNext: number | null;
  headerHex: string;
  payloadHex: string;
  payloadAscii: string;
  payloadMagic: string;
  headerFields: ReplayBrowserHeaderField[];
}

export interface ReplayBrowserModel {
  fileStats: ReplayBrowserStat[];
  segmentStats: ReplayBrowserStat[];
  regions: ReplayBrowserRegion[];
  segments: ReplayBrowserSegment[];
  metadataPreview: string;
  segmentTypes: string[];
}

const footerRecordHeaderLength = 17;
const footerLengthFieldSize = 4;
const previewByteCount = 32;

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  return `${(kib / 1024).toFixed(2)} MiB`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).toUpperCase().padStart(2, "0"))
    .join(" ");
}

function bytesToAscii(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : "."))
    .join("");
}

function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset < 0 || offset + 4 > bytes.length) {
    return null;
  }

  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  );
}

function buildFooterHeaderFields(
  bytes: Uint8Array,
  segment: ReplaySegmentSummary,
): ReplayBrowserHeaderField[] {
  const headerOffset = segment.headerOffset;
  const kind = bytes[headerOffset + 8] ?? 0;

  return [
    { label: "Record ID", value: String(bytes[headerOffset] ?? segment.id) },
    { label: "Related Chunk", value: String(bytes[headerOffset + 4] ?? segment.chunkId) },
    { label: "Kind Byte", value: `0x${kind.toString(16).toUpperCase().padStart(2, "0")}` },
    {
      label: "Uncompressed Length",
      value: formatNumber(readU32LE(bytes, headerOffset + 9) ?? segment.uncompressedLength),
    },
    {
      label: "Compressed Length",
      value: formatNumber(readU32LE(bytes, headerOffset + 13) ?? segment.length),
    },
  ];
}

function buildClassicHeaderFields(
  bytes: Uint8Array,
  segment: ReplaySegmentSummary,
): ReplayBrowserHeaderField[] {
  const headerOffset = segment.headerOffset;
  const typeByte = bytes[headerOffset + 4] ?? 0;

  return [
    { label: "Segment ID", value: formatNumber(readU32LE(bytes, headerOffset) ?? segment.id) },
    { label: "Type Byte", value: `0x${typeByte.toString(16).toUpperCase().padStart(2, "0")}` },
    {
      label: "Encrypted Length",
      value: formatNumber(readU32LE(bytes, headerOffset + 5) ?? segment.length),
    },
    {
      label: "Chunk ID",
      value: formatNumber(readU32LE(bytes, headerOffset + 9) ?? segment.chunkId),
    },
    {
      label: "Data Offset",
      value: formatNumber(readU32LE(bytes, headerOffset + 13) ?? segment.offset),
    },
  ];
}

function buildSegment(
  bytes: Uint8Array,
  segment: ReplaySegmentSummary,
  nextSegment: ReplaySegmentSummary | undefined,
  order: number,
  format: string,
): ReplayBrowserSegment {
  const headerBytes = bytes.slice(
    segment.headerOffset,
    segment.headerOffset + footerRecordHeaderLength,
  );
  const payloadBytes = bytes.slice(
    segment.payloadOffset,
    Math.min(segment.payloadOffset + previewByteCount, bytes.length),
  );
  const payloadEnd = Math.min(segment.payloadOffset + segment.length, bytes.length);
  const nextHeaderOffset = nextSegment?.headerOffset ?? null;

  return {
    key: `${segment.type}-${segment.id}-${segment.headerOffset}`,
    order,
    id: segment.id,
    type: segment.type,
    chunkId: segment.chunkId,
    codec: segment.codec || "unknown",
    compressedLength: segment.length,
    uncompressedLength: segment.uncompressedLength,
    compressionRatio:
      segment.length > 0 && segment.uncompressedLength > 0
        ? segment.uncompressedLength / segment.length
        : null,
    headerOffset: segment.headerOffset,
    payloadOffset: segment.payloadOffset,
    endOffset: payloadEnd,
    gapToNext: nextHeaderOffset !== null ? Math.max(0, nextHeaderOffset - payloadEnd) : null,
    headerHex: bytesToHex(headerBytes),
    payloadHex: bytesToHex(payloadBytes),
    payloadAscii: bytesToAscii(payloadBytes),
    payloadMagic: bytesToHex(payloadBytes.slice(0, 4)),
    headerFields:
      format === "classic-rofl"
        ? buildClassicHeaderFields(bytes, segment)
        : buildFooterHeaderFields(bytes, segment),
  };
}

export function buildReplayBrowserModel(
  bytes: Uint8Array,
  summary: ReplaySummary,
): ReplayBrowserModel {
  const segments = summary.container.segments.map((segment, index, items) =>
    buildSegment(bytes, segment, items[index + 1], index, summary.container.format),
  );

  const regions: ReplayBrowserRegion[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.headerOffset > cursor) {
      regions.push({
        id: `gap-${cursor}`,
        label: "Gap",
        detail: `${formatNumber(segment.headerOffset - cursor)} bytes`,
        start: cursor,
        length: segment.headerOffset - cursor,
        end: segment.headerOffset,
        kind: "gap",
      });
    }

    regions.push({
      id: `header-${segment.key}`,
      label: `${segment.type} header`,
      detail: `record ${segment.id}`,
      start: segment.headerOffset,
      length: footerRecordHeaderLength,
      end: segment.headerOffset + footerRecordHeaderLength,
      kind: "segment-header",
    });
    regions.push({
      id: `payload-${segment.key}`,
      label: `${segment.type} payload`,
      detail: `${formatNumber(segment.compressedLength)} bytes`,
      start: segment.payloadOffset,
      length: segment.compressedLength,
      end: segment.payloadOffset + segment.compressedLength,
      kind: "payload",
    });
    cursor = Math.max(cursor, segment.endOffset);
  }

  const metadataStart = summary.container.metadataOffset;
  const metadataLength = summary.container.metadataSize;
  if (metadataStart > cursor) {
    regions.push({
      id: `gap-${cursor}-metadata`,
      label: "Gap",
      detail: `${formatNumber(metadataStart - cursor)} bytes`,
      start: cursor,
      length: metadataStart - cursor,
      end: metadataStart,
      kind: "gap",
    });
  }
  if (metadataLength > 0) {
    regions.push({
      id: "metadata",
      label: "Metadata JSON",
      detail: `${formatNumber(metadataLength)} bytes`,
      start: metadataStart,
      length: metadataLength,
      end: metadataStart + metadataLength,
      kind: "metadata",
    });
  }
  if (summary.container.metadataSource === "footer-size" && bytes.length >= footerLengthFieldSize) {
    regions.push({
      id: "footer-length",
      label: "Footer Length",
      detail: bytesToHex(bytes.slice(bytes.length - footerLengthFieldSize)),
      start: bytes.length - footerLengthFieldSize,
      length: footerLengthFieldSize,
      end: bytes.length,
      kind: "footer",
    });
  }

  const typeCounts = new Map<string, number>();
  for (const segment of segments) {
    typeCounts.set(segment.type, (typeCounts.get(segment.type) ?? 0) + 1);
  }

  const payloadBytes = segments.reduce((sum, segment) => sum + segment.compressedLength, 0);
  const segmentsWithRatio = segments.filter((segment) => segment.compressionRatio !== null);
  const averageCompressionRatio =
    segmentsWithRatio.reduce((sum, segment) => sum + (segment.compressionRatio ?? 0), 0) /
    Math.max(1, segmentsWithRatio.length);

  return {
    fileStats: [
      { label: "File Size", value: formatFileSize(summary.fileSize) },
      { label: "Format", value: summary.container.format },
      { label: "Metadata Source", value: summary.container.metadataSource },
      { label: "Patch", value: summary.gameVersion || "unknown" },
      { label: "Game Length", value: `${formatNumber(summary.gameLengthMillis)} ms` },
      { label: "Payload Start", value: formatNumber(summary.container.payloadOffset) },
      { label: "Metadata Offset", value: formatNumber(summary.container.metadataOffset) },
      { label: "Metadata Size", value: formatNumber(summary.container.metadataSize) },
    ],
    segmentStats: [
      { label: "Indexed Records", value: formatNumber(segments.length) },
      { label: "Chunk Records", value: formatNumber(typeCounts.get("chunk") ?? 0) },
      { label: "Keyframe Records", value: formatNumber(typeCounts.get("keyframe") ?? 0) },
      { label: "Startup Records", value: formatNumber(typeCounts.get("startup") ?? 0) },
      { label: "Compressed Payload Bytes", value: formatFileSize(payloadBytes) },
      { label: "Avg Inflate Ratio", value: formatPercent(averageCompressionRatio * 100) },
    ],
    regions: regions
      .filter((region) => region.length > 0)
      .sort((left, right) => left.start - right.start),
    segments,
    metadataPreview: summary.metadataJson.slice(0, 2400),
    segmentTypes: Array.from(new Set(segments.map((segment) => segment.type))),
  };
}
