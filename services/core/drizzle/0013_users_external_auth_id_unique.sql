-- AUTH-01: race-safety for "same GitHub user signs in twice concurrently".
-- Without a DB-level uniqueness guard, two concurrent first-sign-ins each
-- resolve null (via resolveUserByExternalAuthId) and create two orgs for the
-- SAME GitHub user — and slug-dedup cannot catch this, since the same login
-- normalizes to the same base slug and would otherwise just get a suffixed
-- SECOND org, not a merge.
--
-- Deliberately a GLOBAL (cross-tenant) partial-unique index on an otherwise
-- per-tenant, RLS-forced table: uniqueness is checked against rows the
-- runtime role cannot SELECT (RLS-filtered), which is exactly what makes the
-- concurrent-race guard work. This is an intentional, explicit exception to
-- the "everything scopes by org" norm (OQ-1 in spec.md), not an oversight. If
-- a provider dimension is ever added, this should become a composite
-- UNIQUE (provider, external_auth_id) index instead.
--
-- Partial (WHERE external_auth_id IS NOT NULL) because NULL never
-- participates in a unique index anyway, and this makes the intent explicit.
CREATE UNIQUE INDEX users_external_auth_id_unique
  ON users (external_auth_id)
  WHERE external_auth_id IS NOT NULL;
