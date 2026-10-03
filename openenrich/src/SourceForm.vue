<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { api } from './client.js'
import { FIXED, ROUTE_CAP_USD, listRecords, priceOf, readAnswer, tableFromRows, usd } from './jobs.js'

const props = defineProps({ source: Object })
const emit = defineEmits(['cancel', 'created'])

const values = reactive(Object.fromEntries(props.source.fields.map((f) => [f.name, ''])))
const limit = ref(25)
const tool = ref(null)
const result = ref(null)       // {rows, columns, cost, servedBy} of the last search
const stale = ref(false)
const busy = ref(false)
const error = ref('')

onMounted(() => api.tool(props.source.tool).then((t) => (tool.value = t)).catch(() => {}))

const filled = computed(() => Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])))
const price = computed(() => {
  const p = priceOf(tool.value, Object.keys(filled.value))
  return p.known ? `${usd(p.min * 1e6)}–${usd(p.max * 1e6)}` : ''
})
const columns = computed(() => result.value?.ids || FIXED[props.source.kind])
watch([values, limit], () => { if (result.value) stale.value = true })

// The search is the table: "Create table" keeps these rows, it does not search again.
async function search() {
  busy.value = true
  error.value = ''
  try {
    const body = { ...filled.value, ...(props.source.noLimit ? {} : { limit: Number(limit.value) || 25 }) }
    const r = await api.run(props.source.tool, { method: 'POST', body, maxCost: ROUTE_CAP_USD, exclude: props.source.exclude })
    const a = readAnswer(r)
    if (a.state === 'hit') {
      const { records, ids } = listRecords(props.source.kind, a.rows, a.columns, body.limit)
      result.value = { rows: records, ids, body, cost: r.cost_micro, servedBy: r.served_by }
      stale.value = false
    } else {
      result.value = null
      error.value = a.state === 'miss' ? 'No results. Loosen a filter and search again.' : a.error
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function create() {
  const name = Object.values(result.value.body).find((v) => typeof v === 'string') || props.source.label
  emit('created', tableFromRows(name, props.source.kind, result.value.rows, columns.value,
    { source: { tool: props.source.tool, body: result.value.body } }))
}
</script>

<template>
  <div class="finder">
    <aside class="filters">
      <button class="ghost back" @click="emit('cancel')">← Back</button>
      <h1>{{ source.label }}</h1>
      <p class="muted small">{{ source.hint }}.</p>
      <form @submit.prevent="search">
        <label v-for="f in source.fields" :key="f.name" class="field">
          <span>{{ f.label }}</span>
          <input v-model="values[f.name]" :placeholder="f.placeholder" />
        </label>
        <label v-if="!source.noLimit" class="field">
          <span>Number of results</span>
          <input v-model.number="limit" type="number" min="1" max="100" />
        </label>
        <button class="primary wide" :disabled="busy || !Object.keys(filled).length">
          {{ busy ? 'Searching…' : result && !stale ? 'Search again' : 'Search' }}
        </button>
        <p v-if="price" class="muted small center">One search costs {{ price }}. No results, no charge.</p>
      </form>
    </aside>

    <section class="results">
      <header class="results-bar">
        <template v-if="result">
          <strong>{{ result.rows.length }} {{ source.kind }}</strong>
          <span class="muted small">via {{ result.servedBy }} · {{ usd(result.cost || 0) }}</span>
          <span v-if="stale" class="muted small">· filters changed, search again to update</span>
        </template>
        <span v-else class="muted">Set filters and search to preview results.</span>
        <span class="spacer" />
        <button class="primary" :disabled="!result" @click="create">Create table with {{ result?.rows.length || 0 }} rows</button>
      </header>
      <p v-if="error" class="banner">{{ error }}</p>
      <div class="grid-wrap">
        <table class="grid">
          <thead><tr><th class="num">#</th><th v-for="c in columns" :key="c">{{ c }}</th></tr></thead>
          <tbody v-if="result">
            <tr v-for="(r, i) in result.rows" :key="i">
              <td class="num">{{ i + 1 }}</td>
              <td v-for="c in columns" :key="c">{{ r[c] ?? '' }}</td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="i in 8" :key="i" class="ghost-row"><td class="num">{{ i }}</td><td v-for="c in columns" :key="c"><span /></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
