"""OpenTelemetry MeterProvider bootstrap for the Python worker fleet.

This is the **only** module in the codebase that names a concrete metrics
exporter/backend (Prometheus today; Datadog/CloudWatch/OTLP-collector in
prod). Every other module — `vector_metrics.py`, the synthetic-load CLI, and
every future pgvector call site — imports only the vendor-neutral
`opentelemetry` API and never references `prometheus_client`, `Prometheus`,
`Datadog`, `CloudWatch`, or `OTLP` directly. Swapping the exporter for prod is
a one-line addition here (see the `otlp` branch below) with **zero changes to
any call site**.

`VECTOR_QUERY_DURATION_BUCKETS_MS` picks explicit histogram bucket boundaries
tuned for vector-query latency (single-digit to low-thousands of ms) so that
`histogram_quantile(0.95/0.99, rate(vector_query_duration_ms_bucket[...]))` is
meaningful. The OTel SDK's default buckets are tuned for generic
sub-millisecond-to-multi-second RPC latency and are too coarse in the
0-100ms band that matters for the pgvector -> OpenSearch migration trigger's
p95/p99 requirement (see `docs/migration-triggers.md` and
`.pipeline/W0-06/spec.md` Acceptance #8).

`GRAPH_QUERY_DURATION_BUCKETS_MS` / `GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS`
(W0-08) add the same explicit-bucket treatment for the two Neo4j graph-store
histograms, registered as additional `View`s on this SAME shared provider —
see `_views()` below. No second `MeterProvider`, no second `/metrics` server.
"""

from __future__ import annotations

import os
import threading

from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.view import ExplicitBucketHistogramAggregation, View
from opentelemetry.sdk.resources import Resource

VECTOR_QUERY_DURATION_BUCKETS_MS: list[float] = [
    1,
    2,
    5,
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    2500,
    5000,
]  # ms — chosen so histogram_quantile(0.95/0.99, ...) is meaningful for vector queries.
   # Default OTel buckets are too coarse for the trigger's p95/p99 requirement.

# Cypher latency spans a wider useful band than pgvector similarity search: point
# reads/writes are single-digit ms, but multi-hop traversals under concurrent load can
# reach seconds. Boundaries are dense around the 300 ms Neo4j->Neptune p95 trigger and
# extend to 10 s so heavy traversals still land in a finite bucket (not just +Inf).
GRAPH_QUERY_DURATION_BUCKETS_MS: list[float] = [
    1,
    5,
    10,
    25,
    50,
    100,
    150,
    200,
    250,
    300,
    400,
    500,
    750,
    1000,
    2500,
    5000,
    10000,
]

# Result-set node counts: viewport reads are canvas-bounded (Folder/File only), writes
# are small, traversals can fan out. Distribution buckets, not latency.
GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS: list[float] = [
    0,
    1,
    5,
    10,
    25,
    50,
    100,
    250,
    500,
    1000,
    5000,
]

_DURATION_INSTRUMENT_NAME = "vector_query_duration_ms"
_GRAPH_DURATION_INSTRUMENT_NAME = "graph_query_duration_ms"
_GRAPH_RESULT_NODE_COUNT_INSTRUMENT_NAME = "graph_query_result_node_count"
_SERVICE_NAME = "sayre-workers"

# Supported exporters. 'otlp' is intentionally reserved (not implemented) as
# the documented prod/vendor extension point -- see the comment in the otlp
# branch below for the one-line addition that wires it up.
_VALID_EXPORTERS = ("prometheus", "console", "none")

_lock = threading.Lock()
_provider: MeterProvider | None = None


def _duration_view() -> View:
    """Forces VECTOR_QUERY_DURATION_BUCKETS_MS onto the vector_query_duration_ms
    histogram regardless of exporter."""
    return View(
        instrument_name=_DURATION_INSTRUMENT_NAME,
        aggregation=ExplicitBucketHistogramAggregation(VECTOR_QUERY_DURATION_BUCKETS_MS),
    )


def _graph_duration_view() -> View:
    """Forces GRAPH_QUERY_DURATION_BUCKETS_MS onto the graph_query_duration_ms
    histogram regardless of exporter (W0-08)."""
    return View(
        instrument_name=_GRAPH_DURATION_INSTRUMENT_NAME,
        aggregation=ExplicitBucketHistogramAggregation(GRAPH_QUERY_DURATION_BUCKETS_MS),
    )


def _graph_result_node_count_view() -> View:
    """Forces GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS onto the
    graph_query_result_node_count histogram regardless of exporter (W0-08)."""
    return View(
        instrument_name=_GRAPH_RESULT_NODE_COUNT_INSTRUMENT_NAME,
        aggregation=ExplicitBucketHistogramAggregation(GRAPH_QUERY_RESULT_NODE_COUNT_BUCKETS),
    )


def _views() -> list[View]:
    """All explicit-bucket histogram Views registered on the single shared
    provider built in init_metrics(). Adding a new bucketed histogram means
    adding one View here -- never a second MeterProvider."""
    return [_duration_view(), _graph_duration_view(), _graph_result_node_count_view()]


def init_metrics(
    *,
    exporter: str | None = None,
    metrics_port: int | None = None,
    metrics_addr: str | None = None,
) -> MeterProvider:
    """Idempotent. Builds a MeterProvider whose only View forces
    VECTOR_QUERY_DURATION_BUCKETS_MS onto instrument name
    'vector_query_duration_ms', sets it as the global provider, and (for
    exporter='prometheus') registers a PrometheusMetricReader and starts
    prometheus_client.start_http_server(port, addr).

    Supported exporters: 'prometheus' (default), 'console', 'none'. An
    unknown value raises ValueError listing valid options. 'otlp' is
    reserved as the documented prod/vendor extension point (add a
    PeriodicExportingMetricReader(OTLPMetricExporter) here -- no call-site
    change).

    Idempotent: the first call wins. A second call (any arguments) is a
    no-op that returns the already-installed provider -- no second HTTP
    server bind, no "Overriding of current MeterProvider" warning.
    """
    global _provider

    with _lock:
        if _provider is not None:
            return _provider

        resolved_exporter = exporter or os.environ.get("OTEL_METRICS_EXPORTER") or "prometheus"
        resolved_port = (
            metrics_port
            if metrics_port is not None
            else int(os.environ.get("METRICS_PORT", "9464"))
        )
        resolved_addr = metrics_addr or os.environ.get("METRICS_ADDR") or "0.0.0.0"

        if resolved_exporter not in _VALID_EXPORTERS:
            raise ValueError(
                f"Unknown OTEL_METRICS_EXPORTER {resolved_exporter!r}; valid exporters are: "
                f"{', '.join(_VALID_EXPORTERS)} ('otlp' is a reserved, documented "
                "prod/vendor extension point -- see sayre_workers/telemetry/otel.py)."
            )

        readers = []
        if resolved_exporter == "prometheus":
            # The only place PrometheusMetricReader / prometheus_client is imported.
            from opentelemetry.exporter.prometheus import PrometheusMetricReader
            from prometheus_client import start_http_server

            readers.append(PrometheusMetricReader())
            start_http_server(resolved_port, resolved_addr)
        elif resolved_exporter == "console":
            from opentelemetry.sdk.metrics.export import (
                ConsoleMetricExporter,
                PeriodicExportingMetricReader,
            )

            readers.append(PeriodicExportingMetricReader(ConsoleMetricExporter()))
        # exporter == "none": no reader is registered. The provider still
        # exists and instruments still record into it (so lazy binding in
        # vector_metrics.py never silently no-ops), but nothing is exported.
        #
        # Prod/vendor extension point -- zero changes to any call site:
        # elif resolved_exporter == "otlp":
        #     from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
        #         OTLPMetricExporter,
        #     )
        #     readers.append(PeriodicExportingMetricReader(OTLPMetricExporter()))

        resource = Resource.create({"service.name": _SERVICE_NAME})
        provider = MeterProvider(
            resource=resource,
            metric_readers=readers,
            views=_views(),
        )
        metrics.set_meter_provider(provider)

        _provider = provider
        return provider


def shutdown_metrics() -> None:
    """Flush + shutdown the provider (clean teardown for tests / CLI)."""
    global _provider

    with _lock:
        if _provider is None:
            return
        _provider.force_flush()
        _provider.shutdown()
        _provider = None
