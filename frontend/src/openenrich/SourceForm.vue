<script setup>
// A search that becomes a table: a filter builder on the left (suggested chips, one card per filter,
// "Add filter" with every filter the search takes), the preview on the right. "Create table" keeps
// the previewed rows; it does not search again.
import { computed, inject, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { FIXED, MAX_SEEDS, ROUTE_CAP_USD, filterBody, listRecords, priceOf, readAnswer, tableFromRows, usd, usesStrict } from './jobs.js'
import { icon } from './icons.js'
import ValuePicker from './ValuePicker.vue'

const props = defineProps({ source: Object })
const emit = defineEmits(['cancel', 'created'])
const api = inject('oeApi')

const filters = props.source.filters
const byName = Object.fromEntries(filters.map((f) => [f.name, f]))
const empty = (f) => (f.type === 'range' ? { min: '', max: '' } : f.type === 'text' || f.type === 'number' ? '' : [])
const values = reactive(Object.fromEntries(filters.map((f) => [f.name, empty(f)])))
const active = ref(filters.filter((f) => f.open).map((f) => f.name))
const conditions = reactive(Object.fromEntries(filters.filter((f) => f.ops).map((f) => [f.name, f.ops[0].id])))  // filter -> its condition (ops)
const picker = ref(false)
const pickQuery = ref('')
const limit = ref(25)
const tool = ref(null)
const result = ref(null)           // {rows, ids, body, cost, servedBy, page, pageCost, done} of the last search
const stale = ref(false)
const busy = ref(false)
const error = ref('')

onMounted(() => api.tool(props.source.tool).then((t) => (tool.value = t)).catch(() => {}))

const look = { companies: ['building', '#2563eb'], people: ['users', '#7c3aed'], similar: ['copy', '#d97706'] }[props.source.id] || ['search', '#64748b']
const suggested = computed(() => filters.filter((f) => f.suggested && !active.value.includes(f.name)))
const pickable = computed(() => {
  const q = pickQuery.value.trim().toLowerCase()
  const left = filters.filter((f) => !active.value.includes(f.name) && (!q || `${f.label} ${f.group}`.toLowerCase().includes(q)))
  const groups = {}
  for (const f of left) (groups[f.suggested && !q ? 'Popular' : f.group] ||= []).push(f)
  return Object.entries(groups)
})
const op = (f) => (f.type === 'range' ? 'between' : f.type === 'number' ? 'at most' : f.ops?.length === 1 ? f.ops[0].label : 'is')
const picked = (f, o) => values[f.name].some((x) => JSON.stringify(x.value) === JSON.stringify(o.value))
function togglePick(f, o) {
  values[f.name] = picked(f, o) ? values[f.name].filter((x) => JSON.stringify(x.value) !== JSON.stringify(o.value)) : [...values[f.name], o]
}

async function addFilter(name) {
  if (!active.value.includes(name)) active.value.push(name)
  picker.value = false
  pickQuery.value = ''
  await nextTick()
  document.getElementById(`oe-f-${name}`)?.focus()
}
// a value picked in one filter that belongs to another: that filter's card, with the value in it
function addTo(name, item) {
  if (!active.value.includes(name)) active.value.push(name)
  if (!values[name].some((x) => x.label === item.label)) values[name] = [...values[name], item]
}
function removeFilter(name) {
  active.value = active.value.filter((n) => n !== name)
  values[name] = empty(byName[name])
}
const body = computed(() => filterBody(filters.filter((f) => active.value.includes(f.name)), values, conditions))
const canSearch = computed(() => Object.keys(body.value).some((k) => (props.source.identity || []).includes(k)))
const price = computed(() => {
  const p = priceOf(tool.value, Object.keys(body.value))
  return p.known ? `${usd(p.min * 1e6)}–${usd(p.max * 1e6)}` : ''
})
const columns = computed(() => result.value?.ids || FIXED[props.source.kind])
watch([values, limit, active, conditions], () => { if (result.value) stale.value = true }, { deep: true })

async function search() {
  busy.value = true
  error.value = ''
  try {
    const b = { ...body.value, ...(props.source.noLimit ? {} : { limit: Number(limit.value) || 25 }) }
    // a `split` filter (lookalikes): one search per value, merged, the seeds themselves left out
    const multi = filters.find((f) => f.split && b[f.name])
    const seeds = multi ? b[multi.name].slice(0, MAX_SEEDS) : []
    const bodies = multi ? seeds.map((v) => ({ ...b, [multi.name]: v })) : [b]
    const strict = usesStrict(props.source, b)
    const runs = await Promise.all(bodies.map((x) => api.run(props.source.tool,
      { method: 'POST', body: x, maxCost: ROUTE_CAP_USD, exclude: props.source.exclude, fresh: true, strict })))
    const answers = runs.map(readAnswer)
    const hits = answers.filter((a) => a.state === 'hit')
    if (hits.length) {
      const own = new Set(seeds.map((v) => v.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split('/')[0]))
      const rows = hits.flatMap((a) => a.rows).filter((r) => !own.has(String(r.domain || '').toLowerCase()))
      const { records, ids } = listRecords(props.source.kind, rows, [...new Set(hits.flatMap((a) => a.columns))], b.limit)
      const cost = runs.reduce((n, r) => n + (r.cost_micro || 0), 0)
      result.value = { rows: records, ids, body: b, cost, servedBy: [...new Set(runs.map((r) => r.served_by).filter(Boolean))].join(', '),
        page: 1, pageCost: cost, done: multi || props.source.noLimit || records.length < (b.limit || 0) }
      stale.value = false
    } else {
      result.value = null
      const failed = answers.find((a) => a.state !== 'miss')
      error.value = failed ? failed.error : 'No results. Remove a filter and search again.'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

// The next page comes from the provider that served the first, so the list continues instead of
// starting over somewhere else: every other provider is excluded, and strict skips that one too
// when it cannot page, which answers no_route_candidate for nothing and ends the list.
const keyOf = (r) => String(r.domain || r.linkedin_url || r.full_name || r.name || '').toLowerCase()
const loadingMore = ref(false)
async function loadMore() {
  const res = result.value
  loadingMore.value = true
  error.value = ''
  try {
    const page = res.page + 1
    const mine = res.servedBy.split('.')[0]
    const others = [...new Set((tool.value?.endpoint?.routed_children || []).map((id) => id.split('.')[0]))].filter((p) => p !== mine)
    const r = await api.run(props.source.tool, { method: 'POST', body: { ...res.body, page }, maxCost: ROUTE_CAP_USD,
      exclude: [...(props.source.exclude || []), ...others], fresh: true, strict: true })
    const a = readAnswer(r)
    res.cost += r.cost_micro || 0
    if (a.state !== 'hit') {
      res.done = true
      if (r.status === 422) error.value = `${mine} cannot fetch a next page. Search again with a larger number of results instead.`
      else if (a.state === 'error') error.value = a.error
      return
    }
    const { records, ids } = listRecords(props.source.kind, a.rows, a.columns)
    const seen = new Set(res.rows.map(keyOf))
    const fresh = records.filter((x) => !seen.has(keyOf(x)))
    res.repeats = (res.repeats || 0) + records.length - fresh.length
    res.rows.push(...fresh)
    res.ids = [...new Set([...res.ids, ...ids])]
    res.page = page
    res.pageCost = r.cost_micro || 0
    if (!fresh.length || records.length < (res.body.limit || 0)) res.done = true
  } finally {
    loadingMore.value = false
  }
}

function create() {
  const first = Object.values(result.value.body).flat().find((v) => typeof v === 'string') || props.source.label
  const name = first.replace(/[a-z]+:\/\/(www\.)?/gi, '').replace(/\/(?=[\s,]|$)/g, '')
  emit('created', tableFromRows(name, props.source.kind, result.value.rows, columns.value,
    { source: { tool: props.source.tool, body: result.value.body } }))
}
</script>

<template>
  <div class="finder">
    <aside class="filters">
      <button class="ghost back" @click="emit('cancel')">← Back</button>
      <div class="finder-head">
        <span class="tile" :style="{ '--tint': look[1] }"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(look[0])" /></svg></span>
        <div><h1>{{ source.label }}</h1><p class="muted small">{{ source.hint }}</p></div>
      </div>

      <form class="fb" @submit.prevent="search">
        <div v-if="suggested.length" class="sugg">
          <span class="fb-label">Suggested</span>
          <div class="fchips">
            <button v-for="f in suggested" :key="f.name" type="button" class="fchip" @click="addFilter(f.name)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(f.icon)" /></svg>{{ f.label }}
            </button>
          </div>
        </div>

        <div v-for="name in active" :key="name" class="fcard">
          <header>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(byName[name].icon)" /></svg>
            <strong>{{ byName[name].label }}</strong>
            <select v-if="byName[name].ops?.length > 1" v-model="conditions[name]" class="op-select">
              <option v-for="o in byName[name].ops" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
            <span v-else class="op">{{ op(byName[name]) }}</span>
            <button type="button" class="icon" title="Remove filter" @click="removeFilter(name)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path :d="icon('x')" /></svg>
            </button>
          </header>
          <input v-if="byName[name].type === 'text'" :id="`oe-f-${name}`" v-model="values[name]" :placeholder="byName[name].placeholder" />
          <input v-else-if="byName[name].type === 'number'" :id="`oe-f-${name}`" v-model="values[name]" type="number" min="1" :placeholder="byName[name].placeholder" />
          <div v-else-if="byName[name].type === 'pick'" class="opts">
            <button v-for="o in byName[name].options" :key="o.value" type="button" :class="['opt', { on: picked(byName[name], o) }]"
                    @click="togglePick(byName[name], o)">{{ o.label }}</button>
          </div>
          <div v-else-if="byName[name].type === 'range'" class="range">
            <input :id="`oe-f-${name}`" v-model="values[name].min" type="number" min="0" :placeholder="byName[name].placeholders?.[0] || 'min'" />
            <span class="muted">to</span>
            <input v-model="values[name].max" type="number" min="0" :placeholder="byName[name].placeholders?.[1] || 'max'" />
          </div>
          <ValuePicker v-else v-model="values[name]" :filter="byName[name]" :input-id="`oe-f-${name}`" @elsewhere="addTo" />
          <small v-if="byName[name].note" class="muted">{{ byName[name].note }}</small>
        </div>

        <div class="add-wrap">
          <button v-if="pickable.length" type="button" class="add-filter" @click="picker = !picker">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path :d="icon('plus')" /></svg>
            Add filter
          </button>
          <div v-if="picker" class="picker" @keydown.esc="picker = false">
            <input v-model="pickQuery" placeholder="Search filters" autofocus />
            <div class="picker-body">
              <section v-for="[group, list] in pickable" :key="group">
                <h4>{{ group }}</h4>
                <button v-for="f in list" :key="f.name" type="button" class="pick" @click="addFilter(f.name)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(f.icon)" /></svg>
                  <span>{{ f.label }}</span><small>{{ f.group }}</small>
                </button>
              </section>
            </div>
          </div>
        </div>

        <label v-if="!source.noLimit" class="oe-field">
          <span>Number of results</span>
          <input v-model.number="limit" type="number" min="1" max="100" />
        </label>

        <div class="fb-foot">
          <button class="primary wide" :disabled="busy || !canSearch">
            {{ busy ? 'Searching…' : result && !stale ? 'Search again' : 'Search' }}
          </button>
          <p v-if="Object.keys(body).length && !canSearch" class="muted small center">Add a title, department, industry, location, keyword or technology to search on.</p>
          <p v-if="price" class="muted small center">
            One search<template v-if="filters.some((f) => f.split)"> per domain (up to {{ MAX_SEEDS }})</template> costs {{ price }}. No results, no charge.
          </p>
        </div>
      </form>
    </aside>

    <section class="results">
      <header class="results-bar">
        <template v-if="result">
          <strong>Preview</strong>
          <span class="muted">· {{ result.rows.length }} {{ source.kind }} · {{ usd(result.cost || 0) }} via {{ result.servedBy }}</span>
          <span v-if="result.repeats" class="muted small" title="The provider sent rows already in the list on a later page; they are left out, but it bills every row it sends">· {{ result.repeats }} {{ result.repeats === 1 ? 'repeat' : 'repeats' }} dropped</span>
          <span v-if="stale" class="muted small">· filters changed, search again to update</span>
        </template>
        <span v-else class="muted">Add filters and search to preview results.</span>
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
      <div v-if="result && !result.done && !stale && tool?.endpoint?.routed_children" class="more">
        <button :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? 'Loading…' : `Load ${result.body.limit} more` }}
          <span v-if="!loadingMore" class="muted"> · about {{ usd(result.pageCost) }}, from {{ result.servedBy.split('.')[0] }}</span>
        </button>
      </div>
    </section>
  </div>
</template>
