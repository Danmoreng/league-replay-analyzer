<script setup lang="ts">
import { computed, ref } from "vue";

import { parseReplayBuffer, type PlayerSummary, type ReplaySummary } from "./replayParser";

const summary = ref<ReplaySummary | null>(null);
const status = ref("Pick a replay from the repo's replays folder to parse it in the browser.");
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

const durationLabel = computed(() => {
  const totalSeconds = Math.floor((summary.value?.gameLengthMillis ?? 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
});

function formatRiotId(player: PlayerSummary): string {
  return player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}`
    : player.riotIdGameName;
}

function percentage(value: number, max: number): string {
  return `${Math.max(6, Math.round((value / max) * 100))}%`;
}

async function loadReplay(file: File): Promise<void> {
  isLoading.value = true;
  errorMessage.value = "";
  status.value = `Parsing ${file.name}...`;

  try {
    const buffer = await file.arrayBuffer();
    summary.value = parseReplayBuffer(buffer);
    status.value = `Parsed ${file.name}. Embedded stats for ${summary.value.playerCount} players are available.`;
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
    <section class="hero">
      <div>
        <p class="eyebrow">League Replay Analyzer</p>
        <h1>Fast metadata MVP from real replay bytes.</h1>
        <p class="lede">
          This first pass parses the embedded match metadata block inside a `.rofl` file and renders
          player stats directly in the browser. It is intentionally narrow, but it gives us a real
          replay-backed UI to iterate on.
        </p>
      </div>
      <label class="picker">
        <span>Load replay</span>
        <input type="file" accept=".rofl" @change="onFileChange" />
      </label>
      <p class="status" :class="{ error: errorMessage }">{{ errorMessage || status }}</p>
    </section>

    <template v-if="summary">
      <section class="summary-grid">
        <article class="metric">
          <span>Patch</span>
          <strong>{{ summary.gameVersion }}</strong>
        </article>
        <article class="metric">
          <span>Duration</span>
          <strong>{{ durationLabel }}</strong>
        </article>
        <article class="metric">
          <span>Chunks</span>
          <strong>{{ summary.lastGameChunkId }}</strong>
        </article>
        <article class="metric">
          <span>Keyframes</span>
          <strong>{{ summary.lastKeyFrameId }}</strong>
        </article>
      </section>

      <section class="team-grid">
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
                    :style="{ width: percentage(Number(player.goldEarned ?? 0), maxGold) }"
                  ></div>
                </div>
                <strong>{{ Number(player.goldEarned ?? 0).toLocaleString() }}</strong>
              </div>

              <div class="stat-row">
                <span>Damage</span>
                <div class="bar-track">
                  <div
                    class="bar-fill damage"
                    :style="{
                      width: percentage(Number(player.totalDamageToChampions ?? 0), maxDamage),
                    }"
                  ></div>
                </div>
                <strong>{{ Number(player.totalDamageToChampions ?? 0).toLocaleString() }}</strong>
              </div>

              <div class="stat-row">
                <span>Vision</span>
                <div class="bar-track">
                  <div
                    class="bar-fill vision"
                    :style="{ width: percentage(Number(player.visionScore ?? 0), maxVision) }"
                  ></div>
                </div>
                <strong>{{ Number(player.visionScore ?? 0).toLocaleString() }}</strong>
              </div>
            </article>
          </div>
        </article>
      </section>
    </template>

    <section class="note">
      <h2>Current parser scope</h2>
      <p>
        This MVP is reading the replay container's embedded metadata block and the per-player
        `statsJson` payload. The next layer is chunk parsing and timeline extraction.
      </p>
      <p v-if="isLoading">Parsing in progress.</p>
    </section>
  </main>
</template>
