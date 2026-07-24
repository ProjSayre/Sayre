"""Bounded chunk persistence and stale-safe embedding storage."""

from __future__ import annotations

import hashlib
import math
from collections.abc import Iterable
from typing import Protocol

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection
from sayre_workers.parsing import SourceFile

from .models import (
    CodeChunk,
    EmbeddingConfig,
    EmbeddingTask,
    EmbeddingWork,
    GraphScope,
    PersistedChunk,
)
from .projection import stable_uid

MAX_CHUNK_CHARACTERS = 3_000
MAX_CHUNKS_PER_FILE = 4


class ChunkStore(Protocol):
    async def replace_chunks(
        self,
        *,
        scope: GraphScope,
        ref_id: str,
        full_rebuild: bool,
        affected_node_ids: tuple[str, ...],
        chunks: tuple[CodeChunk, ...],
    ) -> tuple[PersistedChunk, ...]: ...


class EmbeddingStore(Protocol):
    async def load_embedding_work(self, task: EmbeddingTask) -> EmbeddingWork | None: ...

    async def store_embedding(
        self, work: EmbeddingWork, vector: tuple[float, ...]
    ) -> bool: ...


def build_bounded_chunks(
    scope: GraphScope, source_files: Iterable[SourceFile]
) -> tuple[CodeChunk, ...]:
    """Create useful excerpts while deliberately never persisting a complete file."""
    chunks: list[CodeChunk] = []
    for source in sorted(source_files, key=lambda item: item.path):
        try:
            text = source.content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        # Leave at least one source character out even for tiny files. Combined with
        # the hard per-file cap, the persisted excerpts cannot reconstruct a checkout.
        budget = min(max(0, len(text) - 1), MAX_CHUNK_CHARACTERS * MAX_CHUNKS_PER_FILE)
        if budget == 0:
            continue
        graph_node_id = stable_uid(scope, "File", source.path)
        offset = 0
        chunk_index = 0
        while offset < budget and chunk_index < MAX_CHUNKS_PER_FILE:
            end = min(offset + MAX_CHUNK_CHARACTERS, budget)
            content = text[offset:end]
            start_line = text.count("\n", 0, offset) + 1
            end_line = start_line + content.count("\n")
            chunks.append(
                CodeChunk(
                    graph_node_id=graph_node_id,
                    chunk_index=chunk_index,
                    content=content,
                    content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
                    start_line=start_line,
                    end_line=end_line,
                    token_count=max(1, math.ceil(len(content) / 4)),
                )
            )
            offset = end
            chunk_index += 1
    return tuple(chunks)


class PostgresChunkStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresChunkStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    async def replace_chunks(
        self,
        *,
        scope: GraphScope,
        ref_id: str,
        full_rebuild: bool,
        affected_node_ids: tuple[str, ...],
        chunks: tuple[CodeChunk, ...],
    ) -> tuple[PersistedChunk, ...]:
        persisted: list[PersistedChunk] = []
        async with org_scoped_connection(self._dsn, scope.org_id) as connection:
            async with connection.transaction():
                if full_rebuild:
                    await connection.execute(
                        "DELETE FROM code_chunks WHERE org_id = %s AND ref_id = %s",
                        (scope.org_id, ref_id),
                    )
                elif affected_node_ids:
                    await connection.execute(
                        """
                        DELETE FROM code_chunks
                        WHERE org_id = %s AND ref_id = %s AND graph_node_id = ANY(%s)
                        """,
                        (scope.org_id, ref_id, list(affected_node_ids)),
                    )
                # Unchanged chunks/embeddings remain valid at the new immutable head.
                await connection.execute(
                    """
                    UPDATE code_chunks SET revision_sha = %s, updated_at = now()
                    WHERE org_id = %s AND ref_id = %s
                    """,
                    (scope.revision_sha, scope.org_id, ref_id),
                )
                await connection.execute(
                    """
                    UPDATE code_embeddings SET revision_sha = %s, updated_at = now()
                    WHERE org_id = %s AND ref_id = %s
                    """,
                    (scope.revision_sha, scope.org_id, ref_id),
                )
                for chunk in chunks:
                    cursor = await connection.execute(
                        """
                        INSERT INTO code_chunks
                            (org_id, repository_id, ref_id, revision_sha, graph_node_id,
                             chunk_index, content, content_hash, start_line, end_line, token_count)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT
                            (org_id, ref_id, graph_node_id, chunk_index, content_hash)
                        DO UPDATE SET revision_sha = excluded.revision_sha,
                                      content = excluded.content,
                                      start_line = excluded.start_line,
                                      end_line = excluded.end_line,
                                      token_count = excluded.token_count,
                                      updated_at = now()
                        RETURNING id::text
                        """,
                        (
                            scope.org_id,
                            scope.repository_id,
                            ref_id,
                            scope.revision_sha,
                            chunk.graph_node_id,
                            chunk.chunk_index,
                            chunk.content,
                            chunk.content_hash,
                            chunk.start_line,
                            chunk.end_line,
                            chunk.token_count,
                        ),
                    )
                    row = await cursor.fetchone()
                    assert row is not None
                    persisted.append(PersistedChunk(chunk_id=str(row["id"]), chunk=chunk))
        return tuple(persisted)

    async def load_embedding_work(self, task: EmbeddingTask) -> EmbeddingWork | None:
        async with org_scoped_connection(self._dsn, task.org_id) as connection:
            cursor = await connection.execute(
                """
                SELECT chunk.content, config.provider, config.model, config.dimension,
                       config.endpoint_url, config.credential_ref
                FROM code_chunks AS chunk
                JOIN repository_refs AS ref ON ref.id = chunk.ref_id
                JOIN model_provider_configs AS config
                  ON config.org_id = chunk.org_id AND config.purpose = 'embedding'
                WHERE chunk.id = %s AND chunk.org_id = %s AND chunk.repository_id = %s
                  AND chunk.ref_id = %s AND chunk.graph_node_id = %s
                  AND chunk.revision_sha = %s AND ref.ref_name = %s
                  AND ref.revision_sha = %s
                """,
                (
                    task.chunk_id,
                    task.org_id,
                    task.repository_id,
                    task.ref_id,
                    task.graph_node_id,
                    task.revision_sha,
                    task.ref_name,
                    task.revision_sha,
                ),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return EmbeddingWork(
            task=task,
            content=str(row["content"]),
            config=EmbeddingConfig(
                provider=str(row["provider"]),
                model=str(row["model"]),
                dimension=int(row["dimension"] or 1024),
                endpoint_url=row["endpoint_url"],
                credential_ref=row["credential_ref"],
            ),
        )

    async def store_embedding(self, work: EmbeddingWork, vector: tuple[float, ...]) -> bool:
        task = work.task
        vector_literal = "[" + ",".join(format(value, ".17g") for value in vector) + "]"
        async with org_scoped_connection(self._dsn, task.org_id) as connection:
            async with connection.transaction():
                cursor = await connection.execute(
                    """
                    INSERT INTO code_embeddings
                        (org_id, repository_id, ref_id, revision_sha, chunk_id,
                         graph_node_id, embedding, provider, model, dimension)
                    SELECT %s, %s, %s, %s, %s, %s, %s::vector, %s, %s, %s
                    FROM repository_refs AS ref
                    JOIN code_chunks AS chunk ON chunk.id = %s
                    WHERE ref.id = %s AND ref.org_id = %s AND ref.ref_name = %s
                      AND ref.revision_sha = %s AND chunk.org_id = ref.org_id
                      AND chunk.ref_id = ref.id AND chunk.graph_node_id = %s
                    ON CONFLICT (chunk_id, provider, model)
                    DO UPDATE SET revision_sha = excluded.revision_sha,
                                  embedding = excluded.embedding,
                                  dimension = excluded.dimension,
                                  updated_at = now()
                    RETURNING id
                    """,
                    (
                        task.org_id,
                        task.repository_id,
                        task.ref_id,
                        task.revision_sha,
                        task.chunk_id,
                        task.graph_node_id,
                        vector_literal,
                        work.config.provider,
                        work.config.model,
                        work.config.dimension,
                        task.chunk_id,
                        task.ref_id,
                        task.org_id,
                        task.ref_name,
                        task.revision_sha,
                        task.graph_node_id,
                    ),
                )
                return await cursor.fetchone() is not None
