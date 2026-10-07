<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { COLUMN_TYPES, cellText, linkOf as hrefOf, listRecords, moreRowsPlans, parseEdited, readAnswer, rowKey, searchCap, tableFromRows, toCsv, usd } from './jobs.js'
import ColumnPanel from './ColumnPanel.vue'
import { loadTable } from './client.js'

// `fresh`: a table just made from a search, so the next step (adding a column) is already open
const props = defineProps({ table: Object, fresh: Boolean })
const emit = defineEmits(['open', 'balance', 'renamed'])
const api = inject('oeApi')

const t = ref(props.table)
const adding = ref(props.fresh)
const detail = ref(null)       // {row, column} shown in the side panel
const runs = reactive({})      // column group -> its server run {id, label, done, total, spent, stopping}
const banner = ref('')
const menu = ref(null)         // the column whose header menu is open
// The menu sits on the window, below its header: inside the grid's scroll box a short table would cut it off
const menuAt = ref({})
function openMenu(col, e) {
  if (menu.value === col.id) { menu.value = null; return }
  const r = e.currentTarget.getBoundingClientRect()
  menuAt.value = { top: `${Math.round(r.bottom + 4)}px`, left: `${Math.round(Math.min(r.left, window.innerWidth - 240))}px` }
  menu.value = col.id
  menuScroll = null
}
// the menu stays put on the window: a real scroll of the grid closes it, not the nudge a click on a
// half-hidden header makes to bring it into view
let menuScroll = null
function gridScrolled(e) {
  if (!menu.value) return
  const at = [e.target.scrollLeft, e.target.scrollTop]
  if (!menuScroll) { menuScroll = at; return }
  if (Math.abs(at[0] - menuScroll[0]) > 40 || Math.abs(at[1] - menuScroll[1]) > 40) menu.value = null
}

const DONE = new Set(['hit', 'miss'])

const groups = computed(() => {
  const seen = new Map()
  for (const c of t.value.columns) if (c.job && !seen.has(c.job.group)) seen.set(c.job.group, c)
  return seen
})

// --- saving: the table lives in treg; only what changed since the last sync is sent ----------------
let saveTimer = null
const synced = new Map()       // table name -> {columns: json, rows: Map(row id -> json)}
const each = (o) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, JSON.stringify(v)]))
const snapshot = (table) => ({ columns: JSON.stringify(table.columns),
  rows: new Map(table.rows.map((r) => [r.id, { cells: each(r.cells), runs: each(r.runs) }])) })
function remember(table) { synced.set(table.name, snapshot(table)) }
remember(t.value)

function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 600)
}
let flushing = Promise.resolve()
function flush() {
  clearTimeout(saveTimer)
  flushing = flushing.then(async () => {
    await flushTable(t.value)
  }).then(() => { if (banner.value.startsWith('Could not save')) banner.value = '' })
    .catch((e) => {
      // nothing counted as saved. Out of reach or a server fault: try again shortly, so a moment
      // away loses no cells. Refused (4xx): saying so is all, the same save would be refused again.
      const transient = !e.status || e.status >= 500
      banner.value = `Could not save: ${e.message}${transient ? '. Trying again…' : ''}`
      if (transient) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 4000) }
    })
  return flushing
}
// Only the cells and runs that changed are sent (a removed one as null): the server fills other
// cells of the same rows meanwhile, and a whole row from here would put back what it replaced.
async function flushTable(table) {
  const last = synced.get(table.name) || { columns: '', rows: new Map() }
  // what is sent is what counts as saved: rows keep changing while the request is out
  const sent = snapshot(table)
  const diff = (now, before = {}) => {
    const out = {}
    for (const [k, v] of Object.entries(now)) if (before[k] !== v) out[k] = JSON.parse(v)
    for (const k of Object.keys(before)) if (!(k in now)) out[k] = null
    return out
  }
  const stored = []
  for (const r of table.rows) {
    const was = last.rows.get(r.id)
    const cells = diff(sent.rows.get(r.id).cells, was?.cells)
    const runs = diff(sent.rows.get(r.id).runs, was?.runs)
    if (!was || Object.keys(cells).length || Object.keys(runs).length) {
      stored.push({ id: r.id, cells, runs, ...(r._parent ? { parent_row: r._parent } : {}) })
    }
  }
  if (sent.columns !== last.columns) await api.update(table.name, { columns: table.columns })
  if (stored.length) await api.upsertRows(table.name, stored)
  synced.set(table.name, sent)
}

// --- running a column -----------------------------------------------------------------------------
// A job column's state is its group's run on that row: one call fills every column of the group.
const runOf = (row, col) => (col.job ? row.runs?.[col.job.group] : null)
const setRun = (row, group, value) => {
  row.runs = { ...(row.runs || {}) }
  if (value) row.runs[group] = { ...value, at: new Date().toISOString() }
  else delete row.runs[group]
}

// Runs go on the server (docs/context/architecture/tables.md, phase 2): leaving the page, opening
// the linked table or closing the tab does not stop them. The page starts a run and polls it.
const busy = (row, group) => !!runs[group] && ['queued', 'running'].includes(row.runs?.[group]?.state)
const running = computed(() => Object.keys(runs).length > 0)

// `only`: run just these rows (a cell's ▶), asking the provider again instead of replaying.
async function runGroup(group, howMany, again = false, only = null) {
  await flush()            // the server reads the rows as saved
  const body = { group, rows: only ? only.map((r) => r.id) : again ? 'all' : 'pending',
    ...(only ? { fresh: true } : howMany !== 'all' ? { limit: howMany } : {}) }
  try {
    await api.startRun(t.value.name, body)
    banner.value = ''
  } catch (e) { banner.value = e.message; return }
  await poll()
}

// Every 2 s while a run goes: its progress, then the rows it wrote
const seen = new Set()         // finished runs already reported
let pollTimer = null
let polling = false
async function poll() {
  clearTimeout(pollTimer)
  if (polling) return
  polling = true
  const name = t.value.name
  try {
    const list = await api.runs(name)
    if (name !== t.value.name) return
    const label = (g) => { const cols = t.value.columns.filter((c) => c.job?.group === g); return cols.length > 1 ? `${cols[0].label} +${cols.length - 1}` : cols[0]?.label || g }
    const was = running.value
    for (const g of Object.keys(runs)) delete runs[g]
    for (const x of list) {
      if (['queued', 'running'].includes(x.state)) {
        if (!runs[x.group]) runs[x.group] = { id: x.id, label: label(x.group), done: x.done, total: x.total, spent: x.spent_micro, stopping: x.stopping }
      } else if (!seen.has(x.id)) {
        seen.add(x.id)
        if (x.error && Date.now() - Date.parse(x.updated_at + 'Z') < 60_000) banner.value = x.error
      }
    }
    if (running.value || was) await refresh()
    if (was && !running.value) emit('balance')
  } catch {} finally {
    polling = false
    if (running.value) pollTimer = setTimeout(poll, 2000)
  }
}
async function stopRun(group) {
  runs[group].stopping = true
  try { await api.stopRun(t.value.name, runs[group].id) } catch {}
}

// The stored rows into the ones on screen, in place: an open cell keeps its row
async function refresh() {
  await flush()
  const fresh = await loadTable(api, t.value.name)
  const mine = new Map(t.value.rows.map((r) => [r.id, r]))
  t.value.rows = fresh.rows.map((r) => (mine.has(r.id) ? Object.assign(mine.get(r.id), { cells: r.cells, runs: r.runs }) : r))
  if (JSON.stringify(fresh.columns) !== JSON.stringify(t.value.columns) && !adding.value) t.value.columns = fresh.columns
  remember(t.value)
}
onMounted(poll)
onUnmounted(() => clearTimeout(pollTimer))

// --- more rows from the search the table came from ---------------------------------------------
const loadingMore = ref(false)
async function loadMore() {
  const src = t.value.source
  loadingMore.value = true
  banner.value = ''
  try {
    const tool = await api.tool(src.tool)
    const kind = t.value.kind || 'companies'
    const have = new Set(t.value.rows.map((r) => rowKey(r.cells)).filter(Boolean))
    // a lookalike search never brings back its own seeds
    if (src.split) for (const v of [src.body?.[src.split]].flat()) if (v) have.add(rowKey({ domain: v }))
    let spent = 0
    for (const plan of moreRowsPlans(src, tool?.endpoint?.routed_children || [])) {
      const answers = await Promise.all(plan.bodies.map((body) => api.run(src.tool, src.method === 'GET'
        ? { method: 'GET', query: body, fresh: true }
        : { method: 'POST', body, maxCost: searchCap(body.limit), exclude: plan.exclude, fresh: true, strict: plan.strict })))
      spent += answers.reduce((n, r) => n + (r.cost_micro || 0), 0)
      const hits = answers.map(readAnswer).filter((a) => a.state === 'hit')
      const { records, ids } = listRecords(kind, hits.flatMap((a) => a.rows), [...new Set(hits.flatMap((a) => a.columns))], Infinity, src.keep)
      const made = tableFromRows(t.value.name, kind, records, ids)
      const fresh = made.rows.filter((r) => { const k = rowKey(r.cells); return k && !have.has(k) && have.add(k) })
      if (!fresh.length) continue
      for (const c of made.columns) if (!t.value.columns.some((x) => x.id === c.id)) t.value.columns.push(c)
      t.value.rows.push(...fresh)
      const servedBy = [...new Set(answers.map((r) => r.served_by).filter(Boolean).map((x) => x.split('.')[0]))]
      t.value.source = plan.next === 'page' ? { ...src, page: (src.page || 1) + 1, served_by: src.served_by?.length ? src.served_by : servedBy }
        : { ...src, page: 1, served_by: [...new Set([...(src.served_by || []), ...servedBy])] }
      await flush()
      await api.update(t.value.name, { source: t.value.source })
      banner.value = `Added ${fresh.length} ${kind} · ${usd(spent)}`
      nextTick(() => { const g = document.querySelector('.oe .oe-grid-wrap'); g?.scrollTo({ top: g.scrollHeight, behavior: 'smooth' }) })
      return
    }
    banner.value = `No new ${kind}: the providers behind this search have nothing more for these filters${spent ? ` (${usd(spent)} spent)` : ''}.`
  } catch (e) {
    banner.value = e.message
  } finally {
    loadingMore.value = false
  }
}

// --- columns --------------------------------------------------------------------------------------
async function addColumns({ columns, rows }) {
  adding.value = false
  const old = editGroup.value
  editGroup.value = null
  if (old) {
    // new settings, new answers: the group's old columns, values and runs go; the new ones take
    // the first old column's place
    const at = t.value.columns.findIndex((c) => c.job?.group === old)
    const ids = new Set(t.value.columns.filter((c) => c.job?.group === old).map((c) => c.id))
    for (const r of t.value.rows) { for (const id of ids) delete r.cells[id]; setRun(r, old, null) }
    t.value.columns = t.value.columns.filter((c) => !ids.has(c.id))
    t.value.columns.splice(at, 0, ...columns)
  } else t.value.columns.push(...columns)
  await flush()
  if (rows) await runGroup(columns[0].job.group, rows)
}

const editGroup = ref(null)
function editColumn(col) {
  editGroup.value = col.job.group
  adding.value = true
  detail.value = null
}

async function removeColumn(col) {
  if (!confirm(`Delete column "${col.label}"${col.job ? ' and the columns filled by the same call' : ''}?`)) return
  const drop = new Set(t.value.columns.filter((c) => c === col || (col.job && c.job?.group === col.job.group)).map((c) => c.id))
  t.value.columns = t.value.columns.filter((c) => !drop.has(c.id))
  for (const r of t.value.rows) {
    for (const id of drop) delete r.cells[id]
    if (col.job) setRun(r, col.job.group, null)
  }
  await flush()
}

// a column's type decides which tool inputs it feeds; the menu corrects a wrong guess
async function setType(col, type) {
  if (type) col.type = type
  else delete col.type
  await flush()
}

// A job column some rows ran and others did not answer (a stop, a low balance, an error): the bar
// offers those rows again
const retry = computed(() => {
  for (const c of t.value.columns) {
    if (!c.job || !t.value.rows.some((r) => runOf(r, c))) continue
    const n = remaining(c)
    if (n && !runs[c.job.group]) return { group: c.job.group, n }
  }
  return null
})
function remaining(col) {
  return t.value.rows.filter((r) => !DONE.has(runOf(r, col)?.state) && !busy(r, col.job?.group)).length
}

// --- cells ----------------------------------------------------------------------------------------
const linkOf = (row, col) => runOf(row, col)?.link || null

function show(value) {
  if (value == null) return ''
  if (value === true) return '✓'
  if (value === false) return '✗'
  return typeof value === 'object' ? JSON.stringify(value) : value
}

// a cell of hex colours (a brand's palette) shows them as swatches beside the codes
const swatches = (v) => (typeof v === 'string' && /^#[0-9a-f]{3,8}(,\s*#[0-9a-f]{3,8})*$/i.test(v.trim()) ? v.split(',').map((x) => x.trim()) : null)

// A job cell that has no value to show says why, as a small status pill.
function pill(row, col) {
  const state = runOf(row, col)?.state
  if (!state || state === 'hit' || (['queued', 'running'].includes(state) && !busy(row, col.job.group))) return ''
  return { queued: 'Queued', running: 'Running', miss: 'No result', skipped: 'Missing input', error: 'Error' }[state] ?? ''
}

// ---- the table's name, edited in place ----------------------------------------------------------
const naming = ref(null)         // the name being typed, or null
const nameError = ref('')
async function rename() {
  const next = (naming.value || '').trim()
  naming.value = null
  if (!next || next === t.value.name) return
  try {
    await flush()                // pending cells first, under the old name
    const stored = await api.update(t.value.name, { name: next })
    emit('renamed', stored.name)
  } catch (e) { nameError.value = e.message }
}

// ---- a cell opened in the side panel: its whole value, editable, and the call that filled it ----
const editing = ref(null)        // the text being edited, or null when reading
function openCell(row, col, el) {
  detail.value = { row, column: col }
  editing.value = null
  adding.value = false
  // the panel narrows the grid: keep the clicked cell in sight, not under the panel
  if (el) nextTick(() => el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }))
}
function startEdit() { editing.value = cellText(detail.value.row.cells[detail.value.column.id]) }
function saveEdit() {
  const { row, column } = detail.value
  row.cells[column.id] = parseEdited(editing.value, row.cells[column.id])
  editing.value = null
  save()
}
// the call behind an enrichment cell, as label/value lines
function runLines(row, col) {
  const r = runOf(row, col)
  if (!r) return []
  const state = { hit: 'Found', miss: 'No result', error: 'Error', skipped: 'Missing input', queued: 'Queued', running: 'Running' }[r.state] || r.state
  return [
    ['Status', state],
    r.served_by && ['Provider', r.served_by],
    ['Cost', r.replay ? `${usd(r.cost_micro || 0)} (replayed)` : usd(r.cost_micro || 0)],
    r.confidence != null && ['Confidence', `${Math.round(r.confidence * 100)}%`],
    r.error && ['Error', r.error],
    r.inputs && Object.keys(r.inputs).length && ['Inputs', Object.entries(r.inputs).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')],
    r.at && ['When', new Date(r.at).toLocaleString()],
    r.call_id && ['Call', r.call_id],
  ].filter(Boolean)
}
const copied = ref(false)
async function copyValue() {
  try { await navigator.clipboard.writeText(cellText(detail.value.row.cells[detail.value.column.id])); copied.value = true; setTimeout(() => (copied.value = false), 1200) } catch {}
}

function exportCsv() {
  const blob = new Blob([toCsv(t.value.columns, t.value.rows)], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${t.value.name}.csv` })
  a.click()
  URL.revokeObjectURL(a.href)
}

// A teammate (or later an agent) may change the table while the page is open: reload it on focus.
async function reload() {
  if (running.value || adding.value) return
  await flushing
  try { t.value = await loadTable(api, t.value.name); remember(t.value) } catch {}
}
onMounted(() => window.addEventListener('focus', reload))
onUnmounted(() => window.removeEventListener('focus', reload))
</script>

<template>
  <div class="sheet">
    <div class="bar">
      <a v-if="t.parent" class="crumb-link" href="#" @click.prevent="emit('open', t.parent.table)">← {{ t.parent.table }}</a>
      <input v-if="naming != null" v-model="naming" class="title-edit" autofocus @keydown.enter="rename" @keydown.esc="naming = null" @blur="rename" />
      <strong v-else class="title" title="Rename" @click="naming = t.name; nameError = ''">{{ t.name }}<span class="pencil">✎</span></strong>
      <span v-if="nameError" class="warn small">{{ nameError }}</span>
      <span class="muted small">{{ t.rows.length }} rows · {{ t.columns.length }} columns</span>
      <span v-for="(x, g) in runs" :key="g" class="run-status">
        <span class="dot" /> {{ x.label }} {{ x.done }} / {{ x.total }} · {{ usd(x.spent) }}
        <button class="ghost" :disabled="x.stopping" @click="stopRun(g)">{{ x.stopping ? 'Stopping…' : 'Stop' }}</button>
      </span>
      <span class="spacer" />
      <button v-if="retry" @click="runGroup(retry.group, 'all')">Retry {{ retry.n }} unfinished rows</button>
      <button v-if="t.source?.tool && !t.source.noPage && !t.parent" :disabled="loadingMore" @click="loadMore">{{ loadingMore ? 'Loading…' : 'Load more rows' }}</button>
      <button @click="exportCsv">Export CSV</button>
      <button class="primary" @click="editGroup = null; adding = true; detail = null">+ Add column</button>
    </div>
    <p v-if="banner" class="oe-banner">{{ banner }}</p>

    <div class="oe-layout">
      <div class="oe-grid-wrap" @click="menu = null" @scroll="gridScrolled">
        <table class="oe-grid ui-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th v-for="c in t.columns" :key="c.id" :class="{ jobcol: c.job, open: menu === c.id }" @click.stop="openMenu(c, $event)">
                <span class="th-label">{{ c.label }}</span>
                <span v-if="c.type && !c.job" class="th-type">{{ c.type.replace(/_/g, ' ') }}</span>
                <span class="caret">▾</span>
                <div v-if="menu === c.id" class="menu" :style="menuAt" @click.stop>
                  <template v-if="c.job">
                    <button :disabled="!remaining(c)" @click="menu = null; runGroup(c.job.group, 10)">Run 10 rows</button>
                    <button :disabled="!remaining(c)" @click="menu = null; runGroup(c.job.group, 'all')">Run {{ remaining(c) }} rows left</button>
                    <button :disabled="!!runs[c.job.group]" @click="menu = null; runGroup(c.job.group, 'all', true)">Re-run all rows</button>
                    <button :disabled="!!runs[c.job.group]" @click="menu = null; editColumn(c)">Edit settings</button>
                    <hr />
                  </template>
                  <label class="menu-type">Type
                    <select :value="c.type || ''" @change="setType(c, $event.target.value)">
                      <option value="">not set</option>
                      <option v-for="ty in COLUMN_TYPES" :key="ty" :value="ty">{{ ty.replace(/_/g, ' ') }}</option>
                    </select>
                  </label>
                  <hr />
                  <button class="danger" :disabled="!!(c.job && runs[c.job.group])" @click="menu = null; removeColumn(c)">Delete column</button>
                </div>
              </th>
              <th class="add-col" title="Add a column" @click.stop="editGroup = null; adding = true; detail = null">+ Add column</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in t.rows" :key="r.id">
              <td class="num">{{ i + 1 }}</td>
              <td v-for="c in t.columns" :key="c.id" :class="['cell', runOf(r, c)?.state, { picked: detail?.row === r && detail?.column === c }]"
                  @click="openCell(r, c, $event.currentTarget)">
                <a v-if="linkOf(r, c)" class="pill link" href="#" @click.prevent.stop="emit('open', linkOf(r, c))">
                  {{ r.cells[c.id] }} {{ r.cells[c.id] === 1 ? 'person' : 'people' }} →
                </a>
                <span v-else-if="pill(r, c)" :class="['pill', runOf(r, c).state]">{{ pill(r, c) }}</span>
                <span v-else-if="swatches(r.cells[c.id])" class="swatches"><i v-for="h in swatches(r.cells[c.id])" :key="h" :style="{ background: h }" />{{ show(r.cells[c.id]) }}</span>
                <template v-else>{{ show(r.cells[c.id]) }}<span v-if="runOf(r, c)?.confidence != null" class="muted small"> · {{ Math.round(runOf(r, c).confidence * 100) }}%</span></template>
                <button v-if="c.job && !busy(r, c.job.group)" class="rerun" title="Run this row" @click.stop="runGroup(c.job.group, 1, false, [r])">▶</button>
              </td>
              <td class="add-col" />
            </tr>
          </tbody>
        </table>
      </div>

      <ColumnPanel v-if="adding" :key="editGroup || 'new'" :table="t" :edit="editGroup" @close="adding = false; editGroup = null" @add="addColumns" />

      <aside v-else-if="detail" class="oe-side">
        <header class="side-head">
          <strong>{{ detail.column.label }} · row {{ t.rows.indexOf(detail.row) + 1 }}</strong>
          <button class="icon" title="Close" @click="detail = null">✕</button>
        </header>
        <div class="side-body">
          <div class="cell-head">
            <h4>Value</h4>
            <span class="spacer" />
            <template v-if="editing == null">
              <button class="ghost small-btn" :disabled="detail.row.cells[detail.column.id] == null" @click="copyValue">{{ copied ? 'Copied' : 'Copy' }}</button>
              <button class="ghost small-btn" @click="startEdit">Edit</button>
            </template>
          </div>
          <template v-if="editing == null">
            <a v-if="hrefOf(detail.row.cells[detail.column.id])" class="cell-full" :href="hrefOf(detail.row.cells[detail.column.id])" target="_blank" rel="noopener noreferrer">{{ cellText(detail.row.cells[detail.column.id]) }}</a>
            <pre v-else-if="cellText(detail.row.cells[detail.column.id])" class="cell-full">{{ cellText(detail.row.cells[detail.column.id]) }}</pre>
            <p v-else class="muted small">Empty<template v-if="runOf(detail.row, detail.column)">: {{ pill(detail.row, detail.column) || 'no value' }}</template>.</p>
          </template>
          <template v-else>
            <textarea v-model="editing" class="oe-textarea cell-edit" rows="8" autofocus @keydown.meta.enter="saveEdit" @keydown.ctrl.enter="saveEdit" @keydown.esc="editing = null" />
            <div class="cell-actions">
              <button class="primary" @click="saveEdit">Save</button>
              <button class="ghost" @click="editing = null">Cancel</button>
              <span class="muted small">⌘↵ to save · empty clears it</span>
            </div>
            <p v-if="runOf(detail.row, detail.column)" class="muted small">Your edit stays until this row's column is run again.</p>
          </template>
          <template v-if="runLines(detail.row, detail.column).length">
            <h4>Filled by</h4>
            <dl class="detail">
              <template v-for="[k, v] in runLines(detail.row, detail.column)" :key="k">
                <dt>{{ k }}</dt><dd>{{ v }}</dd>
              </template>
            </dl>
          </template>
        </div>
      </aside>
    </div>
  </div>
</template>
