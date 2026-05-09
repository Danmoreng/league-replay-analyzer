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
    { label: "Mode", value: bundle.match.info.gameMode },
    { label: "Duration", value: `${bundle.match.info.gameDuration}s` },
    { label: "Patch", value: bundle.match.info.gameVersion },
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

  return source.slice(0, 50).map(({ event, frameIndex, eventIndex }) => {
    const killer = event.killerId ? participantNameById.value.get(event.killerId) : null;
    const victim = event.victimId ? participantNameById.value.get(event.victimId) : null;
    const participant = event.participantId
      ? participantNameById.value.get(event.participantId)
      : null;
    let detail = "";

    if (event.type === "CHAMPION_KILL") {
      detail = `${killer || "Unknown killer"} -> ${victim || "Unknown victim"}`;
    } else if (event.type === "ELITE_MONSTER_KILL") {
      detail = `${event.monsterType || "monster"} by ${killer || participant || "unknown"}`;
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

    const haystack = [segment.type, segment.codec, String(segment.id)].join(" ").toLowerCase();
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

function formatPercent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
</script>

<template>
  <div class="d-flex flex-column gap-2">
    <!-- File Layout Map -->
    <div class="island p-3">
      <div class="d-flex justify-content-between align-items-center mb-3">
        <h2 class="fs-5 mb-0">File Layout Map</h2>
        <div class="d-flex gap-3 x-small text-muted">
          <div class="d-flex align-items-center gap-1"><span class="swatch bg-primary"></span> Payload</div>
          <div class="d-flex align-items-center gap-1"><span class="swatch bg-warning"></span> Headers</div>
          <div class="d-flex align-items-center gap-1"><span class="swatch bg-success"></span> Metadata</div>
          <div class="d-flex align-items-center gap-1"><span class="swatch bg-danger"></span> Footer</div>
        </div>
      </div>
      
      <div class="layout-track rounded-3 position-relative overflow-hidden bg-dark border border-secondary border-opacity-25" style="height: 60px;">
        <div
          v-for="region in browser?.regions"
          :key="region.id"
          class="position-absolute h-100"
          :class="`region-${region.kind}`"
          :style="regionStyle(region)"
        ></div>
      </div>
      <div class="d-flex justify-content-between x-small text-muted mt-2">
        <span>0 B</span>
        <span>{{ totalBytes.toLocaleString() }} B</span>
      </div>
    </div>

    <div class="row g-2">
      <!-- Left Column: Segment List -->
      <div class="col-lg-7 d-flex flex-column gap-2">
        <div class="island p-3 d-flex flex-column gap-3">
          <div class="d-flex gap-2 flex-wrap align-items-end">
            <div class="flex-grow-1">
              <label class="x-small text-muted text-uppercase fw-bold mb-1">Search Segments</label>
              <input v-model="searchQuery" type="text" class="form-control form-control-sm" placeholder="ID, type, codec..." />
            </div>
            <div>
              <label class="x-small text-muted text-uppercase fw-bold mb-1">Type</label>
              <select v-model="typeFilter" class="form-select form-select-sm">
                <option value="all">All Types</option>
                <option value="keyframe">Keyframe</option>
                <option value="chunk">Chunk</option>
              </select>
            </div>
          </div>

          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>ID</th>
                  <th>Type</th>
                  <th>Codec</th>
                  <th>Size</th>
                  <th>Payload Offset</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="segment in visibleSegments"
                  :key="segment.key"
                  :class="{ 'table-primary': selectedKey === segment.key }"
                  style="cursor: pointer"
                  @click="selectedKey = segment.key"
                >
                  <td>{{ segment.id }}</td>
                  <td><span class="badge" :class="segment.type === 'keyframe' ? 'bg-warning-subtle text-warning-emphasis' : 'bg-info-subtle text-info-emphasis'">{{ segment.type }}</span></td>
                  <td><code>{{ segment.codec || 'none' }}</code></td>
                  <td>{{ segment.compressedLength.toLocaleString() }}</td>
                  <td class="text-muted">{{ segment.payloadOffset.toLocaleString() }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Right Column: Details & Riot API -->
      <div class="col-lg-5 d-flex flex-column gap-2">
        <!-- Selected Segment Details -->
        <div v-if="selectedSegment" class="island p-3">
          <h2 class="fs-5 mb-3">Segment #{{ selectedSegment.id }} Details</h2>
          <dl class="row g-2 mb-0 small">
            <dt class="col-6 text-muted fw-normal">Type</dt>
            <dd class="col-6 text-end fw-bold mb-1 text-uppercase">{{ selectedSegment.type }}</dd>
            
            <dt class="col-6 text-muted fw-normal">Codec</dt>
            <dd class="col-6 text-end fw-bold mb-1"><code>{{ selectedSegment.codec || 'N/A' }}</code></dd>
            
            <dt class="col-6 text-muted fw-normal">Compressed Size</dt>
            <dd class="col-6 text-end fw-bold mb-1">{{ selectedSegment.compressedLength.toLocaleString() }} B</dd>
            
            <dt class="col-6 text-muted fw-normal">Uncompressed</dt>
            <dd class="col-6 text-end fw-bold mb-1">{{ selectedSegment.uncompressedLength?.toLocaleString() || 'N/A' }}</dd>
            
            <dt class="col-6 text-muted fw-normal">Compression Ratio</dt>
            <dd class="col-6 text-end fw-bold mb-1 text-primary">{{ formatPercent(selectedSegment.compressionRatio) }}</dd>
          </dl>
          
          <div class="mt-3">
            <div class="x-small text-muted text-uppercase fw-bold mb-2">Raw Byte Preview</div>
            <pre class="bg-dark p-2 rounded small text-info mb-0 overflow-auto" style="max-height: 200px;"><code>{{ selectedSegment.payloadHex }}</code></pre>
          </div>
        </div>

        <!-- Riot API Fixture -->
        <div class="island p-3 d-flex flex-column">
          <div class="d-flex justify-content-between align-items-center mb-3">
            <h2 class="fs-5 mb-0">Riot API Correlation</h2>
            <span class="badge" :class="riotBundle ? 'bg-success-subtle text-success-emphasis' : 'bg-secondary-subtle text-secondary-emphasis'">
              {{ riotBundle ? 'Matched' : 'Not Found' }}
            </span>
          </div>
          
          <div v-if="riotBundle" class="d-flex flex-column gap-3">
            <dl class="row g-2 mb-0 small">
              <template v-for="fact in riotMatchFacts" :key="fact.label">
                <dt class="col-6 text-muted fw-normal">{{ fact.label }}</dt>
                <dd class="col-6 text-end fw-bold mb-0">{{ fact.value }}</dd>
              </template>
            </dl>

            <div class="x-small text-muted text-uppercase fw-bold mt-2">Timeline Events</div>
            <div class="d-flex flex-column gap-2 overflow-auto" style="max-height: 500px;">
              <div v-for="event in interestingTimelineEvents" :key="event.key" class="p-2 border rounded-2 small d-flex gap-3 align-items-start">
                <div class="fw-bold text-primary" style="min-width: 45px;">{{ formatTime(event.timestamp) }}</div>
                <div>
                  <div class="fw-bold x-small">{{ event.label }}</div>
                  <div class="text-muted x-small">{{ event.detail }}</div>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="p-3 bg-body-tertiary rounded text-center small text-muted border border-dashed">
            {{ riotFixtureStatus }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  display: inline-block;
}

.region-payload { background: var(--bs-primary); }
.region-segment-header { background: var(--bs-warning); }
.region-metadata { background: var(--bs-success); }
.region-footer { background: var(--bs-danger); }
.region-gap { background: var(--bs-secondary); opacity: 0.3; }

.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  font-family: 'Cascadia Code', Consolas, monospace;
}
</style>
