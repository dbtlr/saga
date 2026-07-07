import { SagaApiClient, SagaApiError } from '@saga/api-client';
import {
  expandRecallContext,
  getSessionDetail,
  importRawSessionRecord,
  insertRawEvent,
  listRecentRawEvents,
  listRecentSessionRecords,
  makeDatabase,
  redactAgentFacingSessionValue,
  runMigrations,
  searchSessionRecall,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { startSagaService } from './server.js';
import type { SagaServiceHandle } from './server.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// Every /v1 read endpoint must return exactly the JSON-serialized form of the
// @saga/db read function it delegates to, AFTER the agent-facing redaction pass
// the handlers apply (mirroring the CLI/MCP). The oracle therefore redacts the
// direct db result too — asserting against the unredacted call would enshrine a
// local-path leak. Both sides run against the SAME db connection, so any
// remaining difference is the HTTP layer's doing, not data drift.
function jsonify(value: unknown): unknown {
  // A JSON round-trip is the point: it normalizes Date instances to the ISO
  // strings that cross the wire. structuredClone would preserve Date objects and
  // defeat the comparison.
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- must serialize Dates to wire strings
  return JSON.parse(JSON.stringify(value));
}

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

describePostgres('service /v1 read parity', () => {
  const databaseName = `saga_service_api_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let client: SagaApiClient | undefined;

  let workspaceId = '';
  let sessionId = '';
  let segmentId = '';

  const recallQuery = 'Parity sentinel phrase alpha bravo';

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
      .values({ handle: `parity-${Date.now().toString(36)}` })
      .returning();
    if (workspace === undefined) {
      throw new Error('workspace insert returned no row');
    }
    workspaceId = workspace.id;

    const imported = await Effect.runPromise(
      importRawSessionRecord(service, {
        author: { handle: 'drew' },
        capturedAt: '2026-06-21T14:00:00.000Z',
        contentType: 'jsonl',
        harness: 'codex',
        harnessSessionId: 'parity-session',
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
        externalEventId: 'parity-evt-1',
        occurredAt: '2026-06-21T14:00:01.000Z',
        payload: { hook_event_name: 'user-prompt' },
        provenance: { importedBy: 'parity-test' },
        sourceBindingId: imported.sourceBinding.id,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );

    // Anchor segment for the context endpoint: the first lexical recall match.
    const seed = await Effect.runPromise(
      searchSessionRecall(service, { query: recallQuery, workspaceId }),
    );
    segmentId = seed.sessions[0]?.matches[0]?.segment.id ?? '';
    if (segmentId === '') {
      throw new Error('seed recall produced no segment to anchor the context expansion');
    }

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
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

  test('exposes version and migration status via /v1/info', async () => {
    const info = await (client ?? fail()).info();
    expect(info.version).toBeTypeOf('string');
    expect(info.migrations.expected).toBeGreaterThan(0);
    expect(info.migrations.applied).toBe(info.migrations.expected);
    expect(info.migrations.compatible).toBe(true);
    expect(info.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  test('matches listRecentSessionRecords via /v1/sessions', async () => {
    const direct = await Effect.runPromise(
      listRecentSessionRecords(service ?? fail(), { workspaceId }),
    );
    const viaApi = await (client ?? fail()).listSessions({ workspaceId });
    expect(viaApi).toStrictEqual(jsonify(redactAgentFacingSessionValue(direct)));
    expect(viaApi.length).toBeGreaterThan(0);
  });

  test('matches getSessionDetail via /v1/sessions/:id', async () => {
    const direct = await Effect.runPromise(
      getSessionDetail(service ?? fail(), { id: sessionId, workspaceId }),
    );
    const viaApi = await (client ?? fail()).getSession(sessionId, { workspaceId });
    expect(viaApi).toStrictEqual(jsonify(redactAgentFacingSessionValue(direct)));
  });

  test('matches expandRecallContext via /v1/sessions/:id/context', async () => {
    const direct = await Effect.runPromise(
      expandRecallContext(service ?? fail(), { segmentId, workspaceId }),
    );
    const viaApi = await (client ?? fail()).getSessionContext(segmentId, { workspaceId });
    expect(viaApi).toStrictEqual(jsonify(redactAgentFacingSessionValue(direct)));
  });

  test('matches listRecentRawEvents via /v1/events', async () => {
    const direct = await Effect.runPromise(listRecentRawEvents(service ?? fail(), { workspaceId }));
    const viaApi = await (client ?? fail()).listEvents({ workspaceId });
    expect(viaApi).toStrictEqual(jsonify(redactAgentFacingSessionValue(direct)));
    expect(viaApi.length).toBeGreaterThan(0);
  });

  test('matches searchSessionRecall via /v1/recall (modulo per-call searchedAt)', async () => {
    const direct = await Effect.runPromise(
      searchSessionRecall(service ?? fail(), { query: recallQuery, workspaceId }),
    );
    const viaApi = await (client ?? fail()).recall({ query: recallQuery, workspaceId });

    // searchedAt is stamped per call, so it legitimately differs between the two
    // invocations; assert it is a valid instant, then compare the rest.
    expect(new Date(viaApi.searchedAt).toISOString()).toBe(viaApi.searchedAt);
    const { searchedAt: _apiAt, ...apiRest } = viaApi;
    const { searchedAt: _dbAt, ...dbRest } = jsonify(
      redactAgentFacingSessionValue(direct),
    ) as Record<string, unknown>;
    expect(apiRest).toStrictEqual(dbRest);
    expect(viaApi.matchCount).toBeGreaterThan(0);
  });

  test('unknown workspace scope yields an empty list, not a leak', async () => {
    const viaApi = await (client ?? fail()).listSessions({
      workspaceId: '00000000-0000-0000-0000-000000000000',
    });
    expect(viaApi).toStrictEqual([]);
  });

  test('returns 404, not 400, for an unknown context segment', async () => {
    const error = await (client ?? fail())
      .getSessionContext('00000000-0000-0000-0000-000000000000', { workspaceId })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SagaApiError);
    expect((error as SagaApiError).status).toBe(404);
    expect((error as SagaApiError).code).toBe('not_found');
  });

  test('scrubs a local path embedded in a session title before it crosses the wire', async () => {
    // Seed a leak directly: a title carrying a real /Users/... path. The handler's
    // redaction pass must scrub it to the placeholder before c.json.
    const leakedTitle = 'sentinel leak /Users/drew/secret-notes.txt marker';
    await (service ?? fail()).sql`
      update sessions set title = ${leakedTitle} where id = ${sessionId}
    `;

    const viaApi = await (client ?? fail()).listSessions({ workspaceId });
    const record = viaApi.find((row) => row.session.id === sessionId);
    expect(record).toBeDefined();
    expect(record?.session.title).not.toContain('/Users/drew');
    expect(record?.session.title).toContain('[local-path-redacted]');
  });
});

function fail(): never {
  throw new Error('service parity fixture was not initialized');
}
