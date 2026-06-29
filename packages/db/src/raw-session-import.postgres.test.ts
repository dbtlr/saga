import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { normalizeClaudeTranscript } from './claude-transcript-normalizer.js';
import { normalizeCodexTranscript } from './codex-transcript-normalizer.js';
import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import { insertRawEvent } from './raw-event.js';
import { importLifecycleBoundaryEvent, importRawSessionRecord } from './raw-session-import.js';
import {
  activityIntervals,
  rawSessionRecords,
  sessionSegmentEmbeddings,
  sessions,
  sessionRelationships,
  sessionSegments,
  sessionTurns,
  sourceBindings,
  users,
  workspaces,
} from './schema.js';
import { expandRecallContext, searchSessionRecall } from './session-recall.js';
import { getSessionDetail, listRecentSessionRecords } from './session-records.js';
import type { RecentSessionRecord, SessionDetail } from './session-records.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

function deferred<T>(): {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describePostgres('raw session import', () => {
  const databaseName = `saga_raw_session_import_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const testDatabaseUrl = new URL(databaseUrl ?? '');
    testDatabaseUrl.pathname = `/${databaseName}`;

    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: testDatabaseUrl.toString(),
          environment: 'test',
          logLevel: 'info',
          service: {
            host: '127.0.0.1',
            port: 4766,
          },
          secrets: {
            openaiApiKey: undefined,
          },
        },
        {
          postgres: {
            max: 10,
          },
        },
      ),
    );
    await Effect.runPromise(runMigrations(service));
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  async function createBoundWorkspace(handlePrefix: string): Promise<string> {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const [workspace] = await service.db
      .insert(workspaces)
      .values({
        handle: `${handlePrefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    return workspace.id;
  }

  async function runWithLockedActivityInterval<T>(
    activityIntervalId: string,
    expectedWaiters: number,
    runWhileLocked: () => Promise<T>,
  ): Promise<T> {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    const lockAcquired = deferred<void>();
    const releaseLock = deferred<void>();
    const lockTransaction = service.sql.begin(async (tx) => {
      await tx`select id from activity_intervals where id = ${activityIntervalId} for update`;
      lockAcquired.resolve();
      await releaseLock.promise;
    });

    await lockAcquired.promise;
    try {
      const running = runWhileLocked();
      await waitForBlockedTransactionLocks(expectedWaiters);
      releaseLock.resolve();
      return await running;
    } finally {
      releaseLock.resolve();
      await lockTransaction;
    }
  }

  async function waitForBlockedTransactionLocks(expectedWaiters: number): Promise<void> {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [locks] = await service.sql<{ blocked: number }[]>`
        select count(*)::int as blocked
        from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
      `;
      if ((locks?.blocked ?? 0) >= expectedWaiters) {
        return;
      }
      await sleep(20);
    }

    throw new Error(`timed out waiting for ${expectedWaiters} blocked transaction locks`);
  }

  async function seedSourceBindingAndRawEvent(input: {
    eventType: string;
    externalEventId: string;
    harness: 'claude' | 'codex';
    hostId: string;
    occurredAt: string;
    workspaceId: string;
  }): Promise<{ rawEventId: string; sourceBindingId: string }> {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    // sourceBindings has a unique index on (workspaceId, sourceType, sourceUri); upsert so repeated
    // calls for the same host/harness return ONE stable binding id (else session lookup forks).
    const sourceUri = `${input.harness}://host/${input.hostId}`;
    await service.db
      .insert(sourceBindings)
      .values({ sourceType: input.harness, sourceUri, workspaceId: input.workspaceId })
      .onConflictDoNothing({
        target: [sourceBindings.workspaceId, sourceBindings.sourceType, sourceBindings.sourceUri],
      });
    const [binding] = await service.db
      .select()
      .from(sourceBindings)
      .where(
        and(
          eq(sourceBindings.workspaceId, input.workspaceId),
          eq(sourceBindings.sourceType, input.harness),
          eq(sourceBindings.sourceUri, sourceUri),
        ),
      )
      .limit(1);
    if (binding === undefined) {
      throw new Error('source binding upsert returned no row');
    }
    const rawEvent = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: input.hostId,
        eventType: input.eventType,
        externalEventId: input.externalEventId,
        occurredAt: input.occurredAt,
        payload: { hook_event_name: input.eventType },
        provenance: { importedBy: 'test' },
        sourceBindingId: binding.id,
        sourceId: `${input.harness}:local`,
        sourceType: input.harness,
        trustLevel: 'raw',
        workspaceId: input.workspaceId,
      }),
    );
    return { rawEventId: rawEvent.id, sourceBindingId: binding.id };
  }

  test('migrates lexical indexes for session segment search', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    const indexes = await service.db.execute<{ indexdef: string; indexname: string }>(sql`
      select indexname, indexdef
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'session_segments'
        and indexname in ('session_segments_search_tsv_idx', 'session_segments_search_trgm_idx')
      order by indexname
    `);

    expect(indexes.map((index) => index.indexname)).toStrictEqual([
      'session_segments_search_trgm_idx',
      'session_segments_search_tsv_idx',
    ]);
    expect(
      indexes.find((index) => index.indexname === 'session_segments_search_tsv_idx')?.indexdef,
    ).toContain('to_tsvector');
    expect(
      indexes.find((index) => index.indexname === 'session_segments_search_trgm_idx')?.indexdef,
    ).toContain('gin_trgm_ops');
  });

  test('imports the same raw record idempotently without duplicate active snapshots', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-idempotent');
    const input = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      capturedAt: '2026-06-21T14:00:00.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      harnessMetadata: {
        cliVersion: 'test',
      },
      harnessSessionId: 'codex-session-1',
      host: {
        id: 'host-1',
        label: 'local-host',
        projectRoot: '/tmp/saga',
      },
      locator: '/tmp/codex-session-1.jsonl',
      rawContent: '{"type":"user","text":"Build SGA-120"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(first.operation).toBe('inserted');
    expect(second.operation).toBe('unchanged');
    expect(second.session.id).toBe(first.session.id);
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(second.sourceBinding.id).toBe(first.sourceBinding.id);
    expect(second.authorUser.id).toBe(first.authorUser.id);

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(1);
    expect(records.filter((record) => record.isActive)).toHaveLength(1);
    expect(records[0]?.contentBytes).toBe(Buffer.byteLength(input.rawContent, 'utf8'));
    expect(records[0]?.metadata).toMatchObject({
      contentBytes: Buffer.byteLength(input.rawContent, 'utf8'),
      sourceLocatorHash: expect.stringMatching(/^sha256:/),
    });

    const bindings = await service.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.workspaceId, workspaceId));
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      sourceType: 'codex',
      sourceUri: 'codex://host/host-1',
    });

    const hostUsers = await service.db
      .select()
      .from(users)
      .where(eq(users.workspaceId, workspaceId));
    expect(hostUsers).toHaveLength(1);
    expect(hostUsers[0]).toMatchObject({
      handle: 'drew',
      identitySource: 'host',
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(turns).toHaveLength(1);
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      ordinal: 0,
      searchText: 'Build SGA-120',
      segmentKind: 'turn',
      tokenStart: 0,
    });
  });

  test('unchanged raw-session reimport leaves current row updatedAt timestamps unchanged', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-idempotent-updated-at');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T12:00:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-idempotent-updated-at-session',
        },
      },
      {
        timestamp: '2026-06-22T12:00:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-idempotent-updated-at',
        },
      },
      {
        timestamp: '2026-06-22T12:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Do not churn timestamps.' }],
          metadata: { turn_id: 'turn-idempotent-updated-at' },
        },
      },
    ]);
    const input = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      capturedAt: '2026-06-22T12:00:02.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-idempotent-updated-at',
        label: 'local-host',
        projectRoot: '/work/saga',
      },
      locator: '/tmp/codex-idempotent-updated-at.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const frozenUpdatedAt = new Date('2026-06-22T00:00:00.000Z');
    await service.db
      .update(sessions)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(sessions.id, first.session.id));
    await service.db
      .update(activityIntervals)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(activityIntervals.id, first.activityInterval.id));
    await service.db
      .update(rawSessionRecords)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));
    await service.db
      .update(sourceBindings)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(sourceBindings.id, first.sourceBinding.id));
    await service.db
      .update(users)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(users.id, first.authorUser.id));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(second.operation).toBe('unchanged');
    expect(second.session.id).toBe(first.session.id);
    expect(second.activityInterval.id).toBe(first.activityInterval.id);
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(second.sourceBinding.id).toBe(first.sourceBinding.id);
    expect(second.authorUser.id).toBe(first.authorUser.id);

    const [storedSession] = await service.db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, first.session.id));
    const [storedActivityInterval] = await service.db
      .select({ updatedAt: activityIntervals.updatedAt })
      .from(activityIntervals)
      .where(eq(activityIntervals.id, first.activityInterval.id));
    const [storedRawSessionRecord] = await service.db
      .select({ updatedAt: rawSessionRecords.updatedAt })
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));
    const [storedSourceBinding] = await service.db
      .select({ updatedAt: sourceBindings.updatedAt })
      .from(sourceBindings)
      .where(eq(sourceBindings.id, first.sourceBinding.id));
    const [storedUser] = await service.db
      .select({ updatedAt: users.updatedAt })
      .from(users)
      .where(eq(users.id, first.authorUser.id));

    expect(storedSession?.updatedAt).toStrictEqual(frozenUpdatedAt);
    expect(storedActivityInterval?.updatedAt).toStrictEqual(frozenUpdatedAt);
    expect(storedRawSessionRecord?.updatedAt).toStrictEqual(frozenUpdatedAt);
    expect(storedSourceBinding?.updatedAt).toStrictEqual(frozenUpdatedAt);
    expect(storedUser?.updatedAt).toStrictEqual(frozenUpdatedAt);
  });

  test('handles concurrent duplicate first imports within one source binding', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const db = service;
    const workspaceId = await createBoundWorkspace('raw-import-concurrent-first');
    const input = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      capturedAt: '2026-06-22T21:00:00.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      harnessMetadata: {
        cliVersion: 'concurrent-test',
      },
      harnessSessionId: 'codex-concurrent-first',
      host: {
        id: 'host-concurrent-first',
        label: 'concurrent-host',
        projectRoot: '/work/saga',
      },
      locator: '/tmp/codex-concurrent-first.jsonl',
      rawContent: '{"type":"user","text":"Concurrent duplicate first import"}\n',
      workspaceId,
    } as const;
    const inputs = Array.from({ length: 8 }, () => input);

    const results = await Promise.all(
      inputs.map((callerInput) => Effect.runPromise(importRawSessionRecord(db, callerInput))),
    );
    const [first] = results;
    if (first === undefined) {
      throw new Error('concurrent imports returned no results');
    }

    expect(results.filter((result) => result.operation === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result.operation === 'unchanged')).toHaveLength(7);
    expect(new Set(results.map((result) => result.session.id))).toStrictEqual(
      new Set([first.session.id]),
    );
    expect(new Set(results.map((result) => result.rawSessionRecord.id))).toStrictEqual(
      new Set([first.rawSessionRecord.id]),
    );
    expect(new Set(results.map((result) => result.sourceBinding.id)).size).toBe(1);
    expect(new Set(results.map((result) => result.authorUser.id)).size).toBe(1);

    const [counts] = await service.sql<
      {
        active_raw_records: number;
        activity_intervals: number;
        raw_records: number;
        sessions: number;
        source_bindings: number;
        users: number;
      }[]
    >`
      select
        (select count(*)::int from sessions where workspace_id = ${workspaceId}) as sessions,
        (select count(*)::int from raw_session_records where workspace_id = ${workspaceId}) as raw_records,
        (select count(*)::int from raw_session_records where workspace_id = ${workspaceId} and is_active) as active_raw_records,
        (select count(*)::int from activity_intervals where workspace_id = ${workspaceId}) as activity_intervals,
        (select count(*)::int from source_bindings where workspace_id = ${workspaceId}) as source_bindings,
        (select count(*)::int from users where workspace_id = ${workspaceId}) as users
    `;
    expect(counts).toStrictEqual({
      active_raw_records: 1,
      activity_intervals: 1,
      raw_records: 1,
      sessions: 1,
      source_bindings: 1,
      users: 1,
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(turns).toHaveLength(1);
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id));
    expect(segments).toHaveLength(1);
  });

  test('scopes same workspace harness session ids by source binding', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-source-scoped-harness-id');
    const baseInput = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: 'shared-local-session-id',
      model: 'gpt-5-fixture',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:10:00.000Z',
        host: {
          id: 'host-source-scoped-harness-a',
          label: 'source-a',
        },
        locator: '/tmp/source-a/shared-local-session-id.jsonl',
        rawContent: '{"type":"user","text":"Source A owns this local id."}\n',
      }),
    );
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:11:00.000Z',
        host: {
          id: 'host-source-scoped-harness-b',
          label: 'source-b',
        },
        locator: '/tmp/source-b/shared-local-session-id.jsonl',
        rawContent: '{"type":"user","text":"Source B owns the same local id."}\n',
      }),
    );
    const repeatedFirst = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:10:00.000Z',
        host: {
          id: 'host-source-scoped-harness-a',
          label: 'source-a',
        },
        locator: '/tmp/source-a/shared-local-session-id.jsonl',
        rawContent: '{"type":"user","text":"Source A owns this local id."}\n',
      }),
    );

    expect(first.operation).toBe('inserted');
    expect(second.operation).toBe('inserted');
    expect(repeatedFirst.operation).toBe('unchanged');
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.sourceBinding.id).not.toBe(first.sourceBinding.id);
    expect(repeatedFirst.session.id).toBe(first.session.id);
    expect(repeatedFirst.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const rows = await service.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.harnessSessionId, 'shared-local-session-id'),
        ),
      )
      .orderBy(asc(sessions.sourceBindingId));
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.sourceBindingId))).toStrictEqual(
      new Set([first.sourceBinding.id, second.sourceBinding.id]),
    );
  });

  test('scopes same workspace locator fallback ids by source binding', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-source-scoped-locator');
    const baseInput = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'claude',
      locator: '/tmp/shared-local-fallback.jsonl',
      model: 'claude-fixture',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:12:00.000Z',
        host: {
          id: 'host-source-scoped-locator-a',
          label: 'source-a',
        },
        rawContent: '{"role":"user","content":"Source A fallback identity."}\n',
      }),
    );
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:13:00.000Z',
        host: {
          id: 'host-source-scoped-locator-b',
          label: 'source-b',
        },
        rawContent: '{"role":"user","content":"Source B fallback identity."}\n',
      }),
    );
    const repeatedFirst = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T21:12:00.000Z',
        host: {
          id: 'host-source-scoped-locator-a',
          label: 'source-a',
        },
        rawContent: '{"role":"user","content":"Source A fallback identity."}\n',
      }),
    );

    expect(first.operation).toBe('inserted');
    expect(second.operation).toBe('inserted');
    expect(repeatedFirst.operation).toBe('unchanged');
    expect(first.session.harnessSessionId).toBeNull();
    expect(second.session.harnessSessionId).toBeNull();
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.sourceBinding.id).not.toBe(first.sourceBinding.id);
    expect(repeatedFirst.session.id).toBe(first.session.id);
    expect(repeatedFirst.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const rows = await service.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, workspaceId),
          eq(sessions.harness, 'claude'),
          isNull(sessions.harnessSessionId),
        ),
      );
    const scopedRows = rows.filter(
      (row) => row.sourceLocatorHash === first.session.sourceLocatorHash,
    );
    expect(scopedRows).toHaveLength(2);
    expect(new Set(scopedRows.map((row) => row.sourceBindingId))).toStrictEqual(
      new Set([first.sourceBinding.id, second.sourceBinding.id]),
    );
  });

  test('keeps same-handle host users distinct across host subjects', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-host-users');
    const baseInput = {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      model: 'gpt-5-fixture',
      rawContent: '{"type":"user","text":"Host attribution fixture"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T14:00:00.000Z',
        harnessSessionId: 'host-session-1',
        host: {
          id: 'host-1',
          label: 'host-one',
          projectRoot: '/tmp/saga-one',
        },
        locator: '/tmp/host-session-1.jsonl',
      }),
    );
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T14:01:00.000Z',
        harnessSessionId: 'host-session-2',
        host: {
          id: 'host-2',
          label: 'host-two',
          projectRoot: '/tmp/saga-two',
        },
        locator: '/tmp/host-session-2.jsonl',
        rawContent: '{"type":"user","text":"Second host attribution fixture"}\n',
      }),
    );

    expect(first.authorUser.id).not.toBe(second.authorUser.id);
    expect(first.authorUser).toMatchObject({
      externalSubject: 'host-1',
      handle: 'drew',
      identitySource: 'host',
    });
    expect(second.authorUser).toMatchObject({
      externalSubject: 'host-2',
      handle: 'drew',
      identitySource: 'host',
    });

    const hostUsers = await service.db
      .select()
      .from(users)
      .where(eq(users.workspaceId, workspaceId))
      .orderBy(asc(users.externalSubject));
    expect(hostUsers.map((user) => user.externalSubject)).toStrictEqual(['host-1', 'host-2']);

    const rows = await service.sql<{ external_subject: string; sessions: string }[]>`
      select u.external_subject, count(*)::text as sessions
      from sessions s
      inner join users u
        on u.id = s.author_user_id
      where s.workspace_id = ${workspaceId}
      group by u.external_subject
      order by u.external_subject
    `;
    expect(rows).toStrictEqual([
      { external_subject: 'host-1', sessions: '1' },
      { external_subject: 'host-2', sessions: '1' },
    ]);
  });

  test('lists recent raw session records with session and provenance metadata', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-list');
    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          displayName: 'Drew',
          handle: 'drew',
        },
        capturedAt: '2026-06-21T16:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessMetadata: {
          cliVersion: 'test',
        },
        harnessSessionId: 'codex-session-list',
        host: {
          id: 'host-list',
          label: 'test-host',
          projectRoot: '/work/saga',
        },
        locator: '/tmp/codex-session-list.jsonl',
        metadata: {
          fixture: 'recent',
        },
        model: 'gpt-5',
        provenance: {
          importedBy: 'test',
        },
        rawContent:
          '{"type":"user","text":"List recent sessions"}\n{"type":"assistant","text":"Recent sessions listed"}\n',
        workspaceId,
      }),
    );

    const rows = await Effect.runPromise(
      listRecentSessionRecords(service, {
        harness: 'codex',
        limit: 5,
        workspaceId,
      }),
    );

    expect(rows).toHaveLength(1);
    expectRecentSessionRecordTimestampsCanRender(rows[0]);
    expect(rows[0]).toMatchObject({
      activityInterval: {
        id: imported.activityInterval.id,
        ordinal: 0,
      },
      authorUser: {
        displayName: 'Drew',
        handle: 'drew',
        identitySource: 'host',
      },
      counts: {
        activityIntervals: 1,
        rawSessionRecords: 1,
        segments: 2,
        turns: 2,
      },
      rawSessionRecord: {
        harness: 'codex',
        id: imported.rawSessionRecord.id,
        isActive: true,
        metadata: expect.objectContaining({
          fixture: 'recent',
        }),
        provenance: {
          importedBy: 'test',
        },
      },
      session: {
        harness: 'codex',
        id: imported.session.id,
        model: 'gpt-5',
      },
      sourceBinding: {
        sourceType: 'codex',
        sourceUri: 'codex://host/host-list',
      },
    });
  });

  test('redacts local session provenance from public read models while preserving persisted rows', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-provenance-redaction');
    const projectRoot = '/work/saga';
    const transcriptPath = '/work/saga/private-session.jsonl';
    const fileLocator = 'file:///work/saga/private-session.jsonl';
    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-21T16:30:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'codex-session-private-provenance',
        host: {
          id: 'host-private-provenance',
          label: 'test-host',
          projectRoot,
        },
        locator: fileLocator,
        metadata: {
          cwd: projectRoot,
        },
        provenance: {
          transcript_path: transcriptPath,
          transcriptPath,
          transcriptUri: fileLocator,
        },
        rawContent: '{"type":"user","text":"Private provenance should not leak"}\n',
        workspaceId,
      }),
    );

    const [persistedRawRecord] = await service.db
      .select({
        provenance: rawSessionRecords.provenance,
        sourceLocator: rawSessionRecords.sourceLocator,
      })
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, imported.rawSessionRecord.id));
    const [persistedSession] = await service.db
      .select({
        sourceLocator: sessions.sourceLocator,
      })
      .from(sessions)
      .where(eq(sessions.id, imported.session.id));
    const [persistedSourceBinding] = await service.db
      .select({
        config: sourceBindings.config,
      })
      .from(sourceBindings)
      .where(eq(sourceBindings.id, imported.sourceBinding.id));

    expect(persistedRawRecord).toMatchObject({
      provenance: {
        transcriptPath,
        transcriptUri: fileLocator,
        transcript_path: transcriptPath,
      },
      sourceLocator: fileLocator,
    });
    expect(persistedSession?.sourceLocator).toBe(fileLocator);
    expect(persistedSourceBinding?.config).toMatchObject({
      projectRoot,
    });

    const recentRows = await Effect.runPromise(
      listRecentSessionRecords(service, {
        limit: 5,
        workspaceId,
      }),
    );
    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.session.id,
        workspaceId,
      }),
    );
    const publicText = JSON.stringify({ detail, recentRows });

    expect(publicText).toContain('[local-path-redacted]');
    expect(publicText).not.toContain(transcriptPath);
    expect(publicText).not.toContain(fileLocator);
    expect(publicText).not.toContain(projectRoot);
    expect(recentRows[0]?.rawSessionRecord.sourceLocator).toBeNull();
    expect(detail.session.sourceLocator).toBeNull();
    expect(detail.rawSessionRecords[0]?.sourceLocator).toBeNull();
  });

  test('shows a session detail through either session id or raw record id with bounded turns', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-show');
    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-21T17:00:00.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        host: {
          id: 'host-show',
          label: 'test-host',
        },
        locator: '/tmp/claude-session-show.jsonl',
        rawContent:
          '{"role":"user","content":"First detail turn"}\n{"role":"assistant","content":"Second detail turn"}\n',
        workspaceId,
      }),
    );

    const bySession = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.session.id,
        maxSegmentsPerTurn: 1,
        maxTurns: 1,
        workspaceId,
      }),
    );
    const byRawRecord = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.rawSessionRecord.id,
        workspaceId,
      }),
    );

    expect(bySession.session.id).toBe(imported.session.id);
    expectSessionDetailTimestampsCanRender(bySession);
    expect(bySession.activeRawSessionRecord?.id).toBe(imported.rawSessionRecord.id);
    expect(Object.hasOwn(bySession.activeRawSessionRecord ?? {}, 'bodyText')).toBe(false);
    expect(Object.hasOwn(bySession.activeRawSessionRecord ?? {}, 'bodyJson')).toBe(false);
    expect(Object.hasOwn(bySession.activeRawSessionRecord ?? {}, 'rawBodyExposure')).toBe(false);
    expect(Object.hasOwn(bySession.rawSessionRecords[0] ?? {}, 'bodyText')).toBe(false);
    expect(Object.hasOwn(bySession.rawSessionRecords[0] ?? {}, 'bodyJson')).toBe(false);
    expect(Object.hasOwn(bySession.rawSessionRecords[0] ?? {}, 'rawBodyExposure')).toBe(false);
    expect(bySession.selectedRawSessionRecord).toBeNull();
    expect(bySession.activityIntervals).toHaveLength(1);
    expect(bySession.activityIntervals[0]?.turns).toHaveLength(1);
    expect(bySession.activityIntervals[0]?.turns[0]?.segments).toHaveLength(1);
    expect(bySession.truncated).toMatchObject({
      rawSessionRecords: false,
      segments: false,
      turns: true,
    });

    expect(byRawRecord.session.id).toBe(imported.session.id);
    expectSessionDetailTimestampsCanRender(byRawRecord);
    expect(byRawRecord.selectedRawSessionRecord?.id).toBe(imported.rawSessionRecord.id);
    expect(byRawRecord.activityIntervals[0]?.turns).toHaveLength(2);

    const withRawBody = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.session.id,
        includeRawBody: true,
        workspaceId,
      }),
    );
    expect(withRawBody.limits.includeRawBody).toBe(true);
    expect(withRawBody.activeRawSessionRecord?.rawBodyExposure).toMatchObject({
      mode: 'raw_forensic',
      requestedBy: 'includeRawBody',
    });
    expect(withRawBody.activeRawSessionRecord?.rawBodyExposure?.warning).toContain(
      'may include skipped',
    );
    expect(withRawBody.activeRawSessionRecord?.bodyText).toBe(
      '{"role":"user","content":"First detail turn"}\n{"role":"assistant","content":"Second detail turn"}\n',
    );
    expect(withRawBody.activeRawSessionRecord?.bodyJson).toStrictEqual([
      { role: 'user', content: 'First detail turn' },
      { role: 'assistant', content: 'Second detail turn' },
    ]);
    expect(withRawBody.rawSessionRecords[0]?.bodyText).toBe(
      '{"role":"user","content":"First detail turn"}\n{"role":"assistant","content":"Second detail turn"}\n',
    );
    expect(withRawBody.rawSessionRecords[0]?.rawBodyExposure).toMatchObject({
      mode: 'raw_forensic',
      requestedBy: 'includeRawBody',
    });
    expect(withRawBody.rawSessionRecords[0]?.bodyJson).toStrictEqual([
      { role: 'user', content: 'First detail turn' },
      { role: 'assistant', content: 'Second detail turn' },
    ]);
  });

  test('shows a selected raw record outside the bounded raw-record window', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-show-selected-outside-window');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'claude',
      host: {
        id: 'host-show-selected-outside-window',
        label: 'test-host',
      },
      locator: '/tmp/claude-selected-outside-window.jsonl',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T18:00:00.000Z',
        rawContent: '{"role":"user","content":"Historical selected turn"}\n',
      }),
    );
    await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T18:05:00.000Z',
        rawContent:
          '{"role":"user","content":"Historical selected turn"}\n{"role":"assistant","content":"Second snapshot"}\n',
      }),
    );
    await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T18:10:00.000Z',
        rawContent:
          '{"role":"user","content":"Historical selected turn"}\n{"role":"assistant","content":"Second snapshot"}\n{"role":"user","content":"Third snapshot"}\n',
      }),
    );
    const active = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T18:15:00.000Z',
        rawContent:
          '{"role":"user","content":"Historical selected turn"}\n{"role":"assistant","content":"Second snapshot"}\n{"role":"user","content":"Third snapshot"}\n{"role":"assistant","content":"Active snapshot"}\n',
      }),
    );

    const [historicalTurn] = await service.db
      .insert(sessionTurns)
      .values({
        actorKind: 'host_user',
        actorLabel: 'drew',
        activityIntervalId: first.activityInterval.id,
        contentParts: [{ type: 'text', text: 'Historical selected turn' }],
        harnessTurnId: 'historical-selected-turn',
        metadata: {
          fixture: 'selected-outside-window',
        },
        model: null,
        ordinal: 0,
        rawSessionRecordId: first.rawSessionRecord.id,
        role: 'user',
        sessionId: first.session.id,
        startedAt: new Date('2026-06-21T18:00:00.000Z'),
        workspaceId,
      })
      .returning();
    if (historicalTurn === undefined) {
      throw new Error('historical turn insert returned no row');
    }
    await service.db.insert(sessionSegments).values({
      activityIntervalId: first.activityInterval.id,
      charEnd: 'Historical selected turn'.length,
      charStart: 0,
      metadata: {
        fixture: 'selected-outside-window',
      },
      ordinal: 0,
      rawSessionRecordId: first.rawSessionRecord.id,
      searchText: 'Historical selected turn',
      segmentKind: 'turn',
      sessionId: first.session.id,
      snippet: 'Historical selected turn',
      tokenEnd: null,
      tokenStart: null,
      turnId: historicalTurn.id,
      workspaceId,
    });

    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: first.rawSessionRecord.id,
        maxRawRecords: 2,
        workspaceId,
      }),
    );

    expect(detail.activeRawSessionRecord?.id).toBe(active.rawSessionRecord.id);
    expect(detail.selectedRawSessionRecord?.id).toBe(first.rawSessionRecord.id);
    expect(detail.rawSessionRecords).toHaveLength(2);
    expect(detail.rawSessionRecords.map((record) => record.id)).not.toContain(
      first.rawSessionRecord.id,
    );
    expect(detail.truncated.rawSessionRecords).toBe(true);
    const turns = detail.activityIntervals.flatMap((interval) => interval.turns);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.turn.harnessTurnId).toBe('historical-selected-turn');
    expect(turns[0]?.segments[0]?.searchText).toBe('Historical selected turn');
  });

  test('imports growing raw content as a new active snapshot and regenerates derived rows', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-growing');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-21T15:00:00.000Z',
      contentType: 'jsonl',
      harness: 'claude',
      host: {
        id: 'host-2',
        label: 'local-host',
      },
      locator: '/tmp/claude-growing.jsonl',
      rawContent: '{"role":"user","content":"First turn"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-21T15:05:00.000Z',
        rawContent:
          '{"role":"user","content":"First turn"}\n{"role":"assistant","content":"Second turn"}\n',
      }),
    );

    expect(second.operation).toBe('inserted');
    expect(second.session.id).toBe(first.session.id);
    expect(second.rawSessionRecord.id).not.toBe(first.rawSessionRecord.id);
    expect(second.rawSessionRecord.snapshotOrdinal).toBe(
      first.rawSessionRecord.snapshotOrdinal + 1,
    );
    expect(second.rawSessionRecord.isActive).toBe(true);

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isActive).map((record) => record.id)).toStrictEqual([
      second.rawSessionRecord.id,
    ]);
    expect(records.find((record) => record.id === first.rawSessionRecord.id)?.isActive).toBe(false);

    const oldTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldTurns).toHaveLength(0);
    const oldSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldSegments).toHaveLength(0);

    const newTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, second.rawSessionRecord.id));
    expect(newTurns).toHaveLength(2);

    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(
        and(
          eq(sessionSegments.rawSessionRecordId, second.rawSessionRecord.id),
          eq(sessionSegments.sessionId, second.session.id),
        ),
      );
    expect(activeSegments).toHaveLength(2);
    expect(activeSegments.map((segment) => segment.searchText)).toStrictEqual([
      'First turn',
      'Second turn',
    ]);
  });

  test('handles concurrent duplicate growing imports as one new active snapshot', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const db = service;
    const workspaceId = await createBoundWorkspace('raw-import-concurrent-growing');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T21:30:00.000Z',
      contentType: 'jsonl',
      harness: 'claude',
      host: {
        id: 'host-concurrent-growing',
        label: 'concurrent-host',
      },
      locator: '/tmp/claude-concurrent-growing.jsonl',
      rawContent: '{"role":"user","content":"Before concurrent growth"}\n',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const growingInput = {
      ...baseInput,
      capturedAt: '2026-06-22T21:35:00.000Z',
      rawContent:
        '{"role":"user","content":"Before concurrent growth"}\n{"role":"assistant","content":"Concurrent growth response"}\n',
    } as const;
    const growingInputs = Array.from({ length: 8 }, () => growingInput);
    const results = await Promise.all(
      growingInputs.map((callerInput) =>
        Effect.runPromise(importRawSessionRecord(db, callerInput)),
      ),
    );
    const [grown] = results;
    if (grown === undefined) {
      throw new Error('concurrent growing imports returned no results');
    }

    expect(results.filter((result) => result.operation === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result.operation === 'unchanged')).toHaveLength(7);
    expect(new Set(results.map((result) => result.session.id))).toStrictEqual(
      new Set([first.session.id]),
    );
    expect(new Set(results.map((result) => result.rawSessionRecord.id))).toStrictEqual(
      new Set([grown.rawSessionRecord.id]),
    );
    expect(grown.rawSessionRecord.id).not.toBe(first.rawSessionRecord.id);
    expect(grown.rawSessionRecord.snapshotOrdinal).toBe(1);

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id))
      .orderBy(asc(rawSessionRecords.snapshotOrdinal));
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.snapshotOrdinal)).toStrictEqual([0, 1]);
    expect(records.find((record) => record.id === first.rawSessionRecord.id)?.isActive).toBe(false);
    expect(records.filter((record) => record.isActive).map((record) => record.id)).toStrictEqual([
      grown.rawSessionRecord.id,
    ]);

    const oldTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldTurns).toHaveLength(0);
    const newTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, grown.rawSessionRecord.id));
    expect(newTurns).toHaveLength(2);
    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, grown.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(activeSegments.map((segment) => segment.searchText)).toStrictEqual([
      'Before concurrent growth',
      'Concurrent growth response',
    ]);
  });

  test('uses an explicit harness source binding without re-enabling disabled bindings', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-disabled-source');
    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        config: {
          hostId: 'host-disabled-source',
        },
        enabled: false,
        sourceType: 'codex',
        sourceUri: 'codex://host/host-disabled-source',
        workspaceId,
      })
      .returning();
    if (sourceBinding === undefined) {
      throw new Error('source binding insert returned no row');
    }

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-disabled-source',
        },
        locator: '/tmp/codex-disabled-source.jsonl',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-disabled-source-session',
            },
          },
          {
            timestamp: '2026-06-22T19:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Import without enabling source.' }],
            },
          },
        ]),
        sourceBindingId: sourceBinding.id,
        workspaceId,
      }),
    );

    expect(result.sourceBinding.id).toBe(sourceBinding.id);
    expect(result.sourceBinding.enabled).toBe(false);

    const [storedBinding] = await service.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.id, sourceBinding.id))
      .limit(1);
    expect(storedBinding?.enabled).toBe(false);

    const recall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'Import without enabling source',
        workspaceId,
      }),
    );
    expect(recall.matchCount).toBe(0);
  });

  test('implicit manual imports re-enable an existing disabled harness source binding', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-manual-enabled-source');
    const [sourceBinding] = await service.db
      .insert(sourceBindings)
      .values({
        config: {
          hostId: 'host-manual-enabled-source',
        },
        enabled: false,
        sourceType: 'codex',
        sourceUri: 'codex://host/host-manual-enabled-source',
        workspaceId,
      })
      .returning();
    if (sourceBinding === undefined) {
      throw new Error('source binding insert returned no row');
    }

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-manual-enabled-source',
        },
        locator: '/tmp/codex-manual-enabled-source.jsonl',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:10:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-manual-enabled-source-session',
            },
          },
          {
            timestamp: '2026-06-22T19:10:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Import and make manual source visible.' }],
            },
          },
        ]),
        workspaceId,
      }),
    );

    expect(result.sourceBinding.id).toBe(sourceBinding.id);
    expect(result.sourceBinding.enabled).toBe(true);

    const [storedBinding] = await service.db
      .select()
      .from(sourceBindings)
      .where(eq(sourceBindings.id, sourceBinding.id))
      .limit(1);
    expect(storedBinding?.enabled).toBe(true);

    const recall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'Import and make manual source visible',
        workspaceId,
      }),
    );
    expect(recall.matchCount).toBe(1);
    expect(recall.sessions[0]?.session.sourceBindingId).toBe(sourceBinding.id);
  });

  test('settles the active Activity Interval from ambient Stop lifecycle input', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-stop-interval');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-stop-interval',
      },
      locator: '/tmp/codex-stop-interval.jsonl',
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'UserPromptSubmit',
        },
        capturedAt: '2026-06-22T19:10:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:10:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-stop-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T19:10:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Start a stoppable interval.' }],
            },
          },
        ]),
      }),
    );
    const stopped = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'Stop',
        },
        capturedAt: '2026-06-22T19:15:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:10:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-stop-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T19:10:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Start a stoppable interval.' }],
            },
          },
          {
            timestamp: '2026-06-22T19:15:00.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              id: 'assistant-stop-interval',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'The interval can settle.' }],
            },
          },
        ]),
      }),
    );

    expect(stopped.activityInterval.id).toBe(first.activityInterval.id);
    expect(stopped.activityInterval).toMatchObject({
      endedAt: new Date('2026-06-22T19:15:00.000Z'),
      settlementReason: 'stop_event',
      status: 'settled',
    });
    expect(stopped.session.status).toBe('completed');
  });

  test('settles an unchanged active raw snapshot from ambient Stop lifecycle input', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-unchanged-stop-interval');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T19:16:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-unchanged-stop-interval-session',
        },
      },
      {
        timestamp: '2026-06-22T19:16:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Stop without transcript growth.' }],
        },
      },
    ]);
    const baseInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T19:16:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-unchanged-stop-interval',
      },
      locator: '/tmp/codex-unchanged-stop-interval.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'UserPromptSubmit',
        },
      }),
    );
    const stopped = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'Stop',
        },
        capturedAt: '2026-06-22T19:17:00.000Z',
      }),
    );

    expect(stopped.operation).toBe('unchanged');
    expect(stopped.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(stopped.activityInterval.id).toBe(first.activityInterval.id);
    expect(stopped.activityInterval).toMatchObject({
      endedAt: new Date('2026-06-22T19:16:01.000Z'),
      settlementReason: 'stop_event',
      status: 'settled',
    });
    expect(stopped.session.status).toBe('completed');
  });

  test('settles unchanged Stop input captured at the active interval boundary', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-boundary-stop-interval');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T19:18:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-boundary-stop-interval-session',
        },
      },
      {
        timestamp: '2026-06-22T19:18:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Stop exactly on the active boundary.' }],
        },
      },
    ]);
    const baseInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T19:18:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-boundary-stop-interval',
      },
      locator: '/tmp/codex-boundary-stop-interval.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'UserPromptSubmit',
        },
      }),
    );
    const stopped = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: {
          hookEventName: 'Stop',
        },
      }),
    );

    expect(stopped.operation).toBe('unchanged');
    expect(stopped.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(stopped.activityInterval.id).toBe(first.activityInterval.id);
    expect(stopped.activityInterval).toMatchObject({
      endedAt: new Date('2026-06-22T19:18:01.000Z'),
      settlementReason: 'stop_event',
      status: 'settled',
    });
    expect(stopped.session).toMatchObject({
      endedAt: new Date('2026-06-22T19:18:01.000Z'),
      status: 'completed',
    });
  });

  test('refreshes stale current active snapshot state before same-content no-op', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-stale-current-active');
    const input = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T19:19:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-stale-current-active',
      },
      locator: '/tmp/codex-stale-current-active.jsonl',
      rawContent: codexTranscript([
        {
          timestamp: '2026-06-22T19:19:00.000Z',
          type: 'session_meta',
          payload: {
            cwd: '/work/saga',
            id: 'codex-stale-current-active-session',
          },
        },
        {
          timestamp: '2026-06-22T19:19:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Repair stale current active state.' }],
          },
        },
      ]),
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    await service.db
      .update(sessions)
      .set({ metadata: {} })
      .where(eq(sessions.id, first.session.id));
    await service.db
      .update(activityIntervals)
      .set({ metadata: {} })
      .where(eq(activityIntervals.id, first.activityInterval.id));

    const repeated = await Effect.runPromise(importRawSessionRecord(service, input));
    const [sessionRow] = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, first.session.id))
      .limit(1);
    const [activityIntervalRow] = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.id, first.activityInterval.id))
      .limit(1);

    expect(repeated.operation).toBe('unchanged');
    expect(repeated.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(repeated.activityInterval.id).toBe(first.activityInterval.id);
    expect(repeated.session.lastActivityAt).toStrictEqual(new Date('2026-06-22T19:19:01.000Z'));
    expect(sessionRow?.metadata).toMatchObject({
      cwd: '/work/saga',
      latestRawSessionRecordId: first.rawSessionRecord.id,
      normalizer: 'codex-transcript-v1',
      turnCount: 1,
    });
    expect(activityIntervalRow?.metadata).toMatchObject({
      cwd: '/work/saga',
      normalizer: 'codex-transcript-v1',
    });
  });

  test('opens new Activity Intervals for clear-context lifecycle and idle timeout', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-interval-boundaries');
    const clearBaseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-clear-interval',
      },
      locator: '/tmp/codex-clear-interval.jsonl',
      workspaceId,
    } as const;
    const clearFirst = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...clearBaseInput,
        capturedAt: '2026-06-22T19:20:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:20:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-clear-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T19:20:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Before clear context.' }],
            },
          },
        ]),
      }),
    );
    const clearSecond = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...clearBaseInput,
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'clear',
        },
        capturedAt: '2026-06-22T19:22:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T19:20:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-clear-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T19:22:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'After clear context.' }],
            },
          },
        ]),
      }),
    );

    expect(clearSecond.activityInterval.id).not.toBe(clearFirst.activityInterval.id);
    expect(clearSecond.activityInterval.ordinal).toBe(1);
    const clearIntervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, clearFirst.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(clearIntervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
    expect(clearIntervals[0]).toMatchObject({
      settlementReason: 'clear_context',
    });

    const idleBaseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-idle-interval',
      },
      locator: '/tmp/codex-idle-interval.jsonl',
      workspaceId,
    } as const;
    const idleFirst = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...idleBaseInput,
        capturedAt: '2026-06-22T20:00:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T20:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-idle-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T20:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Before idle timeout.' }],
            },
          },
        ]),
      }),
    );
    const idleSecond = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...idleBaseInput,
        capturedAt: '2026-06-22T20:45:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T20:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-idle-interval-session',
            },
          },
          {
            timestamp: '2026-06-22T20:45:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'After idle timeout.' }],
            },
          },
        ]),
      }),
    );

    expect(idleSecond.activityInterval.id).not.toBe(idleFirst.activityInterval.id);
    expect(idleSecond.activityInterval.ordinal).toBe(1);
    const idleIntervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, idleFirst.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(idleIntervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
    expect(idleIntervals[0]).toMatchObject({
      endedAt: new Date('2026-06-22T20:30:01.000Z'),
      settlementReason: 'idle_timeout',
    });
  });

  test('opens new Activity Intervals for same-content clear and compact lifecycle inputs', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    for (const sessionStartSource of ['clear', 'compact'] as const) {
      const workspaceId = await createBoundWorkspace(
        `raw-import-same-content-${sessionStartSource}`,
      );
      const rawContent = codexTranscript([
        {
          timestamp: '2026-06-23T00:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: `codex-same-content-${sessionStartSource}-session`,
          },
        },
        {
          timestamp: '2026-06-23T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Before ${sessionStartSource}.` }],
          },
        },
      ]);
      const baseInput = {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-23T00:00:01.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: `host-same-content-${sessionStartSource}`,
        },
        locator: `/tmp/codex-same-content-${sessionStartSource}.jsonl`,
        rawContent,
        workspaceId,
      } as const;

      const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
      const boundary = await Effect.runPromise(
        importRawSessionRecord(service, {
          ...baseInput,
          activity: {
            hookEventName: 'SessionStart',
            sessionStartSource,
          },
          capturedAt: '2026-06-23T00:05:00.000Z',
        }),
      );
      const repeatedBoundary = await Effect.runPromise(
        importRawSessionRecord(service, {
          ...baseInput,
          activity: {
            hookEventName: 'SessionStart',
            sessionStartSource,
          },
          capturedAt: '2026-06-23T00:05:00.000Z',
        }),
      );

      expect(boundary.operation).toBe('unchanged');
      expect(boundary.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
      expect(boundary.activityInterval.id).not.toBe(first.activityInterval.id);
      expect(boundary.activityInterval).toMatchObject({
        ordinal: 1,
        startedAt: new Date('2026-06-23T00:05:00.000Z'),
        status: 'active',
      });
      expect(repeatedBoundary.operation).toBe('unchanged');
      expect(repeatedBoundary.activityInterval.id).toBe(boundary.activityInterval.id);
      expect(repeatedBoundary.session.lastActivityAt).toStrictEqual(
        new Date('2026-06-23T00:05:00.000Z'),
      );

      const intervals = await service.db
        .select()
        .from(activityIntervals)
        .where(eq(activityIntervals.sessionId, first.session.id))
        .orderBy(asc(activityIntervals.ordinal));
      expect(intervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
      expect(intervals[0]).toMatchObject({
        endedAt: new Date('2026-06-23T00:05:00.000Z'),
        settlementReason: 'clear_context',
      });

      const records = await service.db
        .select()
        .from(rawSessionRecords)
        .where(eq(rawSessionRecords.sessionId, first.session.id));
      expect(records).toHaveLength(1);
      // ADR-0031: the record and the rows its snapshot produced stay in the producing interval;
      // the boundary opens a new empty interval rather than absorbing the existing snapshot.
      expect(records[0]).toMatchObject({
        activityIntervalId: first.activityInterval.id,
        id: first.rawSessionRecord.id,
        isActive: true,
      });
    }
  });

  test('same-content clear and compact boundaries keep derived rows in the producing interval (ADR-0031)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    for (const sessionStartSource of ['clear', 'compact'] as const) {
      const workspaceId = await createBoundWorkspace(
        `raw-import-same-content-${sessionStartSource}-derived`,
      );
      const rawContent = codexTranscript([
        {
          timestamp: '2026-06-23T02:00:00.000Z',
          type: 'session_meta',
          payload: { id: `codex-same-content-${sessionStartSource}-derived-session` },
        },
        {
          timestamp: '2026-06-23T02:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Pre-${sessionStartSource} work.` }],
          },
        },
      ]);
      const baseInput = {
        author: { handle: 'drew' },
        capturedAt: '2026-06-23T02:00:01.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: { id: `host-same-content-${sessionStartSource}-derived` },
        locator: `/tmp/codex-same-content-${sessionStartSource}-derived.jsonl`,
        rawContent,
        workspaceId,
      } as const;

      const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));

      const turnsAfterContent = await service.db
        .select()
        .from(sessionTurns)
        .where(eq(sessionTurns.sessionId, first.session.id));
      expect(turnsAfterContent.length).toBeGreaterThan(0);
      expect(new Set(turnsAfterContent.map((turn) => turn.activityIntervalId))).toStrictEqual(
        new Set([first.activityInterval.id]),
      );

      const segmentsAfterContent = await service.db
        .select()
        .from(sessionSegments)
        .where(eq(sessionSegments.sessionId, first.session.id));
      expect(segmentsAfterContent.length).toBeGreaterThan(0);

      // Same content, now carrying the boundary on the content path.
      const boundary = await Effect.runPromise(
        importRawSessionRecord(service, {
          ...baseInput,
          activity: { hookEventName: 'SessionStart', sessionStartSource },
          capturedAt: '2026-06-23T02:05:00.000Z',
        }),
      );

      // The boundary genuinely settles interval 0 and opens an empty interval 1; otherwise the
      // no-reassignment assertions below would pass vacuously.
      const intervals = await service.db
        .select()
        .from(activityIntervals)
        .where(eq(activityIntervals.sessionId, first.session.id))
        .orderBy(asc(activityIntervals.ordinal));
      expect(intervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
      expect(boundary.activityInterval.id).toBe(intervals[1]?.id);
      expect(boundary.activityInterval.id).not.toBe(first.activityInterval.id);

      // ADR-0031: pre-boundary Turns and Segments stay attached to the interval whose snapshot
      // produced them (interval 0); they are not reassigned to the freshly opened interval.
      const turnsAfterBoundary = await service.db
        .select()
        .from(sessionTurns)
        .where(eq(sessionTurns.sessionId, first.session.id));
      expect(turnsAfterBoundary).toHaveLength(turnsAfterContent.length);
      expect(new Set(turnsAfterBoundary.map((turn) => turn.activityIntervalId))).toStrictEqual(
        new Set([first.activityInterval.id]),
      );

      const segmentsAfterBoundary = await service.db
        .select()
        .from(sessionSegments)
        .where(eq(sessionSegments.sessionId, first.session.id));
      expect(
        new Set(segmentsAfterBoundary.map((segment) => segment.activityIntervalId)),
      ).toStrictEqual(new Set([first.activityInterval.id]));

      // ADR-0031: the post-boundary interval exists but holds no derived content yet.
      expect(
        turnsAfterBoundary.filter(
          (turn) => turn.activityIntervalId === boundary.activityInterval.id,
        ),
      ).toHaveLength(0);

      // Coherence: the active record stays with the derived rows it produced (interval 0),
      // not the freshly opened empty interval.
      const records = await service.db
        .select()
        .from(rawSessionRecords)
        .where(eq(rawSessionRecords.sessionId, first.session.id));
      expect(records).toHaveLength(1);
      expect(records[0]?.activityIntervalId).toBe(first.activityInterval.id);
    }
  });

  test('same-content resume input continues the producing interval without reassigning derived rows (ADR-0031)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-same-content-resume-derived');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-23T03:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-same-content-resume-derived-session' },
      },
      {
        timestamp: '2026-06-23T03:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pre-resume work.' }],
        },
      },
    ]);
    const baseInput = {
      author: { handle: 'drew' },
      capturedAt: '2026-06-23T03:00:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: { id: 'host-same-content-resume-derived' },
      locator: '/tmp/codex-same-content-resume-derived.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const turnsAfterContent = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, first.session.id));
    expect(turnsAfterContent.length).toBeGreaterThan(0);

    // Resume is not an interval boundary: a same-content resume continues the existing interval
    // rather than opening a new one, so derived rows are never at risk of reassignment.
    const resumed = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: { hookEventName: 'SessionStart', sessionStartSource: 'resume' },
        capturedAt: '2026-06-23T03:05:00.000Z',
      }),
    );
    expect(resumed.activityInterval.id).toBe(first.activityInterval.id);

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id));
    expect(intervals).toHaveLength(1);

    const turnsAfterResume = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, first.session.id));
    expect(turnsAfterResume).toHaveLength(turnsAfterContent.length);
    expect(new Set(turnsAfterResume.map((turn) => turn.activityIntervalId))).toStrictEqual(
      new Set([first.activityInterval.id]),
    );
  });

  test('a second distinct same-content boundary settles the active interval without corrupting the first (ADR-0031)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-second-boundary');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-23T04:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'codex-second-boundary-session' },
      },
      {
        timestamp: '2026-06-23T04:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Pre-boundary work.' }],
        },
      },
    ]);
    const baseInput = {
      author: { handle: 'drew' },
      capturedAt: '2026-06-23T04:00:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: { id: 'host-second-boundary' },
      locator: '/tmp/codex-second-boundary.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const clearOnce = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: { hookEventName: 'SessionStart', sessionStartSource: 'clear' },
        capturedAt: '2026-06-23T04:05:00.000Z',
      }),
    );
    // A second, distinct boundary on the still-unchanged transcript.
    const clearTwice = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        activity: { hookEventName: 'SessionStart', sessionStartSource: 'clear' },
        capturedAt: '2026-06-23T04:10:00.000Z',
      }),
    );

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id))
      .orderBy(asc(activityIntervals.ordinal));

    // The second boundary must genuinely settle the (empty) active interval and open a new one,
    // not silently collapse back onto the record's already-settled producing interval.
    expect(intervals.map((interval) => interval.status)).toStrictEqual([
      'settled',
      'settled',
      'active',
    ]);
    expect(clearTwice.activityInterval.id).toBe(intervals[2]?.id);
    expect(clearTwice.activityInterval.id).not.toBe(clearOnce.activityInterval.id);

    // The first boundary's settlement on the producing interval must remain intact — never wiped.
    expect(intervals[0]).toMatchObject({
      id: first.activityInterval.id,
      settlementReason: 'clear_context',
      status: 'settled',
    });
    expect(intervals[0]?.settledAt).not.toBeNull();
    expect(intervals[0]?.endedAt).not.toBeNull();

    // ADR-0031: the derived rows still live in the producing interval and nowhere else.
    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, first.session.id));
    expect(turns.length).toBeGreaterThan(0);
    expect(new Set(turns.map((turn) => turn.activityIntervalId))).toStrictEqual(
      new Set([first.activityInterval.id]),
    );
  });

  test('opens a new Activity Interval for same-content idle-boundary input', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('raw-import-same-content-idle');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-23T01:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-same-content-idle-session',
        },
      },
      {
        timestamp: '2026-06-23T01:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Before idle same-content import.' }],
        },
      },
    ]);
    const baseInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-23T01:00:01.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-same-content-idle',
      },
      locator: '/tmp/codex-same-content-idle.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, baseInput));
    const boundary = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-23T01:45:01.000Z',
      }),
    );
    const repeatedBoundary = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-23T01:45:01.000Z',
      }),
    );

    expect(boundary.operation).toBe('unchanged');
    expect(boundary.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(boundary.activityInterval.id).not.toBe(first.activityInterval.id);
    expect(boundary.activityInterval).toMatchObject({
      ordinal: 1,
      startedAt: new Date('2026-06-23T01:45:01.000Z'),
      status: 'active',
    });
    expect(boundary.session.lastActivityAt).toStrictEqual(new Date('2026-06-23T01:45:01.000Z'));
    expect(repeatedBoundary.operation).toBe('unchanged');
    expect(repeatedBoundary.activityInterval.id).toBe(boundary.activityInterval.id);
    expect(repeatedBoundary.session.lastActivityAt).toStrictEqual(
      new Date('2026-06-23T01:45:01.000Z'),
    );

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(intervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
    expect(intervals[0]).toMatchObject({
      endedAt: new Date('2026-06-23T01:30:01.000Z'),
      settlementReason: 'idle_timeout',
    });

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(1);
    // ADR-0031: the record and its derived rows stay in the producing interval across an idle
    // boundary; the freshly opened interval is empty until new content arrives.
    expect(records[0]).toMatchObject({
      activityIntervalId: first.activityInterval.id,
      id: first.rawSessionRecord.id,
      isActive: true,
    });
  });

  test('handles concurrent duplicate clear-context imports as one new active Activity Interval', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const db = service;
    const workspaceId = await createBoundWorkspace('raw-import-concurrent-clear');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: 'codex-concurrent-clear-session',
      host: {
        id: 'host-concurrent-clear-base',
      },
      locator: '/tmp/codex-concurrent-clear.jsonl',
      workspaceId,
    } as const;
    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T22:00:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T22:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-concurrent-clear-session',
            },
          },
          {
            timestamp: '2026-06-22T22:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Before concurrent clear.' }],
            },
          },
        ]),
      }),
    );
    const clearInput = {
      ...baseInput,
      activity: {
        hookEventName: 'SessionStart',
        sessionStartSource: 'clear',
      },
      capturedAt: '2026-06-22T22:05:01.000Z',
      rawContent: codexTranscript([
        {
          timestamp: '2026-06-22T22:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'codex-concurrent-clear-session',
          },
        },
        {
          timestamp: '2026-06-22T22:05:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'After concurrent clear.' }],
          },
        },
      ]),
    } as const;
    const clearInputs = Array.from({ length: 8 }, () => clearInput);

    const results = await runWithLockedActivityInterval(
      first.activityInterval.id,
      clearInputs.length,
      () =>
        Promise.all(
          clearInputs.map((callerInput) =>
            Effect.runPromise(importRawSessionRecord(db, callerInput)),
          ),
        ),
    );
    const [clearResult] = results;
    if (clearResult === undefined) {
      throw new Error('concurrent clear imports returned no results');
    }

    expect(results.filter((result) => result.operation === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result.operation === 'unchanged')).toHaveLength(
      clearInputs.length - 1,
    );
    expect(new Set(results.map((result) => result.session.id))).toStrictEqual(
      new Set([first.session.id]),
    );
    expect(new Set(results.map((result) => result.rawSessionRecord.id))).toStrictEqual(
      new Set([clearResult.rawSessionRecord.id]),
    );
    expect(new Set(results.map((result) => result.activityInterval.id))).toStrictEqual(
      new Set([clearResult.activityInterval.id]),
    );
    expect(clearResult.activityInterval.id).not.toBe(first.activityInterval.id);
    expect(clearResult.activityInterval.ordinal).toBe(1);

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(intervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
    expect(intervals[0]).toMatchObject({
      settlementReason: 'clear_context',
    });

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id))
      .orderBy(asc(rawSessionRecords.snapshotOrdinal));
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isActive).map((record) => record.id)).toStrictEqual([
      clearResult.rawSessionRecord.id,
    ]);
  });

  test('handles concurrent duplicate idle-boundary imports as one new active Activity Interval', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const db = service;
    const workspaceId = await createBoundWorkspace('raw-import-concurrent-idle');
    const baseInput = {
      author: {
        handle: 'drew',
      },
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: 'codex-concurrent-idle-session',
      host: {
        id: 'host-concurrent-idle-base',
      },
      locator: '/tmp/codex-concurrent-idle.jsonl',
      workspaceId,
    } as const;
    const first = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...baseInput,
        capturedAt: '2026-06-22T23:00:01.000Z',
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-22T23:00:00.000Z',
            type: 'session_meta',
            payload: {
              id: 'codex-concurrent-idle-session',
            },
          },
          {
            timestamp: '2026-06-22T23:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Before concurrent idle.' }],
            },
          },
        ]),
      }),
    );
    const idleInput = {
      ...baseInput,
      capturedAt: '2026-06-22T23:45:01.000Z',
      rawContent: codexTranscript([
        {
          timestamp: '2026-06-22T23:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'codex-concurrent-idle-session',
          },
        },
        {
          timestamp: '2026-06-22T23:45:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'After concurrent idle.' }],
          },
        },
      ]),
    } as const;
    const idleInputs = Array.from({ length: 8 }, () => idleInput);

    const results = await runWithLockedActivityInterval(
      first.activityInterval.id,
      idleInputs.length,
      () =>
        Promise.all(
          idleInputs.map((callerInput) =>
            Effect.runPromise(importRawSessionRecord(db, callerInput)),
          ),
        ),
    );
    const [idleResult] = results;
    if (idleResult === undefined) {
      throw new Error('concurrent idle imports returned no results');
    }

    expect(results.filter((result) => result.operation === 'inserted')).toHaveLength(1);
    expect(results.filter((result) => result.operation === 'unchanged')).toHaveLength(
      idleInputs.length - 1,
    );
    expect(new Set(results.map((result) => result.session.id))).toStrictEqual(
      new Set([first.session.id]),
    );
    expect(new Set(results.map((result) => result.rawSessionRecord.id))).toStrictEqual(
      new Set([idleResult.rawSessionRecord.id]),
    );
    expect(new Set(results.map((result) => result.activityInterval.id))).toStrictEqual(
      new Set([idleResult.activityInterval.id]),
    );
    expect(idleResult.activityInterval.id).not.toBe(first.activityInterval.id);
    expect(idleResult.activityInterval.ordinal).toBe(1);

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(intervals.map((interval) => interval.status)).toStrictEqual(['settled', 'active']);
    expect(intervals[0]).toMatchObject({
      endedAt: new Date('2026-06-22T23:30:01.000Z'),
      settlementReason: 'idle_timeout',
    });

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id))
      .orderBy(asc(rawSessionRecords.snapshotOrdinal));
    expect(records).toHaveLength(2);
    expect(records.filter((record) => record.isActive).map((record) => record.id)).toStrictEqual([
      idleResult.rawSessionRecord.id,
    ]);
  });

  test('normalizes Codex transcript JSONL into session metadata, turns, parts, and spans', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-normalize');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:00:00.000Z',
        type: 'session_meta',
        payload: {
          agent_role: 'subagent',
          cli_version: '0.42.0-test',
          cwd: '/work/saga',
          id: 'codex-transcript-session-1',
          model_provider: 'openai',
          parent_thread_id: 'parent-thread-1',
          source: {
            subagent: {
              thread_spawn: {
                parent_turn_id: 'parent-turn-1',
              },
            },
          },
          thread_source: 'subagent',
        },
      },
      {
        timestamp: '2026-06-22T14:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
        },
      },
      {
        timestamp: '2026-06-22T14:00:02.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-1',
        },
      },
      {
        timestamp: '2026-06-22T14:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Normalize Codex transcripts.' }],
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'msg-assistant-1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will parse JSONL into structured turns.' }],
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call-1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Add File: note.md\n+tests passed\n*** End Patch\n',
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:06.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-1',
          output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated files\n',
        },
      },
      {
        timestamp: '2026-06-22T14:00:07.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-2',
          name: 'web.run',
          arguments: '{"open":[{"ref_id":"turn0search0"}]}',
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:08.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-2',
          output: [
            { type: 'text', text: 'Structured array output needle' },
            { type: 'image', image_url: 'file:///tmp/codex-output.png' },
          ],
        },
      },
      {
        timestamp: '2026-06-22T14:00:09.000Z',
        type: 'response_item',
        payload: {
          type: 'web_search_call',
          id: 'ws-call-1',
          status: 'completed',
          action: {
            type: 'search',
            query: 'SGA-121 Codex web_search_call fixture',
          },
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:10.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_call',
          id: 'ts-call-1',
          status: 'completed',
          arguments: JSON.stringify({
            query: 'tool search normalization fixture',
          }),
          execution: {
            duration_ms: 37,
            status: 'completed',
          },
          tools: [
            {
              description: 'Searches deferred tool metadata',
              name: 'tool_search_tool',
            },
          ],
          metadata: { turn_id: 'turn-1' },
        },
      },
      {
        timestamp: '2026-06-22T14:00:11.000Z',
        type: 'response_item',
        payload: {
          type: 'tool_search_output',
          call_id: 'ts-call-1',
          status: 'completed',
          execution: {
            status: 'completed',
          },
          tools: [
            {
              name: 'functions.exec_command',
              recipient_name: 'functions.exec_command',
            },
          ],
          output: {
            matches: [
              {
                name: 'functions.exec_command',
                text: 'Runs a command in a PTY',
              },
            ],
          },
        },
      },
    ]);

    const normalized = normalizeCodexTranscript({
      contentType: 'jsonl',
      rawContent,
    });
    expect(normalized?.turns[5]?.searchText).toContain('Structured array output needle');
    expect(normalized?.turns[5]?.searchText).toContain('codex-output.png');
    expect(normalized?.turns[6]?.searchText).toContain('SGA-121 Codex web_search_call fixture');
    expect(normalized?.turns[7]?.searchText).toContain('tool search normalization fixture');
    expect(normalized?.turns[7]?.searchText).toContain('tool_search_tool');
    expect(normalized?.turns[8]?.searchText).toContain('functions.exec_command');
    expect(normalized?.turns[8]?.searchText).toContain('Runs a command in a PTY');

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          displayName: 'Drew',
          handle: 'drew',
        },
        capturedAt: '2026-06-22T14:00:10.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-codex-normalize',
          label: 'local-host',
          projectRoot: '/work/saga',
        },
        locator: '/tmp/codex-transcript-session-1.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.operation).toBe('inserted');
    expect(result.session.harnessSessionId).toBe('codex-transcript-session-1');
    expect(result.session).toMatchObject({
      lastActivityAt: new Date('2026-06-22T14:00:11.000Z'),
      model: 'gpt-5-codex',
      startedAt: new Date('2026-06-22T14:00:03.000Z'),
    });
    expect(result.session.metadata).toMatchObject({
      cliVersion: '0.42.0-test',
      cwd: '/work/saga',
      detectedHarnessSessionId: 'codex-transcript-session-1',
      normalizer: 'codex-transcript-v1',
      turnCount: 9,
    });
    expect(result.activityInterval.startedAt).toStrictEqual(new Date('2026-06-22T14:00:03.000Z'));
    expect(result.activityInterval.metadata).toMatchObject({
      cwd: '/work/saga',
      normalizer: 'codex-transcript-v1',
      parseErrors: [],
    });

    const [session] = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.session.id))
      .limit(1);
    expect(session).toMatchObject({
      harness: 'codex',
      harnessSessionId: 'codex-transcript-session-1',
      model: 'gpt-5-codex',
    });
    expect(session?.metadata).toMatchObject({
      cliVersion: '0.42.0-test',
      cwd: '/work/saga',
      detectedHarnessSessionId: 'codex-transcript-session-1',
      normalizer: 'codex-transcript-v1',
      subagentEvidence: [
        {
          agent_role: 'subagent',
          parent_thread_id: 'parent-thread-1',
          source_subagent_thread_spawn: {
            parent_turn_id: 'parent-turn-1',
          },
          sourceRecordType: 'session_meta',
          thread_source: 'subagent',
        },
      ],
      turnCount: 9,
    });

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.bodyJson).toStrictEqual(
      rawContent
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    );
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        cwd: '/work/saga',
        detectedHarnessSessionId: 'codex-transcript-session-1',
        normalizer: 'codex-transcript-v1',
        subagentEvidence: [
          {
            agent_role: 'subagent',
            parent_thread_id: 'parent-thread-1',
            sourceRecordType: 'session_meta',
            thread_source: 'subagent',
          },
        ],
        turnCount: 9,
      },
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.role)).toStrictEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
      'tool',
    ]);
    expect(turns[0]).toMatchObject({
      actorKind: 'host_user',
      harnessTurnId: 'turn-1:user:3',
      model: 'gpt-5-codex',
      rawSpan: {
        lineStart: 3,
        lineEnd: 3,
      },
    });
    expect(turns[0]?.metadata).toMatchObject({
      codexTurnId: 'turn-1',
      cwd: '/work/saga',
      normalizer: 'codex-transcript-v1',
    });
    expect(turns[0]?.contentParts).toStrictEqual([
      { type: 'text', text: 'Normalize Codex transcripts.' },
    ]);
    expect(turns[1]?.harnessTurnId).toBe('msg-assistant-1');
    expect(turns[2]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'apply_patch',
        callId: 'call-1',
        input: '*** Begin Patch\n*** Add File: note.md\n+tests passed\n*** End Patch\n',
        status: 'completed',
      },
    ]);
    expect(turns[3]?.contentParts).toStrictEqual([
      {
        type: 'tool_result',
        name: 'apply_patch',
        callId: 'call-1',
        output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated files\n',
      },
    ]);
    expect(turns[4]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'web.run',
        callId: 'call-2',
        arguments: { open: [{ ref_id: 'turn0search0' }] },
        status: 'completed',
      },
    ]);
    expect(turns[5]?.contentParts).toStrictEqual([
      {
        type: 'tool_result',
        name: 'web.run',
        callId: 'call-2',
        output: [
          { type: 'text', text: 'Structured array output needle' },
          { type: 'image', image_url: 'file:///tmp/codex-output.png' },
        ],
      },
    ]);
    expect(turns[6]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'web_search',
        callId: 'ws-call-1',
        status: 'completed',
        action: {
          type: 'search',
          query: 'SGA-121 Codex web_search_call fixture',
        },
      },
    ]);
    expect(turns[6]?.metadata).toMatchObject({
      sourcePayloadType: 'web_search_call',
      sourceRecordType: 'response_item',
    });
    expect(turns[7]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'tool_search',
        callId: 'ts-call-1',
        arguments: {
          query: 'tool search normalization fixture',
        },
        execution: {
          duration_ms: 37,
          status: 'completed',
        },
        status: 'completed',
        tools: [
          {
            description: 'Searches deferred tool metadata',
            name: 'tool_search_tool',
          },
        ],
      },
    ]);
    expect(turns[7]?.metadata).toMatchObject({
      sourcePayloadType: 'tool_search_call',
      sourceRecordType: 'response_item',
    });
    expect(turns[8]?.contentParts).toStrictEqual([
      {
        type: 'tool_result',
        name: 'tool_search',
        callId: 'ts-call-1',
        output: {
          matches: [
            {
              name: 'functions.exec_command',
              text: 'Runs a command in a PTY',
            },
          ],
        },
        execution: {
          status: 'completed',
        },
        status: 'completed',
        tools: [
          {
            name: 'functions.exec_command',
            recipient_name: 'functions.exec_command',
          },
        ],
      },
    ]);
    expect(turns[8]?.metadata).toMatchObject({
      sourcePayloadType: 'tool_search_output',
      sourceRecordType: 'response_item',
    });

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(9);
    expect(segments.map((segment) => segment.segmentKind)).toStrictEqual([
      'turn',
      'turn',
      'tool_group_call',
      'tool_group_result',
      'tool_group_call',
      'tool_group_result',
      'turn',
      'tool_group_call',
      'tool_group_result',
    ]);
    expect(segments[2]?.searchText).toContain('apply_patch');
    expect(segments[3]?.searchText).toContain('Success. Updated files');
    expect(segments[4]?.searchText).toContain('web.run');
    expect(segments[5]?.searchText).toContain('Structured array output needle');
    expect(segments[7]?.searchText).toContain('tool_search');
    expect(segments[8]?.searchText).toContain('Runs a command in a PTY');
    expect(segments[2]?.turnId).toBe(turns[2]?.id);
    expect(segments[3]?.turnId).toBe(turns[3]?.id);
    expect(segments[2]?.metadata).toMatchObject({
      contentPartTypes: ['tool_call'],
      groupedContentPartTypes: [['tool_call'], ['tool_result']],
      groupedTurnIds: [turns[2]?.id, turns[3]?.id],
      normalizer: 'session-segments-v1',
      role: 'tool',
      toolGroup: {
        callId: 'call-1',
        memberCount: 2,
        memberIndex: 0,
        turnIds: [turns[2]?.id, turns[3]?.id],
      },
    });
    expect(segments[3]?.metadata).toMatchObject({
      contentPartTypes: ['tool_result'],
      groupedTurnIds: [turns[2]?.id, turns[3]?.id],
      segmentTurnId: turns[3]?.id,
      toolGroup: {
        callId: 'call-1',
        memberIndex: 1,
      },
    });

    const resultTurnSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.turnId, turns[5]?.id ?? '00000000-0000-0000-0000-000000000000'));
    expect(resultTurnSegments).toHaveLength(1);
    expect(resultTurnSegments[0]?.searchText).toContain('Structured array output needle');
  });

  test('groups interleaved tool call and result segments by call id', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-interleaved-tool-segments');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-interleaved-tool-segment-session',
        },
      },
      {
        timestamp: '2026-06-22T14:10:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-interleaved-tools',
        },
      },
      {
        timestamp: '2026-06-22T14:10:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-a',
          name: 'shell',
          arguments: JSON.stringify({ command: 'printf alpha-call' }),
          metadata: { turn_id: 'turn-interleaved-tools' },
        },
      },
      {
        timestamp: '2026-06-22T14:10:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-b',
          name: 'shell',
          arguments: JSON.stringify({ command: 'printf beta-call' }),
          metadata: { turn_id: 'turn-interleaved-tools' },
        },
      },
      {
        timestamp: '2026-06-22T14:10:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-a',
          output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nALPHA_RESULT_NEEDLE\n',
        },
      },
      {
        timestamp: '2026-06-22T14:10:05.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-b',
          output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nBETA_RESULT_NEEDLE\n',
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T14:10:06.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-codex-interleaved-tool-segments',
          projectRoot: '/work/saga',
        },
        locator: '/tmp/codex-interleaved-tool-segments.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(turns.map((turn) => turn.contentParts)).toStrictEqual([
      [
        {
          type: 'tool_call',
          name: 'shell',
          callId: 'call-a',
          arguments: { command: 'printf alpha-call' },
          status: 'completed',
        },
      ],
      [
        {
          type: 'tool_call',
          name: 'shell',
          callId: 'call-b',
          arguments: { command: 'printf beta-call' },
          status: 'completed',
        },
      ],
      [
        {
          type: 'tool_result',
          name: 'shell',
          callId: 'call-a',
          output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nALPHA_RESULT_NEEDLE\n',
        },
      ],
      [
        {
          type: 'tool_result',
          name: 'shell',
          callId: 'call-b',
          output: 'Exit code: 0\nWall time: 0 seconds\nOutput:\nBETA_RESULT_NEEDLE\n',
        },
      ],
    ]);
    expect(segments).toHaveLength(4);
    expect(segments.map((segment) => segment.ordinal)).toStrictEqual([0, 1, 2, 3]);
    expect(segments.map((segment) => segment.segmentKind)).toStrictEqual([
      'tool_group_call',
      'tool_group_call',
      'tool_group_result',
      'tool_group_result',
    ]);
    expect(segments.map((segment) => segment.turnId)).toStrictEqual(turns.map((turn) => turn.id));
    expect(segments[0]?.searchText).toContain('printf alpha-call');
    expect(segments[1]?.searchText).toContain('printf beta-call');
    expect(segments[2]?.searchText).toContain('ALPHA_RESULT_NEEDLE');
    expect(segments[3]?.searchText).toContain('BETA_RESULT_NEEDLE');

    expect(segments[0]?.metadata).toMatchObject({
      groupedContentPartTypes: [['tool_call'], ['tool_result']],
      groupedTurnIds: [turns[0]?.id, turns[2]?.id],
      groupedTurnOrdinals: [0, 2],
      toolGroup: {
        callId: 'call-a',
        memberCount: 2,
        memberIndex: 0,
        turnIds: [turns[0]?.id, turns[2]?.id],
        turnOrdinals: [0, 2],
      },
    });
    expect(segments[1]?.metadata).toMatchObject({
      groupedContentPartTypes: [['tool_call'], ['tool_result']],
      groupedTurnIds: [turns[1]?.id, turns[3]?.id],
      groupedTurnOrdinals: [1, 3],
      toolGroup: {
        callId: 'call-b',
        memberIndex: 0,
        turnIds: [turns[1]?.id, turns[3]?.id],
        turnOrdinals: [1, 3],
      },
    });
    expect(segments[2]?.metadata).toMatchObject({
      segmentTurnId: turns[2]?.id,
      toolGroup: {
        callId: 'call-a',
        memberIndex: 1,
      },
    });
    expect(segments[3]?.metadata).toMatchObject({
      segmentTurnId: turns[3]?.id,
      toolGroup: {
        callId: 'call-b',
        memberIndex: 1,
      },
    });

    const alphaSegments = segments.filter((segment) =>
      segment.searchText.includes('ALPHA_RESULT_NEEDLE'),
    );
    const betaSegments = segments.filter((segment) =>
      segment.searchText.includes('BETA_RESULT_NEEDLE'),
    );
    expect(alphaSegments.map((segment) => segment.turnId)).toStrictEqual([turns[2]?.id]);
    expect(betaSegments.map((segment) => segment.turnId)).toStrictEqual([turns[3]?.id]);

    const callATurnSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.turnId, turns[0]?.id ?? '00000000-0000-0000-0000-000000000000'));
    expect(callATurnSegments).toHaveLength(1);
    expect(callATurnSegments[0]?.searchText).not.toContain('ALPHA_RESULT_NEEDLE');
  });

  test('derives Codex subagent child relationships when the parent session is present later', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-subagent-relationships');
    const childRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T15:00:00.000Z',
        type: 'session_meta',
        payload: {
          agent_role: 'subagent',
          cwd: '/work/saga',
          id: 'child-thread-1',
          parent_thread_id: 'parent-thread-1',
          source: {
            subagent: {
              thread_spawn: {
                parent_turn_id: 'parent-turn-1',
              },
            },
          },
          thread_source: 'subagent',
        },
      },
      {
        timestamp: '2026-06-22T15:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'child-turn-1' },
      },
      {
        timestamp: '2026-06-22T15:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Inspect a focused importer concern.' }],
          metadata: { turn_id: 'child-turn-1' },
        },
      },
    ]);
    const parentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:59:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'parent-thread-1',
        },
      },
      {
        timestamp: '2026-06-22T14:59:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-1' },
      },
      {
        timestamp: '2026-06-22T14:59:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate the importer inspection.' }],
          metadata: { turn_id: 'parent-turn-1' },
        },
      },
    ]);

    const child = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:00:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-1',
        host: { id: 'host-codex-relationships' },
        locator: '/tmp/child-thread-1.jsonl',
        rawContent: childRawContent,
        workspaceId,
      }),
    );

    let relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(0);

    const parent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:00:04.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parent-thread-1',
        host: { id: 'host-codex-relationships' },
        locator: '/tmp/parent-thread-1.jsonl',
        rawContent: parentRawContent,
        workspaceId,
      }),
    );

    const [parentTurn] = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, parent.session.id))
      .limit(1);
    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      confidence: 'explicit',
      relationshipType: 'child',
      sourceSessionId: parent.session.id,
      sourceTurnId: parentTurn?.id,
      targetSessionId: child.session.id,
    });
    expect(relationships[0]?.evidence).toMatchObject({
      agentRole: 'subagent',
      childHarnessSessionId: 'child-thread-1',
      derivation: 'session-relationship-import-v1',
      parentHarnessSessionId: 'parent-thread-1',
      parentThreadId: 'parent-thread-1',
      parentTurnId: 'parent-turn-1',
      threadSource: 'subagent',
    });

    const updatedParentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:59:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'parent-thread-1',
        },
      },
      {
        timestamp: '2026-06-22T14:59:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-1' },
      },
      {
        timestamp: '2026-06-22T14:59:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate the importer inspection again.' }],
          metadata: { turn_id: 'parent-turn-1' },
        },
      },
    ]);
    const updatedParent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:00:04.500Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parent-thread-1',
        host: { id: 'host-codex-relationships' },
        locator: '/tmp/parent-thread-1.jsonl',
        rawContent: updatedParentRawContent,
        workspaceId,
      }),
    );
    expect(updatedParent.operation).toBe('inserted');
    const [updatedParentTurn] = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, parent.session.id))
      .limit(1);
    const refreshedRelationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(refreshedRelationships).toHaveLength(1);
    expect(refreshedRelationships[0]).toMatchObject({
      id: relationships[0]?.id,
      sourceTurnId: updatedParentTurn?.id,
    });
    expect(refreshedRelationships[0]?.sourceTurnId).not.toBe(relationships[0]?.sourceTurnId);
    relationships = refreshedRelationships;

    const repeatedChild = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:00:05.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-1',
        host: { id: 'host-codex-relationships' },
        locator: '/tmp/child-thread-1.jsonl',
        rawContent: childRawContent,
        workspaceId,
      }),
    );
    expect(repeatedChild.operation).toBe('unchanged');
    const repeatedRelationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(repeatedRelationships.map((relationship) => relationship.id)).toStrictEqual([
      relationships[0]?.id,
    ]);
  });

  test('synchronizes Codex child relationships from current child evidence', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-relationship-sync');
    const host = { id: 'host-codex-relationship-sync' };
    const parentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T15:10:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'parent-thread-sync-1',
        },
      },
      {
        timestamp: '2026-06-22T15:10:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-sync-1' },
      },
      {
        timestamp: '2026-06-22T15:10:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate first importer inspection.' }],
          metadata: { turn_id: 'parent-turn-sync-1' },
        },
      },
      {
        timestamp: '2026-06-22T15:10:03.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-sync-2' },
      },
      {
        timestamp: '2026-06-22T15:10:04.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate second importer inspection.' }],
          metadata: { turn_id: 'parent-turn-sync-2' },
        },
      },
    ]);
    const secondParentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T15:11:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'parent-thread-sync-2',
        },
      },
      {
        timestamp: '2026-06-22T15:11:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-sync-3' },
      },
      {
        timestamp: '2026-06-22T15:11:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate alternate importer inspection.' }],
          metadata: { turn_id: 'parent-turn-sync-3' },
        },
      },
    ]);
    const childRawContent = (parentThreadId: string, parentTurnId: string, text: string) =>
      codexTranscript([
        {
          timestamp: '2026-06-22T15:12:00.000Z',
          type: 'session_meta',
          payload: {
            agent_role: 'subagent',
            cwd: '/work/saga',
            id: 'child-thread-sync',
            parent_thread_id: parentThreadId,
            source: {
              subagent: {
                thread_spawn: {
                  parent_turn_id: parentTurnId,
                },
              },
            },
            thread_source: 'subagent',
          },
        },
        {
          timestamp: '2026-06-22T15:12:01.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: `child-${parentTurnId}` },
        },
        {
          timestamp: '2026-06-22T15:12:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
            metadata: { turn_id: `child-${parentTurnId}` },
          },
        },
      ]);
    const noRelationshipChildRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T15:13:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'child-thread-sync',
        },
      },
      {
        timestamp: '2026-06-22T15:13:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'child-no-parent' },
      },
      {
        timestamp: '2026-06-22T15:13:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue without subagent evidence.' }],
          metadata: { turn_id: 'child-no-parent' },
        },
      },
    ]);

    const parent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:10:05.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parent-thread-sync-1',
        host,
        locator: '/tmp/parent-thread-sync-1.jsonl',
        rawContent: parentRawContent,
        workspaceId,
      }),
    );
    const secondParent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:11:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parent-thread-sync-2',
        host,
        locator: '/tmp/parent-thread-sync-2.jsonl',
        rawContent: secondParentRawContent,
        workspaceId,
      }),
    );
    const child = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:12:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-sync',
        host,
        locator: '/tmp/child-thread-sync.jsonl',
        rawContent: childRawContent(
          'parent-thread-sync-1',
          'parent-turn-sync-1',
          'Inspect the first delegated task.',
        ),
        workspaceId,
      }),
    );

    const parentTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, parent.session.id))
      .orderBy(asc(sessionTurns.ordinal));
    // Closes over the local `typeof parentTurns` row type; hoisting would force
    // re-declaring that query-derived type at module scope.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const matchesCodexTurn = (turn: (typeof parentTurns)[number], turnId: string) =>
      turn.harnessTurnId === turnId || turn.metadata.codexTurnId === turnId;
    const firstParentTurn = parentTurns.find((turn) =>
      matchesCodexTurn(turn, 'parent-turn-sync-1'),
    );
    const secondParentTurn = parentTurns.find((turn) =>
      matchesCodexTurn(turn, 'parent-turn-sync-2'),
    );
    const [thirdParentTurn] = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, secondParent.session.id))
      .limit(1);

    let relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      sourceSessionId: parent.session.id,
      sourceTurnId: firstParentTurn?.id,
    });
    expect(relationships[0]?.evidence).toMatchObject({
      parentHarnessSessionId: 'parent-thread-sync-1',
      parentTurnId: 'parent-turn-sync-1',
    });
    const firstRelationshipId = relationships[0]?.id;

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:12:04.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-sync',
        host,
        locator: '/tmp/child-thread-sync.jsonl',
        rawContent: childRawContent(
          'parent-thread-sync-1',
          'parent-turn-sync-2',
          'Inspect the updated delegated task.',
        ),
        workspaceId,
      }),
    );
    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      id: firstRelationshipId,
      sourceSessionId: parent.session.id,
      sourceTurnId: secondParentTurn?.id,
    });
    expect(relationships[0]?.evidence).toMatchObject({
      parentHarnessSessionId: 'parent-thread-sync-1',
      parentTurnId: 'parent-turn-sync-2',
    });

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:12:05.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-sync',
        host,
        locator: '/tmp/child-thread-sync.jsonl',
        rawContent: childRawContent(
          'parent-thread-sync-2',
          'parent-turn-sync-3',
          'Inspect the alternate delegated task.',
        ),
        workspaceId,
      }),
    );
    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      sourceSessionId: secondParent.session.id,
      sourceTurnId: thirdParentTurn?.id,
    });
    expect(relationships[0]?.id).not.toBe(firstRelationshipId);
    expect(relationships[0]?.evidence).toMatchObject({
      parentHarnessSessionId: 'parent-thread-sync-2',
      parentTurnId: 'parent-turn-sync-3',
    });
    const secondRelationshipId = relationships[0]?.id;

    const [inferredRelationship] = await service.db
      .insert(sessionRelationships)
      .values({
        confidence: 'inferred',
        evidence: {
          note: 'manual inference without import derivation',
        },
        relationshipType: 'child',
        sourceSessionId: parent.session.id,
        targetSessionId: child.session.id,
        workspaceId,
      })
      .returning();
    expect(inferredRelationship).toBeDefined();
    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(2);

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:13:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-sync',
        host,
        locator: '/tmp/child-thread-sync.jsonl',
        rawContent: noRelationshipChildRawContent,
        workspaceId,
      }),
    );
    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      confidence: 'inferred',
      id: inferredRelationship?.id,
      sourceSessionId: parent.session.id,
      targetSessionId: child.session.id,
    });
    expect(relationships[0]?.id).not.toBe(secondRelationshipId);
    expect(relationships[0]?.evidence).toStrictEqual({
      note: 'manual inference without import derivation',
    });
  });

  test('does not overwrite same-key non-derived child relationships during import sync', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-relationship-same-key-manual');
    const host = { id: 'host-codex-relationship-same-key-manual' };
    const parentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T15:20:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'parent-thread-same-key',
        },
      },
      {
        timestamp: '2026-06-22T15:20:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'parent-turn-same-key' },
      },
      {
        timestamp: '2026-06-22T15:20:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Delegate same-key importer inspection.' }],
          metadata: { turn_id: 'parent-turn-same-key' },
        },
      },
    ]);
    const childRawContent = (includeParentEvidence: boolean) =>
      codexTranscript([
        {
          timestamp: '2026-06-22T15:21:00.000Z',
          type: 'session_meta',
          payload: {
            ...(includeParentEvidence
              ? {
                  agent_role: 'subagent',
                  parent_thread_id: 'parent-thread-same-key',
                  source: {
                    subagent: {
                      thread_spawn: {
                        parent_turn_id: 'parent-turn-same-key',
                      },
                    },
                  },
                  thread_source: 'subagent',
                }
              : {}),
            cwd: '/work/saga',
            id: 'child-thread-same-key',
          },
        },
        {
          timestamp: '2026-06-22T15:21:01.000Z',
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'child-turn-same-key' },
        },
        {
          timestamp: '2026-06-22T15:21:02.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Inspect the same-key delegated task.' }],
            metadata: { turn_id: 'child-turn-same-key' },
          },
        },
      ]);

    const parent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:20:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parent-thread-same-key',
        host,
        locator: '/tmp/parent-thread-same-key.jsonl',
        rawContent: parentRawContent,
        workspaceId,
      }),
    );
    const child = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:21:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-same-key',
        host,
        locator: '/tmp/child-thread-same-key.jsonl',
        rawContent: childRawContent(false),
        workspaceId,
      }),
    );

    const [manualRelationship] = await service.db
      .insert(sessionRelationships)
      .values({
        confidence: 'inferred',
        evidence: {
          note: 'same-key manual inference',
        },
        relationshipType: 'child',
        sourceSessionId: parent.session.id,
        targetSessionId: child.session.id,
        workspaceId,
      })
      .returning();
    expect(manualRelationship).toBeDefined();

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:21:04.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-same-key',
        host,
        locator: '/tmp/child-thread-same-key.jsonl',
        rawContent: childRawContent(true),
        workspaceId,
      }),
    );

    let relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      confidence: 'inferred',
      id: manualRelationship?.id,
      sourceSessionId: parent.session.id,
      sourceTurnId: null,
      targetSessionId: child.session.id,
    });
    expect(relationships[0]?.evidence).toStrictEqual({
      note: 'same-key manual inference',
    });

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T15:21:05.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'child-thread-same-key',
        host,
        locator: '/tmp/child-thread-same-key.jsonl',
        rawContent: childRawContent(false),
        workspaceId,
      }),
    );

    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.targetSessionId, child.session.id));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      confidence: 'inferred',
      id: manualRelationship?.id,
      sourceSessionId: parent.session.id,
      sourceTurnId: null,
      targetSessionId: child.session.id,
    });
    expect(relationships[0]?.evidence).toStrictEqual({
      note: 'same-key manual inference',
    });
  });

  test('normalizes Claude transcript JSONL into session metadata, turns, parts, and spans', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('claude-normalize');
    const rawContent = claudeTranscript([
      {
        type: 'mode',
        mode: 'default',
        sessionId: 'claude-transcript-session-1',
      },
      {
        parentUuid: null,
        isSidechain: false,
        promptId: 'prompt-1',
        type: 'user',
        message: {
          role: 'user',
          content: 'Normalize Claude transcripts.',
        },
        uuid: 'user-1',
        timestamp: '2026-06-22T16:00:00.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-transcript-session-1',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        parentUuid: 'user-1',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'I will parse Claude JSONL.' }],
          stop_reason: 'tool_use',
          usage: {
            input_tokens: 10,
            output_tokens: 7,
          },
        },
        requestId: 'req-1',
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-06-22T16:00:01.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-transcript-session-1',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        parentUuid: 'assistant-1',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg-1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-bash-1',
              name: 'Bash',
              attributionMcpServer: 'claude-bash-mcp',
              attributionMcpTool: 'run_command',
              input: {
                command: 'pnpm test -- --run',
              },
              toolUseID: 'legacy-toolu-bash-1',
            },
          ],
          stop_reason: 'tool_use',
        },
        requestId: 'req-1',
        type: 'assistant',
        uuid: 'assistant-2',
        timestamp: '2026-06-22T16:00:02.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-transcript-session-1',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        parentUuid: 'assistant-2',
        isSidechain: false,
        promptId: 'prompt-2',
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu-bash-1',
              attributionMcpServer: 'claude-bash-mcp',
              attributionMcpTool: 'run_command',
              content: 'tests passed',
              is_error: false,
              toolUseID: 'legacy-toolu-bash-1',
              toolUseResult: {
                outputBytes: 12,
              },
            },
          ],
        },
        uuid: 'tool-result-1',
        timestamp: '2026-06-22T16:00:03.000Z',
        toolUseResult: {
          success: true,
        },
        sourceToolAssistantUUID: 'assistant-2',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-transcript-session-1',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        parentUuid: 'tool-result-1',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg-2',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-agent-1',
              name: 'Agent',
              caller: 'agent-caller-1',
              input: {
                description: 'Inspect related code',
                prompt: 'Summarize the importer extension point.',
              },
            },
          ],
          stop_reason: 'tool_use',
        },
        requestId: 'req-2',
        type: 'assistant',
        uuid: 'assistant-agent-1',
        timestamp: '2026-06-22T16:00:04.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-transcript-session-1',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        type: 'ai-title',
        aiTitle: 'Claude normalization fixture',
        sessionId: 'claude-transcript-session-1',
      },
    ]);

    const normalized = normalizeClaudeTranscript({
      contentType: 'jsonl',
      rawContent,
      sourceLocator: '/tmp/claude-transcript-session-1.jsonl',
    });
    expect(normalized?.turns.map((turn) => turn.role)).toStrictEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'subagent',
    ]);
    expect(normalized?.turns[2]?.searchText).toContain('pnpm test');
    expect(normalized?.turns[3]?.searchText).toContain('tests passed');

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          displayName: 'Drew',
          handle: 'drew',
        },
        capturedAt: '2026-06-22T16:00:05.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        host: {
          id: 'host-claude-normalize',
          label: 'local-host',
          projectRoot: '/work/saga',
        },
        locator: '/tmp/claude-transcript-session-1.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.operation).toBe('inserted');
    expect(result.session.harnessSessionId).toBe('claude-transcript-session-1');
    expect(result.session).toMatchObject({
      lastActivityAt: new Date('2026-06-22T16:00:04.000Z'),
      model: 'claude-sonnet-4-5',
      startedAt: new Date('2026-06-22T16:00:00.000Z'),
      title: 'Claude normalization fixture',
    });
    expect(result.session.metadata).toMatchObject({
      cwd: '/work/saga',
      detectedHarnessSessionId: 'claude-transcript-session-1',
      normalizer: 'claude-transcript-v1',
      turnCount: 5,
      version: '2.1.160',
    });
    expect(result.session.metadata).toMatchObject({
      subagentEvidence: [
        {
          sourceRecordType: 'assistant',
          toolUseId: 'toolu-agent-1',
          toolInput: {
            description: 'Inspect related code',
            prompt: 'Summarize the importer extension point.',
          },
        },
      ],
    });
    expect(result.activityInterval.startedAt).toStrictEqual(new Date('2026-06-22T16:00:00.000Z'));
    expect(result.activityInterval.metadata).toMatchObject({
      cwd: '/work/saga',
      lifecycleEvents: [
        {
          mode: 'default',
          type: 'mode',
        },
        {
          aiTitle: 'Claude normalization fixture',
          type: 'ai-title',
        },
      ],
      normalizer: 'claude-transcript-v1',
      parseErrors: [],
    });

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        cwd: '/work/saga',
        detectedHarnessSessionId: 'claude-transcript-session-1',
        normalizer: 'claude-transcript-v1',
        turnCount: 5,
      },
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.role)).toStrictEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'subagent',
    ]);
    expect(turns[0]).toMatchObject({
      actorKind: 'host_user',
      harnessTurnId: 'user-1:user',
      rawSpan: {
        lineStart: 1,
        lineEnd: 1,
      },
    });
    expect(turns[0]?.metadata).toMatchObject({
      cwd: '/work/saga',
      normalizer: 'claude-transcript-v1',
      promptId: 'prompt-1',
      sessionId: 'claude-transcript-session-1',
      uuid: 'user-1',
    });
    expect(turns[0]?.contentParts).toStrictEqual([
      { type: 'text', text: 'Normalize Claude transcripts.' },
    ]);
    expect(turns[2]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'Bash',
        callId: 'toolu-bash-1',
        attributionMcpServer: 'claude-bash-mcp',
        attributionMcpTool: 'run_command',
        input: {
          command: 'pnpm test -- --run',
        },
        toolUseID: 'legacy-toolu-bash-1',
      },
    ]);
    expect(turns[3]).toMatchObject({
      actorKind: 'tool',
      actorLabel: 'Bash',
      harnessTurnId: 'toolu-bash-1:result',
    });
    expect(turns[3]?.contentParts).toStrictEqual([
      {
        type: 'tool_result',
        name: 'Bash',
        callId: 'toolu-bash-1',
        attributionMcpServer: 'claude-bash-mcp',
        attributionMcpTool: 'run_command',
        isError: false,
        output: 'tests passed',
        toolUseID: 'legacy-toolu-bash-1',
        toolUseResult: {
          outputBytes: 12,
        },
      },
    ]);
    expect(turns[3]?.metadata).toMatchObject({
      toolUseResult: {
        success: true,
      },
    });
    expect(turns[4]).toMatchObject({
      actorKind: 'subagent',
      actorLabel: 'Agent',
      harnessTurnId: 'toolu-agent-1',
    });
    expect(turns[4]?.contentParts).toStrictEqual([
      {
        type: 'tool_call',
        name: 'Agent',
        callId: 'toolu-agent-1',
        caller: 'agent-caller-1',
        input: {
          description: 'Inspect related code',
          prompt: 'Summarize the importer extension point.',
        },
      },
    ]);

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(segments).toHaveLength(5);
    expect(segments.map((segment) => segment.segmentKind)).toStrictEqual([
      'turn',
      'turn',
      'tool_group_call',
      'tool_group_result',
      'turn',
    ]);
    expect(segments[2]?.searchText).toContain('Bash');
    expect(segments[2]?.searchText).toContain('pnpm test -- --run');
    expect(segments[3]?.searchText).toContain('tests passed');
  });

  test('splits large turns into overlapping positioned lexical segments', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('segment-large-turn');
    const longText = Array.from({ length: 2500 }, (_, index) => `token${index}`).join(' ');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-large-segment-session',
        },
      },
      {
        timestamp: '2026-06-22T18:00:01.000Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5-codex',
          turn_id: 'turn-large',
        },
      },
      {
        timestamp: '2026-06-22T18:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: longText }],
          metadata: { turn_id: 'turn-large' },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T18:00:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-large-segment',
        },
        locator: '/tmp/codex-large-segment.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => segment.segmentKind === 'turn_chunk')).toBe(true);
    expect(segments.map((segment) => [segment.tokenStart, segment.tokenEnd])).toStrictEqual([
      [0, 917],
      [792, 1709],
      [1584, 2500],
    ]);
    expect((segments[0]?.tokenEnd ?? 0) - (segments[1]?.tokenStart ?? 0)).toBe(125);
    expect((segments[1]?.tokenEnd ?? 0) - (segments[2]?.tokenStart ?? 0)).toBe(125);
    expect(segments[0]?.searchText).toContain('token0');
    expect(segments[1]?.searchText).toContain('token792');
    expect(segments[2]?.searchText).toContain('token2499');
    expect(segments[0]?.metadata).toMatchObject({
      chunkCount: 3,
      chunkIndex: 0,
      normalizer: 'session-segments-v1',
      searchTextSpan: {
        charStart: 0,
        tokenStart: 0,
      },
      segmentRawSpan: {
        lineStart: 2,
        lineEnd: 2,
      },
      sourceRawSpans: [
        {
          lineStart: 2,
          lineEnd: 2,
        },
      ],
      sourceTurnSpans: [
        {
          turnOrdinal: 0,
          rawSpan: {
            lineStart: 2,
            lineEnd: 2,
          },
        },
      ],
    });
    const metadata = segments[0]?.metadata as {
      segmentRawSpan?: { charEnd?: number; charStart?: number };
      sourceRawSpans?: { charEnd?: number; charStart?: number }[];
    };
    expect(metadata.segmentRawSpan?.charStart).toBe(metadata.sourceRawSpans?.[0]?.charStart);
    expect(metadata.segmentRawSpan?.charEnd).toBeLessThanOrEqual(
      metadata.sourceRawSpans?.[0]?.charEnd ?? 0,
    );
  });

  test('redacts structured secrets from tool call and result object payloads', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('segment-structured-secret');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:05:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-structured-secret-session',
        },
      },
      {
        timestamp: '2026-06-22T18:05:01.000Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5-codex',
          turn_id: 'turn-structured-secret',
        },
      },
      {
        timestamp: '2026-06-22T18:05:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-secret',
          name: 'deploy',
          arguments: JSON.stringify({
            accessToken: 'access-token-structured-secret-value',
            api_key: 'api-key-structured-secret-value',
            target: 'staging',
          }),
          metadata: { turn_id: 'turn-structured-secret' },
        },
      },
      {
        timestamp: '2026-06-22T18:05:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-secret',
          output: {
            ok: true,
            password: 'password-structured-secret-value',
            url: 'https://example.test/deploy/123',
          },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T18:05:04.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-structured-secret-segment',
        },
        locator: '/tmp/codex-structured-secret-segment.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.segmentKind)).toStrictEqual([
      'tool_group_call',
      'tool_group_result',
    ]);
    expect(segments[0]?.turnId).toBe(turns[0]?.id);
    expect(segments[1]?.turnId).toBe(turns[1]?.id);
    expect(segments[0]?.searchText).toContain('deploy');
    expect(segments[0]?.searchText).toContain('staging');
    expect(segments[0]?.searchText).toContain('[REDACTED]');
    expect(segments[1]?.searchText).toContain('https://example.test/deploy/123');
    expect(segments[1]?.searchText).toContain('[REDACTED]');
    const indexedText = segments.map((segment) => segment.searchText).join('\n');
    expect(indexedText).not.toContain('access-token-structured-secret-value');
    expect(indexedText).not.toContain('api-key-structured-secret-value');
    expect(indexedText).not.toContain('password-structured-secret-value');
    expect(segments[0]?.metadata).toMatchObject({
      filters: [
        {
          reason: 'secret',
          type: 'tool_call',
        },
      ],
    });
    expect(segments[1]?.metadata).toMatchObject({
      filters: [
        {
          reason: 'secret',
          type: 'tool_result',
        },
      ],
    });
  });

  test('omits mixed skipped turn content parts from detail and recall expansion', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('segment-mixed-skipped-content');
    const safeText = 'Mixed safe searchable anchor context.';
    const omittedNeedle = 'sk-mixedskippedsecretneedle1234567890';
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:07:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-mixed-skipped-content-session',
        },
      },
      {
        timestamp: '2026-06-22T18:07:01.000Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5-codex',
          turn_id: 'turn-mixed-skipped-content',
        },
      },
      {
        timestamp: '2026-06-22T18:07:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: safeText },
            { type: 'input_text', text: `api_key=${omittedNeedle}` },
          ],
          metadata: { turn_id: 'turn-mixed-skipped-content' },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T18:07:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-mixed-skipped-content',
        },
        locator: '/tmp/codex-mixed-skipped-content.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(1);
    expect(segments[0]?.segmentKind).toBe('turn');
    expect(segments[0]?.searchText).toContain(safeText);
    expect(segments[0]?.searchText).not.toContain(omittedNeedle);
    expect(segments[0]?.metadata).toMatchObject({
      filters: [
        {
          reason: 'secret',
          type: 'text',
        },
      ],
      skippedPartCount: 1,
    });

    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: result.session.id,
        maxSegmentsPerTurn: 1,
        workspaceId,
      }),
    );
    const detailTurns = detail.activityIntervals.flatMap((interval) => interval.turns);
    const detailContent = JSON.stringify(detailTurns.map((turn) => turn.contentParts));
    expect(detailContent).toContain('skipped_segment_payload');
    expect(detailContent).toContain('secret');
    expect(detailContent).toContain('skippedPartCount');
    expect(detailContent).not.toContain(omittedNeedle);
    expect(JSON.stringify(detail.rawSessionRecords)).not.toContain(omittedNeedle);

    const anchorSegment = segments[0];
    if (anchorSegment === undefined) {
      throw new Error('expected a searchable anchor segment');
    }

    const expansion = await Effect.runPromise(
      expandRecallContext(service, {
        afterTurns: 0,
        beforeTurns: 0,
        segmentId: anchorSegment.id,
        workspaceId,
      }),
    );
    const expansionContent = JSON.stringify(expansion.turns.map((turn) => turn.contentParts));
    expect(expansionContent).toContain('skipped_segment_payload');
    expect(expansionContent).toContain('secret');
    expect(expansionContent).toContain('skippedPartCount');
    expect(expansionContent).not.toContain(omittedNeedle);
    expect(
      expansion.turns.flatMap((turn) => turn.segments).map((segment) => segment.searchText),
    ).toContain(safeText);

    const rawDetail = await Effect.runPromise(
      getSessionDetail(service, {
        id: result.session.id,
        includeRawBody: true,
        workspaceId,
      }),
    );
    expect(rawDetail.activeRawSessionRecord?.rawBodyExposure).toMatchObject({
      mode: 'raw_forensic',
      requestedBy: 'includeRawBody',
    });
    expect(rawDetail.activeRawSessionRecord?.rawBodyExposure?.warning).toContain(
      'normal Saga surfaces hide',
    );
    expect(rawDetail.activeRawSessionRecord?.bodyText).toContain(omittedNeedle);
    expect(JSON.stringify(rawDetail.activeRawSessionRecord?.bodyJson)).toContain(omittedNeedle);
  });

  test('filters low-signal and high-risk content from lexical segments', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('segment-filter');
    const hugeLog = Array.from(
      { length: 850 },
      (_, index) =>
        `2026-06-22T18:10:${String(index % 60).padStart(2, '0')}Z noisy log line ${index}`,
    ).join('\n');
    const base64Blob = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(30);
    const unboundedDiff = Array.from({ length: 260 }, (_, index) =>
      index % 2 === 0 ? `+added generated line ${index}` : `-removed generated line ${index}`,
    ).join('\n');
    const repeatedGenerated = [
      '// generated file - do not edit',
      ...Array.from({ length: 700 }, () => 'export const routeTree = routeTree;'),
    ].join('\n');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'codex-filter-session',
        },
      },
      {
        timestamp: '2026-06-22T18:10:01.000Z',
        type: 'turn_context',
        payload: {
          model: 'gpt-5-codex',
          turn_id: 'turn-filter',
        },
      },
      {
        timestamp: '2026-06-22T18:10:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Remember safe searchable context.' }],
          metadata: { turn_id: 'turn-filter' },
        },
      },
      {
        timestamp: '2026-06-22T18:10:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-log',
          name: 'shell',
          arguments: JSON.stringify({ command: 'cat build.log' }),
          metadata: { turn_id: 'turn-filter' },
        },
      },
      {
        timestamp: '2026-06-22T18:10:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-log',
          output: hugeLog,
        },
      },
      {
        timestamp: '2026-06-22T18:10:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'api_key=sk-supersecretfixturevalue123456789' }],
          metadata: { turn_id: 'turn-filter' },
        },
      },
      {
        timestamp: '2026-06-22T18:10:06.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: base64Blob }],
          metadata: { turn_id: 'turn-filter' },
        },
      },
      {
        timestamp: '2026-06-22T18:10:07.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'diff-message',
          content: [{ type: 'output_text', text: unboundedDiff }],
          metadata: { turn_id: 'turn-filter' },
        },
      },
      {
        timestamp: '2026-06-22T18:10:08.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          id: 'generated-message',
          content: [{ type: 'output_text', text: repeatedGenerated }],
          metadata: { turn_id: 'turn-filter' },
        },
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T18:10:09.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-filter-segment',
        },
        locator: '/tmp/codex-filter-segment.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(segments).toHaveLength(7);
    expect(segments.map((segment) => segment.searchText)).toStrictEqual([
      'Remember safe searchable context.',
      'shell {"command":"cat build.log"} completed',
      '',
      '',
      '',
      '',
      '',
    ]);
    expect(segments.map((segment) => segment.segmentKind)).toStrictEqual([
      'turn',
      'tool_group_call',
      'tool_group_skipped',
      'turn_skipped',
      'turn_skipped',
      'turn_skipped',
      'turn_skipped',
    ]);
    expect(segments.slice(2).every((segment) => segment.snippet === null)).toBe(true);
    expect(segments.slice(2).every((segment) => segment.charStart === null)).toBe(true);
    expect(segments.slice(2).every((segment) => segment.tokenStart === null)).toBe(true);
    expect(segments.slice(2).map((segment) => segment.metadata)).toMatchObject([
      {
        contentPartTypes: ['tool_result'],
        filterReasons: ['huge_raw_log'],
        filters: [
          {
            reason: 'huge_raw_log',
            type: 'tool_result',
          },
        ],
        omittedSearchText: true,
        segmentStatus: 'skipped',
        skippedPartCount: 1,
        toolGroup: {
          filterReasons: ['huge_raw_log'],
          skippedPartCount: 1,
        },
      },
      {
        contentPartTypes: ['text'],
        filterReasons: ['secret'],
        omittedSearchText: true,
        segmentStatus: 'skipped',
        skippedPartCount: 1,
      },
      {
        contentPartTypes: ['text'],
        filterReasons: ['binary_or_base64'],
        omittedSearchText: true,
        segmentStatus: 'skipped',
        skippedPartCount: 1,
      },
      {
        contentPartTypes: ['text'],
        filterReasons: ['unbounded_diff'],
        omittedSearchText: true,
        segmentStatus: 'skipped',
        skippedPartCount: 1,
      },
      {
        contentPartTypes: ['text'],
        filterReasons: ['repeated_generated_file'],
        omittedSearchText: true,
        segmentStatus: 'skipped',
        skippedPartCount: 1,
      },
    ]);
    expect(segments.map((segment) => segment.searchText).join('\n')).not.toContain(
      'supersecretfixture',
    );
    expect(segments.map((segment) => segment.searchText).join('\n')).not.toContain(base64Blob);
    expect(segments.map((segment) => segment.searchText).join('\n')).not.toContain(
      'added generated line',
    );
    expect(segments.map((segment) => segment.searchText).join('\n')).not.toContain('routeTree');
    expect(JSON.stringify(segments.map((segment) => segment.metadata))).not.toContain(
      'supersecretfixture',
    );
    expect(JSON.stringify(segments.map((segment) => segment.metadata))).not.toContain(
      'added generated line',
    );
    expect(segments[1]?.metadata).toMatchObject({
      toolGroup: {
        filters: [
          {
            reason: 'huge_raw_log',
            type: 'tool_result',
          },
        ],
        skippedPartCount: 1,
      },
    });

    const omittedSecretRecall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'supersecretfixture',
        workspaceId,
      }),
    );
    expect(omittedSecretRecall.matchCount).toBe(0);

    const omittedLogRecall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'noisy log line 42',
        workspaceId,
      }),
    );
    expect(omittedLogRecall.matchCount).toBe(0);

    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: result.session.id,
        maxSegmentsPerTurn: 1,
        workspaceId,
      }),
    );
    const detailTurns = detail.activityIntervals.flatMap((interval) => interval.turns);
    const detailContent = JSON.stringify(detailTurns.map((turn) => turn.contentParts));
    expect(detailContent).toContain('skipped_segment_payload');
    expect(detailContent).toContain('huge_raw_log');
    expect(detailContent).toContain('secret');
    expect(detailContent).not.toContain('supersecretfixture');
    expect(detailContent).not.toContain(base64Blob);
    expect(detailContent).not.toContain('noisy log line 42');
    expect(detailContent).not.toContain('added generated line');
    expect(detailContent).not.toContain('routeTree');

    const anchorSegment = segments[0];
    if (anchorSegment === undefined) {
      throw new Error('expected a searchable anchor segment');
    }

    const expansion = await Effect.runPromise(
      expandRecallContext(service, {
        afterTurns: 20,
        beforeTurns: 0,
        segmentId: anchorSegment.id,
        workspaceId,
      }),
    );
    const expansionContent = JSON.stringify(expansion.turns.map((turn) => turn.contentParts));
    expect(expansionContent).toContain('skipped_segment_payload');
    expect(expansionContent).toContain('huge_raw_log');
    expect(expansionContent).toContain('secret');
    expect(expansionContent).not.toContain('supersecretfixture');
    expect(expansionContent).not.toContain(base64Blob);
    expect(expansionContent).not.toContain('noisy log line 42');
    expect(expansionContent).not.toContain('added generated line');
    expect(expansionContent).not.toContain('routeTree');
  });

  test('imports Claude sidechain subagent transcripts as separate sessions from an explicit parent id', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('claude-sidechain');
    const parentRawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: 'parent-prompt',
        type: 'user',
        message: {
          role: 'user',
          content: 'Delegate a focused inspection.',
        },
        uuid: 'parent-user',
        timestamp: '2026-06-22T17:00:00.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-parent-session',
      },
      {
        parentUuid: 'parent-user',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'parent-msg',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu-agent-parent',
              name: 'Agent',
              input: {
                description: 'Inspect importer',
                prompt: 'Check subagent identity.',
              },
            },
          ],
        },
        type: 'assistant',
        uuid: 'parent-assistant',
        timestamp: '2026-06-22T17:00:01.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-parent-session',
      },
    ]);
    const subagentRawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: true,
        agentId: 'agent-1',
        promptId: 'subagent-prompt',
        type: 'user',
        message: {
          role: 'user',
          content: 'Inspect the importer.',
        },
        uuid: 'subagent-user',
        timestamp: '2026-06-22T17:00:02.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-parent-session',
        sourceToolAssistantUUID: 'parent-assistant',
        sourceToolUseID: 'toolu-agent-parent',
      },
      {
        parentUuid: 'subagent-user',
        isSidechain: true,
        agentId: 'agent-1',
        message: {
          model: 'claude-sonnet-4-5',
          id: 'subagent-msg',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'The importer currently collapses sessions.' }],
        },
        type: 'assistant',
        uuid: 'subagent-assistant',
        timestamp: '2026-06-22T17:00:03.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-parent-session',
        sourceToolAssistantUUID: 'parent-assistant',
        sourceToolUseID: 'toolu-agent-parent',
      },
    ]);

    const parent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T17:00:04.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        harnessSessionId: 'claude-parent-session',
        host: {
          id: 'host-claude-sidechain',
        },
        locator: '/tmp/claude-parent-session.jsonl',
        rawContent: parentRawContent,
        workspaceId,
      }),
    );
    const subagent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T17:00:05.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        harnessSessionId: 'claude-parent-session',
        host: {
          id: 'host-claude-sidechain',
        },
        locator: '/tmp/claude-parent-session/subagents/agent-1.jsonl',
        rawContent: subagentRawContent,
        workspaceId,
      }),
    );

    expect(parent.session.id).not.toBe(subagent.session.id);
    expect(parent.session.harnessSessionId).toBe('claude-parent-session');
    expect(subagent.session.harnessSessionId).toBe('claude-parent-session:subagent:agent-1');
    expect(subagent.rawSessionRecord.harnessSessionId).toBe(
      'claude-parent-session:subagent:agent-1',
    );
    expect(subagent.session.metadata).toMatchObject({
      detectedHarnessSessionId: 'claude-parent-session:subagent:agent-1',
      parentHarnessSessionId: 'claude-parent-session',
    });
    expect(subagent.session.metadata.subagentEvidence).toStrictEqual(
      expect.arrayContaining([
        {
          sourceLocatorKind: 'claude-subagent-transcript',
          sourceLocator: '/tmp/claude-parent-session/subagents/agent-1.jsonl',
        },
        expect.objectContaining({
          agentId: 'agent-1',
          isSidechain: true,
          sourceToolUseID: 'toolu-agent-parent',
        }),
      ]),
    );

    const workspaceSessions = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    expect(workspaceSessions).toHaveLength(2);

    const workspaceRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, workspaceId));
    expect(workspaceRecords).toHaveLength(2);

    const parentTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, parent.session.id))
      .orderBy(asc(sessionTurns.ordinal));
    const subagentTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, subagent.session.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(parentTurns.map((turn) => turn.role)).toStrictEqual(['user', 'subagent']);
    expect(subagentTurns.map((turn) => turn.role)).toStrictEqual(['user', 'assistant']);
    expect(subagentTurns[0]?.metadata).toMatchObject({
      agentId: 'agent-1',
      isSidechain: true,
      sessionId: 'claude-parent-session',
      sourceToolUseID: 'toolu-agent-parent',
    });

    const relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      confidence: 'explicit',
      relationshipType: 'child',
      sourceSessionId: parent.session.id,
      sourceTurnId: parentTurns[1]?.id,
      targetSessionId: subagent.session.id,
    });
    expect(relationships[0]?.evidence).toMatchObject({
      agentId: 'agent-1',
      childHarnessSessionId: 'claude-parent-session:subagent:agent-1',
      derivation: 'session-relationship-import-v1',
      parentHarnessSessionId: 'claude-parent-session',
      sourceToolUseID: 'toolu-agent-parent',
    });

    const repeatedSubagent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T17:00:06.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        harnessSessionId: 'claude-parent-session',
        host: {
          id: 'host-claude-sidechain',
        },
        locator: '/tmp/claude-parent-session/subagents/agent-1.jsonl',
        rawContent: subagentRawContent,
        workspaceId,
      }),
    );
    expect(repeatedSubagent.operation).toBe('unchanged');
    const repeatedRelationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(repeatedRelationships.map((relationship) => relationship.id)).toStrictEqual([
      relationships[0]?.id,
    ]);
  });

  test('does not derive subagent relationships across workspaces', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const parentWorkspaceId = await createBoundWorkspace('relationship-parent-workspace');
    const childWorkspaceId = await createBoundWorkspace('relationship-child-workspace');
    const parentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'shared-parent-thread',
        },
      },
      {
        timestamp: '2026-06-22T18:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Parent in another workspace.' }],
        },
      },
    ]);
    const childRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:01:00.000Z',
        type: 'session_meta',
        payload: {
          agent_role: 'subagent',
          id: 'shared-child-thread',
          parent_thread_id: 'shared-parent-thread',
          thread_source: 'subagent',
        },
      },
      {
        timestamp: '2026-06-22T18:01:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Child in a different workspace.' }],
        },
      },
    ]);

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:00:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'shared-parent-thread',
        host: { id: 'host-cross-workspace' },
        locator: '/tmp/shared-parent-thread.jsonl',
        rawContent: parentRawContent,
        workspaceId: parentWorkspaceId,
      }),
    );
    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:01:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'shared-child-thread',
        host: { id: 'host-cross-workspace' },
        locator: '/tmp/shared-child-thread.jsonl',
        rawContent: childRawContent,
        workspaceId: childWorkspaceId,
      }),
    );

    const relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(
        sql`${sessionRelationships.workspaceId} in (${parentWorkspaceId}, ${childWorkspaceId})`,
      );
    expect(relationships).toHaveLength(0);
  });

  test('does not derive subagent relationships across source bindings', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('relationship-source-binding');
    const parentRawContent = codexTranscript([
      {
        timestamp: '2026-06-22T18:10:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'shared-source-parent-thread',
        },
      },
      {
        timestamp: '2026-06-22T18:10:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Parent on the first host.' }],
        },
      },
    ]);
    const childRawContent = (id: string, text: string) =>
      codexTranscript([
        {
          timestamp: '2026-06-22T18:11:00.000Z',
          type: 'session_meta',
          payload: {
            agent_role: 'subagent',
            id,
            parent_thread_id: 'shared-source-parent-thread',
            thread_source: 'subagent',
          },
        },
        {
          timestamp: '2026-06-22T18:11:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        },
      ]);

    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:11:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'source-child-before-parent',
        host: { id: 'host-relationship-child-source' },
        locator: '/tmp/source-child-before-parent.jsonl',
        rawContent: childRawContent(
          'source-child-before-parent',
          'Child imported before parent on another host.',
        ),
        workspaceId,
      }),
    );
    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:10:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'shared-source-parent-thread',
        host: { id: 'host-relationship-parent-source' },
        locator: '/tmp/shared-source-parent-thread.jsonl',
        rawContent: parentRawContent,
        workspaceId,
      }),
    );
    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:11:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'source-child-after-parent',
        host: { id: 'host-relationship-child-source' },
        locator: '/tmp/source-child-after-parent.jsonl',
        rawContent: childRawContent(
          'source-child-after-parent',
          'Child imported after parent on another host.',
        ),
        workspaceId,
      }),
    );

    const relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(0);
  });

  test('keeps same local relationship session ids separate across source bindings', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('relationship-source-local-id-collision');
    const parentHarnessSessionId = 'shared-local-parent-thread';
    const childHarnessSessionId = 'shared-local-child-thread';
    const parentRawContent = (text: string) =>
      codexTranscript([
        {
          timestamp: '2026-06-22T18:20:00.000Z',
          type: 'session_meta',
          payload: {
            id: parentHarnessSessionId,
          },
        },
        {
          timestamp: '2026-06-22T18:20:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        },
      ]);
    const childRawContent = (text: string) =>
      codexTranscript([
        {
          timestamp: '2026-06-22T18:21:00.000Z',
          type: 'session_meta',
          payload: {
            agent_role: 'subagent',
            id: childHarnessSessionId,
            parent_thread_id: parentHarnessSessionId,
            thread_source: 'subagent',
          },
        },
        {
          timestamp: '2026-06-22T18:21:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        },
      ]);

    const firstParent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:20:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: parentHarnessSessionId,
        host: { id: 'host-relationship-local-id-a' },
        locator: '/tmp/source-a/shared-local-parent-thread.jsonl',
        rawContent: parentRawContent('Parent from source A.'),
        workspaceId,
      }),
    );
    const firstChild = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:21:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: childHarnessSessionId,
        host: { id: 'host-relationship-local-id-a' },
        locator: '/tmp/source-a/shared-local-child-thread.jsonl',
        rawContent: childRawContent('Child from source A.'),
        workspaceId,
      }),
    );
    const secondChild = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:22:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: childHarnessSessionId,
        host: { id: 'host-relationship-local-id-b' },
        locator: '/tmp/source-b/shared-local-child-thread.jsonl',
        rawContent: childRawContent('Child from source B.'),
        workspaceId,
      }),
    );

    expect(firstChild.session.id).not.toBe(secondChild.session.id);
    expect(firstChild.sourceBinding.id).not.toBe(secondChild.sourceBinding.id);

    let relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({
      sourceSessionId: firstParent.session.id,
      targetSessionId: firstChild.session.id,
    });

    const secondParent = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-22T18:23:02.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: parentHarnessSessionId,
        host: { id: 'host-relationship-local-id-b' },
        locator: '/tmp/source-b/shared-local-parent-thread.jsonl',
        rawContent: parentRawContent('Parent from source B.'),
        workspaceId,
      }),
    );

    expect(firstParent.session.id).not.toBe(secondParent.session.id);
    expect(firstParent.sourceBinding.id).not.toBe(secondParent.sourceBinding.id);

    relationships = await service.db
      .select()
      .from(sessionRelationships)
      .where(eq(sessionRelationships.workspaceId, workspaceId));
    expect(relationships).toHaveLength(2);
    expect(
      relationships.map((relationship) => ({
        sourceSessionId: relationship.sourceSessionId,
        targetSessionId: relationship.targetSessionId,
      })),
    ).toStrictEqual(
      expect.arrayContaining([
        {
          sourceSessionId: firstParent.session.id,
          targetSessionId: firstChild.session.id,
        },
        {
          sourceSessionId: secondParent.session.id,
          targetSessionId: secondChild.session.id,
        },
      ]),
    );
    expect(
      relationships.some(
        (relationship) =>
          relationship.sourceSessionId === firstParent.session.id &&
          relationship.targetSessionId === secondChild.session.id,
      ),
    ).toBe(false);
    expect(
      relationships.some(
        (relationship) =>
          relationship.sourceSessionId === secondParent.session.id &&
          relationship.targetSessionId === firstChild.session.id,
      ),
    ).toBe(false);
  });

  test('preserves Claude lifecycle payloads without creating turns', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('claude-lifecycle');
    const rawContent = claudeTranscript([
      {
        type: 'system',
        subtype: 'stop-hook-summary',
        hookSummaries: [{ hook: 'Stop', status: 'success' }],
        sessionId: 'claude-lifecycle-session',
      },
      {
        type: 'worktree-state',
        branch: 'sga-122-claude-normalization',
        changedFiles: ['packages/db/src/claude-transcript-normalizer.ts'],
        sessionId: 'claude-lifecycle-session',
      },
      {
        type: 'pr-link',
        number: 12,
        url: 'https://example.invalid/pr/12',
        title: 'Normalize Claude transcripts',
        sessionId: 'claude-lifecycle-session',
      },
      {
        type: 'attachment',
        attachment: {
          fileName: 'review.txt',
          mediaType: 'text/plain',
        },
        lastPrompt: 'Review this blocker.',
        sessionId: 'claude-lifecycle-session',
      },
      {
        type: 'file-history-snapshot',
        files: [{ path: 'packages/db/src/raw-session-import.ts', status: 'modified' }],
        sessionId: 'claude-lifecycle-session',
      },
      {
        type: 'queue-operation',
        operation: 'enqueue',
        queue: [{ id: 'SGA-135', title: 'Derive subagent relationships' }],
        sessionId: 'claude-lifecycle-session',
      },
      {
        parentUuid: null,
        isSidechain: false,
        promptId: 'lifecycle-prompt',
        type: 'user',
        message: {
          role: 'user',
          content: 'Keep the actual prompt as the only turn.',
        },
        uuid: 'lifecycle-user',
        timestamp: '2026-06-22T17:10:00.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-lifecycle-session',
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T17:10:01.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        host: {
          id: 'host-claude-lifecycle',
        },
        locator: '/tmp/claude-lifecycle-session.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      lifecycleEvents: [
        {
          type: 'system',
          subtype: 'stop-hook-summary',
          hookSummaries: [{ hook: 'Stop', status: 'success' }],
        },
        {
          type: 'worktree-state',
          branch: 'sga-122-claude-normalization',
          changedFiles: ['packages/db/src/claude-transcript-normalizer.ts'],
        },
        {
          type: 'pr-link',
          number: 12,
          url: 'https://example.invalid/pr/12',
        },
        {
          type: 'attachment',
          attachment: {
            fileName: 'review.txt',
          },
          lastPrompt: 'Review this blocker.',
        },
        {
          type: 'file-history-snapshot',
          files: [{ path: 'packages/db/src/raw-session-import.ts', status: 'modified' }],
        },
        {
          type: 'queue-operation',
          queue: [{ id: 'SGA-135', title: 'Derive subagent relationships' }],
        },
      ],
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id));
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('user');

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        lifecycleEvents: [
          {
            type: 'system',
            hookSummaries: [{ hook: 'Stop', status: 'success' }],
          },
          {
            type: 'worktree-state',
            changedFiles: ['packages/db/src/claude-transcript-normalizer.ts'],
          },
          {
            type: 'pr-link',
            url: 'https://example.invalid/pr/12',
          },
          {
            type: 'attachment',
            lastPrompt: 'Review this blocker.',
          },
          {
            type: 'file-history-snapshot',
            files: [{ path: 'packages/db/src/raw-session-import.ts', status: 'modified' }],
          },
          {
            type: 'queue-operation',
            queue: [{ id: 'SGA-135', title: 'Derive subagent relationships' }],
          },
        ],
        turnCount: 1,
      },
    });
  });

  test('preserves per-record Claude cwd on turn metadata', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('claude-cwd');
    const rawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: 'cwd-prompt-1',
        type: 'user',
        message: {
          role: 'user',
          content: 'Start in the repo root.',
        },
        uuid: 'cwd-user-1',
        timestamp: '2026-06-22T17:20:00.000Z',
        cwd: '/work/saga',
        sessionId: 'claude-cwd-session',
      },
      {
        parentUuid: 'cwd-user-1',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'cwd-msg-1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Now I am in packages/db.' }],
        },
        type: 'assistant',
        uuid: 'cwd-assistant-1',
        timestamp: '2026-06-22T17:20:01.000Z',
        cwd: '/work/saga/packages/db',
        sessionId: 'claude-cwd-session',
      },
    ]);

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T17:20:02.000Z',
        contentType: 'jsonl',
        harness: 'claude',
        host: {
          id: 'host-claude-cwd',
        },
        locator: '/tmp/claude-cwd-session.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.session.metadata).toMatchObject({
      cwd: '/work/saga/packages/db',
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(turns.map((turn) => turn.metadata.cwd)).toStrictEqual([
      '/work/saga',
      '/work/saga/packages/db',
    ]);
  });

  test('unchanged Claude reimport preserves current session turn ids', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('claude-unchanged-turn-ids');
    const rawContent = claudeTranscript([
      {
        parentUuid: null,
        isSidechain: false,
        promptId: 'prompt-unchanged',
        type: 'user',
        message: {
          role: 'user',
          content: 'Keep Claude turn ids stable.',
        },
        uuid: 'claude-unchanged-user',
        timestamp: '2026-06-22T16:10:00.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-unchanged-session',
        version: '2.1.160',
        gitBranch: 'main',
      },
      {
        parentUuid: 'claude-unchanged-user',
        isSidechain: false,
        message: {
          model: 'claude-sonnet-4-5',
          id: 'msg-unchanged',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'Stable.' }],
        },
        requestId: 'req-unchanged',
        type: 'assistant',
        uuid: 'claude-unchanged-assistant',
        timestamp: '2026-06-22T16:10:01.000Z',
        userType: 'external',
        entrypoint: 'cli',
        cwd: '/work/saga',
        sessionId: 'claude-unchanged-session',
        version: '2.1.160',
        gitBranch: 'main',
      },
    ]);
    const input = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T16:10:02.000Z',
      contentType: 'jsonl',
      harness: 'claude',
      host: {
        id: 'host-claude-unchanged-turn-ids',
      },
      locator: '/tmp/claude-unchanged-session.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const firstTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const firstSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));
    const secondTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const secondSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(second.operation).toBe('unchanged');
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(second.session.id).toBe(first.session.id);
    expect(secondTurns.map((turn) => turn.id)).toStrictEqual(firstTurns.map((turn) => turn.id));
    expect(secondSegments.map((segment) => segment.id)).toStrictEqual(
      firstSegments.map((segment) => segment.id),
    );
  });

  test('records invalid Codex JSONL parse errors in normalization metadata', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-parse-errors');
    const rawContent = [
      JSON.stringify({
        timestamp: '2026-06-22T14:10:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-parse-error-session',
        },
      }),
      '{"timestamp":"2026-06-22T14:10:01.000Z","type":"response_item","payload":',
      JSON.stringify({
        timestamp: '2026-06-22T14:10:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Keep valid records.' }],
          metadata: { turn_id: 'turn-parse' },
        },
      }),
      '',
    ].join('\n');

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T14:10:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-codex-parse-errors',
        },
        locator: '/tmp/codex-parse-error-session.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      parseErrors: [
        {
          lineNumber: 1,
          rawLine: '{"timestamp":"2026-06-22T14:10:01.000Z","type":"response_item","payload":',
        },
      ],
    });
    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        parseErrors: [
          {
            lineNumber: 1,
          },
        ],
        turnCount: 1,
      },
    });
  });

  test('persists Codex parse errors and compacted lifecycle evidence without turns', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-metadata-only');
    const rawContent = [
      JSON.stringify({
        timestamp: '2026-06-22T14:20:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-metadata-only-session',
        },
      }),
      '{"timestamp":"2026-06-22T14:20:01.000Z","type":"response_item","payload":',
      JSON.stringify({
        timestamp: '2026-06-22T14:20:02.000Z',
        type: 'compacted',
        payload: {
          source: 'codex',
          turn_id: 'turn-compacted',
        },
      }),
      '',
    ].join('\n');

    const result = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: {
          handle: 'drew',
        },
        capturedAt: '2026-06-22T14:20:03.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        host: {
          id: 'host-codex-metadata-only',
        },
        locator: '/tmp/codex-metadata-only-session.jsonl',
        rawContent,
        workspaceId,
      }),
    );

    expect(result.activityInterval.metadata).toMatchObject({
      lifecycleEvents: [
        {
          payload: {
            source: 'codex',
            turnId: 'turn-compacted',
          },
          type: 'compacted',
        },
      ],
      parseErrors: [
        {
          lineNumber: 1,
        },
      ],
    });
    expect(result.session.metadata).toMatchObject({
      lifecycleEventCount: 1,
      turnCount: 0,
    });

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, result.rawSessionRecord.id));
    expect(turns).toHaveLength(0);

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecord.id))
      .limit(1);
    expect(rawRecord?.metadata).toMatchObject({
      normalization: {
        lifecycleEvents: [
          {
            type: 'compacted',
          },
        ],
        parseErrors: [
          {
            lineNumber: 1,
          },
        ],
        turnCount: 0,
      },
    });
  });

  test('same-hash Codex reimport repairs derived rows with current normalization', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-repair');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:30:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-repair-session',
        },
      },
      {
        timestamp: '2026-06-22T14:30:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-repair',
        },
      },
      {
        timestamp: '2026-06-22T14:30:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          status: 'completed',
          call_id: 'call-repair',
          name: 'web.run',
          arguments: '{}',
          metadata: { turn_id: 'turn-repair' },
        },
      },
      {
        timestamp: '2026-06-22T14:30:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call-repair',
          output: [
            { type: 'text', text: 'Repaired structured output' },
            { type: 'image', image_url: 'file:///tmp/repaired.png' },
          ],
        },
      },
    ]);
    const input = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T14:30:04.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-codex-repair',
      },
      locator: '/tmp/codex-repair-session.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const initialTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const toolResultTurn = initialTurns.find((turn) =>
      Array.isArray(turn.contentParts)
        ? turn.contentParts.some(
            (part) =>
              typeof part === 'object' &&
              part !== null &&
              'type' in part &&
              part.type === 'tool_result',
          )
        : false,
    );
    if (toolResultTurn === undefined) {
      throw new Error('tool result turn was not normalized');
    }

    await service.db
      .update(sessionTurns)
      .set({
        contentParts: [{ type: 'tool_result', name: 'web.run', callId: 'call-repair' }],
      })
      .where(eq(sessionTurns.id, toolResultTurn.id));
    const frozenUpdatedAt = new Date('2026-06-22T00:00:00.000Z');
    await service.db
      .update(sessions)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(sessions.id, first.session.id));
    await service.db
      .update(activityIntervals)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(activityIntervals.id, first.activityInterval.id));
    await service.db
      .update(rawSessionRecords)
      .set({ updatedAt: frozenUpdatedAt })
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(second.operation).toBe('unchanged');
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const repairedTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(repairedTurns).toHaveLength(2);
    expect(repairedTurns[1]?.contentParts).toStrictEqual([
      {
        type: 'tool_result',
        name: 'web.run',
        callId: 'call-repair',
        output: [
          { type: 'text', text: 'Repaired structured output' },
          { type: 'image', image_url: 'file:///tmp/repaired.png' },
        ],
      },
    ]);

    const [storedSession] = await service.db
      .select({ updatedAt: sessions.updatedAt })
      .from(sessions)
      .where(eq(sessions.id, first.session.id));
    const [storedActivityInterval] = await service.db
      .select({ updatedAt: activityIntervals.updatedAt })
      .from(activityIntervals)
      .where(eq(activityIntervals.id, first.activityInterval.id));
    const [storedRawSessionRecord] = await service.db
      .select({ updatedAt: rawSessionRecords.updatedAt })
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));
    expect(storedSession?.updatedAt.getTime()).toBeGreaterThan(frozenUpdatedAt.getTime());
    expect(storedActivityInterval?.updatedAt.getTime()).toBeGreaterThan(frozenUpdatedAt.getTime());
    expect(storedRawSessionRecord?.updatedAt.getTime()).toBeGreaterThan(frozenUpdatedAt.getTime());
  });

  test('adopts legacy locator-scoped Codex session on later session_meta id detection', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-legacy-locator');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:40:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-legacy-locator-session',
        },
      },
      {
        timestamp: '2026-06-22T14:40:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-legacy',
        },
      },
      {
        timestamp: '2026-06-22T14:40:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Adopt the legacy locator session.' }],
          metadata: { turn_id: 'turn-legacy' },
        },
      },
    ]);
    const input = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T14:40:02.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-codex-legacy-locator',
      },
      locator: '/tmp/codex-legacy-locator.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));

    // Simulate a pre-normalizer import that was identifiable only by locator.
    await service.db
      .update(rawSessionRecords)
      .set({
        harnessSessionId: null,
        metadata: {
          contentBytes: Buffer.byteLength(input.rawContent, 'utf8'),
          legacyImporter: true,
        },
      })
      .where(eq(rawSessionRecords.id, first.rawSessionRecord.id));
    await service.db
      .update(sessions)
      .set({
        harnessSessionId: null,
        lastActivityAt: new Date('2026-06-22T14:40:03.000Z'),
        metadata: {
          legacyImporter: true,
        },
        model: 'legacy-model',
        startedAt: new Date('2026-06-22T14:40:03.000Z'),
      })
      .where(eq(sessions.id, first.session.id));
    await service.db
      .update(activityIntervals)
      .set({
        metadata: {
          importBoundary: 'raw_session',
          legacyImporter: true,
        },
        startedAt: new Date('2026-06-22T14:40:03.000Z'),
      })
      .where(eq(activityIntervals.id, first.activityInterval.id));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));

    expect(second.operation).toBe('unchanged');
    expect(second.session.id).toBe(first.session.id);
    expect(second.session.harnessSessionId).toBe('codex-legacy-locator-session');
    expect(second.session).toMatchObject({
      lastActivityAt: new Date('2026-06-22T14:40:02.000Z'),
      model: 'gpt-5-codex',
      startedAt: new Date('2026-06-22T14:40:02.000Z'),
    });
    expect(second.session.metadata).toMatchObject({
      cwd: '/work/saga',
      detectedHarnessSessionId: 'codex-legacy-locator-session',
      normalizer: 'codex-transcript-v1',
      turnCount: 1,
    });
    expect(second.activityInterval.startedAt).toStrictEqual(new Date('2026-06-22T14:40:02.000Z'));
    expect(second.activityInterval.metadata).toMatchObject({
      cwd: '/work/saga',
      normalizer: 'codex-transcript-v1',
      turnContexts: [
        {
          model: 'gpt-5-codex',
          turn_id: 'turn-legacy',
        },
      ],
    });
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);

    const workspaceSessions = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, workspaceId));
    expect(workspaceSessions).toHaveLength(1);
    expect(workspaceSessions[0]?.harnessSessionId).toBe('codex-legacy-locator-session');
    expect(workspaceSessions[0]?.metadata).toMatchObject({
      normalizer: 'codex-transcript-v1',
      turnCount: 1,
    });

    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id));
    expect(records).toHaveLength(1);
    expect(records[0]?.harnessSessionId).toBe('codex-legacy-locator-session');
    expect(records[0]?.metadata).toMatchObject({
      normalization: {
        normalizer: 'codex-transcript-v1',
        turnCount: 1,
      },
    });
  });

  test('unchanged Codex reimport preserves current session turn ids', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-unchanged-turn-ids');
    const rawContent = codexTranscript([
      {
        timestamp: '2026-06-22T14:50:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-unchanged-turn-ids-session',
        },
      },
      {
        timestamp: '2026-06-22T14:50:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-unchanged',
        },
      },
      {
        timestamp: '2026-06-22T14:50:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Keep my turn ids.' }],
          metadata: { turn_id: 'turn-unchanged' },
        },
      },
      {
        timestamp: '2026-06-22T14:50:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          id: 'assistant-unchanged',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The turn ids should not churn.' }],
          metadata: { turn_id: 'turn-unchanged' },
        },
      },
    ]);
    const input = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T14:50:04.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-codex-unchanged-turn-ids',
      },
      locator: '/tmp/codex-unchanged-turn-ids.jsonl',
      rawContent,
      workspaceId,
    } as const;

    const first = await Effect.runPromise(importRawSessionRecord(service, input));
    const firstTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const firstSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    const second = await Effect.runPromise(importRawSessionRecord(service, input));
    const secondTurns = await service.db
      .select({ id: sessionTurns.id })
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    const secondSegments = await service.db
      .select({ id: sessionSegments.id })
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, first.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));

    expect(second.operation).toBe('unchanged');
    expect(second.rawSessionRecord.id).toBe(first.rawSessionRecord.id);
    expect(secondTurns.map((turn) => turn.id)).toStrictEqual(firstTurns.map((turn) => turn.id));
    expect(secondSegments.map((segment) => segment.id)).toStrictEqual(
      firstSegments.map((segment) => segment.id),
    );
  });

  test('regenerates Codex derived rows from the active growing snapshot', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('codex-growing');
    const baseRecords = [
      {
        timestamp: '2026-06-22T15:00:00.000Z',
        type: 'session_meta',
        payload: {
          cwd: '/work/saga',
          id: 'codex-growing-session',
        },
      },
      {
        timestamp: '2026-06-22T15:00:01.000Z',
        type: 'turn_context',
        payload: {
          cwd: '/work/saga',
          model: 'gpt-5-codex',
          turn_id: 'turn-1',
        },
      },
      {
        timestamp: '2026-06-22T15:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'First prompt' }],
          metadata: { turn_id: 'turn-1' },
        },
      },
    ] as const;

    const importInput = {
      author: {
        handle: 'drew',
      },
      capturedAt: '2026-06-22T15:00:03.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      host: {
        id: 'host-codex-growing',
      },
      locator: '/tmp/codex-growing.jsonl',
      rawContent: codexTranscript(baseRecords),
      workspaceId,
    } as const;
    const first = await Effect.runPromise(importRawSessionRecord(service, importInput));
    const second = await Effect.runPromise(
      importRawSessionRecord(service, {
        ...importInput,
        capturedAt: '2026-06-22T15:00:05.000Z',
        rawContent: codexTranscript([
          ...baseRecords,
          {
            timestamp: '2026-06-22T15:00:04.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              id: 'assistant-growing-1',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Second answer' }],
              metadata: { turn_id: 'turn-1' },
            },
          },
        ]),
      }),
    );

    expect(second.operation).toBe('inserted');
    expect(second.session.id).toBe(first.session.id);

    const oldTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, first.rawSessionRecord.id));
    expect(oldTurns).toHaveLength(0);

    const newTurns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.rawSessionRecordId, second.rawSessionRecord.id))
      .orderBy(asc(sessionTurns.ordinal));
    expect(newTurns.map((turn) => turn.role)).toStrictEqual(['user', 'assistant']);

    const activeSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.rawSessionRecordId, second.rawSessionRecord.id))
      .orderBy(asc(sessionSegments.ordinal));
    expect(activeSegments).toHaveLength(2);
    expect(activeSegments.map((segment) => segment.searchText)).toStrictEqual([
      'First prompt',
      'Second answer',
    ]);
  });

  test('requires an existing bound workspace', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }

    await expect(
      Effect.runPromise(
        importRawSessionRecord(service, {
          author: {
            handle: 'drew',
          },
          contentType: 'text',
          harness: 'codex',
          harnessSessionId: 'missing-workspace',
          host: {
            id: 'host-3',
          },
          rawContent: 'missing workspace',
          workspaceId: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow('workspace binding is required before importing raw sessions');
  });

  test('lifecycle boundary creates a session shell and opens interval 0 without derived content', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-shell');
    const seed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-shell-1',
      harness: 'codex',
      hostId: 'host-lifecycle-shell',
      occurredAt: '2026-06-27T10:00:00.000Z',
      workspaceId,
    });

    const result = await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: seed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T10:00:00.000Z',
        harness: 'codex',
        harnessSessionId: 'codex-lifecycle-shell-session',
        host: { id: 'host-lifecycle-shell' },
        locator: '/tmp/codex-lifecycle-shell.jsonl',
        provenance: { importedBy: 'saga ingest codex-hook', rawEventId: seed.rawEventId },
        sourceBindingId: seed.sourceBindingId,
        workspaceId,
      }),
    );

    expect(result.operation).toBe('opened');
    expect(result.session.harnessSessionId).toBe('codex-lifecycle-shell-session');
    expect(result.activityInterval.ordinal).toBe(0);
    expect(result.activityInterval.status).toBe('active');

    // ADR-0030: no Raw Session Records, Turns, Segments, or embeddings.
    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, result.session.id));
    expect(records).toHaveLength(0);
    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, result.session.id));
    expect(turns).toHaveLength(0);
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, result.session.id));
    expect(segments).toHaveLength(0);
    const embeddings = await service.db
      .select()
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.workspaceId, workspaceId));
    expect(embeddings).toHaveLength(0);

    // Provenance to the triggering Raw Event lives on the opened interval's metadata.
    expect(result.activityInterval.metadata.triggerRawEventId).toBe(seed.rawEventId);
  });

  test('lifecycle boundaries settle and open intervals without transcript content', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-boundaries');
    const base = {
      author: { handle: 'drew' },
      harness: 'claude',
      host: { id: 'host-lifecycle-boundaries' },
      locator: '/tmp/claude-lifecycle-boundaries.jsonl',
      workspaceId,
    } as const;
    let eventSeq = 0;

    async function event(
      hookEventName: string,
      sessionStartSource: string | undefined,
      capturedAt: string,
    ) {
      eventSeq += 1;
      const seed = await seedSourceBindingAndRawEvent({
        eventType: hookEventName,
        externalEventId: `evt-boundary-${eventSeq}`,
        harness: 'claude',
        hostId: 'host-lifecycle-boundaries',
        occurredAt: capturedAt,
        workspaceId,
      });
      return Effect.runPromise(
        importLifecycleBoundaryEvent(service!, {
          ...base,
          activity: {
            hookEventName,
            sessionStartSource,
            settlementTriggerRawEventId: seed.rawEventId,
          },
          capturedAt,
          harnessSessionId: 'claude-lifecycle-boundaries-session',
          sourceBindingId: seed.sourceBindingId,
        }),
      );
    }

    const start = await event('SessionStart', 'startup', '2026-06-27T11:00:00.000Z');
    expect(start.operation).toBe('opened');

    const clear = await event('SessionStart', 'clear', '2026-06-27T11:05:00.000Z');
    expect(clear.operation).toBe('settled_opened');
    expect(clear.activityInterval.ordinal).toBe(1);
    expect(clear.activityInterval.metadata.triggerRawEventId).toBeDefined();

    const stop = await event('Stop', undefined, '2026-06-27T11:10:00.000Z');
    expect(stop.operation).toBe('settled');
    expect(stop.session.status).toBe('completed');

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, start.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(intervals.map((i) => i.status)).toStrictEqual(['settled', 'settled']);
    expect(intervals[0]).toMatchObject({ settlementReason: 'clear_context' });
    expect(intervals[1]).toMatchObject({ settlementReason: 'stop_event' });
    expect(intervals[0]?.settlementTriggerRawEventId).not.toBeNull();
    // Still no derived content anywhere.
    const records = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, start.session.id));
    expect(records).toHaveLength(0);
    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, start.session.id));
    expect(turns).toHaveLength(0);
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, start.session.id));
    expect(segments).toHaveLength(0);
    // ADR-0030: no embeddings on the transcript-less path.
    const embeddings = await service.db
      .select()
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.workspaceId, workspaceId));
    expect(embeddings).toHaveLength(0);
  });

  test('re-processing the same lifecycle raw event is an idempotent no-op', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-idempotent');

    // Open an active interval so the subsequent Stop can settle it.
    const startSeed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idempotent-start',
      harness: 'codex',
      hostId: 'host-idempotent',
      occurredAt: '2026-06-27T11:50:00.000Z',
      workspaceId,
    });
    await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: startSeed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T11:50:00.000Z',
        harness: 'codex',
        harnessSessionId: 'codex-idempotent-session',
        host: { id: 'host-idempotent' },
        locator: '/tmp/codex-idempotent.jsonl',
        sourceBindingId: startSeed.sourceBindingId,
        workspaceId,
      }),
    );

    const seed = await seedSourceBindingAndRawEvent({
      eventType: 'Stop',
      externalEventId: 'evt-idempotent-1',
      harness: 'codex',
      hostId: 'host-idempotent',
      occurredAt: '2026-06-27T12:00:00.000Z',
      workspaceId,
    });

    const make = () =>
      importLifecycleBoundaryEvent(service!, {
        activity: {
          hookEventName: 'Stop',
          sessionStartSource: undefined,
          settlementTriggerRawEventId: seed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T12:00:00.000Z',
        harness: 'codex',
        harnessSessionId: 'codex-idempotent-session',
        host: { id: 'host-idempotent' },
        locator: '/tmp/codex-idempotent.jsonl',
        sourceBindingId: seed.sourceBindingId,
        workspaceId,
      });

    const first = await Effect.runPromise(make());
    expect(first.operation).toBe('settled');
    const second = await Effect.runPromise(make());
    expect(second.operation).toBe('unchanged');

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id));
    expect(intervals).toHaveLength(1); // no duplicate interval opened on replay
  });

  test('re-processing a lifecycle SessionStart raw event (opened) is an idempotent no-op', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-idempotent-opened');
    const seed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idempotent-opened-1',
      harness: 'codex',
      hostId: 'host-idempotent-opened',
      occurredAt: '2026-06-27T12:00:00.000Z',
      workspaceId,
    });

    const make = () =>
      importLifecycleBoundaryEvent(service!, {
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: seed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T12:00:00.000Z',
        harness: 'codex',
        harnessSessionId: 'codex-idempotent-opened-session',
        host: { id: 'host-idempotent-opened' },
        locator: '/tmp/codex-idempotent-opened.jsonl',
        sourceBindingId: seed.sourceBindingId,
        workspaceId,
      });

    const first = await Effect.runPromise(make());
    expect(first.operation).toBe('opened');
    const second = await Effect.runPromise(make());
    expect(second.operation).toBe('unchanged');

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id));
    expect(intervals).toHaveLength(1); // no duplicate interval opened on replay
  });

  test('transcript import reuses a lifecycle-created session shell and preserves derived rows across a later boundary', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-coherence');
    const harnessSessionId = 'codex-coherence-session';
    const host = { id: 'host-coherence' } as const;
    const locator = '/tmp/codex-coherence.jsonl';

    const startSeed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-coherence-start',
      harness: 'codex',
      hostId: host.id,
      occurredAt: '2026-06-27T13:00:00.000Z',
      workspaceId,
    });

    const shell = await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: startSeed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T13:00:00.000Z',
        harness: 'codex',
        harnessSessionId,
        host,
        locator,
        sourceBindingId: startSeed.sourceBindingId,
        workspaceId,
      }),
    );

    // Later transcript snapshot for the SAME harness session — reuses the seeded binding.
    const content = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T13:01:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId,
        host,
        locator,
        sourceBindingId: startSeed.sourceBindingId,
        rawContent: codexTranscript([
          {
            timestamp: '2026-06-27T13:00:00.000Z',
            type: 'session_meta',
            payload: { id: harnessSessionId },
          },
          {
            timestamp: '2026-06-27T13:01:00.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'Real work.' }],
            },
          },
        ]),
        workspaceId,
      }),
    );

    // Coherence: same session, no fork.
    expect(content.session.id).toBe(shell.session.id);
    const sessionCount = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.harnessSessionId, harnessSessionId));
    expect(sessionCount).toHaveLength(1);

    const turnsAfterContent = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, shell.session.id));
    expect(turnsAfterContent.length).toBeGreaterThan(0);
    const derivedIntervalIds = new Set(turnsAfterContent.map((t) => t.activityIntervalId));

    // A later transcript-less clear boundary must NOT reassign/delete those derived rows (ADR-0031).
    const clearSeed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-coherence-clear',
      harness: 'codex',
      hostId: host.id,
      occurredAt: '2026-06-27T13:05:00.000Z',
      workspaceId,
    });
    await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'clear',
          settlementTriggerRawEventId: clearSeed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T13:05:00.000Z',
        harness: 'codex',
        harnessSessionId,
        host,
        locator,
        sourceBindingId: clearSeed.sourceBindingId,
        workspaceId,
      }),
    );

    // The clear boundary must genuinely settle interval 0 and open interval 1; otherwise the
    // no-reassignment assertions below would pass vacuously (no new interval to move rows into).
    const intervalsAfterClear = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, shell.session.id));
    expect(intervalsAfterClear).toHaveLength(2);

    const turnsAfterClear = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, shell.session.id));
    expect(turnsAfterClear).toHaveLength(turnsAfterContent.length);
    expect(new Set(turnsAfterClear.map((t) => t.activityIntervalId))).toStrictEqual(
      derivedIntervalIds,
    );
  });

  test('lifecycle idle timeout settles and opens a new interval without transcript content', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-idle-timeout');
    const base = {
      author: { handle: 'drew' },
      harness: 'claude',
      host: { id: 'host-lifecycle-idle-timeout' },
      locator: '/tmp/claude-lifecycle-idle-timeout.jsonl',
      workspaceId,
    } as const;
    const T = '2026-06-27T12:00:00.000Z';
    const T45 = '2026-06-27T12:45:00.000Z';

    const seed1 = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idle-1',
      harness: 'claude',
      hostId: 'host-lifecycle-idle-timeout',
      occurredAt: T,
      workspaceId,
    });
    const start = await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        ...base,
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: seed1.rawEventId,
        },
        capturedAt: T,
        harnessSessionId: 'claude-lifecycle-idle-timeout-session',
        sourceBindingId: seed1.sourceBindingId,
      }),
    );
    expect(start.operation).toBe('opened');
    expect(start.activityInterval.ordinal).toBe(0);

    const seed2 = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idle-2',
      harness: 'claude',
      hostId: 'host-lifecycle-idle-timeout',
      occurredAt: T45,
      workspaceId,
    });
    const idle = await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        ...base,
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: seed2.rawEventId,
        },
        capturedAt: T45,
        harnessSessionId: 'claude-lifecycle-idle-timeout-session',
        sourceBindingId: seed1.sourceBindingId,
      }),
    );
    expect(idle.operation).toBe('settled_opened');
    expect(idle.activityInterval.ordinal).toBe(1);

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, start.session.id))
      .orderBy(asc(activityIntervals.ordinal));
    expect(intervals.map((i) => i.status)).toStrictEqual(['settled', 'active']);
    expect(intervals[0]?.settlementReason).toBe('idle_timeout');
  });

  test('stop lifecycle event with no prior active interval settles immediately (no dangling active interval)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-stop-no-interval');
    const seed = await seedSourceBindingAndRawEvent({
      eventType: 'Stop',
      externalEventId: 'evt-stop-no-interval-1',
      harness: 'codex',
      hostId: 'host-stop-no-interval',
      occurredAt: '2026-06-27T14:00:00.000Z',
      workspaceId,
    });

    const result = await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        activity: {
          hookEventName: 'Stop',
          sessionStartSource: undefined,
          settlementTriggerRawEventId: seed.rawEventId,
        },
        author: { handle: 'drew' },
        capturedAt: '2026-06-27T14:00:00.000Z',
        harness: 'codex',
        harnessSessionId: 'codex-stop-no-interval-session',
        host: { id: 'host-stop-no-interval' },
        sourceBindingId: seed.sourceBindingId,
        workspaceId,
      }),
    );

    expect(result.operation).toBe('settled');
    expect(result.session.status).toBe('completed');

    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, result.session.id));
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.status).toBe('settled');
    expect(intervals[0]?.settlementReason).toBe('stop_event');
  });

  test('importLifecycleBoundaryEvent rejects when neither harnessSessionId nor locator is provided', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-no-identity');
    const seed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-no-identity-1',
      harness: 'codex',
      hostId: 'host-no-identity',
      occurredAt: '2026-06-27T14:00:00.000Z',
      workspaceId,
    });

    await expect(
      Effect.runPromise(
        importLifecycleBoundaryEvent(service, {
          activity: {
            hookEventName: 'SessionStart',
            sessionStartSource: 'startup',
            settlementTriggerRawEventId: seed.rawEventId,
          },
          author: { handle: 'drew' },
          capturedAt: '2026-06-27T14:00:00.000Z',
          harness: 'codex',
          // no harnessSessionId, no locator
          host: { id: 'host-no-identity' },
          sourceBindingId: seed.sourceBindingId,
          workspaceId,
        }),
      ),
    ).rejects.toThrow('harnessSessionId or locator is required to identify a raw session');
  });

  test('re-processing the same lifecycle clear (settled_opened) raw event is an idempotent no-op', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createBoundWorkspace('lifecycle-idempotent-clear');
    const base = {
      author: { handle: 'drew' },
      harness: 'codex',
      harnessSessionId: 'codex-idempotent-clear-session',
      host: { id: 'host-idempotent-clear' },
      workspaceId,
    } as const;

    // First: open interval 0 with a SessionStart.
    const startSeed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idempotent-clear-start',
      harness: 'codex',
      hostId: base.host.id,
      occurredAt: '2026-06-27T15:00:00.000Z',
      workspaceId,
    });
    await Effect.runPromise(
      importLifecycleBoundaryEvent(service, {
        ...base,
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'startup',
          settlementTriggerRawEventId: startSeed.rawEventId,
        },
        capturedAt: '2026-06-27T15:00:00.000Z',
        sourceBindingId: startSeed.sourceBindingId,
      }),
    );

    // Second: clear event triggers settled_opened (interval 0 settled, interval 1 opened).
    const clearSeed = await seedSourceBindingAndRawEvent({
      eventType: 'SessionStart',
      externalEventId: 'evt-idempotent-clear-clear',
      harness: 'codex',
      hostId: base.host.id,
      occurredAt: '2026-06-27T15:05:00.000Z',
      workspaceId,
    });

    const makeImport = () =>
      importLifecycleBoundaryEvent(service!, {
        ...base,
        activity: {
          hookEventName: 'SessionStart',
          sessionStartSource: 'clear',
          settlementTriggerRawEventId: clearSeed.rawEventId,
        },
        capturedAt: '2026-06-27T15:05:00.000Z',
        sourceBindingId: clearSeed.sourceBindingId,
      });

    const first = await Effect.runPromise(makeImport());
    expect(first.operation).toBe('settled_opened');

    // Replay the same clear rawEventId — must be a no-op.
    const second = await Effect.runPromise(makeImport());
    expect(second.operation).toBe('unchanged');

    // Interval count must stay at 2 — no third interval opened.
    const intervals = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, first.session.id));
    expect(intervals).toHaveLength(2);
  });
});

function codexTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function claudeTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function expectRecentSessionRecordTimestampsCanRender(row: RecentSessionRecord | undefined): void {
  if (row === undefined) {
    throw new Error('expected recent session record');
  }
  expectNullableDate(row.session.startedAt, 'session.startedAt');
  expectNullableDate(row.session.lastActivityAt, 'session.lastActivityAt');
  expectNullableDate(row.session.endedAt, 'session.endedAt');
  expectDate(row.rawSessionRecord.capturedAt, 'rawSessionRecord.capturedAt');
  if (row.activityInterval !== null) {
    expectDate(row.activityInterval.startedAt, 'activityInterval.startedAt');
    expectNullableDate(row.activityInterval.endedAt, 'activityInterval.endedAt');
    expectNullableDate(row.activityInterval.settledAt, 'activityInterval.settledAt');
  }

  const eagerRecordsOutput = [
    row.rawSessionRecord.capturedAt.toISOString(),
    row.session.startedAt?.toISOString() ?? 'none',
    row.session.lastActivityAt?.toISOString() ?? 'none',
    row.session.endedAt?.toISOString() ?? 'none',
    row.activityInterval?.startedAt.toISOString() ?? 'none',
    row.activityInterval?.endedAt?.toISOString() ?? 'none',
    row.activityInterval?.settledAt?.toISOString() ?? 'none',
  ];
  // JSON round-trip normalizes to serialized form (Date->ISO, drops undefined);
  // structuredClone would preserve those and change the match. Not a plain clone.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  expect(JSON.parse(JSON.stringify({ records: eagerRecordsOutput, value: row }))).toMatchObject({
    records: eagerRecordsOutput,
  });
}

function expectSessionDetailTimestampsCanRender(detail: SessionDetail): void {
  expectNullableDate(detail.session.startedAt, 'session.startedAt');
  expectNullableDate(detail.session.lastActivityAt, 'session.lastActivityAt');
  expectNullableDate(detail.session.endedAt, 'session.endedAt');

  const rawRecords = [
    ...detail.rawSessionRecords,
    ...(detail.activeRawSessionRecord === null ? [] : [detail.activeRawSessionRecord]),
    ...(detail.selectedRawSessionRecord === null ? [] : [detail.selectedRawSessionRecord]),
  ];
  const eagerRecordsOutput = [
    detail.session.startedAt?.toISOString() ?? 'none',
    detail.session.lastActivityAt?.toISOString() ?? 'none',
    detail.session.endedAt?.toISOString() ?? 'none',
  ];

  for (const record of rawRecords) {
    expectDate(record.capturedAt, 'rawSessionRecord.capturedAt');
    eagerRecordsOutput.push(record.capturedAt.toISOString());
  }

  for (const interval of detail.activityIntervals) {
    expectDate(interval.activityInterval.startedAt, 'activityInterval.startedAt');
    expectNullableDate(interval.activityInterval.endedAt, 'activityInterval.endedAt');
    expectNullableDate(interval.activityInterval.settledAt, 'activityInterval.settledAt');
    eagerRecordsOutput.push(
      interval.activityInterval.startedAt.toISOString(),
      interval.activityInterval.endedAt?.toISOString() ?? 'none',
      interval.activityInterval.settledAt?.toISOString() ?? 'none',
    );
    for (const turn of interval.turns) {
      expectNullableDate(turn.startedAt, 'turn.startedAt');
      expectNullableDate(turn.endedAt, 'turn.endedAt');
      eagerRecordsOutput.push(
        turn.startedAt?.toISOString() ?? 'none',
        turn.endedAt?.toISOString() ?? 'none',
      );
    }
  }

  // JSON round-trip normalizes to serialized form (Date->ISO, drops undefined);
  // structuredClone would preserve those and change the match. Not a plain clone.
  // oxlint-disable-next-line unicorn/prefer-structured-clone
  expect(JSON.parse(JSON.stringify({ records: eagerRecordsOutput, value: detail }))).toMatchObject({
    records: eagerRecordsOutput,
  });
}

function expectDate(value: Date, label: string): void {
  // `label` is vitest's supported failure-message hint (expect(actual, message));
  // the rule's default maxArgs misjudges this valid vitest idiom.
  // oxlint-disable-next-line vitest/valid-expect
  expect(value, label).toBeInstanceOf(Date);
  // oxlint-disable-next-line vitest/valid-expect
  expect(value.toISOString(), label).toMatch(/^\d{4}-\d{2}-\d{2}T/);
}

function expectNullableDate(value: Date | null, label: string): void {
  if (value === null) {
    return;
  }
  expectDate(value, label);
}
