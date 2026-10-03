import assert from 'node:assert/strict'
import { test } from 'node:test'
import { idempotencyKey } from '../api.js'
import { autoMap, cellFrom, enrichmentJobs, fillInputs, keptColumns, listRecords, parseCsv, readAnswer, satisfies, toCsv } from '../src/jobs.js'

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

test('the idempotency key ignores key order and changes with the inputs', () => {
  const a = idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Eric' })
  const b = idempotencyKey('treg.people.email.find', 'POST', {}, { full_name: 'Eric', domain: 'ramp.com' })
  assert.equal(a, b)
  assert.notEqual(a, idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Karim' }))
  assert.notEqual(a, idempotencyKey('treg.people.email.find', 'POST', {}, { domain: 'ramp.com', full_name: 'Eric' }, { exclude: ['tomba'] }))
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
})

test('a list answer fills one cell with every value', () => {
  assert.equal(cellFrom([{ name: 'React' }, { name: 'Stripe' }, { name: 'React' }], 'name'), 'React, Stripe')
  assert.equal(cellFrom([{ email: 'a@x.com' }], 'email'), 'a@x.com')
  assert.equal(cellFrom([{ name: null }], 'name'), null)
})
