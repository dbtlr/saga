import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { insertConsolidationRecord } from './consolidation-records.js';
import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import { insertRawEvent } from './raw-event.js';
import { importRawSessionRecord } from './raw-session-import.js';
import {
  activityIntervals,
  consolidationDispositions,
  consolidationEvidencePointers,
  consolidationFindings,
  consolidationRecords,
  rawEvents,
  rawSessionRecords,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sessions,
  workspaces,
} from './schema.js';
import { expandRecallContext, searchSessionRecall } from './session-recall.js';
import { getSessionDetail, listRecentSessionRecords } from './session-records.js';
import { deleteSessionSafety, redactSessionSafety } from './session-safety.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('session safety', () => {
  const databaseName = `saga_session_safety_${Date.now().toString(36)}`;
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
            max: 1,
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

  test('redacts the active raw snapshot without exposing the prior sensitive snapshot', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-redact');
    const secretOrigin = 'origin-secret-token';
    const secretReason = 'reason-secret-token';
    const imported = await seedRawSession(service, {
      harnessSessionId: 'safety-redact',
      rawContent:
        '{"type":"user","text":"Store API_KEY=super-secret-token in the notes"}\n{"type":"assistant","text":"I recorded super-secret-token for follow-up"}\n',
      workspaceId,
    });
    const rawEvent = await seedAssociatedRawEvent(service, {
      externalEventId: 'safety-redact-event',
      imported,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Store API_KEY=super-secret-token in the notes',
      },
      provenance: {
        prompt: 'super-secret-token entered through hook payload',
        transcriptPath: '/tmp/safety-redact.jsonl',
      },
      traceId: 'safety-redact-turn',
      workspaceId,
    });
    const turnLinkedRawEvent = await seedAssociatedRawEvent(service, {
      externalEventId: 'safety-redact-turn-linked-event',
      imported,
      payload: {
        prompt: 'Turn linked super-secret-token evidence',
      },
      provenance: {
        prompt: 'Turn-only super-secret-token provenance',
      },
      sessionId: 'turn-linked-redact-session',
      traceId: 'safety-redact-turn-linked',
      workspaceId,
    });
    await linkTurnsToRawEvent(service, {
      rawEventId: turnLinkedRawEvent.id,
      sessionId: imported.session.id,
    });

    const redacted = await Effect.runPromise(
      redactSessionSafety(service, {
        id: imported.session.id,
        origin: secretOrigin,
        patterns: [{ kind: 'literal', pattern: 'super-secret-token' }],
        reason: secretReason,
        workspaceId,
      }),
    );

    expect(redacted).toMatchObject({
      operation: 'redacted',
      originClassification: 'custom',
      patternCount: 1,
      previousRawSessionRecordId: imported.rawSessionRecord.id,
      reasonProvided: true,
      redactedRawEvents: 2,
      replacementCount: 2,
      sessionId: imported.session.id,
      workspaceId,
    });
    expect(JSON.stringify(redacted)).not.toContain(secretOrigin);
    expect(JSON.stringify(redacted)).not.toContain(secretReason);
    expect(JSON.stringify(redacted)).not.toContain('super-secret-token');

    const rawRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, imported.session.id))
      .orderBy(rawSessionRecords.snapshotOrdinal);
    expect(rawRecords).toHaveLength(2);
    expect(rawRecords[0]).toMatchObject({
      id: imported.rawSessionRecord.id,
      isActive: false,
      status: 'redacted',
    });
    expect(rawRecords[1]).toMatchObject({
      isActive: true,
      redactedFromRawSessionRecordId: imported.rawSessionRecord.id,
      snapshotOrdinal: 1,
      status: 'redacted',
    });
    expect(rawRecords[1]?.bodyText).toContain('[REDACTED]');
    expect(rawRecords[1]?.bodyText).not.toContain('super-secret-token');
    // ADR-0034: the superseded (inactive) snapshot must not retain the sensitive bytes in its body
    // columns — hard redaction scrubs body_text/body_json, keeping only non-sensitive tombstone
    // metadata. A direct read of the inactive row must not recover the secret.
    expect(rawRecords[0]?.bodyText).toBeNull();
    expect(rawRecords[0]?.bodyJson).toBeNull();
    expect(JSON.stringify(rawRecords[0])).not.toContain('super-secret-token');
    const auditPayload = JSON.stringify(
      rawRecords.map((record) => ({
        metadata: record.metadata,
        provenance: record.provenance,
      })),
    );
    expect(auditPayload).not.toContain(secretOrigin);
    expect(auditPayload).not.toContain(secretReason);
    expect(auditPayload).not.toContain('super-secret-token');

    const turns = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, imported.session.id));
    const segments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, imported.session.id));
    expect(turns.every((turn) => turn.rawSessionRecordId === rawRecords[1]?.id)).toBe(true);
    expect(segments.every((segment) => segment.rawSessionRecordId === rawRecords[1]?.id)).toBe(
      true,
    );
    expect(JSON.stringify(turns)).not.toContain('super-secret-token');
    expect(JSON.stringify(segments)).not.toContain('super-secret-token');

    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.rawSessionRecord.id,
        includeRawBody: true,
        workspaceId,
      }),
    );
    expect(detail.rawSessionRecords.map((record) => record.id)).not.toContain(
      imported.rawSessionRecord.id,
    );
    expect(detail.selectedRawSessionRecord).toBeNull();
    expect(JSON.stringify(detail)).not.toContain('super-secret-token');
    expect(JSON.stringify(detail)).not.toContain(secretOrigin);
    expect(JSON.stringify(detail)).not.toContain(secretReason);

    const recent = await Effect.runPromise(
      listRecentSessionRecords(service, {
        workspaceId,
      }),
    );
    expect(recent.map((record) => record.rawSessionRecord.id)).not.toContain(
      imported.rawSessionRecord.id,
    );
    expect(JSON.stringify(recent)).not.toContain('super-secret-token');
    expect(JSON.stringify(recent)).not.toContain(secretOrigin);
    expect(JSON.stringify(recent)).not.toContain(secretReason);
    // The listed count must match the fetchable set: the hard-redacted inactive
    // snapshot is hidden from listings, so it must not be counted either.
    const recentEntry = recent.find((record) => record.session.id === imported.session.id);
    expect(recentEntry?.counts.rawSessionRecords).toBe(1);

    const recall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'super-secret-token',
        workspaceId,
      }),
    );
    expect(recall.matchCount).toBe(0);

    const [redactedRawEvent] = await service.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, rawEvent.id));
    expect(redactedRawEvent).toBeDefined();
    expect(JSON.stringify(redactedRawEvent)).not.toContain('super-secret-token');
    expect(JSON.stringify(redactedRawEvent?.payload)).toContain('[REDACTED]');
    expect(redactedRawEvent?.provenance).toMatchObject({
      sagaSessionSafety: {
        operation: 'redacted',
        rawEventId: rawEvent.id,
      },
    });
    const [redactedTurnLinkedRawEvent] = await service.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.id, turnLinkedRawEvent.id));
    expect(JSON.stringify(redactedTurnLinkedRawEvent)).not.toContain('super-secret-token');
    expect(JSON.stringify(redactedTurnLinkedRawEvent?.payload)).toContain('[REDACTED]');
  });

  test('hard redaction scrubs every inactive snapshot body, not just the just-superseded one', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-multi-snapshot');
    const harnessSessionId = 'safety-multi-snapshot';
    // Two content updates before redaction → snapshotOrdinal 0 (inactive) and 1 (active), both
    // holding the secret; redaction supersedes only the active one, so ordinal 0 must also be scrubbed.
    const first = await seedRawSession(service, {
      harnessSessionId,
      rawContent: '{"type":"user","text":"early super-secret-token"}\n',
      workspaceId,
    });
    const second = await seedRawSession(service, {
      harnessSessionId,
      rawContent:
        '{"type":"user","text":"early super-secret-token"}\n{"type":"assistant","text":"later super-secret-token"}\n',
      workspaceId,
    });
    expect(second.session.id).toBe(first.session.id);

    await Effect.runPromise(
      redactSessionSafety(service, {
        id: first.session.id,
        patterns: [{ kind: 'literal', pattern: 'super-secret-token' }],
        workspaceId,
      }),
    );

    const inactiveRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(
        and(
          eq(rawSessionRecords.sessionId, first.session.id),
          eq(rawSessionRecords.isActive, false),
        ),
      );
    expect(inactiveRecords.length).toBeGreaterThanOrEqual(2);
    for (const record of inactiveRecords) {
      expect(record.bodyText).toBeNull();
      expect(record.bodyJson).toBeNull();
    }
    expect(JSON.stringify(inactiveRecords)).not.toContain('super-secret-token');
  });

  test('redaction leaves no secret-bearing segment embeddings (ADR-0039)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-embedding-wipe');
    const imported = await seedRawSession(service, {
      harnessSessionId: 'safety-embedding-wipe',
      rawContent:
        '{"type":"user","text":"Store API_KEY=super-secret-token in the notes"}\n{"type":"assistant","text":"I recorded super-secret-token for follow-up"}\n',
      workspaceId,
    });

    // Simulate the indexer having embedded the pre-redaction (secret-bearing) segments: seed a vector
    // for each. ADR-0039 requires redaction to leave no vector that encodes the scrubbed text.
    const preSegments = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, imported.session.id));
    expect(preSegments.length).toBeGreaterThan(0);
    expect(preSegments.some((segment) => segment.searchText.includes('super-secret-token'))).toBe(
      true,
    );
    for (const segment of preSegments) {
      await service.db.insert(sessionSegmentEmbeddings).values({
        dimensions: 3,
        embedding: [0.1, 0.2, 0.3],
        inputHash: `sha256:${segment.id}`,
        model: 'text-embedding-3-small',
        provider: 'openai',
        rawSessionRecordId: imported.rawSessionRecord.id,
        segmentId: segment.id,
        workspaceId,
      });
    }

    await Effect.runPromise(
      redactSessionSafety(service, {
        id: imported.session.id,
        patterns: [{ kind: 'literal', pattern: 'super-secret-token' }],
        workspaceId,
      }),
    );

    // The pre-redaction segments and their (secret-bearing) embeddings are wiped by the regenerate
    // path; the surviving segments were rebuilt from redacted content.
    const embeddings = await service.db
      .select({ segmentId: sessionSegmentEmbeddings.segmentId })
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.workspaceId, workspaceId));
    expect(embeddings).toHaveLength(0);

    const postSegments = await service.db
      .select({ searchText: sessionSegments.searchText })
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, imported.session.id));
    expect(postSegments.length).toBeGreaterThan(0);
    expect(postSegments.some((segment) => segment.searchText.includes('super-secret-token'))).toBe(
      false,
    );
  });

  test('rejects invalid regex patterns without echoing sensitive pattern text', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-invalid-regex');
    const secretNeedle = 'regex-secret-token';
    const rawPattern = `${secretNeedle}(`;
    const imported = await seedRawSession(service, {
      harnessSessionId: 'safety-invalid-regex',
      rawContent: '{"type":"user","text":"This session remains unchanged"}\n',
      workspaceId,
    });

    await expect(
      Effect.runPromise(
        redactSessionSafety(service, {
          id: imported.session.id,
          patterns: [{ kind: 'regex', pattern: rawPattern }],
          workspaceId,
        }),
      ),
    ).rejects.toThrow('invalid redaction regex pattern at index 1: invalid syntax');

    let errorText: string | undefined;
    try {
      await Effect.runPromise(
        redactSessionSafety(service, {
          id: imported.session.id,
          patterns: [{ kind: 'regex', pattern: rawPattern }],
          workspaceId,
        }),
      );
    } catch (cause) {
      errorText = String(cause);
    }

    expect(errorText).toBeDefined();
    expect(errorText).toContain('invalid redaction regex pattern');
    expect(errorText).not.toContain(secretNeedle);
    expect(errorText).not.toContain(rawPattern);
    expect(errorText).not.toContain(`/${rawPattern}/`);

    const rawRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, imported.session.id));
    expect(rawRecords).toHaveLength(1);
    expect(JSON.stringify(rawRecords)).not.toContain(secretNeedle);
    expect(JSON.stringify(rawRecords)).not.toContain(rawPattern);
  });

  test('deletes a session and all recall-derived rows', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-delete');
    const secretReason = 'delete-reason-secret-token';
    const imported = await seedRawSession(service, {
      harnessSessionId: 'safety-delete',
      rawContent: '{"type":"user","text":"Delete-only sentinel phrase"}\n',
      workspaceId,
    });
    const rawEvent = await seedAssociatedRawEvent(service, {
      externalEventId: 'safety-delete-event',
      imported,
      payload: {
        prompt: 'Delete-only sentinel phrase',
      },
      provenance: {
        transcriptPath: '/tmp/safety-delete.jsonl',
      },
      traceId: 'safety-delete-turn',
      workspaceId,
    });
    const turnLinkedRawEvent = await seedAssociatedRawEvent(service, {
      externalEventId: 'safety-delete-turn-linked-event',
      imported,
      payload: {
        prompt: 'Delete-only sentinel phrase',
      },
      provenance: {
        transcriptPath: '/tmp/safety-delete-turn-linked.jsonl',
      },
      sessionId: 'turn-linked-delete-session',
      traceId: 'safety-delete-turn-linked',
      workspaceId,
    });
    await linkTurnsToRawEvent(service, {
      rawEventId: turnLinkedRawEvent.id,
      sessionId: imported.session.id,
    });

    const [segment] = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, imported.session.id))
      .limit(1);
    if (segment === undefined) {
      throw new Error('session segment was not inserted');
    }
    await service.sql`
      insert into session_segment_embeddings (
        workspace_id,
        segment_id,
        raw_session_record_id,
        provider,
        model,
        dimensions,
        embedding,
        input_hash
      )
      values (
        ${workspaceId},
        ${segment.id},
        ${imported.rawSessionRecord.id},
        'fixture',
        'fixture-embedding',
        3,
        '[1,2,3]'::vector,
        'sha256:fixture'
      )
    `;

    const deleted = await Effect.runPromise(
      deleteSessionSafety(service, {
        id: imported.rawSessionRecord.id,
        origin: 'test',
        reason: secretReason,
        workspaceId,
      }),
    );
    expect(deleted).toMatchObject({
      deleted: {
        embeddings: 1,
        rawEvents: 2,
        rawSessionRecords: 1,
        segments: 1,
        turns: 1,
      },
      operation: 'deleted',
      originClassification: 'test',
      reasonProvided: true,
      sessionId: imported.session.id,
      workspaceId,
    });
    expect(JSON.stringify(deleted)).not.toContain(secretReason);

    await expect(
      Effect.runPromise(
        getSessionDetail(service, {
          id: imported.session.id,
          includeRawBody: true,
          workspaceId,
        }),
      ),
    ).rejects.toThrow('not found');
    await expect(countRows(service, 'sessions', imported.session.id)).resolves.toBe(0);
    await expect(countRows(service, 'raw_session_records', imported.session.id)).resolves.toBe(0);
    await expect(countRows(service, 'session_turns', imported.session.id)).resolves.toBe(0);
    await expect(countRows(service, 'session_segments', imported.session.id)).resolves.toBe(0);
    await expect(
      countRows(service, 'session_segment_embeddings', imported.session.id),
    ).resolves.toBe(0);
    await expect(countRawEvents(service, rawEvent.id)).resolves.toBe(0);
    await expect(countRawEvents(service, turnLinkedRawEvent.id)).resolves.toBe(0);

    const recall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'Delete-only sentinel phrase',
        workspaceId,
      }),
    );
    expect(recall.matchCount).toBe(0);
  });

  test('deleting a session cascades into and counts its consolidation records', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-consolidation');
    const imported = await seedRawSession(service, {
      harnessSessionId: 'safety-consolidation',
      rawContent: '{"type":"user","text":"Consolidation cascade sentinel"}\n',
      workspaceId,
    });
    const sessionId = imported.session.id;
    const [interval] = await service.db
      .insert(activityIntervals)
      .values({ workspaceId, sessionId, ordinal: 99, status: 'active', startedAt: new Date() })
      .returning();
    if (interval === undefined) {
      throw new Error('activity interval insert returned no row');
    }
    await Effect.runPromise(
      insertConsolidationRecord(service, {
        activityIntervalId: interval.id,
        authPath: 'oauth',
        modelId: 'test-model',
        narrative: 'interval narrative',
        sessionId,
        workspaceId,
        findings: [
          { key: 'a', type: 'decision', text: 'a', evidence: [{ sessionId, turnOrdinal: 1 }] },
          { key: 'b', type: 'follow_up', text: 'b', evidence: [] },
        ],
        dispositions: [{ kind: 'builds_on', fromKey: 'b', toKey: 'a' }],
      }),
    );

    const deleted = await Effect.runPromise(
      deleteSessionSafety(service, {
        id: imported.rawSessionRecord.id,
        origin: 'test',
        workspaceId,
      }),
    );
    expect(deleted.deleted).toMatchObject({
      consolidationRecords: 1,
      consolidationFindings: 2,
      consolidationEvidencePointers: 1,
      consolidationDispositions: 1,
    });

    const remainingRecords = await service.db
      .select()
      .from(consolidationRecords)
      .where(eq(consolidationRecords.sessionId, sessionId));
    const remainingFindings = await service.db
      .select()
      .from(consolidationFindings)
      .where(eq(consolidationFindings.sessionId, sessionId));
    const remainingDispositions = await service.db
      .select()
      .from(consolidationDispositions)
      .where(eq(consolidationDispositions.sessionId, sessionId));
    const remainingPointers = await service.db
      .select()
      .from(consolidationEvidencePointers)
      .where(eq(consolidationEvidencePointers.workspaceId, workspaceId));
    expect(remainingRecords).toHaveLength(0);
    expect(remainingFindings).toHaveLength(0);
    expect(remainingDispositions).toHaveLength(0);
    expect(remainingPointers).toHaveLength(0);
  });

  test('rejects stale expected active raw record guards before replacing a newer snapshot', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-safety-expected-active');
    const first = await seedRawSession(service, {
      harnessSessionId: 'safety-expected-active',
      rawContent: '{"type":"user","text":"first active content"}\n',
      workspaceId,
    });
    const second = await seedRawSession(service, {
      harnessSessionId: 'safety-expected-active',
      rawContent: '{"type":"user","text":"newer active content"}\n',
      workspaceId,
    });

    await expect(
      Effect.runPromise(
        importRawSessionRecord(service, {
          author: {
            displayName: 'Drew',
            handle: 'drew',
          },
          capturedAt: '2026-06-22T12:01:00.000Z',
          contentType: 'jsonl',
          harness: 'codex',
          harnessSessionId: 'safety-expected-active',
          host: {
            id: 'host-session-safety',
            label: 'Session Safety Host',
            projectRoot: '/work/saga',
          },
          locator: '/tmp/safety-expected-active.jsonl',
          rawContent: '{"type":"user","text":"stale redaction content"}\n',
          rawRecord: {
            expectedActiveRawSessionRecordId: first.rawSessionRecord.id,
            inactivePrevious: {
              status: 'redacted',
            },
            redactedFromRawSessionRecordId: first.rawSessionRecord.id,
            status: 'redacted',
          },
          workspaceId,
        }),
      ),
    ).rejects.toThrow('active raw session record changed during import');

    const rawRecords = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, first.session.id))
      .orderBy(rawSessionRecords.snapshotOrdinal);
    expect(rawRecords).toHaveLength(2);
    expect(rawRecords.find((record) => record.id === first.rawSessionRecord.id)?.isActive).toBe(
      false,
    );
    expect(rawRecords.find((record) => record.id === second.rawSessionRecord.id)).toMatchObject({
      isActive: true,
      status: 'captured',
    });
  });

  test('redacts local paths from session segment read models', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const workspaceId = await createWorkspace(service, 'session-read-model-redaction');
    const rawPath = '/Users/Drew Smith/.codex/transcripts/session.jsonl';
    const windowsPath = String.raw`C:\Users\Drew Smith\.codex\transcripts\session.jsonl`;
    const uncPath = String.raw`\\server\share\Users\drew\.codex\transcripts\session.jsonl`;
    const imported = await seedRawSession(service, {
      harnessSessionId: 'read-model-redaction',
      rawContent: `${JSON.stringify({
        text: `localpathneedle ${rawPath} ${windowsPath} ${uncPath}`,
        type: 'user',
      })}\n`,
      workspaceId,
    });

    const detail = await Effect.runPromise(
      getSessionDetail(service, {
        id: imported.session.id,
        workspaceId,
      }),
    );
    const detailSegments = detail.activityIntervals.flatMap((interval) =>
      interval.turns.flatMap((turn) => turn.segments),
    );
    expect(detailSegments).toHaveLength(1);
    expect(detailSegments[0]?.searchText).toContain('[local-path-redacted]');
    expect(detailSegments[0]?.snippet).toContain('[local-path-redacted]');
    expect(JSON.stringify(detailSegments)).not.toContain(rawPath);
    expect(JSON.stringify(detailSegments)).not.toContain(String.raw`C:\Users\Drew Smith`);
    expect(JSON.stringify(detailSegments)).not.toContain(String.raw`\\server\share`);

    const recall = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'localpathneedle',
        workspaceId,
      }),
    );
    const match = recall.sessions[0]?.matches[0];
    expect(match?.snippet).toContain('[local-path-redacted]');
    expect(match?.segment.snippet).toContain('[local-path-redacted]');
    expect(JSON.stringify(recall)).not.toContain(rawPath);
    expect(JSON.stringify(recall)).not.toContain(String.raw`C:\Users\Drew Smith`);
    expect(JSON.stringify(recall)).not.toContain(String.raw`\\server\share`);

    if (match === undefined) {
      throw new Error('recall match was not returned');
    }
    const context = await Effect.runPromise(
      expandRecallContext(service, {
        segmentId: match.segment.id,
        workspaceId,
      }),
    );
    const expandedSegments = context.turns.flatMap((turn) => turn.segments);
    expect(context.anchor.segment.snippet).toContain('[local-path-redacted]');
    expect(expandedSegments[0]?.searchText).toContain('[local-path-redacted]');
    expect(expandedSegments[0]?.snippet).toContain('[local-path-redacted]');
    expect(JSON.stringify(context)).not.toContain(rawPath);
    expect(JSON.stringify(context)).not.toContain(String.raw`C:\Users\Drew Smith`);
    expect(JSON.stringify(context)).not.toContain(String.raw`\\server\share`);
  });
});

async function createWorkspace(service: DatabaseService, handlePrefix: string): Promise<string> {
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

async function seedRawSession(
  service: DatabaseService,
  input: {
    harnessSessionId: string;
    rawContent: string;
    workspaceId: string;
  },
) {
  return Effect.runPromise(
    importRawSessionRecord(service, {
      author: {
        displayName: 'Drew',
        handle: 'drew',
      },
      capturedAt: '2026-06-22T12:00:00.000Z',
      contentType: 'jsonl',
      harness: 'codex',
      harnessSessionId: input.harnessSessionId,
      host: {
        id: 'host-session-safety',
        label: 'Session Safety Host',
        projectRoot: '/work/saga',
      },
      locator: `/tmp/${input.harnessSessionId}.jsonl`,
      model: 'gpt-5',
      rawContent: input.rawContent,
      workspaceId: input.workspaceId,
    }),
  );
}

async function seedAssociatedRawEvent(
  service: DatabaseService,
  input: {
    externalEventId: string;
    imported: Awaited<ReturnType<typeof seedRawSession>>;
    payload: Record<string, unknown>;
    provenance: Record<string, unknown>;
    sessionId?: string | undefined;
    traceId: string;
    workspaceId: string;
  },
) {
  return Effect.runPromise(
    insertRawEvent(service, {
      actorId: 'codex',
      eventType: 'codex.UserPromptSubmit',
      externalEventId: input.externalEventId,
      occurredAt: '2026-06-22T12:00:01.000Z',
      payload: input.payload,
      provenance: input.provenance,
      sessionId: input.sessionId ?? input.imported.session.harnessSessionId ?? undefined,
      sourceBindingId: input.imported.sourceBinding.id,
      sourceId: 'codex:local',
      sourceType: 'codex',
      traceId: input.traceId,
      trustLevel: 'raw',
      workspaceId: input.workspaceId,
    }),
  );
}

async function linkTurnsToRawEvent(
  service: DatabaseService,
  input: { rawEventId: string; sessionId: string },
): Promise<void> {
  await service.db
    .update(sessionTurns)
    .set({
      rawEventIds: [input.rawEventId],
    })
    .where(eq(sessionTurns.sessionId, input.sessionId));
}

async function countRawEvents(service: DatabaseService, id: string): Promise<number> {
  const rows = await service.db.select().from(rawEvents).where(eq(rawEvents.id, id));
  return rows.length;
}

async function countRows(
  service: DatabaseService,
  table:
    | 'raw_session_records'
    | 'session_segment_embeddings'
    | 'session_segments'
    | 'session_turns'
    | 'sessions',
  sessionId: string,
): Promise<number> {
  if (table === 'sessions') {
    const rows = await service.db.select().from(sessions).where(eq(sessions.id, sessionId));
    return rows.length;
  }
  if (table === 'raw_session_records') {
    const rows = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.sessionId, sessionId));
    return rows.length;
  }
  if (table === 'session_turns') {
    const rows = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.sessionId, sessionId));
    return rows.length;
  }
  if (table === 'session_segments') {
    const rows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.sessionId, sessionId));
    return rows.length;
  }
  const rawRecords = await service.db
    .select({ id: rawSessionRecords.id })
    .from(rawSessionRecords)
    .where(eq(rawSessionRecords.sessionId, sessionId));
  if (rawRecords.length === 0) {
    return 0;
  }
  const rows = await service.sql<{ count: number | string }[]>`
    select count(*)::int as count
    from session_segment_embeddings
    where raw_session_record_id = any(${rawRecords.map((record) => record.id)}::uuid[])
  `;
  return Number(rows[0]?.count ?? 0);
}
