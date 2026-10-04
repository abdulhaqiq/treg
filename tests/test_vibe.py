"""Vibe-it (docs/context/architecture/vibe-it.md): conversations, the agent loop with a fake model,
the budget, the draft, test run and publish through the hub's own routes, trimming, deletion."""

from __future__ import annotations

from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update

from treg.config import get_settings
from treg.infra import llm
from treg.infra.db import session_maker
from treg.models import Org, VibeBudget, VibeMessage, VibeSession
from tests.test_hub import hub_on  # noqa: F401


SCRIPT = "export default async function run(ctx) { return {greeting: 'hi ' + ctx.inputs.name}; }"
MANIFEST = {"name": "greeter", "summary": "Says hi to a name.",
            "inputs": {"name": {"type": "string", "example": "Ada"}},
            "uses": [], "script": "run.js", "output": {"fields": ["greeting"]}}
CHECK = {"inputs": {"name": "Ada"}, "fields": ["greeting"]}


@pytest.fixture
def vibe_on(hub_on, monkeypatch):  # noqa: F811
    for k, v in {"TREG_VIBE_ENABLED": "1", "TREG_HUB_TEAMS": "", "TREG_HUB_USERS": "",
                 "TREG_AI_GATEWAY_API_KEY": "test-key", "TREG_VIBE_BUDGET_USD": "1"}.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def _browser(clients: AsyncClient) -> dict:
    """Sign the suite's user in by email code: a session cookie, no token, the team in X-Treg-Org."""
    email = "tim@superdesign.dev"
    code = (await clients.post("/auth/email/start", json={"email": email})).json()["dev_code"]
    assert (await clients.post("/auth/email/verify", json={"email": email, "code": code})).status_code == 200
    slug = (await clients.get("/orgs")).json()[0]["slug"]
    return {"X-Treg-Token": "", "X-Treg-Org": slug}


def _fake_model(monkeypatch, turns: list[llm.Turn]) -> list[list[dict]]:
    seen: list[list[dict]] = []

    async def chat(messages, tools, **kw):
        seen.append(messages)
        return turns.pop(0) if turns else llm.Turn(text="done", tool_calls=[], ms=1)
    monkeypatch.setattr(llm, "chat", chat)
    return seen


def _call(name: str, **args) -> dict:
    return {"id": f"c-{name}", "name": name, "arguments": args}


async def test_off_or_with_a_token_is_refused(clients: AsyncClient, hub_on):  # noqa: F811
    assert (await clients.get("/vibe/state")).status_code == 404
    assert (await clients.get("/vibe-it")).status_code == 404
    assert (await clients.get("/meta")).json()["vibe"] is False


async def test_an_agent_token_cannot_use_it(clients: AsyncClient, vibe_on):
    r = await clients.get("/vibe/state")                       # the suite's token, no browser session
    assert r.status_code == 403 and r.json()["detail"]["error"] == "vibe_browser_only"


async def test_the_agent_writes_valid_files(clients: AsyncClient, vibe_on, monkeypatch):
    h = await _browser(clients)
    seen = _fake_model(monkeypatch, [
        llm.Turn(text="Let me write it.", tool_calls=[_call("write_files", manifest=MANIFEST, script=SCRIPT, check=CHECK,
                                                             readme="Says hi.")], ms=1, cost_usd=0.01),
        llm.Turn(text="Written and valid. Want a test run?", tool_calls=[], ms=1, cost_usd=0.01),
    ])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    r = await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "a greeter"}, headers=h)
    assert r.status_code == 200, r.text
    body = r.json()
    assert [m["role"] for m in body["messages"]] == ["user", "assistant", "tool", "assistant"]
    assert body["messages"][2]["ok"] is True and "valid" in body["messages"][2]["summary"]
    assert body["draft"]["manifest"]["name"] == "greeter" and body["title"] == "greeter"
    # the hub's own rules reach the model
    assert "recipe.json rules" in seen[0][0]["content"] and "never paste a credential" in seen[0][0]["content"]
    state = (await clients.get("/vibe/state", headers=h)).json()
    assert state["left_micro"] == 1_000_000 - 20_000


async def test_a_refusal_names_the_field(clients: AsyncClient, vibe_on, monkeypatch):
    h = await _browser(clients)
    _fake_model(monkeypatch, [llm.Turn(text="", tool_calls=[_call("write_files", manifest={**MANIFEST, "uses": ["nope.tool"]},
                                                                  script=SCRIPT, check=CHECK, readme="x")], ms=1)])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    body = (await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "go"}, headers=h)).json()
    tool = next(m for m in body["messages"] if m["role"] == "tool")
    assert tool["ok"] is False and "uses[0]" in tool["summary"]


async def test_the_budget_stops_the_agent(clients: AsyncClient, vibe_on, monkeypatch):
    h = await _browser(clients)
    _fake_model(monkeypatch, [])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    async with session_maker() as db:
        user_id = (await db.get(VibeSession, s["id"])).user_id
        db.add(VibeBudget(user_id=user_id, spent_micro=1_000_000))
        await db.commit()
    body = (await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "hi"}, headers=h)).json()
    assert "model budget" in body["messages"][-1]["text"]


async def test_tool_calls_are_capped(clients: AsyncClient, vibe_on, monkeypatch):
    from treg.application.vibe import agent
    monkeypatch.setattr(agent, "MAX_TOOL_CALLS", 2)
    h = await _browser(clients)
    _fake_model(monkeypatch, [llm.Turn(text="", tool_calls=[_call("my_tools")] * 5, ms=1)] * 5)
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    body = (await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "go"}, headers=h)).json()
    assert sum(1 for m in body["messages"] if m["role"] == "tool") == 2
    assert "as many steps" in body["messages"][-1]["text"]


async def test_edit_test_and_publish_from_the_panel(clients: AsyncClient, vibe_on):
    h = await _browser(clients)
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    r = (await clients.put(f"/vibe/sessions/{s['id']}/draft", json={"manifest": MANIFEST, "script": SCRIPT,
                                                                    "check": CHECK, "readme": "Says hi."}, headers=h)).json()
    assert r["problem"] is None
    t = (await clients.post(f"/vibe/sessions/{s['id']}/test", json={"inputs": {"name": "Bo"}}, headers=h)).json()
    assert t["status"] == 200 and t["result"]["output"] == {"greeting": "hi Bo"}
    p = (await clients.post(f"/vibe/sessions/{s['id']}/publish", headers=h)).json()
    assert p["status"] == 201 and p["result"]["status"] == "live", p
    assert (await clients.get(f"/vibe/sessions/{s['id']}", headers=h)).json()["tool_id"] == p["result"]["tool_id"]
    p2 = (await clients.post(f"/vibe/sessions/{s['id']}/publish", headers=h)).json()   # a new version
    assert p2["status"] == 200 and p2["result"]["version"] == 2


async def test_another_person_cannot_read_it(clients: AsyncClient, vibe_on):
    h = await _browser(clients)
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    other = AsyncClient(transport=clients._transport, base_url="http://registry")
    code = (await other.post("/auth/email/start", json={"email": "someone@example.com"})).json()["dev_code"]
    await other.post("/auth/email/verify", json={"email": "someone@example.com", "code": code})
    await other.post("/orgs", json={"name": "Other team"})
    slug = (await other.get("/orgs")).json()[0]["slug"]
    assert (await other.get(f"/vibe/sessions/{s['id']}", headers={"X-Treg-Org": slug})).status_code == 404


async def test_idle_conversations_keep_the_draft_and_a_summary(clients: AsyncClient, vibe_on, monkeypatch):
    from treg.application import vibe as vibe_app
    h = await _browser(clients)
    _fake_model(monkeypatch, [llm.Turn(text="Sure, a greeter.", tool_calls=[], ms=1)])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    await clients.put(f"/vibe/sessions/{s['id']}/draft", json={"manifest": MANIFEST}, headers=h)
    await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "build me a greeter"}, headers=h)
    async with session_maker() as db:
        row = await db.get(VibeSession, s["id"])
        await db.execute(update(VibeSession).where(VibeSession.id == row.id)
                         .values(updated_at=row.updated_at - timedelta(days=40)))
        await db.commit()
        assert await vibe_app.trim_idle(db) == 1
        await db.commit()
    body = (await clients.get(f"/vibe/sessions/{s['id']}", headers=h)).json()
    assert body["messages"] == [] and body["trimmed"] is True
    assert "build me a greeter" in body["summary"] and body["draft"]["manifest"]["name"] == "greeter"


async def test_team_deletion_takes_its_conversations(clients: AsyncClient, vibe_on, monkeypatch):
    from treg.domain.governance.teams import cascade_delete_org
    h = await _browser(clients)
    _fake_model(monkeypatch, [llm.Turn(text="ok", tool_calls=[], ms=1)])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "hi"}, headers=h)
    async with session_maker() as db:
        row = await db.get(VibeSession, s["id"])
        await cascade_delete_org(await db.get(Org, row.org_id), db)
        await db.commit()
        assert (await db.execute(select(VibeSession))).scalars().all() == []
        assert (await db.execute(select(VibeMessage))).scalars().all() == []


async def test_catalog_get_says_whether_the_team_can_call_it(clients: AsyncClient, vibe_on, monkeypatch):
    """A step the team holds no key for (and treg serves no shared key for) fails every test run
    with a 404 before any provider: the agent is told before it builds on it."""
    monkeypatch.setenv("TREG_PLATFORM_PROVIDERS", ""); get_settings.cache_clear()
    h = await _browser(clients)
    _fake_model(monkeypatch, [llm.Turn(text="", tool_calls=[_call("catalog_get", id="scrapecreators.reddit.search.posts")], ms=1)])
    s = (await clients.post("/vibe/sessions", json={}, headers=h)).json()
    body = (await clients.post(f"/vibe/sessions/{s['id']}/messages", json={"text": "reddit"}, headers=h)).json()
    tool = next(m for m in body["messages"] if m["role"] == "tool")
    assert "cannot call it yet" in tool["summary"]
    async with session_maker() as db:
        msg = (await db.execute(select(VibeMessage).where(VibeMessage.role == "tool"))).scalars().first()
        assert '"callable": false' in msg.content["result"] and "treg connections connect" in msg.content["result"]
