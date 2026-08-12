from __future__ import annotations

import ast
import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import opentelemetry.metrics._internal as _otel_metrics_internal
import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.util._once import Once

from scripts import synthetic_vector_load
from sayre_workers.telemetry import vector_metrics
from sayre_workers.telemetry.otel import VECTOR_QUERY_DURATION_BUCKETS_MS


@pytest.fixture(autouse=True)
def _reset_otel(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER", None)
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER_SET_ONCE", Once())
    vector_metrics.reset_instruments_cache()
    yield
    vector_metrics.reset_instruments_cache()


def _reader() -> InMemoryMetricReader:
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
    return reader


def _data_points(reader: InMemoryMetricReader, name: str) -> list[Any]:
    data = reader.get_metrics_data()
    if data is None:
        return []
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                if metric.name == name:
                    return list(metric.data.data_points)
    return []


class BarrierConnection:
    def __init__(self, barrier: asyncio.Barrier, *, result: object | None = None) -> None:
        self.barrier = barrier
        self.result = result if result is not None else object()
        self.calls: list[tuple[str, object | None]] = []

    async def execute(self, query: str, params: object | None = None) -> object:
        self.calls.append((query, params))
        await self.barrier.wait()
        return self.result


# @spec AC-2 AC-6
async def test_fifty_instrumented_executions_are_visible_mid_flight_by_org() -> None:
    reader = _reader()
    barrier = asyncio.Barrier(51)
    org_ids = [f"org-{index % 3}" for index in range(50)]
    connections = [BarrierConnection(barrier) for _ in org_ids]

    tasks = [
        asyncio.create_task(
            vector_metrics.execute_vector_query(
                connection,
                org_id=org_id,
                query="SELECT embedding <=> %s::vector FROM code_embeddings",
                params=("[0]",),
            )
        )
        for connection, org_id in zip(connections, org_ids, strict=True)
    ]
    while barrier.n_waiting < 50:
        await asyncio.sleep(0)

    concurrent = _data_points(reader, vector_metrics.CONCURRENT_METRIC_NAME)
    assert sum(point.value for point in concurrent) == 50
    assert {point.attributes["org_id"] for point in concurrent} == {
        "org-0",
        "org-1",
        "org-2",
    }
    assert all(set(point.attributes) == {"org_id"} for point in concurrent)
    assert vector_metrics.DURATION_METRIC_NAME == "vector_query_duration_ms"
    assert vector_metrics.CONCURRENT_METRIC_NAME == "vector_query_concurrent_count"

    await barrier.wait()
    await asyncio.gather(*tasks)

    final_concurrent = _data_points(reader, vector_metrics.CONCURRENT_METRIC_NAME)
    assert sum(point.value for point in final_concurrent) == 0
    durations = _data_points(reader, vector_metrics.DURATION_METRIC_NAME)
    assert sum(point.count for point in durations) == 50
    assert all(set(point.attributes) == {"org_id"} for point in durations)


# @spec AC-3 EC-2
async def test_execution_helper_returns_cursor_and_balances_original_failure() -> None:
    reader = _reader()
    success_barrier = asyncio.Barrier(1)
    cursor = object()
    success = BarrierConnection(success_barrier, result=cursor)

    returned = await vector_metrics.execute_vector_query(
        success, org_id="org-a", query="SELECT 1"
    )
    assert returned is cursor

    class BoomConnection:
        async def execute(self, query: str, params: object | None = None) -> object:
            raise LookupError("original-db-error")

    with pytest.raises(LookupError, match="original-db-error") as captured:
        await vector_metrics.execute_vector_query(
            BoomConnection(), org_id="org-a", query="SELECT 1"
        )
    assert type(captured.value) is LookupError
    assert sum(
        point.value
        for point in _data_points(reader, vector_metrics.CONCURRENT_METRIC_NAME)
    ) == 0
    assert sum(
        point.count
        for point in _data_points(reader, vector_metrics.DURATION_METRIC_NAME)
    ) == 2


# @spec EC-1
@pytest.mark.parametrize("org_id", ["", "  ", None])
async def test_invalid_org_id_fails_before_database_execution(org_id: str | None) -> None:
    reader = _reader()
    connection = BarrierConnection(asyncio.Barrier(1))

    with pytest.raises(ValueError):
        await vector_metrics.execute_vector_query(
            connection, org_id=org_id, query="SELECT 1"  # type: ignore[arg-type]
        )

    assert connection.calls == []
    assert _data_points(reader, vector_metrics.CONCURRENT_METRIC_NAME) == []
    assert _data_points(reader, vector_metrics.DURATION_METRIC_NAME) == []


def _literal_text(node: ast.AST) -> str:
    return "".join(
        value.value
        for value in ast.walk(node)
        if isinstance(value, ast.Constant) and isinstance(value.value, str)
    )


# @spec AC-1 EC-6
def test_production_vector_sql_never_calls_connection_execute_directly() -> None:
    workers_root = Path(__file__).parents[1]
    production_roots = [workers_root / "sayre_workers", workers_root / "scripts"]
    violations: list[str] = []
    signals = ("code_embeddings", "<=>", "::vector")

    for root in production_roots:
        for path in root.rglob("*.py"):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                    continue
                if node.func.attr != "execute" or not node.args:
                    continue
                sql = _literal_text(node.args[0]).lower()
                if any(signal in sql for signal in signals):
                    violations.append(f"{path.relative_to(workers_root)}:{node.lineno}")

    assert violations == [], (
        "vector SQL must use execute_vector_query(), not connection.execute(): "
        + ", ".join(violations)
    )


# @spec AC-4 EC-3 EC-6
async def test_real_load_query_is_tenant_scoped_parameterized_and_measured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = object()
    scoped_calls: list[tuple[str, str]] = []
    query_calls: list[tuple[object, str, str, object | None]] = []

    @asynccontextmanager
    async def scoped(dsn: str, org_id: str) -> AsyncIterator[object]:
        scoped_calls.append((dsn, org_id))
        yield connection

    async def execute(
        actual_connection: object,
        *,
        org_id: str,
        query: str,
        params: object | None = None,
    ) -> object:
        query_calls.append((actual_connection, org_id, query, params))
        return object()

    monkeypatch.setattr(synthetic_vector_load, "org_scoped_connection", scoped)
    monkeypatch.setattr(synthetic_vector_load, "execute_vector_query", execute)

    await synthetic_vector_load._real_db_query("postgresql://runtime", "org-a")

    assert scoped_calls == [("postgresql://runtime", "org-a")]
    assert len(query_calls) == 1
    actual_connection, metric_org, query, params = query_calls[0]
    assert actual_connection is connection
    assert metric_org == "org-a"
    assert "embedding <=> %s::vector" in query
    assert "org-a" not in query
    assert isinstance(params, tuple) and len(params) == 2
    assert params[0] == "org-a"
    assert isinstance(params[1], str) and params[1].startswith("[")


# @spec EC-4
async def test_simulation_mode_never_resolves_database_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def forbidden(_name: str) -> str:
        raise AssertionError("simulation mode must not resolve DATABASE_RUNTIME_URL")

    monkeypatch.setattr(synthetic_vector_load, "get_secret", forbidden)
    await synthetic_vector_load.run_load(
        concurrency=1,
        org_ids=["org-a"],
        duration_seconds=0.001,
        min_latency_ms=0,
        max_latency_ms=0,
        use_db=False,
    )
