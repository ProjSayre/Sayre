"""SQS consumer wiring over the W0-04 durable-delivery primitive.

Consumes ONLY the two enrichment lanes via `consume_enrichment` -- no new queue,
topic, subscription, or DLQ (W0-04 already provisions all of them), and this worker
never touches `INGESTION_QUEUE`. Mirrors `sayre_workers.ingestion.consumers`.
"""

from __future__ import annotations

import asyncio
import sys
import threading
from typing import Literal

from messaging.envelope import MessageEnvelope
from messaging.idempotency import DeliveryStore
from messaging.sqs_client import consume_enrichment

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
    mode: Literal["priority_only", "weighted"] = "weighted",
    priority_weight: int = 3,
    visibility_timeout_seconds: int = 120,
) -> None:
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        def handle(envelope: MessageEnvelope) -> None:
            runner.run(service.handle(envelope))

        consume_enrichment(
            handle,
            consumer_id="enrichment-worker",
            mode=mode,
            priority_weight=priority_weight,
            delivery_store=delivery_store,
            stop_event=stop_event,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )
