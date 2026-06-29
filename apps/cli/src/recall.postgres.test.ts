import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

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

describePostgres('recall CLI postgres integration', () => {
  const databaseName = `saga_recall_cli_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let projectRoot: string | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    projectRoot = mkdtempSync(join(tmpdir(), 'saga-recall-cli-'));
    await initProject({ cwd: projectRoot, handle: 'Recall CLI' });
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

  test('searches imported session segments and expands a matched segment', async () => {
    if (projectRoot === undefined) throw new Error('project root was not initialized');
    const inputPath = join(projectRoot, 'recall-session.jsonl');
    writeFileSync(
      inputPath,
      [
        JSON.stringify({
          text: 'Postgres recall sentinel phrase for SGA-129 search',
          type: 'user',
        }),
        JSON.stringify({
          text: 'The assistant response keeps surrounding context for recall show',
          type: 'assistant',
        }),
        '',
      ].join('\n'),
    );

    await runSessionsCommand(
      ['import', inputPath, '--harness', 'codex', '--harness-session-id', 'recall-cli-session'],
      renderOptions,
      { cwd: projectRoot },
    );

    const searchOutput = await runRecallCommand(
      ['search', 'Postgres recall sentinel', '--no-embeddings'],
      renderOptions,
      { cwd: projectRoot },
    );

    expect(searchOutput).toContain('Recall Search');
    expect(searchOutput).toContain('Match 1');
    expect(searchOutput).toContain('Postgres recall sentinel');
    expect(searchOutput).toContain('raw provenance');
    expect(searchOutput).not.toContain(inputPath);
    expect(searchOutput).not.toContain(projectRoot);

    const segmentIds = await runRecallCommand(
      ['search', 'Postgres recall sentinel', '--no-embeddings'],
      {
        ...renderOptions,
        format: 'ids',
      },
      { cwd: projectRoot },
    );
    const segmentId = segmentIds.split(/\r?\n/u)[0] ?? '';
    expect(segmentId).toMatch(/[0-9a-f-]{36}/u);

    const showOutput = await runRecallCommand(['show', segmentId, '--window', '1'], renderOptions, {
      cwd: projectRoot,
    });

    expect(showOutput).toContain('Recall Context');
    expect(showOutput).toContain('Segment 0 anchor');
    expect(showOutput).toContain('Postgres recall sentinel');
    expect(showOutput).toContain('surrounding context');
    expect(showOutput).toContain('provenance');
    expect(showOutput).toContain('1 before / 1 after');
    expect(showOutput).not.toContain(inputPath);
    expect(showOutput).not.toContain(projectRoot);
  });
});
