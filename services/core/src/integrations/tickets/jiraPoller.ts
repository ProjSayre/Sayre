// Jira ticket poll loop. W3-05 built `enqueueScheduledTicketSync` for exactly
// this ("Enqueues the scheduler's authoritative ticket list for a polling
// cycle") but nothing ever called it, and W3-10 built the connect flow but no
// sync trigger — this closes that gap.
//
// A Jira-side webhook would need a new OAuth scope + a forced reconnect for
// every already-connected org, plus webhook registration/expiry/refresh
// bookkeeping. Polling needs none of that: `db/jiraPollDiscovery.ts`'s
// `listActiveJiraOrgIds` (migration 0017's SECURITY DEFINER resolver, same
// shape as migration 0011's GitHub installation resolver) discovers which
// orgs have an active connection despite `jira_connections` being FORCE-RLS
// org-scoped, then this module fans each org's recently-updated tickets out
// to every one of its connected repositories.
//
// Syncing a ticket into a repo it doesn't reference is a harmless no-op
// (`syncTicket`'s `graph.apply` links 0 nodes there) — fanning out to every
// active repo in the org, rather than trying to guess which repo a ticket
// "belongs to" (nothing in the product records that mapping), is deliberately
// simple and safe rather than a shortcut.

import { randomUUID } from 'node:crypto';
import {
  getRuntimeDb,
  listActiveJiraOrgIds,
  listActiveJiraRepositories,
} from '../../db/jiraPollDiscovery';
import type { Db } from '../../db/client';
import {
  getOrgSecret,
  resolveJiraConnectionContext,
  OrgSecretUnavailableError,
} from './jira/orgSecrets';
import { createDefaultJiraOAuthClient, type JiraOAuthClient } from './jira/jiraOAuthClient';
import { enqueueScheduledTicketSync } from '../../services/ticketSyncIngress';

export interface JiraPollDeps {
  getDb: () => Promise<Db>;
  listOrgIds: (db: Db) => Promise<string[]>;
  listRepositories: (
    db: Db,
    orgId: string,
  ) => Promise<Array<{ id: string; defaultBranch: string | null }>>;
  resolveContext: typeof resolveJiraConnectionContext;
  getToken: typeof getOrgSecret;
  oauthClient: JiraOAuthClient;
  enqueue: typeof enqueueScheduledTicketSync;
  now: () => Date;
  /** How far back to search on every cycle. Deliberately generous vs. the poll
   * interval — overlap is safe (BullMQ job ids are idempotency-keyed per
   * ticket/cycle), so there's no persisted "last polled" cursor to get wrong. */
  lookbackMs: number;
  onOrgError: (orgId: string, error: unknown) => void;
}

const defaultDeps: JiraPollDeps = {
  getDb: getRuntimeDb,
  listOrgIds: listActiveJiraOrgIds,
  listRepositories: listActiveJiraRepositories,
  resolveContext: resolveJiraConnectionContext,
  getToken: getOrgSecret,
  oauthClient: createDefaultJiraOAuthClient(),
  enqueue: enqueueScheduledTicketSync,
  now: () => new Date(),
  lookbackMs: 15 * 60 * 1000,
  onOrgError: (orgId, error) => {
    // eslint-disable-next-line no-console
    console.error(`[jira-poll] org ${orgId} failed:`, error);
  },
};

export interface JiraPollCycleResult {
  orgsPolled: number;
  ticketsFound: number;
  jobsEnqueued: number;
}

/** One poll cycle: discover active orgs, fan each org's recently-updated tickets out to its active repos. */
export async function runJiraPollCycle(
  deps: Partial<JiraPollDeps> = {},
): Promise<JiraPollCycleResult> {
  const resolved: JiraPollDeps = { ...defaultDeps, ...deps };
  const db = await resolved.getDb();
  const orgIds = await resolved.listOrgIds(db);
  const cycleId = randomUUID();
  const since = new Date(resolved.now().getTime() - resolved.lookbackMs);

  let ticketsFound = 0;
  let jobsEnqueued = 0;

  for (const orgId of orgIds) {
    try {
      const ctx = await resolved.resolveContext(orgId);
      if (ctx === null) continue;

      const token = await resolved.getToken(orgId, 'JIRA_ACCESS_TOKEN');
      const keys = await resolved.oauthClient.searchRecentIssueKeys(
        token,
        ctx.apiBaseUrl,
        since,
      );
      if (keys.length === 0) continue;
      ticketsFound += keys.length;

      const repos = await resolved.listRepositories(db, orgId);
      for (const repo of repos) {
        const jobIds = await resolved.enqueue({
          provider: 'jira',
          scope: { orgId, repositoryId: repo.id, refName: repo.defaultBranch ?? 'main' },
          externalTicketIds: keys,
          cycleId,
        });
        jobsEnqueued += jobIds.length;
      }
    } catch (error) {
      // No active/usable connection (revoked mid-cycle, refresh failed) is an
      // expected, quiet skip — not a cycle-ending error.
      if (error instanceof OrgSecretUnavailableError) continue;
      resolved.onOrgError(orgId, error);
    }
  }

  return { orgsPolled: orgIds.length, ticketsFound, jobsEnqueued };
}
