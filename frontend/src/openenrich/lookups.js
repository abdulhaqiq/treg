// Value lookups (industries, technologies, keywords) cached for the page's life: a list is read once,
// a typed text is asked once, so reopening a filter or retyping a word answers at once.
const cache = new Map()

export function cachedLookup(api, tool, query = {}) {
  const key = `${tool}?${new URLSearchParams(query)}`
  if (!cache.has(key)) cache.set(key, api.lookup(tool, query).catch((e) => { cache.delete(key); throw e }))
  return cache.get(key)
}
