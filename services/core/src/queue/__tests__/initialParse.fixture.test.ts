// Wire-shape REGRESSION test (AC4) — NOT the W0-04 cross-language acceptance proof,
// see below: a `repo.initial_parse` envelope, built the same way
// githubAppInstallService.ts builds one, is byte-equal to the committed fixture
// (ignoring the random message_id/occurred_at). The Python `MessageEnvelope.from_body`
// side of this contract lives in services/workers/messaging/envelope.py (out of scope
// here).
//
// W0-04's canonical acceptance line is docs/product/Ticket-Backlog-by-Feature-2.md
// §W0-04 ("cross-language test messages consumed correctly; a priority message
// demonstrably drains ahead of a backlog of default messages") — docs/backlog.md's
// shorter reword is superseded, and this static on-disk fixture is NOT that proof (a
// fixture never crosses a live broker). The actual cross-language evidence is
// services/workers/tests/test_cross_runtime_roundtrip.py, which exercises this same
// wire shape against a live broker in both directions.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import { assertValidEnvelope, makeEnvelope, type MessageEnvelope } from '../envelope';

const FIXTURE_PATH = join(__dirname, '..', '__fixtures__', 'repo_initial_parse.envelope.json');

function loadFixture(): MessageEnvelope<RepoInitialParseEvent> {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as MessageEnvelope<RepoInitialParseEvent>;
}

function buildEnvelope(): MessageEnvelope<RepoInitialParseEvent> {
  const installationId = '555';
  const providerRepoId = '42';
  const ref = 'refs/heads/main';
  const revisionSha = '0123456789abcdef0123456789abcdef01234567';
  return makeEnvelope<RepoInitialParseEvent>({
    org_id: '22222222-2222-4222-8222-222222222222',
    type: 'repo.initial_parse',
    source: 'github-app-install',
    trace_id: `install:${installationId}`,
    idempotency_key: `github:initial_parse:${installationId}:${providerRepoId}:${ref}:${revisionSha}`,
    payload: {
      provider: 'github',
      type: 'initial_parse',
      repo: {
        provider_repo_id: providerRepoId,
        full_name: 'acme/widgets',
        repo_id: '11111111-1111-4111-8111-111111111111',
      },
      ref,
      revision_sha: revisionSha,
      installation_id: installationId,
      reason: 'app_install',
    },
  });
}

/** Strips the two fields that legitimately vary per-build (random uuid, wall-clock time). */
function withoutVolatileFields(envelope: MessageEnvelope<RepoInitialParseEvent>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...envelope };
  delete rest.message_id;
  delete rest.occurred_at;
  return rest;
}

describe('repo.initial_parse envelope — queue fixture', () => {
  it('AC4: matches the committed fixture, ignoring message_id/occurred_at', () => {
    const built = buildEnvelope();
    const fixture = loadFixture();

    expect(withoutVolatileFields(built)).toEqual(withoutVolatileFields(fixture));
  });

  it('validates against assertValidEnvelope', () => {
    expect(() => assertValidEnvelope(buildEnvelope())).not.toThrow();
  });

  it('has a non-blank org_id/type/source/idempotency_key, and no field the Python model forbids at the top level', () => {
    const envelope = buildEnvelope() as unknown as Record<string, unknown>;
    expect(Object.keys(envelope).sort()).toEqual(
      [
        'message_id',
        'idempotency_key',
        'org_id',
        'type',
        'schema_version',
        'occurred_at',
        'source',
        'trace_id',
        'payload',
      ].sort(),
    );
  });

  it('idempotency_key is deterministic per (installation, repo, ref, revision)', () => {
    const a = buildEnvelope();
    const b = buildEnvelope();
    expect(a.idempotency_key).toBe(b.idempotency_key);
    expect(a.idempotency_key).toBe(
      'github:initial_parse:555:42:refs/heads/main:0123456789abcdef0123456789abcdef01234567',
    );
  });
});
