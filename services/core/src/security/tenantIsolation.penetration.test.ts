// Node-side cross-store adversarial penetration suite (W2-06 -- the ticket's
// core acceptance). Proves:
//   (a) a forged client-supplied org_id is ignored end-to-end over HTTP;
//   (b) Postgres RLS, with the app-layer WHERE clause deliberately removed,
//       still returns/writes zero cross-tenant rows under the sayre_app
//       runtime role -- across all 13 tenant tables;
//   (c) the Neo4j write AND read guards reject an org-less query and a
//       forged/mismatched bound org, via the REAL executors (not just the
//       bare guard function -- see graphOrgGuard.test.ts for that);
//   (d) pgvector (code_chunks/code_embeddings) reads/writes are org-scoped.
//
// The Postgres section is real-Postgres-gated exactly like
// `src/db/rls_acceptance.tester.test.ts` (same DATABASE_ADMIN_URL + dedicated
// throwaway-database harness shape, reused deliberately) so `npm run test`
// stays green on a machine without a database. The HTTP and Neo4j sections
// need no real infra (fake driver injection via Neo4jDriverFactory) and
// always run.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client, Pool, type PoolClient } from 'pg';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getConfig, getSecret, resetSecretsForTests, SecretNotFoundError } from '@sayre/config';
import type { GraphEdge, GraphNode } from '../graph-query/types';
import { requireOrgId, type UserAuthContext } from '../auth/context';
import { createDb, createPool, withOrgContext, type Db } from '../db/client';
import {
  createNeo4jWriteExecutor,
  type Neo4jDriverFactory as WriteNeo4jDriverFactory,
} from '../graph-write/neo4j';
import {
  createNeo4jReadExecutor,
  type Neo4jDriverFactory as ReadNeo4jDriverFactory,
} from '../graph-query/neo4j';
import { GraphOrgScopeError } from './graphOrgGuard';
import { createApp } from '../app';

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000002';

// Module top-level (NOT nested inside a describe block) -- vi.mock is hoisted
// by vitest's transform above the imports, and the factory closure below
// references these vi.fn()s, so both must live at true module scope to avoid
// a temporal-dead-zone break. Mirrors routes/technicalTree.test.ts exactly.
const getNodesInViewport = vi.fn(
  async (): Promise<GraphNode[]> => [
    { id: 'n1', label: 'Folder', name: 'root', path: '/root', parentId: null },
  ],
);
const getStructuralEdges = vi.fn(async (): Promise<GraphEdge[]> => []);

vi.mock('../graph-query', () => ({
  graphQueryService: {
    getNodesInViewport: (...args: unknown[]) =>
      (getNodesInViewport as unknown as (...a: unknown[]) => unknown)(...args),
    getStructuralEdges: (...args: unknown[]) =>
      (getStructuralEdges as unknown as (...a: unknown[]) => unknown)(...args),
  },
}));

// ---------------------------------------------------------------------------
// (a) Forged org_id is never used -- query, JSON body, header, all ignored;
//     the server-resolved auth context wins even when multiple forged values
//     are supplied simultaneously.
// ---------------------------------------------------------------------------

describe('forged org_id: requireOrgId only ever reads req.context (direct unit proof)', () => {
  it('ignores org_id present in query, body, AND a header simultaneously -- only req.context.orgId is read', () => {
    const fakeReq = {
      context: { subjectType: 'user', orgId: ORG_A, userId: 'u1', roles: ['member'] } as UserAuthContext,
      query: { org_id: ORG_B, orgId: ORG_B },
      body: { org_id: 'forged-in-body-C' },
      headers: { 'x-org-id': 'forged-in-header-D', 'x-tenant': 'forged-in-header-E' },
    };
    expect(requireOrgId(fakeReq as unknown as Parameters<typeof requireOrgId>[0])).toBe(ORG_A);
  });

  it('throws rather than falling back to any forged field when req.context is absent', () => {
    const fakeReq = { query: { org_id: ORG_B }, body: { org_id: 'C' }, headers: {} };
    expect(() => requireOrgId(fakeReq as unknown as Parameters<typeof requireOrgId>[0])).toThrow(
      /Missing auth context/,
    );
  });
});

describe('forged org_id over HTTP: GET /repos/:repoId/technical-tree', () => {
  let activeServer: Server | undefined;

  afterEach(async () => {
    getNodesInViewport.mockClear();
    getStructuralEdges.mockClear();
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = undefined;
    }
  });

  async function startServer() {
    const app = createApp();
    const server: Server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    activeServer = server;
    return `http://127.0.0.1:${port}`;
  }

  it('a forged X-Org-Id header has no effect -- server-derived context reaches the graph-query layer', async () => {
    const baseUrl = await startServer();
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await fetch(`${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100`, {
      headers: { 'X-Org-Id': 'attacker-org', 'X-Tenant': 'attacker-tenant' },
    });

    expect(res.status).toBe(200);
    const context = getNodesInViewport.mock.calls[0]?.[3] as { orgId: string };
    expect(context.orgId).toBe(expectedOrgId);
    expect(context.orgId).not.toBe('attacker-org');
  });

  // A forged org_id in a JSON body is proven at the unit level above
  // ('requireOrgId only ever reads req.context'), not here: the WHATWG fetch
  // spec forbids a body on a GET request, and there is no POST tenant route
  // in the current app to exercise body-forgery against realistically (the
  // spec scope explicitly says "no route change needed" -- inventing one
  // would be out of scope). The mechanism is identical either way:
  // requireOrgId(req) never reads req.body regardless of HTTP verb.

  it('two different forged org_ids supplied simultaneously (query + header) -- neither reaches the query', async () => {
    const baseUrl = await startServer();
    const expectedOrgId = getConfig('DEV_ORG_ID');

    const res = await fetch(
      `${baseUrl}/repos/repo-1/technical-tree?x=0&y=0&width=100&height=100&orgId=attacker-query-org`,
      { headers: { 'X-Org-Id': 'attacker-header-org' } },
    );

    expect(res.status).toBe(200);
    const context = getNodesInViewport.mock.calls[0]?.[3] as { orgId: string };
    expect(context.orgId).toBe(expectedOrgId);
    expect(context.orgId).not.toBe('attacker-query-org');
    expect(context.orgId).not.toBe('attacker-header-org');
  });
});

// ---------------------------------------------------------------------------
// (c) Neo4j write + read guards, via the REAL executors with a fake injected
//     driver (Neo4jDriverFactory seam -- see neo4jChokepoint.test.ts, which
//     asserts this file uses only the fake, never a real driver).
// ---------------------------------------------------------------------------

interface FakeDriverHandle {
  factory: WriteNeo4jDriverFactory & ReadNeo4jDriverFactory;
  runCalls: Array<{ cypher: string; params: unknown }>;
  wasSessionOpened: () => boolean;
}

function createFakeDriverFactory(): FakeDriverHandle {
  const runCalls: Array<{ cypher: string; params: unknown }> = [];
  let sessionOpened = false;
  const fakeTransaction = {
    run: async (cypher: string, params: unknown) => {
      runCalls.push({ cypher, params });
      return { records: [] };
    },
  };
  const fakeSession = {
    executeWrite: async (fn: (tx: typeof fakeTransaction) => unknown) => fn(fakeTransaction),
    executeRead: async (fn: (tx: typeof fakeTransaction) => unknown) => fn(fakeTransaction),
    close: async () => undefined,
  };
  const fakeDriver = {
    session: () => {
      sessionOpened = true;
      return fakeSession;
    },
    close: async () => undefined,
  };
  const factory = (() => fakeDriver) as unknown as WriteNeo4jDriverFactory & ReadNeo4jDriverFactory;
  return { factory, runCalls, wasSessionOpened: () => sessionOpened };
}

describe('Neo4j write guard (InstrumentedNeo4jWriteExecutor.run, via a fake Neo4jDriverFactory)', () => {
  beforeAll(() => {
    vi.stubEnv('NEO4J_PASSWORD', 'fake-test-password-write');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    resetSecretsForTests();
  });

  it('rejects a write Cypher missing $org_id before opening a session -- nothing executes', async () => {
    resetSecretsForTests();
    const { factory, runCalls, wasSessionOpened } = createFakeDriverFactory();
    const executor = await createNeo4jWriteExecutor(factory);

    await expect(
      executor.run(ORG_A, 'MERGE (n:File {uid: $uid}) RETURN n', { uid: 'x' }),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
    expect(runCalls).toEqual([]);
    expect(wasSessionOpened()).toBe(false);
  });

  it('rejects a write with a forged/mismatched bound org (metrics orgId="A" but params.org_id="B")', async () => {
    resetSecretsForTests();
    const { factory, runCalls, wasSessionOpened } = createFakeDriverFactory();
    const executor = await createNeo4jWriteExecutor(factory);

    await expect(
      executor.run(ORG_A, 'MERGE (n:File {org_id: $org_id, uid: $uid}) RETURN n', {
        org_id: ORG_B,
        uid: 'x',
      }),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
    expect(runCalls).toEqual([]);
    expect(wasSessionOpened()).toBe(false);
  });

  it('allows a correctly org-scoped write through unchanged (regression: guard is not over-strict)', async () => {
    resetSecretsForTests();
    const { factory, runCalls } = createFakeDriverFactory();
    const executor = await createNeo4jWriteExecutor(factory);

    const result = await executor.run(ORG_A, 'MERGE (n:File {org_id: $org_id, uid: $uid}) RETURN n', {
      org_id: ORG_A,
      uid: 'x',
    });
    expect(result.records).toEqual([]);
    expect(runCalls).toHaveLength(1);
  });
});

describe('Neo4j read guard (InstrumentedNeo4jReadExecutor.run, via a fake Neo4jDriverFactory)', () => {
  beforeAll(() => {
    vi.stubEnv('NEO4J_PASSWORD', 'fake-test-password-read');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    resetSecretsForTests();
  });

  it('rejects a read Cypher missing $org_id before opening a session -- nothing executes', async () => {
    resetSecretsForTests();
    const { factory, runCalls, wasSessionOpened } = createFakeDriverFactory();
    const executor = await createNeo4jReadExecutor(factory);

    await expect(
      executor.run(ORG_A, 'traversal', 'MATCH (n:File {uid: $uid}) RETURN n', { uid: 'x' }),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
    expect(runCalls).toEqual([]);
    expect(wasSessionOpened()).toBe(false);
  });

  it('ignores a forged/mismatched bound org on a read: run("A", ..., {org_id: "B"}) throws -- ctx.orgId is authoritative', async () => {
    resetSecretsForTests();
    const { factory, runCalls, wasSessionOpened } = createFakeDriverFactory();
    const executor = await createNeo4jReadExecutor(factory);

    await expect(
      executor.run(ORG_A, 'traversal', 'MATCH (n {org_id: $org_id, uid: $uid}) RETURN n', {
        org_id: ORG_B,
        uid: 'x',
      }),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
    expect(runCalls).toEqual([]);
    expect(wasSessionOpened()).toBe(false);
  });

  it('params.org_id absent/undefined/non-UUID is rejected', async () => {
    resetSecretsForTests();
    const { factory } = createFakeDriverFactory();
    const executor = await createNeo4jReadExecutor(factory);

    await expect(
      executor.run(ORG_A, 'traversal', 'MATCH (n {org_id: $org_id}) RETURN n', {}),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
    await expect(
      executor.run(ORG_A, 'traversal', 'MATCH (n {org_id: $org_id}) RETURN n', {
        org_id: 'not-a-uuid',
      }),
    ).rejects.toBeInstanceOf(GraphOrgScopeError);
  });

  it('allows a correctly org-scoped read through unchanged (regression: guard is not over-strict, mirrors RbacGraphQueryService)', async () => {
    resetSecretsForTests();
    const { factory, runCalls } = createFakeDriverFactory();
    const executor = await createNeo4jReadExecutor(factory);

    const result = await executor.run(
      ORG_A,
      'viewport_read',
      'MATCH (n) WHERE n.org_id = $org_id RETURN n',
      { org_id: ORG_A, repo_id: 'repo-1' },
    );
    expect(result.records).toEqual([]);
    expect(runCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// (b) + (d) Postgres RLS with the app-layer filter removed, across all 13
//     tenant tables (Node) -- real-Postgres-gated, dedicated throwaway DB,
//     exactly like src/db/rls_acceptance.tester.test.ts's harness shape.
// ---------------------------------------------------------------------------

const TABLE_NAMES = [
  'organizations',
  'users',
  'repositories',
  'permissions',
  'ticket_cache',
  'style_rules',
  'onboarding_steps',
  'github_app_installations',
  'mcp_client_keys',
  'model_provider_configs',
  'repository_refs',
  'code_chunks',
  'code_embeddings',
] as const;
type TableName = (typeof TABLE_NAMES)[number];

function vectorLiteral(dim: number, fill = 0): string {
  return `[${Array(dim).fill(fill).join(',')}]`;
}
function shaLike(label: string): string {
  return `${label.toLowerCase()}${'0'.repeat(39)}`.slice(0, 40);
}
function uniqueInstallationId(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

interface SeededOrg {
  orgId: string;
  userId: string;
  repoId: string;
  permissionId: string;
  ticketId: string;
  styleRuleId: string;
  onboardingStepId: string;
  githubAppInstallationId: string;
  mcpClientKeyId: string;
  modelProviderConfigId: string;
  repositoryRefId: string;
  codeChunkId: string;
  codeEmbeddingId: string;
}

function idsByTable(seed: SeededOrg): Record<TableName, string> {
  return {
    organizations: seed.orgId,
    users: seed.userId,
    repositories: seed.repoId,
    permissions: seed.permissionId,
    ticket_cache: seed.ticketId,
    style_rules: seed.styleRuleId,
    onboarding_steps: seed.onboardingStepId,
    github_app_installations: seed.githubAppInstallationId,
    mcp_client_keys: seed.mcpClientKeyId,
    model_provider_configs: seed.modelProviderConfigId,
    repository_refs: seed.repositoryRefId,
    code_chunks: seed.codeChunkId,
    code_embeddings: seed.codeEmbeddingId,
  };
}

async function seedOrg(execPool: Pool, label: string): Promise<SeededOrg> {
  const orgId = randomUUID();
  const userId = randomUUID();
  const repoId = randomUUID();
  const permissionId = randomUUID();
  const ticketId = randomUUID();
  const styleRuleId = randomUUID();
  const onboardingStepId = randomUUID();
  const githubAppInstallationId = randomUUID();
  const mcpClientKeyId = randomUUID();
  const modelProviderConfigId = randomUUID();
  const repositoryRefId = randomUUID();
  const codeChunkId = randomUUID();
  const codeEmbeddingId = randomUUID();

  await execPool.query('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [
    orgId,
    `W2-06 pen-test org ${label}`,
    `w206-pentest-${label.toLowerCase()}-${orgId.slice(0, 8)}`,
  ]);
  await execPool.query('INSERT INTO users (id, org_id, email) VALUES ($1, $2, $3)', [
    userId,
    orgId,
    `user-${label}-${userId.slice(0, 8)}@example.com`,
  ]);
  await execPool.query('INSERT INTO repositories (id, org_id, name) VALUES ($1, $2, $3)', [
    repoId,
    orgId,
    `repo-${label}`,
  ]);
  await execPool.query(
    'INSERT INTO permissions (id, org_id, subject_type, subject_id, repo_id, action) VALUES ($1, $2, $3, $4, $5, $6)',
    [permissionId, orgId, 'user', userId, repoId, 'read'],
  );
  await execPool.query(
    'INSERT INTO ticket_cache (id, org_id, repo_id, provider, external_ticket_id) VALUES ($1, $2, $3, $4, $5)',
    [ticketId, orgId, repoId, 'jira', `PENTEST-${label}`],
  );
  await execPool.query(
    'INSERT INTO style_rules (id, org_id, repo_id, rule_type, content) VALUES ($1, $2, $3, $4, $5)',
    [styleRuleId, orgId, repoId, 'coding_style', `rules for ${label}`],
  );
  await execPool.query(
    'INSERT INTO onboarding_steps (id, org_id, repo_id, sequence, title) VALUES ($1, $2, $3, $4, $5)',
    [onboardingStepId, orgId, repoId, 1, `Step 1 for ${label}`],
  );
  await execPool.query(
    'INSERT INTO github_app_installations (id, org_id, installation_id, account_login) VALUES ($1, $2, $3, $4)',
    [githubAppInstallationId, orgId, uniqueInstallationId(), `${label}-account`],
  );
  await execPool.query(
    'INSERT INTO mcp_client_keys (id, org_id, name, key_prefix, key_hmac, pepper_version) VALUES ($1, $2, $3, $4, $5, $6)',
    [
      mcpClientKeyId,
      orgId,
      `MCP key for ${label}`,
      `mcp_live_pentest_${label.toLowerCase()}_${mcpClientKeyId.slice(0, 8)}`,
      `hmac-sha256:${mcpClientKeyId}`,
      1,
    ],
  );
  await execPool.query(
    'INSERT INTO model_provider_configs (id, org_id, purpose, provider, model) VALUES ($1, $2, $3, $4, $5)',
    [modelProviderConfigId, orgId, 'generation', 'anthropic', 'claude-opus-4'],
  );
  await execPool.query(
    'INSERT INTO repository_refs (id, org_id, repository_id, ref_name, revision_sha) VALUES ($1, $2, $3, $4, $5)',
    [repositoryRefId, orgId, repoId, 'refs/heads/main', shaLike(label)],
  );
  await execPool.query(
    'INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
    [codeChunkId, orgId, repoId, repositoryRefId, shaLike(label), 0, `content for ${label}`, `hash-${codeChunkId}`],
  );
  await execPool.query(
    'INSERT INTO code_embeddings (id, org_id, repository_id, ref_id, revision_sha, chunk_id, embedding, provider, model) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      codeEmbeddingId,
      orgId,
      repoId,
      repositoryRefId,
      shaLike(label),
      codeChunkId,
      vectorLiteral(1024),
      'voyage',
      'voyage-3',
    ],
  );

  return {
    orgId,
    userId,
    repoId,
    permissionId,
    ticketId,
    styleRuleId,
    onboardingStepId,
    githubAppInstallationId,
    mcpClientKeyId,
    modelProviderConfigId,
    repositoryRefId,
    codeChunkId,
    codeEmbeddingId,
  };
}

function buildInsertRow(
  table: Exclude<TableName, 'organizations'>,
  orgId: string,
  seed: SeededOrg,
  uniq: string,
): { cols: string[]; vals: unknown[] } {
  switch (table) {
    case 'users':
      return { cols: ['id', 'org_id', 'email'], vals: [randomUUID(), orgId, `xw-${uniq}@example.com`] };
    case 'repositories':
      return { cols: ['id', 'org_id', 'name'], vals: [randomUUID(), orgId, `repo-xw-${uniq}`] };
    case 'permissions':
      return {
        cols: ['id', 'org_id', 'subject_type', 'subject_id', 'repo_id', 'action'],
        vals: [randomUUID(), orgId, 'user', seed.userId, seed.repoId, 'read'],
      };
    case 'ticket_cache':
      return {
        cols: ['id', 'org_id', 'repo_id', 'provider', 'external_ticket_id'],
        vals: [randomUUID(), orgId, seed.repoId, 'jira', `XW-${uniq}`],
      };
    case 'style_rules':
      return {
        cols: ['id', 'org_id', 'repo_id', 'rule_type', 'content'],
        vals: [randomUUID(), orgId, seed.repoId, 'coding_style', `rule ${uniq}`],
      };
    case 'onboarding_steps':
      return {
        cols: ['id', 'org_id', 'repo_id', 'sequence', 'title'],
        vals: [randomUUID(), orgId, seed.repoId, 1, `step ${uniq}`],
      };
    case 'github_app_installations':
      return {
        cols: ['id', 'org_id', 'installation_id', 'account_login'],
        vals: [randomUUID(), orgId, uniqueInstallationId(), `acct-${uniq}`],
      };
    case 'mcp_client_keys':
      return {
        cols: ['id', 'org_id', 'name', 'key_prefix', 'key_hmac', 'pepper_version'],
        vals: [randomUUID(), orgId, `key ${uniq}`, `mcp_live_pentest_xw_${uniq}`, `hmac:${uniq}`, 1],
      };
    case 'model_provider_configs':
      return {
        cols: ['id', 'org_id', 'purpose', 'provider', 'model'],
        vals: [randomUUID(), orgId, 'embedding', 'voyage', 'voyage-3'],
      };
    case 'repository_refs':
      return {
        cols: ['id', 'org_id', 'repository_id', 'ref_name', 'revision_sha'],
        vals: [randomUUID(), orgId, seed.repoId, `refs/heads/xw-${uniq}`, shaLike(uniq)],
      };
    case 'code_chunks':
      return {
        cols: ['id', 'org_id', 'repository_id', 'ref_id', 'revision_sha', 'chunk_index', 'content', 'content_hash'],
        vals: [randomUUID(), orgId, seed.repoId, seed.repositoryRefId, shaLike(uniq), 99, `content ${uniq}`, `hash-${uniq}`],
      };
    case 'code_embeddings':
      return {
        cols: ['id', 'org_id', 'repository_id', 'ref_id', 'revision_sha', 'chunk_id', 'embedding', 'provider', 'model'],
        vals: [
          randomUUID(),
          orgId,
          seed.repoId,
          seed.repositoryRefId,
          shaLike(uniq),
          seed.codeChunkId,
          vectorLiteral(1024),
          'voyage',
          `voyage-xw-${uniq}`,
        ],
      };
  }
}

async function withTenantSession<T>(
  p: Pool,
  orgId: string | undefined,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE sayre_app');
    if (orgId !== undefined) {
      await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    }
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

async function requireAdminUrl(): Promise<string | undefined> {
  try {
    return await getSecret('env://DATABASE_ADMIN_URL');
  } catch (error) {
    if (error instanceof SecretNotFoundError) return undefined;
    throw error;
  }
}

const adminUrl = await requireAdminUrl();
if (!adminUrl) {
  // eslint-disable-next-line no-console
  console.warn(
    '[tenantIsolation.penetration] DATABASE_ADMIN_URL unreachable -- skipping real-Postgres tenant-isolation tests.',
  );
}

function withDatabaseName(connectionString: string, dbName: string): string {
  const u = new URL(connectionString);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function ensureTestDatabaseExists(url: string, dbName: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}

describe.skipIf(!adminUrl)('Postgres RLS with the app-layer filter removed (all 13 tenant tables)', () => {
  let pool: Pool;
  let db: Db;
  let orgA: SeededOrg;
  let orgB: SeededOrg;
  let idsA: Record<TableName, string>;
  let idsB: Record<TableName, string>;

  beforeAll(async () => {
    const dbName = getConfig('TENANT_ISOLATION_TESTER_DB_NAME');
    await ensureTestDatabaseExists(adminUrl!, dbName);
    const testDbUrl = withDatabaseName(adminUrl!, dbName);

    const migratePool = createPool(testDbUrl);
    try {
      await migrate(createDb(migratePool), { migrationsFolder: './drizzle' });
    } finally {
      await migratePool.end();
    }

    pool = createPool(testDbUrl);
    db = createDb(pool);
    await pool.query('TRUNCATE organizations CASCADE');
    orgA = await seedOrg(pool, 'A');
    orgB = await seedOrg(pool, 'B');
    idsA = idsByTable(orgA);
    idsB = idsByTable(orgB);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('TRUNCATE organizations CASCADE');
      await pool.end();
    }
  });

  it('a filter-less SELECT (no WHERE clause at all) under org A returns only org A rows, across all 13 tables', async () => {
    await withTenantSession(pool, orgA.orgId, async (c) => {
      for (const table of TABLE_NAMES) {
        const own = await c.query(`SELECT id FROM ${table}`);
        expect(own.rowCount, `${table}: expected exactly 1 row (own)`).toBe(1);
        expect(own.rows[0].id).toBe(idsA[table]);

        const cross = await c.query(`SELECT id FROM ${table} WHERE id = $1`, [idsB[table]]);
        expect(cross.rowCount, `${table}: org A must not see org B's row even by direct PK`).toBe(0);
      }
    });
  });

  it('cross-org INSERT (org_id = B) under context A is rejected with a row-level security error, across all 12 non-organizations tables', async () => {
    const tables = TABLE_NAMES.filter((t): t is Exclude<TableName, 'organizations'> => t !== 'organizations');
    for (const table of tables) {
      const { cols, vals } = buildInsertRow(table, orgB.orgId, orgA, `xw-${table}-${randomUUID().slice(0, 8)}`);
      await withTenantSession(pool, orgA.orgId, async (c) => {
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        await expect(
          c.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, vals),
        ).rejects.toThrow(/row-level security/i);
      });
    }
  });

  it('unset app.org_id yields zero rows across all 13 tables (fail-closed)', async () => {
    await withTenantSession(pool, undefined, async (c) => {
      for (const table of TABLE_NAMES) {
        const res = await c.query(`SELECT id FROM ${table}`);
        expect(res.rowCount, `${table}: expected 0 rows with no org context`).toBe(0);
      }
    });
  });

  it('a valid-but-nonexistent org UUID yields zero rows across all 13 tables (fail-closed for unknown org)', async () => {
    const unknownOrg = randomUUID();
    await withTenantSession(pool, unknownOrg, async (c) => {
      for (const table of TABLE_NAMES) {
        const res = await c.query(`SELECT id FROM ${table}`);
        expect(res.rowCount, `${table}: unknown org must see 0 rows`).toBe(0);
      }
    });
  });

  // --- (d) pgvector-specific: code_chunks/code_embeddings org-scoped, even
  //     via the real withOrgContext application path (not just raw pool +
  //     manual SET LOCAL ROLE), reused with NO WHERE clause at all.

  it('withOrgContext(orgA) on a WHERE-clause-free query against code_chunks/code_embeddings returns zero org-B rows', async () => {
    const chunkRows = await withOrgContext(db, orgA.orgId, async (tx) => {
      const r = await tx.execute(sql.raw('select id from code_chunks'));
      return (r as unknown as { rows: Array<{ id: string }> }).rows;
    });
    expect(chunkRows).toEqual([{ id: orgA.codeChunkId }]);

    const embeddingRows = await withOrgContext(db, orgA.orgId, async (tx) => {
      const r = await tx.execute(sql.raw('select id from code_embeddings'));
      return (r as unknown as { rows: Array<{ id: string }> }).rows;
    });
    expect(embeddingRows).toEqual([{ id: orgA.codeEmbeddingId }]);
  });

  it('graph_node_id collision across orgs stays strictly separated (composite org_id scoping, never merged)', async () => {
    const sharedGraphNodeId = `shared-node-${randomUUID()}`;
    await pool.query('UPDATE code_chunks SET graph_node_id = $1 WHERE id = $2', [
      sharedGraphNodeId,
      orgA.codeChunkId,
    ]);
    // Insert a second chunk for org B with the SAME graph_node_id string.
    const orgBChunkId = randomUUID();
    await pool.query(
      'INSERT INTO code_chunks (id, org_id, repository_id, ref_id, revision_sha, graph_node_id, chunk_index, content, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        orgBChunkId,
        orgB.orgId,
        orgB.repoId,
        orgB.repositoryRefId,
        shaLike('collision'),
        sharedGraphNodeId,
        1,
        'org B content sharing a graph_node_id string with org A',
        `hash-collision-${orgBChunkId}`,
      ],
    );

    await withTenantSession(pool, orgA.orgId, async (c) => {
      const res = await c.query('SELECT id, org_id FROM code_chunks WHERE graph_node_id = $1', [
        sharedGraphNodeId,
      ]);
      expect(res.rowCount).toBe(1);
      expect(res.rows[0].id).toBe(orgA.codeChunkId);
      expect(res.rows[0].org_id).toBe(orgA.orgId);
    });

    await pool.query('UPDATE code_chunks SET graph_node_id = NULL WHERE id = $1', [orgA.codeChunkId]);
    await pool.query('DELETE FROM code_chunks WHERE id = $1', [orgBChunkId]);
  });
});
