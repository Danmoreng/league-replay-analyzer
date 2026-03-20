<script setup lang="ts">
import { computed, ref } from "vue";

import DataBrowser from "./components/DataBrowser.vue";
import ReplayInspector from "./components/ReplayInspector.vue";
import Minimap from "./components/Minimap.vue";
import Timeline from "./components/Timeline.vue";
import Sidebar from "./components/Sidebar.vue";
import { usePlayback, type PlayerMovementData } from "./composables/usePlayback";
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
const apiMovement = ref<PlayerMovementData[]>([]);
const riotFixtureStatus = ref("No Riot fixture loaded yet.");
const parserEngine = ref("C++/Wasm");
const replayBuffer = ref<ArrayBuffer | null>(null);
const loadedReplayName = ref("");
const status = ref("Pick a replay file to parse it with the C++/Wasm replay parser.");
const errorMessage = ref("");
const isLoading = ref(false);
const activePage = ref<"summary" | "browser" | "inspector">("summary");
function toDdragonVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) {
    return "16.5.1";
  }

  return `${match[1]}.${match[2]}.1`;
}

function getChampionIconSrc(champion: string, version: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${toDdragonVersion(version)}/img/champion/${encodeURIComponent(champion)}.png`;
}

function getPlayerDisplayName(gameName?: string, tagline?: string): string {
  if (!gameName) {
    return "Unknown Player";
  }

  return tagline ? `${gameName}#${tagline}` : gameName;
}

function getRoleLabel(primary?: string, secondary?: string): string {
  const value = primary || secondary || "";
  if (!value) {
    return "Unknown";
  }

  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

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


const eventAnchoredTypes = new Set(["CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL"]);

function createMovementPlayer(participantId: number, bundle: RiotFixtureBundle): PlayerMovementData {
  const participant = bundle.match.info.participants.find((entry) => entry.participantId === participantId);
  return {
    champion: participant?.championName ?? `P${participantId}`,
    team: participant?.teamId ?? 100,
    playerName: getPlayerDisplayName(participant?.riotIdGameName, participant?.riotIdTagline),
    championIconSrc: getChampionIconSrc(participant?.championName ?? `P${participantId}`, bundle.match.info.gameVersion),
    roleLabel: getRoleLabel(participant?.lane, participant?.role),
    positions: [],
  };
}

function appendMovementPoint(
  movement: Map<number, PlayerMovementData>,
  participantId: number | undefined,
  x: number,
  y: number,
  timestamp: number,
  source: "frame" | "event",
): void {
  if (!participantId || participantId <= 0) {
    return;
  }

  const player = movement.get(participantId);
  if (!player) {
    return;
  }

  player.positions.push({ x, y, timestamp, source });
}

function normalizeMovementPositions(positions: PlayerMovementData["positions"]): PlayerMovementData["positions"] {
  const sourceRank = { frame: 0, event: 1 } as const;
  const sorted = [...positions].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      sourceRank[left.source ?? "frame"] - sourceRank[right.source ?? "frame"],
  );
  const deduped: PlayerMovementData["positions"] = [];

  for (const position of sorted) {
    const previous = deduped[deduped.length - 1];
    if (!previous) {
      deduped.push(position);
      continue;
    }

    if (previous.timestamp !== position.timestamp) {
      if (previous.x !== position.x || previous.y !== position.y) {
        deduped.push(position);
      }
      continue;
    }

    if (previous.x === position.x && previous.y === position.y) {
      continue;
    }

    if ((previous.source ?? "frame") === "frame" && position.source === "event") {
      deduped[deduped.length - 1] = position;
    }
  }

  return deduped;
}

function buildApiMovementFromBundle(bundle: RiotFixtureBundle): PlayerMovementData[] {
  const movement = new Map<number, PlayerMovementData>(
    bundle.match.info.participants.map((participant) => [
      participant.participantId,
      createMovementPlayer(participant.participantId, bundle),
    ]),
  );

  for (const frame of bundle.timeline.info.frames) {
    const participantFrames = frame.participantFrames as Record<string, { position?: { x: number; y: number } }>;
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      if (!participantFrame.position) {
        continue;
      }

      appendMovementPoint(
        movement,
        Number(rawParticipantId),
        participantFrame.position.x,
        participantFrame.position.y,
        frame.timestamp,
        "frame",
      );
    }

    for (const event of frame.events) {
      if (!eventAnchoredTypes.has(event.type) || !event.position) {
        continue;
      }

      const anchoredParticipants = new Set<number>();
      if (event.participantId && event.participantId > 0) {
        anchoredParticipants.add(event.participantId);
      }
      if (event.killerId && event.killerId > 0) {
        anchoredParticipants.add(event.killerId);
      }
      if (event.victimId && event.victimId > 0) {
        anchoredParticipants.add(event.victimId);
      }
      for (const assistingParticipantId of event.assistingParticipantIds ?? []) {
        if (assistingParticipantId > 0) {
          anchoredParticipants.add(assistingParticipantId);
        }
      }

      for (const participantId of anchoredParticipants) {
        appendMovementPoint(
          movement,
          participantId,
          event.position.x,
          event.position.y,
          event.timestamp,
          "event",
        );
      }
    }
  }

  return Array.from(movement.values())
    .map((player) => ({
      ...player,
      positions: normalizeMovementPositions(player.positions),
    }))
    .filter((player) => player.positions.length > 0)
    .sort((left, right) => {
      if (left.team !== right.team) {
        return left.team - right.team;
      }
      return left.champion.localeCompare(right.champion);
    });
}

async function loadMovementData(): Promise<string> {
  apiMovement.value = [];

  if (riotBundle.value) {
    apiMovement.value = buildApiMovementFromBundle(riotBundle.value);
    const apiValid = apiMovement.value.filter((player) => player.positions.length > 0).length;
    return apiValid > 0
      ? `(Loaded Riot timeline movement plus event anchors for ${apiValid} players)`
      : "(Riot timeline fixture did not contain participant positions)";
  }

  try {
    const apiRes = await fetch(`api-positions.json?t=${Date.now()}`);
    if (!apiRes.ok) {
      return `(No API movement fixture available: ${apiRes.status})`;
    }

    const apiRaw = await apiRes.json();
    const players = summary.value?.players ?? [];
    apiMovement.value = apiRaw.map((player: any) => {
      const summaryPlayer = players[player.participantId - 1];
      return {
        champion: summaryPlayer?.champion ?? `P${player.participantId}`,
        team: Number(summaryPlayer?.team ?? 100),
        playerName: getPlayerDisplayName(summaryPlayer?.riotIdGameName, summaryPlayer?.riotIdTagLine),
        championIconSrc: getChampionIconSrc(summaryPlayer?.champion ?? `P${player.participantId}`, summary.value?.gameVersion ?? "16.5.1"),
        roleLabel: getRoleLabel(summaryPlayer?.teamPosition),
        positions: player.positions.map((position: any) => ({
          x: position.x,
          y: position.y,
          timestamp: position.timestamp,
        })),
      };
    });

    const apiValid = apiMovement.value.filter((player) => player.positions.length > 0).length;
    return apiValid > 0
      ? `(Loaded fallback API movement for ${apiValid} players)`
      : "(Fallback API movement fixture had no positions)";
  } catch (error) {
    apiMovement.value = [];
    return `(API movement unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

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
    replayBuffer.value = buffer;
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
    const movementStatus = await loadMovementData();
    status.value = `Parsed ${file.name} successfully. ${movementStatus}`;
  } catch (error) {
    summary.value = null;
    browserModel.value = null;
    riotBundle.value = null;
    replayBuffer.value = null;
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
                    <p class="text-muted small" v-if="apiMovement.length">Riot timeline frame positions plus combat and objective event anchors rendered on the original Summoner&apos;s Rift minimap.</p>
                    <p class="text-muted small" v-else>No decoded movement frames are available yet.</p>
                  </div>
                  <span v-if="apiMovement.length" class="badge bg-success-subtle text-success-emphasis">API Movement Ready</span>
                  <span v-else class="badge bg-warning-subtle text-warning-emphasis">Movement Unavailable</span>
                </div>
                
                <div class="movement-map-frame d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-2 p-xl-3 border border-secondary border-opacity-10">
                  <Minimap
                    class="movement-map"
                    :player-data="apiMovement"
                    empty-message="No Riot timeline movement fixture is available for this replay."
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
          v-else-if="activePage === 'browser'"
          class="flex-grow-1"
          :browser="browserModel"
          :replay-name="loadedReplayName"
          :riot-bundle="riotBundle"
          :riot-fixture-status="riotFixtureStatus"
        />

        <ReplayInspector
          v-else
          class="flex-grow-1"
          :replay-buffer="replayBuffer"
          :summary="summary"
          :riot-bundle="riotBundle"
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

.movement-map-frame {
  width: 100%;
}

.movement-map {
  width: 100%;
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






