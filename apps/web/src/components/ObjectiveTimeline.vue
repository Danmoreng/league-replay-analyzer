<script setup lang="ts">
import { computed } from "vue";

import { usePlayback } from "../composables/usePlayback";
import {
  formatReplayObjectiveTimestamp,
  replayObjectiveMonsterLabel,
  summarizeReplayObjectiveDiagnostics,
  type ReplayObjectiveEvent,
  type ReplayObjectiveMonsterType,
  type ReplayObjectiveResult,
} from "../replayObjectives";

const props = defineProps<{
  result: ReplayObjectiveResult | null;
  isLoading: boolean;
  errorMessage: string;
}>();

const { currentTime, seek } = usePlayback();

const monsterOrder: ReplayObjectiveMonsterType[] = [
  "DRAGON",
  "ATAKHAN",
  "BARON_NASHOR",
  "RIFTHERALD",
  "HORDE",
  "UNKNOWN",
];

const events = computed(() =>
  [...(props.result?.events ?? [])].sort(
    (left, right) => left.timestampMillis - right.timestampMillis,
  ),
);

const monsterCounts = computed(() =>
  monsterOrder
    .map((monsterType) => ({
      monsterType,
      count: props.result?.diagnostics.monsterCounts[monsterType] ?? 0,
    }))
    .filter((entry) => entry.count > 0),
);

const diagnosticSummary = computed(() =>
  props.result ? summarizeReplayObjectiveDiagnostics(props.result) : "",
);

const activeEvent = computed(() => {
  let active: ReplayObjectiveEvent | null = null;
  for (const event of events.value) {
    if (event.timestampMillis > currentTime.value) {
      break;
    }
    active = event;
  }
  return active;
});

function monsterIcon(monsterType: ReplayObjectiveMonsterType): string {
  switch (monsterType) {
    case "DRAGON":
      return "bi-fire";
    case "ATAKHAN":
      return "bi-lightning-charge-fill";
    case "BARON_NASHOR":
      return "bi-gem";
    case "RIFTHERALD":
      return "bi-eye-fill";
    case "HORDE":
      return "bi-hexagon-fill";
    case "UNKNOWN":
      return "bi-question-circle-fill";
  }
}

function monsterClass(monsterType: ReplayObjectiveMonsterType): string {
  return `monster-${monsterType.toLowerCase().replace("_", "-")}`;
}

function eventProgress(event: ReplayObjectiveEvent): string {
  const duration = props.result?.replay.gameLengthMillis ?? 0;
  if (duration <= 0) {
    return "0%";
  }
  return `${Math.min(100, Math.max(0, (event.timestampMillis / duration) * 100))}%`;
}

function openEvent(event: ReplayObjectiveEvent): void {
  seek(event.timestampMillis);
}
</script>

<template>
  <section class="island p-3 objective-timeline">
    <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
      <div>
        <div class="d-flex align-items-center gap-2 mb-1">
          <h2 class="fs-5 mb-0">Replay-Derived Objectives</h2>
          <span class="badge bg-warning-subtle text-warning-emphasis">Broad classes</span>
        </div>
        <p class="text-muted small mb-0">
          Elite-monster objective timing and broad monster class decoded locally from replay packet
          blocks.
        </p>
      </div>
      <div v-if="result" class="d-flex flex-wrap gap-2 justify-content-end">
        <span class="badge bg-primary-subtle text-primary-emphasis">
          {{ events.length }} objectives
        </span>
        <span
          class="badge"
          :class="
            result.diagnostics.exactPacketFraming
              ? 'bg-success-subtle text-success-emphasis'
              : 'bg-danger-subtle text-danger-emphasis'
          "
        >
          {{ result.diagnostics.exactPacketFraming ? "Exact framing" : "Framing warning" }}
        </span>
        <span class="badge bg-secondary-subtle text-secondary-emphasis">Killer unresolved</span>
        <span class="badge bg-secondary-subtle text-secondary-emphasis">
          Dragon element unresolved
        </span>
      </div>
    </div>

    <div v-if="isLoading" class="objective-state mt-3">
      <span class="spinner-border spinner-border-sm text-warning" role="status"></span>
      <span>Decoding elite-monster objectives from replay packet blocks…</span>
    </div>

    <div v-else-if="errorMessage" class="alert alert-warning mt-3 mb-0 small">
      <div class="fw-bold mb-1">Objective timeline unavailable for this replay</div>
      <div>{{ errorMessage }}</div>
      <div class="text-muted mt-1">
        The kill timeline, metadata, and other replay tools remain available.
      </div>
    </div>

    <template v-else-if="result">
      <div v-if="monsterCounts.length" class="monster-count-grid mt-3">
        <div
          v-for="entry in monsterCounts"
          :key="entry.monsterType"
          class="monster-count-card"
          :class="monsterClass(entry.monsterType)"
        >
          <i class="bi" :class="monsterIcon(entry.monsterType)" aria-hidden="true"></i>
          <span class="monster-count-value">{{ entry.count }}</span>
          <span class="monster-count-label">{{
            replayObjectiveMonsterLabel(entry.monsterType)
          }}</span>
        </div>
      </div>

      <div class="diagnostic-strip mt-3">
        <div>
          <span class="diagnostic-value">{{
            result.diagnostics.packetBlockCount.toLocaleString()
          }}</span>
          <span class="diagnostic-label">packet blocks</span>
        </div>
        <div>
          <span class="diagnostic-value">{{ result.profile.packetTypeHex }}</span>
          <span class="diagnostic-label">objective packet</span>
        </div>
        <div>
          <span class="diagnostic-value">{{
            result.diagnostics.chunkRecordCount.toLocaleString()
          }}</span>
          <span class="diagnostic-label">chunks scanned</span>
        </div>
        <div>
          <span class="diagnostic-value">{{
            result.diagnostics.unknownMonsterTypeCount.toLocaleString()
          }}</span>
          <span class="diagnostic-label">rejected unknown</span>
        </div>
      </div>
      <p class="small text-muted mt-2 mb-0">{{ diagnosticSummary }}</p>

      <div v-if="events.length" class="objective-track-shell mt-3">
        <div class="objective-track">
          <button
            v-for="(event, index) in events"
            :key="`${event.timestampMillis}:${event.provenance.blockIndex}:${index}`"
            type="button"
            class="objective-marker"
            :class="[monsterClass(event.monsterType), { active: activeEvent === event }]"
            :style="{ left: eventProgress(event) }"
            :title="`${formatReplayObjectiveTimestamp(event.timestampMillis)} — ${replayObjectiveMonsterLabel(event.monsterType)}`"
            @click="openEvent(event)"
          ></button>
        </div>
        <div class="d-flex justify-content-between text-muted x-small mt-1">
          <span>0:00</span>
          <span>{{ formatReplayObjectiveTimestamp(result.replay.gameLengthMillis ?? 0) }}</span>
        </div>
      </div>

      <div v-if="events.length" class="objective-event-list mt-3">
        <button
          v-for="(event, index) in events"
          :key="`${event.provenance.segmentId}:${event.provenance.blockIndex}:${index}`"
          type="button"
          class="objective-event-row"
          :class="{ active: activeEvent === event }"
          @click="openEvent(event)"
        >
          <span class="objective-time">{{
            formatReplayObjectiveTimestamp(event.timestampMillis)
          }}</span>
          <span class="objective-icon" :class="monsterClass(event.monsterType)">
            <i class="bi" :class="monsterIcon(event.monsterType)" aria-hidden="true"></i>
          </span>
          <span class="objective-name">
            <strong>{{ replayObjectiveMonsterLabel(event.monsterType) }}</strong>
            <small>Broad monster class</small>
          </span>
          <span class="objective-unknowns">
            <span class="unresolved-chip">Killer unknown</span>
            <span v-if="event.monsterType === 'DRAGON'" class="unresolved-chip">
              Element unknown
            </span>
          </span>
          <span class="objective-source text-muted">
            chunk {{ event.provenance.chunkId }} · {{ event.contentLength }} bytes
          </span>
        </button>
      </div>

      <div v-else class="objective-state mt-3">
        <i class="bi bi-info-circle text-muted"></i>
        <span>No elite-monster objective events were present in this replay.</span>
      </div>
    </template>

    <div v-else class="objective-state mt-3">
      <i class="bi bi-hourglass-split text-muted"></i>
      <span>Load a replay to decode its objective timeline.</span>
    </div>
  </section>
</template>

<style scoped>
.objective-timeline {
  min-width: 0;
}

.objective-state {
  min-height: 4rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 1rem;
  color: var(--bs-secondary-color);
  border: 1px dashed rgba(255, 255, 255, 0.12);
  border-radius: 0.75rem;
}

.monster-count-grid,
.diagnostic-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 0.5rem;
}

.monster-count-card {
  min-width: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  gap: 0 0.5rem;
  align-items: center;
  padding: 0.7rem;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0.75rem;
}

.monster-count-card > i {
  grid-row: 1 / 3;
  font-size: 1.25rem;
}

.monster-count-value {
  font-family: var(--bs-font-monospace);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1;
}

.monster-count-label {
  overflow: hidden;
  color: var(--bs-secondary-color);
  font-size: 0.65rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diagnostic-strip {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.diagnostic-strip > div {
  min-width: 0;
  padding: 0.75rem;
  background: rgba(255, 255, 255, 0.035);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0.75rem;
}

.diagnostic-value,
.diagnostic-label {
  display: block;
}

.diagnostic-value {
  overflow: hidden;
  color: var(--bs-warning);
  font-family: var(--bs-font-monospace);
  font-size: 0.95rem;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diagnostic-label {
  margin-top: 0.15rem;
  color: var(--bs-secondary-color);
  font-size: 0.68rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.objective-track-shell {
  padding: 0.75rem 0.75rem 0.35rem;
  background: rgba(0, 0, 0, 0.16);
  border-radius: 0.75rem;
}

.objective-track {
  position: relative;
  height: 0.35rem;
  margin: 0.5rem 0.4rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 999px;
}

.objective-marker {
  position: absolute;
  top: 50%;
  width: 0.72rem;
  height: 0.72rem;
  padding: 0;
  border: 2px solid var(--bs-body-bg);
  border-radius: 0.2rem;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
  transform: translate(-50%, -50%) rotate(45deg);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}

.objective-marker:hover,
.objective-marker.active {
  z-index: 2;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.26);
  transform: translate(-50%, -50%) rotate(45deg) scale(1.35);
}

.objective-event-list {
  max-height: 24rem;
  overflow: auto;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0.75rem;
}

.objective-event-row {
  width: 100%;
  display: grid;
  grid-template-columns: 4.5rem 2.4rem minmax(9rem, 1fr) minmax(10rem, 1.2fr) 9rem;
  gap: 0.65rem;
  align-items: center;
  padding: 0.7rem 0.8rem;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.objective-event-row:last-child {
  border-bottom: 0;
}

.objective-event-row:hover,
.objective-event-row.active {
  background: rgba(255, 193, 7, 0.075);
}

.objective-event-row.active {
  box-shadow: inset 3px 0 0 var(--bs-warning);
}

.objective-time {
  color: var(--bs-warning);
  font-family: var(--bs-font-monospace);
  font-size: 0.82rem;
  font-weight: 700;
}

.objective-icon {
  width: 2.2rem;
  height: 2.2rem;
  display: grid;
  place-items: center;
  border-radius: 0.65rem;
  background: rgba(255, 255, 255, 0.06);
}

.objective-name {
  min-width: 0;
}

.objective-name strong,
.objective-name small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.objective-name small {
  color: var(--bs-secondary-color);
  font-size: 0.68rem;
}

.objective-unknowns {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.unresolved-chip {
  padding: 0.15rem 0.4rem;
  color: var(--bs-secondary-color);
  font-size: 0.65rem;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 999px;
}

.objective-source {
  font-family: var(--bs-font-monospace);
  font-size: 0.68rem;
  text-align: right;
}

.monster-dragon {
  color: #ff7b5c;
  background-color: rgba(255, 123, 92, 0.15);
}

.monster-atakhan {
  color: #e875ff;
  background-color: rgba(232, 117, 255, 0.15);
}

.monster-baron-nashor {
  color: #b990ff;
  background-color: rgba(185, 144, 255, 0.15);
}

.monster-riftherald {
  color: #7c9cff;
  background-color: rgba(124, 156, 255, 0.15);
}

.monster-horde {
  color: #68d5b5;
  background-color: rgba(104, 213, 181, 0.15);
}

.monster-unknown {
  color: #adb5bd;
  background-color: rgba(173, 181, 189, 0.12);
}

.x-small {
  font-size: 0.7rem;
}

@media (max-width: 1200px) {
  .monster-count-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 768px) {
  .monster-count-grid,
  .diagnostic-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .objective-event-row {
    grid-template-columns: 3.5rem 2.2rem minmax(7rem, 1fr);
  }

  .objective-unknowns,
  .objective-source {
    display: none;
  }
}
</style>
