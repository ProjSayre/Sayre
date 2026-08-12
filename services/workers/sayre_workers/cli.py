"""Executable process entrypoints for the Python worker fleet.

Each mode owns one physical queue and one durable delivery store. The SQLite
store is the local/single-host reference implementation; multi-host
deployments must replace it with a shared ``DeliveryStore`` implementation.
Runtime failures are deliberately reported with fixed text so DSNs, provider
credentials, and upstream exception details never reach process logs.
"""

from __future__ import annotations

import argparse
import asyncio
import signal
import sys
import threading
from collections.abc import Callable, Coroutine, Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import FrameType
from typing import Any, Literal

from messaging.idempotency import DeliveryStore, SqliteDeliveryStore
from sayre_workers.chat.consumers import run_chat_turn_consumer
from sayre_workers.chat.runtime import build_chat_turn_service
from sayre_workers.config import get_config
from sayre_workers.enrichment.consumers import run_enrichment_consumer
from sayre_workers.enrichment.onboarding import run_onboarding_priority_consumer
from sayre_workers.enrichment.onboarding_bridge import build_onboarding_generator
from sayre_workers.enrichment.runtime import build_enrichment_service
from sayre_workers.ingestion.consumers import (
    run_embedding_consumer,
    run_ingestion_consumer,
)
from sayre_workers.ingestion.runtime import (
    build_embedding_consumer,
    build_ingestion_service,
)

WorkerMode = Literal[
    "ingestion",
    "enrichment-default",
    "onboarding-priority",
    "embedding",
    "chat",
]
ServiceBuilder = Callable[[], Coroutine[Any, Any, Any]]
ServiceRunner = Callable[[Any, DeliveryStore, threading.Event], None]

WORKER_MODES: tuple[WorkerMode, ...] = (
    "ingestion",
    "enrichment-default",
    "onboarding-priority",
    "embedding",
    "chat",
)
WORKER_FAILURE = "The worker process could not be completed."
MEMORY_STORE_ERROR = "The worker delivery store must persist on disk."


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


def _build_service(builder: ServiceBuilder) -> Any:
    # Builders may resolve async secret references and create async drivers.
    # Consumer adapters own the long-lived event loop used for message work.
    with asyncio.Runner(loop_factory=_loop_factory) as runner:
        return runner.run(builder())


def _run_ingestion(
    service: Any,
    delivery_store: DeliveryStore,
    stop_event: threading.Event,
) -> None:
    run_ingestion_consumer(service, delivery_store, stop_event=stop_event)


def _run_enrichment(
    service: Any,
    delivery_store: DeliveryStore,
    stop_event: threading.Event,
) -> None:
    run_enrichment_consumer(service, delivery_store, stop_event=stop_event)


def _run_onboarding(
    service: Any,
    delivery_store: DeliveryStore,
    stop_event: threading.Event,
) -> None:
    generator = build_onboarding_generator(service)
    run_onboarding_priority_consumer(
        generator,
        delivery_store=delivery_store,
        stop_event=stop_event,
    )


def _run_embedding(
    consumer: Any,
    delivery_store: DeliveryStore,
    stop_event: threading.Event,
) -> None:
    run_embedding_consumer(consumer, delivery_store, stop_event=stop_event)


def _run_chat(
    service: Any,
    delivery_store: DeliveryStore,
    stop_event: threading.Event,
) -> None:
    run_chat_turn_consumer(service, delivery_store, stop_event=stop_event)


@dataclass(frozen=True)
class WorkerDefinition:
    builder: ServiceBuilder
    runner: ServiceRunner


def _definition(mode: WorkerMode) -> WorkerDefinition:
    # Resolve these at call time so tests can replace the production builders
    # and runners without entering a long-poll loop.
    if mode == "ingestion":
        return WorkerDefinition(build_ingestion_service, _run_ingestion)
    if mode == "enrichment-default":
        return WorkerDefinition(build_enrichment_service, _run_enrichment)
    if mode == "onboarding-priority":
        return WorkerDefinition(build_enrichment_service, _run_onboarding)
    if mode == "chat":
        return WorkerDefinition(build_chat_turn_service, _run_chat)
    return WorkerDefinition(build_embedding_consumer, _run_embedding)


@contextmanager
def _graceful_shutdown(stop_event: threading.Event) -> Iterator[None]:
    """Set ``stop_event`` on SIGINT/SIGTERM and restore prior handlers."""

    previous: dict[signal.Signals, Any] = {}

    def request_shutdown(_signum: int, _frame: FrameType | None) -> None:
        stop_event.set()

    if threading.current_thread() is threading.main_thread():
        for name in ("SIGINT", "SIGTERM"):
            selected = getattr(signal, name, None)
            if selected is None:
                continue
            try:
                previous[selected] = signal.getsignal(selected)
                signal.signal(selected, request_shutdown)
            except (OSError, ValueError):
                previous.pop(selected, None)

    try:
        yield
    finally:
        for selected, handler in previous.items():
            try:
                signal.signal(selected, handler)
            except (OSError, ValueError):
                # Process teardown is already underway; a failed restore must
                # not expose platform-specific details or block resource close.
                pass


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="sayre-worker",
        description=(
            "Run one Sayre Python worker process. Run each mode as a separate "
            "process so ingestion, enrichment, onboarding, and embeddings retain "
            "their physical queue isolation."
        ),
    )
    parser.add_argument("mode", choices=WORKER_MODES)
    parser.add_argument(
        "--delivery-store",
        type=Path,
        default=None,
        help=(
            "Durable SQLite delivery-claim path for local/single-host use. "
            "Defaults to DELIVERY_STORE_PATH."
        ),
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    mode = args.mode
    assert mode in WORKER_MODES
    delivery_path = (
        args.delivery_store
        if args.delivery_store is not None
        else Path(get_config("DELIVERY_STORE_PATH"))
    )
    if str(delivery_path).strip() == ":memory:":
        print(MEMORY_STORE_ERROR, file=sys.stderr, flush=True)
        return 2

    definition = _definition(mode)
    stop_event = threading.Event()
    try:
        with _graceful_shutdown(stop_event):
            with SqliteDeliveryStore(delivery_path) as delivery_store:
                service = _build_service(definition.builder)
                definition.runner(service, delivery_store, stop_event)
    except KeyboardInterrupt:
        # Defensive fallback for platforms that do not permit signal handler
        # installation. The consumer/store context managers still unwind.
        return 0
    except Exception:
        print(
            f"{mode} worker FAILED: {WORKER_FAILURE}",
            file=sys.stderr,
            flush=True,
        )
        return 1
    return 0


def _mode_main(mode: WorkerMode, argv: Sequence[str] | None) -> int:
    selected = list(sys.argv[1:] if argv is None else argv)
    return main([mode, *selected])


def ingestion_main(argv: Sequence[str] | None = None) -> int:
    return _mode_main("ingestion", argv)


def enrichment_main(argv: Sequence[str] | None = None) -> int:
    return _mode_main("enrichment-default", argv)


def onboarding_main(argv: Sequence[str] | None = None) -> int:
    return _mode_main("onboarding-priority", argv)


def embedding_main(argv: Sequence[str] | None = None) -> int:
    return _mode_main("embedding", argv)


def chat_main(argv: Sequence[str] | None = None) -> int:
    return _mode_main("chat", argv)
