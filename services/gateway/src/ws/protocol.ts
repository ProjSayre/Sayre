// Encode/decode + validation of the ClientToGatewayMessage / GatewayToClientMessage
// wire contract (@sayre/shared-types). Hand-rolled guards, not Zod — the gateway
// deliberately carries no schema-validation dependency beyond what's already in
// its package.json (spec.md Affected files / O-6). Malformed frames are rejected
// with a ProtocolError; callers must never let this crash the connection.

import type { ClientToGatewayMessage, GatewayToClientMessage } from '@sayre/shared-types';

export class ProtocolError extends Error {
  constructor(message = 'Malformed or invalid WebSocket frame.') {
    super(message);
    this.name = 'ProtocolError';
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseRawFrame(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      throw new ProtocolError('Frame is not valid JSON.');
    }
  }
  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ProtocolError('Frame is not valid JSON.');
    }
  }
  if (Array.isArray(raw)) {
    // `ws` may deliver certain frames as Buffer[] depending on client options.
    try {
      return JSON.parse(Buffer.concat(raw as Buffer[]).toString('utf8'));
    } catch {
      throw new ProtocolError('Frame is not valid JSON.');
    }
  }
  throw new ProtocolError('Unsupported frame encoding.');
}

/** Decodes and validates one inbound client frame. Never throws anything but ProtocolError. */
export function decodeClientMessage(raw: unknown): ClientToGatewayMessage {
  const parsed = parseRawFrame(raw);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ProtocolError('Frame must be a JSON object.');
  }
  const candidate = parsed as Record<string, unknown>;

  switch (candidate.type) {
    case 'auth':
      if (!nonEmptyString(candidate.token)) {
        throw new ProtocolError('auth frame requires a non-empty "token".');
      }
      return { type: 'auth', token: candidate.token };
    case 'subscribe':
      if (!nonEmptyString(candidate.repoId)) {
        throw new ProtocolError('subscribe frame requires a non-empty "repoId".');
      }
      return { type: 'subscribe', repoId: candidate.repoId };
    case 'unsubscribe':
      if (!nonEmptyString(candidate.repoId)) {
        throw new ProtocolError('unsubscribe frame requires a non-empty "repoId".');
      }
      return { type: 'unsubscribe', repoId: candidate.repoId };
    default:
      throw new ProtocolError('Unknown frame "type".');
  }
}

export function encodeServerMessage(message: GatewayToClientMessage): string {
  return JSON.stringify(message);
}
