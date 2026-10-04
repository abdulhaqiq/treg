<script setup lang="ts">
import { computed, ref } from 'vue'
import BlockView from './BlockView.vue'
import { blocks, download } from './render'

const props = defineProps<{ output: unknown, fields: string[], name: string }>()
const raw = ref(false)
const shown = computed(() => blocks(props.output, props.fields))
const json = computed(() => JSON.stringify(props.output, null, 2))
const copied = ref(false)

async function copy() {
  try { await navigator.clipboard.writeText(json.value); copied.value = true; setTimeout(() => (copied.value = false), 1500) } catch { /* shown below */ }
}
</script>

<template>
  <div class="sa-result">
    <div class="sa-result-bar">
      <div class="sa-seg" role="group" aria-label="Result view">
        <button type="button" :class="{ on: !raw }" @click="raw = false">Result</button>
        <button type="button" :class="{ on: raw }" @click="raw = true">JSON</button>
      </div>
      <div class="sa-block-actions">
        <button class="sa-btn sm" type="button" @click="copy">{{ copied ? 'Copied' : 'Copy JSON' }}</button>
        <button class="sa-btn sm" type="button" @click="download(`${name}.json`, json, 'application/json')">Download JSON</button>
      </div>
    </div>
    <pre v-if="raw" class="sa-json">{{ json }}</pre>
    <div v-else class="sa-blocks"><BlockView v-for="b in shown" :key="b.label" :block="b"/></div>
  </div>
</template>
