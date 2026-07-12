"""Deterministic tests for `sayre_workers.telemetry.vector_metrics`.

These tests install their own MeterProvider directly (InMemoryMetricReader
for the concurrency/duration assertions; PrometheusMetricReader for the
exact-exported-name guard) rather than going through `otel.init_metrics()`,
so the concurrency assertion never depends on scrape timing (see
`.pipeline/W0-06/spec.md` "Scrape timing vs. a short burst").

OTel's global MeterProvider can only be *set* once per process by design
(`opentelemetry.metrics._internal._METER_PROVIDER_SET_ONCE` is a one-shot
`Once()`); `_reset_otel_globals` resets that guard before every test (the
same technique the upstream `opentelemetry-python` test suite uses) so each
test can install its own isolated provider and have
`vector_metrics._get_instruments()` -- which is lazily bound to "the current
global MeterProvider" -- pick it up. `reset_instruments_cache()` is also
cleared belt-and-suspenders.
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

from sayre_workers.telemetry import otel as otel_module
from sayre_workers.telemetry import vector_metrics
from sayre_workers.telemetry.otel import VECTOR_QUERY_DURATION_BUCKETS_MS


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
    vector_metrics.reset_instruments_cache()
    yield
    otel_module.shutdown_metrics()
    vector_metrics.reset_instruments_cache()


def _duration_view() -> View:
    return View(
        instrument_name=vector_metrics.DURATION_METRIC_NAME,
        aggregation=ExplicitBucketHistogramAggregation(VECTOR_QUERY_DURATION_BUCKETS_MS),
    )


def _install_in_memory_provider() -> InMemoryMetricReader:
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader], views=[_duration_view()], shutdown_on_exit=False
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

    async def worker(org_id: str) -> None:
        async with vector_metrics.instrument_vector_query(org_id):
            await barrier.wait()  # park here, holding the query "in flight"

    tasks = [asyncio.create_task(worker(org_id)) for org_id in org_ids]

    # Wait until all 50 workers are parked at the barrier (in flight) before
    # taking the snapshot -- avoids a race against task scheduling.
    while barrier.n_waiting < 50:
        await asyncio.sleep(0)

    mid_flight = reader.get_metrics_data()
    concurrent = _sum_by_org(mid_flight, vector_metrics.CONCURRENT_METRIC_NAME)
    assert sum(concurrent.values()) == 50
    assert set(concurrent.keys()) == {"org-0", "org-1", "org-2"}
    # summing per-org concurrency equals total in-flight (multi-tenant tagging)
    assert concurrent["org-0"] + concurrent["org-1"] + concurrent["org-2"] == 50

    # Release all 50 workers (the 51st arrival is this coroutine itself).
    await barrier.wait()
    await asyncio.gather(*tasks)

    final = reader.get_metrics_data()
    final_concurrent = _sum_by_org(final, vector_metrics.CONCURRENT_METRIC_NAME)
    assert sum(final_concurrent.values()) == 0

    histograms = _histogram_by_org(final, vector_metrics.DURATION_METRIC_NAME)
    assert sum(dp.count for dp in histograms.values()) == 50
    for dp in histograms.values():
        assert sum(dp.bucket_counts) == dp.count
        assert dp.sum >= 0
        assert dp.attributes["org_id"] in {"org-0", "org-1", "org-2"}


# --------------------------------------------------------------------------
# Exact-exported-name test (Acceptance #4 / Edge case "naming gotcha")
# --------------------------------------------------------------------------


async def test_prometheus_series_names_have_no_unit_suffix():
    from opentelemetry.exporter.prometheus import PrometheusMetricReader
    from opentelemetry.sdk.resources import Resource
    from prometheus_client import REGISTRY, generate_latest

    reader = PrometheusMetricReader()
    provider = MeterProvider(
        resource=Resource.create({"service.name": "sayre-workers"}),
        metric_readers=[reader],
        views=[_duration_view()],
        shutdown_on_exit=False,
    )
    metrics.set_meter_provider(provider)
    vector_metrics.reset_instruments_cache()

    try:
        async with vector_metrics.instrument_vector_query("org-a"):
            await asyncio.sleep(0.001)

        body = generate_latest(REGISTRY)
    finally:
        provider.shutdown()

    # Exact exported series names -- no unit suffix (e.g. not
    # "vector_query_duration_ms_milliseconds"), concurrency is a gauge (no
    # "_total").
    assert b"vector_query_duration_ms_bucket{" in body
    assert b"vector_query_duration_ms_count{" in body
    assert b"vector_query_duration_ms_sum{" in body
    assert b"vector_query_concurrent_count{" in body
    assert b"TYPE vector_query_concurrent_count gauge" in body
    assert b"TYPE vector_query_duration_ms histogram" in body
    assert b"vector_query_duration_ms_milliseconds" not in body
    assert b"vector_query_concurrent_count_total" not in body


# --------------------------------------------------------------------------
# Failure-path tests (Acceptance #3 / Edge cases "Wrapped query raises",
# "Partial failure mid-burst", "Empty / None / whitespace org_id")
# --------------------------------------------------------------------------


@pytest.mark.parametrize("bad_org_id", ["", "   ", None])
async def test_blank_org_id_raises_value_error_and_emits_nothing(bad_org_id):
    reader = _install_in_memory_provider()

    with pytest.raises(ValueError):
        async with vector_metrics.instrument_vector_query(bad_org_id):
            pass  # pragma: no cover -- must never be entered

    data = reader.get_metrics_data()
    # No metric emitted at all (blank org_id never reaches the instruments).
    assert _metric(data, vector_metrics.CONCURRENT_METRIC_NAME) is None
    assert _metric(data, vector_metrics.DURATION_METRIC_NAME) is None


async def test_raising_query_still_decrements_and_records_duration():
    reader = _install_in_memory_provider()

    with pytest.raises(RuntimeError, match="boom"):
        async with vector_metrics.instrument_vector_query("org-a"):
            raise RuntimeError("boom")

    data = reader.get_metrics_data()
    assert _sum_by_org(data, vector_metrics.CONCURRENT_METRIC_NAME)["org-a"] == 0

    histograms = _histogram_by_org(data, vector_metrics.DURATION_METRIC_NAME)
    assert histograms["org-a"].count == 1


async def test_partial_failure_mid_burst_still_nets_to_zero():
    reader = _install_in_memory_provider()

    async def worker(i: int) -> None:
        async with vector_metrics.instrument_vector_query("org-a"):
            await asyncio.sleep(0)
            if i % 5 == 0:  # 10 of 50 raise
                raise RuntimeError(f"synthetic failure {i}")

    results = await asyncio.gather(
        *(worker(i) for i in range(50)), return_exceptions=True
    )
    failures = [r for r in results if isinstance(r, RuntimeError)]
    assert len(failures) == 10

    data = reader.get_metrics_data()
    assert _sum_by_org(data, vector_metrics.CONCURRENT_METRIC_NAME)["org-a"] == 0

    histograms = _histogram_by_org(data, vector_metrics.DURATION_METRIC_NAME)
    assert histograms["org-a"].count == 50  # every attempt recorded, success or failure


# --------------------------------------------------------------------------
# Import-order / lazy-binding + init_metrics() behavior
# --------------------------------------------------------------------------


async def test_instruments_bind_lazily_to_whatever_provider_is_current():
    """Referencing the wrapper before a provider is installed must not
    silently drop emissions to a no-op meter once a real provider exists."""
    reader = _install_in_memory_provider()

    async with vector_metrics.instrument_vector_query("org-z"):
        pass

    data = reader.get_metrics_data()
    assert _histogram_by_org(data, vector_metrics.DURATION_METRIC_NAME)["org-z"].count == 1


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
