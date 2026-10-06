<script setup>
import { computed, inject, onMounted, onUnmounted, ref } from 'vue'
import { COLUMN_TYPES, cellFrom, cellValue, fillInputs, host, judgeBody, judgeValue, listRecords, readAnswer, rowId, satisfies, toCsv, typeOfField, usd } from './jobs.js'
import ColumnPanel from './ColumnPanel.vue'
import { loadTable, toStoredRows } from './client.js'

const props = defineProps({ table: Object })
const emit = defineEmits(['open', 'balance'])
const api = inject('oeApi')

const t = ref(props.table)
const adding = ref(false)
const detail = ref(null)       // {row, column} shown in the side panel
const run = ref(null)          // {done, total, spent, stopping}
const banner = ref('')
const menu = ref(null)         // the column whose header menu is open

const CONCURRENCY = 10   // a waterfall row takes 5-15 s, so rows run side by side
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
function remember(table) {
  synced.set(table.name, { columns: JSON.stringify(table.columns),
    rows: new Map(table.rows.map((r) => [r.id, { json: rowJson(r), groups: Object.keys(r.runs || {}) }])) })
}
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
    for (const c of children.values()) { await flushTable(c.table, c.replaced); c.replaced = new Set() }
  }).catch((e) => { banner.value = `Could not save: ${e.message}` })
  return flushing
}
async function flushTable(table, replaced) {
  const last = synced.get(table.name) || { columns: '', rows: new Map() }
  if (JSON.stringify(table.columns) !== last.columns) await api.update(table.name, { columns: table.columns })
  const parents = replaced && replaced.size ? [...replaced] : null
  const changed = table.rows.filter((r) => (parents && parents.includes(r._parent)) || last.rows.get(r.id)?.json !== rowJson(r))
  // a group whose run was removed locally is sent as null so the server drops it too
  const stored = toStoredRows(changed).map((r) => {
    const gone = (last.rows.get(r.id)?.groups || []).filter((g) => !(g in (r.runs || {})))
    return gone.length ? { ...r, runs: { ...r.runs, ...Object.fromEntries(gone.map((g) => [g, null])) } } : r
  })
  if (changed.length || parents) await api.upsertRows(table.name, stored, parents)
  remember(table)
}

// --- running a column -----------------------------------------------------------------------------
// A job column's state is its group's run on that row: one call fills every column of the group.
const runOf = (row, col) => (col.job ? row.runs?.[col.job.group] : null)
const setRun = (row, group, value) => {
  row.runs = { ...(row.runs || {}) }
  if (value) row.runs[group] = { ...value, at: new Date().toISOString() }
  else delete row.runs[group]
}

// `only`: re-run just these rows (a cell's ↻), asking the provider again instead of replaying
async function runGroup(group, howMany, again = false, only = null) {
  if (run.value) return
  const cols = t.value.columns.filter((c) => c.job?.group === group)
  // re-running replays each answered row from treg for nothing (same Idempotency-Key)
  if (again) for (const r of t.value.rows) { setRun(r, group, null); for (const c of cols) r.cells[c.id] = null }
  const job = cols[0].job
  if (only) for (const r of only) { setRun(r, group, null); for (const c of cols) r.cells[c.id] = null }
  const todo = only || t.value.rows.filter((r) => !DONE.has(r.runs?.[group]?.state))
  const queue = howMany === 'all' ? todo : todo.slice(0, howMany)
  if (!queue.length) return
  banner.value = ''
  run.value = { done: 0, total: queue.length, spent: 0, stopping: false }
  const child = job.linked ? await childTable(cols[0]) : null
  for (const r of queue) setRun(r, group, { state: 'queued' })

  // Each call holds up to its cap until it settles, so a low balance can refuse a hold while
  // other rows still run: that row waits for them instead of stopping the run.
  let inFlight = 0
  const shared = new Map()      // rows with the same inputs share one call (one Idempotency-Key)
  const worker = async () => {
    while (queue.length && !run.value.stopping) {
      const row = queue.shift()
      inFlight++
      const out = await runRow(row, cols, job, child, () => inFlight > 1, shared, !!only)
      inFlight--
      if (out === 'wait') {
        queue.unshift(row)
        await new Promise((ok) => setTimeout(ok, 1500))
        continue
      }
      run.value.done++
      save()
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  for (const r of queue) if (r.runs?.[group]?.state === 'queued') setRun(r, group, null)
  await flush()
  run.value = null
  emit('balance')
}

async function runRow(row, cols, job, child, othersRunning, shared, fresh = false) {
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
      : { method: job.method || 'POST', body: job.linked ? { ...inputs, limit: job.limit } : inputs, maxCost: job.maxCost }
  }
  setRun(row, group, { state: 'running' })
  if (fresh) req.fresh = true
  const key = JSON.stringify(req)
  if (!shared.has(key)) shared.set(key, callWithRetry(job.tool, req))
  const r = await shared.get(key)
  const res = readAnswer(r)
  const meta = { call_id: r.call_id || undefined, served_by: r.served_by || undefined, cost_micro: r.cost_micro || 0,
    replay: r.replay || undefined, inputs }
  run.value.spent += r.cost_micro || 0
  if (res.state === 'stop' && res.low && othersRunning()) {
    setRun(row, group, { state: 'queued' })
    return 'wait'
  }
  if (res.state === 'stop') {
    run.value.stopping = true
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

// 429, or the same key still running from an earlier run: wait and ask again (a finished call
// answers from treg's replay, free)
async function callWithRetry(tool, req) {
  for (let attempt = 0; ; attempt++) {
    const r = await api.run(tool, req)
    const busy = r.status === 429 || (r.status === 409 && /in progress/i.test(JSON.stringify(r.answer)))
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
  t.value.columns.push(...columns)
  await flush()
  await runGroup(columns[0].job.group, rows)
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
    if (n) return { group: c.job.group, n }
  }
  return null
})
function remaining(col) {
  return t.value.rows.filter((r) => !DONE.has(runOf(r, col)?.state)).length
}

// --- cells ----------------------------------------------------------------------------------------
const linkOf = (row, col) => runOf(row, col)?.link || null

function show(value) {
  if (value == null) return ''
  if (value === true) return '✓'
  if (value === false) return '✗'
  return typeof value === 'object' ? JSON.stringify(value) : value
}

// A job cell that has no value to show says why, as a small status pill.
function pill(row, col) {
  const state = runOf(row, col)?.state
  if (!state || state === 'hit') return ''
  return { queued: 'Queued', running: 'Running', miss: 'No result', skipped: 'Missing input', error: 'Error' }[state] ?? ''
}

// What the detail panel shows: the value, then the call that produced it.
function details(row, col) {
  const out = { value: row.cells[col.id] }
  const r = runOf(row, col)
  if (r) Object.assign(out, r)
  return out
}

function exportCsv() {
  const blob = new Blob([toCsv(t.value.columns, t.value.rows)], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${t.value.name}.csv` })
  a.click()
  URL.revokeObjectURL(a.href)
}

// A teammate (or later an agent) may change the table while the page is open: reload it on focus.
async function reload() {
  if (run.value || adding.value) return
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
      <strong class="title">{{ t.name }}</strong>
      <span class="muted small">{{ t.rows.length }} rows · {{ t.columns.length }} columns</span>
      <span v-if="run" class="run-status">
        <span class="dot" /> Running {{ run.done }} / {{ run.total }} · {{ usd(run.spent) }}
        <button class="ghost" :disabled="run.stopping" @click="run.stopping = true">{{ run.stopping ? 'Stopping…' : 'Stop' }}</button>
      </span>
      <span class="spacer" />
      <button v-if="retry && !run" @click="runGroup(retry.group, 'all')">Retry {{ retry.n }} unfinished rows</button>
      <button @click="exportCsv">Export CSV</button>
      <button class="primary" :disabled="!!run" @click="adding = true; detail = null">+ Add column</button>
    </div>
    <p v-if="banner" class="oe-banner">{{ banner }}</p>

    <div class="oe-layout">
      <div class="oe-grid-wrap" @click="menu = null">
        <table class="oe-grid ui-table">
          <thead>
            <tr>
              <th class="num">#</th>
              <th v-for="c in t.columns" :key="c.id" :class="{ jobcol: c.job, open: menu === c.id }" @click.stop="menu = menu === c.id ? null : c.id">
                <span class="th-label">{{ c.label }}</span>
                <span v-if="c.type && !c.job" class="th-type">{{ c.type.replace(/_/g, ' ') }}</span>
                <span class="caret">▾</span>
                <div v-if="menu === c.id" class="menu" @click.stop>
                  <template v-if="c.job">
                    <button :disabled="!!run || !remaining(c)" @click="menu = null; runGroup(c.job.group, 10)">Run 10 rows</button>
                    <button :disabled="!!run || !remaining(c)" @click="menu = null; runGroup(c.job.group, 'all')">Run {{ remaining(c) }} rows left</button>
                    <button :disabled="!!run" @click="menu = null; runGroup(c.job.group, 'all', true)">Re-run all rows</button>
                    <hr />
                  </template>
                  <label class="menu-type">Type
                    <select :value="c.type || ''" @change="setType(c, $event.target.value)">
                      <option value="">not set</option>
                      <option v-for="ty in COLUMN_TYPES" :key="ty" :value="ty">{{ ty.replace(/_/g, ' ') }}</option>
                    </select>
                  </label>
                  <hr />
                  <button class="danger" @click="menu = null; removeColumn(c)">Delete column</button>
                </div>
              </th>
              <th class="add-col" title="Add a column" @click.stop="!run && (adding = true, detail = null)">+ Add column</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in t.rows" :key="r.id">
              <td class="num">{{ i + 1 }}</td>
              <td v-for="c in t.columns" :key="c.id" :class="['cell', runOf(r, c)?.state, { picked: detail?.row === r && detail?.column === c }]"
                  @click="runOf(r, c) && (detail = { row: r, column: c }, adding = false)">
                <a v-if="linkOf(r, c)" class="pill link" href="#" @click.prevent.stop="emit('open', linkOf(r, c))">
                  {{ r.cells[c.id] }} {{ r.cells[c.id] === 1 ? 'person' : 'people' }} →
                </a>
                <span v-else-if="pill(r, c)" :class="['pill', runOf(r, c).state]">{{ pill(r, c) }}</span>
                <template v-else>{{ show(r.cells[c.id]) }}<span v-if="runOf(r, c)?.confidence != null" class="muted small"> · {{ Math.round(runOf(r, c).confidence * 100) }}%</span></template>
                <button v-if="c.job && !run" class="rerun" title="Run this row again" @click.stop="runGroup(c.job.group, 1, false, [r])">↻</button>
              </td>
              <td class="add-col" />
            </tr>
          </tbody>
        </table>
      </div>

      <ColumnPanel v-if="adding" :table="t" @close="adding = false" @add="addColumns" />

      <aside v-else-if="detail" class="oe-side">
        <header class="side-head">
          <strong>{{ detail.column.label }} · row {{ t.rows.indexOf(detail.row) + 1 }}</strong>
          <button class="icon" title="Close" @click="detail = null">✕</button>
        </header>
        <div class="side-body">
          <dl class="detail">
            <template v-for="(v, k) in details(detail.row, detail.column)" :key="k">
              <dt>{{ k.replace(/_/g, ' ') }}</dt>
              <dd>{{ k === 'cost_micro' ? usd(v) : typeof v === 'object' ? JSON.stringify(v, null, 1) : v }}</dd>
            </template>
          </dl>
        </div>
      </aside>
    </div>
  </div>
</template>
