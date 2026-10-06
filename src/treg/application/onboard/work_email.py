"""Is a new user's email their company's own? The first-run experiment is for work addresses only.

Two steps, cheapest first. A domain on the catalog's free-mail list (`paths.email_domain`: free
mailboxes, ISPs, disposable addresses) is personal, at once and for free. Any other domain is put to
Jev once, as a house call, with what its homepage says (a domain's spelling alone leaves small
companies and throwaway mail services near even odds), and the verdict is kept per domain: the first
sign-up from a domain pays a judgment, the rest read it. When Jev cannot answer, the domain counts as
personal for ten minutes, then is asked again. The verdict only decides who may enter the experiment;
it never blocks a sign-up.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

from ... import ratestore
from ...config import get_settings
from ...domain.catalog.routing.paths import email_domain
from ...infra.db import session_maker
from ..house_calls import HouseCalls
from . import page
from .lookup import JEV_ENDPOINT, JEV_MODEL

log = logging.getLogger("treg.onboarding")

NS = "onboarding_work_domain"    # renamed when the question changed: verdicts to the old one are not kept
TTL_S = 30 * 86400
UNKNOWN_TTL_S = 600      # a domain Jev could not judge is treated as personal this long, then asked again
JUDGE_TIMEOUT_S = 6
HOMEPAGE_S = 3           # the homepage is read this long at most; without it Jev judges the name alone
WORK = 0.5        # Jev's yes probability at which a domain counts as a company's own. Even odds count:
                  # a personal domain in the new flow costs little, a company left out costs a sample


QUESTION = ("Is {domain} the email domain of a company or organisation that its people work for, as "
            "opposed to a free, personal, ISP, school or disposable mailbox? Use its homepage when there is one.")
CRITERIA = {"true": "A business's own domain: the address belongs to someone at that company, whose site it is.",
            "false": "Anyone can get an address there (a mail, temporary-address or hosting service), or it is "
                     "a school or an ISP."}


async def cached(email: str) -> bool | None:
    """The kept verdict for this address's domain: True, False, or None when none is kept yet."""
    d = email_domain(email)
    if not d:
        return False
    async with session_maker() as db:
        row = await ratestore.kv_get(db, NS, d)
    return bool(row["work"]) if row and "work" in row else None


async def is_work(email: str, http: httpx.AsyncClient) -> bool:
    """Whether this is a work address, asking Jev once per domain. Never raises. Callers asking about
    the same domain at once (the sign-up warm-up and the first /auth/me) share one judgment."""
    known = await cached(email)
    if known is not None:
        return known
    d = email_domain(email) or ""
    task = _judging.get(d)
    if task is None:
        task = _judging[d] = asyncio.create_task(_judge(d, http))
        task.add_done_callback(lambda _t: _judging.pop(d, None))
    return await asyncio.shield(task)


_judging: dict[str, asyncio.Task[bool]] = {}


async def _judge(d: str, http: httpx.AsyncClient) -> bool:
    s = get_settings()
    if not s.onboarding_treg_token:
        return False
    house = HouseCalls(http, s.onboarding_treg_token, "onboarding", s.onboarding_treg_url)
    site = await _homepage(http, d)
    state = (f"# An email domain\n\n<domain>{d}</domain>\n\n# Its homepage, https://{d}\n\n"
             f"<homepage>{site[:600] if site else 'Not read: the site was slow, refused us, or does not exist.'}</homepage>")
    try:
        a = await asyncio.wait_for(house.request("POST", JEV_ENDPOINT, "judge", json={
            "model": JEV_MODEL, "state": state,
            "questions": {"work": {"type": "noul", "instructions": QUESTION.format(domain=d), "criteria": CRITERIA}}},
            headers={"X-Treg-Route-Max-Cost": "0.02"}, timeout=JUDGE_TIMEOUT_S), JUDGE_TIMEOUT_S + 1)
        p = float(a.body["answers"]["work"]["noul"]) if a.status == 200 else None
    except Exception as exc:  # noqa: BLE001 - an unanswered domain is treated as personal, briefly
        log.info("onboarding: no work-email verdict for %s: %s", d, type(exc).__name__)
        p = None
    work = p is not None and p >= WORK
    keep = {"work": work, "p": round(p, 3)} if p is not None else {"work": False, "unknown": True}
    try:
        async with session_maker() as db:
            await ratestore.kv_put(db, NS, d, keep, TTL_S if p is not None else UNKNOWN_TTL_S)
            await db.commit()
    except Exception as exc:  # noqa: BLE001 - an unkept verdict is asked again next time
        log.info("onboarding: work-email verdict for %s not kept: %s", d, type(exc).__name__)
    return work


async def _homepage(http: httpx.AsyncClient, d: str) -> str:
    """What https://<d> says about itself, or empty: a slow or unsafe site is judged by its name."""
    try:
        return await asyncio.wait_for(page.text(http, d, timeout=HOMEPAGE_S), HOMEPAGE_S + 0.5)
    except Exception:  # noqa: BLE001 - the homepage is evidence, never a reason to fail the judgment
        return ""
