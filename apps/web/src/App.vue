<script setup lang="ts">
import { computed, ref } from "vue";

import DataBrowser from "./components/DataBrowser.vue";
import KillTimeline from "./components/KillTimeline.vue";
import ObjectiveTimeline from "./components/ObjectiveTimeline.vue";
import ProductReplayView from "./components/ProductReplayView.vue";
import ReplayInspector from "./components/ReplayInspector.vue";
import Minimap from "./components/Minimap.vue";
import Timeline from "./components/Timeline.vue";
import Sidebar from "./components/Sidebar.vue";
import { usePlayback, type PlayerMovementData } from "./composables/usePlayback";
import { buildReplayBrowserModel, type ReplayBrowserModel } from "./replayBrowser";
import {
  deriveRiotMatchIdFromReplayName,
  loadRiotFixtureBundle,
  type RiotFixtureBundle,
  type RiotMatchParticipant,
} from "./riotApiFixtures";
import {
  loadReplayMovementFixture,
  type LoadedReplayMovementFixture,
} from "./replayMovementFixtures";
import { type PlayerSummary, type ReplaySummary } from "./replayParser";
import type { ReplayKillResult } from "./replayKills";
import type { ReplayObjectiveResult } from "./replayObjectives";
import type { ReplayWardResult } from "./replayWards";
import type { ReplayDirectItemPurchasesResult } from "./replayDirectItemPurchases";
import type { ReplayItemSalesResult } from "./replayItemSales";
import type { ReplayPurchaseLinkedItemUpdatesResult } from "./replayPurchaseLinkedItemUpdates";
import {
  extractReplayDirectItemPurchasesWithWasm,
  extractReplayItemSalesWithWasm,
  extractReplayKillsWithWasm,
  extractReplayObjectivesWithWasm,
  extractReplayPurchaseLinkedItemUpdatesWithWasm,
  extractReplayWardsWithWasm,
  parseReplayBufferWithWasm,
} from "./wasmReplayParser";

const { seek, setDuration } = usePlayback();
const summary = ref<ReplaySummary | null>(null);
const browserModel = ref<ReplayBrowserModel | null>(null);
const riotBundle = ref<RiotFixtureBundle | null>(null);
const apiMovement = ref<PlayerMovementData[]>([]);
const replayMovement = ref<PlayerMovementData[]>([]);
const riotFixtureStatus = ref("No Riot fixture loaded yet.");
const replayKills = ref<ReplayKillResult | null>(null);
const replayKillsError = ref("");
const isLoadingReplayKills = ref(false);
const replayObjectives = ref<ReplayObjectiveResult | null>(null);
const replayObjectivesError = ref("");
const isLoadingReplayObjectives = ref(false);
const replayWards = ref<ReplayWardResult | null>(null);
const replayWardsError = ref("");
const isLoadingReplayWards = ref(false);
const replayPurchaseLinkedItemUpdates = ref<ReplayPurchaseLinkedItemUpdatesResult | null>(null);
const replayPurchaseLinkedItemUpdatesError = ref("");
const isLoadingReplayPurchaseLinkedItemUpdates = ref(false);
const replayDirectItemPurchases = ref<ReplayDirectItemPurchasesResult | null>(null);
const replayDirectItemPurchasesError = ref("");
const isLoadingReplayDirectItemPurchases = ref(false);
const replayItemSales = ref<ReplayItemSalesResult | null>(null);
const replayItemSalesError = ref("");
const isLoadingReplayItemSales = ref(false);
const replayMovementStatus = ref("No replay-derived movement fixture loaded yet.");
const replayBuffer = ref<ArrayBuffer | null>(null);
const loadedReplayName = ref("");
const status = ref("Pick a replay file to parse it with the C++/Wasm replay parser.");
const errorMessage = ref("");
const isLoading = ref(false);
const activePage = ref<"product" | "summary" | "browser" | "inspector">("product");
let replayLoadRequest = 0;
const headerStatus = computed(() => {
  if (activePage.value !== "product" || !summary.value) {
    return status.value;
  }

  if (
    isLoading.value ||
    isLoadingReplayKills.value ||
    isLoadingReplayObjectives.value ||
    isLoadingReplayWards.value ||
    isLoadingReplayPurchaseLinkedItemUpdates.value ||
    isLoadingReplayDirectItemPurchases.value ||
    isLoadingReplayItemSales.value
  ) {
    return "Replay wird lokal dekodiert …";
  }

  return "Timeline bereit · Ereignisse lokal aus der geladenen Replay-Datei dekodiert";
});
function toDdragonVersion(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) {
    return "16.5.1";
  }

  return `${match[1]}.${match[2]}.1`;
}

function getChampionIconSrc(champion: string, version: string): string {
  return `https://ddragon.leagueoflegends.com/cdn/${toDdragonVersion(version)}/img/champion/${encodeURIComponent(champion)}.png`;
}

function getPlayerDisplayName(gameName?: string, tagline?: string): string {
  if (!gameName) {
    return "Unknown Player";
  }

  return tagline ? `${gameName}#${tagline}` : gameName;
}

function getRoleLabel(primary?: string, secondary?: string): string {
  const value = primary || secondary || "";
  if (!value) {
    return "Unknown";
  }

  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeRoleLabel(value?: string): string {
  return getRoleLabel(value).toLowerCase();
}

function getRoleRank(roleLabel?: string): number {
  const normalized = normalizeRoleLabel(roleLabel);
  if (normalized.includes("top")) return 0;
  if (normalized.includes("jungle")) return 1;
  if (normalized.includes("mid")) return 2;
  if (normalized.includes("bottom") || normalized.includes("bot") || normalized.includes("adc"))
    return 3;
  if (normalized.includes("support") || normalized.includes("utility")) return 4;
  return 5;
}

const teams = computed(() => {
  const players = summary.value?.players ?? [];
  return [100, 200].map((teamId) => {
    const members = players.filter((player) => Number(player.team) === teamId);
    const totalGold = members.reduce((sum, player) => sum + Number(player.goldEarned ?? 0), 0);
    const totalDamage = members.reduce(
      (sum, player) => sum + Number(player.totalDamageToChampions ?? 0),
      0,
    );
    const totalVision = members.reduce((sum, player) => sum + Number(player.visionScore ?? 0), 0);
    const winner = members.some((player) => player.win === "Win");

    return {
      id: teamId,
      winner,
      members,
      totalGold,
      totalDamage,
      totalVision,
    };
  });
});

const eventAnchoredTypes = new Set(["CHAMPION_KILL", "ELITE_MONSTER_KILL", "BUILDING_KILL"]);

function createMovementPlayer(
  participantId: number,
  bundle: RiotFixtureBundle,
): PlayerMovementData {
  const participant = bundle.match.info.participants.find(
    (entry) => entry.participantId === participantId,
  );
  return {
    champion: participant?.championName ?? `P${participantId}`,
    team: participant?.teamId ?? 100,
    playerName: getPlayerDisplayName(participant?.riotIdGameName, participant?.riotIdTagline),
    championIconSrc: getChampionIconSrc(
      participant?.championName ?? `P${participantId}`,
      bundle.match.info.gameVersion,
    ),
    roleLabel: getRoleLabel(participant?.lane, participant?.role),
    positions: [],
  };
}

function appendMovementPoint(
  movement: Map<number, PlayerMovementData>,
  participantId: number | undefined,
  x: number,
  y: number,
  timestamp: number,
  source: "frame" | "event",
): void {
  if (!participantId || participantId <= 0) {
    return;
  }

  const player = movement.get(participantId);
  if (!player) {
    return;
  }

  player.positions.push({ x, y, timestamp, source });
}

function normalizeMovementPositions(
  positions: PlayerMovementData["positions"],
): PlayerMovementData["positions"] {
  const sourceRank = { frame: 0, event: 1 } as const;
  const sorted = [...positions].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      sourceRank[left.source ?? "frame"] - sourceRank[right.source ?? "frame"],
  );
  const deduped: PlayerMovementData["positions"] = [];

  for (const position of sorted) {
    const previous = deduped[deduped.length - 1];
    if (!previous) {
      deduped.push(position);
      continue;
    }

    if (previous.timestamp !== position.timestamp) {
      if (previous.x !== position.x || previous.y !== position.y) {
        deduped.push(position);
      }
      continue;
    }

    if (previous.x === position.x && previous.y === position.y) {
      continue;
    }

    if ((previous.source ?? "frame") === "frame" && position.source === "event") {
      deduped[deduped.length - 1] = position;
    }
  }

  return deduped;
}

function buildApiMovementFromBundle(bundle: RiotFixtureBundle): PlayerMovementData[] {
  const movement = new Map<number, PlayerMovementData>(
    bundle.match.info.participants.map((participant) => [
      participant.participantId,
      createMovementPlayer(participant.participantId, bundle),
    ]),
  );

  for (const frame of bundle.timeline.info.frames) {
    const participantFrames = frame.participantFrames as Record<
      string,
      { position?: { x: number; y: number } }
    >;
    for (const [rawParticipantId, participantFrame] of Object.entries(participantFrames)) {
      if (!participantFrame.position) {
        continue;
      }

      appendMovementPoint(
        movement,
        Number(rawParticipantId),
        participantFrame.position.x,
        participantFrame.position.y,
        frame.timestamp,
        "frame",
      );
    }

    for (const event of frame.events) {
      if (!eventAnchoredTypes.has(event.type) || !event.position) {
        continue;
      }

      const anchoredParticipants = new Set<number>();
      if (event.participantId && event.participantId > 0) {
        anchoredParticipants.add(event.participantId);
      }
      if (event.killerId && event.killerId > 0) {
        anchoredParticipants.add(event.killerId);
      }
      if (event.victimId && event.victimId > 0) {
        anchoredParticipants.add(event.victimId);
      }
      for (const assistingParticipantId of event.assistingParticipantIds ?? []) {
        if (assistingParticipantId > 0) {
          anchoredParticipants.add(assistingParticipantId);
        }
      }

      for (const participantId of anchoredParticipants) {
        appendMovementPoint(
          movement,
          participantId,
          event.position.x,
          event.position.y,
          event.timestamp,
          "event",
        );
      }
    }
  }

  return Array.from(movement.values())
    .map((player) => ({
      ...player,
      positions: normalizeMovementPositions(player.positions),
    }))
    .filter((player) => player.positions.length > 0)
    .sort((left, right) => {
      if (left.team !== right.team) {
        return left.team - right.team;
      }
      return left.champion.localeCompare(right.champion);
    });
}

function findBundleParticipantForReplayAssignment(
  assignment: LoadedReplayMovementFixture["movement"]["assignments"][number],
  validation: LoadedReplayMovementFixture["validation"],
  bundle: RiotFixtureBundle | null,
): RiotMatchParticipant | null {
  if (!bundle) {
    return null;
  }

  const matchedParticipantId = validation?.assignments?.find(
    (entry) => entry.rosterIndex === assignment.rosterIndex,
  )?.matchedParticipantId;

  if (matchedParticipantId != null) {
    return (
      bundle.match.info.participants.find(
        (participant) => participant.participantId === matchedParticipantId,
      ) ?? null
    );
  }

  let best: { participant: RiotMatchParticipant; score: number } | null = null;
  for (const participant of bundle.match.info.participants) {
    let score = 0;
    if (participant.championName === assignment.champion) {
      score += 5;
    }
    if (participant.teamId === assignment.team) {
      score += 3;
    }
    if (normalizeRoleLabel(participant.lane) === normalizeRoleLabel(assignment.teamPosition)) {
      score += 2;
    }
    if (normalizeRoleLabel(participant.role) === normalizeRoleLabel(assignment.teamPosition)) {
      score += 1;
    }
    if (!best || score > best.score) {
      best = { participant, score };
    }
  }

  return best && best.score >= 5 ? best.participant : null;
}

function buildReplayMovementFromFixture(
  fixture: LoadedReplayMovementFixture,
  bundle: RiotFixtureBundle | null,
  parsedSummary: ReplaySummary | null,
): PlayerMovementData[] {
  const summaryPlayers = parsedSummary?.players ?? [];
  const gameVersion = parsedSummary?.gameVersion ?? bundle?.match.info.gameVersion ?? "16.6.1";

  return fixture.movement.assignments
    .filter((assignment) => assignment.trajectory.length > 0)
    .map((assignment) => {
      const bundleParticipant = findBundleParticipantForReplayAssignment(
        assignment,
        fixture.validation,
        bundle,
      );
      const summaryPlayer = summaryPlayers[assignment.rosterIndex] ?? null;
      const champion =
        assignment.champion ||
        bundleParticipant?.championName ||
        summaryPlayer?.champion ||
        `P${assignment.rosterIndex + 1}`;

      return {
        champion,
        team: assignment.team,
        playerName: getPlayerDisplayName(
          bundleParticipant?.riotIdGameName ?? summaryPlayer?.riotIdGameName,
          bundleParticipant?.riotIdTagline ?? summaryPlayer?.riotIdTagLine,
        ),
        championIconSrc: getChampionIconSrc(champion, gameVersion),
        roleLabel: getRoleLabel(
          assignment.teamPosition,
          bundleParticipant?.lane ?? summaryPlayer?.teamPosition,
        ),
        positions: normalizeMovementPositions(
          assignment.trajectory.map((position) => ({
            x: position.x,
            y: position.y,
            timestamp: position.timestamp,
          })),
        ),
      };
    })
    .sort((left, right) => {
      if (left.team !== right.team) {
        return left.team - right.team;
      }
      return left.champion.localeCompare(right.champion);
    });
}

function summarizeReplayMovementFixture(
  fixture: LoadedReplayMovementFixture | null,
  playerCount: number,
): string {
  if (!fixture) {
    return "(No replay-derived movement fixture published for this replay yet)";
  }

  const assigned =
    fixture.validation?.summary?.assignmentCount ?? fixture.movement.assignments.length;
  const passing = fixture.validation?.summary?.passingAssignmentCount ?? 0;
  if (playerCount <= 0) {
    return "(Replay-derived movement fixture loaded, but it had no assigned participant tracks)";
  }

  if (fixture.validation?.summary) {
    return `(Loaded replay-derived movement for ${playerCount} participants, ${passing}/${assigned} current validation passes)`;
  }

  return `(Loaded replay-derived movement for ${playerCount} participants)`;
}

const hasApiMovement = computed(() =>
  apiMovement.value.some((player) => player.positions.length > 0),
);
const hasReplayMovement = computed(() =>
  replayMovement.value.some((player) => player.positions.length > 0),
);
const apiMovementCount = computed(
  () => apiMovement.value.filter((player) => player.positions.length > 0).length,
);
const replayMovementCount = computed(
  () => replayMovement.value.filter((player) => player.positions.length > 0).length,
);
const hasDualMovement = computed(() => hasApiMovement.value && hasReplayMovement.value);
const movementRosterPlayers = computed(() =>
  (summary.value?.players ?? [])
    .map((player) => ({
      champion: player.champion,
      team: Number(player.team ?? 100),
      playerName: getPlayerDisplayName(player.riotIdGameName, player.riotIdTagLine),
      championIconSrc: getChampionIconSrc(
        player.champion ?? "Unknown",
        summary.value?.gameVersion ?? "16.5.1",
      ),
      roleLabel: getRoleLabel(player.teamPosition),
    }))
    .sort(
      (left, right) =>
        left.team - right.team ||
        getRoleRank(left.roleLabel) - getRoleRank(right.roleLabel) ||
        left.champion.localeCompare(right.champion),
    ),
);
const movementBlueRoster = computed(() =>
  movementRosterPlayers.value.filter((player) => player.team === 100),
);
const movementRedRoster = computed(() =>
  movementRosterPlayers.value.filter((player) => player.team === 200),
);
const apiMinimapEmptyMessage = computed(() =>
  hasReplayMovement.value
    ? "No Riot timeline movement fixture is available for this replay."
    : "No Riot or replay-derived movement fixture is available for this replay.",
);
const replayMinimapEmptyMessage = computed(() =>
  hasApiMovement.value
    ? "No replay-derived participant movement fixture is available for this replay."
    : "No Riot or replay-derived movement fixture is available for this replay.",
);

async function loadMovementData(matchId: string | null, requestId: number): Promise<string> {
  if (requestId !== replayLoadRequest) {
    return "(Replay load superseded)";
  }

  apiMovement.value = [];
  replayMovement.value = [];
  replayMovementStatus.value = "No replay-derived movement fixture loaded yet.";
  const currentRiotBundle = riotBundle.value;
  const currentSummary = summary.value;

  let apiStatus = "(No API movement fixture available)";
  if (currentRiotBundle) {
    apiMovement.value = buildApiMovementFromBundle(currentRiotBundle);
    const apiValid = apiMovement.value.filter((player) => player.positions.length > 0).length;
    apiStatus =
      apiValid > 0
        ? `(Loaded Riot timeline movement plus event anchors for ${apiValid} players)`
        : "(Riot timeline fixture did not contain participant positions)";
  } else {
    apiStatus = "(No replay-specific Riot research fixture available; fixed fallback disabled)";
  }

  let replayStatus = "(No replay-derived movement fixture available)";
  if (matchId) {
    try {
      const replayFixture = await loadReplayMovementFixture(matchId);
      if (requestId !== replayLoadRequest) {
        return "(Replay load superseded)";
      }
      replayMovement.value = replayFixture
        ? buildReplayMovementFromFixture(replayFixture, currentRiotBundle, currentSummary)
        : [];
      replayMovementStatus.value = summarizeReplayMovementFixture(
        replayFixture,
        replayMovementCount.value,
      );
      replayStatus = replayMovementStatus.value;
    } catch (error) {
      if (requestId !== replayLoadRequest) {
        return "(Replay load superseded)";
      }
      replayMovement.value = [];
      replayMovementStatus.value = `(Replay-derived movement unavailable: ${error instanceof Error ? error.message : String(error)})`;
      replayStatus = replayMovementStatus.value;
    }
  } else {
    replayMovementStatus.value =
      "(Replay filename did not map to a published replay movement fixture)";
    replayStatus = replayMovementStatus.value;
  }

  return `${apiStatus} ${replayStatus}`;
}

const maxGold = computed(() =>
  Math.max(1, ...(summary.value?.players ?? []).map((player) => Number(player.goldEarned ?? 0))),
);
const maxDamage = computed(() =>
  Math.max(
    1,
    ...(summary.value?.players ?? []).map((player) => Number(player.totalDamageToChampions ?? 0)),
  ),
);
const maxVision = computed(() =>
  Math.max(1, ...(summary.value?.players ?? []).map((player) => Number(player.visionScore ?? 0))),
);

const durationLabel = computed(() => formatDuration(summary.value?.gameLengthMillis ?? 0));

const overviewMetrics = computed(() => {
  if (!summary.value) {
    return [];
  }

  return [
    { label: "Patch", value: summary.value.gameVersion, icon: "bi-patch-check" },
    { label: "Duration", value: durationLabel.value, icon: "bi-clock" },
    { label: "File Size", value: formatFileSize(summary.value.fileSize), icon: "bi-hdd" },
    { label: "Container", value: summary.value.container.format, icon: "bi-box" },
  ];
});

const capabilityItems = computed(() => {
  const capabilities = summary.value?.capabilities;
  if (!capabilities) {
    return [];
  }

  return [
    {
      label: "Metadata",
      available: capabilities.metadataAvailable,
      detail: "Embedded match metadata JSON",
    },
    {
      label: "Player Stats",
      available: capabilities.playerStatsAvailable,
      detail: "Per-player statsJson summary fields",
    },
    {
      label: "Binary Header",
      available: capabilities.binaryHeaderAvailable,
      detail: "Classic 288-byte ROFL header",
    },
    {
      label: "Payload Decode",
      available: capabilities.payloadDecodingAvailable,
      detail: "Decryption + decompression",
    },
  ];
});

const containerRows = computed(() => {
  const container = summary.value?.container;
  if (!container) {
    return [];
  }

  return [
    { label: "Metadata Offset", value: formatNumber(container.metadataOffset) },
    { label: "Metadata Size", value: formatNumber(container.metadataSize) },
    { label: "Payload Offset", value: formatOptionalNumber(container.payloadOffset) },
    { label: "Match ID", value: formatOptionalNumber(container.matchId) },
    { label: "Chunk Count", value: formatOptionalNumber(container.chunkCount) },
    { label: "Keyframe Count", value: formatOptionalNumber(container.keyframeCount) },
  ];
});

const segmentPreview = computed(() => summary.value?.container.segments.slice(0, 10) ?? []);

function formatRiotId(player: PlayerSummary): string {
  return player.riotIdTagLine
    ? `${player.riotIdGameName}#${player.riotIdTagLine}`
    : player.riotIdGameName;
}

function percentage(value: number, max: number): string {
  return `${Math.max(6, Math.round((value / max) * 100))}%`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatOptionalNumber(value: number): string {
  return value > 0 ? formatNumber(value) : "N/A";
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(1)} KiB`;
  }

  const mib = kib / 1024;
  return `${mib.toFixed(2)} MiB`;
}

async function loadReplay(file: File): Promise<void> {
  const requestId = ++replayLoadRequest;
  const isCurrentRequest = () => requestId === replayLoadRequest;

  isLoading.value = true;
  errorMessage.value = "";
  summary.value = null;
  browserModel.value = null;
  riotBundle.value = null;
  apiMovement.value = [];
  replayMovement.value = [];
  riotFixtureStatus.value = "No Riot fixture loaded yet.";
  replayMovementStatus.value = "No replay-derived movement fixture loaded yet.";
  replayBuffer.value = null;
  setDuration(0);
  seek(0);
  replayKills.value = null;
  replayKillsError.value = "";
  isLoadingReplayKills.value = true;
  replayObjectives.value = null;
  replayObjectivesError.value = "";
  isLoadingReplayObjectives.value = true;
  replayWards.value = null;
  replayWardsError.value = "";
  isLoadingReplayWards.value = true;
  replayPurchaseLinkedItemUpdates.value = null;
  replayPurchaseLinkedItemUpdatesError.value = "";
  isLoadingReplayPurchaseLinkedItemUpdates.value = true;
  replayDirectItemPurchases.value = null;
  replayDirectItemPurchasesError.value = "";
  isLoadingReplayDirectItemPurchases.value = true;
  replayItemSales.value = null;
  replayItemSalesError.value = "";
  isLoadingReplayItemSales.value = true;
  loadedReplayName.value = file.name;
  status.value = `Parsing ${file.name}...`;

  try {
    const buffer = await file.arrayBuffer();
    if (!isCurrentRequest()) return;
    replayBuffer.value = buffer;
    const bytes = new Uint8Array(buffer);
    const parsedSummary = await parseReplayBufferWithWasm(buffer);
    if (!isCurrentRequest()) return;
    const derivedMatchId = deriveRiotMatchIdFromReplayName(file.name);

    summary.value = parsedSummary;
    browserModel.value = buildReplayBrowserModel(bytes, parsedSummary);
    riotBundle.value = null;
    setDuration(parsedSummary.gameLengthMillis);
    seek(0);

    let killStatus = "Kill timeline unavailable.";
    status.value = `Parsed metadata for ${file.name}. Decoding replay kill events...`;
    try {
      const decodedKills = await extractReplayKillsWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayKills.value = decodedKills;
      killStatus = `Decoded ${replayKills.value.events.length} replay-only kill events.`;
    } catch (killError) {
      if (!isCurrentRequest()) return;
      replayKills.value = null;
      replayKillsError.value = killError instanceof Error ? killError.message : String(killError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayKills.value = false;
    }

    let objectiveStatus = "Objective timeline unavailable.";
    status.value = `Decoded replay kills for ${file.name}. Decoding objective events...`;
    try {
      const decodedObjectives = await extractReplayObjectivesWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayObjectives.value = decodedObjectives;
      objectiveStatus = `Decoded ${replayObjectives.value.events.length} replay-only objective events.`;
    } catch (objectiveError) {
      if (!isCurrentRequest()) return;
      replayObjectives.value = null;
      replayObjectivesError.value =
        objectiveError instanceof Error ? objectiveError.message : String(objectiveError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayObjectives.value = false;
    }

    let wardStatus = "Ward timeline unavailable.";
    status.value = `Decoded replay objectives for ${file.name}. Decoding ward events...`;
    try {
      const decodedWards = await extractReplayWardsWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayWards.value = decodedWards;
      const wardPlacements = replayWards.value.events.filter(
        (event) => event.type === "WARD_PLACED",
      ).length;
      const wardKills = replayWards.value.events.filter(
        (event) => event.type === "WARD_KILL",
      ).length;
      wardStatus = `Decoded ${wardPlacements} exact standard-ward placements and ${wardKills} conservative replay-only ward kills.`;
    } catch (wardError) {
      if (!isCurrentRequest()) return;
      replayWards.value = null;
      replayWardsError.value = wardError instanceof Error ? wardError.message : String(wardError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayWards.value = false;
    }

    let purchaseUpdateStatus = "Kaufverknüpftes Ergebnis-Item-Update-Subset nicht verfügbar.";
    status.value = `Decoded replay wards for ${file.name}. Decoding purchase-linked resulting-item updates...`;
    try {
      const decodedPurchaseLinkedItemUpdates =
        await extractReplayPurchaseLinkedItemUpdatesWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayPurchaseLinkedItemUpdates.value = decodedPurchaseLinkedItemUpdates;
      purchaseUpdateStatus = `Decoded ${replayPurchaseLinkedItemUpdates.value.events.length} purchase-linked resulting-item updates (strict subset; no purchase or inventory timeline).`;
    } catch (purchaseUpdateError) {
      if (!isCurrentRequest()) return;
      replayPurchaseLinkedItemUpdates.value = null;
      replayPurchaseLinkedItemUpdatesError.value =
        purchaseUpdateError instanceof Error ? purchaseUpdateError.message : String(purchaseUpdateError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayPurchaseLinkedItemUpdates.value = false;
    }

    let directPurchaseStatus = "Direkte Add-only-Käufe nicht verfügbar.";
    status.value = `Decoded purchase-linked item updates for ${file.name}. Decoding direct Add-only item purchases...`;
    try {
      const decodedDirectItemPurchases = await extractReplayDirectItemPurchasesWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayDirectItemPurchases.value = decodedDirectItemPurchases;
      const componentCount = decodedDirectItemPurchases.events.filter(
        (event) => event.componentItem,
      ).length;
      directPurchaseStatus = `Decoded ${decodedDirectItemPurchases.events.length} direct Add-only item purchases (${componentCount} components; strict subset, no inventory timeline).`;
    } catch (directPurchaseError) {
      if (!isCurrentRequest()) return;
      replayDirectItemPurchases.value = null;
      replayDirectItemPurchasesError.value =
        directPurchaseError instanceof Error ? directPurchaseError.message : String(directPurchaseError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayDirectItemPurchases.value = false;
    }

    let saleStatus = "Verkaufsoperationen nicht verfügbar.";
    status.value = `Decoded direct item purchases for ${file.name}. Decoding item sale operations...`;
    try {
      const decodedItemSales = await extractReplayItemSalesWithWasm(buffer);
      if (!isCurrentRequest()) return;
      replayItemSales.value = decodedItemSales;
      saleStatus = `Decoded ${decodedItemSales.events.length} replay-only item sale operations (no sold-item, slot, gold, or inventory state).`;
    } catch (saleError) {
      if (!isCurrentRequest()) return;
      replayItemSales.value = null;
      replayItemSalesError.value = saleError instanceof Error ? saleError.message : String(saleError);
    } finally {
      if (isCurrentRequest()) isLoadingReplayItemSales.value = false;
    }

    if (derivedMatchId) {
      try {
        const loadedRiotBundle = await loadRiotFixtureBundle(derivedMatchId);
        if (!isCurrentRequest()) return;
        riotBundle.value = loadedRiotBundle;
        riotFixtureStatus.value = riotBundle.value
          ? `Loaded Riot fixture bundle for ${derivedMatchId}.`
          : `No published Riot fixture bundle found for ${derivedMatchId}.`;
      } catch (fixtureError) {
        if (!isCurrentRequest()) return;
        riotFixtureStatus.value =
          fixtureError instanceof Error ? fixtureError.message : String(fixtureError);
      }
    }

    const movementStatus = await loadMovementData(derivedMatchId, requestId);
    if (!isCurrentRequest()) return;
    status.value = `Parsed ${file.name} successfully. ${killStatus} ${objectiveStatus} ${wardStatus} ${purchaseUpdateStatus} ${directPurchaseStatus} ${saleStatus} ${movementStatus}`;
  } catch (error) {
    if (!isCurrentRequest()) return;
    summary.value = null;
    browserModel.value = null;
    riotBundle.value = null;
    replayKills.value = null;
    replayKillsError.value = "";
    replayObjectives.value = null;
    replayObjectivesError.value = "";
    replayWards.value = null;
    replayWardsError.value = "";
    replayPurchaseLinkedItemUpdates.value = null;
    replayPurchaseLinkedItemUpdatesError.value = "";
    replayDirectItemPurchases.value = null;
    replayDirectItemPurchasesError.value = "";
    replayItemSales.value = null;
    replayItemSalesError.value = "";
    replayBuffer.value = null;
    errorMessage.value = error instanceof Error ? error.message : String(error);
    status.value = "Replay parsing failed.";
  } finally {
    if (isCurrentRequest()) {
      isLoading.value = false;
      isLoadingReplayKills.value = false;
      isLoadingReplayObjectives.value = false;
      isLoadingReplayWards.value = false;
      isLoadingReplayPurchaseLinkedItemUpdates.value = false;
      isLoadingReplayDirectItemPurchases.value = false;
      isLoadingReplayItemSales.value = false;
    }
  }
}

function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    void loadReplay(file);
  }
}
</script>

<template>
  <div id="app" class="d-flex vh-100 overflow-hidden" data-bs-theme="dark">
    <!-- Sidebar -->
    <aside class="sidebar island m-2">
      <Sidebar v-model:activePage="activePage" :is-loaded="!!summary" />
    </aside>

    <!-- Content Area -->
    <main class="main-content flex-grow-1 overflow-auto p-2 d-flex flex-column">
      <!-- Top Action Bar -->
      <header
        class="island p-3 mb-2 d-flex justify-content-between align-items-center flex-shrink-0"
      >
        <div>
          <h1 class="fs-4 mb-0" v-if="loadedReplayName">{{ loadedReplayName }}</h1>
          <h1 class="fs-4 mb-0" v-else>League Replay Analyzer</h1>
          <p class="text-muted small mb-0" :class="{ 'text-danger': errorMessage }">
            {{ errorMessage || headerStatus }}
          </p>
        </div>
        <div class="d-flex gap-2 align-items-center">
          <label class="btn btn-primary btn-sm px-3">
            <i class="bi bi-file-earmark-arrow-up me-1"></i>
            Load Replay
            <input type="file" accept=".rofl" @change="onFileChange" class="d-none" />
          </label>
        </div>
      </header>

      <!-- Main Section -->
      <div v-if="summary" class="flex-grow-1 d-flex flex-column gap-2">
        <ProductReplayView
          v-if="activePage === 'product'"
          :summary="summary"
          :replay-name="loadedReplayName"
          :kills="replayKills"
          :objectives="replayObjectives"
          :wards="replayWards"
          :purchase-linked-item-updates="replayPurchaseLinkedItemUpdates"
          :direct-item-purchases="replayDirectItemPurchases"
          :item-sales="replayItemSales"
          :kills-loading="isLoadingReplayKills"
          :objectives-loading="isLoadingReplayObjectives"
          :wards-loading="isLoadingReplayWards"
          :purchase-linked-item-updates-loading="isLoadingReplayPurchaseLinkedItemUpdates"
          :direct-item-purchases-loading="isLoadingReplayDirectItemPurchases"
          :item-sales-loading="isLoadingReplayItemSales"
          :kills-error="replayKillsError"
          :objectives-error="replayObjectivesError"
          :wards-error="replayWardsError"
          :purchase-linked-item-updates-error="replayPurchaseLinkedItemUpdatesError"
          :direct-item-purchases-error="replayDirectItemPurchasesError"
          :item-sales-error="replayItemSalesError"
        />

        <!-- Summary View -->
        <div v-else-if="activePage === 'summary'" class="d-flex flex-column gap-2">
          <!-- Metrics Row -->
          <div class="row g-2 flex-shrink-0">
            <div v-for="metric in overviewMetrics" :key="metric.label" class="col-6 col-md-3">
              <div class="island p-3 text-center">
                <i :class="metric.icon" class="fs-3 text-primary mb-2 d-block"></i>
                <div class="text-muted x-small text-uppercase fw-bold">{{ metric.label }}</div>
                <div class="fs-5 fw-bold">{{ metric.value }}</div>
              </div>
            </div>
          </div>

          <div class="island p-3 d-flex flex-column gap-3">
            <div class="d-flex justify-content-between align-items-start">
              <div>
                <h2 class="fs-5 mb-1">Match Timeline</h2>
                <p class="text-muted small" v-if="hasDualMovement">
                  Riot API and replay-derived positions are rendered side by side with the same
                  playback timeline.
                </p>
                <p class="text-muted small" v-else-if="hasReplayMovement">
                  Showing replay-derived participant positions from the decoder artifacts.
                </p>
                <p class="text-muted small" v-else-if="hasApiMovement">
                  Riot timeline frame positions plus combat and objective event anchors rendered on
                  the original Summoner&apos;s Rift minimap.
                </p>
                <p class="text-muted small" v-else>No decoded movement frames are available yet.</p>
              </div>
              <div class="d-flex flex-wrap gap-2 justify-content-end align-items-center">
                <span v-if="hasApiMovement" class="badge bg-success-subtle text-success-emphasis"
                  >API {{ apiMovementCount }}</span
                >
                <span v-else class="badge bg-secondary-subtle text-secondary-emphasis"
                  >API Missing</span
                >
                <span v-if="hasReplayMovement" class="badge bg-info-subtle text-info-emphasis"
                  >Replay {{ replayMovementCount }}</span
                >
                <span v-else class="badge bg-secondary-subtle text-secondary-emphasis"
                  >Replay Missing</span
                >
              </div>
            </div>
            <div
              class="d-flex flex-column flex-lg-row justify-content-between align-items-start align-items-lg-center gap-2"
            >
              <div class="d-flex flex-column gap-1">
                <span class="text-muted x-small">{{ riotFixtureStatus }}</span>
                <span class="text-muted x-small">{{ replayMovementStatus }}</span>
              </div>
              <span v-if="hasDualMovement" class="badge bg-primary-subtle text-primary-emphasis"
                >Synced Timeline</span
              >
            </div>

            <div v-if="hasDualMovement" class="movement-compare-shell">
              <div class="movement-roster-column movement-roster-column-left">
                <div
                  v-for="player in movementBlueRoster"
                  :key="`${player.team}-${player.champion}-left`"
                  class="movement-roster-item"
                >
                  <img
                    v-if="player.championIconSrc"
                    :src="player.championIconSrc"
                    :alt="player.champion"
                    class="movement-roster-icon blue-team"
                  />
                  <div v-else class="movement-roster-icon movement-roster-fallback blue-team"></div>
                  <div class="movement-roster-copy">
                    <div class="movement-roster-role">{{ player.roleLabel }}</div>
                    <div class="movement-roster-champion">{{ player.champion }}</div>
                    <div class="movement-roster-player">{{ player.playerName }}</div>
                  </div>
                </div>
              </div>

              <div class="movement-map-panel">
                <div class="movement-map-panel-header">
                  <div>
                    <h3 class="fs-6 mb-1">Riot API</h3>
                    <p class="text-muted x-small mb-0">Timeline frames plus event anchors.</p>
                  </div>
                  <span class="badge bg-success-subtle text-success-emphasis"
                    >{{ apiMovementCount }} players</span
                  >
                </div>
                <div
                  class="movement-map-frame d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-2 p-xl-3 border border-secondary border-opacity-10"
                >
                  <Minimap
                    class="movement-map"
                    :player-data="apiMovement"
                    :empty-message="apiMinimapEmptyMessage"
                    :show-side-columns="false"
                  />
                </div>
              </div>

              <div class="movement-map-panel">
                <div class="movement-map-panel-header">
                  <div>
                    <h3 class="fs-6 mb-1">Replay Decoder</h3>
                    <p class="text-muted x-small mb-0">
                      Participant-labelled `timestamp, x, y` from artifacts.
                    </p>
                  </div>
                  <span class="badge bg-info-subtle text-info-emphasis"
                    >{{ replayMovementCount }} players</span
                  >
                </div>
                <div
                  class="movement-map-frame d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-2 p-xl-3 border border-secondary border-opacity-10"
                >
                  <Minimap
                    class="movement-map"
                    :player-data="replayMovement"
                    :empty-message="replayMinimapEmptyMessage"
                    :show-side-columns="false"
                  />
                </div>
              </div>

              <div class="movement-roster-column movement-roster-column-right">
                <div
                  v-for="player in movementRedRoster"
                  :key="`${player.team}-${player.champion}-right`"
                  class="movement-roster-item movement-roster-item-right"
                >
                  <div class="movement-roster-copy movement-roster-copy-right">
                    <div class="movement-roster-role">{{ player.roleLabel }}</div>
                    <div class="movement-roster-champion">{{ player.champion }}</div>
                    <div class="movement-roster-player">{{ player.playerName }}</div>
                  </div>
                  <img
                    v-if="player.championIconSrc"
                    :src="player.championIconSrc"
                    :alt="player.champion"
                    class="movement-roster-icon red-team"
                  />
                  <div v-else class="movement-roster-icon movement-roster-fallback red-team"></div>
                </div>
              </div>
            </div>

            <div v-else class="movement-map-grid">
              <div class="movement-map-panel">
                <div class="movement-map-panel-header">
                  <div>
                    <h3 class="fs-6 mb-1">
                      {{ hasReplayMovement ? "Replay Decoder" : "Riot API" }}
                    </h3>
                    <p class="text-muted x-small mb-0">
                      {{
                        hasReplayMovement
                          ? "Participant-labelled `timestamp, x, y` from artifacts."
                          : "Timeline frames plus event anchors."
                      }}
                    </p>
                  </div>
                  <span
                    class="badge"
                    :class="
                      hasReplayMovement
                        ? 'bg-info-subtle text-info-emphasis'
                        : 'bg-success-subtle text-success-emphasis'
                    "
                  >
                    {{ hasReplayMovement ? replayMovementCount : apiMovementCount }} players
                  </span>
                </div>
                <div
                  class="movement-map-frame d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-2 p-xl-3 border border-secondary border-opacity-10"
                >
                  <Minimap
                    class="movement-map"
                    :player-data="hasReplayMovement ? replayMovement : apiMovement"
                    :empty-message="
                      hasReplayMovement ? replayMinimapEmptyMessage : apiMinimapEmptyMessage
                    "
                  />
                </div>
              </div>
            </div>

            <Timeline class="main-timeline" />
          </div>

          <KillTimeline
            :result="replayKills"
            :is-loading="isLoadingReplayKills"
            :error-message="replayKillsError"
          />

          <ObjectiveTimeline
            :result="replayObjectives"
            :is-loading="isLoadingReplayObjectives"
            :error-message="replayObjectivesError"
          />

          <div class="row g-2">
            <div class="col-lg-8 d-flex flex-column gap-2">
              <div class="island p-3">
                <h2 class="fs-5 mb-3">Segment Preview (First 10)</h2>
                <div class="table-responsive">
                  <table class="table table-sm table-hover align-middle mb-0">
                    <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                      <tr>
                        <th>ID</th>
                        <th>Type</th>
                        <th>Codec</th>
                        <th>Size</th>
                        <th>Uncompressed</th>
                        <th>Offset</th>
                      </tr>
                    </thead>
                    <tbody class="small">
                      <tr v-for="segment in segmentPreview" :key="segment.id">
                        <td>{{ segment.id }}</td>
                        <td>
                          <span class="badge bg-secondary-subtle text-secondary-emphasis">{{
                            segment.type
                          }}</span>
                        </td>
                        <td>
                          <code>{{ segment.codec || "none" }}</code>
                        </td>
                        <td>{{ formatNumber(segment.length) }}</td>
                        <td>{{ formatOptionalNumber(segment.uncompressedLength) }}</td>
                        <td>
                          <span class="text-muted">{{ formatNumber(segment.payloadOffset) }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div class="col-lg-4 d-flex flex-column gap-2">
              <div class="island p-3">
                <h2 class="fs-5 mb-3">Parser Capabilities</h2>
                <div class="row g-2">
                  <div v-for="item in capabilityItems" :key="item.label" class="col-12">
                    <div
                      class="p-2 rounded-2 border border-opacity-10 d-flex align-items-center gap-2"
                      :class="
                        item.available
                          ? 'border-success bg-success-subtle bg-opacity-10'
                          : 'border-danger bg-danger-subtle bg-opacity-10'
                      "
                    >
                      <i
                        class="bi"
                        :class="
                          item.available
                            ? 'bi-check-circle-fill text-success'
                            : 'bi-x-circle-fill text-danger'
                        "
                      ></i>
                      <div>
                        <div class="fw-bold small">{{ item.label }}</div>
                        <div class="x-small text-muted">{{ item.detail }}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="island p-3">
                <h2 class="fs-5 mb-3">Container Layout</h2>
                <dl class="row g-2 mb-0 small">
                  <template v-for="row in containerRows" :key="row.label">
                    <dt class="col-7 text-muted fw-normal">{{ row.label }}</dt>
                    <dd class="col-5 text-end fw-bold mb-0">{{ row.value }}</dd>
                  </template>
                </dl>
              </div>

              <div class="island p-3">
                <h2 class="fs-5 mb-2">Metadata JSON</h2>
                <details class="small">
                  <summary class="text-muted cursor-pointer py-1">Expand raw metadata</summary>
                  <pre
                    class="bg-dark p-2 rounded text-info mt-2 mb-0 overflow-auto"
                    style="max-height: 300px; font-size: 0.75rem"
                  ><code>{{ summary.metadataJson }}</code></pre>
                </details>
              </div>
            </div>
          </div>

          <!-- Teams Section -->
          <div class="row g-2 flex-shrink-0 mb-3">
            <div v-for="team in teams" :key="team.id" class="col-12 col-xl-6">
              <div
                class="island p-3 border-top border-4"
                :class="team.winner ? 'border-success' : 'border-secondary'"
              >
                <div class="d-flex justify-content-between align-items-end mb-3">
                  <div>
                    <div class="x-small text-uppercase text-muted fw-bold">Team {{ team.id }}</div>
                    <h3 class="fs-4 mb-0">{{ team.winner ? "Victory" : "Defeat" }}</h3>
                  </div>
                  <div class="text-end x-small text-muted">
                    <span class="mx-1">{{ team.totalGold.toLocaleString() }} gold</span>
                    <span class="mx-1">{{ team.totalDamage.toLocaleString() }} dmg</span>
                  </div>
                </div>

                <div class="d-flex flex-column gap-2">
                  <div
                    v-for="player in team.members"
                    :key="player.riotIdGameName"
                    class="p-2 border rounded-2 bg-body-tertiary bg-opacity-25"
                  >
                    <div class="d-flex justify-content-between align-items-start mb-2">
                      <div>
                        <div class="x-small text-primary fw-bold text-uppercase">
                          {{ player.teamPosition }}
                        </div>
                        <div class="fw-bold">{{ player.champion }}</div>
                        <div class="x-small text-muted">{{ formatRiotId(player) }}</div>
                      </div>
                      <div class="text-end">
                        <div class="fw-bold text-primary">
                          {{ player.kills }}/{{ player.deaths }}/{{ player.assists }}
                        </div>
                      </div>
                    </div>

                    <div class="d-flex flex-column gap-1">
                      <div class="progress" style="height: 4px">
                        <div
                          class="progress-bar bg-warning"
                          :style="{ width: percentage(player.goldEarned, maxGold) }"
                        ></div>
                      </div>
                      <div class="progress" style="height: 4px">
                        <div
                          class="progress-bar bg-danger"
                          :style="{ width: percentage(player.totalDamageToChampions, maxDamage) }"
                        ></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Data Browser View -->
        <DataBrowser
          v-else-if="activePage === 'browser'"
          class="flex-grow-1"
          :browser="browserModel"
          :replay-name="loadedReplayName"
          :riot-bundle="riotBundle"
          :riot-fixture-status="riotFixtureStatus"
        />

        <ReplayInspector
          v-else
          class="flex-grow-1"
          :replay-buffer="replayBuffer"
          :summary="summary"
          :riot-bundle="riotBundle"
        />
      </div>

      <!-- Welcome State -->
      <div
        v-else-if="!isLoading"
        class="flex-grow-1 d-flex align-items-center justify-content-center"
      >
        <div class="island p-5 text-center" style="max-width: 500px">
          <i class="bi bi-file-earmark-bar-graph fs-1 text-primary mb-3 d-block"></i>
          <h2 class="fs-3">No Replay Loaded</h2>
          <p class="text-muted">
            Load a <code>.rofl</code> file to begin analyzing match metadata, player stats, and
            record structure.
          </p>
          <label class="btn btn-primary px-4 mt-3">
            <i class="bi bi-plus-lg me-1"></i>
            Select File
            <input type="file" accept=".rofl" @change="onFileChange" class="d-none" />
          </label>
        </div>
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="flex-grow-1 d-flex align-items-center justify-content-center">
        <div class="text-center">
          <div
            class="spinner-border text-primary mb-3"
            role="status"
            style="width: 3rem; height: 3rem"
          >
            <span class="visually-hidden">Loading...</span>
          </div>
          <p class="text-muted">Parsing replay bytes...</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style>
/* Dashboard Layout */
.sidebar {
  width: 240px;
  flex-shrink: 0;
}

.main-content {
  min-width: 0;
}

.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}

/* Custom transitions and scrollbar */
.island {
  transition: box-shadow 0.2s;
}

pre {
  white-space: pre-wrap;
  word-wrap: break-word;
}

.movement-map-frame {
  width: 100%;
}

.movement-map {
  width: 100%;
}

.movement-map-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
}

.movement-map-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.movement-map-panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.movement-compare-shell {
  display: grid;
  grid-template-columns: minmax(148px, 176px) minmax(0, 1fr) minmax(0, 1fr) minmax(148px, 176px);
  gap: 12px;
  align-items: stretch;
}

.movement-roster-column {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 10px;
}

.movement-roster-item {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 74px;
  padding: 10px 11px;
  background: rgba(8, 13, 20, 0.66);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
}

.movement-roster-item-right {
  justify-content: flex-end;
}

.movement-roster-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: block;
  object-fit: cover;
  border-radius: 999px;
  background: rgba(8, 11, 18, 0.92);
}

.movement-roster-fallback {
  background: rgba(255, 255, 255, 0.14);
}

.movement-roster-copy {
  min-width: 0;
}

.movement-roster-copy-right {
  text-align: right;
}

.movement-roster-role {
  color: rgba(255, 255, 255, 0.58);
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.movement-roster-champion {
  color: white;
  font-size: 0.88rem;
  font-weight: 700;
  line-height: 1.15;
}

.movement-roster-player {
  color: rgba(255, 255, 255, 0.72);
  font-size: 0.74rem;
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

code {
  color: var(--island-accent);
}

/* Scrollbar styling */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.2);
}

@media (max-width: 1400px) {
  .movement-compare-shell {
    grid-template-columns: 1fr;
  }
}
</style>
