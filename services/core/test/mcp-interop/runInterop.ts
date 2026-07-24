import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  assertExactArguments,
  canonicalJson,
  V1_TOOL_CASES,
  V1_TOOL_NAMES,
  type FixtureScope,
} from './contract';
import type { InteropFixtureGateway } from './fixtureGateway';
import { OpenSourceMcpClient } from './mcpClient';
import type { ToolCallDriver } from './openAiCompatibleModel';

export interface InteropRecord {
  scope: FixtureScope;
  tool: string;
  arguments: Record<string, unknown>;
  result: unknown;
}

export interface InteropReport {
  tools: string[];
  scopes: FixtureScope[];
  matchedCalls: number;
  records: InteropRecord[];
}

function toolMap(tools: readonly Tool[]): Map<string, Tool> {
  const actual = tools.map((tool) => tool.name).sort();
  const expected = [...V1_TOOL_NAMES].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error('The gateway v1 tool inventory does not match the contract.');
  }
  if (
    tools.some(
      (tool) =>
        tool.annotations?.readOnlyHint !== true ||
        tool.annotations?.destructiveHint !== false,
    )
  ) {
    throw new Error('The gateway advertised a non-read-only v1 tool.');
  }
  return new Map(tools.map((tool) => [tool.name, tool]));
}

function assertScopeBoundary(records: readonly InteropRecord[]): void {
  const full = records.filter((record) => record.scope === 'full');
  const limited = records.filter((record) => record.scope === 'limited');
  if (full.length !== V1_TOOL_CASES.length || limited.length !== V1_TOOL_CASES.length) {
    throw new Error('The interop run did not cover every tool in both scopes.');
  }
  for (const record of full) {
    if (!canonicalJson(record.result).toLowerCase().includes('private')) {
      throw new Error(`Full-scope result for ${record.tool} lost fixture context.`);
    }
  }
  for (const record of limited) {
    if (canonicalJson(record.result).toLowerCase().includes('private')) {
      throw new Error(`Limited-scope result for ${record.tool} leaked hidden context.`);
    }
  }
}

export async function runInteropAgainstFixture(
  fixture: InteropFixtureGateway,
  driver: ToolCallDriver,
): Promise<InteropReport> {
  const records: InteropRecord[] = [];
  for (const scope of ['full', 'limited'] as const) {
    const localModelClient = await OpenSourceMcpClient.connect(
      fixture.endpoint,
      fixture.tokens[scope],
      `sayre-open-weight-${scope}`,
    );
    const protocolBaseline = await OpenSourceMcpClient.connect(
      fixture.endpoint,
      fixture.tokens[scope],
      `claude-code-equivalent-${scope}`,
    );
    try {
      const tools = toolMap(await localModelClient.tools());
      toolMap(await protocolBaseline.tools());
      for (const testCase of V1_TOOL_CASES) {
        const tool = tools.get(testCase.name);
        if (!tool) throw new Error(`Missing MCP tool ${testCase.name}.`);
        const selected = await driver.selectTool(testCase, tool);
        if (selected.name !== testCase.name) {
          throw new Error('The local model selected the wrong MCP tool.');
        }
        assertExactArguments(selected.arguments, testCase.arguments);
        const localResult = await localModelClient.call(
          selected.name,
          selected.arguments,
        );
        const baselineResult = await protocolBaseline.call(
          testCase.name,
          testCase.arguments,
        );
        if (canonicalJson(localResult) !== canonicalJson(baselineResult)) {
          throw new Error(
            `Local-model and protocol-baseline results differ for ${scope}/${testCase.name}.`,
          );
        }
        records.push({
          scope,
          tool: testCase.name,
          arguments: selected.arguments,
          result: localResult,
        });
      }
    } finally {
      await Promise.all([
        localModelClient.close(),
        protocolBaseline.close(),
      ]);
    }
  }
  assertScopeBoundary(records);
  return {
    tools: [...V1_TOOL_NAMES],
    scopes: ['full', 'limited'],
    matchedCalls: records.length,
    records,
  };
}
