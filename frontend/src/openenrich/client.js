// openenrich's road to treg: the dashboard's own session (cookie + X-Treg-Org from `headers()`), so
// calls go straight to /table/<tool> and tables to /tables. Nothing here holds a token.

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// Same tool + same inputs + same routing = same key, so a re-run replays from treg for nothing,
// and a changed exclude list asks again instead of replaying the old provider's answer.
export async function idempotencyKey(tool, method, query, body, route = {}) {
  const data = new TextEncoder().encode(stableJson([tool, method, query || {}, body ?? null, route]))
  const digest = await crypto.subtle.digest('SHA-256', data)
  return 'oe-' + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 44)
}

export function makeClient(headers) {
  async function call(path, { method = 'GET', body, extra = {} } = {}) {
    const r = await fetch(path, {
      method,
      credentials: 'include',
      headers: { ...headers(), ...extra, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const json = await r.json().catch(() => ({}))
    return { status: r.status, ok: r.ok, json, headers: r.headers }
  }
  async function must(path, opts) {
    const r = await call(path, opts)
    if (!r.ok) {
      const d = r.json?.detail
      const msg = (d && typeof d === 'object' ? d.message || d.error : d) || r.json?.error || `HTTP ${r.status}`
      throw Object.assign(new Error(msg), { status: r.status, json: r.json })
    }
    return r.json
  }
  const enc = encodeURIComponent

  return {
    account: () => must('/table-account'),
    search: (q, limit = 25) => must(`/catalog/search?q=${enc(q)}&limit=${limit}`),
    platform: (slug) => must(`/catalog/platforms/${enc(slug)}`),
    tool: (id) => must(`/catalog/endpoints/${enc(id)}`),
    columns: (id) => must(`/table-columns/${enc(id)}`).catch(() => null),

    // One call answered as rows and columns. Never throws: the caller reads the status.
    // `fresh`: ask the provider again instead of replaying an earlier identical call (a search the
    // user runs again wants today's answer; a column re-run wants the replay, which is free)
    // `strict`: skip providers that would ignore a filter the search sends
    async run(tool, { method = 'POST', query = {}, body, maxCost, exclude, fresh = false, strict = false } = {}) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()
      const route = { ...(exclude?.length ? { exclude } : {}), ...(fresh ? { fresh: Date.now() } : {}), ...(strict ? { strict } : {}) }
      const extra = { 'Idempotency-Key': await idempotencyKey(tool, method, query, body, route) }
      if (maxCost) extra['X-Treg-Route-Max-Cost'] = String(maxCost)
      if (exclude?.length) extra['X-Treg-Route-Exclude'] = exclude.join(',')
      if (strict) extra['X-Treg-Route-Strict-Filters'] = '1'
      try {
        const r = await call(`/table/${tool}${qs ? `?${qs}` : ''}`, { method, body: method === 'GET' ? undefined : body, extra })
        const meta = r.json?._treg || {}
        return {
          status: r.status, answer: r.json,
          cost_micro: Number(r.headers.get('x-treg-cost-micro') || meta.cost_micro || 0),
          served_by: r.headers.get('x-treg-served-by') || meta.served_by || null,
          call_id: r.headers.get('x-treg-call-id') || meta.call_id || null,
          replay: r.headers.get('x-treg-idempotent-replay') === 'true',
        }
      } catch (e) {
        return { status: 0, answer: { error: 'network', message: String(e?.message || e) } }
      }
    },

    tables: () => must('/tables'),
    load: (name, offset = 0) => must(`/tables/${enc(name)}?offset=${offset}`),
    create: (table) => must('/tables', { method: 'POST', body: table }),
    update: (name, body) => must(`/tables/${enc(name)}`, { method: 'PATCH', body }),
    remove: (name) => call(`/tables/${enc(name)}`, { method: 'DELETE' }),
    upsertRows: (name, rows, replaceParentRows) =>
      must(`/tables/${enc(name)}/rows`, { method: 'POST', body: { rows, ...(replaceParentRows ? { replace_parent_rows: replaceParentRows } : {}) } }),
    csvUrl: (name) => `/tables/${enc(name)}?format=csv`,
  }
}

// Every row of a stored table (one read returns at most a page), as the page works on it.
export async function loadTable(api, name) {
  const first = await api.load(name)
  let items = first.items
  while (items.length < first.rows) {
    const next = await api.load(name, items.length)
    if (!next.items.length) break
    items = items.concat(next.items)
  }
  return fromStored({ ...first, items })
}

// A stored table (GET /tables/<name>) as the page works on it.
// A stored `queued` or `running` is a run that never finished where it was saved (a tab closed, or
// a save lost mid-run): nothing runs a loaded table, so it reads as not run yet
const settled = (runs) => Object.fromEntries(Object.entries(runs || {}).filter(([, v]) => !['queued', 'running'].includes(v?.state)))

export function fromStored(t) {
  return {
    name: t.name, kind: t.kind, parent: t.parent, source: t.source, columns: t.columns || [],
    rows: (t.items || []).map((i) => ({ id: i.id, _parent: i.parent_row || null, cells: i.cells || {}, runs: settled(i.runs) })),
  }
}

export function toStoredRows(rows) {
  return rows.map((r) => ({ id: r.id, cells: r.cells, runs: r.runs || {}, ...(r._parent ? { parent_row: r._parent } : {}) }))
}
