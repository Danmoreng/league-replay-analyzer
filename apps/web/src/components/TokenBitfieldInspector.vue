<template>
  <div class="token-inspector bg-white dark:bg-gray-800 rounded-lg shadow border border-gray-200 dark:border-gray-700">
    <div class="p-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
      <h3 class="text-lg font-semibold text-gray-900 dark:text-white">Token & Bitfield Inspector</h3>
      <div class="text-sm text-gray-500">
        {{ tokens.length }} tokens loaded
      </div>
    </div>

    <div class="p-4 overflow-auto max-h-[600px]">
      <table class="w-full text-sm text-left">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50 dark:bg-gray-700 dark:text-gray-400 sticky top-0 z-10">
          <tr>
            <th class="px-3 py-2 font-medium">Token</th>
            <th class="px-3 py-2 font-medium">Source</th>
            <th class="px-3 py-2 font-medium">Analysis (Bytes, 16-bit, 12-bit)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(token, index) in tokens" :key="index" class="border-b dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600">
            <td class="px-3 py-2 align-top font-mono text-blue-600 dark:text-blue-400 whitespace-nowrap">
              {{ token.tokenHex }}
            </td>
            <td class="px-3 py-2 align-top text-gray-600 dark:text-gray-300">
              <div v-if="token.slot !== undefined">Row {{ token.slot }}</div>
              <div v-if="token.offset !== undefined">Lane {{ token.offset }}</div>
              <div v-if="token.sourceFirstByte !== undefined">Family {{ formatByte(token.sourceFirstByte) }}</div>
            </td>
            <td class="px-3 py-2 align-top">
              <div class="flex flex-wrap gap-2">
                <template v-for="slice in analyze(token)" :key="slice.label">
                  <div 
                    class="px-2 py-1 rounded text-xs font-mono border"
                    :class="[
                      slice.matchType === 'family' ? 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300 dark:border-purple-800' : 
                      slice.matchType === 'capacity' ? 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800' : 
                      'bg-gray-50 text-gray-600 border-gray-200 dark:bg-gray-700 dark:text-gray-400 dark:border-gray-600'
                    ]"
                  >
                    <div class="text-[10px] opacity-75 mb-0.5">{{ slice.label }}</div>
                    <div class="font-bold flex items-center gap-1">
                      {{ slice.hex }} <span v-if="slice.matchType" class="text-[10px] font-normal tracking-tight">({{ slice.matchDesc }})</span>
                    </div>
                  </div>
                </template>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { analyzeToken, type RawToken } from "../tokenBitfields";

defineProps<{
  tokens: RawToken[];
}>();

function formatByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function analyze(token: RawToken) {
  return analyzeToken(token);
}
</script>

