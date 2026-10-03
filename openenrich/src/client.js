// The browser's only road out: the local API in api.js.
async function call(path, { method = 'GET', body } = {}) {
  const r = await fetch(`/api/${path}`, {
    method,
    headers: { 'X-Openenrich': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await r.json().catch(() => ({}))
  if (!r.ok && !path.startsWith('run/')) throw Object.assign(new Error(json.detail || json.message || json.error || `HTTP ${r.status}`), { status: r.status, json })
  return json
}

export const api = {
  account: () => call('account'),
  search: (q, limit = 25) => call(`search?q=${encodeURIComponent(q)}&limit=${limit}`),
  tool: (id) => call(`tool/${encodeURIComponent(id)}`),
  columns: (id) => call(`columns/${encodeURIComponent(id)}`).catch(() => null),
  run: (id, req) => call(`run/${encodeURIComponent(id)}`, { method: 'POST', body: req }),
  tables: () => call('tables'),
  load: (name) => call(`tables/${encodeURIComponent(name)}`),
  save: (table) => call(`tables/${encodeURIComponent(table.name)}`, { method: 'PUT', body: table }),
}
