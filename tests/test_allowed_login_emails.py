"""Exact human-login allowlist for private deployments."""

from __future__ import annotations

import logging

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError
from sqlmodel import select

from treg.api import app
from treg.application import signup
from treg.config import Settings, get_settings
from treg.infra.db import reset_db, session_maker
from treg.models import User

ADMIN = "ak@darwa.co"
REFUSAL = "this address cannot be used to sign in"


@pytest.fixture
def admin_only(monkeypatch):
    monkeypatch.setattr(get_settings(), "allowed_login_emails", ADMIN, raising=False)


@pytest.fixture
async def client():
    await reset_db()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://registry") as c:
        yield c


async def _user_count(email: str) -> int:
    async with session_maker() as db:
        rows = (await db.execute(select(User).where(User.email == email))).scalars().all()
        return len(rows)


def test_allowlist_normalizes_case_and_whitespace():
    settings = Settings(allowed_login_emails=" AK@Darwa.co, owner@example.com ")
    assert settings.allowed_login_email_set == frozenset(
        {"ak@darwa.co", "owner@example.com"},
    )


@pytest.mark.parametrize("raw", ["missing-at", "@darwa.co", "ak@", "a k@darwa.co"])
def test_allowlist_rejects_malformed_entries(raw):
    with pytest.raises(ValidationError):
        Settings(allowed_login_emails=raw)


def test_allowlist_is_exact_and_logs_a_generic_refusal(admin_only, caplog):
    with caplog.at_level(logging.WARNING, logger="treg.auth"):
        assert not signup.email_refused("AK@DARWA.CO", "otp_start")
        assert signup.email_refused("other@darwa.co", "otp_start")
        assert signup.email_refused("ak@sub.darwa.co", "otp_start")
    lines = [
        record.getMessage()
        for record in caplog.records
        if "signup_email_not_allowed" in record.getMessage()
    ]
    assert lines == [
        "event=signup_email_not_allowed door=otp_start domain=darwa.co",
        "event=signup_email_not_allowed door=otp_start domain=sub.darwa.co",
    ]


def test_allowlist_classifier_failure_denies_access(admin_only, monkeypatch, caplog):
    def fail_closed():
        raise RuntimeError("bad allowlist")

    monkeypatch.setattr(
        type(get_settings()), "allowed_login_email_set", property(lambda _: fail_closed()),
    )
    with caplog.at_level(logging.ERROR, logger="treg.auth"):
        assert signup.email_refused(ADMIN, "otp_start")
    assert any("allowlist_error" in record.getMessage() for record in caplog.records)


async def test_otp_start_allows_only_the_admin_address(client, admin_only):
    refused = await client.post("/auth/email/start", json={"email": "other@darwa.co"})
    assert refused.status_code == 403 and refused.json()["detail"] == REFUSAL
    assert "dev_code" not in refused.json()
    assert await _user_count("other@darwa.co") == 0

    allowed = await client.post("/auth/email/start", json={"email": "AK@DARWA.CO"})
    assert allowed.status_code == 200
    assert allowed.json()["email"] == ADMIN


async def test_verify_refuses_a_code_minted_before_allowlist_activation(
    client, monkeypatch,
):
    email = "early@example.com"
    started = await client.post("/auth/email/start", json={"email": email})
    code = started.json()["dev_code"]
    monkeypatch.setattr(get_settings(), "allowed_login_emails", ADMIN, raising=False)

    verified = await client.post(
        "/auth/email/verify", json={"email": email, "code": code},
    )
    assert verified.status_code == 403 and verified.json()["detail"] == REFUSAL
    assert await _user_count(email) == 0


async def test_legacy_registration_obeys_the_same_allowlist(client, admin_only):
    refused = await client.post("/users", json={"email": "other@example.com"})
    assert refused.status_code == 403 and refused.json()["detail"] == REFUSAL
    assert await _user_count("other@example.com") == 0
