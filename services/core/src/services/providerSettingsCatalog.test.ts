import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CREDENTIAL_REGISTRY,
  ProviderSettingsCatalogError,
  credentialOptionsForOrg,
  endpointOptionsForOrg,
  parseEndpointCatalog,
  validateCatalogEndpoint,
  type CredentialRegistryEntry,
} from './providerSettingsCatalog';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';

function entry(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([
    {
      id: 'acme-vllm',
      label: 'Acme private vLLM',
      url: 'https://models.acme.example/v1',
      orgIds: [ORG_A],
      purposes: ['generation', 'embedding'],
      ...overrides,
    },
  ]);
}

describe('provider endpoint catalog', () => {
  it('expands one exact operator-approved endpoint into purpose-scoped choices', () => {
    const parsed = parseEndpointCatalog(entry());

    expect(parsed).toHaveLength(2);
    expect(parsed.map((item) => item.purpose)).toEqual(['generation', 'embedding']);
    expect(parsed.every((item) => item.providers[0] === 'openai_compatible')).toBe(true);
    expect(endpointOptionsForOrg(ORG_A, parsed)).toHaveLength(2);
    expect(endpointOptionsForOrg(ORG_B, parsed)).toEqual([]);
  });

  it('allows an exact private HTTP endpoint only with both explicit operator opt-ins', () => {
    const [parsed] = parseEndpointCatalog(
      entry({
        url: 'http://10.20.30.40:8000/v1',
        purposes: ['generation'],
        allowPrivate: true,
        allowInsecureHttp: true,
      }),
    );

    expect(parsed.url).toBe('http://10.20.30.40:8000/v1');
    expect(parsed.allowPrivate).toBe(true);
    expect(parsed.allowInsecureHttp).toBe(true);
  });

  it.each([
    { url: 'http://10.20.30.40:8000/v1', allowInsecureHttp: true },
    { url: 'http://model.internal:8000/v1', allowInsecureHttp: true },
    { url: 'http://models.acme.example/v1', allowPrivate: false },
  ])('rejects private or insecure endpoints without every required opt-in: %j', (value) => {
    expect(() => parseEndpointCatalog(entry(value))).toThrow(
      ProviderSettingsCatalogError,
    );
  });

  it.each([
    'http://127.0.0.1:11434/v1',
    'http://127.1:11434/v1',
    'http://0177.0.0.1:11434/v1',
    'http://2130706433:11434/v1',
    'http://0x7f000001:11434/v1',
    'http://[::1]:11434/v1',
    'http://[::ffff:127.0.0.1]:11434/v1',
    'http://169.254.169.254/latest/meta-data',
    'http://100.100.100.200/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
    'http://metadata.google.internal./computeMetadata/v1',
    'http://instance-data.ec2.internal/latest',
    'http://[fd00:ec2::254]/latest',
    'http://localhost.:11434/v1',
    'http://0.0.0.0:8000/v1',
  ])('blocks loopback/link-local/cloud-metadata and alternate IP forms: %s', (url) => {
    expect(() =>
      validateCatalogEndpoint(url, {
        allowPrivate: true,
        allowInsecureHttp: true,
      }),
    ).toThrow(ProviderSettingsCatalogError);
  });

  it.each([
    'ftp://models.acme.example/v1',
    'https://user:password@models.acme.example/v1',
    'https://models.acme.example/v1?redirect=http://169.254.169.254',
    'https://models.acme.example/v1#fragment',
  ])('rejects URL forms that broaden or obscure the exact endpoint: %s', (url) => {
    expect(() =>
      validateCatalogEndpoint(url, {
        allowPrivate: false,
        allowInsecureHttp: false,
      }),
    ).toThrow(ProviderSettingsCatalogError);
  });

  it('rejects malformed, duplicate, and cross-shape catalog entries with a generic error', () => {
    expect(() => parseEndpointCatalog('not json')).toThrow(
      new ProviderSettingsCatalogError(),
    );
    expect(() =>
      parseEndpointCatalog(
        JSON.stringify([
          JSON.parse(entry())[0],
          JSON.parse(entry())[0],
        ]),
      ),
    ).toThrow(ProviderSettingsCatalogError);
    expect(() => parseEndpointCatalog(entry({ unexpected: 'field' }))).toThrow(
      ProviderSettingsCatalogError,
    );
    expect(() => parseEndpointCatalog(entry({ orgIds: ['not-a-uuid'] }))).toThrow(
      ProviderSettingsCatalogError,
    );
  });

  it('performs no DNS, HTTP, redirect, response-body, or ambient-proxy operation', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    try {
      parseEndpointCatalog(entry());
      expect(fetchSpy).not.toHaveBeenCalled();
      const source = readFileSync(
        new URL('./providerSettingsCatalog.ts', import.meta.url),
        'utf8',
      );
      expect(source).not.toMatch(/node:dns|node:http|node:https/);
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/ProxyAgent|HTTP_PROXY|HTTPS_PROXY/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('credential-reference registry filtering', () => {
  it('never authorizes the hosted OpenAI vendor key for self-hosted endpoints', () => {
    const openAiEntries = DEFAULT_CREDENTIAL_REGISTRY.filter(
      (entry) => entry.reference === 'env://OPENAI_API_KEY',
    );

    expect(openAiEntries).toHaveLength(2);
    expect(openAiEntries.every((entry) => entry.providers.length === 1)).toBe(
      true,
    );
    expect(
      openAiEntries.every((entry) => entry.providers[0] === 'openai'),
    ).toBe(true);
    expect(
      openAiEntries.some((entry) =>
        entry.providers.includes('openai_compatible'),
      ),
    ).toBe(false);
  });

  it('filters explicit org authorization without exposing or resolving a value', () => {
    const registry: CredentialRegistryEntry[] = [
      {
        id: 'org-a-only',
        label: 'Org A credential',
        purpose: 'generation',
        providers: ['anthropic'],
        reference: 'env://ANTHROPIC_API_KEY',
        orgIds: [ORG_A],
      },
    ];

    expect(credentialOptionsForOrg(ORG_A, registry)).toEqual(registry);
    expect(credentialOptionsForOrg(ORG_B, registry)).toEqual([]);
  });
});
