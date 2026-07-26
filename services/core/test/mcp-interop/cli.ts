import { startInteropFixtureGateway } from './fixtureGateway';
import { OpenAiCompatibleLocalModel } from './openAiCompatibleModel';
import { runInteropAgainstFixture } from './runInterop';

interface CliOptions {
  modelUrl: string;
  model: string;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    modelUrl: 'http://127.0.0.1:11434/v1',
    model: 'llama3.2:1b',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--model-url' && value) {
      options.modelUrl = value;
      index += 1;
    } else if (flag === '--model' && value) {
      options.model = value;
      index += 1;
    } else {
      throw new Error('Usage: mcp-interop:local [--model-url URL] [--model NAME]');
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await startInteropFixtureGateway();
  try {
    const report = await runInteropAgainstFixture(
      fixture,
      new OpenAiCompatibleLocalModel({
        baseUrl: options.modelUrl,
        model: options.model,
      }),
    );
    console.log(
      JSON.stringify(
        {
          status: 'passed',
          model: options.model,
          modelUrl: options.modelUrl,
          tools: report.tools,
          scopes: report.scopes,
          matchedCalls: report.matchedCalls,
        },
        null,
        2,
      ),
    );
  } finally {
    await fixture.close();
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? `MCP interoperability failed: ${error.message}`
      : 'MCP interoperability failed.',
  );
  process.exitCode = 1;
});
