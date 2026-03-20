<template>
  <div class="schema-json-loader d-flex flex-column gap-3">
    <div class="island p-3">
      <h2 class="fs-5 mb-3">Bitfield Schema Inspector</h2>
      <p class="text-muted small">
        Load the JSON output from <code>--analyze-bitfield-schema-json</code> to inspect bitfield handles and descriptor rows.
      </p>
      
      <div class="mb-3">
        <label class="form-label small">Paste JSON Output or Select File</label>
        <textarea v-model="jsonText" class="form-control text-monospace small mb-2" rows="4" placeholder="Paste JSON here..."></textarea>
        <input type="file" accept=".json" class="form-control form-control-sm" @change="handleFileUpload" />
      </div>
      
      <div class="d-flex gap-2 align-items-center">
        <button class="btn btn-primary btn-sm" @click="parseJson">Parse JSON</button>
        <button class="btn btn-outline-secondary btn-sm" @click="loadMock">Load Mock Tokens</button>
        <span v-if="error" class="text-danger small ms-2">{{ error }}</span>
        <span v-if="successMsg" class="text-success small ms-2">{{ successMsg }}</span>
      </div>
    </div>

    <div v-if="summary && (summary.descriptorRows || summary.topWindows)" class="row g-2">
      <div class="col-lg-6" v-if="summary.descriptorRows">
        <div class="island p-3">
          <h3 class="fs-6 mb-2">Descriptor-Heavy Rows</h3>
          <div class="table-responsive">
            <table class="table table-sm small">
              <thead class="text-muted x-small text-uppercase bg-body">
                <tr>
                  <th>Row</th>
                  <th>Descriptor Score</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in summary.descriptorRows" :key="row.slotIndex">
                  <td>{{ row.slotIndex }}</td>
                  <td>{{ Number(row.score ?? 0).toFixed(2) }}</td>
                  <td>
                    {{ row.tokenCount }}
                    <span v-if="row.descriptorWindowCount" class="text-muted">/ {{ row.descriptorWindowCount }} windows</span>
                    <span v-if="row.descriptorLike" class="badge bg-success-subtle text-success-emphasis ms-2">schema</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div class="col-lg-6" v-if="summary.topWindows">
        <div class="island p-3">
          <h3 class="fs-6 mb-2">Top Windows</h3>
          <pre class="small text-muted mb-0" style="max-height: 200px; overflow: auto;">{{ JSON.stringify(summary.topWindows, null, 2) }}</pre>
        </div>
      </div>
    </div>

    <TokenBitfieldInspector v-if="activeTokens.length > 0" :tokens="activeTokens" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import TokenBitfieldInspector from './TokenBitfieldInspector.vue';
import type { RawToken } from '../tokenBitfields';

const props = defineProps<{
  mockTokens: RawToken[];
}>();

const jsonText = ref('');
const error = ref('');
const successMsg = ref('');
const activeTokens = ref<RawToken[]>(props.mockTokens);
const summary = ref<any>(null);

function handleFileUpload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    jsonText.value = e.target?.result as string;
    parseJson();
  };
  reader.readAsText(file);
}

function loadMock() {
  activeTokens.value = props.mockTokens;
  summary.value = null;
  error.value = '';
  successMsg.value = 'Mock tokens loaded.';
}

function parseJson() {
  error.value = '';
  successMsg.value = '';
  if (!jsonText.value.trim()) {
    error.value = 'Please paste JSON output first.';
    return;
  }
  
  try {
    const data = JSON.parse(jsonText.value);
    const parsedTokens: RawToken[] = [];
    
    // Typed adapter logic
    const familyLength = data.length ?? data.familyLength;
    const firstByte = data.firstByte ?? data.familyFirstByte;
    
    const descriptorRows: any[] = [];
    
    if (Array.isArray(data.rows)) {
      for (const row of data.rows) {
        const slotIndex = row.slotIndex ?? row.row ?? row.index ?? 0;
        let rowTokenCount = 0;

        const pushToken = (value: number, lane: number) => {
          if (!value) return;
          parsedTokens.push({
            tokenHex: '0x' + value.toString(16).toUpperCase().padStart(8, '0'),
            tokenU32: value >>> 0,
            sourceFamilyLength: familyLength,
            sourceFirstByte: firstByte,
            slot: slotIndex,
            offset: lane,
          });
          rowTokenCount++;
        };

        if (Array.isArray(row.tokens)) {
          for (const t of row.tokens) {
            if (typeof t === 'number') {
              pushToken(t, 0);
            } else if (t) {
              pushToken(t.u32 ?? t.rawU32 ?? t.val ?? 0, t.lane ?? t.offset ?? 0);
            }
          }
        }

        if (Array.isArray(row.windows)) {
          for (const w of row.windows) {
            if (!Array.isArray(w.tokens)) continue;
            for (const t of w.tokens) {
              if (typeof t === 'number') {
                pushToken(t, w.offset ?? 0);
              } else if (t) {
                pushToken(t.u32 ?? t.rawU32 ?? t.val ?? 0, t.lane ?? t.offset ?? w.offset ?? 0);
              }
            }
          }
        }

        if (Array.isArray(row.topWindows)) {
          for (const w of row.topWindows) {
            if (!Array.isArray(w.topTokens)) continue;
            for (const t of w.topTokens) {
              pushToken(t.rawU32 ?? t.u32 ?? t.val ?? 0, w.offset ?? 0);
            }
          }
        }

        descriptorRows.push({
          slotIndex,
          score: row.bestWindowScore ?? row.descriptorScore ?? row.score ?? 0,
          tokenCount: rowTokenCount,
          descriptorWindowCount: row.descriptorWindowCount ?? 0,
          descriptorLike: row.descriptorLike ?? row.isDescriptor ?? false,
        });
      }
    } else if (Array.isArray(data.slots)) {
      // Fallback to older scalars JSON
      for (const slot of data.slots) {
        if (Array.isArray(slot.lanes)) {
          for (const lane of slot.lanes) {
            if (Array.isArray(lane.samples)) {
              for (const sample of lane.samples) {
                const u32 = sample.rawU32 ?? sample.u32;
                if (u32) {
                  parsedTokens.push({
                    tokenHex: '0x' + u32.toString(16).toUpperCase().padStart(8, '0'),
                    tokenU32: u32,
                    sourceFamilyLength: data.length,
                    sourceFirstByte: data.firstByte,
                    slot: slot.slotIndex,
                    offset: lane.laneIndex
                  });
                }
              }
            }
          }
        }
      }
    } else if (Array.isArray(data.tokens)) {
         for (const t of data.tokens) {
              let u32 = typeof t === 'number' ? t : (t.u32 ?? t.rawU32 ?? t.val ?? 0);
              if (u32 !== 0) {
                   parsedTokens.push({
                       tokenHex: '0x' + u32.toString(16).toUpperCase().padStart(8, '0'),
                       tokenU32: u32,
                       sourceFamilyLength: familyLength,
                       sourceFirstByte: firstByte,
                       slot: t.slot ?? t.row ?? t.slotIndex ?? 0,
                       offset: t.lane ?? t.offset ?? 0
                   });
              }
         }
    }
    
    activeTokens.value = parsedTokens;
    summary.value = {
      descriptorRows: (Array.isArray(data.descriptorRows) ? data.descriptorRows.map((row: any) => ({
        slotIndex: row.slotIndex ?? row.row ?? row.index ?? 0,
        score: row.bestWindowScore ?? row.descriptorScore ?? row.score ?? 0,
        tokenCount: row.bestTotalExactHits ?? row.tokenCount ?? 0,
        descriptorWindowCount: row.descriptorWindowCount ?? 0,
        descriptorLike: row.descriptorLike ?? row.isDescriptor ?? false,
      })) : descriptorRows).length > 0
        ? (Array.isArray(data.descriptorRows) ? data.descriptorRows.map((row: any) => ({
            slotIndex: row.slotIndex ?? row.row ?? row.index ?? 0,
            score: row.bestWindowScore ?? row.descriptorScore ?? row.score ?? 0,
            tokenCount: row.bestTotalExactHits ?? row.tokenCount ?? 0,
            descriptorWindowCount: row.descriptorWindowCount ?? 0,
            descriptorLike: row.descriptorLike ?? row.isDescriptor ?? false,
          })) : descriptorRows)
        : undefined,
      topWindows: data.topWindows ?? data.windows ?? undefined
    };
    successMsg.value = `Successfully parsed ${parsedTokens.length} tokens.`;
  } catch (err: any) {
    error.value = 'Failed to parse JSON: ' + err.message;
  }
}
</script>

<style scoped>
.x-small {
  font-size: 0.7rem;
  letter-spacing: 0.05rem;
}
</style>
