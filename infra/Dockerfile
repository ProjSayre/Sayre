# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:20.19.5-bookworm-slim
ARG PYTHON_IMAGE=python:3.12.13-slim-bookworm

FROM ${NODE_IMAGE} AS node-workspace
WORKDIR /workspace
COPY . .
RUN npm ci

FROM node-workspace AS web-build
RUN npm run build --workspace @sayre/web

FROM web-build AS web
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@sayre/web", "--", "--hostname", "0.0.0.0", "--port", "3000"]

FROM node-workspace AS core-build
RUN npm run build --workspace @sayre/config \
    && npm run build --workspace @sayre/shared-types \
    && npm run build --workspace @sayre/core

FROM core-build AS core
EXPOSE 4000
CMD ["npm", "run", "start", "--workspace", "@sayre/core"]

FROM ${PYTHON_IMAGE} AS workers
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    POETRY_VERSION=2.2.0 \
    POETRY_VIRTUALENVS_CREATE=false
WORKDIR /workspace/services/workers
RUN pip install --no-cache-dir "poetry==${POETRY_VERSION}"
COPY services/workers/pyproject.toml services/workers/poetry.lock ./
RUN poetry install --only main --no-root --no-interaction --no-ansi
COPY services/workers/ ./
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
