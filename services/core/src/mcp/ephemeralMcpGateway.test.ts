// CH-01 red suite — the end-to-end half of AC-1/AC-2/AC-3: a token produced by
// `mintEphemeralMcpCredential` presented to the REAL gateway router with the
// REAL `resolveMcpCredential`, and the unauthorized-response parity that leaves
// no expired-vs-unknown oracle.
//
// Kept out of gateway.test.ts on purpose: spec.md assigns `dev` a mechanical
// fixture update to that file (CREDENTIAL gains `kind`/`meteringSubject`), and a
// red-listed file that `dev` is also expected to edit would collide with the
// red-test integrity rehash. Nothing here needs a database — the key store and
// the ephemeral credential store are both injected fakes.

import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../auth/context';
import type {
  EphemeralMcpCredentialStore,
  StoreEphemeralMcpCredentialInput,
} from '../db/ephemeralMcpCredentialStore';
import type { McpKeyLookup, McpKeyStore } from '../db/mcpKeyStore';
import type { PermissionStore } from '../graph-query/permissions';
import { mintEphemeralMcpCredential } from '../services/ephemeralMcpCredentialService';
import { resolveMcpCredential } from '../services/mcpKeyService';
import { createMcpGatewayRouter } from './gateway';
import type { McpToolMeasurement } from './metrics';
import type { McpRateLimiter } from './rateLimit';
import type { McpToolServices } from './toolServices';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const REPO = '33333333-3333-4333-8333-333333333333';
const KEY_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-10T12:00:00.000Z');
const PEPPER = 'pepper-value';
const PEPPER_VERSION = 7;
const UNAUTHORIZED_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized."},"id":null}';

const MEMBER: AuthContext = {
  subjectType: 'user',
  userId: USER,
  orgId: ORG,
  roles: ['member'],
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

interface Fixture {
  url: URL;
  token: string;
  keyPrefix: string;
  contexts: AuthContext[];
  measurements: McpToolMeasurement[];
  setClock: (value: Date) => void;
  forgetRow: () => void;
}

function services(
  contexts: AuthContext[],
  empty: boolean,
): McpToolServices {
  const capture = <T>(value: T) => async (...args: unknown[]) => {
    contexts.push(args.at(-1) as AuthContext);
    return value;
  };
  return {
    findRelevantNodes: capture(empty ? [] : [{ id: 'file-1' }]),
    traverseFrom: capture(empty ? [] : [{ id: 'file-1' }]),
    getNodeContext: capture(empty ? null : { id: 'file-1' }),
    getAgentSkillMd: capture(empty ? null : { markdown: '# skill' }),
    getStyleRules: capture(empty ? [] : [{ rule: 'no-any' }]),
    getCoveringTests: capture(empty ? [] : [{ id: 'test-1' }]),
    getFeatureCluster: capture(empty ? null : { id: 'feature-1' }),
    getRecentChanges: capture(empty ? null : { id: 'commit-1' }),
    checkLiveness: capture(empty ? null : { imported: true }),
  };
}

async function mintAndServe(
  options: { emptyScope?: boolean } = {},
): Promise<Fixture> {
  const captured: StoreEphemeralMcpCredentialInput[] = [];
  const store: EphemeralMcpCredentialStore = {
    issue: vi.fn(async (_orgId: string, input: StoreEphemeralMcpCredentialInput) => {
      captured.push(input);
      return {
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
    }),
    listByConversation: vi.fn(async () => []),
    deleteExpired: vi.fn(async () => 0),
    getActorLabel: vi.fn(async () => 'Ada Lovelace'),
  };
  const permissions: PermissionStore = {
    getReadScope: vi.fn(async () =>
      options.emptyScope
        ? { allows: [], denies: [] }
        : {
            allows: [{ repoId: REPO, branch: null, pathPrefix: 'src' }],
            denies: [],
          },
    ),
  };

  const minted = await mintEphemeralMcpCredential({ conversationId: CONVERSATION }, MEMBER, {
    store,
    permissions,
    getPepper: async () => PEPPER,
    getPepperVersion: () => PEPPER_VERSION,
    now: () => NOW,
    randomSecret: () => Buffer.alloc(32, 5),
    randomPrefixBytes: () => Buffer.alloc(8, 0xab),
  });

  const input = captured[0] as StoreEphemeralMcpCredentialInput;
  let row: McpKeyLookup | null = {
    id: KEY_ID,
    orgId: ORG,
    keyPrefix: input.keyPrefix,
    keyHmac: input.keyHmac,
    pepperVersion: input.pepperVersion,
    expiresAt: input.expiresAt,
    revokedAt: null,
    createdBy: input.createdBy,
    rateLimitPerMinute: 60,
    kind: 'chat_ephemeral',
    conversationId: input.conversationId,
  } as McpKeyLookup;
  let clock = NOW;

  const keyStore: McpKeyStore = {
    resolve: vi.fn(async (keyPrefix: string) =>
      row && row.keyPrefix === keyPrefix ? row : null,
    ),
    list: vi.fn(async () => []),
    issue: vi.fn(async () => {
      throw new Error('not used');
    }),
    revoke: vi.fn(async () => null),
    markUsed: vi.fn(async () => true),
    getRateLimit: vi.fn(async () => 60),
    setRateLimit: vi.fn(async (_orgId, value: number) => value),
    getActorLabel: vi.fn(async () => 'Ada Lovelace'),
  };

  const contexts: AuthContext[] = [];
  const measurements: McpToolMeasurement[] = [];
  const app = express();
  app.use(express.json());
  app.use(
    createMcpGatewayRouter({
      services: services(contexts, options.emptyScope === true),
      allowedOrigins: () => [],
      // The REAL resolver — only its store/clock/pepper dependencies are faked.
      resolveCredential: (token: string) =>
        resolveMcpCredential(token, {
          store: keyStore,
          getPepper: async () => PEPPER,
          getPepperVersion: () => PEPPER_VERSION,
          now: () => clock,
        }),
      execution: {
        limiter: { consume: vi.fn() } satisfies McpRateLimiter,
        record: (measurement) => measurements.push(measurement),
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    url: new URL(`http://127.0.0.1:${address.port}/mcp`),
    token: minted.token,
    keyPrefix: minted.keyPrefix,
    contexts,
    measurements,
    setClock: (value: Date) => {
      clock = value;
    },
    forgetRow: () => {
      row = null;
    },
  };
}

function responseData(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('missing text result');
  return JSON.parse(content.text) as unknown;
}

async function initialize(url: URL, token: string): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'ch01', version: '1.0.0' },
      },
    }),
  });
}

describe('CH-01 ephemeral credential through the real MCP gateway', () => {
  // @spec AC-1 AC-2 AC-9
  it('authenticates a freshly minted chat token and serves a tool call as the issuer', async () => {
    const fixture = await mintAndServe();
    const client = new Client({ name: 'ch01-gateway', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(fixture.url, {
        requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
      }),
    );

    const result = await client.callTool({
      name: 'get_node_context',
      arguments: { node_id: 'file-1' },
    });
    expect(result.isError).not.toBe(true);
    expect(responseData(result)).toEqual({ data: { id: 'file-1' } });

    // AC-2 (c): the handler receives the agent_key context for this prefix, so
    // every existing tool enforces the issuer's scope with no handler change.
    expect(fixture.contexts.at(-1)).toEqual({
      subjectType: 'agent_key',
      agentKeyId: fixture.keyPrefix,
      orgId: ORG,
      roles: ['member'],
    });
    // AC-9: the metric/rate-limit subject is the stable per-user bucket.
    expect(fixture.measurements.at(-1)?.keyPrefix).toBe(`chat:${USER}`);
    expect(fixture.measurements.at(-1)?.orgId).toBe(ORG);
    await client.close();
  });

  // @spec AC-3 EC-1
  it('answers an expired token byte-identically to an entirely unknown one', async () => {
    const fixture = await mintAndServe();
    fixture.setClock(new Date(NOW.valueOf() + 300_000));
    const expired = await initialize(fixture.url, fixture.token);
    const expiredText = await expired.text();

    fixture.forgetRow();
    const unknown = await initialize(
      fixture.url,
      `mcp_chat_deadbeefdeadbeef.${'A'.repeat(43)}`,
    );
    const unknownText = await unknown.text();

    expect(expired.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(expiredText).toBe(UNAUTHORIZED_BODY);
    expect(unknownText).toBe(expiredText);
    expect(expired.headers.get('content-type')).toBe(
      unknown.headers.get('content-type'),
    );
    expect(expiredText).not.toContain(fixture.token);
    expect(expiredText).not.toContain(fixture.keyPrefix);
  });

  // @spec EC-12
  it('serves empty/null tool results for an issuer with an empty scope rather than an error', async () => {
    const fixture = await mintAndServe({ emptyScope: true });
    const client = new Client({ name: 'ch01-empty', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(fixture.url, {
        requestInit: { headers: { authorization: `Bearer ${fixture.token}` } },
      }),
    );

    const overlay = await client.callTool({
      name: 'get_node_context',
      arguments: { node_id: 'file-1' },
    });
    expect(overlay.isError).not.toBe(true);
    expect(responseData(overlay)).toEqual({ data: null });

    const found = await client.callTool({
      name: 'find_relevant_nodes',
      arguments: { query: 'authentication' },
    });
    expect(found.isError).not.toBe(true);
    expect(responseData(found)).toEqual({ data: [] });
    expect(fixture.measurements.every((entry) => entry.outcome === 'ok')).toBe(true);
    await client.close();
  });
});
