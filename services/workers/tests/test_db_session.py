"""Deterministic unit tests for the shared org-scoped Postgres connection helper (W2-06).

No real Postgres required -- exercises `org_scoped_connection` and
`assert_runtime_role_rls_safe` against fakes that record call order, proving:
  - UUID validation happens before any SQL is issued (bad org_id -> no connect call).
  - Statement order is role -> org (`SET LOCAL ROLE sayre_app` before `set_config`) --
    the exact ordering `docs/tenant-isolation.md` "Finding 1" requires; org-before-role
    would leave RLS silently bypassed by a privileged login role.
  - `set_config` is always issued transaction-local (`is_local = true`), matching the
    Node reference implementation (`withOrgContext`) and eliminating the pre-fix
    `is_local` inconsistency between `chunks.py` (was `false`) and `state.py` (was
    `true`) -- see `docs/tenant-isolation.md` "Finding 3".
  - Commit-on-clean-exit / rollback-on-exception / always-close, so no stale role or
    org context can survive past a single `org_scoped_connection` call.
  - `assert_runtime_role_rls_safe` no-ops outside `SAYRE_ENV` in `{"ci","production"}`
    (so it never blocks local dev, where the login role is intentionally a superuser)
    and is enforcing (raises `RuntimeRoleUnsafeError`) inside them, for both the
    bypass-role and cannot-SET-sayre_app cases.

Real-Postgres coverage of the actual RLS-engagement guarantee (the "privileged-DSN
trap": a superuser/BYPASSRLS DSN still isolates once routed through
`org_scoped_connection`) lives in `tests/test_tenant_isolation.py`, gated on
`DATABASE_ADMIN_URL` exactly like `rls_acceptance.tester.test.ts`. This file is the
fast, infra-free complement covering the helper's own contract in isolation.
"""

from __future__ import annotations

from typing import Any

import pytest

from sayre_workers.config import reset_config_for_tests, set_config_override_for_tests
from sayre_workers.db import (
    InvalidOrgIdError,
    RuntimeRoleUnsafeError,
    assert_runtime_role_rls_safe,
    org_scoped_connection,
)
from sayre_workers.db.session import _SET_LOCAL_ROLE_SAYRE_APP

ORG_A = "11111111-1111-1111-1111-111111111111"
FAKE_DSN = "postgresql://fake-user:fake-pass@fake-host/fake-db"


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    reset_config_for_tests()
    yield
    monkeypatch.setenv("SAYRE_ENV", "test")
    reset_config_for_tests()


class _FakeCursor:
    def __init__(self, row: Any) -> None:
        self._row = row

    async def fetchone(self) -> Any:
        return self._row


class _FakeTransaction:
    def __init__(self, log: list[Any]) -> None:
        self._log = log

    async def __aenter__(self) -> "_FakeTransaction":
        self._log.append("transaction:enter")
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self._log.append("transaction:rollback" if exc_type else "transaction:commit")
        return False


class _FakeConnection:
    def __init__(self, dsn: str, *, next_row: Any = None) -> None:
        self.dsn = dsn
        self.log: list[tuple[str, tuple[Any, ...]]] = []
        self.closed = False
        self._next_row = next_row

    async def execute(self, sql: str, params: tuple[Any, ...] = ()) -> _FakeCursor:
        self.log.append((" ".join(sql.split()), params))
        return _FakeCursor(self._next_row)

    def transaction(self) -> _FakeTransaction:
        return _FakeTransaction(self.log)

    async def close(self) -> None:
        self.closed = True

    async def __aenter__(self) -> "_FakeConnection":
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        await self.close()
        return False


def _sql_calls(conn: _FakeConnection) -> list[tuple[str, tuple[Any, ...]]]:
    """The `(sql, params)` entries in `conn.log`, in call order, excluding the
    `_FakeTransaction` enter/commit/rollback string markers interleaved with them."""
    return [entry for entry in conn.log if isinstance(entry, tuple)]


@pytest.fixture()
def install_fake_connect(monkeypatch):
    """Patches `psycopg.AsyncConnection.connect` to hand back a `_FakeConnection`,
    optionally pre-loaded with `next_row` for the next `.execute(...).fetchone()`."""

    def _install(next_row: Any = None) -> list[_FakeConnection]:
        created: list[_FakeConnection] = []

        async def _connect(dsn: str, *args: Any, **kwargs: Any) -> _FakeConnection:
            conn = _FakeConnection(dsn, next_row=next_row)
            created.append(conn)
            return conn

        monkeypatch.setattr("psycopg.AsyncConnection.connect", _connect)
        return created

    return _install


# --- org_scoped_connection: UUID validation happens before any SQL ------------------


@pytest.mark.parametrize(
    "bad_org_id",
    ["", "not-a-uuid", "12345", "'; DROP TABLE users; --", "  ", ORG_A.upper() + "x"],
)
async def test_invalid_org_id_raises_before_any_connect_call(install_fake_connect, bad_org_id):
    created = install_fake_connect()
    with pytest.raises(InvalidOrgIdError, match="org_id must be a UUID"):
        async with org_scoped_connection(FAKE_DSN, bad_org_id):
            raise AssertionError("must not enter the block for an invalid org_id")
    assert created == [], "an invalid org_id must never reach psycopg.AsyncConnection.connect"


async def test_valid_uuid_is_accepted_case_insensitively(install_fake_connect):
    created = install_fake_connect()
    async with org_scoped_connection(FAKE_DSN, ORG_A.upper()) as connection:
        assert connection is created[0]


# --- statement order: role -> org, always transaction-local --------------------------


async def test_statement_order_is_set_local_role_before_set_config(install_fake_connect):
    created = install_fake_connect()
    async with org_scoped_connection(FAKE_DSN, ORG_A):
        pass
    conn = created[0]
    sql_calls = _sql_calls(conn)
    assert sql_calls[0][0] == _SET_LOCAL_ROLE_SAYRE_APP
    assert sql_calls[0][0] == "SET LOCAL ROLE sayre_app"
    assert "set_config" in sql_calls[1][0]
    assert sql_calls[1][1] == (ORG_A,), "org_id must be bound as a parameter, not interpolated"


async def test_set_config_is_always_transaction_local(install_fake_connect):
    created = install_fake_connect()
    async with org_scoped_connection(FAKE_DSN, ORG_A):
        pass
    set_config_call = _sql_calls(created[0])[1][0]
    assert "true" in set_config_call, "set_config must use is_local=true (transaction-local)"
    assert "false" not in set_config_call, (
        "must never regress to is_local=false (session-scoped) -- the pre-fix "
        "chunks.py bug (docs/tenant-isolation.md Finding 3)"
    )


async def test_role_name_is_a_static_literal_not_interpolated(install_fake_connect):
    created = install_fake_connect()
    async with org_scoped_connection(FAKE_DSN, ORG_A):
        pass
    role_call = _sql_calls(created[0])[0]
    assert role_call[1] == (), "SET LOCAL ROLE must be a static SQL literal, never a bound parameter"


# --- transaction lifecycle: commit-on-clean-exit / rollback-on-exception / always-close


async def test_commits_on_clean_exit_and_closes(install_fake_connect):
    created = install_fake_connect()
    async with org_scoped_connection(FAKE_DSN, ORG_A):
        pass
    conn = created[0]
    assert "transaction:commit" in conn.log
    assert conn.closed is True


async def test_rolls_back_on_exception_and_still_closes(install_fake_connect):
    created = install_fake_connect()

    class _Boom(Exception):
        pass

    with pytest.raises(_Boom):
        async with org_scoped_connection(FAKE_DSN, ORG_A):
            raise _Boom("caller failed mid-transaction")
    conn = created[0]
    assert "transaction:rollback" in conn.log
    assert conn.closed is True


# --- assert_runtime_role_rls_safe: CI/production gate, not a local-dev block --------


async def test_noop_outside_ci_and_production(install_fake_connect):
    created = install_fake_connect()
    # SAYRE_ENV defaults to "test" in this suite's fixture -- not "ci"/"production".
    await assert_runtime_role_rls_safe(FAKE_DSN)
    assert created == [], "must not even attempt to connect outside SAYRE_ENV in {ci, production}"


async def test_noop_for_development_env(install_fake_connect):
    set_config_override_for_tests("SAYRE_ENV", "development")
    created = install_fake_connect()
    await assert_runtime_role_rls_safe(FAKE_DSN)
    assert created == []


@pytest.mark.parametrize("gated_env", ["ci", "production"])
async def test_raises_when_login_role_can_bypass_rls(install_fake_connect, gated_env):
    set_config_override_for_tests("SAYRE_ENV", gated_env)
    install_fake_connect(next_row=(True, False, True))  # rolsuper=True
    with pytest.raises(RuntimeRoleUnsafeError, match="bypass row-level security"):
        await assert_runtime_role_rls_safe(FAKE_DSN)


async def test_raises_when_bypassrls_even_if_not_superuser(install_fake_connect):
    set_config_override_for_tests("SAYRE_ENV", "ci")
    install_fake_connect(next_row=(False, True, True))  # rolbypassrls=True
    with pytest.raises(RuntimeRoleUnsafeError, match="bypass row-level security"):
        await assert_runtime_role_rls_safe(FAKE_DSN)


async def test_raises_when_role_cannot_set_sayre_app(install_fake_connect):
    set_config_override_for_tests("SAYRE_ENV", "ci")
    created = install_fake_connect(next_row=(False, False, False))
    with pytest.raises(RuntimeRoleUnsafeError, match="cannot SET ROLE to sayre_app"):
        await assert_runtime_role_rls_safe(FAKE_DSN)
    assert "'set'" in _sql_calls(created[0])[0][0].lower()
    assert "session_user" in _sql_calls(created[0])[0][0].lower()


async def test_raises_when_role_cannot_be_resolved(install_fake_connect):
    set_config_override_for_tests("SAYRE_ENV", "ci")
    install_fake_connect(next_row=None)
    with pytest.raises(RuntimeRoleUnsafeError, match="could not resolve"):
        await assert_runtime_role_rls_safe(FAKE_DSN)


async def test_passes_and_closes_connection_when_role_is_safe(install_fake_connect):
    set_config_override_for_tests("SAYRE_ENV", "ci")
    created = install_fake_connect(next_row=(False, False, True))
    await assert_runtime_role_rls_safe(FAKE_DSN)
    assert created[0].closed is True


async def test_never_logs_or_raises_the_dsn_itself(install_fake_connect, capsys):
    set_config_override_for_tests("SAYRE_ENV", "ci")
    secret_marker = "s3cr3t-credential-marker"
    install_fake_connect(next_row=(True, False, True))
    with pytest.raises(RuntimeRoleUnsafeError) as excinfo:
        await assert_runtime_role_rls_safe(f"postgresql://user:{secret_marker}@host/db")
    assert secret_marker not in str(excinfo.value)
    assert secret_marker not in capsys.readouterr().out
