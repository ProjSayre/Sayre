"""Scheduled-task entrypoint for one trusted ``coverage.nightly`` envelope.

Usage:
    poetry run python scripts/run_dynamic_coverage.py nightly-envelope.json -- \
      python path/to/isolated_ci_adapter.py

The adapter command is operator configuration, never message input. It runs without
a shell, receives the conservative test plan on stdin, and emits one normalized
CoverageRunReport on stdout.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from messaging.envelope import MessageEnvelope
from sayre_workers.dynamic_coverage import (
    CommandCoverageRunExecutor,
    CoverageRefreshService,
    Neo4jCoverageGraphStore,
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("envelope", type=Path)
    parser.add_argument("runner_command", nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.runner_command[:1] == ["--"]:
        arguments.runner_command = arguments.runner_command[1:]
    if not arguments.runner_command:
        parser.error("runner command is required after --")
    return arguments


async def _run(arguments: argparse.Namespace) -> int:
    envelope = MessageEnvelope.from_body(arguments.envelope.read_text(encoding="utf-8"))
    graph = await Neo4jCoverageGraphStore.from_config()
    try:
        service = CoverageRefreshService(
            graph_store=graph,
            runner=CommandCoverageRunExecutor(arguments.runner_command),
        )
        result = await service.handle(envelope)
    finally:
        await graph.close()
    return 0 if result.status == "applied" else 2


def main() -> int:
    return asyncio.run(_run(_arguments()))


if __name__ == "__main__":
    raise SystemExit(main())
