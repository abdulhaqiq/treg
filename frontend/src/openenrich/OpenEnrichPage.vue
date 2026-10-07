<script setup>
// openenrich (docs/context/architecture/tables.md): the team's tables. Lives at /openenrich and
// /openenrich/<table>; the dashboard's session is the only credential.
import { onMounted, onUnmounted, provide, reactive, ref } from 'vue'
import { useDashboard } from '../state/context'
import { loadTable, makeClient } from './client.js'
import { JEV_TOOL, SOURCES, providersOf, applyTypeAnswers, detectColumns, parseCsv, readAnswer, rowId, typeQuestion, uniqueColumnId } from './jobs.js'
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
const fresh = ref(false)        // the open table was just created
const root = ref(null)
const providers = reactive({})  // source id -> provider slugs behind its search

// The page is the window's height below the dashboard header, so only the table scrolls
function fit() {
  if (root.value) root.value.style.height = `${Math.max(480, window.innerHeight - root.value.getBoundingClientRect().top - 16)}px`
}

// a run spends the team's balance: the dashboard header shows it, so refresh that
const refreshAccount = () => dash.loadBilling?.()

const nameFromPath = () => (/^\/openenrich\/([a-z0-9][a-z0-9-]{0,79})\/?$/.exec(location.pathname) || [])[1] || null

async function open(name, fromPop = false, isNew = false) {
  fresh.value = isNew
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
  try {
    tables.value = await api.tables()
    await seed()
  } catch (e) { error.value = e.status === 404 ? 'openenrich is not turned on for this team yet.' : e.message }
  refreshAccount()
}

async function created(t) {
  try {
    const stored = await api.create({ name: t.name, kind: t.kind, columns: t.columns, source: t.source || null,
      rows: t.rows.map((r) => ({ id: r.id, cells: r.cells, ...(r.runs ? { runs: r.runs } : {}) })) })
    await open(stored.name, false, true)
  } catch (e) {
    error.value = e.message
  }
}

// a renamed table opens under its new name, its address replaced (the old one names nothing now)
async function renamed(name) {
  history.replaceState({ view: 'openenrich', oe: name }, '', `/openenrich/${name}`)
  await open(name, true)
}

// A team's first visit finds a few real tables (seeds.js) beside its own, the ones it does not have
// by name yet. Once per team in this browser: a team that deletes them is not given them again.
async function seed() {
  const key = `oe-seeded:${dash.activeSlugNow || 'team'}`
  try { if (localStorage.getItem(key)) return } catch {}
  const { SEEDS } = await import('./seeds.js')
  const have = new Set(tables.value.map((t) => t.name))
  for (const t of SEEDS.filter((x) => !have.has(x.name))) {
    try { await api.create({ name: t.name, kind: t.kind, columns: t.columns, source: t.source || null, rows: t.rows }) } catch {}
  }
  try { localStorage.setItem(key, '1') } catch {}
  tables.value = await api.tables()
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
  fit()
  window.addEventListener('resize', fit)
  for (const s of SOURCES) api.tool(s.tool).then((t) => (providers[s.id] = providersOf(t))).catch(() => {})
  fromPath()
  window.addEventListener('popstate', fromPath)
})
onUnmounted(() => { window.removeEventListener('popstate', fromPath); window.removeEventListener('resize', fit) })
</script>

<template>
  <div ref="root" class="oe">
    <header v-if="table" class="oe-top">
      <a href="/openenrich" @click.prevent="home()">← All tables</a>
    </header>

    <p v-if="error" class="oe-banner">{{ error }}</p>
    <p v-if="loading" class="muted">Loading…</p>

    <section v-else-if="table" class="oe-main">
      <TableView :key="table.name" :table="table" :fresh="fresh" @open="open" @renamed="renamed" @balance="refreshAccount" />
    </section>

    <section v-else-if="source" class="oe-main full">
      <SourceForm :source="source" :providers="providers[source.id] || []" @cancel="source = null" @created="created" />
    </section>

    <section v-else class="oe-main narrow">
      <div class="hero">
        <div class="hero-top">
          <h1>Open Enrich</h1>
          <a class="gh-btn" href="https://github.com/superdesigndev/treg" target="_blank" rel="noopener">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
            Open source
          </a>
        </div>
        <p>Start from a search or a CSV, then add columns for emails, phones, company data, signals and AI judgments. Each row is one call, at the price of the provider that answers it.</p>
      </div>
      <div class="sources">
        <button v-for="s in SOURCES" :key="s.id" class="card source" @click="source = s">
          <span class="tile" :style="{ '--tint': look(s.id)[1] }"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path :d="icon(look(s.id)[0])" /></svg></span>
          <span><strong>{{ s.label }}</strong><small>{{ s.hint }}</small></span>
          <span v-if="providers[s.id]?.length" class="vendors" :title="providers[s.id].join(', ')">
            <img v-for="p in providers[s.id].slice(0, 6)" :key="p" :src="`/logos/${p}.svg`" :alt="p" @error="$event.target.remove()" />
            <small>{{ providers[s.id].length }} {{ providers[s.id].length === 1 ? 'provider' : 'providers' }}</small>
          </span>
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
