---
title: Vibe-it — build a hub tool in conversation
status: building; behind `vibe_enabled` (TREG_VIBE_ENABLED) and the hub's own flag
sources:
  - src/treg/application/vibe/__init__.py
  - src/treg/application/vibe/agent.py
  - src/treg/routers/vibe.py
  - src/treg/infra/llm.py
  - src/treg/alembic/versions/0066_vibe.py
  - frontend/src/vibe/VibePage.vue
  - frontend/vibe.html
  - tests/test_vibe.py
related:
  - architecture/hub.md
  - architecture/hub-apps.md
---

# Vibe-it

`/vibe-it` is a chat page where a signed-in maker describes a tool in plain words and treg's agent
builds it with them as a hub tool: it searches the catalog, proposes the tools for each step with
their prices, writes the files, test-runs them, publishes when the maker says so, and offers to turn
on an app (`architecture/hub-apps.md`). It is a second way to make a hub tool, never a second kind:
everything it does goes through the hub's own routes.

Behind `vibe_enabled` (`TREG_VIBE_ENABLED`, default off) AND the hub's gate (`hub_app.enabled_for`:
the flag and `TREG_HUB_TEAMS` / `TREG_HUB_USERS`). `/meta.vibe` says whether it exists here.
Browser only: a request carrying `X-Treg-Token`, or no session cookie, is 403 `vibe_browser_only`,
because the model budget is a person's and an agent already has the hub's routes.

## The agent (`application/vibe/agent.py`)

One maker message runs the loop: the model answers through the AI gateway (`infra/llm.chat`,
OpenAI-style function tools; `vibe_model`, else `vibe_fallback_model` on an error) until it answers
in text, at most `MAX_TURNS` model turns and `MAX_TOOL_CALLS` tool calls per message. Every turn and
tool step is stored as it happens. The system prompt carries the hub section of `src/treg/web/skill.md`
verbatim, so this agent and every installed agent read the same rules.

Its seven tools are existing roads, each an in-process request to the running application with the
maker's own session cookie and team header (the `run_check` pattern), so it can do nothing the maker
could not: `catalog_search` and `catalog_get` (the catalog routes; `catalog_get` also carries the
team's `access` from `/catalog/endpoints/{id}/access`: callable now, and if not, why and the fix,
because a step the team holds no key for and treg serves no shared key for fails every test run
with a 404 before any provider, and the prompt has the agent stop and say so), `my_tools` (`GET /tools`, names
and base URLs only), `write_files` (stores the draft, then the hub's own validator,
`hub_app.transient`, which returns the field and rule), `test_run` (`POST /hub/run`: a real run on the
team's balance, nothing stored), `publish` (`POST /hub/tools`, or `PUT` for a new version), `app_on`
(`PUT /hub/tools/{id}/app`). The prompt has it ask before the first test run and before publishing.

No database connection is held while the model or a tool call is in flight: the route's session
commits before each.

## Money

The model is treg's spend, not the team's: each assistant turn's gateway cost (or, when the gateway
reports none, its tokens at a deliberately high estimate) is added to `VibeBudget.spent_micro`, one
row per person, never per team and never restored. Before every model turn the loop checks
`vibe_budget_usd` minus spent; at zero it stops and says the draft is still there. A test run and
the publish check are ordinary hub runs on the team's balance, as from the CLI. None of this is a
ledger entry.

## The data (migration 0066; `application/vibe/__init__.py` is the only writer)

`VibeSession` (person, team, title, `draft` = the four files, `tool_id` once published, `summary`),
`VibeMessage` (role user | assistant | tool; content; the turn's cost), `VibeBudget`. A team's
deletion takes its conversations and their messages (`cascade_delete_org`); an admin's deletion of
a person takes theirs and the budget row (`forget_user`).

**History (option C).** `treg-worker vibe trim` (cron it daily) finds conversations idle for
`vibe_trim_after_days` (default 30): each keeps its draft, its published tool and a short summary
(the maker's first ask and the agent's last answer, no model call); its messages go. The agent reads
the summary when the conversation resumes.

## Routes (`routers/vibe.py`)

| route | does |
|---|---|
| `GET /vibe-it` | the page (`noindex`) |
| `GET /vibe/state` | the budget left and the team's conversations |
| `POST /vibe/sessions` · `GET`/`DELETE /vibe/sessions/{id}` | start, read (messages, draft), delete |
| `POST /vibe/sessions/{id}/messages` | `{text}`: the agent works, the whole conversation comes back; 409 while one runs, 429 past `MESSAGES_PER_MINUTE` |
| `PUT /vibe/sessions/{id}/draft` | the maker's own edits; returns `problem` (field, rule) or null |
| `POST /vibe/sessions/{id}/validate` · `test` · `publish` | the panel's buttons, without the agent |

Changes need member+ and a same-origin request. A conversation is its person's, in its team: anyone
else gets 404.

## The page (`frontend/src/vibe/`)

A standalone Vite entry beside the Dashboard (`routers/web.page_entry("vibe")`): conversations on
the left, the chat in the middle (tool steps as one line each), and the files on the right,
editable, with Validate, Test run (a form from the draft's inputs, the result through the app page's
`ResultView`), Publish and Turn on the app. The agent reads the maker's edits on its next turn.
