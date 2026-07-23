import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  ProviderSettingsStore,
  StoredProviderSetting,
  StoredProviderSettingInput,
} from '../db/providerSettingsStore';
import {
  ProviderSettingsForbiddenError,
  ProviderSettingsValidationError,
  getProviderSettings,
  updateProviderSettings,
} from './providerSettingsService';
import {
  parseEndpointCatalog,
  type CredentialRegistryEntry,
} from './providerSettingsCatalog';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-07-23T04:00:00.000Z');

const ADMIN: AuthContext = {
  subjectType: 'user',
  userId: 'admin-a',
  orgId: ORG_A,
  roles: ['admin'],
};

const CREDENTIALS: CredentialRegistryEntry[] = [
  {
    id: 'anthropic-a',
    label: 'Org A Anthropic',
    purpose: 'generation',
    providers: ['anthropic'],
    reference: 'env://ANTHROPIC_API_KEY',
    orgIds: [ORG_A],
  },
  {
    id: 'openai-generation-a',
    label: 'Org A OpenAI generation',
    purpose: 'generation',
    providers: ['openai'],
    reference: 'env://OPENAI_API_KEY',
    orgIds: [ORG_A],
  },
  {
    id: 'openai-embedding-a',
    label: 'Org A OpenAI embedding',
    purpose: 'embedding',
    providers: ['openai'],
    reference: 'env://OPENAI_API_KEY',
    orgIds: [ORG_A],
  },
  {
    id: 'anthropic-b',
    label: 'Org B Anthropic',
    purpose: 'generation',
    providers: ['anthropic'],
    reference: 'env://ANTHROPIC_API_KEY',
    orgIds: [ORG_B],
  },
];

const ENDPOINTS = parseEndpointCatalog(
  JSON.stringify([
    {
      id: 'vllm-a',
      label: 'Org A vLLM',
      url: 'http://10.20.30.40:8000/v1',
      orgIds: [ORG_A],
      purposes: ['generation', 'embedding'],
      allowPrivate: true,
      allowInsecureHttp: true,
    },
    {
      id: 'vllm-b',
      label: 'Org B vLLM',
      url: 'https://models-b.example/v1',
      orgIds: [ORG_B],
      purposes: ['generation'],
    },
  ]),
);

class MemoryStore implements ProviderSettingsStore {
  readonly rows = new Map<string, StoredProviderSetting>();
  readonly list = vi.fn(async (orgId: string) =>
    [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${orgId}:`))
      .map(([, row]) => row),
  );
  readonly upsert = vi.fn(
    async (
      orgId: string,
      setting: StoredProviderSettingInput,
    ): Promise<StoredProviderSetting> => {
      const row = { ...setting, updatedAt: NOW };
      this.rows.set(`${orgId}:${setting.purpose}`, row);
      return row;
    },
  );
}

function deps(store: ProviderSettingsStore) {
  return {
    store,
    credentialRegistry: CREDENTIALS,
    loadEndpoints: () => ENDPOINTS,
  };
}

function generationBody(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    credentialReferenceId: 'anthropic-a',
    endpointId: null,
    ...overrides,
  };
}

describe('provider settings service', () => {
  it('persists only the server-resolved org and authorized reference, then exposes a redacted view', async () => {
    const store = new MemoryStore();

    const updated = await updateProviderSettings(
      'generation',
      generationBody(),
      ADMIN,
      deps(store),
    );

    expect(store.upsert).toHaveBeenCalledWith(ORG_A, {
      purpose: 'generation',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      credentialRef: 'env://ANTHROPIC_API_KEY',
      endpointUrl: null,
      dimension: null,
    });
    expect(updated).toEqual({
      purpose: 'generation',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      credentialReferenceId: 'anthropic-a',
      endpointId: null,
      credentialConfigured: true,
      endpointConfigured: false,
      updatedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(updated)).not.toContain('env://');
    expect(JSON.stringify(updated)).not.toContain('ANTHROPIC_API_KEY');
  });

  it('keeps embedding separate, fixes dimension at 1024, and allows an approved credentialless endpoint', async () => {
    const store = new MemoryStore();

    await updateProviderSettings(
      'embedding',
      {
        provider: 'openai_compatible',
        model: 'Qwen3-Embedding-0.6B',
        credentialReferenceId: null,
        endpointId: 'vllm-a',
      },
      ADMIN,
      deps(store),
    );

    expect(store.upsert).toHaveBeenCalledWith(ORG_A, {
      purpose: 'embedding',
      provider: 'openai_compatible',
      model: 'Qwen3-Embedding-0.6B',
      credentialRef: null,
      endpointUrl: 'http://10.20.30.40:8000/v1',
      dimension: 1_024,
    });
  });

  it('makes an update visible to the very next uncached settings read', async () => {
    const store = new MemoryStore();
    await updateProviderSettings(
      'generation',
      generationBody(),
      ADMIN,
      deps(store),
    );

    const response = await getProviderSettings(ADMIN, deps(store));

    expect(store.list).toHaveBeenCalledTimes(1);
    expect(response.settings.generation?.provider).toBe('anthropic');
    expect(response.settings.generation?.credentialReferenceId).toBe('anthropic-a');
    expect(response.settings.embedding).toBeNull();
    expect(response.tradeoffs.hostedGuarantee).toMatch(/contractual/i);
    expect(response.tradeoffs.selfHostedGuarantee).toMatch(/structural/i);
    expect(response.tradeoffs.quality).toMatch(/noisier/i);
    expect(response.tradeoffs.latency).toMatch(/15-second structural-sync/i);
  });

  it('redacts underlying credential references and endpoint URLs from list options', async () => {
    const store = new MemoryStore();

    const response = await getProviderSettings(ADMIN, deps(store));
    const serialized = JSON.stringify(response);

    expect(response.credentialOptions.map((option) => option.id)).toEqual([
      'anthropic-a',
      'openai-generation-a',
      'openai-embedding-a',
    ]);
    expect(response.endpointOptions.map((option) => option.id)).toEqual([
      'vllm-a',
      'vllm-a',
    ]);
    expect(serialized).not.toMatch(/env:\/\//);
    expect(serialized).not.toContain('10.20.30.40');
    expect(serialized).not.toContain('OPENAI_API_KEY');
  });

  it.each<AuthContext>([
    { ...ADMIN, roles: ['member'] },
    {
      subjectType: 'agent_key',
      agentKeyId: 'mcp_live_example',
      orgId: ORG_A,
      roles: ['owner'],
    },
  ])('fails closed for non-admin-user context %#', async (ctx) => {
    const store = new MemoryStore();

    await expect(getProviderSettings(ctx, deps(store))).rejects.toBeInstanceOf(
      ProviderSettingsForbiddenError,
    );
    await expect(
      updateProviderSettings('generation', generationBody(), ctx, deps(store)),
    ).rejects.toBeInstanceOf(ProviderSettingsForbiddenError);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { orgId: ORG_B },
    { credentialRef: 'env://ANTHROPIC_API_KEY' },
    { endpointUrl: 'http://169.254.169.254/latest' },
    { apiKey: 'sk-ant-raw-value' },
    { token: 'raw-token' },
    { password: 'raw-password' },
    { config: { temperature: 0.3 } },
  ])('rejects forged org/raw secret/raw URL/unknown fields before persistence: %j', async (extra) => {
    const store = new MemoryStore();

    await expect(
      updateProviderSettings(
        'generation',
        { ...generationBody(), ...extra },
        ADMIN,
        deps(store),
      ),
    ).rejects.toBeInstanceOf(ProviderSettingsValidationError);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it.each([
    generationBody({ credentialReferenceId: 'anthropic-b' }),
    generationBody({ credentialReferenceId: 'openai-embedding-a' }),
    generationBody({ credentialReferenceId: 'missing' }),
    generationBody({ provider: 'openai', credentialReferenceId: 'anthropic-a' }),
    generationBody({ provider: 'openai_compatible', endpointId: 'vllm-b' }),
    generationBody({
      provider: 'openai_compatible',
      credentialReferenceId: 'openai-generation-a',
      endpointId: 'vllm-a',
    }),
  ])('rejects unauthorized/cross-org/cross-purpose/cross-provider options: %j', async (body) => {
    const store = new MemoryStore();

    await expect(
      updateProviderSettings('generation', body, ADMIN, deps(store)),
    ).rejects.toBeInstanceOf(ProviderSettingsValidationError);
    expect(store.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['embedding', generationBody()],
    [
      'generation',
      generationBody({ provider: 'openai_compatible', endpointId: null }),
    ],
    [
      'generation',
      generationBody({ provider: 'anthropic', endpointId: 'vllm-a' }),
    ],
    [
      'generation',
      generationBody({ credentialReferenceId: null }),
    ],
    [
      'generation',
      generationBody({ model: ' sk-ant-secret-looking-value ' }),
    ],
    [
      'generation',
      generationBody({ model: 'sk-proj-secret-looking-value' }),
    ],
    ['chatbot', generationBody()],
  ])('rejects invalid purpose/provider/model/endpoint combinations: %s', async (purpose, body) => {
    const store = new MemoryStore();

    await expect(
      updateProviderSettings(purpose, body, ADMIN, deps(store)),
    ).rejects.toBeInstanceOf(ProviderSettingsValidationError);
    expect(store.upsert).not.toHaveBeenCalled();
  });
});
