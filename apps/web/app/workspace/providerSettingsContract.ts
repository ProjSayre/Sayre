import type {
  ProviderCredentialOption,
  ProviderEndpointOption,
  ProviderKind,
  ProviderPurpose,
  ProviderSettingsResponse,
  ProviderSettingView,
} from '@sayre/shared-types';

const PURPOSES = new Set<ProviderPurpose>(['generation', 'embedding']);
const PROVIDERS = new Set<ProviderKind>([
  'anthropic',
  'openai',
  'openai_compatible',
]);

export class ProviderSettingsContractError extends Error {
  constructor() {
    super('The provider settings response is invalid.');
    this.name = 'ProviderSettingsContractError';
  }
}

export type ProviderConfigurationStatus =
  | 'configured'
  | 'incomplete'
  | 'not-configured';

export function providerConfigurationStatus(
  setting: ProviderSettingView | null,
): ProviderConfigurationStatus {
  if (setting === null) return 'not-configured';
  if (setting.provider === 'openai_compatible') {
    return setting.endpointConfigured ? 'configured' : 'incomplete';
  }
  return setting.credentialConfigured ? 'configured' : 'incomplete';
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderSettingsContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ProviderSettingsContractError();
  }
  return value;
}

function nullableId(value: unknown): string | null {
  if (value === null) return null;
  return requiredString(value);
}

function purpose(value: unknown): ProviderPurpose {
  if (typeof value !== 'string' || !PURPOSES.has(value as ProviderPurpose)) {
    throw new ProviderSettingsContractError();
  }
  return value as ProviderPurpose;
}

function provider(value: unknown): ProviderKind {
  if (typeof value !== 'string' || !PROVIDERS.has(value as ProviderKind)) {
    throw new ProviderSettingsContractError();
  }
  return value as ProviderKind;
}

export function parseProviderSettingView(value: unknown): ProviderSettingView {
  const item = record(value);
  const updatedAt = requiredString(item.updatedAt);
  if (
    typeof item.credentialConfigured !== 'boolean' ||
    typeof item.endpointConfigured !== 'boolean' ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    throw new ProviderSettingsContractError();
  }
  return {
    purpose: purpose(item.purpose),
    provider: provider(item.provider),
    model: requiredString(item.model),
    credentialReferenceId: nullableId(item.credentialReferenceId),
    endpointId: nullableId(item.endpointId),
    credentialConfigured: item.credentialConfigured,
    endpointConfigured: item.endpointConfigured,
    updatedAt,
  };
}

function option<T extends ProviderCredentialOption | ProviderEndpointOption>(
  value: unknown,
): T {
  const item = record(value);
  if (!Array.isArray(item.providers) || item.providers.length === 0) {
    throw new ProviderSettingsContractError();
  }
  return {
    id: requiredString(item.id),
    label: requiredString(item.label),
    purpose: purpose(item.purpose),
    providers: item.providers.map(provider),
  } as T;
}

export function parseProviderSettingsResponse(
  value: unknown,
): ProviderSettingsResponse {
  const response = record(value);
  const settings = record(response.settings);
  const tradeoffs = record(response.tradeoffs);
  if (
    !Array.isArray(response.credentialOptions) ||
    !Array.isArray(response.endpointOptions)
  ) {
    throw new ProviderSettingsContractError();
  }
  const generation =
    settings.generation === null
      ? null
      : parseProviderSettingView(settings.generation);
  const embedding =
    settings.embedding === null
      ? null
      : parseProviderSettingView(settings.embedding);
  if (
    generation?.purpose !== undefined &&
    generation.purpose !== 'generation'
  ) {
    throw new ProviderSettingsContractError();
  }
  if (
    embedding?.purpose !== undefined &&
    embedding.purpose !== 'embedding'
  ) {
    throw new ProviderSettingsContractError();
  }
  return {
    settings: { generation, embedding },
    credentialOptions: response.credentialOptions.map((item) =>
      option<ProviderCredentialOption>(item),
    ),
    endpointOptions: response.endpointOptions.map((item) =>
      option<ProviderEndpointOption>(item),
    ),
    tradeoffs: {
      hostedGuarantee: requiredString(tradeoffs.hostedGuarantee),
      selfHostedGuarantee: requiredString(tradeoffs.selfHostedGuarantee),
      quality: requiredString(tradeoffs.quality),
      latency: requiredString(tradeoffs.latency),
    },
  };
}
