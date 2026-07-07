import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  importRawSessionRecord,
  insertRawEvent,
  makeDatabase,
  runMigrations,
  searchSessionRecall,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { startSagaService } from '@saga/service';
import type { SagaServiceHandle } from '@saga/service';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { restoreDatabaseUrlEnv, setDatabaseUrlEnv } from './database-url-env.js';
import { installHarness } from './harness.js';
import { initProject, readBindingFile } from './init.js';

// SGA-239 slice 4 acceptance: the THIN CLI drives every client command end-to-end.
// Unlike the parity tests (which call the command functions in-process against a
// live service), this spawns the REAL bin — packages/client-cli/bin/saga-client.js
// — as a subprocess for each command, against a LIVE service backed by a scratch
// database, and asserts exit code + rendered stdout. It exercises the full path a
// user hits: argv parsing, global-flag handling, service resolution over
// @saga/api-client, and stdin for the hook contract. The bin runs its source via
// tsx (same pattern as apps/cli/bin/saga.js), so no build step is needed.
const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../..');
const clientBin = join(repoRoot, 'packages/client-cli/bin/saga-client.js');

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

function codexTranscript(sessionId: string, projectRoot: string): string {
  const records = [
    {
      payload: { cwd: projectRoot, id: sessionId },
      timestamp: '2026-06-22T21:10:00.000Z',
      type: 'session_meta',
    },
    {
      payload: {
        content: [{ text: 'E2E client capture sentinel.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      timestamp: '2026-06-22T21:10:01.000Z',
      type: 'response_item',
    },
  ];
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describePostgres('thin client CLI drives every command end-to-end against a live service', () => {
  const databaseName = `saga_client_e2e_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let projectRoot = '';
  let sagaHome = '';
  let workspaceId = '';
  let sessionId = '';
  let serviceUrl = '';

  const recallQuery = 'E2E client surface sentinel phrase gamma delta';

  type SpawnResult = { status: number | null; stderr: string; stdout: string };

  // Spawn the real bin ASYNCHRONOUSLY, exactly as a shell would, from the bound
  // project dir. It must be async (not spawnSync): the Saga service under test
  // runs on THIS process's event loop, so a synchronous spawn would block it and
  // the subprocess's HTTP request could never be served (a deadlock). HOME/
  // SAGA_HOME point at an empty dir so no real ~/.saga config injects a service
  // URL/auth into resolution — the command's service target is only what the test
  // passes on the command line.
  function spawnClient(
    args: readonly string[],
    options: { input?: string } = {},
  ): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [clientBin, ...args], {
        cwd: projectRoot,
        env: { ...process.env, HOME: sagaHome, SAGA_HOME: sagaHome },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('error', (error) => {
        clearTimeout(killTimer);
        reject(error);
      });
      child.on('close', (status) => {
        clearTimeout(killTimer);
        resolve({ status, stderr, stdout });
      });
      if (options.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }

  // The common case: point the command at the live service handle.
  function runClient(
    args: readonly string[],
    options: { input?: string } = {},
  ): Promise<SpawnResult> {
    return spawnClient([...args, '--service-url', serviceUrl], options);
  }

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    // initProject / installHarness are db-backed apps/cli operations; point them
    // at the scratch database via SAGA_DATABASE_URL.
    previousDatabaseUrl = setDatabaseUrlEnv(url.toString());
    service = await Effect.runPromise(
      makeDatabase(testConfig(url.toString()), { postgres: { max: 10 } }),
    );
    await Effect.runPromise(runMigrations(service));

    // A bound project outside the saga git tree (findProjectRoot resolves to the
    // temp dir itself), with the codex harness installed so `ingest codex-hook`
    // can resolve its source binding + host from the on-disk binding file.
    sagaHome = mkdtempSync(join(tmpdir(), 'saga-client-e2e-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'saga-client-e2e-'));
    await initProject({ cwd: projectRoot, handle: 'Client E2E' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    workspaceId = binding.workspace.id;

    // Seed searchable content into the bound workspace so recall/sessions/ingest
    // recent have data to render.
    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'client-e2e-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: [
          JSON.stringify({ text: recallQuery, type: 'user' }),
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
        externalEventId: 'client-e2e-evt-1',
        occurredAt: '2026-06-21T14:00:01.000Z',
        payload: { hook_event_name: 'user-prompt' },
        provenance: { importedBy: 'e2e-test' },
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
    if ((seed.sessions[0]?.matches[0]?.segment.id ?? '') === '') {
      throw new Error('seed recall produced no segment');
    }

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      jobs: [],
      recordRun: () => Effect.void,
      validateDatabase: async () => undefined,
    });
    serviceUrl = handle.url;
  });

  afterAll(async () => {
    if (projectRoot !== '') {
      rmSync(projectRoot, { force: true, recursive: true });
    }
    if (sagaHome !== '') {
      rmSync(sagaHome, { force: true, recursive: true });
    }
    if (handle !== undefined) {
      await handle.close();
    }
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    restoreDatabaseUrlEnv(previousDatabaseUrl);
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('recall search renders the seeded match', async () => {
    const result = await runClient([
      'recall',
      'search',
      recallQuery,
      '--workspace',
      workspaceId,
      '-f',
      'records',
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Recall Search');
    expect(result.stdout).toContain('Match 1');
    expect(result.stdout).toContain(recallQuery);
  });

  test('sessions recent renders the seeded session', async () => {
    const result = await runClient(['sessions', 'recent', '--workspace', workspaceId]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Raw Session Records');
    expect(result.stdout).toContain(sessionId);
  });

  test('sessions show renders the seeded session detail', async () => {
    const result = await runClient(['sessions', 'show', sessionId, '--workspace', workspaceId]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(sessionId);
  });

  test('ingest recent renders the seeded raw event', async () => {
    const result = await runClient(['ingest', 'recent', '--workspace', workspaceId]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Raw events');
    expect(result.stdout).toContain('user-prompt');
  });

  test('ingest codex-hook returns the hook contract on stdin, and a re-run is a duplicate', async () => {
    const transcriptPath = join(projectRoot, 'e2e-codex.jsonl');
    writeFileSync(transcriptPath, codexTranscript('e2e-codex-hook-session', projectRoot));
    const hookInput = JSON.stringify({
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'e2e-codex-hook-session',
      transcript_path: transcriptPath,
    });

    // Default (records) format is the harness invocation: stdout must be exactly
    // the { continue: true } hook contract.
    const first = await runClient(['ingest', 'codex-hook'], { input: hookInput });
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe('{"continue":true}');

    // The same hook again dedups to the same raw event; the json view exposes the
    // duplicate ack.
    const second = await runClient(['ingest', 'codex-hook', '-f', 'json'], { input: hookInput });
    expect(second.status).toBe(0);
    const parsed = JSON.parse(second.stdout) as { ackStatus?: string; mode?: string };
    expect(parsed.ackStatus).toBe('duplicate');
    expect(parsed.mode).toBe('captured');
  });

  test('doctor reports the service check OK against the live handle', async () => {
    const result = await runClient(['doctor', '--ascii']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saga doctor');
    expect(result.stdout).toContain(`healthy at ${serviceUrl}`);
    expect(result.stdout).toContain('service');
    expect(result.stdout).not.toContain('unreachable');
  });

  test('doctor reports the service check as an error against an unreachable URL', async () => {
    const result = await spawnClient(['doctor', '--ascii', '--service-url', 'http://127.0.0.1:1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Saga doctor');
    expect(result.stdout).toContain('service unreachable at http://127.0.0.1:1');
  });
});
