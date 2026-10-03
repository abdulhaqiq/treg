<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from './client.js'
import { COLUMN_JOBS, ROUTE_CAP_USD, autoMap, fillInputs, identityOf, outputsOf, priceOf, satisfies, uniqueColumnId, usd } from './jobs.js'

const props = defineProps({ table: Object })
const emit = defineEmits(['close', 'add'])

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
const results = ref([])
const error = ref('')
const loading = ref(false)

onMounted(() => {
  for (const j of COLUMN_JOBS) api.tool(j.tool).then((t) => (tools[j.tool] = t)).catch(() => {})
})

const tool = computed(() => (job.value ? tools[job.value.tool] : null))
const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const out = {}
  for (const j of COLUMN_JOBS) if (!q || j.label.toLowerCase().includes(q)) (out[j.group] ||= []).push(j)
  return out
})
const fromPrice = (id) => {
  const p = priceOf(tools[id])
  return p.known ? `from ${usd(p.min * 1e6)}` : ''
}

async function pick(j) {
  job.value = j
  error.value = ''
  loading.value = true
  for (const k of Object.keys(mapping)) delete mapping[k]
  for (const k of Object.keys(custom)) delete custom[k]
  try {
    tools[j.tool] ||= await api.tool(j.tool)
    const t = tools[j.tool]
    if (t?.endpoint?.kind === 'routed') identity.value = identityOf(t)
    else {
      const input = t?.endpoint?.input || {}
      const params = { ...input.pathParams, ...input.queryParams, ...(input.body && typeof input.body === 'object' ? input.body : {}) }
      identity.value = [Object.keys(params).filter((k) => params[k]?.required)]
      for (const k of Object.keys(params)) mapping[k] = ''
    }
    if (j.linked) mapping.company_domain = autoMap([['company_domain']], props.table.columns, props.table.kind).company_domain || ''
    else {
      for (const k of identity.value.flat()) mapping[k] ||= ''
      Object.assign(mapping, autoMap(identity.value.length ? identity.value : [Object.keys(mapping)], props.table.columns, props.table.kind))
      const preview = await api.columns(j.tool)
      outputs.value = (preview?.columns || outputsOf(t)).filter((c) => c !== 'served_by')
      keep.value = j.keep ? j.keep.filter((c) => outputs.value.includes(c)) : outputs.value.slice(0, 3)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function searchCatalog() {
  results.value = query.value.trim() ? ((await api.search(query.value.trim())).results || []).slice(0, 8) : []
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
const ready = computed(() => props.table.rows.filter((r) => satisfies(needs.value, fillInputs(inputs.value, r))).length)
const price = computed(() => priceOf(tool.value, Object.keys(inputs.value)))
const canRun = computed(() => ready.value && (job.value?.linked || keep.value.length))

function add(rows) {
  const group = `g${Date.now().toString(36)}`
  const maxCost = tool.value?.endpoint?.kind === 'routed' ? ROUTE_CAP_USD : undefined
  const base = { group, tool: job.value.tool, method: method.value, inputs: { ...inputs.value }, needs: needs.value, maxCost }
  if (job.value.linked) {
    const id = uniqueColumnId(props.table.columns, 'people')
    return emit('add', { rows, columns: [{ id, label: 'People', job: { ...base, linked: true, limit: Number(peopleLimit.value) || 3 } }] })
  }
  const columns = []
  for (const field of keep.value) {
    columns.push({ id: uniqueColumnId([...props.table.columns, ...columns], field), label: field, job: { ...base, field } })
  }
  emit('add', { rows, columns })
}
</script>

<template>
  <aside class="side">
    <template v-if="!job">
      <header class="side-head">
        <strong>Add enrichment</strong>
        <button class="icon" title="Close" @click="emit('close')">✕</button>
      </header>
      <form class="side-search" @submit.prevent="searchCatalog">
        <input v-model="query" placeholder="Search enrichments… (Enter searches every tool)" autofocus />
      </form>
      <div class="side-body">
        <section v-for="(list, name) in groups" :key="name">
          <h4>{{ name }}</h4>
          <button v-for="j in list" :key="j.id" class="enrich" @click="pick(j)">
            <span class="badge">{{ j.label[0] }}</span>
            <span class="enrich-text"><strong>{{ j.label }}</strong><small v-if="j.note">{{ j.note }}</small></span>
            <span class="price">{{ fromPrice(j.tool) }}</span>
          </button>
        </section>
        <section v-if="results.length">
          <h4>Every tool</h4>
          <button v-for="r in results" :key="r.id" class="enrich" @click="pick({ id: 'any', tool: r.id, label: r.name })">
            <span class="badge alt">{{ (r.provider_display || r.provider || '?')[0] }}</span>
            <span class="enrich-text"><strong>{{ r.name }}</strong><small>{{ r.provider_display || r.provider }}</small></span>
            <span class="price">{{ r.cost?.usd != null ? usd(r.cost.usd * 1e6) : '' }}</span>
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
        <p v-if="job.note" class="muted small">{{ job.note }}.</p>

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
          <div class="chips">
            <label v-for="o in outputs" :key="o" :class="['chip', { on: keep.includes(o) }]">
              <input v-model="keep" type="checkbox" :value="o" hidden />{{ o }}
            </label>
          </div>
        </template>
        <p v-if="error" class="banner">{{ error }}</p>
      </div>

      <footer v-if="!loading" class="side-foot">
        <p class="small">
          <strong>{{ ready }}</strong> of {{ table.rows.length }} rows have the inputs.
          <template v-if="price.known">
            From {{ usd(price.min * 1e6) }} a row<template v-if="price.cap">, never over {{ usd(price.cap * 1e6) }}</template>.
            <template v-if="tool?.endpoint?.cost?.type === 'per_success'">No result, no charge.</template>
          </template>
        </p>
        <button class="primary wide" :disabled="!canRun" @click="add(10)">Save and run {{ Math.min(10, ready) }} rows</button>
        <button class="ghost wide" :disabled="!canRun" @click="add('all')">Save and run all {{ ready }} rows</button>
      </footer>
    </template>
  </aside>
</template>
