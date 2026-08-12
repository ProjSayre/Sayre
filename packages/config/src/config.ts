/** The closed set of non-secret settings consumed by checked-in Node code. */
export const CONFIG_NAMES = [
  'NODE_ENV',
  'CI',
  'CORE_PORT',
  'DEV_ORG_ID',
  'DEV_USER_ID',
  'REDIS_HOST',
  'REDIS_PORT',
  'MESSAGING_INTEGRATION_REQUIRED',
  'SMOKE_BASE',
  'SMOKE_SHOTS',
  'RLS_TEST_DB_NAME',
  'RLS_TESTER_DB_NAME',
  'TENANT_ISOLATION_TESTER_DB_NAME',
  'CH01_TEST_DB_NAME',
  'AWS_REGION',
  'SQS_ENDPOINT_URL',
  'SQS_INGESTION_QUEUE',
  'PUPPETEER_EXECUTABLE_PATH',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_ID',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_API_BASE_URL',
  'GITHUB_WEB_BASE_URL',
  'GITHUB_POST_INSTALL_REDIRECT_URL',
  'GITHUB_LOGIN_COMPLETE_REDIRECT_URL',
  'GITHUB_LOGIN_CALLBACK_URL',
  'GATEWAY_PORT',
  'NEXT_PUBLIC_GATEWAY_WS_URL',
  'SQS_GRAPH_UPDATED_REALTIME_QUEUE',
  'GATEWAY_REDIS_CHANNEL',
  'CORE_INTERNAL_BASE_URL',
  'JIRA_BASE_URL',
  'JIRA_OAUTH_AUTHORIZE_URL',
  'JIRA_OAUTH_TOKEN_URL',
  'JIRA_OAUTH_API_BASE_URL',
  'JIRA_OAUTH_SCOPES',
  'JIRA_OAUTH_CLIENT_ID',
  'JIRA_OAUTH_CALLBACK_URL',
  'JIRA_POST_CONNECT_REDIRECT_URL',
  'LINEAR_API_URL',
  'NEO4J_URI',
  'NEO4J_USER',
  'MODEL_PROVIDER_ENDPOINT_CATALOG',
  'ONBOARDING_SANDBOX_RUNTIME',
  'ONBOARDING_SANDBOX_IMAGE',
  'ONBOARDING_SANDBOX_TIMEOUT_MS',
  'ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES',
  'ONBOARDING_SANDBOX_INTEGRATION_IMAGE',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'MCP_TOKEN_PEPPER_VERSION',
  'MCP_ALLOWED_ORIGINS',
  'JIRA_POLL_INTERVAL_MS',
  'REDIS_TLS',
] as const;

export type ConfigName = (typeof CONFIG_NAMES)[number];

/** Safe, non-secret defaults that preserve the existing local-development behavior. */
const DEFAULTS: Readonly<Partial<Record<ConfigName, string>>> = {
  CI: 'false',
  CORE_PORT: '4000',
  DEV_ORG_ID: 'org_dev_local',
  DEV_USER_ID: 'user_dev_local',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  // Off by default (matches local dev / docker-compose's plain redis:7.4-alpine,
  // which has no TLS listener). Managed Redis providers outside the VPC (e.g.
  // Redis Cloud) should set this to "true" -- see bullmq.ts's createRedisConnection.
  REDIS_TLS: 'false',
  MESSAGING_INTEGRATION_REQUIRED: 'false',
  SMOKE_BASE: 'http://localhost:5173',
  SMOKE_SHOTS: 'scripts/.shots',
  RLS_TEST_DB_NAME: 'w005_rls_test',
  RLS_TESTER_DB_NAME: 'w005_rls_tester',
  TENANT_ISOLATION_TESTER_DB_NAME: 'w206_tenant_isolation_tester',
  CH01_TEST_DB_NAME: 'ch01_ephemeral_rls_test',
  AWS_REGION: 'us-east-1',
  SQS_INGESTION_QUEUE: 'ingestion.fifo',
  // SQS_ENDPOINT_URL intentionally has NO default: unset means "use real AWS".
  // The SQS module treats a ConfigError here as "no override endpoint", mirroring
  // the Python client (services/workers/messaging/sqs_client.py).
  GITHUB_API_BASE_URL: 'https://api.github.com',
  GITHUB_WEB_BASE_URL: 'https://github.com',
  GITHUB_POST_INSTALL_REDIRECT_URL: '/settings/integrations',
  // AUTH-01: web completion page that reads the fragment-delivered session
  // token (see apps/web/app/auth/complete/page.tsx).
  GITHUB_LOGIN_COMPLETE_REDIRECT_URL: '/auth/complete',
  // GITHUB_APP_SLUG / GITHUB_APP_ID / GITHUB_APP_CLIENT_ID / GITHUB_LOGIN_CALLBACK_URL
  // intentionally have NO default: they identify the specific per-environment
  // GitHub App and its registered callback (see infra/github-app/README.md) and
  // must be provisioned explicitly. GITHUB_LOGIN_CALLBACK_URL must exactly match
  // one of the App's registered callback URLs -- when a GitHub App has more than
  // one callback URL configured (e.g. the install flow's alongside the login
  // flow's), GitHub does not infer which one to use; the `redirect_uri` param
  // sent in the authorize URL is what disambiguates it.
  GATEWAY_PORT: '4100',
  SQS_GRAPH_UPDATED_REALTIME_QUEUE: 'graph-updated-realtime',
  GATEWAY_REDIS_CHANNEL: 'sayre:graph.updated',
  CORE_INTERNAL_BASE_URL: 'http://localhost:4000',
  // W3-10 Jira Cloud OAuth 3LO connect flow (per-org credentials). These are
  // Atlassian's fixed, documented endpoints -- non-secret, App-registration-
  // independent. JIRA_OAUTH_CLIENT_ID / JIRA_OAUTH_CALLBACK_URL intentionally
  // have NO default: they identify the specific per-environment Atlassian App
  // and its registered callback and must be provisioned explicitly (same
  // posture as GITHUB_APP_CLIENT_ID / GITHUB_LOGIN_CALLBACK_URL above).
  JIRA_OAUTH_AUTHORIZE_URL: 'https://auth.atlassian.com/authorize',
  JIRA_OAUTH_TOKEN_URL: 'https://auth.atlassian.com/oauth/token',
  JIRA_OAUTH_API_BASE_URL: 'https://api.atlassian.com',
  // offline_access is required to receive a refresh token; write:jira-work is
  // required for W3-05's outbound updateTicket; read:me powers the
  // connecting-user record captured at connect time.
  JIRA_OAUTH_SCOPES: 'read:jira-work write:jira-work read:me offline_access',
  JIRA_POST_CONNECT_REDIRECT_URL: '/settings/integrations',
  LINEAR_API_URL: 'https://api.linear.app/graphql',
  NEO4J_URI: 'bolt://localhost:7687',
  NEO4J_USER: 'neo4j',
  // Non-secret W3-09 allowlist. Each production endpoint must be explicitly
  // provisioned for an org; an empty catalog makes self-hosted selection fail closed.
  MODEL_PROVIDER_ENDPOINT_CATALOG: '[]',
  ONBOARDING_SANDBOX_RUNTIME: 'docker',
  // ONBOARDING_SANDBOX_IMAGE deliberately has no default. Operators must pin
  // an approved image by sha256 digest before executable onboarding is enabled.
  ONBOARDING_SANDBOX_TIMEOUT_MS: '30000',
  ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES: '32768',
  // W4-06 MCP defaults. The pepper itself remains in the secret catalog.
  MCP_TOKEN_PEPPER_VERSION: '1',
  // Empty JSON array rejects browser Origins while allowing non-browser MCP
  // clients that omit Origin. Production may provision explicit HTTPS origins.
  MCP_ALLOWED_ORIGINS: '[]',
  // W3-10 Jira poll loop (pollWorker.ts) — matches its prior process.env
  // fallback of 60_000ms.
  JIRA_POLL_INTERVAL_MS: '60000',
};

const supportedNames = new Set<string>(CONFIG_NAMES);
const overrides = new Map<ConfigName, string | undefined>();

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireTestEnvironment(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new ConfigError('Configuration test helpers are unavailable outside the test environment.');
  }
}

function assertConfigName(name: string): asserts name is ConfigName {
  if (!supportedNames.has(name)) {
    throw new ConfigError('Unsupported configuration name.');
  }
}

function validateValue(name: ConfigName, value: string | undefined): string {
  if (value === undefined) {
    const fallback = DEFAULTS[name];
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`Configuration ${name} is missing.`);
  }
  if (value.trim().length === 0) {
    throw new ConfigError(`Configuration ${name} is empty.`);
  }

  if (name === 'CI' || name === 'MESSAGING_INTEGRATION_REQUIRED' || name === 'REDIS_TLS') {
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      throw new ConfigError(`Configuration ${name} must be "true" or "false".`);
    }
    return normalized;
  }

  return value;
}

export function getConfig(name: ConfigName): string {
  const value = getOptionalConfig(name);
  if (value === undefined) {
    throw new ConfigError(`Configuration ${name} is missing.`);
  }
  return value;
}

export function getOptionalConfig(name: ConfigName): string | undefined {
  assertConfigName(name as string);
  const value = overrides.has(name) ? overrides.get(name) : process.env[name];
  if (value === undefined && DEFAULTS[name] === undefined) return undefined;
  return validateValue(name, value);
}

export function setConfigOverrideForTests(
  name: ConfigName,
  value: string | undefined,
): void {
  requireTestEnvironment();
  assertConfigName(name as string);
  overrides.set(name, value);
}

export function resetConfigForTests(): void {
  requireTestEnvironment();
  overrides.clear();
}
