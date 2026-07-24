"""Python-side cross-store tenant-isolation penetration suite (W2-06).

Real-Postgres-gated exactly like `services/core/src/db/rls_acceptance.tester.test.ts`:
skips (never errors) when `DATABASE_ADMIN_URL` is unreachable, so `poetry run pytest`
stays green on a machine without a database, mirroring the reachability-skip
convention already used by `tests/test_graph_migrations.py`'s real-infra suite.

Operates directly against whatever database `DATABASE_ADMIN_URL` resolves to --
assumed already migrated (`npm run db:migrate` from `services/core`, or an
equivalent CI/dev-setup step) since the Python worker fleet has no migration
runner of its own for the Postgres schema (`services/core/drizzle/**`). Every
row this suite seeds is inserted with a fresh random UUID org and deleted (via
`ON DELETE CASCADE` from `organizations`) in a `finally` block, so repeated
runs never collide and never leave residue in a shared dev database.

This is the ticket's headline Python-side acceptance (spec.md AC-3, "Postgres
isolation holds with the app-layer filter removed (Python worker)"): a
filter-less query run through `org_scoped_connection` returns zero
cross-tenant rows -- **even when the DSN itself resolves to a
superuser/BYPASSRLS login role** (`DATABASE_ADMIN_URL` is exactly such a role;
using it here is deliberate, not an oversight -- it is the "privileged-DSN
trap" the ticket calls out). A negative-control test proves the pre-fix
pattern (connect + `set_config` only, no `SET ROLE`) would have leaked, so the
fix documented in `docs/tenant-isolation.md` "Finding 1" can never silently
regress.
"""

from __future__ import annotations

import asyncio
import functools
import uuid
from contextlib import asynccontextmanager
from typing import Any

import pytest
import psycopg
from psycopg.rows import dict_row

from sayre_workers.config import get_secret
from sayre_workers.db import org_scoped_connection
from sayre_workers.db.session import _SET_LOCAL_ROLE_SAYRE_APP

CODE_EMBEDDINGS_DIM = 1024


def _vector_literal(dim: int, fill: float = 0.0) -> str:
    return "[" + ",".join(str(fill) for _ in range(dim)) + "]"


def _sha_like(label: str) -> str:
    return (label.lower() + "0" * 39)[:40]


@functools.lru_cache(maxsize=1)
def _admin_url() -> str | None:
    async def resolve() -> str:
        return await get_secret("env://DATABASE_ADMIN_URL")

    try:
        return asyncio.run(resolve())
    except Exception:
        return None


@functools.lru_cache(maxsize=1)
def _postgres_reachable() -> bool:
    url = _admin_url()
    if url is None:
        return False
    try:
        conn = psycopg.connect(url, connect_timeout=2)
        conn.close()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _postgres_reachable(),
    reason="DATABASE_ADMIN_URL unreachable -- skipping real-Postgres tenant-isolation suite",
)


class _SeededOrg:
    def __init__(self, org_id: str, repository_id: str, ref_id: str, chunk_id: str) -> None:
        self.org_id = org_id
        self.repository_id = repository_id
        self.ref_id = ref_id
        self.chunk_id = chunk_id


async def _seed_org(admin: psycopg.AsyncConnection[Any], label: str) -> _SeededOrg:
    """Seeds one throwaway org (+ repository, ref, chunk, embedding) as admin
    (bypasses RLS -- this is a fixture-setup helper, not the code under test)."""
    org_id = str(uuid.uuid4())
    repo_id = str(uuid.uuid4())
    ref_id = str(uuid.uuid4())
    chunk_id = str(uuid.uuid4())
    slug = f"w206-tester-{label.lower()}-{org_id[:8]}"

    await admin.execute(
        "INSERT INTO organizations (id, name, slug) VALUES (%s, %s, %s)",
        (org_id, f"W2-06 tester org {label}", slug),
    )
    await admin.execute(
        "INSERT INTO repositories (id, org_id, name) VALUES (%s, %s, %s)",
        (repo_id, org_id, f"repo-{label}"),
    )
    await admin.execute(
        """
        INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha)
        VALUES (%s, %s, %s, %s, %s)
        """,
        (ref_id, org_id, repo_id, "refs/heads/main", _sha_like(label)),
    )
    await admin.execute(
        """
        INSERT INTO code_chunks
            (id, org_id, repository_id, ref_id, revision_sha, graph_node_id,
             chunk_index, content, content_hash)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            chunk_id,
            org_id,
            repo_id,
            ref_id,
            _sha_like(label),
            "shared-graph-node-uid",  # deliberately identical across orgs -- see the
            # graph_node_id-collision edge case below.
            0,
            f"tenant isolation content for {label}",
            f"hash-{chunk_id}",
        ),
    )
    await admin.execute(
        """
        INSERT INTO code_embeddings
            (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model)
        VALUES (%s, %s, %s, %s, %s, %s, %s::vector, %s, %s)
        """,
        (
            str(uuid.uuid4()),
            org_id,
            repo_id,
            ref_id,
            _sha_like(label),
            chunk_id,
            _vector_literal(CODE_EMBEDDINGS_DIM, fill=0.001 if label == "A" else 0.002),
            "voyage",
            f"voyage-tester-{label.lower()}",
        ),
    )
    await admin.commit()
    return _SeededOrg(org_id=org_id, repository_id=repo_id, ref_id=ref_id, chunk_id=chunk_id)


async def _leaky_connect(dsn: str, org_id: str) -> psycopg.AsyncConnection[Any]:
    """The PRE-FIX pattern (`docs/tenant-isolation.md` "Finding 1"): `set_config`
    only, no `SET ROLE`. Used as the suite's own negative control -- proves the
    counterfactual so the `org_scoped_connection` fix can never silently regress."""
    connection = await psycopg.AsyncConnection.connect(dsn, row_factory=dict_row)
    await connection.execute("SELECT set_config('app.org_id', %s, false)", (org_id,))
    return connection


@asynccontextmanager
async def _seeded_orgs():
    """Async-context-manager setup/teardown (deliberately NOT a pytest async
    fixture, to avoid any ambiguity about async-fixture support across
    pytest-asyncio versions/modes) -- each test does `async with _seeded_orgs()
    as (admin_url, org_a, org_b):`."""
    admin_url = _admin_url()
    assert admin_url is not None
    admin = await psycopg.AsyncConnection.connect(admin_url, row_factory=dict_row)
    seeded_org_ids: list[str] = []
    try:
        org_a = await _seed_org(admin, "A")
        seeded_org_ids.append(org_a.org_id)
        org_b = await _seed_org(admin, "B")
        seeded_org_ids.append(org_b.org_id)
        yield admin_url, org_a, org_b
    finally:
        if seeded_org_ids:
            await admin.execute("DELETE FROM organizations WHERE id = ANY(%s)", (seeded_org_ids,))
            await admin.commit()
        await admin.close()


# ---------------------------------------------------------------------------
# AC-3: Postgres isolation holds with the app-layer filter removed (Python)
# ---------------------------------------------------------------------------


async def test_privileged_dsn_trap_org_scoped_connection_still_isolates():
    """The headline acceptance test: DATABASE_ADMIN_URL's login role is a
    superuser/BYPASSRLS role, yet org_scoped_connection(admin_url, orgA) still
    returns zero org-B rows on a filter-less SELECT, because SET LOCAL ROLE
    sayre_app -- not the DSN's own privilege -- is what determines whether RLS
    engages."""
    async with _seeded_orgs() as (admin_url, org_a, org_b):
        async with org_scoped_connection(admin_url, org_a.org_id) as conn:
            rows = await (await conn.execute("SELECT id FROM code_chunks")).fetchall()
            # psycopg3 adapts the `id uuid` column to a python uuid.UUID object, not a
            # str -- normalize with str() so this compares to the str-typed seed IDs.
            assert [str(r["id"]) for r in rows] == [org_a.chunk_id]

            cross = await (
                await conn.execute("SELECT id FROM code_chunks WHERE id = %s", (org_b.chunk_id,))
            ).fetchall()
            assert cross == [], "org A must not see org B's chunk even by direct PK lookup"


async def test_negative_control_without_set_role_leaks_across_orgs():
    """Proves the counterfactual: the exact pre-fix pattern (set_config only, no
    SET ROLE) against the same superuser DSN DOES leak -- so the isolation
    proven above is attributable to SET LOCAL ROLE sayre_app, not to some
    accident of the seed data or query shape."""
    async with _seeded_orgs() as (admin_url, org_a, org_b):
        leaky = await _leaky_connect(admin_url, org_a.org_id)
        try:
            rows = await (await leaky.execute("SELECT id FROM code_chunks")).fetchall()
            ids = {str(r["id"]) for r in rows}
            assert org_b.chunk_id in ids, (
                "regression guard: the pre-fix connect-without-SET-ROLE pattern must "
                "still demonstrably leak org B's row under a superuser DSN, proving "
                "org_scoped_connection's SET LOCAL ROLE sayre_app is what closes the gap"
            )
        finally:
            await leaky.close()


async def test_cross_org_write_is_rejected():
    async with _seeded_orgs() as (admin_url, org_a, org_b):
        with pytest.raises(Exception, match="(?i)row-level security"):
            async with org_scoped_connection(admin_url, org_a.org_id) as conn:
                await conn.execute(
                    """
                    INSERT INTO code_chunks
                        (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        str(uuid.uuid4()),
                        org_b.org_id,  # forged cross-org write while scoped to org A
                        org_a.repository_id,
                        org_a.ref_id,
                        _sha_like("xw"),
                        99,
                        "forged cross-org content",
                        f"hash-xw-{uuid.uuid4()}",
                    ),
                )


async def test_repository_refs_and_code_embeddings_also_isolated():
    async with _seeded_orgs() as (admin_url, org_a, _org_b):
        async with org_scoped_connection(admin_url, org_a.org_id) as conn:
            refs = await (await conn.execute("SELECT id FROM repository_refs")).fetchall()
            assert [str(r["id"]) for r in refs] == [org_a.ref_id]

            embeddings = await (await conn.execute("SELECT id FROM code_embeddings")).fetchall()
            assert len(embeddings) == 1


# ---------------------------------------------------------------------------
# Fail-closed: unset / empty org context
# ---------------------------------------------------------------------------


async def test_unset_app_org_id_is_fail_closed_zero_rows():
    async with _seeded_orgs() as (admin_url, _org_a, _org_b):
        # SET LOCAL ROLE only, deliberately skipping org_scoped_connection's
        # set_config step, to exercise RLS's own fail-closed behavior directly.
        conn = await psycopg.AsyncConnection.connect(admin_url, row_factory=dict_row)
        try:
            async with conn.transaction():
                await conn.execute(_SET_LOCAL_ROLE_SAYRE_APP)
                rows = await (await conn.execute("SELECT id FROM code_chunks")).fetchall()
                assert rows == [], "no app.org_id set -> zero rows, fail-closed"
        finally:
            await conn.close()


async def test_empty_string_org_id_is_fail_closed_zero_rows_no_cast_error():
    async with _seeded_orgs() as (admin_url, _org_a, _org_b):
        conn = await psycopg.AsyncConnection.connect(admin_url, row_factory=dict_row)
        try:
            async with conn.transaction():
                await conn.execute(_SET_LOCAL_ROLE_SAYRE_APP)
                await conn.execute("SELECT set_config('app.org_id', %s, true)", ("",))
                rows = await (await conn.execute("SELECT id FROM code_chunks")).fetchall()
                assert rows == [], "empty-string app.org_id -> zero rows, no invalid-uuid cast error"
        finally:
            await conn.close()


# ---------------------------------------------------------------------------
# Concurrency: two sessions with different app.org_id do not bleed
# ---------------------------------------------------------------------------


async def test_two_concurrent_org_scoped_connections_do_not_bleed():
    async with _seeded_orgs() as (admin_url, org_a, org_b):
        async with org_scoped_connection(admin_url, org_a.org_id) as conn_a:
            async with org_scoped_connection(admin_url, org_b.org_id) as conn_b:
                rows_a = await (await conn_a.execute("SELECT id FROM code_chunks")).fetchall()
                rows_b = await (await conn_b.execute("SELECT id FROM code_chunks")).fetchall()
                assert [str(r["id"]) for r in rows_a] == [org_a.chunk_id]
                assert [str(r["id"]) for r in rows_b] == [org_b.chunk_id]


# ---------------------------------------------------------------------------
# pgvector: per-tenant scoping (Resolved decision Q1 -- logical namespace)
# ---------------------------------------------------------------------------


async def test_cross_org_embedding_read_returns_nothing():
    async with _seeded_orgs() as (admin_url, org_a, _org_b):
        async with org_scoped_connection(admin_url, org_a.org_id) as conn:
            rows = await (
                await conn.execute(
                    "SELECT id FROM code_embeddings ORDER BY embedding <=> %s LIMIT 5",
                    (_vector_literal(CODE_EMBEDDINGS_DIM, fill=0.001),),
                )
            ).fetchall()
            # Only org A's own embedding can appear -- org B's is RLS-invisible even
            # though it is nearer in the ORDER BY (both share the "shared-graph-node-uid").
            assert len(rows) == 1


async def test_graph_node_id_collision_across_orgs_stays_separated():
    """Both seeded chunks share the literal graph_node_id 'shared-graph-node-uid'
    -- org_id (part of the composite scoping) keeps them strictly separate, never
    merged, even though the graph_node_id string collides."""
    async with _seeded_orgs() as (admin_url, org_a, _org_b):
        async with org_scoped_connection(admin_url, org_a.org_id) as conn:
            rows = await (
                await conn.execute(
                    "SELECT id, org_id FROM code_chunks WHERE graph_node_id = %s",
                    ("shared-graph-node-uid",),
                )
            ).fetchall()
            assert len(rows) == 1
            assert str(rows[0]["id"]) == org_a.chunk_id
            assert str(rows[0]["org_id"]) == org_a.org_id
