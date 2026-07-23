import type {
  ProviderCredentialOption,
  ProviderEndpointOption,
  ProviderKind,
  ProviderPurpose,
  ProviderSettingView,
  ProviderSettingsResponse,
  ProviderSettingsTradeoffs,
  ProviderSettingsUpdateRequest,
} from '@sayre/shared-types';
import type { AuthContext } from '../auth/context';
import {
  providerSettingsStore,
  type ProviderSettingsStore,
  type StoredProviderSetting,
  type StoredProviderSettingInput,
} from '../db/providerSettingsStore';
import {
  DEFAULT_CREDENTIAL_REGISTRY,
  credentialOptionsForOrg,
  endpointOptionsForOrg,
  loadEndpointCatalog,
  supportsProvider,
  type CredentialRegistryEntry,
  type EndpointCatalogEntry,
} from './providerSettingsCatalog';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/;
const SECRET_LIKE_RE =
  /^(?:sk(?:-ant|-proj)?-|gh[pousr]_|xox[baprs]-|AIza|eyJ[a-zA-Z0-9_-]{10,})|-----BEGIN|(?:api[_-]?key|access[_-]?token|password|secret)=/i;

const PURPOSE_PROVIDERS: Readonly<Record<ProviderPurpose, readonly ProviderKind[]>> = {
  generation: ['anthropic', 'openai', 'openai_compatible'],
  embedding: ['openai', 'openai_compatible'],
};

const TRADEOFFS: ProviderSettingsTradeoffs = {
  hostedGuarantee:
    'Hosted providers offer a contractual data-handling guarantee: requests leave the customer network and are governed by vendor terms.',
  selfHostedGuarantee:
    'An approved self-hosted endpoint provides a structural no-vendor-server path: no Anthropic, OpenAI, or other third-party model server is selected.',
  quality:
    'Smaller or narrowly fine-tuned models can understand local code yet still produce noisier schema-shaped clustering, style, or summary output.',
  latency:
    'Self-hosted latency and uptime affect enrichment readiness and chatbot response time, never the 15-second structural-sync target.',
};

export class ProviderSettingsValidationError extends Error {
  constructor() {
    super('Provider settings are invalid.');
    this.name = 'ProviderSettingsValidationError';
  }
}

export class ProviderSettingsForbiddenError extends Error {
  constructor() {
    super('Provider settings require an org administrator.');
    this.name = 'ProviderSettingsForbiddenError';
  }
}

export class ProviderSettingsConfigurationError extends Error {
  constructor() {
    super('Stored provider settings are invalid.');
    this.name = 'ProviderSettingsConfigurationError';
  }
}

export interface ProviderSettingsDeps {
  store: ProviderSettingsStore;
  credentialRegistry: readonly CredentialRegistryEntry[];
  loadEndpoints: () => readonly EndpointCatalogEntry[];
}

const defaultDeps: ProviderSettingsDeps = {
  store: providerSettingsStore,
  credentialRegistry: DEFAULT_CREDENTIAL_REGISTRY,
  loadEndpoints: loadEndpointCatalog,
};

function resolveDeps(overrides: Partial<ProviderSettingsDeps>): ProviderSettingsDeps {
  return { ...defaultDeps, ...overrides };
}

function requireAdminUser(ctx: AuthContext): void {
  if (
    ctx.subjectType !== 'user' ||
    (!ctx.roles.includes('owner') && !ctx.roles.includes('admin'))
  ) {
    throw new ProviderSettingsForbiddenError();
  }
}

function parsePurpose(value: unknown): ProviderPurpose {
  if (value !== 'generation' && value !== 'embedding') {
    throw new ProviderSettingsValidationError();
  }
  return value;
}

function nullableId(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new ProviderSettingsValidationError();
  }
  return value;
}

function parseUpdate(body: unknown): ProviderSettingsUpdateRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ProviderSettingsValidationError();
  }
  const record = body as Record<string, unknown>;
  const expected = new Set([
    'provider',
    'model',
    'credentialReferenceId',
    'endpointId',
  ]);
  if (
    Object.keys(record).length !== expected.size ||
    Object.keys(record).some((key) => !expected.has(key)) ||
    [...expected].some((key) => !(key in record))
  ) {
    // Rejects orgId, endpointUrl, credentialRef, apiKey, token, password,
    // generic config, and every other raw/ambiguous field.
    throw new ProviderSettingsValidationError();
  }
  if (
    record.provider !== 'anthropic' &&
    record.provider !== 'openai' &&
    record.provider !== 'openai_compatible'
  ) {
    throw new ProviderSettingsValidationError();
  }
  if (typeof record.model !== 'string') {
    throw new ProviderSettingsValidationError();
  }
  const model = record.model.trim();
  if (
    !MODEL_RE.test(model) ||
    SECRET_LIKE_RE.test(model) ||
    model !== record.model
  ) {
    throw new ProviderSettingsValidationError();
  }
  return {
    provider: record.provider,
    model,
    credentialReferenceId: nullableId(record.credentialReferenceId),
    endpointId: nullableId(record.endpointId),
  };
}

function redactedCredential(
  entry: CredentialRegistryEntry,
): ProviderCredentialOption {
  return {
    id: entry.id,
    label: entry.label,
    purpose: entry.purpose,
    providers: [...entry.providers],
  };
}

function redactedEndpoint(entry: EndpointCatalogEntry): ProviderEndpointOption {
  return {
    id: entry.id,
    label: entry.label,
    purpose: entry.purpose,
    providers: [...entry.providers],
  };
}

function knownProvider(
  purpose: ProviderPurpose,
  value: string,
): value is ProviderKind {
  return (PURPOSE_PROVIDERS[purpose] as readonly string[]).includes(value);
}

function settingView(
  row: StoredProviderSetting,
  credentials: readonly CredentialRegistryEntry[],
  endpoints: readonly EndpointCatalogEntry[],
): ProviderSettingView {
  if (!knownProvider(row.purpose, row.provider)) {
    throw new ProviderSettingsConfigurationError();
  }
  const credential =
    row.credentialRef === null
      ? undefined
      : credentials.find(
          (entry) =>
            entry.reference === row.credentialRef &&
            supportsProvider(entry, row.purpose, row.provider),
        );
  const endpoint =
    row.endpointUrl === null
      ? undefined
      : endpoints.find(
          (entry) =>
            entry.url === row.endpointUrl &&
            supportsProvider(entry, row.purpose, row.provider),
        );
  return {
    purpose: row.purpose,
    provider: row.provider,
    model: row.model,
    credentialReferenceId: credential?.id ?? null,
    endpointId: endpoint?.id ?? null,
    credentialConfigured: row.credentialRef !== null,
    endpointConfigured: row.endpointUrl !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function selectCredential(
  request: ProviderSettingsUpdateRequest,
  purpose: ProviderPurpose,
  credentials: readonly CredentialRegistryEntry[],
): CredentialRegistryEntry | null {
  const selected =
    request.credentialReferenceId === null
      ? null
      : credentials.find(
          (entry) =>
            entry.id === request.credentialReferenceId &&
            supportsProvider(entry, purpose, request.provider),
        ) ?? null;
  if (request.credentialReferenceId !== null && selected === null) {
    throw new ProviderSettingsValidationError();
  }
  const hosted = request.provider === 'anthropic' || request.provider === 'openai';
  if (hosted && selected === null) throw new ProviderSettingsValidationError();
  return selected;
}

function selectEndpoint(
  request: ProviderSettingsUpdateRequest,
  purpose: ProviderPurpose,
  endpoints: readonly EndpointCatalogEntry[],
): EndpointCatalogEntry | null {
  const selected =
    request.endpointId === null
      ? null
      : endpoints.find(
          (entry) =>
            entry.id === request.endpointId &&
            supportsProvider(entry, purpose, request.provider),
        ) ?? null;
  if (request.endpointId !== null && selected === null) {
    throw new ProviderSettingsValidationError();
  }
  if (request.provider === 'openai_compatible' && selected === null) {
    throw new ProviderSettingsValidationError();
  }
  if (request.provider !== 'openai_compatible' && selected !== null) {
    throw new ProviderSettingsValidationError();
  }
  return selected;
}

function settingInput(
  purpose: ProviderPurpose,
  request: ProviderSettingsUpdateRequest,
  credential: CredentialRegistryEntry | null,
  endpoint: EndpointCatalogEntry | null,
): StoredProviderSettingInput {
  return {
    purpose,
    provider: request.provider,
    model: request.model,
    credentialRef: credential?.reference ?? null,
    endpointUrl: endpoint?.url ?? null,
    dimension: purpose === 'embedding' ? 1_024 : null,
  };
}

export async function getProviderSettings(
  ctx: AuthContext,
  overrides: Partial<ProviderSettingsDeps> = {},
): Promise<ProviderSettingsResponse> {
  requireAdminUser(ctx);
  const deps = resolveDeps(overrides);
  const credentials = credentialOptionsForOrg(ctx.orgId, deps.credentialRegistry);
  const endpoints = endpointOptionsForOrg(ctx.orgId, deps.loadEndpoints());
  const rows = await deps.store.list(ctx.orgId);
  const settings: ProviderSettingsResponse['settings'] = {
    generation: null,
    embedding: null,
  };
  for (const row of rows) {
    if (settings[row.purpose] !== null) {
      throw new ProviderSettingsConfigurationError();
    }
    settings[row.purpose] = settingView(row, credentials, endpoints);
  }
  return {
    settings,
    credentialOptions: credentials.map(redactedCredential),
    endpointOptions: endpoints.map(redactedEndpoint),
    tradeoffs: TRADEOFFS,
  };
}

export async function updateProviderSettings(
  purposeValue: unknown,
  body: unknown,
  ctx: AuthContext,
  overrides: Partial<ProviderSettingsDeps> = {},
): Promise<ProviderSettingView> {
  requireAdminUser(ctx);
  const purpose = parsePurpose(purposeValue);
  const request = parseUpdate(body);
  if (!PURPOSE_PROVIDERS[purpose].includes(request.provider)) {
    throw new ProviderSettingsValidationError();
  }
  const deps = resolveDeps(overrides);
  const credentials = credentialOptionsForOrg(ctx.orgId, deps.credentialRegistry);
  const endpoints = endpointOptionsForOrg(ctx.orgId, deps.loadEndpoints());
  const credential = selectCredential(request, purpose, credentials);
  const endpoint = selectEndpoint(request, purpose, endpoints);
  const stored = await deps.store.upsert(
    ctx.orgId,
    settingInput(purpose, request, credential, endpoint),
  );
  return settingView(stored, credentials, endpoints);
}
