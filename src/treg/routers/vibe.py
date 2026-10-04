"""Vibe-it's routes (docs/context/architecture/vibe-it.md): the page, the conversations, the draft.

Behind TREG_VIBE_ENABLED and the hub's own flag and lists: off, or off for this person, every route
answers 404. A signed-in person in the browser only: an agent token is refused, because the model
budget is a person's, and an agent already has the hub's own routes.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..application import vibe as vibe_app
from ..application.vibe import agent as vibe_agent
from ..config import get_settings
from ..domain.identity.access import Caller, _require_can_register, require_member
from ..infra import kv
from ..infra.db import get_session
from .auth_helpers import _same_origin
from .web import page_entry

app = APIRouter()

MESSAGES_PER_MINUTE = 12
_busy: set[int] = set()          # one agent loop per conversation at a time (one process)


def _require_vibe(request: Request, caller: Caller) -> None:
    if not vibe_app.enabled_for(caller.org.slug, caller.email):
        raise HTTPException(status_code=404, detail="Not Found")
    if request.headers.get("x-treg-token") or not request.cookies.get("treg_session"):
        raise HTTPException(status_code=403, detail={"error": "vibe_browser_only",
                                                     "message": "vibe-it is used signed in, in the browser"})


def _require_same_origin(request: Request) -> None:
    if not _same_origin(request):
        raise HTTPException(status_code=403, detail="cross-origin request rejected")


async def _owned(db: AsyncSession, caller: Caller, session_id: int):
    row = await vibe_app.of_user(db, user_id=caller.user.id, session_id=session_id)
    if row is None or row.org_id != caller.org_id:
        raise HTTPException(status_code=404, detail="no such conversation")
    return row


async def _view(db: AsyncSession, row) -> dict[str, Any]:
    return {**vibe_app.view_session(row), "draft": vibe_app.clean_draft(row.draft), "summary": row.summary,
            "messages": [vibe_app.view_message(m) for m in await vibe_app.messages(db, row.id)],
            "busy": row.id in _busy}


class NewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="", max_length=vibe_app.TITLE_MAX)


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=vibe_app.TEXT_MAX)


class DraftIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    manifest: dict[str, Any] | None = None
    script: str | None = Field(default=None, max_length=200_000)
    check: dict[str, Any] | None = None
    readme: str | None = Field(default=None, max_length=4000)


class TestIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    inputs: dict[str, Any] = Field(default_factory=dict)


@app.get("/vibe-it", include_in_schema=False)
async def vibe_page():
    """The page itself; it asks the API who is signed in, and says so when vibe-it is off for them."""
    if not get_settings().vibe_enabled:
        raise HTTPException(status_code=404, detail="Not Found")
    return page_entry("vibe")


@app.get("/vibe/state")
async def vibe_state(request: Request, caller: Caller = Depends(require_member),
                     db: AsyncSession = Depends(get_session)) -> dict:
    """The budget left, and this team's conversations."""
    _require_vibe(request, caller)
    rows = await vibe_app.list_for(db, user_id=caller.user.id, org_id=caller.org_id)
    return {"team": caller.org.slug, "email": caller.email,
            "budget_micro": vibe_app.budget_micro(), "left_micro": await vibe_app.left_micro(db, caller.user.id),
            "sessions": [vibe_app.view_session(r) for r in rows]}


@app.post("/vibe/sessions", status_code=201)
async def vibe_new(body: NewIn, request: Request, caller: Caller = Depends(require_member),
                   db: AsyncSession = Depends(get_session)) -> dict:
    _require_vibe(request, caller)
    _require_can_register(caller)
    _require_same_origin(request)
    row = await vibe_app.create(db, user_id=caller.user.id, org_id=caller.org_id, title=body.title)
    await db.commit()
    return await _view(db, row)


@app.get("/vibe/sessions/{session_id}")
async def vibe_get(session_id: int, request: Request, caller: Caller = Depends(require_member),
                   db: AsyncSession = Depends(get_session)) -> dict:
    _require_vibe(request, caller)
    return await _view(db, await _owned(db, caller, session_id))


@app.delete("/vibe/sessions/{session_id}")
async def vibe_delete(session_id: int, request: Request, caller: Caller = Depends(require_member),
                      db: AsyncSession = Depends(get_session)) -> dict:
    _require_vibe(request, caller)
    _require_same_origin(request)
    row = await _owned(db, caller, session_id)
    await vibe_app.remove(db, row)
    await db.commit()
    return {"deleted": session_id}


@app.post("/vibe/sessions/{session_id}/messages")
async def vibe_message(session_id: int, body: MessageIn, request: Request, caller: Caller = Depends(require_member),
                       db: AsyncSession = Depends(get_session)) -> dict:
    """The maker says something; the agent works (searching, writing files, test runs it was allowed)
    until it answers. Can take a minute. The whole conversation comes back."""
    _require_vibe(request, caller)
    _require_can_register(caller)
    _require_same_origin(request)
    row = await _owned(db, caller, session_id)
    if not get_settings().ai_gateway_api_key:
        raise HTTPException(status_code=503, detail={"error": "vibe_no_model", "message": "no model is configured on this registry"})
    if not await kv.store().take(f"vibe:msg:{caller.user.id}", MESSAGES_PER_MINUTE, 60):
        raise HTTPException(status_code=429, detail={"error": "vibe_busy", "message": "too many messages; wait a minute"})
    if row.id in _busy:
        raise HTTPException(status_code=409, detail={"error": "vibe_working", "message": "still working on your last message"})
    _busy.add(row.id)
    try:
        await vibe_agent.send(db, row, caller.org, user_id=caller.user.id, text=body.text, app=request.app,
                              headers=dict(request.headers))
    finally:
        _busy.discard(row.id)
    return await _view(db, row)


@app.put("/vibe/sessions/{session_id}/draft")
async def vibe_draft(session_id: int, body: DraftIn, request: Request, caller: Caller = Depends(require_member),
                     db: AsyncSession = Depends(get_session)) -> dict:
    """The maker's own edits to the files; the agent reads them on its next turn."""
    _require_vibe(request, caller)
    _require_same_origin(request)
    row = await _owned(db, caller, session_id)
    await vibe_app.set_draft(db, row, body.model_dump(exclude_none=True))
    problem = await vibe_agent.validate(db, row, caller.org)
    await db.commit()
    return {"draft": vibe_app.clean_draft(row.draft), "problem": problem}


@app.post("/vibe/sessions/{session_id}/validate")
async def vibe_validate(session_id: int, request: Request, caller: Caller = Depends(require_member),
                        db: AsyncSession = Depends(get_session)) -> dict:
    _require_vibe(request, caller)
    row = await _owned(db, caller, session_id)
    return {"problem": await vibe_agent.validate(db, row, caller.org)}


@app.post("/vibe/sessions/{session_id}/test")
async def vibe_test(session_id: int, body: TestIn, request: Request, caller: Caller = Depends(require_member),
                    db: AsyncSession = Depends(get_session)) -> dict:
    """A real test run of the draft on the team's balance (`POST /hub/run`); nothing is published."""
    _require_vibe(request, caller)
    _require_can_register(caller)
    _require_same_origin(request)
    row = await _owned(db, caller, session_id)
    draft = vibe_app.clean_draft(row.draft)
    await db.commit()
    status, out = await vibe_agent.test_run(request.app, _maker_headers(request), draft, body.inputs)
    return {"status": status, "result": out}


@app.post("/vibe/sessions/{session_id}/publish")
async def vibe_publish(session_id: int, request: Request, caller: Caller = Depends(require_member),
                       db: AsyncSession = Depends(get_session)) -> dict:
    """Publish the draft as the team's hub tool (a new version when it exists)."""
    _require_vibe(request, caller)
    _require_can_register(caller)
    _require_same_origin(request)
    row = await _owned(db, caller, session_id)
    draft = vibe_app.clean_draft(row.draft)
    await db.commit()
    status, out = await vibe_agent.publish(request.app, _maker_headers(request), draft, caller.org.slug)
    if status in (200, 201) and isinstance(out, dict) and out.get("tool_id"):
        row.tool_id = out["tool_id"]
        await db.commit()
    return {"status": status, "result": out}


def _maker_headers(request: Request) -> dict[str, str]:
    h = {k: v for k, v in request.headers.items() if k.lower() in ("cookie", "x-treg-org")}
    h["X-Treg-Client"] = "vibe-it"
    return h
