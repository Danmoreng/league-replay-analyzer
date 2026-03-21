<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";

import { type PlayerMovementData, usePlayback } from "../composables/usePlayback";

const props = withDefaults(
  defineProps<{
    playerData?: PlayerMovementData[];
    comparisonData?: PlayerMovementData[];
    emptyMessage?: string;
    backgroundImageSrc?: string;
    primaryLabel?: string;
    comparisonLabel?: string;
  }>(),
  {
    playerData: () => [],
    comparisonData: () => [],
    emptyMessage: "No map coordinates are available from the current parser output.",
    backgroundImageSrc: "/summoners-rift-minimap.png",
    primaryLabel: "Primary",
    comparisonLabel: "Comparison",
  },
);

const { currentTime } = usePlayback();
const canvasRef = ref<HTMLCanvasElement | null>(null);
const mapSize = 768;
const leagueMapSize = 15000;
const trailPointCount = 5;

const roleOrder = ["Top", "Jungle", "Middle", "Bottom", "Support", "Utility", "Unknown"];

const renderablePlayers = computed(() =>
  props.playerData.filter((player) => player.positions.length > 0),
);
const renderableComparisonPlayers = computed(() =>
  props.comparisonData.filter((player) => player.positions.length > 0),
);
const hasRenderablePlayers = computed(() => renderablePlayers.value.length > 0);
const hasRenderableComparisonPlayers = computed(() => renderableComparisonPlayers.value.length > 0);

function toCanvasCoord(leagueCoord: number): number {
  return (leagueCoord / leagueMapSize) * mapSize;
}

function getTeamColor(team: number, alpha = 1): string {
  return team === 100 ? `rgba(74, 158, 255, ${alpha})` : `rgba(255, 108, 95, ${alpha})`;
}

function getVisiblePositions(player: PlayerMovementData) {
  const visible = [];
  for (const position of player.positions) {
    if (position.timestamp <= currentTime.value) {
      visible.push(position);
      continue;
    }
    break;
  }

  return visible.length > 0 ? visible : [player.positions[0]];
}

function getComparisonColor(team: number, alpha = 1): string {
  return team === 100 ? `rgba(147, 224, 255, ${alpha})` : `rgba(255, 211, 132, ${alpha})`;
}

function getRoleRank(roleLabel?: string): number {
  const role = roleLabel ?? "Unknown";
  const exactIndex = roleOrder.indexOf(role);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const normalized = role.toLowerCase();
  if (normalized.includes("top")) return 0;
  if (normalized.includes("jungle")) return 1;
  if (normalized.includes("mid")) return 2;
  if (normalized.includes("bottom") || normalized.includes("bot") || normalized.includes("adc")) return 3;
  if (normalized.includes("support")) return 4;
  return roleOrder.length - 1;
}

const markerPlayers = computed(() =>
  renderablePlayers.value.map((player) => {
    const visiblePositions = getVisiblePositions(player);
    const currentPosition = visiblePositions[visiblePositions.length - 1];

    return {
      champion: player.champion,
      playerName: player.playerName ?? "Unknown Player",
      championIconSrc: player.championIconSrc ?? "",
      roleLabel: player.roleLabel ?? "Unknown",
      team: player.team,
      left: `${(currentPosition.x / leagueMapSize) * 100}%`,
      top: `${100 - ((currentPosition.y / leagueMapSize) * 100)}%`,
    };
  }),
);

const blueTeamPlayers = computed(() =>
  markerPlayers.value
    .filter((player) => player.team === 100)
    .sort((left, right) => getRoleRank(left.roleLabel) - getRoleRank(right.roleLabel) || left.champion.localeCompare(right.champion)),
);

const redTeamPlayers = computed(() =>
  markerPlayers.value
    .filter((player) => player.team === 200)
    .sort((left, right) => getRoleRank(left.roleLabel) - getRoleRank(right.roleLabel) || left.champion.localeCompare(right.champion)),
);

function drawTrail(ctx: CanvasRenderingContext2D, player: PlayerMovementData, positions: PlayerMovementData["positions"]): void {
  if (positions.length < 2) {
    return;
  }

  const visibleTrail = positions.slice(-trailPointCount);
  for (let index = 1; index < visibleTrail.length; index += 1) {
    const previous = visibleTrail[index - 1];
    const current = visibleTrail[index];
    const alpha = 0.18 + ((0.74 * index) / (visibleTrail.length - 1));

    ctx.beginPath();
    ctx.moveTo(toCanvasCoord(previous.x), mapSize - toCanvasCoord(previous.y));
    ctx.lineTo(toCanvasCoord(current.x), mapSize - toCanvasCoord(current.y));
    ctx.strokeStyle = getTeamColor(player.team, alpha);
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
  }
}

function drawComparisonTrail(ctx: CanvasRenderingContext2D, player: PlayerMovementData, positions: PlayerMovementData["positions"]): void {
  if (positions.length < 2) {
    return;
  }

  const visibleTrail = positions.slice(-trailPointCount);
  for (let index = 1; index < visibleTrail.length; index += 1) {
    const previous = visibleTrail[index - 1];
    const current = visibleTrail[index];
    const alpha = 0.2 + ((0.55 * index) / (visibleTrail.length - 1));

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([8, 7]);
    ctx.moveTo(toCanvasCoord(previous.x), mapSize - toCanvasCoord(previous.y));
    ctx.lineTo(toCanvasCoord(current.x), mapSize - toCanvasCoord(current.y));
    ctx.strokeStyle = getComparisonColor(player.team, alpha);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }
}

function drawComparisonMarker(ctx: CanvasRenderingContext2D, player: PlayerMovementData, positions: PlayerMovementData["positions"]): void {
  if (positions.length === 0) {
    return;
  }

  const current = positions[positions.length - 1];
  const x = toCanvasCoord(current.x);
  const y = mapSize - toCanvasCoord(current.y);

  ctx.save();
  ctx.strokeStyle = getComparisonColor(player.team, 0.95);
  ctx.fillStyle = "rgba(8, 11, 18, 0.88)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawPlayers(ctx: CanvasRenderingContext2D): void {
  for (const player of renderableComparisonPlayers.value) {
    const visiblePositions = getVisiblePositions(player);
    drawComparisonTrail(ctx, player, visiblePositions);
    drawComparisonMarker(ctx, player, visiblePositions);
  }

  for (const player of renderablePlayers.value) {
    const visiblePositions = getVisiblePositions(player);
    drawTrail(ctx, player, visiblePositions);
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
  <div class="minimap-shell">
    <div v-if="hasRenderablePlayers" class="team-column team-column-left">
      <div v-for="player in blueTeamPlayers" :key="`${player.team}-${player.champion}-${player.playerName}-left`" class="team-item">
        <img v-if="player.championIconSrc" :src="player.championIconSrc" :alt="player.champion" class="team-icon blue-team" />
        <div v-else class="team-icon team-fallback blue-team"></div>
        <div class="team-copy team-copy-left">
          <div class="team-role">{{ player.roleLabel }}</div>
          <div class="team-champion">{{ player.champion }}</div>
          <div class="team-player">{{ player.playerName }}</div>
        </div>
      </div>
    </div>

    <div class="minimap-container">
      <img :src="backgroundImageSrc" alt="Summoner's Rift minimap" class="map-background" />
      <canvas ref="canvasRef" :width="mapSize" :height="mapSize" class="minimap-canvas"></canvas>
      <div class="marker-layer">
        <div
          v-for="player in markerPlayers"
          :key="`${player.team}-${player.champion}-${player.playerName}`"
          class="marker"
          :style="{ left: player.left, top: player.top }"
        >
          <img
            v-if="player.championIconSrc"
            :src="player.championIconSrc"
            :alt="player.champion"
            class="champion-icon"
            :class="player.team === 100 ? 'blue-team' : 'red-team'"
          />
          <div v-else class="marker-dot" :class="player.team === 100 ? 'blue-team' : 'red-team'"></div>
        </div>
      </div>
      <div v-if="hasRenderableComparisonPlayers" class="comparison-legend">
        <span class="legend-chip legend-primary">{{ primaryLabel }}</span>
        <span class="legend-chip legend-comparison">{{ comparisonLabel }}</span>
      </div>
      <div v-if="!hasRenderablePlayers" class="empty-overlay">
        <p>{{ emptyMessage }}</p>
      </div>
    </div>

    <div v-if="hasRenderablePlayers" class="team-column team-column-right">
      <div v-for="player in redTeamPlayers" :key="`${player.team}-${player.champion}-${player.playerName}-right`" class="team-item team-item-right">
        <div class="team-copy team-copy-right">
          <div class="team-role">{{ player.roleLabel }}</div>
          <div class="team-champion">{{ player.champion }}</div>
          <div class="team-player">{{ player.playerName }}</div>
        </div>
        <img v-if="player.championIconSrc" :src="player.championIconSrc" :alt="player.champion" class="team-icon red-team" />
        <div v-else class="team-icon team-fallback red-team"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.minimap-shell {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(148px, 176px) minmax(0, 1fr) minmax(148px, 176px);
  gap: 12px;
  align-items: stretch;
}

.team-column {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
}

.team-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 74px;
  padding: 10px 11px;
  background: rgba(8, 13, 20, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
}

.team-item-right {
  justify-content: flex-end;
}

.team-copy {
  min-width: 0;
}

.team-copy-left {
  text-align: left;
}

.team-copy-right {
  text-align: right;
}

.team-role {
  color: rgba(255, 255, 255, 0.58);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.team-champion {
  color: white;
  font-size: 0.88rem;
  font-weight: 700;
  line-height: 1.15;
}

.team-player {
  color: rgba(255, 255, 255, 0.72);
  font-size: 0.74rem;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.minimap-container {
  position: relative;
  width: 100%;
  max-width: none;
  aspect-ratio: 1;
  border: 2px solid var(--border-strong);
  border-radius: 18px;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.22);
  background: #10161d;
}

.map-background {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.minimap-canvas {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  height: 100%;
}

.marker-layer {
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
}

.marker {
  position: absolute;
  width: 28px;
  height: 28px;
  transform: translate(-50%, -50%);
}

.champion-icon,
.team-icon,
.marker-dot {
  display: block;
  object-fit: cover;
  border-radius: 999px;
  background: rgba(8, 11, 18, 0.92);
}

.champion-icon {
  width: 28px;
  height: 28px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
}

.marker-dot {
  width: 18px;
  height: 18px;
  margin: 5px;
}

.team-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.team-fallback {
  background: rgba(255, 255, 255, 0.14);
}

.blue-team {
  box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.95), 0 0 0 4px rgba(8, 11, 18, 0.8);
}

.red-team {
  box-shadow: 0 0 0 2px rgba(255, 108, 95, 0.95), 0 0 0 4px rgba(8, 11, 18, 0.8);
}

.empty-overlay {
  position: absolute;
  z-index: 3;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  background: linear-gradient(180deg, rgba(6, 10, 16, 0.18), rgba(6, 10, 16, 0.56));
}

.empty-overlay p {
  max-width: 28ch;
  padding: 16px 18px;
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.9);
  color: #17202a;
  font-weight: 600;
}

.comparison-legend {
  position: absolute;
  z-index: 3;
  left: 14px;
  bottom: 14px;
  display: flex;
  gap: 8px;
  pointer-events: none;
}

.legend-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: 999px;
  background: rgba(8, 11, 18, 0.84);
  color: white;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.legend-primary::before,
.legend-comparison::before {
  content: "";
  display: inline-block;
  width: 14px;
  height: 0;
  border-top: 3px solid currentColor;
}

.legend-primary {
  color: rgba(255, 255, 255, 0.9);
}

.legend-comparison {
  color: rgba(255, 211, 132, 0.95);
}

.legend-comparison::before {
  border-top-style: dashed;
}

@media (max-width: 1080px) {
  .minimap-shell {
    grid-template-columns: 1fr;
  }

  .team-column-left {
    order: 1;
  }

  .minimap-container {
    order: 2;
  }

  .team-column-right {
    order: 3;
  }
}
</style>
