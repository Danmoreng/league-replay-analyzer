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
import { analyzeBitfieldSchemaWithWasm, analyzeCleanRowOffsetsWithWasm } from "../wasmReplayParser";

const props = defineProps<{
  replayBuffer: ArrayBuffer | null;
  selectedFamily: ReplayFamilyScanItem | null;
  candidateRows: number[];
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

const selectedFamily = computed(() => props.selectedFamily);
const canRun = computed(() => Boolean(props.replayBuffer && props.selectedFamily));

const estimatedElementCount = computed(() => {
  const family = props.selectedFamily;
  if (!family) {
    return 0;
  }
  const usable = family.length - Math.max(family.recommendedHeaderSize, 0);
  if (usable <= 0 || family.recommendedStride <= 0) {
    return 0;
  }
  return Math.floor(usable / family.recommendedStride);
});

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

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
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
