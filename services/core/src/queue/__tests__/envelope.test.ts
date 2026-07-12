// Unit tests for the Node side of the shared MessageEnvelope wire contract.
//
// Broker-independent (no Redis/BullMQ) — always run, giving coverage even in a
// broker-less environment. Covers acceptance criterion 4 (org_id REQUIRED, rejected
// empty/missing on the Node side) and the envelope-shape edge cases.

import { describe, it, expect } from 'vitest';
import {
  makeEnvelope,
  assertValidEnvelope,
  EnvelopeValidationError,
  MessageEnvelope,
} from '../envelope';

function validEnvelope(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    message_id: 'm-1',
    org_id: 'org_ABC123',
    type: 'repo.ingest',
    schema_version: 1,
    occurred_at: '2026-07-12T10:00:00Z',
    source: 'ingestion-worker',
    trace_id: null,
    payload: {},
    ...overrides,
  };
}

describe('makeEnvelope', () => {
  it('fills message_id / occurred_at / schema_version / trace_id defaults', () => {
    const env = makeEnvelope({
      org_id: 'org_1',
      type: 'repo.ingest',
      source: 'ingestion-worker',
      payload: { repo: 'acme/widgets' },
    });
    expect(typeof env.message_id).toBe('string');
    expect(env.message_id.length).toBeGreaterThanOrEqual(32); // uuid v4
    expect(env.schema_version).toBe(1);
    expect(env.trace_id).toBeNull();
    expect(() => new Date(env.occurred_at).toISOString()).not.toThrow();
    expect(env.payload).toEqual({ repo: 'acme/widgets' });
  });

  it('respects explicitly provided values', () => {
    const env = makeEnvelope({
      org_id: 'org_1',
      type: 'graph.updated',
      source: 's',
      payload: { a: 1 },
      message_id: 'fixed',
      occurred_at: '2020-01-01T00:00:00Z',
      schema_version: 2,
      trace_id: 'corr-7',
    });
    expect(env.message_id).toBe('fixed');
    expect(env.occurred_at).toBe('2020-01-01T00:00:00Z');
    expect(env.schema_version).toBe(2);
    expect(env.trace_id).toBe('corr-7');
  });

  it('refuses to build an envelope with an empty org_id (AC4)', () => {
    expect(() =>
      makeEnvelope({ org_id: '', type: 't', source: 's', payload: {} }),
    ).toThrow(EnvelopeValidationError);
  });

  it('accepts an empty payload {}', () => {
    const env = makeEnvelope({ org_id: 'o', type: 't', source: 's', payload: {} });
    expect(env.payload).toEqual({});
  });

  it('emits snake_case wire keys (no camelCase drift)', () => {
    const env = makeEnvelope({ org_id: 'o', type: 't', source: 's', payload: {} });
    const wire = JSON.stringify(env);
    expect(wire).toContain('"org_id"');
    expect(wire).toContain('"schema_version"');
    expect(wire).toContain('"occurred_at"');
    expect(wire).not.toContain('"orgId"');
    expect(Object.keys(JSON.parse(wire)).sort()).toEqual(
      [
        'message_id',
        'occurred_at',
        'org_id',
        'payload',
        'schema_version',
        'source',
        'trace_id',
        'type',
      ].sort(),
    );
  });
});

describe('assertValidEnvelope', () => {
  it('passes a fully-formed envelope', () => {
    expect(() => assertValidEnvelope(validEnvelope())).not.toThrow();
  });

  it('throws on non-object / null', () => {
    expect(() => assertValidEnvelope(null)).toThrow(EnvelopeValidationError);
    expect(() => assertValidEnvelope('nope')).toThrow(EnvelopeValidationError);
    expect(() => assertValidEnvelope(42)).toThrow(EnvelopeValidationError);
  });

  it.each(['message_id', 'org_id', 'type', 'source'] as const)(
    'throws when required string field %s is missing',
    (field) => {
      const env = validEnvelope();
      delete (env as Record<string, unknown>)[field];
      expect(() => assertValidEnvelope(env)).toThrow(EnvelopeValidationError);
    },
  );

  it.each(['message_id', 'org_id', 'type', 'source'] as const)(
    'throws when required string field %s is empty (AC4)',
    (field) => {
      const env = validEnvelope({ [field]: '' } as Partial<MessageEnvelope>);
      expect(() => assertValidEnvelope(env)).toThrow(EnvelopeValidationError);
    },
  );

  it('throws when schema_version is not a number', () => {
    const env = validEnvelope({ schema_version: '1' as unknown as number });
    expect(() => assertValidEnvelope(env)).toThrow(EnvelopeValidationError);
  });

  it('throws when payload is missing', () => {
    const env = validEnvelope();
    delete (env as Record<string, unknown>).payload;
    expect(() => assertValidEnvelope(env)).toThrow(EnvelopeValidationError);
  });

  it('allows trace_id null or undefined but rejects a non-string', () => {
    expect(() => assertValidEnvelope(validEnvelope({ trace_id: null }))).not.toThrow();
    expect(() => assertValidEnvelope(validEnvelope({ trace_id: undefined }))).not.toThrow();
    expect(() =>
      assertValidEnvelope(validEnvelope({ trace_id: 123 as unknown as string })),
    ).toThrow(EnvelopeValidationError);
  });
});
