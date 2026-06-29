import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  activityIntervals,
  makeDatabase,
  rawEvents,
  rawSessionRecords,
  runMigrations,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sessions,
  sourceBindings,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import { and, eq } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { installHarness } from './harness.js';
import { captureHook } from './ingest.js';
import { initProject, readBindingFile } from './init.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('ambient hook ingest postgres integration', () => {
  const databaseName = `saga_ingest_${Date.now().toString(36)}`;
  const adminSql = postgres(databaseUrl ?? '', { max: 1 });
  let previousDatabaseUrl: string | undefined;
  let service: DatabaseService | undefined;

  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl ?? '');
    url.pathname = `/${databaseName}`;
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url.toString();
    service = await Effect.runPromise(
      makeDatabase(
        {
          databaseUrl: url.toString(),
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
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 5 });
  });

  test('skips ambient capture outside an initialized workspace without database writes', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-unbound-'));
    const transcriptPath = join(projectRoot, 'codex-unbound.jsonl');
    writeFileSync(
      transcriptPath,
      codexTranscript([
        {
          timestamp: '2026-06-22T21:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: 'codex-unbound-session',
          },
        },
      ]),
    );

    const result = await captureHook('codex', {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-unbound-session',
      transcript_path: transcriptPath,
    });

    expect(result).toMatchObject({
      mode: 'skipped',
      source: 'codex',
    });
    expect(result.error).toContain('workspace binding is missing');

    const rawEventRows = await service.db.select().from(rawEvents);
    const rawSessionRows = await service.db.select().from(rawSessionRecords);
    expect(rawEventRows).toHaveLength(0);
    expect(rawSessionRows).toHaveLength(0);
  });

  test('imports Codex transcript snapshots idempotently through ambient hooks', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-codex-'));
    await initProject({ cwd: projectRoot, handle: 'Ambient Codex' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    const transcriptPath = join(projectRoot, 'codex-ambient.jsonl');
    writeFileSync(
      transcriptPath,
      codexTranscript([
        {
          timestamp: '2026-06-22T21:10:00.000Z',
          type: 'session_meta',
          payload: {
            cwd: projectRoot,
            id: 'codex-ambient-session',
          },
        },
        {
          timestamp: '2026-06-22T21:10:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Ambient Codex import sentinel.' }],
          },
        },
      ]),
    );

    const hookInput = {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-ambient-session',
      transcript_path: transcriptPath,
    };
    const first = await captureHook('codex', hookInput);
    const second = await captureHook('codex', hookInput);

    expect(first).toMatchObject({
      mode: 'captured',
      rawSessionImport: 'inserted',
      source: 'codex',
    });
    expect(second).toMatchObject({
      eventId: first.eventId,
      mode: 'captured',
      rawSessionImport: 'unchanged',
      rawSessionRecordId: first.rawSessionRecordId,
      source: 'codex',
    });

    const [sourceBinding] = await service.db
      .select()
      .from(sourceBindings)
      .where(
        and(
          eq(sourceBindings.workspaceId, binding.workspace.id),
          eq(sourceBindings.sourceUri, `codex://host/${binding.host.id}`),
        ),
      )
      .limit(1);
    expect(sourceBinding?.id).toBe(binding.harnesses?.codex?.sourceBindingId);
    expect(sourceBinding?.enabled).toBe(true);

    const sessionRows = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, binding.workspace.id));
    const rawRecordRows = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, binding.workspace.id));
    const segmentRows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.workspaceId, binding.workspace.id));
    const rawEventRows = await service.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.workspaceId, binding.workspace.id));

    expect(sessionRows).toHaveLength(1);
    expect(rawRecordRows).toHaveLength(1);
    expect(segmentRows).toHaveLength(1);
    expect(segmentRows[0]?.searchText).toBe('Ambient Codex import sentinel.');
    expect(rawEventRows).toHaveLength(1);
  });

  test('reports raw-session import failure as captured after raw event insertion', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-stale-source-'));
    await initProject({ cwd: projectRoot, handle: 'Ambient Stale Source' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    const sourceBindingId = binding.harnesses?.codex?.sourceBindingId;
    if (sourceBindingId === undefined) {
      throw new Error('codex source binding was not initialized');
    }

    await service.db
      .update(sourceBindings)
      .set({
        sourceUri: `codex://host/${binding.host.id}-stale`,
      })
      .where(eq(sourceBindings.id, sourceBindingId));

    const transcriptPath = join(projectRoot, 'codex-stale-source.jsonl');
    writeFileSync(
      transcriptPath,
      codexTranscript([
        {
          timestamp: '2026-06-22T21:15:00.000Z',
          type: 'session_meta',
          payload: {
            cwd: projectRoot,
            id: 'codex-stale-source-session',
          },
        },
        {
          timestamp: '2026-06-22T21:15:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Keep raw event even if import fails.' }],
          },
        },
      ]),
    );

    const result = await captureHook('codex', {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-stale-source-session',
      transcript_path: transcriptPath,
    });

    expect(result).toMatchObject({
      mode: 'captured',
      rawSessionImport: 'skipped',
      source: 'codex',
    });
    expect(result.eventId).toStrictEqual(expect.any(String));
    expect(result.rawSessionRecordId).toBeUndefined();
    expect(result.error).toContain('source binding does not match the requested harness and host');
    expect(result.error?.length).toBeLessThanOrEqual(500);

    const rawEventRows = await service.db
      .select()
      .from(rawEvents)
      .where(eq(rawEvents.workspaceId, binding.workspace.id));
    const rawSessionRows = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, binding.workspace.id));
    expect(rawEventRows.map((event) => event.id)).toStrictEqual([result.eventId]);
    expect(rawSessionRows).toHaveLength(0);
  });

  test('resolves relative transcript paths against the hook cwd', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-relative-'));
    await initProject({ cwd: projectRoot, handle: 'Ambient Relative Path' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    const transcriptPath = join(projectRoot, 'codex-relative.jsonl');
    writeFileSync(
      transcriptPath,
      codexTranscript([
        {
          timestamp: '2026-06-22T21:17:00.000Z',
          type: 'session_meta',
          payload: {
            cwd: projectRoot,
            id: 'codex-relative-session',
          },
        },
        {
          timestamp: '2026-06-22T21:17:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Resolve transcript relative to hook cwd.' }],
          },
        },
      ]),
    );

    expect(process.cwd()).not.toBe(projectRoot);
    const result = await captureHook('codex', {
      cwd: projectRoot,
      hook_event_name: 'UserPromptSubmit',
      session_id: 'codex-relative-session',
      transcript_path: 'codex-relative.jsonl',
    });

    expect(result).toMatchObject({
      mode: 'captured',
      rawSessionImport: 'inserted',
      source: 'codex',
    });

    const [rawRecord] = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.id, result.rawSessionRecordId ?? ''))
      .limit(1);
    expect(rawRecord?.sourceLocator).toBe(pathToFileURL(transcriptPath).href);
    expect(rawRecord?.provenance).toMatchObject({
      transcriptPath,
    });

    const segmentRows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.workspaceId, binding.workspace.id));
    expect(segmentRows.map((segment) => segment.searchText)).toStrictEqual([
      'Resolve transcript relative to hook cwd.',
    ]);
  });

  test('lifecycle boundary: opens session and interval for transcript-less Codex hook', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-codex-lifecycle-'));
    await initProject({ cwd: projectRoot, handle: 'Lifecycle Codex' });
    await installHarness({ cwd: projectRoot, target: 'codex' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }

    const result = await captureHook('codex', {
      cwd: projectRoot,
      hook_event_name: 'SessionStart',
      session_id: 'codex-lifecycle-session',
    });

    expect(result.accepted).toBe(true);
    expect(result.mode).toBe('captured');
    expect(result.lifecycleBoundary).toBe('opened');

    const sessionRows = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, binding.workspace.id));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.harnessSessionId).toBe('codex-lifecycle-session');

    const intervalRows = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.workspaceId, binding.workspace.id));
    expect(intervalRows).toHaveLength(1);
    expect(intervalRows[0]?.ordinal).toBe(0);
    expect(intervalRows[0]?.status).toBe('active');

    const rawRecordRows = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, binding.workspace.id));
    expect(rawRecordRows).toHaveLength(0);

    const turnRows = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.workspaceId, binding.workspace.id));
    expect(turnRows).toHaveLength(0);

    const segmentRows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.workspaceId, binding.workspace.id));
    expect(segmentRows).toHaveLength(0);

    const embeddingRows = await service.db
      .select()
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.workspaceId, binding.workspace.id));
    expect(embeddingRows).toHaveLength(0);
  });

  test('lifecycle boundary: opens session and interval for transcript-less Claude hook', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-claude-lifecycle-'));
    await initProject({ cwd: projectRoot, handle: 'Lifecycle Claude' });
    await installHarness({ cwd: projectRoot, target: 'claude' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }

    const result = await captureHook('claude', {
      cwd: projectRoot,
      hook_event_name: 'SessionStart',
      session_id: 'claude-lifecycle-session',
    });

    expect(result.accepted).toBe(true);
    expect(result.mode).toBe('captured');
    expect(result.lifecycleBoundary).toBe('opened');

    const sessionRows = await service.db
      .select()
      .from(sessions)
      .where(eq(sessions.workspaceId, binding.workspace.id));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]?.harnessSessionId).toBe('claude-lifecycle-session');

    const intervalRows = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.workspaceId, binding.workspace.id));
    expect(intervalRows).toHaveLength(1);
    expect(intervalRows[0]?.ordinal).toBe(0);
    expect(intervalRows[0]?.status).toBe('active');

    const rawRecordRows = await service.db
      .select()
      .from(rawSessionRecords)
      .where(eq(rawSessionRecords.workspaceId, binding.workspace.id));
    expect(rawRecordRows).toHaveLength(0);

    const turnRows = await service.db
      .select()
      .from(sessionTurns)
      .where(eq(sessionTurns.workspaceId, binding.workspace.id));
    expect(turnRows).toHaveLength(0);

    const segmentRows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.workspaceId, binding.workspace.id));
    expect(segmentRows).toHaveLength(0);

    const embeddingRows = await service.db
      .select()
      .from(sessionSegmentEmbeddings)
      .where(eq(sessionSegmentEmbeddings.workspaceId, binding.workspace.id));
    expect(embeddingRows).toHaveLength(0);
  });

  test('imports and settles Claude transcript snapshots through ambient Stop hooks', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const projectRoot = mkdtempSync(join(tmpdir(), 'saga-ingest-claude-'));
    await initProject({ cwd: projectRoot, handle: 'Ambient Claude' });
    await installHarness({ cwd: projectRoot, target: 'claude' });
    const binding = readBindingFile(projectRoot);
    if (binding?.host === undefined) {
      throw new Error('binding host was not initialized');
    }
    const transcriptPath = join(projectRoot, 'claude-ambient.jsonl');
    writeFileSync(
      transcriptPath,
      claudeTranscript([
        {
          type: 'user',
          message: {
            role: 'user',
            content: 'Ambient Claude import sentinel.',
          },
          timestamp: '2026-06-22T21:20:00.000Z',
          sessionId: 'claude-ambient-session',
          uuid: 'claude-ambient-user',
        },
        {
          type: 'assistant',
          message: {
            model: 'claude-sonnet-4-5',
            role: 'assistant',
            content: [{ type: 'text', text: 'Ambient Claude captured.' }],
          },
          timestamp: '2026-06-22T21:20:01.000Z',
          sessionId: 'claude-ambient-session',
          uuid: 'claude-ambient-assistant',
        },
      ]),
    );

    const result = await captureHook('claude', {
      cwd: projectRoot,
      hook_event_name: 'Stop',
      session_id: 'claude-ambient-session',
      transcript_path: transcriptPath,
    });

    expect(result).toMatchObject({
      mode: 'captured',
      rawSessionImport: 'inserted',
      source: 'claude',
    });

    const [interval] = await service.db
      .select()
      .from(activityIntervals)
      .where(eq(activityIntervals.workspaceId, binding.workspace.id))
      .limit(1);
    expect(interval).toMatchObject({
      settlementReason: 'stop_event',
      status: 'settled',
    });

    const segmentRows = await service.db
      .select()
      .from(sessionSegments)
      .where(eq(sessionSegments.workspaceId, binding.workspace.id));
    expect(segmentRows.map((segment) => segment.searchText)).toStrictEqual([
      'Ambient Claude import sentinel.',
      'Ambient Claude captured.',
    ]);
  });
});

function codexTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function claudeTranscript(records: readonly Record<string, unknown>[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
