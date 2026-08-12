// CH-01 red suite — mint / audit-read / sweep for the `chat_ephemeral` MCP
// credential family. Authored from .pipeline/spec.md before any implementation
// exists, so every assertion below describes the spec, not a diff.
//
// Everything here runs on injected fakes (`store`, `permissions`, `now`,
// `randomSecret`, `randomPrefixBytes`, `getPepper`, `getPepperVersion`) exactly
// as mcpKeyService.test.ts already does — no database is required. The
// genuinely DB-dependent halves (EC-20, EC-21's SQL behavior, EC-23's runtime
// privilege state, AC-2's PostgresPermissionStore half) live in
// src/db/ephemeralMcpCredentials.rls.test.ts.
//
// AC-2 / AC-5 note (the one trap in this ticket): `intersectReadScopes(S, S)`
// produces every pairwise rule intersection, so its result can legitimately
// contain MORE rules than `S` — each of them a subset of a rule already in `S`.
// The authorized *set of resources* is identical; the arrays are not. Every
// scope-equality assertion below is therefore written as `canReadResource`
// agreeing over a probe set, never as deep-equality of `scope.allows`.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  EphemeralMcpCredentialStore,
  StoreEphemeralMcpCredentialInput,
  StoredEphemeralMcpCredential,
} from '../db/ephemeralMcpCredentialStore';
import {
  canReadResource,
  intersectReadScopes,
  type PermissionStore,
  type ReadScope,
  type ScopedGraphResource,
} from '../graph-query/permissions';
import {
  DEFAULT_EPHEMERAL_TTL_SECONDS,
  EPHEMERAL_SWEEP_BATCH,
  EphemeralMcpCredentialForbiddenError,
  EphemeralMcpCredentialValidationError,
  MAX_EPHEMERAL_CEILING_ROWS,
  MAX_EPHEMERAL_TTL_SECONDS,
  listEphemeralMcpCredentialAudit,
  mintEphemeralMcpCredential,
  sweepExpiredEphemeralMcpCredentials,
} from './ephemeralMcpCredentialService';
import { mcpSecretHmac } from './mcpKeyService';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '77777777-7777-4777-8777-777777777777';
const REPO = '33333333-3333-4333-8333-333333333333';
const OTHER_REPO = '44444444-4444-4444-8444-444444444444';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const OTHER_CONVERSATION = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-08-10T12:00:00.000Z');
const PEPPER = 'pepper-value';
const PEPPER_VERSION = 7;

const MEMBER: AuthContext = {
  subjectType: 'user',
  userId: USER,
  orgId: ORG,
  roles: ['member'],
};
const ADMIN: AuthContext = { ...MEMBER, roles: ['admin'] };
const OWNER: AuthContext = { ...MEMBER, roles: ['owner'] };
const AGENT: AuthContext = {
  subjectType: 'agent_key',
  agentKeyId: 'mcp_chat_abababababababab',
  orgId: ORG,
  roles: ['member'],
};

/** Mixed true/false coverage — a probe set that is uniformly one value proves nothing. */
const PROBES: ScopedGraphResource[] = [
  { repoId: REPO, refName: 'refs/heads/main', path: 'src/app/page.tsx' },
  { repoId: REPO, refName: 'refs/heads/main', path: 'src/secret/keys.ts' },
  { repoId: REPO, refName: 'refs/heads/release', path: 'src/app/page.tsx' },
  { repoId: OTHER_REPO, refName: 'refs/heads/main', path: 'src/app/page.tsx' },
  { repoId: REPO, refName: 'refs/heads/main', path: 'docs/readme.md' },
  { repoId: OTHER_REPO, refName: 'refs/heads/main', path: 'lib/index.ts' },
];

const ISSUER_SCOPE: ReadScope = {
  allows: [
    { repoId: REPO, branch: null, pathPrefix: 'src' },
    { repoId: OTHER_REPO, branch: 'refs/heads/main', pathPrefix: null },
  ],
  denies: [{ repoId: REPO, branch: null, pathPrefix: 'src/secret' }],
};

function coverage(scope: ReadScope): boolean[] {
  return PROBES.map((probe) => canReadResource(scope, probe));
}

interface Harness {
  store: EphemeralMcpCredentialStore;
  issued: { orgId: string; input: StoreEphemeralMcpCredentialInput }[];
  listedWith: {
    orgId: string;
    conversationId: string;
    issuedBy: string | null;
  }[];
  sweptWith: { orgId: string; before: Date; limit: number }[];
  rows: StoredEphemeralMcpCredential[];
  actorLabel: string | null;
  permissions: PermissionStore;
  scope: ReadScope;
  randomSecret: ReturnType<typeof vi.fn>;
  randomPrefixBytes: ReturnType<typeof vi.fn>;
  getPepper: ReturnType<typeof vi.fn>;
  deps: () => Record<string, unknown>;
}

function harness(): Harness {
  const state: Harness = {
    issued: [],
    listedWith: [],
    sweptWith: [],
    rows: [],
    actorLabel: 'Ada Lovelace',
    scope: { allows: [...ISSUER_SCOPE.allows], denies: [...ISSUER_SCOPE.denies] },
  } as unknown as Harness;

  state.store = {
    issue: vi.fn(async (orgId: string, input: StoreEphemeralMcpCredentialInput) => {
      state.issued.push({ orgId, input });
      const row: StoredEphemeralMcpCredential = {
        id: KEY_ID,
        keyPrefix: input.keyPrefix,
        conversationId: input.conversationId,
        createdAt: input.issuedAt,
        createdBy: input.createdBy,
        createdByLabel: input.createdByLabel,
        expiresAt: input.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
      };
      return row;
    }),
    listByConversation: vi.fn(
      async (orgId: string, conversationId: string, issuedBy: string | null) => {
        state.listedWith.push({ orgId, conversationId, issuedBy });
        return state.rows;
      },
    ),
    deleteExpired: vi.fn(async (orgId: string, before: Date, limit: number) => {
      state.sweptWith.push({ orgId, before, limit });
      return 3;
    }),
    getActorLabel: vi.fn(async () => state.actorLabel),
  };
  state.permissions = { getReadScope: vi.fn(async () => state.scope) };
  state.randomSecret = vi.fn(() => Buffer.alloc(32, 3));
  state.randomPrefixBytes = vi.fn(() => Buffer.alloc(8, 0xab));
  state.getPepper = vi.fn(async () => PEPPER);
  state.deps = () => ({
    store: state.store,
    permissions: state.permissions,
    getPepper: state.getPepper,
    getPepperVersion: () => PEPPER_VERSION,
    now: () => NOW,
    randomSecret: state.randomSecret,
    randomPrefixBytes: state.randomPrefixBytes,
  });
  return state;
}

describe('CH-01 ephemeral MCP credential minting', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  // @spec AC-1 AC-4 AC-8
  it('returns a one-time chat bearer token and persists only its pepper-versioned digest', async () => {
    const minted = await mintEphemeralMcpCredential(
      { conversationId: CONVERSATION },
      MEMBER,
      h.deps(),
    );

    expect(minted.token).toMatch(/^mcp_chat_[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
    expect(minted.kind).toBe('chat_ephemeral');
    expect(minted.keyId).toBe(KEY_ID);
    expect(minted.keyPrefix).toBe(minted.token.split('.')[0]);
    expect(minted.conversationId).toBe(CONVERSATION);
    expect(minted.issuedByUserId).toBe(USER);
    expect(minted.issuedAt).toBe(NOW.toISOString());

    const secret = minted.token.split('.')[1] ?? '';
    expect(h.issued).toHaveLength(1);
    const captured = h.issued[0];
    // AC-8: tenancy comes only from ctx.orgId — the caller supplied no org.
    expect(captured?.orgId).toBe(ORG);
    expect(captured?.input.keyPrefix).toBe(minted.keyPrefix);
    expect(captured?.input.createdBy).toBe(USER);
    expect(captured?.input.createdByLabel).toBe('Ada Lovelace');
    expect(captured?.input.conversationId).toBe(CONVERSATION);
    // AC-4: digest-only storage.
    expect(captured?.input.keyHmac).toMatch(/^[a-f0-9]{64}$/);
    expect(captured?.input.keyHmac).toBe(mcpSecretHmac(secret, PEPPER));
    expect(captured?.input.pepperVersion).toBe(PEPPER_VERSION);
    expect(JSON.stringify(captured?.input)).not.toContain(secret);
    expect(JSON.stringify(captured?.input)).not.toContain(minted.token);
    expect(captured?.input).not.toHaveProperty('token');
    expect(captured?.input).not.toHaveProperty('secret');
    expect(mintEphemeralMcpCredential).toHaveLength(2);
  });

  // @spec AC-2 AC-5
  it('persists the issuer mint-time scope as the ceiling with identical resource coverage', async () => {
    await mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, h.deps());

    const ceiling = h.issued[0]?.input.ceiling;
    expect(ceiling).toEqual({
      allows: ISSUER_SCOPE.allows,
      denies: ISSUER_SCOPE.denies,
    });

    // The probe set must actually discriminate, or the equality below is vacuous.
    expect(new Set(coverage(ISSUER_SCOPE)).size).toBe(2);

    // AC-2: coverage equality, NOT array equality — intersectReadScopes(S, S)
    // legitimately returns more rules than S, each a subset of an existing one.
    const resolved = intersectReadScopes(
      { allows: ceiling?.allows ?? [], denies: ceiling?.denies ?? [] },
      ISSUER_SCOPE,
    );
    expect(coverage(resolved)).toEqual(coverage(ISSUER_SCOPE));
  });

  // @spec AC-5 EC-15
  it('cannot exceed the issuer live scope even when the stored ceiling is widened', async () => {
    await mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, h.deps());

    // Simulates a ceiling `permissions` row edited directly in the database to
    // the broadest possible rule after mint.
    const widened: ReadScope = {
      allows: [{ repoId: null, branch: null, pathPrefix: null }],
      denies: [],
    };
    const resolved = intersectReadScopes(widened, ISSUER_SCOPE);
    expect(coverage(resolved)).toEqual(coverage(ISSUER_SCOPE));
    expect(
      canReadResource(resolved, {
        repoId: REPO,
        refName: 'refs/heads/main',
        path: 'docs/readme.md',
      }),
    ).toBe(false);
  });

  // @spec EC-13
  it('records an owner ceiling as the single wildcard rule without broadening it', async () => {
    const ownerScope: ReadScope = {
      allows: [{ repoId: null, branch: null, pathPrefix: null }],
      denies: [],
    };
    h.scope = ownerScope;

    await mintEphemeralMcpCredential({ conversationId: CONVERSATION }, OWNER, h.deps());

    expect(h.issued[0]?.input.ceiling).toEqual({
      allows: [{ repoId: null, branch: null, pathPrefix: null }],
      denies: [],
    });
    const resolved = intersectReadScopes(ownerScope, ownerScope);
    expect(coverage(resolved)).toEqual(coverage(ownerScope));
    expect(coverage(resolved).every(Boolean)).toBe(true);
  });

  // @spec EC-14
  it('narrows on the next resolve when the issuer scope is narrowed after mint', async () => {
    await mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, h.deps());
    const ceiling = h.issued[0]?.input.ceiling;

    const narrowed: ReadScope = {
      allows: [{ repoId: REPO, branch: null, pathPrefix: 'src/app' }],
      denies: [],
    };
    const resolved = intersectReadScopes(
      { allows: ceiling?.allows ?? [], denies: ceiling?.denies ?? [] },
      narrowed,
    );
    expect(coverage(resolved)).toEqual(coverage(narrowed));
    expect(
      canReadResource(resolved, {
        repoId: OTHER_REPO,
        refName: 'refs/heads/main',
        path: 'lib/index.ts',
      }),
    ).toBe(false);

    // A later deny narrows the same way, again with no new mint.
    const denied: ReadScope = {
      allows: narrowed.allows,
      denies: [{ repoId: REPO, branch: null, pathPrefix: 'src/app' }],
    };
    expect(
      coverage(
        intersectReadScopes(
          { allows: ceiling?.allows ?? [], denies: ceiling?.denies ?? [] },
          denied,
        ),
      ).some(Boolean),
    ).toBe(false);
    expect(h.store.issue).toHaveBeenCalledTimes(1);
  });

  // @spec EC-12
  it('mints for an issuer with an empty effective scope and writes no ceiling rows', async () => {
    h.scope = { allows: [], denies: [] };

    const minted = await mintEphemeralMcpCredential(
      { conversationId: CONVERSATION },
      MEMBER,
      h.deps(),
    );

    expect(minted.token).toMatch(/^mcp_chat_[a-f0-9]{16}\./);
    expect(h.issued[0]?.input.ceiling).toEqual({ allows: [], denies: [] });
    const resolved = intersectReadScopes({ allows: [], denies: [] }, h.scope);
    expect(coverage(resolved).some(Boolean)).toBe(false);
  });

  // @spec AC-7 EC-9
  it('defaults the TTL to 300s, accepts up to 600s, and rejects anything else before minting', async () => {
    const defaulted = await mintEphemeralMcpCredential(
      { conversationId: CONVERSATION },
      MEMBER,
      h.deps(),
    );
    expect(DEFAULT_EPHEMERAL_TTL_SECONDS).toBe(300);
    expect(MAX_EPHEMERAL_TTL_SECONDS).toBe(600);
    expect(
      new Date(defaulted.expiresAt).valueOf() - new Date(defaulted.issuedAt).valueOf(),
    ).toBe(DEFAULT_EPHEMERAL_TTL_SECONDS * 1_000);
    expect(h.issued[0]?.input.expiresAt.valueOf()).toBe(
      NOW.valueOf() + DEFAULT_EPHEMERAL_TTL_SECONDS * 1_000,
    );
    expect(h.issued[0]?.input.issuedAt.valueOf()).toBe(NOW.valueOf());

    for (const ttlSeconds of [1, 60, MAX_EPHEMERAL_TTL_SECONDS]) {
      const minted = await mintEphemeralMcpCredential(
        { conversationId: CONVERSATION, ttlSeconds },
        MEMBER,
        h.deps(),
      );
      expect(
        new Date(minted.expiresAt).valueOf() - new Date(minted.issuedAt).valueOf(),
      ).toBe(ttlSeconds * 1_000);
    }

    const mintsSoFar = h.issued.length;
    const secretsSoFar = h.randomSecret.mock.calls.length;
    for (const ttlSeconds of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      601,
      '300',
      null,
      true,
    ]) {
      await expect(
        mintEphemeralMcpCredential(
          { conversationId: CONVERSATION, ttlSeconds },
          MEMBER,
          h.deps(),
        ),
      ).rejects.toBeInstanceOf(EphemeralMcpCredentialValidationError);
    }
    // Rejected BEFORE any key material is generated or any row is written.
    expect(h.issued).toHaveLength(mintsSoFar);
    expect(h.randomSecret.mock.calls).toHaveLength(secretsSoFar);
    expect(h.randomPrefixBytes.mock.calls).toHaveLength(secretsSoFar);
  });

  // @spec AC-8 EC-10
  it('accepts exactly conversationId/ttlSeconds and never an org id from the caller', async () => {
    const rejected: unknown[] = [
      {},
      { conversationId: '' },
      { conversationId: 'not-a-uuid' },
      { conversationId: 123 },
      { conversationId: null },
      { conversationId: [CONVERSATION] },
      { conversationId: CONVERSATION, orgId: '99999999-9999-4999-8999-999999999999' },
      { conversationId: CONVERSATION, extra: 1 },
      { ttlSeconds: 300 },
      null,
      'conversation',
      [CONVERSATION],
    ];
    for (const input of rejected) {
      await expect(
        mintEphemeralMcpCredential(input, MEMBER, h.deps()),
      ).rejects.toBeInstanceOf(EphemeralMcpCredentialValidationError);
    }
    expect(h.store.issue).not.toHaveBeenCalled();
    expect(h.randomSecret).not.toHaveBeenCalled();
  });

  // @spec EC-11
  it('refuses to mint, audit, or sweep for a non-user caller including an agent key', async () => {
    await expect(
      mintEphemeralMcpCredential({ conversationId: CONVERSATION }, AGENT, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    await expect(
      listEphemeralMcpCredentialAudit(CONVERSATION, AGENT, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    await expect(
      sweepExpiredEphemeralMcpCredentials(AGENT, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    expect(h.store.issue).not.toHaveBeenCalled();
    expect(h.store.listByConversation).not.toHaveBeenCalled();
    expect(h.store.deleteExpired).not.toHaveBeenCalled();
    expect(h.randomSecret).not.toHaveBeenCalled();
  });

  // @spec EC-16
  it('fails loudly rather than truncating a ceiling larger than the configured maximum', async () => {
    h.scope = {
      allows: Array.from({ length: MAX_EPHEMERAL_CEILING_ROWS + 1 }, (_value, index) => ({
        repoId: REPO,
        branch: null,
        pathPrefix: `src/module-${index}`,
      })),
      denies: [],
    };

    await expect(
      mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialValidationError);
    expect(h.store.issue).not.toHaveBeenCalled();
    expect(h.randomSecret).not.toHaveBeenCalled();
  });

  // @spec EC-17
  it('allows two concurrent mints for one conversation with distinct prefixes and expiries', async () => {
    let prefixCall = 0;
    let clockCall = 0;
    const prefixBytes = vi.fn(() =>
      Buffer.alloc(8, prefixCall++ === 0 ? 0xab : 0xcd),
    );
    const clock = vi.fn(() => new Date(NOW.valueOf() + clockCall++ * 1_000));
    const deps = { ...h.deps(), randomPrefixBytes: prefixBytes, now: clock };

    const [first, second] = await Promise.all([
      mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, deps),
      mintEphemeralMcpCredential(
        { conversationId: CONVERSATION, ttlSeconds: 600 },
        MEMBER,
        deps,
      ),
    ]);

    expect(first?.keyPrefix).not.toBe(second?.keyPrefix);
    expect(first?.conversationId).toBe(CONVERSATION);
    expect(second?.conversationId).toBe(CONVERSATION);
    expect(first?.expiresAt).not.toBe(second?.expiresAt);
    expect(h.issued).toHaveLength(2);
  });

  // @spec EC-22
  it('keeps every rejection message a fixed constant and never logs or echoes key material', async () => {
    expect(new EphemeralMcpCredentialValidationError().message).toBe(
      'Ephemeral MCP credential request is invalid.',
    );
    expect(new EphemeralMcpCredentialForbiddenError().message).toBe(
      'Ephemeral MCP credentials require a signed-in user.',
    );

    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    try {
      const minted = await mintEphemeralMcpCredential(
        { conversationId: CONVERSATION },
        MEMBER,
        h.deps(),
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();

      const failure = await mintEphemeralMcpCredential(
        { conversationId: CONVERSATION, ttlSeconds: 601 },
        MEMBER,
        h.deps(),
      ).catch((error: unknown) => error as Error);
      expect(failure.message).toBe('Ephemeral MCP credential request is invalid.');
      expect(failure.message).not.toContain(minted.token);
      expect(failure.stack ?? '').not.toContain(minted.token.split('.')[1] ?? 'x');
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  // @spec EC-11
  it('refuses to mint when the issuing user has no resolvable actor label', async () => {
    h.actorLabel = null;
    await expect(
      mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    expect(h.store.issue).not.toHaveBeenCalled();
  });
});

describe('CH-01 ephemeral MCP credential audit read', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
    h.rows = [
      {
        id: KEY_ID,
        keyPrefix: 'mcp_chat_abababababababab',
        conversationId: CONVERSATION,
        createdAt: NOW,
        createdBy: USER,
        createdByLabel: 'Ada Lovelace',
        expiresAt: new Date(NOW.valueOf() + 300_000),
        revokedAt: null,
        lastUsedAt: new Date(NOW.valueOf() + 1_000),
      },
    ];
  });

  // @spec AC-6
  it('returns the audit fields for a conversation and no key material', async () => {
    const audit = await listEphemeralMcpCredentialAudit(CONVERSATION, ADMIN, h.deps());

    expect(audit).toEqual([
      {
        keyId: KEY_ID,
        keyPrefix: 'mcp_chat_abababababababab',
        kind: 'chat_ephemeral',
        conversationId: CONVERSATION,
        issuedByUserId: USER,
        issuedByLabel: 'Ada Lovelace',
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.valueOf() + 300_000).toISOString(),
        lastUsedAt: new Date(NOW.valueOf() + 1_000).toISOString(),
        revokedAt: null,
      },
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain('keyHmac');
    expect(serialized).not.toContain('pepperVersion');
    expect(serialized).not.toContain('token');
  });

  // @spec EC-24
  it('scopes the audit read to the caller for a member and to the org for owner/admin', async () => {
    await listEphemeralMcpCredentialAudit(CONVERSATION, MEMBER, h.deps());
    await listEphemeralMcpCredentialAudit(CONVERSATION, ADMIN, h.deps());
    await listEphemeralMcpCredentialAudit(CONVERSATION, OWNER, h.deps());

    expect(h.listedWith).toEqual([
      { orgId: ORG, conversationId: CONVERSATION, issuedBy: USER },
      { orgId: ORG, conversationId: CONVERSATION, issuedBy: null },
      { orgId: ORG, conversationId: CONVERSATION, issuedBy: null },
    ]);

    // A conversation owned by another tenant yields no rows, never another
    // tenant's rows: the org predicate is always this caller's ctx.orgId.
    h.rows = [];
    await expect(
      listEphemeralMcpCredentialAudit(OTHER_CONVERSATION, ADMIN, h.deps()),
    ).resolves.toEqual([]);
    expect(h.listedWith.at(-1)).toEqual({
      orgId: ORG,
      conversationId: OTHER_CONVERSATION,
      issuedBy: null,
    });
  });

  // @spec EC-10 EC-24
  it('rejects a conversation id that is not a UUID', async () => {
    for (const conversationId of ['', 'not-a-uuid', 42, null, undefined, [CONVERSATION]]) {
      await expect(
        listEphemeralMcpCredentialAudit(conversationId, ADMIN, h.deps()),
      ).rejects.toBeInstanceOf(EphemeralMcpCredentialValidationError);
    }
    expect(h.store.listByConversation).not.toHaveBeenCalled();
  });

  // @spec AC-6
  it('reports a deleted issuer as a null user id while keeping the captured label', async () => {
    h.rows = [{ ...(h.rows[0] as StoredEphemeralMcpCredential), createdBy: null }];
    const audit = await listEphemeralMcpCredentialAudit(CONVERSATION, ADMIN, h.deps());
    expect(audit[0]?.issuedByUserId).toBeNull();
    expect(audit[0]?.issuedByLabel).toBe('Ada Lovelace');
  });
});

describe('CH-01 expired ephemeral credential sweep', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  // @spec AC-12
  it('deletes expired rows for one org in one batch and returns the count', async () => {
    await expect(sweepExpiredEphemeralMcpCredentials(ADMIN, h.deps())).resolves.toBe(3);
    expect(h.sweptWith).toEqual([
      { orgId: ORG, before: NOW, limit: EPHEMERAL_SWEEP_BATCH },
    ]);
    expect(EPHEMERAL_SWEEP_BATCH).toBe(1_000);
  });

  // @spec AC-12 EC-11
  it('is rejected for a member, another org actor, and a non-user context', async () => {
    await expect(
      sweepExpiredEphemeralMcpCredentials(MEMBER, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    await expect(
      sweepExpiredEphemeralMcpCredentials(
        { ...MEMBER, userId: OTHER_USER, roles: [] },
        h.deps(),
      ),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    await expect(
      sweepExpiredEphemeralMcpCredentials(AGENT, h.deps()),
    ).rejects.toBeInstanceOf(EphemeralMcpCredentialForbiddenError);
    expect(h.store.deleteExpired).not.toHaveBeenCalled();
  });
});
