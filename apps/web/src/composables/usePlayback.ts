import { computed, ref } from "vue";

export interface PlayerPosition {
  x: number;
  y: number;
  timestamp: number;
  source?: "frame" | "event";
}

export interface PlayerMovementData {
  champion: string;
  team: number;
  positions: PlayerPosition[];
  playerName?: string;
  championIconSrc?: string;
  roleLabel?: string;
}

const currentTime = ref(0);
const isPlaying = ref(false);
const playbackSpeed = ref(1);
const duration = ref(0);

let lastFrameTime = 0;
let animationFrameId: number | null = null;

export function usePlayback() {
  const isFinished = computed(() => currentTime.value >= duration.value);

  const setDuration = (newDuration: number) => {
    duration.value = newDuration;
  };

  const play = () => {
    if (isFinished.value) {
      currentTime.value = 0;
    }
    isPlaying.value = true;
    lastFrameTime = performance.now();
    animate();
  };

  const pause = () => {
    isPlaying.value = false;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  };

  const togglePlayback = () => {
    if (isPlaying.value) {
      pause();
    } else {
      play();
    }
  };

  const seek = (time: number) => {
    currentTime.value = Math.max(0, Math.min(time, duration.value));
  };

  const animate = () => {
    if (!isPlaying.value) return;

    const now = performance.now();
    const delta = now - lastFrameTime;
    lastFrameTime = now;

    currentTime.value += delta * playbackSpeed.value;

    if (currentTime.value >= duration.value) {
      currentTime.value = duration.value;
      pause();
    } else {
      animationFrameId = requestAnimationFrame(animate);
    }
  };

  return {
    currentTime,
    isPlaying,
    playbackSpeed,
    duration,
    isFinished,
    setDuration,
    play,
    pause,
    togglePlayback,
    seek,
  };
}
