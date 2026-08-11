"""CH-04 red suite — the chat-turn consumer: one well-formed delivery answered
end to end, durable idempotency, the D5 failure posture (what is deleted and what
is redriven), and the persist-then-publish ordering.

Authored by `red` from .pipeline/spec.md BEFORE any implementation exists.

Network-free apart from a loopback HTTP server that speaks Core's real MCP
streamable-HTTP wire protocol (tests/test_chat_mcp_client.py's FakeMcpGateway),
so AC-1's "a tools/call that actually crossed the MCP client" is literal rather
than mocked. SQS is the same FakeSQS/FakeStore shape tests/test_sqs_delivery.py
already uses.
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Mapping, Sequence

import httpx
import pytest

from messaging import sqs_client
from messaging.envelope import MessageEnvelope
from sayre_workers.chat import service as chat_service_module
from sayre_workers.chat.agent import ChatAgentLoop
from sayre_workers.chat.consumers import run_chat_turn_consumer
from sayre_workers.chat.events import chat_event_channel
from sayre_workers.chat.mcp_client import (
    McpTransportError,
    McpUnauthorizedError,
    StreamableHttpMcpClient,
)
from sayre_workers.chat.models import (
    CHAT_ANSWER_MAX_CHARACTERS,
    CHAT_TURN_DEADLINE_SECONDS,
    CHAT_TURN_STALE_SECONDS,
    USER_SAFE_MESSAGES,
    ChatAnswer,
    ChatCitation,
    ChatTurnFailure,
    ChatTurnJob,
    ChatTurnMetrics,
)
from sayre_workers.chat.service import ChatTurnService
from sayre_workers.model_provider import ProviderCallFailedError
from tests.test_chat_agent_loop import (
    FakeBaselineStore,
    FakeConfigStore,
    FakeProviderFactory,
    RecordingTokenUsage,
    ScriptedProvider,
    call,
    graph_node,
)
from tests.test_chat_events import (
    CONVERSATION_ID,
    CREDENTIAL,
    NOW,
    ORG_ID,
    OTHER_ORG_ID,
    TURN_ID,
    chat_envelope,
    chat_payload,
)
from tests.test_chat_mcp_client import FakeMcpGateway

STORE_MODULE = Path(__file__).parents[1] / "sayre_workers" / "chat" / "store.py"
SERVICE_MODULE = Path(__file__).parents[1] / "sayre_workers" / "chat" / "service.py"
SECOND_TURN_ID = "77777777-7777-4777-8777-777777777777"

ANSWER = ChatAnswer(
    answer="# Login\n\nSee `src/auth/login.ts`.",
    citations=(
        ChatCitation(
            node_id="file-1",
            label="src/auth/login.ts",
            kind="file",
            resolved_node_id="file-1",
        ),
    ),
    metrics=ChatTurnMetrics(
        context_nodes=1, tokens_used=4_210, baseline_tokens=301_560, ratio=71.63
    ),
)


# ---------------------------------------------------------------------------
# Broker + store + publisher fakes (FakeSQS/FakeStore mirror test_sqs_delivery)
# ---------------------------------------------------------------------------


class FakeStore:
    def __init__(self, status: str = "acquired", renew_result: bool = True) -> None:
        self.status = status
        self.renew_result = renew_result
        self.claims: list[tuple[str, str, str]] = []
        self.renewals = 0
        self.completions = 0
        self.releases = 0

    def claim(self, consumer_id, key, owner, _lease, **_kwargs):  # noqa: ANN001, ANN201
        self.claims.append((consumer_id, key, owner))
        return self.status

    def renew(self, _consumer_id, _key, _owner, _lease):  # noqa: ANN001, ANN201
        self.renewals += 1
        return self.renew_result

    def complete(self, _consumer_id, _key, _owner):  # noqa: ANN001, ANN201
        self.completions += 1
        return True

    def release(self, _consumer_id, _key, _owner):  # noqa: ANN001, ANN201
        self.releases += 1


class FakeSQS:
    def __init__(
        self,
        envelope: MessageEnvelope | None = None,
        raw_body: str | None = None,
    ) -> None:
        self.envelope = envelope
        self.raw_body = raw_body
        self.receives: list[dict[str, object]] = []
        self.visibility_changes = 0
        self.deletes = 0

    def receive_message(self, **kwargs: Any) -> dict[str, Any]:
        self.receives.append(kwargs)
        if self.raw_body is not None:
            body = self.raw_body
            self.raw_body = None
        elif self.envelope is not None:
            body = self.envelope.to_body()
            self.envelope = None
        else:
            return {}
        return {
            "Messages": [
                {"MessageId": "broker-1", "ReceiptHandle": "receipt-1", "Body": body}
            ]
        }

    def change_message_visibility(self, **_kwargs: Any) -> None:
        self.visibility_changes += 1

    def delete_message(self, **_kwargs: Any) -> None:
        self.deletes += 1


class RecordingChatTurnStore:
    def __init__(
        self,
        *,
        claims: Sequence[bool] | bool = True,
        complete_error: BaseException | None = None,
        fail_error: BaseException | None = None,
    ) -> None:
        self._claims = list(claims) if isinstance(claims, (list, tuple)) else claims
        self.complete_error = complete_error
        self.fail_error = fail_error
        self.claim_calls: list[tuple[str, str]] = []
        self.completed: list[dict[str, Any]] = []
        self.failed: list[dict[str, Any]] = []

    async def claim_turn(self, org_id: str, turn_id: str) -> bool:
        self.claim_calls.append((org_id, turn_id))
        if isinstance(self._claims, list):
            return self._claims.pop(0) if self._claims else False
        return bool(self._claims)

    async def complete_turn(
        self,
        org_id: str,
        turn_id: str,
        *,
        content: str,
        citations: Sequence[Mapping[str, Any]],
        metrics: Mapping[str, Any],
    ) -> bool:
        if self.complete_error is not None:
            raise self.complete_error
        self.completed.append(
            {
                "org_id": org_id,
                "turn_id": turn_id,
                "content": content,
                "citations": [dict(citation) for citation in citations],
                "metrics": dict(metrics),
            }
        )
        return True

    async def fail_turn(
        self, org_id: str, turn_id: str, *, code: str, message: str
    ) -> bool:
        if self.fail_error is not None:
            raise self.fail_error
        self.failed.append(
            {"org_id": org_id, "turn_id": turn_id, "code": code, "message": message}
        )
        return True


class RecordingPublisher:
    def __init__(self, *, fail_on: Sequence[str] = ()) -> None:
        self.fail_on = set(fail_on)
        self.published: list[tuple[str, MessageEnvelope]] = []
        self.closed = 0

    async def publish(self, channel: str, envelope: MessageEnvelope) -> None:
        if envelope.type in self.fail_on:
            raise RuntimeError("redis is unavailable at 10.0.0.5:6379")
        self.published.append((channel, envelope))

    async def aclose(self) -> None:
        self.closed += 1

    def types(self) -> list[str]:
        return [envelope.type for _channel, envelope in self.published]

    def payloads(self, event_type: str) -> list[dict[str, Any]]:
        return [
            envelope.payload
            for _channel, envelope in self.published
            if envelope.type == event_type
        ]


class StubAgent:
    """Stands in for ChatAgentLoop wherever the loop itself is not under test."""

    def __init__(
        self,
        *,
        answer: ChatAnswer | None = None,
        error: BaseException | None = None,
        errors_by_turn: Mapping[str, BaseException] | None = None,
        delay_seconds: float = 0.0,
    ) -> None:
        self.answer = answer if answer is not None else ANSWER
        self.error = error
        self.errors_by_turn = dict(errors_by_turn or {})
        self.delay_seconds = delay_seconds
        self.runs: list[ChatTurnJob] = []

    async def run(self, job: ChatTurnJob, progress: Any) -> ChatAnswer:
        self.runs.append(job)
        await progress("tool_call", "find_relevant_nodes", None)
        if self.delay_seconds:
            await asyncio.sleep(self.delay_seconds)
        failure = self.errors_by_turn.get(job.turn_id, self.error)
        if failure is not None:
            raise failure
        return self.answer


def build_service(
    store: RecordingChatTurnStore,
    agent: Any,
    publisher: RecordingPublisher,
) -> ChatTurnService:
    return ChatTurnService(store=store, agent=agent, publisher=publisher, now=lambda: NOW)


def deliver(
    monkeypatch: pytest.MonkeyPatch,
    service: ChatTurnService,
    *,
    envelope: MessageEnvelope | None = None,
    raw_body: str | None = None,
    delivery_store: FakeStore | None = None,
) -> tuple[FakeSQS, FakeStore, int]:
    fake = FakeSQS(envelope=envelope, raw_body=raw_body)
    claims = delivery_store if delivery_store is not None else FakeStore()
    monkeypatch.setattr(sqs_client, "get_queue_url", lambda _name: "queue-url")
    monkeypatch.setattr(sqs_client, "get_client", lambda: fake)

    def handle(received: MessageEnvelope) -> None:
        asyncio.run(service.handle(received))

    handled = sqs_client.consume_once(
        sqs_client.CHAT_TURNS_QUEUE,
        handle,
        consumer_id="chat-turn-worker",
        delivery_store=claims,
        visibility_timeout_seconds=2,
        heartbeat_interval_seconds=0.2,
    )
    return fake, claims, handled


# ---------------------------------------------------------------------------
# AC-1 / AC-2 — one delivery, answered end to end
# ---------------------------------------------------------------------------


# @spec AC-1 AC-2
def test_one_well_formed_delivery_is_answered_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with FakeMcpGateway() as gateway:
        gateway.tool_data["find_relevant_nodes"] = [graph_node("file-1")]
        gateway.tool_data["get_node_context"] = {"node": graph_node("file-1")}
        provider = ScriptedProvider(decisions=[call("get_node_context", node_id="file-1")])

        @asynccontextmanager
        async def factory(job: ChatTurnJob) -> AsyncIterator[StreamableHttpMcpClient]:
            async with httpx.AsyncClient() as http:
                client = StreamableHttpMcpClient(
                    endpoint_url=gateway.url,
                    bearer_token=job.mcp_credential,
                    client=http,
                )
                try:
                    yield client
                finally:
                    await client.aclose()

        agent = ChatAgentLoop(
            mcp_client_factory=factory,
            config_store=FakeConfigStore(),
            provider_factory=FakeProviderFactory(provider),
            baseline_store=FakeBaselineStore(),
            token_usage=RecordingTokenUsage(),
        )
        store = RecordingChatTurnStore()
        publisher = RecordingPublisher()
        fake, claims, handled = deliver(
            monkeypatch, build_service(store, agent, publisher), envelope=chat_envelope()
        )

        # A tools/call genuinely crossed the MCP client, carrying the payload's
        # own ephemeral credential as the bearer.
        assert gateway.tool_calls()
        assert set(gateway.authorizations()) == {f"Bearer {CREDENTIAL}"}

    assert handled == 1
    assert fake.deletes == 1
    assert claims.completions == 1

    assert len(store.completed) == 1
    row = store.completed[0]
    assert row["org_id"] == ORG_ID
    assert row["turn_id"] == TURN_ID
    assert row["content"].strip()
    assert len(row["citations"]) >= 1
    assert set(row["citations"][0]) == {"nodeId", "label", "kind", "resolvedNodeId"}
    assert set(row["metrics"]) == {"contextNodes", "tokensUsed", "baselineTokens", "ratio"}
    assert store.failed == []

    # AC-2: every message is on the pinned channel, progress precedes the
    # terminal event, seq starts at 1 and strictly increases, terminal has none.
    channel = chat_event_channel(ORG_ID, CONVERSATION_ID)
    assert {name for name, _envelope in publisher.published} == {channel}
    types = publisher.types()
    assert types[-1] == "chat.turn.completed"
    assert types.count("chat.turn.completed") == 1
    assert all(kind == "chat.turn.progress" for kind in types[:-1])
    seqs = [payload["seq"] for payload in publisher.payloads("chat.turn.progress")]
    assert seqs[0] == 1
    assert seqs == sorted(seqs)
    assert len(set(seqs)) == len(seqs)
    assert publisher.payloads("chat.turn.progress")[0]["detail"] == "Preparing"
    assert "seq" not in publisher.payloads("chat.turn.completed")[0]


# @spec AC-1 AC-5
def test_a_wrong_bearer_is_rejected_by_the_gateway_and_becomes_an_unauthorized_turn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    expired = "mcp_eph_stale00.EXPIRED-one-time-secret-never-logged"

    with FakeMcpGateway() as gateway:
        gateway.tool_data["find_relevant_nodes"] = [graph_node("file-1")]
        provider = ScriptedProvider()

        @asynccontextmanager
        async def factory(job: ChatTurnJob) -> AsyncIterator[StreamableHttpMcpClient]:
            async with httpx.AsyncClient() as http:
                client = StreamableHttpMcpClient(
                    endpoint_url=gateway.url,
                    bearer_token=job.mcp_credential,
                    client=http,
                )
                try:
                    yield client
                finally:
                    await client.aclose()

        agent = ChatAgentLoop(
            mcp_client_factory=factory,
            config_store=FakeConfigStore(),
            provider_factory=FakeProviderFactory(provider),
            baseline_store=FakeBaselineStore(),
            token_usage=RecordingTokenUsage(),
        )
        store = RecordingChatTurnStore()
        publisher = RecordingPublisher()
        fake, _claims, handled = deliver(
            monkeypatch,
            build_service(store, agent, publisher),
            envelope=chat_envelope(chat_payload(mcpCredential=expired)),
        )

    # No exception escaped `handle`: the delivery completed and was deleted.
    assert handled == 1
    assert fake.deletes == 1
    assert store.completed == []
    assert [row["code"] for row in store.failed] == ["chat.mcp_unauthorized"]
    assert store.failed[0]["message"] == USER_SAFE_MESSAGES["chat.mcp_unauthorized"]
    assert publisher.types()[-1] == "chat.turn.error"

    rendered = "\n".join(
        [caplog.text, json.dumps(store.failed), json.dumps(store.completed)]
        + [envelope.to_body() for _channel, envelope in publisher.published]
    )
    assert expired not in rendered
    assert "EXPIRED-one-time-secret-never-logged" not in rendered
    assert provider.generate_calls == []


# ---------------------------------------------------------------------------
# AC-3 / EC-5 / EC-6 / EC-7 — durable idempotency
# ---------------------------------------------------------------------------


# @spec AC-3
def test_a_duplicate_delivery_blocked_by_claim_turn_runs_the_loop_zero_more_times(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore(claims=[True, False])
    agent = StubAgent()
    publisher = RecordingPublisher()
    service = build_service(store, agent, publisher)

    first_sqs, _first_claims, first_handled = deliver(
        monkeypatch, service, envelope=chat_envelope()
    )
    second_sqs, _second_claims, second_handled = deliver(
        monkeypatch, service, envelope=chat_envelope()
    )

    assert len(agent.runs) == 1
    assert len(store.claim_calls) == 2
    assert len(store.completed) == 1
    assert publisher.types().count("chat.turn.completed") == 1
    assert (first_handled, second_handled) == (1, 1)
    assert (first_sqs.deletes, second_sqs.deletes) == (1, 1)


# @spec AC-3
def test_a_duplicate_delivery_blocked_by_the_delivery_store_never_reaches_the_handler(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore()
    agent = StubAgent()
    publisher = RecordingPublisher()
    service = build_service(store, agent, publisher)

    fake, _claims, handled = deliver(
        monkeypatch,
        service,
        envelope=chat_envelope(),
        delivery_store=FakeStore(status="completed"),
    )

    assert handled == 1
    assert fake.deletes == 1
    assert agent.runs == []
    assert store.claim_calls == []
    assert publisher.published == []


# @spec EC-5 EC-6
def test_an_already_terminal_or_deleted_turn_publishes_nothing_and_is_acknowledged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore(claims=False)
    agent = StubAgent()
    publisher = RecordingPublisher()

    fake, claims, handled = deliver(
        monkeypatch, build_service(store, agent, publisher), envelope=chat_envelope()
    )

    assert store.claim_calls == [(ORG_ID, TURN_ID)]
    assert agent.runs == []
    assert publisher.published == []
    assert store.completed == [] and store.failed == []
    assert handled == 1
    assert fake.deletes == 1
    assert claims.completions == 1


# @spec EC-7
def test_a_duplicate_arriving_while_the_first_is_running_is_left_for_redelivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore()
    agent = StubAgent()
    publisher = RecordingPublisher()

    fake, _claims, handled = deliver(
        monkeypatch,
        build_service(store, agent, publisher),
        envelope=chat_envelope(),
        delivery_store=FakeStore(status="busy"),
    )

    assert handled == 0
    assert fake.deletes == 0
    assert agent.runs == []
    assert store.claim_calls == []


# @spec EC-7
def test_the_durable_claim_statement_reclaims_only_a_stale_running_row() -> None:
    source = STORE_MODULE.read_text(encoding="utf-8")

    assert CHAT_TURN_STALE_SECONDS == 600
    assert "role = 'assistant'" in source
    assert "status = 'pending'" in source
    assert "make_interval(secs =>" in source
    assert "updated_at <" in source
    assert "status = 'completed'" in source
    assert "status = 'error'" in source
    assert "RETURNING id" in source

    tree = ast.parse(source, filename=str(STORE_MODULE))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "execute"
            and node.args
        ):
            assert not isinstance(node.args[0], ast.JoinedStr), "SQL must not use f-strings"


# ---------------------------------------------------------------------------
# AC-4 / EC-11 / EC-16 — the D5 failure posture
# ---------------------------------------------------------------------------


# @spec AC-4 EC-11
def test_a_provider_failure_is_terminal_deleted_and_does_not_poison_the_next_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore()
    agent = StubAgent(
        errors_by_turn={TURN_ID: ProviderCallFailedError("circuit_open", "fail")}
    )
    publisher = RecordingPublisher()
    service = build_service(store, agent, publisher)

    failing_sqs, _claims, failing_handled = deliver(
        monkeypatch, service, envelope=chat_envelope()
    )

    assert failing_handled == 1
    assert failing_sqs.deletes == 1  # deleted, never redriven at a paid provider
    assert [row["code"] for row in store.failed] == ["chat.provider_unavailable"]
    assert store.failed[0]["message"] == USER_SAFE_MESSAGES["chat.provider_unavailable"]
    errors = publisher.payloads("chat.turn.error")
    assert len(errors) == 1
    assert errors[0]["code"] == "chat.provider_unavailable"
    assert errors[0]["message"] == USER_SAFE_MESSAGES["chat.provider_unavailable"]
    assert store.completed == []

    other = chat_envelope(
        chat_payload(turnId=SECOND_TURN_ID, conversationId=CONVERSATION_ID),
        idempotency_key=f"chat.turn:{SECOND_TURN_ID}",
        message_id="message-2",
    )
    healthy_sqs, _other_claims, healthy_handled = deliver(
        monkeypatch, service, envelope=other
    )

    assert healthy_handled == 1
    assert healthy_sqs.deletes == 1
    assert [row["turn_id"] for row in store.completed] == [SECOND_TURN_ID]
    assert publisher.types().count("chat.turn.completed") == 1


# @spec AC-4
@pytest.mark.parametrize(
    ("failure", "code"),
    [
        (ProviderCallFailedError("upstream_error", "fail"), "chat.provider_unavailable"),
        (McpUnauthorizedError("refused"), "chat.mcp_unauthorized"),
        (McpTransportError("transport"), "chat.context_unavailable"),
        (TimeoutError(), "chat.timeout"),
        (ChatTurnFailure("chat.tool_budget_exhausted"), "chat.tool_budget_exhausted"),
        (RuntimeError("psycopg: connection to 10.0.0.5:5432 refused"), "chat.internal"),
    ],
    ids=[
        "provider",
        "mcp-401",
        "mcp-transport",
        "deadline",
        "tool-budget",
        "unclassified",
    ],
)
def test_every_agent_failure_maps_to_a_user_safe_code_and_deletes_the_message(
    monkeypatch: pytest.MonkeyPatch, failure: BaseException, code: str
) -> None:
    store = RecordingChatTurnStore()
    publisher = RecordingPublisher()
    fake, _claims, handled = deliver(
        monkeypatch,
        build_service(store, StubAgent(error=failure), publisher),
        envelope=chat_envelope(),
    )

    assert handled == 1
    assert fake.deletes == 1
    assert [row["code"] for row in store.failed] == [code]
    assert store.failed[0]["message"] == USER_SAFE_MESSAGES[code]
    assert publisher.payloads("chat.turn.error")[0]["code"] == code
    # Never any provider/SDK/DSN detail on the user-visible path.
    rendered = json.dumps(store.failed) + json.dumps(publisher.payloads("chat.turn.error"))
    assert "psycopg" not in rendered
    assert "10.0.0.5" not in rendered


# @spec EC-16
def test_the_turn_deadline_fires_before_the_credential_ttl_can_expire() -> None:
    assert CHAT_TURN_DEADLINE_SECONDS == 240
    assert CHAT_TURN_DEADLINE_SECONDS < 300  # the CH-01 default credential TTL

    source = SERVICE_MODULE.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(SERVICE_MODULE))
    timeouts = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "timeout"
    ]
    assert timeouts, "ChatTurnService must bound the agent run with asyncio.timeout"
    assert any(
        "CHAT_TURN_DEADLINE_SECONDS" in ast.unparse(node) for node in timeouts
    ), ast.unparse(tree)


# ---------------------------------------------------------------------------
# AC-9 / EC-1 / EC-2 / EC-3 — malformed input is redriven, never half-run
# ---------------------------------------------------------------------------


# @spec AC-9 EC-1
def test_a_bare_payload_without_the_envelope_wrapper_is_not_deleted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore()
    agent = StubAgent()
    publisher = RecordingPublisher()

    fake, _claims, handled = deliver(
        monkeypatch,
        build_service(store, agent, publisher),
        raw_body=json.dumps(chat_payload()),
    )

    assert handled == 0
    assert fake.deletes == 0
    assert agent.runs == []
    assert store.claim_calls == []
    assert publisher.published == []


# @spec AC-9 EC-2 EC-3
@pytest.mark.parametrize(
    "envelope",
    [
        chat_envelope(type="chat.turn.completed"),
        chat_envelope(chat_payload(schema="chat.turn.request.v2")),
        chat_envelope(chat_payload(orgId=OTHER_ORG_ID)),
        chat_envelope(chat_payload(mcpCredential=None)),
    ],
    ids=["wrong-type", "wrong-schema", "cross-org-payload", "pre-ch04-replay"],
)
def test_a_malformed_chat_turn_event_is_refused_before_any_side_effect(
    monkeypatch: pytest.MonkeyPatch, envelope: MessageEnvelope
) -> None:
    store = RecordingChatTurnStore()
    agent = StubAgent()
    publisher = RecordingPublisher()

    fake, claims, handled = deliver(
        monkeypatch, build_service(store, agent, publisher), envelope=envelope
    )

    assert handled == 0
    assert fake.deletes == 0  # left for redrive -> DLQ
    assert claims.releases == 1
    assert agent.runs == []
    assert store.claim_calls == []
    assert store.completed == [] and store.failed == []
    assert publisher.published == []


# ---------------------------------------------------------------------------
# EC-17 / EC-18 / EC-19 / EC-20 — publish failures vs. persistence failures
# ---------------------------------------------------------------------------


# @spec EC-17
def test_a_redis_failure_on_a_progress_event_never_changes_the_persisted_turn(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    store = RecordingChatTurnStore()
    publisher = RecordingPublisher(fail_on=("chat.turn.progress",))

    fake, _claims, handled = deliver(
        monkeypatch,
        build_service(store, StubAgent(), publisher),
        envelope=chat_envelope(),
    )

    assert handled == 1
    assert fake.deletes == 1
    assert len(store.completed) == 1
    assert publisher.types() == ["chat.turn.completed"]
    # The log names the channel, never the payload or the credential.
    assert CREDENTIAL not in caplog.text
    assert "How does login work?" not in caplog.text


# @spec EC-18
def test_a_redis_failure_on_the_terminal_event_still_leaves_a_durable_terminal_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore()
    publisher = RecordingPublisher(fail_on=("chat.turn.completed",))

    fake, _claims, handled = deliver(
        monkeypatch,
        build_service(store, StubAgent(), publisher),
        envelope=chat_envelope(),
    )

    assert handled == 1
    assert fake.deletes == 1
    assert len(store.completed) == 1
    assert "chat.turn.completed" not in publisher.types()


# @spec EC-19
def test_a_postgres_failure_leaves_the_message_undeleted_for_redrive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = RecordingChatTurnStore(
        complete_error=RuntimeError("connection to server at 10.0.0.5:5432 failed")
    )
    publisher = RecordingPublisher()

    fake, claims, handled = deliver(
        monkeypatch,
        build_service(store, StubAgent(), publisher),
        envelope=chat_envelope(),
    )

    assert handled == 0
    assert fake.deletes == 0
    assert claims.releases == 1
    assert claims.completions == 0
    assert "chat.turn.completed" not in publisher.types()


# @spec EC-20
def test_the_persisted_answer_and_the_published_answer_are_byte_identical(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    truncated = "# Login\n" + "a" * (CHAT_ANSWER_MAX_CHARACTERS - len("# Login\n"))
    answer = ChatAnswer(
        answer=truncated, citations=ANSWER.citations, metrics=ANSWER.metrics
    )
    store = RecordingChatTurnStore()
    publisher = RecordingPublisher()

    deliver(
        monkeypatch,
        build_service(store, StubAgent(answer=answer), publisher),
        envelope=chat_envelope(),
    )

    assert len(store.completed[0]["content"]) == CHAT_ANSWER_MAX_CHARACTERS
    assert store.completed[0]["content"] == publisher.payloads("chat.turn.completed")[0]["answer"]


# ---------------------------------------------------------------------------
# AC-10 — the consumer inherits the fleet's DLQ/heartbeat/claim posture
# ---------------------------------------------------------------------------


# @spec AC-10
def test_run_chat_turn_consumer_drives_the_shared_consume_primitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, Any] = {}
    ran: list[str] = []

    class ClosingService:
        async def handle(self, envelope: MessageEnvelope) -> None:
            ran.append(envelope.message_id)

        async def aclose(self) -> None:
            ran.append("closed")

    def fake_consume(queue_name: str, handler: Any, **kwargs: Any) -> None:
        recorded["queue"] = queue_name
        recorded["kwargs"] = kwargs
        handler(chat_envelope())

    monkeypatch.setattr("sayre_workers.chat.consumers.consume", fake_consume)
    stop_event = threading.Event()
    delivery_store = FakeStore()

    run_chat_turn_consumer(
        ClosingService(),  # type: ignore[arg-type]
        delivery_store,  # type: ignore[arg-type]
        stop_event=stop_event,
        visibility_timeout_seconds=120,
    )

    assert recorded["queue"] == sqs_client.CHAT_TURNS_QUEUE == "chat-turns.fifo"
    assert recorded["kwargs"]["consumer_id"] == "chat-turn-worker"
    assert recorded["kwargs"]["delivery_store"] is delivery_store
    assert recorded["kwargs"]["visibility_timeout_seconds"] == 120
    assert recorded["kwargs"]["stop_event"] is stop_event
    # The sync handler drove the async service inside an asyncio.Runner, and the
    # service was closed when polling stopped -- the run_enrichment_consumer shape.
    assert ran == ["message-1", "closed"]


# @spec AC-10
def test_the_consumer_closes_the_service_even_when_polling_stops_with_an_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[bool] = []

    class ClosingService:
        async def handle(self, _envelope: MessageEnvelope) -> None:
            return None

        async def aclose(self) -> None:
            closed.append(True)

    def failing_consume(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError("simulated broker stop")

    monkeypatch.setattr("sayre_workers.chat.consumers.consume", failing_consume)

    with pytest.raises(RuntimeError, match="simulated broker stop"):
        run_chat_turn_consumer(ClosingService(), FakeStore())  # type: ignore[arg-type]

    assert closed == [True]


# @spec AC-10
def test_the_chat_worker_never_reimplements_the_delivery_primitive() -> None:
    def imports(path: Path) -> set[str]:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        found: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                found.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module is not None:
                found.add(node.module)
        return found

    consumers_module = SERVICE_MODULE.parent / "consumers.py"
    assert "messaging.sqs_client" in imports(consumers_module)
    # The service orchestrates one already-parsed envelope; it must not poll,
    # claim, heartbeat, or delete a message itself.
    service_imports = imports(SERVICE_MODULE)
    assert "boto3" not in service_imports
    assert "messaging.sqs_client" not in service_imports
    assert chat_service_module.ChatTurnService is ChatTurnService
