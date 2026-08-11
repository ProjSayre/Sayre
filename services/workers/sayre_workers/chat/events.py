"""Trusted-envelope parsing for the chat-turn worker, the CH-05 Redis channel
name, and the three pinned `chat.turn.*` event builders.

`org_id` ALWAYS comes from `envelope.org_id` (server-resolved) -- a payload
`orgId` exists only to be checked against it, never trusted on its own
(`.claude/rules/security-multitenancy.md`). Mirrors
`sayre_workers.enrichment.events.parse_enrichment_envelope`'s shape.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Protocol

from messaging.envelope import MessageEnvelope

from .models import (
    CHAT_EVENT_CHANNEL_PREFIX,
    CHAT_MAX_DETAIL_CHARACTERS,
    ChatAnswer,
    ChatErrorCode,
    ChatHistoryEntry,
    ChatTurnJob,
    InvalidChatTurnEventError,
)

_TREE_VIEWS = {"technical", "product", "onboarding"}
_HISTORY_ROLES = {"user", "assistant"}


class ChatEventPublisher(Protocol):
    async def publish(self, channel: str, envelope: MessageEnvelope) -> None: ...

    async def aclose(self) -> None: ...


def chat_event_channel(org_id: str, conversation_id: str) -> str:
    """sayre:chat.events:{orgId}:{conversationId} -- the CH-05 subscription
    contract. A code constant on both sides, not a packages/config name
    (mirrors CHAT_TURNS_QUEUE's own documented rationale)."""
    return f"{CHAT_EVENT_CHANNEL_PREFIX}:{org_id}:{conversation_id}"


def _required_string(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise InvalidChatTurnEventError("chat turn payload field must be a non-blank string")
    return value


def _parse_scope(value: object) -> tuple[str | None, str | None]:
    if not isinstance(value, dict):
        raise InvalidChatTurnEventError("chat turn payload scope must be an object")
    if set(value) != {"view", "anchorNodeId"}:
        raise InvalidChatTurnEventError(
            "chat turn payload scope must have exactly view and anchorNodeId"
        )
    view = value.get("view")
    if view is not None and (not isinstance(view, str) or view not in _TREE_VIEWS):
        raise InvalidChatTurnEventError("chat turn payload scope.view is invalid")
    anchor = value.get("anchorNodeId")
    if anchor is not None and not isinstance(anchor, str):
        raise InvalidChatTurnEventError(
            "chat turn payload scope.anchorNodeId must be a string or null"
        )
    return view, anchor


def _parse_history(value: object) -> tuple[ChatHistoryEntry, ...]:
    if not isinstance(value, list):
        raise InvalidChatTurnEventError("chat turn payload history must be a list")
    entries: list[ChatHistoryEntry] = []
    for item in value:
        if not isinstance(item, dict) or set(item) != {"role", "content"}:
            raise InvalidChatTurnEventError(
                "chat turn payload history entries must be exactly {role, content}"
            )
        role = item.get("role")
        content = item.get("content")
        if role not in _HISTORY_ROLES or not isinstance(content, str):
            raise InvalidChatTurnEventError("chat turn payload history entry is invalid")
        entries.append(ChatHistoryEntry(role=role, content=content))
    return tuple(entries)


def parse_chat_turn_envelope(envelope: MessageEnvelope) -> ChatTurnJob:
    """Reject anything that is not a well-formed `chat.turn.request.v1`
    envelope. Raises `InvalidChatTurnEventError` when: `envelope.type !=
    'chat.turn.request'`; `payload.schema != 'chat.turn.request.v1'`; any of
    turnId/conversationId/orgId/userId/question is missing or blank;
    `payload.orgId != envelope.org_id`; scope is not an object with exactly
    `{view, anchorNodeId}`; history is not a list of `{role, content}`; or
    mcpCredential is not a non-blank string."""
    if envelope.type != "chat.turn.request":
        raise InvalidChatTurnEventError("chat turn envelope has the wrong type")

    payload = envelope.payload
    if not isinstance(payload, dict):
        raise InvalidChatTurnEventError("chat turn payload must be an object")
    if payload.get("schema") != "chat.turn.request.v1":
        raise InvalidChatTurnEventError("chat turn payload has the wrong schema")

    turn_id = _required_string(payload.get("turnId"))
    conversation_id = _required_string(payload.get("conversationId"))
    payload_org_id = _required_string(payload.get("orgId"))
    user_id = _required_string(payload.get("userId"))
    question = _required_string(payload.get("question"))

    # org_id is the ENVELOPE's -- the payload's own orgId exists only to be
    # checked against it (.claude/rules/security-multitenancy.md).
    if payload_org_id != envelope.org_id:
        raise InvalidChatTurnEventError(
            "chat turn payload orgId does not match the envelope org"
        )

    view, anchor_node_id = _parse_scope(payload.get("scope"))
    history = _parse_history(payload.get("history"))

    mcp_credential = payload.get("mcpCredential")
    if not isinstance(mcp_credential, str) or not mcp_credential.strip():
        raise InvalidChatTurnEventError(
            "chat turn payload mcpCredential must be a non-blank string"
        )

    return ChatTurnJob(
        org_id=envelope.org_id,
        user_id=user_id,
        conversation_id=conversation_id,
        turn_id=turn_id,
        question=question,
        view=view,  # type: ignore[arg-type]
        anchor_node_id=anchor_node_id,
        history=history,
        mcp_credential=mcp_credential,
    )


def _now_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def build_progress_event(
    job: ChatTurnJob,
    *,
    seq: int,
    kind: Literal["status", "tool_call"],
    tool: str | None,
    detail: str | None,
    now: datetime,
) -> MessageEnvelope:
    if detail is not None:
        detail = detail[:CHAT_MAX_DETAIL_CHARACTERS]
    return MessageEnvelope(
        org_id=job.org_id,
        type="chat.turn.progress",
        schema_version=1,
        source="sayre-chat-worker",
        idempotency_key=f"chat.turn.progress:{job.turn_id}:{seq}",
        payload={
            "conversationId": job.conversation_id,
            "turnId": job.turn_id,
            "seq": seq,
            "kind": kind,
            "tool": tool,
            "detail": detail,
            "ts": _now_iso(now),
        },
    )


def build_completed_event(
    job: ChatTurnJob, answer: ChatAnswer, *, now: datetime
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=job.org_id,
        type="chat.turn.completed",
        schema_version=1,
        source="sayre-chat-worker",
        idempotency_key=f"chat.turn.completed:{job.turn_id}",
        payload={
            "conversationId": job.conversation_id,
            "turnId": job.turn_id,
            "answer": answer.answer,
            "citations": [
                {
                    "nodeId": citation.node_id,
                    "label": citation.label,
                    "kind": citation.kind,
                    "resolvedNodeId": citation.resolved_node_id,
                }
                for citation in answer.citations
            ],
            "metrics": {
                "contextNodes": answer.metrics.context_nodes,
                "tokensUsed": answer.metrics.tokens_used,
                "baselineTokens": answer.metrics.baseline_tokens,
                "ratio": answer.metrics.ratio,
            },
            "ts": _now_iso(now),
        },
    )


def build_error_event(
    job: ChatTurnJob, *, code: ChatErrorCode, message: str, now: datetime
) -> MessageEnvelope:
    return MessageEnvelope(
        org_id=job.org_id,
        type="chat.turn.error",
        schema_version=1,
        source="sayre-chat-worker",
        idempotency_key=f"chat.turn.error:{job.turn_id}",
        payload={
            "conversationId": job.conversation_id,
            "turnId": job.turn_id,
            "code": code,
            "message": message,
            "ts": _now_iso(now),
        },
    )


__all__ = [
    "ChatEventPublisher",
    "build_completed_event",
    "build_error_event",
    "build_progress_event",
    "chat_event_channel",
    "parse_chat_turn_envelope",
]
