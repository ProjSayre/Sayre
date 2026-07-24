from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

import pytest

from sayre_workers.retrieval import (
    InvalidRetrievedChunkError,
    PostgresRetrievalStore,
    RetrievalScope,
)
import sayre_workers.retrieval.store as store_module

ORG_ID = "11111111-1111-4111-8111-111111111111"
SCOPE = RetrievalScope(
    org_id=ORG_ID,
    repository_id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ref_name="refs/heads/main",
    revision_sha="a" * 40,
)


class FakeCursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows

    async def fetchone(self) -> dict[str, Any] | None:
        return self.rows[0] if self.rows else None


class FakeConnection:
    def __init__(self, results: list[list[dict[str, Any]]]) -> None:
        self.results = results
        self.executed: list[tuple[str, tuple[Any, ...] | None]] = []

    async def __aenter__(self) -> "FakeConnection":
        return self

    async def __aexit__(self, *_args: object) -> None:
        return None

    async def execute(
        self,
        query: str,
        params: tuple[Any, ...] | None = None,
    ) -> FakeCursor:
        self.executed.append((query, params))
        return FakeCursor(self.results.pop(0) if self.results else [])


class StoreWithFakeConnection(PostgresRetrievalStore):
    def __init__(self, connection: FakeConnection) -> None:
        super().__init__("postgresql://unused")
        self.connection = connection
        self.connected_orgs: list[str] = []

    async def _connect(self, org_id: str) -> Any:
        self.connected_orgs.append(org_id)
        return self.connection


@pytest.fixture
def vector_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    calls: list[str] = []

    @asynccontextmanager
    async def capture(org_id: str) -> AsyncIterator[None]:
        calls.append(org_id)
        yield

    monkeypatch.setattr(store_module, "instrument_vector_query", capture)
    return calls


@pytest.mark.asyncio
async def test_chunk_query_is_parameterized_exactly_scoped_indexed_and_bounded(
    vector_calls: list[str],
) -> None:
    connection = FakeConnection(
        [[
            {
                "chunk_id": "chunk-1",
                "graph_node_id": "node-1",
                "content": "authorized content",
                "token_count": 5,
            }
        ]]
    )
    store = StoreWithFakeConnection(connection)

    chunks = await store.load_bounded_chunks(
        SCOPE,
        ("node-1", "node-1", "node-2"),
        24,
    )

    assert chunks[0].graph_node_id == "node-1"
    assert store.connected_orgs == [ORG_ID]
    assert vector_calls == [ORG_ID]
    query, params = connection.executed[0]
    assert "chunk.org_id = %s" in query
    assert "chunk.repository_id = %s" in query
    assert "ref.ref_name = %s" in query
    assert "ref.revision_sha = %s" in query
    assert "chunk.graph_node_id = ANY(%s)" in query
    assert "embedding.dimension = 1024" in query
    assert "LIMIT %s" in query
    assert ORG_ID not in query
    assert params == (
        ORG_ID,
        SCOPE.repository_id,
        SCOPE.ref_name,
        SCOPE.revision_sha,
        SCOPE.revision_sha,
        ["node-1", "node-2"],
        ["node-1", "node-2"],
        24,
    )


@pytest.mark.asyncio
async def test_connection_sets_runtime_rls_org_before_any_domain_query(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection([[]])
    connect = AsyncMock(return_value=connection)
    monkeypatch.setattr(store_module.psycopg.AsyncConnection, "connect", connect)
    store = PostgresRetrievalStore("postgresql://runtime")

    assert await store._connect(ORG_ID) is connection

    connect.assert_awaited_once_with("postgresql://runtime", row_factory=store_module.dict_row)
    assert connection.executed == [
        ("SELECT set_config('app.org_id', %s, false)", (ORG_ID,))
    ]


@pytest.mark.asyncio
async def test_empty_node_set_never_connects_or_emits_vector_metric(
    vector_calls: list[str],
) -> None:
    store = StoreWithFakeConnection(FakeConnection([]))

    assert await store.load_bounded_chunks(SCOPE, (), 24) == ()
    assert store.connected_orgs == []
    assert vector_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("limit", [0, 25, True])
async def test_invalid_limit_fails_before_postgres(
    limit: int,
    vector_calls: list[str],
) -> None:
    store = StoreWithFakeConnection(FakeConnection([]))

    with pytest.raises(ValueError, match="limit"):
        await store.load_bounded_chunks(SCOPE, ("node",), limit)

    assert store.connected_orgs == []
    assert vector_calls == []


@pytest.mark.asyncio
async def test_full_repo_baseline_returns_only_count_from_same_scope(
    vector_calls: list[str],
) -> None:
    connection = FakeConnection([[{"token_count": 7_000}]])
    store = StoreWithFakeConnection(connection)

    assert await store.load_full_repo_token_count(SCOPE) == 7_000

    query, params = connection.executed[0]
    assert "SUM(chunk.token_count)" in query
    assert "SELECT chunk.content" not in query
    assert "embedding.dimension = 1024" in query
    assert params == (
        ORG_ID,
        SCOPE.repository_id,
        SCOPE.ref_name,
        SCOPE.revision_sha,
        SCOPE.revision_sha,
    )
    assert vector_calls == [ORG_ID]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "row",
    [
        {"chunk_id": "chunk", "graph_node_id": "node", "content": "", "token_count": 1},
        {
            "chunk_id": "chunk",
            "graph_node_id": "node",
            "content": "content",
            "token_count": None,
        },
        {
            "chunk_id": "chunk",
            "graph_node_id": "node",
            "content": "content",
            "token_count": -1,
        },
    ],
)
async def test_malformed_persisted_chunk_fails_closed(
    row: dict[str, Any],
    vector_calls: list[str],
) -> None:
    store = StoreWithFakeConnection(FakeConnection([[row]]))

    with pytest.raises(InvalidRetrievedChunkError):
        await store.load_bounded_chunks(SCOPE, ("node",), 24)

    assert vector_calls == [ORG_ID]


@pytest.mark.asyncio
async def test_invalid_baseline_never_becomes_nan_or_negative_metric(
    vector_calls: list[str],
) -> None:
    store = StoreWithFakeConnection(FakeConnection([[{"token_count": -1}]]))

    with pytest.raises(InvalidRetrievedChunkError):
        await store.load_full_repo_token_count(SCOPE)

    assert vector_calls == [ORG_ID]
