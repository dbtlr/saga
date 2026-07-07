import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import { insertRawEvent } from './raw-event.js';
import { applyExtractionBackfill, importRawSessionRecord } from './raw-session-import.js';
import {
  activityIntervals,
  lifecycleSettlementQueue,
  rawSessionRecords,
  sessionTurns,
  workspaces,
} from './schema.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const CONTENT = [
  JSON.stringify({ text: 'alpha user content', type: 'user' }),
  JSON.stringify({ text: 'beta assistant content', type: 'assistant' }),
  '',
].join('\n');

// Migration 0012's data backfill is only ever run against empty tables by the
// migration runner. This exercises it against a POPULATED pre-migration state (via
// applyExtractionBackfill, the callable twin of the migration's backfill SQL) and
// asserts the row-state transitions and idempotency.
describePostgres('extraction backfill (populated data)', () => {
  const databaseName = `saga_extraction_backfill_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let service: DatabaseService | undefined;

  const svc = (): DatabaseService => {
    if (service === undefined) {
      throw new Error('service not initialized');
    }
    return service;
  };

  const importOne = (harnessSessionId: string, externalEventId: string, workspaceId: string) =>
    Effect.runPromise(
      importRawSessionRecord(svc(), {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId,
        host: { id: `host-${externalEventId}`, label: 'local', projectRoot: '/tmp/saga' },
        rawContent: CONTENT,
        workspaceId,
      }),
    );

  const resetCaptured = async (ids: string[]): Promise<void> => {
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop -- small fixed set
      await svc()
        .db.update(rawSessionRecords)
        .set({ status: 'captured' })
        .where(eq(rawSessionRecords.id, id));
    }
  };

  const statusOf = async (id: string): Promise<string | undefined> => {
    const [row] = await svc()
      .db.select({ status: rawSessionRecords.status })
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, id));
    return row?.status;
  };

  const queueRowsFor = async (rawEventId: string): Promise<number> => {
    const rows = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, rawEventId));
    return rows.length;
  };

  let workspaceId = '';
  let sourceBindingId = '';
  let recordWithTurnsId = '';
  let recordNoTurnsId = '';
  let supersededId = '';
  let activeSupersedingId = '';
  let unsettledStopId = '';
  let settledStopId = '';

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: url.toString(),
          databaseUrlSource: 'environment',
          environment: 'test',
          logLevel: 'info',
          service: { host: '127.0.0.1', port: 4766 },
          secrets: { openaiApiKey: undefined },
        },
        { postgres: { max: 10 } },
      ),
    );
    await Effect.runPromise(runMigrations(service));

    const [workspace] = await service.db
      .insert(workspaces)
      .values({ handle: `backfill-${Date.now().toString(36)}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    workspaceId = workspace.id;

    // (a) a captured record that HAS turns.
    const a = await importOne('bf-a', 'bf-a', workspaceId);
    recordWithTurnsId = a.rawSessionRecord.id;
    sourceBindingId = a.sourceBinding.id;

    // (b) a captured record with NO turns (delete the derived turns).
    const b = await importOne('bf-b', 'bf-b', workspaceId);
    recordNoTurnsId = b.rawSessionRecord.id;
    await service.db.delete(sessionTurns).where(eq(sessionTurns.sessionId, b.session.id));

    // (c) a superseded (is_active=false) captured record + its active successor.
    const c1 = await importOne('bf-c', 'bf-c-1', workspaceId);
    const c2 = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:01:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'bf-c',
        host: { id: 'host-bf-c-1', label: 'local', projectRoot: '/tmp/saga' },
        rawContent: [JSON.stringify({ text: 'newer content', type: 'user' }), ''].join('\n'),
        workspaceId,
      }),
    );
    supersededId = c1.rawSessionRecord.id;
    activeSupersedingId = c2.rawSessionRecord.id;

    // Simulate the pre-migration state: nothing had ever advanced status.
    await resetCaptured([recordWithTurnsId, recordNoTurnsId, supersededId, activeSupersedingId]);

    // (d) an UNSETTLED Stop event: no activity_interval references it.
    const unsettled = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'codex',
        eventType: 'codex.Stop',
        externalEventId: 'bf-unsettled-stop',
        occurredAt: '2026-06-21T14:02:00.000Z',
        payload: {},
        provenance: {},
        sourceBindingId,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );
    unsettledStopId = unsettled.id;

    // (e) a SETTLED Stop event: an activity_interval references it as its trigger.
    const settled = await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'codex',
        eventType: 'codex.Stop',
        externalEventId: 'bf-settled-stop',
        occurredAt: '2026-06-21T14:03:00.000Z',
        payload: {},
        provenance: {},
        sourceBindingId,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );
    settledStopId = settled.id;
    const e = await importOne('bf-e-session', 'bf-e', workspaceId);
    await service.db
      .update(activityIntervals)
      .set({ settlementTriggerRawEventId: settledStopId })
      .where(eq(activityIntervals.id, e.activityInterval.id));
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('marks all captured history derived and enqueues only unsettled boundaries', async () => {
    // Pre-state sanity: everything captured.
    await expect(statusOf(recordWithTurnsId)).resolves.toBe('captured');
    await expect(statusOf(recordNoTurnsId)).resolves.toBe('captured');
    await expect(statusOf(supersededId)).resolves.toBe('captured');
    await expect(statusOf(activeSupersedingId)).resolves.toBe('captured');

    await Effect.runPromise(applyExtractionBackfill(svc()));

    // (a)+(b)+(c) — including the zero-turn and the superseded record — all derived.
    await expect(statusOf(recordWithTurnsId)).resolves.toBe('derived');
    await expect(statusOf(recordNoTurnsId)).resolves.toBe('derived');
    await expect(statusOf(supersededId)).resolves.toBe('derived');
    await expect(statusOf(activeSupersedingId)).resolves.toBe('derived');

    // (d) enqueued 'pending'; (e) NOT enqueued (already settled).
    const [unsettledRow] = await svc()
      .db.select()
      .from(lifecycleSettlementQueue)
      .where(eq(lifecycleSettlementQueue.rawEventId, unsettledStopId));
    expect(unsettledRow?.status).toBe('pending');
    await expect(queueRowsFor(settledStopId)).resolves.toBe(0);
  });

  test('re-running the backfill is idempotent (no churn, no dupes)', async () => {
    const queuedBefore = await svc().db.select().from(lifecycleSettlementQueue);

    await Effect.runPromise(applyExtractionBackfill(svc()));

    // Statuses unchanged; queue row count unchanged (ON CONFLICT DO NOTHING).
    await expect(statusOf(recordWithTurnsId)).resolves.toBe('derived');
    const queuedAfter = await svc().db.select().from(lifecycleSettlementQueue);
    expect(queuedAfter).toHaveLength(queuedBefore.length);
    await expect(queueRowsFor(unsettledStopId)).resolves.toBe(1);
    await expect(queueRowsFor(settledStopId)).resolves.toBe(0);
  });
});
