import { eq } from 'drizzle-orm';
import { Effect } from 'effect';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { makeDatabase, runMigrations } from './database.js';
import type { DatabaseService } from './database.js';
import {
  activityIntervals,
  rawSessionRecords,
  sessions,
  sessionSegmentEmbeddings,
  sessionSegments,
  sessionTurns,
  sourceBindings,
  users,
  workspaces,
} from './schema.js';
import { sessionSegmentEmbeddingInputHash } from './session-embeddings.js';
import { expandRecallContext, searchSessionRecall } from './session-recall.js';

const databaseUrl = process.env.SAGA_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres('session recall', () => {
  const databaseName = `saga_session_recall_${Date.now().toString(36)}`;
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

  test('returns ranked segment matches grouped by session and Activity Interval with metadata', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'grouping');

    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        limit: 10,
        query: 'lexical recall',
        workspaceId: corpus.workspaceId,
      }),
    );

    expect(result.query).toBe('lexical recall');
    expect(result.matchCount).toBeGreaterThanOrEqual(3);
    expect(result.sessions.map((group) => group.session.id)).toContain(corpus.primary.sessionId);
    expect(result.sessions.map((group) => group.session.id)).toContain(corpus.secondary.sessionId);
    expect(result.sessions.map((group) => group.session.id)).not.toContain(
      corpus.otherWorkspace.sessionId,
    );

    const first = result.sessions[0]?.matches[0];
    expect(first?.segment.id).toBe(corpus.primary.segmentIds.lexicalExact);
    expect(first?.scores.lexical).toBeGreaterThan(0);
    expect(first?.scores.trigram).toBeGreaterThan(0);
    expect(first?.scores.combined).toBe(first?.combinedScore);
    expect(first?.scores.vector).toBeUndefined();
    expect(first?.snippet.toLowerCase()).toContain('lexical');
    expect(first?.snippet.toLowerCase()).toContain('recall');
    expect(first?.turn).toMatchObject({
      actorKind: 'host_user',
      ordinal: 0,
      role: 'user',
    });
    expect(first?.session).toMatchObject({
      harness: 'codex',
      harnessSessionId: 'grouping-primary',
      model: 'gpt-5-codex',
      title: 'Primary recall fixture',
    });
    expect(first?.session.authorUser).toMatchObject({
      displayName: 'Drew',
      externalSubject: 'host-grouping',
      handle: 'drew',
      identitySource: 'host',
      metadata: {
        hostId: 'host-grouping',
        hostLabel: 'Recall Host',
      },
    });
    expect(first?.sourceBinding).toMatchObject({
      config: {
        hostId: 'host-grouping',
        projectRoot: '[local-path-redacted]',
      },
      sourceType: 'codex',
    });
    expect(JSON.stringify(first?.sourceBinding)).not.toContain('/work/saga');
    expect(first?.rawSessionRecord).toMatchObject({
      contentType: 'jsonl',
      harness: 'codex',
      isActive: true,
      snapshotOrdinal: 0,
    });

    const primaryGroup = result.sessions.find(
      (group) => group.session.id === corpus.primary.sessionId,
    );
    expect(
      primaryGroup?.activityIntervals.map((group) => group.activityInterval.ordinal),
    ).toStrictEqual([0, 1]);
    expect(
      primaryGroup?.activityIntervals.flatMap((group) =>
        group.matches.map((match) => match.segment.id),
      ),
    ).toStrictEqual(
      expect.arrayContaining([
        corpus.primary.segmentIds.lexicalExact,
        corpus.primary.segmentIds.secondInterval,
      ]),
    );
  });

  test('uses trigram similarity for typo recall while keeping lexical and trigram scores distinct', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'trigram');

    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        minTrigramScore: 0.1,
        query: 'authentcation',
        workspaceId: corpus.workspaceId,
      }),
    );

    const matches = result.sessions.flatMap((group) => group.matches);
    expect(matches.map((match) => match.segment.id)).toContain(
      corpus.primary.segmentIds.authentication,
    );
    const typoMatch = matches.find(
      (match) => match.segment.id === corpus.primary.segmentIds.authentication,
    );
    expect(typoMatch?.scores.lexical).toBe(0);
    expect(typoMatch?.scores.trigram).toBeGreaterThan(0.1);
    expect(typoMatch?.snippet).toContain('Authentication cache invalidation');

    const highThresholdResult = await Effect.runPromise(
      searchSessionRecall(service, {
        minTrigramScore: 0.95,
        query: 'authentcation',
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(highThresholdResult.matchCount).toBe(0);
  });

  test('uses optional vector candidates while preserving segment-level recall pointers', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'vector');
    const provider = recallVectorProvider();
    await insertRecallEmbedding(service, {
      provider,
      rawSessionRecordId: corpus.primary.rawSessionRecordId,
      segmentId: corpus.primary.segmentIds.authentication,
      text: 'Authentication cache invalidation failed in Codex harness.',
      vector: [1, 0, 0],
      workspaceId: corpus.workspaceId,
    });
    await insertRecallEmbedding(service, {
      provider,
      rawSessionRecordId: corpus.primary.rawSessionRecordId,
      segmentId: corpus.primary.segmentIds.lexicalExact,
      text: 'Implement lexical recall lexical recall over session segments with full text search.',
      vector: [0, 1, 0],
      workspaceId: corpus.workspaceId,
    });

    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'zzzznomatch',
        queryEmbedding: {
          dimensions: provider.dimensions,
          model: provider.model,
          provider: provider.id,
          vector: [1, 0, 0],
        },
        workspaceId: corpus.workspaceId,
      }),
    );

    const first = result.sessions[0]?.matches[0];
    expect(first?.segment.id).toBe(corpus.primary.segmentIds.authentication);
    expect(first?.scores.lexical).toBe(0);
    expect(first?.scores.vector).toBeGreaterThan(0.99);
    expect(first?.combinedScore).toBe(first?.scores.combined);
    expect(first?.session.id).toBe(corpus.primary.sessionId);
    expect(first?.turn.id).toBe(corpus.primary.turnIds.authentication);
    expect(first?.rawSessionRecord.id).toBe(corpus.primary.rawSessionRecordId);
  });

  test('can generate the recall query vector through an injected provider callback', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'vector-provider');
    const provider = recallVectorProvider();
    await insertRecallEmbedding(service, {
      provider,
      rawSessionRecordId: corpus.primary.rawSessionRecordId,
      segmentId: corpus.primary.segmentIds.lexicalExact,
      text: 'Implement lexical recall lexical recall over session segments with full text search.',
      vector: [0, 1, 0],
      workspaceId: corpus.workspaceId,
    });

    const queries: string[] = [];
    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        embeddingProvider: {
          provider,
          embedQuery: async ({ query }) => {
            queries.push(query);
            return [0, 1, 0];
          },
        },
        query: 'provider callback query',
        workspaceId: corpus.workspaceId,
      }),
    );

    expect(queries).toStrictEqual(['provider callback query']);
    expect(result.sessions[0]?.matches[0]?.segment.id).toBe(corpus.primary.segmentIds.lexicalExact);
    expect(result.sessions[0]?.matches[0]?.scores.vector).toBeGreaterThan(0.99);
  });

  test('scopes recall to the workspace and only searches filtered segment text', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'isolation');

    const workspaceResult = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'workspaceexclusive uniqueneedle',
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(workspaceResult.matchCount).toBe(0);

    const otherWorkspaceResult = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'workspaceexclusive uniqueneedle',
        workspaceId: corpus.otherWorkspace.workspaceId,
      }),
    );
    expect(otherWorkspaceResult.matchCount).toBe(1);
    expect(otherWorkspaceResult.sessions[0]?.session.id).toBe(corpus.otherWorkspace.sessionId);

    const filteredSecretResult = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'hunter2',
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(filteredSecretResult.matchCount).toBe(0);
  });

  test('excludes disabled source bindings from search and context expansion', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'disabled-source');
    const provider = recallVectorProvider();
    await insertRecallEmbedding(service, {
      provider,
      rawSessionRecordId: corpus.primary.rawSessionRecordId,
      segmentId: corpus.primary.segmentIds.authentication,
      text: 'Authentication cache invalidation failed in Codex harness.',
      vector: [1, 0, 0],
      workspaceId: corpus.workspaceId,
    });

    await service.db
      .update(sourceBindings)
      .set({ enabled: false })
      .where(eq(sourceBindings.id, corpus.primary.sourceBindingId));

    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'Authentication cache invalidation',
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(result.matchCount).toBe(0);

    const vectorResult = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'zzzznomatch',
        queryEmbedding: {
          dimensions: provider.dimensions,
          model: provider.model,
          provider: provider.id,
          vector: [1, 0, 0],
        },
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(vectorResult.matchCount).toBe(0);

    await expect(
      Effect.runPromise(
        expandRecallContext(service, {
          segmentId: corpus.primary.segmentIds.authentication,
          workspaceId: corpus.workspaceId,
        }),
      ),
    ).rejects.toThrow('recall segment was not found in workspace');
  });

  test('excludes inactive raw session snapshots from search and context expansion', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'inactive-raw');
    const provider = recallVectorProvider();
    await insertRecallEmbedding(service, {
      provider,
      rawSessionRecordId: corpus.primary.rawSessionRecordId,
      segmentId: corpus.primary.segmentIds.authentication,
      text: 'Authentication cache invalidation failed in Codex harness.',
      vector: [1, 0, 0],
      workspaceId: corpus.workspaceId,
    });

    await service.db
      .update(rawSessionRecords)
      .set({ isActive: false })
      .where(eq(rawSessionRecords.id, corpus.primary.rawSessionRecordId));

    const result = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'Authentication cache invalidation',
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(result.matchCount).toBe(0);

    const vectorResult = await Effect.runPromise(
      searchSessionRecall(service, {
        query: 'zzzznomatch',
        queryEmbedding: {
          dimensions: provider.dimensions,
          model: provider.model,
          provider: provider.id,
          vector: [1, 0, 0],
        },
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(vectorResult.matchCount).toBe(0);

    await expect(
      Effect.runPromise(
        expandRecallContext(service, {
          segmentId: corpus.primary.segmentIds.authentication,
          workspaceId: corpus.workspaceId,
        }),
      ),
    ).rejects.toThrow('recall segment was not found in workspace');
  });

  test('expands deterministic turn context around a matched segment within interval and raw record bounds', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'context');

    const expansion = await Effect.runPromise(
      expandRecallContext(service, {
        segmentId: corpus.primary.segmentIds.authentication,
        windowTurns: 1,
        workspaceId: corpus.workspaceId,
      }),
    );

    expect(expansion.anchor.segment.id).toBe(corpus.primary.segmentIds.authentication);
    expect(expansion.anchor.turn.id).toBe(corpus.primary.turnIds.authentication);
    expect(expansion.beforeTurns).toBe(1);
    expect(expansion.afterTurns).toBe(1);
    expect(expansion.windowTurns).toBe(1);
    expect(expansion.session).toMatchObject({
      harness: 'codex',
      model: 'gpt-5-codex',
    });
    expect(expansion.sourceBinding.config).toMatchObject({
      hostId: 'host-context',
    });
    expect(expansion.turns.map((turn) => turn.ordinal)).toStrictEqual([1, 2, 3]);
    expect(expansion.turns.map((turn) => turn.id)).toStrictEqual([
      corpus.primary.turnIds.grouping,
      corpus.primary.turnIds.authentication,
      corpus.primary.turnIds.filtered,
    ]);
    expect(expansion.turns[0]?.segments.map((segment) => segment.ordinal)).toStrictEqual([1, 2]);
    expect(expansion.turns[1]?.segments.map((segment) => segment.id)).toStrictEqual([
      corpus.primary.segmentIds.authentication,
    ]);
    expect(expansion.turns[2]?.contentParts).toStrictEqual([
      {
        text: 'The raw transcript contained hunter2, but indexing filtered it.',
        type: 'text',
      },
    ]);
    expect(
      expansion.turns.flatMap((turn) => turn.segments.map((segment) => segment.id)),
    ).not.toContain(corpus.primary.segmentIds.secondInterval);

    const zeroWindow = await Effect.runPromise(
      expandRecallContext(service, {
        segmentId: corpus.primary.segmentIds.authentication,
        windowTurns: 0,
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(zeroWindow.turns.map((turn) => turn.id)).toStrictEqual([
      corpus.primary.turnIds.authentication,
    ]);

    const asymmetricWindow = await Effect.runPromise(
      expandRecallContext(service, {
        afterTurns: 1,
        beforeTurns: 0,
        segmentId: corpus.primary.segmentIds.authentication,
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(asymmetricWindow.beforeTurns).toBe(0);
    expect(asymmetricWindow.afterTurns).toBe(1);
    expect(asymmetricWindow.windowTurns).toBe(1);
    expect(asymmetricWindow.turns.map((turn) => turn.id)).toStrictEqual([
      corpus.primary.turnIds.authentication,
      corpus.primary.turnIds.filtered,
    ]);

    const mixedWindow = await Effect.runPromise(
      expandRecallContext(service, {
        afterTurns: 0,
        segmentId: corpus.primary.segmentIds.authentication,
        windowTurns: 2,
        workspaceId: corpus.workspaceId,
      }),
    );
    expect(mixedWindow.beforeTurns).toBe(2);
    expect(mixedWindow.afterTurns).toBe(0);
    expect(mixedWindow.windowTurns).toBe(2);
    expect(mixedWindow.turns.map((turn) => turn.id)).toStrictEqual([
      corpus.primary.turnIds.lexicalExact,
      corpus.primary.turnIds.grouping,
      corpus.primary.turnIds.authentication,
    ]);
  });

  test('enforces the turn-window contract and surfaces expansion warnings (SGA-160)', async () => {
    if (service === undefined) {
      throw new Error('database service was not initialized');
    }
    const corpus = await seedRecallCorpus(service, 'warnings');
    const anchor = {
      segmentId: corpus.primary.segmentIds.authentication,
      workspaceId: corpus.workspaceId,
    };

    // A clean corpus produces no warnings.
    const clean = await Effect.runPromise(
      expandRecallContext(service, { ...anchor, windowTurns: 1 }),
    );
    expect(clean.warnings).toStrictEqual([]);

    // The window clamps to the maximum (20) per side.
    const clamped = await Effect.runPromise(
      expandRecallContext(service, { ...anchor, windowTurns: 100 }),
    );
    expect(clamped.beforeTurns).toBe(20);
    expect(clamped.afterTurns).toBe(20);
    expect(clamped.windowTurns).toBe(20);

    // A directional value overrides the base window on its side (window 5, before 2 => 2/5).
    const directional = await Effect.runPromise(
      expandRecallContext(service, { ...anchor, beforeTurns: 2, windowTurns: 5 }),
    );
    expect(directional.beforeTurns).toBe(2);
    expect(directional.afterTurns).toBe(5);

    // A hard-redacted active record surfaces an explicit warning, and expansion never exposes
    // the raw body even when one is present.
    await service.sql`
      update raw_session_records
      set status = 'redacted',
        body_text = 'RAWBODYSENTINEL must never appear in expansion output'
      where id = ${corpus.primary.rawSessionRecordId}
    `;
    const redacted = await Effect.runPromise(
      expandRecallContext(service, { ...anchor, windowTurns: 1 }),
    );
    expect(redacted.rawSessionRecord.status).toBe('redacted');
    expect(redacted.warnings).toContainEqual(
      expect.objectContaining({ kind: 'hard_redacted', scope: 'record' }),
    );
    expect(JSON.stringify(redacted)).not.toContain('RAWBODYSENTINEL');
  });
});

type SeededCorpus = {
  otherWorkspace: {
    sessionId: string;
    workspaceId: string;
  };
  primary: {
    segmentIds: {
      authentication: string;
      filtered: string;
      groupingA: string;
      groupingB: string;
      lexicalExact: string;
      secondInterval: string;
    };
    sessionId: string;
    rawSessionRecordId: string;
    sourceBindingId: string;
    turnIds: {
      authentication: string;
      filtered: string;
      grouping: string;
      lexicalExact: string;
      secondInterval: string;
    };
  };
  secondary: {
    sessionId: string;
  };
  workspaceId: string;
};

type WorkspaceBundle = {
  authorUserId: string;
  sourceBindingId: string;
  workspaceId: string;
};

function recallVectorProvider() {
  return {
    dimensions: 3,
    id: 'openai',
    model: 'deterministic-recall-vector',
  } as const;
}

async function insertRecallEmbedding(
  service: DatabaseService,
  input: {
    provider: ReturnType<typeof recallVectorProvider>;
    rawSessionRecordId: string;
    segmentId: string;
    text: string;
    vector: number[];
    workspaceId: string;
  },
): Promise<void> {
  await service.db.insert(sessionSegmentEmbeddings).values({
    dimensions: input.provider.dimensions,
    embedding: input.vector,
    inputHash: sessionSegmentEmbeddingInputHash(input.text, input.provider),
    metadata: {
      fixture: 'session-recall',
      status: 'indexed',
    },
    model: input.provider.model,
    provider: input.provider.id,
    rawSessionRecordId: input.rawSessionRecordId,
    segmentId: input.segmentId,
    workspaceId: input.workspaceId,
  });
}

async function seedRecallCorpus(service: DatabaseService, suffix: string): Promise<SeededCorpus> {
  const primaryWorkspace = await createWorkspaceBundle(service, suffix, {
    harness: 'codex',
    hostId: `host-${suffix}`,
    sourceUri: `codex://host/host-${suffix}`,
  });
  const primary = await insertSessionFixture(service, primaryWorkspace, {
    capturedAt: new Date('2026-06-22T12:00:00.000Z'),
    harness: 'codex',
    harnessSessionId: `${suffix}-primary`,
    model: 'gpt-5-codex',
    title: 'Primary recall fixture',
    turns: [
      {
        actorKind: 'host_user',
        actorLabel: 'Drew',
        contentParts: [
          {
            text: 'Implement lexical recall over session segments.',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'lexicalExact',
        role: 'user',
        searchTexts: [
          'Implement lexical recall lexical recall over session segments with full text search.',
        ],
      },
      {
        actorKind: 'agent',
        actorLabel: 'Codex',
        contentParts: [
          {
            text: 'Group matches by session and Activity Interval.',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'grouping',
        role: 'assistant',
        searchTexts: [
          'Group segment-level matches by session and Activity Interval.',
          'Carry snippets scores harness model and host user metadata.',
        ],
      },
      {
        actorKind: 'host_user',
        actorLabel: 'Drew',
        contentParts: [
          {
            text: 'Authentication cache invalidation failed in the Codex harness.',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'authentication',
        role: 'user',
        searchTexts: ['Authentication cache invalidation failed in Codex harness.'],
      },
      {
        actorKind: 'tool',
        actorLabel: 'shell',
        contentParts: [
          {
            text: 'The raw transcript contained hunter2, but indexing filtered it.',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'filtered',
        role: 'tool',
        searchTexts: [
          'Command output was filtered before indexing and should not expose credentials.',
        ],
      },
      {
        actorKind: 'agent',
        actorLabel: 'Codex',
        contentParts: [
          {
            text: 'The next interval also discussed lexical recall.',
            type: 'text',
          },
        ],
        intervalOrdinal: 1,
        key: 'secondInterval',
        role: 'assistant',
        searchTexts: [
          'Lexical recall second interval keeps Activity Interval boundaries deterministic.',
        ],
      },
    ],
  });

  const secondary = await insertSessionFixture(service, primaryWorkspace, {
    capturedAt: new Date('2026-06-22T13:00:00.000Z'),
    harness: 'claude',
    harnessSessionId: `${suffix}-secondary`,
    model: 'claude-sonnet-4-5',
    title: 'Secondary recall fixture',
    turns: [
      {
        actorKind: 'agent',
        actorLabel: 'Claude',
        contentParts: [
          {
            text: 'Claude also mentioned lexical recall.',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'secondary',
        role: 'assistant',
        searchTexts: ['Lexical recall in Claude sidechain should group under its own session.'],
      },
    ],
  });

  const otherWorkspace = await createWorkspaceBundle(service, `${suffix}-other`, {
    harness: 'codex',
    hostId: `other-host-${suffix}`,
    sourceUri: `codex://host/other-host-${suffix}`,
  });
  const other = await insertSessionFixture(service, otherWorkspace, {
    capturedAt: new Date('2026-06-22T14:00:00.000Z'),
    harness: 'codex',
    harnessSessionId: `${suffix}-other`,
    model: 'gpt-5-codex',
    title: 'Other workspace recall fixture',
    turns: [
      {
        actorKind: 'host_user',
        actorLabel: 'Drew',
        contentParts: [
          {
            text: 'workspaceexclusive uniqueneedle',
            type: 'text',
          },
        ],
        intervalOrdinal: 0,
        key: 'other',
        role: 'user',
        searchTexts: ['workspaceexclusive uniqueneedle'],
      },
    ],
  });

  return {
    otherWorkspace: {
      sessionId: other.sessionId,
      workspaceId: otherWorkspace.workspaceId,
    },
    primary: {
      segmentIds: {
        authentication: primary.segmentIds.authentication?.[0] ?? '',
        filtered: primary.segmentIds.filtered?.[0] ?? '',
        groupingA: primary.segmentIds.grouping?.[0] ?? '',
        groupingB: primary.segmentIds.grouping?.[1] ?? '',
        lexicalExact: primary.segmentIds.lexicalExact?.[0] ?? '',
        secondInterval: primary.segmentIds.secondInterval?.[0] ?? '',
      },
      rawSessionRecordId: primary.rawSessionRecordId,
      sessionId: primary.sessionId,
      sourceBindingId: primaryWorkspace.sourceBindingId,
      turnIds: {
        authentication: primary.turnIds.authentication ?? '',
        filtered: primary.turnIds.filtered ?? '',
        grouping: primary.turnIds.grouping ?? '',
        lexicalExact: primary.turnIds.lexicalExact ?? '',
        secondInterval: primary.turnIds.secondInterval ?? '',
      },
    },
    secondary: {
      sessionId: secondary.sessionId,
    },
    workspaceId: primaryWorkspace.workspaceId,
  };
}

async function createWorkspaceBundle(
  service: DatabaseService,
  suffix: string,
  input: {
    harness: string;
    hostId: string;
    sourceUri: string;
  },
): Promise<WorkspaceBundle> {
  const [workspace] = await service.db
    .insert(workspaces)
    .values({
      handle: `recall-${suffix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    })
    .returning();
  if (workspace === undefined) {
    throw new Error('workspace insert returned no row');
  }

  const [sourceBinding] = await service.db
    .insert(sourceBindings)
    .values({
      config: {
        hostId: input.hostId,
        hostLabel: 'Recall Host',
        projectRoot: '/work/saga',
      },
      displayName: `${input.harness} recall fixture`,
      sourceType: input.harness,
      sourceUri: input.sourceUri,
      workspaceId: workspace.id,
    })
    .returning();
  if (sourceBinding === undefined) {
    throw new Error('source binding insert returned no row');
  }

  const [author] = await service.db
    .insert(users)
    .values({
      displayName: 'Drew',
      externalSubject: input.hostId,
      handle: 'drew',
      identitySource: 'host',
      metadata: {
        hostId: input.hostId,
        hostLabel: 'Recall Host',
      },
      workspaceId: workspace.id,
    })
    .returning();
  if (author === undefined) {
    throw new Error('user insert returned no row');
  }

  return {
    authorUserId: author.id,
    sourceBindingId: sourceBinding.id,
    workspaceId: workspace.id,
  };
}

type SessionFixtureInput = {
  capturedAt: Date;
  harness: string;
  harnessSessionId: string;
  model: string;
  title: string;
  turns: SessionFixtureTurn[];
};

type SessionFixtureTurn = {
  actorKind: string;
  actorLabel: string;
  contentParts: unknown[];
  intervalOrdinal: number;
  key: string;
  role: string;
  searchTexts: string[];
};

async function insertSessionFixture(
  service: DatabaseService,
  bundle: WorkspaceBundle,
  input: SessionFixtureInput,
): Promise<{
  segmentIds: Record<string, string[]>;
  rawSessionRecordId: string;
  sessionId: string;
  turnIds: Record<string, string>;
}> {
  const [session] = await service.db
    .insert(sessions)
    .values({
      authorUserId: bundle.authorUserId,
      harness: input.harness,
      harnessSessionId: input.harnessSessionId,
      lastActivityAt: input.capturedAt,
      metadata: {
        fixture: 'session-recall',
      },
      model: input.model,
      sourceBindingId: bundle.sourceBindingId,
      startedAt: input.capturedAt,
      status: 'completed',
      title: input.title,
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (session === undefined) {
    throw new Error('session insert returned no row');
  }

  const intervalOrdinals = [...new Set(input.turns.map((turn) => turn.intervalOrdinal))].toSorted(
    (left, right) => left - right,
  );
  const intervalIds = new Map<number, string>();
  for (const intervalOrdinal of intervalOrdinals) {
    const [interval] = await service.db
      .insert(activityIntervals)
      .values({
        endedAt: new Date(input.capturedAt.getTime() + (intervalOrdinal + 1) * 60_000),
        metadata: {
          fixture: 'session-recall',
        },
        ordinal: intervalOrdinal,
        sessionId: session.id,
        settledAt: new Date(input.capturedAt.getTime() + (intervalOrdinal + 1) * 60_000),
        settlementReason: 'stop_event',
        startedAt: new Date(input.capturedAt.getTime() + intervalOrdinal * 60_000),
        status: 'settled',
        workspaceId: bundle.workspaceId,
      })
      .returning();
    if (interval === undefined) {
      throw new Error('activity interval insert returned no row');
    }
    intervalIds.set(intervalOrdinal, interval.id);
  }

  const firstIntervalId = intervalIds.get(intervalOrdinals[0] ?? 0);
  if (firstIntervalId === undefined) {
    throw new Error('session fixture requires an interval');
  }

  const [rawRecord] = await service.db
    .insert(rawSessionRecords)
    .values({
      activityIntervalId: firstIntervalId,
      authorUserId: bundle.authorUserId,
      bodyText: input.turns.map((turn) => JSON.stringify(turn.contentParts)).join('\n'),
      capturedAt: input.capturedAt,
      contentHash: `sha256:${input.harnessSessionId}`,
      contentType: 'jsonl',
      harness: input.harness,
      harnessSessionId: input.harnessSessionId,
      metadata: {
        fixture: 'session-recall',
      },
      sessionId: session.id,
      snapshotOrdinal: 0,
      sourceBindingId: bundle.sourceBindingId,
      sourceLocator: `/tmp/${input.harnessSessionId}.jsonl`,
      status: 'captured',
      workspaceId: bundle.workspaceId,
    })
    .returning();
  if (rawRecord === undefined) {
    throw new Error('raw session record insert returned no row');
  }

  const turnIds: Record<string, string> = {};
  const segmentIds: Record<string, string[]> = {};
  let segmentOrdinal = 0;

  for (const [turnOrdinal, turnInput] of input.turns.entries()) {
    const intervalId = intervalIds.get(turnInput.intervalOrdinal);
    if (intervalId === undefined) {
      throw new Error('turn interval was not inserted');
    }

    const [turn] = await service.db
      .insert(sessionTurns)
      .values({
        activityIntervalId: intervalId,
        actorKind: turnInput.actorKind,
        actorLabel: turnInput.actorLabel,
        contentParts: turnInput.contentParts,
        harnessTurnId: `${input.harnessSessionId}-${turnInput.key}`,
        metadata: {
          fixture: 'session-recall',
        },
        model: input.model,
        ordinal: turnOrdinal,
        rawEventIds: [],
        rawSessionRecordId: rawRecord.id,
        role: turnInput.role,
        sessionId: session.id,
        workspaceId: bundle.workspaceId,
      })
      .returning();
    if (turn === undefined) {
      throw new Error('session turn insert returned no row');
    }
    turnIds[turnInput.key] = turn.id;
    segmentIds[turnInput.key] = [];

    for (const searchText of turnInput.searchTexts) {
      const [segment] = await service.db
        .insert(sessionSegments)
        .values({
          activityIntervalId: intervalId,
          metadata: {
            fixture: 'session-recall',
          },
          ordinal: segmentOrdinal,
          rawSessionRecordId: rawRecord.id,
          searchText,
          segmentKind: 'turn',
          sessionId: session.id,
          snippet: searchText.slice(0, 160),
          turnId: turn.id,
          workspaceId: bundle.workspaceId,
        })
        .returning();
      if (segment === undefined) {
        throw new Error('session segment insert returned no row');
      }
      segmentIds[turnInput.key]?.push(segment.id);
      segmentOrdinal += 1;
    }
  }

  return {
    rawSessionRecordId: rawRecord.id,
    segmentIds,
    sessionId: session.id,
    turnIds,
  };
}
