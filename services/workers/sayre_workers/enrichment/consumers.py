"""SQS consumer wiring over the W0-04 durable-delivery primitive.

Consumes ONLY the default enrichment lane, via plain `consume(ENRICHMENT_DEFAULT_QUEUE,
...)` (D6, supersedes the earlier `consume_enrichment(mode="weighted")` wiring). The
priority lane is exclusively W2-08's `run_onboarding_priority_consumer` -- a separate
consumer loop/process, with this ticket's `onboarding_bridge.build_onboarding_generator`
plugged in as its `generator`. This worker never touches `INGESTION_QUEUE` or the
priority queue. Mirrors `sayre_workers.ingestion.consumers`.
"""

from __future__ import annotations

import asyncio
import sys
import threading

from messaging.envelope import MessageEnvelope
from messaging.idempotency import DeliveryStore
from messaging.sqs_client import ENRICHMENT_DEFAULT_QUEUE, consume

from .service import EnrichmentService


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows. Linux uses
    # the platform default selector loop already.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def run_enrichment_consumer(
    service: EnrichmentService,
    delivery_store: DeliveryStore,
    *,
    stop_event: threading.Event | None = None,
    visibility_timeout_seconds: int = 120,
) -> None:
    """Drive plain consume(ENRICHMENT_DEFAULT_QUEUE, ...) with an asyncio.Runner-wrapped
    sync handler (mirror run_embedding_consumer). consumer_id is the fixed string
    'enrichment-worker'. Default-lane only (D6) -- the priority lane is exclusively
    W2-08's run_onboarding_priority_consumer, with this ticket's onboarding_bridge
    plugged in as its generator."""
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        def handle(envelope: MessageEnvelope) -> None:
            runner.run(service.handle(envelope))

        consume(
            ENRICHMENT_DEFAULT_QUEUE,
            handle,
            consumer_id="enrichment-worker",
            delivery_store=delivery_store,
            stop_event=stop_event,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )
