import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { getConfig } from '@sayre/config';
import { z } from 'zod';
import {
  McpKeyAuthenticationError,
  resolveMcpCredential,
  type ResolvedMcpCredential,
} from '../services/mcpKeyService';
import { getAgentSkillMdHandler } from './handlers/getAgentSkillMd';
import { getCoveringTestsHandler } from './handlers/getCoveringTests';
import { getFeatureClusterHandler } from './handlers/getFeatureCluster';
import { getNodeContextHandler } from './handlers/getNodeContext';
import { getRecentChangesHandler } from './handlers/getRecentChanges';
import { getStyleRulesHandler } from './handlers/getStyleRules';
import { findRelevantNodesHandler } from './handlers/findRelevantNodes';
import { traverseFromHandler } from './handlers/traverseFrom';
import {
  defaultMcpExecutionDeps,
  executeMcpTool,
  type McpExecutionDeps,
} from './toolExecution';
import {
  mcpToolServices,
  type McpToolServices,
} from './toolServices';

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;
const NODE_ID = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !value.includes('\0'));
const QUERY = z
  .string()
  .min(1)
  .max(2_000)
  .refine((value) => value.trim().length > 0 && !value.includes('\0'));
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface McpGatewayDeps {
  resolveCredential: (token: string) => Promise<ResolvedMcpCredential>;
  services: McpToolServices;
  execution: McpExecutionDeps;
  allowedOrigins: () => readonly string[];
}

function parseAllowedOrigins(): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(getConfig('MCP_ALLOWED_ORIGINS'));
  } catch {
    throw new Error('MCP_ALLOWED_ORIGINS must be a JSON array.');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (value) =>
        typeof value !== 'string' ||
        (!value.startsWith('https://') &&
          !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(value)),
    )
  ) {
    throw new Error('MCP_ALLOWED_ORIGINS contains an invalid origin.');
  }
  return [...new Set(parsed)];
}

const defaultDeps: McpGatewayDeps = {
  resolveCredential: resolveMcpCredential,
  services: mcpToolServices,
  execution: defaultMcpExecutionDeps,
  allowedOrigins: parseAllowedOrigins,
};

function jsonRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
): void {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function bearerToken(req: Request): string {
  const match = BEARER_RE.exec(req.headers.authorization?.trim() ?? '');
  if (!match?.[1]) throw new McpKeyAuthenticationError();
  return match[1];
}

function originAllowed(req: Request, allowed: readonly string[]): boolean {
  const origin = req.headers.origin;
  return origin === undefined || (typeof origin === 'string' && allowed.includes(origin));
}

function createServer(
  credential: ResolvedMcpCredential,
  deps: McpGatewayDeps,
): McpServer {
  const server = new McpServer(
    { name: 'sayre-graph-context', version: '1.0.0' },
    {
      instructions:
        'Read-only, server-authorized context from the Sayre graph. Missing or hidden nodes return null/empty data.',
    },
  );
  const execute = (tool: string, operation: () => Promise<unknown>) =>
    executeMcpTool(tool, credential, operation, deps.execution);

  server.registerTool(
    'find_relevant_nodes',
    {
      description:
        'Find authorized Folder/File nodes relevant to a natural-language query.',
      inputSchema: { query: QUERY },
      annotations: READ_ONLY,
    },
    ({ query }) =>
      execute('find_relevant_nodes', () =>
        findRelevantNodesHandler(query, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'traverse_from',
    {
      description:
        'Traverse an authorized, bounded graph neighborhood from a Folder/File node.',
      inputSchema: { node_id: NODE_ID, intent: QUERY },
      annotations: READ_ONLY,
    },
    ({ node_id, intent }) =>
      execute('traverse_from', () =>
        traverseFromHandler(
          node_id,
          intent,
          credential.context,
          deps.services,
        ),
      ),
  );
  server.registerTool(
    'get_node_context',
    {
      description:
        'Get the authorized sidebar metadata snapshot for a Folder/File node.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_node_context', () =>
        getNodeContextHandler(node_id, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'get_agent_skill_md',
    {
      description:
        'Get the latest immutable Agent/Skill Markdown for an authorized node.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_agent_skill_md', () =>
        getAgentSkillMdHandler(node_id, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'get_style_rules',
    {
      description:
        'Resolve inherited coding and comment style rules for an authorized node.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_style_rules', () =>
        getStyleRulesHandler(node_id, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'get_covering_tests',
    {
      description:
        'Get authorized COVERS-linked tests with pass/fail and freshness status.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_covering_tests', () =>
        getCoveringTestsHandler(node_id, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'get_feature_cluster',
    {
      description:
        'Get authorized product feature-cluster metadata attached to a node.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_feature_cluster', () =>
        getFeatureClusterHandler(node_id, credential.context, deps.services),
      ),
  );
  server.registerTool(
    'get_recent_changes',
    {
      description:
        'Get recent authorized commit/ownership metadata for a node.',
      inputSchema: { node_id: NODE_ID },
      annotations: READ_ONLY,
    },
    ({ node_id }) =>
      execute('get_recent_changes', () =>
        getRecentChangesHandler(node_id, credential.context, deps.services),
      ),
  );
  return server;
}

export function createMcpGatewayRouter(
  overrides: Partial<McpGatewayDeps> = {},
): Router {
  const deps = { ...defaultDeps, ...overrides };
  const router = Router();

  router.post('/mcp', async (req, res) => {
    const allowedOrigins = deps.allowedOrigins();
    if (!originAllowed(req, allowedOrigins)) {
      jsonRpcError(res, 403, -32001, 'Origin not allowed.');
      return;
    }

    let credential: ResolvedMcpCredential;
    try {
      credential = await deps.resolveCredential(bearerToken(req));
    } catch (error) {
      if (error instanceof McpKeyAuthenticationError) {
        jsonRpcError(res, 401, -32001, 'Unauthorized.');
        return;
      }
      jsonRpcError(res, 500, -32603, 'Internal server error.');
      return;
    }

    const server = createServer(credential, deps);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      allowedOrigins: [...allowedOrigins],
      enableDnsRebindingProtection: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
    } catch {
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, 'Internal server error.');
      }
      await transport.close();
      await server.close();
    }
  });

  router.get('/mcp', (_req, res) => {
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
  });
  router.delete('/mcp', (_req, res) => {
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
  });
  return router;
}

export const mcpGatewayRouter = createMcpGatewayRouter();
