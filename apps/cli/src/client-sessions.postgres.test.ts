import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSessionsCommand as runSessionsClient } from '@saga/client-cli';
import {
  getSessionDetail,
  importRawSessionRecord,
  insertRawEvent,
  listRecentSessionRecords,
  makeDatabase,
  runMigrations,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { startSagaService } from '@saga/service';
import type { SagaServiceHandle } from '@saga/service';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { runSessionsCommand as runSessionsOracle } from './sessions.js';

// SGA-239 parity: the @saga/client-cli sessions read commands (recent, show), over
// @saga/api-client and a live service, must render byte-identically to the original
// db-backed apps/cli sessions commands on the same seeded data. The oracle is the
// original command driven via its injected db seams; the client is driven against a
// live service. There are no per-call fields here, so the comparison is exact.
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

describePostgres('client-cli sessions parity with the db-backed CLI', () => {
  const databaseName = `saga_client_sessions_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let bindingDir: string | undefined;

  let workspaceId = '';
  let sessionId = '';
  let serviceUrl = '';

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
      .values({ handle: `client-sessions-${Date.now().toString(36)}` })
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
        harnessSessionId: 'client-sessions-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: [
          JSON.stringify({ text: 'Client sessions sentinel phrase alpha bravo', type: 'user' }),
          JSON.stringify({ text: 'assistant reply keeps surrounding context', type: 'assistant' }),
          '',
        ].join('\n'),
        workspaceId,
      }),
    );
    sessionId = imported.session.id;

    await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'host-1',
        eventType: 'user-prompt',
        externalEventId: 'client-sessions-evt-1',
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

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      recordRun: () => Effect.void,
      validateDatabase: async () => undefined,
    });
    serviceUrl = handle.url;

    bindingDir = mkdtempSync(join(tmpdir(), 'saga-client-sessions-'));
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

  test('sessions recent records match the db-backed CLI byte-for-byte', async () => {
    const oracle = await runSessionsOracle(['recent'], renderOptions, {
      cwd: bindingDir,
      listRecent: (input) => Effect.runPromise(listRecentSessionRecords(service ?? fail(), input)),
    });
    const clientOutput = await runSessionsClient(['recent'], renderOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toContain('Raw Session Records');
    expect(clientOutput).toBe(oracle);
  });

  test('sessions recent json matches the db-backed CLI byte-for-byte', async () => {
    const jsonOptions = { ...renderOptions, format: 'json' } as const;
    const oracle = await runSessionsOracle(['recent'], jsonOptions, {
      cwd: bindingDir,
      listRecent: (input) => Effect.runPromise(listRecentSessionRecords(service ?? fail(), input)),
    });
    const clientOutput = await runSessionsClient(['recent'], jsonOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toBe(oracle);
  });

  test('sessions show records match the db-backed CLI byte-for-byte', async () => {
    const oracle = await runSessionsOracle(['show', sessionId], renderOptions, {
      cwd: bindingDir,
      getDetail: (input) => Effect.runPromise(getSessionDetail(service ?? fail(), input)),
    });
    const clientOutput = await runSessionsClient(['show', sessionId], renderOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toContain('Session');
    expect(clientOutput).toBe(oracle);
  });

  test('sessions show json matches the db-backed CLI byte-for-byte', async () => {
    const jsonOptions = { ...renderOptions, format: 'json' } as const;
    const oracle = await runSessionsOracle(['show', sessionId], jsonOptions, {
      cwd: bindingDir,
      getDetail: (input) => Effect.runPromise(getSessionDetail(service ?? fail(), input)),
    });
    const clientOutput = await runSessionsClient(['show', sessionId], jsonOptions, {
      apiClient: { serviceUrl },
      workspaceId,
    });

    expect(clientOutput).toBe(oracle);
  });
});

function fail(): never {
  throw new Error('client sessions parity fixture was not initialized');
}
