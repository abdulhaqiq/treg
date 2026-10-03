# openenrich v1 spec

An open enrichment table on top of treg: build a list of companies or people, add columns that find
contacts and facts, export a CSV. One `TREG_TOKEN`, no provider keys.

## Rules

- **Standalone.** `openenrich/` never imports from `src/treg` or `frontend/`. It talks to treg only
  over HTTP. Taking it out is `git filter-repo --subdirectory-filter openenrich`.
- **Jobs, not vendors.** The user picks "Find work email", never a provider. The provider shows only
  as a `served_by` tag on a cell.
- **Money is visible.** A cost estimate before every run, the real cost on every cell, "Run 10 rows"
  before "Run all".
- **No AI column.** Reasoning over rows is a job for Claude Code or Codex. The table file is plain
  JSON on disk, documented below, so an agent can read it, add columns and write it back.

## Out of v1

AI columns, CRM/sequencer push, scheduled re-runs and signals, sharing/multiplayer, hosted accounts,
virtualized grid (a plain table holds a few thousand rows), splitting one cell into rows in place.

## Core jobs

| # | Job | What the user wants |
|---|---|---|
| 1 | Build a list | "Series A fintechs in the US" |
| 2 | Find the people | "Head of growth at each" |
| 3 | Get contact info | "Emails I can send to, phones" |
| 4 | Research | "Size, industry, location, title" |
| 5 | Take it out | CSV into a sequencer |

## Screens

**1. Start.** Four sources and recent tables. Balance in the corner (`GET /table-account`).

```
┌ openenrich ───────────────────────────── $42.10 ┐
│  What list do you want?                          │
│  [ Find companies ]  [ Find people ]             │
│  [ Lookalikes of… ]  [ Import CSV ]              │
│  Recent tables: fintech-q4 · agencies-uk         │
└──────────────────────────────────────────────────┘
```

**2. Source form.** The job's filters, a free column preview (`GET /table-columns/<tool>`), a row
count (`limit`, the price dial) and the estimate. "Create table" runs one call; its rows become the
table.

```
┌ Find companies ──────────────────────────────────┐
│ Describe [fintech, Series A]   Country [US]      │
│ Rows [25]                                        │
│ Columns (free preview): name · domain · …        │
│ ≈ $0.25                    [ Create table ]      │
└──────────────────────────────────────────────────┘
```

**3. Table.** Columns, `+ Add column`, a run bar while running (done / total, spent, Stop).

```
┌ fintech-q4 · 25 rows ───────────────── $42.10 ───┐
│ name     │ domain      │ employees │ + Add column│
│ Ramp     │ ramp.com    │ 900       │             │
│ Mercury  │ mercury.com │ 700       │             │
└──────────────────────────────────────────────────┘
```

**4. Add column panel.** Job list, then for the chosen job: inputs auto-mapped from columns
(editable), output fields to keep (ticked by default when every provider fills them, from the
preview's `coverage`), estimate, two buttons.

```
┌ Find work email ────────────────────────────────┐
│ Uses:  full_name ← {name}   domain ← {domain}    │
│ Adds:  ☑ email  ☑ verified  ☐ confidence         │
│ ~$0.02/hit · misses are free · 25 rows ≤ $0.50   │
│              [ Run 10 rows ]  [ Run all 25 ]     │
└──────────────────────────────────────────────────┘
```

**5. Cell states.**

| State | Shows |
|---|---|
| empty | nothing |
| queued / running | ⟳ |
| hit | the value, `served_by` on hover |
| miss | "— no match (free)" |
| skipped | "— missing input" (a mapped input cell is empty, no call made) |
| error | "⚠ retry" with the reason on hover |

Clicking any cell with a call opens a side panel: inputs sent, provider, cost, call id, the raw
answer.

## Jobs → treg

All are routed jobs: `POST /table/<tool id>` with a JSON body. Inputs are the contract's
`identity` alternatives (`src/treg/catalog/contracts.yaml`); the first one the row satisfies is used.

| Job | Kind | Tool id | Inputs | Default columns |
|---|---|---|---|---|
| Find companies | source | `treg.companies.search` | `q` / `industry` / `technology` + `country`, `limit` | name, domain, industry, employees, location, linkedin_url |
| Lookalikes of… | source | `treg.companies.similar` | `domain` | same as above |
| Find people | source | `treg.people.search` | `q` / `title` + `country`, `location`, `keywords`, `limit` | first_name, last_name, title, company, linkedin_url, location |
| Find people at company | new linked table | `treg.people.search` | `company_domain` ← row, `title` (typed once), `limit` per company (default 3) | same as above + parent columns |
| Find work email | column | `treg.people.email.find` | `full_name`+`domain` / `first_name`+`last_name`+`domain` / `linkedin_url` | email, verified |
| Verify email | column | `treg.people.email.verify` | `email` | valid, status |
| Find phone | column | `treg.people.phone.find` | `linkedin_url` / `email` / `full_name`+`domain` | phone, line_type |
| Enrich company | column | `treg.companies.enrich` | `domain` / `website` / `name` / `linkedin_url` | description, industry, employees, founded, location |
| Enrich person | column | `treg.people.enrich` | `email` / `linkedin_url` / `full_name`+`domain` | title, company, location, linkedin_url |
| Any tool… | column | any catalog id via `GET /catalog/search` | typed by hand, `{column}` templates | picked from the preview |

### Auto-mapping

For each contract input, match column names by alias, case-insensitive:

| Input | Column names |
|---|---|
| `domain` / `company_domain` | domain, company_domain, website, company_website, url |
| `full_name` | full_name, name (only in a people table), person |
| `first_name` / `last_name` | first_name, firstname / last_name, lastname, surname |
| `linkedin_url` | linkedin_url, linkedin, linkedin_profile |
| `email` | email, work_email |

A value that looks like a URL is sent to `domain` as its host. treg's own `derive` handles the rest
(a `full_name` splits into first/last, an email gives a domain).

### Find people at company (linked table)

Creates a new table `people @ <parent>`. One call per parent row; each returned person is one row
carrying `_parent` (the parent row id) and copies of the parent's `name` and `domain` as
`company_name` / `company_domain`. The parent gets a column `people` showing the count with a link to
the child table. Re-running for a parent row replaces that parent's child rows.

## Running

- **Concurrency** 5 calls at a time. Stop finishes the in-flight calls and leaves the rest queued.
- **Idempotency.** Each call sends `Idempotency-Key: sha256(tool id + canonical JSON of inputs)`.
  Re-running a column, or the same lookup in another row or table, replays at no cost.
- **Estimate and cap.** From `GET /catalog/endpoints/<tool id>`: "from" is the cheapest provider in
  the routing plan that accepts the inputs being sent; the upper bound is a fixed cap of $0.25 a row,
  sent on every routed call as `X-Treg-Route-Max-Cost` (treg's default is $1, and a few people-search
  providers charge $2.50 to $3 a call). Shown before every run, misses free.
- **Actual cost** from `_treg.cost_micro` per cell; the run bar sums it.
- **Refusals** stop the run, keep finished cells, show one banner:

| treg answer | Banner |
|---|---|
| 401 | "Token rejected. Check TREG_TOKEN." |
| 402 | "Balance ran out after N rows. Top up at treg.to, then Resume." |
| 429 | back off and retry the cell, banner only if it persists |
| `upstream_error` | cell error, run continues |

## Architecture

```
openenrich/
  package.json      # vue, vite; no other runtime deps
  server.js         # node:http — serves the UI, forwards 4 routes to treg, reads/writes tables/
  src/              # Vue app: Start, SourceForm, Table, ColumnPanel, CellPanel
  tables/           # one JSON file per table (git-ignored)
  README.md
```

`server.js` holds `TREG_TOKEN` (env) so the key never reaches the browser, and solves CORS (treg sends
none). Base URL `TREG_URL`, default `https://treg.to`.

| Local route | Forwards to |
|---|---|
| `GET /api/account` | `GET /table-account` |
| `GET /api/search?q=` | `GET /catalog/search?q=` |
| `GET /api/columns/<tool>` | `GET /table-columns/<tool>` |
| `GET /api/price/<tool>` | `GET /catalog/endpoints/<tool>` |
| `POST /api/run/<tool>` | `POST /table/<tool>` with `Idempotency-Key` |
| `GET/PUT /api/tables/<name>` | `tables/<name>.json` on disk |

### Table file (the agent interface)

```json
{
  "name": "fintech-q4",
  "parent": null,
  "columns": [
    {"id": "name", "label": "name"},
    {"id": "email", "label": "email",
     "job": {"tool": "treg.people.email.find",
             "inputs": {"full_name": "{name}", "domain": "{domain}"},
             "field": "email"}}
  ],
  "rows": [
    {"id": "r1", "_parent": null,
     "cells": {"name": "Ramp",
               "email": {"value": "eric@ramp.com", "state": "hit",
                         "served_by": "hunter", "cost_micro": 20000, "call_id": "…"}}}
  ]
}
```

A plain cell is a scalar; a job cell is an object. One call fills every output field the user
ticked, so several columns can share one `call_id`. An agent may add plain columns or edit values;
the UI reloads the file on focus.

## treg-side prerequisites (separate PRs, merged first)

1. **Turn on `/table/` in prod** (treg-internal env: `TREG_TABLE_ENABLED`, first `TREG_TABLE_TEAMS`
   = our team, all teams on launch day).
2. **Company columns.** `domain.table.LIST_MAPS` maps only `people`; add `companies` (name, domain,
   industry, employees, location, linkedin_url) so search rows have fixed columns whichever provider
   answers.
3. **Check** a team key gets 200 on `/table/treg.people.email.find` and `/table-columns/…` in prod.

## Open questions

- **Paging.** Routed searches return `next_cursor` but take no cursor input, so v1 has no "more
  results": a source is one call sized by `limit` (the form caps Rows at 100).
- **Description-only company search reaches one provider.** `treg.companies.search` with only `q`
  routes to exa alone (every other provider needs a domain, name, industry or technology), and
  exa's rows carry name and homepage but no industry, size or location. Enrich company fills them.

## Done when

On a 10-company table (local dev stack with the flag on, then prod with our team):
Find companies → Find people at company (title "founder") → Find work email → Verify email →
Export CSV works end to end; re-running every column costs $0; a 402 mid-run stops cleanly and
Resume continues.
