<script setup>
import { computed, inject, onMounted, reactive, ref, watch } from 'vue'
import { FIXED, MAX_SEEDS, ROUTE_CAP_USD, listRecords, priceOf, readAnswer, splitList, tableFromRows, usd } from './jobs.js'

const props = defineProps({ source: Object })
const emit = defineEmits(['cancel', 'created'])
const api = inject('oeApi')

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
    // a multi field runs one search per value; the answers are merged, the seeds themselves left out
    const multi = props.source.fields.find((f) => f.multi && body[f.name])
    const seeds = multi ? splitList(body[multi.name]) : []
    const bodies = multi ? seeds.map((v) => ({ ...body, [multi.name]: v })) : [body]
    const runs = await Promise.all(bodies.map((b) => api.run(props.source.tool, { method: 'POST', body: b, maxCost: ROUTE_CAP_USD, exclude: props.source.exclude, fresh: true })))
    const answers = runs.map(readAnswer)
    const hits = answers.filter((a) => a.state === 'hit')
    if (hits.length) {
      const own = new Set(seeds.map((v) => v.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0]))
      const rows = hits.flatMap((a) => a.rows).filter((r) => !own.has(String(r.domain || '').toLowerCase()))
      const cols = [...new Set(hits.flatMap((a) => a.columns))]
      const { records, ids } = listRecords(props.source.kind, rows, cols, body.limit)
      result.value = { rows: records, ids, body, cost: runs.reduce((n, r) => n + (r.cost_micro || 0), 0),
        servedBy: [...new Set(runs.map((r) => r.served_by).filter(Boolean))].join(', ') }
      stale.value = false
    } else {
      result.value = null
      const failed = answers.find((a) => a.state !== 'miss')
      error.value = failed ? failed.error : 'No results. Loosen a filter and search again.'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function create() {
  const name = (Object.values(result.value.body).find((v) => typeof v === 'string') || props.source.label)
    .replace(/[a-z]+:\/\/(www\.)?/gi, '').replace(/\/(?=[\s,]|$)/g, '')
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
        <label v-for="f in source.fields" :key="f.name" class="oe-field">
          <span>{{ f.label }}</span>
          <input v-model="values[f.name]" :placeholder="f.placeholder" />
        </label>
        <label v-if="!source.noLimit" class="oe-field">
          <span>Number of results</span>
          <input v-model.number="limit" type="number" min="1" max="100" />
        </label>
        <button class="primary wide" :disabled="busy || !Object.keys(filled).length">
          {{ busy ? 'Searching…' : result && !stale ? 'Search again' : 'Search' }}
        </button>
        <p v-if="price" class="muted small center">One search<template v-if="source.fields.some((f) => f.multi)"> per domain (up to {{ MAX_SEEDS }})</template> costs {{ price }}. No results, no charge.</p>
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
      <p v-if="error" class="oe-banner">{{ error }}</p>
      <div class="oe-grid-wrap">
        <table class="oe-grid ui-table">
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
