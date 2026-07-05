import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createLaunchdSupervisor,
  renderLaunchdPlist,
  renderServiceLifecycle,
  renderServiceStatus,
  runServiceCommand,
  serviceStatus,
  launchdPrintProcess,
  waitForServiceHealth,
} from './service.js';
import type { ServiceLifecycleReport, ServiceSupervisor } from './service.js';

const renderOptions = {
  ascii: true,
  color: 'never' as const,
  format: 'records' as const,
  isTty: false,
};
const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url));

describe('serviceStatus', () => {
  it('reports unreachable service', async () => {
    const output = await serviceStatus(renderOptions);

    expect(output).toContain('Saga service status');
    expect(output).toContain('health');
  });
});

describe('renderServiceStatus', () => {
  it('reports observed running state', () => {
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

  it('renders observed log paths', () => {
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
  it('dispatches lifecycle subcommands through the supervisor', async () => {
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

  it('reports stopped when launchd starts but health never becomes ready', async () => {
    const output = await runServiceCommand(['start'], renderOptions, {
      healthCheck: async () => 'unreachable (connection refused)',
      healthProbe: { attempts: 1, intervalMs: 0 },
      supervisor: fakeSupervisor(),
    });

    expect(output).toContain('Saga service start');
    expect(output).toContain('state   stopped');
    expect(output).toContain('health check failed');
  });

  it('includes supervisor state in status output', async () => {
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
  it('polls until health is ready', async () => {
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
  it('renders launchd lifecycle details', () => {
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
  it('builds a launchd agent for saga service run', () => {
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

  it('uses the package-local tsx executable', () => {
    expect(
      existsSync(join(workspaceRoot, 'apps', 'cli', 'node_modules', 'tsx', 'dist', 'cli.mjs')),
    ).toBe(true);
  });

  it('execs the compiled stable-path binary directly when compiled', () => {
    const plist = renderLaunchdPlist({
      binPath: '/Users/drew/.local/bin/saga',
      compiled: true,
      paths: {
        plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
        stderrPath: '/Users/drew/Library/Logs/saga/service.err.log',
        stdoutPath: '/Users/drew/Library/Logs/saga/service.out.log',
      },
      projectRoot: '/Volumes/data/workspaces/saga',
    });

    expect(plist).toContain('<string>/Users/drew/.local/bin/saga</string>');
    expect(plist).toContain('<string>service</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).not.toContain('tsx/dist/cli.mjs');
    expect(plist).not.toContain('apps/cli/src/main.ts');
  });

  it('uses home as WorkingDirectory in production and builds the exec path from that home', () => {
    // Rationale lives on renderLaunchdPlist (SGA-230): production gates off
    // cwd-relative .env, so home is a safe, always-accessible cwd.
    const plist = renderLaunchdPlist({
      compiled: true,
      isProduction: true,
      home: '/Users/drew',
      paths: {
        plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
        stderrPath: '/Users/drew/Library/Logs/saga/service.err.log',
        stdoutPath: '/Users/drew/Library/Logs/saga/service.out.log',
      },
      projectRoot: '/Volumes/data/workspaces/saga',
    });

    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/drew</string>');
    // binPath omitted → the compiled fallback must build from the passed home.
    expect(plist).toContain('<string>/Users/drew/.local/bin/saga</string>');
    expect(plist).not.toContain('/Volumes/data/workspaces/saga');
  });

  it('keeps the checkout as WorkingDirectory for a compiled-but-not-production build', () => {
    // `compiled` decides the exec target; `isProduction` decides the cwd. A compiled
    // binary built without the production --define still reads .env from cwd, so it
    // must stay in the checkout — keying the cwd on `compiled` would break this.
    const plist = renderLaunchdPlist({
      binPath: '/Users/drew/.local/bin/saga',
      compiled: true,
      isProduction: false,
      home: '/Users/drew',
      paths: {
        plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
        stderrPath: '/Users/drew/Library/Logs/saga/service.err.log',
        stdoutPath: '/Users/drew/Library/Logs/saga/service.out.log',
      },
      projectRoot: '/Volumes/data/workspaces/saga',
    });

    expect(plist).toContain(
      '<key>WorkingDirectory</key>\n  <string>/Volumes/data/workspaces/saga</string>',
    );
  });

  it('keeps the project checkout as WorkingDirectory in source mode', () => {
    const plist = renderLaunchdPlist({
      compiled: false,
      isProduction: false,
      paths: {
        plistPath: '/Users/drew/Library/LaunchAgents/com.saga.service.plist',
        stderrPath: '/Users/drew/Library/Logs/saga/service.err.log',
        stdoutPath: '/Users/drew/Library/Logs/saga/service.out.log',
      },
      projectRoot: '/Volumes/data/workspaces/saga',
    });

    expect(plist).toContain(
      '<key>WorkingDirectory</key>\n  <string>/Volumes/data/workspaces/saga</string>',
    );
  });
});

describe('launchdPrintProcess', () => {
  it('reports running only when launchctl output includes a pid', () => {
    expect(launchdPrintProcess('state = running\n\tpid = 12345\n')).toBe('running');
    expect(launchdPrintProcess('state = waiting\n\tlast exit code = 0\n')).toBe('not running');
  });
});

describe('createLaunchdSupervisor', () => {
  it.skipIf(process.platform !== 'darwin')(
    'boots out, bootstraps, and then starts the agent on install',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'saga-launchd-'));
      const calls: string[][] = [];
      try {
        const supervisor = createLaunchdSupervisor({
          cwd: process.cwd(),
          home,
          launchctl: async (args) => {
            calls.push([...args]);
          },
        });

        const report = await supervisor.install();

        expect(report.state).toBe('installed');
        expect(report.plistPath.startsWith(home)).toBe(true);
        expect(existsSync(report.plistPath)).toBe(true);
        expect(readFileSync(report.plistPath, 'utf8')).toContain('com.saga.service');
        const domain = `gui/${String(process.getuid?.() ?? '')}`;
        expect(calls).toStrictEqual([
          ['bootout', domain, report.plistPath],
          ['bootstrap', domain, report.plistPath],
          ['kickstart', `${domain}/com.saga.service`],
        ]);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'installs even when there is no previous agent to boot out',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'saga-launchd-'));
      const calls: string[][] = [];
      try {
        const supervisor = createLaunchdSupervisor({
          cwd: process.cwd(),
          home,
          launchctl: async (args) => {
            calls.push([...args]);
            if (args[0] === 'bootout') {
              throw new Error('Boot-out failed: 3: No such process');
            }
          },
        });

        const report = await supervisor.install();

        expect(report.state).toBe('installed');
        expect(calls.map((args) => args[0])).toStrictEqual(['bootout', 'bootstrap', 'kickstart']);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'retries bootstrap when launchd is still tearing the old agent down',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'saga-launchd-'));
      const calls: string[][] = [];
      let bootstrapAttempts = 0;
      try {
        const supervisor = createLaunchdSupervisor({
          cwd: process.cwd(),
          home,
          launchctl: async (args) => {
            calls.push([...args]);
            if (args[0] === 'bootstrap') {
              bootstrapAttempts += 1;
              if (bootstrapAttempts === 1) {
                throw new Error('Bootstrap failed: 5: Input/output error');
              }
            }
          },
        });

        const report = await supervisor.install();

        expect(report.state).toBe('installed');
        expect(calls.map((args) => args[0])).toStrictEqual([
          'bootout',
          'bootstrap',
          'bootstrap',
          'kickstart',
        ]);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform !== 'darwin')(
    'surfaces the swallowed bootout error when bootstrap fails for good',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'saga-launchd-'));
      const calls: string[][] = [];
      try {
        const supervisor = createLaunchdSupervisor({
          cwd: process.cwd(),
          home,
          launchctl: async (args) => {
            calls.push([...args]);
            if (args[0] === 'bootout') {
              throw new Error('Boot-out failed: 5: Input/output error');
            }
            if (args[0] === 'bootstrap') {
              throw new Error('Bootstrap failed: 5: Input/output error');
            }
          },
        });

        await expect(supervisor.install()).rejects.toThrow(
          /Bootstrap failed.*bootout beforehand also failed.*Boot-out failed/,
        );
        expect(calls.map((args) => args[0])).toStrictEqual([
          'bootout',
          'bootstrap',
          'bootstrap',
          'bootstrap',
        ]);
      } finally {
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === 'darwin')(
    'does not mutate launchd state on non-macOS',
    async () => {
      const report = await createLaunchdSupervisor({ cwd: process.cwd() }).install();

      expect(report).toMatchObject({
        action: 'install',
        detail: 'launchd is only available on macOS',
        state: 'unavailable',
      });
    },
  );
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
