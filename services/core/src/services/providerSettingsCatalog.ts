import { isIP } from 'node:net';
import { getConfig, type SecretRef } from '@sayre/config';
import type {
  ProviderCredentialOption,
  ProviderEndpointOption,
  ProviderKind,
  ProviderPurpose,
} from '@sayre/shared-types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPTION_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CATALOG_CHARS = 65_536;
const MAX_CATALOG_ENTRIES = 64;
const MAX_ENDPOINT_CHARS = 2_048;
const MAX_ENDPOINT_PATH_CHARS = 512;

const PURPOSES: readonly ProviderPurpose[] = ['generation', 'embedding'];
const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.internal.',
  'instance-data.ec2.internal',
  'instance-data.ec2.internal.',
]);

export class ProviderSettingsCatalogError extends Error {
  constructor() {
    // Intentionally generic: configuration errors must not echo endpoint/ref contents.
    super('Provider settings catalog is invalid.');
    this.name = 'ProviderSettingsCatalogError';
  }
}

export interface CredentialRegistryEntry extends ProviderCredentialOption {
  reference: SecretRef;
  /** Omitted means deployment-wide; otherwise the exact authorized org UUIDs. */
  orgIds?: readonly string[];
}

export interface EndpointCatalogEntry extends ProviderEndpointOption {
  url: string;
  orgIds: readonly string[];
  allowPrivate: boolean;
  allowInsecureHttp: boolean;
}

/**
 * Closed W0-07 references. These are references only; this module never resolves
 * or returns their secret values.
 */
export const DEFAULT_CREDENTIAL_REGISTRY: readonly CredentialRegistryEntry[] = [
  {
    id: 'anthropic-default',
    label: 'Provisioned Anthropic credential',
    purpose: 'generation',
    providers: ['anthropic'],
    reference: 'env://ANTHROPIC_API_KEY',
  },
  {
    id: 'openai-generation-default',
    label: 'Provisioned OpenAI credential',
    purpose: 'generation',
    // A hosted-vendor credential must never be offered to an arbitrary
    // OpenAI-compatible endpoint. Endpoint-specific references may be added
    // to this server-controlled registry when separately provisioned.
    providers: ['openai'],
    reference: 'env://OPENAI_API_KEY',
  },
  {
    id: 'openai-embedding-default',
    label: 'Provisioned OpenAI embedding credential',
    purpose: 'embedding',
    providers: ['openai'],
    reference: 'env://OPENAI_API_KEY',
  },
] as const;

function invalidCatalog(): never {
  throw new ProviderSettingsCatalogError();
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalidCatalog();
  }
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string') invalidCatalog();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > max ||
    [...normalized].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    invalidCatalog();
  }
  return normalized;
}

function parsePurposeList(value: unknown): ProviderPurpose[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > PURPOSES.length) {
    invalidCatalog();
  }
  const parsed: ProviderPurpose[] = [];
  for (const item of value) {
    if (item !== 'generation' && item !== 'embedding') invalidCatalog();
    if (parsed.includes(item)) invalidCatalog();
    parsed.push(item);
  }
  return parsed;
}

function parseOrgIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) invalidCatalog();
  const orgIds: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !UUID_RE.test(item) || orgIds.includes(item)) {
      invalidCatalog();
    }
    orgIds.push(item);
  }
  return orgIds;
}

function ipv4Parts(address: string): [number, number, number, number] | null {
  const parts = address.split('.').map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? (parts as [number, number, number, number])
    : null;
}

function classifyIpv4(address: string): 'blocked' | 'private' | 'public' {
  const parts = ipv4Parts(address);
  if (!parts) return 'blocked';
  const [a, b, c, d] = parts;

  if (
    a === 0 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    a >= 224 ||
    (a === 100 && b === 100 && c === 100 && d === 200)
  ) {
    return 'blocked';
  }
  if (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  ) {
    return 'private';
  }
  return 'public';
}

function expandIpv6(address: string): number[] | null {
  const lower = address.toLowerCase();
  if (lower.includes('.')) return null;
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < (halves.length === 2 ? 1 : 0)) return null;
  const raw = [...left, ...Array.from({ length: omitted }, () => '0'), ...right];
  if (raw.length !== 8) return null;
  const groups = raw.map((part) => (/^[0-9a-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : -1));
  return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

function classifyIpv6(address: string): 'blocked' | 'private' | 'public' {
  const groups = expandIpv6(address);
  if (!groups) return 'blocked';
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  const linkLocal = (groups[0] & 0xffc0) === 0xfe80;
  const multicast = (groups[0] & 0xff00) === 0xff00;
  const metadata =
    groups[0] === 0xfd00 &&
    groups[1] === 0x0ec2 &&
    groups.slice(2, 7).every((group) => group === 0) &&
    groups[7] === 0x0254;
  const mappedIpv4 =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;

  if (mappedIpv4) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
    return classifyIpv4(ipv4);
  }
  if (allZero || loopback || linkLocal || multicast || metadata) return 'blocked';
  return (groups[0] & 0xfe00) === 0xfc00 ? 'private' : 'public';
}

function normalizedHostname(url: URL): string {
  const value = url.hostname.toLowerCase().replace(/\.$/, '');
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function networkClass(hostname: string): 'blocked' | 'private' | 'public' {
  if (METADATA_HOSTS.has(hostname) || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return 'blocked';
  }
  const version = isIP(hostname);
  if (version === 4) return classifyIpv4(hostname);
  if (version === 6) return classifyIpv6(hostname);
  if (
    !hostname.includes('.') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    return 'private';
  }
  return 'public';
}

export function validateCatalogEndpoint(
  rawUrl: unknown,
  policy: { allowPrivate: boolean; allowInsecureHttp: boolean },
): string {
  const input = boundedString(rawUrl, MAX_ENDPOINT_CHARS);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return invalidCatalog();
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.length > MAX_ENDPOINT_PATH_CHARS
  ) {
    return invalidCatalog();
  }
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) invalidCatalog();

  const hostname = normalizedHostname(url);
  if (!hostname || hostname.includes('%')) invalidCatalog();
  const classification = networkClass(hostname);
  if (classification === 'blocked') invalidCatalog();
  if (classification === 'private' && !policy.allowPrivate) invalidCatalog();

  // URL canonicalization collapses numeric/hex/octal IPv4 spellings before the
  // network-class checks above and produces a stable exact-match persistence value.
  return url.toString();
}

export function parseEndpointCatalog(raw: string): EndpointCatalogEntry[] {
  if (raw.length > MAX_CATALOG_CHARS) invalidCatalog();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalidCatalog();
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_CATALOG_ENTRIES) invalidCatalog();

  const entries: EndpointCatalogEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) invalidCatalog();
    const record = item as Record<string, unknown>;
    exactKeys(
      record,
      ['id', 'label', 'url', 'orgIds', 'purposes'],
      ['allowPrivate', 'allowInsecureHttp'],
    );
    const id = boundedString(record.id, 64);
    if (!OPTION_ID_RE.test(id) || entries.some((entry) => entry.id === id)) invalidCatalog();
    const label = boundedString(record.label, 80);
    const orgIds = parseOrgIds(record.orgIds);
    const purposes = parsePurposeList(record.purposes);
    const allowPrivate = record.allowPrivate === true;
    const allowInsecureHttp = record.allowInsecureHttp === true;
    if (
      (record.allowPrivate !== undefined && typeof record.allowPrivate !== 'boolean') ||
      (record.allowInsecureHttp !== undefined &&
        typeof record.allowInsecureHttp !== 'boolean')
    ) {
      invalidCatalog();
    }
    const url = validateCatalogEndpoint(record.url, { allowPrivate, allowInsecureHttp });
    for (const purpose of purposes) {
      entries.push({
        id,
        label,
        purpose,
        providers: ['openai_compatible'],
        url,
        orgIds,
        allowPrivate,
        allowInsecureHttp,
      });
    }
  }
  return entries;
}

export function loadEndpointCatalog(): EndpointCatalogEntry[] {
  return parseEndpointCatalog(getConfig('MODEL_PROVIDER_ENDPOINT_CATALOG'));
}

export function credentialOptionsForOrg(
  orgId: string,
  registry: readonly CredentialRegistryEntry[],
): CredentialRegistryEntry[] {
  return registry.filter((entry) => !entry.orgIds || entry.orgIds.includes(orgId));
}

export function endpointOptionsForOrg(
  orgId: string,
  catalog: readonly EndpointCatalogEntry[],
): EndpointCatalogEntry[] {
  return catalog.filter((entry) => entry.orgIds.includes(orgId));
}

export function supportsProvider(
  entry: { purpose: ProviderPurpose; providers: readonly ProviderKind[] },
  purpose: ProviderPurpose,
  provider: ProviderKind,
): boolean {
  return entry.purpose === purpose && entry.providers.includes(provider);
}
