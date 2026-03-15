<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type { RiotFixtureBundle, RiotTimelineEvent, RiotTimelineFrame } from "../riotApiFixtures";
import type {
  ReplayBrowserModel,
  ReplayBrowserRegion,
  ReplayBrowserSegment,
} from "../replayBrowser";

const props = defineProps<{
  browser: ReplayBrowserModel | null;
  replayName: string;
  riotBundle: RiotFixtureBundle | null;
  riotFixtureStatus: string;
}>();

const typeFilter = ref<string>("all");
const searchQuery = ref("");
const selectedKey = ref("");

const totalBytes = computed(() => {
  const regions = props.browser?.regions ?? [];
  return Math.max(1, ...regions.map((region) => region.end));
});

const participantNameById = computed(() => {
  const participants = props.riotBundle?.match.info.participants ?? [];
  return new Map(
    participants.map((participant) => [
      participant.participantId,
      `${participant.championName} (${participant.riotIdGameName || `P${participant.participantId}`})`,
    ]),
  );
});

const riotMatchFacts = computed(() => {
  const bundle = props.riotBundle;
  if (!bundle) {
    return [] as Array<{ label: string; value: string }>;
  }

  return [
    { label: "Match ID", value: bundle.match.metadata.matchId },
    { label: "Game ID", value: String(bundle.match.info.gameId) },
    { label: "Queue", value: String(bundle.match.info.queueId ?? "n/a") },
    { label: "Mode", value: bundle.match.info.gameMode },
    { label: "Duration", value: `${bundle.match.info.gameDuration}s` },
    { label: "Patch", value: bundle.match.info.gameVersion },
    { label: "Map", value: String(bundle.match.info.mapId) },
    { label: "Frame Interval", value: `${bundle.timeline.info.frameInterval} ms` },
  ];
});

const interestingTimelineEvents = computed(() => {
  const bundle = props.riotBundle;
  if (!bundle) {
    return [] as Array<{ key: string; timestamp: number; label: string; detail: string }>;
  }

  const importantTypes = new Set([
    "CHAMPION_KILL",
    "ELITE_MONSTER_KILL",
    "BUILDING_KILL",
    "GAME_END",
    "PAUSE_END",
  ]);

  const events = bundle.timeline.info.frames.flatMap((frame: RiotTimelineFrame, frameIndex) =>
    frame.events.map((event: RiotTimelineEvent, eventIndex) => ({
      frame,
      frameIndex,
      event,
      eventIndex,
    })),
  );

  const filtered = events.filter(({ event }) => importantTypes.has(event.type));
  const source =
    filtered.length > 0 ? filtered : events.filter(({ event }) => event.type !== "ITEM_PURCHASED");

  return source.slice(0, 80).map(({ event, frameIndex, eventIndex }) => {
    const killer = event.killerId ? participantNameById.value.get(event.killerId) : null;
    const victim = event.victimId ? participantNameById.value.get(event.victimId) : null;
    const participant = event.participantId
      ? participantNameById.value.get(event.participantId)
      : null;
    let detail = "";

    if (event.type === "CHAMPION_KILL") {
      detail = `${killer || "Unknown killer"} -> ${victim || "Unknown victim"}`;
    } else if (event.type === "ELITE_MONSTER_KILL") {
      detail = `${event.monsterType || "monster"}${event.monsterSubType ? ` (${event.monsterSubType})` : ""} by ${killer || participant || "unknown"}`;
    } else if (event.type === "BUILDING_KILL") {
      detail = `${event.buildingType || "building"}${event.towerType ? ` / ${event.towerType}` : ""} by ${killer || participant || "unknown"}`;
    } else if (participant) {
      detail = participant;
    }

    return {
      key: `${frameIndex}-${eventIndex}-${event.type}-${event.timestamp}`,
      timestamp: event.timestamp,
      label: event.type,
      detail,
    };
  });
});

const timelineFrameSummary = computed(() => {
  const bundle = props.riotBundle;
  if (!bundle) {
    return [] as Array<{ label: string; value: string }>;
  }

  const frames = bundle.timeline.info.frames;
  const firstFrame = frames[0];
  const lastFrame = frames[frames.length - 1];
  return [
    { label: "Frames", value: String(frames.length) },
    { label: "First Frame TS", value: String(firstFrame?.timestamp ?? 0) },
    { label: "Last Frame TS", value: String(lastFrame?.timestamp ?? 0) },
    {
      label: "First Frame Events",
      value: String(firstFrame?.events?.length ?? 0),
    },
  ];
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

function formatTimelineTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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
              byte ranges, raw header bytes, payload previews, and any matching official Riot
              match/timeline anchors published into the frontend.
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

      <section class="note riot-card">
        <div class="section-head">
          <div>
            <h2>Official Riot Match Anchor</h2>
            <p>
              Local fixture data fetched from Match-V5 and timeline endpoints. Use this as a truth
              source for event timing and participant identity while reverse engineering replay
              payloads.
            </p>
          </div>
        </div>

        <p class="riot-status" :class="{ available: riotBundle, unavailable: !riotBundle }">
          {{ riotFixtureStatus }}
        </p>

        <template v-if="riotBundle">
          <div class="stat-columns">
            <div>
              <h3>Match Facts</h3>
              <dl class="browser-stats">
                <template v-for="fact in riotMatchFacts" :key="fact.label">
                  <dt>{{ fact.label }}</dt>
                  <dd>{{ fact.value }}</dd>
                </template>
              </dl>
            </div>
            <div>
              <h3>Timeline Facts</h3>
              <dl class="browser-stats">
                <template v-for="fact in timelineFrameSummary" :key="fact.label">
                  <dt>{{ fact.label }}</dt>
                  <dd>{{ fact.value }}</dd>
                </template>
              </dl>
            </div>
          </div>

          <div class="browser-table-wrap participant-wrap">
            <table class="segment-table browser-table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Champion</th>
                  <th>Riot ID</th>
                  <th>Team</th>
                  <th>Lane</th>
                  <th>K / D / A</th>
                  <th>Win</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="participant in riotBundle.match.info.participants"
                  :key="participant.participantId"
                >
                  <td>{{ participant.participantId }}</td>
                  <td>{{ participant.championName }}</td>
                  <td>{{ participant.riotIdGameName || "unknown" }}</td>
                  <td>{{ participant.teamId }}</td>
                  <td>{{ participant.lane || participant.role || "n/a" }}</td>
                  <td>
                    {{ participant.kills }}/{{ participant.deaths }}/{{ participant.assists }}
                  </td>
                  <td>{{ participant.win ? "yes" : "no" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
      </section>

      <section class="note" v-if="riotBundle">
        <div class="section-head">
          <div>
            <h2>Timeline Event Anchors</h2>
            <p>
              Curated event list from the official timeline. These are the strongest candidates for
              aligning replay chunks and subrecord families with known game-time changes.
            </p>
          </div>
        </div>
        <div class="event-list">
          <article v-for="event in interestingTimelineEvents" :key="event.key" class="event-card">
            <div class="event-time">{{ formatTimelineTimestamp(event.timestamp) }}</div>
            <div>
              <h3>{{ event.label }}</h3>
              <p>{{ event.detail || "No extra detail" }}</p>
            </div>
          </article>
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
        offsets, raw byte previews, and any matching Riot fixture data.
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

.browser-hero,
.riot-card {
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

.riot-status {
  margin-top: -4px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: #fff;
}

.riot-status.available {
  border-color: rgba(77, 125, 87, 0.3);
  background: rgba(77, 125, 87, 0.08);
}

.riot-status.unavailable {
  border-color: rgba(179, 79, 67, 0.2);
  background: rgba(179, 79, 67, 0.05);
}

.stat-columns,
.detail-grid-browser,
.preview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.preview-grid {
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

.participant-wrap {
  margin-top: 18px;
}

.browser-table tbody tr {
  cursor: pointer;
}

.browser-table tbody tr.selected {
  background: rgba(44, 82, 111, 0.08);
}

.event-list {
  display: grid;
  gap: 10px;
}

.event-card {
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 14px;
  padding: 14px 16px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: #fff;
}

.event-time {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--accent);
}

.event-card h3 {
  margin: 0 0 4px;
  font-size: 0.98rem;
}

.event-card p {
  margin: 0;
  color: var(--text-muted);
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
  .preview-grid,
  .event-card {
    grid-template-columns: 1fr;
  }
}
</style>
