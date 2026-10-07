---
title: openenrich — the team's tables (`/tables`, `/openenrich`)
status: phase 1 built (storage + the page; the browser runs the calls), behind the `/table/` flag (TREG_TABLE_ENABLED, TREG_TABLE_TEAMS, TREG_TABLE_USERS)
sources:
  - src/treg/models.py
  - src/treg/alembic/versions/0065_openenrich_tables.py
  - src/treg/alembic/versions/0066_openenrich_table_runs.py
  - src/treg/application/tables.py
  - src/treg/application/table_runs.py
  - src/treg/routers/tables.py
  - src/treg/routers/web.py
  - frontend/src/openenrich/OpenEnrichPage.vue
  - frontend/src/openenrich/SourceForm.vue
  - frontend/src/openenrich/TableView.vue
  - frontend/src/openenrich/ColumnPanel.vue
  - frontend/src/openenrich/client.js
  - frontend/src/openenrich/jobs.js
  - frontend/src/openenrich/icons.js
  - frontend/src/openenrich/style.css
  - tests/test_tables.py
  - frontend/tests/openenrich.test.ts
related:
  - architecture/table.md
  - architecture/catalog.md
  - architecture/archive.md
  - interface/dashboard.md
---

# openenrich: the team's tables

A table is a list of companies or people with columns. A column is either a plain value or a
**job**: a catalog or hub tool, how its inputs map to the row's columns (`{"domain": "{website}"}`,
or a typed value), and the output field it fills. A column may carry a **type** (`domain`,
`person_name`, `linkedin_person`, …) saying what it holds; a job's inputs map to columns by type
first and by header name second. openenrich builds a table from a search (Find
companies, Find people, Lookalikes), a CSV, or another table's column (Find people at company), and
adds job columns from the catalog's People and Company shelves plus the signal capabilities.

## Three phases, one model

| Phase | Who loops over the rows | Status |
|---|---|---|
| 1 | the browser tab running `/openenrich`; each call is an ordinary `/table/<tool>` request | built |
| 2 | treg's worker (`TableRun`, below): built. Agent tools on MCP v2 and the CLI on the same API | runs built; agent tools planned |
| 3 | schedules: columns that run on new rows, re-pulled sources, new-since-last-run | planned |

Phase 1 stores state the later phases read: every call keeps its `state` (`queued`, `running`,
`hit`, `miss`, `error`, `skipped`) and the `inputs` it ran on, so "pending" and "failed" rows can be
computed, and every job column keeps its `group`, settings and `policy`.

## The schema (`application.tables`)

Every write meets typed models (pydantic, unknown keys refused), so a later writer (the worker, an
agent) cannot leave a cell the page cannot read:

- `Column {id, label, type?, job?}`; `type` is one of `COLUMN_TYPES`.
- `Job {group, tool, method, inputs, field?, needs, maxCost?, exclude, linked, limit?, child?, judge?, policy}`;
  `exclude` names the providers of a routed tool the user left out (sent as `X-Treg-Route-Exclude`).
- `Judge {type: noul|choice|score, instructions, labels, levels?, evidence}`: an AI judgment column.
- `Run {state, call_id?, inputs, served_by?, cost_micro, replay, error?, link?, confidence?, at?}`.

**One run per call, not per column.** A row's `cells` hold only values (`email`, `verified`); its
`runs` map a job's column group to the one call that filled those columns. Several columns from one
answer share one run; the raw answer is not copied into the table (it stays with the call record and
the archive, reached by `call_id`). Values stay in the cells: the archive has retention and evidence
blanking, so a table rebuilt from it would empty itself over time.

## Phase 2: runs on the server (`application.table_runs`)

Why: a run owned by the browser tab dies with the view that holds it (opening the linked people table,
the start page, closing the tab). A run becomes a server object that the page, a teammate and an
agent can start, watch and stop.

**`TableRun`** (one row per run): `org_id`, `table_id`, `group` (the column group it fills),
`membership_id` (whose calls these are), `row_ids` (the rows asked for, in order) and `fresh_ids`
(rows asked again rather than replayed), `state` (`queued`, `running`, `done`, `stopped`, `failed`),
counters (`done`, `hits`, `misses`, `errors`, `spent_micro`), `max_usd` (the run's own cap),
`stop_requested`, `lease_until` and `attempts` (the claim and its fencing token), timestamps.

**The worker** (`table_runs.worker`, a lifespan task in the `all` and `control` roles while
`TREG_TABLE_ENABLED` is on): claims a queued run, or a running one whose lease lapsed, with a
conditional `UPDATE … attempts = attempts + 1, lease_until = now + lease` (the `asynctasks`
pattern), and renews the lease every few seconds while it works. Every write a driver makes is
fenced on its `attempts`: a driver that lost its claim writes nothing more. A shutdown cancels the
driver; the lease lapses and another process picks the run up. A run is resumable: every row's call carries the same `Idempotency-Key` as the page computes for it
(tool, method, query, body, route), so a row asked again after a crash or restart replays, answers
409 in progress, or 410 outcome unknown; it is never charged twice.

**One row:** the member's caller is re-read before each batch (a revoked member stops the run). Its
inputs are filled from the row (`fillInputs`, `needs`), its call is an ordinary `execute_call` with
the route headers the column keeps (`maxCost`, `exclude`), read through `application.table.table_answer`
like `/table/<tool>`, and its cells, its `Run` and the run's counters are written with `merge_rows`
in one short transaction (by table id, so a rename mid-run loses nothing; a row deleted mid-run stays
deleted); no
database connection is held while the call is out (non-negotiable 3). An AI judgment column builds
its Jev question from the row; a linked column writes the people it finds to the child table,
replacing that parent's rows, and makes the child table on first use. Rows with the same inputs in
one batch share one call. The request is byte for byte the page's (compact JSON body, the same
headers), because an `Idempotency-Key` fingerprints the request it was first used with.

**Limits:** five calls in flight per run, three active runs per team, and the run stops when its
spend reaches `max_usd` or the team's balance runs short (a 402 `insufficient_balance` stops it; any
other refusal fails that row only; while other calls of the run still hold their caps, the row
waits for them first, as the page did). A row's `queued` counts as busy only inside a run still
going: one left by a page closed mid-run (before phase 2) is not run yet.

**API:** `POST /tables/{name}/runs {group, rows?: "pending" | "failed" | "all" | [ids], fresh?,
limit?, max_usd?}` marks the rows queued and answers `{run, added}`; asking a group that is already
running adds the rows to its run. `"all"` and a list of ids clear the group's old answers first;
`fresh` (with ids, a cell's ▶) asks the provider again instead of replaying. `GET
/tables/{name}/runs` lists the runs still going and those that ended in the last ten minutes; `POST
/tables/{name}/runs/{id}/stop` stops a run after the calls in flight. The page starts runs there,
polls every 2 s while one goes and merges the stored rows into the ones on screen; it saves only
the cells and runs it changed, so its saves never put back a cell a run just filled. The column
rules are ported from `jobs.js` (fillInputs, judgeBody, readAnswer, listRecords) to
`application.table_runs`; the page keeps its copy only for previews.

## Storage (`application.tables`, `/tables`)

`TableDoc` (one per table: `org_id`, unique `name`, `kind`, `parent_id`/`parent_column` for a linked
table, `source`, `columns` as JSON) and `TableRow` (`table_id`, `row_key` the id clients address,
`parent_row`, `position`, `cells` as JSON). A table belongs to the team: every member reads and
writes it; another team's request answers 404.

- `GET /tables`: the team's tables, newest first, with row and column counts.
- `POST /tables`: `{name, kind?, columns?, rows?, source?, parent?: {table, column}}`. The name is
  made unique in the team (`software`, `software-2`); rows without an id get one.
- `GET /tables/{name}`: the table and a page of rows (`items`, `offset`, `has_more`, at most 5,000);
  `?format=csv` answers every row, a job cell as its value.
- `PATCH /tables/{name}`: rename, or replace the column list (the page owns columns and their order).
  Renaming a linked table follows it into its parent: the column that writes to it (`job.child`) and
  every row's run `link`.
- `POST /tables/{name}/rows`: merge rows by id. A known id replaces only the cells and runs it sends
  (a run of `null` removes that group's run, a cell of `null` removes that cell), so a teammate's or another run's cells stay; an
  unknown id is added at the end. `replace_parent_rows`
  first removes those parents' rows (re-running Find people at company for a company replaces its
  people).
- `POST /tables/{name}/rows/delete`, `DELETE /tables/{name}` (a linked table made from it stays,
  unlinked).

Limits: 500 tables per team, 10,000 rows per table, 64 KB of cells and runs per row, 256 KB of columns.

The same flag and lists as `/table/` gate it (`application.table.enabled_for`); off, every route is
a plain 404, and the dashboard's nav entry (`probeOpenEnrich`) stays hidden.

## Money and the archive

Nothing in `/tables` calls a provider or moves money. The page calls `/table/<tool>` row by row, each
an ordinary call with its own hold, under an `Idempotency-Key` made from the tool, its inputs and its
route excludes (`client.idempotencyKey`), so a re-run, or the same lookup in another row or table,
replays for nothing; rows with identical inputs in one run share one call. Routed calls carry a
per-row `X-Treg-Route-Max-Cost` cap. A cell keeps the extracted value and its `call_id`; the raw
answer stays in the call record and the archive, which a table never replaces.

## The page (`frontend/src/openenrich/`)

`/openenrich` and `/openenrich/<table>` serve the dashboard (`routers/web.py`) and open the
`openenrich` view (`oeFromPath` in `state/hub.js`, boot and popstate in `state/boot.js`); a signed-out
visitor gets sign-in and returns to the same path. The page uses only the dashboard session
(`client.makeClient(dash.headers)`), saves only the rows whose cells changed since the last sync,
reloads the table on focus, and refreshes the header balance after a run. Its CSS is scoped under
`.oe`, its colliding class names are `oe-` prefixed, and its grid is a `.ui-table` so the dashboard's
global table rules skip it.

**Searches.** A source's filters are data (`SOURCES` in `jobs.js`). Values are picked, not typed blind:
short lists as pills, long or remote ones by typing (`ValuePicker`: countries, departments, and the
providers' free lookups for industries, technologies and keywords, read through `/call/`), free words
only for titles, places and keywords. A filter's conditions (`ops`: is any of, is none of) are the ones
a provider applies, each writing one field of the routed search (`filterBody`). A search using a field
it cannot be made of alone (`identity`) sends `X-Treg-Route-Strict-Filters`, so a provider that would
ignore it is skipped. "Load more" asks for the next `page` with every other provider excluded, so the
list continues from the provider that served it; one that cannot page answers no_route_candidate,
uncharged, and the list ends there.

**First visit.** A team's first visit adds three real tables beside its own (those it lacks by name) (`seeds.js`, about
50 company rows each, built through treg's searches and column runs; people columns left to run),
once per team in that browser; the seed data loads only then.

**Column types.** A search or a job knows what its fields hold (`typeOfField`). An imported CSV is
typed from its values first (`detectType`: email, LinkedIn person or company, website, domain,
phone, IP, number, boolean; most of a sample must agree), then its header (`typeOfHeader`), then
one Jev call for the columns still unclear (`typeQuestion`, `applyTypeAnswers`; a guess under 60%
stays untyped). The column menu corrects a type.

**AI judgment columns.** "Ask AI to judge" is a job on `openrouter.ai-judge.decide` (Jev): one
question per row over the evidence columns the user picks, sent as escaped, bounded Markdown
(`judgeBody`), answered as Yes/No with a probability, a label from the user's set, or a 1–N score
(`judgeValue`). It judges; it never writes text, which stays the user's agent's job.

`jobs.js` holds the rules a column follows, pure and tested by `frontend/tests/openenrich.test.ts`:
which enrichments are offered (the shelves' per-row capabilities, routed ones as one entry,
providers otherwise, tools needing a provider record id or not callable on treg's key hidden), how
inputs map (aliases, snake/camel names, settings from the catalog's example, test request or enum),
how an answer is read (flat, list, nested, a provider 404 as no result, 402 `insufficient_balance` vs
`route_max_cost`), and how real-answer columns are picked (bookkeeping fields skipped). The rules a
run applies per row are ported to `application.table_runs`; a change to one side changes the other.
