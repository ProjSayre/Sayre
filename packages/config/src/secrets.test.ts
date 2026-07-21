import { format, inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EmptySecretError,
  InvalidSecretReferenceError,
  SecretNotFoundError,
  SecretResolutionError,
  UnauthorizedSecretReferenceError,
  UnsupportedSecretSchemeError,
  getSecret,
  resetSecretsForTests,
  setSecretBackendForTests,
} from './secrets';

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  resetSecretsForTests();
});

afterEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  resetSecretsForTests();
  vi.unstubAllEnvs();
});

describe('getSecret', () => {
  it('resolves a valid env reference and returns the original value unchanged', async () => {
    vi.stubEnv('DATABASE_RUNTIME_URL', '  keep surrounding space  ');
    await expect(getSecret('env://DATABASE_RUNTIME_URL')).resolves.toBe(
      '  keep surrounding space  ',
    );
  });

  it.each([
    'DATABASE_ADMIN_URL',
    'env://',
    'env:///DATABASE_ADMIN_URL',
    'env://database_url',
    'env://BAD-NAME',
    'env://BAD.NAME',
    'env://BAD NAME',
    'env://DATABASE_ADMIN_URL?x=1',
    'env://DATABASE_ADMIN_URL#x',
    'env://DATABASE_ADMIN_URL/path',
  ])('rejects malformed reference %s before calling the backend', async (ref) => {
    const backend = vi.fn(async () => 'unused');
    setSecretBackendForTests(backend);
    await expect(getSecret(ref)).rejects.toBeInstanceOf(InvalidSecretReferenceError);
    expect(backend).not.toHaveBeenCalled();
  });

  it.each(['vault://DB', 'aws-sm://DB', 'ENV://DB'])(
    'rejects unsupported scheme %s without echoing the reference',
    async (ref) => {
      try {
        await getSecret(ref);
        throw new Error('expected rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(UnsupportedSecretSchemeError);
        expect(String(error)).not.toContain(ref);
      }
    },
  );

  it('rejects a well-formed unlisted reference before backend or cache lookup', async () => {
    const backend = vi.fn(async () => 'must-not-resolve');
    setSecretBackendForTests(backend);

    await expect(getSecret('env://WELL_FORMED_BUT_UNLISTED')).rejects.toBeInstanceOf(
      UnauthorizedSecretReferenceError,
    );
    expect(backend).not.toHaveBeenCalled();
  });

  it('distinguishes genuinely missing from explicitly empty environment values', async () => {
    vi.stubEnv('GITHUB_WEBHOOK_SECRET', '   ');
    await expect(getSecret('env://JWT_SIGNING_KEY')).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(getSecret('env://GITHUB_WEBHOOK_SECRET')).rejects.toBeInstanceOf(
      EmptySecretError,
    );
  });

  it('rejects an explicitly empty injected backend result', async () => {
    setSecretBackendForTests(async () => '   ');
    await expect(getSecret('env://REDIS_PASSWORD')).rejects.toBeInstanceOf(EmptySecretError);
  });

  it('deduplicates concurrent resolution and caches success', async () => {
    let calls = 0;
    setSecretBackendForTests(async () => {
      calls += 1;
      await Promise.resolve();
      return 'resolved';
    });
    const [first, second] = await Promise.all([
      getSecret('env://REDIS_PASSWORD'),
      getSecret('env://REDIS_PASSWORD'),
    ]);
    expect([first, second]).toEqual(['resolved', 'resolved']);
    await expect(getSecret('env://REDIS_PASSWORD')).resolves.toBe('resolved');
    expect(calls).toBe(1);
  });

  it('evicts failed resolutions so a corrected backend can retry', async () => {
    let calls = 0;
    setSecretBackendForTests(async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary failure');
      return 'recovered';
    });
    await expect(getSecret('env://NEO4J_PASSWORD')).rejects.toBeInstanceOf(SecretResolutionError);
    await expect(getSecret('env://NEO4J_PASSWORD')).resolves.toBe('recovered');
    expect(calls).toBe(2);
  });

  it('redacts backend errors and sentinel secret values', async () => {
    const sentinel = 'sentinel-super-secret-value';
    setSecretBackendForTests(async () => {
      throw new Error(sentinel);
    });
    try {
      await getSecret('env://ANTHROPIC_API_KEY');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SecretResolutionError);
      expect(String(error)).not.toContain(sentinel);
    }
  });

  it.each([
    ['InvalidSecretReferenceError', () => new InvalidSecretReferenceError()],
    ['UnsupportedSecretSchemeError', () => new UnsupportedSecretSchemeError('backend')],
    ['UnauthorizedSecretReferenceError', () => new UnauthorizedSecretReferenceError()],
    ['SecretNotFoundError', () => new SecretNotFoundError('backend')],
    ['EmptySecretError', () => new EmptySecretError('backend')],
    ['SecretResolutionError', () => new SecretResolutionError('backend')],
  ])('sanitizes backend-supplied exported error type %s', async (_name, makeError) => {
    const sentinel = 'SENTINEL_BACKEND_EXCEPTION_VALUE';
    const backendError = makeError();
    backendError.message = sentinel;
    backendError.stack = `${backendError.name}: ${sentinel}\n    at untrusted-backend`;
    setSecretBackendForTests(async () => {
      throw backendError;
    });

    let visibleError: unknown;
    try {
      await getSecret('env://ANTHROPIC_API_KEY');
      throw new Error('expected rejection');
    } catch (error) {
      visibleError = error;
    }

    expect(visibleError).toBeInstanceOf(Error);
    const safeError = visibleError as Error;
    if (backendError instanceof SecretNotFoundError) {
      expect(safeError).toBeInstanceOf(SecretNotFoundError);
    } else if (backendError instanceof EmptySecretError) {
      expect(safeError).toBeInstanceOf(EmptySecretError);
    } else {
      expect(safeError).toBeInstanceOf(SecretResolutionError);
    }
    for (const output of [
      safeError.message,
      String(safeError),
      inspect(safeError),
      safeError.stack ?? '',
      format(safeError),
      JSON.stringify(safeError),
    ]) {
      expect(output).not.toContain(sentinel);
    }
  });

  it('does not expose mutating test helpers outside NODE_ENV=test', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => setSecretBackendForTests(async () => 'x')).toThrow(SecretResolutionError);
    expect(() => resetSecretsForTests()).toThrow(SecretResolutionError);
  });
});
