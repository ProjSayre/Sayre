"""AI-inferred ticket-to-file matching (hands-on gap-fix, not a planned ticket
-- see docs/post-mvp-backlog.md).

A synced Jira/Linear ticket only ever links to a File/Feature node via an
explicit `[sayre:file:...]`/`[sayre:feature:...]` tag in its own description
(services/core/src/integrations/tickets/references.ts). This module is the
fallback for everything else: `services/core`'s `syncTicket()` publishes a
`ticket.reference_match` request (standard `enrichment-default` queue, no new
physical queue -- see `.claude/rules/async-messaging.md`) whenever a ticket has
no explicit tag; this consumer embeds the ticket's title+description through
the SAME `EmbeddingProvider` boundary ingestion uses, finds the most similar
already-embedded code chunk via pgvector cosine search, and -- only above a
conservative similarity threshold -- writes that chunk's graph node id back to
`ticket_cache` (migration 0018) for `syncTicket()` to pick up and link on its
NEXT cycle.

Deliberately separate from `EnrichmentService.process()`: that pipeline is
built around LLM-based graph-primitive generation (structural context ->
generation config -> generate -> shape -> apply); this is a pure
embed-and-nearest-neighbor lookup with a completely different config surface
(the org's EMBEDDING provider config, not its GENERATION config) and no
GraphifyAdapter shaping step at all. `EnrichmentService.handle()` branches to
this module BEFORE `parse_enrichment_envelope`, rather than forcing this
task's shape into that parser/pipeline.

A wrong auto-link is worse than no link at all, so this never guesses below
its threshold -- an unmatched ticket simply stays unlinked, exactly as it is
today.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from messaging.envelope import MessageEnvelope
from sayre_workers.config import get_secret
from sayre_workers.db.session import org_scoped_connection
from sayre_workers.ingestion.embeddings import EmbeddingProviderFactory
from sayre_workers.ingestion.models import EmbeddingConfig
from sayre_workers.telemetry.vector_metrics import execute_vector_query

# Cosine SIMILARITY (1 - pgvector's `<=>` cosine DISTANCE), not distance.
# Conservative on purpose (see module docstring) -- this exact number has not
# been evaluated against real ticket/code pairs and needs a real pipeline
# re-run to tune (docs/post-mvp-backlog.md).
SIMILARITY_THRESHOLD = 0.75


class InvalidTicketReferenceMatchRequestError(ValueError):
    pass


@dataclass(frozen=True)
class TicketReferenceMatchRequest:
    org_id: str
    repository_id: str
    ref_name: str
    provider: str
    external_ticket_id: str
    title: str
    description: str | None


@dataclass(frozen=True)
class TicketReferenceMatchResult:
    status: Literal["matched", "below_threshold", "no_config", "no_candidates"]
    org_id: str
    external_ticket_id: str
    node_id: str | None = None
    score: float | None = None


def parse_ticket_reference_match_envelope(
    envelope: MessageEnvelope,
) -> TicketReferenceMatchRequest:
    if envelope.type != "ticket.reference_match":
        raise InvalidTicketReferenceMatchRequestError(
            "unsupported ticket reference-match envelope type"
        )
    payload = envelope.payload

    def required(name: str) -> str:
        value = payload.get(name)
        if not isinstance(value, str) or not value.strip():
            raise InvalidTicketReferenceMatchRequestError(
                f"ticket reference-match payload {name} must be a non-blank string"
            )
        return value

    description = payload.get("description")
    if description is not None and not isinstance(description, str):
        raise InvalidTicketReferenceMatchRequestError(
            "ticket reference-match payload description must be a string or null"
        )

    return TicketReferenceMatchRequest(
        org_id=envelope.org_id,
        repository_id=required("repository_id"),
        ref_name=required("ref_name"),
        provider=required("provider"),
        external_ticket_id=required("external_ticket_id"),
        title=required("title"),
        description=description,
    )


class TicketReferenceMatchStore(Protocol):
    async def load_embedding_config(self, org_id: str) -> EmbeddingConfig | None: ...

    async def find_best_match(
        self,
        org_id: str,
        repository_id: str,
        provider: str,
        model: str,
        query_vector: tuple[float, ...],
    ) -> tuple[str, float] | None: ...

    async def write_inferred_reference(
        self,
        org_id: str,
        provider: str,
        external_ticket_id: str,
        node_id: str,
        score: float,
    ) -> None: ...


def _vector_literal(vector: tuple[float, ...]) -> str:
    return "[" + ",".join(format(value, ".17g") for value in vector) + "]"


class PostgresTicketReferenceMatchStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresTicketReferenceMatchStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    async def load_embedding_config(self, org_id: str) -> EmbeddingConfig | None:
        async with org_scoped_connection(self._dsn, org_id) as connection:
            cursor = await connection.execute(
                """
                SELECT provider, model, dimension, endpoint_url, credential_ref
                FROM model_provider_configs
                WHERE org_id = %s AND purpose = 'embedding'
                """,
                (org_id,),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return EmbeddingConfig(
            provider=str(row["provider"]),
            model=str(row["model"]),
            dimension=int(row["dimension"] or 1024),
            endpoint_url=row["endpoint_url"],
            credential_ref=row["credential_ref"],
        )

    async def find_best_match(
        self,
        org_id: str,
        repository_id: str,
        provider: str,
        model: str,
        query_vector: tuple[float, ...],
    ) -> tuple[str, float] | None:
        # Only compare against embeddings produced by the SAME provider/model
        # as the query vector -- vectors from different models are not in a
        # comparable space (docs/wave0-foundation-contracts.md, same rule
        # `code_embeddings`' own unique-per-chunk-per-provider-model index
        # enforces on the write side).
        async with org_scoped_connection(self._dsn, org_id) as connection:
            cursor = await execute_vector_query(
                connection,
                org_id=org_id,
                query="""
                SELECT graph_node_id, 1 - (embedding <=> %s::vector) AS similarity
                FROM code_embeddings
                WHERE org_id = %s AND repository_id = %s
                  AND provider = %s AND model = %s
                  AND graph_node_id IS NOT NULL
                ORDER BY embedding <=> %s::vector
                LIMIT 1
                """,
                params=(
                    _vector_literal(query_vector),
                    org_id,
                    repository_id,
                    provider,
                    model,
                    _vector_literal(query_vector),
                ),
            )
            row = await cursor.fetchone()
        if row is None:
            return None
        return (str(row["graph_node_id"]), float(row["similarity"]))

    async def write_inferred_reference(
        self,
        org_id: str,
        provider: str,
        external_ticket_id: str,
        node_id: str,
        score: float,
    ) -> None:
        async with org_scoped_connection(self._dsn, org_id) as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE ticket_cache
                    SET inferred_reference_node_id = %s,
                        inferred_reference_score = %s,
                        inferred_reference_computed_at = now()
                    WHERE org_id = %s AND provider = %s AND external_ticket_id = %s
                    """,
                    (node_id, score, org_id, provider, external_ticket_id),
                )


class TicketReferenceMatcher:
    def __init__(
        self,
        store: TicketReferenceMatchStore,
        provider_factory: EmbeddingProviderFactory | None = None,
    ) -> None:
        self._store = store
        self._provider_factory = provider_factory or EmbeddingProviderFactory()

    async def handle(self, envelope: MessageEnvelope) -> TicketReferenceMatchResult:
        request = parse_ticket_reference_match_envelope(envelope)
        return await self.process(request)

    async def process(self, request: TicketReferenceMatchRequest) -> TicketReferenceMatchResult:
        config = await self._store.load_embedding_config(request.org_id)
        if config is None:
            # Same "retryable configuration state, not stale work" posture as
            # ingestion's EmbeddingConfigNotFoundError -- but a missing
            # embedding config is common (many orgs never configure one) and
            # this task is a best-effort fallback, not a required step, so
            # this reports rather than raises/retries.
            return TicketReferenceMatchResult(
                status="no_config",
                org_id=request.org_id,
                external_ticket_id=request.external_ticket_id,
            )

        provider = await self._provider_factory.create(config)
        try:
            text = (
                request.title
                if request.description is None
                else (f"{request.title}\n\n{request.description}")
            )
            vector = (await provider.embed([text]))[0]
        finally:
            close: Any = getattr(provider, "aclose", None)
            if callable(close):
                await close()

        match = await self._store.find_best_match(
            request.org_id,
            request.repository_id,
            config.provider,
            config.model,
            vector,
        )
        if match is None:
            return TicketReferenceMatchResult(
                status="no_candidates",
                org_id=request.org_id,
                external_ticket_id=request.external_ticket_id,
            )

        node_id, score = match
        if score < SIMILARITY_THRESHOLD:
            return TicketReferenceMatchResult(
                status="below_threshold",
                org_id=request.org_id,
                external_ticket_id=request.external_ticket_id,
                node_id=node_id,
                score=score,
            )

        await self._store.write_inferred_reference(
            request.org_id,
            request.provider,
            request.external_ticket_id,
            node_id,
            score,
        )
        return TicketReferenceMatchResult(
            status="matched",
            org_id=request.org_id,
            external_ticket_id=request.external_ticket_id,
            node_id=node_id,
            score=score,
        )
