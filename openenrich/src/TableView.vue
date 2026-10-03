<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from './client.js'
import { cellValue, fillInputs, host, keptColumns, readAnswer, rowId, satisfies, toCsv, usd } from './jobs.js'
import ColumnPanel from './ColumnPanel.vue'

const props = defineProps({ table: Object })
const emit = defineEmits(['open', 'balance'])

const t = ref(props.table)
const adding = ref(false)
const detail = ref(null)       // {row, column} shown in the side panel
const run = ref(null)          // {done, total, spent, stopping}
const banner = ref('')

const CONCURRENCY = 5
const DONE = new Set(['hit', 'miss'])

const groups = computed(() => {
  const seen = new Map()
  for (const c of t.value.columns) if (c.job && !seen.has(c.job.group)) seen.set(c.job.group, c)
  return seen
})

// --- saving: debounced while a run writes cells ---------------------------------------------------
let saveTimer = null
const extraSaves = new Map()   // child tables written by "Find people at company"
function save() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, 400)
}
async function flush() {
  clearTimeout(saveTimer)
  await api.save(t.value)
  for (const child of extraSaves.values()) await api.save(child)
}

// --- running a column -----------------------------------------------------------------------------
async function runGroup(group, howMany) {
  if (run.value) return
  const cols = t.value.columns.filter((c) => c.job?.group === group)
  const job = cols[0].job
  const todo = t.value.rows.filter((r) => !DONE.has(r.cells[cols[0].id]?.state))
  const queue = howMany === 'all' ? todo : todo.slice(0, howMany)
  if (!queue.length) return
  banner.value = ''
  run.value = { done: 0, total: queue.length, spent: 0, stopping: false }
  const child = job.linked ? await childTable(cols[0]) : null
  for (const r of queue) for (const c of cols) r.cells[c.id] = { state: 'queued' }

  const worker = async () => {
    while (queue.length && !run.value.stopping) {
      const row = queue.shift()
      await runRow(row, cols, job, child)
      run.value.done++
      save()
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  for (const r of queue) for (const c of cols) if (r.cells[c.id]?.state === 'queued') r.cells[c.id] = null
  await flush()
  run.value = null
  emit('balance')
}

async function runRow(row, cols, job, child) {
  const inputs = fillInputs(job.inputs, row)
  if (!satisfies(job.needs || [], inputs)) {
    for (const c of cols) row.cells[c.id] = { state: 'skipped', inputs }
    return
  }
  for (const c of cols) row.cells[c.id] = { state: 'running' }
  const req = job.method === 'GET'
    ? { method: 'GET', query: inputs }
    : { method: job.method, body: job.linked ? { ...inputs, limit: job.limit } : inputs, maxCost: job.maxCost }
  let r = await api.run(job.tool, req)
  if (r.status === 429) {
    await new Promise((ok) => setTimeout(ok, 3000))
    r = await api.run(job.tool, req)
  }
  const res = readAnswer(r)
  const meta = { served_by: r.served_by, cost_micro: r.cost_micro, call_id: r.call_id, replay: r.replay, inputs }
  run.value.spent += r.cost_micro || 0
  if (res.state === 'stop') {
    run.value.stopping = true
    banner.value = res.error
    for (const c of cols) row.cells[c.id] = null
    return
  }
  if (res.state === 'hit' && job.linked) {
    addPeople(child, row, res)
    row.cells[cols[0].id] = { value: res.rows.length, state: 'hit', link: child.name, ...meta }
    return
  }
  for (const c of cols) {
    row.cells[c.id] = res.state === 'hit'
      ? { value: res.rows[0][c.job.field] ?? null, state: 'hit', answer: res.rows[0], ...meta }
      : { value: null, state: res.state, error: res.error, ...meta }
  }
}

// "Find people at company": a linked people table, one call per company row.
async function childTable(col) {
  const name = `${t.value.name}-people`
  let child
  try { child = await api.load(name) } catch {
    child = { name, kind: 'people', parent: { table: t.value.name, column: col.id }, columns: [], rows: [] }
  }
  extraSaves.set(name, child)
  return child
}

function addPeople(child, parentRow, res) {
  const company = cellValue(parentRow.cells.name ?? parentRow.cells.company_name ?? parentRow.cells.company) ?? ''
  const ids = ['company_name', 'company_domain', ...keptColumns('people', res.columns).filter((c) => c !== 'company')]
  for (const id of ids) if (!child.columns.some((c) => c.id === id)) child.columns.push({ id, label: id })
  child.rows = child.rows.filter((r) => r._parent !== parentRow.id)
  for (const p of res.rows) {
    child.rows.push({
      id: rowId(), _parent: parentRow.id,
      cells: Object.fromEntries(child.columns.map((c) => [c.id,
        c.id === 'company_name' ? company : c.id === 'company_domain' ? host(cellValue(parentRow.cells[domainColumn()])) : p[c.id] ?? null])),
    })
  }
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
  for (const r of t.value.rows) for (const id of drop) delete r.cells[id]
  await flush()
}

function remaining(col) {
  return t.value.rows.filter((r) => !DONE.has(r.cells[col.id]?.state)).length
}

// --- cells ----------------------------------------------------------------------------------------
// typeof first: every string has a built-in `.link` method
const linkOf = (cell) => (cell && typeof cell === 'object' && typeof cell.link === 'string' ? cell.link : null)

function show(cell) {
  if (cell == null || typeof cell !== 'object') return cell ?? ''
  if (cell.state === 'hit') return cell.value === true ? '✓' : cell.value === false ? '✗' : cell.value ?? ''
  return { queued: '·', running: '⟳', miss: '— no match', skipped: '— missing input', error: '⚠ error' }[cell.state] ?? ''
}

function exportCsv() {
  const blob = new Blob([toCsv(t.value.columns, t.value.rows)], { type: 'text/csv' })
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${t.value.name}.csv` })
  a.click()
  URL.revokeObjectURL(a.href)
}

// An agent may edit the table file while the page is open: reload it on focus.
async function reload() {
  if (run.value || adding.value) return
  try { t.value = await api.load(t.value.name) } catch {}
}
onMounted(() => window.addEventListener('focus', reload))
onUnmounted(() => window.removeEventListener('focus', reload))
</script>

<template>
  <div class="bar">
    <a v-if="t.parent" href="#" @click.prevent="emit('open', t.parent.table)">← {{ t.parent.table }}</a>
    <strong>{{ t.rows.length }} rows</strong>
    <template v-if="run">
      <span>Running {{ run.done }} / {{ run.total }} · spent {{ usd(run.spent) }}</span>
      <button class="ghost" :disabled="run.stopping" @click="run.stopping = true">{{ run.stopping ? 'Stopping…' : 'Stop' }}</button>
    </template>
    <span class="spacer" />
    <button class="ghost" @click="exportCsv">Export CSV</button>
    <button class="primary" :disabled="!!run" @click="adding = true">+ Add column</button>
  </div>
  <p v-if="banner" class="banner">{{ banner }}</p>

  <div class="layout">
    <div class="grid-wrap">
      <table class="grid">
        <thead>
          <tr>
            <th class="num">#</th>
            <th v-for="c in t.columns" :key="c.id" :class="{ jobcol: c.job }">
              <span>{{ c.label }}</span>
              <span v-if="c.job && groups.get(c.job.group) === c && remaining(c) && !run" class="col-run">
                <button title="Run 10 more rows" @click="runGroup(c.job.group, 10)">▶ 10</button>
                <button :title="`Run the ${remaining(c)} rows left`" @click="runGroup(c.job.group, 'all')">all</button>
              </span>
              <button class="x" title="Delete column" @click="removeColumn(c)">×</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in t.rows" :key="r.id">
            <td class="num">{{ i + 1 }}</td>
            <td v-for="c in t.columns" :key="c.id" :class="['cell', r.cells[c.id]?.state]"
                @click="r.cells[c.id]?.state && (detail = { row: r, column: c })">
              <a v-if="linkOf(r.cells[c.id])" href="#" @click.prevent.stop="emit('open', linkOf(r.cells[c.id]))">
                {{ r.cells[c.id].value }} {{ r.cells[c.id].value === 1 ? 'person' : 'people' }} →
              </a>
              <template v-else>{{ show(r.cells[c.id]) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ColumnPanel v-if="adding" :table="t" @close="adding = false" @add="addColumns" />

    <aside v-else-if="detail" class="panel">
      <header><strong>{{ detail.column.label }}</strong><button class="ghost" @click="detail = null">Close</button></header>
      <dl class="detail">
        <template v-for="(v, k) in detail.row.cells[detail.column.id]" :key="k">
          <dt>{{ k }}</dt>
          <dd>{{ k === 'cost_micro' ? usd(v) : typeof v === 'object' ? JSON.stringify(v, null, 1) : v }}</dd>
        </template>
      </dl>
    </aside>
  </div>
</template>
