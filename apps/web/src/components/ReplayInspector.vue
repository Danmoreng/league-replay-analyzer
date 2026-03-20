<script setup lang="ts">
import { computed, ref, watch } from "vue";

import type {
  ReplayAnalysisCandidate,
  ReplayEntitySlabAnalysisResult,
  ReplayFamilyAnalysisResult,
  ReplayFamilyScanItem,
  ReplayFamilyScanResult,
  ReplayScalarFamilyAnalysisResult,
} from "../replayInvestigation";
import type { ReplaySummary } from "../replayParser";
import type { RiotFixtureBundle } from "../riotApiFixtures";
import { correlateReplayAnalyses, type ReplayCorrelationReport } from "../replayCorrelation";
import { correlateReplayScalars, type ReplayScalarCorrelationReport } from "../replayScalarCorrelation";
import { assignReplayParticipants, type ReplayParticipantSlotAssignmentReport } from "../replayParticipantAssignment";
import { analyzeEntitySlabWithWasm, analyzeScalarFamilyWithWasm, analyzeSparseFamilyWithWasm, scanReplayFamiliesWithWasm } from "../wasmReplayParser";
import type { PlayerMovementData } from "../composables/usePlayback";
import Minimap from "./Minimap.vue";
import Timeline from "./Timeline.vue";
import SchemaJsonLoader from "./SchemaJsonLoader.vue";
import type { RawToken } from "../tokenBitfields";

const props = defineProps<{
  replayBuffer: ArrayBuffer | null;
  summary: ReplaySummary | null;
  riotBundle: RiotFixtureBundle | null;
}>();

const familyScan = ref<ReplayFamilyScanResult | null>(null);
const selectedFamilyKey = ref("");
const familyAnalysis = ref<ReplayFamilyAnalysisResult | null>(null);
const selectedCandidateKey = ref("");
const correlationReport = ref<ReplayCorrelationReport | null>(null);
const scalarCorrelationReport = ref<ReplayScalarCorrelationReport | null>(null);
const participantAssignmentReport = ref<ReplayParticipantSlotAssignmentReport | null>(null);
const scanStatus = ref("Run the decoder scan to rank recurring chunk families before drilling into candidate tracks.");
const analysisStatus = ref("Select a family to inspect its top slot/pair candidates.");
const correlationStatus = ref("Automatic correlation compares replay candidates against Riot timeline positions, event anchors, and participant-frame scalar stats.");
const scanError = ref("");
const isScanning = ref(false);
const isAnalyzing = ref(false);
const isCorrelating = ref(false);
const mockTokens = ref<RawToken[]>([
  { tokenHex: "0x4B710002", tokenU32: 0x4B710002, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 0 },
  { tokenHex: "0x00F1DD71", tokenU32: 0x00F1DD71, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 2 },
  { tokenHex: "0x000200F1", tokenU32: 0x000200F1, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 0, offset: 1 },
  { tokenHex: "0x0200F14B", tokenU32: 0x0200F14B, sourceFamilyLength: 61917, sourceFirstByte: 0x00, slot: 11, offset: 0 },
]);

const analysisCache = ref(new Map<string, ReplayFamilyAnalysisResult>());
const scalarAnalysisCache = ref(new Map<string, ReplayScalarFamilyAnalysisResult>());
const entitySlabCache = ref(new Map<string, ReplayEntitySlabAnalysisResult>());

function familyKey(family: ReplayFamilyScanItem): string {
  return `${family.length}:${family.firstByte}`;
}

function candidateKey(candidate: ReplayAnalysisCandidate): string {
  return `${candidate.slotIndex}:${candidate.pairLabel}`;
}

const families = computed(() => familyScan.value?.families ?? []);

const selectedFamily = computed(() => {
  return families.value.find((family) => familyKey(family) === selectedFamilyKey.value) ?? null;
});

const candidates = computed(() => familyAnalysis.value?.candidates ?? []);

const selectedCandidate = computed(() => {
  return candidates.value.find((candidate) => candidateKey(candidate) === selectedCandidateKey.value) ?? null;
});

const topClasses = computed(() => familyAnalysis.value?.classes.slice(0, 8) ?? []);
const topMatches = computed(() => correlationReport.value?.topPositionMatches ?? []);
const topScalarMatches = computed(() => scalarCorrelationReport.value?.topScalarMatches ?? []);
const participantAssignments = computed(() => participantAssignmentReport.value?.assignments ?? []);
const topParticipantCandidates = computed(() => participantAssignmentReport.value?.topCandidates ?? []);
const familyRankings = computed(() => correlationReport.value?.familyRankings ?? []);

const selectedCandidateMovement = computed<PlayerMovementData[]>(() => {
  const candidate = selectedCandidate.value;
  if (!candidate) {
    return [];
  }

  return [
    {
      champion: `Slot ${candidate.slotIndex}`,
      team: 100,
      playerName: `${candidate.pairLabel} | ${candidate.classKey}`,
      roleLabel: `score ${candidate.score.toFixed(1)}`,
      positions: candidate.samples.map((sample) => ({
        x: sample.x,
        y: sample.y,
        timestamp: sample.timestamp,
      })),
    },
  ];
});

watch(
  families,
  (items) => {
    if (items.length === 0) {
      selectedFamilyKey.value = "";
      familyAnalysis.value = null;
      return;
    }

    if (!items.some((family) => familyKey(family) === selectedFamilyKey.value)) {
      selectedFamilyKey.value = familyKey(items[0]);
    }
  },
  { immediate: true },
);

watch(
  candidates,
  (items) => {
    if (items.length === 0) {
      selectedCandidateKey.value = "";
      return;
    }

    if (!items.some((candidate) => candidateKey(candidate) === selectedCandidateKey.value)) {
      selectedCandidateKey.value = candidateKey(items[0]);
    }
  },
  { immediate: true },
);

watch(selectedFamilyKey, (key) => {
  if (!key) {
    familyAnalysis.value = null;
    return;
  }

  familyAnalysis.value = analysisCache.value.get(key) ?? null;
});

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

async function runFamilyScan(): Promise<void> {
  if (!props.replayBuffer) {
    scanError.value = "Load a replay before running the decoder scan.";
    return;
  }

  isScanning.value = true;
  scanError.value = "";
  scanStatus.value = "Scanning recurring chunk families in Wasm...";

  try {
    familyScan.value = await scanReplayFamiliesWithWasm(props.replayBuffer, 4096, 4, 18);
    analysisCache.value.clear();
    scalarAnalysisCache.value.clear();
    entitySlabCache.value.clear();
    familyAnalysis.value = null;
    selectedCandidateKey.value = "";
    correlationReport.value = null;
    scalarCorrelationReport.value = null;
    participantAssignmentReport.value = null;
    scanStatus.value = `Scanned ${familyScan.value.scannedChunkCount} chunks and ranked ${familyScan.value.families.length} recurring families.`;
  } catch (error) {
    familyScan.value = null;
    familyAnalysis.value = null;
    correlationReport.value = null;
    scalarCorrelationReport.value = null;
    participantAssignmentReport.value = null;
    scanError.value = error instanceof Error ? error.message : String(error);
    scanStatus.value = "Family scan failed.";
  } finally {
    isScanning.value = false;
  }
}

async function analyzeFamily(family: ReplayFamilyScanItem): Promise<ReplayFamilyAnalysisResult> {
  if (!props.replayBuffer) {
    throw new Error("Replay buffer unavailable.");
  }

  const cacheKey = familyKey(family);
  const cached = analysisCache.value.get(cacheKey);
  if (cached) {
    return cached;
  }

  const headerSize = family.recommendedHeaderSize >= 0
    ? family.recommendedHeaderSize
    : family.headerSizeCandidates[0]?.headerSize ?? 0;

  const result = await analyzeSparseFamilyWithWasm(props.replayBuffer, {
    length: family.length,
    firstByte: family.firstByte,
    headerSize,
    stride: family.recommendedStride,
    topSlots: 24,
    moveEpsilon: 25,
    smoothThreshold: 800,
  });
  analysisCache.value.set(cacheKey, result);
  return result;
}

async function analyzeEntitySlabFamily(family: ReplayFamilyScanItem): Promise<ReplayEntitySlabAnalysisResult> {
  if (!props.replayBuffer) {
    throw new Error("Replay buffer unavailable.");
  }

  const cacheKey = familyKey(family);
  const cached = entitySlabCache.value.get(cacheKey);
  if (cached) {
    return cached;
  }

  const headerSize = family.recommendedHeaderSize >= 0
    ? family.recommendedHeaderSize
    : family.headerSizeCandidates[0]?.headerSize ?? 0;

  const result = await analyzeEntitySlabWithWasm(props.replayBuffer, {
    length: family.length,
    firstByte: family.firstByte,
    headerSize,
    stride: family.recommendedStride,
    topSlots: 24,
  });
  entitySlabCache.value.set(cacheKey, result);
  return result;
}

async function analyzeScalarFamily(family: ReplayFamilyScanItem): Promise<ReplayScalarFamilyAnalysisResult> {
  if (!props.replayBuffer) {
    throw new Error("Replay buffer unavailable.");
  }

  const cacheKey = familyKey(family);
  const cached = scalarAnalysisCache.value.get(cacheKey);
  if (cached) {
    return cached;
  }

  const headerSize = family.recommendedHeaderSize >= 0
    ? family.recommendedHeaderSize
    : family.headerSizeCandidates[0]?.headerSize ?? 0;

  const result = await analyzeScalarFamilyWithWasm(props.replayBuffer, {
    length: family.length,
    firstByte: family.firstByte,
    headerSize,
    stride: family.recommendedStride,
    topSlots: 18,
  });
  scalarAnalysisCache.value.set(cacheKey, result);
  return result;
}

async function analyzeSelectedFamily(): Promise<void> {
  if (!selectedFamily.value) {
    return;
  }

  isAnalyzing.value = true;
  analysisStatus.value = `Analyzing family ${selectedFamily.value.length} / ${formatByte(selectedFamily.value.firstByte)}...`;

  try {
    const result = await analyzeFamily(selectedFamily.value);
    familyAnalysis.value = result;
    analysisStatus.value = result.error
      ? `Analysis completed with a decoder warning: ${result.error}`
      : `Analyzed ${result.recordCount} records and ranked ${result.candidates.length} slot/pair candidates.`;
  } catch (error) {
    familyAnalysis.value = null;
    analysisStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    isAnalyzing.value = false;
  }
}

async function runAutomaticCorrelation(): Promise<void> {
  if (!props.replayBuffer) {
    correlationStatus.value = "Load a replay before running automatic correlation.";
    return;
  }
  if (!props.riotBundle) {
    correlationStatus.value = "No Riot fixture bundle is available for this replay, so automatic correlation cannot run.";
    return;
  }

  if (!familyScan.value) {
    await runFamilyScan();
  }
  if (!familyScan.value) {
    return;
  }

  isCorrelating.value = true;
  correlationStatus.value = "Analyzing top families against Riot movement, event anchors, and scalar participant-frame stats...";

  try {
    const familiesToAnalyze = familyScan.value.families.slice(0, 8);
    const analyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayFamilyAnalysisResult }> = [];
    const scalarAnalyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayScalarFamilyAnalysisResult }> = [];
    const entityAnalyses: Array<{ family: ReplayFamilyScanItem; analysis: ReplayEntitySlabAnalysisResult }> = [];
    for (const family of familiesToAnalyze) {
      const analysis = await analyzeFamily(family);
      const scalarAnalysis = await analyzeScalarFamily(family);
      const entityAnalysis = await analyzeEntitySlabFamily(family);
      analyses.push({ family, analysis });
      scalarAnalyses.push({ family, analysis: scalarAnalysis });
      entityAnalyses.push({ family, analysis: entityAnalysis });
    }

    correlationReport.value = correlateReplayAnalyses(analyses, props.riotBundle);
    scalarCorrelationReport.value = correlateReplayScalars(scalarAnalyses, props.riotBundle);
    participantAssignmentReport.value = assignReplayParticipants(scalarCorrelationReport.value, entityAnalyses, props.riotBundle);
    correlationStatus.value = `${correlationReport.value.summary} ${scalarCorrelationReport.value.summary} ${participantAssignmentReport.value.summary}`;

    const bestFamily = correlationReport.value.familyRankings[0];
    if (bestFamily) {
      selectedFamilyKey.value = bestFamily.familyKey;
      familyAnalysis.value = analysisCache.value.get(bestFamily.familyKey) ?? null;
      selectedCandidateKey.value = bestFamily.bestCandidateKey;
    } else {
      const bestAssignment = participantAssignmentReport.value.assignments[0];
      if (bestAssignment) {
        selectedFamilyKey.value = bestAssignment.familyKey;
        familyAnalysis.value = analysisCache.value.get(bestAssignment.familyKey) ?? null;
      } else {
        const bestScalarMatch = scalarCorrelationReport.value.topScalarMatches[0];
        if (bestScalarMatch) {
          selectedFamilyKey.value = bestScalarMatch.familyKey;
          familyAnalysis.value = analysisCache.value.get(bestScalarMatch.familyKey) ?? null;
        }
      }
    }
  } catch (error) {
    correlationReport.value = null;
    scalarCorrelationReport.value = null;
    participantAssignmentReport.value = null;
    correlationStatus.value = error instanceof Error ? error.message : String(error);
  } finally {
    isCorrelating.value = false;
  }
}

function selectRanking(familyKeyValue: string, candidateKeyValue: string): void {
  selectedFamilyKey.value = familyKeyValue;
  familyAnalysis.value = analysisCache.value.get(familyKeyValue) ?? null;
  selectedCandidateKey.value = candidateKeyValue;
}
</script>

<template>
  <div class="d-flex flex-column gap-2">
    <div class="island p-3 d-flex flex-column gap-3">
      <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
        <div>
          <h2 class="fs-5 mb-1">Decoder Inspector</h2>
          <p class="text-muted small mb-0">
            This page is now data-driven first: it scans recurring replay families, analyzes movement candidates, and scores both movement and scalar replay lanes automatically against Riot timeline fixtures.
          </p>
        </div>
        <div class="d-flex gap-2 flex-wrap">
          <button class="btn btn-primary btn-sm" :disabled="!replayBuffer || isScanning" @click="void runFamilyScan()">
            <span v-if="isScanning" class="spinner-border spinner-border-sm me-2"></span>
            Scan Families
          </button>
          <button
            class="btn btn-outline-light btn-sm"
            :disabled="!selectedFamily || isAnalyzing"
            @click="void analyzeSelectedFamily()"
          >
            <span v-if="isAnalyzing" class="spinner-border spinner-border-sm me-2"></span>
            Analyze Selected Family
          </button>
          <button
            class="btn btn-success btn-sm"
            :disabled="!replayBuffer || !riotBundle || isCorrelating"
            @click="void runAutomaticCorrelation()"
          >
            <span v-if="isCorrelating" class="spinner-border spinner-border-sm me-2"></span>
            Auto Correlate
          </button>
        </div>
      </div>

      <div class="small" :class="scanError ? 'text-danger' : 'text-muted'">
        {{ scanError || scanStatus }}
      </div>
      <div class="small text-muted">{{ analysisStatus }}</div>
      <div class="small" :class="riotBundle ? 'text-info' : 'text-warning'">{{ correlationStatus }}</div>
    </div>

    <div v-if="familyRankings.length" class="row g-2">
      <div class="col-lg-6 d-flex flex-column gap-2">
        <div class="island p-3">
          <h2 class="fs-5 mb-3">Automatic Family Ranking</h2>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>Family</th>
                  <th>Champion</th>
                  <th>Affine RMSE</th>
                  <th>Near-10 Classes</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="ranking in familyRankings"
                  :key="ranking.familyKey"
                  style="cursor: pointer"
                  @click="selectRanking(ranking.familyKey, ranking.bestCandidateKey)"
                >
                  <td><code>{{ ranking.familyLabel }}</code></td>
                  <td>{{ ranking.bestChampion }}</td>
                  <td>{{ ranking.bestAffineRmse.toFixed(0) }}</td>
                  <td>{{ ranking.classNearTenCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="col-lg-6 d-flex flex-column gap-2">
        <div class="island p-3">
          <h2 class="fs-5 mb-3">Top Automatic Matches</h2>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>Slot</th>
                  <th>Pair</th>
                  <th>Champion</th>
                  <th>Affine</th>
                  <th>Events</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="match in topMatches.slice(0, 12)"
                  :key="`${match.familyKey}:${match.candidateKey}:${match.participantId}`"
                  style="cursor: pointer"
                  @click="selectRanking(match.familyKey, match.candidateKey)"
                >
                  <td>{{ match.slotIndex }}</td>
                  <td><code>{{ match.pairLabel }}</code></td>
                  <td>{{ match.champion }}</td>
                  <td>{{ match.affineRmse.toFixed(0) }}</td>
                  <td>{{ match.eventMatches > 0 ? match.eventRmse.toFixed(0) : 'n/a' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>


    <div v-if="topScalarMatches.length" class="row g-2">
      <div class="col-12 d-flex flex-column gap-2">
        <div class="island p-3">
          <h2 class="fs-5 mb-2">Top Automatic Scalar Matches</h2>
          <p class="text-muted small mb-3">
            These are raw replay lanes ranked against Riot participant-frame stats like gold, xp, cs, level, health, and resource values. This is the main path for identifying semantics when movement stays ambiguous.
          </p>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>Family</th>
                  <th>Slot</th>
                  <th>Lane</th>
                  <th>Decode</th>
                  <th>Champion</th>
                  <th>Metric</th>
                  <th>Corr</th>
                  <th>nRMSE</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="match in topScalarMatches.slice(0, 16)"
                  :key="`${match.familyKey}:${match.candidateKey}:${match.participantId}:${match.metricKey}`"
                  style="cursor: pointer"
                  @click="selectedFamilyKey = match.familyKey"
                >
                  <td><code>{{ formatNumber(match.familyLength) }} / {{ formatByte(match.familyFirstByte) }}</code></td>
                  <td>{{ match.slotIndex }}</td>
                  <td>{{ match.laneIndex }}</td>
                  <td><code>{{ match.decodeLabel }}</code></td>
                  <td>{{ match.champion }}</td>
                  <td>{{ match.metricLabel }}</td>
                  <td>{{ match.correlation.toFixed(2) }}</td>
                  <td>{{ match.normalizedRmse.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>


    <div v-if="participantAssignments.length || topParticipantCandidates.length" class="row g-2">
      <div class="col-lg-6 d-flex flex-column gap-2">
        <div class="island p-3">
          <h2 class="fs-5 mb-2">Automatic Participant Assignment</h2>
          <p class="text-muted small mb-3">
            These rows are the best current slot-to-player assignments after filtering families down to dynamic and mixed archetypes from the entity-slab pass.
          </p>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>Family</th>
                  <th>Slot</th>
                  <th>Champion</th>
                  <th>Archetype</th>
                  <th>Metrics</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="assignment in participantAssignments"
                  :key="`${assignment.familyKey}:${assignment.slotIndex}:${assignment.participantId}`"
                  style="cursor: pointer"
                  @click="selectedFamilyKey = assignment.familyKey"
                >
                  <td><code>{{ assignment.familyLabel }}</code></td>
                  <td>{{ assignment.slotIndex }}</td>
                  <td>{{ assignment.champion }}</td>
                  <td><code>{{ assignment.archetype }}</code></td>
                  <td>{{ assignment.distinctMetrics }}</td>
                  <td>{{ assignment.score.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="col-lg-6 d-flex flex-column gap-2">
        <div class="island p-3">
          <h2 class="fs-5 mb-2">Top Row Candidates</h2>
          <p class="text-muted small mb-3">
            Candidate rows are aggregated across multiple scalar metrics. Higher metric diversity is stronger evidence than a single good gold or xp lane.
          </p>
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                <tr>
                  <th>Family</th>
                  <th>Slot</th>
                  <th>Champion</th>
                  <th>Metrics</th>
                  <th>Corr</th>
                  <th>nRMSE</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="candidate in topParticipantCandidates.slice(0, 16)"
                  :key="`${candidate.familyKey}:${candidate.slotIndex}:${candidate.participantId}:candidate`"
                  style="cursor: pointer"
                  @click="selectedFamilyKey = candidate.familyKey"
                >
                  <td><code>{{ candidate.familyLabel }}</code></td>
                  <td>{{ candidate.slotIndex }}</td>
                  <td>{{ candidate.champion }}</td>
                  <td>{{ candidate.distinctMetrics }}</td>
                  <td>{{ candidate.averageCorrelation.toFixed(2) }}</td>
                  <td>{{ candidate.averageNormalizedRmse.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div v-if="families.length === 0" class="island p-4 text-center text-muted">
      <div class="fs-5 mb-2">No family scan results yet</div>
      <p class="mb-0">
        The scan ranks recurring framed subrecord families that are likely to contain world or entity state.
        Automatic correlation then checks those candidates against Riot timeline positions, event windows, and scalar participant-frame stats.
      </p>
    </div>

    <template v-else>
      <div class="row g-2">
        <div class="col-lg-7 d-flex flex-column gap-2">
          <div class="island p-3">
            <h2 class="fs-5 mb-3">Recurring Families</h2>
            <div class="table-responsive">
              <table class="table table-sm table-hover align-middle mb-0 small">
                <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                  <tr>
                    <th>Length</th>
                    <th>First</th>
                    <th>Records</th>
                    <th>Chunks</th>
                    <th>Header</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="family in families"
                    :key="familyKey(family)"
                    :class="{ 'table-primary': familyKey(family) === selectedFamilyKey }"
                    style="cursor: pointer"
                    @click="selectedFamilyKey = familyKey(family)"
                  >
                    <td>{{ formatNumber(family.length) }}</td>
                    <td><code>{{ formatByte(family.firstByte) }}</code></td>
                    <td>{{ formatNumber(family.recordCount) }}</td>
                    <td>{{ formatNumber(family.chunkCount) }}</td>
                    <td>
                      <span v-if="family.recommendedHeaderSize >= 0">h{{ family.recommendedHeaderSize }}</span>
                      <span v-else class="text-muted">n/a</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="col-lg-5 d-flex flex-column gap-2">
          <div v-if="selectedFamily" class="island p-3">
            <h2 class="fs-5 mb-3">Selected Family</h2>
            <dl class="row g-2 mb-0 small">
              <dt class="col-6 text-muted fw-normal">Length</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ formatNumber(selectedFamily.length) }}</dd>

              <dt class="col-6 text-muted fw-normal">First Byte</dt>
              <dd class="col-6 text-end fw-bold mb-0"><code>{{ formatByte(selectedFamily.firstByte) }}</code></dd>

              <dt class="col-6 text-muted fw-normal">Chunk Span</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ selectedFamily.chunkSpanStart }}-{{ selectedFamily.chunkSpanEnd }}</dd>

              <dt class="col-6 text-muted fw-normal">Header Candidates</dt>
              <dd class="col-6 text-end fw-bold mb-0">
                <span v-if="selectedFamily.headerSizeCandidates.length">
                  {{ selectedFamily.headerSizeCandidates.map((candidate) => `h${candidate.headerSize}`).join(', ') }}
                </span>
                <span v-else class="text-muted">none</span>
              </dd>
            </dl>
          </div>

          <div class="island p-3">
            <h2 class="fs-5 mb-2">Interpretation</h2>
            <p class="small text-muted mb-2">
              The tables below are now ranked automatically. Lower affine RMSE helps for movement, while higher scalar correlation and lower normalized RMSE help identify stat-like lanes.
            </p>
            <p class="small text-muted mb-0">
              If movement stays weak but scalar matches start to look strong, that is still progress: we can lock identity and timing through gold/xp/cs/health style lanes first and come back to positions later.
            </p>
          </div>
        </div>
      </div>

      <div v-if="familyAnalysis" class="row g-2">
        <div class="col-xl-8 d-flex flex-column gap-2">
          <div class="island p-3 d-flex flex-column gap-3">
            <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap">
              <div>
                <h2 class="fs-5 mb-1">Candidate Track Preview</h2>
                <p class="text-muted small mb-0">
                  This preview is still useful for inspection, but the main ranking now comes from automatic Riot correlation rather than visual guesswork.
                </p>
              </div>
              <span v-if="selectedCandidate" class="badge bg-info-subtle text-info-emphasis">
                Slot {{ selectedCandidate.slotIndex }} {{ selectedCandidate.pairLabel }}
              </span>
            </div>
            <div class="movement-map-frame d-flex justify-content-center bg-black bg-opacity-25 rounded-3 p-2 p-xl-3 border border-secondary border-opacity-10">
              <Minimap
                class="movement-map"
                :player-data="selectedCandidateMovement"
                empty-message="Analyze a family and select a candidate track to render it here."
              />
            </div>
            <Timeline />
          </div>

          <div class="island p-3">
            <h2 class="fs-5 mb-3">Top Slot/Pair Candidates</h2>
            <div class="table-responsive">
              <table class="table table-sm table-hover align-middle mb-0 small">
                <thead class="text-muted x-small text-uppercase sticky-top bg-body">
                  <tr>
                    <th>#</th>
                    <th>Slot</th>
                    <th>Pair</th>
                    <th>Score</th>
                    <th>Smooth</th>
                    <th>Moving</th>
                    <th>Coverage</th>
                    <th>Range</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="candidate in candidates"
                    :key="candidateKey(candidate)"
                    :class="{ 'table-primary': candidateKey(candidate) === selectedCandidateKey }"
                    style="cursor: pointer"
                    @click="selectedCandidateKey = candidateKey(candidate)"
                  >
                    <td>{{ candidate.rank }}</td>
                    <td>{{ candidate.slotIndex }}</td>
                    <td><code>{{ candidate.pairLabel }}</code></td>
                    <td>{{ candidate.score.toFixed(1) }}</td>
                    <td>{{ formatPercent(candidate.smoothRatio) }}</td>
                    <td>{{ formatPercent(candidate.movingRatio) }}</td>
                    <td>{{ formatPercent(candidate.coverage) }}</td>
                    <td>{{ Math.round(candidate.xRange) }}/{{ Math.round(candidate.yRange) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="col-xl-4 d-flex flex-column gap-2">
          <div v-if="selectedCandidate" class="island p-3">
            <h2 class="fs-5 mb-3">Candidate Details</h2>
            <dl class="row g-2 mb-0 small">
              <dt class="col-6 text-muted fw-normal">Class</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ selectedCandidate.classKey }}</dd>

              <dt class="col-6 text-muted fw-normal">Samples</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ formatNumber(selectedCandidate.coordinateSamples) }}</dd>

              <dt class="col-6 text-muted fw-normal">Transitions</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ formatNumber(selectedCandidate.transitions) }}</dd>

              <dt class="col-6 text-muted fw-normal">Top Mask</dt>
              <dd class="col-6 text-end fw-bold mb-0"><code>{{ selectedCandidate.topMaskBits }}</code></dd>

              <dt class="col-6 text-muted fw-normal">Top First Byte</dt>
              <dd class="col-6 text-end fw-bold mb-0"><code>{{ formatByte(selectedCandidate.topFirstByte) }}</code></dd>

              <dt class="col-6 text-muted fw-normal">Chunk Span</dt>
              <dd class="col-6 text-end fw-bold mb-0">{{ selectedCandidate.chunkSpanStart }}-{{ selectedCandidate.chunkSpanEnd }}</dd>
            </dl>
          </div>

          <div class="island p-3">
            <h2 class="fs-5 mb-3">Top Classes</h2>
            <div v-if="topClasses.length" class="d-flex flex-column gap-2">    
              <div v-for="classItem in topClasses" :key="classItem.key" class="border rounded-2 p-2 small">
                <div class="fw-bold text-break">{{ classItem.key }}</div>      
                <div class="text-muted x-small">
                  {{ classItem.members }} slots | best {{ classItem.bestScore.toFixed(1) }} | moving {{ formatNumber(classItem.totalMovingTransitions) }}     
                </div>
              </div>
            </div>
            <div v-else class="small text-muted">No class aggregation available yet.</div>
          </div>
        </div>
      </div>
    </template>

    <div class="mt-4">
      <SchemaJsonLoader :mockTokens="mockTokens" />
    </div>
  </div>
</template><style scoped>
.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}

.movement-map-frame {
  width: 100%;
}

.movement-map {
  width: 100%;
}
</style>
