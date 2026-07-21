"""Standard tenant-scoped message envelope — Python side of the shared wire contract.

This is one half of a byte-for-byte-compatible wire contract with
`services/core/src/queue/envelope.ts` (see W0-04 spec, "Standard message envelope").
Wire keys are snake_case in *both* languages: `graph.updated` is published to SNS and
delivered as the same raw body to independent SQS subscriptions, including the Node
Realtime/gateway consumer. There is one Python <-> Node JSON shape and no
camelCase/snake_case mapping layer or `orgId` vs `org_id` class of bug.

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

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, model_validator


class MessageEnvelope(BaseModel):
    """Tenant-scoped message envelope. `org_id` is required and non-empty so tenant
    context always propagates through async work (SQS today; BullMQ mirrors this
    contract for Node integration workers)."""

    model_config = ConfigDict(extra="forbid")

    message_id: str = Field(default_factory=lambda: str(uuid4()))
    org_id: str = Field(min_length=1)  # REQUIRED tenant context — never from client input
    type: str = Field(min_length=1)
    schema_version: int = Field(default=1, ge=1, strict=True)
    occurred_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    source: str = Field(min_length=1)
    trace_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = None
    graph_scope_key: str | None = None
    graph_version: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode="after")
    def validate_delivery_identity(self, info: ValidationInfo) -> "MessageEnvelope":
        """Apply the cross-language idempotency/version wire invariants."""
        for field_name in ("message_id", "org_id", "type", "source"):
            value = getattr(self, field_name)
            if not value.strip():
                raise ValueError(f"{field_name} must not be blank")

        from_wire = bool(info.context and info.context.get("wire"))
        if from_wire and (
            "idempotency_key" not in self.model_fields_set or self.idempotency_key is None
        ):
            raise ValueError("wire envelope must include idempotency_key")
        if self.idempotency_key is None:
            self.idempotency_key = self.message_id
        elif not self.idempotency_key.strip():
            raise ValueError("idempotency_key must not be blank")

        scope_present = self.graph_scope_key is not None
        version_present = self.graph_version is not None
        if from_wire and (
            ("graph_scope_key" in self.model_fields_set and self.graph_scope_key is None)
            or ("graph_version" in self.model_fields_set and self.graph_version is None)
        ):
            raise ValueError("wire graph metadata must be absent or a non-null pair")
        if scope_present != version_present:
            raise ValueError("graph_scope_key and graph_version must be supplied together")
        if self.graph_scope_key is not None and not self.graph_scope_key.strip():
            raise ValueError("graph_scope_key must not be blank")
        if self.type == "graph.updated" and not scope_present:
            raise ValueError("graph.updated requires graph_scope_key and graph_version")
        return self

    def to_body(self) -> str:
        """Serialize to the wire JSON body (snake_case keys) for SendMessage."""
        excluded = (
            {"graph_scope_key", "graph_version"}
            if self.graph_scope_key is None and self.graph_version is None
            else None
        )
        return self.model_dump_json(exclude=excluded)

    @classmethod
    def from_body(cls, raw: str) -> "MessageEnvelope":
        """Parse+validate a wire JSON body. Raises `pydantic.ValidationError` on
        malformed JSON or a missing/empty `org_id`/`type`/`source`."""
        return cls.model_validate_json(raw, context={"wire": True})
