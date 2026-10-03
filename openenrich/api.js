// The local API: forwards a few routes to treg (holding the token, so it never reaches the browser,
// and because treg sends no CORS headers) and keeps tables as JSON files in ./tables.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TREG_URL = (process.env.TREG_URL || 'https://treg.to').replace(/\/$/, '')
const TABLES = join(process.cwd(), 'tables')
const TOOL_ID = /^[\w.-]+$/
const TABLE_NAME = /^[\w-]{1,80}$/

// TREG_TOKEN (and TREG_ORG), else what the treg CLI saved at login
async function credentials() {
  let saved = {}
  try { saved = JSON.parse(await readFile(join(homedir(), '.treg', 'config.json'), 'utf8')) } catch {}
  const token = process.env.TREG_TOKEN || saved.token || ''
  const org = process.env.TREG_ORG || (process.env.TREG_TOKEN ? '' : saved.active_org || '')
  return { 'X-Treg-Token': token, ...(org ? { 'X-Treg-Org': org } : {}) }
}

// Same tool + same inputs + same routing = same key, so a re-run replays from treg for nothing,
// and a changed exclude list asks again instead of replaying the old provider's answer.
export function idempotencyKey(tool, method, query, body, route = {}) {
  return createHash('sha256').update(stableJson([tool, method, query || {}, body ?? null, route])).digest('hex').slice(0, 48)
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

async function treg(path, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(TREG_URL + path, {
    method,
    headers: { ...(await credentials()), ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { error: 'not_json', body_excerpt: text.slice(0, 500) } }
  return { status: r.status, json, headers: r.headers }
}

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(json))
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

// Another site open in the browser must not be able to spend this balance: a cross-site request
// cannot add a custom header without a CORS preflight (never answered here), and a rebound DNS name
// fails the host check.
function trusted(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  return req.headers['x-openenrich'] === '1' && ['localhost', '127.0.0.1', '[::1]'].includes(host)
}

export async function handleApi(req, res) {
  if (!trusted(req)) return send(res, 403, { error: 'forbidden' })
  try {
    const url = new URL(req.url, 'http://local')
    const [, , route, ...rest] = url.pathname.split('/')
    const arg = decodeURIComponent(rest.join('/'))

    if (route === 'account' && req.method === 'GET') {
      const r = await treg('/table-account')
      return send(res, r.status, r.json)
    }
    if (route === 'search' && req.method === 'GET') {
      const limit = Math.min(100, Number(url.searchParams.get('limit')) || 25)
      const r = await treg(`/catalog/search?q=${encodeURIComponent(url.searchParams.get('q') || '')}&limit=${limit}`)
      return send(res, r.status, r.json)
    }
    if (route === 'platform' && req.method === 'GET' && TOOL_ID.test(arg)) {
      const r = await treg(`/catalog/platforms/${arg}`)
      return send(res, r.status, r.json)
    }
    if ((route === 'tool' || route === 'columns') && req.method === 'GET' && TOOL_ID.test(arg)) {
      const r = await treg(route === 'tool' ? `/catalog/endpoints/${arg}` : `/table-columns/${arg}`)
      return send(res, r.status, r.json)
    }
    if (route === 'run' && req.method === 'POST' && TOOL_ID.test(arg)) {
      const { method = 'POST', query = {}, body, maxCost, exclude } = await readBody(req)
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '' && v != null)).toString()
      const headers = { 'Idempotency-Key': idempotencyKey(arg, method, query, body, exclude?.length ? { exclude } : {}) }
      if (maxCost) headers['X-Treg-Route-Max-Cost'] = String(maxCost)
      if (exclude?.length) headers['X-Treg-Route-Exclude'] = exclude.join(',')
      const r = await treg(`/table/${arg}${qs ? `?${qs}` : ''}`, { method, headers, body: method === 'GET' ? undefined : body })
      return send(res, 200, {
        status: r.status,
        answer: r.json,
        cost_micro: Number(r.headers.get('x-treg-cost-micro') || r.json?._treg?.cost_micro || 0),
        served_by: r.headers.get('x-treg-served-by') || r.json?._treg?.served_by || null,
        call_id: r.headers.get('x-treg-call-id') || r.json?._treg?.call_id || null,
        replay: r.headers.get('x-treg-idempotent-replay') === 'true',
      })
    }
    if (route === 'tables') {
      await mkdir(TABLES, { recursive: true })
      if (!arg && req.method === 'GET') {
        const names = (await readdir(TABLES)).filter((f) => f.endsWith('.json'))
        const list = await Promise.all(names.map(async (f) => ({ name: f.slice(0, -5), mtime: (await stat(join(TABLES, f))).mtimeMs })))
        return send(res, 200, list.sort((a, b) => b.mtime - a.mtime))
      }
      if (!TABLE_NAME.test(arg)) return send(res, 400, { error: 'bad_table_name' })
      const file = join(TABLES, `${arg}.json`)
      if (req.method === 'GET') {
        try { return send(res, 200, JSON.parse(await readFile(file, 'utf8'))) } catch { return send(res, 404, { error: 'no_table' }) }
      }
      if (req.method === 'PUT') {
        await writeFile(file, JSON.stringify(await readBody(req), null, 1))
        return send(res, 200, { ok: true })
      }
    }
    send(res, 404, { error: 'not_found' })
  } catch (e) {
    send(res, 502, { error: 'local_api_error', message: String(e?.message || e) })
  }
}
