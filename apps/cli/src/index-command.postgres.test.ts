import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionEmbeddingGenerator, SessionEmbeddingIndexResult } from '@saga/db';
import { DEFAULT_OPENAI_EMBEDDING_PROVIDER } from '@saga/runtime';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runIndexCommand } from './index-command.js';
import { initProject } from './init.js';
import { runRecallCommand } from './recall.js';
import { runSessionsCommand } from './sessions.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
} as const;

const { dimensions, id: providerId, model } = DEFAULT_OPENAI_EMBEDDING_PROVIDER;

// One-hot vectors of the production dimension: `alpha` text -> axis 0, `beta` -> axis 1,
// anything else -> axis 2. Cosine distance is 0 between identical axes and 1 otherwise, so a
// query embedding on axis 0 matches only the `alpha` segment via the vector path.
function oneHotVector(axis: number): number[] {
  return Array.from({ length: dimensions }, (_value, index) => (index === axis ? 1 : 0));
}

function axisForText(text: string): number {
  if (text.includes('alpha')) {
    return 0;
  }
  if (text.includes('beta')) {
    return 1;
  }
  return 2;
}

function fakeGenerator(): SessionEmbeddingGenerator {
  return {
    embedSegments: async (inputs) =>
      inputs.map((input) => ({
        embedding: oneHotVector(axisForText(input.text)),
        segmentId: input.segmentId,
      })),
    provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
  };
}

describePostgres('index CLI postgres integration', () => {
  const databaseName = `saga_index_cli_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let projectRoot: string | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    projectRoot = mkdtempSync(join(tmpdir(), 'saga-index-cli-'));
    await initProject({ cwd: projectRoot, handle: 'Index CLI' });

    const inputPath = join(projectRoot, 'index-session.jsonl');
    writeFileSync(
      inputPath,
      [
        JSON.stringify({ text: 'alpha distinctive marker content', type: 'user' }),
        JSON.stringify({ text: 'beta distinctive marker content', type: 'assistant' }),
        '',
      ].join('\n'),
    );
    await runSessionsCommand(
      ['import', inputPath, '--harness', 'codex', '--harness-session-id', 'index-cli-session'],
      renderOptions,
      { cwd: projectRoot },
    );
  });

  afterAll(async () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('indexes eligible segments, is idempotent, and enables vector recall', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }

    // First index run generates embeddings for both eligible segments.
    const firstOutput = await runIndexCommand(
      [],
      { ...renderOptions, format: 'json' },
      {
        cwd: projectRoot,
        embeddingGenerator: fakeGenerator(),
      },
    );
    const first = JSON.parse(firstOutput) as SessionEmbeddingIndexResult;
    expect(first.status).toBe('completed');
    expect(first.provider.id).toBe(providerId);
    expect(first.eligibleCount).toBeGreaterThanOrEqual(2);
    expect(first.indexedCount).toBeGreaterThanOrEqual(2);
    expect(first.existingCount).toBe(0);

    // ADR-0039: re-running is idempotent by finding nothing eligible — the indexer fills
    // absence, so already-embedded segments are excluded rather than re-selected.
    const secondOutput = await runIndexCommand(
      [],
      { ...renderOptions, format: 'json' },
      {
        cwd: projectRoot,
        embeddingGenerator: fakeGenerator(),
      },
    );
    const second = JSON.parse(secondOutput) as SessionEmbeddingIndexResult;
    expect(second.status).toBe('completed');
    expect(second.eligibleCount).toBe(0);
    expect(second.indexedCount).toBe(0);

    // Vector recall end-to-end: a query that matches no lexical/trigram token but whose
    // embedding is on the `alpha` axis returns the alpha segment via the vector path.
    const recallOutput = await runRecallCommand(['search', 'qzxvnomatchtoken'], renderOptions, {
      cwd: projectRoot,
      resolveQueryEmbedding: async () => ({
        posture: { mode: 'vector' as const },
        queryEmbedding: {
          dimensions,
          model,
          provider: providerId,
          vector: oneHotVector(0),
        },
      }),
    });
    // The query matches no lexical or trigram token, so a hit can only come from the vector
    // path; the alpha segment ranks first with a perfect (1) vector score and zero lexical score.
    expect(recallOutput).toContain('Match 1');
    expect(recallOutput).toContain('alpha distinctive marker');
    expect(recallOutput).toContain('vector 1');
    expect(recallOutput).toContain('lexical 0');
  });

  test('--all fills every workspace to completion from the DB without a cwd binding', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    // A second, independently-bound workspace with its own segment, so --all must cover more
    // than the workspace bound to any single cwd.
    const secondRoot = mkdtempSync(join(tmpdir(), 'saga-index-cli-2-'));
    await initProject({ cwd: secondRoot, handle: 'Index CLI Two' });
    const secondInput = join(secondRoot, 'index-session.jsonl');
    writeFileSync(
      secondInput,
      [JSON.stringify({ text: 'gamma distinctive marker content', type: 'user' }), ''].join('\n'),
    );
    await runSessionsCommand(
      ['import', secondInput, '--harness', 'codex', '--harness-session-id', 'index-cli-session-2'],
      renderOptions,
      { cwd: secondRoot },
    );

    // Run --all from a cwd with no binding, proving enumeration is DB-driven, not cwd-bound.
    const noBindingCwd = mkdtempSync(join(tmpdir(), 'saga-index-cli-nobinding-'));
    const output = await runIndexCommand(
      ['--all'],
      { ...renderOptions, format: 'json' },
      {
        cwd: noBindingCwd,
        embeddingGenerator: fakeGenerator(),
      },
    );
    const result = JSON.parse(output) as {
      totalIndexed: number;
      workspaceCount: number;
      workspaces: { handle: string; indexedCount: number; status: string }[];
    };

    // Every workspace enumerated and completed; the brand-new second workspace was filled.
    expect(result.workspaceCount).toBeGreaterThanOrEqual(2);
    expect(result.workspaces.every((workspace) => workspace.status === 'completed')).toBe(true);
    expect(result.totalIndexed).toBeGreaterThanOrEqual(1);

    // Fill-to-completion across every workspace: an immediate second --all indexes nothing.
    const secondOutput = await runIndexCommand(
      ['--all'],
      { ...renderOptions, format: 'json' },
      {
        cwd: noBindingCwd,
        embeddingGenerator: fakeGenerator(),
      },
    );
    const secondResult = JSON.parse(secondOutput) as { totalIndexed: number };
    expect(secondResult.totalIndexed).toBe(0);
  });

  test('--all isolates a failing workspace and still completes the others', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    // One workspace whose segment triggers a generator failure (a transient OpenAI error), and
    // one healthy workspace. --all must record the failure and still process the rest.
    const failRoot = mkdtempSync(join(tmpdir(), 'saga-index-cli-fail-'));
    await initProject({ cwd: failRoot, handle: 'Index CLI Fail' });
    const failInput = join(failRoot, 'index-session.jsonl');
    writeFileSync(
      failInput,
      [JSON.stringify({ text: 'POISON segment content', type: 'user' }), ''].join('\n'),
    );
    await runSessionsCommand(
      ['import', failInput, '--harness', 'codex', '--harness-session-id', 'index-cli-fail'],
      renderOptions,
      { cwd: failRoot },
    );
    const okRoot = mkdtempSync(join(tmpdir(), 'saga-index-cli-ok-'));
    await initProject({ cwd: okRoot, handle: 'Index CLI Ok' });
    const okInput = join(okRoot, 'index-session.jsonl');
    writeFileSync(
      okInput,
      [JSON.stringify({ text: 'healthy segment content', type: 'user' }), ''].join('\n'),
    );
    await runSessionsCommand(
      ['import', okInput, '--harness', 'codex', '--harness-session-id', 'index-cli-ok'],
      renderOptions,
      { cwd: okRoot },
    );

    const throwingGenerator: SessionEmbeddingGenerator = {
      embedSegments: async (inputs) => {
        if (inputs.some((input) => input.text.includes('POISON'))) {
          throw new Error('simulated OpenAI 429');
        }
        return inputs.map((input) => ({
          embedding: oneHotVector(axisForText(input.text)),
          segmentId: input.segmentId,
        }));
      },
      provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
    };

    const output = await runIndexCommand(
      ['--all'],
      { ...renderOptions, format: 'json' },
      {
        cwd: mkdtempSync(join(tmpdir(), 'saga-index-cli-iso-')),
        embeddingGenerator: throwingGenerator,
      },
    );
    const result = JSON.parse(output) as {
      failedCount: number;
      workspaces: { error?: string; handle: string; indexedCount: number; status: string }[];
    };

    // The failing workspace is recorded, not thrown — and the run still reached the others.
    expect(result.failedCount).toBe(1);
    const failed = result.workspaces.find((workspace) => workspace.status === 'failed');
    expect(failed?.error).toContain('simulated OpenAI 429');
    // Other workspaces still completed in the same run (isolation did not abort it).
    expect(result.workspaces.some((workspace) => workspace.status === 'completed')).toBe(true);
  });

  test('renders a skipped result with reason and guidance', async () => {
    if (projectRoot === undefined) {
      throw new Error('project root was not initialized');
    }
    const skipped: SessionEmbeddingIndexResult = {
      eligibleCount: 2,
      existingCount: 0,
      indexedCount: 0,
      lexicalFallback: { detail: 'Lexical recall remains available.', state: 'active' },
      provider: DEFAULT_OPENAI_EMBEDDING_PROVIDER,
      skipped: {
        count: 2,
        detail: 'Remote embeddings are disabled by installation policy.',
        guidance: 'Enable embeddings.remote in ~/.saga/config.json.',
        reason: 'disabled-by-policy',
      },
      staleCount: 0,
      status: 'skipped',
      workspaceId: 'workspace',
    };
    const output = await runIndexCommand([], renderOptions, {
      cwd: projectRoot,
      indexEmbeddings: async () => skipped,
    });
    expect(output).toContain('status');
    expect(output).toContain('skipped');
    expect(output).toContain('disabled-by-policy');
    expect(output).toContain('Enable embeddings.remote');
  });
});
