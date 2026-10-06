<script setup>
// The providers behind a routed tool (a search, or an enrichment column), as logos. Hovering one
// shows its price for this many rows, how it bills, how often it works, what it needs and the
// filters it applies; clicking picks it, and with any picked the tool asks only those. Used by the
// search panel and the add-column panel.
import { computed, inject, ref, watch } from 'vue'
import { usd } from './jobs.js'

const props = defineProps({
  tool: Object,                                   // the routed tool's catalog entry (its routing plan)
  rows: { type: Number, default: 1 },             // results a search asks for; 1 for an enrichment row
  used: { type: Array, default: () => [] },       // filter fields this search sets
  labels: { type: Object, default: () => ({}) },  // field -> the builder's name for it
  have: { type: Array, default: null },           // inputs an enrichment column fills (null: a search)
  cap: { type: Number, default: 0.25 },
  noun: { type: String, default: 'search' },
  modelValue: { type: Array, default: () => [] }, // provider slugs picked; none = auto
})
const emit = defineEmits(['update:modelValue', 'cards'])
const api = inject('oeApi')

// each provider endpoint's catalog entry (billing, name), read once per page
const endpoints = ref({})
const seen = new Map()
watch(() => props.tool, async (tool) => {
  const ids = [...new Set((tool?.routing?.plan || []).map((c) => c.endpoint_id))]
  const got = await Promise.all(ids.map((id) => {
    if (!seen.has(id)) seen.set(id, api.tool(id).then((t) => t?.endpoint || null).catch(() => null))
    return seen.get(id).then((e) => [id, e])
  }))
  endpoints.value = Object.fromEntries(got)
}, { immediate: true })

const picked = computed(() => new Set(props.modelValue))
function toggle(slug) {
  const next = new Set(picked.value)
  if (next.has(slug)) next.delete(slug); else next.add(slug)
  emit('update:modelValue', [...next])
}

// One card per provider (its cheapest endpoint)
const cards = computed(() => {
  const n = props.rows || 0
  const out = {}
  for (const row of props.tool?.routing?.plan || []) {
    const slug = row.endpoint_id.split('.')[0]
    const ep = endpoints.value[row.endpoint_id]
    const c = ep?.cost || {}
    const unit = c.type === 'free' ? 0 : c.usd ?? row.usd ?? 0
    const perResult = c.type === 'per_result'
    const cost = perResult ? unit * n : unit
    const takes = (row.filters || []).filter((k) => props.labels[k])
    const missing = props.used.filter((k) => !(row.filters || []).includes(k))
    // an enrichment: a provider none of whose input sets the column fills cannot answer it
    const needs = (row.accepts || []).map((v) => v.join(' + '))
    const unfed = props.have && !(row.accepts || []).some((v) => v.every((k) => props.have.includes(k)))
    const card = {
      slug, name: ep?.provider_display || slug, cost, unit, perResult, works: row.works,
      overCap: !picked.value.size && cost > props.cap,
      billing: c.type === 'free' ? 'free' : `${usd(unit * 1e6)} per ${perResult ? 'result' : props.noun === 'search' ? 'search' : 'row'}`,
      takes: [...new Set(takes.map((k) => props.labels[k]))].sort((x, y) =>
        props.used.some((k) => props.labels[k] === y) - props.used.some((k) => props.labels[k] === x)),
      using: new Set(props.used.filter((k) => takes.includes(k)).map((k) => props.labels[k])),
      skipped: [...new Set(missing.map((k) => props.labels[k] || k))],
      needs, unfed,
    }
    if (!out[slug] || card.cost < out[slug].cost) out[slug] = card
  }
  return Object.values(out)
})
watch(cards, (c) => emit('cards', c), { immediate: true })
const pickedNames = computed(() => cards.value.filter((c) => picked.value.has(c.slug)).map((c) => c.name))
const price = (c) => (c.cost === 0 ? `Free${props.rows > 1 ? ` for ${props.rows} results` : ''}`
  : props.rows > 1 ? `~${usd(c.cost * 1e6)} for ${props.rows} results · ${c.billing}` : c.billing)
</script>

<template>
  <div v-if="cards.length" class="vendors-row">
    <span class="fb-label">{{ picked.size ? `${picked.size} of ${cards.length} providers picked` : `${cards.length} providers behind this ${noun}` }}</span>
    <span class="vendors wide">
      <span v-for="c in cards" :key="c.slug" :class="['vendor', { off: c.skipped.length || c.overCap || c.unfed, picked: picked.has(c.slug) }]"
            tabindex="0" role="button" :aria-pressed="picked.has(c.slug)" @click="toggle(c.slug); $event.currentTarget.blur()" @keydown.enter="toggle(c.slug)">
        <img :src="`/logos/${c.slug}.svg`" :alt="c.name" @error="$event.target.style.visibility = 'hidden'" />
        <span class="vcard">
          <strong>{{ c.name }}</strong>
          <span>{{ price(c) }}</span>
          <span v-if="c.works != null" class="muted">Works on {{ Math.round(c.works * 100) }}% of calls</span>
          <span v-if="c.overCap" class="warn">Over the {{ usd(cap * 1e6) }} cap: not asked</span>
          <span v-if="c.skipped.length" class="warn">Skipped: does not apply {{ c.skipped.join(', ') }}</span>
          <span v-if="c.unfed" class="warn">Skipped: needs {{ c.needs.join(' or ').replace(/_/g, ' ') }}</span>
          <template v-if="have && !c.unfed && c.needs.length">
            <span class="vlabel">Needs</span><span class="muted">{{ c.needs.join(' or ').replace(/_/g, ' ') }}</span>
          </template>
          <template v-if="c.takes.length">
            <span class="vlabel">Applies</span>
            <span class="vfilters">
              <span v-for="t in c.takes.slice(0, 8)" :key="t" :class="{ on: c.using.has(t) }">{{ t }}</span>
              <span v-if="c.takes.length > 8" class="more-n">+{{ c.takes.length - 8 }} more</span>
            </span>
          </template>
          <span class="muted vhint">{{ picked.has(c.slug) ? 'Click to stop using it' : 'Click to use only the providers you pick' }}</span>
        </span>
      </span>
    </span>
    <small v-if="!picked.size" class="muted">Auto: treg asks them in turn, cheapest first; the first with an answer {{ noun === 'search' ? 'fills the preview' : 'fills the row' }}. Click logos to use only the ones you pick.</small>
    <small v-else class="muted picked-line">Using only {{ pickedNames.join(', ') }} ·
      <a href="#" @click.prevent="emit('update:modelValue', [])">back to auto</a></small>
  </div>
</template>
