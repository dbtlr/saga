import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveCodexInferenceAuth } from './codex-inference-auth.js';

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'saga-codex-inference-'));
}

function writeCodexAuth(dir: string, contents: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'auth.json');
  writeFileSync(path, contents);
  return path;
}

const chatgptAuth = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { access_token: 'access-123', account_id: 'acct-abc' },
});

describe('resolveCodexInferenceAuth', () => {
  it('reads ChatGPT login tokens from ~/.codex/auth.json', () => {
    const home = tempHome();
    writeCodexAuth(join(home, '.codex'), chatgptAuth);

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({
      accessToken: 'access-123',
      accountId: 'acct-abc',
      source: 'user-home',
      status: 'available',
    });
  });

  it('honors CODEX_HOME over the default location', () => {
    const home = tempHome();
    const codexHome = join(home, 'custom-codex');
    writeCodexAuth(codexHome, chatgptAuth);
    // A conflicting default-location file must be ignored in favor of CODEX_HOME.
    writeCodexAuth(join(home, '.codex'), JSON.stringify({ auth_mode: 'apikey' }));

    const auth = resolveCodexInferenceAuth({ env: { CODEX_HOME: codexHome }, homeDir: home });

    expect(auth).toMatchObject({ source: 'codex-home', status: 'available' });
  });

  it('rejects an api-key mode auth file', () => {
    const home = tempHome();
    writeCodexAuth(join(home, '.codex'), JSON.stringify({ OPENAI_API_KEY: 'sk-x' }));

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({ reason: 'not-chatgpt-mode', status: 'unavailable' });
  });

  it('rejects malformed JSON without echoing the file text', () => {
    const home = tempHome();
    writeCodexAuth(join(home, '.codex'), '{ auth_mode: broken');

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({ reason: 'malformed-auth-file', status: 'unavailable' });
    if (auth.status !== 'unavailable') {
      throw new Error('expected an unavailable auth result');
    }
    expect(auth.detail).not.toContain('broken');
  });

  it('reports a missing access token', () => {
    const home = tempHome();
    writeCodexAuth(
      join(home, '.codex'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: 'acct-abc' } }),
    );

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({ reason: 'missing-access-token', status: 'unavailable' });
  });

  it('reports a missing account id', () => {
    const home = tempHome();
    writeCodexAuth(
      join(home, '.codex'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'access-123' } }),
    );

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({ reason: 'missing-account-id', status: 'unavailable' });
  });

  it('reports a missing auth file', () => {
    const home = tempHome();

    const auth = resolveCodexInferenceAuth({ env: {}, homeDir: home });

    expect(auth).toMatchObject({ reason: 'missing-auth-file', status: 'unavailable' });
  });
});
