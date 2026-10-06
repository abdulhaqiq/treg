<script setup>
// The values of one list filter, as chips. `search`: pick from a list, typed to find (local options
// or a treg lookup); `tags`: free words, with the options as suggestions.
import { computed, inject, onMounted, ref, watch } from 'vue'
import { COUNTRIES } from './countries.js'
import { LOOKUPS } from './jobs.js'

const props = defineProps({ filter: Object, modelValue: Array, inputId: String })
const emit = defineEmits(['update:modelValue'])
const api = inject('oeApi')

const LOCAL = { countries: COUNTRIES, countryNames: COUNTRIES.map((c) => ({ value: c.label, label: c.label })) }
const local = Array.isArray(props.filter.options) ? props.filter.options : LOCAL[props.filter.options] || null
const lookup = props.filter.lookup ? LOOKUPS[props.filter.lookup] : null

const text = ref('')
const open = ref(false)
const remote = ref([])
const loading = ref(false)
const all = ref(null)          // a `once` lookup's whole list
const items = computed(() => props.modelValue || [])
const key = (x) => JSON.stringify(x && typeof x === 'object' ? x.value : x)
const chosen = computed(() => new Set(items.value.map(key)))

let timer = null
async function fetchRemote() {
  if (!lookup) return
  if (lookup.once) {
    if (!all.value) {
      loading.value = true
      try { all.value = lookup.read(await api.lookup(lookup.tool)) } catch { all.value = [] } finally { loading.value = false }
    }
    return
  }
  const q = text.value.trim()
  if (q.length < 2) { remote.value = []; return }
  loading.value = true
  try { remote.value = lookup.read(await api.lookup(lookup.tool, lookup.query(q))) } catch { remote.value = [] } finally { loading.value = false }
}
watch(text, () => { clearTimeout(timer); timer = setTimeout(fetchRemote, 220) })
onMounted(() => { if (lookup?.once) fetchRemote() })

const suggestions = computed(() => {
  const q = text.value.trim().toLowerCase()
  const pool = local || all.value || remote.value
  const hits = (local || all.value) ? pool.filter((o) => !q || o.label.toLowerCase().includes(q)) : pool
  return hits.filter((o) => !chosen.value.has(key(o))).slice(0, 40)
})

function add(item) {
  if (!chosen.value.has(key(item))) emit('update:modelValue', [...items.value, item])
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
      <span v-for="x in items" :key="key(x)" class="tagv">{{ label(x) }}
        <button type="button" title="Remove" @mousedown.prevent @click.stop="remove(x)">×</button>
      </span>
      <input :id="inputId" v-model="text" :placeholder="items.length ? '' : filter.placeholder || (filter.type === 'search' ? 'Search…' : 'Type and press Enter')"
             autocomplete="off" @focus="open = true" @input="open = true" @keydown.enter.prevent="enter"
             @keydown.,.prevent="filter.type === 'tags' && enter()" @keydown.backspace="back" @keydown.esc="open = false" />
    </div>
    <div v-if="open && (suggestions.length || loading || (filter.type === 'search' && text.trim().length > 1))" class="suggest">
      <p v-if="loading" class="muted small">Searching…</p>
      <button v-for="o in suggestions" :key="key(o)" type="button" class="sugg-item" @mousedown.prevent @click="add(o)">{{ o.label }}</button>
      <p v-if="!loading && !suggestions.length" class="muted small">No match. Try another word.</p>
    </div>
  </div>
</template>
