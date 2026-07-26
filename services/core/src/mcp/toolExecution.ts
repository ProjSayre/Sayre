import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ResolvedMcpCredential } from '../services/mcpKeyService';
import {
  recordMcpToolMeasurement,
  type McpToolMeasurement,
} from './metrics';
import {
  McpRateLimitError,
  mcpRateLimiter,
  type McpRateLimiter,
} from './rateLimit';

export interface McpExecutionDeps {
  limiter: McpRateLimiter;
  record: (measurement: McpToolMeasurement) => void;
}

function textResult(text: string, isError = false): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function executeMcpTool(
  tool: string,
  credential: ResolvedMcpCredential,
  operation: () => Promise<unknown>,
  deps: McpExecutionDeps,
): Promise<CallToolResult> {
  let responseText = '';
  let outcome: McpToolMeasurement['outcome'] = 'error';
  try {
    deps.limiter.consume(
      credential.context.orgId,
      credential.keyPrefix,
      credential.rateLimitPerMinute,
    );
    const result = await operation();
    responseText = JSON.stringify({ data: result });
    outcome = 'ok';
    return textResult(responseText);
  } catch (error) {
    if (error instanceof McpRateLimitError) {
      responseText = 'MCP rate limit exceeded.';
      outcome = 'rate_limited';
      return textResult(responseText, true);
    }
    // Do not reflect database, graph, provider, or validation details to an
    // external agent. Operators retain traces/metrics through internal paths.
    responseText = 'MCP tool execution failed.';
    return textResult(responseText, true);
  } finally {
    deps.record({
      orgId: credential.context.orgId,
      keyPrefix: credential.keyPrefix,
      tool,
      outcome,
      responseText,
    });
  }
}

export const defaultMcpExecutionDeps: McpExecutionDeps = {
  limiter: mcpRateLimiter,
  record: recordMcpToolMeasurement,
};
