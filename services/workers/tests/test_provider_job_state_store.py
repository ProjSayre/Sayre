from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import psycopg
import pytest

from sayre_workers.enrichment.state_store import (
    InvalidProviderJobStateError,
    PostgresProviderJobStateStore,
    ProviderJobState,
    ProviderJobStateStoreError,
)
from sayre_workers.ingestion.models import GraphScope

SCOPE = GraphScope(
    org_id="11111111-1111-4111-8111-111111111111",
    repository_id="22222222-2222-4222-8222-222222222222",
    ref_name="refs/heads/main",
    revision_sha="a" * 40,
)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"surface": "raw", "status": "generating"},
        {"surface": "product", "status": "raw"},
        {"surface": "product", "status": "ready", "reason_code": "timeout"},
        {"surface": "product", "status": "generating", "reason_code": "timeout"},
        {"surface": "product", "status": "degraded"},
        {"surface": "product", "status": "failed"},
        {
            "surface": "product",
            "status": "failed",
            "reason_code": "raw provider error",
        },
    ],
)
def test_provider_job_state_rejects_values_outside_closed_contract(
    kwargs: dict[str, Any],
) -> None:
    with pytest.raises(InvalidProviderJobStateError):
        ProviderJobState(scope=SCOPE, **kwargs)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_postgres_state_store_sets_transaction_local_org_and_upserts_only_sanitized_fields(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    statements: list[tuple[str, tuple[object, ...]]] = []

    class Transaction:
        async def __aenter__(self) -> Transaction:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

    class Connection:
        async def __aenter__(self) -> Connection:
            return self

        async def __aexit__(self, *args: object) -> None:
            del args

        def transaction(self) -> Transaction:
            return Transaction()

        async def execute(
            self, statement: str, params: tuple[object, ...]
        ) -> None:
            statements.append((statement, params))

    async def connect(_dsn: str) -> Connection:
        return Connection()

    monkeypatch.setattr(
        "sayre_workers.enrichment.state_store.psycopg.AsyncConnection",
        SimpleNamespace(connect=connect),
    )
    store = PostgresProviderJobStateStore("postgresql://not-used")
    state = ProviderJobState(
        scope=SCOPE,
        surface="product",
        status="degraded",
        reason_code="timeout",
    )

    await store.set_state(state)

    assert "set_config('app.org_id', %s, true)" in statements[0][0]
    assert statements[0][1] == (SCOPE.org_id,)
    upsert, params = statements[1]
    assert "ON CONFLICT (org_id, repository_id, ref_name, surface)" in upsert
    assert "WHERE model_provider_job_states.org_id = EXCLUDED.org_id" in upsert
    assert "FROM repository_refs" in upsert
    assert "revision_sha = EXCLUDED.revision_sha" in upsert
    assert params == (
        SCOPE.org_id,
        SCOPE.repository_id,
        SCOPE.ref_name,
        SCOPE.revision_sha,
        "product",
        "degraded",
        "timeout",
        SCOPE.org_id,
        SCOPE.repository_id,
        SCOPE.ref_name,
        SCOPE.revision_sha,
    )
    for forbidden in ("endpoint_url", "credential_ref", "prompt", "response", "error_text"):
        assert forbidden not in upsert


@pytest.mark.asyncio
async def test_postgres_state_store_sanitizes_driver_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail(_dsn: str) -> None:
        raise psycopg.OperationalError("private DSN or endpoint detail")

    monkeypatch.setattr(
        "sayre_workers.enrichment.state_store.psycopg.AsyncConnection",
        SimpleNamespace(connect=fail),
    )
    store = PostgresProviderJobStateStore("postgresql://secret@private")

    with pytest.raises(ProviderJobStateStoreError) as failure:
        await store.set_state(
            ProviderJobState(scope=SCOPE, surface="product", status="generating")
        )

    assert "private" not in str(failure.value)
    assert failure.value.__cause__ is None
