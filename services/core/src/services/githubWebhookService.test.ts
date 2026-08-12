// Fully DI-mocked unit tests for handleGithubWebhook — no Redis/SQS/Postgres.
// getWebhookSecret/resolveOrg/publishIngestion/publishOwnership are all injected.

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
    applyInstallationRepositories: vi.fn(async () => ({ status: 'added' as const, registered: 1, enqueued: 1 })),
    ...overrides,
  };
}

describe('handleGithubWebhook — signature validation gates everything', () => {
  it('throws WebhookSignatureError on a missing signature header and calls no dep past the secret loader', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody, githubEvent: 'push', deliveryId: 'd1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(deps.resolveOrg).not.toHaveBeenCalled();
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  it('throws WebhookSignatureError on a tampered body (correct algorithm, wrong digest)', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const signature = sign(pushBody({ ref: 'refs/heads/other' })); // signed a different body
    await expect(
      handleGithubWebhook({ rawBody, signature, githubEvent: 'push', deliveryId: 'd1' }, deps),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  it('throws WebhookSignatureError on a sha1-only signature (no -256 header)', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const sha1 = createHmac('sha1', SECRET).update(rawBody).digest('hex');
    await expect(
      handleGithubWebhook(
        { rawBody, signature: `sha1=${sha1}`, githubEvent: 'push', deliveryId: 'd1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('propagates a webhook-secret loader failure (misconfig) uncaught, and never publishes', async () => {
    const deps = makeDeps({
      getWebhookSecret: vi.fn(async () => {
        throw new Error('Secret GITHUB_WEBHOOK_SECRET is missing.');
      }),
    });
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd1' },
        deps,
      ),
    ).rejects.toThrow(/GITHUB_WEBHOOK_SECRET/);
    expect(deps.resolveOrg).not.toHaveBeenCalled();
  });
});

describe('handleGithubWebhook — malformed request (400)', () => {
  it('throws WebhookBadRequestError when the body is not JSON', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from('not json at all');
    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookBadRequestError);
    expect(deps.publishIngestion).not.toHaveBeenCalled();
  });

  it('throws WebhookBadRequestError when X-GitHub-Event is missing', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook({ rawBody, signature: sign(rawBody), deliveryId: 'd1' }, deps),
    ).rejects.toBeInstanceOf(WebhookBadRequestError);
  });

  it('throws WebhookBadRequestError when X-GitHub-Delivery is missing', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook({ rawBody, signature: sign(rawBody), githubEvent: 'push' }, deps),
    ).rejects.toBeInstanceOf(WebhookBadRequestError);
  });

  it('throws WebhookBadRequestError when repository.id/full_name are missing', async () => {
    const deps = makeDeps();
    const rawBody = pushBody({ repository: undefined });
    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd1' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookBadRequestError);
  });
});

describe('handleGithubWebhook — routing / publishing', () => {
  it('AC2: a valid push publishes one envelope to ingestion AND ownership, returns published', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd1' },
      deps,
    );
    expect(outcome).toEqual({
      status: 'published',
      type: 'push',
      destinations: ['ingestion', 'ownership'],
    });
    expect(deps.publishIngestion).toHaveBeenCalledTimes(1);
    expect(deps.publishOwnership).toHaveBeenCalledTimes(1);

    const envelope = deps.publishIngestion.mock.calls[0][0] as MessageEnvelope<NormalizedRepoEvent>;
    expect(envelope.type).toBe('repo.push');
    expect(envelope.source).toBe('github-webhook');
    expect(envelope.payload.provider).toBe('github');
    expect(envelope.payload.type).toBe('push');
    expect(envelope.payload.repo.full_name).toBe('acme/widgets');
    expect(envelope.payload.repo.provider_repo_id).toBe('42');
    expect(envelope.payload.ref).toBe('refs/heads/main');
  });

  it('AC3: a valid pull_request publishes to github-sync (ownership) only', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({
        installation: { id: 555 },
        repository: { id: 42, full_name: 'acme/widgets' },
        action: 'opened',
        number: 7,
        pull_request: {
          id: 1,
          state: 'open',
          merged: false,
          title: 'Add feature',
          head: { ref: 'feature-x', sha: 'headsha' },
          base: { ref: 'main', sha: 'basesha' },
          user: { login: 'octocat', id: 1 },
        },
      }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'pull_request', deliveryId: 'd2' },
      deps,
    );
    expect(outcome).toEqual({ status: 'published', type: 'pull_request', destinations: ['ownership'] });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).toHaveBeenCalledTimes(1);
  });

  // GAP-8: a branch create/delete carries no revision SHA -- there is nothing for the
  // ingestion worker to fetch or parse, so it is no longer routed to ingestion (see
  // webhooks/normalizeGithubEvent.ts). @spec AC-1
  it('AC3: a valid branch create/delete publishes to ownership ONLY (not ingestion)', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({
        installation: { id: 555 },
        repository: { id: 42, full_name: 'acme/widgets' },
        ref: 'feature-y',
        ref_type: 'branch',
      }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'create', deliveryId: 'd3' },
      deps,
    );
    expect(outcome).toEqual({ status: 'published', type: 'branch', destinations: ['ownership'] });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).toHaveBeenCalledTimes(1);
  });

  it('ping and unsupported events are ignored, 2xx, no publish', async () => {
    const deps = makeDeps();
    const pingBody = Buffer.from(JSON.stringify({ zen: 'hi', hook_id: 1 }));
    const pingOutcome = await handleGithubWebhook(
      { rawBody: pingBody, signature: sign(pingBody), githubEvent: 'ping', deliveryId: 'd4' },
      deps,
    );
    expect(pingOutcome).toEqual({ status: 'ignored', reason: 'ping' });

    const starBody = Buffer.from(JSON.stringify({ installation: { id: 555 } }));
    const starOutcome = await handleGithubWebhook(
      { rawBody: starBody, signature: sign(starBody), githubEvent: 'star', deliveryId: 'd5' },
      deps,
    );
    expect(starOutcome).toEqual({ status: 'ignored', reason: 'unsupported_event' });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  it('tag create/delete is ignored (unsupported_ref_type), no publish', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({
        installation: { id: 555 },
        repository: { id: 42, full_name: 'acme/widgets' },
        ref: 'v1.0.0',
        ref_type: 'tag',
      }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'create', deliveryId: 'd6' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'unsupported_ref_type' });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
  });
});

describe('handleGithubWebhook — tenant isolation (critical)', () => {
  it('AC6: an unknown installation is ignored (unknown_installation), 2xx, no publish', async () => {
    const deps = makeDeps({ resolveOrg: vi.fn(async () => null) });
    const rawBody = pushBody();
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd7' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'unknown_installation' });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
  });

  it('a suspended installation is ignored (revoked_installation), 2xx, no publish', async () => {
    const deps = makeDeps({
      resolveOrg: vi.fn(async () => ({ orgId: 'org-1', active: false })),
    });
    const rawBody = pushBody();
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd8' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'revoked_installation' });
  });

  it('AC5: a forged organization/org_id claim in the payload does not influence envelope.org_id', async () => {
    const deps = makeDeps({
      resolveOrg: vi.fn(async () => ({ orgId: 'org-resolved-real', active: true })),
    });
    const rawBody = pushBody({
      organization: { id: 'org-forged', login: 'forged-corp' },
      org_id: 'org-forged-id',
    });
    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd9' },
      deps,
    );
    const envelope = deps.publishIngestion.mock.calls[0][0] as MessageEnvelope<NormalizedRepoEvent>;
    expect(envelope.org_id).toBe('org-resolved-real');
  });

  it('two different installations resolve to two different orgs with no cross-tenant bleed', async () => {
    const resolveOrg = vi.fn(async (installationId: number) =>
      installationId === 555 ? { orgId: 'org-A', active: true } : { orgId: 'org-B', active: true },
    );
    const deps = makeDeps({ resolveOrg });

    const bodyA = pushBody({ installation: { id: 555 } });
    const outcomeA = await handleGithubWebhook(
      { rawBody: bodyA, signature: sign(bodyA), githubEvent: 'push', deliveryId: 'dA' },
      deps,
    );
    const bodyB = pushBody({ installation: { id: 777 } });
    const outcomeB = await handleGithubWebhook(
      { rawBody: bodyB, signature: sign(bodyB), githubEvent: 'push', deliveryId: 'dB' },
      deps,
    );
    expect(outcomeA.status).toBe('published');
    expect(outcomeB.status).toBe('published');
    const envelopeA = deps.publishIngestion.mock.calls[0][0] as MessageEnvelope<NormalizedRepoEvent>;
    const envelopeB = deps.publishIngestion.mock.calls[1][0] as MessageEnvelope<NormalizedRepoEvent>;
    expect(envelopeA.org_id).toBe('org-A');
    expect(envelopeB.org_id).toBe('org-B');
  });
});

describe('handleGithubWebhook — installation lifecycle (W1-06)', () => {
  it("delegates 'installation' events to applyInstallationLifecycle instead of the normalize/enqueue path", async () => {
    const deps = makeDeps({
      applyInstallationLifecycle: vi.fn(async () => ({ status: 'revoked' as const })),
    });
    const rawBody = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 555 } }));
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation', deliveryId: 'd20' },
      deps,
    );
    expect(outcome).toEqual({ status: 'installation', result: { status: 'revoked' } });
    expect(deps.applyInstallationLifecycle).toHaveBeenCalledWith({ action: 'deleted', installationId: 555 });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
    expect(deps.resolveOrg).not.toHaveBeenCalled();
  });

  it("an 'installation' event missing installation.id is ignored (no_installation), never reaches the lifecycle service", async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(JSON.stringify({ action: 'deleted' }));
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation', deliveryId: 'd21' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'no_installation' });
    expect(deps.applyInstallationLifecycle).not.toHaveBeenCalled();
  });

  it('signature validation still gates installation events (401 before any lifecycle mutation)', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 555 } }));
    await expect(
      handleGithubWebhook(
        { rawBody, signature: 'sha256=bad', githubEvent: 'installation', deliveryId: 'd22' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(deps.applyInstallationLifecycle).not.toHaveBeenCalled();
  });
});

describe('handleGithubWebhook — installation_repositories (W2-09)', () => {
  it("delegates 'installation_repositories' added events to applyInstallationRepositories instead of the normalize/enqueue path", async () => {
    const deps = makeDeps({
      applyInstallationRepositories: vi.fn(async () => ({
        status: 'added' as const,
        registered: 1,
        enqueued: 1,
      })),
    });
    const rawBody = Buffer.from(
      JSON.stringify({
        action: 'added',
        installation: { id: 555 },
        repositories_added: [{ id: 111, full_name: 'acme/widgets' }],
        repositories_removed: [],
      }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation_repositories', deliveryId: 'd30' },
      deps,
    );
    expect(outcome).toEqual({
      status: 'installation_repositories',
      result: { status: 'added', registered: 1, enqueued: 1 },
    });
    expect(deps.applyInstallationRepositories).toHaveBeenCalledWith({
      action: 'added',
      installationId: 555,
      added: [{ providerRepoId: '111', fullName: 'acme/widgets' }],
      removed: [],
    });
    expect(deps.publishIngestion).not.toHaveBeenCalled();
    expect(deps.publishOwnership).not.toHaveBeenCalled();
    expect(deps.resolveOrg).not.toHaveBeenCalled();
  });

  it("delegates 'installation_repositories' removed events, returning the removed result", async () => {
    const deps = makeDeps({
      applyInstallationRepositories: vi.fn(async () => ({ status: 'removed' as const, revoked: 2 })),
    });
    const rawBody = Buffer.from(
      JSON.stringify({
        action: 'removed',
        installation: { id: 555 },
        repositories_added: [],
        repositories_removed: [
          { id: 111, full_name: 'acme/widgets' },
          { id: 222, full_name: 'acme/gadgets' },
        ],
      }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation_repositories', deliveryId: 'd31' },
      deps,
    );
    expect(outcome).toEqual({ status: 'installation_repositories', result: { status: 'removed', revoked: 2 } });
  });

  it("an 'installation_repositories' event missing installation.id is ignored (no_installation), never reaches the service", async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({ action: 'added', repositories_added: [{ id: 111, full_name: 'acme/widgets' }] }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation_repositories', deliveryId: 'd32' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'no_installation' });
    expect(deps.applyInstallationRepositories).not.toHaveBeenCalled();
  });

  it('an unrecognized action is ignored (noop_action), never reaches the service', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(JSON.stringify({ action: 'unknown_future_action', installation: { id: 555 } }));
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation_repositories', deliveryId: 'd33' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'noop_action' });
    expect(deps.applyInstallationRepositories).not.toHaveBeenCalled();
  });

  it('an empty repositories_added array is ignored (no_repositories), never reaches the service', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({ action: 'added', installation: { id: 555 }, repositories_added: [] }),
    );
    const outcome = await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'installation_repositories', deliveryId: 'd34' },
      deps,
    );
    expect(outcome).toEqual({ status: 'ignored', reason: 'no_repositories' });
    expect(deps.applyInstallationRepositories).not.toHaveBeenCalled();
  });

  it('signature validation still gates installation_repositories events (401 before any mutation)', async () => {
    const deps = makeDeps();
    const rawBody = Buffer.from(
      JSON.stringify({
        action: 'added',
        installation: { id: 555 },
        repositories_added: [{ id: 111, full_name: 'acme/widgets' }],
      }),
    );
    await expect(
      handleGithubWebhook(
        { rawBody, signature: 'sha256=bad', githubEvent: 'installation_repositories', deliveryId: 'd35' },
        deps,
      ),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    expect(deps.applyInstallationRepositories).not.toHaveBeenCalled();
  });
});

describe('handleGithubWebhook — queue/delivery semantics', () => {
  // W1-02 gapfill AC-1 / GAP-4: the same-delivery-replay intent is kept, but the
  // identity is now the SHA-256 of the signed bytes rather than the (unsigned, freely
  // rewritable) X-GitHub-Delivery header this assertion used to pin.
  // @spec AC-1 EC-1
  it('AC9: replaying the same delivery yields the same signed-body idempotency_key both times', async () => {
    const deps = makeDeps();
    const rawBody = pushBody();
    const expectedKey = `github:webhook:${createHash('sha256').update(rawBody).digest('hex')}`;
    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'replay-1' },
      deps,
    );
    await handleGithubWebhook(
      { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'replay-1' },
      deps,
    );
    const first = deps.publishIngestion.mock.calls[0][0] as MessageEnvelope<NormalizedRepoEvent>;
    const second = deps.publishIngestion.mock.calls[1][0] as MessageEnvelope<NormalizedRepoEvent>;
    expect(first.idempotency_key).toBe(expectedKey);
    expect(second.idempotency_key).toBe(expectedKey);
    expect(first.idempotency_key).not.toBe('replay-1');
    expect(first.trace_id).toBe('replay-1');
  });

  it('rethrows when publishIngestion fails even if publishOwnership succeeds — no partial 2xx', async () => {
    const deps = makeDeps({
      publishIngestion: vi.fn(async () => {
        throw new Error('sqs down');
      }),
    });
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd10' },
        deps,
      ),
    ).rejects.toThrow('sqs down');
    expect(deps.publishOwnership).toHaveBeenCalledTimes(1);
  });

  it('rethrows when publishOwnership fails even if publishIngestion succeeds — no partial 2xx', async () => {
    const deps = makeDeps({
      publishOwnership: vi.fn(async () => {
        throw new Error('redis down');
      }),
    });
    const rawBody = pushBody();
    await expect(
      handleGithubWebhook(
        { rawBody, signature: sign(rawBody), githubEvent: 'push', deliveryId: 'd11' },
        deps,
      ),
    ).rejects.toThrow('redis down');
    expect(deps.publishIngestion).toHaveBeenCalledTimes(1);
  });
});
