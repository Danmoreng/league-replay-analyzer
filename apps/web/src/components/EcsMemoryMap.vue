<template>
  <div class="ecs-memory-map d-flex flex-column gap-2">
    <div class="island p-3">
      <h2 class="fs-5 mb-2">ECS Memory Map (16-byte Stride)</h2>
      <p class="text-muted small mb-3">
        Visual representation of the mixed slab. Rows 0-10 act as global schema descriptors defining table capacities. Rows 11+ contain entity data, heavily interspersed with 4-byte archetype signatures. The remaining gaps are the prime candidates for raw scalar stats.
      </p>

      <div class="d-flex gap-3 mb-3 small">
        <div class="d-flex align-items-center gap-1"><span class="badge bg-primary opacity-75">&nbsp;</span> Schema Descriptor</div>
        <div class="d-flex align-items-center gap-1"><span class="badge bg-purple">&nbsp;</span> Archetype Signature</div>
        <div class="d-flex align-items-center gap-1"><span class="badge bg-success opacity-75">&nbsp;</span> Scalar Data Gap</div>
        <div class="d-flex align-items-center gap-1"><span class="badge bg-secondary opacity-25 text-dark border">&nbsp;</span> Empty / Zero</div>
      </div>

      <div class="table-responsive" style="max-height: 500px; overflow-y: auto;">
        <table class="table table-sm table-bordered text-center align-middle mb-0" style="table-layout: fixed; font-size: 0.75rem;">
          <thead class="bg-body-secondary text-muted sticky-top">
            <tr>
              <th style="width: 60px;">Row</th>
              <th v-for="lane in maxLanes" :key="lane">Lane {{ lane - 1 }} (Offset {{ (lane - 1) * 4 }})</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="text-muted fw-bold bg-body-tertiary">{{ row.id }}</td>
              <td v-for="lane in row.lanes" :key="lane.id" :class="getCellClass(lane.type)" :title="lane.tooltip">
                <span v-if="lane.label" class="fw-mono">{{ lane.label }}</span>
                <span v-else>&nbsp;</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { RawToken } from '../tokenBitfields';

const props = defineProps<{
  tokens: RawToken[];
}>();

// Extracted from our motif clustering analysis
const SIGNATURES = new Set([
  0x0200F14B, 0x00F14B71, 0xF14B7100, 0x71000200, 
  0xF1DD7100, 0xDD710002, 0x00F1DD71, 0x000200F1,
  0x98985BDB, 0x9898D8F1, 0x9C98D898, 0x98989898, 0x4D9898D8,
  0xDD714000, 0x0400914B, 0x0300B14B, 0x4B710002, 0x00002007,
  0x0200F1DD, 0x00914B71, 0x914B7100
]);

interface LaneCell {
  id: number;
  type: 'schema' | 'signature' | 'data' | 'empty';
  label: string;
  tooltip: string;
}

const maxLanes = computed(() => {
  let max = 0;
  for (const t of props.tokens) {
    if (t.offset !== undefined && t.offset + 1 > max) {
      max = t.offset + 1;
    }
  }
  return Math.max(max, 4); // Default to at least 4 lanes
});

const rows = computed(() => {
  const result = [];
  
  // Find max row
  let maxRow = 15;
  for (const t of props.tokens) {
    if (t.slot !== undefined && t.slot > maxRow) {
      maxRow = t.slot;
    }
  }

  // Map for fast lookup
  const tokenMap = new Map<string, number>();
  for (const t of props.tokens) {
    if (t.slot !== undefined && t.offset !== undefined) {
      tokenMap.set(`${t.slot}-${t.offset}`, t.tokenU32);
    }
  }

  for (let r = 0; r <= maxRow; r++) {
    const lanes: LaneCell[] = [];
    for (let l = 0; l < maxLanes.value; l++) {
      const u32 = tokenMap.get(`${r}-${l}`);
      let type: 'schema' | 'signature' | 'data' | 'empty' = 'empty';
      let label = '';
      let tooltip = `Row ${r}, Lane ${l} (Offset ${l * 4})`;

      if (u32 !== undefined && u32 !== 0) {
        const hex = `0x${u32.toString(16).toUpperCase().padStart(8, '0')}`;
        label = hex;
        tooltip += `\nValue: ${hex}`;

        // Heuristics based on our recent discoveries
        if (r <= 10) {
          type = 'schema';
        } else if (SIGNATURES.has(u32)) {
          type = 'signature';
        } else {
          // If it has family bytes but isn't explicitly in our known set, still maybe a signature.
          // But for now, we'll call anything non-schema and non-signature a data candidate.
          type = 'data';
        }
      } else {
        // If it's 0 or empty, and we are past schema rows, it's a gap
        if (r > 10) {
            type = 'empty';
            label = '-';
        }
      }

      // If it's a data gap and it actually has a non-zero value, highlight it strongly
      lanes.push({ id: l, type, label, tooltip });
    }
    result.push({ id: r, lanes });
  }

  return result;
});

function getCellClass(type: string) {
  switch (type) {
    case 'schema': return 'bg-primary text-white bg-opacity-75';
    case 'signature': return 'bg-purple text-white';
    case 'data': return 'bg-success text-white bg-opacity-75 fw-bold';
    case 'empty': return 'bg-light text-muted opacity-50';
    default: return '';
  }
}
</script>

<style scoped>
.fw-mono {
  font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.bg-purple {
  background-color: #6f42c1 !important;
}
</style>
