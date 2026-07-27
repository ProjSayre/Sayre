export type SecretRef = `env://${string}`;
type SecretBackend = (ref: SecretRef) => Promise<string>;

/**
 * Closed production catalog of secret names understood by Sayre. Keep this
 * list identical to the Python worker catalog and SECRETS.md.
 */
export const SECRET_NAMES = [
  'DATABASE_ADMIN_URL',
  'DATABASE_RUNTIME_URL',
  'POSTGRES_PASSWORD',
  'JWT_SIGNING_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
  'JIRA_OAUTH_CLIENT_SECRET',
  // W3-10: per-org Jira access/refresh tokens now live encrypted in
  // `jira_connections` (Postgres), resolved through `getOrgSecret` --
  // `JIRA_ACCESS_TOKEN`/`JIRA_REFRESH_TOKEN` are REMOVED from this catalog
  // (they were the exact "one Jira workspace per instance" defect the ticket
  // closes; see docs/PRD_Tickets.md W3-10 and docs/post-mvp-backlog.md).
  // `JIRA_TOKEN_ENC_KEY` is the new application-level encryption key for
  // those stored tokens (AES-256-GCM, jiraTokenCipher.ts).
  'JIRA_TOKEN_ENC_KEY',
  'LINEAR_OAUTH_CLIENT_SECRET',
  'LINEAR_ACCESS_TOKEN',
  'LINEAR_REFRESH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'MCP_TOKEN_PEPPER',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'REDIS_PASSWORD',
  'NEO4J_PASSWORD',
  'NEO4J_AUTH',
] as const;

export type SecretName = (typeof SECRET_NAMES)[number];

const SECRET_NAME_SET: ReadonlySet<string> = new Set(SECRET_NAMES);

const ENV_REF = /^env:\/\/([A-Z_][A-Z0-9_]*)$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

export class InvalidSecretReferenceError extends Error {
  constructor() {
    super('Invalid secret reference.');
    this.name = 'InvalidSecretReferenceError';
  }
}

export class UnsupportedSecretSchemeError extends Error {
  constructor(scheme: string) {
    super(`Unsupported secret reference scheme: ${scheme}.`);
    this.name = 'UnsupportedSecretSchemeError';
  }
}

export class UnauthorizedSecretReferenceError extends Error {
  constructor() {
    super('Secret reference is not authorized.');
    this.name = 'UnauthorizedSecretReferenceError';
  }
}

export class SecretNotFoundError extends Error {
  constructor(name: string) {
    super(`Secret ${name} is missing.`);
    this.name = 'SecretNotFoundError';
  }
}

export class EmptySecretError extends Error {
  constructor(name: string) {
    super(`Secret ${name} is empty.`);
    this.name = 'EmptySecretError';
  }
}

export class SecretResolutionError extends Error {
  constructor(name: string) {
    super(`Secret ${name} could not be resolved.`);
    this.name = 'SecretResolutionError';
  }
}

function parseReference(ref: string): { ref: SecretRef; name: string } {
  const match = ENV_REF.exec(ref);
  if (match) return { ref: ref as SecretRef, name: match[1] };

  const scheme = SCHEME.exec(ref)?.[1];
  if (scheme !== undefined && scheme !== 'env') {
    throw new UnsupportedSecretSchemeError(scheme);
  }
  throw new InvalidSecretReferenceError();
}

const environmentBackend: SecretBackend = async (ref) => {
  const { name } = parseReference(ref);
  const value = process.env[name];
  if (value === undefined) {
    throw new SecretNotFoundError(name);
  }
  if (value.trim().length === 0) throw new EmptySecretError(name);
  return value;
};

let backend: SecretBackend = environmentBackend;
const cache = new Map<SecretRef, Promise<string>>();

function requireTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new SecretResolutionError('test helper');
  }
}

async function resolveSecret(ref: SecretRef, name: string): Promise<string> {
  try {
    const value = await backend(ref);
    if (value.trim().length === 0) throw new EmptySecretError(name);
    return value;
  } catch (error) {
    if (error instanceof SecretNotFoundError) throw new SecretNotFoundError(name);
    if (error instanceof EmptySecretError) throw new EmptySecretError(name);
    throw new SecretResolutionError(name);
  }
}

export async function getSecret(ref: SecretRef | string): Promise<string> {
  const parsed = parseReference(ref);
  if (!SECRET_NAME_SET.has(parsed.name)) {
    throw new UnauthorizedSecretReferenceError();
  }
  const existing = cache.get(parsed.ref);
  if (existing) return existing;

  const pending = resolveSecret(parsed.ref, parsed.name);
  cache.set(parsed.ref, pending);
  pending.catch(() => {
    if (cache.get(parsed.ref) === pending) cache.delete(parsed.ref);
  });
  return pending;
}

export function setSecretBackendForTests(nextBackend: SecretBackend): void {
  requireTestEnvironment();
  backend = nextBackend;
  cache.clear();
}

export function resetSecretsForTests(): void {
  requireTestEnvironment();
  backend = environmentBackend;
  cache.clear();
}
