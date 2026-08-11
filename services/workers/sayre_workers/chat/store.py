"""Postgres persistence for the terminal assistant chat turn (CH-04).

Deliberately no credential column and no credential value ever reaches this
module -- AC-16 (`tests/test_chat_boundaries.py`
`test_the_persistence_layer_has_no_credential_column_at_all`). Every method
opens `org_scoped_connection` (RLS engaged, `SET LOCAL ROLE sayre_app`) and
issues exactly one parameterized statement -- never an f-string.
"""

from __future__ import annotations

import json
from typing import Any, Mapping, Protocol, Sequence

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection

from .models import CHAT_TURN_STALE_SECONDS


class ChatTurnStore(Protocol):
    async def claim_turn(self, org_id: str, turn_id: str) -> bool: ...

    async def complete_turn(
        self,
        org_id: str,
        turn_id: str,
        *,
        content: str,
        citations: Sequence[Mapping[str, Any]],
        metrics: Mapping[str, Any],
    ) -> bool: ...

    async def fail_turn(self, org_id: str, turn_id: str, *, code: str, message: str) -> bool: ...


class PostgresChatTurnStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresChatTurnStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    async def claim_turn(self, org_id: str, turn_id: str) -> bool:
        """The durable idempotency guard. One returned row means this
        delivery owns the turn; a fresh 'running' row (another in-flight
        delivery) or an already-terminal row returns False. A stale 'running'
        row (a crashed prior process) is re-claimable."""
        async with org_scoped_connection(self._dsn, org_id) as connection:
            cursor = await connection.execute(
                """
                UPDATE chat_turns SET status = 'running'
                 WHERE org_id = %s AND id = %s AND role = 'assistant'
                   AND (status = 'pending'
                        OR (status = 'running' AND updated_at < now() - make_interval(secs => %s)))
                 RETURNING id
                """,
                (org_id, turn_id, CHAT_TURN_STALE_SECONDS),
            )
            row = await cursor.fetchone()
        return row is not None

    async def complete_turn(
        self,
        org_id: str,
        turn_id: str,
        *,
        content: str,
        citations: Sequence[Mapping[str, Any]],
        metrics: Mapping[str, Any],
    ) -> bool:
        async with org_scoped_connection(self._dsn, org_id) as connection:
            cursor = await connection.execute(
                """
                UPDATE chat_turns
                   SET status = 'completed', content = %s, citations = %s::jsonb,
                       metrics = %s::jsonb, error = NULL
                 WHERE org_id = %s AND id = %s AND role = 'assistant' AND status = 'running'
                 RETURNING id
                """,
                (
                    content,
                    json.dumps(list(citations)),
                    json.dumps(dict(metrics)),
                    org_id,
                    turn_id,
                ),
            )
            row = await cursor.fetchone()
        return row is not None

    async def fail_turn(self, org_id: str, turn_id: str, *, code: str, message: str) -> bool:
        # error jsonb is exactly {"code","message"} -- no provider/SDK detail.
        async with org_scoped_connection(self._dsn, org_id) as connection:
            cursor = await connection.execute(
                """
                UPDATE chat_turns
                   SET status = 'error', content = '', error = %s::jsonb,
                       citations = NULL, metrics = NULL
                 WHERE org_id = %s AND id = %s AND role = 'assistant'
                   AND status IN ('pending', 'running')
                 RETURNING id
                """,
                (json.dumps({"code": code, "message": message}), org_id, turn_id),
            )
            row = await cursor.fetchone()
        return row is not None


__all__ = ["ChatTurnStore", "PostgresChatTurnStore"]
