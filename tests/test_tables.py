"""openenrich's team tables (`/tables`, docs/context/architecture/tables.md): stored per team, rows
merged by id, gated like `/table/`."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from conftest import verified_signup
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

    # merge: only the sent cells change, a new id is added at the end
    cell = {"value": "eric@ramp.com", "state": "hit", "served_by": "x.find", "cost_micro": 5000, "call_id": "c1"}
    r = await clients.post("/tables/fintech-q4/rows", json={"rows": [{"id": "r1", "cells": {"email": cell}},
                                                                    {"id": "r9", "cells": {"name": "Brex"}}]})
    assert r.json() == {"updated": 1, "added": ["r9"]}
    t = (await clients.get("/tables/fintech-q4")).json()
    row = {i["id"]: i for i in t["items"]}
    assert row["r1"]["cells"] == {"name": "Ramp", "domain": "ramp.com", "email": cell}
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
    assert (await clients.delete("/tables/companies")).status_code == 204
    assert (await clients.get("/tables/companies-people")).json()["parent"] is None


async def test_columns_rows_and_names_are_checked(clients: AsyncClient, table_on):
    bad = await clients.post("/tables", json={"name": "x", "columns": [{"id": "a"}, {"id": "a"}]})
    assert bad.status_code == 422 and bad.json()["detail"]["error"] == "bad_columns"
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
