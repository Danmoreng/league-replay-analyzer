<script setup lang="ts">
import { computed, ref } from "vue";

import Minimap from "./components/Minimap.vue";
import Timeline from "./components/Timeline.vue";
import { usePlayback } from "./composables/usePlayback";
import { type PlayerSummary, type ReplaySummary } from "./replayParser";
import { parseReplayBufferWithWasm } from "./wasmReplayParser";

const { seek, setDuration } = usePlayback();
const summary = ref<ReplaySummary | null>(null);
const parserEngine = ref("C++/Wasm");
const loadedReplayName = ref("");
const status = ref("Pick a replay file to parse it with the C++/Wasm replay parser.");
const errorMessage = ref("");
const isLoading = ref(false);

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
    { label: "Replay", value: loadedReplayName.value || "Loaded" },
    { label: "Patch", value: summary.value.gameVersion },
    { label: "Duration", value: durationLabel.value },
    { label: "File Size", value: formatFileSize(summary.value.fileSize) },
    { label: "Metadata Source", value: summary.value.container.metadataSource },
    { label: "Container", value: summary.value.container.format },
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
      label: "Payload Header",
      available: capabilities.payloadHeaderAvailable,
      detail: "Classic payload header fields",
    },
    {
      label: "Segment Table",
      available: capabilities.segmentTableAvailable,
      detail: "Classic chunk/keyframe index",
    },
    {
      label: "Payload Decode",
      available: capabilities.payloadDecodingAvailable,
      detail: "Decryption + decompression",
    },
    {
      label: "Movement Timeline",
      available: capabilities.movementTimelineAvailable,
      detail: "Decoded position frames",
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
    { label: "Payload Header Offset", value: formatOptionalNumber(container.payloadHeaderOffset) },
    { label: "Payload Header Size", value: formatOptionalNumber(container.payloadHeaderSize) },
    { label: "Payload Offset", value: formatOptionalNumber(container.payloadOffset) },
    { label: "Match ID", value: formatOptionalNumber(container.matchId) },
    { label: "Chunk Count", value: formatOptionalNumber(container.chunkCount) },
    { label: "Keyframe Count", value: formatOptionalNumber(container.keyframeCount) },
    {
      label: "Keyframe Interval",
      value:
        container.keyframeIntervalMillis > 0
          ? `${formatNumber(container.keyframeIntervalMillis)} ms`
          : "Not available",
    },
  ];
});

const segmentPreview = computed(() => summary.value?.container.segments.slice(0, 12) ?? []);

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
  return value > 0 ? formatNumber(value) : "Not available";
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
  status.value = `Parsing ${file.name} with ${parserEngine.value}...`;

  try {
    const buffer = await file.arrayBuffer();
    summary.value = await parseReplayBufferWithWasm(buffer);
    setDuration(summary.value.gameLengthMillis);
    seek(0);
    status.value = `Parsed ${file.name}. Metadata source: ${summary.value.container.metadataSource}. Player stats: ${summary.value.playerCount}.`;
  } catch (error) {
    summary.value = null;
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
  <main class="shell">
    <header class="hero">
      <div>
        <p class="eyebrow">League Replay Analyzer</p>
        <h1>Current parser output, directly from the replay file.</h1>
        <p class="lede">
          This view is limited to what the parser actually extracts today: metadata, player stat
          summaries, container details, and parser capability state. Movement, wards, and event
          frames are intentionally shown as unavailable until payload decoding exists.
        </p>
      </div>
      <div class="hero-controls">
        <div class="engine-pill">{{ parserEngine }}</div>
        <label class="picker">
          <span>Load replay</span>
          <input type="file" accept=".rofl" @change="onFileChange" />
        </label>
      </div>
      <p class="status" :class="{ error: errorMessage }">{{ errorMessage || status }}</p>
    </header>

    <template v-if="summary">
      <section class="summary-grid extended-grid">
        <article v-for="metric in overviewMetrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
        </article>
      </section>

      <div class="analyzer-layout">
        <div class="visual-pane">
          <section class="note visual-card">
            <div class="visual-header">
              <div>
                <h2>Timeline Surface</h2>
                <p>
                  The scrubber currently reflects match duration from metadata only. No decoded
                  movement frames are available yet.
                </p>
              </div>
              <div class="availability-pill unavailable">Movement unavailable</div>
            </div>
            <Minimap
              :player-data="[]"
              label="Movement Map"
              empty-message="Current parser output does not include champion coordinates yet."
            />
            <Timeline class="main-timeline" />
            <p class="visual-note">
              Once payload packets are decoded, this pane will switch from a duration-only shell to
              a real movement timeline.
            </p>
          </section>

          <section v-if="summary.warnings.length > 0" class="note warning-card">
            <h2>Parser Warnings</h2>
            <ul class="warning-list">
              <li v-for="warning in summary.warnings" :key="warning">{{ warning }}</li>
            </ul>
          </section>

          <section v-if="segmentPreview.length > 0" class="note">
            <div class="section-head">
              <h2>Segment Preview</h2>
              <p>First {{ segmentPreview.length }} segment headers currently available.</p>
            </div>
            <div class="segment-table-wrap">
              <table class="segment-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Type</th>
                    <th>Length</th>
                    <th>Chunk ID</th>
                    <th>Offset</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="segment in segmentPreview" :key="`${segment.id}-${segment.offset}`">
                    <td>{{ segment.id }}</td>
                    <td>{{ segment.type }}</td>
                    <td>{{ formatNumber(segment.length) }}</td>
                    <td>{{ formatNumber(segment.chunkId) }}</td>
                    <td>{{ formatNumber(segment.offset) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside class="sidebar">
          <section class="note">
            <div class="section-head">
              <h2>Parser Capabilities</h2>
              <p>Live status of what the replay parser can currently prove or extract.</p>
            </div>
            <div class="capability-grid">
              <article
                v-for="item in capabilityItems"
                :key="item.label"
                class="capability-card"
                :class="item.available ? 'available' : 'unavailable'"
              >
                <div class="capability-state">
                  {{ item.available ? "Available" : "Unavailable" }}
                </div>
                <h3>{{ item.label }}</h3>
                <p>{{ item.detail }}</p>
              </article>
            </div>
          </section>

          <section class="note">
            <div class="section-head">
              <h2>Container Details</h2>
              <p>
                Everything the current parser can describe about file layout and metadata placement.
              </p>
            </div>
            <dl class="detail-grid">
              <template v-for="row in containerRows" :key="row.label">
                <dt>{{ row.label }}</dt>
                <dd>{{ row.value }}</dd>
              </template>
            </dl>
          </section>

          <section class="note raw-note">
            <div class="section-head">
              <h2>Metadata JSON</h2>
              <p>The full embedded metadata block extracted from the replay.</p>
            </div>
            <details class="json-details">
              <summary>Show extracted metadata JSON</summary>
              <pre>{{ summary.metadataJson }}</pre>
            </details>
          </section>
        </aside>
      </div>

      <section class="team-grid player-section">
        <article
          v-for="team in teams"
          :key="team.id"
          class="team-panel"
          :class="{ winner: team.winner }"
        >
          <header class="team-header">
            <div>
              <p class="team-label">Team {{ team.id }}</p>
              <h2>{{ team.winner ? "Winner" : "Defeat" }}</h2>
            </div>
            <div class="team-totals">
              <span>{{ team.totalGold.toLocaleString() }} gold</span>
              <span>{{ team.totalDamage.toLocaleString() }} damage</span>
              <span>{{ team.totalVision.toLocaleString() }} vision</span>
            </div>
          </header>

          <div class="player-list">
            <article
              v-for="player in team.members"
              :key="`${team.id}-${player.teamPosition}-${player.riotIdGameName}`"
              class="player-card"
            >
              <div class="player-main">
                <div>
                  <p class="player-role">{{ player.teamPosition || "UNKNOWN" }}</p>
                  <h3>{{ player.champion || "Unknown Champion" }}</h3>
                  <p class="player-id">{{ formatRiotId(player) || "Unknown Riot ID" }}</p>
                </div>
                <p class="player-kda">
                  {{ player.kills }}/{{ player.deaths }}/{{ player.assists }}
                </p>
              </div>

              <div class="stat-row">
                <span>Gold</span>
                <div class="bar-track">
                  <div
                    class="bar-fill gold"
                    :style="{ width: percentage(player.goldEarned, maxGold) }"
                  ></div>
                </div>
                <strong>{{ player.goldEarned.toLocaleString() }}</strong>
              </div>

              <div class="stat-row">
                <span>Damage</span>
                <div class="bar-track">
                  <div
                    class="bar-fill damage"
                    :style="{ width: percentage(player.totalDamageToChampions, maxDamage) }"
                  ></div>
                </div>
                <strong>{{ player.totalDamageToChampions.toLocaleString() }}</strong>
              </div>

              <div class="stat-row">
                <span>Vision</span>
                <div class="bar-track">
                  <div
                    class="bar-fill vision"
                    :style="{ width: percentage(player.visionScore, maxVision) }"
                  ></div>
                </div>
                <strong>{{ player.visionScore.toLocaleString() }}</strong>
              </div>
            </article>
          </div>
        </article>
      </section>

      <section class="note raw-note">
        <div class="section-head">
          <h2>Normalized Replay Summary</h2>
          <p>The JSON payload returned by the parser after normalization in the web app.</p>
        </div>
        <details class="json-details">
          <summary>Show normalized replay summary</summary>
          <pre>{{ JSON.stringify(summary, null, 2) }}</pre>
        </details>
      </section>
    </template>

    <section v-else-if="!isLoading" class="welcome-hint">
      <div class="hint-card">
        <h3>Ready to inspect parser output</h3>
        <p>
          Load a `.rofl` file to see extracted metadata, player stats, container details, and parser
          capabilities.
        </p>
      </div>
    </section>

    <section v-if="isLoading" class="loading-overlay">
      <div class="spinner"></div>
      <p>Parsing replay bytes...</p>
    </section>
  </main>
</template>

<style>
.analyzer-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(320px, 0.85fr);
  gap: 24px;
  margin-top: 24px;
}

.visual-pane,
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.visual-card {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.visual-header,
.section-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: start;
}

.visual-note {
  font-size: 0.94rem;
  color: var(--text-muted);
}

.availability-pill {
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.availability-pill.unavailable {
  color: var(--bad);
  background: rgba(179, 79, 67, 0.12);
  border: 1px solid rgba(179, 79, 67, 0.24);
}

.extended-grid {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}

.capability-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.capability-card {
  padding: 14px;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: #fff;
}

.capability-card.available {
  border-color: rgba(77, 125, 87, 0.3);
  background: rgba(77, 125, 87, 0.08);
}

.capability-card.unavailable {
  border-color: rgba(179, 79, 67, 0.2);
  background: rgba(179, 79, 67, 0.05);
}

.capability-state {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--text-muted);
}

.capability-card h3 {
  margin-top: 6px;
  margin-bottom: 4px;
  font-size: 1rem;
}

.capability-card p {
  font-size: 0.9rem;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 16px;
  margin: 0;
}

.detail-grid dt {
  color: var(--text-muted);
}

.detail-grid dd {
  margin: 0;
  text-align: right;
  color: #17202a;
  font-weight: 600;
}

.warning-card {
  border-top: 4px solid var(--bad);
}

.warning-list {
  margin: 0;
  padding-left: 18px;
  color: var(--text-muted);
}

.warning-list li + li {
  margin-top: 8px;
}

.segment-table-wrap {
  overflow: auto;
}

.segment-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.92rem;
}

.segment-table th,
.segment-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.segment-table th {
  color: var(--text-muted);
  font-size: 0.78rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.player-section {
  margin-top: 22px;
}

.raw-note {
  margin-top: 22px;
}

.welcome-hint {
  margin-top: 48px;
  display: flex;
  justify-content: center;
}

.hint-card {
  padding: 48px;
  text-align: center;
  border: 2px dashed var(--border);
  border-radius: 32px;
  max-width: 440px;
  background: rgba(255, 253, 249, 0.92);
}

.hint-card h3 {
  font-size: 1.5rem;
  margin-bottom: 12px;
}

.loading-overlay {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px;
  gap: 16px;
}

.spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--surface-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1100px) {
  .analyzer-layout,
  .extended-grid,
  .capability-grid {
    grid-template-columns: 1fr;
  }

  .visual-header,
  .section-head {
    flex-direction: column;
  }
}
</style>
