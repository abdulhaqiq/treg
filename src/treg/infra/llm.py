"""One structured LLM answer through the Vercel AI Gateway's OpenAI-compatible API.

Infra: the wire format and nothing about why it is asked. The gateway takes creator-prefixed model
ids (`anthropic/claude-haiku-4-5-20251001`) and a JSON schema in `response_format`; the answer is the
parsed object or None. It never raises: a model that is down, slow or answers out of schema is an
LLM that abstains, and the caller falls back. Transient statuses (408, 409, 429, 5xx) are retried
with a short backoff inside the caller's deadline.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass

import httpx

log = logging.getLogger("treg.llm")

GATEWAY_URL = "https://ai-gateway.vercel.sh/v1/chat/completions"
_RETRY_STATUSES = {408, 409, 429}


@dataclass(frozen=True)
class Answer:
    value: dict | None          # the parsed object; None = no usable answer
    ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0       # the gateway's market cost of the request, when it says
    error: str | None = None


def _retryable(status: int) -> bool:
    return status in _RETRY_STATUSES or status >= 500


async def structured(system: str, user: str, schema: dict, *, api_key: str, model: str,
                     deadline_s: float = 20.0, max_tokens: int = 2048, attempts: int = 3,
                     url: str = GATEWAY_URL,
                     transport: httpx.AsyncBaseTransport | None = None) -> Answer:
    """Ask `model` for one JSON object matching `schema`. Never raises."""
    body = {
        "model": model, "max_tokens": max_tokens,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "answer", "strict": True, "schema": schema}},
    }
    t0 = time.perf_counter()
    ms = lambda: int((time.perf_counter() - t0) * 1000)  # noqa: E731
    error = "no_attempt"
    try:
        async with asyncio.timeout(deadline_s):
            async with httpx.AsyncClient(timeout=deadline_s, transport=transport) as client:
                for attempt in range(attempts):
                    if attempt:
                        await asyncio.sleep(0.5 * 2 ** (attempt - 1))
                    try:
                        r = await client.post(url, json=body, headers={"Authorization": f"Bearer {api_key}"})
                    except httpx.TransportError as exc:
                        error = type(exc).__name__
                        continue
                    if r.status_code != 200:
                        error = f"http_{r.status_code}"
                        if _retryable(r.status_code):
                            continue
                        return Answer(value=None, ms=ms(), error=error)
                    return _parse(r.json(), ms())
    except TimeoutError:
        error = "timeout"
    except Exception as exc:  # noqa: BLE001 - an abstaining LLM
        log.warning("llm request failed: %s", exc)
        error = type(exc).__name__
    return Answer(value=None, ms=ms(), error=error)


def _parse(data: dict, ms: int) -> Answer:
    usage = data.get("usage") or {}
    meta = dict(input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
                cost_usd=float(usage.get("market_cost") or usage.get("cost") or 0.0))
    try:
        content = data["choices"][0]["message"]["content"]
        value = json.loads(content)
    except (KeyError, IndexError, TypeError, ValueError):
        return Answer(value=None, ms=ms, error="unparsed", **meta)
    if not isinstance(value, dict):
        return Answer(value=None, ms=ms, error="not_object", **meta)
    return Answer(value=value, ms=ms, **meta)


@dataclass(frozen=True)
class Turn:
    """One assistant turn of a tool-using conversation: its text, the tool calls it asks for
    (`[{id, name, arguments}]`, arguments already parsed), and what it cost."""
    text: str
    tool_calls: list
    ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    error: str | None = None


async def chat(messages: list[dict], tools: list[dict], *, api_key: str, model: str,
               deadline_s: float = 90.0, max_tokens: int = 4096, attempts: int = 3,
               url: str = GATEWAY_URL, transport: httpx.AsyncBaseTransport | None = None) -> Turn:
    """One assistant turn over OpenAI-style messages and function tools. Never raises: a model that
    is down or answers garbage is a turn with `error` set and no text."""
    body: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if tools:
        body["tools"] = [{"type": "function", "function": t} for t in tools]
    t0 = time.perf_counter()
    ms = lambda: int((time.perf_counter() - t0) * 1000)  # noqa: E731
    error = "no_attempt"
    try:
        async with asyncio.timeout(deadline_s):
            async with httpx.AsyncClient(timeout=deadline_s, transport=transport) as client:
                for attempt in range(attempts):
                    if attempt:
                        await asyncio.sleep(0.5 * 2 ** (attempt - 1))
                    try:
                        r = await client.post(url, json=body, headers={"Authorization": f"Bearer {api_key}"})
                    except httpx.TransportError as exc:
                        error = type(exc).__name__
                        continue
                    if r.status_code != 200:
                        error = f"http_{r.status_code}"
                        if _retryable(r.status_code):
                            continue
                        return Turn(text="", tool_calls=[], ms=ms(), error=error)
                    return _parse_turn(r.json(), ms())
    except TimeoutError:
        error = "timeout"
    except Exception as exc:  # noqa: BLE001 - an abstaining LLM
        log.warning("llm chat failed: %s", exc)
        error = type(exc).__name__
    return Turn(text="", tool_calls=[], ms=ms(), error=error)


def _parse_turn(data: dict, ms: int) -> Turn:
    usage = data.get("usage") or {}
    meta = dict(input_tokens=int(usage.get("prompt_tokens") or 0),
                output_tokens=int(usage.get("completion_tokens") or 0),
                cost_usd=float(usage.get("market_cost") or usage.get("cost") or 0.0))
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return Turn(text="", tool_calls=[], ms=ms, error="unparsed", **meta)
    calls = []
    for c in msg.get("tool_calls") or []:
        fn = c.get("function") or {}
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except ValueError:
            args = {"_unparsed": fn.get("arguments")}
        calls.append({"id": c.get("id") or "", "name": fn.get("name") or "", "arguments": args if isinstance(args, dict) else {}})
    return Turn(text=msg.get("content") or "", tool_calls=calls, ms=ms, **meta)
