<!-- Focused product surface: match score, combat timeline, and compact rosters. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { usePlayback } from "../composables/usePlayback";
import { loadReplayItemCatalog, type ReplayItemCatalog } from "../replayItemCatalog";
import type { ReplayDirectItemPurchasesResult } from "../replayDirectItemPurchases";
import type { ReplayItemSalesResult } from "../replayItemSales";
import type { ReplayKillEvent, ReplayKillResult } from "../replayKills";
import {
  replayObjectiveMonsterLabel,
  type ReplayObjectiveEvent,
  type ReplayObjectiveResult,
} from "../replayObjectives";
import type { ReplayParticipantStatSnapshotsResult } from "../replayParticipantStatSnapshots";
import type { PlayerSummary, ReplaySummary } from "../replayParser";
import type { ReplayPurchaseLinkedItemUpdatesResult } from "../replayPurchaseLinkedItemUpdates";
import type { ReplayWardResult } from "../replayWards";

const props = defineProps<{
  summary: ReplaySummary;
  replayName: string;
  kills: ReplayKillResult | null;
  objectives: ReplayObjectiveResult | null;
  wards: ReplayWardResult | null;
  purchaseLinkedItemUpdates: ReplayPurchaseLinkedItemUpdatesResult | null;
  directItemPurchases: ReplayDirectItemPurchasesResult | null;
  itemSales: ReplayItemSalesResult | null;
  participantStatSnapshots: ReplayParticipantStatSnapshotsResult | null;
  killsLoading: boolean;
  objectivesLoading: boolean;
  wardsLoading: boolean;
  purchaseLinkedItemUpdatesLoading: boolean;
  directItemPurchasesLoading: boolean;
  itemSalesLoading: boolean;
  participantStatSnapshotsLoading: boolean;
  killsError?: string;
  objectivesError?: string;
  wardsError?: string;
  purchaseLinkedItemUpdatesError?: string;
  directItemPurchasesError?: string;
  itemSalesError?: string;
  participantStatSnapshotsError?: string;
}>();

type ProductEvent =
  | { id: string; kind: "kill"; timestampMillis: number; event: ReplayKillEvent }
  | { id: string; kind: "objective"; timestampMillis: number; event: ReplayObjectiveEvent };

interface TimelineKda {
  kills: number;
  deaths: number;
  assists: number;
}

interface CurrentParticipantStats {
  participantId: number;
  timestampMillis: number;
  level: number | null;
  laneCs: number;
  jungleCs: number;
}

const { currentTime, duration, isPlaying, playbackSpeed, togglePlayback, seek } = usePlayback();
const selectedParticipantId = ref<number | null>(null);
const staticCatalog = ref<ReplayItemCatalog | null>(null);
const speeds = [1, 2, 4, 8];
let catalogRequest = 0;

const participantsById = computed(
  () => new Map(props.summary.players.map((player, index) => [index + 1, player])),
);

const events = computed<ProductEvent[]>(() =>
  [
    ...(props.kills?.events ?? []).map((event, index) => ({
      id: `kill-${index}-${event.timestampMillis}`,
      kind: "kill" as const,
      timestampMillis: event.timestampMillis,
      event,
    })),
    ...(props.objectives?.events ?? []).map((event, index) => ({
      id: `objective-${index}-${event.timestampMillis}`,
      kind: "objective" as const,
      timestampMillis: event.timestampMillis,
      event,
    })),
  ].sort((left, right) => left.timestampMillis - right.timestampMillis),
);

const counts = computed(() => ({
  kills: props.kills?.events.length ?? 0,
  objectives: props.objectives?.events.length ?? 0,
}));

const kdaByParticipant = computed(() => {
  const rows = new Map<number, TimelineKda>();
  const row = (participantId: number): TimelineKda => {
    const existing = rows.get(participantId);
    if (existing) return existing;
    const created = { kills: 0, deaths: 0, assists: 0 };
    rows.set(participantId, created);
    return created;
  };
  for (const event of props.kills?.events ?? []) {
    if (event.timestampMillis > currentTime.value) break;
    row(event.victimParticipantId).deaths += 1;
    if (event.killerParticipantId > 0) row(event.killerParticipantId).kills += 1;
    for (const assistant of event.assistingParticipantIds) row(assistant).assists += 1;
  }
  return rows;
});

const participantStatSnapshotRows = computed<CurrentParticipantStats[]>(() => {
  const rows: CurrentParticipantStats[] = [];
  for (const snapshot of props.participantStatSnapshots?.snapshots ?? []) {
    if (
      !Number.isInteger(snapshot.participantId) ||
      !Number.isFinite(snapshot.timestampMillis) ||
      (snapshot.level !== null && !Number.isInteger(snapshot.level)) ||
      !Number.isFinite(snapshot.laneMinionsKilled) ||
      !Number.isInteger(snapshot.neutralMinionsKilled)
    ) {
      continue;
    }
    rows.push({
      participantId: snapshot.participantId,
      timestampMillis: snapshot.timestampMillis,
      level: snapshot.level,
      laneCs: snapshot.laneMinionsKilled,
      jungleCs: snapshot.neutralMinionsKilled,
    });
  }
  return rows.sort(
    (left, right) =>
      left.participantId - right.participantId || left.timestampMillis - right.timestampMillis,
  );
});

const currentParticipantStatsById = computed(() => {
  const rows = new Map<number, CurrentParticipantStats>();
  for (const snapshot of participantStatSnapshotRows.value) {
    if (snapshot.timestampMillis > currentTime.value) continue;
    rows.set(snapshot.participantId, snapshot);
  }
  return rows;
});

const teams = computed(() =>
  [100, 200].map((teamId) => {
    const players = props.summary.players
      .map((player, index) => ({ player, participantId: index + 1 }))
      .filter(({ player }) => Number(player.team) === teamId)
      .sort(
        (left, right) => roleRank(left.player.teamPosition) - roleRank(right.player.teamPosition),
      );
    return {
      id: teamId,
      label: teamId === 100 ? "Blue Team" : "Red Team",
      players,
      winner: players.some(({ player }) => player.win === "Win"),
      timelineKills: players.reduce(
        (sum, player) => sum + timelineKda(player.participantId).kills,
        0,
      ),
    };
  }),
);

const nearbyEvents = computed(() => {
  let source = events.value;
  if (selectedParticipantId.value !== null) {
    source = source.filter((event) => eventInvolves(event, selectedParticipantId.value!));
  }
  if (source.length === 0) return [];
  const local = source.filter(
    (event) => Math.abs(event.timestampMillis - currentTime.value) <= 90_000,
  );
  return (local.length ? local : source)
    .map((event) => ({
      event,
      distance: Math.abs(event.timestampMillis - currentTime.value),
      priority: event.kind === "kill" ? 0 : 1,
    }))
    .sort((left, right) => left.distance - right.distance || left.priority - right.priority)
    .slice(0, 8)
    .map((entry) => entry.event)
    .sort((left, right) => left.timestampMillis - right.timestampMillis);
});

watch(
  () => props.summary.gameVersion,
  async (gameVersion) => {
    const request = ++catalogRequest;
    staticCatalog.value = null;
    const loaded = await loadReplayItemCatalog(gameVersion);
    if (request === catalogRequest && loaded.available) staticCatalog.value = loaded.catalog;
  },
  { immediate: true },
);

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function roleRank(role: string): number {
  const normalized = role.toLowerCase();
  if (normalized.includes("top")) return 0;
  if (normalized.includes("jungle")) return 1;
  if (normalized.includes("mid")) return 2;
  if (normalized.includes("bottom") || normalized.includes("bot")) return 3;
  if (normalized.includes("support") || normalized.includes("utility")) return 4;
  return 5;
}

function roleLabel(role: string): string {
  if (!role) return "Unknown";
  return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
}

function playerName(player: PlayerSummary): string {
  if (!player.riotIdGameName) return "Unknown Player";
  return player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}`
    : player.riotIdGameName;
}

function ddragonVersion(): string {
  if (staticCatalog.value) return staticCatalog.value.dataDragonVersion;
  const match = props.summary.gameVersion.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.1` : "16.14.1";
}

function championIcon(champion: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion()}/img/champion/${encodeURIComponent(champion)}.png`;
}

function participantChampion(participantId: number): string {
  return participantsById.value.get(participantId)?.champion ?? `P${participantId}`;
}

function timelineKda(participantId: number): TimelineKda {
  return kdaByParticipant.value.get(participantId) ?? { kills: 0, deaths: 0, assists: 0 };
}

function currentParticipantStats(participantId: number): CurrentParticipantStats | null {
  return currentParticipantStatsById.value.get(participantId) ?? null;
}

function markerLeft(timestampMillis: number): string {
  const percentage = (timestampMillis / Math.max(1, duration.value)) * 100;
  return `${Math.max(0, Math.min(100, percentage))}%`;
}

function eventInvolves(event: ProductEvent, participantId: number): boolean {
  if (event.kind === "objective") return true;
  return (
    event.event.victimParticipantId === participantId ||
    event.event.killerParticipantId === participantId ||
    event.event.assistingParticipantIds.includes(participantId)
  );
}

function eventLabel(event: ProductEvent): string {
  if (event.kind === "objective") return replayObjectiveMonsterLabel(event.event.monsterType);
  const killer =
    event.event.killerParticipantId > 0
      ? participantChampion(event.event.killerParticipantId)
      : "Execution";
  return `${killer} → ${participantChampion(event.event.victimParticipantId)}`;
}

function eventIcon(event: ProductEvent): string {
  return event.kind === "kill" ? "bi-lightning-charge-fill" : "bi-shield-fill";
}

function onScrub(event: Event): void {
  seek((event.target as HTMLInputElement).valueAsNumber);
}
</script>

<template>
  <section class="product-view" aria-label="Replay viewer">
    <header class="match-scoreboard">
      <div class="score-team score-team-blue">
        <span :class="{ winner: teams[0].winner }">{{
          teams[0].winner ? "VICTORY" : "DEFEAT"
        }}</span>
        <strong>{{ teams[0].timelineKills }}</strong>
      </div>
      <div class="match-identity">
        <h2>{{ replayName }}</h2>
        <div class="match-meta">
          <span>{{ summary.gameVersion }}</span>
          <span>{{ formatTime(summary.gameLengthMillis) }}</span>
        </div>
      </div>
      <div class="score-team score-team-red">
        <strong>{{ teams[1].timelineKills }}</strong>
        <span :class="{ winner: teams[1].winner }">{{
          teams[1].winner ? "VICTORY" : "DEFEAT"
        }}</span>
      </div>
    </header>

    <section class="timeline-card" aria-label="Match timeline">
      <header class="timeline-heading">
        <strong>Timeline</strong>
        <div class="timeline-legend">
          <span class="kill"><i></i>{{ counts.kills }}</span>
          <span class="objective"><i></i>{{ counts.objectives }}</span>
        </div>
      </header>

      <div class="timeline-layout">
        <div class="timeline-controls">
          <button
            class="play-control"
            :aria-label="isPlaying ? 'Pause' : 'Play'"
            @click="togglePlayback"
          >
            <i class="bi" :class="isPlaying ? 'bi-pause-fill' : 'bi-play-fill'"></i>
          </button>
          <div class="timecode">
            <strong>{{ formatTime(currentTime) }}</strong>
            <span>/ {{ formatTime(duration) }}</span>
          </div>
        </div>

        <div class="timeline-main">
          <div class="timeline-track">
            <div class="timeline-progress" :style="{ width: markerLeft(currentTime) }"></div>
            <button
              v-for="event in events"
              :key="event.id"
              class="event-marker"
              :class="event.kind"
              :style="{ left: markerLeft(event.timestampMillis) }"
              :title="`${formatTime(event.timestampMillis)} · ${eventLabel(event)}`"
              @click="seek(event.timestampMillis)"
            >
              <i class="bi" :class="eventIcon(event)"></i>
            </button>
            <input
              type="range"
              :min="0"
              :max="duration"
              :value="currentTime"
              :step="100"
              aria-label="Replay timeline"
              @input="onScrub"
            />
          </div>
          <div class="timeline-ticks">
            <span>0:00</span>
            <span>{{ formatTime(duration * 0.25) }}</span>
            <span>{{ formatTime(duration * 0.5) }}</span>
            <span>{{ formatTime(duration * 0.75) }}</span>
            <span>{{ formatTime(duration) }}</span>
          </div>
        </div>

        <div class="speed-controls">
          <button
            v-for="speed in speeds"
            :key="speed"
            :class="{ active: playbackSpeed === speed }"
            @click="playbackSpeed = speed"
          >
            {{ speed }}×
          </button>
        </div>
      </div>
    </section>

    <div class="viewer-grid">
      <aside
        v-for="team in teams"
        :key="team.id"
        class="roster"
        :class="team.id === 100 ? 'roster-blue' : 'roster-red'"
      >
        <div class="roster-title">
          <span class="team-pip"></span>
          <span>{{ team.label }}</span>
        </div>

        <button
          v-for="entry in team.players"
          :key="entry.participantId"
          class="player-card"
          :class="[
            { selected: selectedParticipantId === entry.participantId },
            team.id === 200 ? 'player-card-red' : '',
          ]"
          @click="
            selectedParticipantId =
              selectedParticipantId === entry.participantId ? null : entry.participantId
          "
        >
          <span class="champion-portrait">
            <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
            <small v-if="currentParticipantStats(entry.participantId)?.level != null">
              {{ currentParticipantStats(entry.participantId)!.level }}
            </small>
          </span>

          <span class="player-main">
            <span class="player-heading">
              <span>
                <b>{{ entry.player.champion }}</b>
                <small>{{ playerName(entry.player) }}</small>
              </span>
              <em>
                {{ timelineKda(entry.participantId).kills }}/{{
                  timelineKda(entry.participantId).deaths
                }}/{{ timelineKda(entry.participantId).assists }}
              </em>
            </span>
            <span class="player-stats">
              <span>{{ roleLabel(entry.player.teamPosition) }}</span>
              <span v-if="currentParticipantStats(entry.participantId)" class="participant-cs">
                <span>
                  {{ Math.trunc(currentParticipantStats(entry.participantId)!.laneCs) }} Lane
                </span>
                <span>{{ currentParticipantStats(entry.participantId)!.jungleCs }} Jungle</span>
              </span>
            </span>
          </span>
        </button>
      </aside>

      <main class="event-focus">
        <header class="event-window-header">
          <strong>{{ formatTime(currentTime) }}</strong>
          <button
            v-if="selectedParticipantId !== null"
            class="clear-filter"
            @click="selectedParticipantId = null"
          >
            {{ participantChampion(selectedParticipantId) }} ×
          </button>
        </header>

        <div class="event-list">
          <button
            v-for="event in nearbyEvents"
            :key="event.id"
            class="event-row"
            :class="[event.kind, { past: event.timestampMillis <= currentTime }]"
            @click="seek(event.timestampMillis)"
          >
            <time>{{ formatTime(event.timestampMillis) }}</time>
            <span class="event-symbol" :class="event.kind">
              <i class="bi" :class="eventIcon(event)"></i>
            </span>
            <b>{{ eventLabel(event) }}</b>
          </button>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.product-view {
  --blue: #26a7ff;
  --red: #ff5964;
  --gold: #d6af58;
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 10px;
  color: #edf4ff;
}

.match-scoreboard,
.timeline-card,
.roster,
.event-focus {
  border: 1px solid rgba(143, 171, 202, 0.16);
  border-radius: 12px;
  background: #080d14;
}

.match-scoreboard {
  min-height: 68px;
  display: grid;
  grid-template-columns: 1fr minmax(260px, 1.35fr) 1fr;
  align-items: center;
  gap: 20px;
  padding: 10px 22px;
  background: linear-gradient(
    100deg,
    rgba(18, 62, 93, 0.52),
    #070c14 43%,
    #070c14 57%,
    rgba(95, 24, 35, 0.48)
  );
}

.match-identity {
  min-width: 0;
  text-align: center;
}

.match-identity h2 {
  margin: 0 0 5px;
  overflow: hidden;
  color: #fff;
  font-size: 0.94rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.match-meta {
  display: flex;
  justify-content: center;
  gap: 18px;
  color: #718096;
  font-size: 0.62rem;
}

.score-team {
  display: flex;
  align-items: center;
  gap: 12px;
  color: #718096;
  font-size: 0.62rem;
  font-weight: 900;
  letter-spacing: 0.12em;
}

.score-team-red {
  justify-content: flex-end;
}

.score-team strong {
  color: var(--blue);
  font-family: "Cascadia Code", monospace;
  font-size: 2rem;
  line-height: 1;
}

.score-team-red strong {
  color: var(--red);
}

.score-team .winner {
  color: #f1ce73;
}

.timeline-card {
  padding: 12px 16px;
  border-color: rgba(77, 185, 247, 0.26);
}

.timeline-heading,
.timeline-layout,
.timeline-controls,
.timeline-legend,
.player-heading,
.player-stats,
.event-window-header {
  display: flex;
  align-items: center;
}

.timeline-heading {
  justify-content: space-between;
  margin-bottom: 9px;
}

.timeline-heading strong {
  font-size: 0.78rem;
}

.timeline-legend {
  gap: 13px;
  color: #8292a8;
  font-size: 0.58rem;
}

.timeline-legend span {
  display: flex;
  align-items: center;
  gap: 5px;
}

.timeline-legend i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.timeline-legend .kill {
  color: var(--red);
}

.timeline-legend .objective {
  color: var(--gold);
}

.timeline-layout {
  display: grid;
  grid-template-columns: auto minmax(300px, 1fr) auto;
  gap: 16px;
}

.timeline-controls {
  gap: 10px;
}

.play-control {
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(70, 182, 255, 0.46);
  border-radius: 50%;
  background: rgba(30, 140, 212, 0.14);
  color: #7bcbff;
  font-size: 1rem;
}

.timecode {
  display: flex;
  min-width: 82px;
  flex-direction: column;
  font-family: "Cascadia Code", monospace;
}

.timecode strong {
  font-size: 0.9rem;
}

.timecode span {
  color: #627086;
  font-size: 0.55rem;
}

.timeline-main {
  min-width: 0;
}

.timeline-track {
  position: relative;
  height: 24px;
  border: 1px solid rgba(143, 171, 202, 0.1);
  border-radius: 6px;
  background: #0c131d;
}

.timeline-track input {
  position: absolute;
  z-index: 4;
  inset: -7px 0;
  width: 100%;
  height: 38px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.timeline-progress {
  position: absolute;
  z-index: 1;
  inset: 0 auto 0 0;
  border-radius: 5px;
  background: rgba(45, 151, 216, 0.3);
}

.event-marker {
  position: absolute;
  z-index: 5;
  top: 50%;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  transform: translate(-50%, -50%);
  border: 1px solid currentColor;
  border-radius: 50%;
  background: #0a111a;
  font-size: 0.5rem;
  cursor: pointer;
}

.event-marker.kill,
.event-symbol.kill {
  color: var(--red);
}

.event-marker.objective,
.event-symbol.objective {
  color: var(--gold);
}

.timeline-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: #536176;
  font-family: monospace;
  font-size: 0.49rem;
}

.speed-controls {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid rgba(143, 171, 202, 0.1);
  border-radius: 6px;
}

.speed-controls button,
.clear-filter {
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #67758a;
  font-size: 0.58rem;
  font-weight: 700;
}

.speed-controls button {
  padding: 4px 7px;
}

.speed-controls button.active {
  background: #1b5b82;
  color: #d9f1ff;
}

.viewer-grid {
  display: grid;
  grid-template-columns: minmax(250px, 310px) minmax(340px, 1fr) minmax(250px, 310px);
  grid-template-areas: "blue events red";
  gap: 10px;
  align-items: start;
}

.roster {
  overflow: hidden;
}

.roster-blue {
  grid-area: blue;
}

.roster-red {
  grid-area: red;
}

.roster-title {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
  color: #8292a8;
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.13em;
}

.team-pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 8px var(--blue);
}

.roster-red .team-pip {
  background: var(--red);
  box-shadow: 0 0 8px var(--red);
}

.player-card {
  width: 100%;
  min-height: 70px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border: 0;
  border-bottom: 1px solid rgba(143, 171, 202, 0.08);
  border-left: 2px solid transparent;
  background: transparent;
  color: inherit;
  text-align: left;
}

.player-card:hover,
.player-card.selected {
  background: rgba(45, 154, 221, 0.08);
}

.player-card.selected {
  border-left-color: var(--blue);
}

.player-card-red.selected {
  border-left-color: var(--red);
  background: rgba(221, 62, 79, 0.08);
}

.champion-portrait {
  position: relative;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
}

.champion-portrait img {
  width: 100%;
  height: 100%;
  border: 1px solid rgba(38, 167, 255, 0.62);
  border-radius: 8px;
  object-fit: cover;
}

.player-card-red .champion-portrait img {
  border-color: rgba(255, 89, 100, 0.64);
}

.champion-portrait small {
  position: absolute;
  right: -3px;
  bottom: -3px;
  min-width: 16px;
  padding: 1px 3px;
  border: 1px solid rgba(143, 171, 202, 0.28);
  border-radius: 5px;
  background: #0a111a;
  color: #fff;
  font-family: "Cascadia Code", monospace;
  font-size: 0.5rem;
  text-align: center;
}

.player-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.player-heading,
.player-stats {
  justify-content: space-between;
}

.player-heading > span {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.player-heading b,
.event-row b {
  overflow: hidden;
  color: #f6f8fc;
  font-size: 0.72rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-heading small,
.player-stats {
  color: #6f7c90;
  font-size: 0.52rem;
}

.participant-cs {
  display: flex;
  gap: 7px;
  color: #8ba5bd;
  font-family: "Cascadia Code", monospace;
}

.player-heading em {
  color: #d9e3f0;
  font-family: "Cascadia Code", monospace;
  font-size: 0.65rem;
  font-style: normal;
  font-weight: 700;
}

.event-focus {
  grid-area: events;
  min-height: 100%;
  overflow: hidden;
}

.event-window-header {
  min-height: 42px;
  justify-content: space-between;
  padding: 0 11px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
}

.event-window-header strong {
  font-size: 0.82rem;
}

.clear-filter {
  padding: 4px 7px;
  border: 1px solid rgba(77, 185, 247, 0.22);
  background: rgba(41, 126, 182, 0.12);
  color: #9edcff;
}

.event-list {
  min-height: 250px;
}

.event-row {
  width: 100%;
  min-height: 44px;
  display: grid;
  grid-template-columns: 42px 27px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 0;
  border-bottom: 1px solid rgba(143, 171, 202, 0.07);
  background: transparent;
  color: #aab8ca;
  text-align: left;
}

.event-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.event-row.past {
  opacity: 0.62;
}

.event-row time {
  color: #6f7d91;
  font-family: monospace;
  font-size: 0.6rem;
}

.event-symbol {
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(143, 171, 202, 0.14);
  border-radius: 6px;
  background: #0b121b;
  font-size: 0.7rem;
}

@media (max-width: 1180px) {
  .viewer-grid {
    grid-template-columns: 1fr 1fr;
    grid-template-areas: "events events" "blue red";
  }
}

@media (max-width: 820px) {
  .match-scoreboard {
    grid-template-columns: 1fr 1fr;
  }

  .match-identity {
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .timeline-layout {
    grid-template-columns: 1fr;
  }

  .speed-controls {
    justify-self: start;
  }
}

@media (max-width: 620px) {
  .viewer-grid {
    grid-template-columns: 1fr;
    grid-template-areas: "events" "blue" "red";
  }
}
</style>
