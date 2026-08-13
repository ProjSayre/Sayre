// Orchestration for the manual "Refresh installations" reconciliation endpoint (W2-09, now
// W7-01). Business logic lives here per .claude/rules/service-layer.md; the caller
// (routes/githubInstallationReconcile.ts) is a thin HTTP adapter that only calls
// `reconcileInstallationRepositories`.
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): `orgId` comes ONLY
// from `ctx.orgId` — the server-resolved session `AuthContext` the route attaches via
// authenticate()/requireAuthContext() — NEVER from a query param or request body. Every
// read/write below runs against that single resolved org, scoped by `withOrgContext` (RLS).
//
// W7-01 authorization note (supersedes W2-09's OQ-5 "never revokes" block): the destructive
// direction now exists — a `manual_reconcile` run that reaches `complete` may revoke a
// repository GitHub no longer reports (see `githubInstallationDiscoveryService.ts`'s
// `runRevokeSweep`) — but it is asynchronous, performed entirely by the discovery WORKER, and
// authorized by THIS endpoint's `authenticate()` + `authorize('admin')` gate at row-creation
// time (`reason: 'manual_reconcile'`, `requestedBy` captured from `ctx`). This request-path
// function itself still performs no listing, no registration, and no revocation inline — it has
// no GitHub client, no repo-registration writer, and no repo-revocation writer dependency; it
// only records one durable, admin-authorized run row per active installation and kicks the
// dispatcher (AC-10, AC-25, AC-29).
//
// Credential invariant: no credential is read or minted on this request path at all now.

import type { AuthContext } from '../auth/context';
import { getRuntimeDb } from '../db/installations';
import { withOrgContext, type Db } from '../db/client';
import { listActiveInstallationsForOrg } from '../db/githubAppInstallWrites';
import {
  startInstallationSync,
  type InstallationSyncSubject,
} from '../db/githubInstallationSyncStore';
import { kickInstallationDiscoveryDispatcher } from './installationDiscoveryWake';

export interface ReconcileResult {
  status: 'queued';
  installations: number; // active installations for this org
  queued: number; // discovery runs started (== installations on success)
}

export interface ReconcileDeps {
  resolveActiveInstallations: (orgId: string) => Promise<Array<{ installationId: number }>>;
  withOrg: <T>(orgId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  startInstallationSync: typeof startInstallationSync;
  kickDiscoveryDispatcher: () => void;
  // Still no repo-revocation writer, no GitHub client, no repo-registration writer, no
  // initial-parse enqueue dependency: the request path performs no listing, no registration
  // and no revocation. It records an admin-authorized INTENT; the worker executes it.
}

const defaultDeps: ReconcileDeps = {
  resolveActiveInstallations: async (orgId) =>
    withOrgContext(await getRuntimeDb(), orgId, (tx) => listActiveInstallationsForOrg(tx, orgId)),
  withOrg: async (orgId, fn) => withOrgContext(await getRuntimeDb(), orgId, fn),
  startInstallationSync,
  kickDiscoveryDispatcher: kickInstallationDiscoveryDispatcher,
};

function requestedBySubject(ctx: AuthContext): InstallationSyncSubject {
  return ctx.subjectType === 'user'
    ? { subjectType: 'user', subjectId: ctx.userId }
    : { subjectType: 'agent_key', subjectId: ctx.agentKeyId };
}

/**
 * `ctx.orgId` comes ONLY from the server-resolved session (`AuthContext`) — never from
 * query/body. Records one durable `manual_reconcile` run row per active installation (carrying
 * the `ctx`-derived subject), all in ONE `withOrgContext(ctx.orgId)` transaction, then kicks the
 * discovery dispatcher after commit. Row-write-only — see the file header.
 */
export async function reconcileInstallationRepositories(
  ctx: AuthContext,
  deps: Partial<ReconcileDeps> = {},
): Promise<ReconcileResult> {
  const resolvedDeps: ReconcileDeps = { ...defaultDeps, ...deps };
  const orgId = ctx.orgId;

  const installations = await resolvedDeps.resolveActiveInstallations(orgId);
  if (installations.length === 0) {
    return { status: 'queued', installations: 0, queued: 0 };
  }

  const requestedBy = requestedBySubject(ctx);
  const queued = await resolvedDeps.withOrg(orgId, async (tx) => {
    let count = 0;
    for (const installation of installations) {
      await resolvedDeps.startInstallationSync(tx, {
        orgId,
        installationId: installation.installationId,
        reason: 'manual_reconcile',
        requestedBy,
      });
      count += 1;
    }
    return count;
  });

  resolvedDeps.kickDiscoveryDispatcher();

  return { status: 'queued', installations: installations.length, queued };
}
