<script setup lang="ts">
import { computed, ref } from "vue";

import DataBrowser from "./components/DataBrowser.vue";
import Minimap from "./components/Minimap.vue";
import Timeline from "./components/Timeline.vue";
import Sidebar from "./components/Sidebar.vue";
import { usePlayback } from "./composables/usePlayback";
import { buildReplayBrowserModel, type ReplayBrowserModel } from "./replayBrowser";
import {
  deriveRiotMatchIdFromReplayName,
  loadRiotFixtureBundle,
  type RiotFixtureBundle,
} from "./riotApiFixtures";
import { type PlayerSummary, type ReplaySummary } from "./replayParser";
import { parseReplayBufferWithWasm } from "./wasmReplayParser";

const { seek, setDuration } = usePlayback();
const summary = ref<ReplaySummary | null>(null);
const browserModel = ref<ReplayBrowserModel | null>(null);
const riotBundle = ref<RiotFixtureBundle | null>(null);
const riotFixtureStatus = ref("No Riot fixture loaded yet.");
const parserEngine = ref("C++/Wasm");
const loadedReplayName = ref("");
const status = ref("Pick a replay file to parse it with the C++/Wasm replay parser.");
const errorMessage = ref("");
const isLoading = ref(false);
const activePage = ref<"summary" | "browser">("summary");

const teams = computed(() => {
  const players = summary.value?.players ?? [];
  return [100, 200].map((teamId) => {
    const members = players.filter((player) => Number(player.team) === teamId);
    const totalGold = members.reduce((sum, player) => sum + Number(player.goldEarned ?? 0), 0);
    const totalDamage = members.reduce(
      (sum, player) => sum + Number(player.totalDamageToChampions ?? 0),
      0,
    );
    const totalVision = members.reduce((sum, player) => sum + Number(player.visionScore ?? 0), 0);
    const winner = members.some((player) => player.win === "Win");

    return {
      id: teamId,
      winner,
      members,
      totalGold,
      totalDamage,
      totalVision,
    };
  });
});

const maxGold = computed(() =>
  Math.max(1, ...(summary.value?.players ?? []).map((player) => Number(player.goldEarned ?? 0))),
);
const maxDamage = computed(() =>
  Math.max(
    1,
    ...(summary.value?.players ?? []).map((player) => Number(player.totalDamageToChampions ?? 0)),
  ),
);
const maxVision = computed(() =>
  Math.max(1, ...(summary.value?.players ?? []).map((player) => Number(player.visionScore ?? 0))),
);

const durationLabel = computed(() => formatDuration(summary.value?.gameLengthMillis ?? 0));

const overviewMetrics = computed(() => {
  if (!summary.value) {
    return [];
  }

  return [
    { label: "Patch", value: summary.value.gameVersion, icon: 'bi-patch-check' },
    { label: "Duration", value: durationLabel.value, icon: 'bi-clock' },
    { label: "File Size", value: formatFileSize(summary.value.fileSize), icon: 'bi-hdd' },
    { label: "Container", value: summary.value.container.format, icon: 'bi-box' },
  ];
});

const capabilityItems = computed(() => {
  const capabilities = summary.value?.capabilities;
  if (!capabilities) {
    return [];
  }

  return [
    {
      label: "Metadata",
      available: capabilities.metadataAvailable,
      detail: "Embedded match metadata JSON",
    },
    {
      label: "Player Stats",
      available: capabilities.playerStatsAvailable,
      detail: "Per-player statsJson summary fields",
    },
    {
      label: "Binary Header",
      available: capabilities.binaryHeaderAvailable,
      detail: "Classic 288-byte ROFL header",
    },
    {
      label: "Payload Decode",
      available: capabilities.payloadDecodingAvailable,
      detail: "Decryption + decompression",
    },
  ];
});

const containerRows = computed(() => {
  const container = summary.value?.container;
  if (!container) {
    return [];
  }

  return [
    { label: "Metadata Offset", value: formatNumber(container.metadataOffset) },
    { label: "Metadata Size", value: formatNumber(container.metadataSize) },
    { label: "Payload Offset", value: formatOptionalNumber(container.payloadOffset) },
    { label: "Match ID", value: formatOptionalNumber(container.matchId) },
    { label: "Chunk Count", value: formatOptionalNumber(container.chunkCount) },
    { label: "Keyframe Count", value: formatOptionalNumber(container.keyframeCount) },
  ];
});

const segmentPreview = computed(() => summary.value?.container.segments.slice(0, 10) ?? []);

function formatRiotId(player: PlayerSummary): string {
  return player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}`
    : player.riotIdGameName;
}

function percentage(value: number, max: number): string {
  return `${Math.max(6, Math.round((value / max) * 100))}%`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatOptionalNumber(value: number): string {
  return value > 0 ? formatNumber(value) : "N/A";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  const mib = kib / 1024;
  return `${mib.toFixed(2)} MiB`;
}

async function loadReplay(file: File): Promise<void> {
  isLoading.value = true;
  errorMessage.value = "";
  loadedReplayName.value = file.name;
  status.value = `Parsing ${file.name}...`;

  try {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const parsedSummary = await parseReplayBufferWithWasm(buffer);
    const derivedMatchId = deriveRiotMatchIdFromReplayName(file.name);

    summary.value = parsedSummary;
    browserModel.value = buildReplayBrowserModel(bytes, parsedSummary);
    riotBundle.value = null;
    if (derivedMatchId) {
      try {
        riotBundle.value = await loadRiotFixtureBundle(derivedMatchId);
        riotFixtureStatus.value = riotBundle.value
          ? `Loaded Riot fixture bundle for ${derivedMatchId}.`
          : `No published Riot fixture bundle found for ${derivedMatchId}.`;
      } catch (fixtureError) {
        riotFixtureStatus.value =
          fixtureError instanceof Error ? fixtureError.message : String(fixtureError);
      }
    }

    setDuration(parsedSummary.gameLengthMillis);
    seek(0);
    status.value = `Parsed ${file.name} successfully.`;
  } catch (error) {
    summary.value = null;
    browserModel.value = null;
    riotBundle.value = null;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    status.value = "Replay parsing failed.";
  } finally {
    isLoading.value = false;
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void loadReplay(file);
  }
}
</script>

<template>
  <div id="app" class="d-flex vh-100 overflow-hidden" data-bs-theme="dark">
    <!-- Sidebar -->
    <aside class="sidebar island m-2">
      <Sidebar v-model:activePage="activePage" :is-loaded="!!summary" />
    </aside>

    <!-- Content Area -->
    <main class="main-content flex-grow-1 overflow-auto p-2 d-flex flex-column">
      
      <!-- Top Action Bar -->
      <header class="island p-3 mb-2 d-flex justify-content-between align-items-center flex-shrink-0">
        <div>
          <h1 class="fs-4 mb-0" v-if="loadedReplayName">{{ loadedReplayName }}</h1>
          <h1 class="fs-4 mb-0" v-else>League Replay Analyzer</h1>
          <p class="text-muted small mb-0" :class="{ 'text-danger': errorMessage }">
            {{ errorMessage || status }}
          </p>
        </div>
        <div class="d-flex gap-2 align-items-center">
          <span class="badge bg-secondary opacity-75 d-none d-md-inline-block">{{ parserEngine }}</span>
          <label class="btn btn-primary btn-sm px-3">
            <i class="bi bi-file-earmark-arrow-up me-1"></i>
            Load Replay
            <input type="file" accept=".rofl" @change="onFileChange" class="d-none" />
          </label>
        </div>
      </header>

      <!-- Main Section -->
      <div v-if="summary" class="flex-grow-1 d-flex flex-column gap-2">
        
        <!-- Summary View -->
        <div v-if="activePage === 'summary'" class="d-flex flex-column gap-2">
          
          <!-- Metrics Row -->
          <div class="row g-2 flex-shrink-0">
            <div v-for="metric in overviewMetrics" :key="metric.label" class="col-6 col-md-3">
              <div class="island p-3 text-center">
                <i :class="metric.icon" class="fs-3 text-primary mb-2 d-block"></i>
                <div class="text-muted x-small text-uppercase fw-bold">{{ metric.label }}</div>
                <div class="fs-5 fw-bold">{{ metric.value }}</div>
              </div>
            </div>
          </div>

          <div class="row g-2">
            <!-- Left Column: Visuals & Table -->
            <div class="col-lg-8 d-flex flex-column gap-2">
              
              <div class="island p-3 d-flex flex-column gap-3">
                <div class="d-flex justify-content-between align-items-start">
                  <div>
                    <h2 class="fs-5 mb-1">Match Timeline</h2>
                    <p class="text-muted small">No decoded movement frames are available yet.</p>
                  </div>
                  <span class="badge bg-warning-subtle text-warning-emphasis">Movement Unavailable</span>
                </div>
                
                <div class="d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-3 border border-secondary border-opacity-10">
                  <Minimap
                    :player-data="[]"
                    label="Movement Map"
                    empty-message="Current parser output does not include champion coordinates yet."
                    style="max-width: 400px;"
                  />
                </div>
                <Timeline class="main-timeline" />
              </div>

              <div class="island p-3">
                <h2 class="fs-5 mb-3">Segment Preview (First 10)</h2>
                <div class="table-responsive">
                  <table class="table table-sm table-hover align-middle mb-0">
                    <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                      <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Codec</th>
                        <th>Size</th>
                        <th>Uncompressed</th>
                        <th>Offset</th>
                      </tr>
                    </thead>
                    <tbody class="small">
                      <tr v-for="segment in segmentPreview" :key="segment.id">
                        <td>{{ segment.id }}</td>
                        <td><span class="badge bg-secondary-subtle text-secondary-emphasis">{{ segment.type }}</span></td>
                        <td><code>{{ segment.codec || 'none' }}</code></td>
                        <td>{{ formatNumber(segment.length) }}</td>
                        <td>{{ formatOptionalNumber(segment.uncompressedLength) }}</td>
                        <td><span class="text-muted">{{ formatNumber(segment.payloadOffset) }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <!-- Right Column: Capabilities & Details -->
            <div class="col-lg-4 d-flex flex-column gap-2">
              
              <div class="island p-3">
                <h2 class="fs-5 mb-3">Parser Capabilities</h2>
                <div class="row g-2">
                  <div v-for="item in capabilityItems" :key="item.label" class="col-12">
                    <div class="p-2 rounded-2 border border-opacity-10 d-flex align-items-center gap-2"
                         :class="item.available ? 'border-success bg-success-subtle bg-opacity-10' : 'border-danger bg-danger-subtle bg-opacity-10'">
                      <i class="bi" :class="item.available ? 'bi-check-circle-fill text-success' : 'bi-x-circle-fill text-danger'"></i>
                      <div>
                        <div class="fw-bold small">{{ item.label }}</div>
                        <div class="x-small text-muted">{{ item.detail }}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="island p-3">
                <h2 class="fs-5 mb-3">Container Layout</h2>
                <dl class="row g-2 mb-0 small">
                  <template v-for="row in containerRows" :key="row.label">
                    <dt class="col-7 text-muted fw-normal">{{ row.label }}</dt>
                    <dd class="col-5 text-end fw-bold mb-0">{{ row.value }}</dd>
                  </template>
                </dl>
              </div>

              <div class="island p-3">
                <h2 class="fs-5 mb-2">Metadata JSON</h2>
                <details class="small">
                  <summary class="text-muted cursor-pointer py-1">Expand raw metadata</summary>
                  <pre class="bg-dark p-2 rounded text-info mt-2 mb-0 overflow-auto" style="max-height: 300px; font-size: 0.75rem;"><code>{{ summary.metadataJson }}</code></pre>
                </details>
              </div>
            </div>
          </div>

          <!-- Teams Section -->
          <div class="row g-2 flex-shrink-0 mb-3">
            <div v-for="team in teams" :key="team.id" class="col-12 col-xl-6">
              <div class="island p-3 border-top border-4" :class="team.winner ? 'border-success' : 'border-secondary'">
                <div class="d-flex justify-content-between align-items-end mb-3">
                  <div>
                    <div class="x-small text-uppercase text-muted fw-bold">Team {{ team.id }}</div>
                    <h3 class="fs-4 mb-0">{{ team.winner ? 'Victory' : 'Defeat' }}</h3>
                  </div>
                  <div class="text-end x-small text-muted">
                    <span class="mx-1">{{ team.totalGold.toLocaleString() }} gold</span>
                    <span class="mx-1">{{ team.totalDamage.toLocaleString() }} dmg</span>
                  </div>
                </div>

                <div class="d-flex flex-column gap-2">
                  <div v-for="player in team.members" :key="player.riotIdGameName" class="p-2 border rounded-2 bg-body-tertiary bg-opacity-25">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                      <div>
                        <div class="x-small text-primary fw-bold text-uppercase">{{ player.teamPosition }}</div>
                        <div class="fw-bold">{{ player.champion }}</div>
                        <div class="x-small text-muted">{{ formatRiotId(player) }}</div>
                      </div>
                      <div class="text-end">
                        <div class="fw-bold text-primary">{{ player.kills }}/{{ player.deaths }}/{{ player.assists }}</div>
                      </div>
                    </div>
                    
                    <div class="d-flex flex-column gap-1">
                      <div class="progress" style="height: 4px;">
                        <div class="progress-bar bg-warning" :style="{ width: percentage(player.goldEarned, maxGold) }"></div>
                      </div>
                      <div class="progress" style="height: 4px;">
                        <div class="progress-bar bg-danger" :style="{ width: percentage(player.totalDamageToChampions, maxDamage) }"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Data Browser View -->
        <DataBrowser
          v-else
          class="flex-grow-1"
          :browser="browserModel"
          :replay-name="loadedReplayName"
          :riot-bundle="riotBundle"
          :riot-fixture-status="riotFixtureStatus"
        />

      </div>

      <!-- Welcome State -->
      <div v-else-if="!isLoading" class="flex-grow-1 d-flex align-items-center justify-content-center">
        <div class="island p-5 text-center" style="max-width: 500px;">
          <i class="bi bi-file-earmark-bar-graph fs-1 text-primary mb-3 d-block"></i>
          <h2 class="fs-3">No Replay Loaded</h2>
          <p class="text-muted">Load a <code>.rofl</code> file to begin analyzing match metadata, player stats, and record structure.</p>
          <label class="btn btn-primary px-4 mt-3">
            <i class="bi bi-plus-lg me-1"></i>
            Select File
            <input type="file" accept=".rofl" @change="onFileChange" class="d-none" />
          </label>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="flex-grow-1 d-flex align-items-center justify-content-center">
        <div class="text-center">
          <div class="spinner-border text-primary mb-3" role="status" style="width: 3rem; height: 3rem;">
            <span class="visually-hidden">Loading...</span>
          </div>
          <p class="text-muted">Parsing replay bytes...</p>
        </div>
      </div>

    </main>
  </div>
</template>

<style>
/* Dashboard Layout */
.sidebar {
  width: 240px;
  flex-shrink: 0;
}

.main-content {
  min-width: 0;
}

.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}

/* Custom transitions and scrollbar */
.island {
  transition: box-shadow 0.2s;
}

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}

code {
  color: var(--island-accent);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}
</style>
