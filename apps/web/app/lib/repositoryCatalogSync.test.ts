// Leading-red tests (W7-01, EC-21) for parseRepositoryCatalogResponse's handling of the new
// `sync` key: an ABSENT `sync` parses as idle (deploy skew), a PRESENT-but-malformed `sync`
// throws RepositoryCatalogResponseError, and unknown extra keys inside `sync` are ignored. The
// current parser has no notion of `sync` at all, so it never throws on a malformed one and never
// produces the expected idle default either — every assertion below fails today (RED-CORRECT).

import { describe, expect, it } from 'vitest';
import { parseRepositoryCatalogResponse, RepositoryCatalogResponseError } from './repositoryCatalog';

const BASE = { authorization: 'server-filtered' as const, repositories: [] as unknown[] };

describe('parseRepositoryCatalogResponse — EC-21 (sync key: absent/malformed/extra)', () => {
  // @spec EC-21
  it('an absent `sync` key parses as { status: "idle", updatedAt: null, counts null }', () => {
    const result = parseRepositoryCatalogResponse(BASE);
    expect(result.sync).toEqual({
      status: 'idle',
      updatedAt: null,
      discoveredRepositories: null,
      registeredRepositories: null,
    });
  });

  // @spec EC-21
  it('throws RepositoryCatalogResponseError for an unknown sync.status string', () => {
    expect(() =>
      parseRepositoryCatalogResponse({ ...BASE, sync: { status: 'not-a-real-status', updatedAt: null, discoveredRepositories: null, registeredRepositories: null } }),
    ).toThrow(RepositoryCatalogResponseError);
  });

  // @spec EC-21
  it('throws RepositoryCatalogResponseError for non-numeric counts', () => {
    expect(() =>
      parseRepositoryCatalogResponse({
        ...BASE,
        sync: { status: 'importing', updatedAt: null, discoveredRepositories: 'twelve', registeredRepositories: 5 },
      }),
    ).toThrow(RepositoryCatalogResponseError);
  });

  // @spec EC-21
  it('throws RepositoryCatalogResponseError for an unparseable updatedAt', () => {
    expect(() =>
      parseRepositoryCatalogResponse({
        ...BASE,
        sync: { status: 'idle', updatedAt: 'not-a-date', discoveredRepositories: null, registeredRepositories: null },
      }),
    ).toThrow(RepositoryCatalogResponseError);
  });

  // @spec EC-21
  it('ignores unknown extra keys inside a present, otherwise-valid sync object', () => {
    const result = parseRepositoryCatalogResponse({
      ...BASE,
      sync: {
        status: 'importing',
        updatedAt: '2026-08-12T18:00:00.000Z',
        discoveredRepositories: 12,
        registeredRepositories: 5,
        revokedRepositories: 2,
        sweepOutcome: 'applied',
        somethingFromTheFuture: 'ignored',
      },
    });
    expect(result.sync.status).toBe('importing');
    expect(result.sync.discoveredRepositories).toBe(12);
  });
});
