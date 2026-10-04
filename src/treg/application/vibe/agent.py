"""Vibe-it's agent: one maker message in, the agent's turns out (docs/context/architecture/vibe-it.md).

The agent has seven tools, and every one is an existing road taken AS THE SIGNED-IN MAKER: the
catalog's own search and contract, the team's tool list, the hub's validator, `POST /hub/run` (a
real test run, charged to the team's balance as always), publish, and turning on an app. The
requests go in-process to the running application with the maker's own cookie and team header,
so the agent can never do what the maker could not.

Limits on every message: `MAX_TURNS` model turns, `MAX_TOOL_CALLS` tool calls, and the person's
model budget, checked before each turn. No database connection is held while the model or a tool
call is in flight (AGENTS.md non-negotiable 3): the route's session commits before each one.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from ...config import get_settings
from ...domain.hub import ManifestError
from ...infra import llm
from ...models import Org, VibeSession
from .. import hub as hub_app
from . import add_message, clean_draft, left_micro, messages, set_draft, spend

MAX_TURNS = 12
MAX_TOOL_CALLS = 24
RESULT_MAX = 6000            # characters of one tool result the model reads back
# When the gateway reports no cost, count the tokens at a deliberately high rate: the budget is
# spent too early rather than never.
EST_IN_PER_TOKEN_MICRO = 5
EST_OUT_PER_TOKEN_MICRO = 25

_WEB = Path(__file__).resolve().parents[2] / "web"


def _hub_rules() -> str:
    """The hub's own instructions for agents (the publish section of skill.md), so vibe-it's agent
    and every installed agent read the same rules."""
    try:
        text = (_WEB / "skill.md").read_text(encoding="utf-8")
    except OSError:
        return ""
    m = re.search(r"<!--hub-->\n(## Task — publish a tool made of tools.*?)<!--/hub-->", text, flags=re.S)
    section = m.group(1) if m else ""
    section = re.sub(r"<!--/?hubapps-->\n?", "", section)
    return section.replace("{BASE}", get_settings().public_url.rstrip("/"))


SYSTEM = """You are vibe-it, treg's builder. You help a maker turn an idea into a hub tool: a tool \
made of other tools that their team publishes on treg and anyone's agent can call.

How to work:
- Talk first. Ask what the tool should take in and give back, who it is for, and what a good \
answer looks like. Keep questions short, a few at a time.
- Find the building blocks with catalog_search and read them with catalog_get (inputs, price, \
how reliable). Propose the tools for each step with their prices, and say what one run will \
likely cost. Prefer the cheapest reliable option; say when a step is free.
- catalog_get says whether this team can call a tool now (`access.callable`). Build only on tools \
it can call. When none of the providers for a step is callable, stop and tell the maker plainly: \
show `access.why_not` and the `access.fix` command, and offer a provider they could connect. Never \
cycle through providers hoping one works: an uncallable step fails every test run the same way.
- In a script, when a ctx.call fails, put its status and a short piece of its body (`r.text`) in the \
error you throw or in ctx.log, so a failed test run says why.
- The maker's own tools (my_tools) run on their own keys and cost callers nothing.
- Decide steps vs script: JSON steps for a fixed chain, a script (run.js) for fallbacks, loops, \
filtering or arithmetic.
- Write the files with write_files. Fix every refusal it returns (it names the field and the rule).
- test_run costs the maker real money for any metered step: say what it will cost and ask before \
the FIRST test run. Read the result and fix what is wrong.
- publish only when the maker says so. After publishing, offer to turn on an app (a web page \
for the tool) with app_on.
- Never ask for, accept or write an API key or secret. A key the team does not hold is \
registered by the maker first (treg secret add, treg tool add), then named in `uses`.
- Be concise. Use short paragraphs and plain lists; no tables wider than 4 columns.

The team you build for is `{team}`; its tools become `{team}.<name>`.

The hub's rules, as every agent reads them:

{rules}
"""

TOOLS: list[dict[str, Any]] = [
    {"name": "catalog_search", "description": "Search treg's catalog of tools by what you want to do. Returns ids, summaries and prices.",
     "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "catalog_get", "description": "Read one catalog tool's contract: inputs, method and path, price, reliability, docs.",
     "parameters": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "my_tools", "description": "The maker's team's own tools (their keys): names and base URLs. Never secrets.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "write_files", "description": "Save the hub tool's files as the current draft and validate them. "
     "Send every file you change; omitted files keep their current content. Returns ok, or the field and rule to fix.",
     "parameters": {"type": "object", "properties": {
         "manifest": {"type": "object", "description": "recipe.json"},
         "script": {"type": "string", "description": "run.js (script tools only)"},
         "check": {"type": "object", "description": "check.json: sample inputs + the output fields the check must find"},
         "readme": {"type": "string", "description": "README.md for humans"}}}},
    {"name": "test_run", "description": "Run the current draft for real with these inputs, on the maker's balance. Nothing is published.",
     "parameters": {"type": "object", "properties": {"inputs": {"type": "object"}}, "required": ["inputs"]}},
    {"name": "publish", "description": "Publish the current draft (a new version if it exists). Runs check.json once for real; live on pass.",
     "parameters": {"type": "object", "properties": {}}},
    {"name": "app_on", "description": "Give the published tool a web page at /apps/<team>/<name>.",
     "parameters": {"type": "object", "properties": {"name": {"type": "string", "description": "optional page name"}}}},
]


def _trim(value: Any, limit: int = RESULT_MAX) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= limit else text[:limit] + f"… [{len(text) - limit} more characters]"


def _detail(r: httpx.Response) -> Any:
    try:
        body = r.json()
    except ValueError:
        return r.text[:600]
    return body.get("detail", body) if isinstance(body, dict) else body


class Toolbox:
    """The agent's seven tools, each an in-process request as the maker."""

    def __init__(self, db: AsyncSession, session: VibeSession, org: Org, app: Any, headers: dict[str, str]):
        self.db, self.session, self.org, self.app = db, session, org, app
        self.headers = {k: v for k, v in headers.items() if k.lower() in ("cookie", "x-treg-org")}
        self.headers["X-Treg-Client"] = "vibe-it"

    def _client(self, timeout: float = 60.0) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://treg.internal",
                                 headers=self.headers, timeout=timeout)

    async def run(self, name: str, args: dict) -> tuple[dict, str, bool]:
        """(the result the model reads, one line for the page, ok)."""
        fn = getattr(self, f"t_{name}", None)
        if fn is None:
            return {"error": f"no tool {name!r}"}, f"unknown tool {name}", False
        try:
            return await fn(**{k: v for k, v in args.items() if not k.startswith("_")})
        except TypeError as exc:
            return {"error": f"bad arguments: {exc}"}, f"{name}: bad arguments", False

    async def t_catalog_search(self, query: str = "") -> tuple[dict, str, bool]:
        await self.db.commit()
        async with self._client() as c:
            r = await c.get("/catalog/search", params={"q": query, "limit": 8})
        rows = (r.json().get("results") or []) if r.status_code == 200 else []
        out = [{"id": e.get("id"), "summary": e.get("summary"), "kind": e.get("kind"),
                "cost_usd": (e.get("cost") or {}).get("usd"), "price_line": e.get("price_line"),
                "ok_rate": (e.get("observed") or {}).get("ok_rate")} for e in rows]
        return {"results": out}, f"searched the catalog for “{query}”: {len(out)} found", True

    async def t_catalog_get(self, id: str = "") -> tuple[dict, str, bool]:
        await self.db.commit()
        async with self._client() as c:
            r = await c.get(f"/catalog/endpoints/{id}")
        if r.status_code != 200:
            return {"error": f"http_{r.status_code}", "detail": _detail(r)}, f"read {id}: not found", False
        ep = r.json().get("endpoint") or {}
        keep = ("id", "summary", "method", "path", "inputs", "params", "body", "output", "cost", "observed",
                "call_template", "docs", "notes", "kind", "price_line", "example")
        out = {k: ep[k] for k in keep if k in ep}
        access = await self._access(id) if ep.get("kind") != "hub" else None
        if access is not None:
            out["access"] = access
        callable_ = access is None or access["callable"]
        return out, f"read {id}" + ("" if callable_ else ": your team cannot call it yet"), True

    async def _access(self, endpoint_id: str) -> dict | None:
        """Whether THIS team can call a catalog tool now, and with whose key (the catalog's own access
        answer): a step the team cannot call fails every test run with a 404 before any provider."""
        async with self._client() as c:
            r = await c.get(f"/catalog/endpoints/{endpoint_id}/access")
        if r.status_code != 200:
            return None
        a = r.json()
        tier = a.get("tier") or "none"
        return {"callable": tier != "none", "tier": tier,
                **({"why_not": a.get("detail"), "fix": a.get("connect_command")} if tier == "none" else {})}

    async def t_my_tools(self) -> tuple[dict, str, bool]:
        await self.db.commit()
        async with self._client() as c:
            r = await c.get("/tools")
        rows = r.json() if r.status_code == 200 and isinstance(r.json(), list) else []
        out = [{"name": t.get("name"), "base_url": t.get("base_url"), "description": t.get("description")} for t in rows]
        return {"tools": out}, f"listed your team's tools: {len(out)}", True

    async def t_write_files(self, manifest: Any = None, script: Any = None, check: Any = None,
                            readme: Any = None) -> tuple[dict, str, bool]:
        await set_draft(self.db, self.session, {"manifest": manifest, "script": script, "check": check, "readme": readme})
        problem = await validate(self.db, self.session, self.org)
        await self.db.commit()
        if problem:
            return {"ok": False, **problem}, f"saved the files; fix {problem['field']}: {problem['rule']}", False
        return {"ok": True}, "saved the files: valid", True

    async def t_test_run(self, inputs: Any = None) -> tuple[dict, str, bool]:
        d = self.session.draft or {}
        await self.db.commit()
        status, body = await test_run(self.app, self.headers, d, inputs if isinstance(inputs, dict) else {})
        if status == 200 and isinstance(body, dict):
            usage = body.get("usage") or {}
            cost = (usage.get("cost_micro") or 0) / 1e6
            return ({"ok": True, "output": body.get("output"), "usage": usage, "log": body.get("log"),
                     "trace": body.get("trace")}, f"test run: ok, ${cost:.4f}", True)
        return {"ok": False, "status": status, "detail": body}, f"test run failed ({status})", False

    async def t_publish(self) -> tuple[dict, str, bool]:
        d = self.session.draft or {}
        await self.db.commit()
        status, body = await publish(self.app, self.headers, d, self.org.slug)
        if status in (200, 201) and isinstance(body, dict):
            self.session.tool_id = body.get("tool_id")
            await self.db.commit()
            verdict = body.get("status")
            return body, f"published {body.get('tool_id')} v{body.get('version')}: {verdict}", verdict in ("live", "review")
        return {"ok": False, "status": status, "detail": body}, f"publish refused ({status})", False

    async def t_app_on(self, name: str | None = None) -> tuple[dict, str, bool]:
        if not self.session.tool_id:
            return {"error": "publish the tool first"}, "app: publish first", False
        await self.db.commit()
        async with self._client() as c:
            r = await c.put(f"/hub/tools/{self.session.tool_id}/app", json={"name": name} if name else {})
        if r.status_code == 200:
            return r.json(), f"app on at {r.json().get('url')}", True
        return {"error": f"http_{r.status_code}", "detail": _detail(r)}, f"app: refused ({r.status_code})", False


async def validate(db: AsyncSession, session: VibeSession, org: Org) -> dict | None:
    """None when the draft would publish, else {field, rule}: the hub's own validator against the
    team's world (catalog ids, the team's tools). Nothing stored."""
    d = session.draft or {}
    if not isinstance(d.get("manifest"), dict):
        return {"field": "manifest", "rule": "required: recipe.json"}
    if not isinstance(d.get("check"), dict):
        return {"field": "check", "rule": "required: check.json"}
    if not (d.get("readme") or "").strip():
        return {"field": "readme", "rule": "required: README.md"}
    try:
        await hub_app.transient(db, org=org, maker_email="", manifest=d["manifest"], script=d.get("script"),
                                check=d["check"], readme=d["readme"], data=None)
    except ManifestError as exc:
        return {"field": exc.field, "rule": exc.rule}
    return None


def _files(d: dict) -> dict:
    return {"manifest": d.get("manifest") or {}, "script": d.get("script"), "check": d.get("check") or {},
            "readme": d.get("readme") or ""}


async def test_run(app: Any, headers: dict, draft: dict, inputs: dict) -> tuple[int, Any]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://treg.internal",
                                 headers=headers, timeout=200.0) as c:
        r = await c.post("/hub/run", json={**_files(draft), "inputs": inputs})
    try:
        return r.status_code, r.json() if r.status_code == 200 else _detail(r)
    except ValueError:
        return r.status_code, r.text[:600]


async def publish(app: Any, headers: dict, draft: dict, team_slug: str) -> tuple[int, Any]:
    name = (draft.get("manifest") or {}).get("name")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://treg.internal",
                                 headers=headers, timeout=240.0) as c:
        mine = await c.get("/hub/tools/mine")
        exists = mine.status_code == 200 and any(t.get("tool_id") == f"{team_slug}.{name}" for t in mine.json())
        r = (await c.put(f"/hub/tools/{team_slug}.{name}", json=_files(draft)) if exists
             else await c.post("/hub/tools", json=_files(draft)))
    try:
        return r.status_code, r.json() if r.status_code in (200, 201) else _detail(r)
    except ValueError:
        return r.status_code, r.text[:600]


def _history(session: VibeSession, rows: list) -> list[dict]:
    """The stored turns as the model's messages."""
    out: list[dict] = []
    if session.summary:
        out.append({"role": "system", "content": "Summary of the earlier conversation (its messages were trimmed):\n"
                    + session.summary})
    for m in rows:
        c = m.content or {}
        if m.role == "user":
            out.append({"role": "user", "content": c.get("text", "")})
        elif m.role == "assistant":
            msg: dict = {"role": "assistant", "content": c.get("text") or None}
            if c.get("tool_calls"):
                msg["tool_calls"] = [{"id": t["id"], "type": "function",
                                      "function": {"name": t["name"], "arguments": json.dumps(t.get("arguments") or {})}}
                                     for t in c["tool_calls"]]
            out.append(msg)
        elif m.role == "tool":
            out.append({"role": "tool", "tool_call_id": c.get("tool_call_id", ""), "content": c.get("result", "")})
    return out


def _draft_note(session: VibeSession) -> str:
    d = clean_draft(session.draft)
    if not d:
        return "There is no draft yet."
    return "The current draft files (the maker may have edited them):\n" + _trim(d, 12000)


async def send(db: AsyncSession, session: VibeSession, org: Org, *, user_id: int, text: str, app: Any,
               headers: dict[str, str]) -> None:
    """Add the maker's message, then let the agent work until it answers in text or hits a limit.
    Every turn and tool step is stored as it happens. Commits as it goes."""
    s = get_settings()
    await add_message(db, session, "user", {"text": text})
    await db.commit()
    box = Toolbox(db, session, org, app, headers)
    system = SYSTEM.format(team=org.slug, rules=_hub_rules())
    calls = 0
    for _ in range(MAX_TURNS):
        if await left_micro(db, user_id) <= 0:
            await add_message(db, session, "assistant", {"text": "I've used up the model budget treg gives each person for "
                                                         "vibe-it. Your draft is saved: you can still edit it, test it and "
                                                         "publish it from the panel, or finish with `treg hub` in a terminal."})
            await db.commit()
            return
        history = [{"role": "system", "content": system}, {"role": "system", "content": _draft_note(session)},
                   *_history(session, await messages(db, session.id))]
        await db.commit()       # no connection held while the model thinks
        turn = await llm.chat(history, TOOLS, api_key=s.ai_gateway_api_key, model=s.vibe_model)
        if turn.error and s.vibe_fallback_model:
            turn = await llm.chat(history, TOOLS, api_key=s.ai_gateway_api_key, model=s.vibe_fallback_model)
        cost = int(round(turn.cost_usd * 1_000_000)) or (turn.input_tokens * EST_IN_PER_TOKEN_MICRO
                                                         + turn.output_tokens * EST_OUT_PER_TOKEN_MICRO)
        await spend(db, user_id, cost)
        if turn.error:
            await add_message(db, session, "assistant", {"text": "The model did not answer just now "
                                                         f"({turn.error}). Send your message again in a moment."}, cost)
            await db.commit()
            return
        calls_now = turn.tool_calls[: max(0, MAX_TOOL_CALLS - calls)]
        await add_message(db, session, "assistant", {"text": turn.text, "tool_calls": calls_now}, cost)
        await db.commit()
        if not calls_now:
            return
        for call in calls_now:
            calls += 1
            result, line, ok = await box.run(call["name"], call.get("arguments") or {})
            await add_message(db, session, "tool", {"tool_call_id": call["id"], "name": call["name"],
                                                    "result": _trim(result), "summary": line, "ok": ok})
            await db.commit()
        if calls >= MAX_TOOL_CALLS:
            await add_message(db, session, "assistant", {"text": "I've taken as many steps as I can for one message. "
                                                         "Tell me to continue and I'll pick up from here."})
            await db.commit()
            return
    await add_message(db, session, "assistant", {"text": "I'll stop here for this message. Tell me to continue when you're ready."})
    await db.commit()
