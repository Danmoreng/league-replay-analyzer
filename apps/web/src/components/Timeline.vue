<script setup lang="ts">
import { computed } from "vue";
import { usePlayback } from "../composables/usePlayback";

const { currentTime, duration, isPlaying, togglePlayback, seek, playbackSpeed } = usePlayback();

const progress = computed(() => {
  if (duration.value === 0) return 0;
  return (currentTime.value / duration.value) * 100;
});

function formatTime(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function onScrub(event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  seek(value);
}

const speeds = [1, 2, 4, 8];
</script>

<template>
  <div class="timeline-bar">
    <div class="playback-controls">
      <button class="play-button" @click="togglePlayback">
        {{ isPlaying ? "Pause" : "Play" }}
      </button>

      <div class="time-display">
        <strong>{{ formatTime(currentTime) }}</strong>
        <span>/</span>
        <span>{{ formatTime(duration) }}</span>
      </div>

      <div class="scrubber-container">
        <input
          type="range"
          class="scrubber"
          :min="0"
          :max="duration"
          :step="100"
          :value="currentTime"
          @input="onScrub"
        />
        <div class="scrubber-progress" :style="{ width: progress + '%' }"></div>
      </div>

      <div class="speed-selector">
        <button
          v-for="speed in speeds"
          :key="speed"
          class="speed-button"
          :class="{ active: playbackSpeed === speed }"
          @click="playbackSpeed = speed"
        >
          {{ speed }}x
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.timeline-bar {
  padding: 16px 24px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 20px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
}

.playback-controls {
  display: flex;
  align-items: center;
  gap: 20px;
}

.play-button {
  min-width: 80px;
  padding: 8px 16px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 999px;
  font-weight: 700;
  cursor: pointer;
}

.play-button:hover {
  filter: brightness(1.1);
}

.time-display {
  display: flex;
  gap: 6px;
  font-family: monospace;
  font-size: 1.1rem;
}

.time-display span {
  color: var(--text-muted);
}

.scrubber-container {
  position: relative;
  flex: 1;
  height: 8px;
  display: flex;
  align-items: center;
}

.scrubber {
  position: absolute;
  width: 100%;
  height: 100%;
  appearance: none;
  background: #ece7dc;
  border-radius: 999px;
  outline: none;
  cursor: pointer;
  z-index: 2;
  margin: 0;
}

.scrubber::-webkit-slider-thumb {
  appearance: none;
  width: 16px;
  height: 16px;
  background: var(--accent);
  border-radius: 50%;
  border: 2px solid white;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
}

.scrubber-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  background: var(--accent-2);
  border-radius: 999px;
  pointer-events: none;
  z-index: 1;
}

.speed-selector {
  display: flex;
  background: var(--surface-strong);
  padding: 4px;
  border-radius: 12px;
  gap: 4px;
}

.speed-button {
  padding: 4px 10px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
}

.speed-button.active {
  background: white;
  color: var(--accent);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}
</style>
