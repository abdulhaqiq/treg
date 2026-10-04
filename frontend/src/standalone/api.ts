// The standalone pages' one way to the server: same origin, the session cookie, and the active team
// in X-Treg-Org (the dashboard's own convention). Errors keep the server's detail for the page to word.

export class ApiError extends Error {
  status: number
  detail: any
  constructor(status: number, detail: any) {
    super(typeof detail === 'string' ? detail : detail?.message || detail?.error || `HTTP ${status}`)
    this.status = status
    this.detail = detail
  }
}

let team = ''
export function setTeam(slug: string): void { team = slug }
export function currentTeam(): string { return team }

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
  if (team) headers['X-Treg-Org'] = team
  let body = init.body
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const r = await fetch(path, { ...init, body, headers, credentials: 'include' })
  const text = await r.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!r.ok) throw new ApiError(r.status, data && typeof data === 'object' && 'detail' in data ? data.detail : data)
  return data as T
}

export type Team = { slug: string, name: string, role: string }

export async function me(): Promise<{ email: string } | null> {
  try { return await api('/auth/me') } catch { return null }
}

export async function teams(): Promise<Team[]> {
  try { return await api('/orgs') } catch { return [] }
}

// Sign in, then come back here: the dashboard's boot follows `next` for these pages only.
export function signInUrl(): string {
  return '/app?next=' + encodeURIComponent(location.pathname)
}

export function usd(micro: number): string {
  const v = (micro || 0) / 1e6
  return v === 0 ? '$0' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

export function when(iso: string): string {
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z')
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
