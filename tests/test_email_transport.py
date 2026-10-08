from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from treg import email as email_sender


def _settings(**overrides):
    values = {
        "smtp_host": "email-smtp.example.test",
        "smtp_port": 587,
        "smtp_username": "smtp-user",
        "smtp_password": "smtp-password",
        "smtp_starttls": True,
        "smtp_ssl": False,
        "smtp_timeout_s": 15.0,
        "resend_api_key": "",
        "email_from": "Darwa LLM <no-reply@darwa.co>",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_smtp_starttls_login_and_multipart_message(monkeypatch):
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.send_message.return_value = {}
    smtp = MagicMock(return_value=connection)
    monkeypatch.setattr(email_sender.smtplib, "SMTP", smtp)

    sent = email_sender._send_smtp(
        _settings(), "person@example.com", "Sign in", "<b>123456</b>", "Code: 123456",
    )

    assert sent is True
    smtp.assert_called_once_with(host="email-smtp.example.test", port=587, timeout=15.0)
    connection.starttls.assert_called_once()
    connection.login.assert_called_once_with("smtp-user", "smtp-password")
    message = connection.send_message.call_args.args[0]
    assert message["From"] == "Darwa LLM <no-reply@darwa.co>"
    assert message["To"] == "person@example.com"
    assert message.is_multipart()
    assert connection.send_message.call_args.kwargs == {
        "from_addr": "no-reply@darwa.co", "to_addrs": ["person@example.com"],
    }


def test_smtp_ssl_without_starttls_or_auth(monkeypatch):
    connection = MagicMock()
    connection.__enter__.return_value = connection
    connection.send_message.return_value = {}
    smtp_ssl = MagicMock(return_value=connection)
    monkeypatch.setattr(email_sender.smtplib, "SMTP_SSL", smtp_ssl)

    sent = email_sender._send_smtp(
        _settings(smtp_port=465, smtp_username="", smtp_password="", smtp_ssl=True),
        "person@example.com", "Subject", "<b>HTML</b>", "Text",
    )

    assert sent is True
    smtp_ssl.assert_called_once()
    assert "context" in smtp_ssl.call_args.kwargs
    connection.starttls.assert_not_called()
    connection.login.assert_not_called()


@pytest.mark.asyncio
async def test_send_prefers_smtp_when_both_backends_are_configured(monkeypatch):
    settings = _settings(resend_api_key="resend-key")
    called = []

    def smtp_send(*args):
        called.append(args)
        return True

    async def inline(function, *args):
        return function(*args)

    monkeypatch.setattr(email_sender, "get_settings", lambda: settings)
    monkeypatch.setattr(email_sender, "_send_smtp", smtp_send)
    monkeypatch.setattr(email_sender.asyncio, "to_thread", inline)

    assert await email_sender._send("person@example.com", "Subject", "<b>HTML</b>", "Text") is True
    assert called == [(settings, "person@example.com", "Subject", "<b>HTML</b>", "Text")]


@pytest.mark.asyncio
async def test_send_skips_when_no_backend_is_configured(monkeypatch):
    monkeypatch.setattr(
        email_sender, "get_settings", lambda: _settings(smtp_host="", resend_api_key=""),
    )
    assert await email_sender._send("person@example.com", "Subject", "HTML", "Text") is False
