"""Vibe-it: a maker and treg's agent build a hub tool in conversation
(docs/context/architecture/vibe-it.md).

The only writer of `VibeSession`, `VibeMessage` and `VibeBudget`. Everything the agent does to the
team (validate, test run, publish, turn on an app) goes through the hub's own routes as the
signed-in maker, so it can do nothing the maker could not. treg pays for the model, up to
`vibe_budget_usd` per person; a test run's steps are charged to the maker's team as always.
Functions here never commit unless they say so: the route does.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ...config import get_settings
from ...models import VibeBudget, VibeMessage, VibeSession
from ...timeutil import utcnow_naive
from ..hub import enabled_for as hub_enabled_for

DRAFT_KEYS = ("manifest", "script", "check", "readme")
TITLE_MAX = 80
TEXT_MAX = 8000


def enabled_for(org_slug: str | None, email: str | None = None) -> bool:
    """Vibe-it is on AND the hub is on for this reader."""
    return bool(get_settings().vibe_enabled) and hub_enabled_for(org_slug, email)


def budget_micro() -> int:
    return int(round(max(0.0, float(get_settings().vibe_budget_usd)) * 1_000_000))


async def spent_micro(db: AsyncSession, user_id: int) -> int:
    row = await db.get(VibeBudget, user_id)
    return int(row.spent_micro) if row else 0


async def left_micro(db: AsyncSession, user_id: int) -> int:
    return max(0, budget_micro() - await spent_micro(db, user_id))


async def spend(db: AsyncSession, user_id: int, micro: int) -> None:
    """Record treg's model spend on this person. Never below zero; never restored."""
    if micro <= 0:
        return
    row = await db.get(VibeBudget, user_id)
    if row is None:
        db.add(VibeBudget(user_id=user_id, spent_micro=micro, updated_at=utcnow_naive()))
    else:
        row.spent_micro += micro
        row.updated_at = utcnow_naive()
    await db.flush()


def clean_draft(draft: Any) -> dict[str, Any]:
    """The four files and nothing else: manifest and check are objects, script and readme text."""
    d = draft if isinstance(draft, dict) else {}
    out: dict[str, Any] = {}
    for k in ("manifest", "check"):
        if isinstance(d.get(k), dict):
            out[k] = d[k]
    for k in ("script", "readme"):
        if isinstance(d.get(k), str):
            out[k] = d[k][:200_000]
    return out


async def create(db: AsyncSession, *, user_id: int, org_id: int, title: str = "") -> VibeSession:
    now = utcnow_naive()
    row = VibeSession(user_id=user_id, org_id=org_id, title=(title or "New tool")[:TITLE_MAX], draft={},
                      created_at=now, updated_at=now)
    db.add(row)
    await db.flush()
    return row


async def of_user(db: AsyncSession, *, user_id: int, session_id: int) -> VibeSession | None:
    row = await db.get(VibeSession, session_id)
    return row if row is not None and row.user_id == user_id else None


async def list_for(db: AsyncSession, *, user_id: int, org_id: int) -> list[VibeSession]:
    return list((await db.execute(select(VibeSession).where(
        VibeSession.user_id == user_id, VibeSession.org_id == org_id)
        .order_by(VibeSession.updated_at.desc()).limit(100))).scalars().all())


async def messages(db: AsyncSession, session_id: int) -> list[VibeMessage]:
    return list((await db.execute(select(VibeMessage).where(VibeMessage.session_id == session_id)
                                  .order_by(VibeMessage.id))).scalars().all())


async def add_message(db: AsyncSession, session: VibeSession, role: str, content: dict, cost_micro: int = 0) -> VibeMessage:
    msg = VibeMessage(session_id=session.id, role=role, content=content, cost_micro=cost_micro, created_at=utcnow_naive())
    db.add(msg)
    session.updated_at = utcnow_naive()
    await db.flush()
    return msg


async def set_draft(db: AsyncSession, session: VibeSession, draft: Any) -> VibeSession:
    session.draft = {**(session.draft or {}), **clean_draft(draft)}
    name = (session.draft.get("manifest") or {}).get("name")
    if isinstance(name, str) and name and session.title in ("", "New tool"):
        session.title = name[:TITLE_MAX]
    session.updated_at = utcnow_naive()
    await db.flush()
    return session


async def remove(db: AsyncSession, session: VibeSession) -> None:
    await db.execute(delete(VibeMessage).where(VibeMessage.session_id == session.id))
    await db.delete(session)
    await db.flush()


async def forget_user(db: AsyncSession, user_id: int) -> None:
    """A person is deleted: their conversations and their budget row go too."""
    ids = select(VibeSession.id).where(VibeSession.user_id == user_id)
    await db.execute(delete(VibeMessage).where(VibeMessage.session_id.in_(ids)))
    await db.execute(delete(VibeSession).where(VibeSession.user_id == user_id))
    await db.execute(delete(VibeBudget).where(VibeBudget.user_id == user_id))
    await db.flush()


def view_session(s: VibeSession) -> dict[str, Any]:
    return {"id": s.id, "title": s.title, "tool_id": s.tool_id, "updated_at": s.updated_at.isoformat(),
            "trimmed": bool(s.summary)}


def view_message(m: VibeMessage) -> dict[str, Any]:
    """What the page shows: a user's text, the agent's text, and each tool step in short."""
    c = m.content or {}
    out: dict[str, Any] = {"id": m.id, "role": m.role, "at": m.created_at.isoformat()}
    if m.role == "tool":
        out.update({"name": c.get("name"), "summary": c.get("summary") or "", "ok": c.get("ok", True)})
    else:
        out["text"] = c.get("text") or ""
        if c.get("tool_calls"):
            out["calls"] = [t.get("name") for t in c["tool_calls"]]
    return out


async def trim_idle(db: AsyncSession, *, now=None) -> int:
    """Option C of the plan: a conversation idle for `vibe_trim_after_days` keeps its draft, its
    published tool and a short summary; its messages go. No model call: the summary is the
    maker's own first ask and the agent's last answer. Returns how many were trimmed. Does not commit."""
    cutoff = (now or utcnow_naive()) - timedelta(days=max(1, int(get_settings().vibe_trim_after_days)))
    rows = (await db.execute(select(VibeSession).where(
        VibeSession.updated_at < cutoff, VibeSession.summary.is_(None)))).scalars().all()
    for s in rows:
        msgs = await messages(db, s.id)
        if not msgs:
            continue
        first = next((m.content.get("text", "") for m in msgs if m.role == "user"), "")
        last = next((m.content.get("text", "") for m in reversed(msgs) if m.role == "assistant" and m.content.get("text")), "")
        s.summary = (f"Earlier in this conversation the maker asked: {first[:1200]}\n"
                     f"The agent's last answer was: {last[:1200]}")[:3000]
        await db.execute(delete(VibeMessage).where(VibeMessage.session_id == s.id))
    await db.flush()
    return len(rows)
