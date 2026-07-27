// Pure parser for the `installation_repositories` webhook body — mirrors
// normalizeGithubEvent.ts's style (pure function, no I/O).
//
// Tenant-isolation invariant (.claude/rules/security-multitenancy.md): this module NEVER
// reads org_id/organization/owner/account from the body — org_id is resolved server-side
// from `installation.id` by the caller (githubInstallationRepositoriesService.ts /
// githubInstallationReconcileService.ts), never from webhook body input.

export interface ParsedRepoRef {
  providerRepoId: string;
  fullName: string;
}

export interface InstallationRepositoriesEvent {
  action: 'added' | 'removed';
  installationId: number;
  added: ParsedRepoRef[]; // populated when action==='added', else []
  removed: ParsedRepoRef[]; // populated when action==='removed', else []
}

export type InstallationRepositoriesIgnore = {
  ignored: 'no_installation' | 'noop_action' | 'no_repositories';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function extractInstallationId(body: Record<string, unknown>): number | null {
  const installation = body.installation;
  if (!isRecord(installation)) return null;
  const id = installation.id;
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

/**
 * Drops any entry missing a numeric `id` or with an empty/non-string `full_name`. Remaining
 * valid entries are kept, in order.
 */
function parseRepoArray(value: unknown): ParsedRepoRef[] {
  if (!Array.isArray(value)) return [];
  const parsed: ParsedRepoRef[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    const fullName = entry.full_name;
    if (typeof id !== 'number' && typeof id !== 'string') continue;
    if (typeof fullName !== 'string' || fullName.length === 0) continue;
    parsed.push({ providerRepoId: String(id), fullName });
  }
  return parsed;
}

/**
 * Pure. Never reads org_id/organization/owner/account from `body` — installation.id is the
 * only trust anchor a caller may resolve org from, and this function doesn't even do that
 * (it just surfaces the raw numeric id for the caller's privileged lookup).
 *
 * Precedence when multiple conditions are invalid simultaneously: installation.id is checked
 * first (no_installation), then `action` (noop_action), then the repo array matching the
 * action (no_repositories) — mirroring the doc comment order in spec.md.
 */
export function parseInstallationRepositoriesEvent(
  body: Record<string, unknown>,
): InstallationRepositoriesEvent | InstallationRepositoriesIgnore {
  const installationId = extractInstallationId(body);
  if (installationId === null) {
    return { ignored: 'no_installation' };
  }

  const action = body.action;
  if (action !== 'added' && action !== 'removed') {
    return { ignored: 'noop_action' };
  }

  const added = action === 'added' ? parseRepoArray(body.repositories_added) : [];
  const removed = action === 'removed' ? parseRepoArray(body.repositories_removed) : [];
  const matching = action === 'added' ? added : removed;
  if (matching.length === 0) {
    return { ignored: 'no_repositories' };
  }

  return { action, installationId, added, removed };
}
