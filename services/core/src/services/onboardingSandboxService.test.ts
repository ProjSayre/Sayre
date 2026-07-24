import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOptionalConfig } from '@sayre/config';
import {
  DockerOnboardingSandboxRunner,
  buildDockerRunArgs,
  type HostProcessExecutor,
} from './onboardingSandboxService';

const IMAGE = `registry.example/sayre/onboarding@sha256:${'a'.repeat(64)}`;

describe('container-only onboarding sandbox', () => {
  it('builds a fixed hardened Docker invocation with no host mounts', () => {
    const command = 'printf ready > /workspace/result';
    const args = buildDockerRunArgs(IMAGE, 'sayre-onboarding-test', command);

    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('no-new-privileges');
    expect(args).toContain('--tmpfs');
    expect(args).not.toContain('--mount');
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('-v');
    expect(args.at(-3)).toBe(IMAGE);
    expect(args.at(-2)).toBe('-c');
    expect(args.at(-1)).toBe(command);
  });

  it('passes the EnvStep command only as one container-shell argument', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const executor: HostProcessExecutor = {
      run: vi.fn(async (executable, args) => {
        calls.push({ executable, args });
        return calls.length === 1
          ? {
              exitCode: 0,
              timedOut: false,
              stdout: 'ready\n',
              stderr: '',
            }
          : { exitCode: 1, timedOut: false, stdout: '', stderr: '' };
      }),
    };
    const clock = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_025);
    const runner = new DockerOnboardingSandboxRunner({
      runtime: 'docker',
      image: IMAGE,
      timeoutMs: 30_000,
      maxOutputBytes: 32_768,
      executor,
      containerName: () => 'sayre-onboarding-test',
      clockMs: clock,
    });
    const command = 'printf "$HOME"; touch C:\\host-proof';

    await expect(runner.run(command)).resolves.toEqual({
      sandbox: 'container',
      status: 'succeeded',
      exitCode: 0,
      stdout: 'ready\n',
      stderr: '',
      durationMs: 25,
    });
    expect(calls[0]).toMatchObject({ executable: 'docker' });
    expect(calls[0]?.args.at(-1)).toBe(command);
    expect(calls[0]?.args.filter((argument) => argument === command)).toHaveLength(1);
    expect(calls[1]?.args).toEqual(['rm', '-f', 'sayre-onboarding-test']);
  });

  it('reports timeout and always attempts fixed-name cleanup', async () => {
    const run = vi.fn(async () => ({
      exitCode: null,
      timedOut: true,
      stdout: '',
      stderr: '',
    }));
    const runner = new DockerOnboardingSandboxRunner({
      runtime: 'docker',
      image: IMAGE,
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      executor: { run },
      containerName: () => 'sayre-onboarding-timeout',
      clockMs: () => 1_000,
    });

    const result = await runner.run('sleep 10');

    expect(result.status).toBe('timed_out');
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toEqual([
      'rm',
      '-f',
      'sayre-onboarding-timeout',
    ]);
  });

  it('rejects mutable images and malformed commands before process execution', () => {
    expect(() =>
      buildDockerRunArgs('alpine:latest', 'sayre-onboarding-test', 'true'),
    ).toThrow(/immutable sha256/u);
    expect(() =>
      buildDockerRunArgs(IMAGE, 'sayre-onboarding-test', 'bad\0command'),
    ).toThrow(/bounded/u);
  });
});

const integrationImage = getOptionalConfig(
  'ONBOARDING_SANDBOX_INTEGRATION_IMAGE',
);
const containerIt = integrationImage ? it : it.skip;

containerIt(
  'runs the fixture step in a real container without changing a host sentinel',
  async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'sayre-onboarding-host-'));
    const sentinel = join(fixture, 'host-sentinel');
    await writeFile(sentinel, 'safe', 'utf8');
    try {
      const runner = new DockerOnboardingSandboxRunner({
        runtime: 'docker',
        image: integrationImage as string,
        timeoutMs: 15_000,
        maxOutputBytes: 4_096,
      });

      const result = await runner.run(
        'printf compromised > /host-sentinel 2>/dev/null || true; ' +
          'printf sandbox-ready > /workspace/result; cat /workspace/result',
      );

      expect(result).toMatchObject({
        sandbox: 'container',
        status: 'succeeded',
        stdout: 'sandbox-ready',
      });
      await expect(readFile(sentinel, 'utf8')).resolves.toBe('safe');
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  },
  30_000,
);
