<script setup lang="ts">
// Vibe-it (docs/context/architecture/vibe-it.md): the maker talks with treg's agent, which searches
// the catalog, writes the hub tool's files, test-runs them and publishes when asked. The files are
// beside the chat and editable; the buttons under them do the same things without the agent.
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { ApiError, api, me, setTeam, signInUrl, teams, usd, when, type Team } from '../standalone/api'
import { build, initial } from '../standalone/form'
import InputForm from '../standalone/InputForm.vue'
import ResultView from '../standalone/ResultView.vue'

type Msg = { id: number, role: string, text?: string, calls?: string[], name?: string, summary?: string, ok?: boolean, at: string }
type Session = { id: number, title: string, tool_id: string | null, updated_at: string, trimmed: boolean }
type Draft = { manifest?: any, script?: string, check?: any, readme?: string }

const FILES = [
  { key: 'manifest', label: 'recipe.json' },
  { key: 'script', label: 'run.js' },
  { key: 'check', label: 'check.json' },
  { key: 'readme', label: 'README.md' },
] as const

const state = ref<'loading' | 'signedout' | 'off' | 'noteam' | 'ready'>('loading')
const email = ref('')
const myTeams = ref<Team[]>([])
const team = ref('')
const budget = ref({ budget: 0, left: 0 })
const sessions = ref<Session[]>([])
const current = ref<any>(null)
const text = ref('')
const sending = ref(false)
const elapsed = ref(0)
const err = ref('')
const tab = ref<'manifest' | 'script' | 'check' | 'readme'>('manifest')
const edits = ref<Record<string, string>>({})
const dirty = ref(false)
const problem = ref<{ field: string, rule: string } | null>(null)
const checked = ref(false)
const panel = ref<'files' | 'test'>('files')
const testValues = ref<Record<string, unknown>>({})
const testErrors = ref<Record<string, string>>({})
const testing = ref(false)
const testResult = ref<any>(null)
const publishing = ref(false)
const published = ref<any>(null)
const appUrl = ref('')
const chatEl = ref<HTMLElement | null>(null)
let timer: number | undefined

const draft = computed<Draft>(() => current.value?.draft || {})
const inputs = computed(() => draft.value.manifest?.inputs || {})
const outputFields = computed<string[]>(() => {
  const o = draft.value.manifest?.output
  return o && Array.isArray(o.fields) ? o.fields : o ? Object.keys(o) : []
})
const visibleFiles = computed(() => FILES.filter(f => f.key !== 'script' || draft.value.manifest?.script || draft.value.script))
const leftPct = computed(() => budget.value.budget ? Math.round(100 * budget.value.left / budget.value.budget) : 0)

function fileText(d: Draft, key: string): string {
  const v = (d as any)[key]
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
}

function loadEdits() {
  edits.value = Object.fromEntries(FILES.map(f => [f.key, fileText(draft.value, f.key)]))
  dirty.value = false
  testValues.value = initial(inputs.value)
  const sample = draft.value.check?.inputs || draft.value.check?.cases?.[0]?.inputs
  if (sample) for (const [k, v] of Object.entries(sample)) testValues.value[k] = typeof v === 'string' ? v : JSON.stringify(v)
}

async function loadState() {
  try {
    const s = await api('/vibe/state')
    budget.value = { budget: s.budget_micro, left: s.left_micro }
    sessions.value = s.sessions
    state.value = 'ready'
  } catch (e) {
    state.value = e instanceof ApiError && e.status === 404 ? 'off' : 'off'
  }
}

async function open(id: number) {
  err.value = ''; published.value = null; appUrl.value = ''; testResult.value = null; problem.value = null; checked.value = false
  current.value = await api(`/vibe/sessions/${id}`)
  loadEdits()
  history.replaceState(null, '', `/vibe-it#${id}`)
  scrollDown()
}

async function newSession() {
  current.value = await api('/vibe/sessions', { method: 'POST', json: {} })
  loadEdits()
  await loadState()
  history.replaceState(null, '', `/vibe-it#${current.value.id}`)
}

async function remove(s: Session) {
  if (!confirm(`Delete “${s.title}”? The published tool, if any, stays.`)) return
  await api(`/vibe/sessions/${s.id}`, { method: 'DELETE' })
  if (current.value?.id === s.id) current.value = null
  await loadState()
}

function scrollDown() { nextTick(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight }) }

async function send() {
  const t = text.value.trim()
  if (!t || sending.value) return
  if (!current.value) await newSession()
  if (dirty.value) await saveFiles()
  sending.value = true; err.value = ''; elapsed.value = 0
  current.value.messages.push({ id: -1, role: 'user', text: t, at: new Date().toISOString() })
  text.value = ''
  scrollDown()
  const started = Date.now()
  timer = window.setInterval(() => (elapsed.value = Math.round((Date.now() - started) / 1000)), 500)
  try {
    current.value = await api(`/vibe/sessions/${current.value.id}/messages`, { method: 'POST', json: { text: t } })
    loadEdits()
  } catch (e) {
    err.value = e instanceof ApiError ? (e.detail?.message || e.message) : 'The connection dropped. Reload to see where the agent got to.'
    if (current.value) current.value = await api(`/vibe/sessions/${current.value.id}`).catch(() => current.value)
  } finally {
    sending.value = false; clearInterval(timer)
    loadState(); scrollDown()
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
}

function parsedFiles(): { files: Draft, bad: string } {
  const files: any = {}
  for (const f of FILES) {
    const raw = (edits.value[f.key] || '').trim()
    if (!raw) continue
    if (f.key === 'manifest' || f.key === 'check') {
      try { files[f.key] = JSON.parse(raw) } catch { return { files, bad: `${f.label} is not valid JSON` } }
    } else files[f.key] = edits.value[f.key]
  }
  return { files, bad: '' }
}

async function saveFiles() {
  const { files, bad } = parsedFiles()
  if (bad) { problem.value = { field: 'file', rule: bad }; checked.value = true; return false }
  const r = await api(`/vibe/sessions/${current.value.id}/draft`, { method: 'PUT', json: files })
  current.value.draft = r.draft
  problem.value = r.problem; checked.value = true; dirty.value = false
  return true
}

async function validate() {
  if (dirty.value) { await saveFiles(); return }
  problem.value = (await api(`/vibe/sessions/${current.value.id}/validate`, { method: 'POST' })).problem
  checked.value = true
}

async function testRun() {
  if (dirty.value && !(await saveFiles())) return
  const b = build(inputs.value, testValues.value)
  testErrors.value = b.errors
  if (Object.keys(b.errors).length) return
  testing.value = true; testResult.value = null
  try { testResult.value = await api(`/vibe/sessions/${current.value.id}/test`, { method: 'POST', json: { inputs: b.body } }) }
  catch (e) { testResult.value = { status: e instanceof ApiError ? e.status : 0, result: e instanceof ApiError ? e.detail : String(e) } }
  testing.value = false
}

async function publishNow() {
  if (dirty.value && !(await saveFiles())) return
  if (!confirm('Publish this tool? Its check.json runs once for real on your team\'s balance.')) return
  publishing.value = true; published.value = null
  try {
    const r = await api(`/vibe/sessions/${current.value.id}/publish`, { method: 'POST' })
    published.value = r
    if (r.result?.tool_id) current.value.tool_id = r.result.tool_id
  } catch (e) { published.value = { status: e instanceof ApiError ? e.status : 0, result: e instanceof ApiError ? e.detail : String(e) } }
  publishing.value = false
  loadState()
}

async function appOn() {
  try { appUrl.value = (await api(`/hub/tools/${current.value.tool_id}/app`, { method: 'PUT', json: {} })).url }
  catch (e) { err.value = e instanceof ApiError ? `App: ${e.detail?.rule || e.message}` : 'App could not be turned on.' }
}

function pickTeam(slug: string) {
  team.value = slug; setTeam(slug)
  try { localStorage.setItem('treg-vibe-team', slug) } catch { /* convenience */ }
  current.value = null
  loadState()
}

const errText = (r: any) => typeof r === 'string' ? r : r?.message || r?.rule || r?.error || JSON.stringify(r)

onMounted(async () => {
  const who = await me()
  if (!who) { state.value = 'signedout'; return }
  email.value = who.email
  myTeams.value = await teams()
  if (!myTeams.value.length) { state.value = 'noteam'; return }
  let saved = ''
  try { saved = localStorage.getItem('treg-vibe-team') || localStorage.getItem('treg-active') || '' } catch { /* none */ }
  const t = myTeams.value.find(x => x.slug === saved) || myTeams.value[0]
  team.value = t.slug; setTeam(t.slug)
  await loadState()
  const id = Number(location.hash.slice(1))
  if (state.value === 'ready' && id) await open(id).catch(() => null)
})
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <div class="sa-page vb">
    <header class="sa-top">
      <a class="sa-brand" href="/app">treg</a>
      <div class="sa-who">
        <span v-if="state === 'ready'" class="sa-muted vb-budget" :title="`Model budget treg gives you: ${usd(budget.left)} of ${usd(budget.budget)} left`">
          Agent budget <b class="sa-num">{{ leftPct }}%</b>
        </span>
        <label v-if="myTeams.length > 1" class="sa-team">Team
          <select :value="team" @change="pickTeam(($event.target as HTMLSelectElement).value)">
            <option v-for="t in myTeams" :key="t.slug" :value="t.slug">{{ t.name || t.slug }}</option>
          </select>
        </label>
        <span v-if="email" class="sa-muted sa-email">{{ email }}</span>
      </div>
    </header>

    <main v-if="state === 'loading'" class="sa-main"><p class="sa-muted" role="status">Loading…</p></main>
    <main v-else-if="state === 'signedout'" class="sa-main sa-narrow">
      <h1>Vibe it</h1>
      <p>Describe a tool in plain words and build it with treg's agent.</p>
      <a class="sa-btn primary" :href="signInUrl()">Sign in to start</a>
    </main>
    <main v-else-if="state === 'noteam'" class="sa-main sa-narrow">
      <h1>Vibe it</h1>
      <p>A tool belongs to a team. <a href="/app">Create a team</a>, then come back here.</p>
    </main>
    <main v-else-if="state === 'off'" class="sa-main sa-narrow">
      <h1>Vibe it</h1>
      <p class="sa-muted">Vibe-it is not available for this team yet.</p>
    </main>

    <div v-else class="vb-grid">
      <nav class="vb-list" aria-label="Conversations">
        <button class="sa-btn primary vb-new" type="button" @click="newSession">New tool</button>
        <ul>
          <li v-for="s in sessions" :key="s.id" :class="{ on: current?.id === s.id }">
            <button type="button" class="vb-item" @click="open(s.id)">
              <span class="vb-item-title">{{ s.title || 'New tool' }}</span>
              <span class="sa-muted vb-item-meta">{{ s.tool_id ? 'published · ' : '' }}{{ when(s.updated_at) }}</span>
            </button>
            <button type="button" class="vb-del" :aria-label="`Delete ${s.title}`" @click="remove(s)">×</button>
          </li>
        </ul>
        <p v-if="!sessions.length" class="sa-muted vb-empty">No conversations yet.</p>
      </nav>

      <section class="vb-chat">
        <div ref="chatEl" class="vb-scroll">
          <div v-if="!current || !current.messages.length" class="vb-intro">
            <h1>What do you want to build?</h1>
            <p class="sa-muted">Describe the tool: what it takes in, what it gives back, who will use it. The agent finds the
              catalog tools for each step, writes the files, test-runs them with you and publishes when you say so.</p>
            <ul class="vb-ideas">
              <li><button type="button" @click="text = 'A tool that takes a company domain and returns its main social links, employee count and a one-line description.'">Company snapshot from a domain</button></li>
              <li><button type="button" @click="text = 'Given a list of emails, tell me which ones are deliverable, as a table.'">Check a list of emails</button></li>
              <li><button type="button" @click="text = 'Find recent Reddit and Hacker News posts that mention my product name.'">Brand mentions</button></li>
            </ul>
          </div>
          <p v-if="current?.summary" class="vb-trimmed sa-muted">Older messages were trimmed; the agent keeps a summary and your files.</p>
          <template v-for="m in current?.messages || []" :key="m.id">
            <div v-if="m.role === 'user'" class="vb-msg user">{{ m.text }}</div>
            <div v-else-if="m.role === 'assistant' && m.text" class="vb-msg agent">{{ m.text }}</div>
            <div v-else-if="m.role === 'tool'" class="vb-step" :class="{ bad: !m.ok }">
              <span aria-hidden="true">{{ m.ok ? '✓' : '!' }}</span> {{ m.summary }}
            </div>
          </template>
          <div v-if="sending" class="vb-step working" role="status">Working… {{ elapsed }}s</div>
        </div>
        <p v-if="err" class="sa-error-text vb-err" role="alert">{{ err }}</p>
        <form class="vb-compose" @submit.prevent="send">
          <textarea v-model="text" rows="3" placeholder="Describe your tool, or answer the agent…" :disabled="sending" @keydown="onKey"/>
          <button class="sa-btn primary" type="submit" :disabled="sending || !text.trim()">{{ sending ? 'Working…' : 'Send' }}</button>
        </form>
      </section>

      <aside class="vb-files">
        <div class="sa-seg vb-panes" role="group" aria-label="Panel">
          <button type="button" :class="{ on: panel === 'files' }" @click="panel = 'files'">Files</button>
          <button type="button" :class="{ on: panel === 'test' }" @click="panel = 'test'">Test &amp; publish</button>
        </div>
        <p v-if="!current" class="sa-muted">Files appear here as the agent writes them.</p>
        <template v-else-if="panel === 'files'">
          <div class="vb-tabs" role="tablist">
            <button v-for="f in visibleFiles" :key="f.key" type="button" role="tab" :aria-selected="tab === f.key"
                    :class="{ on: tab === f.key }" @click="tab = f.key">{{ f.label }}</button>
          </div>
          <textarea v-model="edits[tab]" class="vb-code" spellcheck="false" :placeholder="`${FILES.find(f => f.key === tab)?.label} is empty`"
                    @input="dirty = true; checked = false"/>
          <div class="vb-actions">
            <button class="sa-btn sm" type="button" :disabled="!dirty" @click="saveFiles">Save</button>
            <button class="sa-btn sm" type="button" @click="validate">Validate</button>
            <span v-if="dirty" class="sa-muted">Unsaved changes</span>
            <span v-else-if="checked && !problem" class="sa-ok">Valid</span>
          </div>
          <p v-if="checked && problem" class="sa-error-text"><code>{{ problem.field }}</code>: {{ problem.rule }}</p>
        </template>
        <template v-else>
          <h3>Test run</h3>
          <p class="sa-muted vb-small">Runs the draft for real on {{ team }}'s balance. Nothing is published.</p>
          <InputForm v-model="testValues" :inputs="inputs" :errors="testErrors" :disabled="testing"/>
          <div class="vb-actions">
            <button class="sa-btn sm primary" type="button" :disabled="testing || !draft.manifest" @click="testRun">{{ testing ? 'Running…' : 'Test run' }}</button>
          </div>
          <div v-if="testResult" class="vb-result">
            <template v-if="testResult.status === 200">
              <p class="sa-run-meta"><span class="sa-ok">Done</span> · {{ usd(testResult.result.usage?.cost_micro) }}</p>
              <ResultView :output="testResult.result.output" :fields="outputFields" name="test-run"/>
            </template>
            <p v-else class="sa-error-text">Failed ({{ testResult.status }}): {{ errText(testResult.result) }}</p>
          </div>
          <h3 class="vb-gap">Publish</h3>
          <p class="sa-muted vb-small">check.json runs once for real; the tool goes live on pass, as <code>{{ team }}.{{ draft.manifest?.name || '…' }}</code>.</p>
          <div class="vb-actions">
            <button class="sa-btn sm primary" type="button" :disabled="publishing || !draft.manifest" @click="publishNow">{{ publishing ? 'Publishing…' : current.tool_id ? 'Publish a new version' : 'Publish' }}</button>
          </div>
          <div v-if="published" class="vb-result">
            <template v-if="published.status === 200 || published.status === 201">
              <p><span :class="published.result.status === 'live' ? 'sa-ok' : 'sa-bad'">{{ published.result.status }}</span>
                · <code>{{ published.result.tool_id }}</code> v{{ published.result.version }}</p>
              <p v-if="published.result.page"><a :href="published.result.page" target="_blank" rel="noopener">Tool page</a></p>
              <p v-if="published.result.check?.status === 'failed'" class="sa-error-text">The check failed: {{ errText(published.result.check.error || {}) }}</p>
            </template>
            <p v-else class="sa-error-text">Refused ({{ published.status }}): {{ errText(published.result) }}</p>
          </div>
          <template v-if="current.tool_id">
            <h3 class="vb-gap">App</h3>
            <p class="sa-muted vb-small">A web page where people fill a form and run the tool as their own team.</p>
            <div class="vb-actions">
              <button v-if="!appUrl" class="sa-btn sm" type="button" @click="appOn">Turn on the app</button>
              <a v-else class="sa-btn sm" :href="appUrl" target="_blank" rel="noopener">Open the app</a>
            </div>
          </template>
        </template>
      </aside>
    </div>
  </div>
</template>

<style>
.vb .vb-grid { display:grid; grid-template-columns:240px minmax(0,1fr) minmax(320px,440px); height:calc(100vh - 57px); min-height:0; }
.vb-list { border-right:1px solid var(--line); padding:14px; overflow:auto; }
.vb-new { width:100%; margin-bottom:12px; }
.vb-list ul { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:2px; }
.vb-list li { display:flex; align-items:center; border-radius:8px; }
.vb-list li.on, .vb-list li:hover { background:var(--hover); }
.vb-item { flex:1; min-width:0; text-align:left; border:0; background:none; padding:8px; cursor:pointer; color:var(--ink); display:flex; flex-direction:column; gap:2px; }
.vb-item-title { font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vb-item-meta { font-size:11.5px; }
.vb-del { border:0; background:none; color:var(--muted); cursor:pointer; font-size:16px; padding:4px 8px; visibility:hidden; }
.vb-list li:hover .vb-del, .vb-del:focus-visible { visibility:visible; }
.vb-empty { font-size:13px; }
.vb-chat { display:flex; flex-direction:column; min-width:0; min-height:0; }
.vb-scroll { flex:1; overflow:auto; padding:24px 28px; display:flex; flex-direction:column; gap:10px; }
.vb-intro { max-width:620px; margin:40px auto 0; }
.vb-ideas { list-style:none; padding:0; display:flex; flex-direction:column; gap:8px; margin-top:16px; }
.vb-ideas button { border:1px solid var(--line2); background:var(--surface); border-radius:10px; padding:10px 12px; text-align:left; width:100%; cursor:pointer; font:13px var(--sans); color:var(--ink); }
.vb-ideas button:hover { background:var(--hover); }
.vb-msg { max-width:760px; padding:10px 14px; border-radius:14px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.55; }
.vb-msg.user { align-self:flex-end; background:var(--inverse); color:var(--inverse-ink); border-bottom-right-radius:4px; }
.vb-msg.agent { align-self:flex-start; background:var(--surface); border:1px solid var(--line); border-bottom-left-radius:4px; }
.vb-step { align-self:flex-start; font:12.5px var(--mono); color:var(--muted); padding:0 4px; }
.vb-step span { color:var(--ok); }
.vb-step.bad span { color:var(--bad); }
.vb-step.working { color:var(--ink); }
.vb-trimmed { font-size:12.5px; text-align:center; }
.vb-err { padding:0 28px; }
.vb-compose { display:flex; gap:10px; align-items:flex-end; padding:14px 28px 20px; border-top:1px solid var(--line); }
.vb-compose textarea { resize:none; }
.vb-files { border-left:1px solid var(--line); padding:14px; overflow:auto; display:flex; flex-direction:column; gap:10px; min-width:0; }
.vb-panes { align-self:flex-start; }
.vb-tabs { display:flex; gap:2px; flex-wrap:wrap; }
.vb-tabs button { border:0; background:none; padding:5px 10px; border-radius:8px; font:12px var(--mono); color:var(--muted); cursor:pointer; }
.vb-tabs button.on { background:var(--panel2); color:var(--ink); }
.vb-code { flex:1; min-height:320px; font:12px/1.55 var(--mono); white-space:pre; resize:vertical; }
.vb-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.vb-small { font-size:12.5px; margin:0; }
.vb-gap { margin-top:14px; }
.vb-result { border:1px solid var(--line); border-radius:10px; padding:12px; }
.vb-budget b { color:var(--ink); }
@media (max-width: 1100px) { .vb .vb-grid { grid-template-columns:minmax(0,1fr); height:auto; } .vb-list, .vb-files { border:0; } .vb-scroll { min-height:50vh; } }
</style>
