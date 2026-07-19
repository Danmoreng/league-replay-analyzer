<!-- Timeline-first product surface. -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { usePlayback } from "../composables/usePlayback";
import {
  loadReplayItemCatalog,
  resolveReplayItem,
  type ReplayItemCatalog,
} from "../replayItemCatalog";
import type { PlayerSummary, ReplaySummary } from "../replayParser";
import type { ReplayKillEvent, ReplayKillResult } from "../replayKills";
import {
  replayObjectiveMonsterLabel,
  type ReplayObjectiveEvent,
  type ReplayObjectiveResult,
} from "../replayObjectives";
import type {
  ReplayDirectItemPurchaseEvent,
  ReplayDirectItemPurchasesResult,
} from "../replayDirectItemPurchases";
import type { ReplayItemSalesResult } from "../replayItemSales";
import type {
  ReplayPurchaseLinkedItemUpdatesResult,
  ReplayPurchaseLinkedResultingItemUpdateEvent,
} from "../replayPurchaseLinkedItemUpdates";
import type { ReplayWardEvent, ReplayWardResult } from "../replayWards";

const props = defineProps<{
  summary: ReplaySummary;
  replayName: string;
  kills: ReplayKillResult | null;
  objectives: ReplayObjectiveResult | null;
  wards: ReplayWardResult | null;
  purchaseLinkedItemUpdates: ReplayPurchaseLinkedItemUpdatesResult | null;
  directItemPurchases: ReplayDirectItemPurchasesResult | null;
  itemSales: ReplayItemSalesResult | null;
  killsLoading: boolean;
  objectivesLoading: boolean;
  wardsLoading: boolean;
  purchaseLinkedItemUpdatesLoading: boolean;
  directItemPurchasesLoading: boolean;
  itemSalesLoading: boolean;
  killsError?: string;
  objectivesError?: string;
  wardsError?: string;
  purchaseLinkedItemUpdatesError?: string;
  directItemPurchasesError?: string;
  itemSalesError?: string;
}>();

type ProductEvent =
  | { id: string; kind: "kill"; timestampMillis: number; event: ReplayKillEvent }
  | { id: string; kind: "objective"; timestampMillis: number; event: ReplayObjectiveEvent }
  | {
      id: string;
      kind: "ward-placement" | "ward-kill";
      timestampMillis: number;
      event: ReplayWardEvent;
    }
  | {
      id: string;
      kind: "purchase-update";
      timestampMillis: number;
      event: ReplayPurchaseLinkedResultingItemUpdateEvent;
    }
  | {
      id: string;
      kind: "direct-purchase";
      timestampMillis: number;
      event: ReplayDirectItemPurchaseEvent;
    }
  | {
      id: string;
      kind: "sale-operation";
      timestampMillis: number;
      event: ReplayItemSalesResult["events"][number];
    };

type ItemPurchaseEvent = Extract<
  ProductEvent,
  { kind: "purchase-update" } | { kind: "direct-purchase" }
>;

interface TimelineKda {
  kills: number;
  deaths: number;
  assists: number;
}

interface WardBucket {
  timestampMillis: number;
  placements: number;
  kills: number;
}

const { currentTime, duration, isPlaying, playbackSpeed, togglePlayback, seek } = usePlayback();
const selectedParticipantId = ref<number | null>(null);
const itemCatalog = ref<ReplayItemCatalog | null>(null);
const itemCatalogLoading = ref(false);
const itemCatalogError = ref("");
const speeds = [1, 2, 4, 8];
let catalogRequest = 0;

const participantsById = computed(
  () => new Map(props.summary.players.map((player, index) => [index + 1, player])),
);

function addProvenanceKey(
  participantId: number,
  timestampMillis: number,
  itemId: number,
  provenance: ReplayDirectItemPurchaseEvent["provenance"]["addBlock"]["provenance"],
): string {
  return [
    participantId,
    timestampMillis,
    itemId,
    provenance.segmentType,
    provenance.segmentId,
    provenance.chunkId,
    provenance.segmentPayloadOffset,
    provenance.blockIndex,
  ].join(":");
}

function compareItemPurchaseEvents(left: ItemPurchaseEvent, right: ItemPurchaseEvent): number {
  if (left.timestampMillis !== right.timestampMillis) {
    return left.timestampMillis - right.timestampMillis;
  }
  const leftProvenance = left.event.provenance.addBlock.provenance;
  const rightProvenance = right.event.provenance.addBlock.provenance;
  if (leftProvenance.segmentPayloadOffset !== rightProvenance.segmentPayloadOffset) {
    return leftProvenance.segmentPayloadOffset - rightProvenance.segmentPayloadOffset;
  }
  if (leftProvenance.blockIndex !== rightProvenance.blockIndex) {
    return leftProvenance.blockIndex - rightProvenance.blockIndex;
  }
  return left.id.localeCompare(right.id);
}

const itemPurchaseEvents = computed<ItemPurchaseEvent[]>(() => {
  const seenAddProvenance = new Set<string>();
  const purchaseUpdates: ItemPurchaseEvent[] = (props.purchaseLinkedItemUpdates?.events ?? []).map(
    (event, index) => {
      seenAddProvenance.add(
        addProvenanceKey(
          event.participantId,
          event.timestampMillis,
          event.resultingItemId,
          event.provenance.addBlock.provenance,
        ),
      );
      return {
        id:
          "purchase-update-" +
          index +
          "-" +
          event.timestampMillis +
          "-" +
          event.participantId +
          "-" +
          event.resultingItemId,
        kind: "purchase-update" as const,
        timestampMillis: event.timestampMillis,
        event,
      };
    },
  );
  const directPurchases: ItemPurchaseEvent[] = [];
  for (const [index, event] of (props.directItemPurchases?.events ?? []).entries()) {
    const key = addProvenanceKey(
      event.participantId,
      event.timestampMillis,
      event.itemId,
      event.provenance.addBlock.provenance,
    );
    if (seenAddProvenance.has(key)) continue;
    seenAddProvenance.add(key);
    directPurchases.push({
      id:
        "direct-purchase-" +
        index +
        "-" +
        event.timestampMillis +
        "-" +
        event.participantId +
        "-" +
        event.itemId,
      kind: "direct-purchase",
      timestampMillis: event.timestampMillis,
      event,
    });
  }
  return [...purchaseUpdates, ...directPurchases].sort(compareItemPurchaseEvents);
});

const events = computed<ProductEvent[]>(() =>
  [
    ...(props.kills?.events ?? []).map((event, index) => ({
      id: "kill-" + index + "-" + event.timestampMillis,
      kind: "kill" as const,
      timestampMillis: event.timestampMillis,
      event,
    })),
    ...(props.objectives?.events ?? []).map((event, index) => ({
      id: "objective-" + index + "-" + event.timestampMillis,
      kind: "objective" as const,
      timestampMillis: event.timestampMillis,
      event,
    })),
    ...(props.wards?.events ?? []).map((event, index) => ({
      id: "ward-" + index + "-" + event.timestampMillis + "-" + event.wardEntityNetworkId,
      kind: event.type === "WARD_PLACED" ? ("ward-placement" as const) : ("ward-kill" as const),
      timestampMillis: event.timestampMillis,
      event,
    })),
    ...itemPurchaseEvents.value,
    ...(props.itemSales?.events ?? []).map((event, index) => ({
      id:
        "sale-operation-" +
        index +
        "-" +
        event.timestampMillis +
        "-" +
        event.participantId +
        "-" +
        event.provenance.removalBlock.provenance.segmentPayloadOffset +
        "-" +
        event.provenance.removalBlock.provenance.blockIndex,
      kind: "sale-operation" as const,
      timestampMillis: event.timestampMillis,
      event,
    })),
  ].sort((left, right) => left.timestampMillis - right.timestampMillis),
);

const primaryEvents = computed(() =>
  events.value.filter(
    (event) => event.kind !== "ward-placement" && event.kind !== "ward-kill",
  ),
);

const counts = computed(() => ({
  kills: props.kills?.events.length ?? 0,
  objectives: props.objectives?.events.length ?? 0,
  purchaseUpdates: props.purchaseLinkedItemUpdates?.events.length ?? 0,
  directPurchases: itemPurchaseEvents.value.filter((event) => event.kind === "direct-purchase")
    .length,
  directComponents: itemPurchaseEvents.value.filter(
    (event) => event.kind === "direct-purchase" && event.event.componentItem,
  ).length,
  purchases: itemPurchaseEvents.value.length,
  sales: props.itemSales?.events.length ?? 0,
  wards: props.wards?.events.length ?? 0,
}));

const wardBuckets = computed<WardBucket[]>(() => {
  const bucketSize = Math.max(30_000, Math.ceil(Math.max(1, duration.value) / 100));
  const buckets = new Map<number, WardBucket>();
  for (const event of props.wards?.events ?? []) {
    const timestampMillis = Math.floor(event.timestampMillis / bucketSize) * bucketSize;
    const bucket = buckets.get(timestampMillis) ?? { timestampMillis, placements: 0, kills: 0 };
    if (event.type === "WARD_PLACED") bucket.placements += 1;
    else bucket.kills += 1;
    buckets.set(timestampMillis, bucket);
  }
  return [...buckets.values()].sort((left, right) => left.timestampMillis - right.timestampMillis);
});

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

const purchasesByParticipant = computed(() => {
  const rows = new Map<number, ItemPurchaseEvent[]>();
  for (const event of itemPurchaseEvents.value) {
    if (event.timestampMillis > currentTime.value) continue;
    const participantEvents = rows.get(event.event.participantId) ?? [];
    participantEvents.push(event);
    rows.set(event.event.participantId, participantEvents);
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
      finalKills: players.reduce((sum, player) => sum + player.player.kills, 0),
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
      priority:
        event.kind === "kill"
          ? 0
          : event.kind === "objective"
            ? 1
            : event.kind === "direct-purchase"
              ? 2
              : event.kind === "purchase-update"
                ? 3
                : event.kind === "sale-operation"
                  ? 4
                  : 5,
    }))
    .sort((left, right) => left.distance - right.distance || left.priority - right.priority)
    .slice(0, 8)
    .map((entry) => entry.event)
    .sort((left, right) => left.timestampMillis - right.timestampMillis);
});

const finalStatsAvailable = computed(
  () => props.summary.capabilities.validatedFinalPlayerStatsAvailable === true,
);
const purchaseUpdatesUnavailable = computed(() => Boolean(props.purchaseLinkedItemUpdatesError));
const directPurchasesUnavailable = computed(() => Boolean(props.directItemPurchasesError));
const salesUnavailable = computed(() => Boolean(props.itemSalesError));
const purchaseStreamsUnavailable = computed(
  () => purchaseUpdatesUnavailable.value && directPurchasesUnavailable.value,
);
const itemOperationStreamsUnavailable = computed(
  () => purchaseStreamsUnavailable.value && salesUnavailable.value,
);

const loadState = computed(() => {
  if (
    props.killsLoading ||
    props.objectivesLoading ||
    props.wardsLoading ||
    props.purchaseLinkedItemUpdatesLoading ||
    props.directItemPurchasesLoading ||
    props.itemSalesLoading
  ) {
    return "Replay-Ereignisse werden lokal dekodiert …";
  }
  if (
    props.killsError ||
    props.objectivesError ||
    props.wardsError ||
    props.purchaseLinkedItemUpdatesError ||
    props.directItemPurchasesError ||
    props.itemSalesError
  ) {
    return "Ein Teil der Replay-Ereignisse ist für diesen Patch nicht verfügbar.";
  }
  return "";
});

watch(
  () => props.summary.gameVersion,
  async (gameVersion) => {
    const request = ++catalogRequest;
    itemCatalog.value = null;
    itemCatalogError.value = "";
    itemCatalogLoading.value = true;
    const loaded = await loadReplayItemCatalog(gameVersion);
    if (request !== catalogRequest) return;
    itemCatalogLoading.value = false;
    if (loaded.available) itemCatalog.value = loaded.catalog;
    else itemCatalogError.value = loaded.error;
  },
  { immediate: true },
);

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("de-DE", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
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
    ? player.riotIdGameName + "#" + player.riotIdTagLine
    : player.riotIdGameName;
}

function ddragonVersion(): string {
  if (itemCatalog.value) return itemCatalog.value.dataDragonVersion;
  const match = props.summary.gameVersion.match(/^(\d+)\.(\d+)/);
  return match ? match[1] + "." + match[2] + ".1" : "16.14.1";
}

function championIcon(champion: string): string {
  return (
    "https://ddragon.leagueoflegends.com/cdn/" +
    ddragonVersion() +
    "/img/champion/" +
    encodeURIComponent(champion) +
    ".png"
  );
}

function itemName(itemId: number): string {
  return resolveReplayItem(itemCatalog.value, itemId)?.name ?? "Item #" + itemId;
}

function itemIcon(itemId: number): string {
  return (
    resolveReplayItem(itemCatalog.value, itemId)?.iconUrl ??
    "https://ddragon.leagueoflegends.com/cdn/" +
      ddragonVersion() +
      "/img/item/" +
      itemId +
      ".png"
  );
}

function participantChampion(participantId: number): string {
  return participantsById.value.get(participantId)?.champion ?? "P" + participantId;
}

function timelineKda(participantId: number): TimelineKda {
  return kdaByParticipant.value.get(participantId) ?? { kills: 0, deaths: 0, assists: 0 };
}

function totalCs(player: PlayerSummary): number {
  return player.laneMinionsKilled + player.neutralMinionsKilled;
}

function visiblePurchases(participantId: number): ItemPurchaseEvent[] {
  return (purchasesByParticipant.value.get(participantId) ?? []).slice(-5);
}

function hiddenPurchaseCount(participantId: number): number {
  return Math.max(0, (purchasesByParticipant.value.get(participantId)?.length ?? 0) - 5);
}

function purchaseItemId(event: ItemPurchaseEvent): number {
  return event.kind === "purchase-update" ? event.event.resultingItemId : event.event.itemId;
}

function purchaseTitle(event: ItemPurchaseEvent): string {
  const detail =
    event.kind === "direct-purchase"
      ? event.event.componentItem
        ? "direkter Komponenten-Kauf"
        : "direkter Item-Kauf"
      : "kaufverknüpftes Ergebnis-Item-Update";
  return (
    formatTime(event.timestampMillis) +
    " · " +
    itemName(purchaseItemId(event)) +
    " · " +
    detail +
    "; kein Slot- oder Inventarstand"
  );
}

function markerLeft(timestampMillis: number): string {
  const percentage = (timestampMillis / Math.max(1, duration.value)) * 100;
  return Math.max(0, Math.min(100, percentage)) + "%";
}

function wardHeight(bucket: WardBucket): string {
  return Math.min(14, 3 + bucket.placements + bucket.kills * 2) + "px";
}

function wardTitle(bucket: WardBucket): string {
  return (
    formatTime(bucket.timestampMillis) +
    " · " +
    bucket.placements +
    " Ward-Platzierungen · " +
    bucket.kills +
    " Ward-Kills"
  );
}

function eventInvolves(event: ProductEvent, participantId: number): boolean {
  if (event.kind === "purchase-update" || event.kind === "direct-purchase") {
    return event.event.participantId === participantId;
  }
  if (event.kind === "sale-operation") return event.event.participantId === participantId;
  if (event.kind === "kill") {
    return (
      event.event.victimParticipantId === participantId ||
      event.event.killerParticipantId === participantId ||
      event.event.assistingParticipantIds.includes(participantId)
    );
  }
  if (event.kind === "ward-placement" && event.event.type === "WARD_PLACED") {
    return event.event.ownerParticipantId === participantId;
  }
  if (event.kind === "ward-kill" && event.event.type === "WARD_KILL") {
    return event.event.killerParticipantId === participantId;
  }
  return true;
}

function eventLabel(event: ProductEvent): string {
  if (event.kind === "objective") return replayObjectiveMonsterLabel(event.event.monsterType);
  if (event.kind === "purchase-update") {
    return participantChampion(event.event.participantId) + " · " + itemName(event.event.resultingItemId);
  }
  if (event.kind === "direct-purchase") {
    const component = event.event.componentItem ? "Komponente · " : "";
    return participantChampion(event.event.participantId) + " · " + component + itemName(event.event.itemId);
  }
  if (event.kind === "sale-operation") {
    return participantChampion(event.event.participantId) + " · Verkaufsoperation";
  }
  if (event.kind === "ward-placement" && event.event.type === "WARD_PLACED") {
    return participantChampion(event.event.ownerParticipantId) + " platziert Ward";
  }
  if (event.kind === "ward-kill" && event.event.type === "WARD_KILL") {
    return participantChampion(event.event.killerParticipantId) + " zerstört Ward";
  }
  if (event.kind !== "kill") return "Ward-Ereignis";
  const killer =
    event.event.killerParticipantId > 0
      ? participantChampion(event.event.killerParticipantId)
      : "Execution";
  return killer + " → " + participantChampion(event.event.victimParticipantId);
}

function eventDetail(event: ProductEvent): string {
  if (event.kind === "purchase-update") {
    return "Kaufverknüpftes Ergebnis-Update · kein Slot- oder Inventarstand";
  }
  if (event.kind === "direct-purchase") {
    return event.event.componentItem
      ? "Direkter Komponenten-Kauf · kein Slot- oder Inventarstand"
      : "Direkter Item-Kauf · kein Slot- oder Inventarstand";
  }
  if (event.kind === "sale-operation") {
    return "Verkaufsoperation · Item, Slot, Gold und Inventarstand nicht dekodiert";
  }
  if (event.kind === "kill") return "Champion-Kill";
  if (event.kind === "objective") return "Elite-Objective";
  return event.kind === "ward-placement" ? "Ward platziert" : "Ward zerstört";
}

function eventIcon(event: ProductEvent): string {
  if (event.kind === "kill") return "bi-lightning-charge-fill";
  if (event.kind === "objective") return "bi-shield-fill";
  if (event.kind === "sale-operation") return "bi-cash-coin";
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
        <strong>{{ teams[0].timelineKills }}</strong>
        <small>{{ teams[0].finalKills }} Kills final</small>
      </div>
      <div class="match-identity">
        <span class="eyebrow">REPLAY TIMELINE</span>
        <h2>{{ replayName }}</h2>
        <div class="match-meta">
          <span>Patch {{ summary.gameVersion }}</span>
          <span>{{ formatTime(summary.gameLengthMillis) }}</span>
          <span>{{ summary.players.length }} Spieler</span>
        </div>
      </div>
      <div class="score-team score-team-red">
        <strong>{{ teams[1].timelineKills }}</strong>
        <span class="score-result" :class="{ winner: teams[1].winner }">{{
          teams[1].winner ? "VICTORY" : "DEFEAT"
        }}</span>
        <small>{{ teams[1].finalKills }} Kills final</small>
      </div>
    </header>

    <section class="timeline-card" aria-label="Match timeline">
      <header class="timeline-heading">
        <div>
          <span class="eyebrow">MATCH TIMELINE</span>
          <strong>Alle sicher dekodierten Ereignisse</strong>
        </div>
        <div class="timeline-legend" aria-label="Timeline legend">
          <span class="kill"><i></i>{{ counts.kills }} Kills</span>
          <span class="objective"><i></i>{{ counts.objectives }} Objectives</span>
          <span class="purchase-update">
            <i></i>
            <template v-if="purchaseLinkedItemUpdatesLoading">Upgrade-Ergebnisse werden dekodiert</template>
            <template v-else-if="purchaseUpdatesUnavailable">Upgrade-Ergebnisse nicht verfügbar</template>
            <template v-else>{{ counts.purchaseUpdates }} Upgrade-Ergebnisse</template>
          </span>
          <span class="direct-purchase">
            <i></i>
            <template v-if="directItemPurchasesLoading">Direkte Käufe werden dekodiert</template>
            <template v-else-if="directPurchasesUnavailable">Direkte Käufe nicht verfügbar</template>
            <template v-else>
              {{ counts.directPurchases }} direkte Käufe
              <template v-if="counts.directComponents">· {{ counts.directComponents }} Komponenten</template>
            </template>
          </span>
          <span class="sale-operation">
            <i></i>
            <template v-if="itemSalesLoading">Verkaufsoperationen werden dekodiert</template>
            <template v-else-if="salesUnavailable">Verkaufsoperationen nicht verfügbar</template>
            <template v-else>{{ counts.sales }} Verkaufsoperationen</template>
          </span>
          <span class="ward"><i></i>{{ counts.wards }} Ward-Ereignisse</span>
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
            <span
              v-for="bucket in wardBuckets"
              :key="bucket.timestampMillis"
              class="ward-density"
              :style="{ left: markerLeft(bucket.timestampMillis), height: wardHeight(bucket) }"
              :title="wardTitle(bucket)"
            ></span>
            <button
              v-for="event in primaryEvents"
              :key="event.id"
              class="event-marker"
              :class="event.kind"
              :style="{ left: markerLeft(event.timestampMillis) }"
              :title="formatTime(event.timestampMillis) + ' · ' + eventLabel(event)"
              @click="seek(event.timestampMillis)"
            >
              <img
                v-if="event.kind === 'purchase-update' || event.kind === 'direct-purchase'"
                :src="itemIcon(purchaseItemId(event))"
                :alt="itemName(purchaseItemId(event))"
              />
              <i v-else class="bi" :class="eventIcon(event)"></i>
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
      <p v-if="loadState" class="timeline-status">{{ loadState }}</p>
    </section>

    <div class="viewer-grid">
      <aside
        v-for="team in teams"
        :key="team.id"
        class="roster"
        :class="team.id === 100 ? 'roster-blue' : 'roster-red'"
        :aria-label="team.label + ' roster'"
      >
        <div class="roster-title">
          <span class="team-pip"></span>
          <span>{{ team.label }}</span>
          <small>Stand {{ formatTime(currentTime) }}</small>
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
          <img :src="championIcon(entry.player.champion)" :alt="entry.player.champion" />
          <span class="player-main">
            <span class="player-heading">
              <span>
                <b>{{ entry.player.champion }}</b>
                <small>{{ playerName(entry.player) }}</small>
              </span>
              <em :title="'K/D/A bis ' + formatTime(currentTime)">
                {{ timelineKda(entry.participantId).kills }}/{{
                  timelineKda(entry.participantId).deaths
                }}/{{ timelineKda(entry.participantId).assists }}
              </em>
            </span>

            <span v-if="finalStatsAvailable" class="final-stats">
              <small>FINAL</small>
              <span><i class="bi bi-star-fill"></i> Lv {{ entry.player.level }}</span>
              <span><i class="bi bi-stack"></i> {{ totalCs(entry.player) }} CS</span>
              <span><i class="bi bi-eye-fill"></i> {{ entry.player.wardsPlaced }}/{{ entry.player.wardsKilled }}</span>
              <span class="final-gold">{{ formatCompact(entry.player.goldEarned) }}g</span>
            </span>
            <span v-else class="final-stats unavailable">
              <small>FINAL</small>
              <span>Für diesen Patch nicht validiert</span>
            </span>

            <span
              v-if="visiblePurchases(entry.participantId).length"
              class="purchase-strip"
              title="Erkannte Kaufereignisse bis zum gewählten Zeitpunkt; kein vollständiger Inventarstand"
            >
              <small>DEKODIERTE KÄUFE</small>
              <span v-if="hiddenPurchaseCount(entry.participantId)" class="hidden-count">
                +{{ hiddenPurchaseCount(entry.participantId) }}
              </span>
              <span
                v-for="itemEvent in visiblePurchases(entry.participantId)"
                :key="itemEvent.id"
                class="purchase-chip"
                :class="[
                  itemEvent.kind,
                  { component: itemEvent.kind === 'direct-purchase' && itemEvent.event.componentItem },
                ]"
                :title="purchaseTitle(itemEvent)"
              >
                <img
                  :src="itemIcon(purchaseItemId(itemEvent))"
                  :alt="itemName(purchaseItemId(itemEvent))"
                />
              </span>
            </span>

            <span class="player-footer">
              <small>{{ roleLabel(entry.player.teamPosition) }}</small>
              <small>K/D/A und dekodierte Käufe folgen der Timeline</small>
            </span>
          </span>
        </button>
      </aside>

      <main class="event-focus">
        <header class="event-window-header">
          <div>
            <span class="eyebrow">EREIGNISSE</span>
            <strong>Rund um {{ formatTime(currentTime) }}</strong>
          </div>
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
              <img
                v-if="event.kind === 'purchase-update' || event.kind === 'direct-purchase'"
                :src="itemIcon(purchaseItemId(event))"
                :alt="itemName(purchaseItemId(event))"
              />
              <i v-else class="bi" :class="eventIcon(event)"></i>
            </span>
            <span class="event-copy">
              <b>{{ eventLabel(event) }}</b>
              <small>{{ eventDetail(event) }}</small>
            </span>
          </button>
          <div v-if="!nearbyEvents.length" class="event-empty">
            Keine dekodierten Ereignisse in diesem Ausschnitt.
          </div>
        </div>

        <p
          class="purchase-boundary"
          :class="{ unavailable: itemOperationStreamsUnavailable }"
          :title="[purchaseLinkedItemUpdatesError, directItemPurchasesError, itemSalesError].filter(Boolean).join(' ')"
        >
          <i
            class="bi"
            :class="itemOperationStreamsUnavailable ? 'bi-bag-x-fill' : 'bi-bag-check-fill'"
          ></i>
          <span>
            <template v-if="itemOperationStreamsUnavailable">
              <b>Item-Käufe nicht verfügbar; Verkaufsströme für diesen Patch ebenfalls nicht verfügbar</b>
              <small>Es werden keine null Käufe oder Verkäufe behauptet und keine Inventardaten geschätzt.</small>
            </template>
            <template v-else>
              <b>
                <template v-if="!purchaseStreamsUnavailable">
                  {{ counts.purchases }} dekodierte Item-Kaufereignisse:
                  {{ counts.directPurchases }} direkte Käufe und {{ counts.purchaseUpdates }}
                  kaufverknüpfte Ergebnis-Updates
                </template>
                <template v-else>Kaufereignisse nicht verfügbar</template>
                ·
                <template v-if="!salesUnavailable">
                  {{ counts.sales }} Verkaufsoperationen
                </template>
                <template v-else>Verkaufsoperationen nicht verfügbar</template>
              </b>
              <small>
                Name und Icon: Data Dragon {{ itemCatalog?.dataDragonVersion ?? "patchgebunden" }}.
                Direkte Komponenten-Käufe sind mit einem türkisfarbenen Rand markiert. Verkäufe,
                falls dekodiert, zeigen ausschließlich eine Verkaufsoperation: verkauftes Item,
                Slot, Instanz, Menge, Goldgewinn, Undo und Inventarverlauf bleiben unavailable.
                Deshalb wird kein Inventarstand mutiert oder angezeigt.
                <template v-if="purchaseStreamsUnavailable">
                  Kaufereignisse sind für diesen Patch nicht verfügbar.
                </template>
                <template v-if="salesUnavailable">
                  Verkaufsoperationen sind für diesen Patch nicht verfügbar; es werden keine
                  fehlenden Verkäufe geschätzt.
                </template>
                <template v-if="itemCatalogLoading"> Itemdaten werden geladen …</template>
                <template v-else-if="itemCatalogError">
                  Unbekannte Items bleiben als ID sichtbar.
                </template>
              </small>
            </template>
          </span>
        </p>
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
  min-height: 82px;
  display: grid;
  grid-template-columns: 1fr minmax(260px, 1.35fr) 1fr;
  align-items: center;
  gap: 20px;
  padding: 12px 22px;
  background: linear-gradient(100deg, rgba(18, 62, 93, 0.52), #070c14 43%, #070c14 57%, rgba(95, 24, 35, 0.48));
}

.match-identity {
  min-width: 0;
  text-align: center;
}

.match-identity h2 {
  margin: 3px 0 5px;
  overflow: hidden;
  color: #fff;
  font-size: 0.96rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eyebrow,
.roster-title {
  color: #8292a8;
  font-size: 0.6rem;
  font-weight: 800;
  letter-spacing: 0.15em;
}

.match-meta {
  display: flex;
  justify-content: center;
  gap: 12px;
  color: #7f8b9d;
  font-size: 0.66rem;
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
  color: var(--blue);
  font-family: "Cascadia Code", monospace;
  font-size: 2rem;
  line-height: 1;
}

.score-team-red strong {
  order: -1;
  color: var(--red);
}

.score-team small {
  color: #8190a4;
  font-size: 0.62rem;
}

.score-result {
  font-size: 0.68rem;
  font-weight: 900;
  letter-spacing: 0.12em;
  opacity: 0.64;
}

.score-result.winner {
  color: #f1ce73;
  opacity: 1;
}

.timeline-card {
  padding: 16px 18px 13px;
  border-color: rgba(77, 185, 247, 0.3);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.24);
}

.timeline-heading,
.timeline-layout,
.timeline-controls,
.timeline-legend,
.player-heading,
.player-footer,
.final-stats,
.purchase-strip,
.event-window-header {
  display: flex;
  align-items: center;
}

.timeline-heading,
.event-window-header {
  justify-content: space-between;
}

.timeline-heading {
  align-items: flex-start;
  gap: 18px;
  margin-bottom: 15px;
}

.timeline-heading > div:first-child,
.event-window-header > div,
.event-copy,
.purchase-boundary span {
  display: flex;
  flex-direction: column;
}

.timeline-heading strong,
.event-window-header strong {
  color: #f4f8fd;
  font-size: 0.9rem;
}

.timeline-legend {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 7px 13px;
  color: #8392a6;
  font-size: 0.61rem;
}

.timeline-legend span {
  display: flex;
  align-items: center;
  gap: 5px;
}

.timeline-legend i {
  width: 7px;
  height: 7px;
  display: block;
  border-radius: 50%;
  background: currentColor;
}

.timeline-legend .kill { color: var(--red); }
.timeline-legend .objective { color: var(--gold); }
.timeline-legend .purchase-update { color: #c49aff; }
.timeline-legend .direct-purchase { color: #61d5c3; }
.timeline-legend .sale-operation { color: #f0a85f; }
.timeline-legend .ward { color: #56d6c2; }

.timeline-layout {
  display: grid;
  grid-template-columns: auto minmax(300px, 1fr) auto;
  gap: 18px;
}

.timeline-controls {
  gap: 11px;
}

.play-control {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(70, 182, 255, 0.46);
  border-radius: 50%;
  background: rgba(30, 140, 212, 0.14);
  color: #7bcbff;
  font-size: 1.15rem;
}

.timecode {
  display: flex;
  min-width: 90px;
  flex-direction: column;
  font-family: "Cascadia Code", monospace;
}

.timecode strong {
  color: #f3f7fc;
  font-size: 0.96rem;
}

.timecode span {
  color: #627086;
  font-size: 0.58rem;
}

.timeline-main {
  min-width: 0;
}

.timeline-track {
  position: relative;
  height: 34px;
  border: 1px solid rgba(143, 171, 202, 0.08);
  border-radius: 7px;
  background: linear-gradient(to bottom, #1a2330 0 8px, transparent 8px 20px, rgba(86, 214, 194, 0.05) 20px), #0a1018;
}

.timeline-track input {
  position: absolute;
  z-index: 4;
  inset: -6px 0;
  width: 100%;
  height: 44px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.timeline-progress {
  position: absolute;
  z-index: 1;
  inset: 0 auto 25px 0;
  border-radius: 6px 0 0 0;
  background: linear-gradient(90deg, #297eb6, #4db9f7);
}

.event-marker {
  position: absolute;
  z-index: 5;
  top: 4px;
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0;
  overflow: hidden;
  transform: translate(-50%, -50%);
  border: 1px solid currentColor;
  border-radius: 50%;
  background: #0a111a;
  color: #dce8f5;
  font-size: 0.54rem;
  cursor: pointer;
}

.event-marker.kill { color: var(--red); }
.event-marker.objective { color: var(--gold); }
.event-marker.purchase-update {
  border-color: #c49aff;
  color: #c49aff;
}

.event-marker.direct-purchase {
  top: 7px;
  width: 13px;
  height: 13px;
  border-color: #61d5c3;
  border-radius: 3px;
  color: #61d5c3;
}

.event-marker.sale-operation {
  border-color: #f0a85f;
  color: #f0a85f;
}

.event-marker img,
.purchase-chip img,
.event-symbol img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}

.ward-density {
  position: absolute;
  z-index: 2;
  bottom: 2px;
  width: 3px;
  transform: translateX(-50%);
  border-radius: 2px 2px 0 0;
  background: linear-gradient(#b596ee, #56d6c2);
  opacity: 0.68;
}

.timeline-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 5px;
  color: #536176;
  font-family: monospace;
  font-size: 0.51rem;
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
  font-size: 0.6rem;
  font-weight: 700;
}

.speed-controls button {
  padding: 4px 7px;
}

.speed-controls button.active {
  background: #1b5b82;
  color: #d9f1ff;
}

.timeline-status {
  margin: 8px 0 0 71px;
  color: #7f8fa4;
  font-size: 0.6rem;
}

.viewer-grid {
  display: grid;
  grid-template-columns: minmax(250px, 310px) minmax(360px, 1fr) minmax(250px, 310px);
  grid-template-areas: "blue events red";
  gap: 10px;
  align-items: start;
}

.roster {
  overflow: hidden;
}

.roster-blue { grid-area: blue; }
.roster-red { grid-area: red; }

.roster-title {
  display: flex;
  align-items: center;
  min-height: 34px;
  gap: 7px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
}

.roster-title small {
  margin-left: auto;
  color: #637186;
  font-size: 0.52rem;
  font-weight: 500;
  letter-spacing: 0;
}

.final-stats.unavailable {
  color: #6f7c90;
  font-weight: 600;
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
  min-height: 92px;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px;
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

.player-card > img {
  width: 38px;
  height: 38px;
  flex: 0 0 38px;
  border: 1px solid rgba(38, 167, 255, 0.62);
  border-radius: 8px;
  object-fit: cover;
}

.player-card-red > img {
  border-color: rgba(255, 89, 100, 0.64);
}

.player-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.player-heading,
.player-footer {
  justify-content: space-between;
}

.player-heading > span {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.player-heading b,
.event-copy b {
  overflow: hidden;
  color: #f6f8fc;
  font-size: 0.74rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-heading small,
.player-footer small {
  overflow: hidden;
  color: #6f7c90;
  font-size: 0.53rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.player-heading em {
  color: #d9e3f0;
  font-family: "Cascadia Code", monospace;
  font-size: 0.68rem;
  font-style: normal;
  font-weight: 700;
}

.final-stats {
  flex-wrap: wrap;
  gap: 6px;
  color: #8c9bb0;
  font-size: 0.52rem;
  font-weight: 700;
}

.final-stats > small,
.purchase-strip > small {
  color: #5f6c7f;
  font-size: 0.46rem;
  font-weight: 900;
  letter-spacing: 0.08em;
}

.final-stats i {
  margin-right: 2px;
  color: #8094ad;
  font-size: 0.48rem;
}

.final-gold {
  margin-left: auto;
  color: #d7bd78;
}

.purchase-strip {
  min-height: 23px;
  gap: 5px;
}

.hidden-count {
  color: #8978b1;
  font-size: 0.48rem;
}

.purchase-chip {
  width: 22px;
  height: 22px;
  display: block;
  overflow: hidden;
  border: 1px solid rgba(196, 154, 255, 0.4);
  border-radius: 4px;
  background: #0b1119;
}

.purchase-chip.direct-purchase {
  border-color: rgba(97, 213, 195, 0.54);
}

.purchase-chip.component {
  border-color: #61d5c3;
  box-shadow: inset 0 0 0 1px rgba(97, 213, 195, 0.22);
}

.event-focus {
  grid-area: events;
  min-height: 100%;
  overflow: hidden;
}

.event-window-header {
  min-height: 49px;
  gap: 10px;
  padding: 8px 11px;
  border-bottom: 1px solid rgba(143, 171, 202, 0.1);
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
  min-height: 46px;
  display: grid;
  grid-template-columns: 42px 28px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
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
  font-size: 0.61rem;
}

.event-symbol {
  width: 27px;
  height: 27px;
  display: grid;
  place-items: center;
  overflow: hidden;
  border: 1px solid rgba(143, 171, 202, 0.14);
  border-radius: 6px;
  background: #0b121b;
  font-size: 0.72rem;
}

.event-symbol.kill { color: var(--red); }
.event-symbol.objective { color: var(--gold); }
.event-symbol.purchase-update { border-color: rgba(196, 154, 255, 0.4); }
.event-symbol.direct-purchase { border-color: rgba(97, 213, 195, 0.54); }
.event-symbol.sale-operation { border-color: rgba(240, 168, 95, 0.54); color: #f0a85f; }
.event-symbol.ward-placement { color: #56d6c2; }
.event-symbol.ward-kill { color: #b596ee; }

.event-copy {
  min-width: 0;
  gap: 2px;
}

.event-copy small {
  overflow: hidden;
  color: #69788c;
  font-size: 0.54rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-empty {
  padding: 24px;
  color: #69778b;
  font-size: 0.65rem;
  text-align: center;
}

.purchase-boundary {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  margin: 0;
  padding: 11px;
  border-top: 1px solid rgba(196, 154, 255, 0.14);
  background: rgba(93, 59, 126, 0.08);
  color: #8d9bae;
}

.purchase-boundary > i {
  color: #c49aff;
}

.purchase-boundary span {
  gap: 2px;
}

.purchase-boundary b {
  color: #c9b3ec;
  font-size: 0.61rem;
}

.purchase-boundary small {
  color: #77869a;
  font-size: 0.55rem;
  line-height: 1.45;
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
  .timeline-heading {
    flex-direction: column;
  }
  .timeline-legend {
    justify-content: flex-start;
  }
  .timeline-layout {
    grid-template-columns: 1fr;
  }
  .speed-controls {
    justify-self: start;
  }
  .timeline-status {
    margin-left: 0;
  }
}

@media (max-width: 620px) {
  .viewer-grid {
    grid-template-columns: 1fr;
    grid-template-areas: "events" "blue" "red";
  }
}
</style>
