import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  classifyClaudeActivationEvidence,
  classifyCodexActivationEvidence,
  installHarness,
  inspectHarness,
  inspectHarnessWithActivation,
  listHarnessAdapters,
  runHarnessCommand,
  uninstallHarness,
} from './harness.js';
import type { HarnessActivationStatus } from './harness.js';
import { readBindingFile, writeBindingFile } from './init.js';

function boundProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saga-harness-'));
  writeBindingFile(projectRoot, {
    project: {
      gitRemote: undefined,
      root: projectRoot,
    },
    schemaVersion: 1,
    service: {
      databaseUrl: 'env:DATABASE_URL',
    },
    sourceBinding: {
      id: 'source-id',
    },
    workspace: {
      handle: 'saga',
      id: 'workspace-id',
    },
  });
  return projectRoot;
}

describe('listHarnessAdapters', () => {
  test('describes the supported harness targets', () => {
    const projectRoot = '/workspace';

    expect(
      listHarnessAdapters().map((adapter) => ({
        hooksPath: adapter.hooksPath(projectRoot),
        ingestCommand: adapter.ingestCommand,
        sourceUri: adapter.sourceUri('host-id'),
        target: adapter.target,
      })),
    ).toStrictEqual([
      {
        hooksPath: join(projectRoot, '.codex', 'hooks.json'),
        ingestCommand: 'codex-hook',
        sourceUri: 'codex://host/host-id',
        target: 'codex',
      },
      {
        hooksPath: join(projectRoot, '.claude', 'settings.local.json'),
        ingestCommand: 'claude-hook',
        sourceUri: 'claude://host/host-id',
        target: 'claude',
      },
    ]);
  });
});

describe('installHarness', () => {
  test('installs Codex hooks and records local harness state', async () => {
    const projectRoot = boundProject();

    const status = await installHarness({
      cwd: projectRoot,
      registerCodexSource: async () => ({ id: 'codex-source-id' }),
      target: 'codex',
    });

    expect(status.binding).toBe('installed');
    expect(status.hooks).toBe('installed');
    expect(status.hookTrust).toBe('pending user trust');
    expect(status.state).toBe('pending-trust');
    expect(status.stateDetail).toBe(
      'binding and hooks are installed; Codex project-local hook trust is pending explicit user approval',
    );
    expect(status.nextStep).toBe(
      'approve Codex project-local hooks for this workspace, then restart Codex or start a new Codex session here',
    );
    expect(status.hooksPath).toBe(join(projectRoot, '.codex', 'hooks.json'));
    const binding = readBindingFile(projectRoot)!;
    expect(binding?.harnesses?.codex?.sourceBindingId).toBe('codex-source-id');
    expect(binding?.harnesses?.codex?.sourceUri).toBe(`codex://host/${binding.host?.id}`);
    expect(binding?.harnesses?.codex?.hookTrust).toBe('requires-review');
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf8')).toContain('.codex/\n');

    const hooks = JSON.parse(readFileSync(status.hooksPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[]; matcher?: string }[]>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(hooks.hooks.SessionStart?.[0]?.matcher).toBe('startup|resume|clear|compact');
    expect(hooks.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(status.sessionStartCoverage).toBe('complete');
    expect(status.sessionStartDetail).toBe(
      'SessionStart sources configured: startup, resume, clear, compact',
    );

    const commandCheck = spawnSync('/bin/sh', [
      '-n',
      join(projectRoot, '.codex', 'saga-codex-hook.sh'),
    ]);
    expect(commandCheck.status).toBe(0);
  });

  test('installs Claude Code hooks and records local harness state', async () => {
    const projectRoot = boundProject();

    const status = await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: 'claude-source-id' }),
      target: 'claude',
    });

    expect(status.binding).toBe('installed');
    expect(status.hooks).toBe('installed');
    expect(status.hookTrust).toBe('requires review');
    expect(status.hooksPath).toBe(join(projectRoot, '.claude', 'settings.local.json'));
    expect(status.skills).toBe('deferred');
    const binding = readBindingFile(projectRoot)!;
    expect(binding?.harnesses?.claude?.sourceBindingId).toBe('claude-source-id');
    expect(binding?.harnesses?.claude?.sourceUri).toBe(`claude://host/${binding.host?.id}`);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf8')).toContain(
      '.claude/settings.local.json\n',
    );
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf8')).toContain(
      '.claude/saga-claude-hook.sh\n',
    );

    const settings = JSON.parse(readFileSync(status.hooksPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[]; matcher?: string }[]>;
    };
    expect(settings.hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(settings.hooks.SessionStart?.[0]?.matcher).toBe('startup|resume|clear|compact');
    expect(settings.hooks.UserPromptSubmit?.[0]?.hooks[0]?.command).toBe(status.hookCommand);
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe(status.hookCommand);

    const commandCheck = spawnSync('/bin/sh', [
      '-n',
      join(projectRoot, '.claude', 'saga-claude-hook.sh'),
    ]);
    expect(commandCheck.status).toBe(0);
  });

  test('preserves non-Saga Codex hooks', async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(
      hooksPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ command: 'echo keep', type: 'command' }],
            },
          ],
        },
      })}\n`,
    );

    await installHarness({
      cwd: projectRoot,
      registerCodexSource: async () => ({ id: 'codex-source-id' }),
      target: 'codex',
    });
    uninstallHarness({ cwd: projectRoot, target: 'codex' });

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: { Stop?: { hooks: { command: string }[] }[] };
    };
    expect(hooks.hooks.Stop?.[0]?.hooks[0]?.command).toBe('echo keep');
    expect(inspectHarness({ cwd: projectRoot, target: 'codex' }).hooks).toBe('missing');
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test('preserves non-Saga Claude hooks', async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
    mkdirSync(join(projectRoot, '.claude'));
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ command: 'echo keep', type: 'command' }],
            },
          ],
        },
      })}\n`,
    );

    await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: 'claude-source-id' }),
      target: 'claude',
    });
    uninstallHarness({ cwd: projectRoot, target: 'claude' });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { Stop?: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toBe('echo keep');
    expect(inspectHarness({ cwd: projectRoot, target: 'claude' }).hooks).toBe('missing');
    expect(readBindingFile(projectRoot)?.harnesses?.claude).toBeUndefined();
  });

  test('preserves valid non-command Claude hooks', async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
    mkdirSync(join(projectRoot, '.claude'));
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { prompt: 'Summarize the session', type: 'prompt' },
                { server: 'memory', tool: 'store', type: 'mcp_tool' },
                { prompt: 'Inspect this event', type: 'agent' },
                { type: 'http', url: 'https://example.invalid/hook' },
              ],
            },
          ],
        },
      })}\n`,
    );

    await installHarness({
      cwd: projectRoot,
      registerClaudeSource: async () => ({ id: 'claude-source-id' }),
      target: 'claude',
    });
    uninstallHarness({ cwd: projectRoot, target: 'claude' });

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: { Stop?: { hooks: { type: string }[] }[] };
    };
    expect(settings.hooks.Stop?.[0]?.hooks.map((hook) => hook.type)).toStrictEqual([
      'prompt',
      'mcp_tool',
      'agent',
      'http',
    ]);
  });

  test('requires saga init first', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-harness-missing-'));

    await expect(installHarness({ cwd: projectRoot, target: 'codex' })).rejects.toThrow(
      'run saga init before installing the codex harness',
    );
  });

  test('does not write active hooks when Codex source registration fails', async () => {
    const projectRoot = boundProject();

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => {
          throw new Error('database unavailable');
        },
        target: 'codex',
      }),
    ).rejects.toThrow('database unavailable');

    expect(existsSync(join(projectRoot, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(projectRoot, '.codex', 'saga-codex-hook.sh'))).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test('does not write active hooks when database migrations are stale', async () => {
    const projectRoot = boundProject();

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => {
          throw new Error('database migrations are not current: 2 applied; expected 3');
        },
        target: 'codex',
      }),
    ).rejects.toThrow('database migrations are not current');

    expect(existsSync(join(projectRoot, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(projectRoot, '.codex', 'saga-codex-hook.sh'))).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test('rolls back local binding when hook activation dependencies fail', async () => {
    const projectRoot = boundProject();
    mkdirSync(join(projectRoot, '.gitignore'));

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => ({ id: 'codex-source-id' }),
        target: 'codex',
      }),
    ).rejects.toThrow('EISDIR');

    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
    expect(existsSync(join(projectRoot, '.codex', 'hooks.json'))).toBe(false);
    expect(existsSync(join(projectRoot, '.codex', 'saga-codex-hook.sh'))).toBe(false);
  });

  test('rejects shape-invalid Codex hooks config before recording local harness state', async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: {} } }));

    await expect(
      installHarness({
        cwd: projectRoot,
        registerCodexSource: async () => ({ id: 'codex-source-id' }),
        target: 'codex',
      }),
    ).rejects.toThrow(`invalid Codex hooks file ${hooksPath}: expected hooks.Stop to be an array`);

    expect(readBindingFile(projectRoot)?.harnesses?.codex).toBeUndefined();
  });

  test('validates hook settings before registering source bindings', async () => {
    const projectRoot = boundProject();
    const settingsPath = join(projectRoot, '.claude', 'settings.local.json');
    mkdirSync(join(projectRoot, '.claude'));
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: {} } }));
    let registered = false;

    await expect(
      installHarness({
        cwd: projectRoot,
        registerClaudeSource: async () => {
          registered = true;
          return { id: 'claude-source-id' };
        },
        target: 'claude',
      }),
    ).rejects.toThrow(
      `invalid Claude settings file ${settingsPath}: expected hooks.Stop to be an array`,
    );

    expect(registered).toBe(false);
    expect(readBindingFile(projectRoot)?.harnesses?.claude).toBeUndefined();
  });
});

describe('inspectHarness', () => {
  test('reports missing harness state when binding and hooks are absent', () => {
    const projectRoot = boundProject();

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('missing');
    expect(status.stateDetail).toBe('binding and hooks are not installed');
    expect(status.hooksCoverage).toBe('none');
  });

  test('reports divergent harness state when binding exists without hooks', () => {
    const projectRoot = boundProject();
    const binding = readBindingFile(projectRoot)!;
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        codex: {
          hookCommand: `'${join(projectRoot, '.codex', 'saga-codex-hook.sh')}'`,
          hookTrust: 'requires-review',
          hooksPath: join(projectRoot, '.codex', 'hooks.json'),
          installedAt: new Date().toISOString(),
          sourceBindingId: 'codex-source-id',
          sourceUri: `codex://host/${binding.host?.id}`,
          target: 'codex',
        },
      },
    });

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('divergent');
    expect(status.stateDetail).toBe('local binding exists but hooks are missing');
  });

  test('reports divergent harness state when partial hooks exist without binding', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  command: `'${join(projectRoot, '.codex', 'saga-codex-hook.sh')}'`,
                  type: 'command',
                },
              ],
            },
          ],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('divergent');
    expect(status.hooksCoverage).toBe('partial');
    expect(status.stateDetail).toBe(
      'Saga hooks are partially installed but local binding is missing',
    );
  });

  test('reports divergent harness state when legacy direct hooks exist without binding', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
          Stop: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('divergent');
    expect(status.hooksCoverage).toBe('complete');
    expect(status.stateDetail).toBe('hooks are installed but local binding is missing');
  });

  test('reports pending Codex trust for complete recognized shim hooks', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.codex'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        codex: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'codex-source-id',
          sourceUri: `codex://host/${binding.host?.id}`,
          target: 'codex',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('pending-trust');
    expect(status.hooks).toBe('installed');
    expect(status.hooksCoverage).toBe('complete');
    expect(status.sessionStartCoverage).toBe('complete');
    expect(status.sessionStartDetail).toBe(
      'SessionStart sources configured: startup, resume, clear, compact',
    );
    expect(status.hookTrust).toBe('pending user trust');
    expect(status.stateDetail).toBe(
      'binding and hooks are installed; Codex project-local hook trust is pending explicit user approval',
    );
    expect(status.nextStep).toBe(
      'approve Codex project-local hooks for this workspace, then restart Codex or start a new Codex session here',
    );
  });

  test('reports divergent state when SessionStart matcher misses continuation sources', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.codex'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        codex: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'codex-source-id',
          sourceUri: `codex://host/${binding.host?.id}`,
          target: 'codex',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ matcher: 'startup', hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('divergent');
    expect(status.hooks).toBe('installed');
    expect(status.hooksCoverage).toBe('complete');
    expect(status.sessionStartCoverage).toBe('partial');
    expect(status.sessionStartDetail).toBe(
      'SessionStart sources configured: startup; missing: resume, clear, compact',
    );
    expect(status.stateDetail).toBe(
      'local binding exists but SessionStart sources configured: startup; missing: resume, clear, compact',
    );
  });

  test('reports configured Claude state for complete recognized shim hooks', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.claude', 'settings.local.json');
    const shimPath = join(projectRoot, '.claude', 'saga-claude-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.claude'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        claude: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'claude-source-id',
          sourceUri: `claude://host/${binding.host?.id}`,
          target: 'claude',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'claude' });

    expect(status.state).toBe('configured');
    expect(status.hooks).toBe('installed');
    expect(status.hooksCoverage).toBe('complete');
    expect(status.hookTrust).toBe('requires review');
    expect(status.stateDetail).toBe('binding is valid and complete Saga hooks are active');
    expect(status.nextStep).toBeUndefined();
  });

  test('reports stale harness state for legacy unhosted local source bindings', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    mkdirSync(join(projectRoot, '.codex'));
    const { host: _host, ...legacyBinding } = readBindingFile(projectRoot)!;
    writeFileSync(
      join(projectRoot, '.saga.local.json'),
      `${JSON.stringify({
        ...legacyBinding,
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: 'requires-review',
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: 'codex-source-id',
            sourceUri: 'codex://local',
            target: 'codex',
          },
        },
      })}\n`,
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('stale');
    expect(status.stateDetail).toContain('local binding host id is missing');
  });

  test('reports invalid harness state for malformed local harness binding', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeBindingFile(projectRoot, {
      ...readBindingFile(projectRoot)!,
      harnesses: {
        codex: {
          hookCommand: `'${join(projectRoot, '.codex', 'saga-codex-hook.sh')}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: '',
          sourceUri: 'codex://local',
          target: 'codex',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
          Stop: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: 'saga ingest codex-hook', type: 'command' }] }],
        },
      }),
    );

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.state).toBe('invalid');
    expect(status.hooks).toBe('installed');
    expect(status.stateDetail).toBe(
      'invalid harness binding: sourceBindingId must be a non-empty string',
    );
  });

  test('reports stale harness state when binding metadata no longer matches the adapter', () => {
    const projectRoot = boundProject();
    writeBindingFile(projectRoot, {
      ...readBindingFile(projectRoot)!,
      harnesses: {
        claude: {
          hookCommand: `'${join(projectRoot, '.claude', 'saga-claude-hook.sh')}'`,
          hookTrust: 'requires-review',
          hooksPath: join(projectRoot, '.claude', 'settings.json'),
          installedAt: new Date().toISOString(),
          sourceBindingId: 'claude-source-id',
          sourceUri: 'claude://local',
          target: 'claude',
        },
      },
    });

    const status = inspectHarness({ cwd: projectRoot, target: 'claude' });

    expect(status.state).toBe('stale');
    expect(status.stateDetail).toContain('binding hooks path does not match the current adapter');
  });

  test('reports malformed Codex hooks config', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(hooksPath, '{invalid-json');

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.hooks).toBe('invalid');
    expect(status.hookTrust).toBe('not installed');
    expect(status.hooksError).toContain(`invalid Codex hooks file ${hooksPath}:`);
  });

  test('reports shape-invalid Codex hooks config', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(hooksPath, JSON.stringify({ hooks: { Stop: {} } }));

    const status = inspectHarness({ cwd: projectRoot, target: 'codex' });

    expect(status.hooks).toBe('invalid');
    expect(status.hooksError).toBe(
      `invalid Codex hooks file ${hooksPath}: expected hooks.Stop to be an array`,
    );
  });
});

describe('classifyCodexActivationEvidence', () => {
  const checkedAt = new Date('2026-06-22T12:00:00.000Z');

  test('proves activation from recent real Codex hook events', () => {
    const status = classifyCodexActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'codex.SessionStart',
          occurredAt: '2026-06-22T11:00:00.000Z',
          payload: { hook_event_name: 'SessionStart', source: 'resume' },
          provenance: { hookEventName: 'SessionStart' },
        }),
        rawActivationEvent({
          eventType: 'codex.UserPromptSubmit',
          occurredAt: '2026-06-22T11:15:00.000Z',
          payload: { hook_event_name: 'UserPromptSubmit' },
          provenance: { hookEventName: 'UserPromptSubmit' },
        }),
      ],
    });

    expect(status.state).toBe('active');
    expect(status.detail).toContain('recent Codex hook raw_event found');
    expect(status.sessionStartSources.observed).toStrictEqual(['resume']);
    expect(status.sessionStartSources.unproven).toStrictEqual(['startup', 'clear', 'compact']);
  });

  test('distinguishes stale real hook evidence', () => {
    const status = classifyCodexActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'codex.UserPromptSubmit',
          occurredAt: '2026-06-20T11:15:00.000Z',
          payload: { hook_event_name: 'UserPromptSubmit' },
          provenance: { hookEventName: 'UserPromptSubmit' },
        }),
      ],
    });

    expect(status.state).toBe('stale');
    expect(status.detail).toContain('latest real Codex hook raw_event is stale');
    expect(status.nextStep).toContain('restart Codex');
  });

  test('distinguishes manual or synthetic raw events from hook activation proof', () => {
    const status = classifyCodexActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'codex.UserPromptSubmit',
          occurredAt: '2026-06-22T11:15:00.000Z',
          payload: { hook_event_name: 'UserPromptSubmit', synthetic: true },
          provenance: { hookEventName: 'UserPromptSubmit' },
        }),
        rawActivationEvent({
          eventType: 'codex.SessionStart',
          occurredAt: '2026-06-22T11:00:00.000Z',
          payload: {},
          provenance: {},
        }),
      ],
    });

    expect(status.state).toBe('manual-only');
    expect(status.detail).toContain('manual/synthetic or lack hook provenance');
  });

  test('treats file-ingested Codex hook markers as manual-only', () => {
    const status = classifyCodexActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'codex.UserPromptSubmit',
          occurredAt: '2026-06-22T11:15:00.000Z',
          payload: {
            captureMode: 'manual',
            hook_event_name: 'UserPromptSubmit',
            sagaManualIngest: true,
          },
          provenance: {
            captureMode: 'manual',
            hookEventName: 'UserPromptSubmit',
            sagaManualIngest: true,
          },
        }),
      ],
    });

    expect(status.state).toBe('manual-only');
    expect(status.nextStep).toContain('interactive Codex session');
  });

  test('reports no evidence when no matching rows are present', () => {
    const status = classifyCodexActivationEvidence({
      checkedAt,
      events: [],
    });

    expect(status.state).toBe('no-evidence');
    expect(status.detail).toContain('no Codex SessionStart/UserPromptSubmit raw_events found');
    expect(status.nextStep).toContain('approve Codex project-local hooks');
  });
});

describe('classifyClaudeActivationEvidence', () => {
  const checkedAt = new Date('2026-06-22T12:00:00.000Z');

  test('proves activation from recent real Claude Code hook events', () => {
    const status = classifyClaudeActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'claude.SessionStart',
          occurredAt: '2026-06-22T11:00:00.000Z',
          payload: { hook_event_name: 'SessionStart', source: 'startup' },
          provenance: { hookEventName: 'SessionStart' },
          sourceType: 'claude',
        }),
        rawActivationEvent({
          eventType: 'claude.UserPromptSubmit',
          occurredAt: '2026-06-22T11:15:00.000Z',
          payload: { hook_event_name: 'UserPromptSubmit' },
          provenance: { hookEventName: 'UserPromptSubmit' },
          sourceType: 'claude',
        }),
      ],
    });

    expect(status.state).toBe('active');
    expect(status.detail).toContain('recent Claude Code hook raw_event found');
    expect(status.sessionStartSources.observed).toStrictEqual(['startup']);
    expect(status.sessionStartSources.unproven).toStrictEqual(['resume', 'clear', 'compact']);
  });

  test('distinguishes stale Claude Code hook evidence', () => {
    const status = classifyClaudeActivationEvidence({
      checkedAt,
      events: [
        rawActivationEvent({
          eventType: 'claude.UserPromptSubmit',
          occurredAt: '2026-06-20T11:15:00.000Z',
          payload: { hook_event_name: 'UserPromptSubmit' },
          provenance: { hookEventName: 'UserPromptSubmit' },
          sourceType: 'claude',
        }),
      ],
    });

    expect(status.state).toBe('stale');
    expect(status.detail).toContain('latest real Claude Code hook raw_event is stale');
    expect(status.nextStep).toContain('run saga harness status claude again');
  });

  test('reports no evidence for installed Claude Code hooks without raw events', () => {
    const status = classifyClaudeActivationEvidence({
      checkedAt,
      events: [],
    });

    expect(status.state).toBe('no-evidence');
    expect(status.detail).toContain('no Claude Code SessionStart/UserPromptSubmit raw_events');
    expect(status.nextStep).toBe(
      'start or resume Claude Code in this workspace, submit a prompt, then run saga harness status claude again',
    );
  });
});

describe('inspectHarnessWithActivation', () => {
  test('promotes Codex pending trust to configured when recent hook evidence proves activation', async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.codex'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        codex: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'codex-source-id',
          sourceUri: `codex://host/${binding.host?.id}`,
          target: 'codex',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = await inspectHarnessWithActivation({
      cwd: projectRoot,
      target: 'codex',
      verifyActivation: async () => activeActivation(),
    });

    expect(status.state).toBe('configured');
    expect(status.hookTrust).toBe('trusted by evidence');
    expect(status.nextStep).toBeUndefined();
    expect(status.stateDetail).toContain('recent Codex hook raw_event found');
  });

  test('does not promote stale static integration state with active evidence', async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    const { host: _host, ...legacyBinding } = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(
      join(projectRoot, '.saga.local.json'),
      `${JSON.stringify({
        ...legacyBinding,
        harnesses: {
          codex: {
            hookCommand: `'${shimPath}'`,
            hookTrust: 'requires-review',
            hooksPath,
            installedAt: new Date().toISOString(),
            sourceBindingId: 'codex-source-id',
            sourceUri: 'codex://local',
            target: 'codex',
          },
        },
      })}\n`,
    );
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = await inspectHarnessWithActivation({
      cwd: projectRoot,
      target: 'codex',
      verifyActivation: async () => activeActivation(),
    });

    expect(status.state).toBe('stale');
    expect(status.hookTrust).toBe('requires review');
    expect(status.stateDetail).toContain('local binding host id is missing');
    expect(status.activation.state).toBe('active');
  });

  test('reports missing Claude Code binding before checking raw-event evidence', async () => {
    const projectRoot = boundProject();

    const status = await inspectHarnessWithActivation({
      cwd: projectRoot,
      target: 'claude',
    });

    expect(status.state).toBe('missing');
    expect(status.activation.state).toBe('missing-binding');
    expect(status.activation.detail).toBe(
      'Claude Code harness source binding is missing; run saga harness install claude',
    );
    expect(status.nextStep).toBe(
      'run saga init and saga harness install claude before checking activation',
    );
  });

  test('reports missing Claude Code hooks separately from no evidence', async () => {
    const projectRoot = boundProject();
    const binding = readBindingFile(projectRoot)!;
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        claude: {
          hookCommand: `'${join(projectRoot, '.claude', 'saga-claude-hook.sh')}'`,
          hookTrust: 'requires-review',
          hooksPath: join(projectRoot, '.claude', 'settings.local.json'),
          installedAt: new Date().toISOString(),
          sourceBindingId: 'claude-source-id',
          sourceUri: `claude://host/${binding.host?.id}`,
          target: 'claude',
        },
      },
    });

    const status = await inspectHarnessWithActivation({
      cwd: projectRoot,
      target: 'claude',
    });

    expect(status.state).toBe('divergent');
    expect(status.activation.state).toBe('missing-hooks');
    expect(status.activation.detail).toBe(
      'Claude Code harness hooks are missing; run saga harness install claude',
    );
    expect(status.nextStep).toContain('run saga harness install claude');
  });

  test('reports installed Claude Code hooks with no recent activation evidence', async () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.claude', 'settings.local.json');
    const shimPath = join(projectRoot, '.claude', 'saga-claude-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.claude'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        claude: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'claude-source-id',
          sourceUri: `claude://host/${binding.host?.id}`,
          target: 'claude',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const status = await inspectHarnessWithActivation({
      cwd: projectRoot,
      target: 'claude',
      verifyActivation: async () =>
        classifyClaudeActivationEvidence({
          checkedAt: new Date('2026-06-22T12:00:00.000Z'),
          events: [],
        }),
    });

    expect(status.state).toBe('configured');
    expect(status.activation.state).toBe('no-evidence');
    expect(status.nextStep).toBe(
      'start or resume Claude Code in this workspace, submit a prompt, then run saga harness status claude again',
    );
  });
});

describe('runHarnessCommand', () => {
  test('renders Codex pending-trust next step in status records', async () => {
    const projectRoot = realpathSync(boundProject());
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    const shimPath = join(projectRoot, '.codex', 'saga-codex-hook.sh');
    const binding = readBindingFile(projectRoot)!;
    mkdirSync(join(projectRoot, '.codex'));
    writeBindingFile(projectRoot, {
      ...binding,
      harnesses: {
        codex: {
          hookCommand: `'${shimPath}'`,
          hookTrust: 'requires-review',
          hooksPath,
          installedAt: new Date().toISOString(),
          sourceBindingId: 'codex-source-id',
          sourceUri: `codex://host/${binding.host?.id}`,
          target: 'codex',
        },
      },
    });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          Stop: [{ hooks: [{ command: shimPath, type: 'command' }] }],
          UserPromptSubmit: [{ hooks: [{ command: shimPath, type: 'command' }] }],
        },
      }),
    );

    const output = await withoutDatabaseUrl(() =>
      withCwd(projectRoot, () =>
        runHarnessCommand(['status', 'codex'], {
          ascii: true,
          color: 'never',
          format: 'records',
          isTty: false,
        }),
      ),
    );

    expect(output).toContain('state           pending-trust');
    expect(output).toContain('hooks           installed');
    expect(output).toContain(
      'session start   complete; SessionStart sources configured: startup, resume, clear, compact',
    );
    expect(output).toContain(
      'activation      missing-database; DATABASE_URL is not set; activation verification cannot query raw_events',
    );
    expect(output).toContain('hook trust      pending user trust');
    expect(output).toContain(
      'next step       set DATABASE_URL in this workspace, ensure migrations are current, then run saga harness status codex again',
    );
  });

  test('renders activation next steps for not-proven non-pending states', async () => {
    const projectRoot = realpathSync(boundProject());
    const output = await withCwd(projectRoot, () =>
      runHarnessCommand(['status', 'codex'], {
        ascii: true,
        color: 'never',
        format: 'records',
        isTty: false,
      }),
    );

    expect(output).toContain('state           missing');
    expect(output).toContain('detail          binding and hooks are not installed');
    expect(output).toContain(
      'activation      missing-binding; Codex harness source binding is missing; run saga harness install codex',
    );
    expect(output).toContain('next step       run saga init and saga harness install codex');
  });

  test('reports all harness targets when status target is omitted', async () => {
    const projectRoot = boundProject();
    const output = await withoutDatabaseUrl(() =>
      withCwd(projectRoot, () =>
        runHarnessCommand(['status'], {
          ascii: true,
          color: 'never',
          format: 'json',
          isTty: false,
        }),
      ),
    );

    const statuses = JSON.parse(output) as { state: string; target: string }[];
    expect(statuses.map((status) => status.target)).toStrictEqual(['codex', 'claude']);
    expect(statuses.map((status) => status.state)).toStrictEqual(['missing', 'missing']);
  });
});

describe('uninstallHarness', () => {
  test('reports malformed Codex hooks config with path', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(hooksPath, '{invalid-json');

    expect(() => uninstallHarness({ cwd: projectRoot, target: 'codex' })).toThrow(
      `invalid Codex hooks file ${hooksPath}:`,
    );
  });

  test('preserves non-command Codex hooks', () => {
    const projectRoot = boundProject();
    const hooksPath = join(projectRoot, '.codex', 'hooks.json');
    mkdirSync(join(projectRoot, '.codex'));
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ prompt: 'Summarize the session', type: 'prompt' }],
            },
          ],
        },
      }),
    );

    uninstallHarness({ cwd: projectRoot, target: 'codex' });

    const hooks = JSON.parse(readFileSync(hooksPath, 'utf8')) as {
      hooks: { Stop?: { hooks: { type: string }[] }[] };
    };
    expect(hooks.hooks.Stop?.[0]?.hooks.map((hook) => hook.type)).toStrictEqual(['prompt']);
  });
});

function withCwd<T>(cwd: string, run: () => T): T {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(previous);
  }
}

async function withoutDatabaseUrl<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previous;
    }
  }
}

function activeActivation(): HarnessActivationStatus {
  return {
    checkedAt: '2026-06-22T12:00:00.000Z',
    detail:
      'recent Codex hook raw_event found: codex.UserPromptSubmit at 2026-06-22T11:15:00.000Z; SessionStart sources observed: startup; unproven: resume, clear, compact',
    lastEvent: {
      eventType: 'codex.UserPromptSubmit',
      occurredAt: '2026-06-22T11:15:00.000Z',
    },
    recentWithinHours: 24,
    sessionStartSources: {
      observed: ['startup'],
      unproven: ['resume', 'clear', 'compact'],
    },
    state: 'active',
  };
}

function rawActivationEvent(input: {
  eventType:
    | 'claude.SessionStart'
    | 'claude.UserPromptSubmit'
    | 'codex.SessionStart'
    | 'codex.UserPromptSubmit';
  occurredAt: string;
  payload: Record<string, unknown>;
  provenance: Record<string, unknown>;
  sourceType?: 'claude' | 'codex';
}): any {
  const sourceType = input.sourceType ?? 'codex';
  return {
    actorId: sourceType,
    createdAt: new Date(input.occurredAt),
    eventType: input.eventType,
    externalEventId: `${input.eventType}:${input.occurredAt}`,
    id: `${input.eventType}:${input.occurredAt}`,
    ingestedAt: new Date(input.occurredAt),
    occurredAt: new Date(input.occurredAt),
    payload: input.payload,
    provenance: input.provenance,
    sessionId: 'session-id',
    sourceBindingId: `${sourceType}-source-id`,
    sourceId: `${sourceType}:local`,
    sourceType,
    traceId: 'turn-id',
    trustLevel: 'raw',
    updatedAt: new Date(input.occurredAt),
    workspaceId: 'workspace-id',
  };
}
