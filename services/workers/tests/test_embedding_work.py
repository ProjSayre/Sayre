from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.chunks import (
    EmbeddingConfigNotFoundError,
    PostgresChunkStore,
)
from sayre_workers.ingestion.embeddings import EmbeddingConsumer
from sayre_workers.ingestion.models import (
    EmbeddingConfig,
    EmbeddingTask,
    EmbeddingWork,
)

ORG_ID = "11111111-1111-4111-8111-111111111111"
REPOSITORY_ID = "22222222-2222-4222-8222-222222222222"
REF_ID = "33333333-3333-4333-8333-333333333333"
CHUNK_ID = "44444444-4444-4444-8444-444444444444"
REVISION_SHA = "a" * 40


def _task() -> EmbeddingTask:
    return EmbeddingTask(
        org_id=ORG_ID,
        repository_id=REPOSITORY_ID,
        ref_id=REF_ID,
        ref_name="refs/heads/main",
        revision_sha=REVISION_SHA,
        chunk_id=CHUNK_ID,
        graph_node_id="file-node",
    )


def _envelope() -> MessageEnvelope:
    task = _task()
    return MessageEnvelope(
        org_id=task.org_id,
        type="embedding.upsert",
        source="ingestion-worker",
        idempotency_key="embedding:fixture",
        payload={
            "repository_id": task.repository_id,
            "ref_id": task.ref_id,
            "ref_name": task.ref_name,
            "revision_sha": task.revision_sha,
            "chunk_id": task.chunk_id,
            "graph_node_id": task.graph_node_id,
        },
    )


@pytest.mark.asyncio
async def test_postgres_embedding_lookup_distinguishes_stale_work_from_missing_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows: list[dict[str, Any] | None] = [
        None,
        {
            "content": "def fixture(): pass",
            "config_id": None,
            "provider": None,
            "model": None,
            "dimension": None,
            "endpoint_url": None,
            "credential_ref": None,
        },
    ]
    statements: list[str] = []

    class Cursor:
        async def fetchone(self) -> dict[str, Any] | None:
            return rows.pop(0)

    class Connection:
        async def execute(
            self,
            statement: str,
            _params: tuple[object, ...],
        ) -> Cursor:
            statements.append(statement)
            return Cursor()

    @asynccontextmanager
    async def scoped_connection(_dsn: str, org_id: str):
        assert org_id == ORG_ID
        yield Connection()

    monkeypatch.setattr(
        "sayre_workers.ingestion.chunks.org_scoped_connection",
        scoped_connection,
    )
    store = PostgresChunkStore("postgresql://not-used")

    assert await store.load_embedding_work(_task()) is None
    with pytest.raises(
        EmbeddingConfigNotFoundError,
        match="configuration is not available",
    ):
        await store.load_embedding_work(_task())

    assert len(statements) == 2
    assert all("LEFT JOIN model_provider_configs AS config" in sql for sql in statements)


@pytest.mark.asyncio
async def test_embedding_consumer_retries_missing_config_then_succeeds() -> None:
    task = _task()
    work = EmbeddingWork(
        task=task,
        content="def fixture(): pass",
        config=EmbeddingConfig(
            provider="openai_compatible",
            model="fixture-embedding",
            dimension=1024,
        ),
    )

    class Store:
        def __init__(self) -> None:
            self.configured = False
            self.stored = 0

        async def load_embedding_work(
            self,
            _task: EmbeddingTask,
        ) -> EmbeddingWork | None:
            if not self.configured:
                raise EmbeddingConfigNotFoundError(
                    "embedding provider configuration is not available"
                )
            return work

        async def store_embedding(
            self,
            _work: EmbeddingWork,
            vector: tuple[float, ...],
        ) -> bool:
            assert len(vector) == 1024
            self.stored += 1
            return True

    class Provider:
        async def embed(
            self,
            texts: list[str],
        ) -> tuple[tuple[float, ...], ...]:
            assert texts == [work.content]
            return ((0.0,) * 1024,)

    class Factory:
        async def create(self, config: EmbeddingConfig) -> Provider:
            assert config == work.config
            return Provider()

    store = Store()
    consumer = EmbeddingConsumer(store, Factory())  # type: ignore[arg-type]

    with pytest.raises(EmbeddingConfigNotFoundError):
        await consumer.handle(_envelope())

    store.configured = True
    assert await consumer.handle(_envelope()) is True
    assert store.stored == 1


@pytest.mark.asyncio
async def test_embedding_consumer_acknowledges_only_genuinely_stale_work() -> None:
    class StaleStore:
        async def load_embedding_work(
            self,
            _task: EmbeddingTask,
        ) -> EmbeddingWork | None:
            return None

        async def store_embedding(
            self,
            _work: EmbeddingWork,
            _vector: tuple[float, ...],
        ) -> bool:
            pytest.fail("stale work must not be written")

    assert await EmbeddingConsumer(StaleStore()).handle(_envelope()) is False
