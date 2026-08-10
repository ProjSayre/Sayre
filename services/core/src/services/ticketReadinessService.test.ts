// CH-02 — behavioral tests for the ticket-readiness service layer.
//
// Authored by the `red` pipeline stage from .pipeline/spec.md alone, before any
// implementation existed. Every block cites the spec ID it exercises.
//
// The graph boundary is injected as a narrow `TicketReadinessGraphQueryService`
// double: readiness classification, grouping, ordering, and capping are pure
// service-layer behaviour and must be provable without Neo4j.

import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  TicketReadinessGraphQueryService,
  TicketReadinessTicket,
} from '../graph-query/types';
import {
  DONE_TICKET_STATUSES,
  OPEN_TICKET_STATUSES,
  READY_TICKETS_LIMIT,
  STARTED_TICKET_STATUSES,
  classifyTicketStatus,
  getReadyTickets,
  normalizeTicketStatus,
} from './ticketReadinessService';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPO_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_NAME = 'refs/heads/main';

const ctx: AuthContext = {
  subjectType: 'user',
  userId: 'user-1',
  orgId: ORG_ID,
  roles: ['member'],
};

function ticket(
  overrides: Partial<TicketReadinessTicket> & { id: string },
): TicketReadinessTicket {
  return {
    externalId: overrides.id,
    system: 'jira',
    title: `Title of ${overrides.id}`,
    status: 'Open',
    url: null,
    repositoryId: REPO_ID,
    refName: REF_NAME,
    prerequisites: [],
    feature: null,
    ...overrides,
  };
}

function graphWith(tickets: TicketReadinessTicket[]) {
  return {
    getTicketReadiness: vi.fn(async () => tickets),
  };
}

function flatTickets(groups: { tickets: { externalId: string }[] }[]): string[] {
  return groups.flatMap((group) => group.tickets.map((entry) => entry.externalId));
}

describe('getReadyTickets', () => {
  // @spec AC-1
  it('returns exactly the open tickets whose prerequisites are all done', async () => {
    const tickets = [
      ticket({
        id: 'ticket-ready',
        externalId: 'SAY-1',
        prerequisites: [{ id: 'ticket-done', status: 'Done', visible: true }],
      }),
      ticket({
        id: 'ticket-blocked-open',
        externalId: 'SAY-2',
        prerequisites: [{ id: 'ticket-open', status: 'To Do', visible: true }],
      }),
      ticket({
        id: 'ticket-blocked-started',
        externalId: 'SAY-3',
        prerequisites: [{ id: 'ticket-wip', status: 'In Progress', visible: true }],
      }),
      ticket({
        id: 'ticket-blocked-unknown',
        externalId: 'SAY-4',
        prerequisites: [{ id: 'ticket-odd', status: 'Marinating', visible: true }],
      }),
      ticket({
        id: 'ticket-partly-done',
        externalId: 'SAY-5',
        prerequisites: [
          { id: 'ticket-done', status: 'Done', visible: true },
          { id: 'ticket-open', status: 'Backlog', visible: true },
        ],
      }),
      ticket({
        id: 'ticket-all-done',
        externalId: 'SAY-6',
        prerequisites: [
          { id: 'ticket-done', status: 'Done', visible: true },
          { id: 'ticket-shipped', status: 'Shipped', visible: true },
        ],
      }),
      ticket({ id: 'ticket-free', externalId: 'SAY-7' }),
      ticket({ id: 'ticket-done', externalId: 'SAY-8', status: 'Done' }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(flatTickets(result.groups)).toEqual(['SAY-1', 'SAY-6', 'SAY-7']);
    expect(result.totalReady).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.authorization).toBe('server-filtered');
  });

  // @spec AC-3
  it('groups ready tickets by owning feature and always places the ungrouped bucket last', async () => {
    const tickets = [
      ticket({ id: 'ticket-1', externalId: 'SAY-1', feature: { id: 'f-2', name: 'Billing' } }),
      ticket({ id: 'ticket-2', externalId: 'SAY-2', feature: null }),
      ticket({ id: 'ticket-3', externalId: 'SAY-3', feature: { id: 'f-1', name: 'Access' } }),
      ticket({ id: 'ticket-4', externalId: 'SAY-4', feature: { id: 'f-2', name: 'Billing' } }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.groups).toEqual([
      {
        feature: { id: 'f-1', name: 'Access' },
        tickets: [expect.objectContaining({ externalId: 'SAY-3' })],
      },
      {
        feature: { id: 'f-2', name: 'Billing' },
        tickets: [
          expect.objectContaining({ externalId: 'SAY-1' }),
          expect.objectContaining({ externalId: 'SAY-4' }),
        ],
      },
      {
        feature: null,
        tickets: [expect.objectContaining({ externalId: 'SAY-2' })],
      },
    ]);
    expect(result.groups.at(-1)?.feature).toBeNull();
  });

  // @spec AC-9
  it('orders groups and tickets deterministically and identically across repeated calls', async () => {
    const tickets = [
      ticket({ id: 'ticket-z', externalId: 'SAY-9', feature: { id: 'f-b', name: 'Access' } }),
      ticket({ id: 'ticket-a', externalId: 'SAY-9', feature: { id: 'f-b', name: 'Access' } }),
      ticket({ id: 'ticket-m', externalId: 'SAY-1', feature: { id: 'f-b', name: 'Access' } }),
      ticket({ id: 'ticket-q', externalId: 'SAY-4', feature: { id: 'f-a', name: 'Access' } }),
      ticket({ id: 'ticket-w', externalId: 'SAY-2', feature: { id: 'f-c', name: 'Billing' } }),
      ticket({ id: 'ticket-u', externalId: 'SAY-3' }),
    ];

    const graph = graphWith(tickets);
    const first = await getReadyTickets(ctx, graph);
    const second = await getReadyTickets(ctx, graph);
    const reversed = await getReadyTickets(ctx, graphWith([...tickets].reverse()));

    expect(second).toEqual(first);
    expect(reversed).toEqual(first);
    // Groups: (name, id) ascending, ungrouped last. Two features sharing a name
    // stay two groups, ordered by feature id.
    expect(first.groups.map((group) => group.feature)).toEqual([
      { id: 'f-a', name: 'Access' },
      { id: 'f-b', name: 'Access' },
      { id: 'f-c', name: 'Billing' },
      null,
    ]);
    // Within a group: externalId ascending, then node id ascending.
    expect(first.groups[1]?.tickets.map((entry) => [entry.externalId, entry.id])).toEqual([
      ['SAY-1', 'ticket-m'],
      ['SAY-9', 'ticket-a'],
      ['SAY-9', 'ticket-z'],
    ]);
  });

  // @spec AC-10
  it('carries the narration payload with satisfiedPrerequisites equal to the done prerequisite count', async () => {
    const tickets = [
      ticket({
        id: 'ticket-1',
        externalId: 'SAY-1',
        title: 'Harden billing authorization',
        status: 'Open',
        url: 'https://example.test/SAY-1',
        feature: { id: 'f-1', name: 'Billing' },
        prerequisites: [
          { id: 'prereq-1', status: 'Done', visible: true },
          { id: 'prereq-2', status: 'Closed', visible: true },
        ],
      }),
      ticket({ id: 'ticket-2', externalId: 'SAY-2', title: null, url: null }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.groups[0]?.tickets[0]).toEqual({
      id: 'ticket-1',
      externalId: 'SAY-1',
      system: 'jira',
      title: 'Harden billing authorization',
      status: 'Open',
      url: 'https://example.test/SAY-1',
      repositoryId: REPO_ID,
      refName: REF_NAME,
      satisfiedPrerequisites: 2,
      feature: { id: 'f-1', name: 'Billing' },
    });
    // The per-ticket feature always matches its enclosing group.
    expect(result.groups[0]?.tickets[0]?.feature).toEqual(result.groups[0]?.feature);
    expect(result.groups[1]?.tickets[0]?.satisfiedPrerequisites).toBe(0);
    expect(result.groups[1]?.tickets[0]?.feature).toBeNull();
  });

  // @spec AC-6
  it('never counts an invisible prerequisite as satisfied and never leaks its identifiers', async () => {
    const tickets = [
      ticket({
        id: 'ticket-blocked',
        externalId: 'SAY-1',
        prerequisites: [{ id: 'hidden-prerequisite', status: null, visible: false }],
      }),
      ticket({
        id: 'ticket-blocked-even-when-done-looking',
        externalId: 'SAY-2',
        // A hidden prerequisite can never present a done status (the graph
        // boundary nulls it), but even if one did it must not satisfy.
        prerequisites: [{ id: 'hidden-done', status: 'Done', visible: false }],
      }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(0);
    expect(result.groups).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('hidden-prerequisite');
    expect(JSON.stringify(result)).not.toContain('hidden-done');
  });

  // @spec AC-4
  it('passes only the server-resolved auth context to the graph boundary', async () => {
    const graph = graphWith([]);

    await getReadyTickets(ctx, graph);

    expect(graph.getTicketReadiness).toHaveBeenCalledTimes(1);
    expect(graph.getTicketReadiness).toHaveBeenCalledWith(ctx);
    expect(graph.getTicketReadiness.mock.calls[0]).toHaveLength(1);
    // (ctx, graph) only — no org id, repository id, or ref parameter exists.
    expect(getReadyTickets.length).toBeLessThanOrEqual(2);
  });

  // @spec EC-1
  it('returns a well-formed empty result when the graph holds no tickets at all', async () => {
    await expect(getReadyTickets(ctx, graphWith([]))).resolves.toEqual({
      authorization: 'server-filtered',
      totalReady: 0,
      truncated: false,
      groups: [],
    });
  });

  // @spec EC-3
  it('treats an unrecognized, blank, or null status as unknown in both directions', async () => {
    const tickets = [
      ticket({ id: 'ticket-null-status', externalId: 'SAY-1', status: null }),
      ticket({ id: 'ticket-blank-status', externalId: 'SAY-2', status: '   ' }),
      ticket({ id: 'ticket-odd-status', externalId: 'SAY-3', status: 'Awaiting Cosmic Alignment' }),
      ticket({
        id: 'ticket-unknown-prerequisite',
        externalId: 'SAY-4',
        prerequisites: [{ id: 'prereq-odd', status: 'Awaiting Cosmic Alignment', visible: true }],
      }),
      ticket({
        id: 'ticket-null-prerequisite',
        externalId: 'SAY-5',
        prerequisites: [{ id: 'prereq-null', status: null, visible: true }],
      }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(0);
    expect(result.groups).toEqual([]);
  });

  // @spec EC-4
  it('never offers an already-done ticket, even with zero prerequisites', async () => {
    const tickets = DONE_TICKET_STATUSES.map((status, index) =>
      ticket({ id: `ticket-${index}`, externalId: `SAY-${index}`, status }),
    );

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(0);
    expect(result.groups).toEqual([]);
  });

  // @spec EC-5
  it('never offers a ticket whose work has already started or is explicitly held', async () => {
    const tickets = STARTED_TICKET_STATUSES.map((status, index) =>
      ticket({ id: `ticket-${index}`, externalId: `SAY-${index}`, status }),
    );

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(0);
    expect(result.groups).toEqual([]);
  });

  // @spec EC-7
  it('offers neither ticket of an open prerequisite cycle', async () => {
    const tickets = [
      ticket({
        id: 'ticket-a',
        externalId: 'SAY-A',
        status: 'Open',
        prerequisites: [{ id: 'ticket-b', status: 'Open', visible: true }],
      }),
      ticket({
        id: 'ticket-b',
        externalId: 'SAY-B',
        status: 'Open',
        prerequisites: [{ id: 'ticket-a', status: 'Open', visible: true }],
      }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(0);
    expect(result.groups).toEqual([]);
  });

  // @spec EC-13
  it('caps the carried groups at READY_TICKETS_LIMIT while reporting the true total', async () => {
    expect(READY_TICKETS_LIMIT).toBe(200);
    const tickets = Array.from({ length: 250 }, (_unused, index) =>
      ticket({
        id: `ticket-${String(index + 1).padStart(3, '0')}`,
        externalId: `SAY-${String(index + 1).padStart(3, '0')}`,
      }),
    );

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.totalReady).toBe(250);
    expect(result.truncated).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.feature).toBeNull();
    expect(result.groups[0]?.tickets).toHaveLength(READY_TICKETS_LIMIT);
    expect(result.groups[0]?.tickets[0]?.externalId).toBe('SAY-001');
    expect(result.groups[0]?.tickets.at(-1)?.externalId).toBe('SAY-200');
  });

  // @spec EC-18
  it('places every ready ticket in a single ungrouped bucket when no PART_OF edge exists', async () => {
    const tickets = [
      ticket({ id: 'ticket-1', externalId: 'SAY-1' }),
      ticket({ id: 'ticket-2', externalId: 'SAY-2' }),
    ];

    const result = await getReadyTickets(ctx, graphWith(tickets));

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.feature).toBeNull();
    expect(flatTickets(result.groups)).toEqual(['SAY-1', 'SAY-2']);
    expect(result.truncated).toBe(false);
    expect(result.totalReady).toBe(2);
  });
});

describe('ticket status classification', () => {
  // @spec AC-11
  it('classifies every documented literal case-, separator-, and apostrophe-insensitively', () => {
    const variants = (status: string): string[] => [
      status,
      status.toUpperCase(),
      `  ${status}  `,
      status.replace(/ /g, '_'),
      status.replace(/ /g, '-'),
      status.replace(/ /g, '   '),
    ];

    for (const status of DONE_TICKET_STATUSES) {
      for (const variant of variants(status)) {
        expect(classifyTicketStatus(variant)).toBe('done');
      }
    }
    for (const status of STARTED_TICKET_STATUSES) {
      for (const variant of variants(status)) {
        expect(classifyTicketStatus(variant)).toBe('started');
      }
    }
    for (const status of OPEN_TICKET_STATUSES) {
      for (const variant of variants(status)) {
        expect(classifyTicketStatus(variant)).toBe('open');
      }
    }
    expect(classifyTicketStatus("Won't Do")).toBe('done');
    expect(classifyTicketStatus("WON'T FIX")).toBe('done');
    expect(classifyTicketStatus('In_Progress')).toBe('started');
    expect(classifyTicketStatus('Ready-For-Dev')).toBe('open');
  });

  // @spec AC-11
  it('returns unknown for null, blank, and unrecognized statuses and never widens it', () => {
    expect(classifyTicketStatus(null)).toBe('unknown');
    expect(classifyTicketStatus('')).toBe('unknown');
    expect(classifyTicketStatus('     ')).toBe('unknown');
    expect(classifyTicketStatus('Awaiting Cosmic Alignment')).toBe('unknown');
    expect(classifyTicketStatus('done-ish')).toBe('unknown');
    // The three vocabularies stay disjoint, so 'unknown' can never be reached
    // by a literal that some other class also claims.
    const all = [
      ...DONE_TICKET_STATUSES,
      ...STARTED_TICKET_STATUSES,
      ...OPEN_TICKET_STATUSES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  // @spec AC-11
  it('normalizes case, apostrophes, and separator runs before matching', () => {
    expect(normalizeTicketStatus('  In_Progress ')).toBe('in progress');
    expect(normalizeTicketStatus("Won't Do")).toBe('wont do');
    expect(normalizeTicketStatus('READY--FOR__DEV')).toBe('ready for dev');
    expect(normalizeTicketStatus('To  Do')).toBe('to do');
    expect(normalizeTicketStatus(null)).toBe('');
    expect(normalizeTicketStatus('   ')).toBe('');
  });
});

describe('service-layer contract shape', () => {
  // @spec AC-4
  it('accepts a narrow graph contract only, with ctx as the sole identity input', async () => {
    // Typed against the published narrow interface: a double implementing only
    // getTicketReadiness must be enough, which is what keeps ctx.orgId the one
    // and only tenant input.
    const graph: TicketReadinessGraphQueryService = {
      getTicketReadiness: async () => [],
    };

    await expect(getReadyTickets(ctx, graph)).resolves.toMatchObject({
      authorization: 'server-filtered',
    });
  });
});
