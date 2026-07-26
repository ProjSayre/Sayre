import { describe, expect, it } from 'vitest';
import type { ProviderSettingView } from '@sayre/shared-types';
import { providerConfigurationStatus } from './providerSettingsContract';

function setting(
  overrides: Partial<ProviderSettingView> = {},
): ProviderSettingView {
  return {
    purpose: 'generation',
    provider: 'openai',
    model: 'gpt-example',
    credentialReferenceId: 'credential-1',
    endpointId: null,
    credentialConfigured: true,
    endpointConfigured: false,
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider configuration status', () => {
  it('distinguishes missing, incomplete, and runnable hosted settings', () => {
    expect(providerConfigurationStatus(null)).toBe('not-configured');
    expect(
      providerConfigurationStatus(
        setting({
          credentialReferenceId: null,
          credentialConfigured: false,
        }),
      ),
    ).toBe('incomplete');
    expect(providerConfigurationStatus(setting())).toBe('configured');
  });

  it('requires an approved endpoint for self-hosted providers', () => {
    expect(
      providerConfigurationStatus(
        setting({
          provider: 'openai_compatible',
          credentialReferenceId: null,
          credentialConfigured: false,
        }),
      ),
    ).toBe('incomplete');
    expect(
      providerConfigurationStatus(
        setting({
          provider: 'openai_compatible',
          credentialReferenceId: null,
          endpointId: 'endpoint-1',
          credentialConfigured: false,
          endpointConfigured: true,
        }),
      ),
    ).toBe('configured');
  });
});
