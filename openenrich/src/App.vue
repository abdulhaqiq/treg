<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { api } from './client.js'
import { SOURCES, parseCsv, rowId, slug, uniqueColumnId, usd } from './jobs.js'
import SourceForm from './SourceForm.vue'
import TableView from './TableView.vue'

const account = ref(null)
const accountError = ref('')
const tables = ref([])
const source = ref(null)        // the source form being filled
const table = ref(null)         // the open table
const csvInput = ref(null)

async function refreshAccount() {
  try {
    account.value = await api.account()
    accountError.value = ''
  } catch (e) {
    accountError.value = e.status === 401 || e.status === 403
      ? 'No treg token. Set TREG_TOKEN or run `treg login`.'
      : e.status === 404 ? 'Tables are not turned on for this team yet.' : e.message
  }
}

const balance = () => {
  const a = account.value
  const team = a?.teams?.find((t) => t.slug === a.active_team || t.org_id === a.active_team) || a?.teams?.[0]
  return team ? usd(team.balance_micro || 0) : ''
}

async function open(name) {
  table.value = await api.load(name)
  source.value = null
  location.hash = `#/t/${name}`
}

function home() {
  table.value = null
  source.value = null
  location.hash = ''
  api.tables().then((t) => (tables.value = t))
  refreshAccount()
}

async function created(t) {
  t.name = await freeName(t.name)
  await api.save(t)
  await open(t.name)
}

async function freeName(base) {
  const taken = new Set((await api.tables()).map((t) => t.name))
  let name = slug(base)
  for (let n = 2; taken.has(name); n++) name = `${slug(base)}-${n}`
  return name
}

async function importCsv(e) {
  const file = e.target.files?.[0]
  if (!file) return
  const [header = [], ...lines] = parseCsv(await file.text())
  const columns = []
  for (const label of header) columns.push({ id: uniqueColumnId(columns, label), label })
  const names = header.map((h) => h.toLowerCase())
  const kind = names.some((n) => /first.?name|last.?name|full.?name|email|title/.test(n)) ? 'people' : 'companies'
  await created({
    name: file.name.replace(/\.csv$/i, ''), kind, parent: null, columns,
    rows: lines.map((l) => ({ id: rowId(), cells: Object.fromEntries(columns.map((c, i) => [c.id, l[i] ?? ''])) })),
  })
  e.target.value = ''
}

function fromHash() {
  const m = location.hash.match(/^#\/t\/([\w-]+)$/)
  if (m) open(m[1]).catch(home)
  else if (table.value) home()
}

onMounted(() => {
  refreshAccount()
  api.tables().then((t) => (tables.value = t))
  fromHash()
  window.addEventListener('hashchange', fromHash)
})
onUnmounted(() => window.removeEventListener('hashchange', fromHash))
</script>

<template>
  <header class="top">
    <a class="brand" href="#" @click.prevent="home">openenrich</a>
    <span v-if="table" class="crumb">/ {{ table.name }}</span>
    <span class="spacer" />
    <span v-if="accountError" class="warn">{{ accountError }}</span>
    <span v-else-if="account" class="balance" title="Your treg balance">{{ balance() }}</span>
  </header>

  <main v-if="table">
    <TableView :key="table.name" :table="table" @open="open" @balance="refreshAccount" />
  </main>

  <main v-else-if="source" class="narrow">
    <SourceForm :source="source" @cancel="source = null" @created="created" />
  </main>

  <main v-else class="narrow">
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
      <h2>Recent tables</h2>
      <ul class="recent">
        <li v-for="t in tables" :key="t.name"><a href="#" @click.prevent="open(t.name)">{{ t.name }}</a></li>
      </ul>
    </template>
  </main>
</template>
