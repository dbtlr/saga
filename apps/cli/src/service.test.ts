import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  createLaunchdSupervisor,
  renderLaunchdPlist,
  renderServiceLifecycle,
  renderServiceStatus,
  runServiceCommand,
  serviceStatus,
  launchdPrintProcess,
  waitForServiceHealth,
  type ServiceLifecycleReport,
  type ServiceSupervisor,
} from './service.js';

const renderOptions = {
  ascii: true,
  color: 'never' as const,
  format: 'records' as const,
  isTty: false,
};
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('serviceStatus', () => {
  test('reports unreachable service', async () => {
    const output = await serviceStatus(renderOptions);

    expect(output).toContain('Saga service status');
    expect(output).toContain('health');
  });
});

describe('renderServiceStatus', () => {
  test('reports observed running state', () => {
    expect(
      renderServiceStatus(
        {
          config: '127.0.0.1:4766',
          health: 'ok (http://127.0.0.1:4766/health)',
          healthUrl: 'http://127.0.0.1:4766/health',
          logs: 'stdout/stderr',
          process: 'running',
          supervisor: 'running',
          supervisorDetail: 'launchd agent is loaded',
        },
        renderOptions,
      ),
    ).toContain('process     running');
  });

  test('renders observed log paths', () => {
    expect(
      renderServiceStatus(
        {
          config: '127.0.0.1:4766',
          health: 'unreachable (connection refused)',
          healthUrl: 'http://127.0.0.1:4766/health',
          logs: 'stdout=/tmp/saga.out (present); stderr=/tmp/saga.err (missing)',
          process: 'not running',
          supervisor: 'stopped',
          supervisorDetail: 'launchd agent is installed but not loaded',
        },
        renderOptions,
      ),
    ).toContain('stdout=/tmp/saga.out (present)');
  });
});

describe('runServiceCommand', () => {
  test('dispatches lifecycle subcommands through the supervisor', async () => {
    const supervisor = fakeSupervisor();

    const output = await runServiceCommand(['restart'], renderOptions, {
      healthCheck: async (url) => `ok (${url})`,
      healthProbe: { attempts: 1, intervalMs: 0 },
      supervisor,
    });

    expect(output).toContain('Saga service restart');
    expect(output).toContain('state   running');
    expect(output).toContain('health ok');
  });

  test('reports stopped when launchd starts but health never becomes ready', async () => {
    const output = await runServiceCommand(['start'], renderOptions, {
      healthCheck: async () => 'unreachable (connection refused)',
      healthProbe: { attempts: 1, intervalMs: 0 },
      supervisor: fakeSupervisor(),
    });

    expect(output).toContain('Saga service start');
    expect(output).toContain('state   stopped');
    expect(output).toContain('health check failed');
  });

  test('includes supervisor state in status output', async () => {
    const output = await runServiceCommand(['status'], renderOptions, {
      healthCheck: async () => 'unreachable (connection refused)',
      supervisor: fakeSupervisor('stopped'),
    });

    expect(output).toContain('supervisor  stopped');
    expect(output).toContain('detail      fake supervisor stopped');
    expect(output).toContain(
      'logs        stdout=/tmp/saga.out (present); stderr=/tmp/saga.err (missing)',
    );
  });
});

describe('waitForServiceHealth', () => {
  test('polls until health is ready', async () => {
    let attempts = 0;
    const health = await waitForServiceHealth(
      'http://127.0.0.1:4766/health',
      async (url) => {
        attempts += 1;
        return attempts === 2 ? `ok (${url})` : 'unreachable (connection refused)';
      },
      { attempts: 3, intervalMs: 0 },
    );

    expect(health).toBe('ok (http://127.0.0.1:4766/health)');
    expect(attempts).toBe(2);
  });
});

describe('renderServiceLifecycle', () => {
  test('renders launchd lifecycle details', () => {
    expect(
      renderServiceLifecycle(
        {
          action: 'install',
          detail: 'installed and bootstrapped launchd agent',
          label: 'com.saga.service',
          plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
          state: 'installed',
        },
        renderOptions,
      ),
    ).toContain('plist   /Users/drew/Library/LaunchAgents/com.saga.service.plist');
  });
});

describe('renderLaunchdPlist', () => {
  test('builds a launchd agent for saga service run', () => {
    const plist = renderLaunchdPlist({
      paths: {
        plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
        stderrPath: '/Users/drew/Library/Logs/saga/service.err.log',
        stdoutPath: '/Users/drew/Library/Logs/saga/service.out.log',
      },
      projectRoot: '/Volumes/data/workspaces/saga',
    });

    expect(plist).toContain('<string>com.saga.service</string>');
    expect(plist).toContain('/Volumes/data/workspaces/saga/apps/cli/node_modules/tsx/dist/cli.mjs');
    expect(plist).toContain('/Volumes/data/workspaces/saga/apps/cli/src/main.ts');
    expect(plist).toContain('<string>service</string>');
    expect(plist).toContain('<string>run</string>');
  });

  test('uses the package-local tsx executable', () => {
    expect(
      existsSync(join(workspaceRoot, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs')),
    ).toBe(true);
  });
});

describe('launchdPrintProcess', () => {
  test('reports running only when launchctl output includes a pid', () => {
    expect(launchdPrintProcess('state = running\n\tpid = 12345\n')).toBe('running');
    expect(launchdPrintProcess('state = waiting\n\tlast exit code = 0\n')).toBe('not running');
  });
});

describe('createLaunchdSupervisor', () => {
  test('does not mutate launchd state on non-macOS', async () => {
    if (process.platform === 'darwin') return;
    const report = await createLaunchdSupervisor({ cwd: process.cwd() }).install();

    expect(report).toMatchObject({
      action: 'install',
      detail: 'launchd is only available on macOS',
      state: 'unavailable',
    });
  });
});

function fakeSupervisor(state: 'running' | 'stopped' = 'running'): ServiceSupervisor {
  const report = (action: ServiceLifecycleReport['action']): ServiceLifecycleReport => ({
    action,
    detail: `fake supervisor ${action}`,
    label: 'com.saga.service',
    plistPath: '/tmp/com.saga.service.plist',
    state: action === 'uninstall' ? 'not installed' : state,
  });
  return {
    inspect: async () => ({
      detail: `fake supervisor ${state}`,
      logs: 'stdout=/tmp/saga.out (present); stderr=/tmp/saga.err (missing)',
      process: state === 'running' ? 'running' : 'not running',
      state,
    }),
    install: async () => report('install'),
    restart: async () => report('restart'),
    start: async () => report('start'),
    stop: async () => report('stop'),
    uninstall: async () => report('uninstall'),
  };
}
