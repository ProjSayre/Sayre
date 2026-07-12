"""Package marker for `services/workers`.

Required so `services/workers/queue` is importable as `workers.queue` (a qualified
submodule) rather than a bare top-level `queue` package. Python's standard library
already has a top-level module named `queue` (`queue.Queue`, `queue.LifoQueue`, used
internally by `threading`/`asyncio`/`concurrent.futures` and, transitively, by
`boto3`/`botocore`/`urllib3` — a direct dependency of `workers/queue/sqs_client.py`
itself). Whichever import wins the `sys.modules["queue"]` cache slot first "shadows"
the other for the lifetime of the process; since this package's own SQS wrapper needs
the *real* stdlib `queue` (via boto3) to keep working, our package cannot safely be
importable as bare top-level `queue`. Nesting it under this `workers` package resolves
the collision: `sys.modules["workers.queue"]` is a distinct cache key from
`sys.modules["queue"]`, so both coexist without shadowing one another.

This file is an addition beyond the ticket's literal file list (not a rename of any
ticket-named path) — see `.pipeline/W0-04/changes.md` "Deviations from spec" for the
full writeup, including the exact import spelling test/production code must use:
`from workers.queue.sqs_client import ...` / `from workers.queue.envelope import ...`
(never bare `from queue.sqs_client import ...`, which resolves to the *stdlib* queue
module and fails).
"""
