import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CODEX_SUBSCRIPTION_MODEL,
  DEFAULT_INFERENCE_PROVIDER,
  DEFAULT_OPENAI_API_MODEL,
  resolveInferenceConfig,
} from './inference-policy.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saga-inference-policy-'));
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

describe('resolveInferenceConfig', () => {
  it('reads an enabled inference section with provider and model', () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({
        inference: { model: 'gpt-4o', provider: 'codex-subscription', remote: 'enabled' },
      }),
    );

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({
      model: 'gpt-4o',
      policy: 'enabled',
      provider: 'codex-subscription',
      source: 'installation-config',
    });
  });

  it('defaults provider and model when the enabled section omits them', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { remote: 'enabled' } }));

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({
      model: DEFAULT_OPENAI_API_MODEL,
      policy: 'enabled',
      provider: DEFAULT_INFERENCE_PROVIDER,
      source: 'installation-config',
    });
  });

  it('applies the codex-subscription default model when that provider omits a model', () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({ inference: { provider: 'codex-subscription', remote: 'enabled' } }),
    );

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({
      model: DEFAULT_CODEX_SUBSCRIPTION_MODEL,
      provider: 'codex-subscription',
    });
  });

  it('reports an explicit disabled installation standard distinctly from not-configured', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { remote: 'disabled' } }));

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'disabled', source: 'installation-config' });
  });

  it('reports not-configured when no installation config file exists', () => {
    const home = tempHome();

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'not-configured', source: 'default' });
  });

  it('reports not-configured when the config omits the inference section', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ embeddings: { remote: 'enabled' } }));

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'not-configured', source: 'default' });
  });

  it('reports not-configured when the config cannot be parsed', () => {
    const home = tempHome();
    writeSagaConfig(home, '{ not valid json');

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config.policy).toBe('not-configured');
  });

  it('fails closed to not-configured on an unknown provider, surfacing the key not the value', () => {
    const home = tempHome();
    writeSagaConfig(
      home,
      JSON.stringify({ inference: { provider: 'anthropic', remote: 'enabled' } }),
    );

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'not-configured', source: 'default' });
    expect(config.detail).toContain('inference.provider');
    expect(config.detail).not.toContain('anthropic');
  });

  it('fails closed to not-configured on a present-but-blank model, surfacing the key', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { model: '   ', remote: 'enabled' } }));

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'not-configured', source: 'default' });
    expect(config.detail).toContain('inference.model');
  });

  it('fails closed to not-configured on a non-string model value', () => {
    const home = tempHome();
    writeSagaConfig(home, JSON.stringify({ inference: { model: 42, remote: 'enabled' } }));

    const config = resolveInferenceConfig({ env: {}, homeDir: home });

    expect(config).toMatchObject({ policy: 'not-configured', source: 'default' });
    expect(config.detail).toContain('inference.model');
    expect(config.detail).not.toContain('42');
  });
});
