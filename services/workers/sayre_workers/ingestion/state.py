"""Postgres-backed repository/ref compare-and-set state."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

import psycopg

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection

from .models import RefState, RepositoryLocator


class UnknownRepositoryError(LookupError):
    pass


class RevisionConflictError(RuntimeError):
    pass


class LockedRef(Protocol):
    repository_id: str
    current: RefState | None

    async def accept(self, revision_sha: str) -> RefState: ...


class RefStateStore(Protocol):
    def lock(
        self, org_id: str, repository: RepositoryLocator, ref_name: str
    ) -> AbstractAsyncContextManager[LockedRef]: ...


class _PostgresLockedRef:
    def __init__(
        self,
        connection: psycopg.AsyncConnection[Any],
        *,
        org_id: str,
        repository_id: str,
        ref_name: str,
        current: RefState | None,
    ) -> None:
        self.connection = connection
        self.org_id = org_id
        self.repository_id = repository_id
        self.ref_name = ref_name
        self.current = current

    async def accept(self, revision_sha: str) -> RefState:
        next_version = 0 if self.current is None else self.current.graph_version + 1
        if self.current is None:
            cursor = await self.connection.execute(
                """
                INSERT INTO repository_refs
                    (org_id, repository_id, ref_name, revision_sha, graph_version)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (org_id, repository_id, ref_name) DO NOTHING
                RETURNING id::text
                """,
                (
                    self.org_id,
                    self.repository_id,
                    self.ref_name,
                    revision_sha,
                    next_version,
                ),
            )
        else:
            cursor = await self.connection.execute(
                """
                UPDATE repository_refs
                SET revision_sha = %s, graph_version = %s, updated_at = now()
                WHERE id = %s AND org_id = %s AND graph_version = %s
                RETURNING id::text
                """,
                (
                    revision_sha,
                    next_version,
                    self.current.ref_id,
                    self.org_id,
                    self.current.graph_version,
                ),
            )
        row = await cursor.fetchone()
        if row is None:
            raise RevisionConflictError("repository ref state changed while ingestion was running")
        accepted = RefState(
            ref_id=str(row["id"]),
            revision_sha=revision_sha,
            graph_version=next_version,
        )
        self.current = accepted
        return accepted


class PostgresRefStateStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn

    @classmethod
    async def from_config(cls) -> "PostgresRefStateStore":
        return cls(await get_secret("env://DATABASE_RUNTIME_URL"))

    @asynccontextmanager
    async def lock(
        self, org_id: str, repository: RepositoryLocator, ref_name: str
    ) -> AsyncIterator[_PostgresLockedRef]:
        async with org_scoped_connection(self._dsn, org_id) as connection:
            repository_cursor = await connection.execute(
                """
                SELECT id::text
                FROM repositories
                WHERE org_id = %s AND provider = %s AND external_id = %s
                """,
                (org_id, repository.provider, repository.provider_repo_id),
            )
            repository_row = await repository_cursor.fetchone()
            if repository_row is None:
                raise UnknownRepositoryError("repository is not registered for this organization")
            repository_id = str(repository_row["id"])
            # SELECT ... FOR UPDATE cannot lock a ref row that does not exist yet.
            # Serialize the whole graph-write/accept sequence for this scope so
            # concurrent cold-start deliveries cannot project different heads
            # before racing to create the first repository_refs row.
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"{org_id}\0{repository_id}\0{ref_name}",),
            )
            ref_cursor = await connection.execute(
                """
                SELECT id::text, revision_sha, graph_version
                FROM repository_refs
                WHERE org_id = %s AND repository_id = %s AND ref_name = %s
                FOR UPDATE
                """,
                (org_id, repository_id, ref_name),
            )
            ref_row = await ref_cursor.fetchone()
            current = (
                None
                if ref_row is None
                else RefState(
                    ref_id=str(ref_row["id"]),
                    revision_sha=str(ref_row["revision_sha"]),
                    graph_version=int(ref_row["graph_version"]),
                )
            )
            yield _PostgresLockedRef(
                connection,
                org_id=org_id,
                repository_id=repository_id,
                ref_name=ref_name,
                current=current,
            )
