"""Supplementary Tester-stage coverage for `sayre_workers.telemetry` (W0-06).

Complements `test_vector_metrics.py` (the dev-authored suite) by closing spec
gaps that suite does not assert:

  * Acceptance #4 -- the *exported* histogram bucket boundaries are exactly
    ``VECTOR_QUERY_DURATION_BUCKETS_MS`` (the dev suite asserts the series
    *names* have no unit suffix, but never that the custom buckets -- not the
    coarse OTel defaults -- are the ones applied; Acceptance #8's p95/p99
    sufficiency hinges on this).
  * Edge case "Exporter selection" -- ``console`` actually prints, and ``none``
    registers no reader (emits nothing / binds no port). The dev suite only
    checked ``none`` returns a non-None provider and that ``unknown`` raises.
  * Acceptance #2 / edge "Exporter selection" -- the exporter is resolved from
    the ``OTEL_METRICS_EXPORTER`` env var when no explicit arg is passed.
  * Decision 1 / lazy-cache -- swapping the global provider yields fresh
    instruments bound to the new provider (emissions follow the swap; the old
    provider stops receiving them).
  * Acceptance #7 facet -- distinct exported series per ``org_id`` (multi-tenant
    concurrency + latency visible), asserted here in-process against the real
    Prometheus exporter so it does not depend on the docker scrape.

Uses the same OTel process-global reset technique as the dev suite so each test
installs its own isolated MeterProvider (``set_meter_provider`` is a one-shot
per process by design).
"""

from __future__ import annotations

import asyncio

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


@pytest.fixture(autouse=True)
def _reset_otel_globals(monkeypatch):
    """Reset OTel's process-global MeterProvider one-shot guard + this repo's
    own init_metrics() guard before each test; tear down cleanly after."""
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


def _install_in_memory_provider() -> tuple[MeterProvider, InMemoryMetricReader]:
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader], views=[_duration_view()], shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider)
    vector_metrics.reset_instruments_cache()
    return provider, reader


# --------------------------------------------------------------------------
# Acceptance #4 -- exported histogram bucket boundaries are the CUSTOM ones
# --------------------------------------------------------------------------


async def test_exported_histogram_buckets_are_the_custom_boundaries():
    """Guard against a regression to OTel's coarse default buckets: the
    exported `le=` boundaries must be exactly VECTOR_QUERY_DURATION_BUCKETS_MS
    (+ the implicit +Inf overflow bucket). Acceptance #8's p95/p99 relies on
    these boundaries existing in the sub-100ms band."""
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
            await asyncio.sleep(0.003)
        body = generate_latest(REGISTRY).decode()
    finally:
        provider.shutdown()

    # Extract every le="..." value from the bucket lines.
    le_values = []
    for line in body.splitlines():
        if line.startswith("vector_query_duration_ms_bucket{"):
            start = line.index('le="') + 4
            end = line.index('"', start)
            le_values.append(line[start:end])

    expected = [
        str(int(b)) if float(b).is_integer() else str(b)
        for b in VECTOR_QUERY_DURATION_BUCKETS_MS
    ]
    # One series (org-a) => each boundary appears once, in order, then +Inf.
    assert le_values == expected + ["+Inf"], (
        f"exported buckets {le_values} != custom {expected} + ['+Inf'] "
        "(regressed to OTel default buckets?)"
    )


# --------------------------------------------------------------------------
# Edge case "Exporter selection" -- console prints, none registers no reader
# --------------------------------------------------------------------------


async def test_console_exporter_emits_metric_names():
    """`console` exporter emits the metric names (flushed on shutdown). Edge
    case 'console prints'.

    OTel's ConsoleMetricExporter binds `out=sys.stdout` as a *default
    argument* evaluated at import time, which defeats both `capsys` (Python
    level) and, in practice, fd-level capture under pytest. To assert the
    payload deterministically we redirect the reader's exporter stream to an
    in-memory buffer, then trigger the export via shutdown."""
    import io

    provider = otel_module.init_metrics(exporter="console")
    vector_metrics.reset_instruments_cache()

    # The 'console' branch attaches a single PeriodicExportingMetricReader
    # wrapping a ConsoleMetricExporter -- redirect its output stream.
    reader = provider._sdk_config.metric_readers[0]
    buf = io.StringIO()
    reader._exporter.out = buf

    async with vector_metrics.instrument_vector_query("org-a"):
        await asyncio.sleep(0)

    # ConsoleMetricExporter exports on force_flush/shutdown.
    otel_module.shutdown_metrics()

    out = buf.getvalue()
    assert "vector_query_duration_ms" in out
    assert "vector_query_concurrent_count" in out
    assert "org-a" in out


def test_none_exporter_registers_no_reader_and_binds_no_port():
    """`none` disables emission cleanly: a provider exists (so lazy binding
    never silently no-ops) but no metric reader is attached, so nothing is
    exported and no HTTP port is bound. Edge case 'none disables cleanly'."""
    provider = otel_module.init_metrics(exporter="none")
    assert provider is not None
    # No reader attached -> nothing exported. `_sdk_config.metric_readers` is
    # the per-provider reader list (NOT `_all_metric_readers`, which is a
    # process-global accumulator shared across every provider in the process).
    assert list(provider._sdk_config.metric_readers) == []


# --------------------------------------------------------------------------
# Acceptance #2 / edge "Exporter selection" -- env var drives selection
# --------------------------------------------------------------------------


def test_exporter_resolved_from_env_var_when_no_arg(monkeypatch):
    """With no explicit `exporter=`, init_metrics() reads OTEL_METRICS_EXPORTER.
    Using 'none' here keeps the test port-free while still exercising the
    env-resolution branch."""
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "none")
    provider = otel_module.init_metrics()  # no exporter arg -> env
    assert provider is not None
    assert list(provider._sdk_config.metric_readers) == []


def test_unknown_env_exporter_also_raises(monkeypatch):
    """An unknown value coming from the env (not just the arg) must also raise
    a clear ValueError -- no silent default that hides a typo."""
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "cloudwatch")
    with pytest.raises(ValueError, match="cloudwatch"):
        otel_module.init_metrics()


# --------------------------------------------------------------------------
# Decision 1 / lazy cache -- swapping the provider rebinds instruments
# --------------------------------------------------------------------------


async def test_provider_swap_rebinds_instruments_to_new_provider():
    """After the global provider is swapped, emissions land in the NEW
    provider's reader and the old provider stops receiving them (cache keyed
    on provider identity, per Decision 1)."""
    provider_a, reader_a = _install_in_memory_provider()

    async with vector_metrics.instrument_vector_query("org-a"):
        await asyncio.sleep(0)

    # Swap in a brand-new provider. OTel's set_meter_provider is a process
    # one-shot, so reset its guard to actually install a second provider (this
    # is exactly the cross-test scenario the dev fixture handles). No
    # reset_instruments_cache() call here on purpose: the provider *identity*
    # change alone must trigger a rebind inside _get_instruments().
    _otel_metrics_internal._METER_PROVIDER = None
    _otel_metrics_internal._METER_PROVIDER_SET_ONCE = Once()
    reader_b = InMemoryMetricReader()
    provider_b = MeterProvider(
        metric_readers=[reader_b], views=[_duration_view()], shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider_b)

    async with vector_metrics.instrument_vector_query("org-b"):
        await asyncio.sleep(0)

    def _orgs(data, name):
        for rm in (data.resource_metrics if data else []):
            for sm in rm.scope_metrics:
                for m in sm.metrics:
                    if m.name == name:
                        return {dp.attributes["org_id"] for dp in m.data.data_points}
        return set()

    data_a = reader_a.get_metrics_data()
    data_b = reader_b.get_metrics_data()
    # New provider saw org-b; it never saw org-a.
    assert "org-b" in _orgs(data_b, vector_metrics.DURATION_METRIC_NAME)
    assert "org-a" not in _orgs(data_b, vector_metrics.DURATION_METRIC_NAME)

    provider_a.shutdown()
    provider_b.shutdown()


# --------------------------------------------------------------------------
# Acceptance #7 facet -- distinct exported series per org_id
# --------------------------------------------------------------------------


async def test_distinct_prometheus_series_per_org_id():
    """A burst mixing org-a/b/c produces a distinct exported gauge + histogram
    series per org_id (multi-tenant concurrency/latency visible), asserted
    against the real Prometheus exporter in-process (independent of scrape)."""
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
        async def worker(org_id: str) -> None:
            async with vector_metrics.instrument_vector_query(org_id):
                await asyncio.sleep(0.002)

        await asyncio.gather(*(worker(f"org-{c}") for c in "abc" for _ in range(4)))
        body = generate_latest(REGISTRY).decode()
    finally:
        provider.shutdown()

    for org in ("org-a", "org-b", "org-c"):
        assert f'vector_query_concurrent_count{{org_id="{org}"}}' in body
        assert f'vector_query_duration_ms_count{{org_id="{org}"}}' in body
        # 4 queries per org all recorded.
        assert f'vector_query_duration_ms_count{{org_id="{org}"}} 4.0' in body
