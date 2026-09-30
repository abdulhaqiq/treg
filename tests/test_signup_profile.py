""""Picked for you" (application.signup_profile): enrich through treg, classify with jev, write plays.

Every upstream is a MockTransport keyed by URL, so these pin the flow and its guards: off unless
configured, personal mailboxes are asked instead of enriched, jev answers off the list are ignored,
and the play writer can only name capabilities the use case grounds it in.
"""
from __future__ import annotations

import json

import httpx
import pytest
from httpx import AsyncClient

from conftest import verified_signup
from treg.application import signup_profile as sp
from treg.config import get_settings
from treg.domain.catalog import store as catalog_store


def test_every_use_case_grounds_plays_in_real_capabilities():
    caps = catalog_store.load().capabilities
    for key, uc in sp.USE_CASES.items():
        missing = [c for c in uc["capabilities"] if c not in caps]
        assert not missing, (key, missing)
        assert len(uc["plays"]) >= sp.PLAYS
        assert all(cap is None or cap in caps for _, cap, _ in uc["plays"]), key


def test_parse_plays_keeps_only_grounded_well_formed_plays():
    allowed = {"google.keywords.volume": "Keyword volume"}
    text = json.dumps({"plays": [
        {"title": "Volume", "prompt": "Use treg to pull volume for acme's 10 keywords", "capability": "google.keywords.volume"},
        {"title": "Made up", "prompt": "Use treg to hack the planet for acme.com", "capability": "planet.hack"},
        {"title": "Lowercase", "prompt": "pull related keywords for acme.com please", "capability": "google.keywords.volume"},
        {"title": "", "prompt": "Use treg to do a thing with no title", "capability": "google.keywords.volume"},
    ]})
    plays = sp.parse_plays(text, allowed)
    assert [p["title"] for p in plays] == ["Volume", "Lowercase"]
    assert plays[1]["prompt"].startswith("Use treg to pull related")
    assert {p["platform"] for p in plays} == {"google"}


@pytest.fixture
def on(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "signup_profile_enabled", True, raising=False)
    monkeypatch.setattr(s, "jev_treg_token", "house-token", raising=False)
    monkeypatch.setattr(s, "ai_gateway_api_key", "gw-key", raising=False)
    seen: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req.url.path)
        cost = {"X-Treg-Cost-Micro": "2600"}
        if req.url.path.endswith("/call/treg.people.enrich"):
            assert req.headers["X-Treg-Token"] == "house-token"
            return httpx.Response(200, headers=cost, json={"output": {
                "full_name": "Tim Shi", "title": "Head of Growth", "company": "Superdesign Dev",
                "company_domain": "superdesign.dev"},
                "raw": {"company": {"summary": {"name": "Superdesign Dev", "description": "AI design agent",
                                                "staff": {"range": {"start": 2, "end": 10}}},
                                    "link": {"domain": "https://www.superdesign.dev"}}}})
        if req.url.path.endswith("/call/thecompaniesapi.companies.enrich"):
            return httpx.Response(404, json={"message": "companyNotFound"})
        if req.url.path.endswith("/call/openrouter.ai-judge.decide"):
            body = json.loads(req.content)
            if "use_case" not in body["questions"]:   # the tools ranking: one noul per candidate
                assert "<candidates>" in body["state"]
                return httpx.Response(200, json={"answers": {
                    k: {"type": "noul", "noul": 0.9 - int(k[1:]) * 0.01} for k in body["questions"]}})
            assert "<company>" in body["state"] and set(body["questions"]) == {"use_case", "persona"}
            return httpx.Response(200, headers={"X-Treg-Cost-Micro": "50"}, json={"answers": {
                "use_case": {"type": "choice", "choice": "seo", "probabilities": {"seo": 0.8, "geo": 0.2}},
                "persona": {"type": "choice", "choice": "marketer", "probabilities": {"marketer": 0.9}}}})
        if req.url.host == "ai-gateway.vercel.sh":
            assert req.headers["Authorization"] == "Bearer gw-key"
            content = json.dumps({"plays": [
                {"title": "Your rankings", "prompt": "Use treg to pull the keywords superdesign.dev ranks for",
                 "capability": "google.domain.ranked_keywords"},
                {"title": "Off list", "prompt": "Use treg to post on X about superdesign.dev today",
                 "capability": "x.post.create"}]})
            return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})
        return httpx.Response(599)

    monkeypatch.setattr(sp, "_transport", httpx.MockTransport(handler))
    return seen


async def test_profile_is_off_until_configured(clients: AsyncClient):
    r = await clients.get("/onboard/profile")
    assert r.status_code == 200 and r.json() == {"status": "off"}
    r = await clients.post("/onboard/profile/use-case", json={"use_case": "seo"})
    assert r.status_code == 404


async def test_work_email_is_enriched_classified_and_given_plays(clients: AsyncClient, on):
    first = (await clients.get("/onboard/profile")).json()
    assert first["status"] == "pending" and len(first["use_cases"]) == len(sp.USE_CASES)
    await sp.drain()
    p = (await clients.get("/onboard/profile")).json()
    assert p["status"] == "ready" and p["use_case"] == "seo" and p["persona"] == "marketer"
    assert p["person"]["title"] == "Head of Growth"
    assert p["company"] == {"name": "Superdesign Dev", "domain": "superdesign.dev", "tagline": "AI design agent",
                            "employees": "2-10"}
    assert p["use_cases"][0]["key"] == "seo"
    # the model's grounded play first, its off-list play dropped, the rest from the templates
    assert [pl["source"] for pl in p["plays"]] == ["model", "template", "template"]
    assert "superdesign.dev" in p["plays"][1]["prompt"]
    assert "cost_usd" not in p and "use_case_probs" not in p
    # one build: the second read did not start another
    assert on.count("/call/treg.people.enrich") == 1
    # the tools ranking ran after the build: one card per job, never an endpoint they already call
    tools = p["tools"]
    assert 0 < len(tools) <= sp.TOOLS_KEEP and len({t["capability"] for t in tools}) == len(tools)
    assert all(t["reason"] == "Fits what you're here for" and t["cap_key"] for t in tools)

    # switching to a use case and back: the second switch reuses the plays already written
    gateway_calls = sum(1 for u in on if u == "/v1/chat/completions")
    assert (await clients.post("/onboard/profile/use-case", json={"use_case": "geo"})).json()["status"] == "pending"
    await sp.drain()
    back = (await clients.post("/onboard/profile/use-case", json={"use_case": "seo"})).json()
    assert back["status"] == "ready" and back["plays"] == p["plays"]
    await sp.drain()
    assert sum(1 for u in on if u == "/v1/chat/completions") == gateway_calls + 1


async def test_personal_email_is_asked_then_built_from_the_answer(clients: AsyncClient, on):
    r = await verified_signup(clients, json={"email": "someone.new@gmail.com"})
    clients.headers["X-Treg-Token"] = r.json()["token"]
    assert (await clients.get("/onboard/profile")).json()["status"] == "pending"
    await sp.drain()
    p = (await clients.get("/onboard/profile")).json()
    assert p["status"] == "ask" and "plays" not in p
    assert not any("people.enrich" in u for u in on)   # a personal mailbox is never enriched

    assert (await clients.post("/onboard/profile/use-case", json={"use_case": "nope"})).status_code == 400
    r = await clients.post("/onboard/profile/use-case", json={"use_case": "creative"})
    assert r.status_code == 200 and r.json()["status"] == "pending"
    await sp.drain()
    p = (await clients.get("/onboard/profile")).json()
    assert p["status"] == "ready" and p["use_case"] == "creative" and p["answer"] == "creative"
    assert p["confidence"] == 1.0
    assert all("my company" in pl["prompt"] or "my product" in pl["prompt"] or "{" not in pl["prompt"]
               for pl in p["plays"])


async def test_use_case_changes_are_rate_limited(clients: AsyncClient, on, monkeypatch):
    monkeypatch.setattr(sp, "ANSWER_LIMIT", (2, 3600))
    for uc in ("leads", "ads"):   # each a rebuild; switching back to written plays is free and unlimited
        assert (await clients.post("/onboard/profile/use-case", json={"use_case": uc})).status_code == 200
    assert (await clients.post("/onboard/profile/use-case", json={"use_case": "web"})).status_code == 429
    await sp.drain()


def test_candidates_skip_what_they_call_and_pick_balances_history():
    cat = catalog_store.load()
    called = next(e for e in cat.endpoints if e.get("capability") == "google.domain.ranked_keywords"
                  and e.get("tier") == "core" and e.get("scope") != "own_account")
    cands = sp.candidates(cat, "leads", [{"id": called["id"], "n": 5, "failed": 0}])
    assert called["id"] not in {e["id"] for e, _, _ in cands}
    assert {"use_case", "alternative", "platform"} <= {why for _, why, _ in cands}
    assert all(e.get("tier") == "core" and e.get("scope") != "own_account" for e, _, _ in cands)
    # jev scores the use case far higher, yet history keeps its half of the cards
    scored = sorted(((0.9 if why == "use_case" else 0.5, i) for i, (_, why, _) in enumerate(cands)), reverse=True)
    picked = [cands[i][1] for _, i in sp.pick(scored, cands)]
    assert len(picked) == sp.TOOLS_KEEP and sum(w != "use_case" for w in picked) == sp.TOOLS_KEEP // 2
