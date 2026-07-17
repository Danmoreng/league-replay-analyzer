<script setup lang="ts">
import { computed, ref } from "vue";

import { usePlayback } from "../composables/usePlayback";
import type { PlayerSummary, ReplaySummary } from "../replayParser";
import type { ReplayKillEvent, ReplayKillResult } from "../replayKills";
import {
  replayObjectiveMonsterLabel,
  type ReplayObjectiveEvent,
  type ReplayObjectiveResult,
} from "../replayObjectives";

const props = defineProps<{
  summary: ReplaySummary;
  replayName: string;
  kills: ReplayKillResult | null;
  objectives: ReplayObjectiveResult | null;
  killsLoading: boolean;
  objectivesLoading: boolean;
  killsError?: string;
  objectivesError?: string;
}>();

type ProductEvent =
  | { id: string; kind: "kill"; timestampMillis: number; event: ReplayKillEvent }
  | { id: string; kind: "objective"; timestampMillis: number; event: ReplayObjectiveEvent };

const { currentTime, duration, isPlaying, playbackSpeed, togglePlayback, seek } = usePlayback();
const selectedParticipantId = ref<number | null>(null);
const speeds = [1, 2, 4, 8];

const participantsById = computed(
  () => new Map((props.kills?.participants ?? []).map((participant) => [participant.participantId, participant])),
);

const events = computed<ProductEvent[]>(() => [
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
].sort((left, right) => left.timestampMillis - right.timestampMillis));

const teams = computed(() => [100, 200].map((teamId) => {
  const players = props.summary.players
    .map((player, index) => ({ player, participantId: index + 1 }))
    .filter(({ player }) => Number(player.team) === teamId)
    .sort((left, right) => roleRank(left.player.teamPosition) - roleRank(right.player.teamPosition));

  return {
    id: teamId,
    label: teamId === 100 ? "Blue Team" : "Red Team",
    players,
    winner: players.some(({ player }) => player.win === "Win"),
    kills: players.reduce((sum, { player }) => sum + player.kills, 0),
    gold: players.reduce((sum, { player }) => sum + player.goldEarned, 0),
  };
}));

const nearbyEvents = computed(() => {
  if (events.value.length === 0) return [];
  const firstFuture = events.value.findIndex((event) => event.timestampMillis >= currentTime.value);
  const center = firstFuture < 0 ? events.value.length - 1 : firstFuture;
  return events.value.slice(Math.max(0, center - 2), Math.min(events.value.length, center + 4));
});

const decoderState = computed(() => {
  if (props.killsLoading || props.objectivesLoading) return "Replay-Ereignisse werden dekodiert …";
  if (props.killsError || props.objectivesError) return "Ein Teil der Ereignisse ist für dieses Replay nicht verfügbar.";
  return `${props.kills?.events.length ?? 0} Kills und ${props.objectives?.events.length ?? 0} Objectives aus Replay-Daten`;
});

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
  return player.riotIdTagLine ? `${player.riotIdGameName}#${player.riotIdTagLine}` : player.riotIdGameName;
}

function championIcon(champion: string): string {
  const match = props.summary.gameVersion.match(/^(\d+)\.(\d+)/);
  const version = match ? `${match[1]}.${match[2]}.1` : "16.9.1";
  return `https://ddragon.leagueoflegends.com/cdn/${version}/img/champion/${encodeURIComponent(champion)}.png`;
}

function participantChampion(participantId: number): string {
  return participantsById.value.get(participantId)?.championName ?? `P${participantId}`;
}

function markerLeft(timestampMillis: number): string {
  return `${Math.max(0, Math.min(100, (timestampMillis / Math.max(1, duration.value)) * 100))}%`;
}

function eventLabel(event: ProductEvent): string {
  if (event.kind === "objective") return replayObjectiveMonsterLabel(event.event.monsterType);
  const killer = event.event.killerParticipantId > 0
    ? participantChampion(event.event.killerParticipantId)
    : "Execution";
  return `${killer} → ${participantChampion(event.event.victimParticipantId)}`;
}

function onScrub(event: Event): void {
  seek((event.target as HTMLInputElement).valueAsNumber);
}
</script>

<template>
  <section class="product-view" aria-label="Replay viewer">
    <header class="match-scoreboard">
      <div class="score-team score-team-blue">
        <span class="score-result" :class="{ winner: teams[0].winner }">{{ teams[0].winner ? "VICTORY" : "DEFEAT" }}</span>
        <strong>{{ teams[0].kills }}</strong>
        <small>{{ formatCompact(teams[0].gold) }} Gold · final</small>
      </div>
      <div class="match-identity">
        <span class="eyebrow">REPLAY-ONLY VIEWER</span>
        <h2>{{ replayName }}</h2>
        <div class="match-meta">
          <span>Patch {{ summary.gameVersion }}</span>
          <span>{{ formatTime(summary.gameLengthMillis) }}</span>
          <span>{{ summary.players.length }} Spieler</span>
        </div>
      </div>
      <div class="score-team score-team-red">
        <strong>{{ teams[1].kills }}</strong>
        <span class="score-result" :class="{ winner: teams[1].winner }">{{ teams[1].winner ? "VICTORY" : "DEFEAT" }}</span>
        <small>{{ formatCompact(teams[1].gold) }} Gold · final</small>
      </div>
    </header>

    <div class="viewer-grid">
      <aside class="roster roster-blue" aria-label="Blue team roster">
        <div class="roster-title">
          <span class="team-pip"></span>
          <span>BLUE TEAM</span>
          <small>Finale Werte</small>
        </div>
        <button
          v-for="entry in teams[0].players"
          :key="entry.participantId"
          class="player-card"
          :class="{ selected: selectedParticipantId === entry.participantId }"
          @click="selectedParticipantId = selectedParticipantId === entry.participantId ? null : entry.participantId"
        >
          <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
          <span class="player-main">
            <span class="player-heading">
              <span><b>{{ entry.player.champion }}</b><small>{{ playerName(entry.player) }}</small></span>
              <em>{{ entry.player.kills }}/{{ entry.player.deaths }}/{{ entry.player.assists }}</em>
            </span>
            <span class="state-bars">
              <span class="unknown-bar health"><i></i><small>Leben nicht dekodiert</small></span>
              <span class="unknown-bar mana"><i></i><small>Ressource nicht dekodiert</small></span>
            </span>
            <span class="player-footer">
              <small>{{ roleLabel(entry.player.teamPosition) }}</small>
              <span class="inventory-slots" title="Inventarverlauf noch nicht dekodiert">
                <i v-for="slot in 6" :key="slot"></i>
              </span>
              <b>{{ entry.player.goldEarned.toLocaleString("de-DE") }}g <small>final</small></b>
            </span>
          </span>
        </button>
      </aside>

      <main class="map-stage">
        <div class="map-frame">
          <img src="/summoners-rift-minimap.png" alt="Summoner's Rift" />
          <div class="map-shade"></div>
          <div class="map-unavailable">
            <i class="bi bi-crosshair"></i>
            <strong>Positionsdaten noch nicht dekodiert</strong>
            <span>Die Karte ist bereit. Champion-Marker erscheinen erst, wenn replay-native Bewegung semantisch validiert ist.</span>
          </div>
          <div class="map-badge"><span></span> Replay source · lokal</div>
        </div>
        <div class="event-window">
          <div class="event-window-header">
            <span>EREIGNISSE UM {{ formatTime(currentTime) }}</span>
            <small>{{ decoderState }}</small>
          </div>
          <button
            v-for="event in nearbyEvents"
            :key="event.id"
            class="event-row"
            :class="[event.kind, { past: event.timestampMillis <= currentTime }]"
            @click="seek(event.timestampMillis)"
          >
            <time>{{ formatTime(event.timestampMillis) }}</time>
            <i class="bi" :class="event.kind === 'kill' ? 'bi-lightning-charge-fill' : 'bi-shield-fill'"></i>
            <span>{{ eventLabel(event) }}</span>
          </button>
          <div v-if="!nearbyEvents.length" class="event-empty">Keine dekodierten Ereignisse vorhanden.</div>
        </div>
      </main>

      <aside class="roster roster-red" aria-label="Red team roster">
        <div class="roster-title">
          <span class="team-pip"></span>
          <span>RED TEAM</span>
          <small>Finale Werte</small>
        </div>
        <button
          v-for="entry in teams[1].players"
          :key="entry.participantId"
          class="player-card player-card-red"
          :class="{ selected: selectedParticipantId === entry.participantId }"
          @click="selectedParticipantId = selectedParticipantId === entry.participantId ? null : entry.participantId"
        >
          <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
          <span class="player-main">
            <span class="player-heading">
              <span><b>{{ entry.player.champion }}</b><small>{{ playerName(entry.player) }}</small></span>
              <em>{{ entry.player.kills }}/{{ entry.player.deaths }}/{{ entry.player.assists }}</em>
            </span>
            <span class="state-bars">
              <span class="unknown-bar health"><i></i><small>Leben nicht dekodiert</small></span>
              <span class="unknown-bar mana"><i></i><small>Ressource nicht dekodiert</small></span>
            </span>
            <span class="player-footer">
              <small>{{ roleLabel(entry.player.teamPosition) }}</small>
              <span class="inventory-slots" title="Inventarverlauf noch nicht dekodiert">
                <i v-for="slot in 6" :key="slot"></i>
              </span>
              <b>{{ entry.player.goldEarned.toLocaleString("de-DE") }}g <small>final</small></b>
            </span>
          </span>
        </button>
      </aside>
    </div>

    <footer class="unified-timeline">
      <div class="timeline-controls">
        <button class="play-control" :aria-label="isPlaying ? 'Pause' : 'Play'" @click="togglePlayback">
          <i class="bi" :class="isPlaying ? 'bi-pause-fill' : 'bi-play-fill'"></i>
        </button>
        <div class="timecode"><strong>{{ formatTime(currentTime) }}</strong><span>/ {{ formatTime(duration) }}</span></div>
      </div>
      <div class="timeline-main">
        <div class="timeline-labels"><span>ALLE EREIGNISSE</span><small>Kills + Elite-Objectives</small></div>
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
          ><i class="bi" :class="event.kind === 'kill' ? 'bi-lightning-charge-fill' : 'bi-shield-fill'"></i></button>
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
        <div class="timeline-ticks"><span>0:00</span><span>{{ formatTime(duration * 0.25) }}</span><span>{{ formatTime(duration * 0.5) }}</span><span>{{ formatTime(duration * 0.75) }}</span><span>{{ formatTime(duration) }}</span></div>
      </div>
      <div class="speed-controls">
        <button v-for="speed in speeds" :key="speed" :class="{ active: playbackSpeed === speed }" @click="playbackSpeed = speed">{{ speed }}×</button>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.product-view { --blue: #26a7ff; --red: #ff5964; --gold: #d6af58; min-width: 0; color: #edf4ff; }
.match-scoreboard { min-height: 92px; display: grid; grid-template-columns: 1fr minmax(260px, 1.35fr) 1fr; align-items: center; gap: 20px; padding: 14px 22px; border: 1px solid rgba(143, 171, 202, .16); border-radius: 12px; background: linear-gradient(100deg, rgba(18, 62, 93, .52), rgba(7, 12, 20, .96) 43%, rgba(7, 12, 20, .96) 57%, rgba(95, 24, 35, .48)); box-shadow: 0 18px 50px rgba(0, 0, 0, .22); }
.match-identity { text-align: center; min-width: 0; }
.match-identity h2 { margin: 3px 0 5px; overflow: hidden; color: #fff; font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
.eyebrow, .roster-title, .timeline-labels span { color: #8292a8; font-size: .62rem; font-weight: 800; letter-spacing: .16em; }
.match-meta { display: flex; justify-content: center; gap: 12px; color: #7f8b9d; font-size: .7rem; }
.match-meta span + span::before { content: "·"; margin-right: 12px; }
.score-team { display: grid; align-items: center; gap: 3px 12px; }
.score-team-blue { grid-template-columns: auto auto 1fr; }
.score-team-red { grid-template-columns: 1fr auto auto; text-align: right; }
.score-team strong { grid-row: span 2; color: #fff; font-family: "Cascadia Code", monospace; font-size: 2.15rem; line-height: 1; }
.score-team-blue strong { color: var(--blue); }
.score-team-red strong { color: var(--red); order: -1; }
.score-team small { color: #8190a4; font-size: .65rem; }
.score-result { font-size: .72rem; font-weight: 900; letter-spacing: .12em; opacity: .66; }
.score-result.winner { color: #f1ce73; opacity: 1; }

.viewer-grid { display: grid; grid-template-columns: minmax(245px, 305px) minmax(420px, 1fr) minmax(245px, 305px); gap: 10px; margin-top: 10px; }
.roster, .map-stage { border: 1px solid rgba(143, 171, 202, .14); border-radius: 12px; background: rgba(8, 13, 21, .94); }
.roster { overflow: hidden; }
.roster-title { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; min-height: 38px; padding: 0 13px; border-bottom: 1px solid rgba(143, 171, 202, .12); }
.roster-title small { color: #657388; font-size: .6rem; letter-spacing: 0; text-transform: none; }
.team-pip { width: 6px; height: 6px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 10px var(--blue); }
.roster-red .team-pip { background: var(--red); box-shadow: 0 0 10px var(--red); }
.player-card { width: 100%; min-height: 112px; display: flex; gap: 10px; padding: 10px; border: 0; border-bottom: 1px solid rgba(143, 171, 202, .09); background: transparent; color: inherit; text-align: left; transition: .16s ease; }
.player-card:last-child { border-bottom: 0; }
.player-card:hover, .player-card.selected { background: linear-gradient(90deg, rgba(38, 167, 255, .12), transparent); }
.player-card-red:hover, .player-card-red.selected { background: linear-gradient(90deg, rgba(255, 89, 100, .12), transparent); }
.player-card > img { width: 42px; height: 42px; flex: 0 0 42px; border: 2px solid rgba(38, 167, 255, .72); border-radius: 9px; object-fit: cover; }
.player-card-red > img { border-color: rgba(255, 89, 100, .72); }
.player-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 7px; }
.player-heading, .player-footer { display: flex; justify-content: space-between; align-items: center; gap: 7px; }
.player-heading > span { min-width: 0; display: flex; flex-direction: column; }
.player-heading b { overflow: hidden; color: #f6f8fc; font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
.player-heading small, .player-footer > small { overflow: hidden; color: #6f7c90; font-size: .58rem; text-overflow: ellipsis; white-space: nowrap; }
.player-heading em { color: #d9e3f0; font-family: "Cascadia Code", monospace; font-size: .69rem; font-style: normal; font-weight: 700; }
.state-bars { display: flex; flex-direction: column; gap: 3px; }
.unknown-bar { position: relative; height: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,.06); border-radius: 2px; background: rgba(255,255,255,.045); }
.unknown-bar i { position: absolute; inset: 0; background: repeating-linear-gradient(135deg, transparent 0 6px, rgba(255,255,255,.035) 6px 9px); }
.unknown-bar small { position: absolute; inset: -1px 4px auto auto; color: rgba(210,220,234,.42); font-size: .43rem; line-height: 8px; }
.health { box-shadow: inset 2px 0 #397f5c; }
.mana { box-shadow: inset 2px 0 #315f93; }
.player-footer b { margin-left: auto; color: #d7bd78; font-size: .62rem; white-space: nowrap; }
.player-footer b small { color: #71684f; font-size: .48rem; font-weight: 500; }
.inventory-slots { display: flex; gap: 2px; }
.inventory-slots i { width: 12px; height: 12px; border: 1px solid rgba(151, 163, 180, .17); border-radius: 2px; background: rgba(0, 0, 0, .2); }

.map-stage { display: flex; min-width: 0; flex-direction: column; padding: 10px; }
.map-frame { position: relative; width: 100%; min-height: 420px; flex: 1; overflow: hidden; border: 1px solid rgba(151, 174, 201, .16); border-radius: 9px; background: #070b10; }
.map-frame > img { width: 100%; height: 100%; position: absolute; inset: 0; object-fit: cover; filter: saturate(.72) brightness(.55) contrast(1.08); }
.map-shade { position: absolute; inset: 0; background: radial-gradient(circle at center, transparent 15%, rgba(3,7,12,.24) 70%, rgba(3,7,12,.62)); }
.map-unavailable { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 28px; text-align: center; }
.map-unavailable i { width: 58px; height: 58px; display: grid; place-items: center; margin-bottom: 13px; border: 1px solid rgba(166,190,220,.22); border-radius: 50%; background: rgba(5,10,16,.66); color: #8ba4c0; font-size: 1.5rem; box-shadow: 0 12px 30px rgba(0,0,0,.28); }
.map-unavailable strong { color: #dce7f5; font-size: .86rem; }
.map-unavailable span { max-width: 46ch; margin-top: 5px; color: #8392a6; font-size: .66rem; line-height: 1.55; }
.map-badge { position: absolute; top: 12px; left: 12px; padding: 5px 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 5px; background: rgba(4,8,13,.76); color: #9cabbf; font-size: .55rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.map-badge span { width: 5px; height: 5px; display: inline-block; margin-right: 5px; border-radius: 50%; background: #4fe093; box-shadow: 0 0 7px #4fe093; }
.event-window { margin-top: 8px; border: 1px solid rgba(143,171,202,.12); border-radius: 8px; background: #080d14; }
.event-window-header { min-height: 31px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 0 9px; border-bottom: 1px solid rgba(143,171,202,.1); color: #8393a8; font-size: .56rem; font-weight: 800; letter-spacing: .1em; }
.event-window-header small { color: #5f6e82; font-size: .52rem; font-weight: 500; letter-spacing: 0; }
.event-row { width: 100%; display: grid; grid-template-columns: 38px 16px 1fr; gap: 5px; padding: 5px 9px; border: 0; border-bottom: 1px solid rgba(143,171,202,.07); background: transparent; color: #aab8ca; text-align: left; font-size: .62rem; }
.event-row:hover { background: rgba(255,255,255,.04); }
.event-row.past { opacity: .56; }
.event-row time { color: #6f7d91; font-family: monospace; }
.event-row.kill i { color: var(--red); }
.event-row.objective i { color: var(--gold); }
.event-empty { padding: 16px; color: #69778b; font-size: .65rem; text-align: center; }

.unified-timeline { display: grid; grid-template-columns: auto minmax(300px, 1fr) auto; align-items: center; gap: 18px; min-height: 104px; margin-top: 10px; padding: 12px 18px; border: 1px solid rgba(143,171,202,.16); border-radius: 12px; background: #080d14; }
.timeline-controls { display: flex; align-items: center; gap: 12px; }
.play-control { width: 40px; height: 40px; display: grid; place-items: center; border: 1px solid rgba(70,182,255,.42); border-radius: 50%; background: rgba(30,140,212,.14); color: #7bcbff; font-size: 1.1rem; }
.timecode { display: flex; min-width: 88px; flex-direction: column; font-family: "Cascadia Code", monospace; }
.timecode strong { color: #f3f7fc; font-size: .92rem; }
.timecode span { color: #627086; font-size: .58rem; }
.timeline-main { min-width: 0; }
.timeline-labels { display: flex; align-items: center; justify-content: space-between; margin-bottom: 11px; }
.timeline-labels small { color: #627086; font-size: .56rem; }
.timeline-track { position: relative; height: 8px; border-radius: 4px; background: #1a2330; }
.timeline-track input { position: absolute; z-index: 4; inset: -7px 0; width: 100%; height: 22px; margin: 0; opacity: 0; cursor: pointer; }
.timeline-progress { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: linear-gradient(90deg, #297eb6, #4db9f7); }
.event-marker { position: absolute; z-index: 5; top: 50%; width: 18px; height: 18px; display: grid; place-items: center; padding: 0; transform: translate(-50%, -50%); border: 1px solid currentColor; border-radius: 50%; background: #0a111a; font-size: .52rem; cursor: pointer; }
.event-marker.kill { color: var(--red); }
.event-marker.objective { color: var(--gold); }
.timeline-ticks { display: flex; justify-content: space-between; margin-top: 10px; color: #536176; font-family: monospace; font-size: .5rem; }
.speed-controls { display: flex; gap: 3px; padding: 3px; border: 1px solid rgba(143,171,202,.1); border-radius: 6px; background: rgba(255,255,255,.025); }
.speed-controls button { padding: 4px 7px; border: 0; border-radius: 4px; background: transparent; color: #67758a; font-size: .6rem; font-weight: 700; }
.speed-controls button.active { background: #1b5b82; color: #d9f1ff; }

@media (max-width: 1280px) {
  .viewer-grid { grid-template-columns: 240px minmax(380px, 1fr) 240px; }
  .player-card { min-height: 105px; padding: 8px; }
  .player-card > img { width: 36px; height: 36px; flex-basis: 36px; }
  .inventory-slots i { width: 9px; height: 9px; }
}

@media (max-width: 980px) {
  .viewer-grid { grid-template-columns: 1fr 1fr; }
  .map-stage { grid-column: 1 / -1; grid-row: 1; }
  .roster { grid-row: 2; }
}

@media (max-width: 680px) {
  .match-scoreboard { grid-template-columns: 1fr 1fr; }
  .match-identity { grid-column: 1 / -1; grid-row: 1; }
  .viewer-grid { grid-template-columns: 1fr; }
  .map-stage, .roster { grid-column: auto; grid-row: auto; }
  .unified-timeline { grid-template-columns: 1fr; }
  .speed-controls { justify-self: start; }
}
</style>
