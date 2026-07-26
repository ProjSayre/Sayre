"""SQS consumer wiring for the nightly dynamic-coverage refresh queue.

Mirrors `sayre_workers.ingestion.consumers`/`sayre_workers.enrichment.consumers`:
a long-running process drains `DYNAMIC_COVERAGE_QUEUE`, handling both
`coverage.nightly` (run the impacted-test plan through the configured runner)
and `coverage.report` (apply an already-produced report) message types via
`CoverageRefreshService.handle`. The scheduler (`scripts/schedule_dynamic_coverage.py`)
is the producer side -- this module only consumes.
"""

from __future__ import annotations

import asyncio
import sys
import threading

from messaging.envelope import MessageEnvelope
from messaging.idempotency import DeliveryStore
from messaging.sqs_client import DYNAMIC_COVERAGE_QUEUE, consume

from .service import CoverageRefreshService


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows. Linux uses
    # the platform default selector loop already. Mirrors the other fleets'
    # _loop_factory helpers.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def run_coverage_consumer(
    service: CoverageRefreshService,
    delivery_store: DeliveryStore,
    *,
    stop_event: threading.Event | None = None,
    visibility_timeout_seconds: int = 300,
) -> None:
    """Drain DYNAMIC_COVERAGE_QUEUE, one message at a time, via CoverageRefreshService.

    A long visibility timeout is the default (300s, matching the ingestion consumer)
    since running a real test suite for impact analysis can take much longer than an
    enrichment or embedding call.
    """
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        def handle(envelope: MessageEnvelope) -> None:
            runner.run(service.handle(envelope))

        consume(
            DYNAMIC_COVERAGE_QUEUE,
            handle,
            consumer_id="dynamic-coverage-worker",
            delivery_store=delivery_store,
            stop_event=stop_event,
            visibility_timeout_seconds=visibility_timeout_seconds,
        )
