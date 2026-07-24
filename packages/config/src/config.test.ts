import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigError,
  getConfig,
  getOptionalConfig,
  resetConfigForTests,
  setConfigOverrideForTests,
} from './config';

afterEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  resetConfigForTests();
  vi.unstubAllEnvs();
});

describe('getConfig', () => {
  it('uses documented safe defaults and returns non-empty overrides unchanged', () => {
    expect(getConfig('CORE_PORT')).toBe('4000');
    expect(getConfig('LINEAR_API_URL')).toBe('https://api.linear.app/graphql');
    expect(getConfig('NEO4J_URI')).toBe('bolt://localhost:7687');
    expect(getConfig('NEO4J_USER')).toBe('neo4j');
    setConfigOverrideForTests('CORE_PORT', ' 4100 ');
    expect(getConfig('CORE_PORT')).toBe(' 4100 ');
  });

  it('requires the tenant-specific Jira base URL to be provisioned', () => {
    setConfigOverrideForTests('JIRA_BASE_URL', undefined);
    expect(() => getConfig('JIRA_BASE_URL')).toThrow(/JIRA_BASE_URL.*missing/);
  });

  it('defaults broker-required mode off and validates boolean overrides centrally', () => {
    expect(getConfig('CI')).toBe('false');
    expect(getConfig('MESSAGING_INTEGRATION_REQUIRED')).toBe('false');

    setConfigOverrideForTests('CI', ' TRUE ');
    expect(getConfig('CI')).toBe('true');

    setConfigOverrideForTests('MESSAGING_INTEGRATION_REQUIRED', ' TRUE ');
    expect(getConfig('MESSAGING_INTEGRATION_REQUIRED')).toBe('true');

    setConfigOverrideForTests('MESSAGING_INTEGRATION_REQUIRED', 'sometimes');
    expect(() => getConfig('MESSAGING_INTEGRATION_REQUIRED')).toThrow(
      /MESSAGING_INTEGRATION_REQUIRED.*true.*false/,
    );
  });

  it('allows callers to distinguish an optional unset setting from an invalid value', () => {
    setConfigOverrideForTests('NODE_ENV', undefined);
    expect(getOptionalConfig('NODE_ENV')).toBeUndefined();
    expect(() => getConfig('NODE_ENV')).toThrow(/NODE_ENV.*missing/);

    setConfigOverrideForTests('NODE_ENV', '   ');
    expect(() => getOptionalConfig('NODE_ENV')).toThrow(/NODE_ENV.*empty/);
  });

  it('treats an explicit undefined override as missing instead of reading the environment', () => {
    vi.stubEnv('CORE_PORT', '9999');
    setConfigOverrideForTests('CORE_PORT', undefined);
    expect(getConfig('CORE_PORT')).toBe('4000');
  });

  it('rejects empty values and runtime attempts to request arbitrary names', () => {
    setConfigOverrideForTests('REDIS_HOST', '   ');
    expect(() => getConfig('REDIS_HOST')).toThrow(/REDIS_HOST.*empty/);
    expect(() => getConfig('NOT_SUPPORTED' as never)).toThrow(/Unsupported configuration name/);
  });

  it('does not expose mutating test helpers outside NODE_ENV=test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => setConfigOverrideForTests('CORE_PORT', '5000')).toThrow(ConfigError);
    expect(() => resetConfigForTests()).toThrow(ConfigError);
  });
});
