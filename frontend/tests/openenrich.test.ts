// @ts-nocheck — exercises the plain-JS openenrich modules
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { idempotencyKey } from '../src/openenrich/client.js'
import { autoMap, cellFrom, enrichmentJobs, signalShelf, fillInputs, keptColumns, listRecords, parseCsv, readAnswer, satisfies, toCsv } from '../src/openenrich/jobs.js'

const EMAIL_FIND = [['domain', 'full_name'], ['domain', 'first_name', 'last_name'], ['linkedin_url'], ['linkedin_handle']]

test('auto-map feeds every input a column can, by alias', () => {
  const cols = [{ id: 'first_name' }, { id: 'last_name' }, { id: 'company_domain' }, { id: 'linkedin_url' }]
  assert.deepEqual(autoMap(EMAIL_FIND, cols, 'people'),
    { domain: '{company_domain}', first_name: '{first_name}', last_name: '{last_name}', linkedin_url: '{linkedin_url}' })
})

test('"name" is a person only in a people table', () => {
  const cols = [{ id: 'name' }, { id: 'website', label: 'Website' }]
  assert.deepEqual(autoMap(EMAIL_FIND, cols, 'people'), { domain: '{website}', full_name: '{name}' })
  assert.deepEqual(autoMap(EMAIL_FIND, cols, 'companies'), { domain: '{website}' })
})

test('inputs fill from cells, domains become hosts, empties drop, alternatives decide', () => {
  const row = { cells: { site: 'https://www.ramp.com/about', who: { value: 'Eric Glyman', state: 'hit' }, li: '' } }
  const inputs = fillInputs({ domain: '{site}', full_name: '{who}', linkedin_url: '{li}', title: 'founder' }, row)
  assert.deepEqual(inputs, { domain: 'ramp.com', full_name: 'Eric Glyman', title: 'founder' })
  assert.ok(satisfies(EMAIL_FIND, inputs))
  assert.ok(!satisfies(EMAIL_FIND, { domain: 'ramp.com' }))
})

test('answers read as hit, miss, error or stop', () => {
  const hit = readAnswer({ status: 200, answer: { columns: ['email', 'served_by'], rows: [['e@x.com', 'hunter']], _treg: {} } })
  assert.equal(hit.state, 'hit')
  assert.equal(hit.rows[0].email, 'e@x.com')
  assert.equal(readAnswer({ status: 200, answer: { columns: ['email'], rows: [], _treg: { outcome: 'miss' } } }).state, 'miss')
  assert.equal(readAnswer({ status: 502, answer: { error: 'upstream_error', upstream_status: 500 } }).state, 'error')
  assert.equal(readAnswer({ status: 402, answer: { detail: { error: 'insufficient_balance' } } }).state, 'stop')
  assert.equal(readAnswer({ status: 402, answer: { detail: { error: 'route_max_cost' } } }).state, 'error')
})

test('list sources keep the fixed columns when treg mapped them', () => {
  assert.deepEqual(keptColumns('people', ['first_name', 'last_name', 'title', 'company', 'linkedin_url', 'location', 'id', 'x.y']),
    ['first_name', 'last_name', 'title', 'company', 'linkedin_url', 'location'])
  assert.deepEqual(keptColumns('companies', ['a', 'b', 'served_by']), ['a', 'b'])
})

test('CSV round-trips quotes, commas and newlines', () => {
  const rows = parseCsv('name,note\r\n"Ramp, Inc.","said ""hi""\nthen left"\n\nMercury,\n')
  assert.deepEqual(rows, [['name', 'note'], ['Ramp, Inc.', 'said "hi"\nthen left'], ['Mercury', '']])
  const cols = [{ id: 'name', label: 'name' }, { id: 'note', label: 'note' }]
  const out = toCsv(cols, rows.slice(1).map(([name, note]) => ({ cells: { name, note: { value: note } } })))
  assert.deepEqual(parseCsv(out), rows)
})

test('the idempotency key ignores key order and changes with the inputs', async () => {
  const a = await idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Eric' })
  const b = await idempotencyKey('treg.people.email.find', 'POST', {}, { full_name: 'Eric', domain: 'ramp.com' })
  assert.equal(a, b)
  assert.notEqual(a, await idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Karim' }))
  assert.notEqual(a, await idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Eric' }, { exclude: ['tomba'] }))
})

test('list rows keep extras, drop duplicates and stop at the limit', () => {
  const columns = ['name', 'domain', 'industry', 'employees', 'location', 'linkedin_url', 'description']
  const rows = [
    { name: 'Microsoft', domain: 'microsoft.com', description: 'software' },
    { name: 'Microsoft', domain: 'microsoft.com', location: 'Campbell' },
    { name: 'Google', domain: 'google.com' },
    { name: 'Apple', domain: 'apple.com' },
  ]
  const { records, ids } = listRecords('companies', rows, columns, 2)
  assert.deepEqual(records.map((r) => r.name), ['Microsoft', 'Google'])
  assert.equal(ids.at(-1), 'description')
  const people = listRecords('people', [{ fullName: 'Ada Lovelace', title: 'CTO' }],
    ['first_name', 'last_name', 'title', 'company', 'linkedin_url', 'location', 'fullName'])
  assert.equal(people.records[0].full_name, 'Ada Lovelace')
  assert.equal(people.ids[0], 'full_name')
})

test('enrichments: one entry per capability, routed or with its providers, no list-building helpers', () => {
  const shelf = { capabilities: [
    { id: 'companies.enrich', description: 'Enrich a company', endpoints: [{ id: 'a.x' }, { id: 'b.x' }] },
    { id: 'companies.news', description: 'Recent news', title: 'Get company news', endpoints: [{ id: 'c.news' }] },
    { id: 'companies.funding', description: 'Funding rounds.', endpoints: [
      { id: 'd.f', provider: 'd', cost: { usd: 0.5 } }, { id: 'e.f', provider: 'e', cost: { usd: 0.1 } }, { id: 'e.p', provider: 'e', name: 'Poll a job' }] },
    { id: 'companies.search.count', description: 'Count', endpoints: [{ id: 'f.c' }] },
    { id: 'companies.enrich.bulk.start', description: 'Bulk', endpoints: [{ id: 'g.b' }] },
  ] }
  const routed = new Map([['treg.companies.news', { id: 'treg.companies.news' }], ['treg.companies.enrich', { id: 'treg.companies.enrich' }]])
  const jobs = enrichmentJobs([['Company', shelf]], routed)
  assert.deepEqual(jobs.map((j) => j.tool), ['treg.companies.news', 'e.f'])   // enrich is already in Popular
  assert.equal(jobs[0].label, 'Get company news')
  assert.equal(jobs[1].label, 'Funding rounds')
  assert.deepEqual(jobs[1].providers.map((p) => p.id), ['e.f', 'd.f'])         // cheapest first, no poll step
  assert.deepEqual(jobs[1].logos, ['e', 'd'])
})

test('a list answer fills one cell with every value', () => {
  assert.equal(cellFrom([{ name: 'React' }, { name: 'Stripe' }, { name: 'React' }], 'name'), 'React, Stripe')
  assert.equal(cellFrom([{ email: 'a@x.com' }], 'email'), 'a@x.com')
  assert.equal(cellFrom([{ name: null }], 'name'), null)
})

test('an enrichment icon says what it finds', async () => {
  const { iconFor } = await import('../src/openenrich/icons.js')
  assert.equal(iconFor('treg.people.email.find'), iconFor('people.email.find.personal'))     // both mail
  assert.notEqual(iconFor('people.email.verify'), iconFor('people.email.find'))              // check, not mail
  assert.notEqual(iconFor('companies.funding'), iconFor('companies.tech_stack'))
})

test('signals: signal capabilities group together, extras keep only per-company endpoints', () => {
  const company = { capabilities: [{ id: 'companies.funding', description: 'Funding', endpoints: [{ id: 'a.f', provider: 'a' }] }] }
  const linkedin = { capabilities: [
    { id: 'linkedin.search.ads', description: 'Ads', endpoints: [
      { id: 'b.co', provider: 'b', name: "Find a company's LinkedIn ads" }, { id: 'b.kw', provider: 'b', name: 'Search LinkedIn ads by keyword' }] },
    { id: 'linkedin.user.profile', description: 'Profile', endpoints: [{ id: 'c.p', provider: 'c' }] },
  ] }
  const jobs = enrichmentJobs([['Company', company], ['Signals', signalShelf([linkedin])]], new Map())
  assert.deepEqual(jobs.map((j) => [j.group, j.tool]), [['Signals', 'a.f'], ['Signals', 'b.co']])
})

test('two capabilities with the same title are one entry with both providers', () => {
  const shelf = { capabilities: [
    { id: 'companies.funding', description: 'Funding', title: 'List funding rounds', endpoints: [{ id: 'p.f', provider: 'p', cost: { usd: 0.04 } }] },
    { id: 'companies.funding_rounds', description: 'Rounds', title: 'List funding rounds', endpoints: [{ id: 'a.f', provider: 'a', cost: { usd: 0.01 } }] },
  ] }
  const jobs = enrichmentJobs([['Company', shelf]], new Map())
  assert.equal(jobs.length, 1)
  assert.deepEqual(jobs[0].providers.map((x) => x.id), ['a.f', 'p.f'])
  assert.equal(jobs[0].tool, 'a.f')
})

test('a nested answer reads as one record under short and full field names', () => {
  const r = readAnswer({ status: 200, answer: { shape: 'nested', columns: ['field', 'value'],
    rows: [['domain', 'cisco.com'], ['colors', '#02c8ff, #051c2d']], tables: [{ name: 'colors', path: 'brand.colors' }], _treg: {} } })
  assert.equal(r.state, 'hit')
  assert.equal(r.rows[0]['brand.colors'], '#02c8ff, #051c2d')
  assert.equal(r.rows[0].domain, 'cisco.com')
})

test('real answers pick useful columns; settings stay typed; provider ids hide a tool', async () => {
  const { pickColumns, rowCallable, fillInputs, autoMap } = await import('../src/openenrich/jobs.js')
  const rows = [{ id: '1', type: 'news', 'attributes.headline': 'Stripe raises', 'attributes.summary': 'x', 'meta.page': 1, 'attributes.empty': null }]
  assert.deepEqual(pickColumns(rows).keep, ['attributes.headline', 'attributes.summary'])
  assert.deepEqual(fillInputs({ perPage: '10', fields: '["a"]', domain: '{d}' }, { cells: { d: 'https://stripe.com' } }),
    { perPage: 10, fields: ['a'], domain: 'stripe.com' })
  assert.equal(rowCallable({ input: { queryParams: { organization_id: { required: true } } } }), false)
  assert.equal(rowCallable({ platform_eligible: false }), false)
  assert.deepEqual(autoMap([['companyName', 'fullName']], [{ id: 'company' }, { id: 'full_name' }], 'people'),
    { companyName: '{company}', fullName: '{full_name}' })
})

test('a setting defaults to the example, then the verified test request, then the first allowed value', async () => {
  const { settingDefault } = await import('../src/openenrich/jobs.js')
  const ep = { input: { queryParams: { page_size: { required: false }, email_type: { required: true, enum: ['personal', 'work'] },
    engine: { required: true, example: 'x' }, profile_url: {} } }, test_request: { queryParams: { page_size: '1' } } }
  assert.equal(settingDefault(ep, 'page_size'), '1')
  assert.equal(settingDefault(ep, 'email_type'), 'personal')
  assert.equal(settingDefault(ep, 'engine'), 'x')
  assert.equal(settingDefault(ep, 'profile_url'), undefined)
})

test('CSV export neutralises formulas in text', () => {
  const out = toCsv([{ id: 'a', label: 'a' }], [{ cells: { a: '=cmd()' } }, { cells: { a: -5 } }])
  assert.equal(out.split('\n')[1], "'=cmd()")
  assert.equal(out.split('\n')[2], '-5')
})

test('column types come from the values, then the header', async () => {
  const { detectType, typeOfHeader, detectColumns } = await import('../src/openenrich/jobs.js')
  assert.equal(detectType(['ramp.com', 'mercury.com', '']), 'domain')
  assert.equal(detectType(['https://www.linkedin.com/in/a', 'linkedin.com/in/b']), 'linkedin_person')
  assert.equal(detectType(['https://www.linkedin.com/company/stripe']), 'linkedin_company')
  assert.equal(detectType(['eric@ramp.com', 'x@y.io']), 'email')
  assert.equal(detectType(['https://ramp.com/about']), 'website')
  assert.equal(detectType(['+1 (415) 555-0100', '+44 20 7946 0958']), 'phone')
  assert.equal(detectType(['1000000', '250']), 'number')
  assert.equal(detectType(['Ramp', 'Mercury']), null)
  assert.equal(typeOfHeader('Company Name'), 'company_name')
  const cols = detectColumns([{ id: 'who', label: 'Contact' }, { id: 'site', label: 'Site' }, { id: 'n', label: 'Notes' }],
    [{ cells: { who: 'Eric Glyman', site: 'ramp.com', n: 'met at SaaStr' } }])
  assert.deepEqual(cols.map((c) => c.type), ['person_name', 'domain', undefined])
})

test('inputs map by column type before header names', async () => {
  const { autoMap } = await import('../src/openenrich/jobs.js')
  const cols = [{ id: 'who', label: 'Contact', type: 'person_name' }, { id: 'site', label: 'Site', type: 'website' },
    { id: 'li', label: 'LI', type: 'linkedin_person' }]
  assert.deepEqual(autoMap([['domain', 'full_name'], ['linkedin_url']], cols, 'people'),
    { domain: '{site}', full_name: '{who}', linkedin_url: '{li}' })
})

test('Jev types the unclear columns in one call and only keeps confident answers', async () => {
  const { typeQuestion, applyTypeAnswers } = await import('../src/openenrich/jobs.js')
  const cols = [{ id: 'a', label: 'A', type: 'domain' }, { id: 'b', label: 'Kunde' }, { id: 'c', label: 'Notiz' }]
  const ask = typeQuestion(cols, [{ cells: { a: 'x.com', b: 'Ramp <Inc>', c: 'hi' } }])
  assert.deepEqual(ask.ids, ['b', 'c'])
  assert.ok(ask.body.state.includes('Ramp &lt;Inc&gt;'), 'evidence is escaped')
  assert.deepEqual(Object.keys(ask.body.questions), ['c0', 'c1'])
  const typed = applyTypeAnswers(cols, ask.ids, { 'answers.c0.choice': 'company_name', 'answers.c0.confidence': 0.9,
    'answers.c1.choice': 'company_name', 'answers.c1.confidence': 0.4 })
  assert.deepEqual(typed.map((c) => c.type), ['domain', 'company_name', undefined])
})

test('a judgment column asks one question over the evidence and reads the answer', async () => {
  const { judgeBody, judgeValue } = await import('../src/openenrich/jobs.js')
  const cols = [{ id: 'name', label: 'name' }, { id: 'desc', label: 'description' }, { id: 'x', label: 'x' }]
  const row = { cells: { name: 'Ramp', desc: 'Corporate cards <b>for</b> finance teams', x: '' } }
  const judge = { type: 'noul', instructions: 'Is this B2B?', evidence: ['name', 'desc', 'x'] }
  const body = judgeBody(judge, row, cols)
  assert.equal(body.model, 'typesafe/jev-1.13')
  assert.ok(body.state.includes('<field name="name">Ramp</field>') && body.state.includes('&lt;b&gt;'))
  assert.ok(!body.state.includes('name="x"'), 'empty evidence is left out')
  assert.equal(judgeBody(judge, { cells: {} }, cols), null)
  assert.deepEqual(judgeValue(judge, { 'answers.q.noul': 0.9 }), { value: 'Yes', confidence: 0.9 })
  assert.deepEqual(judgeValue({ type: 'choice', labels: ['SMB', 'Enterprise'] }, { 'answers.q.choice': 'SMB', 'answers.q.confidence': 0.7 }),
    { value: 'SMB', confidence: 0.7 })
  assert.equal(judgeValue({ type: 'choice', labels: ['SMB'] }, { 'answers.q.choice': 'Other' }).value, null)
  assert.equal(judgeValue({ type: 'score', levels: 5 }, { 'answers.q.score': 3 }).value, 4)
  const score = judgeBody({ type: 'score', levels: 3, instructions: 'Fit?', evidence: ['name'] }, row, cols)
  assert.deepEqual(Object.keys(score.questions.q.criteria), ['1', '2', '3'])
})

test("a result column no row fills is left out, a row's name and domain stay", async () => {
  const { listRecords } = await import('../src/openenrich/jobs.js')
  const columns = ['name', 'domain', 'industry', 'employees', 'location', 'linkedin_url']
  const { ids } = listRecords('companies', [{ name: 'Elvex', domain: 'elvex.com', employees: '11-50' }, { domain: 'x.ai' }], columns)
  assert.deepEqual(ids, ['name', 'domain', 'employees'])
})
