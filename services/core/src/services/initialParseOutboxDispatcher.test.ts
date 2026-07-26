import { describe, expect, it, vi } from 'vitest';
import type { RepoInitialParseEvent } from '@sayre/shared-types';
import type { ClaimedInitialParseOutboxEvent } from '../db/githubInitialParseOutbox';
import { makeEnvelope, type MessageEnvelope } from '../queue/envelope';
import {
  InitialParseOutboxDispatcher,
  type InitialParseOutboxDispatcherDeps,
} from './initialParseOutboxDispatcher';

const OUTBOX_ID = '00000000-0000-4000-8000-000000000010';
const LEASE_TOKEN = '00000000-0000-4000-8000-000000000011';

function envelope(): MessageEnvelope<RepoInitialParseEvent> {
  return makeEnvelope({
    message_id: '00000000-0000-4000-8000-000000000012',
    idempotency_key: `github:initial_parse:555:42:refs/heads/main:${'a'.repeat(40)}`,
    org_id: '00000000-0000-4000-8000-000000000001',
    type: 'repo.initial_parse',
    source: 'github-app-install',
    payload: {
      provider: 'github',
      type: 'initial_parse',
      repo: {
        repo_id: '00000000-0000-4000-8000-000000000020',
        provider_repo_id: '42',
        full_name: 'acme/widgets',
      },
      ref: 'refs/heads/main',
      revision_sha: 'a'.repeat(40),
      installation_id: '555',
      reason: 'app_install',
    },
  });
}

function claim(attemptCount = 1): ClaimedInitialParseOutboxEvent {
  return {
    id: OUTBOX_ID,
    leaseToken: LEASE_TOKEN,
    attemptCount,
    envelope: envelope(),
  };
}

function deps(
  overrides: Partial<InitialParseOutboxDispatcherDeps> = {},
): InitialParseOutboxDispatcherDeps {
  return {
    claim: vi.fn(async () => [claim()]),
    complete: vi.fn(async () => true),
    retry: vi.fn(async () => true),
    publish: vi.fn(async () => 'sqs-message-id'),
    reportError: vi.fn(),
    ...overrides,
  };
}

describe('InitialParseOutboxDispatcher', () => {
  it('publishes the exact committed envelope before marking its lease delivered', async () => {
    const calls: string[] = [];
    const event = claim();
    const injected = deps({
      claim: vi.fn(async () => [event]),
      publish: vi.fn(async (published) => {
        calls.push('publish');
        expect(published).toBe(event.envelope);
      }),
      complete: vi.fn(async () => {
        calls.push('complete');
        return true;
      }),
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      deferred: 0,
    });

    expect(calls).toEqual(['publish', 'complete']);
    expect(injected.complete).toHaveBeenCalledWith(OUTBOX_ID, LEASE_TOKEN);
    expect(injected.retry).not.toHaveBeenCalled();
  });

  it('releases a failed publish with bounded exponential backoff', async () => {
    const injected = deps({
      claim: vi.fn(async () => [claim(4)]),
      publish: vi.fn(async () => {
        throw new Error('secret-bearing provider detail');
      }),
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      deferred: 1,
    });

    expect(injected.complete).not.toHaveBeenCalled();
    expect(injected.retry).toHaveBeenCalledWith(OUTBOX_ID, LEASE_TOKEN, 8);
    expect(injected.reportError).toHaveBeenCalledWith('publish');
    expect(injected.reportError).not.toHaveBeenCalledWith(
      expect.stringContaining('secret-bearing'),
    );
  });

  it('leaves a published row leased when the durable completion write fails', async () => {
    const injected = deps({
      complete: vi.fn(async () => {
        throw new Error('database unavailable');
      }),
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      deferred: 1,
    });

    expect(injected.retry).not.toHaveBeenCalled();
    expect(injected.reportError).toHaveBeenCalledWith('complete');
  });

  it('counts a lost completion lease as deferred rather than delivered', async () => {
    const injected = deps({
      complete: vi.fn(async () => false),
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      deferred: 1,
    });
  });

  it('continues with later rows when one publish fails', async () => {
    const first = claim(1);
    const second = {
      ...claim(1),
      id: '00000000-0000-4000-8000-000000000013',
      leaseToken: '00000000-0000-4000-8000-000000000014',
    };
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('sent');
    const injected = deps({
      claim: vi.fn(async () => [first, second]),
      publish,
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected);

    await expect(dispatcher.drainOnce()).resolves.toEqual({
      claimed: 2,
      delivered: 1,
      deferred: 1,
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(injected.complete).toHaveBeenCalledWith(second.id, second.leaseToken);
  });

  it('starts with an immediate recovery claim and stops without another poll', async () => {
    let signalClaim!: () => void;
    const claimed = new Promise<void>((resolve) => {
      signalClaim = resolve;
    });
    const injected = deps({
      claim: vi.fn(async () => {
        signalClaim();
        return [];
      }),
    });
    const dispatcher = new InitialParseOutboxDispatcher(injected, {
      pollIntervalMs: 25,
    });

    dispatcher.start();
    await claimed;
    await dispatcher.stop();

    expect(injected.claim).toHaveBeenCalledOnce();
  });
});
