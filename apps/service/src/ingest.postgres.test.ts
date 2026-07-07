import { SagaApiClient } from '@saga/api-client';
import type { IngestItem } from '@saga/api-client';
import {
  activityIntervals,
  importLifecycleBoundaryEvent,
  importRawSessionRecord,
  insertRawEvent,
  makeDatabase,
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
import { Effect } from 'effect';
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
});
