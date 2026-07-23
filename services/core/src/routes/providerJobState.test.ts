import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '@sayre/config';

const getProviderJobState = vi.fn(async () => ({
  repositoryId: '22222222-2222-4222-8222-222222222222',
  refName: 'refs/heads/main',
  revisionSha: 'a'.repeat(40),
  surface: 'product',
  status: 'degraded',
  reasonCode: 'timeout',
  updatedAt: '2026-07-22T04:00:00.000Z',
}));

vi.mock('../services/providerJobStateService', async () => {
  class ProviderJobStateInputError extends Error {}
  class ProviderJobStateAccessDeniedError extends Error {}
  return {
    ProviderJobStateInputError,
    ProviderJobStateAccessDeniedError,
    parseProviderJobStateQuery: (query: { refName: unknown; surface: unknown }) => {
      if (
        typeof query.refName !== 'string' ||
        !query.refName.startsWith('refs/') ||
        typeof query.surface !== 'string' ||
        !['product', 'onboarding', 'chatbot'].includes(query.surface)
      ) {
        throw new ProviderJobStateInputError();
      }
      return query;
    },
    getProviderJobState: (...args: unknown[]) => getProviderJobState(...args),
  };
});

import { createApp } from '../app';

let server: Server | undefined;

async function startServer(): Promise<string> {
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  getProviderJobState.mockClear();
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('GET /repos/:repoId/provider-state', () => {
  it('parses a narrow query and delegates with server-derived auth context', async () => {
    const baseUrl = await startServer();
    const response = await fetch(
      `${baseUrl}/repos/22222222-2222-4222-8222-222222222222/provider-state?refName=refs%2Fheads%2Fmain&surface=product&orgId=attacker`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'degraded', reasonCode: 'timeout' });
    expect(getProviderJobState).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      { refName: 'refs/heads/main', surface: 'product' },
      expect.objectContaining({
        orgId: getConfig('DEV_ORG_ID'),
        subjectType: 'user',
      }),
    );
    expect(JSON.stringify(getProviderJobState.mock.calls)).not.toContain('attacker');
  });

  it('returns a safe 400 for malformed query input', async () => {
    const baseUrl = await startServer();
    const response = await fetch(
      `${baseUrl}/repos/22222222-2222-4222-8222-222222222222/provider-state?refName=main&surface=raw`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid provider state request' });
    expect(getProviderJobState).not.toHaveBeenCalled();
  });
});
