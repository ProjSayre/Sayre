import type {
  ProviderKind,
  ProviderPurpose,
  ProviderSettingView,
  ProviderSettingsUpdateRequest,
} from '@sayre/shared-types';

export interface ProviderSettingsDraft {
  provider: ProviderKind;
  model: string;
  credentialReferenceId: string | null;
  endpointId: string | null;
}

const DEFAULTS: Record<ProviderPurpose, ProviderSettingsDraft> = {
  generation: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    credentialReferenceId: null,
    endpointId: null,
  },
  embedding: {
    provider: 'openai_compatible',
    model: 'Qwen3-Embedding-0.6B',
    credentialReferenceId: null,
    endpointId: null,
  },
};

export function draftFor(
  purpose: ProviderPurpose,
  current: ProviderSettingView | null,
): ProviderSettingsDraft {
  return current
    ? {
        provider: current.provider,
        model: current.model,
        credentialReferenceId: current.credentialReferenceId,
        endpointId: current.endpointId,
      }
    : { ...DEFAULTS[purpose] };
}

/**
 * The only browser write serializer. It cannot include org identity, an endpoint
 * URL, a credential reference/value, or a generic options bag.
 */
export function buildProviderSettingsUpdate(
  draft: ProviderSettingsDraft,
): ProviderSettingsUpdateRequest {
  return {
    provider: draft.provider,
    model: draft.model,
    credentialReferenceId: draft.credentialReferenceId,
    endpointId: draft.endpointId,
  };
}
