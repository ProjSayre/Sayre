"""Org-scoped Postgres connection helper (W2-06).

Mirrors `services/core/src/db/client.ts::withOrgContext`. Tenant isolation for
every Postgres-backed worker consumer (`ingestion/chunks.py`,
`ingestion/state.py`) is enforced by PostgreSQL Row-Level Security
(`services/core/drizzle/0001,0004,0007_*.sql`); this module only ever opens the
connection under the correct role and sets the transaction-local `app.org_id`
GUC those policies read. It never implements node-level (org/repo/branch/path)
RBAC itself -- see `.claude/rules/security-multitenancy.md`.

Before this module existed, `PostgresChunkStore._connect`
(`ingestion/chunks.py`) and `PostgresRefStateStore.lock`
(`ingestion/state.py`) both called `set_config('app.org_id', ...)` but never
`SET ROLE sayre_app` -- RLS with `FORCE` is silently bypassed by a
superuser/BYPASSRLS login role, and nothing enforced that
`DATABASE_RUNTIME_URL` resolved to anything else (`docs/tenant-isolation.md`
"Finding 1"). This was, until W2-06, the single most exploitable tenant-
isolation gap in the codebase: the worker's isolation rested entirely on
every call site remembering its explicit `WHERE org_id` clause, with no
engine-level backstop.
"""

from __future__ import annotations

import re
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import psycopg
from psycopg.rows import dict_row

from sayre_workers.config import get_config

# UUID validation identical in intent to client.ts's UUID_RE
# (services/core/src/db/client.ts:41).
_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)

# Role name is a trusted, static SQL literal (not interpolated) -- identical
# rationale to client.ts:85 (`SET ROLE` takes an identifier, not a bindable
# value). Never build this string from any caller-supplied input.
_SET_LOCAL_ROLE_SAYRE_APP = "SET LOCAL ROLE sayre_app"


class InvalidOrgIdError(ValueError):
    """`org_id` failed UUID validation before any SQL was issued."""


class RuntimeRoleUnsafeError(RuntimeError):
    """The resolved `DATABASE_RUNTIME_URL` login role can bypass Postgres RLS
    (`rolsuper` or `rolbypassrls`), or cannot `SET ROLE` to `sayre_app`.
    CI/production gate only (Resolved decision Q2) -- see
    `assert_runtime_role_rls_safe`."""


@asynccontextmanager
async def org_scoped_connection(
    dsn: str, org_id: str
) -> AsyncIterator[psycopg.AsyncConnection[Any]]:
    """Open a tenant-scoped Postgres connection that ACTUALLY engages RLS.

    Mirrors `services/core/src/db/client.ts::withOrgContext`. In order, inside
    one transaction:
      1. validate `org_id` is a UUID (never reaches SQL otherwise);
      2. `SET LOCAL ROLE sayre_app` -- drop off any privileged login role onto
         the NOBYPASSRLS, non-owner runtime role, BEFORE org context is set.
         Without this, FORCE-RLS is silently bypassed when the DSN's login
         role is a superuser/BYPASSRLS role (the historical gap on this path,
         `docs/tenant-isolation.md` "Finding 1"). `SET LOCAL` is
         transaction-scoped, so it auto-resets on commit/rollback --
         pool-safe (this module does not pool connections itself, but a
         caller-side pool must never see stale role/org state either way).
      3. `select set_config('app.org_id', %s, true)` -- transaction-local
         (`is_local = true`), so a reused connection never carries stale org
         context into its next use (`docs/tenant-isolation.md` "Finding 3":
         `chunks.py` previously used `is_local=false`/session-scoped;
         `state.py` used `true`; this helper standardizes on transaction-local
         for both).

    `org_id` is SERVER-RESOLVED (from the ingestion job's `GraphScope`, itself
    derived from the server-controlled envelope) -- NEVER from message
    payload/client input (`.claude/rules/security-multitenancy.md`).

    Yields a connection already inside a transaction with role + org context
    set; the caller runs statements against it directly. The context manager
    commits the transaction on clean exit, rolls it back on exception, and
    closes the connection either way -- so no stale role or org context can
    survive past this call, even if the underlying driver were to reuse the
    socket.

    Does NOT resolve secrets itself -- both `chunks.py` and `state.py` obtain
    their DSN exactly as before (`get_secret("env://DATABASE_RUNTIME_URL")`)
    and pass it in, keeping the secrets-loader boundary
    (`.claude/rules/security-multitenancy.md` / W0-07). Never logs `dsn`
    (it carries credentials).
    """
    if not _UUID_RE.match(org_id):
        raise InvalidOrgIdError("org_scoped_connection: org_id must be a UUID")

    connection = await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row)
    async with connection:
        async with connection.transaction():
            await connection.execute(_SET_LOCAL_ROLE_SAYRE_APP)
            await connection.execute(
                "SELECT set_config('app.org_id', %s, true)", (org_id,)
            )
            yield connection


async def assert_runtime_role_rls_safe(dsn: str) -> None:
    """CI/production startup gate (Resolved decision Q2).

    Queries `pg_roles` for the DSN's *login* role (before any `SET LOCAL
    ROLE`) and raises `RuntimeRoleUnsafeError` if that role:
      - can bypass RLS (`rolsuper` or `rolbypassrls`), or
      - cannot `SET ROLE` to `sayre_app` (which would mean every
        `org_scoped_connection` call's `SET LOCAL ROLE sayre_app` fails closed
        at runtime -- better to catch the misprovisioning at boot).

    PostgreSQL 16 role memberships can be granted with `SET FALSE`, so generic
    membership is not sufficient for this capability check.

    This is a *defense-in-depth early warning*, not the enforcement mechanism
    itself: `org_scoped_connection` already unconditionally drops to
    `sayre_app` before touching tenant data, so RLS engages regardless of
    what the login role is, as long as that `SET LOCAL ROLE` succeeds. This
    assertion exists to catch a misprovisioned `DATABASE_RUNTIME_URL` (e.g.
    accidentally pointed at the admin/owner role) at deploy time rather than
    relying solely on every call site's fail-closed behavior.

    Deliberately a **CI/production gate, not a local-dev block**: local dev's
    login role (`sayre_dev`, `infra/.env.example`) is intentionally a
    superuser (mirrors the same caveat documented in `client.ts`), so this
    function no-ops unless `SAYRE_ENV` is `"ci"` or `"production"`.

    Never logs `dsn` (it carries credentials).
    """
    if get_config("SAYRE_ENV") not in ("ci", "production"):
        return

    connection = await psycopg.AsyncConnection.connect(dsn)
    try:
        cursor = await connection.execute(
            "SELECT rolsuper, rolbypassrls, "
            "pg_has_role(session_user, 'sayre_app', 'set') AS can_set_sayre_app "
            "FROM pg_roles WHERE rolname = session_user"
        )
        row = await cursor.fetchone()
    finally:
        await connection.close()

    if row is None:
        raise RuntimeRoleUnsafeError(
            "assert_runtime_role_rls_safe: could not resolve the runtime login role."
        )
    rolsuper, rolbypassrls, can_set_sayre_app = row
    if rolsuper or rolbypassrls:
        raise RuntimeRoleUnsafeError(
            "assert_runtime_role_rls_safe: DATABASE_RUNTIME_URL's login role "
            "can bypass row-level security (superuser or BYPASSRLS). "
            "Provision a NOBYPASSRLS, non-superuser login role granted "
            "membership in sayre_app before this deploys to CI/production."
        )
    if not can_set_sayre_app:
        raise RuntimeRoleUnsafeError(
            "assert_runtime_role_rls_safe: DATABASE_RUNTIME_URL's login role "
            "cannot SET ROLE to sayre_app; org_scoped_connection's SET LOCAL "
            "ROLE sayre_app will fail closed on every call. Grant a SET-enabled "
            "membership before this deploys to CI/production."
        )
