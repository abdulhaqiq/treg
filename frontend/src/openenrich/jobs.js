// What a user can do, and the pure helpers behind it (mapping inputs, reading answers, CSV).
// No Vue and no fetch here, so `npm test` covers it with node alone.

export const SOURCES = [
  {
    id: 'companies', label: 'Find companies', kind: 'companies', tool: 'treg.companies.search',
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

// Signals: what makes a row worth contacting now (the /leads-signals sources). Some sit on the
// people and company shelves; the rest live on other platforms and are fetched from those shelves.
const SIGNAL_CAPS = new Set([
  'people.signals', 'companies.jobs', 'companies.jobs.search', 'companies.funding', 'companies.funding_rounds',
  'companies.news', 'companies.headcount_trend', 'companies.tech_stack', 'companies.signals',
  'companies.website_evolution', 'companies.acquisitions', 'companies.reviews',
])
export const SIGNAL_EXTRAS = [
  'linkedin.company.posts', 'linkedin.user.posts', 'x.user.posts', 'meta-ads.library.advertiser',
  'google.ads.transparency', 'linkedin.search.ads', 'tiktok-ads.library.search', 'trustpilot.business.reviews',
]
// a platform shelf for the extras: only those capabilities, and only their per-company endpoints
export function signalShelf(platforms) {
  const capabilities = []
  for (const p of platforms) {
    for (const cap of p?.capabilities || []) {
      if (!SIGNAL_EXTRAS.includes(cap.id)) continue
      capabilities.push({ ...cap, endpoints: cap.endpoints.filter((ep) => !/by keyword/i.test(ep.name || '')) })
    }
  }
  return { capabilities }
}

export function enrichmentJobs(shelves, routed) {
  const popular = new Set(COLUMN_JOBS.map((j) => j.tool))
  const out = []
  for (const [shelf, platform] of shelves) {
    for (const cap of platform?.capabilities || []) {
      let group = shelf
      if (NOT_PER_ROW.some((re) => re.test(cap.id))) continue
      const about = cap.description.replace(/\.$/, '')
      const label = cap.title || about                       // the catalog's short shelf title
      if (SIGNAL_CAPS.has(cap.id) || SIGNAL_EXTRAS.includes(cap.id)) group = 'Signals'
      const best = routed.get(`treg.${cap.id}`)
      if (best) {
        const logos = [...new Set(cap.endpoints.map((ep) => ep.provider))]
        if (!popular.has(best.id)) out.push({ id: best.id, tool: best.id, cap: cap.id, group, label, about, price: best.cost?.usd, logos })
        continue
      }
      // no treg route yet: one entry, the providers to pick from, cheapest first
      const providers = cap.endpoints
        .filter((ep) => !/^poll\b/i.test(ep.name || ''))   // the second half of an async job, not a row call
        .filter(rowCallable)
        .map((ep) => ({ id: ep.id, slug: ep.provider, name: ep.provider_display || ep.provider, endpoint: ep.name, price: ep.cost?.usd }))
        .sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity))
      if (!providers.length) continue
      // the same job filed under two capability ids (funding vs funding_rounds) is one entry
      const twin = out.find((j) => j.providers && j.group === group && j.label === label)
      if (twin) {
        twin.providers = [...twin.providers, ...providers].sort((x, y) => (x.price ?? Infinity) - (y.price ?? Infinity))
        twin.logos = [...new Set(twin.providers.map((p) => p.slug))]
        Object.assign(twin, { tool: twin.providers[0].id, price: twin.providers[0].price })
        continue
      }
      const logos = [...new Set(providers.map((p) => p.slug))]
      out.push({ id: cap.id, tool: providers[0].id, cap: cap.id, group, label, about, price: providers[0].price, providers, logos })
    }
  }
  return out
}
export function paramsOf(ep) {
  const input = ep?.input || {}
  return { ...input.pathParams, ...input.queryParams, ...(input.body && typeof input.body === 'object' ? input.body : {}) }
}

// A setting's value for every row: the catalog's example, else the endpoint's verified test
// request (a bounded page size, say), else the first allowed value. Required settings always get
// one; an optional one only when the catalog names a value.
export function settingDefault(ep, k) {
  const p = paramsOf(ep)[k]
  const t = ep?.test_request || {}
  const tested = { ...t.pathParams, ...t.queryParams, ...(t.body && typeof t.body === 'object' ? t.body : {}) }[k]
  if (!SETTING_PARAMS.has(k)) return undefined
  const value = p?.example ?? tested ?? (p?.required ? p?.enum?.[0] : undefined)
  return value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value)
}

// A row can drive it: treg's own key can call it, and no required input is the provider's own
// record id.
export function rowCallable(ep) {
  if (ep.platform_eligible === false) return false
  const params = Object.entries(paramsOf(ep))
  if (params.some(([k, v]) => v?.required && PROVIDER_ID.test(k))) return false
  // a keyword search or a bulk job takes nothing a row holds: it builds lists, it does not enrich
  return !params.length || params.some(([k]) => rowInput(k))
}

export const CATEGORY_ORDER = ['Popular', 'Signals', 'People', 'Company']

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
  profile: ['linkedin_url', 'linkedin', 'linkedin_profile'],
  url: ['linkedin_url', 'linkedin', 'website', 'domain'],
  company: ['name', 'company_name', 'company', 'website', 'domain'],
  company_name: ['company_name', 'company', 'name'],
  firstname: ['first_name', 'firstname'],
  lastname: ['last_name', 'lastname', 'surname'],
  phone: ['phone', 'mobile', 'phone_number'],
  phone_number: ['phone', 'mobile', 'phone_number'],
  domain_or_company: ['domain', 'company_domain', 'website', 'name'],
  company_or_domain: ['domain', 'company_domain', 'website', 'name'],
  company_profile_url: ['company_linkedin_url', 'linkedin_url'],
  company_linkedin_url: ['company_linkedin_url', 'linkedin_url'],
  username: ['x_handle', 'twitter', 'username', 'handle'],
  ip_address: ['ip', 'ip_address'],
  email_domain: ['domain', 'company_domain', 'website'],
  role: ['title', 'role'],
}
// an input a row column can fill (by name, an alias, or the same name in snake_case)
export const rowInput = (k) => k in ALIASES || snake(k) in ALIASES

// Required settings that are the same for every row (paging, an engine or dataset name, the
// fields to return): filled with the catalog's example value, editable in the panel.
// ponytail: a name list; a catalog flag per parameter would be the lasting fix.
export const SETTING_PARAMS = new Set(['perPage', 'per_page', 'page', 'page_size', 'limit', 'offset', 'limit_per_item', 'engine',
  'dataset_id', 'type', 'fields', 'email_type', 'ad_reached_countries', 'data_to_extract'])

// A parameter only the provider can fill (its own record id): a row cannot drive the tool.
export const PROVIDER_ID = /^(organization_id|contactIds|monitor_id|company_id|person_id|select)$/

// camelCase and kebab names read as snake_case: companyName, fullName, domainOrCompany
const snake = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]+/g, '_')
const HOST_INPUTS = new Set(['domain', 'company_domain', 'company_id_or_domain'])

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

// Every identity input a column can feed: {input: '{column id}'}. Routed jobs want everything you
// know (treg derives the rest), so all matches are sent, not only one alternative.
export function autoMap(identity, columns, tableKind) {
  const byName = new Map(columns.map((c) => [norm(c.label || c.id), c.id]))
  const mapping = {}
  for (const input of new Set(identity.flat())) {
    let names = ALIASES[input] || ALIASES[snake(input)] || [input, snake(input)]
    if (input === 'full_name' && tableKind === 'people') names = [...names, 'name']
    // in a people table a tool's `name` is the person's
    if (input === 'name' && tableKind === 'people') names = ['full_name', 'person', 'name']
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
    // a typed setting: JSON stays JSON (a '{column}' template is not JSON), a whole number a number
    if (typeof template === 'string') {
      const t = template.trim()
      if (/^[[{]/.test(t)) { try { out[input] = JSON.parse(t); continue } catch {} }
      if (/^\d+$/.test(t)) { out[input] = Number(t); continue }
    }
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
  // a lookup's 404 is the provider saying it has nothing on this row
  if (r.status === 404 && (a.error === 'upstream_error' || d.error === 'upstream_error')) return { state: 'miss', rows: [], columns: [] }
  if (r.status >= 400 || a.error) {
    const why = a.error === 'upstream_error' ? `provider answered ${a.upstream_status}`
      : d.message || (typeof a.detail === 'string' ? a.detail : '') || d.error || a.error || `HTTP ${r.status}`
    return { state: 'error', error: String(why), retry: r.status === 429 }
  }
  let rows = (a.rows || []).map((row) => Object.fromEntries((a.columns || []).map((c, i) => [c, row[i]])))
  // a nested answer (an object holding several lists) comes as `field, value` summary rows, each
  // list already joined; read it as one record, under the short name and the full path (`colors`
  // and `brand.colors`, the name the column preview used)
  if (a.shape === 'nested') {
    const parent = (a.tables?.[0]?.path || '').split('.').slice(0, -1).join('.')
    const rec = {}
    for (const { field, value } of rows) {
      rec[field] = value
      if (parent) rec[`${parent}.${field}`] = value
    }
    rows = rows.length ? [rec] : []
  }
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

// The columns worth adding from a real answer: fields that hold a value, minus the bookkeeping
// (ids, types, paging, credits), the contract's own picks first when it has them.
const NOISE = /^(id|type|code|status|uuid|_.*)$|(^|\.)(id|meta|key_metadata|relationships|included|links|pagination)(\.|$)/
export function pickColumns(rows, preferred = []) {
  const filled = (c) => rows.some((r) => r[c] != null && r[c] !== '' && r[c] !== '[]')
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => c !== 'served_by')
  const same = (x, y) => rows.every((r) => JSON.stringify(r[x]) === JSON.stringify(r[y]))
  // a nested answer names each field twice (`colors`, `brand.colors`): keep the short one
  const twin = (c) => c.includes('.') && columns.some((o) => o !== c && c.endsWith(`.${o}`) && same(c, o))
  const useful = columns.filter((c) => !NOISE.test(c) && filled(c) && !twin(c))
  const keep = preferred.filter((c) => useful.includes(c))
  return { columns, keep: keep.length ? keep : useful.slice(0, 3) }
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
