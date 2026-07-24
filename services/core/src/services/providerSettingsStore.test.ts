import { describe, expect, it, vi } from 'vitest';
import {
  PostgresProviderSettingsStore,
  type StoredProviderSettingInput,
} from '../db/providerSettingsStore';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-07-23T04:00:00.000Z');

function selectedRow() {
  return {
    id: 'config-1',
    orgId: ORG_A,
    purpose: 'generation',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    endpointUrl: null,
    credentialRef: 'env://ANTHROPIC_API_KEY',
    dimension: null,
    config: {},
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('PostgresProviderSettingsStore', () => {
  it('runs list inside the server-supplied org context and applies an explicit org predicate', async () => {
    const where = vi.fn(async () => [selectedRow()]);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const tx = { select };
    const withOrg = vi.fn(async (_db, orgId: string, fn) => {
      expect(orgId).toBe(ORG_A);
      return fn(tx);
    });
    const store = new PostgresProviderSettingsStore({
      getDb: vi.fn(async () => ({}) as never),
      withOrg: withOrg as never,
    });

    await expect(store.list(ORG_A)).resolves.toEqual([
      {
        purpose: 'generation',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        endpointUrl: null,
        credentialRef: 'env://ANTHROPIC_API_KEY',
        dimension: null,
        updatedAt: NOW,
      },
    ]);
    expect(withOrg).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
  });

  it('uses the purpose-keyed upsert and writes only resolved references/URLs', async () => {
    const values = vi.fn();
    const onConflictDoUpdate = vi.fn();
    const returning = vi.fn(async () => [
      {
        ...selectedRow(),
        provider: 'openai_compatible',
        model: 'local-model',
        endpointUrl: 'https://models.acme.example/v1',
        credentialRef: null,
      },
    ]);
    const chain = {
      values: (input: unknown) => {
        values(input);
        return {
          onConflictDoUpdate: (inputConflict: unknown) => {
            onConflictDoUpdate(inputConflict);
            return { returning };
          },
        };
      },
    };
    const tx = { insert: vi.fn(() => chain) };
    const withOrg = vi.fn(async (_db, orgId: string, fn) => {
      expect(orgId).toBe(ORG_A);
      return fn(tx);
    });
    const store = new PostgresProviderSettingsStore({
      getDb: vi.fn(async () => ({}) as never),
      withOrg: withOrg as never,
    });
    const setting: StoredProviderSettingInput = {
      purpose: 'generation',
      provider: 'openai_compatible',
      model: 'local-model',
      endpointUrl: 'https://models.acme.example/v1',
      credentialRef: null,
      dimension: null,
    };

    await store.upsert(ORG_A, setting);

    expect(values).toHaveBeenCalledWith({
      orgId: ORG_A,
      purpose: 'generation',
      provider: 'openai_compatible',
      model: 'local-model',
      endpointUrl: 'https://models.acme.example/v1',
      credentialRef: null,
      dimension: null,
      config: {},
    });
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown[];
      set: Record<string, unknown>;
    };
    expect(conflict.target).toHaveLength(2);
    expect(conflict.set).not.toHaveProperty('orgId');
    expect(conflict.set).not.toHaveProperty('purpose');
    expect(conflict.set).not.toHaveProperty('apiKey');
    expect(conflict.set).not.toHaveProperty('token');
    expect(conflict.set).not.toHaveProperty('config');
  });
});
