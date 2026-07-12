// Standard tenant-scoped message envelope — Node side of the shared wire contract.
//
// This is one half of a byte-for-byte-compatible wire contract with
// `services/workers/queue/envelope.py` (see W0-04 spec, "Standard message envelope").
// Wire keys are snake_case in *both* languages (not idiomatic-JS camelCase): a
// `graph.updated` event is published by the Python fleet over SQS and later consumed
// by the Node Realtime/gateway service (`docs/architecture.md` "Steady-state push";
// `.claude/rules/async-messaging.md`), so the envelope crosses the Python<->Node
// boundary. One snake_case wire format in both languages avoids a serialization
// mapping layer and a whole class of `orgId` vs `org_id` bugs. Keep both definitions
// identical on the wire.
//
// Tenant-context invariant (`.claude/rules/security-multitenancy.md`): `org_id` is
// REQUIRED and non-empty on every envelope. It must be resolved server-side (e.g.
// from the installation/account -> org mapping in Postgres) and must NEVER be copied
// verbatim from an untrusted webhook body. Callers that originate from a webhook MUST
// HMAC/signature-validate the payload before constructing an envelope and calling
// `enqueue()` — this module (plus `assertValidEnvelope`) is the enforcement point, not
// the webhook receiver itself (out of scope for this ticket).

import { randomUUID } from 'node:crypto';

export interface MessageEnvelope<TPayload = unknown> {
  message_id: string;
  org_id: string; // REQUIRED tenant context — never from client/webhook input
  type: string;
  schema_version: number;
  occurred_at: string; // ISO-8601 UTC
  source: string;
  trace_id?: string | null;
  payload: TPayload;
}

export class EnvelopeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeValidationError';
  }
}

/** Build a fully-formed envelope, filling message_id/occurred_at/schema_version defaults. */
export function makeEnvelope<T>(input: {
  org_id: string;
  type: string;
  source: string;
  payload: T;
  trace_id?: string | null;
  message_id?: string;
  occurred_at?: string;
  schema_version?: number;
}): MessageEnvelope<T> {
  const envelope: MessageEnvelope<T> = {
    message_id: input.message_id ?? randomUUID(),
    org_id: input.org_id,
    type: input.type,
    schema_version: input.schema_version ?? 1,
    occurred_at: input.occurred_at ?? new Date().toISOString(),
    source: input.source,
    trace_id: input.trace_id ?? null,
    payload: input.payload,
  };

  assertValidEnvelope(envelope);

  return envelope;
}

/**
 * Runtime guard — TS types are erased, BullMQ job.data is untyped JSON. Throws
 * `EnvelopeValidationError` if message_id/org_id/type/source missing or empty, or
 * schema_version not a number.
 */
export function assertValidEnvelope(data: unknown): asserts data is MessageEnvelope {
  if (typeof data !== 'object' || data === null) {
    throw new EnvelopeValidationError('Envelope must be a non-null object.');
  }

  const candidate = data as Record<string, unknown>;

  for (const field of ['message_id', 'org_id', 'type', 'source'] as const) {
    const value = candidate[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new EnvelopeValidationError(
        `Envelope field "${field}" must be a non-empty string (got ${JSON.stringify(value)}).`,
      );
    }
  }

  if (typeof candidate.schema_version !== 'number') {
    throw new EnvelopeValidationError(
      `Envelope field "schema_version" must be a number (got ${JSON.stringify(candidate.schema_version)}).`,
    );
  }

  if (typeof candidate.occurred_at !== 'string' || candidate.occurred_at.length === 0) {
    throw new EnvelopeValidationError('Envelope field "occurred_at" must be a non-empty string.');
  }

  if (
    candidate.trace_id !== undefined &&
    candidate.trace_id !== null &&
    typeof candidate.trace_id !== 'string'
  ) {
    throw new EnvelopeValidationError('Envelope field "trace_id" must be a string, null, or undefined.');
  }

  if (!('payload' in candidate)) {
    throw new EnvelopeValidationError('Envelope field "payload" is required (may be an empty object).');
  }
}
