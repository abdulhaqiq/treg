<script setup>
// The values of one list filter, as chips. `search`: pick from a list, typed to find (local options
// or a treg lookup); `tags`: free words, with the options as suggestions.
import { computed, inject, onMounted, ref, watch } from 'vue'
import { COUNTRIES } from './countries.js'
import { LOOKUPS, lookupRetries, typoScore } from './jobs.js'

const props = defineProps({ filter: Object, modelValue: Array, inputId: String })
// `elsewhere`: a suggestion that belongs to another filter (an industry search's description keyword)
const emit = defineEmits(['update:modelValue', 'elsewhere'])
const api = inject('oeApi')

const LOCAL = { countries: COUNTRIES, countryNames: COUNTRIES.map((c) => ({ value: c.label, label: c.label })) }
const local = Array.isArray(props.filter.options) ? props.filter.options : LOCAL[props.filter.options] || null
const lookup = props.filter.lookup ? LOOKUPS[props.filter.lookup] : null
// no value of this list matches: what the words could be in another filter (an AI company is a
// description keyword, not an industry); picking one adds it there
const fallback = props.filter.fallback ? { ...props.filter.fallback, ...LOOKUPS[props.filter.fallback.lookup] } : null
const extra = ref([])
let asked = 0                  // the latest text asked about: an older answer arriving late is dropped

const text = ref('')
const open = ref(false)
const remote = ref([])
const listLoading = ref(false)    // a `once` list on its way
const searching = ref(false)      // the latest text's lookups on their way
const loading = computed(() => listLoading.value || searching.value)
const all = ref(null)          // a `once` lookup's whole list
const items = computed(() => props.modelValue || [])
// an item is known by its label and field: several industries share the same NAICS codes
const key = (x) => (x && typeof x === 'object' ? `${x.elsewhere || ''}:${x.label}` : String(x))
const chosen = computed(() => new Set(items.value.map(key)))

let timer = null
async function fetchRemote() {
  if (!lookup) return
  if (lookup.once) {
    if (!all.value && !listLoading.value) {
      listLoading.value = true
      try { all.value = lookup.read(await api.lookup(lookup.tool)) } catch { all.value = [] } finally { listLoading.value = false }
    }
    return
  }
  const q = text.value.trim()
  if (q.length < 2) { remote.value = []; return }
  const mine = asked
  const got = await forgiving(lookup, q)
  if (mine === asked) remote.value = got
}
// ask the lookup for what was typed; nothing back (a typo), ask again word by word and keep what
// is close to the typed text
async function forgiving(l, q) {
  const ask = async (t) => { try { return l.read(await api.lookup(l.tool, l.query(t))) } catch { return [] } }
  const first = await ask(q)
  if (first.length) return first
  const found = new Map()
  for (const list of await Promise.all(lookupRetries(q).map(ask))) for (const o of list) found.set(o.label, o)
  return [...found.values()].map((o) => [typoScore(q, o.label), o]).filter(([d]) => d != null).sort((a, b) => a[0] - b[0]).map(([, o]) => o)
}
async function fetchFallback() {
  const q = text.value.trim()
  if (!fallback || q.length < 3 || matches.value.length) return []
  return (await forgiving(fallback, q)).map((o) => ({ ...o, elsewhere: fallback.filter }))
}
watch(text, () => {
  clearTimeout(timer)
  extra.value = []
  const mine = ++asked
  searching.value = text.value.trim().length >= 2 && !!(lookup || fallback)
  timer = setTimeout(async () => {
    try {
      await fetchRemote()
      const more = await fetchFallback()
      if (mine === asked) extra.value = more
    } finally { if (mine === asked) searching.value = false }
  }, 220)
})
onMounted(() => { if (lookup?.once) fetchRemote() })

// every typed word, in any order
const matches = computed(() => {
  const words = text.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const pool = local || all.value || remote.value
  // a local list: every word, in any order, a typo forgiven, closest first
  const hits = (local || all.value)
    ? pool.map((o) => [words.length ? typoScore(text.value, o.label) : 0, o]).filter(([d]) => d != null).sort((a, b) => a[0] - b[0]).map(([, o]) => o)
    : pool
  const seen = new Set()
  return hits.filter((o) => !chosen.value.has(key(o)) && !seen.has(key(o)) && seen.add(key(o)))
})
const suggestions = computed(() => [...matches.value, ...extra.value.filter((o) => !chosen.value.has(key(o)))].slice(0, 40))

function add(item) {
  if (item.elsewhere) emit('elsewhere', item.elsewhere, { value: item.value, label: item.label })
  else if (!chosen.value.has(key(item))) emit('update:modelValue', [...items.value, item])
  text.value = ''
}
function remove(item) {
  emit('update:modelValue', items.value.filter((x) => key(x) !== key(item)))
}
// Enter: the first suggestion in a list; a typed word in tags
function enter() {
  if (props.filter.type === 'tags') {
    for (const w of text.value.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean)) add(w)
  } else if (suggestions.value.length) add(suggestions.value[0])
}
function back() {
  if (!text.value && items.value.length) remove(items.value[items.value.length - 1])
}
const label = (x) => (x && typeof x === 'object' ? x.label : x)
</script>

<template>
  <div class="picker-field" @focusout="open = false">
    <div class="tagbox" @click="$event.currentTarget.querySelector('input').focus()">
      <span v-for="x in items" :key="key(x)" class="tagv" :title="label(x)"><span class="tagv-text">{{ label(x) }}</span>
        <button type="button" title="Remove" @mousedown.prevent @click.stop="remove(x)">×</button>
      </span>
      <input :id="inputId" v-model="text" :placeholder="items.length ? '' : filter.placeholder || (filter.type === 'search' ? 'Search…' : 'Type and press Enter')"
             autocomplete="off" @focus="open = true" @input="open = true" @keydown.enter.prevent="enter"
             @keydown.,.prevent="filter.type === 'tags' && enter()" @keydown.backspace="back" @keydown.esc="open = false" />
    </div>
    <div v-if="open && (suggestions.length || loading || (filter.type === 'search' && text.trim().length > 1))" class="suggest">
      <p v-if="loading" class="muted small">Searching…</p>
      <p v-if="!loading && !matches.length && extra.length" class="muted small">No {{ filter.label.toLowerCase() }} by that name. Add as {{ fallback.note }}:</p>
      <button v-for="o in suggestions" :key="key(o)" type="button" class="sugg-item" @mousedown.prevent @click="add(o)">{{ o.label }}</button>
      <p v-if="!loading && !suggestions.length" class="muted small">No match. Try another word.</p>
    </div>
  </div>
</template>
