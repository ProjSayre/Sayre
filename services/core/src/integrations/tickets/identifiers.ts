import { createHash } from 'node:crypto';
import type { TicketProvider } from './types';

export function ticketUid(
  orgId: string,
  provider: TicketProvider,
  externalId: string,
): string {
  return createHash('sha256')
    .update([orgId, provider, 'Ticket', externalId].join('\0'))
    .digest('hex');
}
