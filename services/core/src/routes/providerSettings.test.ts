import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetConfigForTests,
  resetSecretsForTests,
  setConfigOverrideForTests,
  setSecretBackendForTests,
} from '@sayre/config';
import type { OrgRole } from '../auth/context';
import { signSessionToken } from '../auth/sessionToken';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const SIGNING_KEY = 'provider-settings-route-test-signing-key';

const responseFixture = {
  settings: { generation: null, embedding: null },
  credentialOptions: [
    {
      id: 'anthropic-default',
      label: 'Provisioned Anthropic credential',
      purpose: 'generation',
      providers: ['anthropic'],
    },
  ],
  endpointOptions: [],
  tradeoffs: {
    hostedGuarantee: 'contractual',
    selfHostedGuarantee: 'structural',
    quality: 'quality',
    latency: 'latency',
  },
};

const getProviderSettings = vi.fn(async () => responseFixture);
const updateProviderSettings = vi.fn(async () => ({
  purpose: 'generation',
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  credentialReferenceId: 'anthropic-default',
  endpointId: null,
  credentialConfigured: true,
  endpointConfigured: false,
  updatedAt: '2026-07-23T04:00:00.000Z',
}));

vi.mock('../services/providerSettingsService', async () => {
  const actual = await vi.importActual<
    typeof import('../services/providerSettingsService')
  >('../services/providerSettingsService');
  return {
    ...actual,
    getProviderSettings: (...args: unknown[]) =>
      (getProviderSettings as unknown as (...values: unknown[]) => unknown)(...args),
    updateProviderSettings: (...args: unknown[]) =>
      (updateProviderSettings as unknown as (...values: unknown[]) => unknown)(
        ...args,
      ),
  };
});

import { createApp } from '../app';
import { ProviderSettingsValidationError } from '../services/providerSettingsService';

async function startServer() {
  const app = createApp();
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function tokenFor(roles: OrgRole[]): Promise<string> {
  return signSessionToken({ userId: 'admin-a', orgId: ORG_A, roles });
}

let activeServer: Server | undefined;

beforeEach(() => {
  setConfigOverrideForTests('NODE_ENV', 'production');
  setSecretBackendForTests(async (ref) => {
    if (ref === 'env://JWT_SIGNING_KEY') return SIGNING_KEY;
    throw new Error('unexpected secret reference');
  });
  getProviderSettings.mockClear();
  updateProviderSettings.mockClear();
});

afterEach(async () => {
  resetSecretsForTests();
  resetConfigForTests();
  if (activeServer) {
    await closeServer(activeServer);
    activeServer = undefined;
  }
});

describe('provider settings HTTP route', () => {
  it('requires authentication and admin role before any service call', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;

    const unauthenticated = await fetch(`${baseUrl}/settings/model-providers`);
    const member = await fetch(`${baseUrl}/settings/model-providers`, {
      headers: { authorization: `Bearer ${await tokenFor(['member'])}` },
    });

    expect(unauthenticated.status).toBe(401);
    expect(member.status).toBe(403);
    expect(getProviderSettings).not.toHaveBeenCalled();
  });

  it('passes only the verified token context; forged org headers/query have no effect', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['admin']);

    const response = await fetch(
      `${baseUrl}/settings/model-providers?orgId=${ORG_B}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          'x-org-id': ORG_B,
          'x-roles': 'owner',
        },
      },
    );

    expect(response.status).toBe(200);
    expect(getProviderSettings).toHaveBeenCalledWith({
      subjectType: 'user',
      userId: 'admin-a',
      orgId: ORG_A,
      roles: ['admin'],
    });
    expect(JSON.stringify(await response.json())).not.toMatch(
      /env:\/\/|API_KEY|endpointUrl|credentialRef/,
    );
  });

  it('keeps the PUT adapter thin and passes purpose/body/context to the service', async () => {
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['owner']);
    const body = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      credentialReferenceId: 'anthropic-default',
      endpointId: null,
    };

    const response = await fetch(
      `${baseUrl}/settings/model-providers/generation`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    expect(response.status).toBe(200);
    expect(updateProviderSettings).toHaveBeenCalledWith(
      'generation',
      body,
      expect.objectContaining({ orgId: ORG_A, roles: ['owner'] }),
    );
  });

  it('returns a fixed sanitized 400 for raw-secret/unknown-field validation failures', async () => {
    updateProviderSettings.mockRejectedValueOnce(
      new ProviderSettingsValidationError(),
    );
    const { server, baseUrl } = await startServer();
    activeServer = server;
    const token = await tokenFor(['admin']);

    const response = await fetch(
      `${baseUrl}/settings/model-providers/generation`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ apiKey: 'sk-ant-value-never-echoed' }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid provider settings' });
  });
});
