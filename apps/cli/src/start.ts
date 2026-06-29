import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, type RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';
import { findProjectRoot } from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock, type RenderOptions } from './render.js';
import { checkHealth } from './service.js';

export interface SagaStartReport {
  controlPlaneUrl: string;
  healthUrl: string;
  service: 'already running' | 'started';
}

export interface StartDependencies {
  checkHealth?: (url: string) => Promise<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  spawnControlPlane?: (input: SpawnControlPlaneInput) => Promise<number>;
  spawnService?: (input: SpawnServiceInput) => ChildProcess;
}

export interface SpawnControlPlaneInput {
  cleanupChildren?: readonly ChildProcess[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface SpawnServiceInput {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const CONTROL_PLANE_HOST = '127.0.0.1';
const CONTROL_PLANE_PORT = 4767;
const SERVICE_HEALTH_ATTEMPTS = 25;
const SERVICE_HEALTH_INTERVAL_MS = 200;

export class StartInterrupted extends Error {
  constructor(readonly exitCode: number) {
    super(`start interrupted with exit code ${exitCode.toString()}`);
    this.name = 'StartInterrupted';
  }
}

export async function runStartCommand(
  args: readonly string[],
  options: RenderOptions,
  write: (text: string) => void,
  dependencies: StartDependencies = {},
): Promise<number> {
  if (args.length > 0) {
    throw new Error('start does not accept arguments yet');
  }

  const cwd = dependencies.cwd ?? process.cwd();
  const projectRoot = findProjectRoot(cwd);
  const env = dependencies.env ?? process.env;
  const config = await Effect.runPromise(loadRuntimeConfig({ cwd: projectRoot, env }));
  const healthUrl = `http://${config.service.host}:${config.service.port.toString()}/health`;
  const check = dependencies.checkHealth ?? checkHealth;
  const observedHealth = await check(healthUrl);
  const serviceChild = observedHealth.startsWith('ok ')
    ? undefined
    : (dependencies.spawnService ?? spawnServiceRun)({
        cwd: projectRoot,
        env,
      });

  try {
    if (serviceChild !== undefined) {
      const startupExitCode = await waitForServiceHealth({
        checkHealth: check,
        child: serviceChild,
        config,
        healthUrl,
      });
      if (startupExitCode !== undefined) return startupExitCode;
    }

    const report: SagaStartReport = {
      controlPlaneUrl: `http://${CONTROL_PLANE_HOST}:${CONTROL_PLANE_PORT.toString()}`,
      healthUrl,
      service: serviceChild === undefined ? 'already running' : 'started',
    };

    write(renderStartReport(report, options));

    return await (dependencies.spawnControlPlane ?? spawnControlPlaneDev)({
      cleanupChildren: serviceChild === undefined ? [] : [serviceChild],
      cwd: projectRoot,
      env,
    });
  } finally {
    if (serviceChild !== undefined) {
      await terminateChild(serviceChild);
    }
  }
}

export function renderStartReport(report: SagaStartReport, options: RenderOptions): string {
  return formatCommandOutput(
    {
      id: 'start',
      records: recordBlock(
        'Saga start',
        [
          { label: 'service', value: report.service },
          { label: 'health', value: report.healthUrl },
          { label: 'control', value: report.controlPlaneUrl },
        ],
        options,
      ),
      value: report,
    },
    options.format,
  );
}

export function spawnControlPlaneDev(input: SpawnControlPlaneInput): Promise<number> {
  const command = controlPlaneCommand(input.env);
  const child = spawn(command.command, command.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: 'inherit',
  });

  return waitForForegroundChild(child, input.cleanupChildren ?? []);
}

export function spawnServiceRun(input: SpawnServiceInput): ChildProcess {
  const command = cliServiceCommand();
  return spawn(command.command, command.args, {
    cwd: input.cwd,
    env: input.env,
    stdio: 'ignore',
  });
}

export function controlPlaneCommand(env: NodeJS.ProcessEnv): { args: string[]; command: string } {
  const command = pnpmCommand(env);
  return {
    args: [...command.args, '--filter', '@saga/control-plane', 'dev'],
    command: command.command,
  };
}

export function cliServiceCommand(): { args: string[]; command: string } {
  const tsxCli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  return {
    args: [tsxCli, main, 'service', 'run'],
    command: process.execPath,
  };
}

function pnpmCommand(env: NodeJS.ProcessEnv): { args: string[]; command: string } {
  const npmExecPath = env.npm_execpath;
  if (npmExecPath === undefined || npmExecPath.trim() === '') {
    return { args: [], command: 'pnpm' };
  }

  if (npmExecPath.endsWith('.cjs') || npmExecPath.endsWith('.js')) {
    return { args: [npmExecPath], command: process.execPath };
  }

  return { args: [], command: npmExecPath };
}

export function installSignalCleanup(children: readonly ChildProcess[]): {
  getInterruptedSignal: () => NodeJS.Signals | undefined;
  remove: () => void;
} {
  let interruptedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    interruptedSignal = signal;
    for (const child of children) {
      signalChild(child, signal);
    }
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    getInterruptedSignal: () => interruptedSignal,
    remove: () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}

async function waitForServiceHealth(input: {
  checkHealth: (url: string) => Promise<string>;
  child: ChildProcess;
  config: RuntimeConfig;
  healthUrl: string;
}): Promise<number | undefined> {
  const signalCleanup = installSignalCleanup([input.child]);
  try {
    await pollServiceHealth({
      ...input,
      interruptedSignal: signalCleanup.getInterruptedSignal,
    });
    return undefined;
  } catch (error) {
    if (error instanceof StartInterrupted) return error.exitCode;
    throw error;
  } finally {
    signalCleanup.remove();
  }
}

async function pollServiceHealth(input: {
  checkHealth: (url: string) => Promise<string>;
  child: ChildProcess;
  config: RuntimeConfig;
  healthUrl: string;
  interruptedSignal: () => NodeJS.Signals | undefined;
}): Promise<void> {
  for (let attempt = 0; attempt < SERVICE_HEALTH_ATTEMPTS; attempt += 1) {
    const interruptedSignal = input.interruptedSignal();
    if (interruptedSignal !== undefined) {
      throw new StartInterrupted(exitCodeForSignal(interruptedSignal));
    }

    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      if (input.child.signalCode === 'SIGINT' || input.child.signalCode === 'SIGTERM') {
        throw new StartInterrupted(exitCodeForSignal(input.child.signalCode));
      }
      throw new Error(
        `service process exited before becoming healthy on ${input.config.service.host}:${input.config.service.port.toString()}`,
      );
    }

    const health = await input.checkHealth(input.healthUrl);
    if (health.startsWith('ok ')) return;
    await delay(SERVICE_HEALTH_INTERVAL_MS);
  }

  throw new Error(`service did not become healthy at ${input.healthUrl}`);
}

export function waitForForegroundChild(
  foreground: ChildProcess,
  cleanupChildren: readonly ChildProcess[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const children = [foreground, ...cleanupChildren];
    const removeSignalHandlers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      resolve(code);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      reject(error);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      for (const child of children) {
        signalChild(child, signal);
      }
      void waitForChildExit(foreground).then(() => settle(signal === 'SIGINT' ? 130 : 143));
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    foreground.once('error', fail);
    foreground.once('exit', (code, signal) => {
      if (signal !== null) {
        settle(exitCodeForSignal(signal));
        return;
      }
      settle(code ?? 0);
    });
  });
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signalChild(child, 'SIGKILL');
      resolve();
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signalChild(child, 'SIGKILL');
      resolve();
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    signalChild(child, 'SIGTERM');
  });
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  if (signal === 'SIGINT') return 130;
  if (signal === 'SIGTERM') return 143;
  return 128;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
