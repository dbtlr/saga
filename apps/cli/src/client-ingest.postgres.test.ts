import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SagaApiClient } from '@saga/api-client';
import {
  captureHook as clientCaptureHook,
  ingestHook as clientIngestHook,
  inspectRecentRawEvents as clientInspectRecent,
} from '@saga/client-cli';
import type { HookCaptureBinding } from '@saga/client-cli';
import {
  deriveStoredSessionRecord,
  listPendingLifecycleSettlements,
  listRawSessionRecordsAwaitingDerivation,
  makeDatabase,
  rawSessionRecords,
  runMigrations,
  sessionSegments,
  sessionTurns,
  sessions,
  settleStoredLifecycleBoundaryEvent,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { startSagaService } from '@saga/service';
import type { SagaServiceHandle } from '@saga/service';
import { and, asc, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { restoreDatabaseUrlEnv, setDatabaseUrlEnv } from './database-url-env.js';
import { installHarness } from './harness.js';
import {
  captureHook as cliCaptureHook,
  inspectRecentRawEvents as cliInspectRecent,
} from './ingest.js';
import { initProject, readBindingFile } from './init.js';
import type { WorkspaceBindingFileWithHost } from './init.js';

// The load-bearing proof for the client capture surface (SGA-239 slice 3): a hook
// captured through @saga/client-cli's command (build the RawEventEnvelope + the
// IngestSnapshot client-side, POST /v1/ingest) and then derived by the extraction
// job must produce the SAME session/turns/segments the synchronous apps/cli
// captureHook (the db path) produces for the SAME hook input — for BOTH Claude and
// Codex. Plus: the harness hook JSON contract is preserved, stored/duplicate acks
// are correct, and `ingest recent` byte-matches apps/cli's inspectRecentRawEvents.

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const RENDER_OPTIONS = { ascii: true, color: 'never', format: 'records', isTty: false } as const;

function testConfig(url: string): RuntimeConfig {
  return {
    databaseUrl: url,
    databaseUrlSource: 'environment',
    environment: 'test',
    logLevel: 'info',
    service: { host: '127.0.0.1', port: 0 },
    secrets: { openaiApiKey: undefined },
  };
}

function jsonify(value: unknown): unknown {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- must serialize Dates to wire strings
  return JSON.parse(JSON.stringify(value));
}

// Project away the volatile identity/timestamp columns so two structurally
// identical derivations under different session/record ids compare equal (mirrors
// apps/service/src/ingest.postgres.test.ts).
function projectTurns(rows: readonly (typeof sessionTurns.$inferSelect)[]): unknown {
  return jsonify(
    rows.map((row) => ({
      actorKind: row.actorKind,
      actorLabel: row.actorLabel,
      contentParts: row.contentParts,
      endedAt: row.endedAt,
      harnessTurnId: row.harnessTurnId,
      metadata: row.metadata,
      model: row.model,
      ordinal: row.ordinal,
      rawSpan: row.rawSpan,
      role: row.role,
      startedAt: row.startedAt,
    })),
  );
}

function projectSegments(rows: readonly (typeof sessionSegments.$inferSelect)[]): unknown {
  // metadata is deliberately excluded: it embeds the derived turn-row UUIDs, which
  // are correctly session-specific. The remaining fields prove content parity.
  return jsonify(
    rows.map((row) => ({
      charEnd: row.charEnd,
      charStart: row.charStart,
      ordinal: row.ordinal,
      searchText: row.searchText,
      segmentKind: row.segmentKind,
      snippet: row.snippet,
      tokenEnd: row.tokenEnd,
      tokenStart: row.tokenStart,
    })),
  );
}

// The session-level ROW fields (status/model/title) the client path must match
// the db-path oracle on. harnessMetadata is stored on the raw_session_record
// (metadata.harness), so it is asserted by projectRawRecord below, not here.
function projectSessionRow(row: typeof sessions.$inferSelect): unknown {
  return jsonify({ model: row.model, status: row.status, title: row.title });
}

// The raw_session_records session-level provenance + metadata (which embeds
// harnessMetadata under `harness`). Normalize the per-capture volatile fields so
// two structurally identical captures compare equal WITHOUT masking the bug
// fixes 4/5 target: a missing provenance.rawEventId / metadata.triggerRawEventId
// key (fix 4) or a dropped empty-string hookEventName (fix 5) still diverges,
// because we only rewrite the VALUE of a key that is present.
function projectRawRecord(row: typeof rawSessionRecords.$inferSelect): unknown {
  const provenance: Record<string, unknown> = { ...row.provenance };
  if ('rawEventId' in provenance) {
    provenance.rawEventId = '<raw-event-id>';
  }
  if ('transcriptPath' in provenance) {
    provenance.transcriptPath = '<transcript-path>';
  }

  const metadata: Record<string, unknown> = { ...row.metadata };
  if ('triggerRawEventId' in metadata) {
    metadata.triggerRawEventId = '<raw-event-id>';
  }
  // Legitimately per-capture (locator- and transcript-derived), not what fixes
  // 4/5 touch; turns/segments already prove derivation parity.
  delete metadata.normalization;
  delete metadata.sourceLocatorHash;
  delete metadata.contentBytes;

  return jsonify({ metadata, provenance });
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
        content: [{ text: 'Client capture parity sentinel.', type: 'input_text' }],
        role: 'user',
        type: 'message',
      },
      timestamp: '2026-06-22T21:10:01.000Z',
      type: 'response_item',
    },
  ];
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

// The transcript body is deliberately session-agnostic: the session identity
// comes from the hook session_id (the provided harnessSessionId wins over the
// transcript-detected one), so a constant embedded sessionId/uuid keeps the
// transcript-derived turn fields (harnessTurnId, metadata) identical across the
// oracle and ingest derivations while their sessions stay distinct.
function claudeTranscript(): string {
  const records = [
    {
      message: { content: 'Client capture parity sentinel.', role: 'user' },
      sessionId: 'parity-claude',
      timestamp: '2026-06-22T21:20:00.000Z',
      type: 'user',
      uuid: 'parity-claude-user',
    },
    {
      message: {
        content: [{ text: 'Client capture captured.', type: 'text' }],
        model: 'claude-sonnet-4-5',
        role: 'assistant',
      },
      sessionId: 'parity-claude',
      timestamp: '2026-06-22T21:20:01.000Z',
      type: 'assistant',
      uuid: 'parity-claude-assistant',
    },
  ];
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describePostgres('client ingest → extraction parity', () => {
  const databaseName = `saga_client_ingest_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let client: SagaApiClient | undefined;
  let projectRoot = '';
  let binding: WorkspaceBindingFileWithHost | undefined;

  const svc = (): DatabaseService => {
    if (service === undefined) {
      throw new Error('service database not initialized');
    }
    return service;
  };

  const apiClient = (): SagaApiClient => {
    if (client === undefined) {
      throw new Error('api client not initialized');
    }
    return client;
  };

  const clientBinding = (source: 'claude' | 'codex'): HookCaptureBinding => {
    if (binding?.host === undefined) {
      throw new Error('binding host not initialized');
    }
    const sourceBindingId = binding.harnesses?.[source]?.sourceBindingId;
    if (sourceBindingId === undefined) {
      throw new Error(`${source} source binding not initialized`);
    }
    return {
      host: { id: binding.host.id, label: binding.host.label },
      sourceBindingId,
      workspaceId: binding.workspace.id,
    };
  };

  // Drive one extraction pass exactly as apps/service extractionJobFactory does,
  // using the same @saga/db primitives (avoids reaching into service internals).
  const runExtractionOnce = async (): Promise<void> => {
    const pendingDerive = await Effect.runPromise(
      listRawSessionRecordsAwaitingDerivation(svc(), { limit: 100 }),
    );
    for (const id of pendingDerive) {
      // eslint-disable-next-line no-await-in-loop -- sequential drain mirrors the job
      await Effect.runPromise(deriveStoredSessionRecord(svc(), id));
    }
    const pendingSettle = await Effect.runPromise(
      listPendingLifecycleSettlements(svc(), { limit: 100 }),
    );
    for (const id of pendingSettle) {
      // eslint-disable-next-line no-await-in-loop -- sequential drain mirrors the job
      await Effect.runPromise(settleStoredLifecycleBoundaryEvent(svc(), id));
    }
  };

  const workspaceId = (): string => {
    if (binding === undefined) {
      throw new Error('binding not initialized');
    }
    return binding.workspace.id;
  };

  const loadTurns = async (
    harnessSessionId: string,
  ): Promise<(typeof sessionTurns.$inferSelect)[]> => {
    const [row] = await svc()
      .db.select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId()),
          eq(sessions.harnessSessionId, harnessSessionId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new Error(`session ${harnessSessionId} not found`);
    }
    return svc()
      .db.select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, row.id))
      .orderBy(asc(sessionTurns.ordinal));
  };

  const loadSession = async (harnessSessionId: string): Promise<typeof sessions.$inferSelect> => {
    const [row] = await svc()
      .db.select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId()),
          eq(sessions.harnessSessionId, harnessSessionId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new Error(`session ${harnessSessionId} not found`);
    }
    return row;
  };

  const loadActiveRawRecord = async (
    harnessSessionId: string,
  ): Promise<typeof rawSessionRecords.$inferSelect> => {
    const session = await loadSession(harnessSessionId);
    const [row] = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(and(eq(rawSessionRecords.sessionId, session.id), eq(rawSessionRecords.isActive, true)))
      .limit(1);
    if (row === undefined) {
      throw new Error(`active raw_session_record for ${harnessSessionId} not found`);
    }
    return row;
  };

  const loadSegments = async (
    harnessSessionId: string,
  ): Promise<(typeof sessionSegments.$inferSelect)[]> => {
    const [row] = await svc()
      .db.select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId()),
          eq(sessions.harnessSessionId, harnessSessionId),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new Error(`session ${harnessSessionId} not found`);
    }
    return svc()
      .db.select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, row.id))
      .orderBy(asc(sessionSegments.ordinal));
  };

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    // apps/cli captureHook / inspectRecentRawEvents resolve the db from
    // SAGA_DATABASE_URL; point them at the scratch database.
    previousDatabaseUrl = setDatabaseUrlEnv(url.toString());
    service = await Effect.runPromise(
      makeDatabase(testConfig(url.toString()), { postgres: { max: 10 } }),
    );
    await Effect.runPromise(runMigrations(service));

    // A single bound project with both harnesses installed (workspace + host +
    // two source bindings live in the scratch db). Outside the saga git tree so
    // findProjectRoot resolves to the temp dir itself.
    projectRoot = mkdtempSync(join(tmpdir(), 'saga-client-ingest-'));
    await initProject({ cwd: projectRoot, handle: 'Client Ingest Parity' });
    await installHarness({ cwd: projectRoot, target: 'claude' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const read = readBindingFile(projectRoot);
    if (read?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    binding = { ...read, host: read.host };

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      jobs: [],
      recordRun: () => Effect.void,
      validateDatabase: async () => undefined,
    });
    client = new SagaApiClient({ baseUrl: handle.url });
  });

  afterAll(async () => {
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

  test('a Codex hook captured through the client derives to the same turns/segments as apps/cli captureHook', async () => {
    // Oracle: the synchronous db path (apps/cli captureHook derives inline).
    const oracleTranscript = join(projectRoot, 'oracle-codex.jsonl');
    writeFileSync(oracleTranscript, codexTranscript('oracle-codex-session', projectRoot));
    const oracle = await cliCaptureHook('codex', {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'oracle-codex-session',
      transcript_path: oracleTranscript,
    });
    expect(oracle.mode).toBe('captured');

    // Ingest: the client builds envelope + snapshot and POSTs; the job derives.
    const ingestTranscript = join(projectRoot, 'ingest-codex.jsonl');
    writeFileSync(ingestTranscript, codexTranscript('ingest-codex-session', projectRoot));
    const captured = await clientCaptureHook(
      'codex',
      {
        cwd: projectRoot,
        hook_event_name: 'UserPromptSubmit',
        session_id: 'ingest-codex-session',
        transcript_path: ingestTranscript,
      },
      { client: apiClient() },
      { binding: clientBinding('codex') },
    );
    expect(captured.mode).toBe('captured');
    expect(captured.ackStatus).toBe('stored');
    expect(captured.rawSessionRecordId).toBeTypeOf('string');

    // Before the job runs, the snapshot is stored but NOT derived.
    await expect(loadTurns('ingest-codex-session')).resolves.toHaveLength(0);
    await runExtractionOnce();

    const oracleTurns = await loadTurns('oracle-codex-session');
    const ingestTurns = await loadTurns('ingest-codex-session');
    expect(ingestTurns.length).toBeGreaterThan(0);
    expect(projectTurns(ingestTurns)).toStrictEqual(projectTurns(oracleTurns));
    expect(projectSegments(await loadSegments('ingest-codex-session'))).toStrictEqual(
      projectSegments(await loadSegments('oracle-codex-session')),
    );

    // Session-level parity: the session row and the raw_session_record's
    // provenance/metadata (which the client cannot supply verbatim) must match
    // the db-path oracle.
    expect(projectSessionRow(await loadSession('ingest-codex-session'))).toStrictEqual(
      projectSessionRow(await loadSession('oracle-codex-session')),
    );
    expect(projectRawRecord(await loadActiveRawRecord('ingest-codex-session'))).toStrictEqual(
      projectRawRecord(await loadActiveRawRecord('oracle-codex-session')),
    );
  });

  test('a Claude hook captured through the client derives to the same turns/segments as apps/cli captureHook', async () => {
    const oracleTranscript = join(projectRoot, 'oracle-claude.jsonl');
    writeFileSync(oracleTranscript, claudeTranscript());
    const oracle = await cliCaptureHook('claude', {
      cwd: projectRoot,
      hook_event_name: 'Stop',
      session_id: 'oracle-claude-session',
      transcript_path: oracleTranscript,
    });
    expect(oracle.mode).toBe('captured');

    const ingestTranscript = join(projectRoot, 'ingest-claude.jsonl');
    writeFileSync(ingestTranscript, claudeTranscript());
    const captured = await clientCaptureHook(
      'claude',
      {
        cwd: projectRoot,
        hook_event_name: 'Stop',
        session_id: 'ingest-claude-session',
        transcript_path: ingestTranscript,
      },
      { client: apiClient() },
      { binding: clientBinding('claude') },
    );
    expect(captured.mode).toBe('captured');
    expect(captured.ackStatus).toBe('stored');

    await runExtractionOnce();

    const oracleTurns = await loadTurns('oracle-claude-session');
    const ingestTurns = await loadTurns('ingest-claude-session');
    expect(ingestTurns.length).toBeGreaterThan(0);
    expect(projectTurns(ingestTurns)).toStrictEqual(projectTurns(oracleTurns));
    expect(projectSegments(await loadSegments('ingest-claude-session'))).toStrictEqual(
      projectSegments(await loadSegments('oracle-claude-session')),
    );

    expect(projectSessionRow(await loadSession('ingest-claude-session'))).toStrictEqual(
      projectSessionRow(await loadSession('oracle-claude-session')),
    );
    expect(projectRawRecord(await loadActiveRawRecord('ingest-claude-session'))).toStrictEqual(
      projectRawRecord(await loadActiveRawRecord('oracle-claude-session')),
    );
  });

  test('an empty hook_event_name captured through the client matches the db path session-level fields (item 5)', async () => {
    // apps/cli's db path preserves an empty-string hook_event_name verbatim (bare
    // `typeof x === 'string'`); the client used to trim it to undefined via
    // readHookString, dropping the field from activity/harnessMetadata/provenance.
    const oracleTranscript = join(projectRoot, 'oracle-empty-codex.jsonl');
    writeFileSync(oracleTranscript, codexTranscript('oracle-empty-session', projectRoot));
    const oracle = await cliCaptureHook('codex', {
      cwd: projectRoot,
      hook_event_name: '',
      session_id: 'oracle-empty-session',
      transcript_path: oracleTranscript,
    });
    expect(oracle.mode).toBe('captured');

    const ingestTranscript = join(projectRoot, 'ingest-empty-codex.jsonl');
    writeFileSync(ingestTranscript, codexTranscript('ingest-empty-session', projectRoot));
    const captured = await clientCaptureHook(
      'codex',
      {
        cwd: projectRoot,
        hook_event_name: '',
        session_id: 'ingest-empty-session',
        transcript_path: ingestTranscript,
      },
      { client: apiClient() },
      { binding: clientBinding('codex') },
    );
    expect(captured.mode).toBe('captured');
    expect(captured.ackStatus).toBe('stored');

    await runExtractionOnce();

    expect(projectSessionRow(await loadSession('ingest-empty-session'))).toStrictEqual(
      projectSessionRow(await loadSession('oracle-empty-session')),
    );
    expect(projectRawRecord(await loadActiveRawRecord('ingest-empty-session'))).toStrictEqual(
      projectRawRecord(await loadActiveRawRecord('oracle-empty-session')),
    );
  });

  test('the hook command emits { continue: true } on success and the systemMessage skip form on failure', async () => {
    const transcript = join(projectRoot, 'contract-codex.jsonl');
    writeFileSync(transcript, codexTranscript('contract-codex-session', projectRoot));

    const success = await clientIngestHook(
      'codex',
      RENDER_OPTIONS,
      { client: apiClient() },
      {
        binding: clientBinding('codex'),
        stdin: JSON.stringify({
          cwd: projectRoot,
          hook_event_name: 'UserPromptSubmit',
          session_id: 'contract-codex-session',
          transcript_path: transcript,
        }),
      },
    );
    expect(success).toBe(JSON.stringify({ continue: true }));

    // Force a failure: an unreachable service so the POST errors fast; the hook
    // must still return { continue: true } WITH the skip systemMessage.
    const deadClient = new SagaApiClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });
    const failure = await clientIngestHook(
      'codex',
      RENDER_OPTIONS,
      { client: deadClient },
      {
        binding: clientBinding('codex'),
        stdin: JSON.stringify({
          cwd: projectRoot,
          hook_event_name: 'UserPromptSubmit',
          session_id: 'contract-fail-session',
          transcript_path: transcript,
        }),
      },
    );
    const parsed = JSON.parse(failure) as { continue: boolean; systemMessage?: string };
    expect(parsed.continue).toBe(true);
    expect(parsed.systemMessage).toContain('Saga Codex capture skipped:');
  });

  test('first POST is stored, an identical re-POST is a duplicate, and the raw event is visible via listEvents', async () => {
    const transcript = join(projectRoot, 'idempotent-codex.jsonl');
    writeFileSync(transcript, codexTranscript('idempotent-codex-session', projectRoot));
    const hookInput = {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'idempotent-codex-session',
      transcript_path: transcript,
    };

    const first = await clientCaptureHook(
      'codex',
      hookInput,
      { client: apiClient() },
      { binding: clientBinding('codex') },
    );
    expect(first.ackStatus).toBe('stored');
    expect(first.rawEventId).toBeTypeOf('string');

    const second = await clientCaptureHook(
      'codex',
      hookInput,
      { client: apiClient() },
      { binding: clientBinding('codex') },
    );
    expect(second.ackStatus).toBe('duplicate');
    expect(second.rawEventId).toBe(first.rawEventId);

    const events = await apiClient().listEvents({ workspaceId: workspaceId() });
    expect(events.some((event) => event.id === first.rawEventId)).toBe(true);
  });

  test('ingest recent output byte-matches apps/cli inspectRecentRawEvents', async () => {
    const clientOutput = await clientInspectRecent([], RENDER_OPTIONS, {
      client: apiClient(),
      workspaceId: workspaceId(),
    });
    const cliOutput = await cliInspectRecent({ cwd: projectRoot }, RENDER_OPTIONS);
    expect(clientOutput).toBe(cliOutput);
    expect(clientOutput).toContain('Raw events');
  });
});
