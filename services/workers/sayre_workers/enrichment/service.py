"""W2-05 semantic enrichment orchestration.

`handle(envelope)` is a thin wrapper -- parse then delegate -- so `process(job)` is the
single shared entry point for both lanes (Decision D6): the default lane calls it via
`handle`, and the priority lane calls it via `onboarding_bridge.build_onboarding_generator`,
which builds an `EnrichmentJob` directly (bypassing envelope parsing, since W2-08's own
`parse_onboarding_generate` owns that type end to end).

`process`'s order: load structural context from Neo4j (graph is source of truth) ->
short-circuit on empty context -> load the org's generation config (raising on a
missing row, Decision D2 -- no skip-and-ack, no fake-provider fallback) -> persist a
sanitized generating state -> generate through the bounded provider wrapper -> shape
and validate graph primitives -> apply to Neo4j -> persist ready. A configured
degrade fallback persists degraded and acknowledges without a semantic write; fail
and retry-exhausted outcomes persist failed and propagate for SQS redelivery.

No feedback loop: this module never publishes `graph.updated` (that topic fans out to
`enrichment-default`; re-publishing would re-trigger enrichment forever), and it emits
no realtime notification of its own (Decision D4) -- connected views re-read on next
request.
"""

from __future__ import annotations

from typing import Protocol

from messaging.envelope import MessageEnvelope
from sayre_workers.model_provider import (
    GenerationConfig,
    GenerationRequest,
    ModelProviderFactory,
    ProviderCallFailedError,
    ProviderCallScope,
)

from .enrichment_graph import EnrichmentGraphStore
from .events import parse_enrichment_envelope
from .graphify_adapter import GraphifyAdapterFactory
from .models import (
    EnrichmentJob,
    EnrichmentResult,
    GenerationConfigNotFoundError,
    InvalidEnrichmentWriteError,
)
from .state_store import (
    ProviderJobState,
    ProviderJobStateStore,
    ProviderJobStatus,
    ProviderJobSurface,
)


class GenerationConfigStore(Protocol):
    async def load_generation_config(self, org_id: str) -> GenerationConfig | None: ...


class EnrichmentService:
    def __init__(
        self,
        *,
        graph_store: EnrichmentGraphStore,
        model_provider_factory: ModelProviderFactory,
        graphify_factory: GraphifyAdapterFactory,
        config_store: GenerationConfigStore,
        state_store: ProviderJobStateStore,
    ) -> None:
        self._graph_store = graph_store
        self._model_provider_factory = model_provider_factory
        self._graphify_factory = graphify_factory
        self._config_store = config_store
        self._state_store = state_store

    async def handle(self, envelope: MessageEnvelope) -> EnrichmentResult:
        job = parse_enrichment_envelope(envelope)
        return await self.process(job)

    async def process(self, job: EnrichmentJob) -> EnrichmentResult:
        context = await self._graph_store.load_context(
            job.scope, job.changed_paths, job.full_rebuild
        )
        if not context.files:
            # A valid ack -- nothing to enrich (empty repo, no matching changed
            # paths, or a priority-lane job that carries no enrichable scope yet).
            return EnrichmentResult(
                status="skipped_no_context", scope=job.scope, node_count=0, edge_count=0
            )

        config = await self._config_store.load_generation_config(job.scope.org_id)
        if config is None:
            # No skip-and-ack, no fake-provider substitution -- raise so the message
            # is NOT acked and redelivers -> DLQ (Decision D2).
            raise GenerationConfigNotFoundError(
                f"no generation model_provider_configs row for org {job.scope.org_id!r}"
            )

        surface: ProviderJobSurface = (
            "onboarding" if job.lane == "priority" else "product"
        )
        await self._state_store.set_state(
            ProviderJobState(
                scope=job.scope,
                surface=surface,
                status="generating",
            )
        )

        try:
            provider = await self._model_provider_factory.create(
                config, ProviderCallScope(org_id=job.scope.org_id)
            )
            graphify = self._graphify_factory.create()
            generation = await provider.generate_structured(
                GenerationRequest(
                    system=(
                        "Emit only schema-constrained semantic graph primitives. "
                        "Never return free-form prose or structural parser output."
                    ),
                    input=(
                        f"org={job.scope.org_id} repository={job.scope.repository_id} "
                        f"ref={job.scope.ref_name} revision={job.scope.revision_sha} "
                        f"files={[file.path for file in context.files]!r}"
                    ),
                ),
                graphify.schema(context),
            )

            write = await graphify.shape(context, generation)
            if write.scope != job.scope:
                # Defense in depth: a GraphifyAdapter must never write outside the
                # scope it was asked to enrich.
                raise InvalidEnrichmentWriteError(
                    "GraphifyAdapter returned a write scoped to a different job"
                )
            await self._graph_store.apply(write)
        except ProviderCallFailedError as error:
            status: ProviderJobStatus = (
                "degraded" if error.fallback_mode == "degrade" else "failed"
            )
            await self._state_store.set_state(
                ProviderJobState(
                    scope=job.scope,
                    surface=surface,
                    status=status,
                    reason_code=error.reason,
                )
            )
            if status == "degraded":
                return EnrichmentResult(
                    status="degraded",
                    scope=job.scope,
                    node_count=0,
                    edge_count=0,
                )
            raise
        except Exception:
            await self._state_store.set_state(
                ProviderJobState(
                    scope=job.scope,
                    surface=surface,
                    status="failed",
                    reason_code="processing_error",
                )
            )
            raise

        await self._state_store.set_state(
            ProviderJobState(scope=job.scope, surface=surface, status="ready")
        )
        return EnrichmentResult(
            status="written",
            scope=job.scope,
            node_count=len(write.nodes),
            edge_count=len(write.edges),
        )

    async def aclose(self) -> None:
        await self._model_provider_factory.aclose()
