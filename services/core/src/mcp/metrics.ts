import {
  metrics,
  type Counter,
  type MeterProvider,
} from '@opentelemetry/api';

export const MCP_TOOL_CALL_COUNT = 'mcp_tool_call_count';
export const MCP_CONTEXT_TOKENS_SERVED = 'mcp_context_tokens_served';

interface Instruments {
  calls: Counter;
  contextTokens: Counter;
}

let cachedProvider: MeterProvider | null = null;
let cachedInstruments: Instruments | null = null;

function instruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cachedInstruments === null || cachedProvider !== provider) {
    const meter = provider.getMeter('sayre.core.mcp');
    cachedInstruments = {
      calls: meter.createCounter(MCP_TOOL_CALL_COUNT),
      contextTokens: meter.createCounter(MCP_CONTEXT_TOKENS_SERVED),
    };
    cachedProvider = provider;
  }
  return cachedInstruments;
}

export interface McpToolMeasurement {
  orgId: string;
  keyPrefix: string;
  tool: string;
  outcome: 'ok' | 'error' | 'rate_limited';
  responseText: string;
}

export function estimateContextTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

export function recordMcpToolMeasurement(
  measurement: McpToolMeasurement,
): void {
  const attributes = {
    org_id: measurement.orgId,
    key_id: measurement.keyPrefix,
    tool: measurement.tool,
    outcome: measurement.outcome,
  };
  const meter = instruments();
  meter.calls.add(1, attributes);
  meter.contextTokens.add(
    estimateContextTokens(measurement.responseText),
    attributes,
  );
}

export function resetMcpMetricsForTests(): void {
  cachedProvider = null;
  cachedInstruments = null;
}
