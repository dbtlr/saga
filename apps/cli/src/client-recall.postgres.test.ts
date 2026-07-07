import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRecallCommand as runRecallClient } from '@saga/client-cli';
import {
  expandRecallContext,
  importRawSessionRecord,
  insertRawEvent,
  makeDatabase,
  runMigrations,
  searchSessionRecall,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { startSagaService } from '@saga/service';
import type { SagaServiceHandle } from '@saga/service';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runRecallCommand as runRecallOracle } from './recall.js';

// SGA-239 parity: the @saga/client-cli recall commands (over @saga/api-client and
// a live service) must render byte-identically to the original db-backed apps/cli
// recall commands on the same seeded data. The oracle is the original command
// driven in LEXICAL mode via its injected db seams; the client is driven against a
// live service. Both resolve the same workspace, so any difference is presentation
// drift — which this test forbids.
const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const renderOptions = {
  ascii: true,
  color: 'never',
  format: 'records',
  isTty: false,
} as const;

function testConfig(url: string): RuntimeConfig {
  return {
    databaseUrl: url,
    databaseUrlSource: 'environment',
    environment: 'test',
    logLevel: 'info',
    secrets: { openaiApiKey: undefined },
    service: { host: '127.0.0.1', port: 0 },
  };
}

// The two search-only divergences: the recall posture (env/flag-resolved for the
// oracle, a fixed client stance) and the per-call `searchedAt`. Neutralize both in
// the rendered records so the rest of the block/redaction pipeline compares exactly
// — mirroring apps/service/src/mcp.postgres.test.ts's normalizeSearch.
function normalizeSearchRecords(text: string): string {
  return text
    .replace(/^ {2}mode\b.*$/mu, '  mode <normalized>')
    .replace(/^ {2}searched\b.*$/mu, '  searched <normalized>');
}

// The same two divergences in the JSON value: `search` (posture) and `searchedAt`.
function stripVolatileJson(json: string): Record<string, unknown> {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed.search;
  delete parsed.searchedAt;
  return parsed;
}

describePostgres('client-cli recall parity with the db-backed CLI', () => {
  const databaseName = `saga_client_recall_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let bindingDir: string | undefined;

  let workspaceId = '';
  let segmentId = '';
  let serviceUrl = '';

  const recallQuery = 'Client parity sentinel phrase alpha bravo';

  beforeAll(async () => {
    admin = await Effect.runPromise(
      makeDatabase(testConfig(databaseUrl ?? ''), { postgres: { max: 1 } }),
    );
    await admin.sql.unsafe(`create database "${databaseName}"`);

    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    service = await Effect.runPromise(
      makeDatabase(testConfig(url.toString()), { postgres: { max: 10 } }),
    );
    await Effect.runPromise(runMigrations(service));

    const [workspace] = await service.db
      .insert(workspaces)
      .values({ handle: `client-recall-${Date.now().toString(36)}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    workspaceId = workspace.id;

    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'client-recall-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: [
          JSON.stringify({ text: recallQuery, type: 'user' }),
          JSON.stringify({ text: 'assistant reply keeps surrounding context', type: 'assistant' }),
          '',
        ].join('\n'),
        workspaceId,
      }),
    );

    await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'host-1',
        eventType: 'user-prompt',
        externalEventId: 'client-recall-evt-1',
        occurredAt: '2026-06-21T14:00:01.000Z',
        payload: { hook_event_name: 'user-prompt' },
        provenance: { importedBy: 'parity-test' },
        sourceBindingId: imported.sourceBinding.id,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );

    const seed = await Effect.runPromise(
      searchSessionRecall(service, { query: recallQuery, workspaceId }),
    );
    segmentId = seed.sessions[0]?.matches[0]?.segment.id ?? '';
    if (segmentId === '') {
      throw new Error('seed recall produced no segment to anchor the context expansion');
    }

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      recordRun: () => Effect.void,
      validateDatabase: async () => undefined,
    });
    serviceUrl = handle.url;

    // The oracle resolves its workspace id from an on-disk binding; write one that
    // points at the seeded workspace. findProjectRoot falls back to the cwd when git
    // rev-parse fails (a bare temp dir), so no repo is created.
    bindingDir = mkdtempSync(join(tmpdir(), 'saga-client-recall-'));
    writeFileSync(
      join(bindingDir, '.saga.local.json'),
      JSON.stringify({
        project: { gitRemote: undefined, root: bindingDir },
        schemaVersion: 1,
        service: { databaseUrl: 'environment' },
        sourceBinding: { id: imported.sourceBinding.id },
        workspace: { handle: workspace.handle, id: workspaceId },
      }),
    );
  });

  afterAll(async () => {
    if (bindingDir !== undefined) {
      rmSync(bindingDir, { force: true, recursive: true });
    }
    if (handle !== undefined) {
      await handle.close();
    }
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    if (admin !== undefined) {
      await admin.sql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await Effect.runPromise(admin.close());
    }
  });

  test('recall search records match the db-backed CLI (modulo posture + searchedAt)', async () => {
    const oracle = await runRecallOracle(
      ['search', recallQuery, '--no-embeddings'],
      renderOptions,
      {
        cwd: bindingDir,
        searchRecall: (input) => Effect.runPromise(searchSessionRecall(service ?? fail(), input)),
      },
    );
    const clientOutput = await runRecallClient(['search', recallQuery], renderOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toContain('Match 1');
    expect(normalizeSearchRecords(clientOutput)).toBe(normalizeSearchRecords(oracle));
  });

  test('recall search json matches the db-backed CLI (modulo posture + searchedAt)', async () => {
    const jsonOptions = { ...renderOptions, format: 'json' } as const;
    const oracle = await runRecallOracle(['search', recallQuery, '--no-embeddings'], jsonOptions, {
      cwd: bindingDir,
      searchRecall: (input) => Effect.runPromise(searchSessionRecall(service ?? fail(), input)),
    });
    const clientOutput = await runRecallClient(['search', recallQuery], jsonOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(stripVolatileJson(clientOutput)).toStrictEqual(stripVolatileJson(oracle));
  });

  test('recall show records match the db-backed CLI byte-for-byte', async () => {
    const oracle = await runRecallOracle(['show', segmentId, '--window', '1'], renderOptions, {
      cwd: bindingDir,
      expandContext: (input) => Effect.runPromise(expandRecallContext(service ?? fail(), input)),
    });
    const clientOutput = await runRecallClient(
      ['show', segmentId, '--window', '1'],
      renderOptions,
      {
        apiClient: { serviceUrl },
        workspaceId,
      },
    );

    expect(clientOutput).toContain('Segment 0 anchor');
    expect(clientOutput).toBe(oracle);
  });

  test('recall show json matches the db-backed CLI byte-for-byte', async () => {
    const jsonOptions = { ...renderOptions, format: 'json' } as const;
    const oracle = await runRecallOracle(['show', segmentId, '--window', '1'], jsonOptions, {
      cwd: bindingDir,
      expandContext: (input) => Effect.runPromise(expandRecallContext(service ?? fail(), input)),
    });
    const clientOutput = await runRecallClient(['show', segmentId, '--window', '1'], jsonOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toBe(oracle);
  });
});

function fail(): never {
  throw new Error('client recall parity fixture was not initialized');
}
