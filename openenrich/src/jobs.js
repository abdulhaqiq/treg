// What a user can do, and the pure helpers behind it (mapping inputs, reading answers, CSV).
// No Vue and no fetch here, so `npm test` covers it with node alone.

export const SOURCES = [
  {
    id: 'companies', label: 'Find companies', kind: 'companies', tool: 'treg.companies.search',
    // tomba answers a filtered search with the same big-company list, ignoring country and limit
    exclude: ['tomba'],
    hint: 'Filter by industry, technology or country',
    // no free-text field: treg sends a description to one provider only, with thin rows
    fields: [
      { name: 'industry', label: 'Industry', placeholder: 'Software' },
      { name: 'technology', label: 'Uses technology', placeholder: 'Stripe' },
      { name: 'country', label: 'Country', placeholder: 'US (ISO code)' },
      { name: 'name', label: 'Company name', placeholder: 'Acme' },
    ],
  },
  {
    id: 'people', label: 'Find people', kind: 'people', tool: 'treg.people.search',
    hint: 'Filter by job title, company or location',
    fields: [
      { name: 'title', label: 'Job title', placeholder: 'Head of Growth' },
      { name: 'company_domain', label: 'Company domain', placeholder: 'ramp.com' },
      { name: 'location', label: 'Location', placeholder: 'London, United Kingdom' },
      { name: 'country', label: 'Country', placeholder: 'GB (ISO code)' },
      { name: 'q', label: 'Keywords', placeholder: 'fintech, payments' },
    ],
  },
  {
    id: 'similar', label: 'Lookalikes of…', kind: 'companies', tool: 'treg.companies.similar',
    hint: 'Companies like one you already know', noLimit: true,
    fields: [{ name: 'domain', label: 'Company domain', placeholder: 'ramp.com' }],
  },
]

export const COLUMN_JOBS = [
  { id: 'people_at', group: 'People', label: 'Find people at company', tool: 'treg.people.search', linked: true,
    note: 'Writes the people to a new table, linked to this one' },
  { id: 'email', group: 'Contact info', label: 'Find work email', tool: 'treg.people.email.find', keep: ['email', 'verified'] },
  { id: 'verify', group: 'Contact info', label: 'Verify email', tool: 'treg.people.email.verify', keep: ['valid', 'status'] },
  { id: 'phone', group: 'Contact info', label: 'Find mobile phone', tool: 'treg.people.phone.find', keep: ['phone', 'line_type'] },
  { id: 'company', group: 'Enrich', label: 'Enrich company', tool: 'treg.companies.enrich',
    keep: ['description', 'industry', 'employees', 'founded', 'location'] },
  { id: 'person', group: 'Enrich', label: 'Enrich person', tool: 'treg.people.enrich', keep: ['title', 'company', 'location', 'linkedin_url'] },
]

// Every people and company enrichment in the catalog: the capabilities on its "People & contact
// data" and "Company data" shelves that answer one row at a time. Where treg runs a capability
// across several providers (`treg.<capability>`) that is the one entry; otherwise each provider's
// endpoint is listed. List building (searches), filter helpers, counts, bulk jobs, exports and
// feeds are not row enrichments and stay out.
const NOT_PER_ROW = [
  /^(people|companies)\.search(\.|$)/, /^companies\.businesses\.search/, /^people\.lookalike$/,
  /\.(autocomplete|count|filters|fields|feed|detail|taxonomy)$/,
  /\.(bulk|export|job|segment|deny-rules|geo|audience|audiences|lists|technologies)(\.|$)/,
  /^companies\.(lookup|id\.resolve|industries\.list|industry\.resolve|coverage\.check|investors\.portfolio|launch_posts|tech_stack\.users)$/,
  // company data, but about the website's design or payments, not the account
  /^companies\.(brand\.fonts|brand\.styleguide|website\.screenshot|transaction\.identify|tech_stack\.detection)$/,
  /^people\.(preview|email\.disposable)$/,
]
export const ENRICH_SHELVES = [['people', 'People'], ['companies', 'Company']]

export function enrichmentJobs(shelves, routed) {
  const popular = new Set(COLUMN_JOBS.map((j) => j.tool))
  const out = []
  for (const [group, platform] of shelves) {
    for (const cap of platform?.capabilities || []) {
      if (NOT_PER_ROW.some((re) => re.test(cap.id))) continue
      const about = cap.description.replace(/\.$/, '')
      const label = cap.title || about                       // the catalog's short shelf title
      const best = routed.get(`treg.${cap.id}`)
      if (best) {
        const logos = [...new Set(cap.endpoints.map((ep) => ep.provider))]
        if (!popular.has(best.id)) out.push({ id: best.id, tool: best.id, cap: cap.id, group, label, about, price: best.cost?.usd, logos })
        continue
      }
      // no treg route yet: one entry, the providers to pick from, cheapest first
      const providers = cap.endpoints
        .filter((ep) => !/^poll\b/i.test(ep.name || ''))   // the second half of an async job, not a row call
        .map((ep) => ({ id: ep.id, slug: ep.provider, name: ep.provider_display || ep.provider, endpoint: ep.name, price: ep.cost?.usd }))
        .sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity))
      if (!providers.length) continue
      const logos = [...new Set(providers.map((p) => p.slug))]
      out.push({ id: cap.id, tool: providers[0].id, cap: cap.id, group, label, about, price: providers[0].price, providers, logos })
    }
  }
  return out
}
export const CATEGORY_ORDER = ['Popular', 'People', 'Company']

// Column names that can feed each input, best first.
const ALIASES = {
  domain: ['domain', 'company_domain', 'website', 'company_website', 'url'],
  company_domain: ['company_domain', 'domain', 'website', 'company_website', 'url'],
  full_name: ['full_name', 'person', 'person_name', 'contact_name'],
  first_name: ['first_name', 'firstname'],
  last_name: ['last_name', 'lastname', 'surname'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin_profile'],
  // single-provider tools name the same inputs their own way
  profile_url: ['linkedin_url', 'linkedin', 'linkedin_profile'],
  linkedin_profile_url: ['linkedin_url', 'linkedin', 'linkedin_profile'],
  company_id_or_domain: ['domain', 'company_domain', 'website'],
  website_url: ['website', 'domain', 'company_domain', 'url'],
  email_address: ['email', 'work_email'],
  email: ['email', 'work_email'],
  website: ['website', 'company_website', 'url', 'domain'],
  name: ['name', 'company_name', 'company'],
}
const HOST_INPUTS = new Set(['domain', 'company_domain', 'company_id_or_domain'])

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

// Every identity input a column can feed: {input: '{column id}'}. Routed jobs want everything you
// know (treg derives the rest), so all matches are sent, not only one alternative.
export function autoMap(identity, columns, tableKind) {
  const byName = new Map(columns.map((c) => [norm(c.label || c.id), c.id]))
  const mapping = {}
  for (const input of new Set(identity.flat())) {
    let names = ALIASES[input] || [input]
    if (input === 'full_name' && tableKind === 'people') names = [...names, 'name']
    if (input === 'name' && tableKind === 'people') names = names.filter((n) => n !== 'name')
    const hit = names.find((n) => byName.has(n))
    if (hit) mapping[input] = `{${byName.get(hit)}}`
  }
  return mapping
}

export function cellValue(cell) {
  return cell && typeof cell === 'object' ? cell.value : cell
}

export function host(value) {
  const s = String(value || '').trim()
  if (!s) return ''
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, '') } catch { return s }
}

// A row's inputs from a mapping like {domain: '{website}', title: 'founder'}. Empty inputs drop out.
export function fillInputs(mapping, row) {
  const out = {}
  for (const [input, template] of Object.entries(mapping)) {
    let v = String(template ?? '').replace(/\{([^}]+)\}/g, (_, id) => {
      const value = cellValue(row.cells[id])
      return value == null ? '' : String(value)
    }).trim()
    if (HOST_INPUTS.has(input)) v = host(v)
    if (v) out[input] = v
  }
  return out
}

// Does a row have every input of at least one identity alternative?
export function satisfies(identity, inputs) {
  return !identity.length || identity.some((alt) => alt.every((k) => inputs[k]))
}

// One /table/ answer (as the local API returns it) read as {state, rows, error}.
export function readAnswer(r) {
  const a = r.answer || {}
  const d = a.detail && typeof a.detail === 'object' ? a.detail : a
  // treg answers 402 for two reasons: only a short balance stops the run
  if (r.status === 402 && d.error === 'insufficient_balance') {
    return { state: 'stop', low: true, error: 'Your treg balance is too low for the next row. Top up at treg.to, then run the column again.' }
  }
  if (r.status === 402 && d.error === 'route_max_cost') {
    return { state: 'error', error: 'Every provider left would cost more than the $0.25 row cap. Nothing was charged.' }
  }
  if (r.status === 401) return { state: 'stop', error: 'treg rejected the token. Check TREG_TOKEN.' }
  if (r.status >= 400 || a.error) {
    const why = a.error === 'upstream_error' ? `provider answered ${a.upstream_status}`
      : d.message || (typeof a.detail === 'string' ? a.detail : '') || d.error || a.error || `HTTP ${r.status}`
    return { state: 'error', error: String(why), retry: r.status === 429 }
  }
  const rows = (a.rows || []).map((row) => Object.fromEntries((a.columns || []).map((c, i) => [c, row[i]])))
  if (a._treg?.outcome === 'miss' || !rows.length) return { state: 'miss', rows: [], columns: [] }
  return { state: 'hit', rows, columns: a.columns || [] }
}

// The most one routed call may spend (sent as X-Treg-Route-Max-Cost): the waterfall stops before a
// provider that would pass it, so a row never reaches the few dollar-a-call providers.
export const ROUTE_CAP_USD = 0.25

// A call's price range for the inputs a row will send. Routed: from the cheapest provider that
// accepts those inputs, up to the cap. Anything else: its listed price.
export function priceOf(tool, keys = null) {
  const cost = tool?.endpoint?.cost
  const plan = (tool?.routing?.plan || [])
    .filter((p) => !keys || !p.accepts || p.accepts.some((alt) => alt.every((k) => keys.includes(k))))
  if (tool?.endpoint?.kind === 'routed') {
    const prices = plan.map((p) => Number(p.usd_per_hit ?? p.usd) || 0)
    return { min: prices.length ? Math.min(...prices) : 0, max: ROUTE_CAP_USD, cap: ROUTE_CAP_USD, known: prices.length > 0 }
  }
  const usdEach = Number(cost?.usd) || 0
  return { min: usdEach, max: usdEach, known: !!cost }
}

export function identityOf(tool) {
  return tool?.routing?.contract?.identity || []
}

export function outputsOf(tool) {
  return Object.keys(tool?.routing?.contract?.output || {})
}

// One cell from a list answer (a company's technologies, its funding rounds): every row's value,
// joined, so a cell holds the whole list rather than its first item.
export function cellFrom(rows, field) {
  const values = rows.map((r) => r[field]).filter((v) => v != null && v !== '')
  if (values.length <= 1) return values[0] ?? null
  return [...new Set(values.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))))].join(', ')
}

export const usd = (micro) => `$${(micro / 1e6).toFixed(micro && micro < 10000 ? 4 : 2)}`

// --- CSV -----------------------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [[]]
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') { rows.at(-1).push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      rows.at(-1).push(field); field = ''; rows.push([])
    } else field += c
  }
  rows.at(-1).push(field)
  return rows.filter((r) => r.some((v) => v !== ''))
}

export function toCsv(columns, rows) {
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [columns.map((c) => esc(c.label)), ...rows.map((r) => columns.map((c) => esc(cellValue(r.cells[c.id]))))]
    .map((line) => line.join(',')).join('\n')
}

// --- tables --------------------------------------------------------------------------------------

let seq = 0
export const rowId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`

export function slug(s) {
  return norm(s).replace(/_/g, '-').slice(0, 60) || 'table'
}

export function uniqueColumnId(columns, wanted) {
  const ids = new Set(columns.map((c) => c.id))
  let id = norm(wanted) || 'column'
  for (let n = 2; ids.has(id); n++) id = `${norm(wanted)}_${n}`
  return id
}

// The columns a list search keeps: the fixed ones (name, domain… or first_name, title…), which
// treg puts first for people and companies, then the provider's own fields only when they are few.
export const FIXED = {
  companies: ['name', 'domain', 'industry', 'employees', 'location', 'linkedin_url'],
  people: ['first_name', 'last_name', 'title', 'company', 'linkedin_url', 'location'],
}
export function keptColumns(kind, columns) {
  const fixed = FIXED[kind]
  return fixed && fixed.every((c) => columns.includes(c)) ? fixed : columns.filter((c) => c !== 'served_by').slice(0, 12)
}

// Useful fields some providers add beyond the fixed columns, under the names they use.
const EXTRA = {
  people: { full_name: ['full_name', 'fullName', 'name', 'basic_profile.name', 'person.full_name', 'profile.full_name'],
            email: ['email', 'person.email.email', 'work_email'] },
  companies: { description: ['description', 'overview', 'company.description', 'descriptions.primary', 'one_liner'] },
}

// List rows as a table's records: the fixed columns plus the extras any row has, duplicates (same
// domain, LinkedIn or name) dropped, at most `limit` rows (some providers ignore the limit).
export function listRecords(kind, rows, columns, limit = Infinity) {
  const extra = EXTRA[kind] || {}
  const recs = rows.map((r) => {
    const rec = Object.fromEntries(keptColumns(kind, columns).map((c) => [c, r[c] ?? null]))
    for (const [name, paths] of Object.entries(extra)) {
      const hit = paths.map((p) => r[p]).find((v) => typeof v === 'string' && v.trim())
      if (hit) rec[name] = hit
    }
    if (kind === 'people' && !rec.full_name && (rec.first_name || rec.last_name)) {
      rec.full_name = [rec.first_name, rec.last_name].filter(Boolean).join(' ')
    }
    return rec
  })
  const seen = new Set()
  const out = []
  for (const rec of recs) {
    const key = String(rec.domain || rec.linkedin_url || rec.full_name || rec.name || '').toLowerCase()
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    out.push(rec)
    if (out.length >= limit) break
  }
  const ids = [...keptColumns(kind, columns)]
  for (const name of Object.keys(extra)) if (out.some((r) => r[name])) ids.splice(kind === 'people' && name === 'full_name' ? 0 : ids.length, 0, name)
  return { records: out, ids }
}

// A table built from list rows (a source search, or one parent's people).
export function tableFromRows(name, kind, records, ids, extra = {}) {
  return {
    name, kind, parent: null, ...extra,
    columns: ids.map((id) => ({ id, label: id })),
    // a provider that gives a homepage URL as the domain is shown as the bare host
    rows: records.map((r) => ({ id: rowId(), cells: Object.fromEntries(ids.map((id) => [id, id === 'domain' && r[id] ? host(r[id]) : r[id] ?? null])) })),
  }
}
