import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { AuthContext } from '../../src/auth/context';
import { createMcpGatewayRouter } from '../../src/mcp/gateway';
import type { McpToolMeasurement } from '../../src/mcp/metrics';
import type { McpToolServices } from '../../src/mcp/toolServices';
import {
  McpKeyAuthenticationError,
  type ResolvedMcpCredential,
} from '../../src/services/mcpKeyService';
import type { FixtureScope } from './contract';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const FULL_PREFIX = 'mcp_live_aaaaaaaaaaaaaaaa';
const LIMITED_PREFIX = 'mcp_live_bbbbbbbbbbbbbbbb';
const TOKEN_SUFFIX = 'A'.repeat(43);

const PUBLIC_NODE = {
  id: 'file-public',
  label: 'File',
  name: 'public.ts',
  path: '/src/public.ts',
  repositoryId: '22222222-2222-4222-8222-222222222222',
  refName: 'refs/heads/main',
  revisionSha: 'fixture-revision',
  distance: 0,
} as const;

const PRIVATE_NODE = {
  id: 'file-private',
  label: 'File',
  name: 'private.ts',
  path: '/src/private.ts',
  repositoryId: PUBLIC_NODE.repositoryId,
  refName: PUBLIC_NODE.refName,
  revisionSha: PUBLIC_NODE.revisionSha,
  distance: 1,
} as const;

export const FIXTURE_TOKENS: Readonly<Record<FixtureScope, string>> = {
  full: `${FULL_PREFIX}.${TOKEN_SUFFIX}`,
  limited: `${LIMITED_PREFIX}.${TOKEN_SUFFIX}`,
};

function scopeFor(ctx: AuthContext): FixtureScope {
  if (ctx.subjectType !== 'agent_key') {
    throw new Error('The interoperability fixture accepts only agent keys.');
  }
  return ctx.agentKeyId === FULL_PREFIX ? 'full' : 'limited';
}

function visibleNodes(ctx: AuthContext) {
  return scopeFor(ctx) === 'full'
    ? [PUBLIC_NODE, PRIVATE_NODE]
    : [PUBLIC_NODE];
}

function canSeePrivate(ctx: AuthContext): boolean {
  return scopeFor(ctx) === 'full';
}

const fixtureServices: McpToolServices = {
  async findRelevantNodes(_query, ctx) {
    return visibleNodes(ctx);
  },
  async traverseFrom(nodeId, intent, ctx) {
    if (nodeId !== PUBLIC_NODE.id) return null;
    return {
      anchor: PUBLIC_NODE,
      intent,
      nodes: visibleNodes(ctx),
    };
  },
  async getNodeContext(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      authorization: 'server-filtered',
      node: PRIVATE_NODE,
      dependencies: [
        {
          id: PUBLIC_NODE.id,
          label: PUBLIC_NODE.label,
          name: PUBLIC_NODE.name,
          path: PUBLIC_NODE.path,
          relationship: 'IMPORTS',
          direction: 'outbound',
        },
      ],
      recentChanges: [],
      specificFeatures: [],
      agentSkillMd: null,
      description: 'Private billing implementation.',
      specificTickets: [],
    };
  },
  async getAgentSkillMd(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      nodeId: PRIVATE_NODE.id,
      repositoryId: PRIVATE_NODE.repositoryId,
      refName: PRIVATE_NODE.refName,
      document: {
        version: 3,
        content:
          '## Allowed Tools\n- Read\n\n## Required Context\n- Billing graph\n\n## Guardrails\n- Never expose tenant data\n',
      },
    };
  },
  async getStyleRules(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      nodeId: PRIVATE_NODE.id,
      codingStyle: {
        value: 'Prefer explicit result types.',
        sourceNodeId: 'folder-src',
      },
      commentStyle: {
        value: 'Explain invariants, not syntax.',
        sourceNodeId: 'folder-src',
      },
    };
  },
  async getCoveringTests(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      node: PRIVATE_NODE,
      tests: [
        {
          id: 'test-private',
          name: 'private.test.ts',
          path: '/tests/private.test.ts',
          coverageStatus: 'pass',
          edgeStatus: 'measured',
          lastRun: '2026-07-23T00:00:00.000Z',
          freshness: 'fresh',
        },
      ],
    };
  },
  async getFeatureCluster(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      node: PRIVATE_NODE,
      featureClusters: [
        {
          id: 'feature-private-billing',
          name: 'Private billing',
          description: 'Tenant-scoped billing internals.',
          team: 'Platform',
        },
      ],
    };
  },
  async getRecentChanges(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      node: PRIVATE_NODE,
      recentChanges: [
        {
          commitId: 'commit-private',
          sha: 'abc123',
          message: 'Tighten private billing authorization',
          timestamp: '2026-07-22T00:00:00.000Z',
          authorName: 'Fixture Author',
          authorLogin: 'fixture',
          pullRequestTitle: 'Private billing guard',
          pullRequestUrl: 'https://example.invalid/pr/1',
        },
      ],
    };
  },
  async checkLiveness(nodeId, ctx) {
    if (nodeId !== PRIVATE_NODE.id || !canSeePrivate(ctx)) return null;
    return {
      node: {
        id: PRIVATE_NODE.id,
        name: PRIVATE_NODE.name,
        path: PRIVATE_NODE.path,
      },
      liveness: 'imported_by_production',
      inbound: { production: 1, tests: 0 },
      productionImporters: [PUBLIC_NODE.path],
      testImporters: [],
      lastChangedAt: '2026-07-22T00:00:00.000Z',
    };
  },
};

function credentialFor(token: string): ResolvedMcpCredential {
  const scope =
    token === FIXTURE_TOKENS.full
      ? 'full'
      : token === FIXTURE_TOKENS.limited
        ? 'limited'
        : null;
  if (!scope) throw new McpKeyAuthenticationError();
  const prefix = scope === 'full' ? FULL_PREFIX : LIMITED_PREFIX;
  return {
    context: {
      subjectType: 'agent_key',
      agentKeyId: prefix,
      orgId: ORG_ID,
      roles: ['member'],
    },
    keyId:
      scope === 'full'
        ? '33333333-3333-4333-8333-333333333333'
        : '44444444-4444-4444-8444-444444444444',
    keyPrefix: prefix,
    rateLimitPerMinute: 10_000,
    kind: 'agent',
    meteringSubject: prefix,
  };
}

export interface InteropFixtureGateway {
  endpoint: URL;
  tokens: Readonly<Record<FixtureScope, string>>;
  measurements: McpToolMeasurement[];
  close(): Promise<void>;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

export async function startInteropFixtureGateway(): Promise<InteropFixtureGateway> {
  const measurements: McpToolMeasurement[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createMcpGatewayRouter({
      services: fixtureServices,
      resolveCredential: async (token) => credentialFor(token),
      allowedOrigins: () => [],
      execution: {
        limiter: { consume: () => undefined },
        record: (measurement) => measurements.push(measurement),
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    tokens: FIXTURE_TOKENS,
    measurements,
    close: () => closeServer(server),
  };
}
