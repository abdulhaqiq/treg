"""openenrich's team tables over HTTP (docs/context/architecture/tables.md): `/tables`.

The same members and flag as `/table/` (`TREG_TABLE_ENABLED`, `TREG_TABLE_TEAMS`, `TREG_TABLE_USERS`):
a caller outside them gets a plain 404. The use cases live in `application.tables`.
"""

from __future__ import annotations

import csv
import io
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import JSONResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession

from ..application import table as table_app
from ..application import tables as tables_app
from ..domain.identity.access import Caller, require_member
from ..infra.db import get_session

app = APIRouter()


def _require_tables(caller: Caller) -> None:
    if not table_app.enabled_for(caller.org.slug, caller.email):
        raise HTTPException(status_code=404, detail="Not Found")


def _error(exc: tables_app.TableError) -> JSONResponse:
    return JSONResponse({"detail": {"error": exc.error, "message": exc.message}}, status_code=exc.status)


@app.get("/tables")
async def list_tables(caller: Caller = Depends(require_member), db: AsyncSession = Depends(get_session)) -> Any:
    """The team's tables, newest first: name, kind, row and column counts, the parent of a linked one."""
    _require_tables(caller)
    return await tables_app.list_tables(db, caller.org_id)


@app.post("/tables", status_code=201)
async def create_table(body: dict = Body(...), caller: Caller = Depends(require_member),
                       db: AsyncSession = Depends(get_session)) -> Any:
    """{name, kind?, columns?, rows?: [{id?, cells, parent_row?}], source?, parent?: {table, column}}."""
    _require_tables(caller)
    try:
        return await tables_app.create_table(db, org_id=caller.org_id, email=caller.email, body=body)
    except tables_app.TableError as exc:
        return _error(exc)


@app.get("/tables/{name}")
async def get_table(name: str, offset: int = Query(0, ge=0), limit: int = Query(tables_app.MAX_PAGE, ge=1),
                    format: str = Query("json"), caller: Caller = Depends(require_member),
                    db: AsyncSession = Depends(get_session)) -> Any:
    """The table and a page of its rows (`items`, `has_more`). `?format=csv` answers every row as CSV,
    a job cell as its value."""
    _require_tables(caller)
    try:
        if format == "csv":
            return _csv(await _all_rows(db, caller.org_id, name), name)
        return await tables_app.get_table(db, org_id=caller.org_id, name=name, offset=offset, limit=limit)
    except tables_app.TableError as exc:
        return _error(exc)


async def _all_rows(db: AsyncSession, org_id: int, name: str) -> dict:
    page = await tables_app.get_table(db, org_id=org_id, name=name, limit=tables_app.MAX_PAGE)
    items = page["items"]
    while page["has_more"]:
        page = await tables_app.get_table(db, org_id=org_id, name=name, offset=len(items), limit=tables_app.MAX_PAGE)
        items += page["items"]
    return {**page, "items": items}


def _csv(table: dict, name: str) -> Response:
    columns = table["columns"]
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow([c.get("label") or c["id"] for c in columns])
    for row in table["items"]:
        values = []
        for c in columns:
            cell = row["cells"].get(c["id"])
            value = cell.get("value") if isinstance(cell, dict) else cell
            values.append("" if value is None else value if isinstance(value, (str, int, float)) else str(value))
        writer.writerow(values)
    return Response(out.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="{name}.csv"'})


@app.patch("/tables/{name}")
async def update_table(name: str, body: dict = Body(...), caller: Caller = Depends(require_member),
                       db: AsyncSession = Depends(get_session)) -> Any:
    """{name?, columns?}: rename, or replace the column list."""
    _require_tables(caller)
    try:
        return await tables_app.update_table(db, org_id=caller.org_id, name=name, body=body)
    except tables_app.TableError as exc:
        return _error(exc)


@app.delete("/tables/{name}", status_code=204, response_class=Response)
async def delete_table(name: str, caller: Caller = Depends(require_member),
                       db: AsyncSession = Depends(get_session)) -> Response:
    _require_tables(caller)
    try:
        await tables_app.delete_table(db, org_id=caller.org_id, name=name)
    except tables_app.TableError as exc:
        return _error(exc)
    return Response(status_code=204)


@app.post("/tables/{name}/rows")
async def upsert_rows(name: str, body: dict = Body(...), caller: Caller = Depends(require_member),
                      db: AsyncSession = Depends(get_session)) -> Any:
    """{rows: [{id?, cells, parent_row?}], replace_parent_rows?: [row id]}: merge by row id, add the rest."""
    _require_tables(caller)
    try:
        return await tables_app.upsert_rows(db, org_id=caller.org_id, name=name, rows=body.get("rows") or [],
                                            replace_parent_rows=body.get("replace_parent_rows"))
    except tables_app.TableError as exc:
        return _error(exc)


@app.post("/tables/{name}/rows/delete")
async def delete_rows(name: str, body: dict = Body(...), caller: Caller = Depends(require_member),
                      db: AsyncSession = Depends(get_session)) -> Any:
    """{ids: [row id]}."""
    _require_tables(caller)
    try:
        return await tables_app.delete_rows(db, org_id=caller.org_id, name=name, ids=body.get("ids") or [])
    except tables_app.TableError as exc:
        return _error(exc)
