"""RLS-scoped reads from the launch Postgres/pgvector retrieval store."""

from __future__ import annotations

from typing import Any, Protocol

import psycopg
from psycopg.rows import dict_row

from sayre_workers.config import get_secret
from sayre_workers.telemetry.vector_metrics import execute_vector_query

from .models import InvalidRetrievedChunkError, RetrievalScope, RetrievedChunk

MAX_RETRIEVAL_CHUNKS = 24


class RetrievalStore(Protocol):
    async def load_bounded_chunks(
        self,
        scope: RetrievalScope,
        node_ids: tuple[str, ...],
        limit: int,
    ) -> tuple[RetrievedChunk, ...]: ...

    async def load_full_repo_token_count(self, scope: RetrievalScope) -> int: ...


def _require_scope(scope: RetrievalScope) -> None:
    if not all(
        value.strip()
        for value in (
            scope.org_id,
            scope.repository_id,
            scope.ref_name,
            scope.revision_sha,
        )
    ):
        raise ValueError("retrieval scope fields must be non-blank")


def _chunk_from_row(row: dict[str, Any]) -> RetrievedChunk:
    chunk_id = row.get("chunk_id")
    graph_node_id = row.get("graph_node_id")
    content = row.get("content")
    token_count = row.get("token_count")
    if (
        not isinstance(chunk_id, str)
        or not chunk_id
        or not isinstance(graph_node_id, str)
        or not graph_node_id
        or not isinstance(content, str)
        or not content
        or not isinstance(token_count, int)
        or token_count <= 0
    ):
        raise InvalidRetrievedChunkError("retrieval store returned malformed chunk metadata")
    return RetrievedChunk(
        chunk_id=chunk_id,
        graph_node_id=graph_node_id,
        content=content,
        token_count=token_count,
    )


class PostgresRetrievalStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresRetrievalStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    async def _connect(self, org_id: str) -> psycopg.AsyncConnection[Any]:
        connection = await psycopg.AsyncConnection.connect(self._dsn, row_factory=dict_row)
        await connection.execute("SELECT set_config('app.org_id', %s, false)", (org_id,))
        return connection

    async def load_bounded_chunks(
        self,
        scope: RetrievalScope,
        node_ids: tuple[str, ...],
        limit: int,
    ) -> tuple[RetrievedChunk, ...]:
        _require_scope(scope)
        distinct_node_ids = tuple(dict.fromkeys(node_id for node_id in node_ids if node_id))
        if not distinct_node_ids:
            return ()
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= MAX_RETRIEVAL_CHUNKS
        ):
            raise ValueError(f"retrieval chunk limit must be between 1 and {MAX_RETRIEVAL_CHUNKS}")

        connection = await self._connect(scope.org_id)
        async with connection:
            cursor = await execute_vector_query(
                connection,
                org_id=scope.org_id,
                query="""
                    SELECT chunk.id::text AS chunk_id,
                           chunk.graph_node_id,
                           chunk.content,
                           chunk.token_count
                    FROM code_chunks AS chunk
                    JOIN repository_refs AS ref
                      ON ref.id = chunk.ref_id
                     AND ref.org_id = chunk.org_id
                     AND ref.repository_id = chunk.repository_id
                    WHERE chunk.org_id = %s
                      AND chunk.repository_id = %s
                      AND ref.ref_name = %s
                      AND ref.revision_sha = %s
                      AND chunk.revision_sha = %s
                      AND chunk.graph_node_id = ANY(%s)
                      AND EXISTS (
                        SELECT 1
                        FROM code_embeddings AS embedding
                        WHERE embedding.chunk_id = chunk.id
                          AND embedding.org_id = chunk.org_id
                          AND embedding.repository_id = chunk.repository_id
                          AND embedding.ref_id = chunk.ref_id
                          AND embedding.revision_sha = chunk.revision_sha
                          AND embedding.graph_node_id = chunk.graph_node_id
                          AND embedding.dimension = 1024
                      )
                    ORDER BY array_position(%s::text[], chunk.graph_node_id),
                             chunk.chunk_index,
                             chunk.id
                    LIMIT %s
                    """,
                params=(
                    scope.org_id,
                    scope.repository_id,
                    scope.ref_name,
                    scope.revision_sha,
                    scope.revision_sha,
                    list(distinct_node_ids),
                    list(distinct_node_ids),
                    limit,
                ),
            )
            rows = await cursor.fetchall()
        return tuple(_chunk_from_row(row) for row in rows)

    async def load_full_repo_token_count(self, scope: RetrievalScope) -> int:
        """Return an internal tenant/repo/ref/revision baseline, never chunk text."""
        _require_scope(scope)
        connection = await self._connect(scope.org_id)
        async with connection:
            cursor = await execute_vector_query(
                connection,
                org_id=scope.org_id,
                query="""
                    SELECT COALESCE(SUM(chunk.token_count), 0)::bigint AS token_count
                    FROM code_chunks AS chunk
                    JOIN repository_refs AS ref
                      ON ref.id = chunk.ref_id
                     AND ref.org_id = chunk.org_id
                     AND ref.repository_id = chunk.repository_id
                    WHERE chunk.org_id = %s
                      AND chunk.repository_id = %s
                      AND ref.ref_name = %s
                      AND ref.revision_sha = %s
                      AND chunk.revision_sha = %s
                      AND chunk.token_count > 0
                      AND EXISTS (
                        SELECT 1
                        FROM code_embeddings AS embedding
                        WHERE embedding.chunk_id = chunk.id
                          AND embedding.org_id = chunk.org_id
                          AND embedding.repository_id = chunk.repository_id
                          AND embedding.ref_id = chunk.ref_id
                          AND embedding.revision_sha = chunk.revision_sha
                          AND embedding.graph_node_id = chunk.graph_node_id
                          AND embedding.dimension = 1024
                      )
                    """,
                params=(
                    scope.org_id,
                    scope.repository_id,
                    scope.ref_name,
                    scope.revision_sha,
                    scope.revision_sha,
                ),
            )
            row = await cursor.fetchone()
        value = row.get("token_count") if row is not None else 0
        if not isinstance(value, int) or value < 0:
            raise InvalidRetrievedChunkError("retrieval baseline token count is invalid")
        return value
