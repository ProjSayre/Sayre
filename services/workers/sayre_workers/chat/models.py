"""Immutable contracts for CH-04's chat-turn agent loop: bounds, error codes,
and the frozen dataclasses every other `chat/*` module shares.

The ephemeral MCP credential (`ChatTurnJob.mcp_credential`) is `repr=False` so
no traceback, log record, or pytest assertion diff can ever print it -- AC-16
(`.claude/rules/security-multitenancy.md`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Mapping

# ---------------------------------------------------------------------------
# Bounds (spec.md "Python — sayre_workers/chat/models.py")
# ---------------------------------------------------------------------------

CHAT_MAX_TOOL_CALLS = 8
CHAT_TURN_DEADLINE_SECONDS = 240  # < the 300 s CH-01 default credential TTL (D6)
CHAT_TURN_STALE_SECONDS = 600  # a 'running' row older than this is re-claimable
CHAT_ANSWER_MAX_CHARACTERS = 32_000
CHAT_MAX_CITATIONS = 24
CHAT_MAX_DETAIL_CHARACTERS = 200
CHAT_MAX_MALFORMED_DECISIONS = 2
CHAT_EVENT_CHANNEL_PREFIX = "sayre:chat.events"

ChatErrorCode = Literal[
    "chat.provider_unavailable",
    "chat.context_unavailable",
    "chat.mcp_unauthorized",
    "chat.tool_budget_exhausted",
    "chat.timeout",
    "chat.internal",
]
CitationKind = Literal["file", "folder", "feature", "ticket"]
TreeView = Literal["technical", "product", "onboarding"]

# Deliberately closed-form and provider/SDK-detail-free -- these are the only
# strings a user (or an event/log consumer) ever sees for a failed turn.
USER_SAFE_MESSAGES: Mapping[ChatErrorCode, str] = {
    "chat.provider_unavailable": (
        "The assistant is temporarily unavailable. Please try again in a moment."
    ),
    "chat.context_unavailable": (
        "I could not find anything in this codebase's graph that answers that."
    ),
    "chat.mcp_unauthorized": (
        "This chat session expired before the answer finished. Please ask again."
    ),
    "chat.tool_budget_exhausted": (
        "I could not narrow that down within this turn's lookup budget. "
        "Try a more specific question."
    ),
    "chat.timeout": "That question took too long to answer. Try a more specific question.",
    "chat.internal": "Something went wrong answering that. Please try again.",
}


@dataclass(frozen=True)
class ChatHistoryEntry:
    role: Literal["user", "assistant"]
    content: str


@dataclass(frozen=True)
class ChatTurnJob:
    org_id: str  # ALWAYS envelope.org_id -- never payload-derived
    user_id: str
    conversation_id: str
    turn_id: str  # the ASSISTANT turn id
    question: str
    view: TreeView | None
    anchor_node_id: str | None
    history: tuple[ChatHistoryEntry, ...]
    # repr=False so no traceback, log record, or pytest assertion diff can ever
    # print it.
    mcp_credential: str = field(repr=False)


@dataclass(frozen=True)
class ChatCitation:
    node_id: str
    label: str
    kind: CitationKind
    resolved_node_id: str | None


@dataclass(frozen=True)
class ChatTurnMetrics:
    context_nodes: int
    tokens_used: int
    baseline_tokens: int
    ratio: float


@dataclass(frozen=True)
class ChatAnswer:
    answer: str  # markdown, <= CHAT_ANSWER_MAX_CHARACTERS
    citations: tuple[ChatCitation, ...]  # <= CHAT_MAX_CITATIONS, prompt order
    metrics: ChatTurnMetrics


class InvalidChatTurnEventError(ValueError):
    """A `chat.turn.request` envelope/payload is malformed. The caller must
    leave the SQS message undeleted so it redrives to DLQ rather than
    producing a crash loop or a half-run turn."""


class ChatTurnFailure(RuntimeError):
    """A sanitized, terminal agent-loop failure. Only the closed `code` enum is
    ever persisted, published, or logged -- never provider/SDK detail."""

    def __init__(self, code: ChatErrorCode) -> None:
        self.code = code
        self.user_message = USER_SAFE_MESSAGES[code]
        super().__init__(code)  # the CODE only -- never provider/SDK detail
