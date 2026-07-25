"""Postgres-backed generation-config lookup (`model_provider_configs`, purpose='generation').

Mirrors `sayre_workers.ingestion.chunks.PostgresChunkStore`'s org-scoped connection
pattern (`set_config('app.org_id', ...)` before every query). No schema/migration
change -- `model_provider_configs` already exists and is keyed by `purpose`, which
`PostgresChunkStore.load_embedding_work` already reads with `purpose='embedding'`.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection
from sayre_workers.model_provider import (
    GenerationConfig,
    InvalidModelProviderConfigError,
)


class PostgresGenerationConfigStore:
    """Concrete `GenerationConfigStore` (see `service.py`'s Protocol) -- structural
    typing only, matching `PostgresChunkStore`'s relationship to `ChunkStore`/
    `EmbeddingStore` in `sayre_workers.ingestion.chunks`."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresGenerationConfigStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    @asynccontextmanager
    async def _connect(
        self,
        org_id: str,
    ) -> AsyncIterator[psycopg.AsyncConnection[Any]]:
        async with org_scoped_connection(self._dsn, org_id) as connection:
            yield connection

    async def load_generation_config(self, org_id: str) -> GenerationConfig | None:
        async with self._connect(org_id) as connection:
            cursor = await connection.execute(
                """
                SELECT provider, model, endpoint_url, credential_ref, config
                FROM model_provider_configs
                WHERE org_id = %s AND purpose = 'generation'
                """,
                (org_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            # The ONLY signal for the missing-config path (Decision D2) -- never
            # synthesize a fake config here.
            return None
        raw_options = row["config"]
        if raw_options is None:
            options: dict[str, Any] = {}
        elif isinstance(raw_options, dict):
            options = dict(raw_options)
        else:
            raise InvalidModelProviderConfigError(
                "generation provider options must be a JSON object"
            )
        return GenerationConfig(
            provider=str(row["provider"]),
            model=str(row["model"]),
            endpoint_url=row["endpoint_url"],
            credential_ref=row["credential_ref"],
            options=options,
        )
