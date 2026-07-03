import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveEmbeddingCredential } from './embedding-credential.js';

// A workspace with an installation config that sets embeddings.openaiApiKey, a Codex
// auth file that carries a cached key, and isolated homes so nothing reads the real
// machine. Each tier can be selectively populated by the individual tests.
function workspace(config: {
  codexKey?: string;
  installationKey?: string;
  installationRemote?: 'enabled' | 'disabled';
}): { env: NodeJS.ProcessEnv; homeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'saga-credential-'));
  const sagaHome = join(root, 'saga-home');
  const codexHome = join(root, 'codex-home');
  const homeDir = join(root, 'home');
  mkdirSync(sagaHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  if (config.installationKey !== undefined || config.installationRemote !== undefined) {
    const embeddings: Record<string, unknown> = {};
    if (config.installationRemote !== undefined) {
      embeddings.remote = config.installationRemote;
    }
    if (config.installationKey !== undefined) {
      embeddings.openaiApiKey = config.installationKey;
    }
    writeFileSync(join(sagaHome, 'config.json'), JSON.stringify({ embeddings }));
  }
  if (config.codexKey !== undefined) {
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: config.codexKey }),
    );
  }

  return { env: { CODEX_HOME: codexHome, SAGA_HOME: sagaHome }, homeDir };
}

describe('resolveEmbeddingCredential', () => {
  it('resolves the OPENAI_API_KEY environment variable first', () => {
    const { env, homeDir } = workspace({
      codexKey: 'sk-codex',
      installationKey: 'sk-installation',
    });

    const credential = resolveEmbeddingCredential({
      env: { ...env, OPENAI_API_KEY: 'sk-environment' },
      homeDir,
    });

    expect(credential.status).toBe('available');
    if (credential.status !== 'available') {
      return;
    }
    expect(credential.apiKey).toBe('sk-environment');
    expect(credential.source).toBe('environment');
  });

  it('resolves OPENAI_API_KEY_FILE when the direct variable is unset', () => {
    const { env, homeDir } = workspace({ codexKey: 'sk-codex' });
    const root = mkdtempSync(join(tmpdir(), 'saga-credential-file-'));
    const keyFile = join(root, 'openai-key');
    writeFileSync(keyFile, 'sk-from-file\n');

    const credential = resolveEmbeddingCredential({
      env: { ...env, OPENAI_API_KEY_FILE: keyFile },
      homeDir,
    });

    expect(credential.status).toBe('available');
    if (credential.status !== 'available') {
      return;
    }
    expect(credential.apiKey).toBe('sk-from-file');
    expect(credential.source).toBe('environment');
  });

  it('falls back to installation config when the environment has no key', () => {
    const { env, homeDir } = workspace({
      codexKey: 'sk-codex',
      installationKey: 'sk-installation',
    });

    const credential = resolveEmbeddingCredential({ env, homeDir });

    expect(credential.status).toBe('available');
    if (credential.status !== 'available') {
      return;
    }
    expect(credential.apiKey).toBe('sk-installation');
    expect(credential.source).toBe('installation-config');
  });

  it('falls back to the Codex cached key when neither env nor installation config has one', () => {
    const { env, homeDir } = workspace({ codexKey: 'sk-codex' });

    const credential = resolveEmbeddingCredential({ env, homeDir });

    expect(credential.status).toBe('available');
    if (credential.status !== 'available') {
      return;
    }
    expect(credential.apiKey).toBe('sk-codex');
    expect(credential.source).toBe('codex-auth');
  });

  it('ignores a blank installation key and falls through to Codex', () => {
    const { env, homeDir } = workspace({ codexKey: 'sk-codex', installationKey: '   ' });

    const credential = resolveEmbeddingCredential({ env, homeDir });

    expect(credential.status).toBe('available');
    if (credential.status !== 'available') {
      return;
    }
    expect(credential.apiKey).toBe('sk-codex');
    expect(credential.source).toBe('codex-auth');
  });

  it('reports unavailable with the Codex reason when no tier provides a key', () => {
    const { env, homeDir } = workspace({ installationRemote: 'enabled' });

    const credential = resolveEmbeddingCredential({ env, homeDir });

    expect(credential.status).toBe('unavailable');
    if (credential.status !== 'unavailable') {
      return;
    }
    expect(credential.reason).toBe('missing-auth-file');
    expect(credential.detail).toContain('no Codex auth file found');
  });
});
