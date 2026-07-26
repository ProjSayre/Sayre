"""Ad-hoc local runner for the ingestion consumer -- manual testing only.

Mirrors run_ingestion_consumer's internal asyncio.Runner usage, but builds
the real service INSIDE that same runner/loop (build_ingestion_service()
constructs loop-bound async resources -- Neo4j driver, Postgres pool -- that
must not be created in one event loop and used from another).

Usage (from services/workers/, with infra/.env sourced into the environment):
    poetry run python scripts/run_local_ingestion_consumer.py
"""

from __future__ import annotations

import sys

sys.path.insert(0, ".")

from messaging.idempotency import SqliteDeliveryStore
from messaging.sqs_client import INGESTION_QUEUE, consume, initialize_client
from sayre_workers.ingestion.consumers import _loop_factory
from sayre_workers.ingestion.runtime import build_ingestion_service

import asyncio


def main() -> None:
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        runner.run(initialize_client())
        service = runner.run(build_ingestion_service())
        delivery_store = SqliteDeliveryStore("/tmp/sayre-ingestion-delivery-store.sqlite")

        def handle(envelope):
            runner.run(service.handle(envelope))

        try:
            print("[ingestion-consumer] draining", INGESTION_QUEUE, flush=True)
            consume(
                INGESTION_QUEUE,
                handle,
                consumer_id="ingestion-worker-local",
                delivery_store=delivery_store,
                visibility_timeout_seconds=300,
            )
        finally:
            runner.run(service.aclose())


if __name__ == "__main__":
    main()
