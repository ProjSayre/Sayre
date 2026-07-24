"""Shared, org-scoped Postgres connection helper for the Python worker fleet (W2-06).

`org_scoped_connection` is the single sanctioned way any worker opens a
tenant-scoped Postgres connection -- it mirrors
`services/core/src/db/client.ts::withOrgContext` exactly (validate UUID -> `SET
LOCAL ROLE sayre_app` -> transaction-local `set_config`). See
`docs/tenant-isolation.md` and `.claude/rules/security-multitenancy.md`.
"""

from __future__ import annotations

from .session import (
    InvalidOrgIdError,
    RuntimeRoleUnsafeError,
    assert_runtime_role_rls_safe,
    org_scoped_connection,
)

__all__ = [
    "InvalidOrgIdError",
    "RuntimeRoleUnsafeError",
    "assert_runtime_role_rls_safe",
    "org_scoped_connection",
]
