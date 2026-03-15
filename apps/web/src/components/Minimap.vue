<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { type PlayerMovementData, usePlayback } from "../composables/usePlayback";

const props = withDefaults(
  defineProps<{
    playerData?: PlayerMovementData[];
    label?: string;
    emptyMessage?: string;
  }>(),
  {
    playerData: () => [],
    label: "Minimap",
    emptyMessage: "No map coordinates are available from the current parser output.",
  },
);

const { currentTime } = usePlayback();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const mapSize = 512;
const leagueMapSize = 15000;

const hasRenderablePlayers = computed(() =>
  props.playerData.some((player) => player.positions.length > 0),
);

function toCanvasCoord(leagueCoord: number): number {
  return (leagueCoord / leagueMapSize) * mapSize;
}

function drawBackground(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createLinearGradient(0, 0, mapSize, mapSize);
  gradient.addColorStop(0, "#20331e");
  gradient.addColorStop(0.5, "#2a4030");
  gradient.addColorStop(1, "#19262a");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, mapSize, mapSize);

  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let index = 1; index < 8; index += 1) {
    const offset = (mapSize / 8) * index;
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset, mapSize);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, offset);
    ctx.lineTo(mapSize, offset);
    ctx.stroke();
  }
}

function drawPlayers(ctx: CanvasRenderingContext2D): void {
  for (const player of props.playerData) {
    if (player.positions.length === 0) {
      continue;
    }

    const currentPos = player.positions.reduce((previous, current) => {
      if (current.timestamp <= currentTime.value) {
        return current;
      }
      return previous;
    }, player.positions[0]);

    const x = toCanvasCoord(currentPos.x);
    const y = mapSize - toCanvasCoord(currentPos.y);

    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = player.team === 100 ? "#4a9eff" : "#ff6c5f";
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = "white";
    ctx.font = "bold 10px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(player.champion, x, y - 12);
  }
}

function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }

  ctx.clearRect(0, 0, mapSize, mapSize);
  drawBackground(ctx);
  drawPlayers(ctx);
}

let animationFrame = 0;

function loop(): void {
  draw();
  animationFrame = requestAnimationFrame(loop);
}

onMounted(() => {
  loop();
});

onUnmounted(() => {
  cancelAnimationFrame(animationFrame);
});
</script>

<template>
  <div class="minimap-container">
    <canvas ref="canvasRef" :width="mapSize" :height="mapSize" class="minimap-canvas"></canvas>
    <div class="minimap-overlay">
      <div class="minimap-label">{{ label }}</div>
    </div>
    <div v-if="!hasRenderablePlayers" class="empty-overlay">
      <p>{{ emptyMessage }}</p>
    </div>
  </div>
</template>

<style scoped>
.minimap-container {
  position: relative;
  width: min(100%, 512px);
  aspect-ratio: 1;
  border: 2px solid var(--border-strong);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.18);
  background: #1f2f27;
}

.minimap-canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.minimap-overlay {
  position: absolute;
  top: 12px;
  left: 12px;
  pointer-events: none;
}

.minimap-label {
  padding: 4px 10px;
  background: rgba(0, 0, 0, 0.6);
  color: white;
  border-radius: 6px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.empty-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  background: linear-gradient(180deg, rgba(14, 18, 21, 0.22), rgba(14, 18, 21, 0.48));
}

.empty-overlay p {
  max-width: 26ch;
  padding: 16px 18px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.88);
  color: #17202a;
  font-weight: 600;
}
</style>
