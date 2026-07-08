import { SagaApiClient } from '@saga/api-client';
import {
  importRawSessionRecord,
  insertRawEvent,
  makeDatabase,
  runMigrations,
  searchSessionRecall,
  workspaces,
} from '@saga/db';
import type { DatabaseService } from '@saga/db';
import type { JsonRpcRequest, JsonRpcResponse } from '@saga/mcp';
import type { RuntimeConfig } from '@saga/runtime';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import type { RecallEmbeddingResolver } from './recall-embedding.js';
import { startSagaService } from './server.js';
import type { SagaServiceHandle } from './server.js';

// SGA-253: prove the SERVICE resolves a query embedding and takes the vector recall
// path end-to-end on both surfaces (/v1/recall and the HTTP MCP), returning a
// `vector` posture and a non-null vector score — the parity coverage the lexical
// tests could not reach. The resolver is INJECTED with a deterministic embedding so
// the test never performs remote egress and never depends on ambient OPENAI_API_KEY;
// the segment embedding is seeded directly so the pgvector path has a candidate.
const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.SAGA_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

// A tiny 3-dim embedding space keeps the seed vectors exact and the cosine math
// obvious: the seeded segment and the injected query vector are identical, so the
// vector score is ~1.0. The model/provider/dimensions MUST match the seeded row or
// the vector_candidates CTE (which filters on all three) finds nothing.
const EMBEDDING_MODEL = 'deterministic-recall-vector';
const EMBEDDING_PROVIDER = 'openai';
const EMBEDDING_DIMENSIONS = 3;
const EMBEDDING_VECTOR = [1, 0, 0] as const;

// A query with no lexical overlap with the seeded content, so any match can only
// have come from the vector path (lexical/trigram score 0).
const NON_LEXICAL_QUERY = 'zzzznomatch';

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

// The injected resolver: always returns the deterministic vector posture + embedding,
// standing in for the real policy-gated resolveServiceRecallEmbedding (which would
// read installation policy and call OpenAI).
const vectorResolver: RecallEmbeddingResolver = async () => ({
  posture: { mode: 'vector' },
  queryEmbedding: {
    dimensions: EMBEDDING_DIMENSIONS,
    model: EMBEDDING_MODEL,
    provider: EMBEDDING_PROVIDER,
    vector: [...EMBEDDING_VECTOR],
  },
});

describePostgres('service vector recall egress', () => {
  const databaseName = `saga_service_vector_${Date.now().toString(36)}`;
  let admin: DatabaseService | undefined;
  let service: DatabaseService | undefined;
  let handle: SagaServiceHandle | undefined;
  let client: SagaApiClient | undefined;

  let workspaceId = '';
  let segmentId = '';

  // Lexical content that will NOT match NON_LEXICAL_QUERY, so a hit proves vector.
  const seededContent = 'authentication middleware rotates the signing key';

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
      .values({ handle: `vector-${Date.now().toString(36)}` })
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
        harnessSessionId: 'vector-session',
        host: { id: 'host-1', label: 'local-host', projectRoot: '/tmp/saga' },
        rawContent: [
          JSON.stringify({ text: seededContent, type: 'user' }),
          JSON.stringify({ text: 'assistant reply keeps surrounding context', type: 'assistant' }),
          '',
        ].join('\n'),
        workspaceId,
      }),
    );

    await Effect.runPromise(
      insertRawEvent(service, {
        actorId: 'host-1',
        eventType: 'user-prompt',
        externalEventId: 'vector-evt-1',
        occurredAt: '2026-06-21T14:00:01.000Z',
        payload: { hook_event_name: 'user-prompt' },
        provenance: { importedBy: 'vector-test' },
        sourceBindingId: imported.sourceBinding.id,
        sourceId: 'codex:local',
        sourceType: 'codex',
        trustLevel: 'raw',
        workspaceId,
      }),
    );

    // Find the segment (and its raw record) to attach an embedding to. A lexical
    // recall on the seeded content returns the segment we want to make vector-searchable.
    const seed = await Effect.runPromise(
      searchSessionRecall(service, { query: seededContent, workspaceId }),
    );
    const seedMatch = seed.sessions[0]?.matches[0];
    segmentId = seedMatch?.segment.id ?? '';
    const rawSessionRecordId = seedMatch?.rawSessionRecord.id ?? '';
    if (segmentId === '' || rawSessionRecordId === '') {
      throw new Error('seed recall produced no segment to attach an embedding to');
    }

    // Seed the segment embedding directly (no OpenAI call). The pgvector literal is
    // an exact 3-dim vector; provider/model/dimensions match the injected query
    // embedding so the vector_candidates CTE (which filters on all three) hits.
    const vectorLiteral = `[${EMBEDDING_VECTOR.join(',')}]`;
    await service.sql`
      insert into session_segment_embeddings
        (workspace_id, segment_id, raw_session_record_id, provider, model, dimensions, embedding, input_hash)
      values
        (${workspaceId}, ${segmentId}, ${rawSessionRecordId}, ${EMBEDDING_PROVIDER}, ${EMBEDDING_MODEL},
         ${EMBEDDING_DIMENSIONS}, ${vectorLiteral}::vector, ${'vector-test-input-hash'})
    `;

    handle = await startSagaService(testConfig(url.toString()), {
      database: service,
      recordRun: () => Effect.void,
      resolveRecallEmbedding: vectorResolver,
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

  test('/v1/recall takes the vector path and reports a vector posture', async () => {
    const result = await (client ?? fail()).recall({ query: NON_LEXICAL_QUERY, workspaceId });

    // The posture the service stamped is vector (resolved, not a hardcoded lexical stance).
    expect(result.search.mode).toBe('vector');
    // The match exists ONLY because of the vector path: no lexical overlap with the query.
    expect(result.matchCount).toBeGreaterThan(0);
    const match = result.sessions[0]?.matches[0];
    expect(match?.segment.id).toBe(segmentId);
    expect(match?.scores.lexical).toBe(0);
    expect(match?.scores.vector ?? 0).toBeGreaterThan(0.99);
  });

  test('a request forcing mode:lexical never takes the vector path', async () => {
    const result = await (client ?? fail()).recall({
      mode: 'lexical',
      query: NON_LEXICAL_QUERY,
      workspaceId,
    });
    // Forced lexical: no vector egress, no vector match for a non-lexical query.
    expect(result.search.mode).toBe('lexical');
    expect(result.matchCount).toBe(0);
  });

  test('the HTTP MCP search_sessions takes the vector path and reports vector posture', async () => {
    const request: JsonRpcRequest = {
      id: 1,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { arguments: { limit: 5, query: NON_LEXICAL_QUERY }, name: 'search_sessions' },
    };
    const response = await fetch(`${(handle ?? fail()).url}/mcp?workspaceId=${workspaceId}`, {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonRpcResponse;
    const structured = (
      body.result as { structuredContent: { search: { mode: string }; matchCount: number } }
    ).structuredContent;
    expect(structured.search.mode).toBe('vector');
    expect(structured.matchCount).toBeGreaterThan(0);
  });
});

function fail(): never {
  throw new Error('service vector recall fixture was not initialized');
}
