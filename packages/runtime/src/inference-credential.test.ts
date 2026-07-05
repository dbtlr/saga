import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveInferenceApiKey } from './inference-credential.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saga-inference-credential-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tempDirs.length = 0;
});

function writeSagaConfig(home: string, contents: string): void {
  mkdirSync(join(home, '.saga'), { recursive: true });
  writeFileSync(join(home, '.saga', 'config.json'), contents);
}

describe('resolveInferenceApiKey', () => {
  it('prefers OPENAI_API_KEY from the environment', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { openaiApiKey: 'sk-config' } }));

    const credential = resolveInferenceApiKey({ env: { OPENAI_API_KEY: 'sk-env' }, homeDir: home });

    expect(credential).toMatchObject({
      apiKey: 'sk-env',
      source: 'environment',
      status: 'available',
    });
  });

  it('reads inference.openaiApiKey from the installation config', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { openaiApiKey: 'sk-config' } }));

    const credential = resolveInferenceApiKey({ env: {}, homeDir: home });

    expect(credential).toMatchObject({
      apiKey: 'sk-config',
      source: 'installation-config',
      status: 'available',
    });
  });

  it('reads a key from OPENAI_API_KEY_FILE', () => {
    const home = tempHome();
    const keyFile = join(home, 'key.txt');
    writeFileSync(keyFile, 'sk-file\n');

    const credential = resolveInferenceApiKey({
      env: { OPENAI_API_KEY_FILE: keyFile },
      homeDir: home,
    });

    expect(credential).toMatchObject({ apiKey: 'sk-file', status: 'available' });
  });

  it('falls back to the Codex cached OPENAI_API_KEY when env and installation config have none', () => {
    const home = tempHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-codex' }),
    );

    const credential = resolveInferenceApiKey({ env: {}, homeDir: home });

    expect(credential).toMatchObject({
      apiKey: 'sk-codex',
      source: 'codex-auth',
      status: 'available',
    });
  });

  it('is unavailable when no source supplies a key', () => {
    const home = tempHome();

    const credential = resolveInferenceApiKey({ env: {}, homeDir: home });

    expect(credential.status).toBe('unavailable');
  });

  it('reports an issue for a non-string configured key without echoing config text', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { openaiApiKey: 42 } }));

    const credential = resolveInferenceApiKey({ env: {}, homeDir: home });

    expect(credential.status).toBe('unavailable');
    if (credential.status !== 'unavailable') {
      throw new Error('expected an unavailable credential');
    }
    expect(credential.detail).toContain('inference.openaiApiKey');
    expect(credential.detail).not.toContain('42');
  });
});
