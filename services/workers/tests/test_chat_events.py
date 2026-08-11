"""CH-04 red suite — envelope parsing, the pinned chat event payloads, and the
Redis channel name CH-05 will subscribe to.

Authored by `red` from .pipeline/spec.md BEFORE any implementation exists: every
assertion here describes the spec, never a diff.

Boundary note: this file measures the *pure* half of CH-04's event contract —
what `parse_chat_turn_envelope` accepts/rejects and exactly what bytes each of
the three published messages carries. Ordering, `seq` allocation, and the
publish-vs-persist sequencing are service-level properties and live in
tests/test_chat_turn_consumer.py.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pytest
from pydantic import ValidationError

from messaging.envelope import MessageEnvelope
from sayre_workers.chat.events import (
    ChatEventPublisher,
    build_completed_event,
    build_error_event,
    build_progress_event,
    chat_event_channel,
    parse_chat_turn_envelope,
)
from sayre_workers.chat.models import (
    CHAT_EVENT_CHANNEL_PREFIX,
    USER_SAFE_MESSAGES,
    ChatAnswer,
    ChatCitation,
    ChatHistoryEntry,
    ChatTurnJob,
    ChatTurnMetrics,
    InvalidChatTurnEventError,
)

ORG_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ORG_ID = "99999999-9999-4999-8999-999999999999"
USER_ID = "22222222-2222-4222-8222-222222222222"
CONVERSATION_ID = "44444444-4444-4444-8444-444444444444"
TURN_ID = "66666666-6666-4666-8666-666666666666"
CREDENTIAL = "mcp_eph_abcd1234.ZZZ-one-time-secret-value-never-logged"
NOW = datetime(2026, 8, 10, 0, 0, 0, tzinfo=timezone.utc)


def chat_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "schema": "chat.turn.request.v1",
        "turnId": TURN_ID,
        "conversationId": CONVERSATION_ID,
        "orgId": ORG_ID,
        "userId": USER_ID,
        "question": "How does login work?",
        "scope": {"view": "technical", "anchorNodeId": "file-42"},
        "history": [{"role": "user", "content": "earlier question"}],
        "mcpCredential": CREDENTIAL,
    }
    payload.update(overrides)
    return payload


def chat_envelope(payload: dict[str, Any] | None = None, **overrides: Any) -> MessageEnvelope:
    fields: dict[str, Any] = {
        "message_id": "message-1",
        "idempotency_key": f"chat.turn:{TURN_ID}",
        "org_id": ORG_ID,
        "type": "chat.turn.request",
        "schema_version": 1,
        "source": "sayre-core-chat",
        "payload": chat_payload() if payload is None else payload,
    }
    fields.update(overrides)
    return MessageEnvelope(**fields)


def job() -> ChatTurnJob:
    return ChatTurnJob(
        org_id=ORG_ID,
        user_id=USER_ID,
        conversation_id=CONVERSATION_ID,
        turn_id=TURN_ID,
        question="How does login work?",
        view="technical",
        anchor_node_id="file-42",
        history=(ChatHistoryEntry(role="user", content="earlier question"),),
        mcp_credential=CREDENTIAL,
    )


def answer() -> ChatAnswer:
    return ChatAnswer(
        answer="# Login\n\nSee `src/auth/login.ts`.",
        citations=(
            ChatCitation(
                node_id="file-42",
                label="src/auth/login.ts",
                kind="file",
                resolved_node_id="file-42",
            ),
        ),
        metrics=ChatTurnMetrics(
            context_nodes=7,
            tokens_used=4_210,
            baseline_tokens=301_560,
            ratio=71.63,
        ),
    )


# ---------------------------------------------------------------------------
# Channel name — the CH-05 subscription contract
# ---------------------------------------------------------------------------


# @spec AC-15
def test_channel_is_the_namespaced_org_and_conversation_scoped_name() -> None:
    assert CHAT_EVENT_CHANNEL_PREFIX == "sayre:chat.events"
    assert chat_event_channel(ORG_ID, CONVERSATION_ID) == (
        f"sayre:chat.events:{ORG_ID}:{CONVERSATION_ID}"
    )
    # Two conversations in one org, and one conversation id across two orgs,
    # never collide — CH-05 re-filters per receiving client's RBAC scope and
    # needs the org segment to be structurally present.
    assert chat_event_channel(ORG_ID, "other-conversation") != chat_event_channel(
        ORG_ID, CONVERSATION_ID
    )
    assert chat_event_channel(OTHER_ORG_ID, CONVERSATION_ID) != chat_event_channel(
        ORG_ID, CONVERSATION_ID
    )


# @spec AC-15
def test_publisher_protocol_declares_exactly_publish_and_aclose() -> None:
    assert hasattr(ChatEventPublisher, "publish")
    assert hasattr(ChatEventPublisher, "aclose")


# ---------------------------------------------------------------------------
# Pinned event payloads — CH-05 binds to these byte-for-byte
# ---------------------------------------------------------------------------


# @spec AC-2
def test_progress_event_carries_exactly_the_pinned_keys_inside_a_standard_envelope() -> None:
    envelope = build_progress_event(
        job(), seq=1, kind="status", tool=None, detail="Preparing", now=NOW
    )

    assert envelope.org_id == ORG_ID
    assert envelope.type == "chat.turn.progress"
    assert envelope.schema_version == 1
    assert envelope.source == "sayre-chat-worker"
    assert envelope.trace_id is None
    assert envelope.idempotency_key == f"chat.turn.progress:{TURN_ID}:1"

    assert set(envelope.payload) == {
        "conversationId",
        "turnId",
        "seq",
        "kind",
        "tool",
        "detail",
        "ts",
    }
    assert envelope.payload["conversationId"] == CONVERSATION_ID
    assert envelope.payload["turnId"] == TURN_ID
    assert envelope.payload["seq"] == 1
    assert envelope.payload["kind"] == "status"
    assert envelope.payload["tool"] is None
    assert envelope.payload["detail"] == "Preparing"
    assert envelope.payload["ts"] == "2026-08-10T00:00:00Z"

    # The gateway's Redis reader calls assertValidEnvelope on every message.
    assert MessageEnvelope.from_body(envelope.to_body()).type == "chat.turn.progress"


# @spec AC-2
def test_tool_call_progress_event_names_the_tool_and_a_server_authored_detail() -> None:
    envelope = build_progress_event(
        job(),
        seq=2,
        kind="tool_call",
        tool="get_node_context",
        detail="node file-42",
        now=NOW,
    )

    assert envelope.idempotency_key == f"chat.turn.progress:{TURN_ID}:2"
    assert envelope.payload["kind"] == "tool_call"
    assert envelope.payload["tool"] == "get_node_context"
    assert envelope.payload["detail"] == "node file-42"
    assert envelope.payload["seq"] == 2


# @spec AC-2 AC-12
def test_completed_event_carries_the_answer_citations_and_all_four_metrics() -> None:
    envelope = build_completed_event(job(), answer(), now=NOW)

    assert envelope.type == "chat.turn.completed"
    assert envelope.org_id == ORG_ID
    assert envelope.source == "sayre-chat-worker"
    assert envelope.idempotency_key == f"chat.turn.completed:{TURN_ID}"

    assert set(envelope.payload) == {
        "conversationId",
        "turnId",
        "answer",
        "citations",
        "metrics",
        "ts",
    }
    assert "seq" not in envelope.payload
    assert envelope.payload["answer"] == "# Login\n\nSee `src/auth/login.ts`."
    assert envelope.payload["citations"] == [
        {
            "nodeId": "file-42",
            "label": "src/auth/login.ts",
            "kind": "file",
            "resolvedNodeId": "file-42",
        }
    ]
    assert envelope.payload["metrics"] == {
        "contextNodes": 7,
        "tokensUsed": 4_210,
        "baselineTokens": 301_560,
        "ratio": 71.63,
    }
    assert envelope.payload["ts"] == "2026-08-10T00:00:00Z"
    assert MessageEnvelope.from_body(envelope.to_body()).payload == envelope.payload


# @spec AC-2 AC-4
def test_error_event_carries_only_a_code_and_a_user_safe_message() -> None:
    envelope = build_error_event(
        job(),
        code="chat.provider_unavailable",
        message=USER_SAFE_MESSAGES["chat.provider_unavailable"],
        now=NOW,
    )

    assert envelope.type == "chat.turn.error"
    assert envelope.idempotency_key == f"chat.turn.error:{TURN_ID}"
    assert set(envelope.payload) == {"conversationId", "turnId", "code", "message", "ts"}
    assert "seq" not in envelope.payload
    assert envelope.payload["code"] == "chat.provider_unavailable"
    assert envelope.payload["message"] == (
        "The assistant is temporarily unavailable. Please try again in a moment."
    )


# @spec AC-4 AC-5
def test_every_error_code_has_a_user_safe_message_with_no_provider_detail() -> None:
    assert set(USER_SAFE_MESSAGES) == {
        "chat.provider_unavailable",
        "chat.context_unavailable",
        "chat.mcp_unauthorized",
        "chat.tool_budget_exhausted",
        "chat.timeout",
        "chat.internal",
    }
    for code, message in USER_SAFE_MESSAGES.items():
        assert message.strip(), code
        assert not any(
            leak in message.lower()
            for leak in ("anthropic", "openai", "http", "traceback", "bearer", "sql", "psycopg")
        ), code


# @spec AC-5 AC-16
def test_no_built_event_and_no_job_repr_can_leak_the_credential() -> None:
    subject = job()
    bodies = [
        build_progress_event(
            subject, seq=1, kind="status", tool=None, detail="Preparing", now=NOW
        ).to_body(),
        build_completed_event(subject, answer(), now=NOW).to_body(),
        build_error_event(
            subject,
            code="chat.mcp_unauthorized",
            message=USER_SAFE_MESSAGES["chat.mcp_unauthorized"],
            now=NOW,
        ).to_body(),
        repr(subject),
        str(subject),
    ]
    for body in bodies:
        assert CREDENTIAL not in body
        assert "one-time-secret-value-never-logged" not in body


# ---------------------------------------------------------------------------
# parse_chat_turn_envelope — malformed input is refused before anything runs
# ---------------------------------------------------------------------------


# @spec AC-9
def test_a_well_formed_envelope_becomes_a_job_scoped_by_the_envelope_org() -> None:
    parsed = parse_chat_turn_envelope(chat_envelope())

    assert parsed.org_id == ORG_ID
    assert parsed.user_id == USER_ID
    assert parsed.conversation_id == CONVERSATION_ID
    assert parsed.turn_id == TURN_ID
    assert parsed.question == "How does login work?"
    assert parsed.view == "technical"
    assert parsed.anchor_node_id == "file-42"
    assert parsed.history == (ChatHistoryEntry(role="user", content="earlier question"),)
    assert parsed.mcp_credential == CREDENTIAL


# @spec AC-9 EC-1
def test_a_bare_payload_without_the_standard_envelope_is_not_even_an_envelope() -> None:
    with pytest.raises((ValidationError, ValueError)):
        MessageEnvelope.from_body(json.dumps(chat_payload()))


# @spec EC-2
@pytest.mark.parametrize(
    "envelope",
    [
        chat_envelope(type="graph.updated", graph_scope_key="scope", graph_version=1),
        chat_envelope(type="chat.turn.completed"),
        chat_envelope(chat_payload(schema="chat.turn.request.v2")),
        chat_envelope(chat_payload(schema=None)),
    ],
    ids=["graph.updated", "wrong-chat-type", "wrong-payload-schema", "null-payload-schema"],
)
def test_the_wrong_event_type_or_payload_schema_is_refused(envelope: MessageEnvelope) -> None:
    with pytest.raises(InvalidChatTurnEventError):
        parse_chat_turn_envelope(envelope)


# @spec AC-9 EC-3
def test_a_payload_org_that_disagrees_with_the_envelope_org_is_refused() -> None:
    # .claude/rules/security-multitenancy.md: org_id is the envelope's, and the
    # payload's own orgId exists ONLY to be checked against it.
    with pytest.raises(InvalidChatTurnEventError):
        parse_chat_turn_envelope(chat_envelope(chat_payload(orgId=OTHER_ORG_ID)))


# @spec EC-4
@pytest.mark.parametrize("credential", [None, "", "   ", 42, ["token"]])
def test_a_missing_or_blank_mcp_credential_is_refused_rather_than_half_run(
    credential: Any,
) -> None:
    with pytest.raises(InvalidChatTurnEventError):
        parse_chat_turn_envelope(chat_envelope(chat_payload(mcpCredential=credential)))


# @spec AC-9
@pytest.mark.parametrize(
    "overrides",
    [
        {"turnId": ""},
        {"turnId": None},
        {"conversationId": "   "},
        {"userId": ""},
        {"question": "   "},
        {"orgId": ""},
        {"scope": None},
        {"scope": "technical"},
        {"scope": {"view": "technical"}},
        {"scope": {"view": "technical", "anchorNodeId": None, "extra": 1}},
        {"scope": {"view": "financial", "anchorNodeId": None}},
        {"history": None},
        {"history": "earlier"},
        {"history": [{"role": "system", "content": "x"}]},
        {"history": [{"role": "user"}]},
        {"history": [["user", "x"]]},
    ],
    ids=[
        "blank-turn-id",
        "null-turn-id",
        "blank-conversation-id",
        "blank-user-id",
        "blank-question",
        "blank-org-id",
        "null-scope",
        "string-scope",
        "scope-missing-anchor-key",
        "scope-extra-key",
        "scope-unknown-view",
        "null-history",
        "string-history",
        "history-unknown-role",
        "history-missing-content",
        "history-not-objects",
    ],
)
def test_a_structurally_malformed_payload_is_refused(overrides: dict[str, Any]) -> None:
    with pytest.raises(InvalidChatTurnEventError):
        parse_chat_turn_envelope(chat_envelope(chat_payload(**overrides)))


# @spec AC-9
def test_a_null_scope_view_and_anchor_are_accepted_as_the_absent_scope() -> None:
    parsed = parse_chat_turn_envelope(
        chat_envelope(chat_payload(scope={"view": None, "anchorNodeId": None}, history=[]))
    )

    assert parsed.view is None
    assert parsed.anchor_node_id is None
    assert parsed.history == ()
