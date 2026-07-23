"""Priority-lane onboarding message validation, completion, and TTFC recording."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from threading import Event

from pydantic import BaseModel, ConfigDict, Field

from messaging.envelope import MessageEnvelope
from messaging.idempotency import DeliveryStore
from messaging.sqs_client import consume_enrichment
from sayre_workers.telemetry.onboarding_metrics import record_onboarding_ready
from .models import EnrichmentResult


class InvalidOnboardingJobError(ValueError):
    """The trusted priority-lane envelope does not contain a valid job."""


class _OnboardingPayload(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    repository_id: str = Field(min_length=1)
    ref_name: str = Field(min_length=1)
    revision_sha: str = Field(min_length=40, max_length=64, pattern=r"^[0-9a-fA-F]+$")
    cold_start_started_at_ms: int = Field(ge=0, strict=True)


@dataclass(frozen=True)
class OnboardingGenerateJob:
    org_id: str
    repository_id: str
    ref_name: str
    revision_sha: str
    graph_scope_key: str
    graph_version: int
    cold_start_started_at_ms: int
    trace_id: str | None


def parse_onboarding_generate(envelope: MessageEnvelope) -> OnboardingGenerateJob:
    """Parse a priority message using tenant identity only from its envelope."""
    if envelope.type != "onboarding.generate":
        raise InvalidOnboardingJobError("unsupported enrichment message type")
    if envelope.graph_scope_key is None or envelope.graph_version is None:
        raise InvalidOnboardingJobError("onboarding.generate requires graph scope metadata")
    try:
        payload = _OnboardingPayload.model_validate(envelope.payload)
    except ValueError as error:
        raise InvalidOnboardingJobError("invalid onboarding.generate payload") from error
    return OnboardingGenerateJob(
        org_id=envelope.org_id,
        repository_id=payload.repository_id,
        ref_name=payload.ref_name,
        revision_sha=payload.revision_sha.lower(),
        graph_scope_key=envelope.graph_scope_key,
        graph_version=envelope.graph_version,
        cold_start_started_at_ms=payload.cold_start_started_at_ms,
        trace_id=envelope.trace_id,
    )


class OnboardingPriorityHandler:
    """Run onboarding generation and emit readiness only after it succeeds."""

    def __init__(
        self,
        generator: Callable[[OnboardingGenerateJob], EnrichmentResult | None],
        *,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self._generator = generator
        self._clock_ms = clock_ms or (lambda: time.time_ns() // 1_000_000)

    def __call__(self, envelope: MessageEnvelope) -> None:
        job = parse_onboarding_generate(envelope)
        result = self._generator(job)
        if result is not None and result.status == "degraded":
            return
        duration_ms = float(max(0, self._clock_ms() - job.cold_start_started_at_ms))
        record_onboarding_ready(job.org_id, job.repository_id, duration_ms)


def run_onboarding_priority_consumer(
    generator: Callable[[OnboardingGenerateJob], EnrichmentResult | None],
    *,
    delivery_store: DeliveryStore,
    consumer_id: str = "onboarding-priority",
    stop_event: Event | None = None,
    visibility_timeout_seconds: int = 30,
) -> None:
    """Reserve priority-only capacity on W0-04's existing enrichment lane."""
    try:
        consume_enrichment(
            OnboardingPriorityHandler(generator),
            consumer_id=consumer_id,
            mode="priority_only",
            delivery_store=delivery_store,
            stop_event=stop_event,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )
    finally:
        close = getattr(generator, "close", None)
        if callable(close):
            close()
