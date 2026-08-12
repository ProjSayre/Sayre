"""Real PostgreSQL/pgvector acceptance for W0-06; CI enforces zero skips."""

from __future__ import annotations

import asyncio
import functools
import uuid
from typing import Any

import opentelemetry.metrics._internal as _otel_metrics_internal
import psycopg
import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.util._once import Once
from psycopg.rows import dict_row

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection
from sayre_workers.telemetry import vector_metrics
from sayre_workers.telemetry.otel import VECTOR_QUERY_DURATION_BUCKETS_MS


def _vector(fill: float = 0.001) -> str:
    return "[" + ",".join([str(fill)] * 1024) + "]"


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
        connection = psycopg.connect(url, connect_timeout=2)
        connection.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _postgres_reachable(),
    reason="DATABASE_ADMIN_URL unreachable -- skipping real pgvector metrics acceptance",
)


def _points(reader: InMemoryMetricReader, name: str) -> list[Any]:
    data = reader.get_metrics_data()
    if data is None:
        return []
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                if metric.name == name:
                    return list(metric.data.data_points)
    return []


# @spec AC-5 EC-5
async def test_fifty_real_pgvector_queries_emit_midflight_concurrency_and_latency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER", None)
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER_SET_ONCE", Once())
    vector_metrics.reset_instruments_cache()
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader],
        views=[
            View(
                instrument_name=vector_metrics.DURATION_METRIC_NAME,
                aggregation=ExplicitBucketHistogramAggregation(
                    VECTOR_QUERY_DURATION_BUCKETS_MS
                ),
            )
        ],
        shutdown_on_exit=False,
    )
    metrics.set_meter_provider(provider)

    admin_url = _admin_url()
    assert admin_url is not None
    org_id = str(uuid.uuid4())
    repository_id = str(uuid.uuid4())
    ref_id = str(uuid.uuid4())
    chunk_id = str(uuid.uuid4())
    revision = "6" * 40
    admin = await psycopg.AsyncConnection.connect(admin_url, row_factory=dict_row)
    try:
        await admin.execute(
            "INSERT INTO organizations (id, name, slug) VALUES (%s, %s, %s)",
            (org_id, "W0-06 metrics", f"w0-06-{org_id[:8]}"),
        )
        await admin.execute(
            "INSERT INTO repositories (id, org_id, name) VALUES (%s, %s, %s)",
            (repository_id, org_id, "metrics-repo"),
        )
        await admin.execute(
            """INSERT INTO repository_refs
               (id, org_id, repository_id, ref_name, revision_sha)
               VALUES (%s, %s, %s, 'refs/heads/main', %s)""",
            (ref_id, org_id, repository_id, revision),
        )
        await admin.execute(
            """INSERT INTO code_chunks
               (id, org_id, repository_id, ref_id, revision_sha, graph_node_id,
                chunk_index, content, content_hash)
               VALUES (%s, %s, %s, %s, %s, 'node-w0-06', 0, 'metrics', %s)""",
            (chunk_id, org_id, repository_id, ref_id, revision, f"hash-{chunk_id}"),
        )
        await admin.execute(
            """INSERT INTO code_embeddings
               (org_id, repository_id, ref_id, revision_sha, chunk_id, graph_node_id,
                embedding, provider, model)
               VALUES (%s, %s, %s, %s, %s, 'node-w0-06', %s::vector, 'fake', 'fake')""",
            (org_id, repository_id, ref_id, revision, chunk_id, _vector()),
        )
        await admin.commit()

        start = asyncio.Barrier(51)

        async def query_once() -> None:
            async with org_scoped_connection(admin_url, org_id) as connection:
                await start.wait()
                cursor = await vector_metrics.execute_vector_query(
                    connection,
                    org_id=org_id,
                    query="""
                        WITH delay AS MATERIALIZED (SELECT pg_sleep(0.2))
                        SELECT embedding.id
                        FROM delay, code_embeddings AS embedding
                        WHERE embedding.org_id = %s
                        ORDER BY embedding.embedding <=> %s::vector
                        LIMIT 1
                    """,
                    params=(org_id, _vector()),
                )
                assert await cursor.fetchone() is not None

        tasks = [asyncio.create_task(query_once()) for _ in range(50)]
        while start.n_waiting < 50:
            await asyncio.sleep(0)
        await start.wait()

        for _ in range(1_000):
            concurrent = _points(reader, vector_metrics.CONCURRENT_METRIC_NAME)
            if sum(point.value for point in concurrent) == 50:
                break
            await asyncio.sleep(0.001)
        else:
            pytest.fail("50 real vector queries were never observable concurrently")

        await asyncio.gather(*tasks)
        assert sum(
            point.value
            for point in _points(reader, vector_metrics.CONCURRENT_METRIC_NAME)
        ) == 0
        assert sum(
            point.count
            for point in _points(reader, vector_metrics.DURATION_METRIC_NAME)
        ) == 50
    finally:
        await admin.execute("DELETE FROM organizations WHERE id = %s", (org_id,))
        await admin.commit()
        await admin.close()
        provider.shutdown()
        vector_metrics.reset_instruments_cache()
