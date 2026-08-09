import { describe, expect, it } from 'vitest';
import { runWorkspacePackCli, type WorkspacePackCliIo } from './cli';
import { testPack } from './testFixture';

function cliIo(overrides: Partial<WorkspacePackCliIo> = {}): WorkspacePackCliIo {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    readFile: async () => JSON.stringify(testPack()),
    writeFileAtomic: async () => undefined,
    mkdir: async () => undefined,
    exists: async () => false,
    rename: async () => undefined,
    remove: async () => undefined,
    ...overrides,
  };
}

describe('Workspace Pack CLI', () => {
  // @spec AC-37 AC-40
  it('emits one machine-readable catalog envelope', async () => {
    const stdout: string[] = [];
    const code = await runWorkspacePackCli(['catalog', '--json'], cliIo({ stdout: (value) => stdout.push(value) }));
    expect(code).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ command: 'catalog', ok: true });
  });

  // @spec AC-37 EC-35
  it('refuses an existing export destination before writing', async () => {
    const writes: string[] = [];
    const stdout: string[] = [];
    const code = await runWorkspacePackCli([
      'export', 'default', '--out', 'already.json', '--root', process.cwd(), '--json',
    ], cliIo({
      stdout: (value) => stdout.push(value),
      exists: async (path) => path.endsWith('already.json'),
      writeFileAtomic: async (path) => { writes.push(path); },
    }));
    expect(code).toBe(1);
    expect(writes).toEqual([]);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ command: 'export', ok: false });
  });

  // @spec AC-37 AC-39 EC-35
  it('removes a staged fork when its document write fails', async () => {
    const removed: string[] = [];
    const renamed: string[] = [];
    const code = await runWorkspacePackCli([
      'fork', 'default', 'forked', '--id', 'sayre.forked', '--name', 'Forked', '--version', '1.0.0', '--author', 'Tester', '--root', process.cwd(), '--json',
    ], cliIo({
      writeFileAtomic: async () => { throw new Error('disk full'); },
      remove: async (path) => { removed.push(path); },
      rename: async (_source, destination) => { renamed.push(destination); },
    }));
    expect(code).toBe(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(/forked\..+\.tmp$/);
    expect(renamed).toEqual([]);
  });

  // @spec AC-37 EC-65
  it('rejects roles outside the closed command contract', async () => {
    const stdout: string[] = [];
    const code = await runWorkspacePackCli([
      'edit', 'default', '--operations', 'operations.json', '--role', 'superuser', '--root', process.cwd(), '--json',
    ], cliIo({
      stdout: (value) => stdout.push(value),
      readFile: async (path) => path.endsWith('operations.json') ? '[]' : JSON.stringify(testPack()),
    }));
    expect(code).toBe(1);
    expect(JSON.parse(stdout.join(''))).toMatchObject({ violations: [{ code: 'invalid-role' }] });
  });
});
