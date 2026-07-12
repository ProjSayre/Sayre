"""Standard tenant-scoped message envelope — Python side of the shared wire contract.

This is one half of a byte-for-byte-compatible wire contract with
`services/core/src/queue/envelope.ts` (see W0-04 spec, "Standard message envelope").
Wire keys are snake_case in *both* languages: `graph.updated` is published here (SQS)
and later consumed by the Node Realtime/gateway service, so there is a single JSON
shape to reason about across the Python <-> Node boundary — no camelCase/snake_case
mapping layer, no `orgId` vs `org_id` class of bug.

Tenant-context invariant (`.claude/rules/security-multitenancy.md`): `org_id` is
REQUIRED and non-empty on every envelope. It must be resolved server-side (e.g. from
the installation/account -> org mapping in Postgres) and must NEVER be copied verbatim
from an untrusted webhook body. Callers that originate from a webhook MUST
HMAC/signature-validate the payload before constructing an envelope and calling
`publish()` — this module is the enforcement point (a `MessageEnvelope` cannot exist
without `org_id`), not the webhook receiver itself (out of scope for this ticket).
"""

from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class MessageEnvelope(BaseModel):
    """Tenant-scoped message envelope. `org_id` is required and non-empty so tenant
    context always propagates through async work (SQS today; BullMQ mirrors this
    contract for Node integration workers)."""

    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(default_factory=lambda: str(uuid4()))
    org_id: str = Field(min_length=1)  # REQUIRED tenant context — never from client input
    type: str = Field(min_length=1)
    schema_version: int = 1
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = Field(min_length=1)
    trace_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)

    def to_body(self) -> str:
        """Serialize to the wire JSON body (snake_case keys) for SendMessage."""
        return self.model_dump_json()

    @classmethod
    def from_body(cls, raw: str) -> "MessageEnvelope":
        """Parse+validate a wire JSON body. Raises `pydantic.ValidationError` on
        malformed JSON or a missing/empty `org_id`/`type`/`source`."""
        return cls.model_validate_json(raw)
