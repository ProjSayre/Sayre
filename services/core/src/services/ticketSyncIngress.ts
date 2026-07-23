import { createHash } from 'node:crypto';
import { enqueue, type TicketSyncPayload, type TicketUpdatePayload } from '../queue/bullmq';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import { JiraProviderAdapter } from '../integrations/tickets/providers/jira';
import { LinearProviderAdapter } from '../integrations/tickets/providers/linear';
import { TicketProviderRegistry } from '../integrations/tickets/providerRegistry';
import type { TicketProvider } from '../integrations/tickets/types';

interface ServerResolvedTicketScope {
  orgId: string;
  repositoryId: string;
  refName: string;
}

type EnqueueTicket = (
  provider: TicketProvider,
  envelope: MessageEnvelope<TicketSyncPayload>,
) => Promise<string>;

const defaultEnqueue: EnqueueTicket = async (provider, envelope) => {
  const jobId = createHash('sha256').update(envelope.idempotency_key).digest('hex');
  if (provider === 'jira') {
    return enqueue('jira-sync', envelope as MessageEnvelope<TicketSyncPayload & { provider: 'jira' }>, { jobId });
  }
  return enqueue('linear-sync', envelope as MessageEnvelope<TicketSyncPayload & { provider: 'linear' }>, { jobId });
};

function defaultProviders(): TicketProviderRegistry {
  return new TicketProviderRegistry([
    new JiraProviderAdapter(),
    new LinearProviderAdapter(),
  ]);
}

function assertScope(scope: ServerResolvedTicketScope): void {
  for (const value of [scope.orgId, scope.repositoryId, scope.refName]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Ticket sync scope must be server-resolved.');
    }
  }
}

function assertExternalId(externalId: string): void {
  if (typeof externalId !== 'string' || externalId.trim().length === 0) {
    throw new Error('Ticket synchronization external id must be non-blank.');
  }
}

function payload(
  provider: TicketProvider,
  direction: 'inbound' | 'outbound',
  externalTicketId: string,
  scope: ServerResolvedTicketScope,
  patch?: TicketUpdatePayload,
): TicketSyncPayload {
  return {
    provider,
    direction,
    external_ticket_id: externalTicketId,
    repository_id: scope.repositoryId,
    ref_name: scope.refName,
    ...(patch === undefined ? {} : { patch }),
  };
}

/**
 * Called only after the provider signature is verified and account/workspace -> org/repo
 * scope is resolved server-side. The untrusted webhook body supplies only the issue id.
 */
export async function enqueueTicketWebhook(input: {
  provider: TicketProvider;
  scope: ServerResolvedTicketScope;
  webhook: unknown;
  deliveryId: string;
}, providers = defaultProviders(), enqueueJob: EnqueueTicket = defaultEnqueue): Promise<string | null> {
  assertScope(input.scope);
  const externalId = providers.get(input.provider).externalIdFromWebhook(input.webhook);
  if (externalId === null) return null;
  const envelope = makeEnvelope({
    org_id: input.scope.orgId,
    type: 'ticket.inbound',
    source: `${input.provider}-webhook`,
    idempotency_key: `${input.provider}-webhook-${input.deliveryId}`,
    payload: payload(input.provider, 'inbound', externalId, input.scope),
  });
  return enqueueJob(input.provider, envelope);
}

/** Enqueues the scheduler's authoritative ticket list for a polling cycle. */
export async function enqueueScheduledTicketSync(input: {
  provider: TicketProvider;
  scope: ServerResolvedTicketScope;
  externalTicketIds: readonly string[];
  cycleId: string;
}, enqueueJob: EnqueueTicket = defaultEnqueue): Promise<string[]> {
  assertScope(input.scope);
  const jobs: string[] = [];
  for (const externalId of new Set(input.externalTicketIds)) {
    if (externalId.trim().length === 0) continue;
    const envelope = makeEnvelope({
      org_id: input.scope.orgId,
      type: 'ticket.inbound',
      source: `${input.provider}-schedule`,
      idempotency_key: `${input.provider}-schedule-${input.cycleId}-${externalId}`,
      payload: payload(input.provider, 'inbound', externalId, input.scope),
    });
    jobs.push(await enqueueJob(input.provider, envelope));
  }
  return jobs;
}

/** Enqueues an authorized Sayre-side edit for propagation to the provider. */
export async function enqueueTicketUpdate(input: {
  provider: TicketProvider;
  scope: ServerResolvedTicketScope;
  externalTicketId: string;
  patch: TicketUpdatePayload;
  requestId: string;
}, enqueueJob: EnqueueTicket = defaultEnqueue): Promise<string> {
  assertScope(input.scope);
  assertExternalId(input.externalTicketId);
  if (input.patch.title === undefined && input.patch.description === undefined) {
    throw new Error('Outbound ticket synchronization requires a title or description.');
  }
  const envelope = makeEnvelope({
    org_id: input.scope.orgId,
    type: 'ticket.outbound',
    source: 'sayre-ticket-update',
    idempotency_key: `${input.provider}-outbound-${input.requestId}`,
    payload: payload(
      input.provider,
      'outbound',
      input.externalTicketId,
      input.scope,
      input.patch,
    ),
  });
  return enqueueJob(input.provider, envelope);
}

export type { EnqueueTicket, ServerResolvedTicketScope };
