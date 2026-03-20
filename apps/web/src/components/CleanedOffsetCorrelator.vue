<template>
  <div class="island p-3 mt-3">
    <div class="d-flex justify-content-between align-items-start mb-3">
      <div>
        <h2 class="fs-5 mb-1">Cleaned Offset Correlation</h2>
        <p class="text-muted small mb-0">
          Rank the surviving fields (after signature masking) against Riot API stats.
        </p>
      </div>
      <button 
        class="btn btn-success btn-sm" 
        :disabled="!riotBundle || !hasCandidates || isCorrelating"
        @click="correlate"
      >
        <span v-if="isCorrelating" class="spinner-border spinner-border-sm me-2"></span>
        Correlate Cleaned Fields
      </button>
    </div>

    <div v-if="!riotBundle" class="text-warning small mb-3">
      Load a Riot API match bundle to enable correlation.
    </div>

    <div v-if="report && report.topScalarMatches.length > 0" class="table-responsive">
      <table class="table table-sm table-hover align-middle mb-0 small">
        <thead class="text-muted x-small text-uppercase sticky-top bg-body">
          <tr>
            <th>Row</th>
            <th>Offset</th>
            <th>Type</th>
            <th>Champion</th>
            <th>Metric</th>
            <th>Corr</th>
            <th>nRMSE</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="match in report.topScalarMatches.slice(0, 15)" :key="match.candidateKey + match.participantId + match.metricKey">
            <td>{{ match.slotIndex }}</td>
            <td>{{ match.laneIndex }}</td>
            <td><code>{{ match.decodeLabel }}</code></td>
            <td>{{ match.champion }}</td>
            <td>{{ match.metricLabel }}</td>
            <td>{{ match.correlation.toFixed(3) }}</td>
            <td>{{ match.normalizedRmse.toFixed(3) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="report" class="text-muted small">
      No strong correlations found in the cleaned fields.
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { correlateReplayScalars, type ReplayScalarCorrelationReport } from "../replayScalarCorrelation";
import type { RiotFixtureBundle } from "../riotApiFixtures";
import type { ReplayFamilyScanItem, ReplayScalarFamilyAnalysisResult } from "../replayInvestigation";

const props = defineProps<{
  riotBundle: RiotFixtureBundle | null;
  familyContext: ReplayFamilyScanItem;
  cleanedFieldsData: any; // The raw JSON output containing slots -> fields -> samples
}>();

const isCorrelating = ref(false);
const report = ref<ReplayScalarCorrelationReport | null>(null);

const hasCandidates = computed(() => {
  return props.cleanedFieldsData && Array.isArray(props.cleanedFieldsData.slots) && props.cleanedFieldsData.slots.length > 0;
});

function correlate() {
  if (!props.riotBundle || !hasCandidates.value) return;
  
  isCorrelating.value = true;
  
  try {
    // We need to map the new CLI output (slots -> fields -> samples) 
    // into the ReplayScalarFamilyAnalysisResult shape (slots -> lanes -> samples) 
    // expected by correlateReplayScalars.
    
    const mappedSlots = props.cleanedFieldsData.slots.map((s: any) => {
       const mappedLanes = (s.fields || []).map((f: any) => {
           return {
               laneIndex: f.offset, // Map offset to laneIndex so the correlator knows what it is
               activeSamples: f.activeSamples ?? 0,
               nonZeroSamples: f.nonZeroSamples ?? 0,
               uniqueValues: f.uniqueValues ?? 0,
               transitions: f.transitions ?? 0,
               changedTransitions: f.changedTransitions ?? 0,
               minU32: f.minValue ?? 0, // Approx
               maxU32: f.maxValue ?? 0,
               minFiniteF32: 0,
               maxFiniteF32: 0,
               samples: (f.samples || []).map((sample: any) => ({
                   chunkId: sample.chunkId ?? 0,
                   recordIndex: sample.recordIndex ?? 0,
                   timestamp: sample.timestamp ?? 0,
                   rawU32: sample.raw !== undefined ? sample.raw : (sample.u32 ?? 0),
                   firstByte: 0,
                   mask: 0,
                   maskBits: ""
               }))
           };
       });
       
       return {
           rank: 0,
           slotIndex: s.slotIndex,
           score: 0,
           activeRecords: s.activeRecords ?? 0,
           totalLaneSamples: 0,
           maxActiveLanes: 0,
           topFirstByte: 0,
           topFirstByteCount: 0,
           topMask: 0,
           topMaskBits: "",
           topMaskCount: 0,
           chunkSpanStart: s.chunkSpanStart ?? 0,
           chunkSpanEnd: s.chunkSpanEnd ?? 0,
           lanes: mappedLanes
       };
    });
    
    const analysisStub: ReplayScalarFamilyAnalysisResult = {
        length: props.familyContext.length,
        firstByte: props.familyContext.firstByte,
        recordCount: props.cleanedFieldsData.recordCount ?? 0,
        headerSize: props.familyContext.recommendedHeaderSize,
        stride: props.familyContext.recommendedStride,
        gameLengthMillis: 0,
        chunkBaseId: 0,
        elementCount: 0,
        laneCount: 0,
        slots: mappedSlots
    };
    
    const result = correlateReplayScalars([{ family: props.familyContext, analysis: analysisStub }], props.riotBundle);
    report.value = result;
    
  } catch (e) {
    console.error("Cleaned correlation failed", e);
  } finally {
    isCorrelating.value = false;
  }
}
</script>

