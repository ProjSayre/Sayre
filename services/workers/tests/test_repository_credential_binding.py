from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import pytest

from messaging.envelope import MessageEnvelope
from sayre_workers.ingestion.models import RepositoryLocator
from sayre_workers.ingestion.repository import GitRepositorySource
from sayre_workers.ingestion.service import IngestionService
from sayre_workers.ingestion import state
from sayre_workers.ingestion.state import (
    PostgresRefStateStore,
    RepositoryCredentialBindingError,
    UnknownRepositoryError,
)

ORG_ID = "00000000-0000-4000-8000-000000000001"
REVISION = "a" * 40


class _Cursor:
    def __init__(self, row: dict[str, Any] | None) -> None:
        self._row = row

    async def fetchone(self) -> dict[str, Any] | None:
        return self._row


class _Connection:
    def __init__(self, repository_row: dict[str, Any] | None) -> None:
        self._repository_row = repository_row
        self.calls: list[tuple[str, tuple[object, ...]]] = []

    async def execute(
        self,
        query: str,
        parameters: tuple[object, ...] = (),
    ) -> _Cursor:
        normalized = " ".join(query.split())
        self.calls.append((normalized, parameters))
        if "FROM repositories AS repository" in normalized:
            return _Cursor(self._repository_row)
        if "pg_advisory_xact_lock" in normalized:
            return _Cursor(None)
        if "FROM repository_refs" in normalized:
            return _Cursor(None)
        raise AssertionError(f"unexpected statement: {normalized}")


def _binding_row(**overrides: object) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "Acme/Widgets",
        "installation_id": 555,
        "account_login": "ACME",
        "account_type": "Organization",
        "suspended_at": None,
        "revoked_at": None,
    }
    row.update(overrides)
    return row


def _locator(**overrides: object) -> RepositoryLocator:
    values: dict[str, object] = {
        "provider": "github",
        "provider_repo_id": "42",
        "full_name": "acme/widgets",
        "installation_id": 555,
    }
    values.update(overrides)
    return RepositoryLocator.model_validate(values)


def _patch_connection(
    monkeypatch: pytest.MonkeyPatch,
    repository_row: dict[str, Any] | None,
) -> _Connection:
    connection = _Connection(repository_row)

    @asynccontextmanager
    async def scoped_connection(
        dsn: str,
        org_id: str,
    ) -> AsyncIterator[_Connection]:
        assert dsn == "postgresql://credential-must-not-escape"
        assert org_id == ORG_ID
        yield connection

    monkeypatch.setattr(state, "org_scoped_connection", scoped_connection)
    return connection


@pytest.mark.asyncio
async def test_ref_lock_binds_full_queue_tuple_to_active_tenant_installation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _patch_connection(monkeypatch, _binding_row())
    store = PostgresRefStateStore("postgresql://credential-must-not-escape")

    async with store.lock(ORG_ID, _locator(), "refs/heads/main") as locked:
        assert locked.repository_id == "11111111-1111-4111-8111-111111111111"

    binding_query, binding_parameters = connection.calls[0]
    assert "LEFT JOIN github_app_installations AS installation" in binding_query
    assert "installation.org_id = repository.org_id" in binding_query
    assert binding_parameters == (555, ORG_ID, "github", "42")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("row_overrides", "locator_overrides"),
    [
        ({"name": "acme/other"}, {}),
        ({"installation_id": None}, {}),
        ({"installation_id": 777}, {}),
        ({"account_login": "other-owner"}, {}),
        ({"account_type": "Bot"}, {}),
        ({"suspended_at": object()}, {}),
        ({"revoked_at": object()}, {}),
        ({}, {"full_name": "other/widgets"}),
        ({}, {"installation_id": 777}),
    ],
)
async def test_ref_lock_rejects_any_repository_installation_binding_mismatch(
    monkeypatch: pytest.MonkeyPatch,
    row_overrides: dict[str, object],
    locator_overrides: dict[str, object],
) -> None:
    _patch_connection(monkeypatch, _binding_row(**row_overrides))
    store = PostgresRefStateStore("postgresql://credential-must-not-escape")

    with pytest.raises(
        RepositoryCredentialBindingError,
        match="credentials are not bound",
    ) as caught:
        async with store.lock(
            ORG_ID,
            _locator(**locator_overrides),
            "refs/heads/main",
        ):
            raise AssertionError("a mismatched credential binding must not be yielded")

    assert "credential-must-not-escape" not in str(caught.value)
    assert "other-owner" not in str(caught.value)


@pytest.mark.asyncio
async def test_ref_lock_keeps_unknown_repository_failure_indistinguishable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_connection(monkeypatch, None)
    store = PostgresRefStateStore("postgresql://credential-must-not-escape")

    with pytest.raises(UnknownRepositoryError, match="not registered"):
        async with store.lock(ORG_ID, _locator(), "refs/heads/main"):
            raise AssertionError("an unknown repository must not be yielded")


@pytest.mark.asyncio
async def test_binding_failure_happens_before_installation_token_mint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_connection(monkeypatch, _binding_row(account_login="other-owner"))

    class _TokenProvider:
        def __init__(self) -> None:
            self.calls: list[int] = []

        async def mint_token(self, installation_id: int) -> str:
            self.calls.append(installation_id)
            return "must-not-be-created"

    token_provider = _TokenProvider()
    service = IngestionService(
        state_store=PostgresRefStateStore("postgresql://credential-must-not-escape"),
        repository_source=GitRepositorySource(token_provider=token_provider),
        graph_store=object(),  # type: ignore[arg-type]
        chunk_store=object(),  # type: ignore[arg-type]
        publisher=object(),  # type: ignore[arg-type]
    )
    envelope = MessageEnvelope(
        org_id=ORG_ID,
        type="repo.initial_parse",
        source="github-app",
        idempotency_key="binding-before-mint",
        payload={
            "provider": "github",
            "repo": {
                "provider_repo_id": "42",
                "full_name": "acme/widgets",
            },
            "ref": "refs/heads/main",
            "revision_sha": REVISION,
            "installation_id": "555",
        },
    )

    with pytest.raises(RepositoryCredentialBindingError):
        await service.handle(envelope)

    assert token_provider.calls == []
