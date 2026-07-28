import { describe, expect, it, vi } from 'vitest';
import type { GraphWriteExecutor } from '../../graph-write/neo4j';
import {
  CLEAR_TICKET_REFERENCES_CYPHER,
  LINK_TICKET_REFERENCES_CYPHER,
  Neo4jTicketGraphStore,
  UPSERT_TICKET_CYPHER,
} from './graphTicketStore';
import type { NormalizedTicket } from './types';

const ticket: NormalizedTicket = {
  provider: 'jira',
  externalId: 'PAY-42',
  title: 'Fix checkout',
  description: '[sayre:file:src/pay.ts] [sayre:feature:Checkout]',
  status: 'In Progress',
  url: 'https://jira.test/browse/PAY-42',
  updatedAt: '2026-07-22T12:00:00Z',
  references: [
    { kind: 'file', value: 'src/pay.ts' },
    { kind: 'feature', value: 'Checkout' },
  ],
  raw: { key: 'PAY-42' },
};

describe('Neo4jTicketGraphStore', () => {
  it('upserts the Ticket and links known File/Feature nodes in server scope', async () => {
    const run = vi.fn(async (_orgId: string, query: string) => ({
      records: [{
        get: (key: string) => query === LINK_TICKET_REFERENCES_CYPHER && key === 'linked_nodes'
          ? 2
          : 1,
      }],
    }));
    const store = new Neo4jTicketGraphStore({
      run,
      close: vi.fn(async () => undefined),
    });

    await expect(store.apply({
      orgId: 'server-org',
      repositoryId: 'server-repo',
      refName: 'refs/heads/main',
      ticket,
    })).resolves.toEqual({ linkedNodes: 2 });

    expect(run).toHaveBeenCalledTimes(3);
    expect(run).toHaveBeenNthCalledWith(
      1,
      'server-org',
      UPSERT_TICKET_CYPHER,
      expect.objectContaining({
        org_id: 'server-org',
        repo_id: 'server-repo',
        ref_name: 'refs/heads/main',
        external_id: 'PAY-42',
      }),
      'upserted',
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      'server-org',
      CLEAR_TICKET_REFERENCES_CYPHER,
      expect.any(Object),
      'removed_references',
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      'server-org',
      LINK_TICKET_REFERENCES_CYPHER,
      expect.objectContaining({ references: ticket.references }),
      'linked_nodes',
    );
    expect(UPSERT_TICKET_CYPHER).toContain('MERGE (ticket:Ticket');
    expect(LINK_TICKET_REFERENCES_CYPHER).toContain('target:File');
    expect(LINK_TICKET_REFERENCES_CYPHER).toContain('target:Feature');
    expect(LINK_TICKET_REFERENCES_CYPHER).toContain('[link:REFERENCES]');
    expect(`${UPSERT_TICKET_CYPHER}${LINK_TICKET_REFERENCES_CYPHER}`).not.toMatch(/\bCREATE\b/u);
  });

  it('clears stale links without running a link query when references are empty', async () => {
    const executor: GraphWriteExecutor = {
      run: vi.fn(async () => ({ records: [{ get: () => 1 }] })),
      close: vi.fn(async () => undefined),
    };
    const store = new Neo4jTicketGraphStore(executor);
    await expect(store.apply({
      orgId: 'org',
      repositoryId: 'repo',
      refName: 'refs/heads/main',
      ticket: { ...ticket, references: [] },
    })).resolves.toEqual({ linkedNodes: 0 });
    expect(executor.run).toHaveBeenCalledTimes(2);
  });

  it('links an AI-inferred node_id reference by File.uid, not by path/name', async () => {
    const run = vi.fn(async () => ({ records: [{ get: () => 1 }] }));
    const store = new Neo4jTicketGraphStore({ run, close: vi.fn(async () => undefined) });

    await store.apply({
      orgId: 'org',
      repositoryId: 'repo',
      refName: 'refs/heads/main',
      ticket: {
        ...ticket,
        references: [{ kind: 'node_id', value: 'abc123uid' }],
      },
    });

    expect(run).toHaveBeenNthCalledWith(
      3,
      'org',
      LINK_TICKET_REFERENCES_CYPHER,
      expect.objectContaining({
        references: [{ kind: 'node_id', value: 'abc123uid' }],
      }),
      'linked_nodes',
    );
    expect(LINK_TICKET_REFERENCES_CYPHER).toContain("reference.kind = 'node_id'");
    expect(LINK_TICKET_REFERENCES_CYPHER).toContain('target.uid = reference.value');
    // Regression guard: File nodes' external "id" (CanvasNode.id, MCP tool
    // responses) is a read-side Cypher alias (`node.uid AS id`,
    // graph-query/index.ts) -- the stored property is `uid`, never `id`.
    expect(LINK_TICKET_REFERENCES_CYPHER).not.toContain('target.id = reference.value');
  });
});
