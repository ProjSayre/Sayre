"""Deterministic tests for `sayre_workers.telemetry.graph_metrics` (W0-08).

Mirrors `tests/test_vector_metrics.py`'s scope and technique exactly (see that
file's module docstring for the full rationale): these tests install their own
MeterProvider directly (InMemoryMetricReader for the concurrency/duration
assertions; PrometheusMetricReader for the exact-exported-name guard) rather
than going through `otel.init_metrics()`, so the concurrency assertion never
depends on scrape timing. `_reset_otel_globals` resets OTel's one-shot global
MeterProvider guard before every test so each test can install its own
isolated provider and have `graph_metrics._get_instruments()` -- lazily bound
to "the current global MeterProvider" -- pick it up.

This is the **dev-authored** half of the W0-08 test split (see
`.pipeline/spec.md` "Test ownership split"). Supplementary coverage (custom
bucket boundaries, distinct per-(org_id, query_shape) series, result-count
recorded-only-when-set edge cases, env-var exporter resolution, provider-swap
rebind, and the Neo4j-gated seed/load/cleanup sentinel-safety integration
check) lives in the **tester-authored** `tests/test_graph_metrics_tester.py`,
which this module deliberately does not write.
"""

from __future__ import annotations

import asyncio
import socket
import urllib.request

import opentelemetry.metrics._internal as _otel_metrics_internal
import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.util._once import Once

from sayre_workers.telemetry import graph_metrics
from sayre_workers.telemetry import otel as otel_module
from sayre_workers.telemetry.otel import (
    GRAPH_QUERY_DURATION_BUCKETS_MS,
    GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS,
)


# --------------------------------------------------------------------------
# Fixtures / helpers
# --------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_otel_globals(monkeypatch):
    """Reset OTel's process-global MeterProvider guard and this repo's own
    `otel.init_metrics()` idempotency guard before every test, and tear down
    cleanly afterwards (stopping any HTTP server a test started)."""
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER", None)
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(otel_module, "_provider", None)
    graph_metrics.reset_instruments_cache()
    yield
    otel_module.shutdown_metrics()
    graph_metrics.reset_instruments_cache()


def _graph_views() -> list[View]:
    return [
        View(
            instrument_name=graph_metrics.DURATION_METRIC_NAME,
            aggregation=ExplicitBucketHistogramAggregation(GRAPH_QUERY_DURATION_BUCKETS_MS),
        ),
        View(
            instrument_name=graph_metrics.RESULT_NODE_COUNT_METRIC_NAME,
            aggregation=ExplicitBucketHistogramAggregation(
                GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS
            ),
        ),
    ]


def _install_in_memory_provider() -> InMemoryMetricReader:
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader], views=_graph_views(), shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider)
    return reader


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _metric(data, name):
    if data is None:  # nothing collected yet -- no instrument was ever touched
        return None
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                if metric.name == name:
                    return metric
    return None


def _sum_by_org(data, name: str) -> dict[str, float]:
    metric = _metric(data, name)
    if metric is None:
        return {}
    return {dp.attributes["org_id"]: dp.value for dp in metric.data.data_points}


def _histogram_by_org(data, name: str) -> dict[str, object]:
    metric = _metric(data, name)
    if metric is None:
        return {}
    return {dp.attributes["org_id"]: dp for dp in metric.data.data_points}


# --------------------------------------------------------------------------
# Deterministic 50-concurrent test (Acceptance #6 / Edge case "Exact concurrency")
# --------------------------------------------------------------------------


async def test_fifty_concurrent_queries_report_concurrency_and_latency():
    reader = _install_in_memory_provider()

    # asyncio.Barrier(51): 50 workers + this asserting coroutine, per spec.
    barrier = asyncio.Barrier(51)
    org_ids = [f"org-{i % 3}" for i in range(50)]  # multi-tenant burst
    shapes = [
        graph_metrics.QUERY_SHAPE_VIEWPORT_READ,
        graph_metrics.QUERY_SHAPE_WRITE,
        graph_metrics.QUERY_SHAPE_TRAVERSAL,
    ]

    async def worker(org_id: str, shape: str) -> None:
        async with graph_metrics.instrument_graph_query(org_id, shape):
            await barrier.wait()  # park here, holding the query "in flight"

    tasks = [
        asyncio.create_task(worker(org_id, shapes[i % 3]))
        for i, org_id in enumerate(org_ids)
    ]

    # Wait until all 50 workers are parked at the barrier (in flight) before
    # taking the snapshot -- avoids a race against task scheduling.
    while barrier.n_waiting < 50:
        await asyncio.sleep(0)

    mid_flight = reader.get_metrics_data()
    concurrent = _sum_by_org(mid_flight, graph_metrics.CONCURRENT_METRIC_NAME)
    assert sum(concurrent.values()) == 50
    assert set(concurrent.keys()) == {"org-0", "org-1", "org-2"}
    # summing per-org concurrency equals total in-flight (multi-tenant tagging)
    assert concurrent["org-0"] + concurrent["org-1"] + concurrent["org-2"] == 50

    concurrent_metric = _metric(mid_flight, graph_metrics.CONCURRENT_METRIC_NAME)
    shape_values = {dp.attributes["query_shape"] for dp in concurrent_metric.data.data_points}
    assert shape_values == set(shapes)

    # Release all 50 workers (the 51st arrival is this coroutine itself).
    await barrier.wait()
    await asyncio.gather(*tasks)

    final = reader.get_metrics_data()
    final_concurrent = _sum_by_org(final, graph_metrics.CONCURRENT_METRIC_NAME)
    assert sum(final_concurrent.values()) == 0

    histograms = _histogram_by_org(final, graph_metrics.DURATION_METRIC_NAME)
    assert sum(dp.count for dp in histograms.values()) == 50
    for dp in histograms.values():
        assert sum(dp.bucket_counts) == dp.count
        assert dp.sum >= 0
        assert dp.attributes["org_id"] in {"org-0", "org-1", "org-2"}
        assert dp.attributes["query_shape"] in set(shapes)


# --------------------------------------------------------------------------
# Exact-exported-name test (Acceptance #3/#4 / Edge case "naming gotcha")
# --------------------------------------------------------------------------


async def test_prometheus_series_names_have_no_unit_suffix():
    from opentelemetry.exporter.prometheus import PrometheusMetricReader
    from opentelemetry.sdk.resources import Resource
    from prometheus_client import REGISTRY, generate_latest

    reader = PrometheusMetricReader()
    provider = MeterProvider(
        resource=Resource.create({"service.name": "sayre-workers"}),
        metric_readers=[reader],
        views=_graph_views(),
        shutdown_on_exit=False,
    )
    metrics.set_meter_provider(provider)
    graph_metrics.reset_instruments_cache()

    try:
        async with graph_metrics.instrument_graph_query(
            "org-a", graph_metrics.QUERY_SHAPE_VIEWPORT_READ
        ) as m:
            await asyncio.sleep(0.001)
            m.set_result_node_count(3)

        body = generate_latest(REGISTRY)
    finally:
        provider.shutdown()

    # Exact exported series names -- no unit suffix (e.g. not
    # "graph_query_duration_ms_milliseconds"), concurrency is a gauge (no
    # "_total"), result-node-count is a histogram.
    assert b"graph_query_duration_ms_bucket{" in body
    assert b"graph_query_duration_ms_count{" in body
    assert b"graph_query_duration_ms_sum{" in body
    assert b"graph_query_concurrent_count{" in body
    assert b"graph_query_result_node_count_bucket{" in body
    assert b"graph_query_result_node_count_count{" in body
    assert b"graph_query_result_node_count_sum{" in body
    assert b"TYPE graph_query_concurrent_count gauge" in body
    assert b"TYPE graph_query_duration_ms histogram" in body
    assert b"TYPE graph_query_result_node_count histogram" in body
    assert b"graph_query_duration_ms_milliseconds" not in body
    assert b"graph_query_concurrent_count_total" not in body
    assert b'org_id="org-a"' in body
    assert b'query_shape="viewport_read"' in body


# --------------------------------------------------------------------------
# Validation tests (Acceptance #6 / Edge cases "Empty org_id", "Invalid shape")
# --------------------------------------------------------------------------


@pytest.mark.parametrize("bad_org_id", ["", "   ", None])
async def test_blank_org_id_raises_value_error_and_emits_nothing(bad_org_id):
    reader = _install_in_memory_provider()

    with pytest.raises(ValueError):
        async with graph_metrics.instrument_graph_query(
            bad_org_id, graph_metrics.QUERY_SHAPE_VIEWPORT_READ
        ):
            pass  # pragma: no cover -- must never be entered

    data = reader.get_metrics_data()
    # No metric emitted at all (blank org_id never reaches the instruments).
    assert _metric(data, graph_metrics.CONCURRENT_METRIC_NAME) is None
    assert _metric(data, graph_metrics.DURATION_METRIC_NAME) is None
    assert _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME) is None


@pytest.mark.parametrize(
    "bad_shape", ["", "read", "VIEWPORT_READ", None, "arbitrary-shape"]
)
async def test_invalid_query_shape_raises_value_error_and_emits_nothing(bad_shape):
    reader = _install_in_memory_provider()

    with pytest.raises(ValueError):
        async with graph_metrics.instrument_graph_query("org-a", bad_shape):
            pass  # pragma: no cover -- must never be entered

    data = reader.get_metrics_data()
    assert _metric(data, graph_metrics.CONCURRENT_METRIC_NAME) is None
    assert _metric(data, graph_metrics.DURATION_METRIC_NAME) is None
    assert _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME) is None


# --------------------------------------------------------------------------
# Failure-path tests (Acceptance #7 / Edge cases "Wrapped query raises",
# "Partial failure mid-burst")
# --------------------------------------------------------------------------


async def test_raising_query_still_decrements_and_records_duration_not_node_count():
    reader = _install_in_memory_provider()

    with pytest.raises(RuntimeError, match="boom"):
        async with graph_metrics.instrument_graph_query(
            "org-a", graph_metrics.QUERY_SHAPE_TRAVERSAL
        ):
            raise RuntimeError("boom")

    data = reader.get_metrics_data()
    assert _sum_by_org(data, graph_metrics.CONCURRENT_METRIC_NAME)["org-a"] == 0

    histograms = _histogram_by_org(data, graph_metrics.DURATION_METRIC_NAME)
    assert histograms["org-a"].count == 1

    # Result-node-count is NOT recorded for a query that raised without reporting.
    assert _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME) is None


async def test_partial_failure_mid_burst_still_nets_to_zero():
    reader = _install_in_memory_provider()

    async def worker(i: int) -> None:
        async with graph_metrics.instrument_graph_query(
            "org-a", graph_metrics.QUERY_SHAPE_WRITE
        ) as m:
            await asyncio.sleep(0)
            if i % 5 == 0:  # 10 of 50 raise
                raise RuntimeError(f"synthetic failure {i}")
            m.set_result_node_count(1)

    results = await asyncio.gather(
        *(worker(i) for i in range(50)), return_exceptions=True
    )
    failures = [r for r in results if isinstance(r, RuntimeError)]
    assert len(failures) == 10

    data = reader.get_metrics_data()
    assert _sum_by_org(data, graph_metrics.CONCURRENT_METRIC_NAME)["org-a"] == 0

    histograms = _histogram_by_org(data, graph_metrics.DURATION_METRIC_NAME)
    assert histograms["org-a"].count == 50  # every attempt recorded, success or failure

    node_count_histograms = _histogram_by_org(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
    # Only the 40 successful calls reported a result node count.
    assert node_count_histograms["org-a"].count == 40


# --------------------------------------------------------------------------
# Import-order / lazy-binding + init_metrics() behavior
# --------------------------------------------------------------------------


async def test_instruments_bind_lazily_to_whatever_provider_is_current():
    """Referencing the wrapper before a provider is installed must not
    silently drop emissions to a no-op meter once a real provider exists."""
    reader = _install_in_memory_provider()

    async with graph_metrics.instrument_graph_query(
        "org-z", graph_metrics.QUERY_SHAPE_VIEWPORT_READ
    ) as m:
        m.set_result_node_count(0)

    data = reader.get_metrics_data()
    assert _histogram_by_org(data, graph_metrics.DURATION_METRIC_NAME)["org-z"].count == 1
    node_count = _histogram_by_org(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
    assert node_count["org-z"].count == 1
    assert node_count["org-z"].sum == 0  # zero is a valid, recorded result


def test_init_metrics_rejects_unknown_exporter():
    with pytest.raises(ValueError, match="datadog"):
        otel_module.init_metrics(exporter="datadog")


def test_init_metrics_none_exporter_creates_provider_without_binding_a_port():
    provider = otel_module.init_metrics(exporter="none")
    assert provider is not None


def test_init_metrics_is_idempotent_and_serves_metrics():
    port = _free_port()

    provider1 = otel_module.init_metrics(
        exporter="prometheus", metrics_port=port, metrics_addr="127.0.0.1"
    )
    # Second call (even with different-looking args) is a no-op: same
    # provider object, no second HTTP server bind / "Address already in use".
    provider2 = otel_module.init_metrics(
        exporter="prometheus", metrics_port=port + 1, metrics_addr="127.0.0.1"
    )
    assert provider1 is provider2

    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5) as resp:
        body = resp.read()
    assert b"python_info" in body
