// Orchestration for GitHub App install lifecycle webhooks (uninstall/suspend/
// unsuspend). Business logic lives here per .claude/rules/service-layer.md;
// the caller is `githubWebhookService.ts`'s `installation` branch, which has
// already validated the HMAC signature before this ever runs.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): org_id
// is resolved ONLY via the privileged pre-tenant `resolveInstallationOrg`
// lookup (installation id -> org), then every mutation runs inside
// `withOrgContext` so RLS scopes the write to that org. Never accepts an
// org_id from the webhook body.

import { getRuntimeDb, resolveInstallationOrg } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import { markInstallationRevoked, setInstallationSuspended } from '../db/githubAppInstallWrites';

export type InstallationLifecycleResult =
  | { status: 'revoked' | 'suspended' | 'unsuspended' }
  | { status: 'ignored'; reason: 'unknown_installation' | 'noop_action' };

export interface InstallationLifecycleDeps {
  resolveOrg: (installationId: number) => Promise<{ orgId: string; active: boolean } | null>;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  markRevoked: (tx: Db, installationId: number) => Promise<boolean>;
  setSuspended: (tx: Db, installationId: number, suspended: boolean) => Promise<boolean>;
}

const defaultDeps: InstallationLifecycleDeps = {
  resolveOrg: async (installationId) => resolveInstallationOrg(await getRuntimeDb(), installationId),
  withOrg: async (orgId, fn) => withOrgContext(await getRuntimeDb(), orgId, fn),
  markRevoked: markInstallationRevoked,
  setSuspended: setInstallationSuspended,
};

/**
 * Maps `action`: `deleted` -> revoke; `suspend` -> suspend; `unsuspend` ->
 * unsuspend; anything else (`created`, `new_permissions_accepted`, an
 * `installation_repositories` action, or a missing/unrecognized action) ->
 * `{ status: 'ignored', reason: 'noop_action' }` WITHOUT hitting the
 * privileged org lookup at all. An unknown `installation_id` (resolve returns
 * null, or the org-scoped write matches zero rows) -> `{ status: 'ignored',
 * reason: 'unknown_installation' }`. Idempotent: re-delivering the same
 * action never throws.
 */
export async function applyInstallationLifecycleEvent(
  input: { action: string; installationId: number },
  deps: Partial<InstallationLifecycleDeps> = {},
): Promise<InstallationLifecycleResult> {
  const resolvedDeps: InstallationLifecycleDeps = { ...defaultDeps, ...deps };

  let statusOnSuccess: 'revoked' | 'suspended' | 'unsuspended';
  let mutate: (tx: Db, installationId: number) => Promise<boolean>;
  if (input.action === 'deleted') {
    statusOnSuccess = 'revoked';
    mutate = (tx, id) => resolvedDeps.markRevoked(tx, id);
  } else if (input.action === 'suspend') {
    statusOnSuccess = 'suspended';
    mutate = (tx, id) => resolvedDeps.setSuspended(tx, id, true);
  } else if (input.action === 'unsuspend') {
    statusOnSuccess = 'unsuspended';
    mutate = (tx, id) => resolvedDeps.setSuspended(tx, id, false);
  } else {
    return { status: 'ignored', reason: 'noop_action' };
  }

  const resolved = await resolvedDeps.resolveOrg(input.installationId);
  if (!resolved) {
    return { status: 'ignored', reason: 'unknown_installation' };
  }

  const applied = await resolvedDeps.withOrg(resolved.orgId, (tx) => mutate(tx, input.installationId));
  if (!applied) {
    return { status: 'ignored', reason: 'unknown_installation' };
  }

  return { status: statusOnSuccess };
}
