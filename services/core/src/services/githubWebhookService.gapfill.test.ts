// Red-stage (W1-02 gapfill) service-level coverage. Fully DI-mocked, like the sibling
// githubWebhookService.test.ts — no Redis/SQS/Postgres.
//
// Covers AC-1 (dedup identity from the signed bytes only), AC-2 (push refs/heads/*
// constraint at the orchestration level), AC-3 (positive-safe-integer installation ids in
// BOTH the normalize path and the `installation` lifecycle branch), AC-4 (full_name shape
// -> 400 with nothing published), and the surrounding edge cases.
//
// The expected idempotency key is recomputed here from node:crypto rather than imported
// from webhooks/githubDeliveryIdentity, so an implementation that is merely
// self-consistent (e.g. hashing the parsed JSON re-serialized, or salting with the
// delivery id) cannot pass.

import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedRepoEvent } from '@sayre/shared-types';
import type { MessageEnvelope } from '../queue/envelope';
import { WebhookSignatureError } from '../webhooks/githubSignature';
import {
  handleGithubWebhook,
  WebhookBadRequestError,
  type WebhookDeps,
} from './githubWebhookService';

const SECRET = 'wh-secret';

function sign(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function expectedKey(rawBody: Buffer): string {
  return `github:webhook:${createHash('sha256').update(rawBody).digest('hex')}`;
}

function pushBody(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      installation: { id: 555 },
      repository: { id: 42, full_name: 'acme/widgets' },
      ref: 'refs/heads/main',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      forced: false,
      deleted: false,
      pusher: { name: 'octocat' },
      commits: [],
      ...overrides,
    }),
  );
}

interface Deps extends WebhookDeps {
  getWebhookSecret: ReturnType<typeof vi.fn>;
  resolveOrg: ReturnType<typeof vi.fn>;
  publishIngestion: ReturnType<typeof vi.fn>;
  publishOwnership: ReturnType<typeof vi.fn>;
  applyInstallationLifecycle: ReturnType<typeof vi.fn>;
  applyInstallationRepositories: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    getWebhookSecret: vi.fn(async () => SECRET),
    resolveOrg: vi.fn(async () => ({ orgId: 'org-resolved-1', active: true })),
    publishIngestion: vi.fn(async () => undefined),
    publishOwnership: vi.fn(async () => undefined),
    applyInstallationLifecycle: vi.fn(async () => ({ status: 'revoked' as const })),
    applyInstallationRepositories: vi.fn(async () => ({
      status: 'added' as const,
      registered: 1,
      enqueued: 1,
    })),
    ...overrides,
  };
}

function publishedEnvelope(deps: Deps, index = 0): MessageEnvelope<NormalizedRepoEvent> {
  return deps.publishIngestion.mock.calls[index][0] as MessageEnvelope<NormalizedRepoEvent>;
}

describe('handleGithubWebhook — dedup identity comes from the signed bytes (AC-1 / GAP-4)', () => {
  // @spec AC-1
  it('sets idempotency_key to github:webhook:<sha256 of the raw body>, not the delivery id', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();

    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'delivery-abc' },
      deps,
    );

    const envelope = publishedEnvelope(deps);
    expect(envelope.idempotency_key).toBe(expectedKey(rawBody));
    expect(envelope.idempotency_key).not.toBe('delivery-abc');
    expect(envelope.idempotency_key).not.toContain('delivery-abc');
  });

  // @spec AC-1
  it('keeps the delivery id visible as trace_id and payload.delivery_id for attribution', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();

    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'delivery-abc' },
      deps,
    );

    const envelope = publishedEnvelope(deps);
    expect(envelope.trace_id).toBe('delivery-abc');
    expect(envelope.payload.delivery_id).toBe('delivery-abc');
  });

  // @spec AC-1
  it('hands the identical envelope object to both ingestion and ownership publishers', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();

    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'delivery-abc' },
      deps,
    );

    expect(deps.publishOwnership.mock.calls[0][0]).toBe(publishedEnvelope(deps));
  });

  // @spec EC-1
  it("GitHub's own retry (same bytes, same delivery id) yields one idempotency_key across both publishes", async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const input = { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'replay-1' };

    await handleGithubWebhook(input, deps);
    await handleGithubWebhook(input, deps);

    const first = publishedEnvelope(deps, 0);
    const second = publishedEnvelope(deps, 1);
    expect(first.idempotency_key).toBe(expectedKey(rawBody));
    expect(second.idempotency_key).toBe(first.idempotency_key);
    // Only the per-delivery volatile fields differ.
    expect(second.message_id).not.toBe(first.message_id);
  });

  // The GAP-4 attack itself: X-GitHub-Delivery is not covered by the HMAC, so an attacker
  // replaying a captured (body, signature) pair can freely mint a new delivery id. That
  // must NOT mint a new dedup identity.
  // @spec AC-1 EC-2
  it('same bytes with a DIFFERENT delivery id still produce the same idempotency_key', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const signature = sign(rawBody);

    await handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'genuine-1' }, deps);
    await handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'attacker-2' }, deps);

    const first = publishedEnvelope(deps, 0);
    const second = publishedEnvelope(deps, 1);
    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.idempotency_key).toBe(expectedKey(rawBody));
    // ...while attribution still reflects each delivery's own header.
    expect(first.trace_id).toBe('genuine-1');
    expect(second.trace_id).toBe('attacker-2');
    expect(first.payload.delivery_id).toBe('genuine-1');
    expect(second.payload.delivery_id).toBe('attacker-2');
  });

  // @spec EC-3
  it('different bytes with the SAME delivery id produce different idempotency_keys', async () => {
    const deps = makeDeps();
    const bodyA = pushBody({ after: 'a'.repeat(40) });
    const bodyB = pushBody({ after: 'c'.repeat(40) });

    await handleGithubWebhook(
      { rawBody: bodyA, signature: sign(bodyA), githubEvent: 'push', deliveryId: 'same-id' },
      deps,
    );
    await handleGithubWebhook(
      { rawBody: bodyB, signature: sign(bodyB), githubEvent: 'push', deliveryId: 'same-id' },
      deps,
    );

    expect(publishedEnvelope(deps, 0).idempotency_key).not.toBe(
      publishedEnvelope(deps, 1).idempotency_key,
    );
  });

  // GAP-1 regression guard: AC-1 must not move any work ahead of the signature check.
  // @spec EC-4
  it('a body tampered after signing is still rejected 401 with nothing published', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const signature = sign(pushBody({ ref: 'refs/heads/other' })); // signed different bytes

    await expect(
      handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'd-tamper' }, deps),
    ).rejects.toBeInstanceOf(WebhookSignatureError);

    expect(deps.resolveOrg).not.toHaveBeenCalled();
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  // @spec EC-23
  it('two concurrent duplicate deliveries (same bytes, different ids) both succeed with one key', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const signature = sign(rawBody);

    const outcomes = await Promise.all([
      handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'concurrent-a' }, deps),
      handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'concurrent-b' }, deps),
    ]);

    // The receiver makes no exactly-once claim — both are accepted; the QUEUE collapses them.
    expect(outcomes.every((outcome) => outcome.status === 'published')).toBe(true);
    expect(deps.publishIngestion).toHaveBeenCalledTimes(2);
    expect(publishedEnvelope(deps, 0).idempotency_key).toBe(expectedKey(rawBody));
    expect(publishedEnvelope(deps, 1).idempotency_key).toBe(expectedKey(rawBody));
  });
});

describe('handleGithubWebhook — push refs constrained to refs/heads/* (AC-2 / GAP-5)', () => {
  // @spec AC-2 EC-5
  it.each(['refs/tags/v1.0.0', 'refs/pull/7/head', 'main', 'refs/heads/', 'refs/headsfoo', 'refs/head/main'])(
    'ignores a validly-signed push with ref %j and publishes nothing',
    async (ref) => {
      const deps = makeDeps();
      const rawBody = pushBody({ ref });

      const outcome = await handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-ref' },
        deps,
      );

      expect(outcome).toEqual({ status: 'ignored', reason: 'unsupported_ref_type' });
      expect(deps.publishIngestion).not.toHaveBeenCalled();
      expect(deps.publishOwnership).not.toHaveBeenCalled();
    },
  );

  // @spec AC-2 EC-7
  it('still publishes a nested branch ref (refs/heads/feat/a/b) to both destinations', async () => {
    const deps = makeDeps();
    const rawBody = pushBody({ ref: 'refs/heads/feat/a/b' });

    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-nested' },
      deps,
    );

    expect(outcome).toEqual({
      status: 'published',
      type: 'push',
      destinations: ['ingestion', 'ownership'],
    });
    expect(publishedEnvelope(deps).payload.ref).toBe('refs/heads/feat/a/b');
  });

  // @spec EC-8
  it('a push with no ref is still the no_ref ignore, not unsupported_ref_type', async () => {
    const deps = makeDeps();
    const rawBody = pushBody({ ref: undefined });

    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-noref' },
      deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_ref' });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });
});

describe('handleGithubWebhook — installation.id must be a positive safe integer (AC-3 / GAP-6)', () => {
  // The id is written as a raw JSON literal rather than through JSON.stringify, so the
  // exact wire token is what reaches the guard (JSON.stringify would rewrite NaN and
  // Infinity to `null`, testing the null branch instead of the numeric one). `1e999`
  // is how a JSON document expresses Infinity — JSON.parse accepts it and yields
  // Number.POSITIVE_INFINITY.
  // @spec AC-3 EC-10
  it.each([
    ['-1', '-1'],
    ['1.5', '1.5'],
    ['0', '0'],
    ['-0', '-0'],
    ['Infinity (1e999)', '1e999'],
    ['-Infinity (-1e999)', '-1e999'],
    ['2 ** 53', String(2 ** 53)],
    ['the string "555"', '"555"'],
    ['null', 'null'],
    ['1e300 (finite, not a safe integer)', '1e300'],
  ])('a push with installation.id %s is a no_installation ignore', async (_label, literal) => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      `{"installation":{"id":${literal}},"repository":{"id":42,"full_name":"acme/widgets"},` +
        `"ref":"refs/heads/main","commits":[]}`,
    );

    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-inst' },
      deps,
    );

    expect(outcome).toEqual({ status: 'ignored', reason: 'no_installation' });
    expect(deps.resolveOrg).not.toHaveBeenCalled();
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  // @spec AC-3 EC-13
  it('accepts Number.MAX_SAFE_INTEGER and resolves the org with it', async () => {
    const deps = makeDeps();
    const rawBody = pushBody({ installation: { id: Number.MAX_SAFE_INTEGER } });

    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-max' },
      deps,
    );

    expect(outcome.status).toBe('published');
    expect(deps.resolveOrg).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);
  });

  // The `installation` lifecycle branch reads installation.id independently of the
  // normalizer — today `typeof id === 'number'` there admits NaN straight through to
  // applyInstallationLifecycle.
  // @spec AC-3 EC-11
  it.each([
    ['-1', '-1'],
    ['1.5', '1.5'],
    ['0', '0'],
    ['-0', '-0'],
    ['Infinity (1e999)', '1e999'],
    ['2 ** 53', String(2 ** 53)],
    ['the string "555"', '"555"'],
  ])(
    'an `installation` event with installation.id %s ignores without calling the lifecycle service',
    async (_label, literal) => {
      const deps = makeDeps();
      const rawBody = Buffer.from(
        `{"action":"unsuspend","installation":{"id":${literal}}}`,
      );

      const outcome = await handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'installation', deliveryId: 'd-life' },
        deps,
      );

      expect(outcome).toEqual({ status: 'ignored', reason: 'no_installation' });
      expect(deps.applyInstallationLifecycle).not.toHaveBeenCalled();
    },
  );

  // NaN is not expressible in strict JSON, but `installation.id: null` and a nested
  // object both are, and both must land in the same ignore — never a 500.
  // @spec AC-3 EC-11
  it.each([['null', 'null'], ['an object', '{"id":555}']])(
    'an `installation` event with installation.id %s ignores without calling the lifecycle service',
    async (_label, literal) => {
      const deps = makeDeps();
      const rawBody = Buffer.from(`{"action":"suspend","installation":{"id":${literal}}}`);

      const outcome = await handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'installation', deliveryId: 'd-life-2' },
        deps,
      );

      expect(outcome).toEqual({ status: 'ignored', reason: 'no_installation' });
      expect(deps.applyInstallationLifecycle).not.toHaveBeenCalled();
    },
  );

  // @spec AC-3
  it('still delegates a well-formed `installation` event to the lifecycle service', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(JSON.stringify({ action: 'suspend', installation: { id: 555 } }));

    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation', deliveryId: 'd-life-ok' },
      deps,
    );

    expect(outcome).toEqual({ status: 'installation', result: { status: 'revoked' } });
    expect(deps.applyInstallationLifecycle).toHaveBeenCalledWith({
      action: 'suspend',
      installationId: 555,
    });
  });
});

describe('handleGithubWebhook — repository.full_name shape (AC-4 / GAP-7)', () => {
  // @spec AC-4 EC-14
  it.each(['../../evil', 'a/b/c', 'owner/', '/name', 'owner//name', '..', 'owner/na me', `${'a'.repeat(300)}/name`])(
    'rejects full_name %j as a bad request with nothing published',
    async (fullName) => {
      const deps = makeDeps();
      const rawBody = pushBody({ repository: { id: 42, full_name: fullName } });

      await expect(
        handleGithubWebhook(
          { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-name' },
          deps,
        ),
      ).rejects.toBeInstanceOf(WebhookBadRequestError);

      expect(deps.publishIngestion).not.toHaveBeenCalled();
      expect(deps.publishOwnership).not.toHaveBeenCalled();
    },
  );

  // @spec AC-4 EC-15
  it.each(['acme-corp/widgets', 'a.b/c_d-e.f', 'A_1/x.y-z'])(
    'publishes the legal full_name %s normally',
    async (fullName) => {
      const deps = makeDeps();
      const rawBody = pushBody({ repository: { id: 42, full_name: fullName } });

      const outcome = await handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-name-ok' },
        deps,
      );

      expect(outcome.status).toBe('published');
      expect(publishedEnvelope(deps).payload.repo.full_name).toBe(fullName);
    },
  );

  // @spec EC-16
  it.each([['missing', undefined], ['empty', ''], ['a number', 42]])(
    'still rejects a %s full_name as a bad request',
    async (_label, fullName) => {
      const deps = makeDeps();
      const rawBody = pushBody({ repository: { id: 42, full_name: fullName } });

      await expect(
        handleGithubWebhook(
          { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-name-bad' },
          deps,
        ),
      ).rejects.toBeInstanceOf(WebhookBadRequestError);
      expect(deps.publishIngestion).not.toHaveBeenCalled();
    },
  );
});

describe('handleGithubWebhook — behavior preserved around the six changes', () => {
  // @spec EC-19
  it('rethrows when publishOwnership fails even though publishIngestion succeeded', async () => {
    const deps = makeDeps({
      publishOwnership: vi.fn(async () => {
        throw new Error('bullmq down');
      }),
    });
    const rawBody = pushBody();

    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-fail' },
        deps,
      ),
    ).rejects.toThrow('bullmq down');
    expect(deps.publishIngestion).toHaveBeenCalledTimes(1);
  });

  // @spec EC-19
  it('rethrows when publishIngestion fails even though publishOwnership succeeded', async () => {
    const deps = makeDeps({
      publishIngestion: vi.fn(async () => {
        throw new Error('sqs down');
      }),
    });
    const rawBody = pushBody();

    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd-fail-2' },
        deps,
      ),
    ).rejects.toThrow('sqs down');
    expect(deps.publishOwnership).toHaveBeenCalledTimes(1);
  });

  // @spec EC-22
  it('keeps ping, an unsupported event, and the unknown/revoked installation ignores intact', async () => {
    const pingBody = Buffer.from(JSON.stringify({ zen: 'hi', hook_id: 1 }));
    const pingDeps = makeDeps();
    await expect(
      handleGithubWebhook(
        { rawBody: pingBody, signature: sign(pingBody), githubEvent: 'ping', deliveryId: 'd-ping' },
        pingDeps,
      ),
    ).resolves.toEqual({ status: 'ignored', reason: 'ping' });

    const starBody = pushBody();
    const starDeps = makeDeps();
    await expect(
      handleGithubWebhook(
        { rawBody: starBody, signature: sign(starBody), githubEvent: 'star', deliveryId: 'd-star' },
        starDeps,
      ),
    ).resolves.toEqual({ status: 'ignored', reason: 'unsupported_event' });

    const unknownDeps = makeDeps({ resolveOrg: vi.fn(async () => null) });
    const unknownBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody: unknownBody, signature: sign(unknownBody), githubEvent: 'push', deliveryId: 'd-unknown' },
        unknownDeps,
      ),
    ).resolves.toEqual({ status: 'ignored', reason: 'unknown_installation' });

    const revokedDeps = makeDeps({
      resolveOrg: vi.fn(async () => ({ orgId: 'org-resolved-1', active: false })),
    });
    const revokedBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody: revokedBody, signature: sign(revokedBody), githubEvent: 'push', deliveryId: 'd-revoked' },
        revokedDeps,
      ),
    ).resolves.toEqual({ status: 'ignored', reason: 'revoked_installation' });
  });

  // @spec EC-22
  it('keeps installation_repositories added/removed delegating to its own service', async () => {
    const added = Buffer.from(
      JSON.stringify({
        action: 'added',
        installation: { id: 555 },
        repositories_added: [{ id: 111, full_name: 'acme/widgets' }],
      }),
    );
    const addedDeps = makeDeps();
    await expect(
      handleGithubWebhook(
        {
          rawBody: added,
          signature: sign(added),
          githubEvent: 'installation_repositories',
          deliveryId: 'd-ir-add',
        },
        addedDeps,
      ),
    ).resolves.toEqual({
      status: 'installation_repositories',
      result: { status: 'added', registered: 1, enqueued: 1 },
    });
    expect(addedDeps.publishIngestion).not.toHaveBeenCalled();

    const removed = Buffer.from(
      JSON.stringify({
        action: 'removed',
        installation: { id: 555 },
        repositories_removed: [{ id: 111, full_name: 'acme/widgets' }],
      }),
    );
    const removedDeps = makeDeps({
      applyInstallationRepositories: vi.fn(async () => ({ status: 'removed' as const, revoked: 1 })),
    });
    await expect(
      handleGithubWebhook(
        {
          rawBody: removed,
          signature: sign(removed),
          githubEvent: 'installation_repositories',
          deliveryId: 'd-ir-rm',
        },
        removedDeps,
      ),
    ).resolves.toEqual({
      status: 'installation_repositories',
      result: { status: 'removed', revoked: 1 },
    });
  });
});
