<script setup>
// openenrich (docs/context/architecture/tables.md): the team's tables. Lives at /openenrich and
// /openenrich/<table>; the dashboard's session is the only credential.
import { onMounted, onUnmounted, provide, ref } from 'vue'
import { useDashboard } from '../state/context'
import { loadTable, makeClient } from './client.js'
import { JEV_TOOL, SOURCES, applyTypeAnswers, detectColumns, parseCsv, readAnswer, rowId, typeQuestion, uniqueColumnId } from './jobs.js'
import SourceForm from './SourceForm.vue'
import { icon } from './icons.js'
import TableView from './TableView.vue'
import './style.css'

const dash = useDashboard()
const api = makeClient(() => dash.headers())
provide('oeApi', api)

const tables = ref([])
const source = ref(null)        // the source form being filled
const table = ref(null)         // the open table
const loading = ref(false)
const error = ref('')
const csvInput = ref(null)

// a run spends the team's balance: the dashboard header shows it, so refresh that
const refreshAccount = () => dash.loadBilling?.()

const nameFromPath = () => (/^\/openenrich\/([a-z0-9][a-z0-9-]{0,79})\/?$/.exec(location.pathname) || [])[1] || null

async function open(name, fromPop = false) {
  loading.value = true
  error.value = ''
  try {
    table.value = await loadTable(api, name)
    source.value = null
    if (!fromPop) history.pushState({ view: 'openenrich', oe: name }, '', `/openenrich/${name}`)
  } catch (e) {
    error.value = e.status === 404 ? `No table named “${name}” in this team.` : e.message
    table.value = null
  } finally {
    loading.value = false
  }
}

async function home(fromPop = false) {
  table.value = null
  source.value = null
  error.value = ''
  if (!fromPop) history.pushState({ view: 'openenrich' }, '', '/openenrich')
  try { tables.value = await api.tables() } catch (e) { error.value = e.status === 404 ? 'openenrich is not turned on for this team yet.' : e.message }
  refreshAccount()
}

async function created(t) {
  try {
    const stored = await api.create({ name: t.name, kind: t.kind, columns: t.columns, source: t.source || null,
      rows: t.rows.map((r) => ({ id: r.id, cells: r.cells })) })
    await open(stored.name)
  } catch (e) {
    error.value = e.message
  }
}

async function removeTable(t) {
  if (!confirm(`Delete the table “${t.name}” and its ${t.rows} rows? This cannot be undone.`)) return
  await api.remove(t.name)
  tables.value = tables.value.filter((x) => x.name !== t.name)
}

async function importCsv(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const [header = [], ...lines] = parseCsv(await file.text())
  const columns = []
  for (const label of header) columns.push({ id: uniqueColumnId(columns, label), label })
  const rows = lines.map((l) => ({ id: rowId(), cells: Object.fromEntries(columns.map((c, i) => [c.id, l[i] ?? ''])) }))
  // what each column holds: from its values, then its header, then one Jev call for the rest
  let typed = detectColumns(columns, rows)
  const ask = typeQuestion(typed, rows)
  if (ask) {
    const res = readAnswer(await api.run(JEV_TOOL, { method: 'POST', body: ask.body }))
    if (res.state === 'hit') typed = applyTypeAnswers(typed, ask.ids, res.rows[0] || {})
  }
  const types = new Set(typed.map((c) => c.type))
  const kind = ['person_name', 'first_name', 'last_name', 'email', 'linkedin_person', 'job_title'].some((t) => types.has(t)) ? 'people' : 'companies'
  await created({ name: file.name.replace(/\.csv$/i, ''), kind, columns: typed, rows })
  e.target.value = ''
}

function fromPath() {
  const name = nameFromPath()
  if (name) open(name, true)
  else home(true)
}

// each way to start, as an icon on a tint
const LOOK = { companies: ['building', '#2563eb'], people: ['users', '#7c3aed'], similar: ['copy', '#d97706'], csv: ['upload', '#059669'] }
const look = (id) => LOOK[id] || ['table', '#64748b']

const ago = (iso) => {
  const s = (Date.now() - new Date(`${iso}Z`).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 129600) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

onMounted(() => {
  fromPath()
  window.addEventListener('popstate', fromPath)
})
onUnmounted(() => window.removeEventListener('popstate', fromPath))
</script>

<template>
  <div class="oe">
    <header v-if="table" class="oe-top">
      <a href="/openenrich" @click.prevent="home()">← All tables</a>
    </header>

    <p v-if="error" class="oe-banner">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <section v-else-if="table" class="oe-main">
      <TableView :key="table.name" :table="table" @open="open" @balance="refreshAccount" />
    </section>

    <section v-else-if="source" class="oe-main full">
      <SourceForm :source="source" @cancel="source = null" @created="created" />
    </section>

    <section v-else class="oe-main narrow">
      <div class="hero">
        <h1>Build a list, enrich every row</h1>
        <p>Start from a search or a CSV, then add columns for emails, phones, company data, signals and AI judgments. Each row is one call, charged only when it finds something.</p>
      </div>
      <div class="sources">
        <button v-for="s in SOURCES" :key="s.id" class="card source" @click="source = s">
          <span class="tile" :style="{ '--tint': look(s.id)[1] }"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(look(s.id)[0])" /></svg></span>
          <span><strong>{{ s.label }}</strong><small>{{ s.hint }}</small></span>
        </button>
        <button class="card source" @click="csvInput.click()">
          <span class="tile" :style="{ '--tint': look('csv')[1] }"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon('upload')" /></svg></span>
          <span><strong>Import CSV</strong><small>Start from a list you already have</small></span>
        </button>
        <input ref="csvInput" type="file" accept=".csv,text/csv" hidden @change="importCsv" />
      </div>

      <div class="section-head"><h2>Your tables</h2><span class="count">{{ tables.length }}</span></div>
      <div v-if="tables.length" class="recent">
        <a v-for="t in tables" :key="t.name" class="card" :href="`/openenrich/${t.name}`" @click.prevent="open(t.name)">
          <span class="tile" :style="{ '--tint': look(t.kind === 'people' ? 'people' : 'companies')[1] }"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(t.kind === 'people' ? 'users' : 'building')" /></svg></span>
          <span>
            <strong>{{ t.name }}</strong>
            <span class="meta">{{ t.rows }} rows · {{ t.columns }} cols · {{ ago(t.updated_at) }}</span>
            <small v-if="t.parent">from {{ t.parent.table }}</small>
          </span>
          <button class="icon del" title="Delete table" @click.prevent.stop="removeTable(t)">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon('trash')" /></svg>
          </button>
        </a>
      </div>
      <p v-else class="empty">No tables yet. Pick a way to start above.</p>
    </section>
  </div>
</template>
