"""Postgres-backed repository/ref compare-and-set state."""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

import psycopg

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection

from .models import RefState, RepositoryLocator

_GITHUB_FULL_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class UnknownRepositoryError(LookupError):
    pass


class RepositoryCredentialBindingError(PermissionError):
    """The queue repository identity is not bound to this tenant installation."""


class RevisionConflictError(RuntimeError):
    pass


def _github_binding_matches(
    repository: RepositoryLocator,
    row: dict[str, Any],
) -> bool:
    """Compare only canonical identities; callers emit one sanitized failure."""

    if (
        repository.installation_id is None
        or not _GITHUB_FULL_NAME.fullmatch(repository.full_name)
        or not isinstance(row.get("name"), str)
        or row["name"].casefold() != repository.full_name.casefold()
        or row.get("installation_id") != repository.installation_id
        or row.get("suspended_at") is not None
        or row.get("revoked_at") is not None
    ):
        return False

    account_login = row.get("account_login")
    account_type = row.get("account_type")
    owner, _repository_name = repository.full_name.split("/", 1)
    return (
        isinstance(account_login, str)
        and account_login.casefold() == owner.casefold()
        and isinstance(account_type, str)
        and account_type.casefold() in {"organization", "user"}
    )


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
            if repository.provider == "github":
                # Resolve the complete credential binding under the same
                # tenant-scoped/RLS-enforced transaction that owns the ref
                # lock. A queue tuple can authorize a GitHub token only when:
                #   * the provider id and full name identify this org's row;
                #   * the installation id is visible in this same org;
                #   * the installation is active; and
                #   * its GitHub account owns the repository namespace.
                #
                # This happens before RepositorySource.checkout(), and
                # therefore before mint_token(), so a forged/misrouted queue
                # delivery never receives or uses an installation credential.
                repository_cursor = await connection.execute(
                    """
                    SELECT
                        repository.id::text,
                        repository.name,
                        installation.installation_id,
                        installation.account_login,
                        installation.account_type,
                        installation.suspended_at,
                        installation.revoked_at
                    FROM repositories AS repository
                    LEFT JOIN github_app_installations AS installation
                      ON installation.org_id = repository.org_id
                     AND installation.installation_id = %s
                    WHERE repository.org_id = %s
                      AND repository.provider = %s
                      AND repository.external_id = %s
                    """,
                    (
                        repository.installation_id,
                        org_id,
                        repository.provider,
                        repository.provider_repo_id,
                    ),
                )
            else:
                repository_cursor = await connection.execute(
                    """
                    SELECT id::text, name
                    FROM repositories
                    WHERE org_id = %s AND provider = %s AND external_id = %s
                    """,
                    (org_id, repository.provider, repository.provider_repo_id),
                )
            repository_row = await repository_cursor.fetchone()
            if repository_row is None:
                raise UnknownRepositoryError("repository is not registered for this organization")
            if repository.provider == "github" and not _github_binding_matches(
                repository, repository_row
            ):
                raise RepositoryCredentialBindingError(
                    "repository credentials are not bound to this organization"
                )
            repository_id = str(repository_row["id"])
            # SELECT ... FOR UPDATE cannot lock a ref row that does not exist yet.
            # Serialize the whole graph-write/accept sequence for this scope so
            # concurrent cold-start deliveries cannot project different heads
            # before racing to create the first repository_refs row.
            # ':' is invalid in both a UUID and a git ref name, so it cannot
            # cause two distinct (org_id, repository_id, ref_name) tuples to
            # collide onto the same lock key. NUL was tried first but Postgres
            # `text` parameters can never contain a NUL byte -- psycopg raises
            # DataError client-side before the query is even sent.
            await connection.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"{org_id}:{repository_id}:{ref_name}",),
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
