// What an enrichment finds, as an icon: shown where several providers stand behind one entry, so
// the badge says what you get instead of who sells it. Paths are 24x24 strokes (Lucide shapes).
const PATHS = {
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M22 6l-10 7L2 6',
  check: 'M22 11.1V12a10 10 0 1 1-5.9-9.1 M22 4 12 14l-3-3',
  phone: 'M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z',
  user: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M22 21v-2a4 4 0 0 0-3-3.9 M16 3.1a4 4 0 0 1 0 7.8',
  building: 'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18z M6 12H4a2 2 0 0 0-2 2v8h4 M18 9h2a2 2 0 0 1 2 2v11h-4 M10 6h4 M10 10h4 M10 14h4 M10 18h4',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  dollar: 'M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  briefcase: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16 M4 6h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z',
  news: 'M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2 M18 14h-8 M15 18h-5 M10 6h8v4h-8z',
  code: 'M16 18l6-6-6-6 M8 6l-6 6 6 6',
  trend: 'M22 7l-8.5 8.5-5-5L2 17 M16 7h6v6',
  package: 'M16.5 9.4 7.5 4.2 M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z M3.3 7 12 12l8.7-5 M12 22V12',
  star: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  copy: 'M8 8h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2',
  at: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.9 7.9',
  search: 'M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z M21 21l-4.3-4.3',
  message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  megaphone: 'M3 11l18-5v12L3 14v-3z M11.6 16.8a3 3 0 1 1-5.8-1.6',
}

// First match wins, so the specific words come before the general ones.
const RULES = [
  [/\.posts$/, 'message'], [/ads[.-]|\.ads$|transparency/, 'megaphone'],
  [/verify/, 'check'], [/email_pattern|format/, 'at'], [/email/, 'mail'], [/phone/, 'phone'],
  [/funding|investment|acquisition/, 'dollar'], [/jobs?\b|jobs\./, 'briefcase'], [/news|filings/, 'news'],
  [/tech_stack|repositories/, 'code'], [/headcount|signals/, 'trend'], [/products/, 'package'],
  [/reviews/, 'star'], [/similar|lookalike/, 'copy'], [/identity|profile|linkedin|github/, 'link'],
  [/people\.search|employees|founders|contacts|decision_makers|teams/, 'users'],
  [/companies\./, 'building'], [/people\./, 'user'],
]

export function iconFor(id) {
  const key = String(id).replace(/^treg\./, '')
  const name = (RULES.find(([re]) => re.test(key)) || [, 'search'])[1]
  return PATHS[name]
}
