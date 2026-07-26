"""Ad-hoc local runner for the default-lane enrichment consumer -- manual testing only.

Mirrors run_local_ingestion_consumer.py's pattern: build_enrichment_service()
constructs loop-bound async resources, so it must run INSIDE the same
asyncio.Runner that will later process messages.

Usage (from services/workers/, with infra/.env sourced into the environment):
    poetry run python scripts/run_local_enrichment_consumer.py
"""

from __future__ import annotations

import sys

sys.path.insert(0, ".")

from messaging.idempotency import SqliteDeliveryStore
from messaging.sqs_client import ENRICHMENT_DEFAULT_QUEUE, consume, initialize_client
from sayre_workers.enrichment.consumers import _loop_factory
from sayre_workers.enrichment.runtime import build_enrichment_service

import asyncio


def main() -> None:
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        runner.run(initialize_client())
        service = runner.run(build_enrichment_service())
        delivery_store = SqliteDeliveryStore("/tmp/sayre-enrichment-delivery-store.sqlite")

        def handle(envelope):
            runner.run(service.handle(envelope))

        try:
            print("[enrichment-consumer] draining", ENRICHMENT_DEFAULT_QUEUE, flush=True)
            consume(
                ENRICHMENT_DEFAULT_QUEUE,
                handle,
                consumer_id="enrichment-worker-local",
                delivery_store=delivery_store,
                visibility_timeout_seconds=120,
            )
        finally:
            runner.run(service.aclose())


if __name__ == "__main__":
    main()
