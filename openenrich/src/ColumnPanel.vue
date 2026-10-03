<script setup>
import { computed, reactive, ref } from 'vue'
import { api } from './client.js'
import { COLUMN_JOBS, ROUTE_CAP_USD, autoMap, fillInputs, identityOf, outputsOf, priceOf, satisfies, uniqueColumnId, usd } from './jobs.js'

const props = defineProps({ table: Object })
const emit = defineEmits(['close', 'add'])

const job = ref(null)          // a COLUMN_JOBS entry, or {id:'any', tool, label} from search
const tool = ref(null)
const identity = ref([])
const mapping = reactive({})
const outputs = ref([])
const keep = ref([])
const peopleTitle = ref('')
const peopleLimit = ref(3)
const query = ref('')
const results = ref([])
const error = ref('')
const loading = ref(false)

async function pick(j) {
  job.value = j
  error.value = ''
  loading.value = true
  for (const k of Object.keys(mapping)) delete mapping[k]
  try {
    tool.value = await api.tool(j.tool)
    const routed = tool.value?.endpoint?.kind === 'routed'
    if (routed) identity.value = identityOf(tool.value)
    else {
      const input = tool.value?.endpoint?.input || {}
      const params = { ...input.pathParams, ...input.queryParams, ...(input.body && typeof input.body === 'object' ? input.body : {}) }
      identity.value = [Object.keys(params).filter((k) => params[k]?.required)]
      for (const k of Object.keys(params)) mapping[k] = ''
    }
    if (j.linked) Object.assign(mapping, { company_domain: autoMap([['company_domain']], props.table.columns, props.table.kind).company_domain || '' })
    else Object.assign(mapping, autoMap(identity.value.length ? identity.value : [Object.keys(mapping)], props.table.columns, props.table.kind))
    if (!j.linked) for (const k of identity.value.flat()) if (!(k in mapping)) mapping[k] = ''
    if (!j.linked) {
      const preview = await api.columns(j.tool)
      outputs.value = (preview?.columns || outputsOf(tool.value)).filter((c) => c !== 'served_by')
      keep.value = j.keep ? j.keep.filter((c) => outputs.value.includes(c)) : outputs.value.slice(0, 3)
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

async function search() {
  results.value = query.value.trim() ? (await api.search(query.value.trim())).results || [] : []
}

const method = computed(() => (tool.value?.endpoint?.kind === 'routed' ? 'POST' : tool.value?.endpoint?.method || 'GET'))
const inputs = computed(() => {
  const m = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v))
  if (job.value?.linked) Object.assign(m, peopleTitle.value ? { title: peopleTitle.value } : {})
  return m
})
const ready = computed(() => props.table.rows.filter((r) => satisfies(job.value?.linked ? [['company_domain']] : identity.value.filter((a) => a.length), fillInputs(inputs.value, r))).length)
const estimate = computed(() => {
  const p = priceOf(tool.value, Object.keys(inputs.value))
  if (!p.known) return ''
  const n = Math.min(10, ready.value)
  const misses = tool.value?.endpoint?.cost?.type === 'per_success' ? ' · misses are free' : ''
  const cap = p.cap ? ` · at most ${usd(p.cap * 1e6)} a row` : ''
  return `From ${usd(p.min * 1e6)} a row${misses}${cap}. 10 rows ≤ ${usd(p.max * n * 1e6)}, all ${ready.value} ≤ ${usd(p.max * ready.value * 1e6)}.`
})

function add(rows) {
  const group = `g${Date.now().toString(36)}`
  const needs = job.value.linked ? [['company_domain']] : identity.value.filter((a) => a.length)
  const maxCost = tool.value?.endpoint?.kind === 'routed' ? ROUTE_CAP_USD : undefined
  const base = { group, tool: job.value.tool, method: method.value, inputs: { ...inputs.value }, needs, maxCost }
  if (job.value.linked) {
    const id = uniqueColumnId(props.table.columns, 'people')
    emit('add', { rows, columns: [{ id, label: 'people', job: { ...base, linked: true, limit: Number(peopleLimit.value) || 3 } }] })
    return
  }
  const columns = []
  for (const field of keep.value) {
    columns.push({ id: uniqueColumnId([...props.table.columns, ...columns], field), label: field, job: { ...base, field } })
  }
  emit('add', { rows, columns })
}
</script>

<template>
  <aside class="panel">
    <header>
      <strong>{{ job ? job.label : 'What do you want to know?' }}</strong>
      <button class="ghost" @click="job ? (job = null, tool = null) : emit('close')">{{ job ? 'Back' : 'Close' }}</button>
    </header>

    <template v-if="!job">
      <button v-for="j in COLUMN_JOBS" :key="j.id" class="job" @click="pick(j)">
        {{ j.label }}<small v-if="j.note">{{ j.note }}</small>
      </button>
      <form class="search" @submit.prevent="search">
        <input v-model="query" placeholder="Search all tools… (e.g. company tech stack)" />
      </form>
      <button v-for="r in results" :key="r.id" class="job" @click="pick({ id: 'any', tool: r.id, label: r.name })">
        {{ r.name }}<small>{{ r.id }}<template v-if="r.cost?.usd"> · {{ usd(r.cost.usd * 1e6) }}</template></small>
      </button>
    </template>

    <template v-else-if="loading"><p class="muted">Loading…</p></template>

    <template v-else>
      <p v-if="job.note" class="muted small">{{ job.note }}.</p>
      <h3>Uses</h3>
      <label v-for="(v, k) in mapping" :key="k" class="map">
        <span>{{ k }}</span>
        <input v-model="mapping[k]" placeholder="{column} or text" list="column-names" />
      </label>
      <datalist id="column-names"><option v-for="c in table.columns" :key="c.id" :value="`{${c.id}}`" /></datalist>
      <template v-if="job.linked">
        <label class="map"><span>title</span><input v-model="peopleTitle" placeholder="founder, head of growth…" /></label>
        <label class="map"><span>per company</span><input v-model.number="peopleLimit" type="number" min="1" max="25" /></label>
      </template>
      <p v-if="!job.linked && identity.length && identity[0].length" class="muted small">
        Needs one of: {{ identity.map((a) => a.join(' + ')).join(' · ') }}
      </p>

      <template v-if="!job.linked">
        <h3>Adds</h3>
        <label v-for="o in outputs" :key="o" class="check"><input v-model="keep" type="checkbox" :value="o" /> {{ o }}</label>
      </template>

      <p v-if="error" class="warn">{{ error }}</p>
      <p class="muted small">{{ ready }} of {{ table.rows.length }} rows have the inputs. {{ estimate }}</p>
      <div class="actions">
        <button class="primary" :disabled="!ready || (!job.linked && !keep.length)" @click="add(10)">Run 10 rows</button>
        <button :disabled="!ready || (!job.linked && !keep.length)" @click="add('all')">Run all {{ ready }}</button>
      </div>
    </template>
  </aside>
</template>
