import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { loadRuntimeConfig } from '@saga/runtime';
import { startSagaService } from '@saga/service';
import { Effect } from 'effect';

import { findProjectRoot } from './init.js';
import { formatCommandOutput } from './output.js';
import { recordBlock } from './render.js';
import type { RenderOptions } from './render.js';

const execFileAsync = promisify(execFile);
const LAUNCHD_LABEL = 'com.saga.service';

export type ServiceSupervisorState =
  | 'installed'
  | 'not installed'
  | 'running'
  | 'stopped'
  | 'unavailable';

export type ServiceStatusReport = {
  config: string;
  health: string;
  healthUrl: string;
  logs: string;
  process: 'running' | 'not running';
  supervisor: ServiceSupervisorState;
  supervisorDetail: string;
};

export type ServiceLifecycleReport = {
  action: 'install' | 'restart' | 'start' | 'stop' | 'uninstall';
  detail: string;
  label: string;
  plistPath: string;
  state: ServiceSupervisorState;
};

export type ServiceSupervisorInspection = {
  detail: string;
  logs: string;
  process: 'not running' | 'running';
  state: ServiceSupervisorState;
};

export type ServiceSupervisor = {
  inspect: () => Promise<ServiceSupervisorInspection>;
  install: () => Promise<ServiceLifecycleReport>;
  restart: () => Promise<ServiceLifecycleReport>;
  start: () => Promise<ServiceLifecycleReport>;
  stop: () => Promise<ServiceLifecycleReport>;
  uninstall: () => Promise<ServiceLifecycleReport>;
};

export type ServiceHealthProbeOptions = {
  attempts?: number | undefined;
  intervalMs?: number | undefined;
};

export type ServiceCommandDependencies = {
  healthCheck?: ((url: string) => Promise<string>) | undefined;
  healthProbe?: ServiceHealthProbeOptions | undefined;
  supervisor?: ServiceSupervisor | undefined;
};

export async function runServiceCommand(
  args: readonly string[],
  options: RenderOptions,
  dependencies: ServiceCommandDependencies = {},
): Promise<string> {
  const subcommand = args[0];
  if (subcommand === 'run') {
    return runService(options);
  }
  if (subcommand === 'status') {
    return serviceStatus(options, dependencies);
  }
  if (
    subcommand === 'install' ||
    subcommand === 'uninstall' ||
    subcommand === 'start' ||
    subcommand === 'stop' ||
    subcommand === 'restart'
  ) {
    return runServiceLifecycle(subcommand, options, dependencies);
  }

  throw new Error(`service ${subcommand ?? ''} is not implemented yet`.trim());
}

export async function runService(options: RenderOptions): Promise<string> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const service = await startSagaService(config);
  const closeAndExit = async (): Promise<void> => {
    await service.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void closeAndExit());
  process.once('SIGTERM', () => void closeAndExit());

  return formatCommandOutput(
    {
      id: 'service',
      records: recordBlock(
        'Saga service',
        [
          { label: 'health', value: `${service.url}/health` },
          { label: 'mode', value: 'foreground' },
        ],
        options,
      ),
      value: {
        healthUrl: `${service.url}/health`,
        mode: 'foreground',
      },
    },
    options.format,
  );
}

export async function serviceStatus(
  options: RenderOptions,
  dependencies: ServiceCommandDependencies = {},
): Promise<string> {
  const report = await inspectServiceStatus(dependencies);

  return formatCommandOutput(
    {
      id: 'service',
      records: renderServiceStatus(report, options),
      value: report,
    },
    options.format,
  );
}

export async function inspectServiceStatus(
  dependencies: ServiceCommandDependencies = {},
): Promise<ServiceStatusReport> {
  const config = await Effect.runPromise(loadRuntimeConfig());
  const healthUrl = `http://${config.service.host}:${config.service.port}/health`;
  const health = await (dependencies.healthCheck ?? checkHealth)(healthUrl);
  const supervisor = await (dependencies.supervisor ?? createLaunchdSupervisor()).inspect();
  return {
    config: `${config.service.host}:${config.service.port}`,
    health,
    healthUrl,
    logs: supervisor.logs,
    process:
      supervisor.process === 'running' || health.startsWith('ok ') ? 'running' : 'not running',
    supervisor: supervisor.state,
    supervisorDetail: supervisor.detail,
  };
}

export function renderServiceStatus(report: ServiceStatusReport, options: RenderOptions): string {
  return recordBlock(
    'Saga service status',
    [
      { label: 'process', value: report.process },
      { label: 'config', value: report.config },
      { label: 'logs', value: report.logs },
      { label: 'health', value: report.health },
      { label: 'supervisor', value: report.supervisor },
      { label: 'detail', value: report.supervisorDetail },
    ],
    options,
  );
}

async function runServiceLifecycle(
  action: ServiceLifecycleReport['action'],
  options: RenderOptions,
  dependencies: ServiceCommandDependencies,
): Promise<string> {
  const supervisor = dependencies.supervisor ?? createLaunchdSupervisor();
  const supervisorReport = await supervisor[action]();
  const report = await observeLifecycleHealth(supervisorReport, dependencies);
  return formatCommandOutput(
    {
      id: 'service',
      records: renderServiceLifecycle(report, options),
      value: report,
    },
    options.format,
  );
}

async function observeLifecycleHealth(
  report: ServiceLifecycleReport,
  dependencies: ServiceCommandDependencies,
): Promise<ServiceLifecycleReport> {
  if (!shouldVerifyHealth(report)) {
    return report;
  }

  const config = await Effect.runPromise(loadRuntimeConfig());
  const healthUrl = `http://${config.service.host}:${config.service.port}/health`;
  const health = await waitForServiceHealth(
    healthUrl,
    dependencies.healthCheck ?? checkHealth,
    dependencies.healthProbe,
  );

  if (health.startsWith('ok ')) {
    return {
      ...report,
      detail: `${report.detail}; health ${health}`,
      state: 'running',
    };
  }

  return {
    ...report,
    detail: `${report.detail}; health check failed: ${health}`,
    state: 'stopped',
  };
}

function shouldVerifyHealth(report: ServiceLifecycleReport): boolean {
  return (
    (report.action === 'install' || report.action === 'restart' || report.action === 'start') &&
    (report.state === 'installed' || report.state === 'running')
  );
}

export function renderServiceLifecycle(
  report: ServiceLifecycleReport,
  options: RenderOptions,
): string {
  return recordBlock(
    `Saga service ${report.action}`,
    [
      { label: 'state', value: report.state },
      { label: 'label', value: report.label },
      { label: 'plist', value: report.plistPath },
      { label: 'detail', value: report.detail },
    ],
    options,
  );
}

export function createLaunchdSupervisor(input: { cwd?: string } = {}): ServiceSupervisor {
  const projectRoot = findProjectRoot(input.cwd ?? process.cwd());
  const paths = launchdPaths();
  const unavailable = (action: ServiceLifecycleReport['action']) =>
    launchdUnavailableReport(paths, action);
  const launchctl = async (args: readonly string[]) => {
    await execFileAsync('launchctl', [...args]);
  };
  const inspect = async () => inspectLaunchd(paths);
  return {
    inspect,
    install: async () => {
      if (process.platform !== 'darwin') {
        return unavailable('install');
      }
      ensureLaunchdDirectories(paths);
      writeFileSync(paths.plistPath, renderLaunchdPlist({ paths, projectRoot }), {
        mode: 0o600,
      });
      await launchctl(['bootstrap', `gui/${String(process.getuid?.() ?? '')}`, paths.plistPath]);
      return {
        action: 'install',
        detail: 'installed and bootstrapped launchd agent',
        label: LAUNCHD_LABEL,
        plistPath: paths.plistPath,
        state: 'installed',
      };
    },
    restart: async () => {
      if (process.platform !== 'darwin') {
        return unavailable('restart');
      }
      await launchctl([
        'kickstart',
        '-k',
        `gui/${String(process.getuid?.() ?? '')}/${LAUNCHD_LABEL}`,
      ]);
      return {
        action: 'restart',
        detail: 'restarted launchd agent',
        label: LAUNCHD_LABEL,
        plistPath: paths.plistPath,
        state: 'running',
      };
    },
    start: async () => {
      if (process.platform !== 'darwin') {
        return unavailable('start');
      }
      await launchctl(['kickstart', `gui/${String(process.getuid?.() ?? '')}/${LAUNCHD_LABEL}`]);
      return {
        action: 'start',
        detail: 'started launchd agent',
        label: LAUNCHD_LABEL,
        plistPath: paths.plistPath,
        state: 'running',
      };
    },
    stop: async () => {
      if (process.platform !== 'darwin') {
        return unavailable('stop');
      }
      await launchctl(['kill', 'TERM', `gui/${String(process.getuid?.() ?? '')}/${LAUNCHD_LABEL}`]);
      return {
        action: 'stop',
        detail: 'sent TERM to launchd agent',
        label: LAUNCHD_LABEL,
        plistPath: paths.plistPath,
        state: 'stopped',
      };
    },
    uninstall: async () => {
      if (process.platform !== 'darwin') {
        return unavailable('uninstall');
      }
      await launchctl([
        'bootout',
        `gui/${String(process.getuid?.() ?? '')}`,
        paths.plistPath,
      ]).catch(() => undefined);
      rmSync(paths.plistPath, { force: true });
      return {
        action: 'uninstall',
        detail: 'removed launchd agent',
        label: LAUNCHD_LABEL,
        plistPath: paths.plistPath,
        state: 'not installed',
      };
    },
  };
}

export function renderLaunchdPlist(input: {
  paths: ReturnType<typeof launchdPaths>;
  projectRoot: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(process.execPath)}</string>
    <string>${escapePlist(join(input.projectRoot, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs'))}</string>
    <string>${escapePlist(join(input.projectRoot, 'apps', 'cli', 'src', 'main.ts'))}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlist(input.projectRoot)}</string>
  <key>RunAtLoad</key>
  <false/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${escapePlist(input.paths.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlist(input.paths.stderrPath)}</string>
</dict>
</plist>
`;
}

function launchdUnavailableReport(
  paths: ReturnType<typeof launchdPaths>,
  action: ServiceLifecycleReport['action'],
): ServiceLifecycleReport {
  return {
    action,
    detail: 'launchd is only available on macOS',
    label: LAUNCHD_LABEL,
    plistPath: paths.plistPath,
    state: 'unavailable',
  };
}

function launchdPaths() {
  const home = homedir();
  return {
    plistPath: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
    stderrPath: join(home, 'Library', 'Logs', 'saga', 'service.err.log'),
    stdoutPath: join(home, 'Library', 'Logs', 'saga', 'service.out.log'),
  };
}

function ensureLaunchdDirectories(paths: ReturnType<typeof launchdPaths>): void {
  mkdirSync(dirname(paths.plistPath), { recursive: true });
  mkdirSync(dirname(paths.stdoutPath), { recursive: true });
}

async function inspectLaunchd(
  paths: ReturnType<typeof launchdPaths>,
): Promise<ServiceSupervisorInspection> {
  const logs = launchdLogStatus(paths);
  if (process.platform !== 'darwin') {
    return {
      detail: 'launchd is only available on macOS',
      logs,
      process: 'not running',
      state: 'unavailable',
    };
  }
  if (!existsSync(paths.plistPath)) {
    return {
      detail: 'launchd agent is not installed',
      logs,
      process: 'not running',
      state: 'not installed',
    };
  }
  try {
    const plist = readFileSync(paths.plistPath, 'utf8');
    if (!plist.includes(`<string>${LAUNCHD_LABEL}</string>`)) {
      return {
        detail: 'launchd plist label does not match Saga service',
        logs,
        process: 'not running',
        state: 'stopped',
      };
    }
    const { stdout } = await execFileAsync('launchctl', [
      'print',
      `gui/${String(process.getuid?.() ?? '')}/${LAUNCHD_LABEL}`,
    ]);
    const serviceProcess = launchdPrintProcess(stdout);
    return {
      detail:
        serviceProcess === 'running'
          ? 'launchd agent is loaded and running'
          : 'launchd agent is loaded but process is not running',
      logs,
      process: serviceProcess,
      state: serviceProcess === 'running' ? 'running' : 'stopped',
    };
  } catch {
    return {
      detail: 'launchd agent is installed but not loaded',
      logs,
      process: 'not running',
      state: 'stopped',
    };
  }
}

export function launchdPrintProcess(output: string): 'not running' | 'running' {
  return /^\s*pid\s*=\s*[1-9][0-9]*\s*$/mu.test(output) ? 'running' : 'not running';
}

function launchdLogStatus(paths: ReturnType<typeof launchdPaths>): string {
  return [
    `stdout=${paths.stdoutPath} (${existsSync(paths.stdoutPath) ? 'present' : 'missing'})`,
    `stderr=${paths.stderrPath} (${existsSync(paths.stderrPath) ? 'present' : 'missing'})`,
  ].join('; ');
}

function escapePlist(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export async function checkHealth(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return `unhealthy (${String(response.status)})`;
    }
    const payload = (await response.json()) as { ok?: unknown };
    return payload.ok === true ? `ok (${url})` : `unexpected response (${url})`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unreachable (${message})`;
  }
}

export async function waitForServiceHealth(
  url: string,
  healthCheck: (url: string) => Promise<string> = checkHealth,
  options: ServiceHealthProbeOptions = {},
): Promise<string> {
  const attempts = options.attempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;
  let last = 'unreachable';

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = await healthCheck(url);
    if (last.startsWith('ok ')) {
      return last;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return last;
}
