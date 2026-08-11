"""GAP-4 gap-fill: `PostgresChunkStore.replace_chunks`/`store_embedding` proved
against a REAL Postgres + pgvector, replacing the fake-driven coverage that
previously only ever exercised `chunks.py` through an in-memory recorder
(`tests/test_embedding_work.py`).

Skip-gating convention (spec.md's "Skip-gating convention..." section) mirrors
`tests/test_tenant_isolation.py:55-79` EXACTLY: resolve `DATABASE_ADMIN_URL`
through `sayre_workers.config.get_secret`, probe with `psycopg.connect(url,
connect_timeout=2)`, module-level `pytestmark`. A machine with no reachable
Postgres must still see `poetry run pytest` finish green (EC-25).

Each test seeds a fresh random-UUID org (+ repository + ref) as admin and cleans
up via `ON DELETE CASCADE` from `organizations` in a `finally` block.
"""

from __future__ import annotations

import asyncio
import functools
import uuid

import pytest
import psycopg
from pgvector.psycopg import register_vector_async
from psycopg.rows import dict_row

from sayre_workers.config import get_secret
from sayre_workers.ingestion.chunks import PostgresChunkStore
from sayre_workers.ingestion.models import (
    CodeChunk,
    EmbeddingConfig,
    EmbeddingTask,
    EmbeddingWork,
    GraphScope,
)

CODE_EMBEDDINGS_DIM = 1024


@functools.lru_cache(maxsize=1)
def _admin_url() -> str | None:
    async def resolve() -> str:
        return await get_secret("env://DATABASE_ADMIN_URL")

    try:
        return asyncio.run(resolve())
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def _postgres_reachable() -> bool:
    url = _admin_url()
    if url is None:
        return False
    try:
        conn = psycopg.connect(url, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _postgres_reachable(),
    reason="DATABASE_ADMIN_URL unreachable -- skipping real-Postgres chunk store integration suite",
)


def _vector(dim: int, fill: float = 0.001) -> tuple[float, ...]:
    return tuple(fill for _ in range(dim))


def _sha_like(label: str) -> str:
    return (label.lower() + "0" * 39)[:40]


class _SeededRef:
    def __init__(self, org_id: str, repository_id: str, ref_id: str, revision_sha: str) -> None:
        self.org_id = org_id
        self.repository_id = repository_id
        self.ref_id = ref_id
        self.revision_sha = revision_sha


async def _seed_ref(admin: psycopg.AsyncConnection, label: str) -> _SeededRef:
    org_id = str(uuid.uuid4())
    repository_id = str(uuid.uuid4())
    ref_id = str(uuid.uuid4())
    revision_sha = _sha_like(label)
    slug = f"w105-gapfill-{label.lower()}-{org_id[:8]}"

    await admin.execute(
        "INSERT INTO organizations (id, name, slug) VALUES (%s, %s, %s)",
        (org_id, f"W1-05 gapfill org {label}", slug),
    )
    await admin.execute(
        "INSERT INTO repositories (id, org_id, name) VALUES (%s, %s, %s)",
        (repository_id, org_id, f"repo-{label}"),
    )
    await admin.execute(
        """
        INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (ref_id, org_id, repository_id, "refs/heads/main", revision_sha),
    )
    await admin.commit()
    return _SeededRef(org_id, repository_id, ref_id, revision_sha)


class _Harness:
    def __init__(self, admin_url: str) -> None:
        self.admin_url = admin_url
        self.admin: psycopg.AsyncConnection | None = None
        self.seeded_org_ids: list[str] = []

    async def __aenter__(self) -> "_Harness":
        self.admin = await psycopg.AsyncConnection.connect(self.admin_url, row_factory=dict_row)
        # Without this, psycopg has no codec for the `vector` OID and SELECT ... embedding
        # comes back as its raw text literal ("[0,0,...]"), so `list(row["embedding"])`
        # silently iterates characters instead of the 1024 stored floats. Read-only on this
        # harness's own verification connection -- PostgresChunkStore itself (chunks.py)
        # never reads embedding back, only writes it via `%s::vector`, so production has no
        # equivalent gap this mirrors.
        await register_vector_async(self.admin)
        return self

    async def seed(self, label: str) -> _SeededRef:
        assert self.admin is not None
        seeded = await _seed_ref(self.admin, label)
        self.seeded_org_ids.append(seeded.org_id)
        return seeded

    async def __aexit__(self, *_exc: object) -> None:
        assert self.admin is not None
        if self.seeded_org_ids:
            await self.admin.execute(
                "DELETE FROM organizations WHERE id = ANY(%s)", (self.seeded_org_ids,)
            )
            await self.admin.commit()
        await self.admin.close()


def _harness() -> _Harness:
    url = _admin_url()
    assert url is not None
    return _Harness(url)


def _scope(ref: _SeededRef) -> GraphScope:
    return GraphScope(
        org_id=ref.org_id,
        repository_id=ref.repository_id,
        ref_name="refs/heads/main",
        revision_sha=ref.revision_sha,
    )


def _chunk(graph_node_id: str, *, index: int = 0, content: str = "def run():\n    return 1\n") -> CodeChunk:
    import hashlib

    return CodeChunk(
        graph_node_id=graph_node_id,
        chunk_index=index,
        content=content,
        content_hash=hashlib.sha256(content.encode("utf-8")).hexdigest(),
        start_line=1,
        end_line=content.count("\n") + 1,
        token_count=8,
    )


@pytest.mark.asyncio
# @spec AC-6
async def test_replace_chunks_inserts_expected_columns_against_real_postgres() -> None:
    async with _harness() as harness:
        ref = await harness.seed("A")
        store = PostgresChunkStore(harness.admin_url)
        chunk = _chunk("file-uid-1")

        persisted = await store.replace_chunks(
            scope=_scope(ref),
            ref_id=ref.ref_id,
            full_rebuild=True,
            affected_node_ids=(),
            chunks=(chunk,),
        )
        assert len(persisted) == 1

        assert harness.admin is not None
        cursor = await harness.admin.execute(
            "SELECT org_id, ref_id, graph_node_id, content_hash FROM code_chunks WHERE id = %s",
            (persisted[0].chunk_id,),
        )
        row = await cursor.fetchone()
        assert str(row["org_id"]) == ref.org_id
        assert str(row["ref_id"]) == ref.ref_id
        assert row["graph_node_id"] == "file-uid-1"
        assert row["content_hash"] == chunk.content_hash


@pytest.mark.asyncio
# @spec AC-6
async def test_replace_chunks_on_conflict_updates_rather_than_duplicates() -> None:
    async with _harness() as harness:
        ref = await harness.seed("B")
        store = PostgresChunkStore(harness.admin_url)
        chunk = _chunk("file-uid-2")

        await store.replace_chunks(
            scope=_scope(ref), ref_id=ref.ref_id, full_rebuild=True, affected_node_ids=(), chunks=(chunk,)
        )
        # Redeliver the SAME chunk (identical org_id/ref_id/graph_node_id/chunk_index/
        # content_hash) -- must hit the ON CONFLICT DO UPDATE path, not insert a
        # second row.
        await store.replace_chunks(
            scope=_scope(ref), ref_id=ref.ref_id, full_rebuild=False, affected_node_ids=(), chunks=(chunk,)
        )

        assert harness.admin is not None
        cursor = await harness.admin.execute(
            "SELECT count(*) AS c FROM code_chunks WHERE ref_id = %s AND graph_node_id = %s",
            (ref.ref_id, "file-uid-2"),
        )
        row = await cursor.fetchone()
        assert row["c"] == 1


@pytest.mark.asyncio
# @spec AC-6 EC-20
async def test_store_embedding_round_trips_a_real_1024_vector_with_extreme_values() -> None:
    async with _harness() as harness:
        ref = await harness.seed("C")
        store = PostgresChunkStore(harness.admin_url)
        chunk = _chunk("file-uid-3")
        [persisted] = await store.replace_chunks(
            scope=_scope(ref), ref_id=ref.ref_id, full_rebuild=True, affected_node_ids=(), chunks=(chunk,)
        )

        vector = [0.0, 5e-320, 1.234567890123456] + [0.001] * (CODE_EMBEDDINGS_DIM - 3)
        task = EmbeddingTask(
            org_id=ref.org_id,
            repository_id=ref.repository_id,
            ref_id=ref.ref_id,
            ref_name="refs/heads/main",
            revision_sha=ref.revision_sha,
            chunk_id=persisted.chunk_id,
            graph_node_id="file-uid-3",
        )
        work = EmbeddingWork(
            task=task,
            content=chunk.content,
            config=EmbeddingConfig(provider="voyage", model="voyage-gapfill-test"),
        )

        stored = await store.store_embedding(work, tuple(vector))
        assert stored is True

        assert harness.admin is not None
        cursor = await harness.admin.execute(
            "SELECT embedding, provider, model, dimension FROM code_embeddings WHERE chunk_id = %s",
            (persisted.chunk_id,),
        )
        row = await cursor.fetchone()
        read_back = list(row["embedding"])
        assert len(read_back) == CODE_EMBEDDINGS_DIM
        for expected, actual in zip(vector, read_back):
            assert actual == pytest.approx(expected, abs=1e-6)
        assert row["provider"] == "voyage"
        assert row["model"] == "voyage-gapfill-test"
        assert row["dimension"] == CODE_EMBEDDINGS_DIM


@pytest.mark.asyncio
# @spec EC-18
async def test_store_embedding_cross_org_chunk_id_returns_false_and_writes_nothing() -> None:
    async with _harness() as harness:
        ref_a = await harness.seed("D")
        ref_b = await harness.seed("E")
        store = PostgresChunkStore(harness.admin_url)

        [persisted_a] = await store.replace_chunks(
            scope=_scope(ref_a),
            ref_id=ref_a.ref_id,
            full_rebuild=True,
            affected_node_ids=(),
            chunks=(_chunk("file-uid-a"),),
        )

        # org B's connection attempts to store an embedding against org A's chunk_id.
        forged_task = EmbeddingTask(
            org_id=ref_b.org_id,
            repository_id=ref_b.repository_id,
            ref_id=ref_b.ref_id,
            ref_name="refs/heads/main",
            revision_sha=ref_b.revision_sha,
            chunk_id=persisted_a.chunk_id,
            graph_node_id="file-uid-a",
        )
        work = EmbeddingWork(
            task=forged_task,
            content="forged",
            config=EmbeddingConfig(provider="voyage", model="voyage-gapfill-test"),
        )

        stored = await store.store_embedding(work, _vector(CODE_EMBEDDINGS_DIM))
        assert stored is False

        assert harness.admin is not None
        cursor = await harness.admin.execute(
            "SELECT count(*) AS c FROM code_embeddings WHERE chunk_id = %s", (persisted_a.chunk_id,)
        )
        row = await cursor.fetchone()
        assert row["c"] == 0


@pytest.mark.asyncio
# @spec EC-19
async def test_store_embedding_rejects_a_vector_of_the_wrong_dimension() -> None:
    async with _harness() as harness:
        ref = await harness.seed("F")
        store = PostgresChunkStore(harness.admin_url)
        [persisted] = await store.replace_chunks(
            scope=_scope(ref),
            ref_id=ref.ref_id,
            full_rebuild=True,
            affected_node_ids=(),
            chunks=(_chunk("file-uid-f"),),
        )
        task = EmbeddingTask(
            org_id=ref.org_id,
            repository_id=ref.repository_id,
            ref_id=ref.ref_id,
            ref_name="refs/heads/main",
            revision_sha=ref.revision_sha,
            chunk_id=persisted.chunk_id,
            graph_node_id="file-uid-f",
        )
        work = EmbeddingWork(
            task=task, content="x", config=EmbeddingConfig(provider="voyage", model="voyage-gapfill-test")
        )

        with pytest.raises(Exception):
            await store.store_embedding(work, _vector(CODE_EMBEDDINGS_DIM - 1))


@pytest.mark.asyncio
# @spec EC-21
async def test_replace_chunks_full_rebuild_vs_scoped_affected_node_delete() -> None:
    async with _harness() as harness:
        ref = await harness.seed("G")
        store = PostgresChunkStore(harness.admin_url)
        chunk_kept = _chunk("file-kept", content="def kept():\n    return 1\n")
        chunk_removed = _chunk("file-removed", content="def removed():\n    return 2\n")

        await store.replace_chunks(
            scope=_scope(ref),
            ref_id=ref.ref_id,
            full_rebuild=True,
            affected_node_ids=(),
            chunks=(chunk_kept, chunk_removed),
        )

        # Scoped delta: only file-removed's chunks are deleted; file-kept's chunk
        # (not re-supplied here) survives with its revision_sha advanced.
        new_revision = "f" * 40
        await store.replace_chunks(
            scope=GraphScope(
                org_id=ref.org_id,
                repository_id=ref.repository_id,
                ref_name="refs/heads/main",
                revision_sha=new_revision,
            ),
            ref_id=ref.ref_id,
            full_rebuild=False,
            affected_node_ids=("file-removed",),
            chunks=(),
        )

        assert harness.admin is not None
        cursor = await harness.admin.execute(
            "SELECT graph_node_id, revision_sha FROM code_chunks WHERE ref_id = %s ORDER BY graph_node_id",
            (ref.ref_id,),
        )
        rows = await cursor.fetchall()
        assert [row["graph_node_id"] for row in rows] == ["file-kept"]
        assert rows[0]["revision_sha"] == new_revision
