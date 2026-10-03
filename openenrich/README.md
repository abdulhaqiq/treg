# openenrich

An open enrichment table. Build a list of companies or people, add columns that find their work
emails, phones and company facts, and export a CSV. Every column is a [treg](https://treg.to) job, so
one token reaches every provider treg carries, with no provider accounts.

```bash
cd openenrich
npm install
TREG_TOKEN=<your treg key> npm run dev     # or log in once with `treg login`
```

Open http://localhost:5173.

## What it does

1. **Build a list.** Find companies (by description, industry or technology), find people (by
   description, title or company), companies like one you know, or import a CSV.
2. **Add columns.** Find people at each company (a new linked people table), find work email, verify
   email, find phone, enrich a company or a person, or any tool in the treg catalog.
3. **Run 10 rows first,** see what you got and what it cost, then run the rest.
4. **Export a CSV.**

You pick a job, not a provider. treg tries providers cheapest first until one finds the answer, and
each cell shows which one did and what it cost (click it). A row with no match costs nothing.

## Money

- Every column shows a price range before it runs: from the cheapest provider that takes the
  inputs, up to a cap of $0.25 a row (`X-Treg-Route-Max-Cost`), so a row never reaches the few
  dollar-a-call providers.
- Each call carries an `Idempotency-Key` made from the tool and its inputs. Running a column again,
  or the same lookup in another table, replays the earlier answer for nothing.
- If the balance runs out mid-run, the run stops, finished cells stay, and running the column again
  picks up where it stopped.

## Tables are files

Each table is `tables/<name>.json` in the folder you start from. An agent (Claude Code, Codex) can
read a table, add its own columns, score or write copy for each row, and save it back; the page
reloads the file when its window gets focus.

```json
{
  "name": "fintech",
  "kind": "companies",
  "parent": null,
  "columns": [
    {"id": "name", "label": "name"},
    {"id": "email", "label": "email",
     "job": {"group": "g1", "tool": "treg.people.email.find", "method": "POST",
             "inputs": {"full_name": "{name}", "domain": "{domain}"}, "field": "email"}}
  ],
  "rows": [
    {"id": "r1", "cells": {"name": "Ramp",
      "email": {"value": "eric@ramp.com", "state": "hit", "served_by": "trykitt.people.email.find",
                "cost_micro": 5000, "call_id": "…"}}}
  ]
}
```

A plain cell is a value; a cell a job filled is an object with `value` and `state` (`hit`, `miss`,
`error`, `skipped`). Columns filled by the same call share a `group`. A people table made by "Find
people at company" has `parent` set, and each row carries `_parent`, its company's row id.

## How it talks to treg

`npm run dev` runs one local server (Vite, with `api.js` mounted on `/api/`). It holds the token, so
the key never reaches the browser, and forwards a few calls:

| Local | treg |
|---|---|
| `GET /api/account` | `GET /table-account` |
| `GET /api/search?q=` | `GET /catalog/search` |
| `GET /api/tool/<id>` | `GET /catalog/endpoints/<id>` |
| `GET /api/columns/<id>` | `GET /table-columns/<id>` (free column preview) |
| `POST /api/run/<id>` | `/table/<id>`: the call, answered as rows and columns |

The local API only answers requests from its own page (a custom header and a `localhost` host
check), so another site open in the browser cannot spend the balance.

`npm start` builds the page and serves it with `node server.js` (port `PORT`, default 5180).
Settings: `TREG_TOKEN`, `TREG_ORG` (a team, for a personal login token), `TREG_URL` (default
`https://treg.to`).

openenrich never imports treg's code; it uses only the HTTP API above, so it runs against any treg,
hosted or self-hosted.

```bash
npm test     # node --test, no browser
```
