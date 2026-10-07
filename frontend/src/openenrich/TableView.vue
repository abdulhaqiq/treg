<script setup>
import { computed, inject, onMounted, onUnmounted, reactive, ref } from 'vue'
import { COLUMN_TYPES, cellText, linkOf as hrefOf, parseEdited, cellFrom, cellValue, fillInputs, host, judgeBody, judgeValue, listRecords, readAnswer, rowId, satisfies, toCsv, typeOfField, usd } from './jobs.js'
import ColumnPanel from './ColumnPanel.vue'
import { loadTable, toStoredRows } from './client.js'

// `fresh`: a table just made from a search, so the next step (adding a column) is already open
const props = defineProps({ table: Object, fresh: Boolean })
const emit = defineEmits(['open', 'balance', 'renamed'])
const api = inject('oeApi')

const t = ref(props.table)
const adding = ref(props.fresh)
const detail = ref(null)       // {row, column} shown in the side panel
const runs = reactive({})      // column group -> {label, queue, fresh, done, total, spent, stopping}: one per running column
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

const CONCURRENCY = 10   // calls in flight across the whole table: a waterfall row takes 5-15 s, so rows run side by side
const DONE = new Set(['hit', 'miss'])

const groups = computed(() => {
  const seen = new Map()
  for (const c of t.value.columns) if (c.job && !seen.has(c.job.group)) seen.set(c.job.group, c)
  return seen
})

// --- saving: the table lives in treg; only what changed since the last sync is sent ----------------
let saveTimer = null
const synced = new Map()       // table name -> {columns: json, rows: Map(row id -> json)}
const children = new Map()     // linked tables written by "Find people at company": name -> {table, replaced}
const rowJson = (r) => JSON.stringify(r.cells) + '|' + JSON.stringify(r.runs || {}) + '|' + (r._parent || '')
const snapshot = (table) => ({ columns: JSON.stringify(table.columns),
  rows: new Map(table.rows.map((r) => [r.id, { json: rowJson(r), groups: Object.keys(r.runs || {}), cells: Object.keys(r.cells || {}) }])) })
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
    await flushTable(t.value, null)
    for (const c of children.values()) { const replaced = c.replaced; c.replaced = new Set(); await flushTable(c.table, replaced) }
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
async function flushTable(table, replaced) {
  const last = synced.get(table.name) || { columns: '', rows: new Map() }
  // what is sent is what counts as saved: rows keep changing while the request is out (other rows
  // finishing), and those changes must stay unsaved for the next flush
  const sent = snapshot(table)
  const stored = JSON.parse(JSON.stringify(toStoredRows(table.rows.filter((r) => (replaced?.size && replaced.has(r._parent)) || last.rows.get(r.id)?.json !== sent.rows.get(r.id).json))
    .map((r) => {
      // a run or a cell removed here (a deleted or re-set column) is sent as null: the server merges
      // what it is sent, so a key left out would keep its old value
      const gone = (last.rows.get(r.id)?.groups || []).filter((g) => !(g in (r.runs || {})))
      const cleared = (last.rows.get(r.id)?.cells || []).filter((c) => !(c in (r.cells || {})))
      return { ...r,
        ...(gone.length ? { runs: { ...r.runs, ...Object.fromEntries(gone.map((g) => [g, null])) } } : {}),
        ...(cleared.length ? { cells: { ...r.cells, ...Object.fromEntries(cleared.map((c) => [c, null])) } } : {}) }
    })))
  const parents = replaced && replaced.size ? [...replaced] : null
  if (sent.columns !== last.columns) await api.update(table.name, { columns: table.columns })
  if (stored.length || parents) await api.upsertRows(table.name, stored, parents)
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

// Calls in flight, across every running column: a run takes a slot per call
let active = 0
const waiting = []
async function slot() {
  while (active >= CONCURRENCY) await new Promise((ok) => waiting.push(ok))
  active++
}
function free() {
  active--
  waiting.shift()?.()
}
const busy = (row, group) => ['queued', 'running'].includes(row.runs?.[group]?.state)
const running = computed(() => Object.keys(runs).length > 0)

// Columns run side by side. Asking a running column for more rows adds them to its run.
// `only`: run just these rows (a cell's ▶), asking the provider again instead of replaying.
async function runGroup(group, howMany, again = false, only = null) {
  const cols = t.value.columns.filter((c) => c.job?.group === group)
  const job = cols[0].job
  // re-running replays each answered row from treg for nothing (same Idempotency-Key)
  if (again && !runs[group]) for (const r of t.value.rows) { setRun(r, group, null); for (const c of cols) r.cells[c.id] = null }
  if (only) for (const r of only) if (!busy(r, group)) { setRun(r, group, null); for (const c of cols) r.cells[c.id] = null }
  const todo = (only || t.value.rows.filter((r) => !DONE.has(r.runs?.[group]?.state))).filter((r) => !busy(r, group))
  const add = howMany === 'all' ? todo : todo.slice(0, howMany)
  if (!add.length) return
  for (const r of add) setRun(r, group, { state: 'queued' })
  const fresh = only ? add.map((r) => r.id) : []
  if (runs[group]) {
    runs[group].queue.push(...add)
    runs[group].total += add.length
    fresh.forEach((id) => runs[group].fresh.add(id))
    return
  }
  banner.value = ''
  runs[group] = { label: cols.length > 1 ? `${cols[0].label} +${cols.length - 1}` : cols[0].label, queue: [...add], fresh: new Set(fresh), done: 0, total: add.length, spent: 0, stopping: false }
  const run = runs[group]
  const child = job.linked ? await childTable(cols[0]) : null

  // Each call holds up to its cap until it settles, so a low balance can refuse a hold while
  // other calls still run: that row waits for them instead of stopping the run.
  const shared = new Map()      // rows with the same inputs share one call (one Idempotency-Key)
  const worker = async () => {
    while (run.queue.length && !run.stopping) {
      await slot()
      const row = run.queue.shift()
      if (!row || run.stopping) { if (row) run.queue.unshift(row); free(); break }
      let out
      try { out = await runRow(run, row, cols, job, child, () => active > 1, shared, run.fresh.has(row.id)) } finally { free() }
      if (out === 'wait') {
        run.queue.unshift(row)
        await new Promise((ok) => setTimeout(ok, 1500))
        continue
      }
      run.done++
      save()
    }
  }
  // rows added while the last workers were finishing still run
  do { await Promise.all(Array.from({ length: CONCURRENCY }, worker)) } while (run.queue.length && !run.stopping)
  for (const r of run.queue) if (r.runs?.[group]?.state === 'queued') setRun(r, group, null)
  delete runs[group]
  await flush()
  emit('balance')
}

async function runRow(run, row, cols, job, child, othersRunning, shared, fresh = false) {
  const group = job.group
  let inputs, req
  if (job.judge) {
    // a judgment's input is the row's evidence columns, as one bounded Markdown state
    const body = judgeBody(job.judge, row, t.value.columns)
    if (!body) { setRun(row, group, { state: 'skipped' }); return }
    inputs = { evidence: job.judge.evidence }
    req = { method: 'POST', body }
  } else {
    inputs = fillInputs(job.inputs, row)
    const fromRow = Object.fromEntries(Object.entries(job.inputs).filter(([, v]) => String(v).includes('{')))
    if (!Object.keys(fillInputs(fromRow, row)).length || !satisfies(job.needs || [], inputs)) {
      setRun(row, group, { state: 'skipped', inputs })
      return
    }
    req = job.method === 'GET'
      ? { method: 'GET', query: inputs }
      : { method: job.method || 'POST', body: job.linked ? { ...inputs, limit: job.limit } : inputs, maxCost: job.maxCost,
          ...(job.exclude?.length ? { exclude: job.exclude } : {}) }
  }
  setRun(row, group, { state: 'running' })
  if (fresh) req.fresh = true
  const key = JSON.stringify(req)
  if (!shared.has(key)) shared.set(key, callWithRetry(job.tool, req))
  const r = await shared.get(key)
  const res = readAnswer(r)
  const meta = { call_id: r.call_id || undefined, served_by: r.served_by || undefined, cost_micro: r.cost_micro || 0,
    replay: r.replay || undefined, inputs }
  run.spent += r.cost_micro || 0
  if (res.state === 'stop' && res.low && othersRunning()) {
    setRun(row, group, { state: 'queued' })
    return 'wait'
  }
  if (res.state === 'stop') {
    // a short balance or a rejected token stops every running column, not just this one
    for (const x of Object.values(runs)) x.stopping = true
    banner.value = res.error
    setRun(row, group, null)
    return
  }
  if (res.state === 'hit' && job.linked) {
    const count = addPeople(child, row, res, job.limit)
    row.cells[cols[0].id] = count
    setRun(row, group, { state: 'hit', link: child.name, ...meta })
    return
  }
  if (res.state === 'hit' && job.judge) {
    const { value, confidence } = judgeValue(job.judge, res.rows[0] || {})
    row.cells[cols[0].id] = value
    setRun(row, group, value == null ? { state: 'error', error: 'The judgment came back without an answer.', ...meta }
      : { state: 'hit', confidence, ...meta })
    return
  }
  for (const c of cols) row.cells[c.id] = res.state === 'hit' ? cellFrom(res.rows, c.job.field) : null
  setRun(row, group, res.state === 'hit' ? { state: 'hit', ...meta } : { state: res.state, error: res.error, ...meta })
}

// 429, the same key still running from an earlier run, or treg out of reach for a moment (a
// network drop, a restart): wait and ask again. A finished call answers from treg's replay, free,
// so asking again never pays twice.
async function callWithRetry(tool, req) {
  for (let attempt = 0; ; attempt++) {
    const r = await api.run(tool, req)
    const busy = r.status === 0 || r.status === 429 || (r.status === 409 && /in progress/i.test(JSON.stringify(r.answer)))
    if (!busy || attempt >= 5) return r
    await new Promise((ok) => setTimeout(ok, 2000 * (attempt + 1)))
  }
}

// "Find people at company": a linked people table, one call per company row. The column keeps its
// table's name, so a re-run writes to the same one.
async function childTable(col) {
  let child = null
  if (col.job.child) { try { child = await loadTable(api, col.job.child) } catch {} }
  if (!child) {
    const made = await api.create({ name: `${t.value.name}-people`, kind: 'people', parent: { table: t.value.name, column: col.id } })
    child = { name: made.name, kind: 'people', parent: made.parent, columns: [], rows: [] }
    col.job.child = made.name
    await flush()
  }
  remember(child)
  children.set(child.name, { table: child, replaced: new Set() })
  return child
}

function addPeople(child, parentRow, res, limit) {
  const company = cellValue(parentRow.cells.name ?? parentRow.cells.company_name ?? parentRow.cells.company) ?? ''
  const { records, ids: kept } = listRecords('people', res.rows, res.columns, limit)
  const ids = ['company_name', 'company_domain', ...kept.filter((c) => c !== 'company')]
  for (const id of ids) {
    if (child.columns.some((c) => c.id === id)) continue
    const type = typeOfField(id, 'people')
    child.columns.push(type ? { id, label: id, type } : { id, label: id })
  }
  child.rows = child.rows.filter((r) => r._parent !== parentRow.id)
  children.get(child.name)?.replaced.add(parentRow.id)
  for (const p of records) {
    child.rows.push({
      id: rowId(), _parent: parentRow.id,
      cells: Object.fromEntries(child.columns.map((c) => [c.id,
        c.id === 'company_name' ? company : c.id === 'company_domain' ? host(cellValue(parentRow.cells[domainColumn()])) : p[c.id] ?? null])),
    })
  }
  return records.length
}

const domainColumn = () => (t.value.columns.find((c) => ['domain', 'company_domain', 'website'].includes(c.id)) || {}).id

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
  if (!state || state === 'hit') return ''
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
function openCell(row, col) {
  detail.value = { row, column: col }
  editing.value = null
  adding.value = false
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
        <button class="ghost" :disabled="x.stopping" @click="x.stopping = true">{{ x.stopping ? 'Stopping…' : 'Stop' }}</button>
      </span>
      <span class="spacer" />
      <button v-if="retry" @click="runGroup(retry.group, 'all')">Retry {{ retry.n }} unfinished rows</button>
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
                  @click="openCell(r, c)">
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
