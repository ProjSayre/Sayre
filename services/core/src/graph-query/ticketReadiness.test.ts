// CH-02 — behavioral tests for the ticket-readiness graph boundary.
//
// Authored by the `red` pipeline stage from .pipeline/spec.md alone, before any
// implementation existed. Every block cites the spec ID it exercises.
//
// This checkout has no live Neo4j, so — exactly like every existing suite in
// this directory — the executor is a double and the record mapper is exercised
// directly. Query-shape guarantees that only the database can finally enforce
// (org predicate, RBAC rule predicates, single-hop prerequisite pattern,
// PART_OF-only grouping) are asserted against the exported Cypher text, the
// same way index.test.ts already asserts them for the canvas queries.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type { GraphReadExecutor, GraphReadRecord } from './neo4j';
import type { PermissionStore, ReadScope } from './permissions';
import {
  GET_READY_TICKETS_CYPHER,
  GET_READY_TICKETS_ROW_LIMIT,
  RbacGraphQueryService,
} from './index';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_REPO_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REF_NAME = 'refs/heads/main';

function user(userId: string): AuthContext {
  return { subjectType: 'user', userId, orgId: ORG_ID, roles: ['member'] };
}

function record(values: Record<string, unknown>): GraphReadRecord {
  return { get: (key) => values[key] };
}

/** One RETURN row of GET_READY_TICKETS_CYPHER: a ticket, at most one
 *  prerequisite, at most one feature. */
function ticketRow(overrides: Record<string, unknown> = {}): GraphReadRecord {
  return record({
    ticket_id: 'ticket-1',
    ticket_org_id: ORG_ID,
    ticket_external_id: 'SAY-1',
    ticket_system: 'jira',
    ticket_title: 'Harden billing authorization',
    ticket_status: 'Open',
    ticket_url: 'https://example.test/SAY-1',
    ticket_repo_id: REPO_ID,
    ticket_ref_name: REF_NAME,
    prerequisite_id: null,
    prerequisite_org_id: null,
    prerequisite_repo_id: null,
    prerequisite_ref_name: null,
    prerequisite_status: null,
    prerequisite_edge_org_id: null,
    prerequisite_edge_type: null,
    feature_id: null,
    feature_name: null,
    feature_org_id: null,
    feature_repo_id: null,
    feature_ref_name: null,
    membership_org_id: null,
    ...overrides,
  });
}

/** A row whose prerequisite columns are all populated and self-consistent. */
function withPrerequisite(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prerequisite_id: 'ticket-9',
    prerequisite_org_id: ORG_ID,
    prerequisite_repo_id: REPO_ID,
    prerequisite_ref_name: REF_NAME,
    prerequisite_status: 'Done',
    prerequisite_edge_org_id: ORG_ID,
    prerequisite_edge_type: 'REQUIRES',
    ...overrides,
  };
}

/** A row whose feature columns are all populated and self-consistent. */
function withFeature(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    feature_id: 'feature-billing',
    feature_name: 'Billing',
    feature_org_id: ORG_ID,
    feature_repo_id: REPO_ID,
    feature_ref_name: REF_NAME,
    membership_org_id: ORG_ID,
    ...overrides,
  };
}

interface ExecutorCall {
  orgId: string;
  shape: string;
  cypher: string;
  parameters: Record<string, unknown>;
}

class QueueExecutor implements GraphReadExecutor {
  readonly calls: ExecutorCall[] = [];

  readonly run = vi.fn(
    async (
      orgId: string,
      shape: Parameters<GraphReadExecutor['run']>[1],
      cypher: string,
      parameters: Readonly<Record<string, unknown>>,
    ) => {
      this.calls.push({ orgId, shape, cypher, parameters: { ...parameters } });
      return { records: this.results.shift() ?? [] };
    },
  );

  readonly close = vi.fn(async () => undefined);

  constructor(private readonly results: GraphReadRecord[][] = []) {}
}

class FixedPermissionStore implements PermissionStore {
  constructor(private readonly scope: ReadScope) {}

  async getReadScope(): Promise<ReadScope> {
    return this.scope;
  }
}

const repositoryScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: null }],
  denies: [],
};
const pathScope: ReadScope = {
  allows: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: 'src/public' }],
  denies: [],
};
const deniedScope: ReadScope = {
  allows: [{ repoId: null, branch: null, pathPrefix: null }],
  denies: [{ repoId: REPO_ID, branch: REF_NAME, pathPrefix: null }],
};
const emptyScope: ReadScope = { allows: [], denies: [] };

function serviceFor(
  scope: ReadScope,
  rows: GraphReadRecord[] = [],
): { service: RbacGraphQueryService; executor: QueueExecutor } {
  const executor = new QueueExecutor([rows]);
  return {
    service: new RbacGraphQueryService(executor, new FixedPermissionStore(scope)),
    executor,
  };
}

describe('RbacGraphQueryService.getTicketReadiness', () => {
  // @spec AC-4
  it('binds $org_id from the auth context alone and embeds no literal tenant id', async () => {
    const { service, executor } = serviceFor(repositoryScope, []);

    await service.getTicketReadiness(user('alice'));

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.orgId).toBe(ORG_ID);
    expect(executor.calls[0]?.shape).toBe('traversal');
    expect(executor.calls[0]?.cypher).toBe(GET_READY_TICKETS_CYPHER);
    expect(executor.calls[0]?.parameters).toEqual({
      org_id: ORG_ID,
      allow_rules: [{ repo_id: REPO_ID, branch: REF_NAME, path_prefix: null }],
      deny_rules: [],
    });
    expect(GET_READY_TICKETS_CYPHER).toContain('ticket.org_id = $org_id');
    expect(GET_READY_TICKETS_CYPHER).not.toContain(ORG_ID);
    expect(GET_READY_TICKETS_CYPHER).not.toContain(OTHER_ORG_ID);
  });

  // @spec AC-4
  it('drops any record whose ticket, prerequisite, edge, feature, or membership org differs', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_id: 'foreign-ticket', ticket_external_id: 'SAY-0', ticket_org_id: OTHER_ORG_ID }),
      ticketRow({
        ticket_id: 'ticket-1',
        ticket_external_id: 'SAY-1',
        ...withPrerequisite({ prerequisite_org_id: OTHER_ORG_ID }),
        ...withFeature({ feature_org_id: OTHER_ORG_ID }),
      }),
      ticketRow({
        ticket_id: 'ticket-2',
        ticket_external_id: 'SAY-2',
        ...withPrerequisite({ prerequisite_edge_org_id: OTHER_ORG_ID }),
        ...withFeature({ membership_org_id: OTHER_ORG_ID }),
      }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-1', 'ticket-2']);
    expect(tickets.every((entry) => entry.prerequisites.length === 0)).toBe(true);
    expect(tickets.every((entry) => entry.feature === null)).toBe(true);
    expect(JSON.stringify(tickets)).not.toContain('foreign-ticket');
  });

  // @spec AC-5
  it('returns a repository-root-granted caller its tickets and a path-scoped caller none', async () => {
    const granted = serviceFor(repositoryScope, [ticketRow()]);
    const pathScoped = serviceFor(pathScope, [ticketRow()]);

    await expect(granted.service.getTicketReadiness(user('alice'))).resolves.toMatchObject([
      { id: 'ticket-1', externalId: 'SAY-1' },
    ]);
    await expect(pathScoped.service.getTicketReadiness(user('bob'))).resolves.toEqual([]);
    expect(GET_READY_TICKETS_CYPHER).toContain('ANY(rule IN $allow_rules');
    expect(GET_READY_TICKETS_CYPHER).toContain('NOT ANY(rule IN $deny_rules');
    expect(GET_READY_TICKETS_CYPHER).toContain('rule.path_prefix IS NULL');
  });

  // @spec AC-5
  it('removes a ticket covered by a matching deny rule', async () => {
    const { service } = serviceFor(deniedScope, [ticketRow()]);

    await expect(service.getTicketReadiness(user('alice'))).resolves.toEqual([]);
  });

  // @spec AC-5 EC-2
  it('returns [] without a graph round trip when the caller has zero allow rules', async () => {
    const { service, executor } = serviceFor(emptyScope, [ticketRow()]);

    await expect(service.getTicketReadiness(user('alice'))).resolves.toEqual([]);
    expect(executor.run).not.toHaveBeenCalled();
    expect(executor.calls).toHaveLength(0);
  });

  // @spec AC-2
  it('admits a DEPENDS_ON prerequisite exactly as it admits a REQUIRES one', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({
        ticket_id: 'ticket-1',
        ticket_external_id: 'SAY-1',
        ...withPrerequisite({ prerequisite_edge_type: 'REQUIRES' }),
      }),
      ticketRow({
        ticket_id: 'ticket-2',
        ticket_external_id: 'SAY-2',
        ...withPrerequisite({ prerequisite_edge_type: 'DEPENDS_ON' }),
      }),
      ticketRow({
        ticket_id: 'ticket-3',
        ticket_external_id: 'SAY-3',
        ...withPrerequisite({ prerequisite_edge_type: 'REFERENCES' }),
      }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));
    const byId = new Map(tickets.map((entry) => [entry.id, entry]));

    expect(byId.get('ticket-1')?.prerequisites).toEqual([
      { id: 'ticket-9', status: 'Done', visible: true },
    ]);
    expect(byId.get('ticket-2')?.prerequisites).toEqual([
      { id: 'ticket-9', status: 'Done', visible: true },
    ]);
    expect(byId.get('ticket-3')?.prerequisites).toEqual([]);
    expect(GET_READY_TICKETS_CYPHER).toMatch(
      /type\(\s*prerequisite_edge\s*\)\s+IN\s*\[\s*'REQUIRES'\s*,\s*'DEPENDS_ON'\s*\]/,
    );
  });

  // @spec AC-6
  it('marks an out-of-scope prerequisite invisible and withholds its status', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({
        ...withPrerequisite({
          prerequisite_repo_id: OTHER_REPO_ID,
          prerequisite_status: 'Done',
        }),
      }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    expect(ticket?.prerequisites).toEqual([
      { id: 'ticket-9', status: null, visible: false },
    ]);
  });

  // @spec AC-6
  it('de-duplicates prerequisites by id and orders them ascending', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ...withPrerequisite({ prerequisite_id: 'ticket-c' }) }),
      ticketRow({ ...withPrerequisite({ prerequisite_id: 'ticket-a' }) }),
      ticketRow({ ...withPrerequisite({ prerequisite_id: 'ticket-c' }) }),
      ticketRow({ ...withPrerequisite({ prerequisite_id: 'ticket-b' }) }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    expect(ticket?.prerequisites.map((entry) => entry.id)).toEqual([
      'ticket-a',
      'ticket-b',
      'ticket-c',
    ]);
  });

  // @spec EC-6
  it('drops a self-referential prerequisite so a self-loop cannot hide a ticket', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ...withPrerequisite({ prerequisite_id: 'ticket-1', prerequisite_status: 'Open' }) }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    expect(ticket?.id).toBe('ticket-1');
    expect(ticket?.prerequisites).toEqual([]);
  });

  // @spec EC-7
  it('reads prerequisites through a single-hop pattern that cannot traverse a cycle', () => {
    expect(GET_READY_TICKETS_CYPHER).toMatch(
      /OPTIONAL MATCH \(ticket\)-\[prerequisite_edge\]->\(prerequisite:Ticket\)/,
    );
    // No variable-length relationship pattern anywhere: a cycle can therefore
    // never expand into an unbounded traversal.
    expect(GET_READY_TICKETS_CYPHER).not.toMatch(/\[[^\]\n]*\*/);
  });

  // @spec EC-8
  it('lists a multi-feature ticket once, under the lowest (name, id) feature', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ...withFeature({ feature_id: 'feature-2', feature_name: 'Billing' }) }),
      ticketRow({ ...withFeature({ feature_id: 'feature-9', feature_name: 'Access' }) }),
      ticketRow({ ...withFeature({ feature_id: 'feature-1', feature_name: 'Access' }) }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets).toHaveLength(1);
    expect(tickets[0]?.feature).toEqual({ id: 'feature-1', name: 'Access' });
  });

  // @spec EC-9
  it('ignores a Feature from another repository, ref, or org', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({
        ticket_id: 'ticket-1',
        ticket_external_id: 'SAY-1',
        ...withFeature({ feature_repo_id: OTHER_REPO_ID }),
      }),
      ticketRow({
        ticket_id: 'ticket-2',
        ticket_external_id: 'SAY-2',
        ...withFeature({ feature_ref_name: 'refs/heads/other' }),
      }),
      ticketRow({
        ticket_id: 'ticket-3',
        ticket_external_id: 'SAY-3',
        ...withFeature({ feature_org_id: OTHER_ORG_ID }),
      }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-1', 'ticket-2', 'ticket-3']);
    expect(tickets.every((entry) => entry.feature === null)).toBe(true);
  });

  // @spec EC-10
  it('ignores a prerequisite relationship carrying a foreign org id on the edge', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({
        ...withPrerequisite({
          prerequisite_edge_org_id: OTHER_ORG_ID,
          prerequisite_status: 'Open',
        }),
      }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    // Neither counted nor blocking: for this tenant the edge does not exist.
    expect(ticket?.prerequisites).toEqual([]);
  });

  // @spec EC-11
  it('drops a ticket whose rows disagree about its identity, and never re-adds it', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_id: 'ticket-1', ticket_external_id: 'SAY-1', ticket_status: 'Open' }),
      ticketRow({ ticket_id: 'ticket-1', ticket_external_id: 'SAY-1', ticket_status: 'Done' }),
      ticketRow({ ticket_id: 'ticket-1', ticket_external_id: 'SAY-1', ticket_status: 'Open' }),
      ticketRow({ ticket_id: 'ticket-2', ticket_external_id: 'SAY-2' }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-2']);
  });

  // @spec EC-12
  it('drops the final row-capped ticket, whose prerequisite list may be incomplete', async () => {
    expect(GET_READY_TICKETS_ROW_LIMIT).toBe(4096);
    const rows = Array.from({ length: GET_READY_TICKETS_ROW_LIMIT }, (_unused, index) => {
      const id = `ticket-${String(index).padStart(4, '0')}`;
      return ticketRow({ ticket_id: id, ticket_external_id: `SAY-${String(index).padStart(4, '0')}` });
    });
    const { service } = serviceFor(repositoryScope, rows);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets).toHaveLength(GET_READY_TICKETS_ROW_LIMIT - 1);
    expect(tickets.at(-1)?.id).toBe('ticket-4094');
    expect(tickets.some((entry) => entry.id === 'ticket-4095')).toBe(false);
    expect(GET_READY_TICKETS_CYPHER).toContain(`LIMIT ${GET_READY_TICKETS_ROW_LIMIT}`);
  });

  // @spec EC-12
  it('keeps every ticket when the executor returns fewer rows than the cap', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_id: 'ticket-1', ticket_external_id: 'SAY-1' }),
      ticketRow({ ticket_id: 'ticket-2', ticket_external_id: 'SAY-2' }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-1', 'ticket-2']);
  });

  // @spec EC-14
  it('emits a non-http(s) ticket url as null', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_url: 'javascript:alert(1)' }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    expect(ticket?.url).toBeNull();
  });

  // @spec EC-16
  it('normalizes blank title, status, and url values to null', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_title: '   ', ticket_status: '', ticket_url: '  ' }),
    ]);

    const [ticket] = await service.getTicketReadiness(user('alice'));

    expect(ticket?.title).toBeNull();
    expect(ticket?.status).toBeNull();
    expect(ticket?.url).toBeNull();
  });

  // @spec EC-17
  it('drops a ticket missing repo_id or ref_name, and treats such a prerequisite as invisible', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_id: 'ticket-no-repo', ticket_external_id: 'SAY-1', ticket_repo_id: null }),
      ticketRow({ ticket_id: 'ticket-no-ref', ticket_external_id: 'SAY-2', ticket_ref_name: null }),
      ticketRow({
        ticket_id: 'ticket-ok',
        ticket_external_id: 'SAY-3',
        ...withPrerequisite({ prerequisite_repo_id: null }),
      }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-ok']);
    expect(tickets[0]?.prerequisites).toEqual([
      { id: 'ticket-9', status: null, visible: false },
    ]);
  });

  // @spec EC-19
  it('groups only through PART_OF, never through REFERENCES', () => {
    expect(GET_READY_TICKETS_CYPHER).toMatch(
      /OPTIONAL MATCH \(ticket\)-\[membership:PART_OF\]->\(feature:Feature\)/,
    );
    expect(GET_READY_TICKETS_CYPHER).not.toContain('REFERENCES');
  });

  // @spec AC-9
  it('returns tickets ordered by externalId then node id', async () => {
    const { service } = serviceFor(repositoryScope, [
      ticketRow({ ticket_id: 'ticket-z', ticket_external_id: 'SAY-9' }),
      ticketRow({ ticket_id: 'ticket-a', ticket_external_id: 'SAY-9' }),
      ticketRow({ ticket_id: 'ticket-m', ticket_external_id: 'SAY-1' }),
    ]);

    const tickets = await service.getTicketReadiness(user('alice'));

    expect(tickets.map((entry) => entry.id)).toEqual(['ticket-m', 'ticket-a', 'ticket-z']);
  });
});

describe('graph schema documentation', () => {
  // @spec AC-13
  it('records the ticket endpoint pairs without widening either closed set', () => {
    const schema = readFileSync(
      new URL('../../../../packages/graph-schema/schema.md', import.meta.url),
      'utf8',
    );
    const rowFor = (relationship: string): string =>
      schema
        .split(/\r?\n/)
        .find((line) => line.startsWith(`| \`${relationship}\` |`)) ?? '';

    expect(rowFor('REQUIRES')).toContain('Ticket->Ticket');
    expect(rowFor('DEPENDS_ON')).toContain('Ticket->Ticket');
    expect(rowFor('PART_OF')).toContain('Ticket->Feature');
    // No new node label and no new relationship type: both closed sets keep
    // their documented counts.
    expect(schema).toContain('## Node labels (13)');
    expect(schema).toContain('## Relationship types (13)');
  });
});
