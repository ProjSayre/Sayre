"""SQS consumer wiring over the W0-04 durable-delivery primitive for the
chat-turn worker. Structurally the same as
`sayre_workers.enrichment.consumers.run_enrichment_consumer` /
`run_embedding_consumer`, so this worker inherits the fleet's DLQ posture,
visibility heartbeat, and durable claim without reimplementing any of them.
"""

from __future__ import annotations

import asyncio
import sys
import threading

from messaging.envelope import MessageEnvelope
from messaging.idempotency import DeliveryStore
from messaging.sqs_client import CHAT_TURNS_QUEUE, consume

from .service import ChatTurnService


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows. Linux
    # uses the platform default selector loop already.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def run_chat_turn_consumer(
    service: ChatTurnService,
    delivery_store: DeliveryStore,
    *,
    stop_event: threading.Event | None = None,
    visibility_timeout_seconds: int = 120,
) -> None:
    """consume(CHAT_TURNS_QUEUE, handle, consumer_id="chat-turn-worker",
    delivery_store=..., ...) inside an asyncio.Runner -- byte-for-byte the
    run_enrichment_consumer / run_embedding_consumer shape."""
    with asyncio.Runner(loop_factory=_loop_factory) as runner:

        def handle(envelope: MessageEnvelope) -> None:
            runner.run(service.handle(envelope))

        try:
            consume(
                CHAT_TURNS_QUEUE,
                handle,
                consumer_id="chat-turn-worker",
                delivery_store=delivery_store,
                stop_event=stop_event,
                visibility_timeout_seconds=visibility_timeout_seconds,
            )
        finally:
            runner.run(service.aclose())


__all__ = ["run_chat_turn_consumer"]
