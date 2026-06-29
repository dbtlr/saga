import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { describe, expect, test } from 'vitest';

import {
  cliServiceCommand,
  controlPlaneCommand,
  renderStartReport,
  runStartCommand,
  waitForForegroundChild,
} from './start.js';

const renderOptions = {
  ascii: true,
  color: 'never' as const,
  format: 'records' as const,
  isTty: false,
};

describe('renderStartReport', () => {
  test('renders service and control-plane endpoints', () => {
    expect(
      renderStartReport(
        {
          controlPlaneUrl: 'http://127.0.0.1:4767',
          healthUrl: 'http://127.0.0.1:4766/health',
          service: 'started',
        },
        renderOptions,
      ),
    ).toContain('control  http://127.0.0.1:4767');
  });
});

describe('runStartCommand', () => {
  test('launches the control-plane dev server when the service is already running', async () => {
    const output: string[] = [];
    const exitCode = await runStartCommand([], renderOptions, (text) => output.push(text), {
      checkHealth: async () => 'ok (http://127.0.0.1:4766/health)',
      cwd: process.cwd(),
      env: {},
      spawnControlPlane: async (input) => {
        expect(input.cwd).toBeTypeOf('string');
        return 0;
      },
    });

    expect(exitCode).toBe(0);
    expect(output[0]).toContain('service  already running');
  });

  test('starts an embedded service when health is unreachable', async () => {
    const output: string[] = [];
    const serviceChild = new FakeChildProcess();
    let healthChecks = 0;

    await expect(
      runStartCommand([], renderOptions, (text) => output.push(text), {
        checkHealth: async () => {
          healthChecks += 1;
          return healthChecks === 1 ? 'unreachable' : 'ok (http://127.0.0.1:4766/health)';
        },
        cwd: process.cwd(),
        env: {},
        spawnControlPlane: async () => 0,
        spawnService: () => serviceChild as unknown as ChildProcess,
      }),
    ).resolves.toBe(0);

    expect(output[0]).toContain('service  started');
    expect(serviceChild.signals).toContain('SIGTERM');
  });

  test('cleans up the service child when startup health checks fail', async () => {
    const serviceChild = new FakeChildProcess();
    let healthChecks = 0;

    await expect(
      runStartCommand([], renderOptions, () => undefined, {
        checkHealth: async () => {
          healthChecks += 1;
          if (healthChecks === 1) return 'unreachable';
          throw new Error('health check failed');
        },
        cwd: process.cwd(),
        env: {},
        spawnControlPlane: async () => 0,
        spawnService: () => serviceChild as unknown as ChildProcess,
      }),
    ).rejects.toThrow('health check failed');

    expect(serviceChild.signals).toContain('SIGTERM');
  });

  test('returns a signal exit code when interrupted during service startup', async () => {
    const serviceChild = new FakeChildProcess();
    let healthChecks = 0;

    const exitCode = await runStartCommand([], renderOptions, () => undefined, {
      checkHealth: async () => {
        healthChecks += 1;
        if (healthChecks === 1) return 'unreachable';
        process.emit('SIGTERM', 'SIGTERM');
        return 'unreachable';
      },
      cwd: process.cwd(),
      env: {},
      spawnControlPlane: async () => 0,
      spawnService: () => serviceChild as unknown as ChildProcess,
    });

    expect(exitCode).toBe(143);
    expect(serviceChild.signals).toContain('SIGTERM');
  });
});

describe('process command builders', () => {
  test('builds the control-plane dev command through pnpm', () => {
    expect(controlPlaneCommand({})).toEqual({
      args: ['--filter', '@saga/control-plane', 'dev'],
      command: 'pnpm',
    });
  });

  test('builds the service command as a CLI process', () => {
    const command = cliServiceCommand();

    expect(command.command).toBe(process.execPath);
    expect(command.args.at(-2)).toBe('service');
    expect(command.args.at(-1)).toBe('run');
  });
});

describe('waitForForegroundChild', () => {
  test('waits for foreground exit after forwarding a signal', async () => {
    const foreground = new FakeChildProcess({ autoExitOnKill: false });
    const service = new FakeChildProcess({ autoExitOnKill: false });
    let resolved = false;

    const result = waitForForegroundChild(foreground as unknown as ChildProcess, [
      service as unknown as ChildProcess,
    ]).then((code) => {
      resolved = true;
      return code;
    });

    process.emit('SIGINT', 'SIGINT');
    await Promise.resolve();

    expect(foreground.signals).toContain('SIGINT');
    expect(service.signals).toContain('SIGINT');
    expect(resolved).toBe(false);

    foreground.exit(null, 'SIGINT');

    await expect(result).resolves.toBe(130);
    expect(resolved).toBe(true);
  });

  test('maps foreground SIGTERM exits to 143', async () => {
    const foreground = new FakeChildProcess();

    const result = waitForForegroundChild(foreground as unknown as ChildProcess, []);
    foreground.exit(null, 'SIGTERM');

    await expect(result).resolves.toBe(143);
  });
});

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  killed = false;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];

  constructor(private readonly options: { autoExitOnKill: boolean } = { autoExitOnKill: true }) {
    super();
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    const normalizedSignal = typeof signal === 'string' ? signal : 'SIGTERM';
    this.killed = true;
    this.signals.push(normalizedSignal);
    if (this.options.autoExitOnKill) {
      this.exit(null, normalizedSignal);
    }
    return true;
  }
}
