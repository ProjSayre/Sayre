from __future__ import annotations

import signal
import threading
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from messaging.idempotency import DeliveryStore, SqliteDeliveryStore
from sayre_workers import cli
from sayre_workers.ingestion.consumers import run_ingestion_consumer
from scripts import run_graph_migrations


@pytest.mark.parametrize("mode", cli.WORKER_MODES)
def test_each_worker_mode_builds_and_runs_once_without_polling_forever(
    mode: cli.WorkerMode,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    events: list[tuple[str, object]] = []
    service = object()

    async def build() -> object:
        events.append(("build", mode))
        return service

    def run(
        selected_service: Any,
        delivery_store: DeliveryStore,
        stop_event: threading.Event,
    ) -> None:
        assert selected_service is service
        assert not stop_event.is_set()
        assert delivery_store is not None
        events.append(("run", mode))

    monkeypatch.setattr(
        cli,
        "_definition",
        lambda selected_mode: cli.WorkerDefinition(build, run),
    )

    result = cli.main(
        [mode, "--delivery-store", str(tmp_path / f"{mode}.sqlite3")]
    )

    assert result == 0
    assert events == [("build", mode), ("run", mode)]
    assert (tmp_path / f"{mode}.sqlite3").is_file()


def test_worker_failure_output_never_contains_exception_details(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "postgresql://runtime-user:do-not-print@example.invalid/sayre"

    async def fail_to_build() -> object:
        raise RuntimeError(secret)

    def should_not_run(
        _service: Any,
        _delivery_store: DeliveryStore,
        _stop_event: threading.Event,
    ) -> None:
        raise AssertionError("runner must not be called after a construction failure")

    monkeypatch.setattr(
        cli,
        "_definition",
        lambda _mode: cli.WorkerDefinition(fail_to_build, should_not_run),
    )

    result = cli.main(
        ["ingestion", "--delivery-store", str(tmp_path / "claims.sqlite3")]
    )

    captured = capsys.readouterr()
    assert result == 1
    assert cli.WORKER_FAILURE in captured.err
    assert secret not in captured.err
    assert captured.out == ""


def test_worker_rejects_an_in_memory_delivery_store_before_construction(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        cli,
        "_definition",
        lambda _mode: pytest.fail("construction must not run for an in-memory store"),
    )

    assert cli.main(["embedding", "--delivery-store", ":memory:"]) == 2
    assert capsys.readouterr().err.strip() == cli.MEMORY_STORE_ERROR


def test_graceful_shutdown_sets_event_and_restores_signal_handlers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    installed: dict[signal.Signals, object] = {}
    restored: list[tuple[signal.Signals, object]] = []
    previous = {
        signal.SIGINT: object(),
        signal.SIGTERM: object(),
    }

    monkeypatch.setattr(signal, "getsignal", lambda selected: previous[selected])

    def fake_signal(selected: signal.Signals, handler: object) -> object:
        if selected in installed:
            restored.append((selected, handler))
        else:
            installed[selected] = handler
        return previous[selected]

    monkeypatch.setattr(signal, "signal", fake_signal)
    stop_event = threading.Event()

    with cli._graceful_shutdown(stop_event):
        handler = installed[signal.SIGTERM]
        assert callable(handler)
        handler(signal.SIGTERM, None)
        assert stop_event.is_set()

    assert restored == [
        (signal.SIGINT, previous[signal.SIGINT]),
        (signal.SIGTERM, previous[signal.SIGTERM]),
    ]


def test_package_declares_all_worker_and_migration_console_scripts() -> None:
    pyproject_path = Path(__file__).parents[1] / "pyproject.toml"
    with pyproject_path.open("rb") as pyproject_file:
        scripts = tomllib.load(pyproject_file)["project"]["scripts"]

    assert scripts == {
        "sayre-worker": "sayre_workers.cli:main",
        "sayre-ingestion-worker": "sayre_workers.cli:ingestion_main",
        "sayre-enrichment-worker": "sayre_workers.cli:enrichment_main",
        "sayre-onboarding-worker": "sayre_workers.cli:onboarding_main",
        "sayre-embedding-worker": "sayre_workers.cli:embedding_main",
        "sayre-chat-worker": "sayre_workers.cli:chat_main",
        "sayre-graph-migrate": "scripts.run_graph_migrations:console_main",
        "sayre-affected-tests": "scripts.affected_tests:console_main",
    }


def test_graph_migration_console_entrypoint_runs_async_main(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_main() -> int:
        return 7

    monkeypatch.setattr(run_graph_migrations, "main", fake_main)

    assert run_graph_migrations.console_main() == 7


def test_ingestion_consumer_closes_service_when_polling_stops_with_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[bool] = []

    def fail_poll(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("simulated broker stop")

    async def handle(_envelope: object) -> None:
        return None

    async def close() -> None:
        closed.append(True)

    monkeypatch.setattr("sayre_workers.ingestion.consumers.consume", fail_poll)
    service = SimpleNamespace(handle=handle, aclose=close)

    with SqliteDeliveryStore(":memory:") as store:
        with pytest.raises(RuntimeError, match="simulated broker stop"):
            run_ingestion_consumer(service, store)  # type: ignore[arg-type]

    assert closed == [True]
