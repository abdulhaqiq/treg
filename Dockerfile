FROM node:22.22.0-bookworm-slim AS dashboard

WORKDIR /app
COPY . .
RUN bash scripts/build-dashboard.sh

FROM python:3.13-slim-bookworm AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.12.3 /uv /uvx /bin/

WORKDIR /app
COPY . .
COPY --from=dashboard /app/src/treg/web/dashboard ./src/treg/web/dashboard

RUN uv sync --locked --no-dev --extra server \
    && groupadd --system treg \
    && useradd --system --gid treg --home-dir /app treg \
    && chown -R treg:treg /app

USER treg
EXPOSE 10000

CMD ["python", "-m", "treg"]
