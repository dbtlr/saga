import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCodexAuth } from './codex-auth.js';

describe('resolveCodexAuth', () => {
  it('uses CODEX_HOME/auth.json before ~/.codex/auth.json', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    const codexHome = join(cwd, 'codex-home');
    const userHome = join(cwd, 'home');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-codex' }));
    writeFileSync(
      join(userHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-home' }),
    );

    const auth = resolveCodexAuth({
      env: { CODEX_HOME: codexHome },
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      displayPath: 'CODEX_HOME/auth.json',
      mode: 'api-key',
      source: 'codex-home',
      status: 'available',
    });
    expect(auth.status === 'available' ? auth.openaiApiKey : undefined).toBe('sk-codex');
    expect(auth.detail).not.toContain('sk-codex');
  });

  it('falls back to ~/.codex/auth.json when CODEX_HOME/auth.json is absent', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    const codexHome = join(cwd, 'codex-home');
    const userHome = join(cwd, 'home');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(
      join(userHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-home' }),
    );

    const auth = resolveCodexAuth({
      env: { CODEX_HOME: codexHome },
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      displayPath: '~/.codex/auth.json',
      mode: 'api-key',
      source: 'user-home',
      status: 'available',
    });
    expect(auth.status === 'available' ? auth.openaiApiKey : undefined).toBe('sk-home');
  });

  it('falls back to ~/.codex/auth.json when CODEX_HOME/auth.json has login tokens without an API key', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    const codexHome = join(cwd, 'codex-home');
    const userHome = join(cwd, 'home');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(
      join(codexHome, 'auth.json'),
      JSON.stringify({
        account_id: 'acct_123',
        tokens: {
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    );
    writeFileSync(
      join(userHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-home' }),
    );

    const auth = resolveCodexAuth({
      env: { CODEX_HOME: codexHome },
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      displayPath: '~/.codex/auth.json',
      mode: 'api-key',
      source: 'user-home',
      status: 'available',
    });
    expect(auth.status === 'available' ? auth.openaiApiKey : undefined).toBe('sk-home');
    expect(auth.detail).not.toContain('sk-home');
    expect(auth.detail).not.toContain('token');
    expect(auth.detail).not.toContain('refresh');
  });

  it('falls back to ~/.codex/auth.json when CODEX_HOME/auth.json has an unknown shape without an API key', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    const codexHome = join(cwd, 'codex-home');
    const userHome = join(cwd, 'home');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ preference: 'local' }));
    writeFileSync(
      join(userHome, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-home' }),
    );

    const auth = resolveCodexAuth({
      env: { CODEX_HOME: codexHome },
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      displayPath: '~/.codex/auth.json',
      mode: 'api-key',
      source: 'user-home',
      status: 'available',
    });
    expect(auth.status === 'available' ? auth.openaiApiKey : undefined).toBe('sk-home');
    expect(auth.detail).not.toContain('sk-home');
  });

  it('reports Codex login tokens without treating them as embedding credentials', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(
      join(userHome, '.codex', 'auth.json'),
      JSON.stringify({
        account_id: 'acct_123',
        tokens: {
          access_token: 'token',
          refresh_token: 'refresh',
        },
      }),
    );

    const auth = resolveCodexAuth({
      env: {},
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      mode: 'login',
      reason: 'login-without-api-key',
      status: 'unavailable',
    });
    expect(auth.detail).toContain('no cached OPENAI_API_KEY');
    expect(auth.detail).not.toContain('acct_123');
    expect(auth.detail).not.toContain('refresh');
    expect(auth.guidance).toContain('Lexical recall remains available');
  });

  it('reports missing auth files as unavailable', () => {
    const auth = resolveCodexAuth({
      env: {},
      homeDir: mkdtempSync(join(tmpdir(), 'saga-codex-auth-')),
    });

    expect(auth).toMatchObject({
      mode: 'missing',
      reason: 'missing-auth-file',
      status: 'unavailable',
    });
  });

  it('reports malformed auth files as unavailable without throwing', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    mkdirSync(join(userHome, '.codex'), { recursive: true });
    writeFileSync(join(userHome, '.codex', 'auth.json'), '{nope');

    const auth = resolveCodexAuth({
      env: {},
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      mode: 'malformed',
      reason: 'malformed-auth-file',
      status: 'unavailable',
    });
    expect(auth.guidance).toContain('Lexical recall remains available');
  });

  it('reports malformed auth files without parser text or source excerpts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    const codexHome = join(cwd, 'codex-home');
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-leaked-fragment","tokens":{"access_token":"tok-leaked-fragment",}',
    );

    const auth = resolveCodexAuth({
      env: { CODEX_HOME: codexHome },
      homeDir: join(cwd, 'home'),
    });
    const publicStatus = JSON.stringify(auth);

    expect(auth).toMatchObject({
      detail: 'could not parse CODEX_HOME/auth.json',
      mode: 'malformed',
      reason: 'malformed-auth-file',
      status: 'unavailable',
    });
    expect(publicStatus).not.toContain('sk-leaked-fragment');
    expect(publicStatus).not.toContain('tok-leaked-fragment');
    expect(publicStatus).not.toContain('OPENAI_API_KEY');
    expect(publicStatus).not.toContain('access_token');
    expect(publicStatus).not.toContain('Unexpected');
    expect(publicStatus).not.toContain('JSON');
  });

  it('reports unreadable auth files as unavailable without trying to mutate them', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'saga-codex-auth-'));
    mkdirSync(join(userHome, '.codex', 'auth.json'), { recursive: true });

    const auth = resolveCodexAuth({
      env: {},
      homeDir: userHome,
    });

    expect(auth).toMatchObject({
      mode: 'unreadable',
      reason: 'unreadable-auth-file',
      status: 'unavailable',
    });
  });
});
