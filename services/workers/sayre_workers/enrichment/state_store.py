"""Tenant-scoped persistence for the minimal provider-job visibility contract."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import psycopg

from sayre_workers.config import get_secret
from sayre_workers.ingestion.models import GraphScope

ProviderJobSurface = Literal["product", "onboarding", "chatbot"]
ProviderJobStatus = Literal["generating", "ready", "degraded", "failed"]
ProviderJobReason = Literal[
    "timeout",
    "circuit_open",
    "provider_error",
    "retry_exhausted",
    "processing_error",
]

_SURFACES = frozenset({"product", "onboarding", "chatbot"})
_STATUSES = frozenset({"generating", "ready", "degraded", "failed"})
_REASONS = frozenset(
    {
        "timeout",
        "circuit_open",
        "provider_error",
        "retry_exhausted",
        "processing_error",
    }
)


class InvalidProviderJobStateError(ValueError):
    """A caller attempted to leave the closed visible-state contract."""


class ProviderJobStateStoreError(RuntimeError):
    """Sanitized persistence failure; the job must fail rather than ack invisibly."""


@dataclass(frozen=True)
class ProviderJobState:
    scope: GraphScope
    surface: ProviderJobSurface
    status: ProviderJobStatus
    reason_code: ProviderJobReason | None = None

    def __post_init__(self) -> None:
        if self.surface not in _SURFACES:
            raise InvalidProviderJobStateError("unsupported provider job surface")
        if self.status not in _STATUSES:
            raise InvalidProviderJobStateError("unsupported provider job status")
        if self.reason_code is not None and self.reason_code not in _REASONS:
            raise InvalidProviderJobStateError("unsupported provider job reason")
        if self.status in {"generating", "ready"} and self.reason_code is not None:
            raise InvalidProviderJobStateError(
                "generating and ready provider states cannot have a reason"
            )
        if self.status in {"degraded", "failed"} and self.reason_code is None:
            raise InvalidProviderJobStateError(
                "degraded and failed provider states require a reason"
            )


class ProviderJobStateStore(Protocol):
    async def set_state(self, state: ProviderJobState) -> None: ...


class PostgresProviderJobStateStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresProviderJobStateStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    async def set_state(self, state: ProviderJobState) -> None:
        try:
            connection = await psycopg.AsyncConnection.connect(self._dsn)
            async with connection:
                async with connection.transaction():
                    # Transaction-local tenant context prevents a pooled/reused
                    # connection from retaining another org's identity.
                    await connection.execute(
                        "SELECT set_config('app.org_id', %s, true)",
                        (state.scope.org_id,),
                    )
                    await connection.execute(
                        """
                        INSERT INTO model_provider_job_states (
                            org_id,
                            repository_id,
                            ref_name,
                            revision_sha,
                            surface,
                            status,
                            reason_code
                        )
                        SELECT %s, %s, %s, %s, %s, %s, %s
                        WHERE EXISTS (
                            SELECT 1
                            FROM repository_refs
                            WHERE org_id = %s
                              AND repository_id = %s
                              AND ref_name = %s
                              AND revision_sha = %s
                        )
                        ON CONFLICT (org_id, repository_id, ref_name, surface)
                        DO UPDATE SET
                            revision_sha = EXCLUDED.revision_sha,
                            status = EXCLUDED.status,
                            reason_code = EXCLUDED.reason_code
                        WHERE model_provider_job_states.org_id = EXCLUDED.org_id
                          AND EXISTS (
                              SELECT 1
                              FROM repository_refs
                              WHERE org_id = EXCLUDED.org_id
                                AND repository_id = EXCLUDED.repository_id
                                AND ref_name = EXCLUDED.ref_name
                                AND revision_sha = EXCLUDED.revision_sha
                          )
                        """,
                        (
                            state.scope.org_id,
                            state.scope.repository_id,
                            state.scope.ref_name,
                            state.scope.revision_sha,
                            state.surface,
                            state.status,
                            state.reason_code,
                            state.scope.org_id,
                            state.scope.repository_id,
                            state.scope.ref_name,
                            state.scope.revision_sha,
                        ),
                    )
        except (psycopg.Error, OSError):
            # Never carry a DSN, SQL text, or driver detail into queue logs.
            raise ProviderJobStateStoreError(
                "provider job state could not be persisted"
            ) from None
