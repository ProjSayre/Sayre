"""The three mandated graph-store metrics + the sole sanctioned wrapper (W0-08).

Mirrors `telemetry/vector_metrics.py` exactly: exporter-agnostic (imports only the
`opentelemetry` API, never `opentelemetry.sdk`, never a concrete exporter/backend),
and works whether or not `otel.init_metrics()` has run yet -- instruments are
created lazily from whatever the *current* global MeterProvider is at first use, so
import order relative to `init_metrics()` never matters and metrics are never
silently dropped to a no-op meter.

No real Graph Query Service call site exists yet (W2-02; see
`.pipeline/spec.md` Scope/Out). This module is the enforced convention: every
future Neo4j driver call -- viewport read, write, or traversal -- routes through
`instrument_graph_query()`, exactly like `instrument_vector_query()` is the
enforced convention for pgvector ahead of a real call site.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from opentelemetry import metrics
from opentelemetry.metrics import Histogram, MeterProvider, UpDownCounter

DURATION_METRIC_NAME = "graph_query_duration_ms"
CONCURRENT_METRIC_NAME = "graph_query_concurrent_count"
RESULT_NODE_COUNT_METRIC_NAME = "graph_query_result_node_count"

ORG_ID_ATTR = "org_id"
QUERY_SHAPE_ATTR = "query_shape"

QUERY_SHAPE_VIEWPORT_READ = "viewport_read"
QUERY_SHAPE_WRITE = "write"
QUERY_SHAPE_TRAVERSAL = "traversal"
GRAPH_QUERY_SHAPES: frozenset[str] = frozenset(
    {QUERY_SHAPE_VIEWPORT_READ, QUERY_SHAPE_WRITE, QUERY_SHAPE_TRAVERSAL}
)

_METER_NAME = "sayre_workers.telemetry.graph_metrics"

# Cache is keyed on the *current* global MeterProvider object (identity, not
# just its existence) so that a test which installs a fresh provider gets
# fresh instruments bound to it, per reset_instruments_cache() below. Mirrors
# vector_metrics.py exactly.
_cached_provider: MeterProvider | None = None
_cached_instruments: tuple[Histogram, UpDownCounter, Histogram] | None = None


def _get_instruments() -> tuple[Histogram, UpDownCounter, Histogram]:
    """Lazily create + cache (duration_histogram, concurrent_updown_counter,
    result_node_count_histogram) from the CURRENT global meter provider. Lazy
    creation guarantees they bind to whatever provider init_metrics() (or a
    test) installed, regardless of import order. Cache is keyed on the current
    provider object so a test that swaps the provider gets fresh instruments.
    Created with NO unit set (an explicit unit gets suffixed onto the exported
    Prometheus series name and would break the exact names the acceptance
    criteria require -- same gotcha as vector_metrics)."""
    global _cached_provider, _cached_instruments

    provider = metrics.get_meter_provider()
    if _cached_instruments is None or _cached_provider is not provider:
        meter = provider.get_meter(_METER_NAME)
        duration_histogram = meter.create_histogram(DURATION_METRIC_NAME)
        concurrent_counter = meter.create_up_down_counter(CONCURRENT_METRIC_NAME)
        result_node_count_histogram = meter.create_histogram(RESULT_NODE_COUNT_METRIC_NAME)
        _cached_instruments = (duration_histogram, concurrent_counter, result_node_count_histogram)
        _cached_provider = provider

    return _cached_instruments


class GraphQueryMeasurement:
    """Handle yielded by instrument_graph_query so the caller can report the query's
    result node count (which the wrapper cannot know on its own). Duration and
    concurrency are measured automatically; result node count must be reported by
    the caller via set_result_node_count()."""

    def __init__(self) -> None:
        self._result_node_count: int | None = None

    def set_result_node_count(self, count: int) -> None:
        """Record how many nodes this query returned/created. Raises ValueError on a
        negative count (a bug). Last call wins if invoked more than once."""
        if count < 0:
            raise ValueError(
                f"set_result_node_count() requires a non-negative count, got {count!r}"
            )
        self._result_node_count = count


@asynccontextmanager
async def instrument_graph_query(org_id: str, query_shape: str) -> AsyncIterator[GraphQueryMeasurement]:
    """Wrap exactly one Neo4j query.

    org_id MUST be the server-derived tenant id already used to scope the query
    (per-tenant namespace / RLS per PRD 4.5) -- NEVER a client-supplied field.
    Raises ValueError if org_id is falsy/whitespace (missing tenant context is a
    bug, not an 'unknown'-labelled metric).

    query_shape MUST be one of GRAPH_QUERY_SHAPES (viewport_read | write |
    traversal). Raises ValueError otherwise -- a strict enum, same strictness as
    org_id: an unknown shape is a caller bug, never a free-form label that
    fragments the dashboard.

    Both validations happen BEFORE any instrument is touched, so an invalid call
    emits nothing at all.

    Behavior:
      - attrs = {"org_id": org_id, "query_shape": query_shape}
      - concurrent.add(+1, attrs) on entry
      - yields a fresh GraphQueryMeasurement
      - in a `finally` (success OR failure):
          * duration_ms is ALWAYS recorded -- a failed query still consumed
            graph capacity / counts as load
          * result_node_count is recorded ONLY if the caller reported one via
            set_result_node_count() -- unset (e.g. the query raised before
            reporting, or a shape that produced no count) means DO NOT record,
            so failures/no-ops don't pollute the size distribution with
            spurious zeros
          * concurrent.add(-1, attrs) in the same `finally` so a raising query
            cannot leak the gauge
      - re-raises any exception unchanged
    """
    if not org_id or not org_id.strip():
        raise ValueError(
            "instrument_graph_query() requires a non-empty, server-derived org_id "
            "(missing tenant context is a bug -- refusing to emit a blank/'unknown'-labelled metric)"
        )
    if query_shape not in GRAPH_QUERY_SHAPES:
        raise ValueError(
            f"instrument_graph_query() requires query_shape to be one of "
            f"{sorted(GRAPH_QUERY_SHAPES)!r}, got {query_shape!r} (an unknown shape is a "
            "caller bug, not a free-form label)"
        )

    duration_histogram, concurrent, result_node_count_histogram = _get_instruments()
    attrs = {ORG_ID_ATTR: org_id, QUERY_SHAPE_ATTR: query_shape}

    concurrent.add(1, attrs)
    start = time.perf_counter()
    measurement = GraphQueryMeasurement()
    try:
        yield measurement
    finally:
        duration_ms = (time.perf_counter() - start) * 1000.0
        duration_histogram.record(duration_ms, attrs)
        if measurement._result_node_count is not None:
            result_node_count_histogram.record(measurement._result_node_count, attrs)
        concurrent.add(-1, attrs)


def reset_instruments_cache() -> None:
    """Test hook -- clears the cached instruments so a fresh provider takes
    effect on the next _get_instruments() call. Mirrors
    vector_metrics.reset_instruments_cache()."""
    global _cached_provider, _cached_instruments
    _cached_provider = None
    _cached_instruments = None
