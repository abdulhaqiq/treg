<script setup>
import { computed, inject, onMounted, reactive, ref } from 'vue'
import { iconFor } from './icons.js'
import { CATEGORY_ORDER, COLUMN_JOBS, ENRICH_SHELVES, ROUTE_CAP_USD, SETTING_PARAMS, SIGNAL_EXTRAS, autoMap, enrichmentJobs, paramsOf, settingDefault, pickColumns, readAnswer, signalShelf, fillInputs, identityOf, outputsOf, priceOf, satisfies, uniqueColumnId, usd } from './jobs.js'

const props = defineProps({ table: Object })
const emit = defineEmits(['close', 'add'])
const api = inject('oeApi')

const tools = reactive({})     // tool id -> /catalog/endpoints answer, for prices and inputs
const job = ref(null)          // a COLUMN_JOBS entry, or {id:'any', tool, label} from the catalog
const identity = ref([])
const mapping = reactive({})   // input -> '{column}' or literal text
const custom = reactive({})    // inputs set to "type a value"
const outputs = ref([])
const keep = ref([])
const peopleTitle = ref('')
const peopleLimit = ref(3)
const query = ref('')
const error = ref('')
const loading = ref(false)
const contract = ref(false)    // outputs come from a fixed contract, not a guess from an example
const test = ref(null)         // {values, cost, row} after "Test on row 1"
const testing = ref(false)

const routed = ref([])         // every people and company enrichment, from the catalog shelves

onMounted(async () => {
  for (const j of COLUMN_JOBS) api.tool(j.tool).then((t) => (tools[j.tool] = t)).catch(() => {})
  try {
    const extraPlatforms = [...new Set(SIGNAL_EXTRAS.map((c) => c.split('.')[0]))]
    const [best, ...shelves] = await Promise.all([api.search('treg', 100),
      ...[...ENRICH_SHELVES.map(([slug]) => slug), ...extraPlatforms].map((slug) => api.platform(slug).catch(() => null))])
    const byId = new Map((best.results || []).filter((r) => r.id.startsWith('treg.')).map((r) => [r.id, r]))
    const own = ENRICH_SHELVES.map(([, group], i) => [group, shelves[i]])
    routed.value = enrichmentJobs([...own, ['Signals', signalShelf(shelves.slice(ENRICH_SHELVES.length))]], byId)
  } catch {}
})

const tool = computed(() => (job.value ? tools[job.value.tool] : null))
const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const match = (j) => !q || [j.label, j.tool, j.note || '', j.about || ''].some((s) => s.toLowerCase().includes(q))
  const out = {}
  for (const j of COLUMN_JOBS) if (match(j)) (out.Popular ||= []).push(j)
  for (const j of routed.value) if (match(j)) (out[j.group] ||= []).push(j)
  return Object.fromEntries(CATEGORY_ORDER.filter((g) => out[g]).map((g) => [g, out[g]]))
})
// one provider: its logo; several (a treg route, or a capability with a provider picker): a stack
// icon. The popular jobs are all treg routes.
const logosOf = (j) => j.logos || ['', '']
const badLogo = reactive({})

const fromPrice = (j) => {
  const p = priceOf(tools[j.tool])
  const min = p.known ? p.min : j.price
  return min != null ? `from ${usd(min * 1e6)}` : ''
}



async function pick(j) {
  job.value = j
  error.value = ''
  loading.value = true
  for (const k of Object.keys(mapping)) delete mapping[k]
  for (const k of Object.keys(custom)) delete custom[k]
  test.value = null
  try {
    tools[j.tool] ||= await api.tool(j.tool)
    const t = tools[j.tool]
    if (t?.endpoint?.kind === 'routed') identity.value = identityOf(t)
    else {
      const params = paramsOf(t?.endpoint)
      identity.value = [Object.keys(params).filter((k) => params[k]?.required && !SETTING_PARAMS.has(k))]
      for (const k of Object.keys(params)) mapping[k] = ''
      for (const k of Object.keys(params)) {
        const value = settingDefault(t?.endpoint, k)
        if (value !== undefined) { mapping[k] = value; custom[k] = true }
      }
    }
    if (j.linked) mapping.company_domain = autoMap([['company_domain']], props.table.columns, props.table.kind).company_domain || ''
    else {
      for (const k of identity.value.flat()) mapping[k] ||= ''
      // routed: the contract's identity; a single provider: every input it takes, optional ones too
      const mappable = t?.endpoint?.kind === 'routed' ? identity.value : [Object.keys(mapping).filter((k) => !custom[k])]
      Object.assign(mapping, autoMap(mappable, props.table.columns, props.table.kind))
      // "Provide exactly one company identifier": keep only the first input a column filled
      if (/exactly one/i.test(t?.endpoint?.input?.note || '')) {
        const filled = Object.keys(mapping).filter((k) => mapping[k] && !custom[k])
        for (const k of filled.slice(1)) mapping[k] = ''
      }
      const preview = await api.columns(j.tool)
      // a routed list job's rows are each provider's own objects: only a flat contract is fixed
      contract.value = preview?.column_source === 'contract' && preview?.shape === 'flat'
      outputs.value = (preview?.columns || outputsOf(t)).filter((c) => c !== 'served_by')
      keep.value = j.keep ? j.keep.filter((c) => outputs.value.includes(c)) : outputs.value.slice(0, 3)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}


function setSource(input, value) {
  if (value === '__text') { custom[input] = true; mapping[input] = '' } else { delete custom[input]; mapping[input] = value }
}

const method = computed(() => (tool.value?.endpoint?.kind === 'routed' ? 'POST' : tool.value?.endpoint?.method || 'GET'))
const needs = computed(() => (job.value?.linked ? [['company_domain']] : identity.value.filter((a) => a.length)))
const inputs = computed(() => {
  const m = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v))
  if (job.value?.linked && peopleTitle.value) m.title = peopleTitle.value
  return m
})
// a row is ready when it has what the tool needs, and at least one input from the row itself
const fromRow = computed(() => Object.fromEntries(Object.entries(inputs.value).filter(([k]) => !custom[k] || /\{/.test(inputs.value[k]))))
const ready = computed(() => props.table.rows.filter((r) => {
  const filled = fillInputs(inputs.value, r)
  return Object.keys(fillInputs(fromRow.value, r)).length && satisfies(needs.value, filled)
}).length)
const price = computed(() => priceOf(tool.value, Object.keys(inputs.value)))
const needsTest = computed(() => !job.value?.linked && !contract.value && !test.value)
const canRun = computed(() => ready.value && (job.value?.linked || keep.value.length) && !needsTest.value)

// Run the first ready row once and take the columns from the real answer. The run replays that
// row from treg for nothing (same inputs, same Idempotency-Key).
async function testRow() {
  const row = props.table.rows.find((r) => Object.keys(fillInputs(fromRow.value, r)).length && satisfies(needs.value, fillInputs(inputs.value, r)))
  if (!row) return
  testing.value = true
  error.value = ''
  try {
    const filled = fillInputs(inputs.value, row)
    const req = method.value === 'GET' ? { method: 'GET', query: filled } : { method: method.value, body: filled }
    const r = await api.run(job.value.tool, req)
    const a = readAnswer(r)
    if (a.state !== 'hit') {
      error.value = a.state === 'miss' ? 'No result on that row. Try another tool or check the inputs.' : a.error
      return
    }
    const picked = pickColumns(a.rows, job.value.keep || [])
    outputs.value = picked.columns
    keep.value = picked.keep
    test.value = { cost: r.cost_micro, row: props.table.rows.indexOf(row) + 1,
      values: Object.fromEntries(picked.columns.map((c) => [c, String(a.rows.map((x) => x[c]).find((v) => v != null && v !== '') ?? '')])) }
  } finally {
    testing.value = false
  }
}

function add(rows) {
  const group = `g${Date.now().toString(36)}`
  const maxCost = tool.value?.endpoint?.kind === 'routed' ? ROUTE_CAP_USD : undefined
  const base = { group, tool: job.value.tool, method: method.value, inputs: { ...inputs.value }, needs: needs.value, maxCost }
  if (job.value.linked) {
    // people searches can bill per person returned: the cap scales with the count asked for
    const limit = Number(peopleLimit.value) || 3
    const id = uniqueColumnId(props.table.columns, 'people')
    return emit('add', { rows, columns: [{ id, label: 'People', job: { ...base, maxCost: ROUTE_CAP_USD * limit, linked: true, limit } }] })
  }
  const columns = []
  for (const field of keep.value) {
    columns.push({ id: uniqueColumnId([...props.table.columns, ...columns], field), label: field, job: { ...base, field } })
  }
  emit('add', { rows, columns })
}
</script>

<template>
  <aside class="oe-side">
    <template v-if="!job">
      <header class="side-head">
        <strong>Add enrichment</strong>
        <button class="icon" title="Close" @click="emit('close')">✕</button>
      </header>
      <form class="side-search" @submit.prevent>
        <input v-model="query" :placeholder="`Search ${COLUMN_JOBS.length + routed.length} enrichments and signals…`" autofocus />
      </form>
      <div class="side-body">
        <section v-for="(list, name) in groups" :key="name">
          <h4>{{ name }}</h4>
          <button v-for="j in list" :key="j.id" class="enrich" :title="j.about || j.note || j.label" @click="pick(j)">
            <span v-if="logosOf(j).length === 1 && !badLogo[j.id]" class="oe-badge logo">
              <img :src="`/logos/${logosOf(j)[0]}.svg`" alt="" @error="badLogo[j.id] = true" />
            </span>
            <span v-else-if="logosOf(j).length > 1" class="oe-badge" :title="`${logosOf(j).filter(Boolean).length || 'Several'} providers`">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"
                   stroke-linecap="round" stroke-linejoin="round"><path :d="iconFor(j.cap || j.tool)" /></svg>
            </span>
            <span v-else class="oe-badge">{{ j.label[0] }}</span>
            <span class="enrich-text"><strong>{{ j.label }}</strong><small v-if="j.note">{{ j.note }}</small></span>
            <span class="price">{{ fromPrice(j) }}</span>
          </button>
        </section>
      </div>
    </template>

    <template v-else>
      <header class="side-head">
        <button class="icon" title="Back" @click="job = null">←</button>
        <strong>{{ job.label }}</strong>
        <button class="icon" title="Close" @click="emit('close')">✕</button>
      </header>
      <div v-if="loading" class="side-body"><p class="muted">Loading…</p></div>
      <div v-else class="side-body">
        <p v-if="job.about || job.note" class="muted small">{{ job.about || job.note }}.</p>

        <template v-if="job.providers?.length > 1">
          <h4>Provider</h4>
          <select :value="job.tool" @change="pick({ ...job, tool: $event.target.value })">
            <option v-for="p in job.providers" :key="p.id" :value="p.id">
              {{ p.name }}<template v-if="job.providers.filter((x) => x.name === p.name).length > 1"> · {{ p.endpoint }}</template>
              <template v-if="p.price != null"> · {{ usd(p.price * 1e6) }}</template>
            </option>
          </select>
        </template>

        <h4>Inputs</h4>
        <div v-for="(v, k) in mapping" :key="k" class="input-row">
          <span class="input-name">{{ k.replace(/_/g, ' ') }}</span>
          <div class="input-src">
            <select :value="custom[k] ? '__text' : v" @change="setSource(k, $event.target.value)">
              <option value="">Not used</option>
              <option v-for="c in table.columns" :key="c.id" :value="`{${c.id}}`">/ {{ c.label }}</option>
              <option value="__text">Type a value…</option>
            </select>
            <input v-if="custom[k]" v-model="mapping[k]" placeholder="value" />
          </div>
        </div>
        <template v-if="job.linked">
          <div class="input-row">
            <span class="input-name">job title</span>
            <div class="input-src"><input v-model="peopleTitle" placeholder="founder, head of growth…" /></div>
          </div>
          <div class="input-row">
            <span class="input-name">people per company</span>
            <div class="input-src"><input v-model.number="peopleLimit" type="number" min="1" max="25" /></div>
          </div>
        </template>
        <p v-if="needs.length && !job.linked" class="muted small">Needs {{ needs.map((a) => a.join(' + ').replace(/_/g, ' ')).join(', or ') }}.</p>

        <template v-if="!job.linked">
          <h4>Columns to add</h4>
          <p v-if="needsTest" class="muted small">This tool's answer varies, so test it on one row to see the real columns.</p>
          <p v-else-if="test" class="muted small">From row {{ test.row }} ({{ usd(test.cost || 0) }}); running it again later is free.</p>
          <div v-if="!needsTest" class="chips">
            <label v-for="o in outputs" :key="o" :class="['oe-chip', { on: keep.includes(o) }]" :title="test?.values[o] || ''">
              <input v-model="keep" type="checkbox" :value="o" hidden />{{ o }}
            </label>
          </div>
        </template>
        <p v-if="error" class="oe-banner">{{ error }}</p>
      </div>

      <footer v-if="!loading" class="side-foot">
        <p class="small">
          <strong>{{ ready }}</strong> of {{ table.rows.length }} rows have the inputs.
          <template v-if="price.known">
            From {{ usd(price.min * 1e6) }} a row<template v-if="price.cap">, never over {{ usd(price.cap * (job.linked ? Number(peopleLimit) || 1 : 1) * 1e6) }}</template>.
            <template v-if="tool?.endpoint?.cost?.type === 'per_success'">No result, no charge.</template>
          </template>
        </p>
        <button v-if="needsTest" class="primary wide" :disabled="!ready || testing" @click="testRow">
          {{ testing ? 'Testing…' : 'Test on 1 row' }}</button>
        <button v-else class="primary wide" :disabled="!canRun" @click="add(10)">Save and run {{ Math.min(10, ready) }} rows</button>
        <button class="ghost wide" :disabled="!canRun" @click="add('all')">Save and run all {{ ready }} rows</button>
      </footer>
    </template>
  </aside>
</template>
