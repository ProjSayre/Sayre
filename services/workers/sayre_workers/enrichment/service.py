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

from dataclasses import replace
from typing import Protocol

from messaging.envelope import MessageEnvelope
from sayre_workers.model_provider import (
    GenerationConfig,
    ModelProviderFactory,
    ProviderCallFailedError,
    ProviderCallScope,
)

from .enrichment_graph import EnrichmentGraphStore
from .events import parse_enrichment_envelope
from .feature_clustering import (
    build_feature_clustering_request,
    build_feature_clustering_schema,
    canonicalize_feature_clustering_write,
)
from .graphify_adapter import GraphifyAdapterFactory
from .models import (
    EnrichmentJob,
    EnrichmentResult,
    GenerationConfigNotFoundError,
    InvalidEnrichmentWriteError,
)
from .onboarding_plan import (
    OnboardingGraphifyAdapter,
    build_onboarding_request,
)
from .style_classifier import ModelStyleClassifier, StyleClassifier
from .state_store import (
    ProviderJobState,
    ProviderJobStateStore,
    ProviderJobStatus,
    ProviderJobSurface,
)
from sayre_workers.tickets.reference_match import (
    TicketReferenceMatcher,
    TicketReferenceMatchResult,
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
        onboarding_graphify_factory: GraphifyAdapterFactory | None = None,
        config_store: GenerationConfigStore,
        state_store: ProviderJobStateStore,
        style_classifier: StyleClassifier | None = None,
        ticket_reference_matcher: TicketReferenceMatcher | None = None,
    ) -> None:
        self._graph_store = graph_store
        self._model_provider_factory = model_provider_factory
        self._graphify_factory = graphify_factory
        self._onboarding_graphify_factory = (
            onboarding_graphify_factory or GraphifyAdapterFactory()
        )
        self._config_store = config_store
        self._state_store = state_store
        self._style_classifier = style_classifier or ModelStyleClassifier()
        self._ticket_reference_matcher = ticket_reference_matcher

    async def handle(
        self, envelope: MessageEnvelope
    ) -> EnrichmentResult | TicketReferenceMatchResult:
        # Hands-on gap-fix (docs/post-mvp-backlog.md): a `ticket.reference_match`
        # request is architecturally unrelated to the LLM-generation pipeline
        # below (different config surface, no graph structural context, no
        # GraphifyAdapter shaping) -- branch BEFORE parse_enrichment_envelope
        # rather than forcing it through that parser.
        if envelope.type == "ticket.reference_match":
            if self._ticket_reference_matcher is None:
                raise RuntimeError(
                    "received a ticket.reference_match envelope but no "
                    "TicketReferenceMatcher was configured"
                )
            return await self._ticket_reference_matcher.handle(envelope)

        job = parse_enrichment_envelope(envelope)
        return await self.process(job)

    async def process(self, job: EnrichmentJob) -> EnrichmentResult:
        if not await self._graph_store.is_current(job.scope):
            return EnrichmentResult(
                status="skipped_stale", scope=job.scope, node_count=0, edge_count=0
            )

        # Feature clustering is a complete projection of the current ref head, not a
        # per-file patch. Re-reading every current File keeps cross-folder clusters
        # coherent after changed-file deltas and allows one atomic replacement.
        changed_paths = () if job.lane == "default" else job.changed_paths
        full_rebuild = True if job.lane == "default" else job.full_rebuild
        context = await self._graph_store.load_context(
            job.scope, changed_paths, full_rebuild
        )
        if not context.files:
            if not await self._graph_store.is_current(job.scope):
                return EnrichmentResult(
                    status="skipped_stale",
                    scope=job.scope,
                    node_count=0,
                    edge_count=0,
                )
            # A valid ack -- nothing to enrich (empty repo, no matching changed
            # paths, or a priority-lane job that carries no enrichable scope yet).
            return EnrichmentResult(
                status="skipped_no_context",
                scope=job.scope,
                node_count=0,
                edge_count=0,
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
            base_graphify = (
                self._graphify_factory.create()
                if job.lane == "default"
                else self._onboarding_graphify_factory.create()
            )
            graphify = (
                base_graphify
                if job.lane == "default"
                else OnboardingGraphifyAdapter(base_graphify)
            )
            request = (
                build_feature_clustering_request(context)
                if job.lane == "default"
                else build_onboarding_request(context)
            )
            generation = await provider.generate_structured(
                request,
                (
                    build_feature_clustering_schema(context)
                    if job.lane == "default"
                    else graphify.schema(context)
                ),
            )

            write = await graphify.shape(context, generation)
            if write.scope != job.scope:
                # Defense in depth: a GraphifyAdapter must never write outside the
                # scope it was asked to enrich.
                raise InvalidEnrichmentWriteError(
                    "GraphifyAdapter returned a write scoped to a different job"
                )
            if job.lane == "default":
                write = canonicalize_feature_clustering_write(context, write)

            style_patches = (
                await self._style_classifier.classify(context, provider)
                if job.lane == "default"
                else ()
            )
            if style_patches:
                write = replace(
                    write,
                    property_patches=(*write.property_patches, *style_patches),
                )
            context_folder_uids = {folder.uid for folder in context.folders}
            if any(
                patch.label != "Folder" or patch.uid not in context_folder_uids
                for patch in write.property_patches
            ):
                raise InvalidEnrichmentWriteError(
                    "enrichment property patch targets a Folder outside the loaded context"
                )

            if job.lane == "default":
                if not await self._graph_store.apply_feature_projection(write):
                    return EnrichmentResult(
                        status="skipped_stale",
                        scope=job.scope,
                        node_count=0,
                        edge_count=0,
                    )
            else:
                if not await self._graph_store.apply_onboarding_projection(write):
                    return EnrichmentResult(
                        status="skipped_stale",
                        scope=job.scope,
                        node_count=0,
                        edge_count=0,
                    )
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
        close_failed = False
        try:
            await self._model_provider_factory.aclose()
        except Exception:
            close_failed = True

        close_graph = getattr(self._graph_store, "close", None)
        if callable(close_graph):
            try:
                await close_graph()
            except Exception:
                close_failed = True

        if close_failed:
            raise RuntimeError("one or more enrichment runtime resources failed to close")
