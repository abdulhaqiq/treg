<script setup>
// openenrich (docs/context/architecture/tables.md): the team's tables. Lives at /openenrich and
// /openenrich/<table>; the dashboard's session is the only credential.
import { onMounted, onUnmounted, provide, ref } from 'vue'
import { useDashboard } from '../state/context'
import { loadTable, makeClient } from './client.js'
import { JEV_TOOL, SOURCES, applyTypeAnswers, detectColumns, parseCsv, readAnswer, rowId, typeQuestion, uniqueColumnId } from './jobs.js'
import SourceForm from './SourceForm.vue'
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
    <header :class="['oe-top', { narrow: !table && !source }]">
      <a class="brand" href="/openenrich" @click.prevent="home()">openenrich</a>
      <span v-if="table" class="crumb">/ {{ table.name }}</span>
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
      <h1>What list do you want?</h1>
      <div class="sources">
        <button v-for="s in SOURCES" :key="s.id" class="source" @click="source = s">
          <strong>{{ s.label }}</strong><span>{{ s.hint }}</span>
        </button>
        <button class="source" @click="csvInput.click()">
          <strong>Import CSV</strong><span>Start from a list you already have</span>
        </button>
        <input ref="csvInput" type="file" accept=".csv,text/csv" hidden @change="importCsv" />
      </div>
      <template v-if="tables.length">
        <h2>Your team's tables</h2>
        <ul class="recent">
          <li v-for="t in tables" :key="t.name">
            <a :href="`/openenrich/${t.name}`" @click.prevent="open(t.name)">
              <strong>{{ t.name }}</strong>
              <span class="muted small">{{ t.rows }} rows · {{ t.columns }} columns<template v-if="t.parent"> · from {{ t.parent.table }}</template> · {{ ago(t.updated_at) }}</span>
            </a>
            <button class="icon" title="Delete table" @click="removeTable(t)">✕</button>
          </li>
        </ul>
      </template>
    </section>
  </div>
</template>
