<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type {
  ReplayBrowserModel,
  ReplayBrowserRegion,
  ReplayBrowserSegment,
} from "../replayBrowser";

const props = defineProps<{
  browser: ReplayBrowserModel | null;
  replayName: string;
}>();

const typeFilter = ref<string>("all");
const searchQuery = ref("");
const selectedKey = ref("");

const totalBytes = computed(() => {
  const regions = props.browser?.regions ?? [];
  return Math.max(1, ...regions.map((region) => region.end));
});

const visibleSegments = computed(() => {
  const browser = props.browser;
  if (!browser) {
    return [] as ReplayBrowserSegment[];
  }

  const query = searchQuery.value.trim().toLowerCase();
  return browser.segments.filter((segment) => {
    if (typeFilter.value !== "all" && segment.type !== typeFilter.value) {
      return false;
    }

    if (!query) {
      return true;
    }

    const haystack = [
      segment.type,
      segment.codec,
      String(segment.id),
      String(segment.chunkId),
      String(segment.order),
      String(segment.headerOffset),
      String(segment.payloadOffset),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
});

const selectedSegment = computed(() => {
  const segments = visibleSegments.value;
  return segments.find((segment) => segment.key === selectedKey.value) ?? segments[0] ?? null;
});

watch(
  visibleSegments,
  (segments) => {
    if (segments.length === 0) {
      selectedKey.value = "";
      return;
    }

    if (!segments.some((segment) => segment.key === selectedKey.value)) {
      selectedKey.value = segments[0].key;
    }
  },
  { immediate: true },
);

function regionStyle(region: ReplayBrowserRegion): Record<string, string> {
  const start = (region.start / totalBytes.value) * 100;
  const width = Math.max((region.length / totalBytes.value) * 100, 0.08);
  return {
    left: `${start}%`,
    width: `${width}%`,
  };
}

function regionClass(region: ReplayBrowserRegion): string {
  return `region-${region.kind}`;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return new Intl.NumberFormat().format(value);
}
</script>

<template>
  <section v-if="browser" class="browser-shell">
    <div class="browser-grid">
      <section class="note browser-hero">
        <div class="browser-head">
          <div>
            <p class="browser-label">Replay Data Browser</p>
            <h2>{{ replayName || "Loaded replay" }}</h2>
            <p>
              This page shows transport-level structure the app can prove today: indexed records,
              byte ranges, raw header bytes, and payload previews. These are ordered container
              records, not decoded gameplay frames yet.
            </p>
          </div>
          <div class="browser-badges">
            <span class="browser-badge">{{ browser.fileStats[1]?.value }}</span>
            <span class="browser-badge">{{ browser.segmentStats[0]?.value }} records</span>
          </div>
        </div>

        <div class="stat-columns">
          <div>
            <h3>File Facts</h3>
            <dl class="browser-stats">
              <template v-for="stat in browser.fileStats" :key="stat.label">
                <dt>{{ stat.label }}</dt>
                <dd>{{ stat.value }}</dd>
              </template>
            </dl>
          </div>
          <div>
            <h3>Record Facts</h3>
            <dl class="browser-stats">
              <template v-for="stat in browser.segmentStats" :key="stat.label">
                <dt>{{ stat.label }}</dt>
                <dd>{{ stat.value }}</dd>
              </template>
            </dl>
          </div>
        </div>
      </section>

      <section class="note layout-card">
        <div class="section-head">
          <div>
            <h2>File Layout Map</h2>
            <p>
              Absolute byte-position view of indexed record headers, compressed payloads, metadata,
              and any gaps between them.
            </p>
          </div>
        </div>
        <div class="layout-frame">
          <div class="layout-track">
            <button
              v-for="region in browser.regions"
              :key="region.id"
              class="layout-region"
              :class="regionClass(region)"
              :style="regionStyle(region)"
              :title="`${region.label} | ${formatNumber(region.start)}..${formatNumber(region.end)} | ${region.detail}`"
              type="button"
            ></button>
          </div>
          <div class="layout-axis">
            <span>0</span>
            <span>{{ browser.fileStats[0]?.value }}</span>
          </div>
        </div>
        <div class="legend">
          <span class="legend-item"><i class="swatch region-payload"></i>Payload</span>
          <span class="legend-item"><i class="swatch region-segment-header"></i>Record Header</span>
          <span class="legend-item"><i class="swatch region-metadata"></i>Metadata</span>
          <span class="legend-item"><i class="swatch region-footer"></i>Footer</span>
          <span class="legend-item"><i class="swatch region-gap"></i>Gap</span>
        </div>
      </section>

      <section class="note browser-table-card">
        <div class="section-head browser-tools">
          <div>
            <h2>Indexed Records</h2>
            <p>
              Filter by record kind and inspect one record at a time. For footer-style files these
              are the zstd-backed startup, chunk, and keyframe records.
            </p>
          </div>
          <div class="toolbar-row">
            <label>
              <span>Type</span>
              <select v-model="typeFilter">
                <option value="all">All</option>
                <option v-for="type in browser.segmentTypes" :key="type" :value="type">
                  {{ type }}
                </option>
              </select>
            </label>
            <label>
              <span>Find</span>
              <input v-model="searchQuery" type="search" placeholder="id, chunk, offset, codec" />
            </label>
          </div>
        </div>

        <div class="browser-table-wrap">
          <table class="segment-table browser-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>ID</th>
                <th>Type</th>
                <th>Chunk</th>
                <th>Codec</th>
                <th>Header</th>
                <th>Payload</th>
                <th>Compressed</th>
                <th>Uncompressed</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="segment in visibleSegments"
                :key="segment.key"
                :class="{ selected: selectedSegment?.key === segment.key }"
                @click="selectedKey = segment.key"
              >
                <td>{{ segment.order }}</td>
                <td>{{ segment.id }}</td>
                <td>{{ segment.type }}</td>
                <td>{{ segment.chunkId }}</td>
                <td>{{ segment.codec }}</td>
                <td>{{ formatNumber(segment.headerOffset) }}</td>
                <td>{{ formatNumber(segment.payloadOffset) }}</td>
                <td>{{ formatNumber(segment.compressedLength) }}</td>
                <td>{{ formatNumber(segment.uncompressedLength) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section v-if="selectedSegment" class="note detail-card">
        <div class="section-head">
          <div>
            <h2>Selected Record</h2>
            <p>
              Record #{{ selectedSegment.id }} in transport order {{ selectedSegment.order }}.
              Header fields are decoded only at the container level; payload bytes are still opaque.
            </p>
          </div>
          <div class="detail-pills">
            <span class="detail-pill">{{ selectedSegment.type }}</span>
            <span class="detail-pill"
              >inflate {{ formatPercent(selectedSegment.compressionRatio) }}</span
            >
          </div>
        </div>

        <div class="detail-grid-browser">
          <article class="detail-block">
            <h3>Offsets</h3>
            <dl class="browser-stats compact">
              <dt>Header Offset</dt>
              <dd>{{ formatNumber(selectedSegment.headerOffset) }}</dd>
              <dt>Payload Offset</dt>
              <dd>{{ formatNumber(selectedSegment.payloadOffset) }}</dd>
              <dt>Payload End</dt>
              <dd>{{ formatNumber(selectedSegment.endOffset) }}</dd>
              <dt>Gap To Next</dt>
              <dd>{{ formatNumber(selectedSegment.gapToNext) }}</dd>
            </dl>
          </article>

          <article class="detail-block">
            <h3>Header Fields</h3>
            <dl class="browser-stats compact">
              <template v-for="field in selectedSegment.headerFields" :key="field.label">
                <dt>{{ field.label }}</dt>
                <dd>{{ field.value }}</dd>
              </template>
            </dl>
          </article>
        </div>

        <div class="preview-grid">
          <article class="preview-card">
            <h3>Header Bytes</h3>
            <pre>{{ selectedSegment.headerHex }}</pre>
          </article>
          <article class="preview-card">
            <h3>Payload Preview</h3>
            <pre>{{ selectedSegment.payloadHex }}</pre>
          </article>
          <article class="preview-card">
            <h3>ASCII Preview</h3>
            <pre>{{ selectedSegment.payloadAscii }}</pre>
          </article>
          <article class="preview-card">
            <h3>Payload Magic</h3>
            <pre>{{ selectedSegment.payloadMagic }}</pre>
          </article>
        </div>
      </section>

      <section class="note metadata-card">
        <div class="section-head">
          <div>
            <h2>Metadata Preview</h2>
            <p>
              First 2.4 KB of the normalized metadata JSON so you can compare container structure
              with Riot's embedded summary block.
            </p>
          </div>
        </div>
        <pre>{{ browser.metadataPreview }}</pre>
      </section>
    </div>
  </section>

  <section v-else class="welcome-hint">
    <div class="hint-card">
      <h3>Ready to inspect raw structure</h3>
      <p>
        Load a `.rofl` file, then switch to the data browser page to inspect indexed records,
        offsets, and raw byte previews.
      </p>
    </div>
  </section>
</template>

<style scoped>
.browser-grid {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.browser-hero {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.browser-head {
  display: flex;
  justify-content: space-between;
  gap: 18px;
  align-items: start;
}

.browser-label {
  margin-bottom: 8px;
  color: var(--accent-2);
  text-transform: uppercase;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
}

.browser-badges,
.detail-pills {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.browser-badge,
.detail-pill {
  display: inline-flex;
  padding: 8px 12px;
  border-radius: 999px;
  background: var(--surface-accent);
  border: 1px solid #bfccd7;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.stat-columns,
.detail-grid-browser,
.preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.preview-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 18px;
}

.browser-stats {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 14px;
  margin: 12px 0 0;
}

.browser-stats.compact {
  margin-top: 8px;
}

.browser-stats dt {
  color: var(--text-muted);
}

.browser-stats dd {
  margin: 0;
  text-align: right;
  font-weight: 600;
  color: #17202a;
}

.layout-frame {
  margin-top: 14px;
}

.layout-track {
  position: relative;
  height: 68px;
  border-radius: 18px;
  overflow: hidden;
  background: #efe8db;
  border: 1px solid var(--border);
}

.layout-region {
  position: absolute;
  top: 0;
  bottom: 0;
  border: 0;
  padding: 0;
  opacity: 0.95;
}

.layout-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 0.84rem;
}

.legend {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
}

.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 0.88rem;
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 4px;
  display: inline-block;
}

.region-payload {
  background: #6d8ba0;
}

.region-segment-header {
  background: #b88b35;
}

.region-metadata {
  background: #4d7d57;
}

.region-footer {
  background: #b85d4e;
}

.region-gap {
  background: #cfc6b5;
}

.browser-tools {
  align-items: end;
}

.toolbar-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.toolbar-row label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 160px;
  color: var(--text-muted);
  font-size: 0.84rem;
}

.toolbar-row select,
.toolbar-row input {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: #fff;
  font: inherit;
  color: #17202a;
}

.browser-table-wrap {
  overflow: auto;
  margin-top: 16px;
}

.browser-table tbody tr {
  cursor: pointer;
}

.browser-table tbody tr.selected {
  background: rgba(44, 82, 111, 0.08);
}

.detail-block,
.preview-card {
  padding: 16px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: #fff;
}

.preview-card pre,
.metadata-card pre {
  margin-top: 10px;
  padding: 14px;
  border-radius: 14px;
  background: #f3efe6;
  border: 1px solid var(--border);
  color: #23303c;
  font-family: Consolas, "Cascadia Code", monospace;
  font-size: 0.82rem;
  line-height: 1.45;
  overflow: auto;
}

@media (max-width: 980px) {
  .browser-head,
  .browser-tools {
    flex-direction: column;
  }

  .stat-columns,
  .detail-grid-browser,
  .preview-grid {
    grid-template-columns: 1fr;
  }
}
</style>
