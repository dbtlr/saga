import { randomUUID } from 'node:crypto';

import { ConsolidationRecord } from '@saga/contracts';
import { and, eq } from 'drizzle-orm';
import { Effect, Exit, Schema } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import {
  ConsolidationRecordError,
  deleteConsolidationRecordsForLineage,
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

  test('mints finding ids, inserts a complete record, and reads it back by interval', async () => {
    const workspaceId = await createWorkspace('insert');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

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
              key: 'a',
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
    // The finding id is a system-minted UUID, not the local key.
    expect(inserted.findings[0]?.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(inserted.findings[0]?.evidence[0]?.turnOrdinal).toBe(3);

    const fetched = await Effect.runPromise(
      getConsolidationRecordByInterval(db(), { workspaceId, activityIntervalId }),
    );
    expect(fetched?.id).toBe(inserted.id);
    expect(fetched?.findings[0]?.id).toBe(inserted.findings[0]?.id);
    expect(fetched?.findings[0]?.type).toBe('decision');
  });

  test('assembled insert detail matches the read path (parity)', async () => {
    const workspaceId = await createWorkspace('parity');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            {
              key: 'a',
              type: 'decision',
              text: 'a',
              evidence: [
                { sessionId, activityIntervalOrdinal: 0, turnOrdinal: 1 },
                { sessionId, turnOrdinal: 2 },
              ],
            },
            { key: 'b', type: 'follow_up', text: 'b', evidence: [] },
          ],
          dispositions: [{ kind: 'builds_on', fromKey: 'b', toKey: 'a' }],
        }),
      ),
    );

    const fetched = await Effect.runPromise(
      getConsolidationRecordByInterval(db(), { workspaceId, activityIntervalId }),
    );
    expect(fetched).toStrictEqual(inserted);
  });

  test('a persisted record detail decodes against the ConsolidationRecord contract', async () => {
    const workspaceId = await createWorkspace('roundtrip');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            // no ordinals -> absent decodes as undefined (not null) against the contract
            { key: 'a', type: 'decision', text: 'a', evidence: [{ sessionId }] },
          ],
        }),
      ),
    );

    const decoded = Schema.decodeUnknownSync(ConsolidationRecord)(inserted);
    expect(decoded.id).toBe(inserted.id);
    expect(decoded.findings[0]?.id).toBe(inserted.findings[0]?.id);
  });

  test('round-trips evidence pointers in their emitted order', async () => {
    const workspaceId = await createWorkspace('pointerorder');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            {
              key: 'a',
              type: 'decision',
              text: 'ordered',
              evidence: [
                { sessionId, turnOrdinal: 100 },
                { sessionId, turnOrdinal: 200 },
                { sessionId, turnOrdinal: 300 },
              ],
            },
          ],
        }),
      ),
    );
    expect(inserted.findings[0]?.evidence.map((pointer) => pointer.turnOrdinal)).toStrictEqual([
      100, 200, 300,
    ]);

    const fetched = await Effect.runPromise(
      getConsolidationRecordByInterval(db(), { workspaceId, activityIntervalId }),
    );
    expect(fetched?.findings[0]?.evidence.map((pointer) => pointer.turnOrdinal)).toStrictEqual([
      100, 200, 300,
    ]);
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

  test('rejects a duplicate local finding key before minting', async () => {
    const workspaceId = await createWorkspace('dupkey');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const error = await Effect.runPromise(
      Effect.flip(
        insertConsolidationRecord(
          db(),
          baseRecord({
            activityIntervalId,
            sessionId,
            workspaceId,
            findings: [
              { key: 'dup', type: 'decision', text: 'first', evidence: [] },
              { key: 'dup', type: 'follow_up', text: 'second', evidence: [] },
            ],
          }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ConsolidationRecordError);
    expect(error.message).toContain('duplicate finding key');

    const written = await db()
      .db.select()
      .from(consolidationRecords)
      .where(eq(consolidationRecords.sessionId, sessionId));
    expect(written).toHaveLength(0);
  });

  test('rejects a disposition whose local target key names no finding', async () => {
    const workspaceId = await createWorkspace('unknownkey');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const error = await Effect.runPromise(
      Effect.flip(
        insertConsolidationRecord(
          db(),
          baseRecord({
            activityIntervalId,
            sessionId,
            workspaceId,
            findings: [{ key: 'a', type: 'decision', text: 'a', evidence: [] }],
            dispositions: [{ kind: 'builds_on', fromKey: 'a', toKey: 'missing' }],
          }),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ConsolidationRecordError);
    expect(error.message).toContain('is not a finding in this record');
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
    const record = await Effect.runPromise(
      insertConsolidationRecord(db(), baseRecord({ activityIntervalId, sessionId, workspaceId })),
    );
    // Bypass the typed API to prove the check constraint owns the finding type.
    await expect(
      db().sql`
        insert into consolidation_findings (workspace_id, session_id, record_id, ordinal, finding_type, text)
        values (${workspaceId}, ${sessionId}, ${record.id}, 0, 'speculation', 't')
      `,
    ).rejects.toBeInstanceOf(Error);
  });

  test('database rejects an invalid disposition kind and a self-loop', async () => {
    const workspaceId = await createWorkspace('disp');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);
    const record = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            { key: 'a', type: 'decision', text: 't', evidence: [] },
            { key: 'b', type: 'follow_up', text: 't2', evidence: [] },
          ],
        }),
      ),
    );
    const findingA = record.findings[0]?.id ?? '';
    const findingB = record.findings[1]?.id ?? '';

    await expect(
      db().sql`
        insert into consolidation_dispositions
          (workspace_id, session_id, record_id, from_finding_id, to_finding_id, kind, ordinal)
        values (${workspaceId}, ${sessionId}, ${record.id}, ${findingA}, ${findingB}, 'contradicts', 5)
      `,
    ).rejects.toBeInstanceOf(Error);

    await expect(
      db().sql`
        insert into consolidation_dispositions
          (workspace_id, session_id, record_id, from_finding_id, to_finding_id, kind, ordinal)
        values (${workspaceId}, ${sessionId}, ${record.id}, ${findingA}, ${findingA}, 'builds_on', 6)
      `,
    ).rejects.toBeInstanceOf(Error);
  });

  test('cascades deletes from record to findings, pointers, and dispositions', async () => {
    const workspaceId = await createWorkspace('cascade');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            { key: 'a', type: 'decision', text: 'a', evidence: [{ sessionId, turnOrdinal: 1 }] },
            { key: 'b', type: 'candidate_learning', text: 'b', evidence: [] },
          ],
          dispositions: [{ kind: 'builds_on', fromKey: 'b', toKey: 'a' }],
        }),
      ),
    );
    const findingA = inserted.findings[0]?.id ?? '';

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

  test('deleting an activity interval cascades into the consolidation tables', async () => {
    const workspaceId = await createWorkspace('interval-cascade');
    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

    const inserted = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId,
          sessionId,
          workspaceId,
          findings: [
            { key: 'a', type: 'decision', text: 'a', evidence: [{ sessionId, turnOrdinal: 1 }] },
          ],
        }),
      ),
    );

    await db().db.delete(activityIntervals).where(eq(activityIntervals.id, activityIntervalId));

    const records = await db()
      .db.select()
      .from(consolidationRecords)
      .where(eq(consolidationRecords.id, inserted.id));
    const findings = await db()
      .db.select()
      .from(consolidationFindings)
      .where(eq(consolidationFindings.recordId, inserted.id));
    const pointers = await db()
      .db.select()
      .from(consolidationEvidencePointers)
      .where(eq(consolidationEvidencePointers.findingId, inserted.findings[0]?.id ?? ''));
    expect(records).toHaveLength(0);
    expect(findings).toHaveLength(0);
    expect(pointers).toHaveLength(0);
  });

  test('lineage delete removes the record chains of every continuation-linked session', async () => {
    const workspaceId = await createWorkspace('lineage-delete');
    const priorSessionId = await createSession(workspaceId);
    const priorInterval = await createInterval(workspaceId, priorSessionId, 0);
    const prior = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: priorInterval,
          sessionId: priorSessionId,
          workspaceId,
          findings: [{ key: 'p', type: 'decision', text: 'prior', evidence: [] }],
        }),
      ),
    );
    const priorFindingId = prior.findings[0]?.id ?? '';

    const continuationSessionId = await createSession(workspaceId);
    await linkContinuation(workspaceId, continuationSessionId, priorSessionId);
    const continuationInterval = await createInterval(workspaceId, continuationSessionId, 0);
    // A cross-record disposition edge into the prior session's finding.
    await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: continuationInterval,
          sessionId: continuationSessionId,
          workspaceId,
          findings: [{ key: 'c', type: 'follow_up', text: 'cont', evidence: [] }],
          dispositions: [{ kind: 'builds_on', fromKey: 'c', toFindingId: priorFindingId }],
        }),
      ),
    );

    // Deleting from either session's lineage removes BOTH chains.
    const deleted = await Effect.runPromise(
      deleteConsolidationRecordsForLineage(db(), {
        workspaceId,
        sessionId: continuationSessionId,
      }),
    );
    expect(deleted).toBe(2);

    const priorRemaining = await Effect.runPromise(
      listConsolidationRecordsBySession(db(), { workspaceId, sessionId: priorSessionId }),
    );
    const continuationRemaining = await Effect.runPromise(
      listConsolidationRecordsBySession(db(), { workspaceId, sessionId: continuationSessionId }),
    );
    expect(priorRemaining).toHaveLength(0);
    expect(continuationRemaining).toHaveLength(0);
  });

  test('accepts a same-session cross-record disposition into an earlier record', async () => {
    const workspaceId = await createWorkspace('samelineage');
    const sessionId = await createSession(workspaceId);
    const interval0 = await createInterval(workspaceId, sessionId, 0);
    const interval1 = await createInterval(workspaceId, sessionId, 1);

    const earlier = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: interval0,
          sessionId,
          workspaceId,
          findings: [{ key: 'earlier', type: 'decision', text: 'earlier', evidence: [] }],
        }),
      ),
    );
    const earlierFindingId = earlier.findings[0]?.id ?? '';

    const later = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: interval1,
          sessionId,
          workspaceId,
          findings: [{ key: 'later', type: 'follow_up', text: 'later', evidence: [] }],
          dispositions: [{ kind: 'builds_on', fromKey: 'later', toFindingId: earlierFindingId }],
        }),
      ),
    );
    expect(later.dispositions).toHaveLength(1);
    expect(later.dispositions[0]?.toFindingId).toBe(earlierFindingId);
  });

  test('accepts a disposition into an explicitly continued session', async () => {
    const workspaceId = await createWorkspace('continuation');
    const priorSessionId = await createSession(workspaceId);
    const priorInterval = await createInterval(workspaceId, priorSessionId, 0);
    const prior = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: priorInterval,
          sessionId: priorSessionId,
          workspaceId,
          findings: [{ key: 'prior', type: 'decision', text: 'prior', evidence: [] }],
        }),
      ),
    );
    const priorFindingId = prior.findings[0]?.id ?? '';

    const continuationSessionId = await createSession(workspaceId);
    await linkContinuation(workspaceId, continuationSessionId, priorSessionId);
    const continuationInterval = await createInterval(workspaceId, continuationSessionId, 0);

    const record = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: continuationInterval,
          sessionId: continuationSessionId,
          workspaceId,
          findings: [{ key: 'cont', type: 'follow_up', text: 'cont', evidence: [] }],
          dispositions: [{ kind: 'builds_on', fromKey: 'cont', toFindingId: priorFindingId }],
        }),
      ),
    );
    expect(record.dispositions[0]?.toFindingId).toBe(priorFindingId);
  });

  test('rejects a disposition into an unrelated session', async () => {
    const workspaceId = await createWorkspace('unrelated');
    const unrelatedSessionId = await createSession(workspaceId);
    const unrelatedInterval = await createInterval(workspaceId, unrelatedSessionId, 0);
    const unrelated = await Effect.runPromise(
      insertConsolidationRecord(
        db(),
        baseRecord({
          activityIntervalId: unrelatedInterval,
          sessionId: unrelatedSessionId,
          workspaceId,
          findings: [{ key: 'other', type: 'decision', text: 'other', evidence: [] }],
        }),
      ),
    );
    const unrelatedFindingId = unrelated.findings[0]?.id ?? '';

    const sessionId = await createSession(workspaceId);
    const activityIntervalId = await createInterval(workspaceId, sessionId, 0);

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
            findings: [{ key: 'local', type: 'follow_up', text: 'local', evidence: [] }],
            dispositions: [
              { kind: 'builds_on', fromKey: 'local', toFindingId: unrelatedFindingId },
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
