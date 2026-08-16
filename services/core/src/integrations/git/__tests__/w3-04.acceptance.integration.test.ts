// W3-04 gapfill. The literal acceptance sentence, both clauses, in one real (BullMQ +
// Neo4j) run, per spec.md's Approach step 11:
//   1. A merged PR changes real File node ownership/recent-edit properties in a real
//      graph inside the pinned GIT_SYNC_TARGET_MS sync target (AC-5).
//   2. The mock `fakehub` provider is registrable purely through GIT_PROVIDER_CATALOG
//      configuration + startGitSyncWorker's default dependency wiring — NO `providers`
//      override, and no edit to worker.ts (AC-9, AC-11).
//
// INTEGRATION test: requires BOTH Redis (REDIS_HOST/REDIS_PORT) and Neo4j
// (NEO4J_URI/NEO4J_USER + the NEO4J_PASSWORD secret) reachable. Skips locally when
// either is unreachable; CI sets MESSAGING_INTEGRATION_REQUIRED=true and
// GRAPH_INTEGRATION_REQUIRED=true, which turn an unreachable broker/store into a hard
// failure, following src/queue/__tests__/bullmq.roundtrip.test.ts:216's exact pattern.
//
// GRAPH_INTEGRATION_REQUIRED / GIT_PROVIDER_CATALOG are not yet registered config names
// (GAP-6 adds them) — read via a helper that degrades to a safe default on ConfigError
// rather than crashing test collection, so this file needs no edit once they land.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import IORedis from 'ioredis';
import neo4j, { type Driver, type Session } from 'neo4j-driver';
import {
  ConfigError,
  getConfig,
  getSecret,
  resetConfigForTests,
  SecretNotFoundError,
  setConfigOverrideForTests,
} from '@sayre/config';
import { makeEnvelope } from '../../../queue/envelope';
import { enqueue, closeQueues } from '../../../queue/bullmq';
import { startGitSyncWorker } from '../worker';
import { PostgresGitRepositoryResolver } from '../repositoryResolver';
import { Neo4jOwnershipGraphStore } from '../graphOwnershipStore';
import type { ProviderRepoEvent } from '../types';

function optionalBoolConfig(name: string): boolean {
  try {
    return getConfig(name as never) === 'true';
  } catch (error) {
    if (error instanceof ConfigError) return false;
    throw error;
  }
}

async function redisReachable(): Promise<boolean> {
  let password: string | undefined;
  try {
    password = await getSecret('env://REDIS_PASSWORD');
  } catch (error) {
    if (!(error instanceof SecretNotFoundError)) throw error;
  }
  const conn = new IORedis({
    host: getConfig('REDIS_HOST'),
    port: Number(getConfig('REDIS_PORT')),
    password,
    maxRetriesPerRequest: 0,
    connectTimeout: 2000,
    lazyConnect: true,
    retryStrategy: () => null,
  });
  conn.on('error', () => {});
  try {
    await conn.connect();
    await conn.ping();
    return true;
  } catch {
    return false;
  } finally {
    conn.disconnect();
  }
}

async function neo4jReachable(): Promise<Driver | null> {
  let password: string;
  try {
    password = await getSecret('env://NEO4J_PASSWORD');
  } catch {
    return null;
  }
  const driver = neo4j.driver(getConfig('NEO4J_URI'), neo4j.auth.basic(getConfig('NEO4J_USER'), password));
  try {
    await driver.verifyConnectivity();
    return driver;
  } catch {
    await driver.close();
    return null;
  }
}

const messagingRequired = optionalBoolConfig('MESSAGING_INTEGRATION_REQUIRED');
const graphRequired = optionalBoolConfig('GRAPH_INTEGRATION_REQUIRED');
const redisUp = await redisReachable();
const neo4jDriver = await neo4jReachable();
const bothUp = redisUp && neo4jDriver !== null;

if (!redisUp && messagingRequired) {
  throw new Error(
    `[w3-04.acceptance.integration] Redis is required but unreachable at ${getConfig('REDIS_HOST')}:${getConfig('REDIS_PORT')}.`,
  );
}
if (!neo4jDriver && graphRequired) {
  throw new Error(
    `[w3-04.acceptance.integration] Neo4j is required but unreachable at ${getConfig('NEO4J_URI')}.`,
  );
}
if (!bothUp) {
  // eslint-disable-next-line no-console
  console.warn(
    '[w3-04.acceptance.integration] Redis and/or Neo4j unreachable — skipping the W3-04 acceptance test.',
  );
}

describe.skipIf(!bothUp)('W3-04 acceptance: merged PR -> configured-provider -> real graph, under budget', () => {
  const orgId = `org-${randomUUID()}`;
  const repositoryId = `repo-${randomUUID()}`;
  let session: Session;
  // A Neo4j Session is not safe for concurrent use: the worker's own writes (running
  // async, driven by the BullMQ job) and this test's polling reads happen concurrently
  // once the event is enqueued below, so they need separate sessions on the same driver
  // — sharing one `Session` between them threw a genuine Neo4jError under real
  // concurrency, reproduced locally before this fix.
  let graphSession: Session;

  beforeAll(async () => {
    session = neo4jDriver!.session();
    graphSession = neo4jDriver!.session();
  });

  afterAll(async () => {
    await session.executeWrite((tx) =>
      tx.run('MATCH (n) WHERE n.org_id = $org_id DETACH DELETE n', { org_id: orgId }),
    );
    await session.close();
    await graphSession.close();
    await neo4jDriver!.close();
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG' as never, undefined);
    resetConfigForTests();
    await closeQueues();
  });

  // @spec AC-5 AC-9 AC-11 EC-26
  it('a fakehub merged-PR event, enqueued after GIT_PROVIDER_CATALOG selects fakehub, updates a real File node within GIT_SYNC_TARGET_MS — no `providers` override, no worker.ts edit', async () => {
    const { GIT_SYNC_TARGET_MS } = await import('../budgets');
    setConfigOverrideForTests('GIT_PROVIDER_CATALOG' as never, '[{"provider":"fakehub"}]');

    // Seed the File node the way the real system would: via the Python ingestion
    // writer's own query text (same helper as ownershipGraph.integration.test.ts),
    // duplicated inline here to keep this acceptance file independently runnable.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const graphPyPath = resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      'workers',
      'sayre_workers',
      'ingestion',
      'graph.py',
    );
    const fileQueryMatch = /"File":\s*"""([\s\S]*?)"""/.exec(readFileSync(graphPyPath, 'utf8'));
    if (!fileQueryMatch) throw new Error('Could not locate File query in ingestion/graph.py');
    const refName = 'refs/heads/main';
    await session.executeWrite((tx) =>
      tx.run(fileQueryMatch[1], {
        org_id: orgId,
        repo_id: repositoryId,
        ref_name: refName,
        revision_sha: 'a'.repeat(40),
        items: [
          {
            uid: `${orgId}:${repositoryId}:${refName}:src/acceptance.ts`,
            path: 'src/acceptance.ts',
            name: 'acceptance.ts',
            language: 'typescript',
            last_structural_change_at: null,
          },
        ],
      }),
    );

    const graph = new Neo4jOwnershipGraphStore({
      run: async (_orgId, cypher, parameters) => {
        const result = await graphSession.executeWrite((tx) => tx.run(cypher, parameters));
        return { records: result.records };
      },
      close: async () => undefined,
    });
    const repositories: InstanceType<typeof PostgresGitRepositoryResolver> = {
      resolve: async () => ({ repositoryId }),
    };

    // AC-9/AC-11: NO `providers` override — startGitSyncWorker must resolve the
    // fakehub adapter purely from GIT_PROVIDER_CATALOG via loadGitProviderRegistry().
    const runtime = await startGitSyncWorker({ repositories, graph } as never);

    try {
      const event: ProviderRepoEvent = {
        provider: 'fakehub',
        type: 'pull_request',
        repo: { provider_repo_id: 'fake-1', full_name: 'acme/repo', repo_id: null },
        ref: refName,
        installation_id: 'fake-installation',
        delivery_id: `delivery-${randomUUID()}`,
        payload: {
          action: 'merged',
          pull_request: {
            number: 21,
            title: 'Ship acceptance',
            url: 'https://fakehub.test/pr/21',
            merged_at: new Date().toISOString(),
            merge_commit_sha: `merge-${randomUUID()}`,
            base_ref: 'main',
            author: { login: 'fake-user', name: 'Fake User', email: 'fake@example.test' },
            files: ['src/acceptance.ts'],
          },
        },
      };
      const envelope = makeEnvelope({
        org_id: orgId,
        type: 'repo.pull_request',
        source: 'fakehub-webhook',
        payload: event,
      });

      const enqueuedAt = performance.now();
      await enqueue('github-sync', envelope);

      // Poll until the File node's ownership metadata reflects the merge, or budget-plus-slack elapses.
      let updated = false;
      let elapsedMs = 0;
      while (!updated && elapsedMs < GIT_SYNC_TARGET_MS * 2) {
        const result = await session.executeRead((tx) =>
          tx.run(
            'MATCH (f:File {org_id: $org_id, repo_id: $repo_id, ref_name: $ref_name, path: $path}) RETURN f',
            { org_id: orgId, repo_id: repositoryId, ref_name: refName, path: 'src/acceptance.ts' },
          ),
        );
        const props = result.records[0]?.get('f')?.properties;
        if (props?.recent_pr_number === 21) {
          updated = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        elapsedMs = performance.now() - enqueuedAt;
      }

      expect(updated, 'the File node never reflected the fakehub merged-PR event').toBe(true);
      expect(elapsedMs).toBeLessThan(GIT_SYNC_TARGET_MS);
    } finally {
      await runtime.close();
    }
  });
});
