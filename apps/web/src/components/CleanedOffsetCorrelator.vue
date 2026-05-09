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
import { computed, ref, watch } from "vue";
import type { ReplayScalarCorrelationReport } from "../replayScalarCorrelation";
import type { RiotFixtureBundle } from "../riotApiFixtures";
import type { ReplayFamilyScanItem } from "../replayInvestigation";
import { correlateCleanedFields } from "../replayDeepAnalysis";

const props = defineProps<{
  riotBundle: RiotFixtureBundle | null;
  familyContext: ReplayFamilyScanItem;
  cleanedFieldsData: any; // The raw JSON output containing slots -> fields -> samples
  autorun?: boolean;
}>();

const isCorrelating = ref(false);
const report = ref<ReplayScalarCorrelationReport | null>(null);

const hasCandidates = computed(() => {
  return props.cleanedFieldsData && Array.isArray(props.cleanedFieldsData.slots) && props.cleanedFieldsData.slots.length > 0;
});

function correlate() {
  if (!props.riotBundle || !hasCandidates.value) {
    return;
  }

  isCorrelating.value = true;

  try {
    report.value = correlateCleanedFields(props.familyContext, props.cleanedFieldsData, props.riotBundle);
  } catch (error) {
    console.error("Cleaned correlation failed", error);
    report.value = null;
  } finally {
    isCorrelating.value = false;
  }
}

watch(
  () => [props.cleanedFieldsData, props.riotBundle, props.autorun],
  () => {
    report.value = null;
    if (props.autorun !== false && props.riotBundle && hasCandidates.value) {
      correlate();
    }
  },
  { immediate: true },
);
</script>

