import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildProviderSettingsUpdate,
  draftFor,
  type ProviderSettingsDraft,
} from './providerSettingsClient';

describe('provider settings UI contract', () => {
  it('serializes only opaque selections and the bounded model/provider fields', () => {
    const hostileDraft = {
      provider: 'openai_compatible',
      model: 'local-model',
      credentialReferenceId: 'approved-ref-id',
      endpointId: 'approved-endpoint-id',
      orgId: 'forged-org',
      endpointUrl: 'http://169.254.169.254/latest',
      credentialRef: 'env://OPENAI_API_KEY',
      apiKey: 'raw-value',
      password: 'raw-value',
    } as ProviderSettingsDraft & Record<string, unknown>;

    const payload = buildProviderSettingsUpdate(hostileDraft);

    expect(payload).toEqual({
      provider: 'openai_compatible',
      model: 'local-model',
      credentialReferenceId: 'approved-ref-id',
      endpointId: 'approved-endpoint-id',
    });
    expect(Object.keys(payload)).toEqual([
      'provider',
      'model',
      'credentialReferenceId',
      'endpointId',
    ]);
    expect(JSON.stringify(payload)).not.toMatch(
      /forged-org|169\.254|env:\/\/|raw-value/,
    );
  });

  it('keeps generation and embedding drafts independent', () => {
    expect(draftFor('generation', null)).toMatchObject({
      provider: 'anthropic',
      model: expect.stringMatching(/claude/i),
    });
    expect(draftFor('embedding', null)).toMatchObject({
      provider: 'openai_compatible',
      model: 'Qwen3-Embedding-0.6B',
    });
  });

  it('contains no raw credential/reference/endpoint input or secret inventory value', () => {
    const component = readFileSync(
      new URL('./ProviderSettingsPanel.tsx', import.meta.url),
      'utf8',
    );
    const page = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8');
    const combined = `${component}\n${page}`;

    expect(combined).not.toMatch(
      /ANTHROPIC_API_KEY|OPENAI_API_KEY|env:\/\/|sk-ant-|sk-proj-|apiKey|accessToken|password/i,
    );
    expect(combined).not.toMatch(/\bcredentialRef\b|\bendpointUrl\b/);
    expect(combined).not.toMatch(/type=["']password["']/);
    expect(combined).toMatch(/Generation/);
    expect(combined).toMatch(/Embedding/);
    expect(combined).toMatch(/Raw keys cannot be entered, viewed, or stored/);
    expect(combined).toMatch(/contractual/i);
    expect(combined).toMatch(/structural/i);
    expect(combined).toMatch(/tradeoffs\.latency/);
  });
});
