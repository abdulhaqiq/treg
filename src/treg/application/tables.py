"""openenrich's team tables (docs/context/architecture/tables.md): store, list, read and merge rows.

Phase 1 is storage only. The page runs a column's job row by row through `/table/<tool>` and writes
each cell back here, so nothing in this module calls a provider or touches money. A table belongs
to the team: every member reads and writes it. The use cases here own their commits.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import TableDoc, TableRow
from ..timeutil import utcnow_naive

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
ROW_KEY = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_TABLES = 500                 # per team
MAX_ROWS = 10_000                # per table
MAX_ROW_BYTES = 64 * 1024        # one row's cells and runs, as JSON
MAX_COLUMNS_BYTES = 256 * 1024   # a table's column list, as JSON
MAX_PAGE = 5_000                 # rows one read returns


# ---- the schema every writer meets (the page now; the worker and agents in phase 2) ----------------

COLUMN_ID = r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$"
# What a column holds, detected from its values (or judged by Jev) so a job's inputs map by type.
COLUMN_TYPES = ("company_name", "domain", "website", "email", "person_name", "first_name", "last_name",
                "linkedin_person", "linkedin_company", "job_title", "phone", "location", "industry",
                "x_handle", "ip", "number", "boolean", "other")


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Judge(_Strict):
    """An AI judgment column (Jev through `openrouter.ai-judge.decide`): a yes/no, a label or a score
    over the row's evidence columns."""
    type: Literal["noul", "choice", "score"]
    instructions: str = Field(min_length=1, max_length=2000)
    labels: list[str] = Field(default_factory=list, max_length=50)
    levels: int | None = Field(default=None, ge=2, le=10)
    evidence: list[str] = Field(default_factory=list, max_length=100)


class Job(_Strict):
    """What fills a column: a catalog or hub tool, how its inputs come from the row (`{column}`
    templates or a typed value), the output field it takes, and the group of columns one call fills."""
    group: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    tool: str = Field(pattern=r"^[\w.@-]{1,200}$")
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"] = "POST"
    inputs: dict[str, Any] = Field(default_factory=dict)
    field: str | None = None
    needs: list[list[str]] = Field(default_factory=list)
    maxCost: float | None = Field(default=None, ge=0, le=100)   # noqa: N815 — the page's spelling
    linked: bool = False
    limit: int | None = Field(default=None, ge=1, le=100)
    child: str | None = None
    judge: Judge | None = None
    policy: Literal["manual", "auto"] = "manual"


class Column(_Strict):
    id: str = Field(pattern=COLUMN_ID)
    label: str = Field(default="", max_length=200)
    type: Literal[COLUMN_TYPES] | None = None  # type: ignore[valid-type]
    job: Job | None = None


class Run(_Strict):
    """One call for one row and one column group, kept once however many columns it fills: the
    cells hold only the values, the call's evidence lives here (the raw answer stays with the call
    record and the archive, reached by `call_id`)."""
    state: Literal["queued", "running", "hit", "miss", "error", "skipped"]
    call_id: str | None = None
    inputs: dict[str, Any] = Field(default_factory=dict)
    served_by: str | None = None
    cost_micro: int = Field(default=0, ge=0)
    replay: bool = False
    error: str | None = Field(default=None, max_length=2000)
    link: str | None = None          # a linked table this run wrote (Find people at company)
    confidence: float | None = None  # a judgment's probability
    at: str | None = None


def _validate(model: type[BaseModel], value: Any, error: str) -> Any:
    try:
        return model.model_validate(value).model_dump(exclude_none=True, exclude_defaults=True)
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        raise TableError(422, error, f"{where}: {first.get('msg')}") from None


class TableError(Exception):
    def __init__(self, status: int, error: str, message: str):
        super().__init__(message)
        self.status, self.error, self.message = status, error, message


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:60].strip("-")
    return s or "table"


def _size(value: Any) -> int:
    return len(json.dumps(value, separators=(",", ":"), default=str))


def _columns(columns: Any) -> list[dict]:
    if not isinstance(columns, list):
        raise TableError(422, "bad_columns", "columns must be a list of objects, each with a string id")
    columns = [_validate(Column, c, "bad_columns") for c in columns]
    ids = [c["id"] for c in columns]
    if len(ids) != len(set(ids)):
        raise TableError(422, "bad_columns", "column ids must be unique")
    if _size(columns) > MAX_COLUMNS_BYTES:
        raise TableError(413, "columns_too_large", f"a table's columns are at most {MAX_COLUMNS_BYTES} bytes")
    return columns


def _view(doc: TableDoc, rows: int | None = None) -> dict:
    out = {"name": doc.name, "kind": doc.kind, "source": doc.source, "columns": doc.columns,
           "parent": None, "created_by": doc.created_by,
           "created_at": doc.created_at.isoformat(), "updated_at": doc.updated_at.isoformat()}
    if rows is not None:
        out["rows"] = rows
    return out


async def _doc(db: AsyncSession, org_id: int, name: str) -> TableDoc:
    doc = (await db.execute(select(TableDoc).where(TableDoc.org_id == org_id, TableDoc.name == name))).scalar_one_or_none()
    if doc is None:
        raise TableError(404, "no_table", f"no table named {name!r} in this team")
    return doc


async def _parent_view(db: AsyncSession, doc: TableDoc) -> dict | None:
    if doc.parent_id is None:
        return None
    parent = await db.get(TableDoc, doc.parent_id)
    if parent is None or parent.org_id != doc.org_id:
        return None
    return {"table": parent.name, "column": doc.parent_column}


async def list_tables(db: AsyncSession, org_id: int) -> list[dict]:
    docs = (await db.execute(select(TableDoc).where(TableDoc.org_id == org_id)
                             .order_by(TableDoc.updated_at.desc()))).scalars().all()
    counts = dict((await db.execute(
        select(TableRow.table_id, func.count(TableRow.id)).where(TableRow.table_id.in_([d.id for d in docs]))
        .group_by(TableRow.table_id))).all()) if docs else {}
    names = {d.id: d.name for d in docs}
    out = []
    for d in docs:
        v = _view(d, counts.get(d.id, 0))
        v["columns"] = len(d.columns)
        v["parent"] = {"table": names[d.parent_id], "column": d.parent_column} if d.parent_id in names else None
        out.append(v)
    return out


async def _free_name(db: AsyncSession, org_id: int, wanted: str) -> str:
    base = slug(wanted)
    taken = set((await db.execute(select(TableDoc.name).where(
        TableDoc.org_id == org_id, TableDoc.name.like(f"{base}%")))).scalars().all())
    name, n = base, 2
    while name in taken:
        name, n = f"{base}-{n}", n + 1
    return name


async def create_table(db: AsyncSession, *, org_id: int, email: str, body: dict) -> dict:
    """A new table, its name made unique in the team (`fintech`, `fintech-2`). With `parent`, a
    linked table: the rows another table's column produced (people at each company)."""
    count = (await db.execute(select(func.count(TableDoc.id)).where(TableDoc.org_id == org_id))).scalar_one()
    if count >= MAX_TABLES:
        raise TableError(409, "too_many_tables", f"a team keeps at most {MAX_TABLES} tables; delete one first")
    columns = _columns(body.get("columns") or [])
    rows = body.get("rows") or []
    if not isinstance(rows, list) or len(rows) > MAX_ROWS:
        raise TableError(413, "too_many_rows", f"a table holds at most {MAX_ROWS} rows")
    parent_id = None
    parent = body.get("parent")
    if isinstance(parent, dict) and parent.get("table"):
        parent_id = (await _doc(db, org_id, str(parent["table"]))).id
    name = await _free_name(db, org_id, body.get("name") or "table")
    doc = TableDoc(org_id=org_id, name=name, kind=str(body.get("kind") or "")[:20], parent_id=parent_id,
                   parent_column=(parent or {}).get("column") if parent_id else None,
                   source=body.get("source") if isinstance(body.get("source"), dict) else None,
                   columns=columns, created_by=email)
    db.add(doc)
    await db.flush()
    _insert(db, doc.id, _clean_rows(rows), start=0)
    await db.commit()
    return await get_table(db, org_id=org_id, name=name)


def _clean_rows(rows: list) -> list[dict]:
    out = []
    for r in rows:
        if not isinstance(r, dict):
            raise TableError(422, "bad_rows", "each row is an object with `cells`")
        key = r.get("id")
        if key is not None and not (isinstance(key, str) and ROW_KEY.match(key)):
            raise TableError(422, "bad_rows", "a row id is 1-64 letters, digits, '-' or '_'")
        cells = r.get("cells") or {}
        if not isinstance(cells, dict):
            raise TableError(422, "bad_rows", "a row's cells are an object keyed by column id")
        runs = r.get("runs") or {}
        if not isinstance(runs, dict):
            raise TableError(422, "bad_rows", "a row's runs are an object keyed by column group")
        # a run of None clears that group (a column re-run from scratch, or deleted)
        runs = {g: (None if v is None else _validate(Run, v, "bad_rows")) for g, v in runs.items()}
        if _size(cells) + _size(runs) > MAX_ROW_BYTES:
            raise TableError(413, "row_too_large", f"one row's cells and runs are at most {MAX_ROW_BYTES} bytes")
        parent_row = r.get("parent_row")
        out.append({"id": key, "cells": cells, "runs": runs,
                    "parent_row": parent_row if isinstance(parent_row, str) else None})
    return out


def _insert(db: AsyncSession, table_id: int, rows: list[dict], *, start: int) -> list[str]:
    import secrets
    keys = []
    for i, r in enumerate(rows):
        key = r["id"] or "r" + secrets.token_hex(6)
        keys.append(key)
        db.add(TableRow(table_id=table_id, row_key=key, parent_row=r["parent_row"], position=start + i,
                        cells=r["cells"], runs={g: v for g, v in r["runs"].items() if v is not None}))
    return keys


async def get_table(db: AsyncSession, *, org_id: int, name: str, offset: int = 0, limit: int = MAX_PAGE) -> dict:
    doc = await _doc(db, org_id, name)
    limit = max(1, min(int(limit), MAX_PAGE))
    total = (await db.execute(select(func.count(TableRow.id)).where(TableRow.table_id == doc.id))).scalar_one()
    rows = (await db.execute(select(TableRow).where(TableRow.table_id == doc.id)
                             .order_by(TableRow.position, TableRow.id).offset(max(0, int(offset))).limit(limit))).scalars().all()
    out = _view(doc, total)
    out["parent"] = await _parent_view(db, doc)
    out["offset"] = offset
    out["has_more"] = offset + len(rows) < total
    out["items"] = [{"id": r.row_key, "parent_row": r.parent_row, "cells": r.cells, "runs": r.runs or {}} for r in rows]
    return out


async def update_table(db: AsyncSession, *, org_id: int, name: str, body: dict) -> dict:
    """Rename a table and/or replace its column list (the page owns the columns' order and jobs)."""
    doc = await _doc(db, org_id, name)
    if "columns" in body:
        doc.columns = _columns(body["columns"])
    if body.get("name") and slug(body["name"]) != doc.name:
        old = doc.name
        doc.name = await _free_name(db, org_id, body["name"])
        if doc.parent_id is not None:
            await _relink(db, doc.parent_id, old, doc.name)
    doc.updated_at = utcnow_naive()
    await db.commit()
    return await get_table(db, org_id=org_id, name=doc.name, limit=1)


async def _relink(db: AsyncSession, parent_id: int, old: str, new: str) -> None:
    """A linked table is named in its parent: the column that writes to it (`job.child`) and each
    row's run (`link`). A rename follows it there, or the parent's people links open nothing."""
    parent = await db.get(TableDoc, parent_id)
    if parent is None:
        return
    parent.columns = [{**c, "job": {**c["job"], "child": new}} if (c.get("job") or {}).get("child") == old else c
                      for c in parent.columns or []]
    for row in (await db.execute(select(TableRow).where(TableRow.table_id == parent_id))).scalars().all():
        if any((r or {}).get("link") == old for r in (row.runs or {}).values()):
            row.runs = {g: ({**r, "link": new} if (r or {}).get("link") == old else r) for g, r in row.runs.items()}


async def delete_table(db: AsyncSession, *, org_id: int, name: str) -> None:
    """Delete a table and its rows. A linked table made from it stays, unlinked."""
    doc = await _doc(db, org_id, name)
    await db.execute(delete(TableRow).where(TableRow.table_id == doc.id))
    for child in (await db.execute(select(TableDoc).where(TableDoc.parent_id == doc.id))).scalars().all():
        child.parent_id, child.parent_column = None, None
    await db.delete(doc)
    await db.commit()


async def upsert_rows(db: AsyncSession, *, org_id: int, name: str, rows: list,
                      replace_parent_rows: list | None = None) -> dict:
    """Merge rows into a table. A row whose id exists gets only the cells it sends replaced (a
    teammate's or the page's other cells stay); a row without a known id is added at the end. With
    `replace_parent_rows`, the rows of those parents are removed first (re-running "find people
    at company" for a company replaces its people)."""
    doc = await _doc(db, org_id, name)
    clean = _clean_rows(rows if isinstance(rows, list) else [])
    if replace_parent_rows:
        await db.execute(delete(TableRow).where(TableRow.table_id == doc.id,
                                                TableRow.parent_row.in_([str(p) for p in replace_parent_rows])))
    keys = [r["id"] for r in clean if r["id"]]
    existing = {r.row_key: r for r in (await db.execute(
        select(TableRow).where(TableRow.table_id == doc.id, TableRow.row_key.in_(keys)))).scalars().all()} if keys else {}
    total, last = (await db.execute(select(func.count(TableRow.id), func.max(TableRow.position))
                                    .where(TableRow.table_id == doc.id))).one()
    new = [r for r in clean if r["id"] not in existing]
    if total + len(new) > MAX_ROWS:
        raise TableError(413, "too_many_rows", f"a table holds at most {MAX_ROWS} rows")
    now = utcnow_naive()
    for r in clean:
        row = existing.get(r["id"])
        if row is None:
            continue
        # a cell sent as null is removed (a deleted or re-set column), as a run of null is
        merged = {k: v for k, v in {**row.cells, **r["cells"]}.items() if v is not None}
        runs = {**(row.runs or {}), **r["runs"]}
        runs = {g: v for g, v in runs.items() if v is not None}
        if _size(merged) + _size(runs) > MAX_ROW_BYTES:
            raise TableError(413, "row_too_large", f"one row's cells and runs are at most {MAX_ROW_BYTES} bytes")
        row.cells, row.runs, row.updated_at = merged, runs, now
    added = _insert(db, doc.id, new, start=(last if last is not None else -1) + 1)
    doc.updated_at = now
    await db.commit()
    return {"updated": len(clean) - len(new), "added": added}


async def delete_rows(db: AsyncSession, *, org_id: int, name: str, ids: list) -> dict:
    doc = await _doc(db, org_id, name)
    keys = [str(i) for i in ids or []]
    result = await db.execute(delete(TableRow).where(TableRow.table_id == doc.id, TableRow.row_key.in_(keys)))
    doc.updated_at = utcnow_naive()
    await db.commit()
    return {"deleted": result.rowcount or 0}
