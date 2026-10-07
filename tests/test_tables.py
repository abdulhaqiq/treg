"""openenrich's team tables (`/tables`, docs/context/architecture/tables.md): stored per team, rows
merged by id, gated like `/table/`."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from conftest import verified_signup
from tests.test_marketplace_call import platform_on  # noqa: F401 - tier 4 on
from treg.config import get_settings


@pytest.fixture
def table_on(monkeypatch):
    monkeypatch.setenv("TREG_TABLE_ENABLED", "1")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


COLUMNS = [{"id": "name", "label": "name"}, {"id": "domain", "label": "domain"},
           {"id": "email", "label": "email", "job": {"group": "g1", "tool": "treg.people.email.find", "field": "email"}}]


async def test_off_without_the_flag(clients: AsyncClient):
    assert (await clients.get("/tables")).status_code == 404
    assert (await clients.post("/tables", json={"name": "x"})).status_code == 404


async def test_create_read_merge_and_export(clients: AsyncClient, table_on):
    r = await clients.post("/tables", json={"name": "Fintech Q4", "kind": "companies", "columns": COLUMNS,
                                            "rows": [{"id": "r1", "cells": {"name": "Ramp", "domain": "ramp.com"}},
                                                     {"cells": {"name": "Mercury", "domain": "mercury.com"}}]})
    assert r.status_code == 201, r.text
    t = r.json()
    assert t["name"] == "fintech-q4" and t["rows"] == 2 and [c["id"] for c in t["columns"]] == ["name", "domain", "email"]
    assert t["items"][0]["id"] == "r1" and t["items"][1]["id"]           # a row without an id gets one
    # a second table with the same name is made unique, never overwrites
    assert (await clients.post("/tables", json={"name": "Fintech Q4"})).json()["name"] == "fintech-q4-2"

    # merge: only the sent cells change, a new id is added at the end; a call's evidence is one run
    run = {"state": "hit", "served_by": "x.find", "cost_micro": 5000, "call_id": "c1", "inputs": {"domain": "ramp.com"}}
    r = await clients.post("/tables/fintech-q4/rows", json={"rows": [
        {"id": "r1", "cells": {"email": "eric@ramp.com"}, "runs": {"g1": run}},
        {"id": "r9", "cells": {"name": "Brex"}}]})
    assert r.json() == {"updated": 1, "added": ["r9"]}
    t = (await clients.get("/tables/fintech-q4")).json()
    row = {i["id"]: i for i in t["items"]}
    assert row["r1"]["cells"] == {"name": "Ramp", "domain": "ramp.com", "email": "eric@ramp.com"}
    assert row["r1"]["runs"] == {"g1": run}
    # a run of None clears its group
    await clients.post("/tables/fintech-q4/rows", json={"rows": [{"id": "r1", "cells": {}, "runs": {"g1": None}}]})
    assert (await clients.get("/tables/fintech-q4")).json()["items"][0]["runs"] == {}
    # a cell of None removes it, the rest stay
    await clients.post("/tables/fintech-q4/rows", json={"rows": [{"id": "r1", "cells": {"email": None}}]})
    assert (await clients.get("/tables/fintech-q4")).json()["items"][0]["cells"] == {"name": "Ramp", "domain": "ramp.com"}
    await clients.post("/tables/fintech-q4/rows", json={"rows": [{"id": "r1", "cells": {"email": "eric@ramp.com"}}]})
    assert [i["id"] for i in t["items"]][-1] == "r9"

    csv = (await clients.get("/tables/fintech-q4?format=csv")).text.splitlines()
    assert csv[0] == "name,domain,email" and csv[1] == "Ramp,ramp.com,eric@ramp.com"

    listed = {x["name"]: x for x in (await clients.get("/tables")).json()}
    assert listed["fintech-q4"]["rows"] == 3 and listed["fintech-q4"]["columns"] == 3


async def test_a_linked_table_replaces_a_parents_rows_and_survives_its_parent(clients: AsyncClient, table_on):
    await clients.post("/tables", json={"name": "companies", "columns": COLUMNS, "rows": [{"id": "c1", "cells": {}}]})
    r = await clients.post("/tables", json={"name": "companies-people", "kind": "people",
                                            "parent": {"table": "companies", "column": "people"},
                                            "rows": [{"cells": {"first_name": "A"}, "parent_row": "c1"},
                                                     {"cells": {"first_name": "B"}, "parent_row": "c1"}]})
    assert r.json()["parent"] == {"table": "companies", "column": "people"}
    # re-running the parent's column for c1 replaces its people
    await clients.post("/tables/companies-people/rows", json={"replace_parent_rows": ["c1"],
                                                             "rows": [{"cells": {"first_name": "C"}, "parent_row": "c1"}]})
    names = [i["cells"]["first_name"] for i in (await clients.get("/tables/companies-people")).json()["items"]]
    assert names == ["C"]
    # renaming the linked table follows it into the parent: the column's child and each row's link
    await clients.patch("/tables/companies", json={"columns": [{"id": "people", "label": "People",
        "job": {"group": "g9", "tool": "treg.people.search", "linked": True, "child": "companies-people"}}]})
    await clients.post("/tables/companies/rows", json={"rows": [{"id": "c1", "cells": {"people": 1},
        "runs": {"g9": {"state": "hit", "link": "companies-people"}}}]})
    r = await clients.patch("/tables/companies-people", json={"name": "Fintech founders"})
    assert r.json()["name"] == "fintech-founders"
    parent = (await clients.get("/tables/companies")).json()
    assert parent["columns"][0]["job"]["child"] == "fintech-founders"
    assert parent["items"][0]["runs"]["g9"]["link"] == "fintech-founders"
    assert (await clients.get("/tables/fintech-founders")).json()["parent"] == {"table": "companies", "column": "people"}
    await clients.patch("/tables/fintech-founders", json={"name": "companies-people"})
    assert (await clients.delete("/tables/companies")).status_code == 204
    assert (await clients.get("/tables/companies-people")).json()["parent"] is None


async def test_columns_rows_and_names_are_checked(clients: AsyncClient, table_on):
    bad = await clients.post("/tables", json={"name": "x", "columns": [{"id": "a"}, {"id": "a"}]})
    assert bad.status_code == 422 and bad.json()["detail"]["error"] == "bad_columns"
    # the schema: unknown keys, a bad type or a malformed job are refused
    for col in ({"id": "a", "colour": "red"}, {"id": "a", "type": "favourite"},
                {"id": "a", "job": {"group": "g", "tool": "x", "method": "TRACE"}},
                {"id": "a", "job": {"group": "g", "tool": "x", "judge": {"type": "noul"}}}):
        r = await clients.post("/tables", json={"name": "x", "columns": [col]})
        assert r.status_code == 422, col
    ok = await clients.post("/tables", json={"name": "typed", "columns": [
        {"id": "site", "label": "Site", "type": "website"},
        {"id": "fit", "label": "fit", "job": {"group": "g2", "tool": "openrouter.ai-judge.decide", "field": "value",
         "judge": {"type": "noul", "instructions": "Is this B2B SaaS?", "evidence": ["site"]}}}]})
    assert ok.status_code == 201, ok.text
    # a column may keep to the providers the user picked
    picked = await clients.post("/tables", json={"name": "picked", "columns": [{"id": "email", "label": "email",
        "job": {"group": "g3", "tool": "treg.people.email.find", "field": "email", "exclude": ["hunter", "tomba"]}}]})
    assert picked.json()["columns"][0]["job"]["exclude"] == ["hunter", "tomba"]
    assert ok.json()["columns"][0]["type"] == "website"
    bad_run = await clients.post("/tables/typed/rows", json={"rows": [{"cells": {}, "runs": {"g2": {"state": "done"}}}]})
    assert bad_run.status_code == 422
    await clients.post("/tables", json={"name": "t"})
    bad = await clients.post("/tables/t/rows", json={"rows": [{"id": "../x", "cells": {}}]})
    assert bad.status_code == 422
    huge = await clients.post("/tables/t/rows", json={"rows": [{"cells": {"a": "x" * 70_000}}]})
    assert huge.status_code == 413
    assert (await clients.get("/tables/missing")).status_code == 404


async def test_another_team_cannot_see_or_touch_a_table(clients: AsyncClient, table_on):
    await clients.post("/tables", json={"name": "secret", "rows": [{"id": "r1", "cells": {"a": 1}}]})
    other = await verified_signup(clients, json={"email": "tables-stranger@example.com"})
    stranger = {"X-Treg-Token": other.json()["token"]}
    assert (await clients.get("/tables", headers=stranger)).json() == []
    assert (await clients.get("/tables/secret", headers=stranger)).status_code == 404
    assert (await clients.post("/tables/secret/rows", headers=stranger, json={"rows": []})).status_code == 404
    assert (await clients.delete("/tables/secret", headers=stranger)).status_code == 404


async def test_deleting_the_team_deletes_its_tables_and_rows(clients: AsyncClient, table_on):
    from sqlalchemy import func, select
    from treg.infra.db import session_maker
    from treg.models import TableDoc, TableRow
    other = await verified_signup(clients, json={"email": "tables-leaver@example.com"})
    h = {"X-Treg-Token": other.json()["token"]}
    org = await clients.post("/orgs", headers=h, json={"name": "leaver-team"})
    h = {"X-Treg-Token": org.json()["token"]}
    await clients.post("/tables", headers=h, json={"name": "t", "rows": [{"cells": {"a": 1}}, {"cells": {"a": 2}}]})
    r = await clients.delete(f"/orgs/{org.json()['org_id']}?confirm={org.json()['org']}", headers=h)
    assert r.status_code == 200, r.text
    async with session_maker() as db:
        assert (await db.execute(select(func.count(TableDoc.id)).where(TableDoc.org_id == org.json()["org_id"]))).scalar_one() == 0
        assert (await db.execute(select(func.count(TableRow.id)))).scalar_one() == 0


async def test_csv_export_neutralises_formulas(clients: AsyncClient, table_on):
    await clients.post("/tables", json={"name": "f", "columns": [{"id": "a", "label": "a"}],
                                        "rows": [{"cells": {"a": "=HYPERLINK(\"x\")"}}, {"cells": {"a": -5}}]})
    lines = (await clients.get("/tables/f?format=csv")).text.splitlines()
    assert lines[1] == "\"'=HYPERLINK(\"\"x\"\")\"" and lines[2] == "-5"


# ---- runs on the server (phase 2) -------------------------------------------------------------------

RUN_EP = "tikhub.tiktok.video.comments"      # a real catalog GET endpoint with a platform price


async def _drive_all():
    """What the worker does, in the test's loop: claim each queued run and drive it to its end."""
    import httpx
    from treg.application import table_runs
    async with httpx.AsyncClient() as http:
        while (claimed := await table_runs._claim()) is not None:
            await table_runs._Driver(*claimed, http).drive()


def test_the_server_makes_the_same_idempotency_key_as_the_page():
    # the values frontend/src/openenrich/client.js `idempotencyKey` gives for the same calls, so a
    # row the page already ran replays on the server for nothing
    from treg.application.table_runs import idempotency_key
    assert idempotency_key("treg.people.email.find", "POST", {}, {"domain": "ramp.com", "full_name": "Éric Glyman", "limit": 5},
                           {"exclude": ["hunter"]}) == "oe-0232c24f3b86bb3c7260292868590cab0e466df7e4ec"
    assert idempotency_key(RUN_EP, "GET", {"aweme_id": "7"}, None, {}) == "oe-7b901c9c9cfabeac6601d6d5888529c793d6c6832b43"


async def test_a_run_fills_the_column_on_the_server_and_replays_when_asked_again(clients: AsyncClient, table_on, platform_on, monkeypatch):
    from tests.test_marketplace_call import _fake_relay
    from treg.application.call import service as call_service
    monkeypatch.setattr(call_service, "relay", _fake_relay(200, b'{"data": [{"a": 1}, {"a": 2}]}'))
    cols = [{"id": "vid", "label": "vid"},
            {"id": "a", "label": "a", "job": {"group": "g1", "tool": RUN_EP, "method": "GET", "inputs": {"aweme_id": "{vid}"}, "field": "a"}}]
    # r2's `running` was left by a page closed mid-run: no run owns it, so it is not run yet
    await clients.post("/tables", json={"name": "vids", "columns": cols, "rows": [
        {"id": "r1", "cells": {"vid": "1"}}, {"id": "r2", "cells": {"vid": "2"}, "runs": {"g1": {"state": "running"}}},
        {"id": "r3", "cells": {}}]})
    r = await clients.post("/tables/vids/runs", json={"group": "g1"})
    assert r.status_code == 200, r.text
    assert r.json()["added"] == 3 and r.json()["run"]["state"] == "queued"
    items = (await clients.get("/tables/vids")).json()["items"]
    assert {i["runs"]["g1"]["state"] for i in items} == {"queued"}
    # asking again while it is queued adds nothing: the rows are already in the run
    assert (await clients.post("/tables/vids/runs", json={"group": "g1"})).json()["added"] == 0

    # a row the worker has picked up shows running while its call is out
    from treg.application import table_runs
    seen = []
    real = table_runs._Driver._call
    async def spy(self, caller, req):
        seen.append({i["id"]: i["runs"]["g1"]["state"] for i in (await clients.get("/tables/vids")).json()["items"]})
        return await real(self, caller, req)
    monkeypatch.setattr(table_runs._Driver, "_call", spy)
    await _drive_all()
    assert seen and all(s["r1"] in ("running", "hit") and s["r2"] in ("running", "hit") for s in seen)
    rows = {i["id"]: i for i in (await clients.get("/tables/vids")).json()["items"]}
    assert rows["r1"]["cells"]["a"] == "1, 2" and rows["r1"]["runs"]["g1"]["state"] == "hit"
    assert rows["r1"]["runs"]["g1"]["cost_micro"] > 0 and rows["r1"]["runs"]["g1"]["call_id"]
    assert rows["r3"]["runs"]["g1"]["state"] == "skipped"
    run = (await clients.get("/tables/vids/runs")).json()[0]
    assert (run["state"], run["done"], run["hits"], run["total"]) == ("done", 3, 2, 3)

    # re-running every row asks with the same keys: answered from treg's replay, nothing charged
    spent = run["spent_micro"]
    await clients.post("/tables/vids/runs", json={"group": "g1", "rows": "all"})
    await _drive_all()
    again = (await clients.get("/tables/vids/runs")).json()[0]
    assert again["state"] == "done" and again["hits"] == 2 and again["spent_micro"] == 0 and spent > 0
    rows = {i["id"]: i for i in (await clients.get("/tables/vids")).json()["items"]}
    assert rows["r1"]["runs"]["g1"]["replay"] is True


async def test_a_stopped_run_puts_its_rows_back_and_a_team_runs_three_at_once(clients: AsyncClient, table_on):
    cols = [{"id": f"c{i}", "label": "x", "job": {"group": f"g{i}", "tool": RUN_EP, "method": "GET", "inputs": {"aweme_id": "{v}"}}}
            for i in range(4)]
    await clients.post("/tables", json={"name": "stops", "columns": cols, "rows": [{"id": "r1", "cells": {"v": "1"}}]})
    run = (await clients.post("/tables/stops/runs", json={"group": "g0"})).json()["run"]
    assert (await clients.post("/tables/stops/runs", json={"group": "g1"})).status_code == 200
    assert (await clients.post("/tables/stops/runs", json={"group": "g2"})).status_code == 200
    busy = await clients.post("/tables/stops/runs", json={"group": "g3"})
    assert busy.status_code == 429 and busy.json()["detail"]["error"] == "too_many_runs"
    for g in ("g0", "g1", "g2"):
        rid = next(x["id"] for x in (await clients.get("/tables/stops/runs")).json() if x["group"] == g)
        assert (await clients.post(f"/tables/stops/runs/{rid}/stop")).json()["stopping"] is True
    await _drive_all()
    runs = {x["id"]: x for x in (await clients.get("/tables/stops/runs")).json()}
    assert runs[run["id"]]["state"] == "stopped" and runs[run["id"]]["done"] == 0
    assert (await clients.get("/tables/stops")).json()["items"][0]["runs"] == {}


async def test_a_run_that_lost_its_claim_writes_nothing(clients: AsyncClient, table_on):
    from sqlalchemy import update
    from treg.application import table_runs
    from treg.infra.db import session_maker
    from treg.models import TableRun
    await clients.post("/tables", json={"name": "lease", "columns": [{"id": "c", "label": "c", "job": {
        "group": "g", "tool": RUN_EP, "method": "GET", "inputs": {"aweme_id": "{v}"}}}], "rows": [{"id": "r1", "cells": {}}]})
    await clients.post("/tables/lease/runs", json={"group": "g"})
    run_id, token = await table_runs._claim()
    async with session_maker() as db:     # another process took it over
        await db.execute(update(TableRun).where(TableRun.id == run_id).values(attempts=token + 1))
        await db.commit()
    await table_runs._Driver(run_id, token, None).drive()
    assert (await clients.get("/tables/lease")).json()["items"][0]["runs"]["g"]["state"] == "queued"


def test_a_waterfall_where_nobody_found_it_says_who_could_not_answer():
    from treg.application.table_runs import read_answer
    tried = [{"provider": "hunter", "outcome": "miss"}, {"provider": "tomba", "outcome": "miss"},
             {"provider": "moltsets", "outcome": "error", "status": 429}]
    r = read_answer(502, {"detail": {"error": "route_failed", "tried": tried}})
    assert r["state"] == "error" and r["error"].startswith("No provider found it: 2 had nothing, 1 could not answer (moltsets)")
