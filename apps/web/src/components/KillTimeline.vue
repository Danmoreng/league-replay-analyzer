<script setup lang="ts">
import { computed } from "vue";

import { usePlayback } from "../composables/usePlayback";
import {
  formatReplayKillTimestamp,
  replayKillParticipantName,
  summarizeReplayKillDiagnostics,
  type ReplayKillEvent,
  type ReplayKillParticipant,
  type ReplayKillResult,
} from "../replayKills";

const props = defineProps<{
  result: ReplayKillResult | null;
  isLoading: boolean;
  errorMessage: string;
}>();

const { currentTime, seek } = usePlayback();

const events = computed(() =>
  [...(props.result?.events ?? [])].sort(
    (left, right) => left.timestampMillis - right.timestampMillis,
  ),
);

const participantById = computed(
  () =>
    new Map(
      (props.result?.participants ?? []).map((participant) => [
        participant.participantId,
        participant,
      ]),
    ),
);

const diagnosticSummary = computed(() =>
  props.result ? summarizeReplayKillDiagnostics(props.result) : "",
);

const validation = computed(() => props.result?.diagnostics.finalKdaValidation ?? null);

const activeEvent = computed(() => {
  let active: ReplayKillEvent | null = null;
  for (const event of events.value) {
    if (event.timestampMillis > currentTime.value) {
      break;
    }
    active = event;
  }
  return active;
});

function participant(participantId: number): ReplayKillParticipant | undefined {
  return participantById.value.get(participantId);
}

function championLabel(participantId: number): string {
  return participant(participantId)?.championName ?? `P${participantId}`;
}

function playerLabel(participantId: number): string {
  return replayKillParticipantName(participant(participantId));
}

function teamClass(participantId: number): string {
  return participant(participantId)?.teamId === 200 ? "team-red" : "team-blue";
}

function eventProgress(event: ReplayKillEvent): string {
  const duration = props.result?.replay.gameLengthMillis ?? 0;
  if (duration <= 0) {
    return "0%";
  }
  return `${Math.min(100, Math.max(0, (event.timestampMillis / duration) * 100))}%`;
}

function openEvent(event: ReplayKillEvent): void {
  seek(event.timestampMillis);
}
</script>

<template>
  <section class="island p-3 kill-timeline">
    <div class="d-flex flex-wrap justify-content-between align-items-start gap-3">
      <div>
        <div class="d-flex align-items-center gap-2 mb-1">
          <h2 class="fs-5 mb-0">Replay-Derived Kills</h2>
          <span class="badge bg-info-subtle text-info-emphasis">ROFL → C++ → Wasm</span>
        </div>
        <p class="text-muted small mb-0">
          Champion-kill events decoded locally from packet blocks. Riot API data is not used at
          runtime.
        </p>
      </div>
      <div v-if="result" class="d-flex flex-wrap gap-2 justify-content-end">
        <span class="badge bg-primary-subtle text-primary-emphasis">
          {{ events.length }} events
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
        <span
          class="badge"
          :class="
            validation?.pass
              ? 'bg-success-subtle text-success-emphasis'
              : 'bg-warning-subtle text-warning-emphasis'
          "
        >
          K/D/A {{ validation?.passingParticipantCount ?? 0 }}/{{
            validation?.participantCount ?? 0
          }}
        </span>
      </div>
    </div>

    <div v-if="isLoading" class="kill-state mt-3">
      <span class="spinner-border spinner-border-sm text-info" role="status"></span>
      <span>Decoding champion kills from replay packet blocks…</span>
    </div>

    <div v-else-if="errorMessage" class="alert alert-warning mt-3 mb-0 small">
      <div class="fw-bold mb-1">Kill timeline unavailable for this replay</div>
      <div>{{ errorMessage }}</div>
      <div class="text-muted mt-1">
        The metadata, player summary, and other replay tools remain available.
      </div>
    </div>

    <template v-else-if="result">
      <div class="diagnostic-strip mt-3">
        <div>
          <span class="diagnostic-value">{{
            result.diagnostics.packetBlockCount.toLocaleString()
          }}</span>
          <span class="diagnostic-label">packet blocks</span>
        </div>
        <div>
          <span class="diagnostic-value">{{
            result.diagnostics.chunkRecordCount.toLocaleString()
          }}</span>
          <span class="diagnostic-label">chunks scanned</span>
        </div>
        <div>
          <span class="diagnostic-value">{{ result.profile.ownerSequencePacketTypeHex }}</span>
          <span class="diagnostic-label">owner sequence</span>
        </div>
        <div>
          <span class="diagnostic-value">{{ result.profile.deathMarkerPacketTypeHex }}</span>
          <span class="diagnostic-label">death marker</span>
        </div>
      </div>
      <p class="small text-muted mt-2 mb-0">{{ diagnosticSummary }}</p>

      <div v-if="events.length" class="kill-track-shell mt-3">
        <div class="kill-track">
          <button
            v-for="(event, index) in events"
            :key="`${event.timestampMillis}:${event.victimParticipantId}:${index}`"
            type="button"
            class="kill-marker"
            :class="[teamClass(event.killerParticipantId), { active: activeEvent === event }]"
            :style="{ left: eventProgress(event) }"
            :title="`${formatReplayKillTimestamp(event.timestampMillis)} — ${championLabel(event.killerParticipantId)} → ${championLabel(event.victimParticipantId)}`"
            @click="openEvent(event)"
          ></button>
        </div>
        <div class="d-flex justify-content-between text-muted x-small mt-1">
          <span>0:00</span>
          <span>{{ formatReplayKillTimestamp(result.replay.gameLengthMillis ?? 0) }}</span>
        </div>
      </div>

      <div v-if="events.length" class="kill-event-list mt-3">
        <button
          v-for="(event, index) in events"
          :key="`${event.provenance.deathMarker.segmentId}:${event.provenance.deathMarker.blockIndex}:${index}`"
          type="button"
          class="kill-event-row"
          :class="{ active: activeEvent === event }"
          @click="openEvent(event)"
        >
          <span class="kill-time">{{ formatReplayKillTimestamp(event.timestampMillis) }}</span>

          <span v-if="event.killerParticipantId > 0" class="kill-participant">
            <span class="team-dot" :class="teamClass(event.killerParticipantId)"></span>
            <span>
              <strong>{{ championLabel(event.killerParticipantId) }}</strong>
              <small>{{ playerLabel(event.killerParticipantId) }}</small>
            </span>
          </span>
          <span v-else class="kill-participant">
            <span class="team-dot execution"></span>
            <span>
              <strong>Execution</strong>
              <small>No champion killer</small>
            </span>
          </span>

          <i class="bi bi-arrow-right kill-arrow" aria-hidden="true"></i>

          <span class="kill-participant">
            <span class="team-dot" :class="teamClass(event.victimParticipantId)"></span>
            <span>
              <strong>{{ championLabel(event.victimParticipantId) }}</strong>
              <small>{{ playerLabel(event.victimParticipantId) }}</small>
            </span>
          </span>

          <span class="kill-assists">
            <small class="text-muted">Assists</small>
            <span v-if="event.assistingParticipantIds.length" class="assist-list">
              <span
                v-for="participantId in event.assistingParticipantIds"
                :key="participantId"
                class="assist-chip"
                :title="playerLabel(participantId)"
              >
                {{ championLabel(participantId) }}
              </span>
            </span>
            <span v-else class="text-muted small">—</span>
          </span>

          <span class="kill-source text-muted">
            chunk {{ event.provenance.deathMarker.chunkId }}
          </span>
        </button>
      </div>

      <div v-else class="kill-state mt-3">
        <i class="bi bi-shield-check text-success"></i>
        <span>No champion-kill events were present in the decoded replay timeline.</span>
      </div>
    </template>

    <div v-else class="kill-state mt-3">
      <i class="bi bi-hourglass-split text-muted"></i>
      <span>Load a replay to decode its champion-kill timeline.</span>
    </div>
  </section>
</template>

<style scoped>
.kill-timeline {
  min-width: 0;
}

.kill-state {
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

.diagnostic-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0.5rem;
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
  color: var(--bs-info);
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

.kill-track-shell {
  padding: 0.75rem 0.75rem 0.35rem;
  background: rgba(0, 0, 0, 0.16);
  border-radius: 0.75rem;
}

.kill-track {
  position: relative;
  height: 0.35rem;
  margin: 0.5rem 0.4rem;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 999px;
}

.kill-marker {
  position: absolute;
  top: 50%;
  width: 0.65rem;
  height: 0.65rem;
  padding: 0;
  border: 2px solid var(--bs-body-bg);
  border-radius: 999px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.14);
  transform: translate(-50%, -50%);
  transition:
    transform 120ms ease,
    box-shadow 120ms ease;
}

.kill-marker:hover,
.kill-marker.active {
  z-index: 2;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.26);
  transform: translate(-50%, -50%) scale(1.35);
}

.kill-event-list {
  max-height: 27rem;
  overflow: auto;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0.75rem;
}

.kill-event-row {
  width: 100%;
  display: grid;
  grid-template-columns: 4.5rem minmax(9rem, 1fr) 1.5rem minmax(9rem, 1fr) minmax(8rem, 1.2fr) 5rem;
  gap: 0.6rem;
  align-items: center;
  padding: 0.7rem 0.8rem;
  color: inherit;
  text-align: left;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.055);
}

.kill-event-row:last-child {
  border-bottom: 0;
}

.kill-event-row:hover,
.kill-event-row.active {
  background: rgba(13, 202, 240, 0.08);
}

.kill-event-row.active {
  box-shadow: inset 3px 0 0 var(--bs-info);
}

.kill-time {
  color: var(--bs-info);
  font-family: var(--bs-font-monospace);
  font-size: 0.82rem;
  font-weight: 700;
}

.kill-participant {
  min-width: 0;
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.kill-participant > span:last-child {
  min-width: 0;
}

.kill-participant strong,
.kill-participant small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kill-participant small {
  color: var(--bs-secondary-color);
  font-size: 0.68rem;
}

.team-dot {
  width: 0.65rem;
  height: 0.65rem;
  flex: 0 0 auto;
  border-radius: 999px;
}

.team-blue {
  background: #2f9bff;
}

.team-red {
  background: #ff5d73;
}

.execution {
  background: #adb5bd;
}

.kill-arrow {
  color: var(--bs-danger);
  text-align: center;
}

.kill-assists {
  min-width: 0;
}

.kill-assists > small {
  display: block;
  margin-bottom: 0.2rem;
}

.assist-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem;
}

.assist-chip {
  max-width: 7rem;
  padding: 0.12rem 0.35rem;
  overflow: hidden;
  color: var(--bs-secondary-color);
  font-size: 0.66rem;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 0.3rem;
}

.kill-source {
  font-family: var(--bs-font-monospace);
  font-size: 0.68rem;
  text-align: right;
}

.x-small {
  font-size: 0.7rem;
}

@media (max-width: 992px) {
  .diagnostic-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .kill-event-row {
    grid-template-columns: 3.5rem minmax(7rem, 1fr) 1rem minmax(7rem, 1fr);
  }

  .kill-assists,
  .kill-source {
    display: none;
  }
}
</style>
