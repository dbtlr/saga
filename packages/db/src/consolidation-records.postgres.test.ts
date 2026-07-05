import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  ConsolidationRecordError,
  deleteConsolidationRecordsForSession,
  getConsolidationRecordByInterval,
  insertConsolidationRecord,
  listConsolidationRecordsBySession,
} from './consolidation-records.js';
import type { InsertConsolidationRecordInput } from './consolidation-records.js';
import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import {
  activityIntervals,
  consolidationDispositions,
  consolidationEvidencePointers,
  consolidationFindings,
  consolidationRecords,
  sessionRelationships,
  sessions,
  sourceBindings,
  users,
  workspaces,
} from './schema.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

function baseRecord(
  over: Partial<InsertConsolidationRecordInput> &
    Pick<InsertConsolidationRecordInput, 'activityIntervalId' | 'sessionId' | 'workspaceId'>,
): InsertConsolidationRecordInput {
  return {
    authPath: 'oauth',
    dispositions: [],
    findings: [],
    modelId: 'test-model',
    narrative: 'interval narrative',
    ...over,
  };
}

describePostgres('consolidation records', () => {
  const databaseName = `saga_consolidation_records_${Date.now().toString(36)}`;
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
  });

  afterAll(async () => {
    if (service !== undefined) {
      await Effect.runPromise(service.close());
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  function db(): DatabaseService {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    return service;
  }

  async function createWorkspace(prefix: string): Promise<string> {
    const [workspace] = await db()
      .db.insert(workspaces)
      .values({ handle: `${prefix}-${randomUUID()}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    return workspace.id;
  }

  async function createSession(workspaceId: string): Promise<string> {
    const [user] = await db()
      .db.insert(users)
      .values({ workspaceId, handle: `user-${randomUUID()}`, identitySource: 'test' })
      .returning();
    const [binding] = await db()
      .db.insert(sourceBindings)
      .values({ workspaceId, sourceType: 'test', sourceUri: `test://${randomUUID()}` })
      .returning();
    if (user === undefined || binding === undefined) {
      throw new Error('session prerequisites insert returned no row');
    }
    const [session] = await db()
      .db.insert(sessions)
      .values({
        workspaceId,
        sourceBindingId: binding.id,
        authorUserId: user.id,
        harness: 'test',
      })
      .returning();
    if (session === undefined) {
      throw new Error('session insert returned no row');
    }
    return session.id;
  }

  async function createInterval(
    workspaceId: string,
    sessionId: string,
    ordinal: number,
  ): Promise<string> {
    const [interval] = await db()
      .db.insert(activityIntervals)
      .values({ workspaceId, sessionId, ordinal, status: 'active', startedAt: new Date() })
      .returning();
    if (interval === undefined) {
      throw new Error('activity interval insert returned no row');
    }
    return interval.id;
  }

  async function linkContinuation(
    workspaceId: string,
    continuationSessionId: string,
    priorSessionId: string,
  ): Promise<void> {
    await db().db.insert(sessionRelationships).values({
      workspaceId,
      sourceSessionId: continuationSessionId,
      targetSessionId: priorSessionId,
      relationshipType: 'continuation',
      confidence: 'explicit',
    });
  }

  test('inserts a complete record and reads it back by interval', async () => {
    const workspaceId = await createWorkspace('insert');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const findingId = randomUUID();

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          modelId: 'gpt-test',
          authPath: 'api_key',
          findings: [
            {
              id: findingId,
              type: 'decision',
              text: 'Chose composite foreign keys.',
              evidence: [{ sessionId, activityIntervalOrdinal: 0, turnOrdinal: 3 }],
            },
          ],
        }),
      ),
    );

    expect(inserted.modelId).toBe('gpt-test');
    expect(inserted.authPath).toBe('api_key');
    expect(inserted.findings).toHaveLength(1);
    expect(inserted.findings[0]?.evidence[0]?.turnOrdinal).toBe(3);

    const fetched = await Effect.runPromise(
      getConsolidationRecordByInterval(db(), { workspaceId, activityIntervalId }),
    );
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.findings[0]?.id).toBe(findingId);
    expect(fetched?.findings[0]?.type).toBe('decision');
  });

  test('lists a session records in activity-interval order', async () => {
    const workspaceId = await createWorkspace('order');
    const sessionId = await createSession(workspaceId);
    const interval0 = await createInterval(workspaceId, sessionId, 0);
    const interval1 = await createInterval(workspaceId, sessionId, 1);

    // Insert the higher ordinal first to prove ordering is by interval ordinal.
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({ activityIntervalId: interval1, sessionId, workspaceId, narrative: 'second' }),
      ),
    );
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({ activityIntervalId: interval0, sessionId, workspaceId, narrative: 'first' }),
      ),
    );

    const records = await Effect.runPromise(
      listConsolidationRecordsBySession(db(), { workspaceId, sessionId }),
    );
    expect(records.map((record) => record.narrative)).toStrictEqual(['first', 'second']);
  });

  test('rejects a second record for the same interval', async () => {
    const workspaceId = await createWorkspace('unique');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    await Effect.runPromise(
      insertConsolidationRecord(db(), baseRecord({ activityIntervalId, sessionId, workspaceId })),
    );

    const exit = await Effect.runPromiseExit(
      insertConsolidationRecord(db(), baseRecord({ activityIntervalId, sessionId, workspaceId })),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  test('database rejects an invalid finding type', async () => {
    const workspaceId = await createWorkspace('findingtype');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const [record] = await db()
      .db.insert(consolidationRecords)
      .values({
        workspaceId,
        sessionId,
        activityIntervalId,
        narrative: 'n',
        modelId: 'm',
        authPath: 'a',
      })
      .returning();
    await expect(
      db()
        .db.insert(consolidationFindings)
        .values({
          workspaceId,
          sessionId,
          recordId: record?.id ?? '',
          ordinal: 0,
          findingType: 'speculation',
          text: 't',
        }),
    ).rejects.toBeInstanceOf(Error);
  });

  test('database rejects an invalid disposition kind and a self-loop', async () => {
    const workspaceId = await createWorkspace('disp');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const findingId = randomUUID();
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [{ id: findingId, type: 'decision', text: 't', evidence: [] }],
        }),
      ),
    );
    const [record] = await db()
      .db.select({ id: consolidationRecords.id })
      .from(consolidationRecords)
      .where(eq(consolidationRecords.activityIntervalId, activityIntervalId));
    const otherFindingId = randomUUID();
    await db()
      .db.insert(consolidationFindings)
      .values({
        id: otherFindingId,
        workspaceId,
        sessionId,
        recordId: record?.id ?? '',
        ordinal: 1,
        findingType: 'follow_up',
        text: 't2',
      });

    await expect(
      db()
        .db.insert(consolidationDispositions)
        .values({
          workspaceId,
          sessionId,
          recordId: record?.id ?? '',
          fromFindingId: findingId,
          toFindingId: otherFindingId,
          kind: 'contradicts',
        }),
    ).rejects.toBeInstanceOf(Error);

    await expect(
      db()
        .db.insert(consolidationDispositions)
        .values({
          workspaceId,
          sessionId,
          recordId: record?.id ?? '',
          fromFindingId: findingId,
          toFindingId: findingId,
          kind: 'builds_on',
        }),
    ).rejects.toBeInstanceOf(Error);
  });

  test('cascades deletes from record to findings, pointers, and dispositions', async () => {
    const workspaceId = await createWorkspace('cascade');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const findingA = randomUUID();
    const findingB = randomUUID();

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            {
              id: findingA,
              type: 'decision',
              text: 'a',
              evidence: [{ sessionId, turnOrdinal: 1 }],
            },
            { id: findingB, type: 'candidate_learning', text: 'b', evidence: [] },
          ],
          dispositions: [{ kind: 'builds_on', fromFindingId: findingB, toFindingId: findingA }],
        }),
      ),
    );

    await db().db.delete(consolidationRecords).where(eq(consolidationRecords.id, inserted.id));

    const findings = await db()
      .db.select()
      .from(consolidationFindings)
      .where(eq(consolidationFindings.recordId, inserted.id));
    const pointers = await db()
      .db.select()
      .from(consolidationEvidencePointers)
      .where(eq(consolidationEvidencePointers.findingId, findingA));
    const dispositions = await db()
      .db.select()
      .from(consolidationDispositions)
      .where(eq(consolidationDispositions.recordId, inserted.id));
    expect(findings).toHaveLength(0);
    expect(pointers).toHaveLength(0);
    expect(dispositions).toHaveLength(0);
  });

  test('chain-deletes every record for a session', async () => {
    const workspaceId = await createWorkspace('chain');
    const sessionId = await createSession(workspaceId);
    const interval0 = await createInterval(workspaceId, sessionId, 0);
    const interval1 = await createInterval(workspaceId, sessionId, 1);
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({ activityIntervalId: interval0, sessionId, workspaceId }),
      ),
    );
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({ activityIntervalId: interval1, sessionId, workspaceId }),
      ),
    );

    const deleted = await Effect.runPromise(
      deleteConsolidationRecordsForSession(db(), { workspaceId, sessionId }),
    );
    expect(deleted).toBe(2);
    const remaining = await Effect.runPromise(
      listConsolidationRecordsBySession(db(), { workspaceId, sessionId }),
    );
    expect(remaining).toHaveLength(0);
  });

  test('accepts a same-session disposition into an earlier record', async () => {
    const workspaceId = await createWorkspace('samelineage');
    const sessionId = await createSession(workspaceId);
    const interval0 = await createInterval(workspaceId, sessionId, 0);
    const interval1 = await createInterval(workspaceId, sessionId, 1);
    const earlierFinding = randomUUID();
    const laterFinding = randomUUID();

    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: interval0,
          sessionId,
          workspaceId,
          findings: [{ id: earlierFinding, type: 'decision', text: 'earlier', evidence: [] }],
        }),
      ),
    );
    const later = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: interval1,
          sessionId,
          workspaceId,
          findings: [{ id: laterFinding, type: 'follow_up', text: 'later', evidence: [] }],
          dispositions: [
            { kind: 'builds_on', fromFindingId: laterFinding, toFindingId: earlierFinding },
          ],
        }),
      ),
    );
    expect(later.dispositions).toHaveLength(1);
    expect(later.dispositions[0]?.toFindingId).toBe(earlierFinding);
  });

  test('accepts a disposition into an explicitly continued session', async () => {
    const workspaceId = await createWorkspace('continuation');
    const priorSessionId = await createSession(workspaceId);
    const priorInterval = await createInterval(workspaceId, priorSessionId, 0);
    const priorFinding = randomUUID();
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: priorInterval,
          sessionId: priorSessionId,
          workspaceId,
          findings: [{ id: priorFinding, type: 'decision', text: 'prior', evidence: [] }],
        }),
      ),
    );

    const continuationSessionId = await createSession(workspaceId);
    await linkContinuation(workspaceId, continuationSessionId, priorSessionId);
    const continuationInterval = await createInterval(workspaceId, continuationSessionId, 0);
    const continuationFinding = randomUUID();

    const record = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: continuationInterval,
          sessionId: continuationSessionId,
          workspaceId,
          findings: [{ id: continuationFinding, type: 'follow_up', text: 'cont', evidence: [] }],
          dispositions: [
            { kind: 'builds_on', fromFindingId: continuationFinding, toFindingId: priorFinding },
          ],
        }),
      ),
    );
    expect(record.dispositions[0]?.toFindingId).toBe(priorFinding);
  });

  test('rejects a disposition into an unrelated session', async () => {
    const workspaceId = await createWorkspace('unrelated');
    const unrelatedSessionId = await createSession(workspaceId);
    const unrelatedInterval = await createInterval(workspaceId, unrelatedSessionId, 0);
    const unrelatedFinding = randomUUID();
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: unrelatedInterval,
          sessionId: unrelatedSessionId,
          workspaceId,
          findings: [{ id: unrelatedFinding, type: 'decision', text: 'other', evidence: [] }],
        }),
      ),
    );

    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const localFinding = randomUUID();

    // Effect.flip moves the expected failure onto the success channel so the
    // assertions are unconditional; an unexpected success rejects runPromise.
    const error = await Effect.runPromise(
      Effect.flip(
        insertConsolidationRecord(
          db(),
          baseRecord({
            activityIntervalId,
            sessionId,
            workspaceId,
            findings: [{ id: localFinding, type: 'follow_up', text: 'local', evidence: [] }],
            dispositions: [
              { kind: 'builds_on', fromFindingId: localFinding, toFindingId: unrelatedFinding },
            ],
          }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ConsolidationRecordError);
    expect(error.message).toContain('continuation lineage');

    // The rejected write left nothing behind.
    const written = await db()
      .db.select()
      .from(consolidationRecords)
      .where(
        and(
          eq(consolidationRecords.workspaceId, workspaceId),
          eq(consolidationRecords.sessionId, sessionId),
        ),
      );
    expect(written).toHaveLength(0);
  });
});
