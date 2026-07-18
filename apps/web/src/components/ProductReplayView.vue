<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { usePlayback } from "../composables/usePlayback";
import type { PlayerSummary, ReplaySummary } from "../replayParser";
import type { ReplayKillEvent, ReplayKillResult } from "../replayKills";
import {
  replayObjectiveMonsterLabel,
  type ReplayObjectiveEvent,
  type ReplayObjectiveResult,
} from "../replayObjectives";
import {
  buildReplayWardPositionResearchMarkers,
  buildReplayWardPositionReviews,
  filterReplayWardPositionReviews,
  listReplayWardPositionHypotheses,
  replayWardPositionResearchCompatibility,
  wardFloatApiFitHypothesisId,
  type ReplayWardPositionResearchMarker,
  type ReplayWardPositionResearchResult,
  type ReplayWardPositionReview,
  type ReplayWardPositionReviewFilter,
} from "../replayWardPositionResearch";
import type { ReplayWardEvent, ReplayWardResult } from "../replayWards";

const props = defineProps<{
  summary: ReplaySummary;
  replayName: string;
  kills: ReplayKillResult | null;
  objectives: ReplayObjectiveResult | null;
  wards: ReplayWardResult | null;
  wardPositionCandidates: ReplayWardPositionResearchResult | null;
  killsLoading: boolean;
  objectivesLoading: boolean;
  wardsLoading: boolean;
  wardPositionCandidatesLoading: boolean;
  killsError?: string;
  objectivesError?: string;
  wardsError?: string;
  wardPositionCandidatesError?: string;
}>();

type ProductEvent =
  | { id: string; kind: "kill"; timestampMillis: number; event: ReplayKillEvent }
  | { id: string; kind: "objective"; timestampMillis: number; event: ReplayObjectiveEvent }
  | {
      id: string;
      kind: "ward-placement" | "ward-kill";
      timestampMillis: number;
      event: ReplayWardEvent;
    };

const { currentTime, duration, isPlaying, playbackSpeed, togglePlayback, seek } = usePlayback();
const selectedParticipantId = ref<number | null>(null);
const wardResearchEnabled = ref(true);
const wardResearchVisibility = ref<"all-placements" | "timeline">("all-placements");
const wardResearchShowActive = ref(true);
const wardResearchShowPulses = ref(true);
const selectedWardHypothesisId = ref("");
const wardReviewFilter = ref<ReplayWardPositionReviewFilter>("all");
const speeds = [1, 2, 4, 8];
const wardReviewFilters = ["all", "mapped", "unresolved"] as const;

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
    ...(props.wards?.events ?? []).map((event, index) => ({
      id: `ward-${index}-${event.timestampMillis}-${event.wardEntityNetworkId}`,
      kind: event.type === "WARD_PLACED" ? ("ward-placement" as const) : ("ward-kill" as const),
      timestampMillis: event.timestampMillis,
      event,
    })),
  ].sort((left, right) => left.timestampMillis - right.timestampMillis),
);

const wardCounts = computed(() => ({
  placements: props.wards?.events.filter((event) => event.type === "WARD_PLACED").length ?? 0,
  kills: props.wards?.events.filter((event) => event.type === "WARD_KILL").length ?? 0,
}));
const wardResearchBinding = computed(() => {
  if (!props.wards || !props.wardPositionCandidates) return null;
  return replayWardPositionResearchCompatibility(props.wards, props.wardPositionCandidates);
});
const wardHypotheses = computed(() => {
  if (!props.wards || !props.wardPositionCandidates) return [];
  return listReplayWardPositionHypotheses(props.wards, props.wardPositionCandidates);
});
const selectedWardHypothesis = computed(
  () =>
    wardHypotheses.value.find((hypothesis) => hypothesis.id === selectedWardHypothesisId.value) ??
    null,
);
const wardPositionReviews = computed(() => {
  if (!props.wards || !props.wardPositionCandidates) return [];
  return buildReplayWardPositionReviews(
    props.wards,
    props.wardPositionCandidates,
    selectedWardHypothesisId.value || wardFloatApiFitHypothesisId,
  );
});
const wardReviewCounts = computed(() => {
  const mapped = wardPositionReviews.value.filter((review) => review.status === "mapped").length;
  return {
    all: wardPositionReviews.value.length,
    mapped,
    unresolved: wardPositionReviews.value.length - mapped,
  };
});
const filteredWardPositionReviews = computed(() =>
  filterReplayWardPositionReviews(wardPositionReviews.value, wardReviewFilter.value),
);
const wardResearchMarkers = computed(() => {
  if (
    !wardResearchEnabled.value ||
    !props.wards ||
    !props.wardPositionCandidates ||
    !selectedWardHypothesisId.value
  ) {
    return [];
  }

  return buildReplayWardPositionResearchMarkers(
    props.wards,
    props.wardPositionCandidates,
    selectedWardHypothesisId.value,
    currentTime.value,
    {
      visibilityMode: wardResearchVisibility.value,
      showActiveLinkedWards: wardResearchShowActive.value,
      showEventPulses: wardResearchShowPulses.value,
    },
  );
});
const wardResearchStatus = computed(() => {
  if (props.wardPositionCandidatesLoading) return "Replay-Pakete werden ausgewertet …";
  if (props.wardPositionCandidatesError) return props.wardPositionCandidatesError;
  if (!props.wards) return "Produktiver Ward-Lifecycle ist nicht verfügbar.";
  if (!props.wardPositionCandidates) return "Keine Positionshypothesen für dieses Replay.";
  if (wardResearchBinding.value && !wardResearchBinding.value.compatible) {
    return wardResearchBinding.value.reason ?? "Research-Daten passen nicht zum Replay.";
  }
  if (!wardPositionReviews.value.length) return "Keine Ward-Platzierungen in diesem Replay.";
  return `${wardReviewCounts.value.mapped}/${wardReviewCounts.value.all} Platzierungen mit experimentellem Koordinatenkandidaten · ${wardResearchMarkers.value.length} sichtbar`;
});

watch(
  wardHypotheses,
  (hypotheses) => {
    if (hypotheses.some((hypothesis) => hypothesis.id === selectedWardHypothesisId.value)) return;
    selectedWardHypothesisId.value =
      hypotheses.find((hypothesis) => hypothesis.id === wardFloatApiFitHypothesisId)?.id ??
      hypotheses[0]?.id ??
      "";
  },
  { immediate: true },
);
const finalPlayerStatsAvailable = computed(
  () => props.summary.capabilities.validatedFinalPlayerStatsAvailable === true,
);

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
      kills: players.reduce((sum, { player }) => sum + player.kills, 0),
      gold: players.reduce((sum, { player }) => sum + player.goldEarned, 0),
    };
  }),
);

const nearbyEvents = computed(() => {
  if (events.value.length === 0) return [];
  const firstFuture = events.value.findIndex((event) => event.timestampMillis >= currentTime.value);
  const center = firstFuture < 0 ? events.value.length - 1 : firstFuture;
  return events.value.slice(Math.max(0, center - 2), Math.min(events.value.length, center + 4));
});

const decoderState = computed(() => {
  if (props.killsLoading || props.objectivesLoading || props.wardsLoading)
    return "Replay-Ereignisse werden dekodiert …";
  if (props.killsError || props.objectivesError || props.wardsError)
    return "Ein Teil der Ereignisse ist für dieses Replay nicht verfügbar.";
  return `${props.kills?.events.length ?? 0} Kills · ${props.objectives?.events.length ?? 0} Objectives · ${wardCounts.value.placements} exakte Standard-Ward-Platzierungen · ${wardCounts.value.kills} konservative Ward-Kills`;
});

function formatTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("de-DE", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
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
  const match = props.summary.gameVersion.match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}.1` : "16.9.1";
}

function championIcon(champion: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion()}/img/champion/${encodeURIComponent(champion)}.png`;
}

function itemIcon(itemId: number): string {
  return `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion()}/img/item/${itemId}.png`;
}

function finalItems(player: PlayerSummary): number[] {
  return [...player.items, 0, 0, 0, 0, 0, 0, 0].slice(0, 7);
}

function totalCs(player: PlayerSummary): number {
  return player.laneMinionsKilled + player.neutralMinionsKilled;
}

function participantChampion(participantId: number): string {
  return participantsById.value.get(participantId)?.champion ?? `P${participantId}`;
}

function participantTeamClass(participantId: number): "blue" | "red" | "unknown" {
  const team = Number(participantsById.value.get(participantId)?.team);
  if (team === 100) return "blue";
  if (team === 200) return "red";
  return "unknown";
}

function wardResearchMarkerTitle(marker: ReplayWardPositionResearchMarker): string {
  const removal = marker.removalTimestampMillis
    ? ` · entfernt ${formatTime(marker.removalTimestampMillis)}`
    : " · Entfernung nicht sicher dekodiert";
  return `EXPERIMENTELL / API-OFFLINE-FIT / NICHT PROMOTET · ${participantChampion(marker.ownerParticipantId)} · platziert ${formatTime(marker.placementTimestampMillis)}${removal} · X ${marker.x.toFixed(1)} / Y ${marker.y.toFixed(1)} · ${marker.xSource} + ${marker.ySource}`;
}

function wardReviewEvidence(review: ReplayWardPositionReview): string {
  if (review.candidate) {
    return `X ${review.candidate.x.toFixed(1)} · Y ${review.candidate.y.toFixed(1)}`;
  }
  return review.missingEvidence[0] ?? "Koordinatenevidenz fehlt.";
}

function markerLeft(timestampMillis: number): string {
  return `${Math.max(0, Math.min(100, (timestampMillis / Math.max(1, duration.value)) * 100))}%`;
}

function eventLabel(event: ProductEvent): string {
  if (event.kind === "objective") return replayObjectiveMonsterLabel(event.event.monsterType);
  if (event.kind === "ward-placement" && event.event.type === "WARD_PLACED") {
    return `${participantChampion(event.event.ownerParticipantId)} platziert Ward`;
  }
  if (event.kind === "ward-kill" && event.event.type === "WARD_KILL") {
    return `${participantChampion(event.event.killerParticipantId)} zerstört Ward`;
  }
  if (event.kind !== "kill") return "Ward-Ereignis";
  const killer =
    event.event.killerParticipantId > 0
      ? participantChampion(event.event.killerParticipantId)
      : "Execution";
  return `${killer} → ${participantChampion(event.event.victimParticipantId)}`;
}

function eventIcon(event: ProductEvent): string {
  if (event.kind === "kill") return "bi-lightning-charge-fill";
  if (event.kind === "objective") return "bi-shield-fill";
  return event.kind === "ward-placement" ? "bi-eye-fill" : "bi-eye-slash-fill";
}

function onScrub(event: Event): void {
  seek((event.target as HTMLInputElement).valueAsNumber);
}
</script>

<template>
  <section class="product-view" aria-label="Replay viewer">
    <header class="match-scoreboard">
      <div class="score-team score-team-blue">
        <span class="score-result" :class="{ winner: teams[0].winner }">{{
          teams[0].winner ? "VICTORY" : "DEFEAT"
        }}</span>
        <strong>{{ teams[0].kills }}</strong>
        <small>{{ formatCompact(teams[0].gold) }} Gold verdient · final</small>
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
        <span class="score-result" :class="{ winner: teams[1].winner }">{{
          teams[1].winner ? "VICTORY" : "DEFEAT"
        }}</span>
        <small>{{ formatCompact(teams[1].gold) }} Gold verdient · final</small>
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
          @click="
            selectedParticipantId =
              selectedParticipantId === entry.participantId ? null : entry.participantId
          "
        >
          <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
          <span class="player-main">
            <span class="player-heading">
              <span
                ><b>{{ entry.player.champion }}</b
                ><small>{{ playerName(entry.player) }}</small></span
              >
              <em>{{ entry.player.kills }}/{{ entry.player.deaths }}/{{ entry.player.assists }}</em>
            </span>
            <span class="state-bars">
              <span class="unknown-bar health"><i></i><small>Leben nicht dekodiert</small></span>
              <span class="unknown-bar mana"><i></i><small>Ressource nicht dekodiert</small></span>
            </span>
            <span v-if="finalPlayerStatsAvailable" class="final-stats">
              <span :title="`${entry.player.experience.toLocaleString('de-DE')} XP · final`"
                ><i class="bi bi-star-fill"></i> Lv {{ entry.player.level }}</span
              >
              <span
                :title="`${entry.player.laneMinionsKilled} Lane + ${entry.player.neutralMinionsKilled} Neutral · final`"
                ><i class="bi bi-stack"></i> {{ totalCs(entry.player) }} CS</span
              >
              <span
                :title="`${entry.player.wardsPlaced} platziert / ${entry.player.wardsKilled} zerstört · exakter finaler Replay-Wert`"
                ><i class="bi bi-eye-fill"></i> {{ entry.player.wardsPlaced }}/{{
                  entry.player.wardsKilled
                }}</span
              >
            </span>
            <span v-else class="final-stats unavailable"
              ><i class="bi bi-slash-circle"></i> Finaldaten für diesen Patch nicht validiert</span
            >
            <span class="player-footer">
              <small>{{ roleLabel(entry.player.teamPosition) }}</small>
              <span
                v-if="finalPlayerStatsAvailable"
                class="inventory-slots"
                title="Exaktes finales Inventar; kein Inventarverlauf"
              >
                <span
                  v-for="(itemId, slot) in finalItems(entry.player)"
                  :key="slot"
                  class="inventory-slot"
                  :class="{ empty: itemId === 0 }"
                >
                  <img v-if="itemId > 0" :src="itemIcon(itemId)" :alt="`Item ${itemId}`" />
                </span>
              </span>
              <span
                v-else
                class="inventory-slots unavailable"
                title="Finaldaten für diesen Patch nicht validiert"
              >
                <span v-for="slot in 7" :key="slot" class="inventory-slot empty"></span>
              </span>
              <b
                >{{ entry.player.goldEarned.toLocaleString("de-DE") }}g
                <small>verdient · final</small></b
              >
            </span>
          </span>
        </button>
      </aside>

      <main class="map-stage">
        <section class="ward-research-controls" aria-label="Experimentelle Live-Ward-Positionen">
          <div class="ward-research-heading">
            <span>EXPERIMENTELL · ROFL-LIVE / API-OFFLINE-FIT</span>
            <strong>Live-Ward-Kandidaten</strong>
            <small>{{ wardResearchStatus }}</small>
          </div>
          <label class="ward-hypothesis-select">
            <span>Modell</span>
            <select
              v-model="selectedWardHypothesisId"
              :disabled="!wardHypotheses.length || !wardResearchEnabled"
            >
              <option
                v-for="hypothesis in wardHypotheses"
                :key="hypothesis.id"
                :value="hypothesis.id"
              >
                {{ hypothesis.label }} · {{ Math.round(hypothesis.coverage * 100) }}%
              </option>
            </select>
          </label>
          <div class="ward-research-modes" aria-label="Ward marker visibility">
            <button
              :class="{ active: wardResearchVisibility === 'all-placements' }"
              :disabled="!wardResearchEnabled"
              @click="wardResearchVisibility = 'all-placements'"
            >
              Alle mappbaren Kandidaten
            </button>
            <button
              :class="{ active: wardResearchVisibility === 'timeline' }"
              :disabled="!wardResearchEnabled"
              @click="wardResearchVisibility = 'timeline'"
            >
              Timeline / Lifecycle
            </button>
          </div>
          <button
            class="ward-layer-toggle"
            :class="{ active: wardResearchEnabled }"
            :aria-pressed="wardResearchEnabled"
            @click="wardResearchEnabled = !wardResearchEnabled"
          >
            <i class="bi" :class="wardResearchEnabled ? 'bi-eye-fill' : 'bi-eye-slash'"></i>
            {{ wardResearchEnabled ? "Layer an" : "Layer aus" }}
          </button>
          <div
            v-if="wardResearchVisibility === 'timeline' && wardResearchEnabled"
            class="ward-timeline-options"
          >
            <label>
              <input v-model="wardResearchShowActive" type="checkbox" />
              verknüpfte aktive Wards
            </label>
            <label>
              <input v-model="wardResearchShowPulses" type="checkbox" />
              5-Sekunden-Ereignispulse
            </label>
          </div>
          <p v-if="selectedWardHypothesis" class="ward-hypothesis-description">
            <b>{{ selectedWardHypothesis.id }}</b>
            <span v-if="selectedWardHypothesis.description">
              · {{ selectedWardHypothesis.description }}
            </span>
            <small>
              X: {{ selectedWardHypothesis.xSource }} · Y: {{ selectedWardHypothesis.ySource }}
            </small>
            <small>
              Lifecycle-Invariant: 701/745 verknüpfte Removals besitzen denselben vollständigen
              Primary+Companion-Spawn-Fingerprint wie ihre Platzierung.
            </small>
          </p>
        </section>

        <div class="map-frame" :class="{ 'research-layer-visible': wardResearchMarkers.length }">
          <img src="/summoners-rift-minimap.png" alt="Summoner's Rift" />
          <div class="map-shade"></div>
          <div v-if="wardResearchMarkers.length" class="ward-research-layer">
            <button
              v-for="marker in wardResearchMarkers"
              :key="`${marker.hypothesisId}-${marker.wardEntityNetworkId}`"
              class="ward-research-marker"
              :class="[
                `team-${participantTeamClass(marker.ownerParticipantId)}`,
                `state-${marker.state}`,
              ]"
              :style="{ left: `${marker.leftPercent}%`, top: `${marker.topPercent}%` }"
              :title="wardResearchMarkerTitle(marker)"
              :aria-label="wardResearchMarkerTitle(marker)"
              @click="seek(marker.placementTimestampMillis)"
            >
              <i class="bi" :class="marker.state === 'kill-pulse' ? 'bi-x-lg' : 'bi-eye-fill'"></i>
            </button>
          </div>
          <div v-else class="map-unavailable">
            <i class="bi bi-crosshair"></i>
            <strong>Keine experimentellen Marker sichtbar</strong>
            <span>{{ wardResearchStatus }}</span>
          </div>
          <div class="ward-research-warning">
            <strong>NICHT PROMOTET · VISUELL PRÜFEN</strong>
            <span
              >Die Marker werden live aus den Spawn-Paketbytes des geladenen .rofl berechnet. Die
              Symbol→Float-Tabelle wurde offline an 95 gespeicherten Riot-Timeline-Killankern
              gefittet; zur Laufzeit fließen keine API-, Client- oder Vanguard-Daten ein. Nur
              48/2.625 Corpus-Platzierungen sind abgedeckt.</span
            >
          </div>
          <div class="map-badge"><span></span> Replay source · lokal</div>
        </div>
        <section class="ward-review-panel" aria-label="Ward position research review">
          <header class="ward-review-header">
            <span>
              <strong>WARD-PLACEMENT-PRÜFLISTE</strong>
              <small>
                {{ wardReviewCounts.mapped }}/{{ wardReviewCounts.all }} mit Kandidat ·
                {{ wardReviewCounts.unresolved }} ohne Koordinate
              </small>
            </span>
            <span class="ward-review-method">
              Methode: {{ selectedWardHypothesisId || wardFloatApiFitHypothesisId }} · Confidence:
              experimentell / API-offline-fit
            </span>
            <span class="ward-review-filters" aria-label="Ward review filter">
              <button
                v-for="filter in wardReviewFilters"
                :key="filter"
                :class="{ active: wardReviewFilter === filter }"
                @click="wardReviewFilter = filter"
              >
                {{ filter === "all" ? "Alle" : filter === "mapped" ? "Mit Kandidat" : "Offen" }}
                ({{ wardReviewCounts[filter] }})
              </button>
            </span>
          </header>
          <div v-if="filteredWardPositionReviews.length" class="ward-review-list">
            <button
              v-for="review in filteredWardPositionReviews"
              :key="`${review.timestampMillis}-${review.wardEntityNetworkId}`"
              class="ward-review-row"
              :class="review.status"
              :title="review.missingEvidence.join(' ') || wardReviewEvidence(review)"
              @click="seek(review.timestampMillis)"
            >
              <time>{{ formatTime(review.timestampMillis) }}</time>
              <span class="ward-review-owner">{{
                participantChampion(review.ownerParticipantId)
              }}</span>
              <code>{{ review.wardEntityNetworkIdHex }}</code>
              <b>{{ review.status === "mapped" ? "KANDIDAT" : "OFFEN" }}</b>
              <small>{{ wardReviewEvidence(review) }}</small>
            </button>
          </div>
          <p v-else class="ward-review-empty">
            Keine Platzierungen für diesen Filter. Ohne passenden Research-Datensatz werden keine
            Koordinaten geraten.
          </p>
        </section>
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
            <i class="bi" :class="eventIcon(event)"></i>
            <span>{{ eventLabel(event) }}</span>
          </button>
          <div v-if="!nearbyEvents.length" class="event-empty">
            Keine dekodierten Ereignisse vorhanden.
          </div>
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
          @click="
            selectedParticipantId =
              selectedParticipantId === entry.participantId ? null : entry.participantId
          "
        >
          <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
          <span class="player-main">
            <span class="player-heading">
              <span
                ><b>{{ entry.player.champion }}</b
                ><small>{{ playerName(entry.player) }}</small></span
              >
              <em>{{ entry.player.kills }}/{{ entry.player.deaths }}/{{ entry.player.assists }}</em>
            </span>
            <span class="state-bars">
              <span class="unknown-bar health"><i></i><small>Leben nicht dekodiert</small></span>
              <span class="unknown-bar mana"><i></i><small>Ressource nicht dekodiert</small></span>
            </span>
            <span v-if="finalPlayerStatsAvailable" class="final-stats">
              <span :title="`${entry.player.experience.toLocaleString('de-DE')} XP · final`"
                ><i class="bi bi-star-fill"></i> Lv {{ entry.player.level }}</span
              >
              <span
                :title="`${entry.player.laneMinionsKilled} Lane + ${entry.player.neutralMinionsKilled} Neutral · final`"
                ><i class="bi bi-stack"></i> {{ totalCs(entry.player) }} CS</span
              >
              <span
                :title="`${entry.player.wardsPlaced} platziert / ${entry.player.wardsKilled} zerstört · exakter finaler Replay-Wert`"
                ><i class="bi bi-eye-fill"></i> {{ entry.player.wardsPlaced }}/{{
                  entry.player.wardsKilled
                }}</span
              >
            </span>
            <span v-else class="final-stats unavailable"
              ><i class="bi bi-slash-circle"></i> Finaldaten für diesen Patch nicht validiert</span
            >
            <span class="player-footer">
              <small>{{ roleLabel(entry.player.teamPosition) }}</small>
              <span
                v-if="finalPlayerStatsAvailable"
                class="inventory-slots"
                title="Exaktes finales Inventar; kein Inventarverlauf"
              >
                <span
                  v-for="(itemId, slot) in finalItems(entry.player)"
                  :key="slot"
                  class="inventory-slot"
                  :class="{ empty: itemId === 0 }"
                >
                  <img v-if="itemId > 0" :src="itemIcon(itemId)" :alt="`Item ${itemId}`" />
                </span>
              </span>
              <span
                v-else
                class="inventory-slots unavailable"
                title="Finaldaten für diesen Patch nicht validiert"
              >
                <span v-for="slot in 7" :key="slot" class="inventory-slot empty"></span>
              </span>
              <b
                >{{ entry.player.goldEarned.toLocaleString("de-DE") }}g
                <small>verdient · final</small></b
              >
            </span>
          </span>
        </button>
      </aside>
    </div>

    <footer class="unified-timeline">
      <div class="timeline-controls">
        <button
          class="play-control"
          :aria-label="isPlaying ? 'Pause' : 'Play'"
          @click="togglePlayback"
        >
          <i class="bi" :class="isPlaying ? 'bi-pause-fill' : 'bi-play-fill'"></i>
        </button>
        <div class="timecode">
          <strong>{{ formatTime(currentTime) }}</strong
          ><span>/ {{ formatTime(duration) }}</span>
        </div>
      </div>
      <div class="timeline-main">
        <div class="timeline-labels">
          <span>ALLE EREIGNISSE</span
          ><small
            >Kills · Elite-Objectives · Standard-Ward platziert · Ward zerstört (konservativ)</small
          >
        </div>
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
          <span>0:00</span><span>{{ formatTime(duration * 0.25) }}</span
          ><span>{{ formatTime(duration * 0.5) }}</span
          ><span>{{ formatTime(duration * 0.75) }}</span
          ><span>{{ formatTime(duration) }}</span>
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
    </footer>
  </section>
</template>

<style scoped>
.product-view {
  --blue: #26a7ff;
  --red: #ff5964;
  --gold: #d6af58;
  min-width: 0;
  color: #edf4ff;
}
.match-scoreboard {
  min-height: 92px;
  display: grid;
  grid-template-columns: 1fr minmax(260px, 1.35fr) 1fr;
  align-items: center;
  gap: 20px;
  padding: 14px 22px;
  border: 1px solid rgba(143, 171, 202, 0.16);
  border-radius: 12px;
  background: linear-gradient(
    100deg,
    rgba(18, 62, 93, 0.52),
    rgba(7, 12, 20, 0.96) 43%,
    rgba(7, 12, 20, 0.96) 57%,
    rgba(95, 24, 35, 0.48)
  );
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.22);
}
.match-identity {
  text-align: center;
  min-width: 0;
}
.match-identity h2 {
  margin: 3px 0 5px;
  overflow: hidden;
  color: #fff;
  font-size: 1rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.eyebrow,
.roster-title,
.timeline-labels span {
  color: #8292a8;
  font-size: 0.62rem;
  font-weight: 800;
  letter-spacing: 0.16em;
}
.match-meta {
  display: flex;
  justify-content: center;
  gap: 12px;
  color: #7f8b9d;
  font-size: 0.7rem;
}
.match-meta span + span::before {
  content: "·";
  margin-right: 12px;
}
.score-team {
  display: grid;
  align-items: center;
  gap: 3px 12px;
}
.score-team-blue {
  grid-template-columns: auto auto 1fr;
}
.score-team-red {
  grid-template-columns: 1fr auto auto;
  text-align: right;
}
.score-team strong {
  grid-row: span 2;
  color: #fff;
  font-family: "Cascadia Code", monospace;
  font-size: 2.15rem;
  line-height: 1;
}
.score-team-blue strong {
  color: var(--blue);
}
.score-team-red strong {
  color: var(--red);
  order: -1;
}
.score-team small {
  color: #8190a4;
  font-size: 0.65rem;
}
.score-result {
  font-size: 0.72rem;
  font-weight: 900;
  letter-spacing: 0.12em;
  opacity: 0.66;
}
.score-result.winner {
  color: #f1ce73;
  opacity: 1;
}

.viewer-grid {
  display: grid;
  grid-template-columns: minmax(245px, 305px) minmax(420px, 1fr) minmax(245px, 305px);
  gap: 10px;
  margin-top: 10px;
}
.roster,
.map-stage {
  border: 1px solid rgba(143, 171, 202, 0.14);
  border-radius: 12px;
  background: rgba(8, 13, 21, 0.94);
}
.roster {
  overflow: hidden;
}
.roster-title {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 0 13px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.12);
}
.roster-title small {
  color: #657388;
  font-size: 0.6rem;
  letter-spacing: 0;
  text-transform: none;
}
.team-pip {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 10px var(--blue);
}
.roster-red .team-pip {
  background: var(--red);
  box-shadow: 0 0 10px var(--red);
}
.player-card {
  width: 100%;
  min-height: 112px;
  display: flex;
  gap: 10px;
  padding: 10px;
  border: 0;
  border-bottom: 1px solid rgba(143, 171, 202, 0.09);
  background: transparent;
  color: inherit;
  text-align: left;
  transition: 0.16s ease;
}
.player-card:last-child {
  border-bottom: 0;
}
.player-card:hover,
.player-card.selected {
  background: linear-gradient(90deg, rgba(38, 167, 255, 0.12), transparent);
}
.player-card-red:hover,
.player-card-red.selected {
  background: linear-gradient(90deg, rgba(255, 89, 100, 0.12), transparent);
}
.player-card > img {
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border: 2px solid rgba(38, 167, 255, 0.72);
  border-radius: 9px;
  object-fit: cover;
}
.player-card-red > img {
  border-color: rgba(255, 89, 100, 0.72);
}
.player-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.player-heading,
.player-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 7px;
}
.player-heading > span {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.player-heading b {
  overflow: hidden;
  color: #f6f8fc;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-heading small,
.player-footer > small {
  overflow: hidden;
  color: #6f7c90;
  font-size: 0.58rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.player-heading em {
  color: #d9e3f0;
  font-family: "Cascadia Code", monospace;
  font-size: 0.69rem;
  font-style: normal;
  font-weight: 700;
}
.state-bars {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.unknown-bar {
  position: relative;
  height: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.045);
}
.unknown-bar i {
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    135deg,
    transparent 0 6px,
    rgba(255, 255, 255, 0.035) 6px 9px
  );
}
.unknown-bar small {
  position: absolute;
  inset: -1px 4px auto auto;
  color: rgba(210, 220, 234, 0.42);
  font-size: 0.43rem;
  line-height: 8px;
}
.health {
  box-shadow: inset 2px 0 #397f5c;
}
.mana {
  box-shadow: inset 2px 0 #315f93;
}
.final-stats {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8c9bb0;
  font-size: 0.53rem;
  font-weight: 700;
}
.final-stats span {
  white-space: nowrap;
}
.final-stats i {
  margin-right: 2px;
  color: #8094ad;
  font-size: 0.5rem;
}
.final-stats.unavailable {
  color: #6f7c90;
  font-weight: 600;
}
.player-footer b {
  margin-left: auto;
  color: #d7bd78;
  font-size: 0.62rem;
  white-space: nowrap;
}
.player-footer b small {
  color: #71684f;
  font-size: 0.48rem;
  font-weight: 500;
}
.inventory-slots {
  display: flex;
  gap: 2px;
}
.inventory-slot {
  width: 15px;
  height: 15px;
  overflow: hidden;
  border: 1px solid rgba(151, 163, 180, 0.24);
  border-radius: 2px;
  background: rgba(0, 0, 0, 0.3);
}
.inventory-slot.empty {
  opacity: 0.42;
}
.inventory-slots.unavailable {
  filter: saturate(0);
  opacity: 0.62;
}
.inventory-slot img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.map-stage {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 10px;
}
.ward-research-controls {
  display: grid;
  grid-template-columns: minmax(150px, 0.8fr) minmax(170px, 1.2fr) auto auto;
  align-items: end;
  gap: 8px;
  margin-bottom: 8px;
  padding: 9px;
  border: 1px solid rgba(255, 178, 72, 0.24);
  border-radius: 8px;
  background: linear-gradient(100deg, rgba(88, 48, 12, 0.22), rgba(8, 13, 20, 0.98));
}
.ward-research-heading {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.ward-research-heading > span {
  color: #ffb348;
  font-size: 0.52rem;
  font-weight: 900;
  letter-spacing: 0.13em;
}
.ward-research-heading strong {
  color: #f2f5fa;
  font-size: 0.75rem;
}
.ward-research-heading small {
  overflow: hidden;
  color: #8e9caf;
  font-size: 0.54rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ward-hypothesis-select {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  color: #8190a4;
  font-size: 0.52rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.ward-hypothesis-select select {
  width: 100%;
  min-height: 29px;
  border: 1px solid rgba(255, 181, 73, 0.25);
  border-radius: 5px;
  background: #0d141e;
  color: #dce7f3;
  font-size: 0.61rem;
}
.ward-research-modes {
  display: flex;
  padding: 3px;
  border: 1px solid rgba(143, 171, 202, 0.12);
  border-radius: 6px;
  background: #080d14;
}
.ward-research-modes button,
.ward-layer-toggle {
  min-height: 27px;
  padding: 4px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #738197;
  font-size: 0.55rem;
  font-weight: 700;
  white-space: nowrap;
}
.ward-research-modes button.active,
.ward-layer-toggle.active {
  background: rgba(236, 155, 51, 0.18);
  color: #ffc46f;
}
.ward-layer-toggle {
  border: 1px solid rgba(143, 171, 202, 0.12);
  background: #080d14;
}
.ward-timeline-options,
.ward-hypothesis-description {
  grid-column: 1 / -1;
}
.ward-timeline-options {
  display: flex;
  gap: 18px;
  color: #8a99ad;
  font-size: 0.57rem;
}
.ward-timeline-options label {
  display: flex;
  align-items: center;
  gap: 5px;
}
.ward-hypothesis-description {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  margin: 0;
  color: #9eabbc;
  font-size: 0.55rem;
}
.ward-hypothesis-description b {
  color: #d7e0eb;
}
.ward-hypothesis-description small {
  margin-left: auto;
  overflow: hidden;
  color: #66758a;
  font-family: "Cascadia Code", monospace;
  font-size: 0.5rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.map-frame {
  position: relative;
  width: 100%;
  max-width: min(100%, 820px);
  min-height: 0;
  aspect-ratio: 1 / 1;
  align-self: center;
  flex: none;
  overflow: hidden;
  border: 1px solid rgba(151, 174, 201, 0.16);
  border-radius: 9px;
  background: #070b10;
}
.map-frame > img {
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
  object-fit: contain;
  filter: saturate(0.72) brightness(0.55) contrast(1.08);
}
.map-frame.research-layer-visible > img {
  filter: saturate(0.9) brightness(0.67) contrast(1.08);
}
.map-shade {
  position: absolute;
  inset: 0;
  background: radial-gradient(
    circle at center,
    transparent 15%,
    rgba(3, 7, 12, 0.24) 70%,
    rgba(3, 7, 12, 0.62)
  );
}
.ward-research-layer {
  position: absolute;
  z-index: 3;
  inset: 0;
}
.ward-research-marker {
  --marker-color: #e3eaf2;
  position: absolute;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  padding: 0;
  transform: translate(-50%, -50%);
  border: 1px solid rgba(255, 255, 255, 0.84);
  border-radius: 50%;
  background: color-mix(in srgb, var(--marker-color) 78%, #06101a);
  color: #fff;
  font-size: 0.56rem;
  box-shadow:
    0 0 0 2px rgba(4, 9, 15, 0.72),
    0 0 11px var(--marker-color);
  cursor: pointer;
}
.ward-research-marker:hover,
.ward-research-marker:focus-visible {
  z-index: 5;
  transform: translate(-50%, -50%) scale(1.42);
  outline: 2px solid #fff;
}
.ward-research-marker.team-blue {
  --marker-color: #23a9ff;
}
.ward-research-marker.team-red {
  --marker-color: #ff5964;
}
.ward-research-marker.state-all-placement {
  opacity: 0.76;
}
.ward-research-marker.state-active-linked {
  opacity: 1;
}
.ward-research-marker.state-placement-pulse {
  animation: ward-placement-pulse 1.2s ease-out infinite;
}
.ward-research-marker.state-kill-pulse {
  --marker-color: #c49aff;
  animation: ward-kill-pulse 0.8s ease-in-out infinite alternate;
}
.ward-research-warning {
  position: absolute;
  z-index: 4;
  right: 10px;
  bottom: 10px;
  max-width: min(72%, 440px);
  padding: 7px 9px;
  border: 1px solid rgba(255, 178, 72, 0.35);
  border-radius: 6px;
  background: rgba(20, 14, 7, 0.88);
  color: #ac9c88;
  font-size: 0.52rem;
  line-height: 1.4;
  pointer-events: none;
}
.ward-research-warning strong {
  margin-right: 6px;
  color: #ffb348;
  font-size: 0.54rem;
  letter-spacing: 0.08em;
}
.ward-review-panel {
  margin-top: 8px;
  overflow: hidden;
  border: 1px solid rgba(255, 178, 72, 0.2);
  border-radius: 8px;
  background: #080d14;
}
.ward-review-header {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 9px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
}
.ward-review-header > span:first-child {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.ward-review-header strong {
  color: #ffc46f;
  font-size: 0.56rem;
  letter-spacing: 0.1em;
}
.ward-review-header small,
.ward-review-method {
  color: #7e8ca0;
  font-size: 0.52rem;
}
.ward-review-method {
  grid-column: 1 / -1;
  grid-row: 2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ward-review-filters {
  display: flex;
  gap: 3px;
}
.ward-review-filters button {
  min-height: 25px;
  padding: 3px 6px;
  border: 1px solid rgba(143, 171, 202, 0.12);
  border-radius: 4px;
  background: #0c131d;
  color: #77869a;
  font-size: 0.51rem;
  font-weight: 700;
}
.ward-review-filters button.active {
  border-color: rgba(255, 178, 72, 0.3);
  background: rgba(236, 155, 51, 0.16);
  color: #ffc46f;
}
.ward-review-list {
  max-height: 184px;
  overflow-y: auto;
}
.ward-review-row {
  width: 100%;
  display: grid;
  grid-template-columns: 38px minmax(72px, 1fr) 78px 52px;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 0;
  border-bottom: 1px solid rgba(143, 171, 202, 0.07);
  border-left: 2px solid #b47c3d;
  background: transparent;
  color: #9baabd;
  text-align: left;
  font-size: 0.56rem;
}
.ward-review-row.mapped {
  border-left-color: #4fe093;
}
.ward-review-row:hover,
.ward-review-row:focus-visible {
  background: rgba(255, 255, 255, 0.045);
  outline: none;
}
.ward-review-row time,
.ward-review-row code {
  color: #78879a;
  font-family: "Cascadia Code", monospace;
}
.ward-review-owner {
  overflow: hidden;
  color: #c2cfde;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ward-review-row b {
  color: #dca55f;
  font-size: 0.49rem;
  letter-spacing: 0.06em;
}
.ward-review-row.mapped b {
  color: #65dda1;
}
.ward-review-row small {
  grid-column: 1 / -1;
  overflow: hidden;
  color: #77869a;
  font-size: 0.52rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ward-review-empty {
  margin: 0;
  padding: 14px;
  color: #69778b;
  font-size: 0.58rem;
  text-align: center;
}
.map-unavailable {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  padding: 28px;
  text-align: center;
}
.map-unavailable i {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  margin-bottom: 13px;
  border: 1px solid rgba(166, 190, 220, 0.22);
  border-radius: 50%;
  background: rgba(5, 10, 16, 0.66);
  color: #8ba4c0;
  font-size: 1.5rem;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
}
.map-unavailable strong {
  color: #dce7f5;
  font-size: 0.86rem;
}
.map-unavailable span {
  max-width: 46ch;
  margin-top: 5px;
  color: #8392a6;
  font-size: 0.66rem;
  line-height: 1.55;
}
.map-badge {
  position: absolute;
  z-index: 4;
  top: 12px;
  left: 12px;
  padding: 5px 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 5px;
  background: rgba(4, 8, 13, 0.76);
  color: #9cabbf;
  font-size: 0.55rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.map-badge span {
  width: 5px;
  height: 5px;
  display: inline-block;
  margin-right: 5px;
  border-radius: 50%;
  background: #4fe093;
  box-shadow: 0 0 7px #4fe093;
}
@keyframes ward-placement-pulse {
  0% {
    box-shadow:
      0 0 0 2px rgba(4, 9, 15, 0.72),
      0 0 0 0 var(--marker-color);
  }
  100% {
    box-shadow:
      0 0 0 2px rgba(4, 9, 15, 0.72),
      0 0 0 12px transparent;
  }
}
@keyframes ward-kill-pulse {
  from {
    opacity: 0.52;
  }
  to {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1.24);
  }
}
.event-window {
  margin-top: 8px;
  border: 1px solid rgba(143, 171, 202, 0.12);
  border-radius: 8px;
  background: #080d14;
}
.event-window-header {
  min-height: 31px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 9px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
  color: #8393a8;
  font-size: 0.56rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}
.event-window-header small {
  color: #5f6e82;
  font-size: 0.52rem;
  font-weight: 500;
  letter-spacing: 0;
}
.event-row {
  width: 100%;
  display: grid;
  grid-template-columns: 38px 16px 1fr;
  gap: 5px;
  padding: 5px 9px;
  border: 0;
  border-bottom: 1px solid rgba(143, 171, 202, 0.07);
  background: transparent;
  color: #aab8ca;
  text-align: left;
  font-size: 0.62rem;
}
.event-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.event-row.past {
  opacity: 0.56;
}
.event-row time {
  color: #6f7d91;
  font-family: monospace;
}
.event-row.kill i {
  color: var(--red);
}
.event-row.objective i {
  color: var(--gold);
}
.event-row.ward-placement i {
  color: #56d6c2;
}
.event-row.ward-kill i {
  color: #b596ee;
}
.event-empty {
  padding: 16px;
  color: #69778b;
  font-size: 0.65rem;
  text-align: center;
}

.unified-timeline {
  display: grid;
  grid-template-columns: auto minmax(300px, 1fr) auto;
  align-items: center;
  gap: 18px;
  min-height: 104px;
  margin-top: 10px;
  padding: 12px 18px;
  border: 1px solid rgba(143, 171, 202, 0.16);
  border-radius: 12px;
  background: #080d14;
}
.timeline-controls {
  display: flex;
  align-items: center;
  gap: 12px;
}
.play-control {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(70, 182, 255, 0.42);
  border-radius: 50%;
  background: rgba(30, 140, 212, 0.14);
  color: #7bcbff;
  font-size: 1.1rem;
}
.timecode {
  display: flex;
  min-width: 88px;
  flex-direction: column;
  font-family: "Cascadia Code", monospace;
}
.timecode strong {
  color: #f3f7fc;
  font-size: 0.92rem;
}
.timecode span {
  color: #627086;
  font-size: 0.58rem;
}
.timeline-main {
  min-width: 0;
}
.timeline-labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 11px;
}
.timeline-labels small {
  color: #627086;
  font-size: 0.56rem;
}
.timeline-track {
  position: relative;
  height: 8px;
  border-radius: 4px;
  background: #1a2330;
}
.timeline-track input {
  position: absolute;
  z-index: 4;
  inset: -7px 0;
  width: 100%;
  height: 22px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}
.timeline-progress {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, #297eb6, #4db9f7);
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
  font-size: 0.52rem;
  cursor: pointer;
}
.event-marker.kill {
  color: var(--red);
}
.event-marker.objective {
  color: var(--gold);
}
.event-marker.ward-placement,
.event-marker.ward-kill {
  z-index: 5;
  top: calc(100% + 5px);
  width: 8px;
  height: 8px;
  border-width: 0;
  background: currentColor;
  font-size: 0;
  opacity: 0.72;
}
.event-marker.ward-placement {
  color: #56d6c2;
}
.event-marker.ward-kill {
  color: #b596ee;
}
.event-marker.ward-placement:hover,
.event-marker.ward-kill:hover {
  z-index: 6;
  width: 12px;
  height: 12px;
  opacity: 1;
}
.timeline-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  color: #536176;
  font-family: monospace;
  font-size: 0.5rem;
}
.speed-controls {
  display: flex;
  gap: 3px;
  padding: 3px;
  border: 1px solid rgba(143, 171, 202, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.025);
}
.speed-controls button {
  padding: 4px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #67758a;
  font-size: 0.6rem;
  font-weight: 700;
}
.speed-controls button.active {
  background: #1b5b82;
  color: #d9f1ff;
}

@media (max-width: 1280px) {
  .viewer-grid {
    grid-template-columns: 240px minmax(380px, 1fr) 240px;
  }
  .player-card {
    min-height: 105px;
    padding: 8px;
  }
  .player-card > img {
    width: 36px;
    height: 36px;
    flex-basis: 36px;
  }
  .inventory-slot {
    width: 11px;
    height: 11px;
  }
  .ward-research-controls {
    grid-template-columns: 1fr 1fr;
  }
}

@media (max-width: 980px) {
  .viewer-grid {
    grid-template-columns: 1fr 1fr;
  }
  .map-stage {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  .roster {
    grid-row: 2;
  }
}

@media (max-width: 680px) {
  .match-scoreboard {
    grid-template-columns: 1fr 1fr;
  }
  .match-identity {
    grid-column: 1 / -1;
    grid-row: 1;
  }
  .viewer-grid {
    grid-template-columns: 1fr;
  }
  .map-stage,
  .roster {
    grid-column: auto;
    grid-row: auto;
  }
  .unified-timeline {
    grid-template-columns: 1fr;
  }
  .speed-controls {
    justify-self: start;
  }
  .ward-research-controls {
    grid-template-columns: 1fr;
  }
  .ward-research-heading,
  .ward-hypothesis-select,
  .ward-research-modes,
  .ward-layer-toggle,
  .ward-timeline-options,
  .ward-hypothesis-description {
    grid-column: 1;
  }
  .ward-hypothesis-description {
    align-items: flex-start;
    flex-direction: column;
  }
  .ward-hypothesis-description small {
    max-width: 100%;
    margin-left: 0;
  }
  .ward-research-warning {
    max-width: calc(100% - 20px);
  }
}
</style>
