"""Supplementary Tester-stage coverage for `sayre_workers.telemetry.graph_metrics`
and `scripts/synthetic_graph_load.py` (W0-08).

Complements `test_graph_metrics.py` (the dev-authored suite) by closing spec gaps
that suite does not assert, mirroring the split established by
`tests/test_vector_metrics_tester.py` for W0-06:

  * Acceptance #4 -- the *exported* histogram bucket boundaries for BOTH graph
    histograms (duration and result-node-count) are exactly
    ``GRAPH_QUERY_DURATION_BUCKETS_MS`` / ``GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS``,
    not OTel's coarse defaults (the dev suite only asserts the series *names*).
  * Acceptance #2 -- distinct exported Prometheus series per (org_id, query_shape)
    pair, not just per org_id.
  * Interfaces `GraphQueryMeasurement.set_result_node_count()` -- zero is a valid
    recorded value, negative raises `ValueError`, multiple calls -> last one wins,
    and "never called" leaves the histogram untouched (no spurious zero).
  * Edge case "Exporter selection" -- `console` prints graph metric names, `none`
    registers no reader, and `OTEL_METRICS_EXPORTER` env-var resolution (shared
    `otel.py` behavior, re-asserted here against the graph instruments specifically
    since a regression could plausibly be graph-view-specific -- e.g. a `_views()`
    wiring bug that only breaks the graph views).
  * Decision 1 / lazy cache -- swapping the global provider rebinds ALL THREE graph
    instruments (duration, concurrent, result-node-count), not just one.
  * Sentinel-anchor safety (Edge case "Sentinel-anchor safety (script)") -- a real
    seed -> load -> cleanup cycle against local Neo4j never touches the W0-02
    all-zero-org schema-anchor nodes/edges and leaves zero synthetic residue.
    Guarded behind Neo4j reachability so CI without Neo4j skips cleanly (mirrors
    `tests/test_graph_migrations.py`'s `_neo4j_reachable()` pattern).

Uses the same OTel process-global reset technique as the dev suite so each test
installs its own isolated MeterProvider (`set_meter_provider` is a one-shot per
process by design).
"""

from __future__ import annotations

import asyncio
import functools
import os

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


@pytest.fixture(autouse=True)
def _reset_otel_globals(monkeypatch):
    """Reset OTel's process-global MeterProvider one-shot guard + this repo's
    own init_metrics() guard before each test; tear down cleanly after."""
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


def _install_in_memory_provider() -> tuple[MeterProvider, InMemoryMetricReader]:
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader], views=_graph_views(), shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider)
    graph_metrics.reset_instruments_cache()
    return provider, reader


def _metric(data, name):
    if data is None:
        return None
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                if metric.name == name:
                    return metric
    return None


def _histogram_by_org(data, name: str) -> dict[str, object]:
    metric = _metric(data, name)
    if metric is None:
        return {}
    return {dp.attributes["org_id"]: dp for dp in metric.data.data_points}


# --------------------------------------------------------------------------
# Acceptance #4 -- exported histogram bucket boundaries are the CUSTOM ones
# (both graph histograms, not just duration)
# --------------------------------------------------------------------------


def _le_values(body: str, series_prefix: str) -> list[str]:
    le_values = []
    for line in body.splitlines():
        if line.startswith(series_prefix):
            start = line.index('le="') + 4
            end = line.index('"', start)
            le_values.append(line[start:end])
    return le_values


def _expected_le(buckets: list[float]) -> list[str]:
    return [str(int(b)) if float(b).is_integer() else str(b) for b in buckets] + ["+Inf"]


async def test_exported_duration_buckets_are_the_custom_graph_boundaries():
    """Guard against a regression to OTel's coarse default buckets on the
    duration histogram: exported `le=` boundaries must be exactly
    GRAPH_QUERY_DURATION_BUCKETS_MS (+ the implicit +Inf overflow bucket)."""
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
            "org-a", graph_metrics.QUERY_SHAPE_TRAVERSAL
        ) as m:
            await asyncio.sleep(0.003)
            m.set_result_node_count(2)
        body = generate_latest(REGISTRY).decode()
    finally:
        provider.shutdown()

    le_values = _le_values(body, "graph_query_duration_ms_bucket{")
    expected = _expected_le(GRAPH_QUERY_DURATION_BUCKETS_MS)
    assert le_values == expected, (
        f"exported duration buckets {le_values} != custom {expected} "
        "(regressed to OTel default buckets?)"
    )


async def test_exported_result_node_count_buckets_are_the_custom_graph_boundaries():
    """Same guard as above, for the result-node-count histogram -- its View is
    wired separately in otel.py's `_views()` and could regress independently."""
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
            m.set_result_node_count(7)
        body = generate_latest(REGISTRY).decode()
    finally:
        provider.shutdown()

    le_values = _le_values(body, "graph_query_result_node_count_bucket{")
    expected = _expected_le(GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS)
    assert le_values == expected, (
        f"exported result-node-count buckets {le_values} != custom {expected} "
        "(regressed to OTel default buckets?)"
    )


# --------------------------------------------------------------------------
# Acceptance #2 -- distinct exported series per (org_id, query_shape)
# --------------------------------------------------------------------------


async def test_distinct_prometheus_series_per_org_and_shape():
    """A burst mixing 3 orgs x 3 shapes produces a distinct exported gauge +
    histogram series per (org_id, query_shape) pair -- not just per org_id --
    asserted against the real Prometheus exporter in-process (independent of
    any docker scrape). Directly exercises the PromQL
    `sum by (org_id, query_shape) (graph_query_concurrent_count)` acceptance
    facet (spec.md Acceptance #2)."""
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

    orgs = ["org-a", "org-b", "org-c"]
    shapes = [
        graph_metrics.QUERY_SHAPE_VIEWPORT_READ,
        graph_metrics.QUERY_SHAPE_WRITE,
        graph_metrics.QUERY_SHAPE_TRAVERSAL,
    ]

    try:
        async def worker(org_id: str, shape: str) -> None:
            async with graph_metrics.instrument_graph_query(org_id, shape) as m:
                await asyncio.sleep(0.001)
                m.set_result_node_count(1)

        await asyncio.gather(
            *(worker(org, shape) for org in orgs for shape in shapes)
        )
        body = generate_latest(REGISTRY).decode()
    finally:
        provider.shutdown()

    for org in orgs:
        for shape in shapes:
            assert (
                f'graph_query_concurrent_count{{org_id="{org}",query_shape="{shape}"}}'
                in body
            )
            assert (
                f'graph_query_duration_ms_count{{org_id="{org}",query_shape="{shape}"}} 1.0'
                in body
            )
            assert (
                f'graph_query_result_node_count_count{{org_id="{org}",'
                f'query_shape="{shape}"}} 1.0' in body
            )


# --------------------------------------------------------------------------
# GraphQueryMeasurement.set_result_node_count() -- recorded-only-when-set,
# zero/negative/multi-call cases
# --------------------------------------------------------------------------


async def test_result_node_count_never_called_leaves_histogram_untouched():
    """A caller that forgets to report a result node count (e.g. a shape that
    produced no meaningful count) must not pollute the distribution with a
    spurious sample -- the histogram has NO data point for that org at all,
    not a zero-valued one."""
    _, reader = _install_in_memory_provider()

    async with graph_metrics.instrument_graph_query(
        "org-a", graph_metrics.QUERY_SHAPE_WRITE
    ):
        await asyncio.sleep(0)
        # caller never calls m.set_result_node_count()

    data = reader.get_metrics_data()
    assert _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME) is None


async def test_result_node_count_zero_is_recorded_as_a_real_sample():
    """Zero is a valid, meaningful result (e.g. a viewport read over an org
    with no matching files) and MUST be recorded -- distinct from "never
    called", which records nothing at all."""
    _, reader = _install_in_memory_provider()

    async with graph_metrics.instrument_graph_query(
        "org-a", graph_metrics.QUERY_SHAPE_VIEWPORT_READ
    ) as m:
        m.set_result_node_count(0)

    data = reader.get_metrics_data()
    histograms = _histogram_by_org(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
    assert histograms["org-a"].count == 1
    assert histograms["org-a"].sum == 0


def test_set_result_node_count_negative_raises_value_error():
    """A negative count is a caller bug, never silently clamped or recorded."""
    measurement = graph_metrics.GraphQueryMeasurement()
    with pytest.raises(ValueError):
        measurement.set_result_node_count(-1)


async def test_set_result_node_count_negative_inside_block_still_nets_concurrency_to_zero():
    """set_result_node_count(-1) raises INSIDE the `async with` block, the same
    as any other exception raised by caller code -- duration is still recorded,
    concurrency still nets to zero, and result-node-count is NOT recorded
    (the raise happens before the value is assigned)."""
    _, reader = _install_in_memory_provider()

    with pytest.raises(ValueError):
        async with graph_metrics.instrument_graph_query(
            "org-a", graph_metrics.QUERY_SHAPE_WRITE
        ) as m:
            m.set_result_node_count(-1)

    data = reader.get_metrics_data()
    concurrent = _metric(data, graph_metrics.CONCURRENT_METRIC_NAME)
    total = sum(dp.value for dp in concurrent.data.data_points)
    assert total == 0

    duration = _histogram_by_org(data, graph_metrics.DURATION_METRIC_NAME)
    assert duration["org-a"].count == 1

    assert _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME) is None


async def test_set_result_node_count_multiple_calls_last_one_wins():
    _, reader = _install_in_memory_provider()

    async with graph_metrics.instrument_graph_query(
        "org-a", graph_metrics.QUERY_SHAPE_TRAVERSAL
    ) as m:
        m.set_result_node_count(5)
        m.set_result_node_count(12)
        m.set_result_node_count(3)  # last call wins

    data = reader.get_metrics_data()
    histograms = _histogram_by_org(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
    assert histograms["org-a"].count == 1
    assert histograms["org-a"].sum == 3


async def test_result_node_count_reported_then_raise_afterward_still_records_it():
    """Edge case "Result count reported then query raises afterward inside the
    block": the wrapper's `finally` checks `measurement._result_node_count is
    not None` -- it does NOT care whether that happened before or after a
    later exception. So if the caller successfully reports a count and THEN
    the block raises (e.g. a post-processing step after the query itself
    succeeded), the already-reported count IS still recorded even though the
    call overall failed -- distinct from "raised before ever reporting"
    (which records nothing, per `test_raising_query_still_decrements_and_
    records_duration_not_node_count` in the dev suite). This pins the
    documented "record only if set at finally-time" behavior explicitly."""
    reader = InMemoryMetricReader()
    provider = MeterProvider(
        metric_readers=[reader], views=_graph_views(), shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider)
    graph_metrics.reset_instruments_cache()

    try:
        with pytest.raises(RuntimeError, match="boom"):
            async with graph_metrics.instrument_graph_query(
                "org-a", graph_metrics.QUERY_SHAPE_VIEWPORT_READ
            ) as m:
                m.set_result_node_count(4)  # query succeeded, count reported
                raise RuntimeError("boom")  # then something else in the block fails

        data = reader.get_metrics_data()

        concurrent = _metric(data, graph_metrics.CONCURRENT_METRIC_NAME)
        assert sum(dp.value for dp in concurrent.data.data_points) == 0

        duration = _histogram_by_org(data, graph_metrics.DURATION_METRIC_NAME)
        assert duration["org-a"].count == 1

        # The count reported BEFORE the raise is still recorded.
        node_count = _histogram_by_org(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
        assert node_count["org-a"].count == 1
        assert node_count["org-a"].sum == 4
    finally:
        provider.shutdown()


# --------------------------------------------------------------------------
# Edge case "Exporter selection" -- console prints, none registers no reader,
# env-var resolution (re-asserted against the graph instruments specifically)
# --------------------------------------------------------------------------


async def test_console_exporter_emits_graph_metric_names():
    """`console` exporter emits all three graph metric names (flushed on
    shutdown), proving the graph views/instruments ride the console branch
    too, not just the prometheus branch exercised elsewhere."""
    import io

    provider = otel_module.init_metrics(exporter="console")
    graph_metrics.reset_instruments_cache()

    reader = provider._sdk_config.metric_readers[0]
    buf = io.StringIO()
    reader._exporter.out = buf

    async with graph_metrics.instrument_graph_query(
        "org-a", graph_metrics.QUERY_SHAPE_WRITE
    ) as m:
        await asyncio.sleep(0)
        m.set_result_node_count(1)

    otel_module.shutdown_metrics()

    out = buf.getvalue()
    assert "graph_query_duration_ms" in out
    assert "graph_query_concurrent_count" in out
    assert "graph_query_result_node_count" in out
    assert "org-a" in out


def test_none_exporter_registers_no_reader_for_graph_instruments():
    """`none` disables emission cleanly for the graph provider too: a provider
    exists (so lazy binding never silently no-ops) but no reader is attached."""
    provider = otel_module.init_metrics(exporter="none")
    assert provider is not None
    assert list(provider._sdk_config.metric_readers) == []


def test_exporter_resolved_from_env_var_when_no_arg_graph(monkeypatch):
    """With no explicit `exporter=`, init_metrics() reads OTEL_METRICS_EXPORTER --
    re-asserted here since a graph-specific `_views()` wiring regression could
    plausibly break this only for the graph instruments."""
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "none")
    provider = otel_module.init_metrics()
    assert provider is not None
    assert list(provider._sdk_config.metric_readers) == []


# --------------------------------------------------------------------------
# Decision 1 / lazy cache -- swapping the provider rebinds ALL THREE graph
# instruments (duration, concurrent, result-node-count)
# --------------------------------------------------------------------------


async def test_provider_swap_rebinds_all_three_graph_instruments():
    """After the global provider is swapped, emissions for duration,
    concurrency, AND result-node-count all land in the NEW provider's reader;
    the old provider stops receiving any of the three (cache keyed on
    provider identity, per Decision 1 -- must hold for all 3 instruments, not
    just the ones vector_metrics exercises)."""
    provider_a, reader_a = _install_in_memory_provider()

    async with graph_metrics.instrument_graph_query(
        "org-a", graph_metrics.QUERY_SHAPE_VIEWPORT_READ
    ) as m:
        m.set_result_node_count(1)

    _otel_metrics_internal._METER_PROVIDER = None
    _otel_metrics_internal._METER_PROVIDER_SET_ONCE = Once()
    reader_b = InMemoryMetricReader()
    provider_b = MeterProvider(
        metric_readers=[reader_b], views=_graph_views(), shutdown_on_exit=False
    )
    metrics.set_meter_provider(provider_b)
    # No reset_instruments_cache() call here on purpose: the provider *identity*
    # change alone must trigger a rebind inside _get_instruments().

    async with graph_metrics.instrument_graph_query(
        "org-b", graph_metrics.QUERY_SHAPE_WRITE
    ) as m:
        m.set_result_node_count(2)

    def _orgs(data, name):
        for rm in (data.resource_metrics if data else []):
            for sm in rm.scope_metrics:
                for m2 in sm.metrics:
                    if m2.name == name:
                        return {dp.attributes["org_id"] for dp in m2.data.data_points}
        return set()

    data_b = reader_b.get_metrics_data()
    for name in (
        graph_metrics.DURATION_METRIC_NAME,
        graph_metrics.CONCURRENT_METRIC_NAME,
        graph_metrics.RESULT_NODE_COUNT_METRIC_NAME,
    ):
        orgs_seen = _orgs(data_b, name)
        assert "org-b" in orgs_seen, f"{name}: new provider never saw org-b"
        assert "org-a" not in orgs_seen, f"{name}: new provider leaked org-a from old provider"

    provider_a.shutdown()
    provider_b.shutdown()


# --------------------------------------------------------------------------
# Edge case "--simulate": all three shapes emitted without opening a driver
# (Neo4j-less smoke path) -- deterministic, no Neo4j required.
# --------------------------------------------------------------------------


async def test_simulate_run_load_produces_all_three_shapes_without_a_driver(monkeypatch):
    """`run_load(simulate=True)` must route every batch through
    `instrument_graph_query()` with all three query shapes visible, and must
    never call `neo4j_driver_from_env()` (proving it never opens a real
    driver) -- the Neo4j-less CI/smoke path spec.md's Open Question #4
    describes."""
    import sys

    sys.path.insert(0, ".")
    from scripts import synthetic_graph_load

    provider, in_memory_reader = _install_in_memory_provider()

    def _fail_if_called() -> None:
        raise AssertionError(
            "neo4j_driver_from_env() must never be called when simulate=True"
        )

    monkeypatch.setattr(
        synthetic_graph_load, "neo4j_driver_from_env", lambda: _fail_if_called()
    )

    try:
        await synthetic_graph_load.run_load(
            concurrency=9,
            org_ids=["org-a", "org-b"],
            duration_seconds=0.01,
            simulate=True,
        )
    finally:
        provider.shutdown()

    data = in_memory_reader.get_metrics_data()
    duration_metric = _metric(data, graph_metrics.DURATION_METRIC_NAME)
    assert duration_metric is not None
    shapes_seen = {dp.attributes["query_shape"] for dp in duration_metric.data.data_points}
    assert shapes_seen == {
        graph_metrics.QUERY_SHAPE_VIEWPORT_READ,
        graph_metrics.QUERY_SHAPE_WRITE,
        graph_metrics.QUERY_SHAPE_TRAVERSAL,
    }
    # Concurrency nets to zero once the (short, simulated) run completes.
    concurrent_metric = _metric(data, graph_metrics.CONCURRENT_METRIC_NAME)
    assert sum(dp.value for dp in concurrent_metric.data.data_points) == 0


# --------------------------------------------------------------------------
# Sentinel-anchor safety (script) -- real seed -> load -> cleanup cycle,
# guarded behind Neo4j reachability (skips cleanly without Neo4j)
# --------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _neo4j_reachable() -> bool:
    try:
        import neo4j

        uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
        user = os.environ.get("NEO4J_USER", "neo4j")
        password = os.environ.get("NEO4J_PASSWORD")
        if not password:
            return False
        driver = neo4j.GraphDatabase.driver(uri, auth=(user, password), connection_timeout=2)
        try:
            driver.verify_connectivity()
            return True
        finally:
            driver.close()
    except Exception:
        return False


pytestmark_integration = pytest.mark.skipif(
    not _neo4j_reachable(),
    reason="Neo4j unreachable -- skipping real-infra synthetic-load sentinel-safety test",
)


@pytestmark_integration
def test_synthetic_load_seed_cycle_never_touches_sentinel_anchors_and_cleans_up():
    """Headline script-level acceptance check (spec.md Acceptance #9 / Edge case
    "Sentinel-anchor safety (script)"): a full seed_org_data -> real queries via
    instrument_graph_query -> cleanup_org_data cycle for a synthetic org
    - never changes the count of W0-02 all-zero-org schema-anchor nodes/edges
      (uid='__schema_anchor__', org_id='00000000-...-0000'), and
    - leaves zero residual '__synthetic_load__'-prefixed nodes afterward.

    Only runs when Neo4j is reachable (see `_neo4j_reachable` above); skips
    cleanly in CI/dev environments without a local Neo4j.
    """
    import asyncio as _asyncio
    import sys

    sys.path.insert(0, ".")
    import neo4j

    from scripts.synthetic_graph_load import (
        DEFAULT_SYNTHETIC_ORGS,
        SYNTHETIC_UID_PREFIX,
        _traversal,
        _viewport_read,
        _write,
        cleanup_org_data,
        seed_org_data,
    )

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ["NEO4J_PASSWORD"]
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))

    org_id = DEFAULT_SYNTHETIC_ORGS[0]

    def _anchor_count() -> int:
        with driver.session() as session:
            return session.run(
                "MATCH (n {uid: '__schema_anchor__'}) RETURN count(n) AS c"
            ).single()["c"]

    def _anchor_edge_count() -> int:
        with driver.session() as session:
            return session.run(
                "MATCH ()-[r]->() WHERE r.org_id = '00000000-0000-0000-0000-000000000000' "
                "RETURN count(r) AS c"
            ).single()["c"]

    def _synthetic_residue_count() -> int:
        with driver.session() as session:
            return session.run(
                "MATCH (n) WHERE n.uid STARTS WITH $prefix RETURN count(n) AS c",
                prefix=SYNTHETIC_UID_PREFIX,
            ).single()["c"]

    anchors_before = _anchor_count()
    anchor_edges_before = _anchor_edge_count()
    # Ensure a clean slate for the residue assertion regardless of prior test runs.
    cleanup_org_data(driver, org_id)
    residue_before = _synthetic_residue_count()
    assert residue_before == 0

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], views=_graph_views(), shutdown_on_exit=False)
    metrics.set_meter_provider(provider)
    graph_metrics.reset_instruments_cache()

    try:
        seed_org_data(driver, org_id, folders=2, files_per_folder=3)
        # Seeding must be scoped to the synthetic org -- sentinel anchors untouched.
        assert _anchor_count() == anchors_before
        assert _anchor_edge_count() == anchor_edges_before
        assert _synthetic_residue_count() > 0  # seed actually wrote something

        async def _drive() -> None:
            async with graph_metrics.instrument_graph_query(
                org_id, graph_metrics.QUERY_SHAPE_VIEWPORT_READ
            ) as m:
                count = _viewport_read(driver, org_id)
                m.set_result_node_count(count)
            async with graph_metrics.instrument_graph_query(
                org_id, graph_metrics.QUERY_SHAPE_WRITE
            ) as m:
                count = _write(driver, org_id)
                m.set_result_node_count(count)
            async with graph_metrics.instrument_graph_query(
                org_id, graph_metrics.QUERY_SHAPE_TRAVERSAL
            ) as m:
                count = _traversal(driver, org_id)
                m.set_result_node_count(count)

        _asyncio.run(_drive())

        data = reader.get_metrics_data()
        for shape in (
            graph_metrics.QUERY_SHAPE_VIEWPORT_READ,
            graph_metrics.QUERY_SHAPE_WRITE,
            graph_metrics.QUERY_SHAPE_TRAVERSAL,
        ):
            duration_metric = _metric(data, graph_metrics.DURATION_METRIC_NAME)
            shapes_seen = {dp.attributes["query_shape"] for dp in duration_metric.data.data_points}
            assert shape in shapes_seen

        cleanup_org_data(driver, org_id)

        assert _synthetic_residue_count() == 0
        assert _anchor_count() == anchors_before
        assert _anchor_edge_count() == anchor_edges_before
    finally:
        provider.shutdown()
        # Belt-and-suspenders: guarantee no synthetic residue survives this test
        # even if an assertion above failed mid-way.
        cleanup_org_data(driver, org_id)
        driver.close()


@pytestmark_integration
def test_viewport_read_and_traversal_over_unseeded_org_return_zero_without_error():
    """Edge case "Concurrency > seeded data": `_viewport_read`/`_traversal`
    against an org_id with NO seeded synthetic subtree must return a valid 0
    (not raise, not None) -- e.g. a canvas viewport read for a brand-new
    tenant with no files yet. `instrument_graph_query` must still record a
    real (zero-valued, not skipped) result-node-count sample for it, per
    Acceptance #8 / the "Zero -> recorded as 0" edge case applied to a
    genuinely empty real query result."""
    import asyncio as _asyncio
    import sys

    sys.path.insert(0, ".")
    import neo4j

    from scripts.synthetic_graph_load import _traversal, _viewport_read, cleanup_org_data

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ["NEO4J_PASSWORD"]
    driver = neo4j.GraphDatabase.driver(uri, auth=(user, password))

    # A synthetic-namespaced org_id that was never seeded in this test run.
    unseeded_org_id = "99999999-9999-9999-9999-999999999999"
    cleanup_org_data(driver, unseeded_org_id)  # guarantee it's truly empty

    reader = InMemoryMetricReader()
    provider = MeterProvider(metric_readers=[reader], views=_graph_views(), shutdown_on_exit=False)
    metrics.set_meter_provider(provider)
    graph_metrics.reset_instruments_cache()

    try:
        # Direct (unwrapped) calls never raise over an empty result set.
        assert _viewport_read(driver, unseeded_org_id) == 0
        assert _traversal(driver, unseeded_org_id) == 0

        async def _drive() -> None:
            async with graph_metrics.instrument_graph_query(
                unseeded_org_id, graph_metrics.QUERY_SHAPE_VIEWPORT_READ
            ) as m:
                m.set_result_node_count(_viewport_read(driver, unseeded_org_id))
            async with graph_metrics.instrument_graph_query(
                unseeded_org_id, graph_metrics.QUERY_SHAPE_TRAVERSAL
            ) as m:
                m.set_result_node_count(_traversal(driver, unseeded_org_id))

        _asyncio.run(_drive())

        data = reader.get_metrics_data()
        # _histogram_by_org keys by org_id only, which would collapse the two
        # (same org_id, different query_shape) data points into one -- index
        # by the full attribute set instead so both shapes' samples are visible.
        metric = _metric(data, graph_metrics.RESULT_NODE_COUNT_METRIC_NAME)
        data_points = [
            dp for dp in metric.data.data_points if dp.attributes["org_id"] == unseeded_org_id
        ]
        assert len(data_points) == 2  # one series per query_shape
        assert {dp.attributes["query_shape"] for dp in data_points} == {
            graph_metrics.QUERY_SHAPE_VIEWPORT_READ,
            graph_metrics.QUERY_SHAPE_TRAVERSAL,
        }
        assert all(dp.count == 1 for dp in data_points)  # both calls recorded, not skipped
        assert all(dp.sum == 0 for dp in data_points)  # both were genuinely zero
    finally:
        provider.shutdown()
        cleanup_org_data(driver, unseeded_org_id)
        driver.close()
