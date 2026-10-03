// What a user can do, and the pure helpers behind it (mapping inputs, reading answers, CSV).
// No Vue and no fetch here, so `npm test` covers it with node alone.

export const SOURCES = [
  {
    id: 'companies', label: 'Find companies', kind: 'companies', tool: 'treg.companies.search',
    hint: 'Describe the companies, or filter by industry or technology',
    fields: [
      { name: 'q', label: 'Describe', placeholder: 'B2B fintech startups' },
      { name: 'industry', label: 'Industry', placeholder: 'Software' },
      { name: 'technology', label: 'Uses technology', placeholder: 'Stripe' },
      { name: 'country', label: 'Country (ISO code)', placeholder: 'US' },
    ],
  },
  {
    id: 'people', label: 'Find people', kind: 'people', tool: 'treg.people.search',
    hint: 'Describe the people, or give a title and a company domain',
    fields: [
      { name: 'q', label: 'Describe', placeholder: 'heads of growth at fintech startups' },
      { name: 'title', label: 'Title', placeholder: 'Head of Growth' },
      { name: 'company_domain', label: 'Company domain', placeholder: 'ramp.com' },
      { name: 'location', label: 'Location', placeholder: 'London, United Kingdom' },
      { name: 'country', label: 'Country (ISO code)', placeholder: 'GB' },
    ],
  },
  {
    id: 'similar', label: 'Lookalikes of…', kind: 'companies', tool: 'treg.companies.similar',
    hint: 'Companies like one you already know', noLimit: true,
    fields: [{ name: 'domain', label: 'Company domain', placeholder: 'ramp.com' }],
  },
]

export const COLUMN_JOBS = [
  { id: 'people_at', label: 'Find people at company', tool: 'treg.people.search', linked: true,
    note: 'Makes a new people table, linked to this one' },
  { id: 'email', label: 'Find work email', tool: 'treg.people.email.find', keep: ['email', 'verified'] },
  { id: 'verify', label: 'Verify email', tool: 'treg.people.email.verify', keep: ['valid', 'status'] },
  { id: 'phone', label: 'Find phone', tool: 'treg.people.phone.find', keep: ['phone', 'line_type'] },
  { id: 'company', label: 'Enrich company', tool: 'treg.companies.enrich',
    keep: ['description', 'industry', 'employees', 'founded', 'location'] },
  { id: 'person', label: 'Enrich person', tool: 'treg.people.enrich', keep: ['title', 'company', 'location', 'linkedin_url'] },
]

// Column names that can feed each input, best first.
const ALIASES = {
  domain: ['domain', 'company_domain', 'website', 'company_website', 'url'],
  company_domain: ['company_domain', 'domain', 'website', 'company_website', 'url'],
  full_name: ['full_name', 'person', 'person_name', 'contact_name'],
  first_name: ['first_name', 'firstname'],
  last_name: ['last_name', 'lastname', 'surname'],
  linkedin_url: ['linkedin_url', 'linkedin', 'linkedin_profile'],
  email: ['email', 'work_email'],
  website: ['website', 'company_website', 'url', 'domain'],
  name: ['name', 'company_name', 'company'],
}
const HOST_INPUTS = new Set(['domain', 'company_domain'])

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
  if (r.status === 402) return { state: 'stop', error: 'Balance ran out. Top up at treg.to, then run again.' }
  if (r.status === 401 || r.status === 403) return { state: 'stop', error: 'treg rejected the token. Check TREG_TOKEN.' }
  const a = r.answer || {}
  if (r.status >= 400 || a.error) {
    const why = a.error === 'upstream_error' ? `provider answered ${a.upstream_status}` : a.detail || a.message || a.error || `HTTP ${r.status}`
    return { state: 'error', error: typeof why === 'string' ? why : JSON.stringify(why), retry: r.status === 429 }
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

// A table built from list rows (a source search, or one parent's people).
export function tableFromRows(name, kind, records, ids, extra = {}) {
  return {
    name, kind, parent: null, ...extra,
    columns: ids.map((id) => ({ id, label: id })),
    // a provider that gives a homepage URL as the domain is shown as the bare host
    rows: records.map((r) => ({ id: rowId(), cells: Object.fromEntries(ids.map((id) => [id, id === 'domain' && r[id] ? host(r[id]) : r[id] ?? null])) })),
  }
}
