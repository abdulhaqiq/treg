<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from './client.js'
import { FIXED, ROUTE_CAP_USD, keptColumns, priceOf, readAnswer, tableFromRows, usd } from './jobs.js'

const props = defineProps({ source: Object })
const emit = defineEmits(['cancel', 'created'])

const values = reactive(Object.fromEntries(props.source.fields.map((f) => [f.name, ''])))
const limit = ref(25)
const tool = ref(null)
const preview = ref([])
const busy = ref(false)
const error = ref('')

onMounted(async () => {
  api.tool(props.source.tool).then((t) => (tool.value = t)).catch(() => {})
  const cols = await api.columns(props.source.tool)
  preview.value = cols?.columns?.length ? keptColumns(props.source.kind, cols.columns) : FIXED[props.source.kind]
})

const filled = computed(() => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])))
const estimate = computed(() => {
  const p = priceOf(tool.value, Object.keys(filled.value))
  return p.known ? `From ${usd(p.min * 1e6)}, at most ${usd(p.max * 1e6)}` : ''
})

async function create() {
  busy.value = true
  error.value = ''
  try {
    const body = { ...filled.value, ...(props.source.noLimit ? {} : { limit: Number(limit.value) || 25 }) }
    const r = readAnswer(await api.run(props.source.tool, { method: 'POST', body, maxCost: ROUTE_CAP_USD }))
    if (r.state === 'miss') error.value = 'Nothing matched. Try a broader description.'
    else if (r.state !== 'hit') error.value = r.error
    else {
      const name = Object.values(filled.value)[0] || props.source.label
      emit('created', tableFromRows(name, props.source.kind, r.rows, keptColumns(props.source.kind, r.columns),
        { source: { tool: props.source.tool, body } }))
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <h1>{{ source.label }}</h1>
  <p class="muted">{{ source.hint }}.</p>
  <form class="form" @submit.prevent="create">
    <label v-for="f in source.fields" :key="f.name">
      <span>{{ f.label }}</span>
      <input v-model="values[f.name]" :placeholder="f.placeholder" />
    </label>
    <label v-if="!source.noLimit">
      <span>Rows</span>
      <input v-model.number="limit" type="number" min="1" max="100" />
    </label>
    <p class="muted small">Columns: {{ preview.join(' · ') }}</p>
    <p v-if="error" class="warn">{{ error }}</p>
    <div class="actions">
      <span class="muted small">{{ estimate }}</span>
      <span class="spacer" />
      <button type="button" class="ghost" @click="emit('cancel')">Back</button>
      <button class="primary" :disabled="busy || !Object.keys(filled).length">{{ busy ? 'Searching…' : 'Create table' }}</button>
    </div>
  </form>
</template>
