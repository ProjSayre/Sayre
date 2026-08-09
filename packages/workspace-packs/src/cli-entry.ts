import { runWorkspacePackCli } from './cli';

process.exitCode = await runWorkspacePackCli(process.argv.slice(2));
