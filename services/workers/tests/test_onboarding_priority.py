"""W2-08 cold-start routing, priority ordering, and TTFC metric coverage."""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterator

import opentelemetry.metrics._internal as _otel_metrics_internal
import pytest
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.util._once import Once

from messaging.envelope import MessageEnvelope
from messaging import sqs_client
from messaging.sqs_client import ENRICHMENT_DEFAULT_QUEUE, ENRICHMENT_PRIORITY_QUEUE
from sayre_workers.enrichment.onboarding import OnboardingPriorityHandler
from sayre_workers.ingestion import events as ingestion_events
from sayre_workers.ingestion.events import MessagingPublisher, graph_scope_key
from sayre_workers.ingestion.models import GraphScope
from sayre_workers.telemetry import onboarding_metrics
from sayre_workers.telemetry import otel as otel_module

SHA_A = "a" * 40
SHA_B = "b" * 40


@pytest.fixture(autouse=True)
def _reset_otel_globals(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER", None)
    monkeypatch.setattr(_otel_metrics_internal, "_METER_PROVIDER_SET_ONCE", Once())
    monkeypatch.setattr(otel_module, "_provider", None)
    onboarding_metrics.reset_instruments_cache()
    yield
    otel_module.shutdown_metrics()
    onboarding_metrics.reset_instruments_cache()


def _install_metrics_backend() -> InMemoryMetricReader:
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader], shutdown_on_exit=False))
    return reader


def _onboarding_envelope(
    *, revision_sha: str = SHA_A, started_at_ms: int = 1_000
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id="org-server-resolved",
        type="onboarding.generate",
        source="ingestion-worker",
        idempotency_key=f"onboarding:{revision_sha}",
        graph_scope_key="scope-key",
        graph_version=7,
        payload={
            "repository_id": "repo-server-resolved",
            "ref_name": "refs/heads/main",
            "revision_sha": revision_sha,
            "cold_start_started_at_ms": started_at_ms,
        },
    )


def _metric(reader: InMemoryMetricReader):
    data = reader.get_metrics_data()
    assert data is not None
    for resource_metrics in data.resource_metrics:
        for scope_metrics in resource_metrics.scope_metrics:
            for metric in scope_metrics.metrics:
                if metric.name == onboarding_metrics.TTFC_METRIC_NAME:
                    return metric
    raise AssertionError("TTFC metric was not exported")


@pytest.mark.asyncio
async def test_cold_start_publisher_uses_existing_priority_lane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    published: list[tuple[str, MessageEnvelope]] = []
    monkeypatch.setattr(
        ingestion_events,
        "publish",
        lambda queue, envelope: published.append((queue, envelope)),
    )
    scope = GraphScope(
        org_id="org-server-resolved",
        repository_id="repo-server-resolved",
        ref_name="refs/heads/main",
        revision_sha=SHA_A,
    )

    await MessagingPublisher().onboarding_generate(
        scope=scope,
        graph_version=7,
        cold_start_started_at_ms=123,
        trace_id="trace-1",
    )

    [(queue, envelope)] = published
    assert queue == ENRICHMENT_PRIORITY_QUEUE
    assert envelope.type == "onboarding.generate"
    assert envelope.org_id == scope.org_id
    assert envelope.graph_scope_key == graph_scope_key(scope)
    assert envelope.graph_version == 7
    assert envelope.payload["repository_id"] == scope.repository_id
    assert "org_id" not in envelope.payload


def test_ttfc_metric_is_exported_for_every_successful_cold_start(
    caplog: pytest.LogCaptureFixture,
) -> None:
    reader = _install_metrics_backend()
    generated: list[str] = []
    clock_values = iter((1_500, 2_800))
    handler = OnboardingPriorityHandler(
        lambda job: generated.append(job.revision_sha),
        clock_ms=lambda: next(clock_values),
    )

    with caplog.at_level(logging.INFO, logger=onboarding_metrics.__name__):
        handler(_onboarding_envelope(revision_sha=SHA_A, started_at_ms=1_000))
        handler(_onboarding_envelope(revision_sha=SHA_B, started_at_ms=2_000))

    assert generated == [SHA_A, SHA_B]
    [point] = list(_metric(reader).data.data_points)
    assert point.count == 2
    assert point.sum == 1_300
    assert point.attributes == {
        "org_id": "org-server-resolved",
        "repo_id": "repo-server-resolved",
    }
    assert caplog.text.count(onboarding_metrics.TTFC_METRIC_NAME) == 2


def test_failed_generation_does_not_emit_a_false_ready_metric() -> None:
    reader = _install_metrics_backend()

    def fail(_job) -> None:
        raise RuntimeError("generation failed")

    with pytest.raises(RuntimeError, match="generation failed"):
        OnboardingPriorityHandler(fail, clock_ms=lambda: 1_500)(_onboarding_envelope())

    assert reader.get_metrics_data() is None


def test_weighted_polling_reaches_onboarding_ready_before_default_enrichment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_metrics_backend()
    stop = threading.Event()
    events: list[str] = []
    priority = _onboarding_envelope()
    default = MessageEnvelope(
        org_id="org-server-resolved",
        type="feature.cluster",
        source="test",
        idempotency_key="feature-default",
        payload={"repository_id": "repo-server-resolved"},
    )
    messages = {
        ENRICHMENT_PRIORITY_QUEUE: [priority],
        ENRICHMENT_DEFAULT_QUEUE: [default],
    }
    onboarding = OnboardingPriorityHandler(
        lambda _job: events.append("onboarding-ready"),
        clock_ms=lambda: 1_500,
    )

    def dispatch(envelope: MessageEnvelope) -> None:
        if envelope.type == "onboarding.generate":
            onboarding(envelope)
        else:
            events.append("feature-enrichment-complete")
            stop.set()

    def consume_once(queue_name: str, handler, **_kwargs) -> int:
        queued = messages[queue_name]
        if not queued:
            return 0
        handler(queued.pop(0))
        return 1

    monkeypatch.setattr(sqs_client, "consume_once", consume_once)
    sqs_client.consume_enrichment(
        dispatch,
        consumer_id="enrichment",
        delivery_store=object(),  # consume_once is replaced; no claim is made.
        stop_event=stop,
        priority_weight=1,
    )

    assert events == ["onboarding-ready", "feature-enrichment-complete"]
