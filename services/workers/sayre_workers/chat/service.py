"""`ChatTurnService.handle(envelope)` -- the whole D5 failure posture (spec.md
"Decision: Failure posture") for one already-received `chat.turn.request`
delivery: parse -> claim -> preparing -> bounded agent run -> persist ->
publish.

This module orchestrates ONE already-parsed envelope; it must never poll,
claim an SQS message, heartbeat, or delete a message itself -- that is
`consumers.py`'s job (`messaging.sqs_client`), not this one
(`tests/test_chat_turn_consumer.py`'s
`test_the_chat_worker_never_reimplements_the_delivery_primitive`).
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from itertools import count
from typing import Any, Callable

from messaging.envelope import MessageEnvelope
from sayre_workers.model_provider import ProviderCallFailedError

from .agent import ChatAgentLoop
from .events import (
    ChatEventPublisher,
    build_completed_event,
    build_error_event,
    build_progress_event,
    chat_event_channel,
    parse_chat_turn_envelope,
)
from .mcp_client import McpTransportError, McpUnauthorizedError
from .models import CHAT_TURN_DEADLINE_SECONDS, USER_SAFE_MESSAGES, ChatErrorCode, ChatTurnFailure
from .store import ChatTurnStore

logger = logging.getLogger(__name__)


def _map_failure(error: BaseException) -> ChatErrorCode:
    if isinstance(error, ChatTurnFailure):
        return error.code
    if isinstance(error, ProviderCallFailedError):
        return "chat.provider_unavailable"
    # McpUnauthorizedError is a McpTransportError subclass -- check it first.
    if isinstance(error, McpUnauthorizedError):
        return "chat.mcp_unauthorized"
    if isinstance(error, McpTransportError):
        return "chat.context_unavailable"
    if isinstance(error, TimeoutError):
        return "chat.timeout"
    return "chat.internal"


class ChatTurnService:
    def __init__(
        self,
        *,
        store: ChatTurnStore,
        agent: ChatAgentLoop,
        publisher: ChatEventPublisher,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    ) -> None:
        self._store = store
        self._agent = agent
        self._publisher = publisher
        self._now = now

    async def handle(self, envelope: MessageEnvelope) -> None:
        # 1. Malformed input propagates -- the message is not deleted, so it
        # redrives to DLQ rather than producing a crash loop or a half-run
        # turn (EC-1..EC-4).
        job = parse_chat_turn_envelope(envelope)

        # 2. The durable idempotency guard.
        claimed = await self._store.claim_turn(job.org_id, job.turn_id)
        if not claimed:
            logger.info("chat turn %s already claimed or terminal; skipping", job.turn_id)
            return

        channel = chat_event_channel(job.org_id, job.conversation_id)
        seq_counter = count(1)

        async def publish_safely(built: MessageEnvelope) -> None:
            # 8. Every publish is individually wrapped: a Redis failure is
            # logged (channel name only, never payload) and swallowed.
            try:
                await self._publisher.publish(channel, built)
            except Exception:
                logger.warning("chat event publish failed on channel %s", channel)

        async def sink(kind: Any, tool: Any, detail: Any) -> None:
            seq = next(seq_counter)
            await publish_safely(
                build_progress_event(
                    job, seq=seq, kind=kind, tool=tool, detail=detail, now=self._now()
                )
            )

        # 3. seq=1 'status' 'Preparing', allocated by THIS service.
        await sink("status", None, "Preparing")

        try:
            async with asyncio.timeout(CHAT_TURN_DEADLINE_SECONDS):
                answer = await self._agent.run(job, sink)
        except Exception as error:
            code = _map_failure(error)
            message = USER_SAFE_MESSAGES[code]
            # 6/7: persistence precedes the terminal publish; if fail_turn
            # itself raises, that propagates (message not deleted -> redrive).
            await self._store.fail_turn(job.org_id, job.turn_id, code=code, message=message)
            await publish_safely(
                build_error_event(job, code=code, message=message, now=self._now())
            )
            return

        # 5. Persistence precedes the terminal publish, so no event ever
        # announces a state that is not durable.
        await self._store.complete_turn(
            job.org_id,
            job.turn_id,
            content=answer.answer,
            citations=[
                {
                    "nodeId": citation.node_id,
                    "label": citation.label,
                    "kind": citation.kind,
                    "resolvedNodeId": citation.resolved_node_id,
                }
                for citation in answer.citations
            ],
            metrics={
                "contextNodes": answer.metrics.context_nodes,
                "tokensUsed": answer.metrics.tokens_used,
                "baselineTokens": answer.metrics.baseline_tokens,
                "ratio": answer.metrics.ratio,
            },
        )
        await publish_safely(build_completed_event(job, answer, now=self._now()))

    async def aclose(self) -> None:
        await self._publisher.aclose()


__all__ = ["ChatTurnService"]
