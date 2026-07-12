"""OpenTelemetry metrics bootstrap + instruments for the Python worker fleet.

`otel.py` is the only module in this package (or anywhere in the fleet) that
names a concrete exporter/backend. Everything else — including
`vector_metrics.py` and any future call site — imports only the vendor-neutral
`opentelemetry` API, so swapping the exporter (Prometheus today; Datadog,
CloudWatch, or a vendor OTLP collector in prod) never requires touching a
call site. See `otel.init_metrics` docstring for the swap point.
"""
