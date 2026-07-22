"""W2-05 semantic enrichment orchestration.

Order: parse envelope -> load structural context from Neo4j (graph is source of
truth) -> short-circuit on empty context -> load the org's generation config (raising
on a missing row, Decision D2 -- no skip-and-ack, no fake-provider fallback) ->
generate -> shape into graph primitives -> validate the write is scoped to this job
and stays inside the closed sets -> apply to Neo4j.

No feedback loop: this module never publishes `graph.updated` (that topic fans out to
`enrichment-default`; re-publishing would re-trigger enrichment forever), and it emits
no realtime notification of its own (Decision D4) -- connected views re-read on next
request.
"""

from __future__ import annotations

from typing import Protocol

from messaging.envelope import MessageEnvelope

from .enrichment_graph import EnrichmentGraphStore
from .events import parse_enrichment_envelope
from .graphify_adapter import GraphifyAdapterFactory
from .models import (
    EnrichmentResult,
    GenerationConfig,
    GenerationConfigNotFoundError,
    InvalidEnrichmentWriteError,
)
from .providers import GenerationRequest, ModelProviderFactory


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
    ) -> None:
        self._graph_store = graph_store
        self._model_provider_factory = model_provider_factory
        self._graphify_factory = graphify_factory
        self._config_store = config_store

    async def handle(self, envelope: MessageEnvelope) -> EnrichmentResult:
        job = parse_enrichment_envelope(envelope)

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

        provider = await self._model_provider_factory.create(config)
        generation = await provider.generate(
            GenerationRequest(
                system=(
                    "Sayre semantic enrichment skeleton. Emit only structured graph "
                    "primitives (nodes and edges) -- never free-form prose."
                ),
                input=(
                    f"org={job.scope.org_id} repository={job.scope.repository_id} "
                    f"ref={job.scope.ref_name} revision={job.scope.revision_sha} "
                    f"files={[file.path for file in context.files]!r}"
                ),
            )
        )

        write = await self._graphify_factory.create().shape(context, generation)
        if write.scope != job.scope:
            # Defense in depth: a GraphifyAdapter must never write outside the scope
            # it was asked to enrich. Checked here (where both the job's authoritative
            # scope and the adapter's returned write are in hand) so no Cypher runs.
            raise InvalidEnrichmentWriteError(
                "GraphifyAdapter returned a write scoped to a different job"
            )
        await self._graph_store.apply(write)

        return EnrichmentResult(
            status="written",
            scope=job.scope,
            node_count=len(write.nodes),
            edge_count=len(write.edges),
        )
