"""D6 bridge: plugs `EnrichmentService.process` into W2-08's priority-lane
`OnboardingPriorityHandler(generator=...)` slot.

Why this exists: W2-08 merged into `main` after this ticket branched and built its own
dedicated priority-lane consumer (`sayre_workers.enrichment.onboarding`:
`OnboardingGenerateJob`, `parse_onboarding_generate`, `OnboardingPriorityHandler`,
`run_onboarding_priority_consumer`). This worker's own `run_enrichment_consumer` no
longer touches the priority queue at all (see `consumers.py`) -- real priority-lane
processing is exclusively driven by W2-08's consumer, with this module supplying the
`generator` it calls.

`OnboardingPriorityHandler.__call__` invokes `self._generator(job)` unawaited, so the
returned callable MUST be synchronous. It owns one long-lived `asyncio.Runner`, built
once here and reused across every call, so a message-processing hot path never pays
the cost of spinning up a fresh event loop per message (mirrors `consumers.py`'s
`_loop_factory` pattern). Any exception `process()` raises (notably
`GenerationConfigNotFoundError`, Decision D2) propagates uncaught out of the generator
-- `OnboardingPriorityHandler.__call__` has no try/except around the generator call, so
this preserves D2's raise -> redeliver -> DLQ semantics on the priority lane too, and
correctly skips `record_onboarding_ready` (it only fires after the generator returns
without raising -- an onboarding repo must never be reported "ready" if enrichment
failed).
"""

from __future__ import annotations

import asyncio
import sys
from sayre_workers.ingestion.models import GraphScope

from .models import EnrichmentJob, EnrichmentResult
from .onboarding import OnboardingGenerateJob
from .service import EnrichmentService


def _loop_factory() -> asyncio.AbstractEventLoop:
    # psycopg's async implementation needs a selector loop on Windows. Linux uses
    # the platform default selector loop already. Mirrors consumers.py/ingestion's
    # _loop_factory helpers.
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop()
    return asyncio.new_event_loop()


class OnboardingGenerator:
    def __init__(self, service: EnrichmentService) -> None:
        self._service = service
        self._runner = asyncio.Runner(loop_factory=_loop_factory)
        self._closed = False

    def __call__(self, job: OnboardingGenerateJob) -> EnrichmentResult:
        if self._closed:
            raise RuntimeError("onboarding generator is closed")
        enrichment_job = EnrichmentJob(
            scope=GraphScope(
                org_id=job.org_id,
                repository_id=job.repository_id,
                ref_name=job.ref_name,
                revision_sha=job.revision_sha,
            ),
            graph_scope_key=job.graph_scope_key,
            graph_version=job.graph_version,
            full_rebuild=True,
            changed_paths=(),
            lane="priority",
            trace_id=job.trace_id,
            idempotency_key=f"{job.graph_scope_key}:{job.revision_sha}:onboarding.generate",
        )
        return self._runner.run(self._service.process(enrichment_job))

    def close(self) -> None:
        if self._closed:
            return
        try:
            self._runner.run(self._service.aclose())
        finally:
            self._runner.close()
            self._closed = True


def build_onboarding_generator(service: EnrichmentService) -> OnboardingGenerator:
    """Return a sync callable wrapping `service.process(...)` for W2-08's
    `OnboardingPriorityHandler(generator=...)`.

    Builds an `EnrichmentJob` from the `OnboardingGenerateJob`: `full_rebuild=True`
    (cold start has no prior state to diff against, so there is nothing to compare
    `changed_paths` against) and `changed_paths=()`; `lane="priority"`;
    `idempotency_key` mirrors the convention already used for `graph.updated` jobs
    (`f"{graph_scope_key}:{revision_sha}:<event type>"`).

    Owns one long-lived `asyncio.Runner`, built once when this function is called and
    reused across every invocation of the returned callable -- not a new event loop
    per message.
    """
    return OnboardingGenerator(service)
