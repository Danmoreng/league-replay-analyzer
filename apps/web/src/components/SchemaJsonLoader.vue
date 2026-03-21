<template>
  <div class="schema-json-loader d-flex flex-column gap-3">
    <div class="island p-3">
      <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap">
        <div>
          <h2 class="fs-5 mb-1">Backend Deep Analysis</h2>
          <p class="text-muted small mb-0">
            This runs the selected family through the Wasm backend directly. No file selection or JSON paste is required.
          </p>
        </div>
        <div class="d-flex gap-2 flex-wrap">
          <button class="btn btn-outline-light btn-sm" :disabled="!canRun || isSchemaRunning" @click="void runSchemaAnalysis()">
            <span v-if="isSchemaRunning" class="spinner-border spinner-border-sm me-2"></span>
            Run Schema Scan
          </button>
          <button class="btn btn-success btn-sm" :disabled="!canRun || isCleanRunning" @click="void runCleanedAnalysis()">
            <span v-if="isCleanRunning" class="spinner-border spinner-border-sm me-2"></span>
            Run Cleaned Field Scan
          </button>
          <button class="btn btn-primary btn-sm" :disabled="!canRun || isSchemaRunning || isCleanRunning" @click="void runAllAnalyses()">
            Run Both
          </button>
        </div>
      </div>

      <div class="row g-2 mt-1">
        <div class="col-lg-4">
          <div class="rounded-3 border border-secondary border-opacity-10 p-3 h-100 bg-body-tertiary bg-opacity-25">
            <div class="text-uppercase x-small text-muted mb-1">Selected Family</div>
            <div v-if="selectedFamily" class="small">
              <code>{{ selectedFamily.length }} / {{ formatByte(selectedFamily.firstByte) }}</code>
            </div>
            <div v-else class="small text-warning">Choose a family above first.</div>
          </div>
        </div>
        <div class="col-lg-4">
          <div class="rounded-3 border border-secondary border-opacity-10 p-3 h-100 bg-body-tertiary bg-opacity-25">
            <div class="text-uppercase x-small text-muted mb-1">Schema Rows</div>
            <div class="small text-muted">{{ schemaRowsLabel }}</div>
          </div>
        </div>
        <div class="col-lg-4">
          <div class="rounded-3 border border-secondary border-opacity-10 p-3 h-100 bg-body-tertiary bg-opacity-25">
            <div class="text-uppercase x-small text-muted mb-1">Cleaned Rows</div>
            <div class="small text-muted">{{ cleanedRowsLabel }}</div>
          </div>
        </div>
      </div>

      <div class="d-flex flex-column gap-1 mt-3 small">
        <div :class="schemaError ? 'text-danger' : 'text-muted'">{{ schemaError || schemaStatus }}</div>
        <div :class="cleanError ? 'text-danger' : 'text-muted'">{{ cleanError || cleanStatus }}</div>
        <div :class="deepError ? 'text-danger' : 'text-muted'">{{ deepError || deepStatus }}</div>
      </div>
    </div>

    <div class="island p-3">
      <div class="d-flex justify-content-between align-items-start gap-3 flex-wrap mb-3">
        <div>
          <h3 class="fs-6 mb-1">Automatic Deep Analysis</h3>
          <p class="text-muted small mb-0">
            Run schema scan plus cleaned-field correlation across the top recurring families and rank the most likely decoded fields automatically.
          </p>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="!replayBuffer || !riotBundle || !families.length || isDeepRunning" @click="void runAutoDeepAnalysis()">
          <span v-if="isDeepRunning" class="spinner-border spinner-border-sm me-2"></span>
          Run Auto Deep Analysis
        </button>
      </div>

      <div v-if="deepReport" class="row g-3">
        <div class="col-xl-5">
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Family</th>
                  <th>Rows</th>
                  <th>Fields</th>
                  <th>Best Lead</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="family in deepReport.families.slice(0, 6)" :key="family.familyKey">
                  <td><code>{{ family.familyLabel }}</code></td>
                  <td>{{ family.cleanedRowCount }}</td>
                  <td>{{ family.cleanedFieldCount }}</td>
                  <td>
                    <span v-if="family.topMatch">{{ family.topMatch.champion }} {{ family.topMatch.metricLabel }}</span>
                    <span v-else class="text-muted">n/a</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="col-xl-7">
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Family</th>
                  <th>Row/Offset</th>
                  <th>Decode</th>
                  <th>Metric</th>
                  <th>Corr</th>
                  <th>nRMSE</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="match in deepReport.topMatches.slice(0, 10)" :key="`${match.familyKey}:${match.candidateKey}:${match.metricKey}:${match.participantId}`">
                  <td><code>{{ match.familyLength }} / {{ formatByte(match.familyFirstByte) }}</code></td>
                  <td>{{ match.slotIndex }} / {{ match.laneIndex }}</td>
                  <td><code>{{ match.decodeLabel }}</code></td>
                  <td>{{ match.champion }} {{ match.metricLabel }}</td>
                  <td>{{ match.correlation.toFixed(2) }}</td>
                  <td>{{ match.normalizedRmse.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="col-12" v-if="deepReport.likelyFieldPatterns.length">
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Field Map</th>
                  <th>Family</th>
                  <th>Rows</th>
                  <th>Participants</th>
                  <th>Corr</th>
                  <th>nRMSE</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="pattern in deepReport.likelyFieldPatterns.slice(0, 10)" :key="pattern.patternKey">
                  <td>
                    <div><code>+{{ pattern.laneIndex }}</code> <code>{{ pattern.decodeLabel }}</code> -> {{ pattern.metricLabel }}</div>
                    <div class="text-muted x-small">{{ pattern.championPreview.join(', ') }}</div>
                  </td>
                  <td><code>{{ pattern.familyLabel }}</code></td>
                  <td>{{ pattern.rowPreview.join(', ') }}</td>
                  <td>{{ pattern.distinctParticipants }}</td>
                  <td>{{ pattern.averageCorrelation.toFixed(2) }}</td>
                  <td>{{ pattern.averageNormalizedRmse.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="col-12" v-if="deepReport.participantAssignments.topCandidates.length">
          <div class="table-responsive">
            <table class="table table-sm table-hover align-middle mb-0 small">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Family</th>
                  <th>Row</th>
                  <th>Champion</th>
                  <th>Metrics</th>
                  <th>Archetype</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="candidate in deepReport.participantAssignments.topCandidates.slice(0, 10)" :key="`${candidate.familyKey}:${candidate.slotIndex}:${candidate.participantId}`">
                  <td><code>{{ candidate.familyLabel }}</code></td>
                  <td>{{ candidate.slotIndex }}</td>
                  <td>{{ candidate.champion }}</td>
                  <td>{{ candidate.distinctMetrics }}</td>
                  <td><code>{{ candidate.archetype }}</code></td>
                  <td>{{ candidate.score.toFixed(2) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div v-else class="small text-muted">
        No automatic deep-analysis report yet. Run it after scanning families.
      </div>
    </div>

    <div v-if="schemaData && (schemaSummary.descriptorRows.length || schemaSummary.topWindows.length)" class="row g-2">
      <div class="col-lg-6" v-if="schemaSummary.descriptorRows.length">
        <div class="island p-3">
          <h3 class="fs-6 mb-2">Descriptor-Heavy Rows</h3>
          <div class="table-responsive">
            <table class="table table-sm small mb-0">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Row</th>
                  <th>Score</th>
                  <th>Windows</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in schemaSummary.descriptorRows" :key="row.slotIndex">
                  <td>{{ row.slotIndex }}</td>
                  <td>{{ Number(row.score ?? 0).toFixed(2) }}</td>
                  <td>
                    {{ row.tokenCount }}
                    <span v-if="row.descriptorWindowCount" class="text-muted">/ {{ row.descriptorWindowCount }}</span>
                    <span v-if="row.descriptorLike" class="badge bg-success-subtle text-success-emphasis ms-2">schema</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-lg-6" v-if="schemaSummary.topWindows.length">
        <div class="island p-3">
          <h3 class="fs-6 mb-2">Top Windows</h3>
          <pre class="small text-muted mb-0" style="max-height: 220px; overflow: auto;">{{ JSON.stringify(schemaSummary.topWindows, null, 2) }}</pre>
        </div>
      </div>
    </div>

    <CleanedOffsetCorrelator
      v-if="cleanedData"
      :riotBundle="riotBundle"
      :familyContext="familyContext"
      :cleanedFieldsData="cleanedData"
      :autorun="true"
    />

    <div v-if="activeTokens.length > 0" class="row g-2 mt-2">
      <div class="col-lg-6">
        <EcsMemoryMap :tokens="activeTokens" />
      </div>
      <div class="col-lg-6">
        <TokenBitfieldInspector :tokens="activeTokens" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import TokenBitfieldInspector from "./TokenBitfieldInspector.vue";
import EcsMemoryMap from "./EcsMemoryMap.vue";
import CleanedOffsetCorrelator from "./CleanedOffsetCorrelator.vue";
import type { RiotFixtureBundle } from "../riotApiFixtures";
import type { ReplayFamilyScanItem } from "../replayInvestigation";
import type { RawToken } from "../tokenBitfields";
import { analyzeBitfieldSchemaWithWasm, analyzeCleanRowOffsetsWithWasm, analyzeEntitySlabWithWasm } from "../wasmReplayParser";
import { buildReplayDeepAnalysisReport, deriveDeepCleanedRows, estimateElementCount, type ReplayDeepAnalysisReport } from "../replayDeepAnalysis";

const props = defineProps<{
  replayBuffer: ArrayBuffer | null;
  selectedFamily: ReplayFamilyScanItem | null;
  candidateRows: number[];
  families: ReplayFamilyScanItem[];
  riotBundle: RiotFixtureBundle | null;
}>();

const isSchemaRunning = ref(false);
const isCleanRunning = ref(false);
const schemaStatus = ref("Schema scan uses the selected family and early rows to find descriptor-heavy windows.");
const cleanStatus = ref("Cleaned field scan uses suggested non-schema rows and feeds the scalar correlator automatically.");
const schemaError = ref("");
const cleanError = ref("");
const schemaData = ref<any>(null);
const cleanedData = ref<any>(null);
const activeTokens = ref<RawToken[]>([]);
const deepReport = ref<ReplayDeepAnalysisReport | null>(null);
const isDeepRunning = ref(false);
const deepStatus = ref("Automatic deep analysis can scan the top families and rank likely decoded fields without manual family-by-family work.");
const deepError = ref("");

const selectedFamily = computed(() => props.selectedFamily);
const canRun = computed(() => Boolean(props.replayBuffer && props.selectedFamily));

const estimatedElementCount = computed(() => props.selectedFamily ? estimateElementCount(props.selectedFamily) : 0);

const schemaRows = computed(() => {
  const max = Math.min(12, estimatedElementCount.value);
  return Array.from({ length: max }, (_, index) => index);
});

const cleanedRows = computed(() => {
  const limit = estimatedElementCount.value;
  const suggested = Array.from(new Set(props.candidateRows)).filter((value) => value >= 0 && value < limit);
  if (suggested.length > 0) {
    return suggested.slice(0, 10);
  }
  const start = Math.min(12, Math.max(limit - 1, 0));
  const rows: number[] = [];
  for (let value = start; value < Math.min(start + 12, limit); value += 1) {
    rows.push(value);
  }
  return rows;
});

const schemaRowsLabel = computed(() => schemaRows.value.length ? schemaRows.value.join(", ") : "none");
const cleanedRowsLabel = computed(() => cleanedRows.value.length ? cleanedRows.value.join(", ") : "none");
const familyContext = computed<ReplayFamilyScanItem>(() => props.selectedFamily ?? {
  length: 0,
  firstByte: 0,
  paddingByte: 0,
  recordCount: 0,
  chunkCount: 0,
  chunkSpanStart: 0,
  chunkSpanEnd: 0,
  recommendedStride: 16,
  recommendedHeaderSize: 0,
  headerSizeCandidates: [],
});

const schemaSummary = computed(() => ({
  descriptorRows: Array.isArray(schemaData.value?.descriptorRows) ? schemaData.value.descriptorRows : [],
  topWindows: Array.isArray(schemaData.value?.topWindows) ? schemaData.value.topWindows : [],
}));

watch(() => props.selectedFamily && `${props.selectedFamily.length}:${props.selectedFamily.firstByte}`, () => {
  schemaData.value = null;
  cleanedData.value = null;
  activeTokens.value = [];
  schemaError.value = "";
  cleanError.value = "";
  schemaStatus.value = "Schema scan uses the selected family and early rows to find descriptor-heavy windows.";
  cleanStatus.value = "Cleaned field scan uses suggested non-schema rows and feeds the scalar correlator automatically.";
});

watch(() => props.families, () => {
  deepReport.value = null;
  deepError.value = "";
  deepStatus.value = "Automatic deep analysis can scan the top families and rank likely decoded fields without manual family-by-family work.";
});

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function resolveHeaderSize(family: ReplayFamilyScanItem): number {
  return family.recommendedHeaderSize >= 0 ? family.recommendedHeaderSize : (family.headerSizeCandidates[0]?.headerSize ?? 0);
}

async function runAutoDeepAnalysis(): Promise<void> {
  if (!props.replayBuffer) {
    deepError.value = "Load a replay before running automatic deep analysis.";
    return;
  }
  if (!props.riotBundle) {
    deepError.value = "Load a Riot timeline bundle before running automatic deep analysis.";
    return;
  }
  if (!props.families.length) {
    deepError.value = "Run a family scan first.";
    return;
  }

  isDeepRunning.value = true;
  deepError.value = "";
  deepStatus.value = "Running schema and cleaned-field analysis across the top families...";

  try {
    const targets = props.families.slice(0, 6);
    const inputs = [] as any[];

    for (let index = 0; index < targets.length; index += 1) {
      const family = targets[index];
      const headerSize = resolveHeaderSize(family);
      deepStatus.value = `Analyzing family ${index + 1}/${targets.length}: ${family.length} / ${formatByte(family.firstByte)}...`;
      const entityAnalysis = await analyzeEntitySlabWithWasm(props.replayBuffer, {
        length: family.length,
        firstByte: family.firstByte,
        headerSize,
        stride: family.recommendedStride,
        topSlots: 24,
      });
      const schemaRowCount = Math.min(12, estimateElementCount(family));
      const schemaRowsForFamily = Array.from({ length: schemaRowCount }, (_, rowIndex) => rowIndex);
      const schemaResult = await analyzeBitfieldSchemaWithWasm(props.replayBuffer, {
        length: family.length,
        firstByte: family.firstByte,
        headerSize,
        stride: family.recommendedStride,
        slotIndices: schemaRowsForFamily,
        topWindows: 12,
      });
      const cleanedRowsForFamily = deriveDeepCleanedRows(family, entityAnalysis, familyKeyMatchesSelected(family) ? props.candidateRows : []);
      const cleanedResult = await analyzeCleanRowOffsetsWithWasm(props.replayBuffer, {
        length: family.length,
        firstByte: family.firstByte,
        headerSize,
        stride: family.recommendedStride,
        slotIndices: cleanedRowsForFamily,
        topFields: 10,
      });
      inputs.push({
        family,
        entityAnalysis,
        schemaData: schemaResult,
        cleanedData: cleanedResult,
      });
    }

    deepReport.value = buildReplayDeepAnalysisReport(inputs, props.riotBundle);
    deepStatus.value = deepReport.value.summary;
  } catch (error) {
    deepReport.value = null;
    deepError.value = error instanceof Error ? error.message : String(error);
    deepStatus.value = "Automatic deep analysis failed.";
  } finally {
    isDeepRunning.value = false;
  }
}

function familyKeyMatchesSelected(family: ReplayFamilyScanItem): boolean {
  if (!props.selectedFamily) {
    return false;
  }
  return family.length === props.selectedFamily.length && family.firstByte === props.selectedFamily.firstByte;
}

function extractTokensFromSchema(data: any): RawToken[] {
  const tokens: RawToken[] = [];
  if (!Array.isArray(data?.rows)) {
    return tokens;
  }

  for (const row of data.rows) {
    const slotIndex = row.slotIndex ?? 0;
    if (!Array.isArray(row.topWindows)) {
      continue;
    }
    for (const window of row.topWindows) {
      if (!Array.isArray(window.topTokens)) {
        continue;
      }
      for (const token of window.topTokens) {
        const raw = token.rawU32 ?? token.u32 ?? token.val ?? 0;
        if (!raw) {
          continue;
        }
        tokens.push({
          tokenHex: `0x${(raw >>> 0).toString(16).toUpperCase().padStart(8, "0")}`,
          tokenU32: raw >>> 0,
          sourceFamilyLength: data.length,
          sourceFirstByte: data.firstByte,
          slot: slotIndex,
          offset: window.offset ?? 0,
        });
      }
    }
  }

  return tokens;
}

async function runSchemaAnalysis(): Promise<void> {
  if (!props.replayBuffer || !props.selectedFamily) {
    schemaError.value = "Select a family before running schema analysis.";
    return;
  }

  isSchemaRunning.value = true;
  schemaError.value = "";
  schemaStatus.value = `Scanning schema windows for ${props.selectedFamily.length} / ${formatByte(props.selectedFamily.firstByte)}...`;

  try {
    const result = await analyzeBitfieldSchemaWithWasm(props.replayBuffer, {
      length: props.selectedFamily.length,
      firstByte: props.selectedFamily.firstByte,
      headerSize: props.selectedFamily.recommendedHeaderSize >= 0 ? props.selectedFamily.recommendedHeaderSize : (props.selectedFamily.headerSizeCandidates[0]?.headerSize ?? 0),
      stride: props.selectedFamily.recommendedStride,
      slotIndices: schemaRows.value,
      topWindows: 12,
    });
    schemaData.value = result;
    activeTokens.value = extractTokensFromSchema(result);
    schemaStatus.value = `Analyzed ${schemaRows.value.length} rows and extracted ${activeTokens.value.length} schema tokens.`;
  } catch (error) {
    schemaData.value = null;
    activeTokens.value = [];
    schemaError.value = error instanceof Error ? error.message : String(error);
    schemaStatus.value = "Schema scan failed.";
  } finally {
    isSchemaRunning.value = false;
  }
}

async function runCleanedAnalysis(): Promise<void> {
  if (!props.replayBuffer || !props.selectedFamily) {
    cleanError.value = "Select a family before running cleaned field analysis.";
    return;
  }

  isCleanRunning.value = true;
  cleanError.value = "";
  cleanStatus.value = `Scanning cleaned fields for ${props.selectedFamily.length} / ${formatByte(props.selectedFamily.firstByte)}...`;

  try {
    const result = await analyzeCleanRowOffsetsWithWasm(props.replayBuffer, {
      length: props.selectedFamily.length,
      firstByte: props.selectedFamily.firstByte,
      headerSize: props.selectedFamily.recommendedHeaderSize >= 0 ? props.selectedFamily.recommendedHeaderSize : (props.selectedFamily.headerSizeCandidates[0]?.headerSize ?? 0),
      stride: props.selectedFamily.recommendedStride,
      slotIndices: cleanedRows.value,
      topFields: 10,
    });
    cleanedData.value = result;
    const slotCount = Array.isArray(result?.slots) ? result.slots.length : 0;
    cleanStatus.value = `Analyzed ${slotCount} cleaned rows and passed the surviving fields into the correlator.`;
  } catch (error) {
    cleanedData.value = null;
    cleanError.value = error instanceof Error ? error.message : String(error);
    cleanStatus.value = "Cleaned field scan failed.";
  } finally {
    isCleanRunning.value = false;
  }
}

async function runAllAnalyses(): Promise<void> {
  await runSchemaAnalysis();
  await runCleanedAnalysis();
}
</script>

<style scoped>
.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}
</style>
