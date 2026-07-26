import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { InteropToolCase } from './contract';

const MAX_RESPONSE_BYTES = 1_048_576;

export interface ModelSelectedTool {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallDriver {
  selectTool(
    testCase: InteropToolCase,
    tool: Tool,
  ): Promise<ModelSelectedTool>;
}

export interface LocalModelOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

function localBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new Error(
      'The interoperability model endpoint must be unauthenticated HTTP on loopback.',
    );
  }
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error('The local model response exceeded the size limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The local model returned no response body.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  let reading = true;
  while (reading) {
    const chunk = await reader.read();
    if (chunk.done) {
      reading = false;
      continue;
    }
    const { value } = chunk;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES || chunks.length >= 1_024) {
      await reader.cancel();
      throw new Error('The local model response exceeded the size limit.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error('The local model returned invalid JSON.');
  }
}

function selectedTool(value: unknown): ModelSelectedTool {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The local model response was not an object.');
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length !== 1) {
    throw new Error('The local model must return exactly one choice.');
  }
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) {
    throw new Error('The local model choice omitted a message.');
  }
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
    throw new Error('The local model must select exactly one tool.');
  }
  const fn = (toolCalls[0] as { function?: unknown }).function;
  if (typeof fn !== 'object' || fn === null) {
    throw new Error('The local model tool call omitted its function.');
  }
  const name = (fn as { name?: unknown }).name;
  const rawArguments = (fn as { arguments?: unknown }).arguments;
  if (typeof name !== 'string') {
    throw new Error('The local model tool call omitted its name.');
  }
  let args: unknown = rawArguments;
  if (typeof rawArguments === 'string') {
    try {
      args = JSON.parse(rawArguments);
    } catch {
      throw new Error('The local model produced invalid tool arguments.');
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('The local model tool arguments were not an object.');
  }
  return { name, arguments: args as Record<string, unknown> };
}

export class OpenAiCompatibleLocalModel implements ToolCallDriver {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  constructor(private readonly options: LocalModelOptions) {
    this.baseUrl = localBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  async selectTool(
    testCase: InteropToolCase,
    tool: Tool,
  ): Promise<ModelSelectedTool> {
    const response = await fetch(
      new URL('chat/completions', this.baseUrl),
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          stream: false,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                'You are an MCP tool-routing test. Call the required function exactly once and do not answer in prose.',
            },
            {
              role: 'user',
              content: [
                `Call ${testCase.name}.`,
                `Arguments (exact JSON): ${JSON.stringify(testCase.arguments)}`,
              ].join('\n'),
            },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description ?? '',
                parameters: tool.inputSchema,
              },
            },
          ],
          tool_choice: {
            type: 'function',
            function: { name: tool.name },
          },
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `The local model endpoint returned HTTP ${response.status}.`,
      );
    }
    return selectedTool(await boundedJson(response));
  }
}
