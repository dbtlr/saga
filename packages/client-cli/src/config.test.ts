import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorkspaceBindingFile } from './binding.js';
import { clientSpoolDir, loadClientConfig, resolveWorkspaceBinding } from './config.js';

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'saga-client-config-'));
  mkdirSync(join(home, '.saga'), { recursive: true });
  return home;
}

function writeConfig(home: string, config: unknown): void {
  writeFileSync(join(home, '.saga', 'config.json'), JSON.stringify(config));
}

const representativeBinding: WorkspaceBindingFile = {
  project: { gitRemote: 'git@example.com:acme/app.git', root: '/checkout' },
  schemaVersion: 1,
  service: { databaseUrl: 'installation-config' },
  sourceBinding: { id: 'source-binding-id' },
  workspace: { handle: 'app', id: 'workspace-id' },
};

describe('loadClientConfig', () => {
  it('resolves the new client keys from a config file', () => {
    const home = tempHome();
    writeConfig(home, {
      authToken: 'secret-token',
      hostname: 'laptop.local',
      service: { url: 'https://saga.example.com' },
      spool: { dir: '/var/spool/saga' },
      workspaces: {
        '/checkout': { repo: { remote: 'git@example.com:acme/app.git' }, workspaceId: 'ws-1' },
      },
    });

    const config = loadClientConfig({ homeDir: home });

    expect(config).toStrictEqual({
      authToken: 'secret-token',
      hostname: 'laptop.local',
      service: { url: 'https://saga.example.com' },
      spool: { dir: '/var/spool/saga' },
      workspaces: {
        '/checkout': { repo: { remote: 'git@example.com:acme/app.git' }, workspaceId: 'ws-1' },
      },
    });
  });

  it('returns empty defaults when the config file is absent', () => {
    const home = tempHome();
    expect(loadClientConfig({ homeDir: home })).toStrictEqual({ workspaces: {} });
  });

  it('returns empty defaults for missing keys', () => {
    const home = tempHome();
    writeConfig(home, {});
    expect(loadClientConfig({ homeDir: home })).toStrictEqual({ workspaces: {} });
  });

  it('parses a legacy database-only config without error and without new keys', () => {
    const home = tempHome();
    writeConfig(home, { database: { url: 'postgres://localhost/saga' } });
    expect(loadClientConfig({ homeDir: home })).toStrictEqual({ workspaces: {} });
  });

  it('drops malformed workspace entries rather than throwing', () => {
    const home = tempHome();
    writeConfig(home, {
      workspaces: {
        '/bad': { repo: 'not-an-object' },
        '/good': { workspaceId: 'ws-1' },
      },
    });
    expect(loadClientConfig({ homeDir: home }).workspaces).toStrictEqual({
      '/good': { workspaceId: 'ws-1' },
    });
  });

  it('is tolerant of an unparseable config file', () => {
    const home = tempHome();
    writeFileSync(join(home, '.saga', 'config.json'), '{ not json');
    expect(loadClientConfig({ homeDir: home })).toStrictEqual({ workspaces: {} });
  });
});

describe('clientSpoolDir', () => {
  it('defaults to <home>/.saga/spool when unset', () => {
    const home = tempHome();
    const config = loadClientConfig({ homeDir: home });
    expect(clientSpoolDir(config, { homeDir: home })).toBe(resolve(home, '.saga', 'spool'));
  });

  it('honors a configured spool dir', () => {
    const home = tempHome();
    writeConfig(home, { spool: { dir: '/var/spool/saga' } });
    const config = loadClientConfig({ homeDir: home });
    expect(clientSpoolDir(config, { homeDir: home })).toBe('/var/spool/saga');
  });
});

describe('resolveWorkspaceBinding', () => {
  it('answers from the client config workspaces map on an exact-path hit', () => {
    const home = tempHome();
    writeConfig(home, {
      workspaces: { '/checkout': { workspaceId: 'ws-1' } },
    });
    expect(resolveWorkspaceBinding('/checkout', { homeDir: home })).toStrictEqual({
      binding: { workspaceId: 'ws-1' },
      source: 'client-config',
    });
  });

  it('matches a workspaces-map key regardless of trailing-slash normalization', () => {
    const home = tempHome();
    writeConfig(home, {
      workspaces: { '/checkout': { workspaceId: 'ws-1' } },
    });
    expect(resolveWorkspaceBinding('/checkout/', { homeDir: home })).toStrictEqual({
      binding: { workspaceId: 'ws-1' },
      source: 'client-config',
    });
  });

  it('treats a malformed .saga.local.json as no binding rather than throwing', () => {
    const home = tempHome();
    writeConfig(home, { workspaces: {} });
    const checkout = mkdtempSync(join(tmpdir(), 'saga-client-checkout-'));
    writeFileSync(join(checkout, '.saga.local.json'), '{ not json');
    expect(resolveWorkspaceBinding(checkout, { homeDir: home })).toStrictEqual({ source: 'none' });
  });

  it('falls back to .saga.local.json on a workspaces-map miss', () => {
    const home = tempHome();
    writeConfig(home, { workspaces: {} });
    const checkout = mkdtempSync(join(tmpdir(), 'saga-client-checkout-'));
    writeFileSync(
      join(checkout, '.saga.local.json'),
      `${JSON.stringify(representativeBinding, null, 2)}\n`,
    );

    expect(resolveWorkspaceBinding(checkout, { homeDir: home })).toStrictEqual({
      binding: representativeBinding,
      source: 'binding-file',
    });
  });

  it('reports no binding when neither source answers', () => {
    const home = tempHome();
    const checkout = mkdtempSync(join(tmpdir(), 'saga-client-checkout-'));
    expect(resolveWorkspaceBinding(checkout, { homeDir: home })).toStrictEqual({ source: 'none' });
  });
});
