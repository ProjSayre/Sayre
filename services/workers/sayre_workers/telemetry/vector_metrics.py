"""The two mandated vector-store metrics + the sole sanctioned execution path.

Exporter-agnostic: this module imports only the `opentelemetry` API (never
`opentelemetry.sdk`, never a concrete exporter/backend). It works whether or
not `otel.init_metrics()` has run yet -- instruments are created lazily from
whatever the *current* global MeterProvider is at first use, so import order
relative to `init_metrics()` never matters and metrics are never silently
dropped to a no-op meter.

Every sanctioned operation that reads or writes the pgvector-backed
``code_embeddings`` store routes through ``execute_vector_query()``. The
lower-level context manager remains public for non-connection test harnesses,
but application call sites use the execution helper so metrics cannot be
separated accidentally from the database operation they describe.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from typing import Any, Protocol

from opentelemetry import metrics
from opentelemetry.metrics import Histogram, MeterProvider, UpDownCounter

DURATION_METRIC_NAME = "vector_query_duration_ms"
CONCURRENT_METRIC_NAME = "vector_query_concurrent_count"
ORG_ID_ATTR = "org_id"

_METER_NAME = "sayre_workers.telemetry.vector_metrics"

# Cache is keyed on the *current* global MeterProvider object (identity, not
# just its existence) so that a test which installs a fresh provider gets
# fresh instruments bound to it, per reset_instruments_cache() below.
_cached_provider: MeterProvider | None = None
_cached_instruments: tuple[Histogram, UpDownCounter] | None = None


class VectorQueryConnection(Protocol):
    async def execute(
        self,
        query: str,
        params: Sequence[Any] | Mapping[str, Any] | None = None,
    ) -> Any: ...


def _get_instruments() -> tuple[Histogram, UpDownCounter]:
    """Lazily create + cache the histogram and up/down counter from the
    CURRENT global meter provider. Lazy creation guarantees they bind to
    whatever provider init_metrics() (or a test) installed, regardless of
    import order. Cache is keyed on the current provider object so a test
    that swaps the provider gets fresh instruments. Created with NO unit set
    (see naming gotcha in otel.py / spec: an explicit unit gets suffixed onto
    the exported Prometheus series name, which would break the exact names
    Acceptance #4 requires)."""
    global _cached_provider, _cached_instruments

    provider = metrics.get_meter_provider()
    if _cached_instruments is None or _cached_provider is not provider:
        meter = provider.get_meter(_METER_NAME)
        histogram = meter.create_histogram(DURATION_METRIC_NAME)
        counter = meter.create_up_down_counter(CONCURRENT_METRIC_NAME)
        _cached_instruments = (histogram, counter)
        _cached_provider = provider

    return _cached_instruments


@asynccontextmanager
async def instrument_vector_query(org_id: str) -> AsyncIterator[None]:
    """Measure exactly one pgvector-backed database operation.

    org_id MUST be the server-derived tenant id already used to scope the
    query (per-tenant namespace / RLS per PRD 4.5) -- NEVER a client-supplied
    field. Raises ValueError if org_id is falsy (missing tenant context is a
    bug, not an 'unknown'-labelled metric).

    Behavior:
      - attrs = {"org_id": org_id}
      - concurrent.add(+1, attrs) on entry
      - record duration_ms in a `finally` (success OR failure -- a failed
        query still consumed vector-store capacity and counts toward load)
      - concurrent.add(-1, attrs) in the same `finally` so a raising query
        cannot leak the gauge
      - re-raise any exception unchanged
    """
    if not org_id or not org_id.strip():
        raise ValueError(
            "instrument_vector_query() requires a non-empty, server-derived org_id "
            "(missing tenant context is a bug -- refusing to emit a blank/'unknown'-labelled metric)"
        )

    histogram, concurrent = _get_instruments()
    attrs = {ORG_ID_ATTR: org_id}

    concurrent.add(1, attrs)
    start = time.perf_counter()
    try:
        yield
    finally:
        duration_ms = (time.perf_counter() - start) * 1000.0
        histogram.record(duration_ms, attrs)
        concurrent.add(-1, attrs)


async def execute_vector_query(
    connection: VectorQueryConnection,
    *,
    org_id: str,
    query: str,
    params: Sequence[Any] | Mapping[str, Any] | None = None,
) -> Any:
    """Execute one sanctioned vector-store operation with mandatory metrics.

    ``org_id`` is the same server-derived tenant identifier already installed
    on ``connection`` by the RLS boundary. SQL and parameters stay separate;
    the returned cursor is intentionally untouched so callers retain normal
    psycopg fetch semantics.
    """
    async with instrument_vector_query(org_id):
        if params is None:
            return await connection.execute(query)
        return await connection.execute(query, params)


def reset_instruments_cache() -> None:
    """Test hook -- clears the cached instruments so a fresh provider takes
    effect on the next _get_instruments() call."""
    global _cached_provider, _cached_instruments
    _cached_provider = None
    _cached_instruments = None
