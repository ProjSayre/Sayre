import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpKeyAuthenticationError,
  type ResolvedMcpCredential,
} from '../services/mcpKeyService';
import { createMcpGatewayRouter } from './gateway';
import type { McpToolMeasurement } from './metrics';
import {
  McpRateLimitError,
  type McpRateLimiter,
} from './rateLimit';
import type { McpToolServices } from './toolServices';

const TOKEN =
  'mcp_live_0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const CREDENTIAL: ResolvedMcpCredential = {
  context: {
    subjectType: 'agent_key',
    agentKeyId: 'mcp_live_0123456789abcdef',
    orgId: '11111111-1111-4111-8111-111111111111',
    roles: ['member'],
  },
  keyId: '22222222-2222-4222-8222-222222222222',
  keyPrefix: 'mcp_live_0123456789abcdef',
  rateLimitPerMinute: 60,
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

async function startGateway(
  services: McpToolServices,
  options: {
    limiter?: McpRateLimiter;
    measurements?: McpToolMeasurement[];
    resolveCredential?: (token: string) => Promise<ResolvedMcpCredential>;
  } = {},
): Promise<URL> {
  const app = express();
  app.use(express.json());
  app.use(
    createMcpGatewayRouter({
      services,
      allowedOrigins: () => [],
      resolveCredential:
        options.resolveCredential ??
        vi.fn(async (token: string) => {
          expect(token).toBe(TOKEN);
          return CREDENTIAL;
        }),
      execution: {
        limiter:
          options.limiter ??
          ({ consume: vi.fn() } satisfies McpRateLimiter),
        record: (measurement) => options.measurements?.push(measurement),
      },
    }),
  );
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

function fixtureServices(): McpToolServices {
  const result = (tool: string, value: unknown) =>
    Promise.resolve({ tool, value });
  return {
    findRelevantNodes: vi.fn((query) => result('find_relevant_nodes', query)),
    traverseFrom: vi.fn((nodeId, intent) =>
      result('traverse_from', { nodeId, intent }),
    ),
    getNodeContext: vi.fn((nodeId) =>
      Promise.resolve(
        nodeId === 'hidden'
          ? null
          : { tool: 'get_node_context', value: nodeId },
      ),
    ),
    getAgentSkillMd: vi.fn((nodeId) =>
      result('get_agent_skill_md', nodeId),
    ),
    getStyleRules: vi.fn((nodeId) => result('get_style_rules', nodeId)),
    getCoveringTests: vi.fn((nodeId) =>
      result('get_covering_tests', nodeId),
    ),
    getFeatureCluster: vi.fn((nodeId) =>
      result('get_feature_cluster', nodeId),
    ),
    getRecentChanges: vi.fn((nodeId) =>
      result('get_recent_changes', nodeId),
    ),
  };
}

function responseData(result: Awaited<ReturnType<Client['callTool']>>): unknown {
  const content = result.content[0];
  if (!content || content.type !== 'text') throw new Error('missing text result');
  return JSON.parse(content.text) as unknown;
}

describe('read-only MCP Streamable HTTP gateway', () => {
  it('serves every v1 tool through the official client and meters every call', async () => {
    const measurements: McpToolMeasurement[] = [];
    const services = fixtureServices();
    const url = await startGateway(services, { measurements });
    const client = new Client({ name: 'gateway-test', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    });
    await client.connect(transport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [
        'find_relevant_nodes',
        'get_agent_skill_md',
        'get_covering_tests',
        'get_feature_cluster',
        'get_node_context',
        'get_recent_changes',
        'get_style_rules',
        'traverse_from',
      ].sort(),
    );
    expect(listed.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(
      true,
    );

    const calls = [
      ['find_relevant_nodes', { query: 'authentication' }],
      ['traverse_from', { node_id: 'file-1', intent: 'change auth' }],
      ['get_node_context', { node_id: 'file-1' }],
      ['get_agent_skill_md', { node_id: 'file-1' }],
      ['get_style_rules', { node_id: 'file-1' }],
      ['get_covering_tests', { node_id: 'file-1' }],
      ['get_feature_cluster', { node_id: 'file-1' }],
      ['get_recent_changes', { node_id: 'file-1' }],
    ] as const;
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      expect(responseData(result)).toEqual({
        data: expect.objectContaining({ tool: name }),
      });
    }

    const hidden = await client.callTool({
      name: 'get_node_context',
      arguments: { node_id: 'hidden' },
    });
    expect(responseData(hidden)).toEqual({ data: null });
    expect(measurements).toHaveLength(9);
    expect(measurements.every((entry) => entry.outcome === 'ok')).toBe(true);
    expect(
      measurements.every(
        (entry) =>
          entry.orgId === CREDENTIAL.context.orgId &&
          entry.keyPrefix === CREDENTIAL.keyPrefix,
      ),
    ).toBe(true);
    await client.close();
  });

  it('enforces the configured per-key limit inside tool dispatch', async () => {
    let consumed = 0;
    const limiter: McpRateLimiter = {
      consume: () => {
        consumed += 1;
        if (consumed > 1) {
          throw new McpRateLimitError();
        }
      },
    };
    const url = await startGateway(fixtureServices(), { limiter });
    const client = new Client({ name: 'rate-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}` },
        },
      }),
    );
    const first = await client.callTool({
      name: 'get_node_context',
      arguments: { node_id: 'file-1' },
    });
    expect(first.isError).not.toBe(true);
    await expect(
      client.callTool({
        name: 'get_node_context',
        arguments: { node_id: 'file-1' },
      }),
    ).resolves.toMatchObject({ isError: true });
    await client.close();
  });

  it('returns a fixed unauthorized response without reflecting the token', async () => {
    const url = await startGateway(fixtureServices(), {
      resolveCredential: async () => {
        throw new McpKeyAuthenticationError();
      },
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bad-key', version: '1.0.0' },
        },
      }),
    });
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toContain('Unauthorized.');
    expect(text).not.toContain(TOKEN);
  });
});
