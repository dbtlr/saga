import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EmbeddingCredential } from './embedding-credential.js';
import type { EmbeddingPolicy } from './embedding-policy.js';
import { composeEmbeddingWorkflow, inspectEmbeddingWorkflow } from './embeddings.js';

const availableCredential: EmbeddingCredential = {
  apiKey: 'sk-secret',
  detail: 'cached OPENAI_API_KEY present in CODEX_HOME/auth.json',
  displayPath: 'CODEX_HOME/auth.json',
  guidance: 'available',
  mode: 'api-key',
  source: 'codex-auth',
  status: 'available',
};

const environmentCredential: EmbeddingCredential = {
  apiKey: 'sk-env-secret',
  detail: 'OPENAI_API_KEY present in the environment',
  displayPath: 'OPENAI_API_KEY',
  guidance: 'OpenAI embeddings use the OPENAI_API_KEY configured in the environment.',
  mode: 'api-key',
  source: 'environment',
  status: 'available',
};

const missingCredential: EmbeddingCredential = {
  detail: 'no Codex auth file found',
  guidance: 'Embedding generation is skipped. Lexical recall remains available.',
  mode: 'missing',
  reason: 'missing-auth-file',
  status: 'unavailable',
};

const enabledPolicy: EmbeddingPolicy = {
  detail: 'remote embeddings enabled by installation standard in ~/.saga/config.json',
  remoteEmbeddings: 'enabled',
  source: 'installation-config',
};

const disabledPolicy: EmbeddingPolicy = {
  detail: 'remote embeddings disabled by installation standard in ~/.saga/config.json',
  remoteEmbeddings: 'disabled',
  source: 'installation-config',
};

describe('composeEmbeddingWorkflow', () => {
  it('policy enabled with available credentials is vector-aware', () => {
    const workflow = composeEmbeddingWorkflow({
      credential: availableCredential,
      policy: enabledPolicy,
    });

    expect(workflow.mode).toBe('vector-aware');
    expect(workflow.availability).toMatchObject({
      reason: 'openai-api-key-available',
      state: 'available',
    });
    expect(workflow.availability.credential.source).toBe('codex-auth');
    expect(workflow.lexicalFallback.state).toBe('standby');
    expect(workflow.policy.remoteEmbeddings).toBe('enabled');
    expect(JSON.stringify(workflow)).not.toContain('sk-secret');
  });

  it('reports the credential source for a non-Codex key', () => {
    const workflow = composeEmbeddingWorkflow({
      credential: environmentCredential,
      policy: enabledPolicy,
    });

    expect(workflow.mode).toBe('vector-aware');
    expect(workflow.availability.credential.source).toBe('environment');
    expect(workflow.availability.detail).toContain('OPENAI_API_KEY');
    expect(JSON.stringify(workflow)).not.toContain('sk-env-secret');
  });

  it('policy enabled with missing credentials degrades to lexical fallback', () => {
    const workflow = composeEmbeddingWorkflow({
      credential: missingCredential,
      policy: enabledPolicy,
    });

    expect(workflow.mode).toBe('lexical-fallback');
    expect(workflow.availability).toMatchObject({
      reason: 'missing-auth-file',
      state: 'skipped',
    });
    expect(workflow.lexicalFallback.state).toBe('active');
  });

  it('policy disabled is lexical-only by policy even when credentials are available', () => {
    const workflow = composeEmbeddingWorkflow({
      credential: availableCredential,
      policy: disabledPolicy,
    });

    expect(workflow.mode).toBe('lexical-only-by-policy');
    expect(workflow.availability).toMatchObject({
      reason: 'disabled-by-policy',
      state: 'skipped',
    });
    expect(workflow.lexicalFallback.state).toBe('active');
    expect(workflow.policy.remoteEmbeddings).toBe('disabled');
    expect(JSON.stringify(workflow)).not.toContain('sk-secret');
  });

  it('policy disabled takes precedence over missing credentials', () => {
    const workflow = composeEmbeddingWorkflow({
      credential: missingCredential,
      policy: disabledPolicy,
    });

    expect(workflow.mode).toBe('lexical-only-by-policy');
    expect(workflow.availability.reason).toBe('disabled-by-policy');
  });
});

describe('inspectEmbeddingWorkflow', () => {
  it('resolves installation policy and Codex auth together', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-embedding-inspect-'));
    const sagaHome = join(cwd, 'saga-home');
    const codexHome = join(cwd, 'codex-home');
    mkdirSync(sagaHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(sagaHome, 'config.json'),
      JSON.stringify({ embeddings: { remote: 'enabled' } }),
    );
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-inspect' }));

    const workflow = inspectEmbeddingWorkflow(
      { env: { CODEX_HOME: codexHome }, homeDir: join(cwd, 'home') },
      { env: { SAGA_HOME: sagaHome }, homeDir: join(cwd, 'home') },
    );

    expect(workflow.mode).toBe('vector-aware');
    expect(workflow.policy.remoteEmbeddings).toBe('enabled');
    expect(JSON.stringify(workflow)).not.toContain('sk-inspect');
  });

  it('keeps malformed auth parser text and secrets out of workflow status', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'saga-embedding-auth-'));
    const sagaHome = join(cwd, 'saga-home');
    const codexHome = join(cwd, 'codex-home');
    mkdirSync(sagaHome, { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    // Enable the policy so the auth path is what decides the workflow state.
    writeFileSync(
      join(sagaHome, 'config.json'),
      JSON.stringify({ embeddings: { remote: 'enabled' } }),
    );
    writeFileSync(
      join(codexHome, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-workflow-leak","tokens":{"access_token":"tok-workflow-leak",}',
    );

    const workflow = inspectEmbeddingWorkflow(
      { env: { CODEX_HOME: codexHome }, homeDir: join(cwd, 'home') },
      { env: { SAGA_HOME: sagaHome }, homeDir: join(cwd, 'home') },
    );
    const publicStatus = JSON.stringify(workflow);

    expect(workflow.mode).toBe('lexical-fallback');
    expect(workflow.availability).toMatchObject({
      reason: 'malformed-auth-file',
      state: 'skipped',
    });
    expect(workflow.availability.credential.detail).toBe('could not parse CODEX_HOME/auth.json');
    expect(publicStatus).not.toContain('sk-workflow-leak');
    expect(publicStatus).not.toContain('tok-workflow-leak');
    expect(publicStatus).not.toContain('OPENAI_API_KEY');
    expect(publicStatus).not.toContain('access_token');
    expect(publicStatus).not.toContain('Unexpected');
    expect(publicStatus).not.toContain('JSON');
  });
});
