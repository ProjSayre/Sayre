// CH-02 — deterministic, graph-computed answer to "which tickets are
// unblocked and ready to start right now?" See .pipeline/spec.md for the full
// design and .claude/rules/service-layer.md for why this stays a plain
// function rather than logic inline in a route handler or MCP handler.

import type { AuthContext } from '../auth/context';
import { graphQueryService } from '../graph-query';
import type {
  TicketReadinessGraphQueryService,
  TicketReadinessTicket,
} from '../graph-query/types';

/**
 * Jira and Linear both expose a free-text workflow status name, so this is a
 * closed, documented vocabulary rather than an inference. Anything outside it —
 * including null and blank — is 'unknown', and 'unknown' is deliberately
 * unhelpful in both directions: never a ready candidate, never a satisfied
 * prerequisite. A team with custom status names therefore gets fewer answers,
 * never wrong ones.
 */
export type TicketStatusClass = 'done' | 'started' | 'open' | 'unknown';

/** Normalized (see `normalizeTicketStatus`) status literals per class. */
export const DONE_TICKET_STATUSES: readonly string[] = [
  'done', 'closed', 'complete', 'completed', 'resolved', 'shipped', 'released',
  'merged', 'deployed', 'cancelled', 'canceled', 'duplicate', 'rejected',
  'wont do', 'wont fix', 'will not do', 'abandoned',
];
export const STARTED_TICKET_STATUSES: readonly string[] = [
  'in progress', 'in development', 'in dev', 'in review', 'in qa', 'in testing',
  'started', 'doing', 'review', 'code review', 'qa', 'testing', 'blocked',
  'on hold', 'paused', 'waiting',
];
export const OPEN_TICKET_STATUSES: readonly string[] = [
  'open', 'reopened', 'to do', 'todo', 'backlog', 'new', 'ready',
  'ready for dev', 'ready for development', 'selected for development',
  'triage', 'unstarted', 'planned', 'not started',
];

const DONE_STATUS_SET = new Set(DONE_TICKET_STATUSES.map(normalizeTicketStatus));
const STARTED_STATUS_SET = new Set(STARTED_TICKET_STATUSES.map(normalizeTicketStatus));
const OPEN_STATUS_SET = new Set(OPEN_TICKET_STATUSES.map(normalizeTicketStatus));

/** lowercase, apostrophes removed, `[\s_-]+` collapsed to one space, trimmed. */
export function normalizeTicketStatus(status: string | null): string {
  if (status === null) return '';
  return status
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[\s_-]+/g, ' ')
    .trim();
}

export function classifyTicketStatus(status: string | null): TicketStatusClass {
  const normalized = normalizeTicketStatus(status);
  if (normalized.length === 0) return 'unknown';
  if (DONE_STATUS_SET.has(normalized)) return 'done';
  if (STARTED_STATUS_SET.has(normalized)) return 'started';
  if (OPEN_STATUS_SET.has(normalized)) return 'open';
  return 'unknown';
}

/** Maximum ready tickets carried in `groups`; `totalReady` still reports the true count. */
export const READY_TICKETS_LIMIT = 200;

export interface ReadyTicketFeature {
  id: string;
  name: string;
}

export interface ReadyTicket {
  id: string;
  externalId: string;
  system: string;
  title: string | null;
  status: string | null;
  url: string | null;
  repositoryId: string;
  refName: string;
  /** Count of this ticket's prerequisites — all of which are done, or it would not be here. */
  satisfiedPrerequisites: number;
  /** Always identical to the enclosing group's `feature`. */
  feature: ReadyTicketFeature | null;
}

export interface ReadyTicketGroup {
  /** null is the ungrouped bucket; it is always the last group. */
  feature: ReadyTicketFeature | null;
  tickets: ReadyTicket[];
}

export interface ReadyTicketsResult {
  authorization: 'server-filtered';
  /** Ready tickets found before READY_TICKETS_LIMIT was applied. */
  totalReady: number;
  /** True when `totalReady` exceeds the number of tickets carried in `groups`. */
  truncated: boolean;
  groups: ReadyTicketGroup[];
}

function isReady(ticket: TicketReadinessTicket): boolean {
  if (classifyTicketStatus(ticket.status) !== 'open') return false;
  return ticket.prerequisites.every(
    (prerequisite) =>
      prerequisite.visible === true &&
      classifyTicketStatus(prerequisite.status) === 'done',
  );
}

function compareReadyTickets(left: ReadyTicket, right: ReadyTicket): number {
  const leftUngrouped = left.feature === null ? 1 : 0;
  const rightUngrouped = right.feature === null ? 1 : 0;
  if (leftUngrouped !== rightUngrouped) return leftUngrouped - rightUngrouped;

  if (left.feature && right.feature) {
    const nameCompare = left.feature.name.localeCompare(right.feature.name);
    if (nameCompare !== 0) return nameCompare;
    const idCompare = left.feature.id.localeCompare(right.feature.id);
    if (idCompare !== 0) return idCompare;
  }

  const externalIdCompare = left.externalId.localeCompare(right.externalId);
  if (externalIdCompare !== 0) return externalIdCompare;
  return left.id.localeCompare(right.id);
}

function featureGroupKey(feature: ReadyTicketFeature | null): string | null {
  return feature === null ? null : `${feature.name}\u0000${feature.id}`;
}

export async function getReadyTickets(
  ctx: AuthContext,
  graph: TicketReadinessGraphQueryService = graphQueryService,
): Promise<ReadyTicketsResult> {
  const tickets = await graph.getTicketReadiness(ctx);

  const ready: ReadyTicket[] = tickets.filter(isReady).map((ticket) => ({
    id: ticket.id,
    externalId: ticket.externalId,
    system: ticket.system,
    title: ticket.title,
    status: ticket.status,
    url: ticket.url,
    repositoryId: ticket.repositoryId,
    refName: ticket.refName,
    satisfiedPrerequisites: ticket.prerequisites.length,
    feature: ticket.feature,
  }));

  ready.sort(compareReadyTickets);

  const totalReady = ready.length;
  const taken = ready.slice(0, READY_TICKETS_LIMIT);
  const truncated = totalReady > taken.length;

  const groups: ReadyTicketGroup[] = [];
  let currentKey: string | null | undefined;
  for (const ticket of taken) {
    const key = featureGroupKey(ticket.feature);
    if (groups.length === 0 || key !== currentKey) {
      groups.push({ feature: ticket.feature, tickets: [] });
      currentKey = key;
    }
    groups[groups.length - 1]?.tickets.push(ticket);
  }

  return {
    authorization: 'server-filtered',
    totalReady,
    truncated,
    groups,
  };
}
