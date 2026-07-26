import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export class OpenSourceMcpClient {
  private readonly client: Client;

  private constructor(clientName: string) {
    this.client = new Client({ name: clientName, version: '1.0.0' });
  }

  static async connect(
    endpoint: URL,
    token: string,
    clientName: string,
  ): Promise<OpenSourceMcpClient> {
    const wrapper = new OpenSourceMcpClient(clientName);
    await wrapper.client.connect(
      new StreamableHTTPClientTransport(endpoint, {
        requestInit: {
          headers: { authorization: `Bearer ${token}` },
        },
      }),
    );
    return wrapper;
  }

  async tools(): Promise<Tool[]> {
    return (await this.client.listTools()).tools;
  }

  async call(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const result = await this.client.callTool({
      name,
      arguments: args,
    });
    if (result.isError) throw new Error(`MCP tool ${name} returned an error.`);
    const content = result.content;
    if (!Array.isArray(content) || content.length !== 1) {
      throw new Error(`MCP tool ${name} returned an unsupported content shape.`);
    }
    const item = content[0];
    if (
      typeof item !== 'object' ||
      item === null ||
      item.type !== 'text' ||
      typeof item.text !== 'string'
    ) {
      throw new Error(`MCP tool ${name} returned an unsupported content shape.`);
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(item.text);
    } catch {
      throw new Error(`MCP tool ${name} returned invalid JSON.`);
    }
    if (
      typeof envelope !== 'object' ||
      envelope === null ||
      Array.isArray(envelope) ||
      Object.keys(envelope).length !== 1 ||
      !('data' in envelope)
    ) {
      throw new Error(`MCP tool ${name} violated the v1 response envelope.`);
    }
    return (envelope as { data: unknown }).data;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}
