import { SagaApiClient } from '@saga/api-client';
import type { IngestItem } from '@saga/api-client';
import {
  activityIntervals,
  deriveStoredSessionRecord,
  importLifecycleBoundaryEvent,
  importRawSessionRecord,
  insertRawEvent,
  lifecycleSettlementQueue,
  listPendingLifecycleSettlements,
  listRawSessionRecordsAwaitingDerivation,
  makeDatabase,
  MAX_DERIVATION_ATTEMPTS,
  rawEvents,
  runMigrations,
  sessions,
  sessionSegments,
  sessionTurns,
  rawSessionRecords,
  sourceBindings,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { and, asc, eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { extractionJobFactory } from './jobs/extraction.js';
import { startSagaService } from './server.js';
import type { SagaServiceHandle } from './server.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// The load-bearing proof for the async write path (SGA-238): a snapshot POSTed
// through @saga/api-client and then derived by the extraction job must produce
// the SAME turns/segments the synchronous importRawSessionRecord (the CLI path)
// produces for the same transcript — and the store + derive must both be
// idempotent, and a stored lifecycle-boundary event must settle its interval the
// way importLifecycleBoundaryEvent does.

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

const CAPTURED_AT = '2026-06-21T14:00:00.000Z';
// Within the 30-minute idle window so the boundary settles as a clean stop_event
// rather than tripping an idle_timeout settlement first.
const STOP_AT = '2026-06-21T14:05:00.000Z';
const RAW_CONTENT = [
  JSON.stringify({ text: 'Parity sentinel phrase alpha bravo', type: 'user' }),
  JSON.stringify({ text: 'assistant reply keeps surrounding context', type: 'assistant' }),
  '',
].join('\n');

// Project away the volatile identity/timestamp columns so two structurally
// identical derivations under different session/record ids compare equal.
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
  // metadata is deliberately excluded: it embeds the derived turn-row UUIDs
  // (segmentTurnId/groupedTurnIds), which are correctly session-specific. The
  // remaining fields (searchText, offsets, kind, ordinal) prove content parity.
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

describePostgres('service ingest → extraction parity', () => {
  const databaseName = `saga_service_ingest_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let client: SagaApiClient | undefined;

  let workspaceId = '';
  let sourceBindingId = '';

  const svc = (): DatabaseService => {
    if (service === undefined) {
      throw new Error('service database not initialized');
    }
    return service;
  };

  const runExtractionOnce = async (): Promise<void> => {
    await Effect.runPromise(extractionJobFactory({ database: svc() }).run);
  };

  const loadTurns = async (sessionId: string): Promise<(typeof sessionTurns.$inferSelect)[]> =>
    svc()
      .db.select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId))
      .orderBy(asc(sessionTurns.ordinal));

  const loadSegments = async (
    sessionId: string,
  ): Promise<(typeof sessionSegments.$inferSelect)[]> =>
    svc()
      .db.select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, sessionId))
      .orderBy(asc(sessionSegments.ordinal));

  const findSession = async (harnessSessionId: string): Promise<typeof sessions.$inferSelect> => {
    const [row] = await svc()
      .db.select()
      .from(sessions)
      .where(
        and(eq(sessions.workspaceId, workspaceId), eq(sessions.harnessSessionId, harnessSessionId)),
      )
      .limit(1);
    if (row === undefined) {
      throw new Error(`session ${harnessSessionId} not found`);
    }
    return row;
  };

  const activeIntervalFor = async (
    sessionId: string,
  ): Promise<(typeof activityIntervals.$inferSelect)[]> =>
    svc()
      .db.select()
      .from(activityIntervals)
      .where(eq(activityIntervals.sessionId, sessionId))
      .orderBy(asc(activityIntervals.ordinal));

  const snapshotItem = (harnessSessionId: string, externalEventId: string): IngestItem => ({
    envelope: {
      actorId: 'codex',
      eventType: 'codex.UserPromptSubmit',
      externalEventId,
      occurredAt: CAPTURED_AT,
      payload: { hook_event_name: 'UserPromptSubmit', session_id: harnessSessionId },
      provenance: { importedBy: 'ingest-test' },
      sourceBindingId,
      sourceId: 'codex:local',
      sourceType: 'codex',
      trustLevel: 'raw',
      workspaceId,
    },
    snapshot: {
      activity: { hookEventName: 'UserPromptSubmit' },
      author: { handle: 'drew' },
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId,
      host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
      rawContent: RAW_CONTENT,
      status: 'active',
    },
  });

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
      .values({ handle: `ingest-${Date.now().toString(36)}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    workspaceId = workspace.id;

    // A source binding the raw-event envelope references; its sourceUri matches
    // the host so storeRawSessionRecord adopts it rather than minting a new one.
    const [binding] = await service.db
      .insert(sourceBindings)
      .values({
        config: { hostId: 'host-1', hostLabel: 'local-host', projectRoot: '/tmp/saga' },
        displayName: 'Codex on local-host',
        sourceType: 'codex',
        sourceUri: 'codex://host/host-1',
        workspaceId,
      })
      .returning();
    if (binding === undefined) {
      throw new Error('source binding insert returned no row');
    }
    sourceBindingId = binding.id;

    // The oracle: the synchronous CLI path over the same transcript.
    await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: CAPTURED_AT,
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'oracle-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: RAW_CONTENT,
        workspaceId,
      }),
    );

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      // No background jobs: the test drives the extraction job's run Effect
      // directly so derivation timing is deterministic.
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
    if (admin !== undefined) {
      await admin.sql.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await Effect.runPromise(admin.close());
    }
  });

  test('a POSTed snapshot, once derived by the job, equals importRawSessionRecord', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const response = await client.ingest({
      items: [snapshotItem('ingest-session', 'ingest-evt-1')],
    });
    expect(response.results).toHaveLength(1);
    const [ack] = response.results;
    expect(ack?.status).toBe('stored');
    expect(ack?.externalEventId).toBe('ingest-evt-1');
    expect(ack?.rawEventId).toBeTypeOf('string');
    expect(ack?.rawSessionRecordId).toBeTypeOf('string');

    // Before the job runs, the snapshot is stored but NOT derived.
    const ingestSession = await findSession('ingest-session');
    await expect(loadTurns(ingestSession.id)).resolves.toHaveLength(0);

    await runExtractionOnce();

    const oracleSession = await findSession('oracle-session');
    const oracleTurns = await loadTurns(oracleSession.id);
    const oracleSegments = await loadSegments(oracleSession.id);
    const ingestTurns = await loadTurns(ingestSession.id);
    const ingestSegments = await loadSegments(ingestSession.id);

    expect(ingestTurns.length).toBeGreaterThan(0);
    expect(projectTurns(ingestTurns)).toStrictEqual(projectTurns(oracleTurns));
    expect(projectSegments(ingestSegments)).toStrictEqual(projectSegments(oracleSegments));
  });

  test('re-POSTing the same item is a duplicate with no new rows, and re-deriving is idempotent', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const ingestSession = await findSession('ingest-session');
    const turnsBefore = await loadTurns(ingestSession.id);

    const response = await client.ingest({
      items: [snapshotItem('ingest-session', 'ingest-evt-1')],
    });
    expect(response.results[0]?.status).toBe('duplicate');

    const records = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, ingestSession.id));
    expect(records).toHaveLength(1);

    // Two more derive passes must not duplicate or drift the derived rows.
    await runExtractionOnce();
    await runExtractionOnce();
    const turnsAfter = await loadTurns(ingestSession.id);
    expect(projectTurns(turnsAfter)).toStrictEqual(projectTurns(turnsBefore));
  });

  test('a stored lifecycle-boundary event settles its interval like importLifecycleBoundaryEvent', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    // Oracle: settle the oracle session's active interval synchronously. The
    // settlement trigger must be a real raw event (activity_intervals has a FK to
    // raw_events), mirroring the CLI, which threads the inserted raw event's id.
    const oracleStopEvent = await Effect.runPromise(
      insertRawEvent(svc(), {
        actorId: 'codex',
        eventType: 'codex.Stop',
        externalEventId: 'oracle-stop-1',
        occurredAt: STOP_AT,
        payload: { hook_event_name: 'Stop', session_id: 'oracle-session' },
        provenance: { importedBy: 'ingest-test' },
        sourceBindingId,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );
    const oracleStop = await Effect.runPromise(
      importLifecycleBoundaryEvent(svc(), {
        activity: { hookEventName: 'Stop', settlementTriggerRawEventId: oracleStopEvent.id },
        author: { handle: 'drew' },
        capturedAt: STOP_AT,
        harness: 'codex',
        harnessSessionId: 'oracle-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        workspaceId,
      }),
    );
    expect(oracleStop.activityInterval.status).toBe('settled');
    expect(oracleStop.activityInterval.settlementReason).toBe('stop_event');

    // Ingest: POST a Stop raw event (no snapshot); the job settles the interval.
    const stopResponse = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.Stop',
            externalEventId: 'ingest-stop-1',
            occurredAt: STOP_AT,
            payload: { hook_event_name: 'Stop', session_id: 'ingest-session' },
            provenance: { importedBy: 'ingest-test' },
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
        },
      ],
    });
    expect(stopResponse.results[0]?.status).toBe('stored');

    await runExtractionOnce();

    const ingestSession = await findSession('ingest-session');
    const intervals = await activeIntervalFor(ingestSession.id);
    const settled = intervals.find((interval) => interval.settlementReason === 'stop_event');
    expect(settled).toBeDefined();
    expect(settled?.status).toBe('settled');

    const oracleSession = await findSession('oracle-session');
    expect(jsonify(ingestSession.status)).toStrictEqual(jsonify(oracleSession.status));
  });

  // --- livelock regressions the recorded-done redesign fixes ---

  test('a zero-turn snapshot is derived once (status=derived) and never re-processed', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const base = snapshotItem('zeroturn-session', 'zeroturn-evt-1');
    // A codex session_meta-only transcript normalizes to zero turns.
    const snapshot: IngestItem['snapshot'] =
      base.snapshot === undefined
        ? undefined
        : {
            ...base.snapshot,
            rawContent: JSON.stringify({ payload: { cwd: '/tmp/saga' }, type: 'session_meta' }),
          };
    const item: IngestItem = { envelope: base.envelope, snapshot };
    const response = await client.ingest({ items: [item] });
    const recordId = response.results[0]?.rawSessionRecordId ?? '';
    expect(response.results[0]?.status).toBe('stored');

    await runExtractionOnce();

    // Derived with zero turns — but it still left the queue (status='derived').
    const session = await findSession('zeroturn-session');
    await expect(loadTurns(session.id)).resolves.toHaveLength(0);
    const [derivedRecord] = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, recordId));
    expect(derivedRecord?.status).toBe('derived');

    // The old absence-of-turns query would re-match this forever; the status queue
    // does not. It is no longer discoverable, and a second run leaves it untouched.
    const pending = await Effect.runPromise(
      listRawSessionRecordsAwaitingDerivation(svc(), { limit: 1000 }),
    );
    expect(pending).not.toContain(recordId);
    await runExtractionOnce();
    await expect(loadTurns(session.id)).resolves.toHaveLength(0);
  });

  test('a lifecycle boundary with an updated outcome settles once and is not re-processed', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    // A session with an active interval (snapshot + derive).
    await client.ingest({ items: [snapshotItem('updated-session', 'updated-snap-1')] });
    await runExtractionOnce();
    const session = await findSession('updated-session');
    const intervalsBefore = await activeIntervalFor(session.id);
    const activeBefore = intervalsBefore.find((i) => i.status === 'active');
    expect(activeBefore).toBeDefined();

    // A plain SessionStart (source 'startup', not clear/compact) within the idle
    // window → 'updated' outcome: NO interval reference is written, which is
    // exactly what made the old absence scan loop forever.
    const startResponse = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.SessionStart',
            externalEventId: 'updated-start-1',
            occurredAt: '2026-06-21T14:02:00.000Z',
            payload: {
              hook_event_name: 'SessionStart',
              session_id: 'updated-session',
              source: 'startup',
            },
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
        },
      ],
    });
    expect(startResponse.results[0]?.status).toBe('stored');
    const rawEventId = startResponse.results[0]?.rawEventId ?? '';

    await runExtractionOnce();

    // The outcome is genuinely reference-less ('updated'/'unchanged'): no new
    // interval opened, the same interval stays active, and NO interval references
    // this event — precisely the class the old absence scan looped on.
    const intervalsAfter = await activeIntervalFor(session.id);
    expect(intervalsAfter).toHaveLength(intervalsBefore.length);
    const activeAfter = intervalsAfter.find((i) => i.status === 'active');
    expect(activeAfter?.id).toBe(activeBefore?.id);
    expect(
      intervalsAfter.some(
        (i) =>
          i.settlementTriggerRawEventId === rawEventId ||
          i.metadata.triggerRawEventId === rawEventId,
      ),
    ).toBe(false);

    // The queue row is terminal ('settled'), so it can never re-match.
    const [queued] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    expect(queued?.status).toBe('settled');
    const pending = await Effect.runPromise(
      listPendingLifecycleSettlements(svc(), { limit: 1000 }),
    );
    expect(pending).not.toContain(rawEventId);
    await runExtractionOnce();
    const [stillQueued] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    expect(stillQueued?.status).toBe('settled');
  });

  test('a poison snapshot is dead-lettered as failed after the attempt cap', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const response = await client.ingest({
      items: [snapshotItem('poison-session', 'poison-evt-1')],
    });
    const recordId = response.results[0]?.rawSessionRecordId ?? '';
    // Poison it: strip the activity interval so deriveStoredSessionRecord always throws.
    await svc()
      .db.update(rawSessionRecords)
      .set({ activityIntervalId: null })
      .where(eq(rawSessionRecords.id, recordId));

    for (let attempt = 0; attempt < MAX_DERIVATION_ATTEMPTS; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential attempts drive the cap
      const exit = await Effect.runPromiseExit(deriveStoredSessionRecord(svc(), recordId));
      expect(Exit.isFailure(exit)).toBe(true);
    }

    const [record] = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, recordId));
    expect(record?.status).toBe('failed');
    expect(Number(record?.metadata.derivationAttempts)).toBe(MAX_DERIVATION_ATTEMPTS);

    // A dead-lettered record has left the queue.
    const pending = await Effect.runPromise(
      listRawSessionRecordsAwaitingDerivation(svc(), { limit: 1000 }),
    );
    expect(pending).not.toContain(recordId);
  });

  // --- ack contract ---

  test('a malformed snapshot yields an error ack and does not half-store the raw event', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const response = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.UserPromptSubmit',
            externalEventId: 'malformed-evt-1',
            occurredAt: CAPTURED_AT,
            payload: {},
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
          // Missing required author/host/rawContent → coercion fails before any write.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately malformed for the test
          snapshot: { contentType: 'jsonl', harness: 'codex' } as IngestItem['snapshot'],
        },
      ],
    });
    const ack = response.results[0];
    expect(ack?.status).toBe('error');
    expect(ack?.index).toBe(0);
    expect(ack?.rawEventId).toBeUndefined();
    // The raw event was NOT stored: validation ran before insertRawEvent.
    const events = await svc()
      .db.select()
      .from(rawEvents)
      .where(eq(rawEvents.externalEventId, 'malformed-evt-1'));
    expect(events).toHaveLength(0);
  });

  test('a failure after the raw event persists still reports its rawEventId', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    // Valid envelope but a snapshot whose harness mismatches the (codex) binding:
    // the raw event stores, then storeRawSessionRecord throws on the binding check.
    const response = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.UserPromptSubmit',
            externalEventId: 'partial-evt-1',
            occurredAt: CAPTURED_AT,
            payload: {},
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
          snapshot: {
            author: { handle: 'drew' },
            contentType: 'jsonl',
            harness: 'claude',
            harnessSessionId: 'partial-session',
            host: { id: 'host-1' },
            rawContent: RAW_CONTENT,
          },
        },
      ],
    });
    const ack = response.results[0];
    expect(ack?.status).toBe('error');
    expect(ack?.rawEventId).toBeTypeOf('string');
    const events = await svc()
      .db.select()
      .from(rawEvents)
      .where(eq(rawEvents.externalEventId, 'partial-evt-1'));
    expect(events).toHaveLength(1);
  });

  test('every ack carries its positional index, even across mixed outcomes', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const response = await client.ingest({
      items: [
        // 0: a lifecycle boundary (no snapshot) → stored + enqueued.
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.SessionStart',
            externalEventId: 'idx-a',
            occurredAt: CAPTURED_AT,
            payload: { session_id: 'index-lifecycle' },
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
        },
        // 1: a malformed snapshot → error.
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.UserPromptSubmit',
            externalEventId: 'idx-b',
            occurredAt: CAPTURED_AT,
            payload: {},
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- deliberately malformed for the test
          snapshot: { contentType: 'jsonl' } as IngestItem['snapshot'],
        },
        // 2: a valid snapshot → stored.
        snapshotItem('index-session', 'idx-c'),
      ],
    });
    expect(response.results.map((r) => r.index)).toStrictEqual([0, 1, 2]);
    expect(response.results[0]?.externalEventId).toBe('idx-a');
    expect(response.results[1]?.status).toBe('error');
    expect(response.results[2]?.externalEventId).toBe('idx-c');
  });

  // --- crux regressions ---

  test('the job derives only the active snapshot, never a superseded one', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    // Two snapshots for one session, WITHOUT a derive between: the second
    // supersedes the first (marks it is_active=false), so both sit at 'captured'
    // — the older one inactive. If discovery ignored is_active it would derive the
    // superseded record and re-home the session's turns to it, clobbering the active.
    const olderContent = [
      JSON.stringify({ text: 'older superseded content', type: 'user' }),
      '',
    ].join('\n');
    const olderItem = snapshotItem('super-session', 'super-old-1');
    const olderSnapshot: IngestItem['snapshot'] =
      olderItem.snapshot === undefined
        ? undefined
        : { ...olderItem.snapshot, rawContent: olderContent };
    const older = await client.ingest({
      items: [{ envelope: olderItem.envelope, snapshot: olderSnapshot }],
    });
    const newer = await client.ingest({ items: [snapshotItem('super-session', 'super-new-1')] });
    const olderRecordId = older.results[0]?.rawSessionRecordId ?? '';
    const newerRecordId = newer.results[0]?.rawSessionRecordId ?? '';
    expect(olderRecordId).not.toBe(newerRecordId);

    // Both captured; the older one is now inactive.
    const [olderBefore] = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, olderRecordId));
    expect(olderBefore?.isActive).toBe(false);
    expect(olderBefore?.status).toBe('captured');

    // Discovery yields ONLY the active record.
    const pending = await Effect.runPromise(
      listRawSessionRecordsAwaitingDerivation(svc(), { limit: 1000 }),
    );
    expect(pending).toContain(newerRecordId);
    expect(pending).not.toContain(olderRecordId);

    await runExtractionOnce();
    await runExtractionOnce();

    // Every derived turn homes to the ACTIVE record; the superseded one was never
    // derived and never clobbered the active snapshot's rows.
    const session = await findSession('super-session');
    const turns = await loadTurns(session.id);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every((t) => t.rawSessionRecordId === newerRecordId)).toBe(true);
    const [olderAfter] = await svc()
      .db.select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, olderRecordId));
    expect(olderAfter?.status).toBe('captured');
    expect(olderAfter?.isActive).toBe(false);
  });

  test('a snapshot-less non-boundary event IS enqueued and settled once (CLI parity)', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    // The CLI calls importLifecycleBoundaryEvent for EVERY snapshot-less event, so
    // the twin enqueues every snapshot-less item regardless of type. The queue
    // settles each exactly once (no livelock), even a non-boundary event type.
    const response = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.PreToolUse',
            externalEventId: 'nonboundary-evt-1',
            occurredAt: CAPTURED_AT,
            payload: { session_id: 'nonboundary-session' },
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
        },
      ],
    });
    expect(response.results[0]?.status).toBe('stored');
    const rawEventId = response.results[0]?.rawEventId ?? '';

    // Enqueued for settlement (parity with the CLI).
    const [pendingRow] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    expect(pendingRow?.status).toBe('pending');

    await runExtractionOnce();

    // Settled exactly once; a second run does not re-process it.
    const [settledRow] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    expect(settledRow?.status).toBe('settled');
    const pending = await Effect.runPromise(
      listPendingLifecycleSettlements(svc(), { limit: 1000 }),
    );
    expect(pending).not.toContain(rawEventId);
    await runExtractionOnce();
    const [stillSettled] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    expect(stillSettled?.status).toBe('settled');
  });

  test('a snapshot missing both harnessSessionId and locator is a 400 with no raw event stored', async () => {
    if (client === undefined) {
      throw new Error('client not initialized');
    }
    const response = await client.ingest({
      items: [
        {
          envelope: {
            actorId: 'codex',
            eventType: 'codex.UserPromptSubmit',
            externalEventId: 'no-identity-evt-1',
            occurredAt: CAPTURED_AT,
            payload: {},
            provenance: {},
            sourceBindingId,
            sourceId: 'codex:local',
            sourceType: 'codex',
            trustLevel: 'raw',
            workspaceId,
          },
          // Valid otherwise, but neither harnessSessionId nor locator → 400 before write.
          snapshot: {
            author: { handle: 'drew' },
            contentType: 'jsonl',
            harness: 'codex',
            host: { id: 'host-1' },
            rawContent: RAW_CONTENT,
          },
        },
      ],
    });
    const ack = response.results[0];
    expect(ack?.status).toBe('error');
    expect(ack?.code).toBe('bad_request');
    expect(ack?.rawEventId).toBeUndefined();
    // No raw event was stored: the identity check runs before any write.
    const events = await svc()
      .db.select()
      .from(rawEvents)
      .where(eq(rawEvents.externalEventId, 'no-identity-evt-1'));
    expect(events).toHaveLength(0);
  });
});
