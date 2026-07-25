"""SQS consumer wiring over the W0-04 durable-delivery primitive."""

from __future__ import annotations

import asyncio
import sys
import threading

from messaging.idempotency import DeliveryStore
from messaging.envelope import MessageEnvelope
from messaging.sqs_client import EMBEDDING_UPSERTS_QUEUE, INGESTION_QUEUE, consume

from .embeddings import EmbeddingConsumer
from .service import IngestionService


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows. Linux uses
    # the platform default selector loop already.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def run_ingestion_consumer(
    service: IngestionService,
    delivery_store: DeliveryStore,
    *,
    stop_event: threading.Event | None = None,
) -> None:
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        def handle(envelope: MessageEnvelope) -> None:
            runner.run(service.handle(envelope))

        try:
            consume(
                INGESTION_QUEUE,
                handle,
                consumer_id="ingestion-worker",
                delivery_store=delivery_store,
                stop_event=stop_event,
                visibility_timeout_seconds=300,
            )
        finally:
            runner.run(service.aclose())


def run_embedding_consumer(
    consumer: EmbeddingConsumer,
    delivery_store: DeliveryStore,
    *,
    stop_event: threading.Event | None = None,
) -> None:
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        def handle(envelope: MessageEnvelope) -> None:
            runner.run(consumer.handle(envelope))

        consume(
            EMBEDDING_UPSERTS_QUEUE,
            handle,
            consumer_id="embedding-worker",
            delivery_store=delivery_store,
            stop_event=stop_event,
            visibility_timeout_seconds=120,
        )
