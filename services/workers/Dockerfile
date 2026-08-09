# Self-contained context: services/workers is Poetry-managed and not part of
# the root npm workspace, so (unlike apps/web and services/core) this build
# context is just this directory. See .github/workflows/deploy.yml.
#
# Build with (from services/workers/):
#   docker build -t sayre-workers .
#
# python:3.12-slim (Debian), not alpine: psycopg[binary] and several other
# dependencies here (tree-sitter, tree-sitter-language-pack, the
# opentelemetry exporters) ship prebuilt glibc wheels but not musl/alpine
# ones, which would otherwise force a slow, fragile from-source compile.

# ---- deps -------------------------------------------------------------
FROM python:3.12-slim AS builder
WORKDIR /app

RUN pip install --no-cache-dir poetry==2.2.0 \
    && poetry config virtualenvs.create false

COPY pyproject.toml poetry.lock ./
# --only main: skip [tool.poetry.group.dev.dependencies] (pytest/ruff/mypy).
# --no-root: install dependencies only, not this project itself as a
# package — the runtime stage runs uvicorn directly against copied source,
# it doesn't need sayre-workers pip-installed/editable.
RUN poetry install --only main --no-root --no-interaction

# ---- runtime ------------------------------------------------------------
FROM python:3.12-slim AS runner
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

COPY app app
COPY sayre_workers sayre_workers
COPY messaging messaging
COPY scripts scripts

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
