import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { V1_TOOL_NAMES } from './contract';
import { startInteropFixtureGateway } from './fixtureGateway';
import { OpenAiCompatibleLocalModel } from './openAiCompatibleModel';
import { runInteropAgainstFixture } from './runInterop';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections?.();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startModelDouble(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (req, res) => {
    const body = req.body as {
      messages?: Array<{ content?: unknown }>;
      tool_choice?: { function?: { name?: unknown } };
    };
    const name = body.tool_choice?.function?.name;
    const prompt = body.messages?.[1]?.content;
    if (typeof name !== 'string' || typeof prompt !== 'string') {
      res.status(400).json({ error: 'invalid fixture request' });
      return;
    }
    const marker = 'Arguments (exact JSON): ';
    const markerIndex = prompt.indexOf(marker);
    if (markerIndex < 0) {
      res.status(400).json({ error: 'missing fixture arguments' });
      return;
    }
    const args = prompt.slice(markerIndex + marker.length);
    res.json({
      id: 'fixture-completion',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: `call-${name}`,
                type: 'function',
                function: { name, arguments: args },
              },
            ],
          },
        },
      ],
    });
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

describe('local-model MCP interoperability harness', () => {
  it('matches every v1 tool in full and limited scopes without hidden-node leakage', async () => {
    const fixture = await startInteropFixtureGateway();
    try {
      const report = await runInteropAgainstFixture(
        fixture,
        new OpenAiCompatibleLocalModel({
          baseUrl: await startModelDouble(),
          model: 'open-weight-fixture',
          timeoutMs: 5_000,
        }),
      );

      expect(report.tools).toEqual(V1_TOOL_NAMES);
      expect(report.scopes).toEqual(['full', 'limited']);
      expect(report.matchedCalls).toBe(16);
      expect(
        report.records.filter((record) => record.scope === 'limited'),
      ).toHaveLength(8);
      expect(fixture.measurements).toHaveLength(32);
      expect(
        fixture.measurements.every(
          (measurement) => measurement.outcome === 'ok',
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it('refuses a remote or credential-bearing model endpoint', () => {
    expect(
      () =>
        new OpenAiCompatibleLocalModel({
          baseUrl: 'https://models.example.com/v1',
          model: 'remote',
        }),
    ).toThrow(/loopback/);
    expect(
      () =>
        new OpenAiCompatibleLocalModel({
          baseUrl: 'http://user:password@127.0.0.1:11434/v1',
          model: 'credential-bearing',
        }),
    ).toThrow(/loopback/);
  });

  it('publishes every v1 schema in the standalone customer contract', () => {
    const contract = readFileSync(
      resolve(process.cwd(), '../../MCP_TOOL_CONTRACT.md'),
      'utf8',
    );

    for (const name of V1_TOOL_NAMES) {
      expect(contract).toContain(`### \`${name}\``);
    }
    expect(contract).toContain('`node_id`: required string, 1–512 characters');
    expect(contract).toContain(
      '`query` and `intent`: required string, 1–2,000 characters',
    );
    expect(contract).toContain('`{"data":null}`');
    expect(contract).toContain('MCP rate limit exceeded.');
  });
});
