-- W2-09: repositories gained no revocation column in W0-05; revocation status lived only on
-- github_app_installations (suspended_at/revoked_at). Repo-level add/remove-without-reinstall now
-- needs per-repository revocation. NULL = active; existing rows default NULL (active). No new RLS
-- (repositories is already org_id FORCE-RLS from 0001) and no new index (removed/reconcile writes
-- filter on the existing repositories_org_provider_external_unique (org_id, provider, external_id)).
ALTER TABLE "repositories" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
