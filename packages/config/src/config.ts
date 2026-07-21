/** The closed set of non-secret settings consumed by checked-in Node code. */
export const CONFIG_NAMES = [
  'NODE_ENV',
  'CORE_PORT',
  'DEV_ORG_ID',
  'REDIS_HOST',
  'REDIS_PORT',
  'MESSAGING_INTEGRATION_REQUIRED',
  'SMOKE_BASE',
  'SMOKE_SHOTS',
  'RLS_TEST_DB_NAME',
  'RLS_TESTER_DB_NAME',
] as const;

export type ConfigName = (typeof CONFIG_NAMES)[number];

/** Safe, non-secret defaults that preserve the existing local-development behavior. */
const DEFAULTS: Readonly<Partial<Record<ConfigName, string>>> = {
  CORE_PORT: '4000',
  DEV_ORG_ID: 'org_dev_local',
  REDIS_HOST: 'localhost',
  REDIS_PORT: '6379',
  MESSAGING_INTEGRATION_REQUIRED: 'false',
  SMOKE_BASE: 'http://localhost:5173',
  SMOKE_SHOTS: 'scripts/.shots',
  RLS_TEST_DB_NAME: 'w005_rls_test',
  RLS_TESTER_DB_NAME: 'w005_rls_tester',
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

  if (name === 'MESSAGING_INTEGRATION_REQUIRED') {
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'true' && normalized !== 'false') {
      throw new ConfigError(
        'Configuration MESSAGING_INTEGRATION_REQUIRED must be "true" or "false".',
      );
    }
    return normalized;
  }

  return value;
}

export function getConfig(name: ConfigName): string {
  assertConfigName(name as string);
  const value = overrides.has(name) ? overrides.get(name) : process.env[name];
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
