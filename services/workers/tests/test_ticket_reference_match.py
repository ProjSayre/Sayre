from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.embeddings import EmbeddingProviderFactory
from sayre_workers.ingestion.models import EmbeddingConfig
from sayre_workers.tickets.reference_match import (
    InvalidTicketReferenceMatchRequestError,
    SIMILARITY_THRESHOLD,
    TicketReferenceMatcher,
    TicketReferenceMatchRequest,
    parse_ticket_reference_match_envelope,
)

ORG_ID = "org-1"


def request(**overrides: object) -> TicketReferenceMatchRequest:
    base = dict(
        org_id=ORG_ID,
        repository_id="repo-1",
        ref_name="refs/heads/main",
        provider="jira",
        external_ticket_id="PROJ-1",
        title="Fix the checkout flow",
        description="Users can't complete checkout on mobile.",
    )
    base.update(overrides)
    return TicketReferenceMatchRequest(**base)  # type: ignore[arg-type]


def envelope(**payload_overrides: object) -> MessageEnvelope:
    payload = dict(
        repository_id="repo-1",
        ref_name="refs/heads/main",
        provider="jira",
        external_ticket_id="PROJ-1",
        title="Fix the checkout flow",
        description="Users can't complete checkout on mobile.",
    )
    payload.update(payload_overrides)
    return MessageEnvelope(
        org_id=ORG_ID,
        type="ticket.reference_match",
        source="test",
        payload=payload,
    )


@dataclass
class FakeStore:
    config: EmbeddingConfig | None
    match: tuple[str, float] | None
    written: list[tuple[str, str, str, str, float]] = field(default_factory=list)
    embedded_texts: list[str] = field(default_factory=list)

    async def load_embedding_config(self, org_id: str) -> EmbeddingConfig | None:
        assert org_id == ORG_ID
        return self.config

    async def find_best_match(
        self, org_id, repository_id, provider, model, query_vector
    ) -> tuple[str, float] | None:
        assert org_id == ORG_ID
        return self.match

    async def write_inferred_reference(
        self, org_id, provider, external_ticket_id, node_id, score
    ) -> None:
        self.written.append((org_id, provider, external_ticket_id, node_id, score))


@pytest.fixture(autouse=True)
def _test_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SAYRE_ENV", "test")


def deterministic_config() -> EmbeddingConfig:
    return EmbeddingConfig(provider="deterministic_fake", model="test-model", dimension=1024)


class TestParseTicketReferenceMatchEnvelope:
    def test_parses_a_well_formed_envelope(self) -> None:
        parsed = parse_ticket_reference_match_envelope(envelope())
        assert parsed == request()

    def test_accepts_a_null_description(self) -> None:
        parsed = parse_ticket_reference_match_envelope(envelope(description=None))
        assert parsed.description is None

    def test_rejects_the_wrong_envelope_type(self) -> None:
        bad = MessageEnvelope(org_id=ORG_ID, type="ticket.inbound", source="test", payload={})
        with pytest.raises(InvalidTicketReferenceMatchRequestError):
            parse_ticket_reference_match_envelope(bad)

    @pytest.mark.parametrize("field_name", ["repository_id", "ref_name", "provider", "external_ticket_id", "title"])
    def test_rejects_a_missing_required_field(self, field_name: str) -> None:
        with pytest.raises(InvalidTicketReferenceMatchRequestError):
            parse_ticket_reference_match_envelope(envelope(**{field_name: ""}))

    def test_rejects_a_non_string_description(self) -> None:
        with pytest.raises(InvalidTicketReferenceMatchRequestError):
            parse_ticket_reference_match_envelope(envelope(description=123))


class TestTicketReferenceMatcher:
    async def test_reports_no_config_without_embedding_or_writing_anything(self) -> None:
        store = FakeStore(config=None, match=("node-1", 0.99))
        matcher = TicketReferenceMatcher(store)

        result = await matcher.process(request())

        assert result.status == "no_config"
        assert result.node_id is None
        assert store.written == []

    async def test_reports_no_candidates_when_the_repo_has_no_embeddings(self) -> None:
        store = FakeStore(config=deterministic_config(), match=None)
        matcher = TicketReferenceMatcher(store)

        result = await matcher.process(request())

        assert result.status == "no_candidates"
        assert store.written == []

    async def test_does_not_write_below_the_similarity_threshold(self) -> None:
        below = SIMILARITY_THRESHOLD - 0.01
        store = FakeStore(config=deterministic_config(), match=("node-1", below))
        matcher = TicketReferenceMatcher(store)

        result = await matcher.process(request())

        assert result.status == "below_threshold"
        assert result.node_id == "node-1"
        assert result.score == below
        assert store.written == []

    async def test_writes_the_match_at_exactly_the_threshold(self) -> None:
        store = FakeStore(config=deterministic_config(), match=("node-1", SIMILARITY_THRESHOLD))
        matcher = TicketReferenceMatcher(store)

        result = await matcher.process(request())

        assert result.status == "matched"
        assert store.written == [
            (ORG_ID, "jira", "PROJ-1", "node-1", SIMILARITY_THRESHOLD)
        ]

    async def test_writes_a_match_above_the_threshold(self) -> None:
        store = FakeStore(config=deterministic_config(), match=("node-42", 0.91))
        matcher = TicketReferenceMatcher(store)

        result = await matcher.process(request())

        assert result.status == "matched"
        assert result.node_id == "node-42"
        assert result.score == 0.91
        assert store.written == [(ORG_ID, "jira", "PROJ-1", "node-42", 0.91)]

    async def test_embeds_title_and_description_together_when_both_are_present(self) -> None:
        captured: list[list[str]] = []

        class CapturingStore(FakeStore):
            async def find_best_match(self, org_id, repository_id, provider, model, query_vector):
                return self.match

        store = CapturingStore(config=deterministic_config(), match=None)

        class CapturingFactory(EmbeddingProviderFactory):
            async def create(self, config):
                provider = await super().create(config)

                class Wrapped:
                    async def embed(self, texts):
                        captured.append(list(texts))
                        return await provider.embed(texts)

                return Wrapped()

        matcher = TicketReferenceMatcher(store, provider_factory=CapturingFactory())
        await matcher.process(request(title="Fix checkout", description="on mobile"))

        assert captured == [["Fix checkout\n\non mobile"]]

    async def test_embeds_only_the_title_when_description_is_null(self) -> None:
        captured: list[list[str]] = []
        store = FakeStore(config=deterministic_config(), match=None)

        class CapturingFactory(EmbeddingProviderFactory):
            async def create(self, config):
                provider = await super().create(config)

                class Wrapped:
                    async def embed(self, texts):
                        captured.append(list(texts))
                        return await provider.embed(texts)

                return Wrapped()

        matcher = TicketReferenceMatcher(store, provider_factory=CapturingFactory())
        await matcher.process(request(title="Fix checkout", description=None))

        assert captured == [["Fix checkout"]]

    async def test_handle_parses_the_envelope_before_processing(self) -> None:
        store = FakeStore(config=deterministic_config(), match=("node-1", 0.99))
        matcher = TicketReferenceMatcher(store)

        result = await matcher.handle(envelope())

        assert result.status == "matched"
        assert result.org_id == ORG_ID
        assert result.external_ticket_id == "PROJ-1"
