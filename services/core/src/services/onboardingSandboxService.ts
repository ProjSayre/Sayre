import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getConfig } from '@sayre/config';

const IMAGE_DIGEST_RE =
  /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const RUNTIME_RE = /^(?:[A-Za-z]:[\\/])?[A-Za-z0-9_./\\-]+$/u;
const MAX_COMMAND_CHARS = 4_096;

export interface SandboxExecutionResult {
  sandbox: 'container';
  status: 'succeeded' | 'failed' | 'timed_out';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OnboardingSandboxRunner {
  run(command: string): Promise<SandboxExecutionResult>;
}

interface HostProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface HostProcessExecutor {
  run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<HostProcessResult>;
}

export class NodeHostProcessExecutor implements HostProcessExecutor {
  run(
    executable: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<HostProcessResult> {
    return new Promise((resolve) => {
      execFile(
        executable,
        [...args],
        {
          encoding: 'utf8',
          timeout: options.timeoutMs,
          maxBuffer: options.maxOutputBytes,
          windowsHide: true,
          shell: false,
          env: {
            PATH: process.env.PATH,
            PATHEXT: process.env.PATHEXT,
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            DOCKER_HOST: process.env.DOCKER_HOST,
            DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
            DOCKER_CONFIG: process.env.DOCKER_CONFIG,
          },
        },
        (error, stdout, stderr) => {
          const processError = error as
            | (Error & {
                code?: string | number;
                killed?: boolean;
                signal?: NodeJS.Signals;
              })
            | null;
          resolve({
            exitCode:
              processError === null
                ? 0
                : typeof processError.code === 'number'
                  ? processError.code
                  : null,
            timedOut:
              processError?.killed === true ||
              processError?.signal === 'SIGTERM' ||
              processError?.signal === 'SIGKILL',
            stdout,
            stderr,
          });
        },
      );
    });
  }
}

export function buildDockerRunArgs(
  image: string,
  containerName: string,
  command: string,
): string[] {
  if (!IMAGE_DIGEST_RE.test(image)) {
    throw new RangeError(
      'ONBOARDING_SANDBOX_IMAGE must be an immutable sha256 image reference.',
    );
  }
  if (!/^[a-z0-9][a-z0-9_.-]{0,62}$/u.test(containerName)) {
    throw new RangeError('Sandbox container name is invalid.');
  }
  if (
    !command.trim() ||
    command.length > MAX_COMMAND_CHARS ||
    command.includes('\0')
  ) {
    throw new RangeError('EnvStep command must be a bounded non-blank string.');
  }

  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '64',
    '--memory',
    '256m',
    '--cpus',
    '0.50',
    '--user',
    '65532:65532',
    '--tmpfs',
    '/workspace:rw,nosuid,nodev,size=256m,mode=1777',
    '--workdir',
    '/workspace',
    '--env',
    'HOME=/workspace',
    '--env',
    'TMPDIR=/workspace',
    '--entrypoint',
    '/bin/sh',
    image,
    '-c',
    command,
  ];
}

function boundedInteger(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${name} is outside its supported range.`);
  }
  return parsed;
}

export class DockerOnboardingSandboxRunner implements OnboardingSandboxRunner {
  constructor(
    private readonly options: {
      runtime: string;
      image: string;
      timeoutMs: number;
      maxOutputBytes: number;
      executor?: HostProcessExecutor;
      containerName?: () => string;
      clockMs?: () => number;
    },
  ) {
    if (!RUNTIME_RE.test(options.runtime) || options.runtime.includes('\0')) {
      throw new RangeError('Sandbox runtime executable is invalid.');
    }
    if (!IMAGE_DIGEST_RE.test(options.image)) {
      throw new RangeError(
        'ONBOARDING_SANDBOX_IMAGE must be an immutable sha256 image reference.',
      );
    }
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 1_000 ||
      options.timeoutMs > 300_000
    ) {
      throw new RangeError('Sandbox timeout is outside its supported range.');
    }
    if (
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 1_024 ||
      options.maxOutputBytes > 1_048_576
    ) {
      throw new RangeError('Sandbox output bound is outside its supported range.');
    }
  }

  async run(command: string): Promise<SandboxExecutionResult> {
    const executor = this.options.executor ?? new NodeHostProcessExecutor();
    const clockMs = this.options.clockMs ?? Date.now;
    const containerName =
      this.options.containerName?.() ??
      `sayre-onboarding-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const args = buildDockerRunArgs(this.options.image, containerName, command);
    const startedAt = clockMs();
    const result = await executor.run(this.options.runtime, args, {
      timeoutMs: this.options.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes,
    });

    // `docker run --rm` removes normal exits. This fixed cleanup command also
    // removes a container whose client process timed out; it never contains
    // model output and never invokes a host shell.
    await executor.run(this.options.runtime, ['rm', '-f', containerName], {
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
    });

    return {
      sandbox: 'container',
      status: result.timedOut
        ? 'timed_out'
        : result.exitCode === 0
          ? 'succeeded'
          : 'failed',
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.max(0, clockMs() - startedAt),
    };
  }
}

export function createOnboardingSandboxRunner(): OnboardingSandboxRunner {
  return new DockerOnboardingSandboxRunner({
    runtime: getConfig('ONBOARDING_SANDBOX_RUNTIME'),
    image: getConfig('ONBOARDING_SANDBOX_IMAGE'),
    timeoutMs: boundedInteger(
      getConfig('ONBOARDING_SANDBOX_TIMEOUT_MS'),
      'ONBOARDING_SANDBOX_TIMEOUT_MS',
      1_000,
      300_000,
    ),
    maxOutputBytes: boundedInteger(
      getConfig('ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES'),
      'ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES',
      1_024,
      1_048_576,
    ),
  });
}
